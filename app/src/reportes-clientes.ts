// GET /api/reportes/clientes (Issue #802): la vista Clientes de /reportes, solo para el dueno.
// «Socio» = fila de `clientes` (el programa de Dolarones); una venta es de un socio por `ventas.cliente_id`. Las cuentas que el
// sistema crea para el equipo (`registrado_por = 'retos'`, retos.ts) NO son clientes: no cuentan como socios, y sus tickets cuentan
// como «sin socio» (como en /tablero, que tambien las deja fuera). Canal de alta: `registrado_por` es 'portal' (se registro sola),
// el correo de la cuenta de la caja (alta en la tienda, dolarones.ts) o 'retos'. Cinco consultas, todas por rango o por socio (nada por producto):
//  1. tickets y ventas netas por dia y tipo de cliente (el mismo neto que /api/reportes, via lineasNetas);
//  2. dias de compra de cada socio, de siempre hasta la fecha final (para recompra y recencia; filas = socios x dias de compra);
//  3. altas del periodo y de la comparacion, una fila por socio (se agregan en la pagina; nunca viajan al navegador);
//  4. una fila: primera alta, socios antes del periodo, cuentas del equipo y referidos;
//  5. los 15 socios con mas compras netas del periodo.
// El filtro de lineasNetas va como `v.id in (select id from ventas where ...)`: asi SQLite entra por el indice de fecha de ventas y lee solo las
// lineas de esos tickets; con el rango sobre `v` recorria TODAS las lineas vendidas (EXPLAIN QUERY PLAN: SCAN l). El resultado es el mismo.
import { lineasNetas } from './netas.ts';
import { esTienda, type Tienda } from './cuentas.ts';
import { diaTienda, rangoDe } from './reportes.ts';
import { apertura } from './tablero-comun.ts';
import { sumarDias } from '../public/graficas.js';
import { COMPARACIONES, GRANOS, granoEfectivo, ventanaComparacion } from '../public/reportes-resumen.js';
import { armarClientes, TOP } from '../public/reportes-clientes.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

/** Una cuenta que no es de un cliente: la que se crea para que el equipo gane Dolarones de retos. */
export const ES_EQUIPO = `registrado_por = 'retos'`;
export const NO_ES_EQUIPO = `registrado_por <> 'retos'`;
/** El canal de alta: el portal, la caja (la cuenta de la caja es un correo) u otro valor que no se reconoce. */
export const CANAL_ALTA = `case when registrado_por = 'portal' then 'portal' when registrado_por like '%@%' then 'tienda' else 'otro' end`;

export async function reporteClientes(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
  const rango = rangoDe(url, ahora);
  const periodo = { desde: rango.dia_desde, hasta: rango.dia_hasta, dias: rango.dias };

  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const tienda: Tienda | null = esTienda(pedida) ? pedida : null;
  const deTienda = tienda ? ` and tienda = '${tienda}'` : '';          // la clave sale de TIENDAS: segura en el SQL

  const comparar = url.searchParams.get('comparar') || 'anterior';
  if (!COMPARACIONES.includes(comparar)) return json({ error: 'Comparacion invalida.' }, 400);
  const granoPedido = url.searchParams.get('grano') ?? '';
  if (granoPedido && !GRANOS.includes(granoPedido)) return json({ error: 'Grano invalido.' }, 400);
  const grano: string = granoEfectivo(granoPedido, periodo.desde, periodo.hasta);
  const ventana: { desde: string; hasta: string; dias: number } | null = ventanaComparacion(periodo.desde, periodo.hasta, comparar);

  const lecturaDesde = ventana && ventana.desde < periodo.desde ? ventana.desde : periodo.desde;
  const [desdeLectura, desde, hasta] = [apertura(lecturaDesde), apertura(periodo.desde), apertura(sumarDias(periodo.hasta, 1))];

  const [tickets, historia, altas, programa, top] = await Promise.all([
    // 1. Tickets y ventas netas por dia y grupo: 0 sin socio, 1 socio, 2 cuenta del equipo (en la pagina cuenta como sin socio).
    env.DB.prepare(
      `${lineasNetas(`v.id in (select id from ventas where creado_en >= ? and creado_en < ?${deTienda})`)}
       select ${diaTienda('n.creado_en')} as dia,
         case when c.id is null then 0 when c.${ES_EQUIPO} then 2 else 1 end as grupo,
         count(distinct n.venta) as tickets, coalesce(sum(n.neta), 0) as ventas
       from netas n join ventas v on v.id = n.venta left join clientes c on c.id = v.cliente_id
       where n.propietario = 'dolaron' group by 1, 2`,   // por posicion: ver el aviso de `group by <alias>` en netas/ventas
    ).bind(desdeLectura, hasta).all<{ dia: string; grupo: number; tickets: number; ventas: number }>(),
    // 2. Dias de compra de cada socio (con la tienda, para filtrar en la pagina): un ticket cuenta si no esta cancelado y le
    //    queda al menos una pieza sin devolver; un ticket devuelto por completo no es una compra.
    env.DB.prepare(
      `select c.numero as socio, ${diaTienda('v.creado_en')} as dia, v.tienda as tienda, count(*) as tickets
       from ventas v indexed by ventas_cliente_historial join clientes c on c.id = v.cliente_id
       where v.cancelada = 0 and v.cliente_id is not null and c.${NO_ES_EQUIPO} and v.creado_en < ?
         and exists (select 1 from venta_lineas l where l.venta_id = v.id and l.propietario = 'dolaron' and l.cantidad > l.cancelada_cantidad)
       group by 1, 2, 3`,
    ).bind(hasta).all<{ socio: number; dia: string; tienda: string; tickets: number }>(),
    // 3. Altas de socios (no del equipo) del periodo y de la comparacion.
    env.DB.prepare(
      `select numero as socio, ${diaTienda('creado_en')} as dia, ${CANAL_ALTA} as canal from clientes
       where ${NO_ES_EQUIPO} and creado_en >= ? and creado_en < ?`,
    ).bind(desdeLectura, hasta).all<{ socio: number; dia: string; canal: string }>(),
    // 4. Lo que no es por dia: primera alta, socios anteriores a la lectura, cuentas del equipo y referidos (los de cuentas del equipo no cuentan).
    env.DB.prepare(
      `select (select ${diaTienda('min(creado_en)')} from clientes where ${NO_ES_EQUIPO}) as primero,
         (select count(*) from clientes where ${NO_ES_EQUIPO} and creado_en < ?) as antes,
         (select count(*) from clientes where ${ES_EQUIPO}) as equipo,
         (select count(*) from referidos r join clientes c on c.id = r.nuevo_id where c.${NO_ES_EQUIPO} and r.estado = 'pendiente') as pendientes,
         (select count(*) from referidos r join clientes c on c.id = r.nuevo_id where c.${NO_ES_EQUIPO} and r.estado = 'liberado') as liberados,
         (select count(*) from referidos r join clientes c on c.id = r.nuevo_id where c.${NO_ES_EQUIPO} and r.creado_en >= ? and r.creado_en < ?) as nuevos_periodo,
         (select count(*) from referidos r join clientes c on c.id = r.nuevo_id where c.${NO_ES_EQUIPO} and r.liberado_en >= ? and r.liberado_en < ?) as liberados_periodo`,
    ).bind(desdeLectura, desde, hasta, desde, hasta).first<{ primero: string | null; antes: number; equipo: number; pendientes: number; liberados: number; nuevos_periodo: number; liberados_periodo: number }>(),
    // 5. Los socios que mas compraron en el periodo, por NUMERO (nada mas del socio sale de la base).
    env.DB.prepare(
      `${lineasNetas(`v.id in (select id from ventas where cliente_id is not null and creado_en >= ? and creado_en < ?${deTienda})`)}
       select c.numero as socio, count(distinct n.venta) as tickets, sum(n.neta) as ventas
       from netas n join ventas v on v.id = n.venta join clientes c on c.id = v.cliente_id
       where n.propietario = 'dolaron' and c.${NO_ES_EQUIPO}
       group by 1 having sum(n.neta) > 0 order by ventas desc, socio limit ${TOP}`,
    ).bind(desde, hasta).all<{ socio: number; tickets: number; ventas: number }>(),
  ]);

  return json({
    periodo, comparar, comparacion: ventana, grano, tienda: tienda ?? '',
    ...armarClientes({
      desde: periodo.desde, hasta: periodo.hasta, grano, ventana, tienda: tienda ?? '',
      filasTickets: tickets.results, filasHistoria: historia.results, filasAltas: altas.results, programa, filasTop: top.results,
    }),
  });
}
