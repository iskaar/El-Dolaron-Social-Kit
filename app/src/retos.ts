/**
 * Retos (Issue #752, Fase 2 de #749): logros individuales pagados en Dolarones y la pantalla «Mis retos».
 * Ranking PRIVADO: nada aqui compara personas; cada empleada solo ve lo suyo.
 * Un cron diario revisa las ventas de hace 8 dias (el clawback de 7 dias queda implicito: cancelada o devuelta no paga).
 * Cada logro es una fila unica (correo, logro, ref) en `retos_logros`, asi que correr el cron dos veces no paga doble;
 * el credito es un lote de Dolarones `origen = 'reto'` (centavos: 1 D = 100) con id fijo `reto:<logro>`.
 */
import { lineasNetas } from './netas.ts';
import { hoyTienda, delDia } from './reportes.ts';
import { lunesDe, sumarDias } from './equipo.ts';
import { saldo, sumarMeses } from './dolarones.ts';
import { pushA } from './push.ts';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

const OMISIONES = {
  reto_dias_viejo: 90, reto_d_viejo: 50, reto_stock_alto: 5, reto_d_stock: 30, reto_racha_dias: 5,
  reto_d_racha: 100, reto_d_socio: 30, reto_d_apartado: 30, reto_d_tope_mes: 500,
};
type ConfigRetos = typeof OMISIONES;
// ponytail: el credito vence como el de una compra (12 meses); si Isaac prefiere otro plazo, cambia esta constante.
const MESES_VIGENCIA = 12;
// El cron corre cada 15 min: la corrida diaria es la que cae a las 03:00 de la tienda (09:00 UTC).
export const esCorridaDiaria = (ms: number) => { const f = new Date(ms); return f.getUTCHours() === 9 && f.getUTCMinutes() < 15; };

export async function configRetos(env: Env): Promise<ConfigRetos> {
  const { results } = await env.DB.prepare(`select clave, valor from config where clave like 'reto\\_%' escape '\\'`)
    .all<{ clave: string; valor: string }>();
  const cfg = { ...OMISIONES };
  for (const { clave, valor } of results) {
    const n = Number(valor);
    if (clave in cfg && Number.isInteger(n) && n >= 0) cfg[clave as keyof ConfigRetos] = n;
  }
  return cfg;
}

interface Empleada { id: string; nombre: string; correo: string; cliente_id: string }
interface Candidato { correo: string; logro: string; ref: string; d: number }

/** Venta que cuenta: no cancelada, sin devolucion (ni de dinero ni de Dolarones) y que no es compra de la propia empleada. */
const VENTA_VALIDA = `v.cancelada = 0 and v.devuelto = 0 and v.dolarones_devueltos = 0 and v.cliente_id is not e.cliente_id`;

/** Lo que ganaron las empleadas ligadas el dia `dia` de la tienda, sin importar si ya se registro. */
async function candidatosDelDia(env: Env, cfg: ConfigRetos, dia: string): Promise<Candidato[]> {
  const [desde, hasta] = delDia(dia);
  const salida: Candidato[] = [];
  const agregar = (filas: { correo: string; ref: string | number }[], logro: string, d: number) => {
    if (d > 0) for (const f of filas) salida.push({ correo: f.correo, logro, ref: String(f.ref), d });
  };

  // Antiguedad y Desatorar: por linea vendida.
  // ponytail: el stock al momento de la venta se reconstruye con stock actual - movimientos posteriores (movimientos_existencia),
  // una consulta por linea del dia; si el dia llegara a tener miles de lineas conviene pedirlo por producto.
  const { results: lineas } = await env.DB.prepare(
    `select e.correo, l.id as ref,
       coalesce(julianday(v.creado_en) - julianday(p.creado_en) >= ?, 0) as viejo,
       p.stock + l.cantidad - coalesce((select sum(m.cantidad) from movimientos_existencia m
         where m.producto_id = l.producto_id and m.en > v.registrado_en), 0) >= ? as alto
     from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
       join empleados e on e.correo = v.vendedora
     where e.activo = 1 and e.correo <> '' and ${VENTA_VALIDA} and v.creado_en >= ? and v.creado_en < ?
       and l.cantidad > l.cancelada_cantidad and p.sin_inventario = 0 and l.propietario = 'dolaron'`,
  ).bind(cfg.reto_dias_viejo, cfg.reto_stock_alto, desde, hasta).all<{ correo: string; ref: number; viejo: number; alto: number }>();
  agregar(lineas.filter((l) => l.viejo), 'antiguedad', cfg.reto_d_viejo);
  agregar(lineas.filter((l) => l.alto), 'desatorar', cfg.reto_d_stock);

  // Socio nuevo: lo registro ella y el socio compro ese mismo dia.
  const { results: socios } = await env.DB.prepare(
    `select e.correo, c.id as ref from clientes c join empleados e on e.correo = c.registrado_por
     where e.activo = 1 and e.correo <> '' and c.id <> e.cliente_id and c.creado_en >= ? and c.creado_en < ?
       and exists (select 1 from ventas v where v.cliente_id = c.id and ${VENTA_VALIDA} and v.creado_en >= ? and v.creado_en < ?)`,
  ).bind(desde, hasta, desde, hasta).all<{ correo: string; ref: string }>();
  agregar(socios, 'socio', cfg.reto_d_socio);

  // Apartado cerrado: el dia de la venta que lo liquido.
  const { results: apartados } = await env.DB.prepare(
    `select e.correo, p.id as ref from pedidos p join ventas v on v.id = p.venta_id join empleados e on e.correo = p.vendedora
     where p.estado = 'vendido' and e.activo = 1 and e.correo <> '' and ${VENTA_VALIDA} and v.creado_en >= ? and v.creado_en < ?`,
  ).bind(desde, hasta).all<{ correo: string; ref: string }>();
  agregar(apartados, 'apartado', cfg.reto_d_apartado);

  // Racha: dias TRABAJADOS seguidos (asistencias; los dias de descanso no la rompen) con al menos una venta atendida.
  // Un dia trabajado sin venta la corta. Se paga en cada multiplo exacto de la racha; ref = ese ultimo dia.
  if (cfg.reto_racha_dias > 0 && cfg.reto_d_racha > 0) {
    const { results: trabajan } = await env.DB.prepare(
      `select e.id, e.correo, e.cliente_id from empleados e join asistencias a on a.empleado_id = e.id
       where e.activo = 1 and e.correo <> '' and a.fecha = ?`,
    ).bind(dia).all<{ id: string; correo: string; cliente_id: string }>();
    for (const e of trabajan) {
      // ponytail: el dia de la venta se saca con diaTienda por fila; ventas_vendedora acota por persona. Con miles de ventas por persona, usar rangos por dia.
      const { results: dias } = await env.DB.prepare(
        `select a.fecha, exists(select 1 from ventas v where v.vendedora = ?1 and v.cancelada = 0 and v.devuelto = 0
           and v.dolarones_devueltos = 0 and v.cliente_id is not ?2
           and substr(datetime(v.creado_en, '-6 hours'), 1, 10) = a.fecha) as vendio
         from asistencias a where a.empleado_id = ?3 and a.fecha <= ?4 order by a.fecha desc limit ?5`,
      ).bind(e.correo, e.cliente_id, e.id, dia, cfg.reto_racha_dias * 40).all<{ fecha: string; vendio: number }>();
      let largo = 0;
      while (largo < dias.length && dias[largo].vendio) largo++;
      if (largo > 0 && largo % cfg.reto_racha_dias === 0) agregar([{ correo: e.correo, ref: dia }], 'racha', cfg.reto_d_racha);
    }
  }
  return salida;
}

/** La cuenta de socio de la empleada; se crea al primer credito. Telefono de relleno (unico): para canjear, Isaac pone el real. */
async function clienteDe(env: Env, e: Empleada, ahora: string): Promise<string> {
  if (e.cliente_id) return e.cliente_id;
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `insert into clientes (id, numero, nombre, telefono, bases_version, registrado_por, creado_en)
       select ?, coalesce(max(numero), 0) + 1, ?, ?, ?, 'retos', ? from clientes`,
    ).bind(id, e.nombre, `retos-${e.id}`, env.BASES_APROBADAS_VERSION || 'retos', ahora),
    env.DB.prepare(`update empleados set cliente_id = ? where id = ? and cliente_id = ''`).bind(id, e.id),
  ]);
  return (await env.DB.prepare('select cliente_id from empleados where id = ?').bind(e.id).first<{ cliente_id: string }>())!.cliente_id;
}

/**
 * Cron diario: registra los logros de los dias 8 a 10 antes de hoy (tres dias para que una corrida perdida no pierda nada;
 * es idempotente) y paga en Dolarones los que no tengan su lote. Devuelve cuantos logros nuevos registro.
 */
export async function otorgarLogros(env: Env, ahora = Date.now()): Promise<number> {
  const cfg = await configRetos(env);
  const iso = new Date(ahora).toISOString();
  const mes = hoyTienda(ahora).slice(0, 7);
  let nuevos = 0;
  for (const atras of [10, 9, 8]) {
    for (const c of await candidatosDelDia(env, cfg, sumarDias(hoyTienda(ahora), -atras))) {
      // El tope mensual se calcula en la misma sentencia: lo que no cabe se registra con d = 0.
      const r = await env.DB.prepare(
        `insert into retos_logros (id, correo, logro, ref, d, creado_en)
         select ?1, ?2, ?3, ?4, max(0, min(?5, ?6 - coalesce((select sum(d) from retos_logros
           where correo = ?2 and substr(datetime(creado_en, '-6 hours'), 1, 7) = ?7), 0))), ?8
         where 1 on conflict (correo, logro, ref) do nothing`,
      ).bind(crypto.randomUUID(), c.correo, c.logro, c.ref, c.d, cfg.reto_d_tope_mes, mes, iso).run();
      nuevos += r.meta.changes;
    }
  }

  // Pago: todo logro con d > 0 sin lote. Tambien repara una corrida que se corto entre registrar y pagar.
  const { results: porPagar } = await env.DB.prepare(
    `select r.id, r.logro, r.d, e.id as empleado, e.nombre, e.correo, e.cliente_id from retos_logros r
     join empleados e on e.correo = r.correo
     where r.d > 0 and not exists (select 1 from dolarones_lotes where id = 'reto:' || r.id) order by r.creado_en, r.id`,
  ).all<{ id: string; logro: string; d: number; empleado: string; nombre: string; correo: string; cliente_id: string }>();
  const cuentas = new Map<string, string>();   // la lista trae cliente_id de antes de pagar: la cuenta recien creada se recuerda aqui
  for (const p of porPagar) {
    const cliente = cuentas.get(p.empleado) ?? await clienteDe(env, { id: p.empleado, nombre: p.nombre, correo: p.correo, cliente_id: p.cliente_id }, iso);
    cuentas.set(p.empleado, cliente);
    const lote = `reto:${p.id}`;
    const centavos = p.d * 100;
    await env.DB.batch([
      env.DB.prepare(
        `insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
         values (?, ?, 'reto', null, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
      ).bind(lote, cliente, centavos, centavos, iso, sumarMeses(new Date(ahora), MESES_VIGENCIA), iso),
      env.DB.prepare(
        `insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
         select ?, ?, null, 'reto', ?, 'retos', ? where not exists (select 1 from dolarones_movimientos where lote_id = ? and tipo = 'reto')`,
      ).bind(cliente, lote, centavos, iso, lote),
    ]);
    await pushA(env, p.correo, '¡Ganaste un reto!', `${ETIQUETAS[p.logro] ?? p.logro}: +${p.d} Dolarones.`)
      .catch((error) => console.error(JSON.stringify({ mensaje: 'push de reto fallido', error: String(error).slice(0, 200) })));
  }
  return nuevos;
}

const ETIQUETAS: Record<string, string> = {
  antiguedad: 'Pieza con antigüedad', desatorar: 'Desatorar inventario', racha: 'Racha de días con venta',
  socio: 'Socio nuevo', apartado: 'Apartado cerrado',
};

/** Ventas netas, tickets, socios nuevos y apartados cerrados atendidos por `correo` en [desdeDia, hastaDia). */
async function numerosDe(env: Env, correo: string, desdeDia: string, hastaDia: string) {
  const [desde, hasta] = [delDia(desdeDia)[0], delDia(hastaDia)[0]];
  const [ventas, socios, apartados] = await Promise.all([
    env.DB.prepare(
      `${lineasNetas('v.creado_en >= ? and v.creado_en < ? and v.vendedora = ?')}
       select count(distinct venta) as tickets, coalesce(sum(neta), 0) as ventas from netas where propietario = 'dolaron'`,
    ).bind(desde, hasta, correo).first<{ tickets: number; ventas: number }>(),
    env.DB.prepare('select count(*) as n from clientes where registrado_por = ? and creado_en >= ? and creado_en < ?')
      .bind(correo, desde, hasta).first<{ n: number }>(),
    env.DB.prepare(
      `select count(*) as n from pedidos p join ventas v on v.id = p.venta_id
       where p.vendedora = ? and p.estado = 'vendido' and v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ?`,
    ).bind(correo, desde, hasta).first<{ n: number }>(),
  ]);
  return { ventas: ventas?.ventas ?? 0, tickets: ventas?.tickets ?? 0, socios: socios?.n ?? 0, apartados: apartados?.n ?? 0 };
}

/**
 * GET /api/retos/mios: SOLO lo de quien pregunta (correo del servidor, nunca de la peticion): su semana contra su promedio
 * de las 4 semanas cerradas anteriores, sus logros y el saldo de su cuenta. Dinero en centavos; `d` en Dolarones enteros.
 */
export async function misRetos(env: Env, correo: string, ahora = Date.now()): Promise<Response> {
  const lunes = lunesDe(hoyTienda(ahora));
  const [semana, previas, cfg, logros, mes, emp] = await Promise.all([
    numerosDe(env, correo, lunes, sumarDias(lunes, 7)),
    numerosDe(env, correo, sumarDias(lunes, -28), lunes),
    configRetos(env),
    env.DB.prepare('select creado_en, logro, d from retos_logros where correo = ? order by creado_en desc, id limit 50')
      .bind(correo).all<{ creado_en: string; logro: string; d: number }>(),
    env.DB.prepare(`select coalesce(sum(d), 0) as d from retos_logros where correo = ? and substr(datetime(creado_en, '-6 hours'), 1, 7) = ?`)
      .bind(correo, hoyTienda(ahora).slice(0, 7)).first<{ d: number }>(),
    env.DB.prepare('select nombre, cliente_id from empleados where correo = ? and activo = 1').bind(correo).first<{ nombre: string; cliente_id: string }>(),
  ]);
  const promedio = Object.fromEntries(Object.entries(previas).map(([k, v]) => [k, Math.round(v * 10 / 4) / 10]));
  const cuenta = emp?.cliente_id ? await saldo(env, emp.cliente_id, new Date(ahora).toISOString()) : null;
  return json({
    nombre: emp?.nombre ?? '', semana: { desde: lunes, ...semana }, promedio_4_semanas: promedio,
    logros: logros.results.map((l) => ({ fecha: l.creado_en, logro: l.logro, etiqueta: ETIQUETAS[l.logro] ?? l.logro, d: l.d })),
    mes: { ganado: mes?.d ?? 0, tope: cfg.reto_d_tope_mes },
    saldo: cuenta?.disponible ?? 0, por_liberar: cuenta?.por_liberar ?? 0,
    reglas: [
      { logro: 'antiguedad', texto: `Vende una pieza con ${cfg.reto_dias_viejo} días o más en inventario`, d: cfg.reto_d_viejo },
      { logro: 'desatorar', texto: `Vende una pieza de un producto con ${cfg.reto_stock_alto} o más en existencia`, d: cfg.reto_d_stock },
      { logro: 'racha', texto: `${cfg.reto_racha_dias} días trabajados seguidos, cada uno con al menos una venta`, d: cfg.reto_d_racha },
      { logro: 'socio', texto: 'Registra un socio que compra ese mismo día', d: cfg.reto_d_socio },
      { logro: 'apartado', texto: 'Cierra un apartado tuyo', d: cfg.reto_d_apartado },
    ],
  });
}
