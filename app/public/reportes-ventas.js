// Vista «Ventas» de /reportes (Issue #802): de /api/reportes/resumen y /api/reportes/ventas al HTML y las graficas.
// Funciones puras (sin DOM): las usa el servidor (src/reportes-ventas.ts, `armarVentas`) y la pagina, y se prueban en
// src/reportes-ventas.test.ts. Todo el dinero va en centavos enteros; los dias son dias de la tienda (UTC-6).
import { escapar, pesos, pesosEje, tabla, columnas, leyendaSeries, sumarDias } from './graficas.js';
import {
  cubetas as listaCubetas, cambioKpi, tarjetasKpi, etiquetaCubeta, tituloCubeta,
} from './reportes-resumen.js';

const num = (n) => Number(n).toLocaleString('es-MX');
const un = (v) => v.toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const cuenta = (n, uno, varios) => `${num(n)} ${n === 1 ? uno : varios}`;
const entre = (dia, desde, hasta) => dia >= desde && dia <= hasta;

/* ---------- constantes de lo que se mide ---------- */

/** Un ticket gana Dolarones por cada bloque completo de $100 (venta.js `dolaronesGanados`): por debajo de $100 no gana ninguno. */
export const UMBRAL_DOLARONES = 10_000;
/** Limites superiores (exclusivos) de los tramos del importe de un ticket, en centavos; el ultimo tramo es «mas de ...». El primero es el umbral. */
export const LIMITES_MONTO = [UMBRAL_DOLARONES, 20_000, 30_000, 50_000, 80_000, 120_000];
/** Piezas por ticket: 1, 2, 3, 4, 5 y 6 o mas. */
export const MAX_PIEZAS = 6;
/** Categorias que se dibujan por separado; el resto va junto en «Otras». */
export const MAX_CATEGORIAS = 6;
/** Mas columnas que estas no se leen (ni se recorren con Tab): se pide una agrupacion mayor y queda la tabla. */
export const MAX_COLUMNAS = 120;

export const CANALES = [['tienda', 'Tienda', 'var(--serie-1)'], ['whatsapp', 'WhatsApp', 'var(--serie-2)'], ['revendedoras', 'Revendedoras', 'var(--serie-3)']];
export const FORMAS = [['efectivo', 'Efectivo', 'var(--serie-1)'], ['tarjeta', 'Tarjeta', 'var(--serie-2)'],
  ['transferencia', 'Transferencia', 'var(--serie-3)'], ['dolarones', 'Dolarones', 'var(--serie-4)'], ['otra', 'Otra forma', 'var(--tinta-2)']];
const COLORES_CATEGORIA = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)', 'var(--d-5)', 'var(--d-6)'];
const COLOR_OTRAS = 'var(--d-gris)';

/** El SQL del tramo de un importe `neto` (centavos): el indice del primer limite que no alcanza. */
export const sqlTramoMonto = (columna) => `case ${LIMITES_MONTO.map((l, i) => `when ${columna} < ${l} then ${i}`).join(' ')} else ${LIMITES_MONTO.length} end`;
export const sqlTramoPiezas = (columna) => `case when ${columna} <= 1 then 1 when ${columna} >= ${MAX_PIEZAS} then ${MAX_PIEZAS} else ${columna} end`;

/* ---------- el servidor: de las filas de D1 a la respuesta ---------- */

/**
 * Arma la respuesta de /api/reportes/ventas. Todo va alineado con las cubetas del periodo (las mismas de /api/reportes/resumen: misma
 * funcion, mismo periodo y grano). Filas de entrada:
 *  - `filasMezcla`: { dia, canal, categoria, ventas, piezas } por dia; trae el periodo y, si hay, la comparacion (para sus dias con venta);
 *  - `filasPago`: { dia, forma_pago, total };  `filasDescuento`: { dia, promo_tickets, promo, otros_tickets, otros };
 *  - `filasTickets`: { k, b, n, total } de tramos de importe ('monto'), de piezas ('piezas') y de la mediana ('mediana': b = lugar, n = importe, total = tickets).
 * Nada se descarta: las categorias que no entran al top se suman en «otras», asi cada serie apilada suma lo vendido de la cubeta.
 */
export function armarVentas({ desde, hasta, grano, ventana, filasMezcla, filasPago, filasDescuento, filasTickets }) {
  const cubetas = listaCubetas(desde, hasta, grano);
  const n = cubetas.length;
  const indice = new Map();
  cubetas.forEach((c, i) => { for (let k = 0; k < c.dias; k++) indice.set(sumarDias(c.desde, k), i); });
  const ceros = () => new Array(n).fill(0);

  // La mezcla: categoria y canal por cubeta, los dias con venta del periodo y de la comparacion.
  const ventas = ceros(), conVenta = ceros();
  const diasPeriodo = new Set(), diasAntes = new Set();
  const porCategoria = new Map();
  const porCanal = new Map(CANALES.map(([clave]) => [clave, ceros()]));
  for (const f of filasMezcla) {
    if (ventana && entre(f.dia, ventana.desde, ventana.hasta)) diasAntes.add(f.dia);
    const i = indice.get(f.dia);
    if (i === undefined) continue;
    if (!diasPeriodo.has(f.dia)) { diasPeriodo.add(f.dia); conVenta[i] += 1; }
    ventas[i] += f.ventas;
    if (!porCategoria.has(f.categoria)) porCategoria.set(f.categoria, { categoria: f.categoria, total: 0, piezas: 0, valores: ceros() });
    const c = porCategoria.get(f.categoria);
    c.valores[i] += f.ventas; c.total += f.ventas; c.piezas += f.piezas;
    (porCanal.get(f.canal) ?? porCanal.set(f.canal, ceros()).get(f.canal))[i] += f.ventas;
  }
  const ordenadas = [...porCategoria.values()].sort((a, b) => b.total - a.total || a.categoria.localeCompare(b.categoria));
  const top = ordenadas.slice(0, MAX_CATEGORIAS);
  const resto = ordenadas.slice(top.length);
  const categorias = [...top];
  if (resto.length) {
    categorias.push({ categoria: 'otras', otras: resto.length, total: resto.reduce((s, c) => s + c.total, 0), piezas: resto.reduce((s, c) => s + c.piezas, 0),
      valores: ceros().map((_, i) => resto.reduce((s, c) => s + c.valores[i], 0)) });
  }
  const canales = [...porCanal].map(([clave, valores]) => ({ clave, total: valores.reduce((s, v) => s + v, 0), valores }));

  // Las formas de pago: lo cobrado, no lo vendido (el anticipo entra el dia que se aparto).
  const porForma = new Map(FORMAS.map(([clave]) => [clave, ceros()]));
  for (const f of filasPago) {
    const i = indice.get(f.dia);
    if (i === undefined) continue;
    porForma.get(porForma.has(f.forma_pago) ? f.forma_pago : 'otra')[i] += f.total;
  }
  const pago = [...porForma].map(([clave, valores]) => ({ clave, total: valores.reduce((s, v) => s + v, 0), valores }));

  // Los descuentos: lo aprobado por el dueno (`otros`) aparte de la promo de la tienda.
  const descuentos = ceros().map(() => ({ promo: 0, otros: 0, promo_tickets: 0, otros_tickets: 0 }));
  for (const f of filasDescuento) {
    const i = indice.get(f.dia);
    if (i === undefined) continue;
    const d = descuentos[i];
    d.promo += f.promo; d.otros += f.otros; d.promo_tickets += f.promo_tickets; d.otros_tickets += f.otros_tickets;
  }
  const sumaD = (campo) => descuentos.reduce((s, d) => s + d[campo], 0);

  // Los tickets: tramos de importe y de piezas; la mediana viene de los 1 o 2 tickets del centro.
  const monto = Array.from({ length: LIMITES_MONTO.length + 1 }, () => ({ n: 0, total: 0 }));
  const piezas = Array.from({ length: MAX_PIEZAS }, () => ({ n: 0, total: 0 }));
  const centro = [];
  for (const f of filasTickets) {
    if (f.k === 'monto') { monto[f.b].n += f.n; monto[f.b].total += f.total; }
    else if (f.k === 'piezas') { piezas[f.b - 1].n += f.n; piezas[f.b - 1].total += f.total; }
    else if (f.k === 'mediana') centro.push(f.n);
  }
  const tickets = monto.reduce((s, t) => s + t.n, 0);
  const mediana = centro.length === 0 ? null : Math.round(centro.reduce((s, v) => s + v, 0) / centro.length);

  return {
    cubetas: cubetas.map((c, i) => ({ ...c, ventas: ventas[i], dias_con_venta: conVenta[i] })),
    dias_con_venta: { periodo: diasPeriodo.size, anterior: ventana ? diasAntes.size : null },
    categorias, canales, pago,
    descuentos: { promo: sumaD('promo'), otros: sumaD('otros'), promo_tickets: sumaD('promo_tickets'), otros_tickets: sumaD('otros_tickets'), valores: descuentos },
    tickets: { total: tickets, mediana, umbral: UMBRAL_DOLARONES, bajo_umbral: monto[0].n, monto, piezas },
  };
}

/* ---------- las tarjetas ---------- */

/**
 * Las 8 tarjetas de la vista, con el mismo marcado y las mismas reglas de color que las de Resumen. `d` es /api/reportes/resumen y `v`
 * /api/reportes/ventas del mismo periodo. Las que ya existen en Resumen (ventas, tickets, ticket promedio, piezas por ticket y
 * descuento) salen de la misma funcion; solo se agregan las que Resumen no tiene.
 */
export function tarjetasVentas(d, v) {
  const por = Object.fromEntries(tarjetasKpi(d, null).map((k) => [k.clave, k]));
  const t = d.totales, a = d.anterior, sc = d.cubetas;
  const hayComp = !!(a && a.tickets > 0);
  const comunes = { vs: por.ventas.vs, hayComp, comparando: !!d.comparacion };
  const bruto = (x) => x.ventas + x.descuento;
  const dias = v.dias_con_venta;
  const porDia = (ventas, n) => (n > 0 ? Math.round(ventas / n) : null);
  const promedio = porDia(t.ventas, dias.periodo);
  const previo = hayComp && dias.anterior != null ? porDia(a.ventas, dias.anterior) : null;
  return [
    { ...por.ventas, avance: null, pie: `${pesos(Math.round(t.ventas / d.periodo.dias))} por día del periodo` },
    { ...comunes, clave: 'bruto', etiqueta: 'Bruto', valor: pesos(bruto(t)), cambio: hayComp ? cambioKpi(bruto(t), bruto(a)) : null,
      serie: sc.map(bruto), clase: 's1', pie: 'Ventas netas más lo descontado y la promoción' },
    { ...comunes, clave: 'piezas_total', etiqueta: 'Piezas vendidas', valor: num(t.piezas), cambio: hayComp ? cambioKpi(t.piezas, a.piezas) : null,
      serie: sc.map((c) => c.piezas), clase: 's1', pie: null },
    por.tickets, por.ticket, por.piezas,
    { ...comunes, clave: 'dia_promedio', etiqueta: 'Venta por día con venta', valor: promedio == null ? '—' : pesos(promedio),
      cambio: hayComp && promedio != null && previo != null ? cambioKpi(promedio, previo) : null,
      serie: v.cubetas.map((c) => porDia(c.ventas, c.dias_con_venta)), clase: 's1',
      pie: `${cuenta(dias.periodo, 'día', 'días')} con ventas de ${d.periodo.dias}` },
    por.descuento,
  ];
}

/* ---------- series en el tiempo: datos de las graficas y sus tablas ---------- */

const categoriasDeEje = (d, v) => v.cubetas.map((c) => ({ etiqueta: etiquetaCubeta(c, d.grano, v.cubetas.length), titulo: tituloCubeta(c, d.grano) }));

export function datosCategorias(v, nombreCategoria = (c) => c) {
  return v.categorias.map((c, i) => ({
    nombre: c.otras ? `Otras (${c.otras})` : nombreCategoria(c.categoria),
    color: c.otras ? COLOR_OTRAS : COLORES_CATEGORIA[i % COLORES_CATEGORIA.length], valores: c.valores, total: c.total,
  })).filter((s) => s.total !== 0);
}
export const datosCanales = (v) => v.canales.map((c) => ({ ...c, nombre: CANALES.find(([k]) => k === c.clave)?.[1] ?? c.clave,
  color: CANALES.find(([k]) => k === c.clave)?.[2] ?? 'var(--tinta-2)' }));
export const datosPago = (v) => v.pago.map((p) => ({ ...p, nombre: FORMAS.find(([k]) => k === p.clave)[1], color: FORMAS.find(([k]) => k === p.clave)[2] }));

/** Una fila de cada cubeta repartida en milesimos (enteros que suman 1000 si hay algo): sin decimales flotantes, la barra cierra en 100 %. */
export function milesimos(valores) {
  const buenos = valores.map((x) => Math.max(0, x));
  const total = buenos.reduce((s, x) => s + x, 0);
  if (total <= 0) return buenos.map(() => 0);
  const base = buenos.map((x) => Math.floor((x * 1000) / total));
  let faltan = 1000 - base.reduce((s, x) => s + x, 0);
  const orden = buenos.map((x, i) => [((x * 1000) % total) / total, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of orden) { if (faltan-- <= 0) break; base[i] += 1; }
  return base;
}

const pctMil = (m) => `${un(m / 10)} %`;

/** La mezcla por cubeta como tabla: una fila por periodo, una columna por serie y el total. `fmt` escribe cada importe. */
function tablaApilada(ejes, series, { fmt = pesos, totales = true } = {}) {
  const enc = ['Periodo', ...series.map((s) => s.nombre), ...(totales ? ['Total'] : [])];
  const filas = ejes.map((e, i) => [e.titulo, ...series.map((s) => fmt(s.valores[i])), ...(totales ? [fmt(series.reduce((x, s) => x + s.valores[i], 0))] : [])]);
  return tabla(enc, filas, enc.map((_, i) => i).slice(1));
}

export const tablaCategorias = (d, v, nombreCategoria) => tablaApilada(categoriasDeEje(d, v), datosCategorias(v, nombreCategoria));
export const tablaCanales = (d, v) => tablaApilada(categoriasDeEje(d, v), datosCanales(v));
export function tablaPago(d, v) {
  const ejes = categoriasDeEje(d, v), series = datosPago(v).filter((s) => s.total !== 0);
  const enc = ['Periodo', ...series.flatMap((s) => [s.nombre, '%']), 'Total'];
  const filas = ejes.map((e, i) => {
    const m = milesimos(series.map((s) => s.valores[i]));
    return [e.titulo, ...series.flatMap((s, j) => [pesos(s.valores[i]), m.some(Boolean) ? pctMil(m[j]) : '—']), pesos(series.reduce((x, s) => x + s.valores[i], 0))];
  });
  return tabla(enc, filas, enc.map((_, i) => i).slice(1));
}
export function tablaDescuentos(d, v) {
  const ejes = categoriasDeEje(d, v);
  return tabla(['Periodo', 'Tickets con promo', 'Promoción', 'Tickets con descuento aprobado', 'Descuentos aprobados', 'Total'],
    ejes.map((e, i) => { const x = v.descuentos.valores[i]; return [e.titulo, num(x.promo_tickets), pesos(x.promo), num(x.otros_tickets), pesos(x.otros), pesos(x.promo + x.otros)]; }), [1, 2, 3, 4, 5]);
}

/* ---------- tickets ---------- */

const pesos0 = (c) => `$${num(Math.round(c / 100))}`;
/** «$0–100», «$100–200» ... «$1,200 o más»: los limites del servidor, escritos. */
export const nombresMonto = () => LIMITES_MONTO.map((l, i) => (i === 0 ? `Menos de ${pesos0(l)}` : `${pesos0(LIMITES_MONTO[i - 1])}–${pesos0(l)}`))
  .concat([`${pesos0(LIMITES_MONTO.at(-1))} o más`]);
const etiquetasMonto = () => LIMITES_MONTO.map((l, i) => (i === 0 ? `<${num(l / 100)}` : `${num(LIMITES_MONTO[i - 1] / 100)}–${num(l / 100)}`)).concat([`${num(LIMITES_MONTO.at(-1) / 100)}+`]);
export const nombresPiezas = () => Array.from({ length: MAX_PIEZAS }, (_, i) => (i + 1 === MAX_PIEZAS ? `${MAX_PIEZAS} o más` : i === 0 ? '1 pieza' : `${i + 1} piezas`));

const porcentaje = (parte, todo) => (todo > 0 ? `${un((parte * 100) / todo)} %` : '—');

export function textoTickets(v) {
  const t = v.tickets;
  if (t.total === 0) return '';
  return `La mitad de los tickets es de ${pesos(t.mediana)} o menos (mediana). ${porcentaje(t.bajo_umbral, t.total)} de los tickets (${num(t.bajo_umbral)} de ${num(t.total)}) queda por debajo de ${pesos0(t.umbral)}, el mínimo para ganar Dolarones.`;
}

export function tablaTickets(v) {
  const t = v.tickets;
  const monto = tabla(['Importe del ticket', 'Tickets', '% de los tickets', 'Ventas netas'],
    nombresMonto().map((nombre, i) => [nombre, num(t.monto[i].n), porcentaje(t.monto[i].n, t.total), pesos(t.monto[i].total)]), [1, 2, 3]);
  const piezas = tabla(['Piezas del ticket', 'Tickets', '% de los tickets', 'Ventas netas'],
    nombresPiezas().map((nombre, i) => [nombre, num(t.piezas[i].n), porcentaje(t.piezas[i].n, t.total), pesos(t.piezas[i].total)]), [1, 2, 3]);
  return `${monto}<div style="height:12px"></div>${piezas}`;
}

/* ---------- las graficas: { id: html } para el ancho que tenga cada hueco ---------- */

const vacio = (texto) => `<div class="vacio">${escapar(texto)}</div>`;
const demasiadas = (n) => `<div class="vacio">Con ${num(n)} columnas la gráfica no se lee: elige «Semana» o «Mes» arriba. La tabla tiene todo.</div>`;

export function graficas(d, v, anchoDe, nombreCategoria = (c) => c) {
  const ancho = (id) => Math.max(220, Math.floor(anchoDe(id)));
  const ejes = categoriasDeEje(d, v), n = ejes.length;
  const apilar = (id, series, sinDatos, extra = {}) => {
    if (series.length === 0 || series.every((s) => s.valores.every((x) => x === 0))) return vacio(sinDatos);
    if (n > MAX_COLUMNAS) return demasiadas(n);
    return `${leyendaSeries(series)}${columnas({ categorias: ejes, series, ancho: ancho(id), modo: 'apiladas', fmtEje: pesosEje, fmtValor: pesos, ...extra })}`;
  };
  const cat = datosCategorias(v, nombreCategoria);
  const canales = datosCanales(v).filter((c) => c.total !== 0);
  const pagos = datosPago(v).filter((p) => p.total !== 0);
  const d1 = v.descuentos.valores;
  const t = v.tickets;
  const histograma = (id, categoriasX, valores, nombre) => (t.total === 0 ? vacio('Sin tickets en este periodo.')
    : columnas({ categorias: categoriasX, series: [{ nombre, color: 'var(--serie-1)', valores }], ancho: ancho(id), alto: 210, entero: true, fmtValor: num }));
  return {
    categorias: apilar('categorias', cat, 'Sin ventas en este periodo.'),
    canales: apilar('canales', canales, 'Sin ventas en este periodo.'),
    pago: (() => {
      if (pagos.length === 0) return vacio('Sin cobros en este periodo.');
      if (n > MAX_COLUMNAS) return demasiadas(n);
      const mil = ejes.map((_, i) => milesimos(pagos.map((p) => p.valores[i])));
      const series = pagos.map((p, j) => ({ nombre: p.nombre, color: p.color, valores: mil.map((m) => m[j]) }));
      return `${leyendaSeries(series)}${columnas({ categorias: ejes, series, ancho: ancho('pago'), modo: 'apiladas', entero: true, fmtEje: (x) => `${x / 10} %`, fmtValor: pctMil })}`;
    })(),
    descuentos: apilar('descuentos', [
      { nombre: 'Descuentos aprobados', color: 'var(--serie-1)', valores: d1.map((x) => x.otros) },
      { nombre: 'Promoción', color: 'var(--serie-2)', valores: d1.map((x) => x.promo) },
    ], 'Sin descuentos ni promociones en este periodo.', { alto: 210 }),
    tickets_monto: histograma('tickets_monto', etiquetasMonto().map((e, i) => ({ etiqueta: e, titulo: nombresMonto()[i] })), t.monto.map((x) => x.n), 'Tickets'),
    tickets_piezas: histograma('tickets_piezas', nombresPiezas().map((e, i) => ({ etiqueta: i + 1 === MAX_PIEZAS ? `${MAX_PIEZAS}+` : String(i + 1), titulo: e })), t.piezas.map((x) => x.n), 'Tickets'),
  };
}

/* ---------- textos que dicen lo que no hay ---------- */

/** Los canales sin ventas: se dicen, no se dibujan como una leyenda vacia. */
export function notaCanales(v) {
  const sin = datosCanales(v).filter((c) => c.total === 0).map((c) => c.nombre);
  const hay = datosCanales(v).some((c) => c.total !== 0);
  if (!hay) return '';
  return `${sin.length ? `Sin ventas por ${sin.length === 1 ? sin[0] : `${sin.slice(0, -1).join(', ')} ni ${sin.at(-1)}`} en este periodo. ` : ''}Mercado Libre va aparte y no suma a las ventas netas: está en Resumen.`;
}

export function notaCategorias(v) {
  const otras = v.categorias.find((c) => c.otras);
  return `Las ${MAX_CATEGORIAS} categorías que más vendieron en el periodo${otras ? `; las otras ${num(otras.otras)} van juntas en «Otras»` : ''}. Las bandas de ropa van juntas, como en «Por categoría».`;
}
