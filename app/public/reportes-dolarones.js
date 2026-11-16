// Vista «Dolarones» de /reportes (Issue #802): del JSON de /api/reportes/dolarones al HTML y las graficas.
// Todo son funciones puras (sin DOM): se prueban en src/reportes-dolarones-js.test.ts. Dinero en centavos, 1 D = 100.
import {
  escapar, dolarones, diaCorto, textoPeriodo, tabla, apilada, barrasHorizontales, pesos,
  columnas, lineaSerie, leyendaSeries,
} from './graficas.js';
import { cambioKpi, tarjetasHtml } from './reportes-resumen.js';

const num = (n) => Number(n).toLocaleString('es-MX');
const pct1 = (x) => `${(x * 100).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
/** Parte entre todo como «12.3 %»; null si no hay todo. */
export const porcentaje = (parte, todo) => (todo > 0 ? pct1(parte / todo) : null);
const enD = (c) => Math.round(c / 100).toLocaleString('es-MX');   // eje: D enteros

export const COLORES_ORIGEN = {
  vale: 'var(--serie-1)', socio: 'var(--serie-2)', promo: 'var(--serie-3)', regalo: 'var(--serie-4)',
  referido: 'var(--d-5)', equipo: 'var(--d-6)', cupon: 'var(--d-gris)', otro: 'var(--tinta-2)',
};
const colorDe = (o) => COLORES_ORIGEN[o] ?? 'var(--tinta-2)';

/* ---------- la banda «El saldo cuadra» ---------- */

/** La identidad de un libro escrita con sus cifras; el traspaso solo aparece si lo hubo. */
export function identidad(c) {
  const traspaso = c.traspaso ? ` ${c.traspaso > 0 ? '+' : '−'} traspaso ${dolarones(Math.abs(c.traspaso))}` : '';
  const otros = c.otros ? ` ${c.otros > 0 ? '+' : '−'} otros movimientos ${dolarones(Math.abs(c.otros))}` : '';
  return `Emitido ${dolarones(c.emitido)}${traspaso} − canjeado ${dolarones(c.canjeado)} − vencido ${dolarones(c.vencido)} − retirado ${dolarones(c.retirado)}${otros} = saldo vivo ${dolarones(c.vivo)}`;
}

const lineaLibro = (nombre, c) => `<li><b>${escapar(nombre)}</b>: ${escapar(identidad(c))}. ${c.diferencia === 0
  ? 'Diferencia contra lo guardado: 0.00 D.'
  : `<span class="mal">Diferencia contra lo guardado: ${escapar(dolarones(c.diferencia))}.</span>`}</li>`;

export function bandaCuadre(r) {
  const c = r.cuadre, t = c.total;
  const avisos = [];
  if (t.asientos.diferencia !== 0) avisos.push(`Los movimientos de alta no coinciden con lo emitido por ${dolarones(t.asientos.diferencia)}.`);
  if (r.tickets.diferencia !== 0) avisos.push(`En los tickets del periodo, los Dolarones usados (${dolarones(r.tickets.en_tickets)}) no coinciden con los movimientos (${dolarones(r.tickets.socio + r.tickets.vale)}): ${dolarones(r.tickets.diferencia)}.`);
  const ok = c.ok && avisos.length === 0;
  const titulo = !c.ok ? `⚠ El saldo no cuadra: diferencia de ${dolarones(t.diferencia)}`
    : avisos.length ? '⚠ El saldo cuadra, pero hay algo que revisar' : '✓ El saldo cuadra';
  return `<div class="banda-saldo ${ok ? 'ok' : 'mal'}" role="status">
    <b>${escapar(titulo)}</b>
    <p>${escapar(identidad(t))}. Diferencia contra los saldos guardados: ${c.ok ? '0.00 D' : escapar(dolarones(t.diferencia))}.</p>
    <ul>${lineaLibro('Cuentas de socio', c.socio)}${lineaLibro('Vales de papel y cupones', c.vale)}</ul>
    ${avisos.map((a) => `<p class="mal">${escapar(a)}</p>`).join('')}
    <p class="nota">Siempre de todo el negocio y desde la apertura, sin importar el periodo ni la tienda. «Canjeado» ya descuenta lo que regresó al cancelar o devolver${t.reversos_canje ? ` (${escapar(dolarones(t.reversos_canje))})` : ''}.
      Lo vencido se deduce de las fechas: no deja movimiento.</p>
  </div>`;
}

/* ---------- tarjetas ---------- */

// Mismo marcado y mismo vocabulario de comparacion que todas las vistas (`tarjetasHtml`, reportes-resumen.js). Dolarones siempre compara con el
// periodo anterior de igual largo. `pp`: las dos cifras son proporciones (0 a 1) y el cambio se dice en puntos porcentuales.
const cambioDe = (actual, previo, { pp = false, bueno = 'neutro' } = {}) => (pp
  ? (actual == null || previo == null ? null : cambioKpi(actual * 100, previo * 100, { tipo: 'pp', bueno }))
  : cambioKpi(actual, previo, { tipo: 'pct', bueno }));

/** Fecha corta de un dia «2026-11-20» -> «20 nov». */
const fechaCorta = (d) => (d ? diaCorto(d) : '');

export function tarjetas(r) {
  const p = r.periodo, s = r.saldo, e = r.efecto;
  const tasa = p.tasa.total, tasaAntes = p.tasa_antes.total;
  const costo = p.ventas_netas > 0 ? p.costo / p.ventas_netas : null;
  const costoAntes = p.ventas_netas_antes > 0 ? p.costo_antes / p.ventas_netas_antes : null;
  const pieTasa = tasa.tasa === null
    ? `Aún no cierra su plazo nada del periodo${r.proximo_cierre ? `; lo próximo cierra el ${fechaCorta(r.proximo_cierre)}` : ''}`
    : `De ${dolarones(tasa.base)} que cerraron su plazo en el periodo, ${dolarones(tasa.canjeado)} se usaron`;
  const cierre = tasa.base;
  const serie = r.serie;
  const hayComp = p.ventas_netas_antes > 0 || p.emitidos_antes > 0 || p.canjeados_antes > 0 || p.vencidos_antes > 0;   // el periodo anterior tuvo algo
  const k = (etiqueta, valor, { cambio = null, vs = 'vs anterior', pie = '', serie: s2 = [], clase = 's1', delta = '', sinDelta = false, base = hayComp } = {}) =>
    ({ etiqueta, valor, cambio, vs, pie, serie: s2, clase, delta, sinDelta, comparando: true, hayComp: base });
  return tarjetasHtml([
    k('Emitidos en el periodo', dolarones(p.emitidos), { cambio: cambioDe(p.emitidos, p.emitidos_antes), serie: serie.map((c) => c.emitidos), clase: 's1',
      pie: porcentaje(p.emitidos, p.ventas_netas) ? `${porcentaje(p.emitidos, p.ventas_netas)} de las ventas netas` : 'Sin ventas netas con qué comparar' }),
    k('Canjeados', dolarones(p.canjeados), { cambio: cambioDe(p.canjeados, p.canjeados_antes), serie: serie.map((c) => c.canjeados), clase: 's2', pie: 'Usados como pago en caja' }),
    k('Tasa de canje', tasa.tasa === null ? 'Sin datos' : pct1(tasa.tasa), { cambio: cambioDe(tasa.tasa, tasaAntes.tasa, { pp: true, bueno: 'sube' }), pie: pieTasa }),
    k('Saldo vivo', dolarones(s.vivo), { cambio: cambioDe(s.vivo, s.vivo_inicio), vs: 'vs inicio del periodo', base: true, serie: serie.map((c) => c.vivo), clase: 's1',
      pie: `Lo que la tienda debe · disponible ${dolarones(s.disponible)} · por liberar ${dolarones(s.por_liberar)}` }),
    k('Por vencer en 30 días', dolarones(s.por_vencer_30), { delta: porcentaje(s.por_vencer_30, s.vivo) ? `${porcentaje(s.por_vencer_30, s.vivo)} del saldo vivo` : 'Sin saldo vivo', pie: 'Si no se usa' }),
    k('Vencidos sin usar', dolarones(p.vencidos), { cambio: cambioDe(p.vencidos, p.vencidos_antes), serie: serie.map((c) => c.vencidos), clase: 's3',
      pie: cierre > 0 ? `${porcentaje(p.vencidos, cierre)} de lo que cerró su plazo` : 'Ya no se pueden canjear' }),
    k('Costo del programa', costo === null ? 'Sin datos' : pct1(costo), { cambio: cambioDe(costo, costoAntes, { pp: true, bueno: 'baja' }),
      pie: 'Dolarones canjeados (sin cupones) sobre las ventas netas' }),
    k('Tickets pagados con Dolarones', num(e.con.tickets), { cambio: cambioDe(e.con.tickets, r.efecto.tickets_antes),
      pie: porcentaje(e.con.tickets, e.tickets) ? `${porcentaje(e.con.tickets, e.tickets)} de los tickets` : 'Sin tickets en el periodo' }),
  ]);
}

/* ---------- series: datos para las graficas y sus tablas ---------- */

/** Etiqueta de una cubeta: «14 nov» si es un dia; «9–15 nov» o «30 oct – 5 nov» si es una semana. */
export function etiquetaCubeta(c) {
  if (c.desde === c.hasta) return { etiqueta: diaCorto(c.desde), titulo: diaCorto(c.desde) };
  const corto = c.desde.slice(0, 7) === c.hasta.slice(0, 7) ? `${Number(c.desde.slice(8))}–${diaCorto(c.hasta)}` : `${diaCorto(c.desde)} – ${diaCorto(c.hasta)}`;
  return { etiqueta: corto, titulo: `${textoPeriodo(c.desde, c.hasta)}${c.parcial ? ' (parcial)' : ''}` };
}

export function datosSerie(r) {
  const categorias = r.serie.map(etiquetaCubeta);
  const series = [
    { nombre: 'Emitidos', color: 'var(--serie-1)', valores: r.serie.map((c) => c.emitidos) },
    { nombre: 'Canjeados', color: 'var(--serie-2)', valores: r.serie.map((c) => c.canjeados) },
    { nombre: 'Vencidos sin usar', color: 'var(--d-gris)', valores: r.serie.map((c) => c.vencidos) },
  ];
  const origenes = r.origenes.filter((o) => r.serie.some((c) => c.por_origen[o.clave]));
  const porOrigen = (origenes.length ? origenes : r.origenes.slice(0, 1)).map((o) => ({ nombre: o.nombre, color: colorDe(o.clave), valores: r.serie.map((c) => c.por_origen[o.clave] ?? 0) }));
  return { categorias, series, porOrigen, vivo: r.serie.map((c) => c.vivo) };
}

/** Calendario: ocho semanas desde hoy y «después» (más de ocho semanas). */
export function datosCalendario(r) {
  const categorias = [...r.vencimientos.semanas.map((s) => ({ etiqueta: diaCorto(s.desde), titulo: `${textoPeriodo(s.desde, s.hasta)}` })),
    { etiqueta: 'Después', titulo: 'Más de ocho semanas' }];
  const origenes = r.origenes.filter((o) => r.vencimientos.semanas.some((s) => s.por_origen[o.clave]));
  const series = origenes.map((o) => ({ nombre: o.nombre, color: colorDe(o.clave), valores: [...r.vencimientos.semanas.map((s) => s.por_origen[o.clave] ?? 0), 0] }));
  // Lo de después de ocho semanas no se separa por origen: va en una serie propia para que la suma cuadre.
  series.push({ nombre: 'Más adelante', color: 'var(--tinta-2)', valores: [...r.vencimientos.semanas.map(() => 0), r.vencimientos.despues] });
  return { categorias, series };
}

const tablaSerie = (categorias, series, fmt = dolarones, totales = true) => tabla(['Periodo', ...series.map((s) => s.nombre), ...(totales ? ['Total'] : [])],
  categorias.map((c, i) => [c.titulo, ...series.map((s) => fmt(s.valores[i])), ...(totales ? [fmt(series.reduce((t, s) => t + s.valores[i], 0))] : [])]),
  series.map((_, i) => i + 1).concat(totales ? [series.length + 1] : []));

/* ---------- el resto de paneles ---------- */

export function tablaOrigen(r) {
  const filas = r.por_origen;
  const total = r.cuadre.total;
  const hayTraspaso = filas.some((f) => f.traspaso !== 0);
  const encabezados = ['Origen', 'Emitido', ...(hayTraspaso ? ['Traspaso'] : []), 'Canjeado', 'Vencido', 'Retirado', 'Vivo'];
  const fila = (f) => [f.nombre, dolarones(f.emitido), ...(hayTraspaso ? [dolarones(f.traspaso)] : []), dolarones(f.canjeado), dolarones(f.vencido), dolarones(f.retirado), dolarones(f.vivo)];
  const sumaTotal = ['Total', dolarones(total.emitido), ...(hayTraspaso ? [dolarones(total.traspaso)] : []), dolarones(total.canjeado), dolarones(total.vencido), dolarones(total.retirado - total.otros), dolarones(total.vivo)];
  return tabla(encabezados, [...filas.map(fila), sumaTotal], encabezados.map((_, i) => i).slice(1));
}

export function panelVales(r) {
  const v = r.vales;
  if (v.emitidos === 0) return '<div class="vacio">Sin vales emitidos en este periodo.</div>';
  const colores = { completo: 'var(--serie-3)', parcial: 'var(--serie-1)', vencido: 'var(--d-gris)', vivo: 'var(--serie-4)', cuenta: 'var(--serie-2)', retirado: 'var(--tinta-2)' };
  return apilada(v.resultados.map((x) => ({ nombre: x.nombre, valor: x.n, color: colores[x.clave], texto: `${num(x.n)} ${x.n === 1 ? 'vale' : 'vales'}`, extra: dolarones(x.importe) })));
}

export function datosHistograma(r) {
  const h = r.vales.dias.histograma;
  return { categorias: h.map((x) => ({ etiqueta: x.nombre.replace(' días', '').replace(' o más', '+'), titulo: x.nombre })), valores: h.map((x) => x.n) };
}

export function efectoVenta(r) {
  const e = r.efecto;
  if (e.tickets === 0) return '<div class="vacio">Sin tickets en este periodo.</div>';
  const medio = (neto, n) => (n > 0 ? Math.round(neto / n) : 0);
  const con = medio(e.con.neto, e.con.tickets), sin = medio(e.sin.neto, e.sin.tickets);
  const barras = barrasHorizontales([
    { nombre: 'Con Dolarones', valor: con, texto: e.con.tickets ? pesos(con) : 'Sin tickets', tip: `Con Dolarones\n${pesos(con)}\n${num(e.con.tickets)} tickets` },
    { nombre: 'Sin Dolarones', valor: sin, texto: e.sin.tickets ? pesos(sin) : 'Sin tickets', tip: `Sin Dolarones\n${pesos(sin)}\n${num(e.sin.tickets)} tickets` },
  ]);
  const porD = e.con.dolarones > 0 ? pesos(Math.round((e.con.dinero * 100) / e.con.dolarones)) : '—';
  const par = (a, b, fuerte = false) => `<dt>${escapar(a)}</dt><dd class="num">${fuerte ? '<b>' : ''}${escapar(b)}${fuerte ? '</b>' : ''}</dd>`;
  return `<p class="nota" style="margin:0 0 8px">Ticket promedio</p>${barras}<dl class="pares">${par('Tickets pagados con Dolarones', num(e.con.tickets))}${par('Dolarones usados en ellos', dolarones(e.con.dolarones))}
    ${par('Dinero que entró en esos tickets', pesos(e.con.dinero))}${par('Dinero por cada D canjeado', porD, true)}</dl>
    <p class="nota">El ticket promedio es lo vendido neto de cada ticket, con la parte pagada en Dolarones. Quien regresa a usar sus Dolarones paga el resto en efectivo, tarjeta o transferencia.</p>`;
}

export function tablaSaldos(r) {
  if (r.saldos.length === 0) return '<div class="vacio">Ningún socio tiene saldo vigente.</div>';
  const enc = ['Socio', 'Última compra', 'Vence primero', 'Saldo', 'Disponible', 'Por liberar'];
  return tabla(enc, r.saldos.map((s) => [`Socio #${s.socio}`, s.ultima_compra ? fechaCorta(s.ultima_compra) : 'Sin compras', fechaCorta(s.vence_primero), dolarones(s.saldo), dolarones(s.disponible), dolarones(s.por_liberar)]), [3, 4, 5]);
}

/* ---------- la vista completa ---------- */

const panel = (id, titulo, sub, graficaId, tablaHtml, nota = '', leyenda = '') => `<article class="panel" id="${id}">
  <header><h4>${escapar(titulo)} <span class="subtitulo">${escapar(sub)}</span></h4><button type="button" class="alterna">Ver tabla</button></header>
  <div class="vista-grafica">${leyenda}<div class="graf-d" data-grafica="${graficaId}"></div>${nota ? `<p class="nota">${escapar(nota)}</p>` : ''}</div>
  <div class="vista-tabla">${tablaHtml}</div></article>`;

/** El esqueleto de la vista, con las graficas como huecos (`.graf-d`) que `graficas()` llena segun el ancho. */
export function vistaDolarones(r) {
  const d = datosSerie(r), cal = datosCalendario(r);
  const grano = r.grano === 'dia' ? 'D por día' : 'D por semana, de lunes a domingo';
  const todoVacio = r.cuadre.total.emitido === 0 && r.por_origen.every((f) => f.vivo === 0);
  const aviso = r.tienda
    ? `<p class="nota aviso-tienda">Con ${escapar(r.tienda_nombre)} elegida, lo emitido, canjeado y vencido es de las ventas de esa tienda (los regalos, retos y cupones no son de una tienda y no entran). El saldo vivo, el calendario, el cuadre, la tabla por origen y los saldos son de todo el negocio.</p>` : '';
  const desde = r.inicio_programa ? `Hay movimientos desde el ${fechaCorta(r.inicio_programa)}.` : 'Todavía no hay movimientos del programa.';
  const mediana = r.vales.dias.mediana;
  return `${bandaCuadre(r)}
    ${aviso}
    ${todoVacio ? `<p class="vacio">${escapar(desde)}</p>` : ''}
    <div class="tarjetas" id="d-kpis">${tarjetas(r)}</div>
    <div class="malla dos">
      ${panel('d-sem', 'Emitidos, canjeados y vencidos', grano, 'semana', tablaSerie(d.categorias, d.series, dolarones, false),
        'Lo emitido que no regresa en su plazo termina en «vencidos»: los vales, los regalos y los 50 D de registro a los 30 días; lo ganado por socios a los 12 meses.', leyendaSeries(d.series))}
      ${panel('d-vivo', 'Saldo vivo', r.grano === 'dia' ? 'al cierre de cada día' : 'al cierre de cada semana', 'vivo', tabla(['Periodo', 'Saldo vivo'], d.categorias.map((c, i) => [c.titulo, dolarones(d.vivo[i])]), [1]),
        'Es un pasivo: mercancía que la tienda ya prometió. Se reconstruye de los movimientos y las fechas de vencimiento, y el último punto es el de ahora.')}
    </div>
    <div class="malla iguales">
      ${panel('d-origen', 'Emitidos por origen', grano, 'origen', tablaSerie(d.categorias, d.porOrigen), '', leyendaSeries(d.porOrigen))}
      <article class="panel" id="d-origen-t"><header><h4>Saldo por origen <span class="subtitulo">desde la apertura, todo el negocio</span></h4></header>
        ${tablaOrigen(r)}
        <p class="nota">Socios: 10 D por cada $100 completos, disponibles al día siguiente, 12 meses. Vale: 5 D por cada $100, 30 días. «Retirado» incluye lo que se quitó al cancelar o devolver la compra que lo dio.
          Un vale que pasa a una cuenta sale de «Vale de papel» (traspaso −) y entra a «Compra de socio» (traspaso +): no cuenta dos veces. Los cupones reemplazan una devolución de dinero.</p></article>
    </div>
    <div class="malla iguales">
      <article class="panel" id="d-vales"><header><h4>Vales de papel <span class="subtitulo">${escapar(num(r.vales.emitidos))} emitidos en el periodo</span></h4></header>
        ${panelVales(r)}<p class="nota">Cada vale cuenta una sola vez: los recientes todavía siguen vivos.</p></article>
      ${panel('d-dias', 'Cuánto tarda en regresar un vale', 'días entre la emisión y el canje', 'dias',
        tabla(['Días desde la emisión', 'Canjes', 'Dolarones'], r.vales.dias.histograma.map((h) => [h.nombre, num(h.n), dolarones(h.importe)]), [1, 2]),
        mediana === null ? 'Sin canjes de vales en el periodo.' : `La mitad de los canjes del periodo ocurre a los ${mediana} ${mediana === 1 ? 'día' : 'días'} de la emisión o antes.`)}
    </div>
    <div class="malla iguales">
      ${panel('d-vence', 'Calendario de vencimientos', 'D que vencen por semana si no se usan', 'calendario', tablaSerie(cal.categorias, cal.series),
        'Las próximas ocho semanas desde hoy; lo de después va aparte. Lo ganado por socios vence a los 12 meses.', leyendaSeries(cal.series))}
      <article class="panel" id="d-efecto"><header><h4>Efecto en la venta <span class="subtitulo">tickets del periodo</span></h4></header>${efectoVenta(r)}</article>
    </div>
    <article class="panel" id="d-saldos"><header><h4>Saldos más grandes <span class="subtitulo">por número de socio</span></h4></header>
      ${tablaSaldos(r)}<p class="nota">Solo el número de socio; el nombre y el teléfono no salen en los reportes. Las cuentas del equipo también aparecen aquí.</p></article>`;
}

/** Las graficas de cada hueco `.graf-d`, para el ancho que tenga: { grafica: html }. */
export function graficas(r, anchoDe) {
  const d = datosSerie(r), cal = datosCalendario(r), h = datosHistograma(r);
  const ancho = (id) => Math.max(220, Math.floor(anchoDe(id)));
  const sinNada = (series, mensaje) => (series.every((x) => x.valores.every((v) => v === 0)) ? `<div class="vacio">${mensaje}</div>` : null);
  return {
    semana: sinNada(d.series, 'Sin movimientos en el periodo.') ?? columnas({ categorias: d.categorias, series: d.series, ancho: ancho('semana'), fmtEje: enD, fmtValor: dolarones }),
    vivo: sinNada([{ valores: d.vivo }], 'Sin saldo vivo en el periodo.') ?? lineaSerie({ categorias: d.categorias, valores: d.vivo, nombre: 'Saldo vivo', ancho: ancho('vivo'), fmtEje: enD, fmtValor: dolarones }),
    origen: sinNada(d.porOrigen, 'Sin emisiones en el periodo.') ?? columnas({ categorias: d.categorias, series: d.porOrigen, ancho: ancho('origen'), modo: 'apiladas', fmtEje: enD, fmtValor: dolarones }),
    dias: sinNada([{ valores: h.valores }], 'Sin canjes de vales en el periodo.') ?? columnas({ categorias: h.categorias, series: [{ nombre: 'Canjes de vales', color: 'var(--serie-1)', valores: h.valores }], ancho: ancho('dias'), alto: 200, entero: true, fmtValor: num }),
    calendario: sinNada(cal.series, 'Nada por vencer en las próximas semanas.') ?? columnas({ categorias: cal.categorias, series: cal.series, ancho: ancho('calendario'), alto: 220, modo: 'apiladas', fmtEje: enD, fmtValor: dolarones }),
  };
}
