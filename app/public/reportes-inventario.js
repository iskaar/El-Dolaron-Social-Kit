// Vista «Inventario» de /reportes (Issue #802): del JSON de /api/reportes/inventario (y de la foto de /api/reportes) al HTML y las graficas.
// Todo son funciones puras (sin DOM): se prueban en src/reportes-inventario-js.test.ts. Dinero en centavos; las cantidades son unidades.
import {
  escapar, pesos, diaCorto, tabla, columnas, leyendaSeries, pasoCalor, PASOS_CALOR, TRAMOS_ANTIGUEDAD,
} from './graficas.js';
import { cambioKpi, tarjetasHtml, edadPromedio } from './reportes-resumen.js';
import { etiquetaCubeta } from './reportes-dolarones.js';

const num = (n) => Number(n).toLocaleString('es-MX');
const dec1 = (n) => Number(n).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct1 = (x) => `${dec1(x)} %`;
const cuenta = (n, uno, varios) => `${num(n)} ${n === 1 ? uno : varios}`;
const signo = (n) => (n > 0 ? `+${num(n)}` : n < 0 ? `−${num(Math.abs(n))}` : '0');
const flecha = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '=');
const semanas = (k) => (k === 1 ? '1 semana' : `${k} semanas`);
const dias = (n) => `${Number.isInteger(n) ? num(n) : dec1(n)} ${n === 1 ? 'día' : 'días'}`;

/* ---------- aviso de tienda ---------- */

/** Que hace (y que no) la tienda elegida arriba en esta vista. `nombre` vacio = todas. */
export function avisoTienda(nombre) {
  const base = 'Esta vista es del negocio completo: las capturas se hacen en Soledad y las ventas de las tres tiendas y de Mercado Libre salen del mismo inventario.';
  return nombre
    ? `Con ${nombre} elegida esta vista no cambia: la tienda solo acota las demás vistas. ${base} Para ver dónde está lo que hay en piso, mira «Dónde está el inventario», al final.`
    : base;
}

/* ---------- tarjetas ---------- */

/**
 * Las seis tarjetas, con el mismo marcado y vocabulario de comparacion que todas las vistas (`tarjetasHtml`, reportes-resumen.js). `r`:
 * /api/reportes/inventario (null mientras carga); `base`: /api/reportes (la foto de ahora y la merma). Lo de piso es una foto de hoy y no lleva
 * minigrafica ni «vs anterior»; vendido a 4 semanas y dias en venta dependen del periodo.
 */
export function tarjetasInventario(r, base) {
  const inv = base?.inventario, merma = base?.merma_caducidad;
  const edad = inv ? edadPromedio(inv) : null;
  const v4 = r?.cohortes.vendido_4;
  const serie4 = r ? r.cohortes.semanas.filter((s) => s.pct[4] !== null).map((s) => s.pct[4]) : [];
  const dv = r?.dias_en_venta;
  const cargando = 'Cargando…';
  const k = (etiqueta, valor, o = {}) => ({ etiqueta, valor, cambio: null, vs: 'vs anterior', pie: '', serie: [], clase: 's1', comparando: true, hayComp: true, ...o });
  return tarjetasHtml([
    k('Valor en piso', inv ? pesos(inv.valor) : '—', { foto: !!inv, delta: inv ? '' : cargando, pie: inv ? `${cuenta(inv.unidades, 'unidad', 'unidades')} a precio de tienda · todo el negocio` : '' }),
    k('Piezas en piso', inv ? num(inv.piezas) : '—', { foto: !!inv, delta: inv ? '' : cargando, pie: inv ? `${cuenta(inv.sin_fecha.piezas, 'pieza', 'piezas')} sin fecha de captura` : '' }),
    k('Antigüedad promedio', edad == null ? (inv ? 'Sin datos' : '—') : dias(Math.round(edad)), { foto: !!inv, delta: inv ? '' : cargando, pie: 'Días desde la captura, por pieza en piso' }),
    k('Vendido a 4 semanas', !r ? '—' : v4.pct === null ? 'Sin datos' : pct1(v4.pct), { serie: serie4,
      delta: !r ? cargando : v4.pct === null ? 'Ninguna semana de captura tiene aún 4 semanas' : `${cuenta(v4.semanas, 'semana', 'semanas')} de captura con 4 semanas cumplidas`,
      pie: !r ? '' : v4.pct === null ? 'Unidades vendidas a 4 semanas de capturadas' : `${num(v4.vendidas)} de ${num(v4.unidades)} unidades capturadas se vendieron en 4 semanas` }),
    k('Días en venta', !r ? '—' : dv.mediana === null ? 'Sin datos' : dias(dv.mediana), {
      cambio: !r || dv.mediana === null ? null : cambioKpi(dv.mediana, dv.mediana_antes, { bueno: 'baja' }), hayComp: dv?.mediana_antes != null,
      delta: !r ? cargando : dv.mediana === null ? 'Sin ventas con fecha de captura en el periodo' : '',
      pie: !r ? '' : dv.mediana === null ? 'Mediana de captura a venta' : `Mediana de captura a venta · ${cuenta(dv.unidades, 'unidad', 'unidades')} vendidas en el periodo` }),
    k('Merma por caducidad', merma ? pesos(merma.valor_lista) : '—', { delta: merma ? 'Capturada en el periodo' : cargando, pie: merma ? `${cuenta(merma.piezas, 'pieza', 'piezas')}, a precio de lista` : '' }),
  ]);
}

/* ---------- entradas y salidas ---------- */

export function datosFlujo(r) {
  const categorias = r.flujo.semanas.map(etiquetaCubeta);
  const series = [
    { nombre: 'Capturadas', color: 'var(--serie-1)', valores: r.flujo.semanas.map((w) => w.capturadas) },
    { nombre: 'Vendidas', color: 'var(--serie-2)', valores: r.flujo.semanas.map((w) => w.vendidas) },
  ];
  return { categorias, series };
}

export function tablaFlujo(r) {
  const { categorias } = datosFlujo(r);
  const t = r.flujo.total;
  const filas = r.flujo.semanas.map((w, i) => [categorias[i].titulo, num(w.capturadas), num(w.vendidas), signo(w.neto), num(w.vendidas_ml)]);
  filas.push(['Total', num(t.capturadas), num(t.vendidas), signo(t.neto), num(t.vendidas_ml)]);
  return tabla(['Semana', 'Capturadas', 'Vendidas', 'Neto', 'De ellas, Mercado Libre'], filas, [1, 2, 3, 4]);
}

/** La frase que lee el dueño: entra mas de lo que sale, o al reves. Con flecha y texto. */
export function resumenFlujo(r) {
  const t = r.flujo.total;
  if (t.capturadas === 0 && t.vendidas === 0) return 'Sin capturas ni ventas de inventario en el periodo.';
  const lectura = t.neto > 0 ? 'Entró más de lo que salió: el piso se llena.' : t.neto < 0 ? 'Salió más de lo que entró: el piso se vacía.' : 'Entró lo mismo que salió.';
  return `${cuenta(t.capturadas, 'unidad capturada', 'unidades capturadas')} y ${cuenta(t.vendidas, 'vendida', 'vendidas')} · neto ${flecha(t.neto)} ${signo(t.neto)}. ${lectura}`;
}

/* ---------- cohortes ---------- */

/** El maximo de los porcentajes de la tabla: la escala va de 0 a ese maximo, como en el mapa de horas. */
export const maximoCohortes = (r) => Math.max(0, ...r.cohortes.semanas.flatMap((s) => Object.values(s.pct).filter((p) => p !== null)));

const SEMANAS_K = [1, 2, 4, 8];

export function tablaCohortes(r) {
  const maximo = maximoCohortes(r);
  const filas = r.cohortes.semanas.map((s) => {
    const { etiqueta, titulo } = etiquetaCubeta({ desde: s.lunes, hasta: s.domingo, parcial: false });
    const celdas = SEMANAS_K.map((k) => {
      const p = s.pct[k];
      if (p === null) {
        const motivo = s.unidades === 0 ? 'Sin capturas esa semana' : `Aún no pasan ${semanas(k)} desde que cerró la semana`;
        return `<td class="num sin" title="${escapar(motivo)}" aria-label="${escapar(motivo)}">—</td>`;
      }
      const paso = pasoCalor(p, maximo);
      const detalle = `${titulo}: ${pct1(p)} vendido a ${semanas(k)} (${num(s.vendidas_en[k])} de ${num(s.unidades)} unidades)`;
      return `<td class="num ${paso ? `p${paso}` : 'cero'}" title="${escapar(detalle)}">${escapar(pct1(p))}</td>`;
    }).join('');
    return `<tr><th scope="row">${escapar(etiqueta)}</th><td class="num">${num(s.unidades)}</td>${celdas}<td class="num">${num(s.sin_venta)}</td></tr>`;
  }).join('');
  return `<table class="tabla cohorte"><thead><tr><th>Semana de captura</th><th class="num">Unidades</th>${SEMANAS_K.map((k) => `<th class="num">${escapar(semanas(k))}</th>`).join('')}<th class="num">Salieron sin venta</th></tr></thead><tbody>${filas}</tbody></table>`;
}

export function leyendaCohortes(r) {
  const maximo = maximoCohortes(r);
  if (maximo <= 0) return '';
  const pasos = Array.from({ length: PASOS_CALOR }, (_, i) => (maximo * (i + 1)) / PASOS_CALOR);
  return `<div class="calor-leyenda" aria-label="Escala: más oscuro es más vendido"><span class="calor-paso sec">Sin valor aún</span><span class="calor-paso"><b>—</b></span>${pasos.map((hasta, i) =>
    `<span class="calor-paso"><i class="celda p${i + 1}"></i>${escapar(i === 0 ? `hasta ${pct1(hasta)}` : `${pct1(pasos[i - 1])}–${pct1(hasta)}`)}</span>`).join('')}</div>`;
}

/* ---------- rebajas ---------- */

export function datosRebajas(r) {
  const categorias = r.rebajas.semanas.map(etiquetaCubeta);
  const series = [
    { nombre: 'Rebajas', color: 'var(--serie-3)', valores: r.rebajas.semanas.map((w) => w.eventos) },
    { nombre: 'Piezas rebajadas', color: 'var(--serie-1)', valores: r.rebajas.semanas.map((w) => w.piezas) },
  ];
  return { categorias, series };
}

export function tablaRebajas(r) {
  const { categorias } = datosRebajas(r);
  const t = r.rebajas.total;
  const filas = r.rebajas.semanas.map((w, i) => [categorias[i].titulo, num(w.eventos), num(w.piezas), w.pct_promedio === null ? '—' : pct1(w.pct_promedio)]);
  filas.push(['Periodo', num(t.eventos), num(t.piezas), t.pct_promedio === null ? '—' : pct1(t.pct_promedio)]);
  return tabla(['Semana', 'Rebajas', 'Piezas rebajadas', 'Rebaja promedio'], filas, [1, 2, 3]);
}

const NOMBRES_TRAMO = TRAMOS_ANTIGUEDAD.map(([, nombre]) => nombre);
const celdaTasa = (g) => (g.pendientes > 0 ? `${pct1(g.pct)} <span class="sec">de ${num(g.pendientes)}</span>` : '<span class="sec">Sin piezas</span>');

/** Rebajadas contra piezas de la misma edad sin rebaja: por tramo de antigüedad y en total. */
export function comparacionRebajas(r) {
  const c = r.rebajas.comparacion;
  if (c.rebajadas.piezas === 0) {
    return `<p class="nota">Ninguna pieza se rebajó en el periodo con al menos ${c.ventana_dias} días de antelación: todavía no se puede medir qué pasó después.</p>`;
  }
  const filas = c.tramos.filter((t) => t.rebajadas.pendientes > 0 || t.sin_rebaja.pendientes > 0).map((t) => `<tr><th scope="row">${escapar(NOMBRES_TRAMO[t.tramo])}</th>
    <td class="num">${num(t.rebajadas.piezas)}</td><td class="num">${celdaTasa(t.rebajadas)}</td><td class="num">${celdaTasa(t.sin_rebaja)}</td></tr>`).join('');
  const t = c.comparables;
  const lectura = t.pct === null
    ? 'Ningún tramo de antigüedad tiene a la vez piezas rebajadas y piezas sin rebaja contra las que comparar.'
    : `Entre las unidades que seguían sin venderse al rebajar, ${pct1(t.pct)} se vendió en ${c.ventana_dias} días; en piezas de la misma edad sin rebaja, ${pct1(t.pct_sin_rebaja)} (${flecha(t.diferencia_pp)} ${t.diferencia_pp > 0 ? '+' : t.diferencia_pp < 0 ? '−' : ''}${dec1(Math.abs(t.diferencia_pp))} puntos).`;
  return `<p class="lectura-rebajas">${escapar(lectura)}</p>
    ${c.poca_muestra && t.pct !== null ? `<p class="nota aviso-pie">Muestra chica (${num(t.pendientes)} unidades): tómalo como indicio, no como conclusión.</p>` : ''}
    <table class="tabla"><thead><tr><th>Edad al rebajar</th><th class="num">Piezas rebajadas</th><th class="num">Rebajadas: vendido en ${c.ventana_dias} días</th><th class="num">Sin rebaja: vendido en ${c.ventana_dias} días</th></tr></thead><tbody>${filas}</tbody></table>`;
}

/* ---------- dias en venta ---------- */

export function textoMediana(r) {
  const d = r.dias_en_venta;
  if (d.mediana === null) return 'Sin piezas vendidas con fecha de captura en el periodo.';
  return `Mediana del periodo: ${dias(d.mediana)} de la captura a la venta (${cuenta(d.unidades, 'unidad', 'unidades')}). ${d.tramos.filter((t) => t.unidades > 0).map((t) => `${t.nombre}: ${num(t.unidades)}`).join(' · ')}.`;
}

/* ---------- los paneles ---------- */

const panel = (id, titulo, sub, graficaId, tablaHtml, nota = '', leyenda = '') => `<article class="panel" id="${id}">
  <header><h4>${escapar(titulo)} <span class="subtitulo">${escapar(sub)}</span></h4><button type="button" class="alterna">Ver tabla</button></header>
  <div class="vista-grafica">${leyenda}<div class="graf-i" data-grafica="${graficaId}"></div>${nota ? `<p class="nota">${escapar(nota)}</p>` : ''}</div>
  <div class="vista-tabla">${tablaHtml}</div></article>`;

export function panelFlujo(r) {
  const d = datosFlujo(r);
  const parcial = r.flujo.semanas.some((w) => w.parcial);
  return panel('i-flujo', 'Entradas y salidas', 'unidades por semana, de lunes a domingo', 'flujo', tablaFlujo(r),
    `${resumenFlujo(r)} Capturadas = lo que se capturó en la semana (vendidas hasta hoy + existencia de hoy + apartadas); vendidas = unidades netas de tickets no cancelados más Mercado Libre. No cuenta las piezas caducadas (grado D, merma) ni las descartadas: por eso sale menos que las capturas de la vista Capturas.${parcial ? ' Las semanas de los extremos cubren solo los días del periodo.' : ''}`,
    leyendaSeries(d.series));
}

export function panelCohortes(r) {
  const corto = r.dias < 56;
  return `<article class="panel" id="i-cohortes">
    <header><h4>Qué tan rápido se vende lo capturado <span class="subtitulo">% de las unidades vendido a 1, 2, 4 y 8 semanas de capturarse</span></h4></header>
    <div class="cohorte-caja">${tablaCohortes(r)}</div>${leyendaCohortes(r)}
    <p class="nota">Cada fila es lo capturado en una semana (lunes a domingo). Un guion significa que aún no pasan esas semanas desde que cerró la semana de captura: no es 0 %.
      La cantidad inicial de una pieza no se guarda: unidades = vendidas hasta hoy + existencia de hoy (Soledad, sucursales y en camino) + apartadas, así que una devolución posterior baja lo vendido.
      Lo que salió por robo, merma o error de captura ya no está en la existencia: no cuenta en las unidades y se muestra aparte en «Salieron sin venta».
      El color sigue la misma escala que el mapa de horas, hasta el máximo de esta tabla.${corto ? ' Con un periodo corto se muestran al menos las últimas 8 semanas de captura.' : ''}</p></article>`;
}

export function panelRebajas(r) {
  const b = r.rebajas;
  const desde = b.desde_bitacora ? diaCorto(b.desde_bitacora) : null;
  const sub = desde ? `desde el ${desde}, cuando empezó el registro de cambios` : 'todavía no hay registro de cambios';
  if (!b.desde_bitacora) return `<article class="panel" id="i-rebajas"><header><h4>Rebajas <span class="subtitulo">${escapar(sub)}</span></h4></header><div class="vacio">Sin datos: el sistema aún no ha registrado cambios de precio.</div></article>`;
  const antes = r.dia_desde < r.rebajas.desde_bitacora ? `<p class="nota aviso-pie">El periodo empieza antes del registro (${escapar(diaCorto(b.desde_bitacora))}): las rebajas anteriores no se pueden contar.</p>` : '';
  const t = b.total;
  const tarjetas = `<div class="tarjetas pequenas">
    <div class="tarjeta"><div class="etq">Rebajas</div><div class="valor">${num(t.eventos)}</div></div>
    <div class="tarjeta"><div class="etq">Piezas rebajadas</div><div class="valor">${num(t.piezas)}</div></div>
    <div class="tarjeta"><div class="etq">Rebaja promedio</div><div class="valor">${t.pct_promedio === null ? '—' : escapar(pct1(t.pct_promedio))}</div></div></div>`;
  const sin = t.eventos === 0 ? '<div class="vacio">Sin rebajas en el periodo.</div>' : '';
  return `<article class="panel" id="i-rebajas">
    <header><h4>Rebajas <span class="subtitulo">${escapar(sub)}</span></h4>${t.eventos ? '<button type="button" class="alterna">Ver tabla</button>' : ''}</header>
    ${antes}${tarjetas}
    ${sin || `<div class="vista-grafica">${leyendaSeries(datosRebajas(r).series)}<div class="graf-i" data-grafica="rebajas"></div></div>
    <div class="vista-tabla">${tablaRebajas(r)}</div>`}
    <h5 class="sub-h">¿Se vende más después de rebajar?</h5>
    ${comparacionRebajas(r)}
    <p class="nota">Una rebaja es un cambio de precio hacia abajo (a algo mayor que cero) hecho por una persona o por el sistema, al menos 24 horas después de capturar la pieza: lo que fija la IA al capturar y subir un precio no cuentan.
      Se compara lo vendido en ${b.comparacion.ventana_dias} días entre las unidades que seguían sin venderse al momento de rebajar y las de piezas sin rebaja a la misma edad (a ${b.comparacion.edades.join(', ')} días de capturadas por tramo), en el mismo periodo.
      Es una comparación, no una prueba: la rebaja se aplica a lo que no se movía.</p></article>`;
}

/** Los tres paneles nuevos, listos para sus huecos. */
export function vistaInventario(r) {
  return { flujo: panelFlujo(r), cohortes: panelCohortes(r), rebajas: panelRebajas(r) };
}

/** Las graficas de cada hueco `.graf-i`, para el ancho que tenga: { grafica: html }. */
export function graficas(r, anchoDe) {
  const ancho = (id) => Math.max(220, Math.floor(anchoDe(id)));
  const sinNada = (series, mensaje) => (series.every((x) => x.valores.every((v) => v === 0)) ? `<div class="vacio">${mensaje}</div>` : null);
  const f = datosFlujo(r), b = datosRebajas(r);
  return {
    flujo: sinNada(f.series, 'Sin capturas ni ventas de inventario en el periodo.')
      ?? columnas({ categorias: f.categorias, series: f.series, ancho: ancho('flujo'), entero: true, fmtValor: num, fmtEje: num }),
    rebajas: columnas({ categorias: b.categorias, series: b.series, ancho: ancho('rebajas'), alto: 200, entero: true, fmtValor: num, fmtEje: num }),
  };
}
