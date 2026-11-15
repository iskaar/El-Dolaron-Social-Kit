// GET /api/reportes/ventas (Issue #802): lo que la vista Ventas de /reportes necesita y /api/reportes/resumen no trae.
// Por cubeta (dia, semana o mes, la misma de Resumen): ventas netas por categoria y por canal, lo cobrado por forma de pago y
// lo descontado (promo aparte de lo aprobado); y para el periodo, el tamano de los tickets (importe y piezas, mediana).
// Las tarjetas y la tendencia salen de /api/reportes/resumen: aqui no se repiten. Cuatro consultas, todas sobre un rango (nada por producto).
// Las ventas son las de `lineasNetas` (el mismo neto que /api/reportes y Resumen), asi cada serie suma lo vendido de su cubeta al centavo.
import { lineasNetas } from './netas.ts';
import { cajasDe, esTienda, type Tienda } from './cuentas.ts';
import { consultaFormaPago, diaTienda, rangoDe } from './reportes.ts';
import { CANAL } from './reportes-resumen.ts';
import { apertura } from './tablero-comun.ts';
import { sumarDias } from '../public/graficas.js';
import { COMPARACIONES, GRANOS, granoEfectivo, ventanaComparacion } from '../public/reportes-resumen.js';
import { armarVentas, sqlTramoMonto, sqlTramoPiezas } from '../public/reportes-ventas.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

/** Importe y piezas de cada ticket y, con ellos, los tramos y la mediana. Tres terminos por compound SELECT (D1 admite 5). */
export const consultaTickets = (filtro: string) => `${lineasNetas(filtro)},
  t as (select venta, sum(neta) as neto, sum(cant) as piezas from netas where propietario = 'dolaron' group by venta),
  o as (select neto, row_number() over (order by neto) as rn, count(*) over () as c from t)
  select 'monto' as k, ${sqlTramoMonto('neto')} as b, count(*) as n, coalesce(sum(neto), 0) as total from t group by b
  union all
  select 'piezas', ${sqlTramoPiezas('piezas')}, count(*), coalesce(sum(neto), 0) from t group by 2
  union all
  select 'mediana', rn, neto, c from o where rn in ((c + 1) / 2, (c + 2) / 2)`;

export async function reporteVentas(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
  const rango = rangoDe(url, ahora);
  const periodo = { desde: rango.dia_desde, hasta: rango.dia_hasta, dias: rango.dias };

  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const tienda: Tienda | null = esTienda(pedida) ? pedida : null;
  const deTienda = tienda ? ` and v.tienda = '${tienda}'` : '';          // la clave sale de TIENDAS: segura en el SQL
  const deTiendaSola = tienda ? ` and tienda = '${tienda}'` : '';
  const deCajas = (columna: string) => tienda ? ` and ${columna} in (${cajasDe(tienda).map((c) => `'${c}'`).join(', ')})` : '';

  const comparar = url.searchParams.get('comparar') || 'anterior';
  if (!COMPARACIONES.includes(comparar)) return json({ error: 'Comparacion invalida.' }, 400);
  const granoPedido = url.searchParams.get('grano') ?? '';
  if (granoPedido && !GRANOS.includes(granoPedido)) return json({ error: 'Grano invalido.' }, 400);
  const grano: string = granoEfectivo(granoPedido, periodo.desde, periodo.hasta);
  const ventana: { desde: string; hasta: string; dias: number } | null = ventanaComparacion(periodo.desde, periodo.hasta, comparar);

  // La mezcla lee tambien la comparacion (solo para contar sus dias con venta); lo demas, solo el periodo.
  const lecturaDesde = ventana && ventana.desde < periodo.desde ? ventana.desde : periodo.desde;
  const [desde, hasta] = [apertura(periodo.desde), apertura(sumarDias(periodo.hasta, 1))];

  const [mezcla, pago, tickets, descuento] = await Promise.all([
    // 1. Ventas netas por dia, canal (el de Resumen y /tablero) y categoria (las bandas juntas, como /api/reportes).
    env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select ${diaTienda('n.creado_en')} as dia, ${CANAL} as canal,
         case when p.sin_inventario = 1 then 'bandas' else coalesce(nullif(p.categoria, ''), 'sin categoria') end as categoria,
         coalesce(sum(n.neta), 0) as ventas, coalesce(sum(n.cant), 0) as piezas
       from netas n join ventas v on v.id = n.venta
         left join productos p on p.id = n.producto_id
         left join pedidos pe on pe.id = v.pedido_id
         left join usuarios u on u.correo = pe.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
       where n.propietario = 'dolaron' group by 1, 2, 3`,   // por posicion: `group by categoria` agruparia por la columna p.categoria y no por la expresion (mezcla las bandas con la ropa)
    ).bind(apertura(lecturaDesde), hasta).all<{ dia: string; canal: string; categoria: string; ventas: number; piezas: number }>(),
    // 2. Lo cobrado por forma de pago y dia: LA MISMA consulta de por_forma_pago de /api/reportes, con el dia (anticipos y Dolarones incluidos).
    env.DB.prepare(consultaFormaPago(deTienda, deCajas, true))
      .bind(desde, hasta, desde, hasta, desde, hasta).all<{ dia: string; forma_pago: string; total: number }>(),
    // 3. Tamano de los tickets del periodo: tramos de importe y de piezas y los tickets del centro (mediana).
    env.DB.prepare(consultaTickets(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)).bind(desde, hasta).all<{ k: string; b: number; n: number; total: number }>(),
    // 4. Lo descontado por dia: la misma de los descuentos de /api/reportes (la promo aparte de lo aprobado; sin cancelados).
    env.DB.prepare(
      `select ${diaTienda('creado_en')} as dia,
         sum(case when coalesce(promo, 0) > 0 then 1 else 0 end) as promo_tickets, coalesce(sum(promo), 0) as promo,
         sum(case when coalesce(descuento, 0) - coalesce(promo, 0) > 0 then 1 else 0 end) as otros_tickets,
         coalesce(sum(coalesce(descuento, 0) - coalesce(promo, 0)), 0) as otros
       from ventas where cancelada = 0 and coalesce(descuento, 0) > 0 and creado_en >= ? and creado_en < ?${deTiendaSola} group by dia`,
    ).bind(desde, hasta).all<{ dia: string; promo_tickets: number; promo: number; otros_tickets: number; otros: number }>(),
  ]);

  return json({
    periodo, comparar, comparacion: ventana, grano, tienda: tienda ?? '',
    ...armarVentas({
      desde: periodo.desde, hasta: periodo.hasta, grano, ventana,
      filasMezcla: mezcla.results, filasPago: pago.results, filasDescuento: descuento.results, filasTickets: tickets.results,
    }),
  });
}
