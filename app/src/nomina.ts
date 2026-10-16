/** Nómina interna (Issue #326): centavos MXN y un libro de movimientos por empleado.
 * Devengo, adelanto y bono son positivos; pago, abono y ajuste son negativos.
 * Se le debe = devengo + pago + abono + ajuste + bono. Adelantos por descontar = adelanto + abono.
 * Pago y adelanto de caja crean un retiro 'nomina' que el corte resta; fuera no toca el corte.
 */
import { CAJAS } from './cuentas.ts';
import { cajaDe } from './corte.ts';
import { hashPin } from './dolarones.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN_INTENTOS = 5;
const IMPORTE_MAXIMO = 10_000_000;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const texto = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fechaValida = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) && new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;
const hoyTienda = (ahora = Date.now()) => new Date(ahora - 6 * 3600_000).toISOString().slice(0, 10);
const DEBE = `coalesce(sum(case tipo when 'devengo' then importe when 'pago' then importe
  when 'abono' then importe when 'ajuste' then importe when 'bono' then importe else 0 end), 0)`;
const ADELANTOS = `coalesce(sum(case tipo when 'adelanto' then importe when 'abono' then importe else 0 end), 0)`;

interface ConfigNomina {
  checador_activo: number;
  bono_centavos: number;
  tolerancia_minutos: number;
  retardos_permitidos: number;
  faltas_permitidas: number;
}

async function configNomina(env: Env): Promise<ConfigNomina> {
  return await env.DB.prepare('select * from nomina_config where id = 1').first<ConfigNomina>() ?? {
    checador_activo: 0, bono_centavos: 0, tolerancia_minutos: 0, retardos_permitidos: 0, faltas_permitidas: 0,
  };
}

export async function rutaNomina(request: Request, env: Env, url: URL, correo: string): Promise<Response> {
  if (request.method === 'GET' && url.pathname === '/api/nomina/checador') {
    if (!(await configNomina(env)).checador_activo) return json({ error: 'Checador apagado.' }, 404);
    const { results } = await env.DB.prepare('select id, nombre from empleados where activo=1 order by nombre').all();
    return json({ empleados: results });
  }
  if (request.method === 'POST' && url.pathname === '/api/nomina/entrada') return marcarEntrada(request, env);
  if (request.method === 'GET' && url.pathname === '/api/nomina') {
    const { results } = await env.DB.prepare(
      `select e.id, e.nombre, e.periodo, e.pago_dia, e.dias, e.hora_entrada, e.activo,
         (select ${DEBE} from nomina_movimientos m where m.empleado_id = e.id) as debe,
         (select ${ADELANTOS} from nomina_movimientos m where m.empleado_id = e.id) as adelantos
       from empleados e order by e.activo desc, e.nombre`,
    ).all();
    return json({ empleados: results, config: await configNomina(env) });
  }

  if (request.method === 'PUT' && url.pathname === '/api/nomina/config') return guardarConfig(request, env);
  const edicion = /^\/api\/nomina\/empleados\/([^/]+)$/.exec(url.pathname);
  if (edicion && ['POST', 'PUT', 'DELETE'].includes(request.method)) return guardarEmpleado(request, env, edicion[1]);
  const historial = /^\/api\/nomina\/([^/]+)\/movimientos$/.exec(url.pathname);
  if (historial && UUID.test(historial[1]) && request.method === 'GET') {
    const desde = url.searchParams.get('desde') || '0000-01-01';
    const hasta = url.searchParams.get('hasta') || '9999-12-31';
    if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) return json({ error: 'Rango inválido.' }, 400);
    const { results } = await env.DB.prepare(
      `select * from nomina_movimientos where empleado_id = ? and fecha between ? and ?
       order by fecha desc, creado_en desc`,
    ).bind(historial[1], desde, hasta).all();
    return json({ movimientos: results });
  }
  const periodo = /^\/api\/nomina\/([^/]+)\/periodo$/.exec(url.pathname);
  if (periodo && UUID.test(periodo[1]) && request.method === 'GET') return resumenPeriodo(env, periodo[1]);
  if (request.method === 'POST' && url.pathname === '/api/nomina/movimientos') {
    return registrarMovimiento(request, env, correo);
  }
  return json({ error: 'Método no permitido.' }, 405);
}

async function guardarConfig(request: Request, env: Env): Promise<Response> {
  const c = await request.json().catch(() => ({})) as Record<string, unknown>;
  const checador = c.checador_activo === true;
  const bono = Number(c.bono_centavos);
  const tolerancia = Number(c.tolerancia_minutos);
  const retardos = Number(c.retardos_permitidos);
  const faltas = Number(c.faltas_permitidas);
  if (![bono, tolerancia, retardos, faltas].every(Number.isInteger) || bono < 0 || bono > IMPORTE_MAXIMO
      || tolerancia < 0 || tolerancia > 240 || retardos < 0 || retardos > 31 || faltas < 0 || faltas > 31) {
    return json({ error: 'Configuración del bono inválida.' }, 400);
  }
  await env.DB.prepare(
    `insert into nomina_config (id, checador_activo, bono_centavos, tolerancia_minutos, retardos_permitidos, faltas_permitidas)
     values (1, ?, ?, ?, ?, ?) on conflict(id) do update set checador_activo=excluded.checador_activo,
       bono_centavos=excluded.bono_centavos, tolerancia_minutos=excluded.tolerancia_minutos,
       retardos_permitidos=excluded.retardos_permitidos, faltas_permitidas=excluded.faltas_permitidas`,
  ).bind(checador ? 1 : 0, bono, tolerancia, retardos, faltas).run();
  return json(await configNomina(env));
}

async function marcarEntrada(request: Request, env: Env): Promise<Response> {
  const config = await configNomina(env);
  if (!config.checador_activo) return json({ error: 'Checador apagado.' }, 404);
  const c = await request.json().catch(() => ({})) as Record<string, unknown>;
  const empleadoId = String(c.empleado_id ?? '');
  const pin = String(c.pin ?? '');
  if (!UUID.test(empleadoId) || !/^\d{6}$/.test(pin)) return json({ error: 'Empleado o PIN inválido.' }, 400);
  const empleado = await env.DB.prepare('select id, pin_hash, pin_fallos, pin_bloqueo from empleados where id = ? and activo = 1')
    .bind(empleadoId).first<{ id: string; pin_hash: string; pin_fallos: number; pin_bloqueo: string }>();
  if (!empleado) return json({ error: 'Empleado no encontrado.' }, 404);
  const ahora = new Date().toISOString();
  // Una entrada vale un dia de sueldo: tras PIN_INTENTOS fallos se bloquea 15 min, como el PIN de cajero.
  if (empleado.pin_bloqueo > ahora) return json({ error: 'PIN bloqueado por intentos fallidos. Espera 15 minutos.' }, 423);
  const [sal, hash] = empleado.pin_hash.split(':');
  if (!sal || !hash || await hashPin(pin, sal) !== hash) {
    const bloqueo = empleado.pin_fallos + 1 >= PIN_INTENTOS ? new Date(Date.now() + 15 * 60_000).toISOString() : '';
    await env.DB.prepare('update empleados set pin_fallos = ?, pin_bloqueo = ? where id = ?')
      .bind(bloqueo ? 0 : empleado.pin_fallos + 1, bloqueo, empleadoId).run();
    return json({ error: 'PIN incorrecto.' }, 401);
  }
  if (empleado.pin_fallos) await env.DB.prepare('update empleados set pin_fallos = 0 where id = ?').bind(empleadoId).run();
  const fecha = hoyTienda();
  const id = `devengo:${empleadoId}:${fecha}`;
  const existente = await env.DB.prepare('select fecha from asistencias where empleado_id = ? and fecha = ?')
    .bind(empleadoId, fecha).first();
  if (existente) return json({ fecha, repetida: true });
  await env.DB.batch([
    env.DB.prepare('insert into asistencias (empleado_id, fecha, entrada, origen) values (?, ?, ?, ?) on conflict do nothing')
      .bind(empleadoId, fecha, ahora, 'pin'),
    env.DB.prepare(`insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, creado_por, creado_en)
      values (?, ?, ?, 'devengo', (select pago_dia from empleados where id = ?), 'Entrada marcada', 'checador', ?)
      on conflict(id) do nothing`).bind(id, empleadoId, fecha, empleadoId, ahora),
  ]);
  return json({ fecha, repetida: false }, 201);
}

async function guardarEmpleado(request: Request, env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  if (request.method === 'DELETE') {
    await env.DB.prepare('update empleados set activo = 0 where id = ?').bind(id).run();
    return json({ id, activo: false });
  }
  const c = await request.json().catch(() => ({})) as Record<string, unknown>;
  const nombre = texto(c.nombre, 80);
  const periodo = String(c.periodo);
  const pagoDia = Number(c.pago_dia);
  const dias = Array.isArray(c.dias) ? c.dias : [];
  const hora = c.hora_entrada === '' || c.hora_entrada == null ? null : String(c.hora_entrada);
  const pin = String(c.pin ?? '');
  if (!nombre || !['diario', 'quincenal'].includes(periodo)) return json({ error: 'Nombre o periodo inválido.' }, 400);
  if (!Number.isInteger(pagoDia) || pagoDia <= 0 || pagoDia > IMPORTE_MAXIMO) return json({ error: 'Pago diario inválido.' }, 400);
  if (!dias.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return json({ error: 'Días inválidos.' }, 400);
  if (hora !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return json({ error: 'Hora de entrada inválida.' }, 400);
  if (pin && !/^\d{6}$/.test(pin)) return json({ error: 'El PIN debe tener 6 dígitos.' }, 400);
  const existente = await env.DB.prepare('select pin_hash from empleados where id = ?').bind(id).first<{ pin_hash: string }>();
  let pinHash = existente?.pin_hash ?? '';
  if (pin) {
    const sal = crypto.getRandomValues(new Uint8Array(16));
    const salHex = [...sal].map((b) => b.toString(16).padStart(2, '0')).join('');
    pinHash = `${salHex}:${await hashPin(pin, salHex)}`;
  }
  if (!pinHash) return json({ error: 'Asigna un PIN de 6 dígitos al empleado.' }, 400);
  if (request.method === 'POST') {
    await env.DB.prepare(`insert into empleados (id, nombre, periodo, pago_dia, dias, hora_entrada, pin_hash, creado_en)
      values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do nothing`)
      .bind(id, nombre, periodo, pagoDia, JSON.stringify(dias), hora, pinHash, new Date().toISOString()).run();
  } else {
    await env.DB.prepare(`update empleados set nombre=?, periodo=?, pago_dia=?, dias=?, hora_entrada=?, pin_hash=? where id=?`)
      .bind(nombre, periodo, pagoDia, JSON.stringify(dias), hora, pinHash, id).run();
  }
  return json({ id, nombre, periodo, pago_dia: pagoDia, dias, hora_entrada: hora, tiene_pin: !!pinHash }, request.method === 'POST' ? 201 : 200);
}

async function resumenPeriodo(env: Env, empleadoId: string): Promise<Response> {
  const empleado = await env.DB.prepare('select id, dias, hora_entrada, creado_en from empleados where id = ? and activo = 1')
    .bind(empleadoId).first<{ id: string; dias: string; hora_entrada: string | null; creado_en: string }>();
  if (!empleado) return json({ error: 'Empleado no encontrado.' }, 404);
  const config = await configNomina(env);
  const pago = await env.DB.prepare(`select fecha from nomina_movimientos where empleado_id=? and tipo='pago'
    order by creado_en desc limit 1`).bind(empleadoId).first<{ fecha: string }>();
  const creadoMs = Date.parse(empleado.creado_en);
  const desde = pago?.fecha ?? (Number.isNaN(creadoMs) ? (empleado.creado_en.slice(0, 10) || hoyTienda()) : hoyTienda(creadoMs));
  const hasta = hoyTienda();
  const inicio = new Date(`${desde}T12:00:00Z`);
  if (pago) inicio.setUTCDate(inicio.getUTCDate() + 1);
  const dias: number[] = JSON.parse(empleado.dias);
  const { results: asistencias } = await env.DB.prepare(
    'select fecha, entrada from asistencias where empleado_id=? and fecha>? and fecha<=?',
  ).bind(empleadoId, pago?.fecha ?? new Date(inicio.getTime() - 86400_000).toISOString().slice(0, 10), hasta)
    .all<{ fecha: string; entrada: string }>();
  const marcadas = new Map(asistencias.map((a) => [a.fecha, a.entrada]));
  let faltas = 0;
  let retardos = 0;
  for (let fecha = inicio; ; fecha.setUTCDate(fecha.getUTCDate() + 1)) {
    const dia = fecha.toISOString().slice(0, 10);
    if (dia > hasta) break;
    if (dias.includes(fecha.getUTCDay())) {
      const entrada = marcadas.get(dia);
      if (!entrada) faltas++;
      else if (empleado.hora_entrada) {
        const hora = new Date(Date.parse(entrada) - 6 * 3600_000).toISOString().slice(11, 16);
        const minutos = (Number(hora.slice(0, 2)) * 60) + Number(hora.slice(3));
        const esperada = Number(empleado.hora_entrada.slice(0, 2)) * 60 + Number(empleado.hora_entrada.slice(3));
        if (minutos > esperada + config.tolerancia_minutos) retardos++;
      }
    }
  }
  const bonoSugerido = config.checador_activo && faltas <= config.faltas_permitidas
    && retardos <= config.retardos_permitidos ? config.bono_centavos : 0;
  return json({ desde, hasta, faltas, retardos, bono_sugerido: bonoSugerido });
}

async function registrarMovimiento(request: Request, env: Env, correo: string): Promise<Response> {
  const c = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = typeof c.id === 'string' && UUID.test(c.id) ? c.id : '';
  const empleadoId = typeof c.empleado_id === 'string' ? c.empleado_id : '';
  const tipo = String(c.tipo);
  const fecha = c.fecha ?? hoyTienda();
  const nota = texto(c.nota, 200);
  if (!id || !UUID.test(empleadoId) || !fechaValida(fecha)) return json({ error: 'Identificador, empleado o fecha inválido.' }, 400);
  if (!['devengo', 'ajuste', 'adelanto', 'pago'].includes(tipo)) return json({ error: 'Tipo inválido.' }, 400);
  if (tipo === 'devengo' && c.origen !== 'manual') return json({ error: 'El día trabajado requiere registro manual.' }, 400);
  const repetido = await env.DB.prepare('select * from nomina_movimientos where id = ?').bind(id).first();
  if (repetido) return json(repetido, 201);
  const empleado = await env.DB.prepare('select pago_dia from empleados where id=? and activo=1')
    .bind(empleadoId).first<{ pago_dia: number }>();
  if (!empleado) return json({ error: 'Empleado no encontrado.' }, 404);
  const monto = tipo === 'devengo' ? empleado.pago_dia : Number(c.importe);
  if (!Number.isInteger(monto) || monto <= 0 || monto > IMPORTE_MAXIMO) return json({ error: 'Importe inválido.' }, 400);
  if (tipo === 'devengo') {
    const diaId = `devengo:${empleadoId}:${fecha}`;
    const marcado = await env.DB.prepare('select id from nomina_movimientos where id=?').bind(diaId).first();
    if (marcado) return json({ error: 'Ese día ya se devengó.' }, 409);
    if (c.origen === 'manual') {
      const entrada = await env.DB.prepare('select fecha from asistencias where empleado_id=? and fecha=?')
        .bind(empleadoId, fecha).first();
      if (entrada) return json({ error: 'Ese día ya tiene entrada.' }, 409);
    }
  }
  if (tipo === 'ajuste') {
    const diaId = `devengo:${empleadoId}:${fecha}`;
    if (!await env.DB.prepare('select id from nomina_movimientos where id=?').bind(diaId).first()) {
      return json({ error: 'No hay día devengado para quitar.' }, 404);
    }
  }
  const origen = ['pago', 'adelanto'].includes(tipo) ? c.origen : null;
  if (['pago', 'adelanto'].includes(tipo) && origen !== 'caja' && origen !== 'fuera') return json({ error: 'Origen inválido.' }, 400);
  let bono = 0;
  let resumen: Record<string, number> = { faltas: 0, retardos: 0 };
  if (tipo === 'pago') {
    const config = await configNomina(env);
    const periodo = await resumenPeriodo(env, empleadoId);
    const calculado = await periodo.json() as Record<string, number>;
    resumen = calculado;
    bono = Number(c.bono ?? 0);
    if (!Number.isInteger(bono) || bono < 0 || bono > IMPORTE_MAXIMO || (!config.checador_activo && bono > 0)) {
      return json({ error: 'Bono inválido.' }, 400);
    }
    if (bono > (calculado.bono_sugerido ?? 0) && !nota) {
      return json({ error: 'Escribe una nota para el bono manual.' }, 400);
    }
  }
  const abono = tipo === 'pago' ? Number(c.abono ?? 0) : 0;
  if (tipo === 'pago') {
    const saldos = await env.DB.prepare(`select ${DEBE} as debe, ${ADELANTOS} as adelantos from nomina_movimientos
      where empleado_id=?`).bind(empleadoId).first<{ debe: number; adelantos: number }>();
    if (!Number.isInteger(abono) || abono < 0 || abono > (saldos?.adelantos ?? 0)
        || monto + abono > (saldos?.debe ?? 0) + bono) return json({ error: 'El pago o abono excede el saldo disponible.' }, 400);
  }
  const ahora = new Date().toISOString();
  const sentencias: D1PreparedStatement[] = [];
  let caja = '';
  if (origen === 'caja') {
    caja = await cajaDe(env, correo, c.caja);
    if (!CAJAS.includes(caja)) return json({ error: 'Caja inválida.' }, 400);
    sentencias.push(env.DB.prepare(`insert into retiros (id,tipo,caja,cajero,importe,motivo,corte_id,creado_en,categoria)
      values (?, 'nomina', ?, ?, ?, ?, null, ?, '') on conflict(id) do nothing`)
      .bind(id, caja, correo, monto, tipo === 'pago' ? 'Pago de nómina' : 'Adelanto de nómina', ahora));
  }
  const importeLibro = ['adelanto', 'devengo'].includes(tipo) ? monto : -monto;
  const movimientoId = tipo === 'devengo' ? `devengo:${empleadoId}:${fecha}` : id;
  sentencias.push(env.DB.prepare(`insert into nomina_movimientos (id,empleado_id,fecha,tipo,importe,nota,origen,retiro_id,creado_por,creado_en)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(id) do nothing`)
    .bind(movimientoId, empleadoId, fecha, tipo, tipo === 'pago' ? -monto : importeLibro,
      nota, origen, caja ? id : null, correo, ahora));
  if (tipo === 'pago' && bono > 0) {
    sentencias.push(env.DB.prepare(`insert into nomina_movimientos (id,empleado_id,fecha,tipo,importe,nota,origen,creado_por,creado_en)
      values (?, ?, ?, 'bono', ?, ?, ?, ?, ?) on conflict(id) do nothing`)
      .bind(`${id}:bono`, empleadoId, fecha, bono, nota || 'Bono de nómina', origen, correo, ahora));
  }
  if (tipo === 'devengo' && c.origen === 'manual') {
    sentencias.push(env.DB.prepare(`insert into asistencias (empleado_id, fecha, entrada, origen) values (?, ?, ?, 'manual')
      on conflict(empleado_id, fecha) do nothing`)
      .bind(empleadoId, fecha, new Date(`${fecha}T12:00:00-06:00`).toISOString()));
  }
  if (tipo === 'ajuste') {
    const devengo = await env.DB.prepare('select importe from nomina_movimientos where id=?').bind(`devengo:${empleadoId}:${fecha}`)
      .first<{ importe: number }>();
    const ajustes = await env.DB.prepare(`select coalesce(sum(importe), 0) as importe from nomina_movimientos
      where empleado_id=? and fecha=? and tipo='ajuste'`).bind(empleadoId, fecha).first<{ importe: number }>();
    if (!devengo || monto > devengo.importe + (ajustes?.importe ?? 0)) {
      return json({ error: 'El ajuste excede el día trabajado.' }, 400);
    }
    sentencias.push(env.DB.prepare('delete from asistencias where empleado_id=? and fecha=?').bind(empleadoId, fecha));
  }
  if (abono) {
    sentencias.push(env.DB.prepare(`insert into nomina_movimientos (id,empleado_id,fecha,tipo,importe,nota,origen,creado_por,creado_en)
      values (?, ?, ?, 'abono', ?, 'Abono descontado del pago', ?, ?, ?) on conflict(id) do nothing`)
      .bind(`${id}:abono`, empleadoId, fecha, -abono, origen, correo, ahora));
  }
  await env.DB.batch(sentencias);
  return json({ id, empleado_id: empleadoId, fecha, tipo, importe: importeLibro, neto: tipo === 'pago' ? monto : null,
    abono, bono, origen, retiro_id: caja ? id : null, ...resumen }, 201);
}
