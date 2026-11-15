// GET /api/reportes/control (Issue #802): lo que la vista Control de /reportes necesita y /api/reportes no trae.
// Prevencion de perdidas: cancelaciones y devoluciones (por periodo, motivo, persona, hora y demora), cajon abierto sin venta,
// diferencia de cortes y descuentos aprobados fuera de la promocion. Las tarjetas y las series van por cubeta (dia, semana o mes,
// el mismo grano de Resumen) contra la comparacion elegida.
// Seis consultas, todas acotadas por el rango (nada por producto ni por ticket): ventas por dia y cajero, cancelaciones y
// devoluciones, aperturas del cajon, cortes, descuentos aprobados y usuarios. Nombra a personal de la tienda, nunca a clientes.
// A que periodo pertenece cada cosa: ver la cabecera de public/reportes-control.js (la venta, no la cancelacion).
import { cajasDe, esTienda, type Tienda } from './cuentas.ts';
import { diaTienda, rangoDe } from './reportes.ts';
import { apertura } from './tablero-comun.ts';
import { sumarDias } from '../public/graficas.js';
import { COMPARACIONES, GRANOS, granoEfectivo, ventanaComparacion } from '../public/reportes-resumen.js';
import { armarControl } from '../public/reportes-control.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

export async function reporteControl(url: URL, env: Env, ahora = Date.now()): Promise<Response> {
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

  // Se lee desde el inicio de lo que se compara (si hay) y hasta el final del periodo: una sola ventana por consulta.
  const lecturaDesde = ventana && ventana.desde < periodo.desde ? ventana.desde : periodo.desde;
  const [desde, hasta] = [apertura(lecturaDesde), apertura(sumarDias(periodo.hasta, 1))];

  const [ventas, eventos, aperturas, cortes, descuentos, usuarios] = await Promise.all([
    // 1. Tickets y bruto por dia de la venta y cajero. Todos, cancelados incluidos: es el `bruto` del cuadre de /api/reportes.
    env.DB.prepare(
      `select ${diaTienda('creado_en')} as dia, cajero, count(*) as tickets, coalesce(sum(total), 0) as bruto
       from ventas where creado_en >= ? and creado_en < ?${deTiendaSola} group by 1, 2`,
    ).bind(desde, hasta).all(),
    // 2. Un renglon por cancelacion completa y por pieza devuelta, en el dia de la VENTA (como el bloque `cancelaciones` de /api/reportes).
    //    Dinero = lo que salio en efectivo, tarjeta o transferencia (con el que se paso a cupon); Dolarones aparte. Su suma es lo que el cuadre resta del bruto.
    env.DB.prepare(
      `select 'ticket' as tipo, ${diaTienda('v.creado_en')} as dia, v.creado_en as venta_en, v.cancelada_en as en, v.cancelada_por as por,
         v.motivo_cancelacion as motivo, v.total - v.dolarones - v.devuelto as dinero, v.dolarones - v.dolarones_devueltos as dolarones
       from ventas v where v.cancelada = 1 and v.creado_en >= ? and v.creado_en < ?${deTienda}
       union all
       select 'pieza', ${diaTienda('v.creado_en')}, v.creado_en, d.creado_en, d.autor, d.motivo, d.importe + d.cupon, d.dolarones
       from devoluciones d join ventas v on v.id = d.venta_id where v.creado_en >= ? and v.creado_en < ?${deTienda}`,
    ).bind(desde, hasta, desde, hasta).all(),
    // 3. «Abrir cajon» sin venta, de las cajas de la tienda elegida.
    env.DB.prepare(
      `select abierto_en, abierto_por from cajon_aperturas where abierto_en >= ? and abierto_en < ?${deCajas('caja')}`,
    ).bind(desde, hasta).all(),
    // 4. Cortes cerrados en el rango (contado - esperado): el mismo criterio de /api/reportes.
    env.DB.prepare(
      `select hasta, diferencia from cortes where hasta >= ? and hasta < ?${deCajas('caja')}`,
    ).bind(desde, hasta).all(),
    // 5. Descuentos aprobados fuera de la promocion, de los tickets que siguen en pie (el mismo criterio de los descuentos de /api/reportes).
    //    La solicitud se une por su llave primaria (`ventas.descuento_id` es unico): quien lo pidio y quien lo aprobo.
    env.DB.prepare(
      `select ${diaTienda('v.creado_en')} as dia, coalesce(v.descuento, 0) - coalesce(v.promo, 0) as monto, coalesce(s.correo, '') as pidio,
         coalesce(s.resuelto_por, '') as aprobo, s.id is not null as con_solicitud
       from ventas v left join solicitudes s on s.id = v.descuento_id
       where v.cancelada = 0 and coalesce(v.descuento, 0) - coalesce(v.promo, 0) > 0 and v.creado_en >= ? and v.creado_en < ?${deTienda}`,
    ).bind(desde, hasta).all(),
    env.DB.prepare('select correo, nombre, roles from usuarios').all(),
  ]);

  return json({
    periodo, comparar, comparacion: ventana, grano, tienda: tienda ?? '',
    ...armarControl({
      desde: periodo.desde, hasta: periodo.hasta, grano, ventana,
      ventas: ventas.results as never, eventos: eventos.results as never, aperturas: aperturas.results as never, cortes: cortes.results as never,
      descuentos: (descuentos.results as { con_solicitud: number }[]).map((f) => ({ ...f, con_solicitud: !!f.con_solicitud })) as never,
      usuarios: usuarios.results as never,
    }),
  });
}
