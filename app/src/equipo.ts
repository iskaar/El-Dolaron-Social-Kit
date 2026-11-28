/**
 * Equipo en /reportes (Issue #751, Fase 1 de #749): lo que hizo cada persona en el rango y el bono semanal POR TIENDA (#930).
 * Bono: cada tienda tiene su linea semanal (`bono_tienda_linea_<tienda>`; sin linea = apagado). Si las ventas netas de una semana
 * cerrada (lunes a domingo, fecha de tienda, `ventas.tienda`) superan la linea, la bolsa es `bono_tienda_pb` puntos base (100 = 1 %)
 * de lo vendido ARRIBA de la linea (lo vendido arriba de la meta tope `bono_tienda_meta_tope` paga `bono_tienda_pb_arriba`, #960; 0 = `pb`) y se reparte entre las empleadas de ESA tienda por dias trabajados de ESA semana. Sin ranking.
 * Encima del efectivo van Dolarones: 1 D por cada `bono_d_cada` centavos de bono (tope semanal por persona `bono_d_tope`) y un premio fijo
 * `bono_d_record` si la semana fue la mejor de la tienda y no llego a su linea. `bono_tienda_desde` (un lunes, AAAAMMDD) es la primera semana
 * del esquema nuevo: sin ella, o antes de ella, no hay bono por tienda (las semanas ya asentadas con el esquema anterior no se tocan). Todo en centavos enteros; el bono se paga como
 * `nomina_movimientos` tipo 'bono' (nomina.ts) y los Dolarones como lotes 'reto' de id fijo (dolarones.ts).
 */
import { lineasNetas } from './netas.ts';
import { atiende } from './cajeros.ts';
import { leerRoles, esTienda, TIENDAS, TIENDA_CENTRAL, type Tienda } from './cuentas.ts';
import { acreditarReto } from './dolarones.ts';
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
export const loteBono = (lunes: string, empleado: string) => `bono-tienda:${lunes}:${empleado}`;

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

const TIENDAS_CLAVES = Object.keys(TIENDAS) as Tienda[];
export const claveLinea = (t: string) => `bono_tienda_linea_${t}`;
export const CLAVE_BONO_DESDE = 'bono_tienda_desde';
/** AAAAMMDD (como se guarda en `config`) -> 'AAAA-MM-DD' si es una fecha real y un lunes; '' si no. */
export function fechaBono(n: number): string {
  if (!Number.isInteger(n) || n < 20000101 || n > 99991231) return '';
  const s = String(n);
  const f = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  const d = new Date(`${f}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f && lunesDe(f) === f ? f : '';
}
/** Todo en centavos enteros salvo `pb` (puntos base) y los Dolarones (`d_*`, enteros). Cero = apagado. */
interface ConfigBono { pb: number; pb_arriba: number; desde: string; lineas: Record<Tienda, number>; tope: number; d_cada: number; d_tope: number; d_record: number }
export async function configBono(env: Env): Promise<ConfigBono> {
  const { results } = await env.DB.prepare(`select clave, valor from config where clave like 'bono\\_tienda\\_%' escape '\\' or clave like 'bono\\_d\\_%' escape '\\'`)
    .all<{ clave: string; valor: string }>();
  const v = (clave: string, omision: number) => {
    const n = Number(results.find((f) => f.clave === clave)?.valor);
    return Number.isInteger(n) && n >= 0 ? n : omision;
  };
  return {
    pb: v('bono_tienda_pb', 100), pb_arriba: v('bono_tienda_pb_arriba', 0), desde: fechaBono(v(CLAVE_BONO_DESDE, 0)), tope: v('bono_tienda_meta_tope', 0), d_cada: v('bono_d_cada', 0), d_tope: v('bono_d_tope', 0), d_record: v('bono_d_record', 0),
    lineas: Object.fromEntries(TIENDAS_CLAVES.map((t) => [t, v(claveLinea(t), 0)])) as Record<Tienda, number>,
  };
}

/**
 * Para cada lunes y cada tienda: ventas netas (mismo neto que el Resumen, por `ventas.tienda`), linea, bolsa y la parte de cada empleada ligada a
 * una cuenta de ESA tienda (`usuarios.tienda`; '' = la central). `alcanzada` = ventas >= linea (justo en la linea no hay bolsa: el excedente es 0).
 * `record`: la semana supero a todas las anteriores de la tienda (y la tienda no llego a su linea). Solo se calcula con `d_record` > 0 y lee hasta 52
 * semanas de historia antes de la primera pedida; `retos.ts` (que solo necesita el avance de la semana en curso) pide `sinHistorial`.
 * Lo ya pagado manda: si la empleada tiene su movimiento de nomina o su lote, el importe y los Dolarones salen de lo que se pago, no del recalculo
 * (cambiar la config despues de asentar no cambia lo pagado ni lo vuelve a pagar). Antes de `config.desde` (o sin ella) la linea cuenta como 0.
 */
export async function semanasBono(env: Env, lunes: string[], config?: ConfigBono, sinHistorial = false) {
  config ??= await configBono(env);
  const conRecord = config.d_record > 0 && !sinHistorial;
  const primero = [...lunes].sort()[0];
  const ultimo = sumarDias([...lunes].sort().at(-1)!, 7);   // el lunes siguiente: limite exclusivo
  const { results: ventas } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
     select date(datetime(n.creado_en, '-6 hours'), 'weekday 0', '-6 days') as lunes, v.tienda, coalesce(sum(n.neta), 0) as total
     from netas n join ventas v on v.id = n.venta where n.propietario = 'dolaron' group by 1, 2`,
  // ponytail: el record compara contra las 52 semanas anteriores; una mejor semana mas vieja no se ve. Subir el limite si importa.
  ).bind(delDia(conRecord ? sumarDias(primero, -7 * 52) : primero)[0], delDia(ultimo)[0]).all<{ lunes: string; tienda: string; total: number }>();
  const { results: asistencias } = await env.DB.prepare(
    `select e.id, e.nombre, e.correo, a.fecha, coalesce(nullif(u.tienda, ''), ?) as tienda
     from asistencias a join empleados e on e.id = a.empleado_id join usuarios u on u.correo = e.correo
     where e.activo = 1 and e.correo <> '' and a.fecha >= ? and a.fecha < ?`,
  ).bind(TIENDA_CENTRAL, primero, ultimo).all<{ id: string; nombre: string; correo: string; fecha: string; tienda: string }>();
  const [{ results: hechos }, { results: lotes }] = await Promise.all([
    env.DB.prepare(`select empleado_id, nota, importe from nomina_movimientos where tipo = 'bono' and nota like 'bono tienda semana %'`).all<{ empleado_id: string; nota: string; importe: number }>(),
    env.DB.prepare(`select id, importe from dolarones_lotes where id >= 'bono-tienda:' and id < 'bono-tienda;'`).all<{ id: string; importe: number }>(),
  ]);
  const pagado = new Map(hechos.map((h) => [`${h.nota}|${h.empleado_id}`, h.importe]));
  const loteDe = new Map(lotes.map((l) => [l.id, l.importe]));
  const totalDe = (dia: string, t: string) => ventas.find((v) => v.lunes === dia && v.tienda === t)?.total ?? 0;

  return lunes.map((dia) => ({
    lunes: dia, domingo: sumarDias(dia, 6),
    tiendas: TIENDAS_CLAVES.map((t) => {
      const total = totalDe(dia, t);
      const linea = config.desde && dia >= config.desde ? config.lineas[t] : 0;
      // Acelerador: arriba de la meta tope rige `pb_arriba` (0 = `pb`). Sin tope, o tope <= linea, no hay tramo: todo a `pb`.
      const tramoTope = config.tope > linea ? config.tope : Infinity;
      const alcanzada = linea > 0 && total > linea;   // justo en la linea no llego: no hay excedente
      const bolsa = linea > 0 && total > linea ? Math.floor(((Math.min(total, tramoTope) - linea) * config.pb + Math.max(0, total - tramoTope) * (config.pb_arriba || config.pb)) / 10_000) : 0;
      const mejorAntes = conRecord ? Math.max(0, ...ventas.filter((v) => v.tienda === t && v.lunes < dia).map((v) => v.total)) : 0;
      const record = conRecord && linea > 0 && !alcanzada && mejorAntes > 0 && total > mejorAntes;
      const dias = new Map<string, { id: string; nombre: string; correo: string; dias: number }>();
      if (linea > 0) for (const a of asistencias) {
        if (a.tienda !== t || a.fecha < dia || a.fecha > sumarDias(dia, 6)) continue;
        const p = dias.get(a.id) ?? { id: a.id, nombre: a.nombre, correo: a.correo, dias: 0 };
        p.dias++;
        dias.set(a.id, p);
      }
      const partes = repartirBono(bolsa, [...dias.values()]).map((p) => {
        const pago = pagado.get(`${notaBono(dia)}|${p.id}`);   // lo que de verdad se pago, si ya se asento
        const lote = loteDe.get(loteBono(dia, p.id));
        const importe = pago ?? p.importe;
        const d = lote !== undefined ? lote / 100
          : (config.d_cada > 0 ? Math.min(Math.floor(importe / config.d_cada), config.d_tope) : 0) + (record ? config.d_record : 0);
        return {
          empleado_id: p.id, nombre: p.nombre, correo: p.correo, dias: p.dias, importe, d,
          registrado: (importe === 0 || pago !== undefined) && (d === 0 || lote !== undefined),
        };
      });
      return { tienda: t, nombre: TIENDAS[t].nombre, ventas: total, linea, alcanzada, bolsa, record, partes };
    }),
  }));
}

/**
 * GET /api/reportes/equipo?dias=N | desde=&hasta=[&comparar=&grano=]: tabla por persona del rango, la serie por cubeta (dia, semana o mes)
 * contra la comparacion elegida y las ultimas 8 semanas cerradas del bono. Los campos de siempre (`personas`, `semanas`, `config`, `dias`,
 * `dia_desde`, `dia_hasta`) no cambian; lo demas se agrega (#802). Sin subconsultas por pieza: «vendidas a 14 dias» sale de UNA pasada
 * agrupada por producto, como Capturas. Todo por dia de la tienda; 10 consultas (en paralelo) mas las 4 del bono: 14.
 * `tienda=` (#802, A1) acota lo que tiene tienda: ventas, tickets, cancelaciones, apartados y desde cuando hay ventas atribuidas (`ventas.tienda`).
 * Socios, capturas y asistencias no se registran por tienda: no se filtran y la pantalla lo dice. El bono (`semanas`, una entrada por tienda) es de cada tienda
 * y no cambia con el filtro `tienda=` (lo lee tambien retos.ts).
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
 * POST /api/reportes/equipo/bono { semana: 'YYYY-MM-DD' (lunes) }: asienta el bono de una semana CERRADA, de todas las tiendas.
 * Un movimiento por empleada, fechado el domingo de esa semana, con id fijo y nota `bono tienda semana <lunes>`, y su lote de
 * Dolarones con id fijo `bono-tienda:<lunes>:<empleada>`: repetir la llamada (o dos a la vez) no duplica, aunque la config haya cambiado entre una y otra;
 * lo que ya estaba se reporta aparte. Una semana anterior a `bono_tienda_desde` se rechaza.
 */
export async function registrarBonoSemana(request: Request, env: Env, correo: string, ahora = Date.now()): Promise<Response> {
  const { semana } = await request.json().catch(() => ({})) as { semana?: unknown };
  if (typeof semana !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(semana) || lunesDe(semana) !== semana
      || Number.isNaN(Date.parse(`${semana}T12:00:00Z`))) return json({ error: 'La semana debe ser un lunes (AAAA-MM-DD).' }, 400);
  if (sumarDias(semana, 6) >= hoyTienda(ahora)) return json({ error: 'Esa semana aún no termina.' }, 400);
  const { desde } = await configBono(env);
  if (!desde) return json({ error: 'El bono por tienda está apagado: falta la fecha de inicio en Equipo.' }, 400);
  if (semana < desde) return json({ error: `El bono por tienda empieza en la semana del ${desde}; esa semana no se asienta aquí.` }, 400);
  const [plan] = await semanasBono(env, [semana]);
  const resumen = (t: string, p: { nombre: string; importe: number; d: number }) => ({ tienda: t, nombre: p.nombre, importe: p.importe, d: p.d });
  const creados: ReturnType<typeof resumen>[] = [];
  const yaEstaban: ReturnType<typeof resumen>[] = [];
  const creado = new Date(ahora).toISOString();
  for (const t of plan.tiendas) {
    for (const p of t.partes.filter((x) => x.importe > 0 || x.d > 0)) {
      if (p.registrado) { yaEstaban.push(resumen(t.tienda, p)); continue; }
      if (p.importe > 0) {
        await env.DB.prepare(
          `insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, creado_por, creado_en)
           values (?, ?, ?, 'bono', ?, ?, ?, ?) on conflict(id) do nothing`,
        ).bind(`bono-tienda:${semana}:${p.empleado_id}`, p.empleado_id, plan.domingo, p.importe, notaBono(semana), correo, creado).run();
      }
      if (p.d > 0) {
        const emp = (await env.DB.prepare('select cliente_id from empleados where id = ?').bind(p.empleado_id).first<{ cliente_id: string }>())!;
        await acreditarReto(env, { id: p.empleado_id, nombre: p.nombre, correo: p.correo, cliente_id: emp.cliente_id }, loteBono(semana, p.empleado_id), p.d * 100, ahora);
      }
      creados.push(resumen(t.tienda, p));
    }
  }
  const bolsa = plan.tiendas.reduce((suma, t) => suma + t.bolsa, 0);
  return json({ semana, bolsa, alcanzada: plan.tiendas.some((t) => t.alcanzada), creados, ya_estaban: yaEstaban }, creados.length ? 201 : 200);
}
