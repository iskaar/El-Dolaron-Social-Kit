// GET /api/tablero (Issue #610): el tablero de solo lectura de los inversionistas.
// SOLO agregados del mes de la tienda. Nunca nombres, telefonos, correos, tickets, codigos de pieza, motivos de
// cancelacion, sueldos ni una fila por persona. Un grupo de menos de 5 personas no se cuenta (MIN_PERSONAS).
import { diasEnVentaPorCategoria, inventarioEnPiso } from './reportes.ts';
import { gananciaDe } from '../public/vender.js';
import { DETALLES } from './tablero-detalle.ts';
import {
  apertura, calendario, canalesDelMes, desdeComparacion, gastosDelMes, json, mercadoLibre, personasVisibles, resumenDeVentas,
  ventasPorDia, MIN_PERSONAS,
} from './tablero-comun.ts';

const CACHE_SEGUNDOS = 300;

export async function calcularTablero(env: Env, ahora = Date.now()) {
  const cal = calendario(ahora);
  const { hoy, mes, primero, siguiente, diasMes, transcurridos } = cal;

  const [porDia, canales, filasRevendedora, ml, gastos, config, inventario, diasEnVenta, clientes] = await Promise.all([
    ventasPorDia(env, desdeComparacion(cal), cal),
    canalesDelMes(env, cal),
    // Un renglon por ticket de revendedora (solo el subtotal sin envio, sin id): la comision se redondea por ticket como en vender.js.
    env.DB.prepare(
      `select coalesce(sum(l.precio * (l.cantidad - l.cancelada_cantidad)), 0) as subtotal
       from ventas v join pedidos p on p.id = v.pedido_id
         join usuarios u on u.correo = p.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
         left join venta_lineas l on l.venta_id = v.id and l.codigo != 'ENVIO'
       where v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ? group by v.id`,
    ).bind(apertura(primero), apertura(siguiente)).all<{ subtotal: number }>(),
    mercadoLibre(env, primero, cal),
    gastosDelMes(env, cal),
    env.DB.prepare("select valor from config where clave = 'meta_ventas_mes'").first<{ valor: string }>(),
    inventarioEnPiso(env, ahora),
    diasEnVentaPorCategoria(env),
    env.DB.prepare(
      `select (select count(*) from clientes) as socios,
         (select count(*) from (select cliente_id from ventas where cliente_id is not null and cancelada = 0
            group by cliente_id having count(*) >= 2)) as regresaron`,
    ).first<{ socios: number; regresaron: number }>(),
  ]);

  // --- ventas: mes, semanas y comparacion
  const { delMes, ventas } = resumenDeVentas(porDia.results, cal);

  // --- meta y ritmo (null sin meta o con 0)
  const metaCruda = Number(config?.valor);
  const meta = Number.isSafeInteger(metaCruda) && metaCruda > 0 ? metaCruda : null;
  const ritmo = meta === null ? null : Math.round(meta * transcurridos / diasMes);

  // --- gastos del mes (una sola vez cada gasto de caja) + nomina
  const { total: gastosTotal, grupos } = gastos;

  // --- canales
  const canal = (clave: string) => canales.results.find((f) => f.canal === clave);
  const comision = filasRevendedora.results.reduce((s, f) => s + gananciaDe({ estado: 'vendido', subtotal: f.subtotal }), 0);
  const revendedoras = canal('revendedoras');
  const revendedorasVisibles = personasVisibles(revendedoras?.personas ?? 0) !== null;

  // --- inventario: solo agregados (sin la lista de piezas mas viejas)
  const semanasDeInventario = transcurridos >= 7 && delMes.total > 0
    ? Math.round(inventario.valor / (delMes.total / (transcurridos / 7))) : null;

  const socios = clientes?.socios ?? 0;
  return {
    generado_en: new Date(ahora).toISOString(),
    mes: { clave: mes, dias: diasMes, transcurridos, hoy },
    ventas,
    meta: meta === null ? null : {
      monto: meta,
      avance_pct: Math.round(delMes.total * 100 / meta),
      ritmo_monto: ritmo,
      ritmo_pct: Math.round(transcurridos * 100 / diasMes),
      estado: delMes.total >= ritmo! ? 'arriba' : 'abajo',
    },
    gastos: {
      total: gastosTotal,
      por_categoria: [
        { categoria: 'nomina', importe: grupos.nomina }, { categoria: 'renta', importe: grupos.renta },
        { categoria: 'otros', importe: grupos.otros }, { categoria: 'publicidad', importe: grupos.publicidad },
      ],
    },
    ventas_menos_gastos: delMes.total - gastosTotal,
    inventario: {
      piezas: inventario.unidades,
      valor: inventario.valor,
      semanas_de_inventario: semanasDeInventario,
      por_antiguedad: inventario.por_antiguedad,
      sin_fecha: inventario.sin_fecha,
      por_categoria: inventario.por_categoria,
    },
    dias_en_venta: diasEnVenta.map(({ categoria, dias_promedio, n }) => ({ categoria, dias_promedio, n })),
    canales: {
      tienda: { total: canal('tienda')?.total ?? 0, tickets: canal('tienda')?.tickets ?? 0 },
      // Con menos de 5 revendedoras su venta y comision son casi el pago de una persona: van sumadas a WhatsApp.
      whatsapp: {
        total: (canal('whatsapp')?.total ?? 0) + (revendedorasVisibles ? 0 : revendedoras?.total ?? 0),
        tickets: (canal('whatsapp')?.tickets ?? 0) + (revendedorasVisibles ? 0 : revendedoras?.tickets ?? 0),
        incluye_revendedoras: !revendedorasVisibles,
      },
      revendedoras: revendedorasVisibles
        ? { total: revendedoras?.total ?? 0, tickets: revendedoras?.tickets ?? 0, comision, personas: revendedoras!.personas }
        : null,
      mercado_libre: { estimado: true, total: ml?.total ?? 0, piezas: ml?.piezas ?? 0 },
    },
    clientes: {
      socios: personasVisibles(socios),
      regresaron_pct: socios >= MIN_PERSONAS ? Math.round((clientes?.regresaron ?? 0) * 100 / socios) : null,
    },
    publicidad: {
      gasto: grupos.publicidad,
      ventas_por_peso: grupos.publicidad > 0 ? Math.round(delMes.total / grupos.publicidad) : null,
    },
  };
}

/**
 * GET /api/tablero (resumen) y GET /api/tablero?vista=<nombre> (detalle de un canal, el inventario, los gastos o los clientes).
 * El JSON se calcula a lo mas cada 5 min por centro de datos y por vista; el navegador nunca lo guarda.
 * La ruta es una sola a proposito: el permiso (cuentas.ts) la abre al inversionista solo con GET.
 */
export async function rutaTablero(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Metodo no permitido.' }, 405);
  const url = new URL(request.url);
  const vista = url.searchParams.get('vista');
  // Una vista que no existe no llega a D1 ni a la cache.
  if (vista !== null && !Object.hasOwn(DETALLES, vista)) return json({ error: 'Vista no encontrada.' }, 404);
  // Sin `caches` (pruebas locales) se calcula siempre.
  const cache = typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default;
  // La cache es de la zona: sandbox y prod comparten viste.com.mx, asi que la llave lleva el host (y la vista).
  const llave = new Request(`${url.origin}/api/tablero/cache-v1${vista === null ? '' : `/${vista}`}`);
  const guardado = await cache?.match(llave).catch(() => undefined);
  if (guardado) return json(await guardado.json());
  const cuerpo = vista === null ? await calcularTablero(env) : await DETALLES[vista](env, calendario());
  if (cache) {
    ctx.waitUntil(cache.put(llave, new Response(JSON.stringify(cuerpo), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SEGUNDOS}` },
    })).catch(() => undefined));
  }
  return json(cuerpo);
}
