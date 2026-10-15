/**
 * Nomina interna (Issue #326, fase 2): cuanto se le debe a cada empleado y cuanto
 * se le ha pagado. Lo fiscal (IMSS, ISR, recibos timbrados) lo lleva el contador.
 *
 * Todo vive en un libro de movimientos por empleado (`nomina_movimientos`), en
 * centavos y con signo:
 *   devengo  +  sueldo del dia o de la quincena (lo pone el cron, ver devengarNomina)
 *   falta    -  un dia de sueldo (quincena / 15)
 *   pago     -  lo que se entrega MAS lo que se abona a adelantos
 *   adelanto +  dinero que se le presta
 *   abono    -  lo que se descuenta del adelanto dentro de un pago
 * Se le debe = devengo + falta + pago. Adelantos por descontar = adelanto + abono.
 *
 * Pago y adelanto salen del cajon (origen 'caja': un retiro tipo 'nomina' que el
 * corte resta) o de fuera (no toca el corte), igual que los gastos.
 */
import { CAJAS } from './cuentas.ts';
import { cajaDe } from './corte.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORTE_MAXIMO = 10_000_000;

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const texto = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fechaValida = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

// La tienda vive en UTC-6 fijo (San Luis Potosi, sin horario de verano), como corte.ts.
const hoyTienda = (ahora = Date.now()) => new Date(ahora - 6 * 3600_000).toISOString().slice(0, 10);
const quincenaDe = (fecha: string) => `${fecha.slice(0, 7)}-${Number(fecha.slice(8)) <= 15 ? '15' : 'fin'}`;

/** Un dia de sueldo: el diario completo; la quincena entre 15, al centavo mas cercano. */
const diaDeSueldo = (e: { periodo: string; sueldo: number }) =>
  e.periodo === 'diario' ? e.sueldo : Math.floor((e.sueldo + 7) / 15);

const DEBE = `coalesce(sum(case tipo when 'devengo' then importe when 'falta' then importe when 'pago' then importe else 0 end), 0)`;
const ADELANTOS = `coalesce(sum(case tipo when 'adelanto' then importe when 'abono' then importe else 0 end), 0)`;

/**
 * Lo corre el cron cada 15 min. El id de cada devengo es el empleado mas el dia
 * (o la quincena), asi que correrlo de mas no duplica nada: el diario se devenga
 * todos los dias y la quincena el 15 y el ultimo dia del mes.
 */
export async function devengarNomina(env: Env, ahora = Date.now()) {
  const fecha = hoyTienda(ahora);
  const dia = Number(fecha.slice(8));
  const ultimo = new Date(Date.UTC(Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)), 0)).getUTCDate();
  const { results } = await env.DB.prepare('select id, periodo, sueldo from empleados where activo = 1')
    .all<{ id: string; periodo: string; sueldo: number }>();
  const sql = `insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, creado_por, creado_en)
    values (?, ?, ?, 'devengo', ?, ?, 'cron', ?) on conflict (id) do nothing`;
  const creado = new Date(ahora).toISOString();
  const sentencias = results.flatMap((e) => {
    if (e.periodo === 'diario') {
      return [env.DB.prepare(sql).bind(`devengo:${e.id}:${fecha}`, e.id, fecha, e.sueldo, 'Devengo diario', creado)];
    }
    if (dia !== 15 && dia !== ultimo) return [];
    const quincena = quincenaDe(fecha);
    return [env.DB.prepare(sql).bind(`devengo:${e.id}:${quincena}`, e.id, fecha, e.sueldo, `Devengo quincenal ${quincena}`, creado)];
  });
  if (sentencias.length) await env.DB.batch(sentencias);
}

export async function rutaNomina(request: Request, env: Env, url: URL, correo: string): Promise<Response> {
  if (request.method === 'GET' && url.pathname === '/api/nomina') {
    const { results } = await env.DB.prepare(
      `select e.*,
         (select ${DEBE} from nomina_movimientos m where m.empleado_id = e.id) as debe,
         (select ${ADELANTOS} from nomina_movimientos m where m.empleado_id = e.id) as adelantos
       from empleados e order by e.activo desc, e.nombre`,
    ).all();
    return json({ empleados: results });
  }

  const edicion = /^\/api\/nomina\/empleados\/([^/]+)$/.exec(url.pathname);
  if (edicion && ['POST', 'PUT', 'DELETE'].includes(request.method)) return guardarEmpleado(request, env, edicion[1]);

  const historial = /^\/api\/nomina\/([^/]+)\/movimientos$/.exec(url.pathname);
  if (historial && UUID.test(historial[1]) && request.method === 'GET') {
    const desde = url.searchParams.get('desde') || '0000-01-01';
    const hasta = url.searchParams.get('hasta') || '9999-12-31';
    if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) return json({ error: 'Rango invalido.' }, 400);
    const { results } = await env.DB.prepare(
      `select * from nomina_movimientos where empleado_id = ? and fecha between ? and ?
       order by fecha desc, creado_en desc`,
    ).bind(historial[1], desde, hasta).all();
    return json({ movimientos: results });
  }

  if (request.method === 'POST' && url.pathname === '/api/nomina/movimientos') return registrarMovimiento(request, env, correo);
  return json({ error: 'Metodo no permitido.' }, 405);
}

/** Alta (POST con el id que manda la pantalla), cambio (PUT) o baja logica (DELETE). */
async function guardarEmpleado(request: Request, env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (request.method === 'DELETE') {
    await env.DB.prepare('update empleados set activo = 0 where id = ?').bind(id).run();
    return json({ id, activo: false });
  }
  const c = await request.json().catch(() => ({})) as Record<string, unknown>;
  const nombre = texto(c.nombre, 80);
  const periodo = String(c.periodo);
  const sueldo = Number(c.sueldo);
  if (!nombre || !['diario', 'quincenal'].includes(periodo)) return json({ error: 'Nombre o periodo invalido.' }, 400);
  if (!Number.isInteger(sueldo) || sueldo <= 0 || sueldo > 100_000_000) return json({ error: 'Sueldo invalido.' }, 400);
  if (request.method === 'POST') {
    await env.DB.prepare(
      'insert into empleados (id, nombre, periodo, sueldo, creado_en) values (?, ?, ?, ?, ?) on conflict (id) do nothing',
    ).bind(id, nombre, periodo, sueldo, new Date().toISOString()).run();
  } else {
    await env.DB.prepare('update empleados set nombre = ?, periodo = ?, sueldo = ? where id = ?')
      .bind(nombre, periodo, sueldo, id).run();
  }
  return json({ id, nombre, periodo, sueldo }, request.method === 'POST' ? 201 : 200);
}

/**
 * Falta, adelanto o pago. Idempotente por el id que manda la pantalla: un
 * reintento devuelve el movimiento ya guardado sin duplicar el retiro de caja.
 */
async function registrarMovimiento(request: Request, env: Env, correo: string): Promise<Response> {
  const c = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = typeof c.id === 'string' && UUID.test(c.id) ? c.id : '';
  const empleadoId = typeof c.empleado_id === 'string' ? c.empleado_id : '';
  const tipo = String(c.tipo);
  const fecha = c.fecha ?? hoyTienda();
  const nota = texto(c.nota, 200);
  if (!id || !UUID.test(empleadoId) || !fechaValida(fecha)) return json({ error: 'Identificador, empleado o fecha invalido.' }, 400);
  if (!['falta', 'adelanto', 'pago'].includes(tipo)) return json({ error: 'Tipo invalido.' }, 400);

  const repetido = await env.DB.prepare('select * from nomina_movimientos where id = ?').bind(id).first();
  if (repetido) return json(repetido, 201);

  const empleado = await env.DB.prepare('select * from empleados where id = ? and activo = 1')
    .bind(empleadoId).first<{ id: string; sueldo: number; periodo: string }>();
  if (!empleado) return json({ error: 'Empleado no encontrado.' }, 404);

  const importe = Number(c.importe);
  const monto = tipo === 'falta'
    ? diaDeSueldo(empleado)
    : Number.isInteger(importe) && importe > 0 && importe <= IMPORTE_MAXIMO ? importe : 0;
  if (!monto) return json({ error: 'Importe invalido.' }, 400);

  const conDinero = tipo === 'pago' || tipo === 'adelanto';
  const origen = conDinero ? c.origen : null;
  if (conDinero && origen !== 'caja' && origen !== 'fuera') return json({ error: 'Origen invalido.' }, 400);

  // El pago no puede pasar de lo que se le debe, ni el abono del adelanto pendiente.
  const abono = tipo === 'pago' ? Number(c.abono ?? 0) : 0;
  if (tipo === 'pago') {
    const saldos = await env.DB.prepare(
      `select ${DEBE} as debe, ${ADELANTOS} as adelantos from nomina_movimientos where empleado_id = ?`,
    ).bind(empleadoId).first<{ debe: number; adelantos: number }>();
    if (!Number.isInteger(abono) || abono < 0 || abono > (saldos?.adelantos ?? 0) || monto + abono > (saldos?.debe ?? 0)) {
      return json({ error: 'El pago o abono excede el saldo disponible.' }, 400);
    }
  }

  const ahora = new Date().toISOString();
  const sentencias: D1PreparedStatement[] = [];
  let caja = '';
  if (origen === 'caja') {
    caja = await cajaDe(env, correo, c.caja);
    if (!CAJAS.includes(caja)) return json({ error: 'Caja invalida.' }, 400);
    // Solo el efectivo que sale del cajon: el abono no mueve dinero.
    sentencias.push(env.DB.prepare(
      `insert into retiros (id, tipo, caja, cajero, importe, motivo, corte_id, creado_en, categoria)
       values (?, 'nomina', ?, ?, ?, ?, null, ?, '') on conflict (id) do nothing`,
    ).bind(id, caja, correo, monto, tipo === 'pago' ? 'Pago de nomina' : 'Adelanto de nomina', ahora));
  }

  const importeLibro = tipo === 'adelanto' ? monto : tipo === 'pago' ? -(monto + abono) : -monto;
  sentencias.push(env.DB.prepare(
    `insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, origen, retiro_id, creado_por, creado_en)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
  ).bind(id, empleadoId, fecha, tipo, importeLibro, nota, origen, caja ? id : null, correo, ahora));
  if (abono) {
    sentencias.push(env.DB.prepare(
      `insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, origen, creado_por, creado_en)
       values (?, ?, ?, 'abono', ?, 'Abono descontado del pago', ?, ?, ?) on conflict (id) do nothing`,
    ).bind(`${id}:abono`, empleadoId, fecha, -abono, origen, correo, ahora));
  }
  await env.DB.batch(sentencias);

  return json({
    id, empleado_id: empleadoId, fecha, tipo, importe: importeLibro,
    neto: tipo === 'pago' ? monto : null, abono, origen, retiro_id: caja ? id : null,
  }, 201);
}
