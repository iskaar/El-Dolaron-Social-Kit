// GET /api/reportes/finanzas (Issue #802): lo que la vista Finanzas de /reportes necesita y /api/reportes no trae.
// Ventas netas, gastos de operacion, nomina, pagos a inversionistas y retiros sin clasificar por dia (de ahi: tarjetas por cubeta y el
// estado de resultados por mes), lo cobrado por forma de pago, las diferencias de cada corte y la comision estimada de la terminal.
// Las definiciones son las de Resumen y el tablero (ver reportes-finanzas.js): mismo neto (`lineasNetas`), mismos gastos (`GASTOS_DEL_MES`
// mas la nomina pagada), mismos retiros sin clasificar; el test las cuadra contra /api/reportes y /api/reportes/resumen.
// Seis consultas (cuatro con tienda), todas sobre un rango: nada por producto.
import { lineasNetas } from './netas.ts';
import { GASTOS_DEL_MES } from './gastos.ts';
import { cajasDe, esTienda, type Tienda } from './cuentas.ts';
import { consultaFormaPago, diaTienda, rangoDe } from './reportes.ts';
import { apertura } from './tablero-comun.ts';
import { sumarDias } from '../public/graficas.js';
import { COMPARACIONES, GRANOS, granoEfectivo, ventanaComparacion } from '../public/reportes-resumen.js';
import { armarFinanzas, CLAVE_COMISION } from '../public/reportes-finanzas.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

/**
 * Gastos de operacion y pagos a inversionistas por dia y categoria: GASTOS_DEL_MES (cada gasto de caja una sola vez) mas la nomina
 * pagada (pagos y adelantos; el libro guarda el pago en negativo), que se cuenta como categoria `nomina`. Es la misma suma que Resumen
 * (reportes-resumen.ts), sin quitar `inversionistas` ni juntar las categorias: aqui se separan. Binds: lo de GASTOS_DEL_MES y desde, hasta.
 */
export const GASTOS_Y_NOMINA = `select fecha, categoria, sum(importe) as importe from (
     select fecha, categoria, importe from (${GASTOS_DEL_MES})
     union all
     select fecha, 'nomina', case tipo when 'adelanto' then importe else -importe end from nomina_movimientos
     where tipo in ('adelanto', 'pago') and fecha >= ? and fecha < ?
   ) group by 1, 2`;

export async function reporteFinanzas(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
  const rango = rangoDe(url, ahora);
  const periodo = { desde: rango.dia_desde, hasta: rango.dia_hasta, dias: rango.dias };

  const pedida = url.searchParams.get('tienda') ?? '';
  if (pedida && !esTienda(pedida)) return json({ error: 'Tienda invalida.' }, 400);
  const tienda: Tienda | null = esTienda(pedida) ? pedida : null;
  const deTienda = tienda ? ` and v.tienda = '${tienda}'` : '';          // la clave sale de TIENDAS: segura en el SQL
  const deCajas = (columna: string) => tienda ? ` and ${columna} in (${cajasDe(tienda).map((c) => `'${c}'`).join(', ')})` : '';

  const comparar = url.searchParams.get('comparar') || 'anterior';
  if (!COMPARACIONES.includes(comparar)) return json({ error: 'Comparacion invalida.' }, 400);
  const granoPedido = url.searchParams.get('grano') ?? '';
  if (granoPedido && !GRANOS.includes(granoPedido)) return json({ error: 'Grano invalido.' }, 400);
  const grano: string = granoEfectivo(granoPedido, periodo.desde, periodo.hasta);
  const ventana: { desde: string; hasta: string; dias: number } | null = ventanaComparacion(periodo.desde, periodo.hasta, comparar);

  // Lo que hay que leer: el periodo y, para comparar, la ventana (siempre anterior al periodo).
  const lecturaDesde = ventana && ventana.desde < periodo.desde ? ventana.desde : periodo.desde;
  const fechaFin = sumarDias(periodo.hasta, 1);
  const [desde, hasta] = [apertura(periodo.desde), apertura(fechaFin)];
  const lecturaApertura = apertura(lecturaDesde);

  const [ventas, gastos, sinClasificar, pago, cortes, comision] = await Promise.all([
    // 1. Ventas netas por dia (el mismo neto que /api/reportes y Resumen).
    env.DB.prepare(
      `${lineasNetas(`v.creado_en >= ? and v.creado_en < ?${deTienda}`)}
       select ${diaTienda('n.creado_en')} as dia, coalesce(sum(n.neta), 0) as ventas from netas n where n.propietario = 'dolaron' group by 1`,
    ).bind(lecturaApertura, hasta).all<{ dia: string; ventas: number }>(),
    // 2. Gastos, nomina e inversionistas por dia y categoria. No hay gastos por tienda: con tienda no se piden (como Resumen).
    tienda ? Promise.resolve({ results: [] as { fecha: string; categoria: string; importe: number }[] }) : env.DB.prepare(GASTOS_Y_NOMINA)
      .bind(lecturaDesde, fechaFin, `${lecturaDesde}T00:00:00`, `${fechaFin}T00:00:00`, lecturaDesde, fechaFin)
      .all<{ fecha: string; categoria: string; importe: number }>(),
    // 3. Retiros de caja sin clasificar por dia: tipo `retiro` sin fila en `gastos` (la misma regla de Resumen).
    tienda ? Promise.resolve({ results: [] as { dia: string; n: number; importe: number }[] }) : env.DB.prepare(
      `select ${diaTienda('r.creado_en')} as dia, count(*) as n, coalesce(sum(r.importe), 0) as importe from retiros r
       where r.tipo = 'retiro' and r.creado_en >= ? and r.creado_en < ? and not exists (select 1 from gastos g where g.retiro_id = r.id) group by 1`,
    ).bind(lecturaApertura, hasta).all<{ dia: string; n: number; importe: number }>(),
    // 4. Lo cobrado por forma de pago y dia: LA MISMA consulta de /api/reportes (anticipos incluidos), solo el periodo.
    env.DB.prepare(consultaFormaPago(deTienda, deCajas, true))
      .bind(desde, hasta, desde, hasta, desde, hasta).all<{ dia: string; forma_pago: string; total: number }>(),
    // 5. Los cortes del periodo (la misma ventana que /api/reportes): su diferencia = contado - esperado.
    env.DB.prepare(
      `select caja, hasta, ${diaTienda('hasta')} as dia, diferencia from cortes where hasta >= ? and hasta < ?${deCajas('caja')} order by hasta`,
    ).bind(desde, hasta).all<{ caja: string; hasta: string; dia: string; diferencia: number }>(),
    // 6. El porcentaje de la comision de la terminal (opcional).
    env.DB.prepare('select valor from config where clave = ?').bind(CLAVE_COMISION).first<{ valor: string }>(),
  ]);

  return json({
    periodo, comparar, comparacion: ventana, grano, tienda: tienda ?? '',
    ...armarFinanzas({
      desde: periodo.desde, hasta: periodo.hasta, grano, ventana, soloVentas: !!tienda,
      filasVentas: ventas.results, filasGasto: gastos.results, filasSinClasificar: sinClasificar.results,
      filasPago: pago.results, filasCortes: cortes.results, comisionBp: comision?.valor ?? null,
    }),
  });
}
