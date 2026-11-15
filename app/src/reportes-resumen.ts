// GET /api/reportes/resumen (Issue #802): el Resumen ejecutivo de /reportes.
// Ventas netas, tickets, piezas, descuentos y gastos del periodo y de la comparacion, por cubeta (dia, semana o mes); canales,
// categorias y la meta del mes. Las ventas salen de `lineasNetas` (mismo neto que /api/reportes), los gastos de la misma
// definicion que el tablero de inversionistas. Siete consultas (cuatro con tienda), todas sobre un rango: nada por producto.
import { lineasNetas } from './netas.ts';
import { GASTOS_DEL_MES } from './gastos.ts';
import { diaTienda, rangoDe } from './reportes.ts';
import { esTienda, type Tienda } from './cuentas.ts';
import { SQL_ML, apertura, canalML, type FilaML } from './tablero-comun.ts';
import { sumarDias } from '../public/graficas.js';
import {
  COMPARACIONES, GRANOS, armarCubetas, calcularMeta, granoEfectivo, primeroDelMes, ventanaComparacion,
} from '../public/reportes-resumen.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

type Medidas = { ventas: number; tickets: number; piezas: number; descuento: number; gastos: number };
const dia = (porDia: Map<string, Medidas>, clave: string) => {
  let m = porDia.get(clave);
  if (!m) { m = { ventas: 0, tickets: 0, piezas: 0, descuento: 0, gastos: 0 }; porDia.set(clave, m); }
  return m;
};
const entre = (clave: string, desde: string, hasta: string) => clave >= desde && clave <= hasta;

/** Los canales como /tablero (tablero-comun.ts): sin pedido = tienda; pedido de una revendedora = revendedoras; el resto, WhatsApp. */
export const CANAL = `case when v.pedido_id is null then 'tienda' when u.correo is not null then 'revendedoras' else 'whatsapp' end`;

export async function reporteResumen(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
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
  const mes = periodo.hasta.slice(0, 7);
  const inicioMes = primeroDelMes(periodo.hasta);

  // Lo que hay que leer: el periodo, la comparacion y, para la meta, el mes de la fecha final desde el dia 1.
  const lecturaDesde = [periodo.desde, ventana?.desde ?? periodo.desde, inicioMes].sort()[0];
  const ventasDesde = apertura(lecturaDesde), ventasHasta = apertura(sumarDias(periodo.hasta, 1));
  const comparaDesde = apertura(ventana ? (ventana.desde < periodo.desde ? ventana.desde : periodo.desde) : periodo.desde);
  const ventanaA = [apertura(periodo.desde), ventasHasta], ventanaB = ventana ? [apertura(ventana.desde), apertura(sumarDias(ventana.hasta, 1))] : null;
  const fechaFin = sumarDias(periodo.hasta, 1);
  const fechaIni = ventana && ventana.desde < periodo.desde ? ventana.desde : periodo.desde;

  const [filasDia, filasCategoria, filasDescuento, filasGasto, filasML, meta, sinClasificar] = await Promise.all([
    // 1. Ventas netas, tickets y piezas por dia y canal. Un ticket tiene un solo dia y un solo canal: los tickets suman sin repetirse.
    env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select ${diaTienda('n.creado_en')} as dia, ${CANAL} as canal,
         count(distinct n.venta) as tickets, coalesce(sum(n.neta), 0) as ventas, coalesce(sum(n.cant), 0) as piezas
       from netas n join ventas v on v.id = n.venta
         left join pedidos p on p.id = v.pedido_id
         left join usuarios u on u.correo = p.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
       where n.propietario = 'dolaron' group by dia, canal`,
    ).bind(ventasDesde, ventasHasta).all<{ dia: string; canal: string; tickets: number; ventas: number; piezas: number }>(),
    // 2. Por categoria (las bandas juntas, como /api/reportes), el periodo y la comparacion en la misma pasada.
    env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select case when p.sin_inventario = 1 then 'bandas' else coalesce(nullif(p.categoria, ''), 'sin categoria') end as categoria,
         coalesce(sum(case when n.creado_en >= ? and n.creado_en < ? then n.neta end), 0) as total,
         coalesce(sum(case when n.creado_en >= ? and n.creado_en < ? then n.cant end), 0) as piezas,
         coalesce(sum(case when n.creado_en >= ? and n.creado_en < ? then n.neta end), 0) as anterior
       from netas n left join productos p on p.id = n.producto_id
       where n.propietario = 'dolaron' group by 1`,   // por posicion: `group by categoria` agrupaba por la columna p.categoria y mezclaba las bandas con la ropa (#802)
    ).bind(comparaDesde, ventasHasta, ...ventanaA, ...ventanaA, ...(ventanaB ?? ['', ''])).all<{ categoria: string; total: number; piezas: number; anterior: number }>(),
    // 3. Lo descontado por dia: la misma suma de `ventas.descuento` (sin cancelados) que el bloque de descuentos de /api/reportes.
    env.DB.prepare(
      `select ${diaTienda('creado_en')} as dia, coalesce(sum(descuento), 0) as descuento from ventas
       where cancelada = 0 and descuento > 0 and creado_en >= ? and creado_en < ?${deTiendaSola} group by dia`,
    ).bind(comparaDesde, ventasHasta).all<{ dia: string; descuento: number }>(),
    // 4. Gastos de operacion por dia: la definicion del tablero (GASTOS_DEL_MES sin pagos a inversionistas) mas la nomina pagada
    //    (pagos y adelantos; el libro guarda el pago en negativo). No hay gastos por tienda: con tienda no se piden.
    tienda ? Promise.resolve({ results: [] as { fecha: string; importe: number }[] }) : env.DB.prepare(
      `select fecha, sum(importe) as importe from (
         select fecha, importe from (${GASTOS_DEL_MES}) where categoria != 'inversionistas'
         union all
         select fecha, case tipo when 'adelanto' then importe else -importe end from nomina_movimientos
         where tipo in ('adelanto', 'pago') and fecha >= ? and fecha < ?
       ) group by fecha`,
    ).bind(fechaIni, fechaFin, `${fechaIni}T00:00:00`, `${fechaFin}T00:00:00`, fechaIni, fechaFin).all<{ fecha: string; importe: number }>(),
    // 5. Mercado Libre, aparte de las ventas (como el tablero): periodo y comparacion. No lleva tienda.
    tienda ? Promise.resolve({ results: [] as (FilaML & { ventana: string })[] }) : env.DB.prepare(
      `select case when m.recibido_en >= ? and m.recibido_en < ? then 'a' else 'b' end as ventana, ${SQL_ML}
       from ml_ventas m join productos p on p.id = m.producto_id
         left join ml_publicaciones pub on pub.producto_id = m.producto_id
       where m.estado != 'cancelada' and p.propietario = 'dolaron'
         and ((m.recibido_en >= ? and m.recibido_en < ?) or (m.recibido_en >= ? and m.recibido_en < ?))
       group by ventana`,
    ).bind(...ventanaA, ...ventanaA, ...(ventanaB ?? ['', ''])).all<FilaML & { ventana: string }>(),
    // 6. La meta del mes.
    env.DB.prepare("select valor from config where clave = 'meta_ventas_mes'").first<{ valor: string }>(),
    // 7. Retiros de caja sin clasificar: dinero que salio del cajon como `retiro` (no `gasto`) y no esta en `gastos`. NO entran a los gastos
    //    (no se sabe que son: nomina, reparto u otra cosa); solo se cuentan para que la pantalla diga lo que el total deja fuera.
    tienda ? Promise.resolve(null) : env.DB.prepare(
      `select count(*) as n, coalesce(sum(r.importe), 0) as importe from retiros r
       where r.tipo = 'retiro' and r.creado_en >= ? and r.creado_en < ?
         and not exists (select 1 from gastos g where g.retiro_id = r.id)`,
    ).bind(...ventanaA).first<{ n: number; importe: number }>(),
  ]);

  // --- de las filas a un mapa por dia
  const porDia = new Map<string, Medidas>();
  // Por canal, la ventana A (periodo) y la B (comparacion) se acumulan aparte.
  const porCanal = { a: new Map<string, { ventas: number; tickets: number }>(), b: new Map<string, { ventas: number; tickets: number }>() };
  const acumula = (m: Map<string, { ventas: number; tickets: number }>, canal: string, f: { ventas: number; tickets: number }) => {
    const x = m.get(canal) ?? { ventas: 0, tickets: 0 };
    x.ventas += f.ventas; x.tickets += f.tickets; m.set(canal, x);
  };
  for (const f of filasDia.results) {
    const m = dia(porDia, f.dia);
    m.ventas += f.ventas; m.tickets += f.tickets; m.piezas += f.piezas;
    if (entre(f.dia, periodo.desde, periodo.hasta)) acumula(porCanal.a, f.canal, f);
    if (ventana && entre(f.dia, ventana.desde, ventana.hasta)) acumula(porCanal.b, f.canal, f);
  }
  for (const f of filasDescuento.results) dia(porDia, f.dia).descuento += f.descuento;
  for (const f of filasGasto.results) dia(porDia, f.fecha).gastos += f.importe;

  const { cubetas, totales, anterior } = armarCubetas({ desde: periodo.desde, hasta: periodo.hasta, grano, ventana, porDia, sinGastos: !!tienda });

  // --- el mejor dia del periodo
  let mejor: { dia: string; ventas: number; tickets: number } | null = null;
  let diasConVentas = 0;
  for (let d = periodo.desde; d <= periodo.hasta; d = sumarDias(d, 1)) {
    const m = porDia.get(d);
    if (m && m.tickets > 0) {
      diasConVentas += 1;
      if (!mejor || m.ventas > mejor.ventas) mejor = { dia: d, ventas: m.ventas, tickets: m.tickets };
    }
  }

  // --- canales
  const canal = (clave: string) => ({
    ventas: porCanal.a.get(clave)?.ventas ?? 0, tickets: porCanal.a.get(clave)?.tickets ?? 0,
    anterior: ventana ? porCanal.b.get(clave)?.ventas ?? 0 : null,
  });
  const fila = (clave: string) => filasML.results.find((f) => f.ventana === clave) ?? null;
  const mlA = canalML(fila('a'));
  const mercadoLibre = tienda ? null : { ...mlA, anterior: ventana ? canalML(fila('b')).total : null };

  // --- categorias: las del periodo y las que solo vendieron en la comparacion, de mayor a menor
  const categorias = filasCategoria.results.filter((f) => f.total !== 0 || f.anterior !== 0 || f.piezas !== 0)
    .map((f) => ({ ...f, anterior: ventana ? f.anterior : 0 }))
    .sort((a, b) => b.total - a.total || b.anterior - a.anterior || a.categoria.localeCompare(b.categoria));

  // --- meta del mes de la fecha final, a esa fecha; ignora el rango elegido. Es del negocio completo: con tienda no se calcula.
  const diasMes = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).getUTCDate();
  let metaMes: Record<string, unknown>;
  if (tienda) metaMes = { solo_negocio: true };
  else {
    const crudo = Number(meta?.valor);
    const acumulado: number[] = [];
    let suma = 0;
    for (let d = inicioMes; d <= periodo.hasta; d = sumarDias(d, 1)) { suma += porDia.get(d)?.ventas ?? 0; acumulado.push(suma); }
    metaMes = calcularMeta({ monto: Number.isSafeInteger(crudo) && crudo > 0 ? crudo : null, acumuladoPorDia: acumulado, diasMes });
  }

  return json({
    periodo, comparar, comparacion: ventana, grano, tienda: tienda ?? '',
    totales, anterior,
    cubetas,
    canales: { tienda: canal('tienda'), whatsapp: canal('whatsapp'), revendedoras: canal('revendedoras'), mercado_libre: mercadoLibre },
    categorias,
    retiros_sin_clasificar: tienda ? null : { n: sinClasificar?.n ?? 0, importe: sinClasificar?.importe ?? 0 },
    mejor_dia: mejor, dias_con_ventas: diasConVentas,
    meta_mes: mes, meta: metaMes,
  });
}
