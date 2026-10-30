// Consultas de /reportes y los helpers de fecha de la tienda. /tablero (Issue #610) reutiliza lo exportado.
import { lineasNetas } from './netas.ts';
import { tramoDeDias, TRAMOS_ANTIGUEDAD } from '../public/graficas.js';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

// La tienda esta en America/Mexico_City: UTC-6 fijo desde 2022, sin horario de
// verano. Las ventas se guardan en UTC, asi que despues de las 18:00 locales ya
// son "manana" en UTC; el dia de la tienda se saca restando 6 horas. Sin esto,
// el corte de las 20:00 solo veia lo vendido de 18:00 a 20:00 (Issue #93).
export const diaTienda = (columna: string) => `substr(datetime(${columna}, '-6 hours'), 1, 10)`;
export const hoyTienda = (ahora = Date.now()) => new Date(ahora - 6 * 3_600_000).toISOString().slice(0, 10);
export const DIA = /^\d{4}-\d{2}-\d{2}$/;
/**
 * [00:00, 24:00) de un dia de la tienda, en UTC. Para filtrar se compara la columna
 * tal cual: diaTienda() en el WHERE obliga a D1 a leer toda la tabla en cada
 * consulta, y la caja pide el corte del dia seguido (agoto la cuota diaria, 15/10).
 */
export const delDia = (dia: string) => {
  const apertura = (d: string) => `${d}T06:00:00.000Z`;
  return [apertura(dia), apertura(new Date(Date.parse(`${dia}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10))];
};

/**
 * Los `dias` dias completos de la tienda que terminan hoy (Issue #166): el primero
 * empieza a las 00:00 de la tienda, no «hace N x 24 h», para que un dia nunca salga
 * a medias. `anterior_desde` abre el periodo de igual largo justo antes, para comparar.
 */
export function rangoDias(dias: number, ahora = Date.now()) {
  const apertura = (dia: string) => `${dia}T06:00:00.000Z`;   // 00:00 en UTC-6
  const primero = hoyTienda(ahora - (dias - 1) * 86_400_000);
  return {
    dias, dia_desde: primero, dia_hasta: hoyTienda(ahora), desde: apertura(primero),
    anterior_desde: apertura(hoyTienda(ahora - (2 * dias - 1) * 86_400_000)),
  };
}
// `dias=abc` daba NaN y tumbaba el reporte con 500: un valor que no es numero vale el de omision.
export const rangoDe = (url: URL) => {
  const dias = Math.round(Number(url.searchParams.get('dias') ?? 30));
  return rangoDias(Number.isFinite(dias) ? Math.min(365, Math.max(1, dias)) : 30);
};

/**
 * Foto de lo que hay en piso AHORA (Issue #174), sin importar el periodo del reporte: piezas individuales
 * ya etiquetadas (con codigo) y con existencia. Quedan fuera las bandas (no tienen fecha de captura propia),
 * lo agotado y lo que aun esta en la cola de revision sin etiqueta. Las danadas SI cuentan: estan en piso.
 * Antiguedad = dias de la tienda (UTC-6) desde `creado_en`, y los tramos van por semanas completas.
 * Una fecha vacia o invalida no se adivina: va aparte, en `sin_fecha`.
 */
export async function inventarioEnPiso(env: Env, ahora = Date.now()) {
  // ponytail: se trae toda la lista y se suma en JS; con decenas de miles de piezas en piso conviene agrupar en SQL.
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, coalesce(nullif(categoria, ''), 'sin categoria') as categoria, precio, stock, creado_en,
       case when julianday(creado_en) is null then null
            else max(0, cast(julianday(?) - julianday(substr(datetime(creado_en, '-6 hours'), 1, 10)) as integer)) end as dias
     from productos
     where sin_inventario = 0 and stock > 0 and destino = 'etiqueta' and codigo is not null and codigo != ''
       and propietario = 'dolaron'`,
  )
    .bind(hoyTienda(ahora))
    .all<{ id: string; codigo: string; nombre: string; categoria: string; precio: number; stock: number; creado_en: string; dias: number | null }>();

  const valorDe = (f: { precio: number; stock: number }) => f.precio * f.stock;
  const tramos = new Map(TRAMOS_ANTIGUEDAD.map(([clave]) => [clave, { tramo: clave, piezas: 0, unidades: 0, valor: 0 }]));
  const sinFecha = { piezas: 0, valor: 0 };
  const categorias = new Map<string, { categoria: string; piezas: number; unidades: number; valor: number; sumaDias: number; fechadas: number }>();
  for (const f of results) {
    const tramo = f.dias === null ? null : tramos.get(tramoDeDias(f.dias))!;
    const grupo = tramo ?? sinFecha;
    grupo.piezas += 1;
    if (tramo) tramo.unidades += f.stock;   // `piezas` cuenta etiquetas; `unidades`, la existencia (tablero #610)
    grupo.valor += valorDe(f);
    const c = categorias.get(f.categoria) ?? { categoria: f.categoria, piezas: 0, unidades: 0, valor: 0, sumaDias: 0, fechadas: 0 };
    c.piezas += 1;
    c.unidades += f.stock;
    c.valor += valorDe(f);
    if (f.dias !== null) { c.sumaDias += f.dias; c.fechadas += 1; }
    categorias.set(f.categoria, c);
  }
  return {
    piezas: results.length,
    unidades: results.reduce((suma, f) => suma + f.stock, 0),
    valor: results.reduce((suma, f) => suma + valorDe(f), 0),
    por_antiguedad: [...tramos.values()],
    sin_fecha: sinFecha,
    por_categoria: [...categorias.values()]
      .map(({ sumaDias, fechadas, ...c }) => ({ ...c, dias_promedio: fechadas ? sumaDias / fechadas : null }))
      .sort((a, b) => b.valor - a.valor || a.categoria.localeCompare(b.categoria)),
    mas_viejas: results.filter((f) => f.dias !== null)
      .sort((a, b) => b.dias! - a.dias! || valorDe(b) - valorDe(a) || a.codigo.localeCompare(b.codigo))
      .slice(0, 15)
      .map(({ id, codigo, nombre, categoria, precio, stock, creado_en, dias }) => ({ id, codigo, nombre, categoria, precio, stock, creado_en, dias })),
  };
}

/** Dias promedio entre capturar una pieza y venderla, por categoria (de siempre, solo El Dolaron). Lo reusa /api/tablero (#610). */
export async function diasEnVentaPorCategoria(env: Env) {
  // Diferido a proposito en CONTRATO-ESCANER.md hasta que hubiera ventas reales.
  const { results } = await env.DB.prepare(
    `select coalesce(nullif(p.categoria, ''), 'sin categoria') as categoria,
       avg(julianday(substr(v.creado_en, 1, 10)) - julianday(substr(p.creado_en, 1, 10))) as dias_promedio,
       count(*) as n
     from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where v.cancelada = 0 and p.sin_inventario = 0 and l.cantidad > l.cancelada_cantidad and l.propietario = 'dolaron'
     group by categoria order by dias_promedio desc`,
  ).all<{ categoria: string; dias_promedio: number; n: number }>();
  return results;
}

/**
 * Reportes: todo sale de consultas contra D1 en el momento, nada se precalcula
 * ni vive en otra tabla. `dias` acota lo que tiene sentido por rango (ventas del
 * dia, categoria, top de piezas); precio sugerido y dias en venta son de
 * siempre, porque son pocos datos y la pregunta que responden no es "esta
 * semana" sino "en general". `inventario` es la foto de ahora: tampoco depende de `dias`.
 */
export async function reportes(url: URL, env: Env): Promise<Response> {
  const rango = rangoDe(url);
  const { dias, desde } = rango;

  // Solo lo de la tienda (propietario 'dolaron', Issue #298): el neto de cada ticket va repartido por pieza.
  const resumen = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select count(distinct venta) as ventas, coalesce(sum(neta), 0) as total, coalesce(sum(cant), 0) as piezas
     from netas where propietario = 'dolaron'`,
  )
    .bind(desde)
    .first<{ ventas: number; total: number; piezas: number }>();

  // El periodo de igual largo justo antes, para las flechas de «vs periodo anterior».
  const anterior = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
     select count(distinct venta) as ventas, coalesce(sum(neta), 0) as total, coalesce(sum(cant), 0) as piezas
     from netas where propietario = 'dolaron'`,
  )
    .bind(rango.anterior_desde, desde)
    .first<{ ventas: number; total: number; piezas: number }>();

  // De bruto a vendido, sin que sobre ni falte un centavo: lo cobrado en todos los
  // tickets, menos lo devuelto por piezas, menos lo que valian los cancelados completos.
  const cuadre = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select (select coalesce(sum(total), 0) from ventas where creado_en >= ?) as bruto,
       (select coalesce(sum(devuelto + dolarones_devueltos), 0) from ventas where creado_en >= ?) as devoluciones_pieza,
       (select coalesce(sum(case when cancelada = 1 then total - devuelto - dolarones_devueltos end), 0) from ventas where creado_en >= ?) as cancelados,
       (select coalesce(sum(neta), 0) from netas where propietario = 'fep') as fep`,
  )
    .bind(desde, desde, desde, desde)
    .first<{ bruto: number; devoluciones_pieza: number; cancelados: number; fep: number }>();

  // Lo cobrado en dinero por forma de pago, y lo pagado con Dolarones como una forma mas.
  const { results: porFormaPago } = await env.DB.prepare(
    // Cobrado en el ticket (netas.ts ya descuenta el anticipo) mas el anticipo de los pedidos recibidos
    // en el periodo: el dinero entra el dia del apartado, no el de la venta. Los Dolarones usados
    // (neta - cobrado - anticipo) van en su propia fila.
    `${lineasNetas('v.creado_en >= ?')}
     select forma_pago, sum(tickets) as tickets, sum(total) as total from (
       select forma_pago, count(distinct venta) as tickets, coalesce(sum(cobrado), 0) as total
       from cobros where propietario = 'dolaron' group by forma_pago
       union all
       select forma_pago, 0, coalesce(sum(anticipo), 0) from pedidos where creado_en >= ? group by forma_pago
       union all
       select forma_pago, 0, coalesce(sum(importe), 0) from pedido_movimientos
       where tipo = 'abono' and creado_en >= ? group by forma_pago
       union all
       select 'dolarones', count(distinct case when neta - cobrado - anticipo_linea <> 0 then venta end),
         coalesce(sum(neta - cobrado - anticipo_linea), 0)
       from cobros where propietario = 'dolaron'
     ) group by forma_pago`,
  )
    .bind(desde, desde, desde)
    .all<{ forma_pago: string; tickets: number; total: number }>();

  const { results: ventasPorDia } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select ${diaTienda('creado_en')} as dia, count(distinct venta) as tickets, sum(neta) as total
     from netas where propietario = 'dolaron' group by dia order by dia`,
  )
    .bind(desde)
    .all<{ dia: string; tickets: number; total: number }>();
  const { results: piezasPorDia } = await env.DB.prepare(
    `select ${diaTienda('v.creado_en')} as dia, coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) as piezas
     from venta_lineas l join ventas v on v.id = l.venta_id
     where v.cancelada = 0 and v.creado_en >= ? and l.propietario = 'dolaron' group by dia`,
  )
    .bind(desde)
    .all<{ dia: string; piezas: number }>();
  const piezasPorDiaMapa = new Map(piezasPorDia.map((f) => [f.dia, f.piezas]));
  const porDia = ventasPorDia.map((f) => ({ ...f, piezas: piezasPorDiaMapa.get(f.dia) ?? 0 }));

  // Mapa de calor de /reportes: dia de la semana (0 = domingo, como %w) y hora, ambos de la tienda (UTC-6).
  const { results: porHora } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select cast(strftime('%w', datetime(creado_en, '-6 hours')) as integer) as dia_semana,
       cast(strftime('%H', datetime(creado_en, '-6 hours')) as integer) as hora,
       count(distinct venta) as tickets, sum(neta) as total
     from netas where propietario = 'dolaron' group by dia_semana, hora order by dia_semana, hora`,
  )
    .bind(desde)
    .all<{ dia_semana: number; hora: number; tickets: number; total: number }>();

  // Lo vendido por categoria (las bandas juntas), del periodo y del anterior de igual largo: mismas reglas en los dos.
  const ventasPorCategoria = (anteriorAlPeriodo: boolean) => env.DB.prepare(
    `${lineasNetas(`v.creado_en >= ? ${anteriorAlPeriodo ? 'and v.creado_en < ?' : ''}`)}
     select case when p.sin_inventario = 1 then 'bandas' else coalesce(nullif(p.categoria, ''), 'sin categoria') end as categoria,
       coalesce(sum(n.neta), 0) as total, coalesce(sum(n.cant), 0) as piezas
     from netas n left join productos p on p.id = n.producto_id
     where n.propietario = 'dolaron'
     group by categoria order by total desc`,
  )
    .bind(...(anteriorAlPeriodo ? [rango.anterior_desde, desde] : [desde]))
    .all<{ categoria: string; total: number; piezas: number }>();
  const { results: porCategoria } = await ventasPorCategoria(false);
  const { results: porCategoriaAnterior } = await ventasPorCategoria(true);

  const { results: topProductos } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select codigo, nombre, sum(cant) as cantidad, sum(neta) as total
     from netas where producto_id is not null and cant > 0 and propietario = 'dolaron'
     group by codigo, nombre order by cantidad desc, total desc limit 10`,
  )
    .bind(desde)
    .all<{ codigo: string; nombre: string; cantidad: number; total: number }>();

  // Cuanto se aleja lo que de verdad se cobra de lo que propuso la IA: la razon
  // por la que existe precio_sugerido (migracion 002) es poder responder esto
  // con datos en vez de ajustar los porcentajes a ojo.
  const precioSugerido = await env.DB.prepare(
    `select count(*) as n, avg((precio - precio_sugerido) * 100.0 / precio_sugerido) as promedio_pct
     from productos where precio_sugerido > 0 and precio > 0 and propietario = 'dolaron'`,
  ).first<{ n: number; promedio_pct: number | null }>();

  const diasEnVenta = await diasEnVentaPorCategoria(env);

  // Devoluciones, de ticket completo o de piezas sueltas (Issue #138): el motivo y quien cancelo son la unica huella de una
  // cancelacion que no fue legitima (cobrar de verdad y "cancelar" para
  // quedarse el efectivo). Se listan una por una, no solo el total.
  const { results: cancelaciones } = await env.DB.prepare(
    `select v.id, v.total - v.dolarones - v.devuelto as total, v.dolarones - v.dolarones_devueltos as dolarones,
       v.forma_pago, v.cancelada_en, v.cancelada_por, v.motivo_cancelacion,
       (select group_concat(nombre, ' · ') from venta_lineas
        where venta_id = v.id and cantidad > cancelada_cantidad) as piezas, 'ticket' as tipo
     from ventas v where v.cancelada = 1 and v.creado_en >= ?
     union all
     select d.venta_id, d.importe, d.dolarones, d.forma_pago, d.creado_en, d.autor, d.motivo,
       d.cantidad || ' × ' || l.nombre, 'pieza'
     from devoluciones d join venta_lineas l on l.id = d.linea_id join ventas v on v.id = d.venta_id
     where v.creado_en >= ?
     order by 5 desc`,
  )
    .bind(desde, desde)
    .all<{
      id: string; total: number; dolarones: number; forma_pago: string; cancelada_en: string;
      cancelada_por: string; motivo_cancelacion: string; piezas: string; tipo: string;
    }>();

  const { results: aperturas } = await env.DB.prepare(
    `select abierto_en, abierto_por, caja from cajon_aperturas where abierto_en >= ? order by abierto_en desc`,
  )
    .bind(desde)
    .all<{ abierto_en: string; abierto_por: string; caja: string }>();

  const { results: cortes } = await env.DB.prepare(
    `select id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas, efectivo_devoluciones, retiros,
            gastos, nomina, efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema, tarjeta_terminal, transferencias,
            dolarones, fondo_siguiente, entregado, notas
     from cortes where hasta >= ? order by hasta desc`,
  )
    .bind(desde)
    .all();

  const { results: retiros } = await env.DB.prepare(
    `select creado_en, tipo, caja, cajero, importe, motivo from retiros where creado_en >= ? order by creado_en desc`,
  )
    .bind(desde)
    .all();

  // Lo regalado en descuentos por dia (Isaac, 24/10): la promo de inauguracion aparte de los aprobados
  // (descuento ya trae la promo sumada). Un ticket cancelado no regalo nada.
  const { results: descuentosPorDia } = await env.DB.prepare(
    `select ${diaTienda('creado_en')} as dia,
       sum(case when coalesce(promo, 0) > 0 then 1 else 0 end) as promo_tickets, coalesce(sum(promo), 0) as promo,
       sum(case when coalesce(descuento, 0) - coalesce(promo, 0) > 0 then 1 else 0 end) as otros_tickets,
       coalesce(sum(coalesce(descuento, 0) - coalesce(promo, 0)), 0) as otros
     from ventas where cancelada = 0 and coalesce(descuento, 0) > 0 and creado_en >= ? group by dia order by dia`,
  )
    .bind(desde)
    .all<{ dia: string; promo_tickets: number; promo: number; otros_tickets: number; otros: number }>();
  const sumaDescuentos = (campo: 'promo_tickets' | 'promo' | 'otros_tickets' | 'otros') =>
    descuentosPorDia.reduce((suma, d) => suma + d[campo], 0);

  // Revendedoras (#575): lo que cerro en caja cada una, por el pedido que apartó. Un ticket cancelado no cuenta
  // y lo devuelto se resta (mismo neto que el resumen). Entra por ventas_creado (el rango) y une por llave primaria.
  // ponytail: importe = el ticket completo; si el cliente agrego otras piezas al cobrar, tambien suman.
  const { results: revendedoras } = await env.DB.prepare(
    `select p.vendedora, coalesce(nullif(u.nombre, ''), p.vendedora) as nombre, count(*) as pedidos,
       coalesce(sum((select coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) from venta_lineas l
         where l.venta_id = v.id and l.codigo != 'ENVIO')), 0) as piezas,
       coalesce(sum(v.total - v.devuelto - v.dolarones_devueltos), 0) as importe
     from ventas v join pedidos p on p.id = v.pedido_id join usuarios u on u.correo = p.vendedora
     where v.cancelada = 0 and v.creado_en >= ? and v.pedido_id is not null
       and (',' || u.roles || ',') like '%,revendedora,%'
     group by p.vendedora order by importe desc`,
  )
    .bind(desde)
    .all<{ vendedora: string; nombre: string; pedidos: number; piezas: number; importe: number }>();

  return json({
    dias, dia_desde: rango.dia_desde, dia_hasta: rango.dia_hasta,
    resumen: {
      ventas: resumen?.ventas ?? 0,
      total: resumen?.total ?? 0,
      piezas: resumen?.piezas ?? 0,
      ticket_promedio: resumen?.ventas ? Math.round((resumen.total ?? 0) / resumen.ventas) : 0,
    },
    anterior: {
      ventas: anterior?.ventas ?? 0,
      total: anterior?.total ?? 0,
      piezas: anterior?.piezas ?? 0,
      ticket_promedio: anterior?.ventas ? Math.round((anterior.total ?? 0) / anterior.ventas) : 0,
    },
    cuadre: {
      bruto: cuadre?.bruto ?? 0,
      devoluciones_pieza: cuadre?.devoluciones_pieza ?? 0,
      cancelados: cuadre?.cancelados ?? 0,
      fep: cuadre?.fep ?? 0,
      vendido: (cuadre?.bruto ?? 0) - (cuadre?.devoluciones_pieza ?? 0) - (cuadre?.cancelados ?? 0) - (cuadre?.fep ?? 0),
    },
    por_forma_pago: porFormaPago,
    por_dia: porDia,
    por_hora: porHora,
    por_categoria: porCategoria,
    por_categoria_anterior: porCategoriaAnterior,
    inventario: await inventarioEnPiso(env),
    top_productos: topProductos,
    precio_sugerido: { n: precioSugerido?.n ?? 0, promedio_pct: precioSugerido?.promedio_pct ?? null },
    dias_en_venta_por_categoria: diasEnVenta,
    cancelaciones: {
      n: cancelaciones.length,
      total: cancelaciones.reduce((suma, c) => suma + c.total, 0),
      dolarones: cancelaciones.reduce((suma, c) => suma + c.dolarones, 0),
      detalle: cancelaciones,
    },
    aperturas_cajon: aperturas,
    cortes,
    retiros,
    revendedoras,
    descuentos: {
      promo_tickets: sumaDescuentos('promo_tickets'), promo: sumaDescuentos('promo'),
      otros_tickets: sumaDescuentos('otros_tickets'), otros: sumaDescuentos('otros'),
      por_dia: descuentosPorDia,
    },
  });
}
