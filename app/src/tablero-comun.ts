// Piezas compartidas por el resumen (tablero.ts) y las vistas de detalle (tablero-detalle.ts) de /tablero (Issue #610).
// Mismas reglas de privacidad en las dos: SOLO agregados, y un grupo de menos de MIN_PERSONAS personas no se cuenta.
import { lineasNetas } from './netas.ts';
import { GASTOS_DEL_MES } from './gastos.ts';
import { hoyTienda } from './reportes.ts';
import { sumarDias } from '../public/graficas.js';
import { gananciaDe } from '../public/vender.js';

export const MIN_PERSONAS = 5;
export const MIN_VENTAS_COMPARACION = 10;   // con menos tickets en la semana anterior no se muestra porcentaje

export const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Las ventas se guardan en UTC; el dia de la tienda (00:00 a 24:00, UTC-6) abre a las 06:00Z. Se filtra con la columna tal cual (indice).
export const apertura = (dia: string) => `${dia}T06:00:00.000Z`;
export const lunesDe = (dia: string) => sumarDias(dia, -((new Date(`${dia}T00:00:00Z`).getUTCDay() + 6) % 7));
export const entre = (dia: string, desde: string, hasta: string) => dia >= desde && dia <= hasta;
export const personasVisibles = (n: number) => (n >= MIN_PERSONAS ? n : null);

/** El mes de la tienda y su semana en curso (lunes a hoy) contra la anterior al mismo punto: mismo numero de dias. */
export function calendario(ahora = Date.now()) {
  const hoy = hoyTienda(ahora);
  const mes = hoy.slice(0, 7);
  const primero = `${mes}-01`;
  const [anio, numMes] = mes.split('-').map(Number);
  const siguiente = new Date(Date.UTC(anio, numMes, 1)).toISOString().slice(0, 10);
  const lunes = lunesDe(hoy);
  const dias = Math.round((Date.parse(hoy) - Date.parse(lunes)) / 86_400_000) + 1;
  const lunesAnterior = sumarDias(lunes, -7);
  return {
    ahora, hoy, mes, primero, siguiente, lunes, lunesAnterior, dias,
    diasMes: new Date(Date.UTC(anio, numMes, 0)).getUTCDate(),
    transcurridos: Number(hoy.slice(8)),
    finAnterior: sumarDias(lunesAnterior, dias - 1),
  };
}
export type Calendario = ReturnType<typeof calendario>;

/** Tickets y ventas netas de El Dolaron por dia de la tienda, de `desdeDia` al fin del mes. */
export const ventasPorDia = (env: Env, desdeDia: string, cal: Calendario) => env.DB.prepare(
  `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
   select substr(datetime(creado_en, '-6 hours'), 1, 10) as dia, count(distinct venta) as tickets, coalesce(sum(neta), 0) as total
   from netas where propietario = 'dolaron' group by dia`,
).bind(apertura(desdeDia), apertura(cal.siguiente)).all<{ dia: string; tickets: number; total: number }>();

/** Mes, semanas del mes y comparacion de la semana en curso, a partir de las filas de `ventasPorDia`. */
export function resumenDeVentas(filas: { dia: string; tickets: number; total: number }[], cal: Calendario) {
  const suma = (desde: string, hasta: string) => filas
    .filter((f) => entre(f.dia, desde, hasta))
    .reduce((s, f) => ({ total: s.total + f.total, tickets: s.tickets + f.tickets }), { total: 0, tickets: 0 });
  const delMes = suma(cal.primero, sumarDias(cal.siguiente, -1));
  const semanas: { desde: string; hasta: string; total: number; tickets: number; actual: boolean }[] = [];
  for (let inicio = lunesDe(cal.primero); inicio <= cal.hoy; inicio = sumarDias(inicio, 7)) {
    const fin = sumarDias(inicio, 6);
    const recorte = { desde: inicio < cal.primero ? cal.primero : inicio, hasta: fin > cal.hoy ? cal.hoy : fin };
    semanas.push({ ...recorte, ...suma(recorte.desde, recorte.hasta), actual: inicio === cal.lunes });
  }
  const actual = suma(cal.lunes, cal.hoy);
  const anterior = suma(cal.lunesAnterior, cal.finAnterior);
  return {
    delMes,
    ventas: {
      total: delMes.total, tickets: delMes.tickets,
      ticket_promedio: delMes.tickets ? Math.round(delMes.total / delMes.tickets) : 0,
      semanas,
      semana: { actual, anterior, dias: cal.dias, poca_historia: anterior.tickets < MIN_VENTAS_COMPARACION },
    },
  };
}

/** Desde donde hay que leer para tener el mes completo y la semana en curso (que puede empezar el mes anterior). */
export const desdeMasAntiguo = (cal: Calendario) => (cal.lunes < cal.primero ? cal.lunes : cal.primero);

/** Desde donde se lee para comparar la semana en curso con la anterior: la anterior tambien puede abrir en el mes pasado. */
export const desdeComparacion = (cal: Calendario) => (cal.lunesAnterior < cal.primero ? cal.lunesAnterior : cal.primero);

export type FilaCanal = {
  canal: string; tickets: number; total: number; personas: number;
  tickets_semana: number; total_semana: number; personas_semana: number;
};
/**
 * Ventas netas por canal, del mes y de la semana en curso. Canal: sin pedido = tienda; con pedido de una cuenta
 * revendedora = revendedoras; el resto = WhatsApp. `personas` = revendedoras distintas con venta (solo se cuentan, nunca se nombran).
 */
export const canalesDelMes = (env: Env, cal: Calendario) => env.DB.prepare(
  `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
   select case when v.pedido_id is null then 'tienda' when u.correo is not null then 'revendedoras' else 'whatsapp' end as canal,
     count(distinct case when n.creado_en >= ? then n.venta end) as tickets,
     coalesce(sum(case when n.creado_en >= ? then n.neta end), 0) as total,
     count(distinct case when u.correo is not null and n.creado_en >= ? then p.vendedora end) as personas,
     count(distinct case when n.creado_en >= ? then n.venta end) as tickets_semana,
     coalesce(sum(case when n.creado_en >= ? then n.neta end), 0) as total_semana,
     count(distinct case when u.correo is not null and n.creado_en >= ? then p.vendedora end) as personas_semana
   from netas n join ventas v on v.id = n.venta
     left join pedidos p on p.id = v.pedido_id
     left join usuarios u on u.correo = p.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
   where n.propietario = 'dolaron' group by canal`,
).bind(
  apertura(desdeMasAntiguo(cal)), apertura(cal.siguiente),
  apertura(cal.primero), apertura(cal.primero), apertura(cal.primero),
  apertura(cal.lunes), apertura(cal.lunes), apertura(cal.lunes),
).all<FilaCanal>();

/** Mercado Libre no guarda precio de la orden: estimado con el precio publicado. No entra en `ventas`. */
export const mercadoLibre = (env: Env, desdeDia: string, cal: Calendario) => env.DB.prepare(
  `select coalesce(sum(m.cantidad), 0) as piezas, coalesce(sum(m.cantidad * coalesce(pub.precio_ml, 0)), 0) as total
   from ml_ventas m join productos p on p.id = m.producto_id
     left join ml_publicaciones pub on pub.producto_id = m.producto_id
   where m.estado != 'cancelada' and p.propietario = 'dolaron' and m.recibido_en >= ? and m.recibido_en < ?`,
).bind(apertura(desdeDia), apertura(cal.siguiente)).first<{ piezas: number; total: number }>();

/** Nomina, renta, publicidad y el resto: la nomina es lo pagado en el mes (pagos y adelantos), sin desglose por persona. */
export function agruparGastos(porCategoria: Map<string, number>) {
  const grupos = { nomina: 0, renta: 0, publicidad: 0, otros: 0 };
  for (const [categoria, importe] of porCategoria) {
    if (categoria === 'nomina' || categoria === 'renta' || categoria === 'publicidad') grupos[categoria] += importe;
    else grupos.otros += importe;
  }
  return grupos;
}

/** Gastos del mes por categoria (una sola vez cada gasto de caja) mas la nomina pagada, que es un solo total. */
export async function gastosDelMes(env: Env, cal: Calendario) {
  const [filas, nomina] = await Promise.all([
    env.DB.prepare(`select categoria, sum(importe) as importe from (${GASTOS_DEL_MES}) group by categoria`)
      .bind(cal.primero, cal.siguiente, `${cal.primero}T00:00:00`, `${cal.siguiente}T00:00:00`)
      .all<{ categoria: string; importe: number }>(),
    env.DB.prepare(
      `select coalesce(sum(case tipo when 'adelanto' then importe when 'pago' then -importe else 0 end), 0) as importe
       from nomina_movimientos where fecha >= ? and fecha < ?`,
    ).bind(cal.primero, cal.siguiente).first<{ importe: number }>(),
  ]);
  const porCategoria = new Map(filas.results.map((f) => [f.categoria, f.importe]));
  if (nomina?.importe) porCategoria.set('nomina', (porCategoria.get('nomina') ?? 0) + nomina.importe);
  return { porCategoria, total: [...porCategoria.values()].reduce((s, v) => s + v, 0), grupos: agruparGastos(porCategoria) };
}

/** Comision de las revendedoras en el mes: se redondea por ticket sobre el subtotal sin envio, como en vender.js. Un solo numero, sin nombres. */
export async function comisionDelMes(env: Env, cal: Calendario) {
  const { results } = await env.DB.prepare(
    `select coalesce(sum(l.precio * (l.cantidad - l.cancelada_cantidad)), 0) as subtotal
     from ventas v join pedidos p on p.id = v.pedido_id
       join usuarios u on u.correo = p.vendedora and (',' || u.roles || ',') like '%,revendedora,%'
       left join venta_lineas l on l.venta_id = v.id and l.codigo != 'ENVIO'
     where v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ? group by v.id`,
  ).bind(apertura(cal.primero), apertura(cal.siguiente)).all<{ subtotal: number }>();
  return results.reduce((s, f) => s + gananciaDe({ estado: 'vendido', subtotal: f.subtotal }), 0);
}
