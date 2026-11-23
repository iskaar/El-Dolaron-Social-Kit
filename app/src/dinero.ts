/**
 * Recolección del efectivo de los cortes por tienda (Issue #909, fase 1 de #908). Solo gerencia (cuentas.ts).
 *
 * Un corte fija cuánto se entrega (`entregado`). Gerencia recoge, cuenta y escribe el total; quien entrega firma con su PIN.
 * Cada corte entra a una sola recolección: `recolecciones_cortes.corte_id` es llave primaria (migración 089) y las marcas y la
 * recolección se escriben en un mismo batch. Lo esperado sale de lo que de verdad quedó marcado, no de lo que mandó la pantalla:
 * si otro dispositivo se adelantó con un corte, la recolección lo deja fuera y la respuesta lo dice.
 *
 * Fase 2 (Issue #910, migración 090): saldo esperado del efectivo de gerencia desde el último arqueo, movimientos manuales y arqueos.
 * Leer /api/dinero y /dinero: gerencia y `finanzas`; escribir: solo gerencia (cuentas.ts).
 */
import { TIENDAS, tiendaDeCaja, apruebaDinero, leerRoles, leerUsuario, esTienda, type Rol } from './cuentas.ts';
import { atiende, verificarPinAprobacion } from './cajeros.ts';
import { hoyTienda } from './reportes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const CLAVE_DESDE = 'recolecciones_desde';
const MAX_CORTES = 200;
const HISTORIAL = 30;

/** Quien puede entregar el efectivo de una tienda: su personal con PIN (cajero, capturista, supervisor) o gerencia. */
const puedeEntregar = (roles: Rol[]) => atiende(roles) || apruebaDinero(roles);

interface Pendiente { id: string; caja: string; cajero: string; cajero_nombre: string | null; hasta: string; entregado: number; diferencia: number }

const desdeConfig = async (env: Env) =>
  (await env.DB.prepare('select valor from config where clave = ?').bind(CLAVE_DESDE).first<{ valor: string }>())?.valor ?? null;
const SIN_MIGRAR = () => json({ error: 'Falta actualizar el sistema (migración 089): avisa a gerencia.' }, 503);

const CON_NOMBRES = `select r.*, (select nombre from usuarios where correo = r.recibio) as recibio_nombre,
            (select nombre from usuarios where correo = r.entrego) as entrego_nombre from recolecciones r`;
const CORTES_DE = `select x.recoleccion_id, c.id, c.caja, c.hasta, c.entregado from recolecciones_cortes x join cortes c on c.id = x.corte_id`;
const conTienda = <T extends { tienda: string }>(fila: T, cortes: unknown[]) =>
  ({ ...fila, tienda_nombre: esTienda(fila.tienda) ? TIENDAS[fila.tienda].nombre : fila.tienda, cortes });

const leerRecoleccion = async (env: Env, id: string) => {
  const fila = await env.DB.prepare(`${CON_NOMBRES} where r.id = ?`).bind(id).first<Record<string, unknown> & { tienda: string }>();
  if (!fila) return null;
  const { results: cortes } = await env.DB.prepare(`select c.id, c.caja, c.hasta, c.entregado from recolecciones_cortes x join cortes c on c.id = x.corte_id
     where x.recoleccion_id = ? order by c.hasta`).bind(id).all();
  return conTienda(fila, cortes);
};

async function listar(env: Env, correo: string): Promise<Response> {
  const desde = await desdeConfig(env);
  if (desde === null) return SIN_MIGRAR();
  const { results: pendientes } = await env.DB.prepare(
    `select c.id, c.caja, c.cajero, u.nombre as cajero_nombre, c.hasta, c.entregado, c.diferencia from cortes c
       left join usuarios u on u.correo = c.cajero
      where c.entregado > 0 and c.hasta >= ? and not exists (select 1 from recolecciones_cortes x where x.corte_id = c.id)
      order by c.hasta`,
  ).bind(desde).all<Pendiente>();
  const { results: usuarios } = await env.DB.prepare(
    `select correo, nombre, roles, tienda from usuarios where activo = 1 and pin_hash != '' order by nombre`,
  ).all<{ correo: string; nombre: string; roles: string; tienda: string }>();
  const tiendas = (Object.keys(TIENDAS) as (keyof typeof TIENDAS)[]).map((clave) => {
    const cortes = pendientes.filter((c) => tiendaDeCaja(c.caja) === clave);
    return {
      clave, nombre: TIENDAS[clave].nombre, cortes, total: cortes.reduce((suma, c) => suma + c.entregado, 0),
      // Quienes pueden firmar la entrega: personal de esa tienda (sin tienda cuenta como Soledad, igual que en la caja) y gerencia.
      personal: usuarios.filter((u) => {
        const roles = leerRoles(u.roles);
        return puedeEntregar(roles) && (roles.includes('dueno') || (esTienda(u.tienda) ? u.tienda : 'soledad') === clave);
      }).map(({ correo, nombre }) => ({ correo, nombre })),
    };
  });
  // Historial en dos consultas (las últimas recolecciones y todos sus cortes), agrupado aquí.
  const { results: ultimas } = await env.DB.prepare(`${CON_NOMBRES} order by r.creado_en desc, r.id limit ?`)
    .bind(HISTORIAL).all<Record<string, unknown> & { id: string; tienda: string }>();
  const { results: deEllas } = await env.DB.prepare(`${CORTES_DE} where x.recoleccion_id in (select value from json_each(?)) order by c.hasta`)
    .bind(JSON.stringify(ultimas.map((r) => r.id))).all<{ recoleccion_id: string; id: string; caja: string; hasta: string; entregado: number }>();
  const recolecciones = ultimas.map((r) =>
    conTienda(r, deEllas.filter((c) => c.recoleccion_id === r.id).map(({ id, caja, hasta, entregado }) => ({ id, caja, hasta, entregado }))));
  const extra = await caja(env, correo);
  // Quien solo lee (`finanzas`) no firma entregas: no recibe la lista de personal con PIN.
  return json({ desde, tiendas: extra.puede_escribir ? tiendas : tiendas.map((t) => ({ ...t, personal: [] })), recolecciones, ...extra });
}

// --- Caja de gerencia (#910) ---

/** Una fila cuenta si es posterior al arqueo: fecha mayor, o la misma fecha y registrada después. Binds: ?1 = creado_en del arqueo, ?2 = su fecha. */
const POSTERIOR = '(fecha > ?2 or (fecha = ?2 and creado_en > ?1))';
const suma = (columna: string, tabla: string, donde: string) => `(select coalesce(sum(${columna}), 0) from ${tabla} where ${donde})`;
const SALDO = `select
  ${suma('contado', 'recolecciones', 'creado_en > ?1')} as recolecciones,
  ${suma('importe', 'retiros', "tipo = 'terminal' and caja = '' and creado_en > ?1")} as terminal,
  ${suma('importe', 'dinero_movimientos', `tipo = 'entrada' and ${POSTERIOR}`)} as entradas,
  ${suma('importe', 'gastos', `origen = 'fuera' and pagado_con = 'efectivo' and ${POSTERIOR}`)} as gastos,
  ${suma('abs(importe)', 'nomina_movimientos', `origen = 'fuera' and pagado_con = 'efectivo' and tipo in ('pago', 'adelanto') and ${POSTERIOR}`)} as nomina,
  ${suma('importe', 'dinero_movimientos', `tipo = 'deposito' and ${POSTERIOR}`)} as depositos,
  ${suma('importe', 'dinero_movimientos', `tipo = 'a_tienda' and ${POSTERIOR}`)} as a_tienda,
  ${suma('importe', 'dinero_movimientos', `tipo = 'salida' and ${POSTERIOR}`)} as salidas`;

interface Arqueo { id: string; fecha: string; esperado: number; contado: number; diferencia: number; nota: string; creado_por: string; creado_en: string }
type Desglose = Record<'recolecciones' | 'terminal' | 'entradas' | 'gastos' | 'nomina' | 'depositos' | 'a_tienda' | 'salidas', number>;

/** Saldo esperado desde `arqueo`: lo contado entonces más lo que entró y menos lo que salió después. */
async function saldoDesde(env: Env, arqueo: Arqueo) {
  const d = (await env.DB.prepare(SALDO).bind(arqueo.creado_en, arqueo.fecha).first<Desglose>())!;
  const esperado = arqueo.contado + d.recolecciones + d.terminal + d.entradas - d.gastos - d.nomina - d.depositos - d.a_tienda - d.salidas;
  return { arqueo: arqueo.id, desde: arqueo.creado_en, base: arqueo.contado, ...d, esperado };
}

const ultimoArqueo = (env: Env) =>
  env.DB.prepare('select * from arqueos order by creado_en desc, id limit 1').first<Arqueo>();
const NOMBRE = (columna: string) => `(select nombre from usuarios where correo = ${columna})`;
const SIN_MIGRAR_090 = () => json({ error: 'Falta actualizar el sistema (migración 090): avisa a gerencia.' }, 503);
const migrada = (env: Env) => env.DB.prepare('select 1 from arqueos limit 0').first().then(() => true, () => false);

/** ¿Ya existe la columna `pagado_con`? Gastos y nómina siguen guardando si el código llega antes que la migración 090. */
export const tienePagadoCon = (env: Env, tabla: 'gastos' | 'nomina_movimientos') =>
  env.DB.prepare(`select pagado_con from ${tabla} limit 0`).first().then(() => true, () => false);

/** «¿Con qué se pagó?» de un gasto o pago de nómina: solo importa con origen 'fuera' (Efectivo por omisión, también para un cliente viejo); null = inválido. */
export const pagadoCon = (origen: unknown, valor: unknown): 'efectivo' | 'banco' | '' | null =>
  origen !== 'fuera' ? '' : valor === undefined || valor === null || valor === '' ? 'efectivo' : valor === 'efectivo' || valor === 'banco' ? valor : null;

/** Lo que /api/dinero suma a la fase 1: saldo, últimos arqueos y movimientos, y si quien mira puede escribir. Siempre las mismas consultas. */
async function caja(env: Env, correo: string) {
  const puede_escribir = (await leerUsuario(env, correo))?.roles.includes('dueno') ?? false;
  if (!(await migrada(env))) return { caja_lista: false, puede_escribir, saldo: null, arqueos: [], movimientos: [] };
  const { results: arqueos } = await env.DB.prepare(
    `select a.*, ${NOMBRE('a.creado_por')} as creado_por_nombre from arqueos a order by a.creado_en desc, a.id limit ?`).bind(HISTORIAL).all<Arqueo>();
  const { results: movimientos } = await env.DB.prepare(
    `select m.*, ${NOMBRE('m.creado_por')} as creado_por_nombre from dinero_movimientos m order by m.creado_en desc, m.id limit ?`).bind(HISTORIAL).all();
  // Sin arqueo todavía no hay saldo: la pantalla pide el primero.
  return { caja_lista: true, puede_escribir, saldo: arqueos[0] ? await saldoDesde(env, arqueos[0]) : null, arqueos, movimientos };
}

async function movimiento(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const tipo = String(cuerpo.tipo ?? '');
  const importe = Number(cuerpo.importe);
  const nota = texto(cuerpo.nota, 300);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!['deposito', 'a_tienda', 'entrada', 'salida'].includes(tipo)) return json({ error: 'Tipo de movimiento invalido.' }, 400);
  if (!Number.isInteger(importe) || importe <= 0 || importe > 100_000_000) return json({ error: 'Importe invalido.' }, 400);
  if ((tipo === 'entrada' || tipo === 'salida') && !nota) return json({ error: 'Escribe una nota que explique el movimiento.' }, 400);
  if (!(await migrada(env))) return SIN_MIGRAR_090();
  const leer = () => env.DB.prepare('select * from dinero_movimientos where id = ?').bind(id).first();
  const previo = await leer();
  if (previo) return json({ ...previo, repetida: true });
  // Sin arqueo no hay saldo que mover: el movimiento se perdería en silencio al hacer el primero.
  if (!(await ultimoArqueo(env))) return json({ error: 'Haz primero el arqueo inicial.' }, 409);
  const ahora = new Date().toISOString();
  await env.DB.prepare(
    `insert into dinero_movimientos (id, fecha, tipo, importe, nota, creado_por, creado_en) values (?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
  ).bind(id, hoyTienda(Date.parse(ahora)), tipo, importe, nota, correo, ahora).run();
  return json(await leer(), 201);
}

async function arqueo(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const contado = Number(cuerpo.contado);
  const nota = texto(cuerpo.nota, 300);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!Number.isInteger(contado) || contado < 0 || contado > 100_000_000) return json({ error: 'Total contado invalido.' }, 400);
  if (!(await migrada(env))) return SIN_MIGRAR_090();
  const leer = () => env.DB.prepare('select * from arqueos where id = ?').bind(id).first<Arqueo>();
  const previo = await leer();
  if (previo) return json({ ...previo, repetida: true });

  // `ahora` antes de leer el saldo: lo que se registre mientras se calcula queda después del arqueo y cuenta en el siguiente.
  const ahora = new Date().toISOString();
  const ultimo = await ultimoArqueo(env);
  // El primer arqueo es el saldo inicial: lo contado es lo esperado, sin diferencia.
  const esperado = ultimo ? (await saldoDesde(env, ultimo)).esperado : contado;
  const diferencia = contado - esperado;
  if (diferencia !== 0 && !nota) return json({ error: 'Hay diferencia entre lo esperado y lo contado: escribe una nota que la explique.' }, 400);
  // Solo se inserta si el último arqueo sigue siendo el que se leyó: dos arqueos a la vez no calculan sobre el mismo anterior.
  const resultado = await env.DB.prepare(
    `insert into arqueos (id, fecha, esperado, contado, diferencia, nota, creado_por, creado_en)
     select ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 where (select coalesce(max(creado_en), '') from arqueos) = ?9
     on conflict (id) do nothing`,
  ).bind(id, hoyTienda(Date.parse(ahora)), esperado, contado, diferencia, nota, correo, ahora, ultimo?.creado_en ?? '').run();
  if (!resultado.meta.changes) {
    const ya = await leer();
    return ya ? json({ ...ya, repetida: true }) : json({ error: 'Otro arqueo se registró mientras contabas: abre /dinero otra vez.' }, 409);
  }
  return json(await leer(), 201);
}

async function recoger(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const tienda = String(cuerpo.tienda ?? '');
  const contado = Number(cuerpo.contado);
  const nota = texto(cuerpo.nota, 300);
  const pedidos = Array.isArray(cuerpo.cortes) ? [...new Set(cuerpo.cortes.map(String))] : [];
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!esTienda(tienda)) return json({ error: 'Tienda invalida.' }, 400);
  if (pedidos.length === 0 || pedidos.length > MAX_CORTES || !pedidos.every((c) => UUID.test(c))) return json({ error: 'Elige los cortes que recoges.' }, 400);
  if (!Number.isInteger(contado) || contado < 0 || contado > 100_000_000) return json({ error: 'Total contado invalido.' }, 400);

  const desde = await desdeConfig(env);
  if (desde === null) return SIN_MIGRAR();

  // Reenvío tras red caída: la misma recolección, sin volver a pedir el PIN ni a marcar nada.
  const previo = await leerRecoleccion(env, id);
  if (previo) return previo.tienda === tienda ? json({ ...previo, repetida: true }) : json({ error: 'Ese identificador ya se usó en otra tienda.' }, 409);

  // Firma de quien entrega: su PIN, con los 5 intentos y 15 minutos de la aprobación (cajeros.ts), contados aparte de su acceso a la caja.
  // Sin `entrego` se guarda sin firma. No se firma a uno mismo. Un PIN malo no registra nada: se verifica antes de tocar los cortes.
  let entrego = '';
  if (cuerpo.entrego) {
    entrego = String(cuerpo.entrego).trim().toLowerCase();
    if (entrego === correo) return json({ error: 'Quien recibe no puede firmar la entrega: elige a quien entrega.' }, 400);
    const firma = await verificarPinAprobacion(env, entrego, String(cuerpo.pin ?? ''), `recoleccion:${tienda}`, puedeEntregar, tienda);
    if ('error' in firma) return json({ error: firma.error }, firma.status);
    entrego = firma.fila.correo;
  }

  // Candidatos: de lo pedido, de esta tienda, aún sin recolección y desde la fecha de arranque.
  const { results: candidatos } = await env.DB.prepare(
    `select c.id, c.caja, c.entregado from cortes c
      where c.id in (select value from json_each(?)) and c.entregado > 0 and c.hasta >= ?
        and not exists (select 1 from recolecciones_cortes x where x.corte_id = c.id)`,
  ).bind(JSON.stringify(pedidos), desde).all<{ id: string; caja: string; entregado: number }>();
  const propios = candidatos.filter((c) => tiendaDeCaja(c.caja) === tienda);
  if (propios.length === 0) return json({ error: 'Esos cortes ya no están pendientes en esta tienda: abre /dinero otra vez.' }, 409);
  const previsto = propios.reduce((suma, c) => suma + c.entregado, 0);
  if (contado !== previsto && !nota) return json({ error: 'Hay diferencia entre lo esperado y lo contado: escribe una nota que la explique.' }, 400);

  // Marcar y registrar en un mismo batch. Lo esperado se calcula de lo que de verdad quedó marcado (otro dispositivo pudo adelantarse entre
  // la lectura y aquí); si no quedó marcado ninguno, no se inserta nada. Los candidatos se vuelven a filtrar en SQL.
  const ahora = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `insert into recolecciones_cortes (corte_id, recoleccion_id)
         select c.id, ?1 from cortes c
          where c.id in (select value from json_each(?2)) and c.entregado > 0 and c.hasta >= ?3
            and not exists (select 1 from recolecciones_cortes x where x.corte_id = c.id)`,
      ).bind(id, JSON.stringify(propios.map((c) => c.id)), desde),
      env.DB.prepare(
        `insert into recolecciones (id, tienda, recibio, entrego, esperado, contado, diferencia, nota, creado_en)
         select ?1, ?2, ?3, ?4, suma, ?5, ?5 - suma, ?6, ?7
           from (select coalesce(sum(c.entregado), 0) as suma, count(*) as n
                   from recolecciones_cortes x join cortes c on c.id = x.corte_id where x.recoleccion_id = ?1)
          where n > 0`,
      ).bind(id, tienda, correo, entrego, contado, nota, ahora),
    ]);
  } catch (error) {
    // Dos envíos del mismo id a la vez: el segundo choca con la llave y el primero ya quedó.
    const ya = await leerRecoleccion(env, id);
    if (ya) return json({ ...ya, repetida: true });
    // La diferencia pedía nota y lo pendiente cambió entre la lectura y el batch: el batch se deshizo entero.
    if (String(error).includes('CHECK constraint')) return json({ error: 'Lo pendiente cambió mientras contabas: abre /dinero otra vez.' }, 409);
    throw error;
  }
  const recoleccion = await leerRecoleccion(env, id);
  // Ningún corte quedó marcado (otro dispositivo se adelantó con todos): no se creó nada.
  if (!recoleccion) return json({ error: 'Esos cortes ya los recogió otro dispositivo: abre /dinero otra vez.' }, 409);
  const tomados = recoleccion.cortes.length;
  return json({ ...recoleccion, pedidos: pedidos.length, tomados, parcial: tomados < pedidos.length }, 201);
}

async function cambiarDesde(request: Request, env: Env): Promise<Response> {
  const { desde } = (await request.json().catch(() => ({}))) as { desde?: unknown };
  // Una fecha (AAAA-MM-DD) es la medianoche de la tienda (UTC-6); también se acepta un ISO completo.
  const crudo = typeof desde === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(desde) ? `${desde}T06:00:00.000Z` : desde;
  const fecha = typeof crudo === 'string' ? new Date(crudo) : null;
  if (!fecha || Number.isNaN(fecha.valueOf())) return json({ error: 'Fecha invalida.' }, 400);
  const resultado = await env.DB.prepare('update config set valor = ? where clave = ?').bind(fecha.toISOString(), CLAVE_DESDE).run();
  if (!resultado.meta.changes) return SIN_MIGRAR();
  return json({ desde: fecha.toISOString() });
}

export async function rutaDinero(request: Request, env: Env, url: URL, correo: string): Promise<Response> {
  if (url.pathname === '/api/dinero' && request.method === 'GET') return listar(env, correo);
  if (url.pathname === '/api/dinero/movimientos' && request.method === 'POST') return movimiento(request, env, correo);
  if (url.pathname === '/api/dinero/arqueos' && request.method === 'POST') return arqueo(request, env, correo);
  if (url.pathname === '/api/dinero/recolecciones' && request.method === 'POST') return recoger(request, env, correo);
  if (url.pathname === '/api/dinero/desde' && request.method === 'PUT') return cambiarDesde(request, env);
  return json({ error: 'Metodo no permitido.' }, 405);
}
