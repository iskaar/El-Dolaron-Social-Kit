/**
 * Dolarones v1 (Issue #81): socios, saldo por lotes y lo que una venta o una
 * cancelacion le hacen a ese saldo. Reglas en docs/RECOMPENSAS-DOLARONES.md.
 *
 * Centavos enteros, como el resto del dinero: 1 D = 100. El saldo no se guarda
 * en una columna: es la suma de `restante` de los lotes vigentes, y cada lote
 * solo baja dentro del mismo batch que registra la venta.
 */

import { dolaronesGanados, MINIMO_REGALO } from '../public/venta.js';
import { MINIMO_COMPRA, D_PREMIO, pendienteDe, sentenciasDeLiberacion } from './referidos.ts';

// America/Mexico_City no tiene horario de verano desde 2022: siempre UTC-6.
const MX = -6 * 3_600_000;
export const INTENTOS_PIN = 5;
export const BLOQUEO_PIN = 15 * 60_000;
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
    .filter((l) => l.origen === 'compra' || l.origen === 'referido' || l.origen === 'promo' || l.origen === 'reto' || (l.origen === 'regalo' && total >= MINIMO_REGALO))
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

/* ---------- promo de noviembre (Issue #684), reglas puras ---------- */

/** Cada $3,000 en dinero pagado durante el periodo dan 300 D de bono, sin tope. Centavos. */
export const PROMO_META = 300_000;
export const PROMO_BONO = 30_000;

export interface PromoMeta { inicio: string; fin: string; vence: string }

/**
 * Periodo y vigencia del bono, de PROMO_META_INICIO / _FIN / _VENCE (ISO, UTC). Con cualquiera
 * ausente o mal formada, o un periodo vacio, la promo esta apagada y nada cambia. Se normalizan
 * a toISOString() porque se comparan como texto contra `creado_en`.
 */
export function promoMeta(env: Env): PromoMeta | null {
  const crudo = [env.PROMO_META_INICIO, env.PROMO_META_FIN, env.PROMO_META_VENCE];
  if (!crudo.every((v) => !!v && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v)))) return null;
  const [inicio, fin, vence] = crudo.map((v) => new Date(v!).toISOString());
  return inicio < fin ? { inicio, fin, vence } : null;
}

/** El instante cae en el periodo: inicio incluido, fin excluido. */
export const enPeriodoDePromo = (meta: PromoMeta, instante: Date) => {
  const iso = instante.toISOString();
  return iso >= meta.inicio && iso < meta.fin;
};

/**
 * Bonos nuevos que gana una venta: los multiplos de `meta` que el acumulado alcanza al sumar
 * `dineroVenta` y que todavia no se han pagado. `otorgados` (bonos vigentes del socio en el
 * periodo) vale por omision lo que el acumulado ya tenia, que es el caso normal. Contarlos
 * aparte cubre dos casos: encender la promo despues del 1/11 (el rezago se paga en la primera
 * venta) y una devolucion que bajo el acumulado (no se vuelve a pagar el mismo bloque).
 */
export function bonosDeMeta(acumuladoAntes: number, dineroVenta: number, meta = PROMO_META,
  otorgados = Math.floor(acumuladoAntes / meta)): number {
  return Math.max(0, Math.floor((acumuladoAntes + Math.max(0, dineroVenta)) / meta) - otorgados);
}

export const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** PIN de CAJEROS; ya no se usa para socios. PBKDF2-SHA256, 100,000 vueltas. */
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
export const basesListas = (env: Env) => !!env.BASES_APROBADAS_VERSION &&
  !env.BASES_APROBADAS_VERSION.startsWith('borrador') && !!env.PORTAL_BASES_TEXTO?.trim() &&
  !!env.PORTAL_AVISO_TEXTO?.trim() &&
  // Un dato sin llenar ({{RFC}}) nunca llega al cliente: el portal sigue cerrado.
  !`${env.PORTAL_BASES_TEXTO}${env.PORTAL_AVISO_TEXTO}`.includes('{{');

/** La hora fiable de aceptación de la venta decide si ya inició la promoción. */
export function promocionIniciada(env: Env, ahora: Date): boolean {
  const inicio = env.PROMOCION_INICIO;
  return !!inicio && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(inicio) &&
    Number.isFinite(Date.parse(inicio)) && ahora.getTime() >= Date.parse(inicio);
}

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
  const cuerpo = (await request.json().then((c) => c ?? {}, () => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const nombre = texto(cuerpo.nombre, 80);
  const telefono = String(cuerpo.telefono ?? '').replace(/\D/g, '');
  const correo = texto(cuerpo.correo, 200).toLowerCase();

  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (nombre.length < 2) return json({ error: 'Escribe el nombre del cliente.' }, 400);
  if (telefono.length !== 10) return json({ error: 'El telefono debe tener 10 digitos.' }, 400);
  if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ error: 'Correo invalido.' }, 400);
  if (cuerpo.acepta_bases !== true) return json({ error: 'El cliente tiene que aceptar las bases y el aviso de privacidad.' }, 400);
  if (cuerpo.declara_mayor_edad !== true) return json({ error: 'El cliente debe declarar que es mayor de 18 años.' }, 400);
  if (!basesListas(env))
    return json({ error: 'Altas cerradas hasta aprobar las bases y el aviso.' }, 503);

  const leer = (campo: 'id' | 'telefono', valor: string) =>
    env.DB.prepare(`select id, numero, nombre, telefono from clientes where ${campo} = ?`).bind(valor).first<FilaCliente>();

  const previo = await leer('id', id);
  if (previo) return json(await socioConSaldo(env, previo));
  const mismoTelefono = await leer('telefono', telefono);
  if (mismoTelefono) return json({ error: `Ese telefono ya es el socio #${mismoTelefono.numero}.` }, 409);

  const ahora = new Date();
  const ahoraIso = ahora.toISOString();
  // El alta presencial no acredita una llegada ni asigna un premio. #109
  // exige que personal registre la llegada con la ruta dedicada.
  try {
    await env.DB.prepare(
        `insert into clientes (id, numero, nombre, telefono, correo, bases_version, bases_aceptadas_en, registrado_por, creado_en)
         select ?, coalesce(max(numero), 0) + 1, ?, ?, ?, ?, ?, ?, ? from clientes`,
      ).bind(id, nombre, telefono, correo, env.BASES_APROBADAS_VERSION, ahoraIso, autor, ahoraIso).run();
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

type Resultado = { ok: true; sentencias: D1PreparedStatement[]; ganados: number; referido?: number; bono_promo?: number } | { ok: false; status: number; error: string };

/**
 * Lo que una venta le hace al saldo, como sentencias para el MISMO batch que
 * inserta la venta: o todo o nada. La autorización se consume en ese batch.
 */
export async function sentenciasDeVenta(env: Env, p: {
  ventaId: string; clienteId: string | null; dolarones: number; codigo: string;
  total: number; autor: string; ahora: Date;
  /** Hora de la venta en la caja (`creado_en`); decide si cae en el periodo de la promo. Omitida: `ahora`. */
  hora?: Date;
}): Promise<Resultado> {
  if (!Number.isSafeInteger(p.dolarones) || p.dolarones < 0 || p.dolarones > p.total) {
    return { ok: false, status: 400, error: 'Importe de Dolarones invalido.' };
  }
  if (!p.clienteId) {
    return p.dolarones > 0 ? { ok: false, status: 400, error: 'Para pagar con Dolarones hace falta el socio.' } : { ok: true, sentencias: [], ganados: 0 };
  }
  const cliente = await env.DB.prepare('select id from clientes where id = ?')
    .bind(p.clienteId)
    .first<{ id: string }>();
  if (!cliente) return { ok: false, status: 400, error: 'El socio no existe.' };

  const ahoraIso = p.ahora.toISOString();
  const sentencias: D1PreparedStatement[] = [];

  if (p.dolarones > 0) {
    const tokenHash = await hashCodigo(p.codigo);
    if (!tokenHash) return { ok: false, status: 403, error: 'Escanea un código vigente autorizado por el cliente.' };
    const autorizado = await env.DB.prepare(`select 1 from codigos_cliente k join clientes c on c.id = k.cliente_id
      where k.cliente_id = ? and token_hash = ? and venta_id = '' and expira_en > ?
      and maximo >= ? and k.auth_uid = c.auth_uid`)
      .bind(cliente.id, tokenHash, ahoraIso, p.dolarones).first();
    if (!autorizado) return { ok: false, status: 403, error: 'Código vencido, usado o importe no autorizado. El cliente debe generar otro.' };
    // Volver a comprobar dentro del batch: otro cajero, un nuevo código o el
    // reloj real pueden invalidar lo leído. NULL dispara el trigger y revierte
    // también venta, existencias y saldo. Cerrar sesión revoca sin borrar la fila.
    sentencias.push(env.DB.prepare(`update codigos_cliente set venta_id = case
      when token_hash = ? and venta_id = '' and expira_en > ?
      and expira_en > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') and maximo >= ?
      and auth_uid = (select auth_uid from clientes where id = ?)
      then ? else null end where cliente_id = ?`)
      .bind(tokenHash, ahoraIso, p.dolarones, cliente.id, p.ventaId, cliente.id));

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
           and (origen in ('compra', 'referido', 'promo', 'reto') or (origen = 'regalo' and ? >= ?)) then restante - ? else -1 end
           where id = ?`,
        ).bind(ahoraIso, ahoraIso, p.total, MINIMO_REGALO, parte.importe, parte.id),
        env.DB.prepare(
          `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
           values (?, ?, ?, 'canje', ?, ?, ?)`,
        ).bind(cliente.id, parte.id, p.ventaId, -parte.importe, p.autor, ahoraIso),
      );
    }
  }

  const ganados = promocionIniciada(env, p.ahora) ? dolaronesGanados(p.total - p.dolarones) : 0;
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
  const bono = await sentenciasDePromo(env, p, cliente.id);
  sentencias.push(...bono.sentencias);
  // Referidos (#489): la primera compra con $150 en dinero libera 25 D al nuevo y 25 D a quien lo invitó.
  const referente = p.total - p.dolarones >= MINIMO_COMPRA ? await pendienteDe(env, cliente.id) : null;
  if (referente) sentencias.push(...sentenciasDeLiberacion(env, {
    ventaId: p.ventaId, nuevoId: cliente.id, referenteId: referente, autor: p.autor, ahora: p.ahora }));
  return { ok: true, sentencias, ganados, referido: referente ? D_PREMIO : 0, bono_promo: bono.bonos * PROMO_BONO };
}

/**
 * Promo de noviembre (#684): el dinero pagado (total menos Dolarones) de las ventas no canceladas del
 * socio en el periodo, sin esta venta (todavia no esta insertada), mas el de esta, da los bonos. Cada
 * bono es un lote origen 'promo' SIN venta_id (el indice unico lotes_venta deja un lote por venta y
 * esa plaza es de lo ganado por compra) enlazado por su movimiento 'promo', como los referidos.
 * Una devolucion parcial resta del progreso pero no retira bonos ya pagados (devoluciones.ts solo toca
 * el lote con venta_id): el bloque no se paga dos veces y hay que reunirlo de nuevo.
 * ponytail: cada lote verifica en el batch cuantos bonos hay ya (dos cajas a la vez no pagan doble);
 * la que pierde la carrera no paga y la siguiente venta del socio lo recupera con bonosDeMeta.
 */
/** Bonos de la promo que el socio (?1) conserva: su venta cae en el periodo (?2, ?3) y no esta cancelada. */
const BONOS_VIGENTES = `(select count(*) from dolarones_movimientos m join ventas v on v.id = m.venta_id
  where m.cliente_id = ?1 and m.tipo = 'promo' and v.cancelada = 0 and v.creado_en >= ?2 and v.creado_en < ?3)`;

/** Dinero pagado del socio en el periodo (?1, ?2, ?3), sin canceladas ni lo devuelto. */
const DINERO_DEL_PERIODO = `coalesce((select sum(max(0, total - dolarones - devuelto)) from ventas
  where cliente_id = ?1 and cancelada = 0 and creado_en >= ?2 and creado_en < ?3), 0)`;

/** Para el portal (#684): como va el socio en la meta. null si la promo esta apagada o fuera de su periodo. */
export async function progresoDePromo(env: Env, clienteId: string, ahora: Date) {
  const meta = promoMeta(env);
  if (!meta || !enPeriodoDePromo(meta, ahora)) return null;
  const fila = await env.DB.prepare(`select ${DINERO_DEL_PERIODO} as acumulado, ${BONOS_VIGENTES} as bonos`)
    .bind(clienteId, meta.inicio, meta.fin).first<{ acumulado: number; bonos: number }>();
  return { acumulado: fila?.acumulado ?? 0, meta: PROMO_META, bono: PROMO_BONO, fin: meta.fin, bonos: fila?.bonos ?? 0 };
}

async function sentenciasDePromo(env: Env, p: { ventaId: string; total: number; dolarones: number; autor: string; ahora: Date; hora?: Date },
  clienteId: string): Promise<{ sentencias: D1PreparedStatement[]; bonos: number }> {
  const meta = promoMeta(env);
  const dinero = p.total - p.dolarones;
  if (!meta || dinero <= 0 || !enPeriodoDePromo(meta, p.hora ?? p.ahora)) return { sentencias: [], bonos: 0 };
  const previo = await env.DB.prepare(
    `select ${DINERO_DEL_PERIODO} as acumulado, ${BONOS_VIGENTES} as otorgados`,
  ).bind(clienteId, meta.inicio, meta.fin).first<{ acumulado: number; otorgados: number }>();
  const otorgados = previo?.otorgados ?? 0;
  const bonos = bonosDeMeta(previo?.acumulado ?? 0, dinero, PROMO_META, otorgados);
  const ahoraIso = p.ahora.toISOString();
  const sentencias: D1PreparedStatement[] = [];
  for (let k = 0; k < bonos; k++) {
    const lote = crypto.randomUUID();
    sentencias.push(
      env.DB.prepare(
        `insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
         select ?4, ?1, 'promo', null, ?5, ?5, ?6, ?7, ?8 where ${BONOS_VIGENTES} = ?9`,
      ).bind(clienteId, meta.inicio, meta.fin, lote, PROMO_BONO, disponibleDesde(p.ahora), meta.vence, ahoraIso, otorgados + k),
      env.DB.prepare(
        `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
         select ?, ?, ?, 'promo', ?, ?, ? where exists (select 1 from dolarones_lotes where id = ?)`,
      ).bind(clienteId, lote, p.ventaId, PROMO_BONO, p.autor, ahoraIso, lote),
    );
  }
  return { sentencias, bonos };
}

/** Deshacer una venta: los Dolarones usados regresan a sus lotes y los ganados
 * se retiran. Para el mismo batch que marca la venta cancelada. Referidos, bono de promo y vales
 * los suma reversos.ts (un solo registro de programas, Issue #765).
 *
 * Decision de Isaac (#135): si el cliente ya gasto parte de lo ganado, la
 * cancelacion no procede sola (el trigger aborta el batch) y se aclara en la
 * tienda, igual que con los vales. ponytail: lo que regresa a un lote ya
 * vencido se pierde; la restitucion de 30 dias del plan espera aprobacion.
 */
export async function sentenciasDeCancelacion(env: Env, ventaId: string, autor: string, ahora: string): Promise<D1PreparedStatement[]> {
  // Por lote, lo canjeado menos lo que ya regreso por piezas canceladas sueltas (Issue #138).
  const { results: canjes } = await env.DB.prepare(
    `select cliente_id, lote_id, -sum(importe) as importe from dolarones_movimientos
     where venta_id = ? and tipo in ('canje', 'reverso_canje') group by cliente_id, lote_id having sum(importe) < 0`,
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
    // La bitácora ya incluye el retiro final y los retiros por piezas previas.
    // Si no cubren el importe original, hay crédito gastado: abortar todo.
    env.DB.prepare(`update dolarones_lotes set restante = case
      when importe + coalesce((select sum(importe) from dolarones_movimientos
        where lote_id = dolarones_lotes.id and tipo = 'reverso_compra'), 0) = 0
      then 0 else -1 end where venta_id = ?`).bind(ventaId),
  ];
}

/**
 * Cancelar una pieza del ticket (Issue #138): regresan `dolarones` al saldo y
 * lo ganado se recalcula sobre `pagadoRestante`, el dinero que el ticket sigue
 * teniendo cobrado. Para el mismo batch que registra la devolucion.
 *
 * Lo que regresa va al lote que vence al ultimo: al cliente le dura mas. Lo
 * ganado de más se retira; si ya se gastó, el batch aborta como al cancelar
 * el ticket completo (decisión de Isaac, #135).
 */
export async function sentenciasDeDevolucion(env: Env, p: {
  ventaId: string; dolarones: number; pagadoRestante: number; autor: string; ahora: string;
}): Promise<D1PreparedStatement[]> {
  const sentencias: D1PreparedStatement[] = [];

  let falta = p.dolarones;
  for (const canje of falta > 0 ? await canjesPendientes(env, p.ventaId) : []) {
    if (falta === 0) break;
    const regresa = Math.min(canje.importe, falta);
    falta -= regresa;
    sentencias.push(
      env.DB.prepare('update dolarones_lotes set restante = restante + ? where id = ?').bind(regresa, canje.lote_id),
      env.DB.prepare(
        `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
         values (?, ?, ?, 'reverso_canje', ?, ?, ?)`,
      ).bind(canje.cliente_id, canje.lote_id, p.ventaId, regresa, p.autor, p.ahora),
    );
  }

  const compra = await env.DB.prepare(
    `select l.id, l.cliente_id, l.importe, l.restante,
       coalesce((select -sum(importe) from dolarones_movimientos
                 where lote_id = l.id and tipo = 'reverso_compra'), 0) as retirado
     from dolarones_lotes l where l.venta_id = ?`,
  )
    .bind(p.ventaId)
    .first<{ id: string; cliente_id: string; importe: number; restante: number; retirado: number }>();
  if (compra) {
    const retira = Math.max(0, compra.importe - compra.retirado - dolaronesGanados(p.pagadoRestante));
    if (retira > 0) {
      sentencias.push(
        // Si ya se gastó crédito (también desde otra caja), aborta todo.
        env.DB.prepare(`update dolarones_lotes set restante = case
          when restante = importe + coalesce((select sum(importe) from dolarones_movimientos
            where lote_id = dolarones_lotes.id and tipo = 'reverso_compra'), 0)
          then restante - ? else -1 end where id = ?`).bind(retira, compra.id),
        env.DB.prepare(
          `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
           values (?, ?, ?, 'reverso_compra', ?, ?, ?)`,
        ).bind(compra.cliente_id, compra.id, p.ventaId, -retira, p.autor, p.ahora),
      );
    }
  }
  return sentencias;
}

/** Lo canjeado en una venta que todavia no regresa a su lote, por lote; el que vence al ultimo primero. */
async function canjesPendientes(env: Env, ventaId: string) {
  const { results } = await env.DB.prepare(
    `select m.cliente_id, m.lote_id, -sum(m.importe) as importe
     from dolarones_movimientos m join dolarones_lotes l on l.id = m.lote_id
     where m.venta_id = ? and m.tipo in ('canje', 'reverso_canje')
     group by m.cliente_id, m.lote_id having sum(m.importe) < 0
     order by max(l.vence_en) desc, m.lote_id`,
  )
    .bind(ventaId)
    .all<{ cliente_id: string; lote_id: string; importe: number }>();
  return results;
}

/** Igual que los referidos: el lote del bono se retira entero o el trigger lote_no_negativo aborta la cancelacion. */
export function sentenciasDeReversoPromo(env: Env, ventaId: string, autor: string, ahora: string): D1PreparedStatement[] {
  const bonos = `select lote_id from dolarones_movimientos where venta_id = ? and tipo = 'promo'`;
  return [
    env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
      select cliente_id, id, ?, 'reverso_promo', -restante, ?, ? from dolarones_lotes
      where restante > 0 and id in (${bonos})`).bind(ventaId, autor, ahora, ventaId),
    env.DB.prepare(`update dolarones_lotes set restante = case
      when importe + coalesce((select sum(importe) from dolarones_movimientos
        where lote_id = dolarones_lotes.id and tipo = 'reverso_promo'), 0) = 0
      then 0 else -1 end where id in (${bonos})`).bind(ventaId),
  ];
}

export const codigoAleatorio = (prefijo: 'DC' | 'DV' | 'DP') => prefijo + '-' +
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, '-').replace(/\//g, '_');

export async function hashCodigo(codigo: string): Promise<string | null> {
  if (!/^D[CV]-[A-Za-z0-9_-]{16}$/.test(codigo)) return null;
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codigo)));
}

/** El lector manda el código por POST: nunca tokens en URL, historial o logs. */
export async function buscarPorCodigo(request: Request, env: Env): Promise<Response> {
  const body = await request.json().then((c) => c ?? {}, () => ({})) as { codigo?: unknown };
  const codigo = String(body.codigo ?? '');
  const hash = await hashCodigo(codigo);
  if (!hash || !codigo.startsWith('DC-')) return json({ error: 'Código de socio inválido.' }, 400);
  const cliente = await env.DB.prepare(`select c.id, c.numero, c.nombre, c.telefono, k.maximo, k.expira_en
    from codigos_cliente k join clientes c on c.id = k.cliente_id
    where token_hash = ? and venta_id = '' and expira_en > ? and k.auth_uid = c.auth_uid`)
    .bind(hash, new Date().toISOString()).first<FilaCliente & { maximo: number; expira_en: string }>();
  if (!cliente) return json({ error: 'Código vencido o usado. Pide al cliente que genere otro.' }, 403);
  const respuesta = json(await socioConSaldo(env, cliente));
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}
