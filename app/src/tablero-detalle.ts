// GET /api/tablero?vista=<nombre> (Issue #610): el detalle de cada cifra del tablero de los inversionistas.
// Mismas reglas que el resumen: SOLO agregados del mes de la tienda. Nunca nombres, telefonos, correos, tickets, pedidos,
// codigos de pieza, motivos de cancelacion, guias, sueldos ni una fila por persona. Un grupo de menos de MIN_PERSONAS
// personas no se cuenta, y lo que lo dejaria deducible restando se junta con otra cifra (ver `pagos.otras`).
import { lineasNetas } from './netas.ts';
import { diasEnVentaPorCategoria, inventarioEnPiso } from './reportes.ts';
import { D_ALTA, D_PREMIO, MINIMO_COMPRA, MAXIMO_REFERIDOS } from './referidos.ts';
import { DIAS_APARTADO, HORAS_REVENDEDORA } from './pedidos.ts';
import { ANTICIPO_ENVIO, ANTICIPO_PORCENTAJE } from '../public/venta.js';
import { COMISION } from '../public/vender.js';
import {
  apertura, canalesDelMes, comisionDelMes, desdeComparacion, gastosDelMes, mercadoLibre, personasVisibles, resumenDeVentas,
  ventasPorDia, type Calendario, type FilaCanal,
} from './tablero-comun.ts';

type Vista = (env: Env, cal: Calendario) => Promise<unknown>;

const cabecera = (vista: string, cal: Calendario) => ({
  vista, generado_en: new Date(cal.ahora).toISOString(),
  mes: { clave: cal.mes, dias: cal.diasMes, transcurridos: cal.transcurridos, hoy: cal.hoy },
});

/**
 * Canales del mes o de la semana. Con menos de 5 revendedoras con venta su total seria el pago de una persona:
 * van sumadas a WhatsApp (igual que el resumen) y `revendedoras` queda en null.
 */
export function repartirCanales(filas: FilaCanal[], periodo: 'mes' | 'semana') {
  const sufijo = periodo === 'semana' ? '_semana' : '';
  const dato = (clave: string) => {
    const f = filas.find((x) => x.canal === clave);
    return { total: f?.[`total${sufijo}` as 'total'] ?? 0, tickets: f?.[`tickets${sufijo}` as 'tickets'] ?? 0, personas: f?.[`personas${sufijo}` as 'personas'] ?? 0 };
  };
  const tienda = dato('tienda');
  const whatsapp = dato('whatsapp');
  const rev = dato('revendedoras');
  // La revendedora del mes decide si el canal existe; la de la semana, si esa semana se puede separar.
  const aparte = personasVisibles(rev.personas) !== null;
  return {
    tienda: { total: tienda.total, tickets: tienda.tickets },
    whatsapp: {
      total: whatsapp.total + (aparte ? 0 : rev.total), tickets: whatsapp.tickets + (aparte ? 0 : rev.tickets),
      incluye_revendedoras: !aparte,
    },
    revendedoras: aparte ? { total: rev.total, tickets: rev.tickets } : null,
  };
}

/** Cuantos socios distintos pagaron con Dolarones en [desde, hasta) (solo se cuentan, nunca se nombran). */
const sociosConDolarones = (env: Env, desde: string, hasta: string, soloCaja: boolean) => env.DB.prepare(
  `select count(distinct cliente_id) as n, coalesce(sum(dolarones - dolarones_devueltos), 0) as importe
   from ventas where cancelada = 0 and dolarones > 0 and cliente_id is not null and creado_en >= ? and creado_en < ?
     ${soloCaja ? 'and pedido_id is null' : ''}`,
).bind(desde, hasta).first<{ n: number; importe: number }>();

// --- Ventas

async function ventas(env: Env, cal: Calendario) {
  const [porDia, canales, ml, cuadre, descuentos] = await Promise.all([
    ventasPorDia(env, desdeComparacion(cal), cal),
    canalesDelMes(env, cal),
    mercadoLibre(env, cal.lunes, cal),
    // De lo cobrado a lo vendido, al centavo (misma cuenta que /reportes, acotada al mes).
    env.DB.prepare(
      `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
       select (select coalesce(sum(total), 0) from ventas where creado_en >= ? and creado_en < ?) as bruto,
         (select coalesce(sum(devuelto + dolarones_devueltos), 0) from ventas where creado_en >= ? and creado_en < ?) as devoluciones,
         (select coalesce(sum(case when cancelada = 1 then total - devuelto - dolarones_devueltos end), 0) from ventas
            where creado_en >= ? and creado_en < ?) as cancelaciones,
         (select coalesce(sum(neta), 0) from netas where propietario = 'fep') as otros_duenos`,
    ).bind(...Array(4).fill([apertura(cal.primero), apertura(cal.siguiente)]).flat())
      .first<{ bruto: number; devoluciones: number; cancelaciones: number; otros_duenos: number }>(),
    // Lo regalado en descuentos: la promo aparte de los aprobados (descuento ya trae la promo sumada). Un ticket cancelado no regalo nada.
    env.DB.prepare(
      `select coalesce(sum(case when coalesce(promo, 0) > 0 then 1 else 0 end), 0) as promo_tickets, coalesce(sum(promo), 0) as promo,
         coalesce(sum(case when coalesce(descuento, 0) - coalesce(promo, 0) > 0 then 1 else 0 end), 0) as otros_tickets,
         coalesce(sum(coalesce(descuento, 0) - coalesce(promo, 0)), 0) as otros
       from ventas where cancelada = 0 and coalesce(descuento, 0) > 0 and creado_en >= ? and creado_en < ?`,
    ).bind(apertura(cal.primero), apertura(cal.siguiente))
      .first<{ promo_tickets: number; promo: number; otros_tickets: number; otros: number }>(),
  ]);
  const { ventas: resumen } = resumenDeVentas(porDia.results, cal);
  const semana = repartirCanales(canales.results, 'semana');
  return {
    ...cabecera('ventas', cal),
    ventas: resumen,
    // Esta semana (lunes a hoy) por canal. Mercado Libre va aparte: es estimado y no esta sumado en las ventas.
    canales_semana: { ...semana, mercado_libre: { estimado: true, total: ml?.total ?? 0, piezas: ml?.piezas ?? 0 } },
    cuadre: {
      cobrado: cuadre?.bruto ?? 0, devoluciones: cuadre?.devoluciones ?? 0, cancelaciones: cuadre?.cancelaciones ?? 0,
      otros_duenos: cuadre?.otros_duenos ?? 0,
      vendido: (cuadre?.bruto ?? 0) - (cuadre?.devoluciones ?? 0) - (cuadre?.cancelaciones ?? 0) - (cuadre?.otros_duenos ?? 0),
    },
    descuentos: descuentos ?? { promo_tickets: 0, promo: 0, otros_tickets: 0, otros: 0 },
  };
}

// --- Tienda (caja)

async function tienda(env: Env, cal: Calendario) {
  const [filas, dolarones] = await Promise.all([
    // Un renglon por canal (caja o no), forma de pago, dia de la semana (0 = domingo) y franja del dia (hora de la tienda):
    // cada ticket cae en uno solo. Lo que no es de la caja solo sirve para saber que parte de las ventas del mes es la caja.
    env.DB.prepare(
      `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
       select v.pedido_id is null as es_caja, c.forma_pago, cast(strftime('%w', datetime(c.creado_en, '-6 hours')) as integer) as dia_semana,
         case when cast(strftime('%H', datetime(c.creado_en, '-6 hours')) as integer) < 12 then 'manana'
              when cast(strftime('%H', datetime(c.creado_en, '-6 hours')) as integer) < 16 then 'tarde' else 'noche' end as franja,
         count(distinct c.venta) as tickets, coalesce(sum(c.neta), 0) as total, coalesce(sum(c.cobrado), 0) as cobrado,
         coalesce(sum(c.neta - c.cobrado - c.anticipo_linea), 0) as dolarones
       from cobros c join ventas v on v.id = c.venta where c.propietario = 'dolaron' group by es_caja, c.forma_pago, dia_semana, franja`,
    ).bind(apertura(cal.primero), apertura(cal.siguiente))
      .all<{ es_caja: number; forma_pago: string; dia_semana: number; franja: string; tickets: number; total: number; cobrado: number; dolarones: number }>(),
    sociosConDolarones(env, apertura(cal.primero), apertura(cal.siguiente), true),
  ]);
  const ventasTotal = filas.results.reduce((s, f) => s + f.total, 0);
  const caja = filas.results.filter((f) => f.es_caja === 1);
  const suma = (campo: 'tickets' | 'total') => caja.reduce((s, f) => s + f[campo], 0);
  const cobradoEn = (forma: string) => caja.filter((f) => f.forma_pago === forma).reduce((s, f) => s + f.cobrado, 0);
  const total = suma('total');
  const tickets = suma('tickets');
  const efectivo = cobradoEn('efectivo');
  const tarjeta = cobradoEn('tarjeta');
  const transferencia = cobradoEn('transferencia');
  const pagadoConDolarones = caja.reduce((s, f) => s + f.dolarones, 0);
  // Si menos de 5 socios pagaron con Dolarones, restar las otras formas de pago de lo vendido los delataria:
  // su monto se junta con cualquier otra forma de pago en `otras`.
  const dolaronesVisibles = personasVisibles(dolarones?.n ?? 0) !== null;
  const otras = total - efectivo - tarjeta - transferencia - (dolaronesVisibles ? pagadoConDolarones : 0);
  const porDiaSemana = Array.from({ length: 7 }, (_, dia) => {
    const del = caja.filter((f) => f.dia_semana === dia);
    return { dia, total: del.reduce((s, f) => s + f.total, 0), tickets: del.reduce((s, f) => s + f.tickets, 0) };
  });
  const franja = (clave: string) => caja.filter((f) => f.franja === clave).reduce((s, f) => s + f.total, 0);
  return {
    ...cabecera('tienda', cal),
    ventas_total: ventasTotal,
    tienda: { total, tickets, ticket_promedio: tickets ? Math.round(total / tickets) : 0 },
    pagos: { efectivo, tarjeta, transferencia, dolarones: dolaronesVisibles ? pagadoConDolarones : null, otras },
    por_dia_semana: porDiaSemana,
    por_franja: { manana: franja('manana'), tarde: franja('tarde'), noche: franja('noche') },
  };
}

// --- Mercancia en el piso

async function mercancia(env: Env, cal: Calendario) {
  const [inventario, diasEnVenta] = await Promise.all([inventarioEnPiso(env, cal.ahora), diasEnVentaPorCategoria(env)]);
  const porTramo = inventario.por_antiguedad.map(({ tramo, unidades, valor }) => ({ tramo, piezas: unidades, valor }));
  return {
    ...cabecera('mercancia', cal),
    inventario: {
      piezas: inventario.unidades,
      valor: inventario.valor,
      por_categoria: inventario.por_categoria.map(({ categoria, unidades, valor }) => ({ categoria, piezas: unidades, valor })),
      por_antiguedad: porTramo,
      // Piezas con existencia pero sin fecha de captura valida: no se adivina su edad.
      sin_fecha: inventario.unidades - porTramo.reduce((s, t) => s + t.piezas, 0),
    },
    dias_en_venta: diasEnVenta.map(({ categoria, dias_promedio, n }) => ({ categoria, dias_promedio, n })),
  };
}

// --- Gastos

async function gastos(env: Env, cal: Calendario) {
  const [{ porCategoria, total, grupos }, filasDia] = await Promise.all([gastosDelMes(env, cal), ventasPorDia(env, cal.primero, cal)]);
  const ventasTotal = resumenDeVentas(filasDia.results, cal).delMes.total;
  // Dentro de «otros»: cada categoria con su importe (la nomina es un solo total y nunca se desglosa).
  const otrosDetalle = [...porCategoria]
    .filter(([categoria, importe]) => !['nomina', 'renta', 'publicidad'].includes(categoria) && importe !== 0)
    .map(([categoria, importe]) => ({ categoria, importe }))
    .sort((a, b) => b.importe - a.importe || a.categoria.localeCompare(b.categoria));
  return {
    ...cabecera('gastos', cal),
    ventas_total: ventasTotal,
    gastos: { total, nomina: grupos.nomina, renta: grupos.renta, publicidad: grupos.publicidad, otros: grupos.otros, otros_detalle: otrosDetalle },
    publicidad: { gasto: grupos.publicidad, ventas_por_peso: grupos.publicidad > 0 ? Math.round(ventasTotal / grupos.publicidad) : null },
  };
}

// --- Clientes

async function clientes(env: Env, cal: Calendario) {
  const [filasDia, socios, nuevos, dolarones, referidos] = await Promise.all([
    ventasPorDia(env, cal.primero, cal),
    env.DB.prepare(
      `select (select count(*) from clientes) as socios,
         (select count(*) from (select cliente_id from ventas where cliente_id is not null and cancelada = 0
            group by cliente_id having count(*) >= 2)) as regresaron`,
    ).first<{ socios: number; regresaron: number }>(),
    // Altas del mes por dia de la tienda; por semana se suman abajo y las de menos de 5 no se muestran.
    env.DB.prepare(
      `select substr(datetime(creado_en, '-6 hours'), 1, 10) as dia, count(*) as n from clientes
       where creado_en >= ? and creado_en < ? group by dia`,
    ).bind(apertura(cal.primero), apertura(cal.siguiente)).all<{ dia: string; n: number }>(),
    sociosConDolarones(env, apertura(cal.primero), apertura(cal.siguiente), false),
    env.DB.prepare(
      `select (select count(*) from referidos) as total,
         (select count(*) from referidos where estado = 'liberado') as liberados,
         (select coalesce(sum(importe), 0) from dolarones_movimientos where tipo in ('alta_referido', 'referido', 'referido_nuevo')) as regalados,
         (select coalesce(sum(importe), 0) from dolarones_movimientos where tipo = 'reverso_referido') as revertidos`,
    ).first<{ total: number; liberados: number; regalados: number; revertidos: number }>(),
  ]);
  const { ventas: resumen } = resumenDeVentas(filasDia.results, cal);
  const totalSocios = socios?.socios ?? 0;
  const visibles = totalSocios >= 5;
  const semanasNuevos = resumen.semanas.map((w) => {
    const n = nuevos.results.filter((f) => f.dia >= w.desde && f.dia <= w.hasta).reduce((s, f) => s + f.n, 0);
    return { desde: w.desde, hasta: w.hasta, actual: w.actual, nuevos: personasVisibles(n) };
  });
  // Referidos (revertidos < 0: lo retirado al cancelar la compra que libero el premio): se cuentan personas; si hay menos de 5, o si liberados o pendientes quedarian en menos de 5 (el otro se deduce restando),
  // solo se dice el total cuando llega a 5.
  const r = referidos ?? { total: 0, liberados: 0, regalados: 0, revertidos: 0 };
  const referidosVisibles = r.total >= 5;
  const pendientes = r.total - r.liberados;
  const desglose = referidosVisibles && r.liberados >= 5 && pendientes >= 5;
  return {
    ...cabecera('clientes', cal),
    compras: { tickets: resumen.tickets, ticket_promedio: resumen.ticket_promedio },
    socios: {
      total: personasVisibles(totalSocios),
      nuevos_por_semana: visibles ? semanasNuevos : null,
      regresaron_pct: visibles ? Math.round((socios?.regresaron ?? 0) * 100 / totalSocios) : null,
      regresaron: visibles ? personasVisibles(socios?.regresaron ?? 0) : null,
    },
    dolarones_pagados: personasVisibles(dolarones?.n ?? 0) === null ? null : dolarones!.importe,
    referidos: referidosVisibles ? {
      total: r.total,
      liberados: desglose ? r.liberados : null,
      pendientes: desglose ? pendientes : null,
      dolarones_regalados: r.regalados + r.revertidos,
      reglas: { alta: D_ALTA, premio: D_PREMIO, minimo_compra: MINIMO_COMPRA, maximo_por_socio: MAXIMO_REFERIDOS },
    } : null,
  };
}

// --- Pedidos por WhatsApp

// Cuenta de revendedora (mismo criterio que el canal): solo se usa para decidir si sus pedidos van con WhatsApp.
const ES_REVENDEDORA = `(u.correo is not null)`;
const UNE_REVENDEDORA = `left join usuarios u on u.correo = p.vendedora and (',' || u.roles || ',') like '%,revendedora,%'`;
// Valor de un pedido: sus piezas al precio pactado mas el envio (como `faltante` en pedidos.ts).
const TOTAL_PEDIDO = `(coalesce((select sum(l.precio * l.cantidad) from pedido_lineas l where l.pedido_id = p.id), 0) + p.envio)`;

async function whatsapp(env: Env, cal: Calendario) {
  const [canales, delMes, abiertos] = await Promise.all([
    canalesDelMes(env, cal),
    // Los pedidos que se apartaron este mes, por como van hoy y como se entregan.
    env.DB.prepare(
      `select p.estado, p.entrega, ${ES_REVENDEDORA} as es_rev, count(*) as n,
         coalesce(sum(case when p.estado = 'vendido' and p.entrega = 'envio' and p.guia = '' then 1 else 0 end), 0) as sin_guia
       from pedidos p ${UNE_REVENDEDORA} where p.creado_en >= ? and p.creado_en < ?
       group by p.estado, p.entrega, es_rev`,
    ).bind(apertura(cal.primero), apertura(cal.siguiente))
      .all<{ estado: string; entrega: string; es_rev: number; n: number; sin_guia: number }>(),
    // Apartados abiertos HOY (de cualquier mes): valor, lo ya pagado y lo que falta, por pedido sin pasar de cero.
    env.DB.prepare(
      `select es_rev, count(*) as n, coalesce(sum(total), 0) as total, coalesce(sum(saldo), 0) as pagado,
         coalesce(sum(max(0, total - saldo)), 0) as falta
       from (select ${ES_REVENDEDORA} as es_rev, ${TOTAL_PEDIDO} as total, p.saldo from pedidos p ${UNE_REVENDEDORA} where p.estado = 'apartado')
       group by es_rev`,
    ).all<{ es_rev: number; n: number; total: number; pagado: number; falta: number }>(),
  ]);
  const canal = repartirCanales(canales.results, 'mes');
  const conRevendedoras = canal.whatsapp.incluye_revendedoras;
  const suyos = <T extends { es_rev: number }>(f: T) => f.es_rev === 0 || conRevendedoras;
  const pedidos = delMes.results.filter(suyos);
  const cuenta = (estado: string) => pedidos.filter((f) => f.estado === estado).reduce((s, f) => s + f.n, 0);
  const aparte = abiertos.results.filter(suyos);
  const suma = (campo: 'n' | 'total' | 'pagado' | 'falta') => aparte.reduce((s, f) => s + f[campo], 0);
  const entrega = (clave: string) => pedidos.filter((f) => f.entrega === clave).reduce((s, f) => s + f.n, 0);
  return {
    ...cabecera('whatsapp', cal),
    canal: {
      total: canal.whatsapp.total, tickets: canal.whatsapp.tickets,
      ticket_promedio: canal.whatsapp.tickets ? Math.round(canal.whatsapp.total / canal.whatsapp.tickets) : 0,
      incluye_revendedoras: conRevendedoras,
    },
    pedidos_mes: { total: pedidos.reduce((s, f) => s + f.n, 0), cerrados: cuenta('vendido'), abiertos: cuenta('apartado'), vencidos: cuenta('vencido'), cancelados: cuenta('cancelado') },
    apartados: { abiertos: suma('n'), valor: suma('total'), pagado: suma('pagado'), falta: suma('falta') },
    entrega: { tienda: entrega('tienda'), envio: entrega('envio'), envios_pendientes: pedidos.reduce((s, f) => s + f.sin_guia, 0) },
    // Las reglas salen del codigo de pedidos y de la caja: aqui no se repiten.
    reglas: { dias_apartado: DIAS_APARTADO, horas_revendedora: HORAS_REVENDEDORA, anticipo_pct: ANTICIPO_PORCENTAJE, anticipo_envio: ANTICIPO_ENVIO },
  };
}

// --- Revendedoras (solo con 5 o mas con ventas en el mes: antes, su venta es casi el pago de una persona)

async function revendedoras(env: Env, cal: Calendario) {
  const canales = await canalesDelMes(env, cal);
  const rev = canales.results.find((f) => f.canal === 'revendedoras');
  // Sin datos y sin cifras: ni siquiera cuantas hay.
  if (personasVisibles(rev?.personas ?? 0) === null) return { ...cabecera('revendedoras', cal), disponible: false };
  const [comision, categorias, apartados] = await Promise.all([
    comisionDelMes(env, cal),
    // Que se vende (solo categorias; el envio no es una categoria).
    env.DB.prepare(
      `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
       select case when p.sin_inventario = 1 then 'bandas' else coalesce(nullif(p.categoria, ''), 'sin categoria') end as categoria,
         coalesce(sum(n.neta), 0) as total
       from netas n join ventas v on v.id = n.venta join pedidos pe on pe.id = v.pedido_id
         join usuarios u on u.correo = pe.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
         left join productos p on p.id = n.producto_id
       where n.propietario = 'dolaron' and n.codigo != 'ENVIO' group by categoria order by total desc, categoria`,
    ).bind(apertura(cal.primero), apertura(cal.siguiente)).all<{ categoria: string; total: number }>(),
    env.DB.prepare(
      `select count(*) as n, coalesce(sum(total), 0) as total
       from (select ${TOTAL_PEDIDO} as total from pedidos p ${UNE_REVENDEDORA} where p.estado = 'apartado' and ${ES_REVENDEDORA})`,
    ).first<{ n: number; total: number }>(),
  ]);
  return {
    ...cabecera('revendedoras', cal),
    disponible: true,
    personas: rev!.personas,
    pedidos: rev!.tickets,
    total: rev!.total,
    ticket_promedio: rev!.tickets ? Math.round(rev!.total / rev!.tickets) : 0,
    comision,
    comision_pct: Math.round(COMISION * 100),
    categorias: categorias.results,
    apartados_abiertos: { n: apartados?.n ?? 0, valor: apartados?.total ?? 0 },
  };
}

// --- Mercado Libre (estimado: no se guarda el precio real, la comision ni el envio de cada orden)

async function mercadolibre(env: Env, cal: Calendario) {
  const desde = apertura(cal.primero);
  const hasta = apertura(cal.siguiente);
  const [ml, publicadas, categorias, atender, dias] = await Promise.all([
    mercadoLibre(env, cal.primero, cal),
    env.DB.prepare(
      `select coalesce(sum(case when m.ml_item_id is not null then 1 else 0 end), 0) as publicadas,
         coalesce(sum(case when m.estado = 'activa' then 1 else 0 end), 0) as activas,
         (select count(distinct v.producto_id) from ml_ventas v where v.estado != 'cancelada') as con_venta
       from ml_publicaciones m join productos p on p.id = m.producto_id where p.propietario = 'dolaron'`,
    ).first<{ publicadas: number; activas: number; con_venta: number }>(),
    env.DB.prepare(
      `select coalesce(nullif(p.categoria, ''), 'sin categoria') as categoria, coalesce(sum(m.cantidad), 0) as piezas,
         coalesce(sum(m.cantidad * coalesce(pub.precio_ml, 0)), 0) as total
       from ml_ventas m join productos p on p.id = m.producto_id left join ml_publicaciones pub on pub.producto_id = m.producto_id
       where m.estado != 'cancelada' and p.propietario = 'dolaron' and m.recibido_en >= ? and m.recibido_en < ?
       group by categoria order by total desc, categoria`,
    ).bind(desde, hasta).all<{ categoria: string; piezas: number; total: number }>(),
    env.DB.prepare(
      `select coalesce(sum(case when atendida_en = '' and estado != 'cancelada' then 1 else 0 end), 0) as por_atender,
         coalesce(sum(case when estado = 'cancelada' and recibido_en >= ? and recibido_en < ? then 1 else 0 end), 0) as canceladas
       from ml_ventas`,
    ).bind(desde, hasta).first<{ por_atender: number; canceladas: number }>(),
    // Del dia que se publico la pieza al dia de la orden (solo las que guardan la fecha de publicacion).
    env.DB.prepare(
      `select count(*) as n, avg(julianday(substr(m.recibido_en, 1, 10)) - julianday(substr(pub.publicado_en, 1, 10))) as promedio
       from ml_ventas m join ml_publicaciones pub on pub.producto_id = m.producto_id
       where m.estado != 'cancelada' and pub.publicado_en != '' and julianday(pub.publicado_en) is not null`,
    ).first<{ n: number; promedio: number | null }>(),
  ]);
  return {
    ...cabecera('mercadolibre', cal),
    estimado: true,
    vendido: { total: ml?.total ?? 0, piezas: ml?.piezas ?? 0 },
    publicaciones: { publicadas: publicadas?.publicadas ?? 0, activas: publicadas?.activas ?? 0, con_venta: publicadas?.con_venta ?? 0 },
    por_categoria: categorias.results,
    por_atender: atender?.por_atender ?? 0,
    canceladas: atender?.canceladas ?? 0,
    dias_en_venderse: (dias?.n ?? 0) >= 3 && dias?.promedio != null ? Math.max(0, dias.promedio) : null,
  };
}

export const DETALLES: Record<string, Vista> = { ventas, tienda, mercancia, gastos, clientes, whatsapp, revendedoras, mercadolibre };
