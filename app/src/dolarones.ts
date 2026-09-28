/**
 * Dolarones v1 (Issue #81): socios, saldo por lotes y lo que una venta o una
 * cancelacion le hacen a ese saldo. Reglas en docs/RECOMPENSAS-DOLARONES.md.
 *
 * Centavos enteros, como el resto del dinero: 1 D = 100. El saldo no se guarda
 * en una columna: es la suma de `restante` de los lotes vigentes, y cada lote
 * solo baja dentro del mismo batch que registra la venta.
 */

import { dolaronesGanados, MINIMO_REGALO } from '../public/venta.js';

// America/Mexico_City no tiene horario de verano desde 2022: siempre UTC-6.
const MX = -6 * 3_600_000;
const INTENTOS_PIN = 5;
const BLOQUEO_PIN = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- reglas, puras para probarlas sin D1 ---------- */

const MESES_COMPRA = 12;

/** Lo ganado en una compra se usa desde la medianoche siguiente, hora de la tienda. */
export function disponibleDesde(ahora: Date): string {
  const local = new Date(ahora.getTime() + MX);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - MX).toISOString();
}

/** Misma fecha y hora local N meses despues; si ese dia no existe, el ultimo del mes. */
export function sumarMeses(ahora: Date, meses: number): string {
  const local = new Date(ahora.getTime() + MX);
  const anio = local.getUTCFullYear();
  const mes = local.getUTCMonth() + meses;
  const ultimo = new Date(Date.UTC(anio, mes + 1, 0)).getUTCDate();
  const destino = Date.UTC(anio, mes, Math.min(local.getUTCDate(), ultimo),
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds());
  return new Date(destino - MX).toISOString();
}

export interface Lote {
  id: string;
  origen: string;
  restante: number;
  disponible_desde: string;
  vence_en: string;
}

/**
 * De que lotes sale un canje: primero el que vence antes. null si no alcanza.
 * Es solo la propuesta: el UPDATE vuelve a comprobar saldo y vigencia.
 */
export function repartir(lotes: Lote[], importe: number, ahora: string, total: number): { id: string; importe: number }[] | null {
  const usables = lotes
    .filter((l) => l.restante > 0 && l.disponible_desde <= ahora && l.vence_en > ahora)
    .filter((l) => l.origen === 'compra' || (l.origen === 'regalo' && total >= MINIMO_REGALO))
    .sort((a, b) => a.vence_en.localeCompare(b.vence_en) || a.id.localeCompare(b.id));
  const reparto: { id: string; importe: number }[] = [];
  let falta = importe;
  for (const lote of usables) {
    if (falta === 0) break;
    const toma = Math.min(lote.restante, falta);
    reparto.push({ id: lote.id, importe: toma });
    falta -= toma;
  }
  return falta > 0 ? null : reparto;
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** PBKDF2-SHA256; 100,000 vueltas es el maximo que acepta Workers. */
export async function hashPin(pin: string, salHex: string): Promise<string> {
  const llave = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const sal = Uint8Array.from(salHex.match(/../g)!.map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: 100_000 }, llave, 256));
}

/* ---------- D1 ---------- */

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export async function saldo(env: Env, clienteId: string, ahora: string): Promise<{ disponible: number; por_liberar: number; regalo_disponible: number }> {
  const fila = await env.DB.prepare(
    `select coalesce(sum(case when disponible_desde <= ? then restante end), 0) as disponible,
            coalesce(sum(case when disponible_desde > ? then restante end), 0) as por_liberar,
            coalesce(sum(case when disponible_desde <= ? and origen = 'regalo' then restante end), 0) as regalo_disponible
     from dolarones_lotes where cliente_id = ? and vence_en > ?`,
  )
    .bind(ahora, ahora, ahora, clienteId, ahora)
    .first<{ disponible: number; por_liberar: number; regalo_disponible: number }>();
  return { disponible: fila?.disponible ?? 0, por_liberar: fila?.por_liberar ?? 0, regalo_disponible: fila?.regalo_disponible ?? 0 };
}

interface FilaCliente {
  id: string;
  numero: number;
  nombre: string;
  telefono: string;
}

async function socioConSaldo(env: Env, cliente: FilaCliente) {
  return { ...cliente, ...(await saldo(env, cliente.id, new Date().toISOString())) };
}

/** Alta en la tienda, por alguien con sesion en la caja. Reintentar con el mismo id devuelve el mismo socio. */
export async function registrarSocio(request: Request, env: Env, autor: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const nombre = texto(cuerpo.nombre, 80);
  const telefono = String(cuerpo.telefono ?? '').replace(/\D/g, '');
  const correo = texto(cuerpo.correo, 200).toLowerCase();
  const pin = String(cuerpo.pin ?? '');

  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (nombre.length < 2) return json({ error: 'Escribe el nombre del cliente.' }, 400);
  if (telefono.length !== 10) return json({ error: 'El telefono debe tener 10 digitos.' }, 400);
  if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ error: 'Correo invalido.' }, 400);
  if (!/^\d{4}$/.test(pin)) return json({ error: 'El PIN debe tener 4 digitos.' }, 400);
  if (cuerpo.acepta_bases !== true) return json({ error: 'El cliente tiene que aceptar las bases y el aviso de privacidad.' }, 400);
  if (!env.BASES_APROBADAS_VERSION || env.BASES_APROBADAS_VERSION.startsWith('borrador'))
    return json({ error: 'Altas cerradas hasta aprobar las bases y el aviso.' }, 503);

  const leer = (campo: 'id' | 'telefono', valor: string) =>
    env.DB.prepare(`select id, numero, nombre, telefono from clientes where ${campo} = ?`).bind(valor).first<FilaCliente>();

  const previo = await leer('id', id);
  if (previo) return json(await socioConSaldo(env, previo));
  const mismoTelefono = await leer('telefono', telefono);
  if (mismoTelefono) return json({ error: `Ese telefono ya es el socio #${mismoTelefono.numero}.` }, 409);

  const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
  const pinHash = await hashPin(pin, sal);
  const ahora = new Date();
  const ahoraIso = ahora.toISOString();
  // El alta presencial no acredita una llegada ni asigna un premio. #109
  // exige que personal registre la llegada con la ruta dedicada.
  try {
    await env.DB.prepare(
        `insert into clientes (id, numero, nombre, telefono, correo, pin_hash, pin_sal, bases_version, bases_aceptadas_en, registrado_por, creado_en)
         select ?, coalesce(max(numero), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ? from clientes`,
      ).bind(id, nombre, telefono, correo, pinHash, sal, env.BASES_APROBADAS_VERSION, ahoraIso, autor, ahoraIso).run();
  } catch (error) {
    if (String(error).includes('clientes.telefono')) return json({ error: 'Ese telefono ya es socio.' }, 409);
    throw error;
  }

  const socio = (await leer('id', id))!;
  return json({ ...(await socioConSaldo(env, socio)), regalo: 0, regalo_vence: null }, 201);
}

/** La caja busca por telefono (10 digitos) o por numero de socio. */
export async function buscarSocio(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').replace(/\D/g, '');
  if (!q) return json({ error: 'Escribe el telefono o el numero de socio.' }, 400);
  const cliente = await env.DB.prepare(
    `select id, numero, nombre, telefono from clientes where ${q.length === 10 ? 'telefono' : 'numero'} = ?`,
  )
    .bind(q.length === 10 ? q : Number(q))
    .first<FilaCliente>();
  if (!cliente) return json({ error: 'No hay socio con ese telefono o numero.' }, 404);
  return json(await socioConSaldo(env, cliente));
}

type Resultado = { ok: true; sentencias: D1PreparedStatement[]; ganados: number } | { ok: false; status: number; error: string };

/**
 * Lo que una venta le hace al saldo, como sentencias para el MISMO batch que
 * inserta la venta: o todo o nada. Aqui se valida el PIN (sus fallos si se
 * guardan aparte, aunque la venta no ocurra).
 */
export async function sentenciasDeVenta(env: Env, p: {
  ventaId: string; clienteId: string | null; dolarones: number; pin: string;
  total: number; autor: string; ahora: Date;
}): Promise<Resultado> {
  if (!Number.isSafeInteger(p.dolarones) || p.dolarones < 0 || p.dolarones > p.total) {
    return { ok: false, status: 400, error: 'Importe de Dolarones invalido.' };
  }
  if (!p.clienteId) {
    return p.dolarones > 0 ? { ok: false, status: 400, error: 'Para pagar con Dolarones hace falta el socio.' } : { ok: true, sentencias: [], ganados: 0 };
  }
  const cliente = await env.DB.prepare('select id, pin_hash, pin_sal, pin_fallos, pin_bloqueo from clientes where id = ?')
    .bind(p.clienteId)
    .first<{ id: string; pin_hash: string; pin_sal: string; pin_fallos: number; pin_bloqueo: string }>();
  if (!cliente) return { ok: false, status: 400, error: 'El socio no existe.' };

  const ahoraIso = p.ahora.toISOString();
  const sentencias: D1PreparedStatement[] = [];

  if (p.dolarones > 0) {
    if (cliente.pin_bloqueo > ahoraIso) {
      return { ok: false, status: 423, error: 'PIN bloqueado por intentos fallidos. Espera 15 minutos o llama a Isaac.' };
    }
    if (await hashPin(p.pin, cliente.pin_sal) !== cliente.pin_hash) {
      // Incrementar sobre el valor actual: varias cajas pueden haber leido el mismo contador.
      // Un intento en vuelo no debe quitar un bloqueo ni modificar un PIN restablecido.
      const fallo = await env.DB.prepare(
        `update clientes set
           pin_fallos = case when pin_fallos + 1 >= ? then 0 else pin_fallos + 1 end,
           pin_bloqueo = case when pin_fallos + 1 >= ? then ? else pin_bloqueo end
         where id = ? and pin_bloqueo <= ? and pin_hash = ?
         returning pin_bloqueo`,
      ).bind(INTENTOS_PIN, INTENTOS_PIN, new Date(p.ahora.getTime() + BLOQUEO_PIN).toISOString(),
        cliente.id, ahoraIso, cliente.pin_hash).first<{ pin_bloqueo: string }>();
      return { ok: false, status: 403, error: fallo && fallo.pin_bloqueo > ahoraIso ? 'PIN incorrecto. Se bloqueo 15 minutos.' : 'PIN incorrecto.' };
    }
    // Confirmar el PIN y limpiar fallos juntos, antes de preparar la venta:
    // el hash o el bloqueo pueden haber cambiado durante PBKDF2.
    const autorizado = await env.DB.prepare(
      `update clientes set pin_fallos = 0 where id = ? and pin_hash = ? and pin_bloqueo <= ? returning id`,
    ).bind(cliente.id, cliente.pin_hash, ahoraIso).first();
    if (!autorizado) return { ok: false, status: 423, error: 'PIN bloqueado o actualizado. Vuelve a buscar al socio o llama a Isaac.' };

    const { results: lotes } = await env.DB.prepare(
      'select id, origen, restante, disponible_desde, vence_en from dolarones_lotes where cliente_id = ? and restante > 0 and vence_en > ?',
    )
      .bind(cliente.id, ahoraIso)
      .all<Lote>();
    const reparto = repartir(lotes, p.dolarones, ahoraIso, p.total);
    if (!reparto) return { ok: false, status: 409, error: p.total < MINIMO_REGALO
      ? 'Saldo canjeable insuficiente. Los regalos de apertura requieren un ticket de $1,000 MXN o mas, antes de descontar Dolarones.'
      : 'Saldo de Dolarones insuficiente.' };

    for (const parte of reparto) {
      // -1 si el lote vencio o aun no se libera entre la lectura y el batch:
      // el trigger lote_no_negativo aborta la venta completa.
      sentencias.push(
        env.DB.prepare(
          `update dolarones_lotes set restante = case when vence_en > ? and disponible_desde <= ?
           and (origen = 'compra' or (origen = 'regalo' and ? >= ?)) then restante - ? else -1 end
           where id = ?`,
        ).bind(ahoraIso, ahoraIso, p.total, MINIMO_REGALO, parte.importe, parte.id),
        env.DB.prepare(
          `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
           values (?, ?, ?, 'canje', ?, ?, ?)`,
        ).bind(cliente.id, parte.id, p.ventaId, -parte.importe, p.autor, ahoraIso),
      );
    }
  }

  const ganados = dolaronesGanados(p.total - p.dolarones);
  if (ganados > 0) {
    const lote = crypto.randomUUID();
    sentencias.push(
      env.DB.prepare(
        `insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
         values (?, ?, 'compra', ?, ?, ?, ?, ?, ?)`,
      ).bind(lote, cliente.id, p.ventaId, ganados, ganados, disponibleDesde(p.ahora), sumarMeses(p.ahora, MESES_COMPRA), ahoraIso),
      env.DB.prepare(
        `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
         values (?, ?, ?, 'compra', ?, ?, ?)`,
      ).bind(cliente.id, lote, p.ventaId, ganados, p.autor, ahoraIso),
    );
  }
  return { ok: true, sentencias, ganados };
}

/**
 * Deshacer una venta: los Dolarones usados regresan a sus lotes y los ganados
 * se retiran. Para el mismo batch que marca la venta cancelada.
 *
 * ponytail: si el cliente ya gasto parte de lo ganado, solo se retira lo que
 * queda y la diferencia (a lo mas 10% de la venta) la absorbe la tienda; el
 * plan propone registrarla como deuda. Y lo que regresa a un lote ya vencido
 * se pierde; la restitucion de 30 dias del plan espera aprobacion.
 */
export async function sentenciasDeCancelacion(env: Env, ventaId: string, autor: string, ahora: string): Promise<D1PreparedStatement[]> {
  const { results: canjes } = await env.DB.prepare(
    `select cliente_id, lote_id, -importe as importe from dolarones_movimientos where venta_id = ? and tipo = 'canje'`,
  )
    .bind(ventaId)
    .all<{ cliente_id: string; lote_id: string; importe: number }>();
  return [
    ...canjes.flatMap((c) => [
      env.DB.prepare('update dolarones_lotes set restante = restante + ? where id = ?').bind(c.importe, c.lote_id),
      env.DB.prepare(
        `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
         values (?, ?, ?, 'reverso_canje', ?, ?, ?)`,
      ).bind(c.cliente_id, c.lote_id, ventaId, c.importe, autor, ahora),
    ]),
    // Primero la bitacora, que lee cuanto queda; luego el lote en cero.
    env.DB.prepare(
      `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
       select cliente_id, id, venta_id, 'reverso_compra', -restante, ?, ? from dolarones_lotes
       where venta_id = ? and restante > 0`,
    ).bind(autor, ahora, ventaId),
    env.DB.prepare('update dolarones_lotes set restante = 0 where venta_id = ?').bind(ventaId),
  ];
}

/**
 * El socio olvido su PIN o se bloqueo: el dueno, con el cliente enfrente, deja
 * que escriba uno nuevo. Ruta solo del dueno (no esta listada en cuentas.ts).
 */
export async function cambiarPin(numero: number, request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { pin?: unknown };
  const pin = String(cuerpo.pin ?? '');
  if (!/^\d{4}$/.test(pin)) return json({ error: 'El PIN debe tener 4 digitos.' }, 400);
  const sal = hex(crypto.getRandomValues(new Uint8Array(16)));
  const { meta } = await env.DB.prepare(
    `update clientes set pin_hash = ?, pin_sal = ?, pin_fallos = 0, pin_bloqueo = '' where numero = ?`,
  )
    .bind(await hashPin(pin, sal), sal, numero)
    .run();
  if (meta.changes === 0) return json({ error: 'No hay socio con ese numero.' }, 404);
  return json({ numero, pin_cambiado: true });
}
