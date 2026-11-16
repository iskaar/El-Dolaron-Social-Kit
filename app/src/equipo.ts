/**
 * Equipo en /reportes (Issue #751, Fase 1 de #749): lo que hizo cada persona en el rango y el bono semanal de la tienda.
 * Bono: si las ventas netas de una semana cerrada (lunes a domingo, fecha de tienda) SUPERAN la meta, la bolsa es
 * `bono_tienda_pb` puntos base (100 = 1 %) de esas ventas y se reparte por dias trabajados de ESA semana. Sin ranking.
 * Todo en centavos enteros; el bono se paga como `nomina_movimientos` tipo 'bono' (nomina.ts).
 */
import { lineasNetas } from './netas.ts';
import { atiende } from './cajeros.ts';
import { leerRoles, esTienda, type Tienda } from './cuentas.ts';
import { delDia, diaTienda, hoyTienda, rangoDe } from './reportes.ts';
import { COMPARACIONES, GRANOS, granoEfectivo, ventanaComparacion } from '../public/reportes-resumen.js';
import { armarEquipo } from '../public/reportes-equipo.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const DIA_MS = 86_400_000;
export const sumarDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
/** El lunes de la semana de `dia` (lunes a domingo). */
export const lunesDe = (dia: string) => sumarDias(dia, -((new Date(`${dia}T12:00:00Z`).getUTCDay() + 6) % 7));
/** Los lunes de las `n` semanas ya cerradas (la de hoy no), de la mas reciente a la mas vieja. */
export const semanasCerradas = (hoy: string, n = 8) =>
  Array.from({ length: n }, (_, i) => sumarDias(lunesDe(hoy), -7 * (i + 1)));
export const notaBono = (lunes: string) => `bono tienda semana ${lunes}`;

/**
 * Reparte `bolsa` centavos por dias trabajados: floor(bolsa x dias / total) a cada quien y el resto a quien mas dias tiene (empate: orden alfabetico de correo). Siempre suma exactamente `bolsa`.
 */
export function repartirBono<T extends { correo: string; dias: number }>(bolsa: number, personas: T[]) {
  const total = personas.reduce((s, p) => s + p.dias, 0);
  if (!total || bolsa <= 0) return personas.map((p) => ({ ...p, importe: 0 }));
  const partes = personas.map((p) => ({ ...p, importe: Math.floor(bolsa * p.dias / total) }));
  const primero = partes.reduce((m, p) => (p.dias > m.dias || (p.dias === m.dias && p.correo < m.correo) ? p : m));
  primero.importe += bolsa - partes.reduce((s, p) => s + p.importe, 0);
  return partes;
}

interface ConfigBono { pb: number; meta: number }
export async function configBono(env: Env): Promise<ConfigBono> {
  const { results } = await env.DB.prepare(`select clave, valor from config where clave in ('bono_tienda_pb', 'bono_tienda_meta_semana')`)
    .all<{ clave: string; valor: string }>();
  const v = (clave: string, omision: number) => {
    const n = Number(results.find((f) => f.clave === clave)?.valor);
    return Number.isInteger(n) && n >= 0 ? n : omision;
  };
  return { pb: v('bono_tienda_pb', 100), meta: v('bono_tienda_meta_semana', 10_000_000) };
}

/** Para cada lunes: ventas netas (mismo neto que el Resumen), meta, bolsa y la parte de cada empleada ligada. */
export async function semanasBono(env: Env, lunes: string[], config?: ConfigBono) {
  config ??= await configBono(env);
  const primero = [...lunes].sort()[0];
  const ultimo = sumarDias([...lunes].sort().at(-1)!, 7);   // el lunes siguiente: limite exclusivo
  const { results: ventas } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
     select date(datetime(creado_en, '-6 hours'), 'weekday 0', '-6 days') as lunes, coalesce(sum(neta), 0) as total
     from netas where propietario = 'dolaron' group by lunes`,
  ).bind(delDia(primero)[0], delDia(ultimo)[0]).all<{ lunes: string; total: number }>();
  const { results: asistencias } = await env.DB.prepare(
    `select e.id, e.nombre, e.correo, a.fecha from asistencias a join empleados e on e.id = a.empleado_id
     where e.activo = 1 and e.correo <> '' and a.fecha >= ? and a.fecha < ?`,
  ).bind(primero, ultimo).all<{ id: string; nombre: string; correo: string; fecha: string }>();
  const { results: hechos } = await env.DB.prepare(
    `select empleado_id, nota from nomina_movimientos where tipo = 'bono' and nota like 'bono tienda semana %'`,
  ).all<{ empleado_id: string; nota: string }>();
  const registrados = new Set(hechos.map((h) => `${h.nota}|${h.empleado_id}`));

  return lunes.map((dia) => {
    const total = ventas.find((v) => v.lunes === dia)?.total ?? 0;
    const alcanzada = total > config.meta;
    const bolsa = alcanzada ? Math.floor(total * config.pb / 10_000) : 0;
    const dias = new Map<string, { id: string; nombre: string; correo: string; dias: number }>();
    for (const a of asistencias) {
      if (a.fecha < dia || a.fecha > sumarDias(dia, 6)) continue;
      const p = dias.get(a.id) ?? { id: a.id, nombre: a.nombre, correo: a.correo, dias: 0 };
      p.dias++;
      dias.set(a.id, p);
    }
    const partes = repartirBono(bolsa, [...dias.values()]).map((p) => ({
      empleado_id: p.id, nombre: p.nombre, correo: p.correo, dias: p.dias, importe: p.importe,
      registrado: registrados.has(`${notaBono(dia)}|${p.id}`),
    }));
    return { lunes: dia, domingo: sumarDias(dia, 6), ventas: total, meta: config.meta, alcanzada, bolsa, partes };
  });
}

/**
 * GET /api/reportes/equipo?dias=N | desde=&hasta=[&comparar=&grano=]: tabla por persona del rango, la serie por cubeta (dia, semana o mes)
 * contra la comparacion elegida y las ultimas 8 semanas cerradas del bono. Los campos de siempre (`personas`, `semanas`, `config`, `dias`,
 * `dia_desde`, `dia_hasta`) no cambian; lo demas se agrega (#802). Sin subconsultas por pieza: «vendidas a 14 dias» sale de UNA pasada
 * agrupada por producto, como Capturas. Todo por dia de la tienda; 10 consultas (en paralelo) mas las 3 del bono: 13.
 * `tienda=` (#802, A1) acota lo que tiene tienda: ventas, tickets, cancelaciones, apartados y desde cuando hay ventas atribuidas (`ventas.tienda`).
 * Socios, capturas y asistencias no se registran por tienda: no se filtran y la pantalla lo dice. El bono (`semanas`) es del negocio completo
 * y no cambia con la tienda (lo leen tambien retos.ts y el pago de nomina).
 */
export async function reporteEquipo(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
  const rango = rangoDe(url, ahora);
  const periodo = { desde: rango.dia_desde, hasta: rango.dia_hasta, dias: rango.dias };
  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const tienda: Tienda | null = esTienda(pedida) ? pedida : null;
  const deTienda = tienda ? ` and v.tienda = '${tienda}'` : '';          // la clave sale de TIENDAS: segura en el SQL
  const deTiendaSola = tienda ? ` and tienda = '${tienda}'` : '';
  const comparar = url.searchParams.get('comparar') || 'anterior';
  if (!COMPARACIONES.includes(comparar)) return json({ error: 'Comparacion invalida.' }, 400);
  const granoPedido = url.searchParams.get('grano') ?? '';
  if (granoPedido && !GRANOS.includes(granoPedido)) return json({ error: 'Grano invalido.' }, 400);
  const grano: string = granoEfectivo(granoPedido, periodo.desde, periodo.hasta);
  const ventana: { desde: string; hasta: string; dias: number } | null = ventanaComparacion(periodo.desde, periodo.hasta, comparar);

  // Se lee desde el inicio de lo que se compara (si hay) hasta el final del periodo.
  const lecturaDesde = ventana && ventana.desde < periodo.desde ? ventana.desde : periodo.desde;
  const [desde, hasta] = [`${lecturaDesde}T06:00:00.000Z`, rango.hasta];
  const [ventas, cancelaciones, socios, apartados, capturas, asistencias, primeraAsistencia, atribucion, usuarios, config] = await Promise.all([
    // Neto por ticket (igual que el Resumen), por dia y atribuido a quien atendio; '' = sin atribuir.
    env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select ${diaTienda('v.creado_en')} as dia, v.vendedora as correo, count(distinct n.venta) as tickets, coalesce(sum(n.neta), 0) as ventas, coalesce(sum(n.cant), 0) as piezas
       from netas n join ventas v on v.id = n.venta where n.propietario = 'dolaron' group by 1, 2`,
    ).bind(desde, hasta).all(),
    // Tickets completos cancelados de cada vendedora, en el dia de la venta (el mismo periodo de Control).
    env.DB.prepare(
      `select ${diaTienda('creado_en')} as dia, vendedora as correo, count(*) as n, coalesce(sum(total - devuelto - dolarones_devueltos), 0) as valor
       from ventas where cancelada = 1 and creado_en >= ? and creado_en < ?${deTiendaSola} group by 1, 2`,
    ).bind(desde, hasta).all(),
    env.DB.prepare(
      `select ${diaTienda('c.creado_en')} as dia, c.registrado_por as correo, count(*) as socios,
         coalesce(sum(exists(select 1 from ventas v where v.cliente_id = c.id and v.cancelada = 0
           and substr(datetime(v.creado_en, '-6 hours'), 1, 10) = substr(datetime(c.creado_en, '-6 hours'), 1, 10))), 0) as socios_compraron
       from clientes c where c.creado_en >= ? and c.creado_en < ? and c.registrado_por <> 'retos' group by 1, 2`,
    ).bind(desde, hasta).all(),
    env.DB.prepare(
      `select ${diaTienda('v.creado_en')} as dia, p.vendedora as correo, count(*) as apartados from pedidos p join ventas v on v.id = p.venta_id
       where p.estado = 'vendido' and v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ?${deTienda} group by 1, 2`,
    ).bind(desde, hasta).all(),
    // Piezas capturadas por dia y persona (las de `capturado_por` vacio vienen aparte, como `capturas_sin_cuenta`) y cuantas se vendieron en sus primeros 14 dias. La primera venta de cada pieza sale de UNA pasada
    // que arranca por las ventas del rango (indice ventas_creado, luego venta_lineas_venta y la llave de productos); `cross join` fija ese orden.
    // Antes era un `exists` por pieza sobre venta_lineas, que no tiene indice por producto. Solo cuenta la caja, como antes (Mercado Libre no).
    env.DB.prepare(
      `select ${diaTienda('p.creado_en')} as dia, p.capturado_por as correo, count(*) as capturadas,
         coalesce(sum(f.primera is not null and julianday(f.primera) - julianday(p.creado_en) <= 14), 0) as vendidas_14
       from productos p left join (
         select l.producto_id, min(v.creado_en) as primera
         from ventas v cross join venta_lineas l on l.venta_id = v.id cross join productos q on q.id = l.producto_id
         where v.creado_en >= ? and v.cancelada = 0 and l.cantidad > l.cancelada_cantidad
           and q.creado_en >= ? and q.creado_en < ? and q.sin_inventario = 0 and q.propietario = 'dolaron'
         group by l.producto_id) f on f.producto_id = p.id
       where p.creado_en >= ? and p.creado_en < ? and p.sin_inventario = 0
         and p.propietario = 'dolaron' and p.estado_analisis <> 'descartado' group by 1, 2`,
    ).bind(desde, desde, hasta, desde, hasta).all(),
    // Dias de asistencia por dia y cuenta ligada ('' = empleado sin cuenta: cuenta en el total, no en una persona).
    env.DB.prepare(
      `select a.fecha as dia, e.correo, count(*) as n from asistencias a join empleados e on e.id = a.empleado_id
       where a.fecha >= ? and a.fecha <= ? group by 1, 2`,
    ).bind(lecturaDesde, rango.dia_hasta).all(),
    env.DB.prepare('select min(fecha) as desde from asistencias').first<{ desde: string | null }>(),
    // El primer dia con una venta atribuida: se recorre ventas_creado hasta la primera que trae vendedora (las de antes de que existiera la columna).
    env.DB.prepare(`select creado_en from ventas where vendedora <> ''${deTiendaSola} order by creado_en limit 1`).first<{ creado_en: string }>(),
    // Las cuentas: el nombre de cada correo y, de ellas, las que atienden en piso (salen en la tabla aunque no hayan hecho nada).
    env.DB.prepare('select correo, nombre, roles, activo from usuarios order by nombre').all<{ correo: string; nombre: string; roles: string; activo: number }>(),
    configBono(env),
  ]);

  const primera = atribucion?.creado_en ? new Date(Date.parse(atribucion.creado_en) - 6 * 3_600_000).toISOString().slice(0, 10) : null;
  const equipo = armarEquipo({
    desde: periodo.desde, hasta: periodo.hasta, grano, ventana,
    ventas: ventas.results as never, cancelaciones: cancelaciones.results as never, socios: socios.results as never, apartados: apartados.results as never,
    capturas: capturas.results as never, asistencias: asistencias.results as never, usuarios: usuarios.results, vendedoras: usuarios.results.filter((u) => u.activo && atiende(leerRoles(u.roles))), atribucionDesde: primera,
  });
  return json({
    dias: rango.dias, dia_desde: rango.dia_desde, dia_hasta: rango.dia_hasta, tienda: tienda ?? '',
    periodo, comparar, comparacion: ventana, grano, asistencias: { desde: primeraAsistencia?.desde ?? null },
    ...equipo,
    semanas: await semanasBono(env, semanasCerradas(hoyTienda(ahora)), config),
    config,
  });
}

/**
 * POST /api/reportes/equipo/bono { semana: 'YYYY-MM-DD' (lunes) }: asienta el bono de una semana CERRADA.
 * Un movimiento por empleada, fechado el domingo de esa semana, con id fijo y nota `bono tienda semana <lunes>`:
 * repetir la llamada (o dos a la vez) no duplica; lo que ya estaba se reporta aparte.
 */
export async function registrarBonoSemana(request: Request, env: Env, correo: string, ahora = Date.now()): Promise<Response> {
  const { semana } = await request.json().catch(() => ({})) as { semana?: unknown };
  if (typeof semana !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(semana) || lunesDe(semana) !== semana
      || Number.isNaN(Date.parse(`${semana}T12:00:00Z`))) return json({ error: 'La semana debe ser un lunes (AAAA-MM-DD).' }, 400);
  if (sumarDias(semana, 6) >= hoyTienda(ahora)) return json({ error: 'Esa semana aún no termina.' }, 400);
  const [plan] = await semanasBono(env, [semana]);
  const pendientes = plan.partes.filter((p) => p.importe > 0);
  if (!plan.bolsa) return json({ semana, bolsa: 0, alcanzada: plan.alcanzada, creados: [], ya_estaban: [] });
  const nuevos = pendientes.filter((p) => !p.registrado);
  const creado = new Date().toISOString();
  if (nuevos.length) {
    await env.DB.batch(nuevos.map((p) => env.DB.prepare(
      `insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, creado_por, creado_en)
       values (?, ?, ?, 'bono', ?, ?, ?, ?) on conflict(id) do nothing`,
    ).bind(`bono-tienda:${semana}:${p.empleado_id}`, p.empleado_id, plan.domingo, p.importe, notaBono(semana), correo, creado)));
  }
  const nombre = (p: { nombre: string; importe: number }) => ({ nombre: p.nombre, importe: p.importe });
  return json({ semana, bolsa: plan.bolsa, alcanzada: true, creados: nuevos.map(nombre),
    ya_estaban: pendientes.filter((p) => p.registrado).map(nombre) }, nuevos.length ? 201 : 200);
}
