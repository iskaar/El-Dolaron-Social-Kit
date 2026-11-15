// Vista «Capturas» de /reportes (Issue #802): del JSON de /api/reportes/capturas a HTML y SVG.
// Todo lo que no toca el DOM se prueba en src/reportes-capturas.test.ts; solo `montarCapturas` usa document.
// Como en graficas.js: marcas delgadas, una tabla equivalente para cada grafica y el color nunca lleva solo el significado.
import {
  escapar, cambio, flechaCambio, diaCorto, diaLargo, diaSemana, mapaCalor, mapaCalorHtml, tablaCalor, FORMATO_CALOR_DINERO,
  graficaColumnas, graficaLinea, barrasHorizontales, tabla, minigrafica, leyendaSeries, columnas,
} from './graficas.js';
import { cambioKpi } from './reportes-resumen.js';

const mayuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const n0 = (n) => Number(n ?? 0).toLocaleString('es-MX');
const n1 = (n) => Number(n).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const cuenta = (n, uno, varios) => `${n0(n)} ${n === 1 ? uno : varios}`;
const pct = (n, base) => (base > 0 ? `${n1((n / base) * 100)} %` : '—');

/** 48 -> «48 s»; 94 -> «1:34 min». null -> «—». */
export function duracion(seg) {
  if (seg == null) return '—';
  if (seg < 60) return `${Math.round(seg)} s`;
  const total = Math.round(seg);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')} min`;
}

/** Para esperas largas: 1500 -> «25 min»; 11520 -> «3.2 h»; 259200 -> «3.0 días». null -> «—». */
export function duracionLarga(seg) {
  if (seg == null) return '—';
  if (seg < 3600) return `${Math.max(1, Math.round(seg / 60))} min`;
  if (seg < 172_800) return `${n1(seg / 3600)} h`;
  return `${n1(seg / 86_400)} días`;
}

/** Cuanto lleva algo esperando: «45 min», «5 h», «3 días». */
export function edad(desdeIso, ahoraIso) {
  if (!desdeIso) return '—';
  const min = Math.max(0, (Date.parse(ahoraIso) - Date.parse(desdeIso)) / 60_000);
  return min < 60 ? `${Math.max(1, Math.round(min))} min` : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} días`;
}

/** Promedio de los últimos `n` valores; null mientras no haya `n` (sin rampa falsa al arrancar). */
export function promedioMovil(valores, n = 7) {
  return valores.map((_, i) => (i < n - 1 ? null : Math.round((valores.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n) * 10) / 10));
}

const COLORES = ['var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)'];
export const COLOR_SIN_ATRIBUIR = 'var(--apagado)';

/**
 * Las series de la grafica: cada persona con su color; con más de cuatro, las tres con más capturas y «Resto» (la tabla las trae todas).
 * «Sin atribuir» va siempre aparte y en gris. Devuelve [{ nombre, color, correos: [..] }].
 */
export function agruparPersonas(personas) {
  const con = personas.filter((p) => p.correo && p.capturas > 0);
  const grupos = con.length <= COLORES.length
    ? con.map((p) => ({ nombre: p.nombre, correos: [p.correo] }))
    : [...con.slice(0, COLORES.length - 1).map((p) => ({ nombre: p.nombre, correos: [p.correo] })),
      { nombre: `Resto (${con.length - (COLORES.length - 1)} personas)`, correos: con.slice(COLORES.length - 1).map((p) => p.correo) }];
  const salida = grupos.map((g, i) => ({ ...g, color: COLORES[i] }));
  if (personas.some((p) => !p.correo && p.capturas > 0)) salida.push({ nombre: 'Sin atribuir', correos: [''], color: COLOR_SIN_ATRIBUIR });
  return salida;
}

/** La serie del servidor lista para `graficaColumnas`: una columna por día (hasta 35 días) o por semana, y el promedio de 7 días solo por día. */
export function datosSerie(r) {
  const grupos = agruparPersonas(r.personas);
  const dia = r.grano === 'dia';
  const series = grupos.map((g) => ({ nombre: g.nombre, color: g.color, valores: r.serie.map((s) => g.correos.reduce((t, c) => t + (s.personas[c] ?? 0), 0)) }));
  return {
    unidad: 'capturas',
    etiquetas: r.serie.map((s) => (dia ? (r.serie.length <= 10 ? `${diaSemana(s.clave)} ${s.clave.slice(8).replace(/^0/, '')}` : diaCorto(s.clave)) : diaCorto(s.clave))),
    titulos: r.serie.map((s) => (dia ? mayuscula(diaLargo(s.clave)) : `Semana del ${diaCorto(s.desde)} al ${diaCorto(s.hasta)}${s.parcial ? ' (parte de la semana)' : ''}`)),
    series,
    ...(dia ? { linea: { nombre: 'Promedio de 7 días', valores: promedioMovil(r.serie.map((s) => s.total), 7) } } : {}),
    grupos,
  };
}

/** Mediana semanal del tiempo por captura, en segundos; una semana sin intervalos medidos queda sin punto (no es cero). */
export function datosTiempo(r) {
  return r.tiempo_semanal.map((s) => ({
    etiqueta: diaCorto(s.lunes), titulo: `Semana del ${diaCorto(s.lunes)}`, valor: s.mediana_s,
    detalle: [s.n ? cuenta(s.n, 'intervalo medido', 'intervalos medidos') : 'Sin intervalos medidos'],
  }));
}

const TRAMOS = [[0, '< 30 s'], [30, '30–60 s'], [60, '60–90 s'], [90, '90–120 s'], [120, '2–3 min'], [180, '3–5 min'], [300, '5–10 min'], [600, '10 min o más']];
/** El histograma sin el tramo abierto de 10 min cuando la pausa no lo deja existir. */
export function datosHistograma(r) {
  const tramos = r.histograma.filter((t) => t.desde < r.pausa_min * 60);
  const etiqueta = (t) => TRAMOS.find(([desde]) => desde === t.desde)[1];
  return { unidad: 'intervalos', etiquetas: tramos.map(etiqueta), titulos: tramos.map(etiqueta), series: [{ nombre: 'Capturas', color: 'var(--serie-1)', valores: tramos.map((t) => t.n) }] };
}

/** Lo de la bitácora de cambios, con la fecha de su primer renglón: «desde el 23 oct». */
export function notaDesde(r) {
  if (r.bitacora.desde === null) return 'La bitácora de cambios todavía no tiene datos.';
  return `desde el ${diaCorto(r.bitacora.desde)}${r.bitacora.dentro_del_periodo ? ' (el periodo empieza antes: lo anterior no tiene este detalle)' : ''}`;
}

/* ---------- tarjetas ---------- */

// Mismo marcado que las tarjetas de Resumen y Dolarones (`.tarjeta.kpi`, `cambioKpi`): `bueno` dice si subir es bueno, malo o ni lo uno ni lo otro;
// la flecha y el signo van escritos y el color solo los refuerza. `serie` pinta la minigrafica si hay al menos dos puntos.
function delta(actual, previo, formato, bueno = 'sube') {
  const c = actual == null || previo == null ? null : cambioKpi(actual, previo, { bueno });
  if (!c) return '<div class="delta">Sin periodo anterior para comparar</div>';
  return `<div class="delta"><span class="chip ${c.tono}">${escapar(`${c.flecha} ${c.texto}`)}</span>${escapar(`antes: ${formato(previo)}`)}</div>`;
}
const pie = (texto) => `<div class="pie">${escapar(texto)}</div>`;
const tarjeta = (etq, valor, extra = '', serie = [], clase = 's1') =>
  `<div class="tarjeta kpi"><div class="etq">${escapar(etq)}</div><div class="valor">${escapar(valor)}</div>${extra}${
    serie.length >= 2 ? `<div class="mini-caja">${minigrafica(serie, { clase, etiqueta: `Tendencia de ${etq}` })}</div>` : ''}</div>`;

export function tarjetasCapturas(r) {
  const x = r.resumen, a = r.anterior, c = x.corregidas, cola = r.pendientes.por_revisar;
  const porColumna = r.serie.map((s) => s.total), porDia = r.serie.map((s) => (s.dias ? s.total / s.dias : null));
  return `<div class="tarjetas" id="c-kpis">${[
    tarjeta('Capturas del periodo', n0(x.capturas), delta(x.capturas, a.capturas, n0) + (x.sumas ? pie(`y ${cuenta(x.sumas, 'suma', 'sumas')} a piezas que ya existían`) : ''), porColumna, 's1'),
    tarjeta('Por día', x.por_dia == null ? '—' : n1(x.por_dia), delta(x.por_dia, a.por_dia, n1) + pie(`${cuenta(x.dias_con_captura, 'día', 'días')} con captura`), porDia, 's1'),
    tarjeta('Tiempo por captura', duracion(x.tiempo_mediano_s), delta(x.tiempo_mediano_s, a.tiempo_mediano_s, duracion, 'baja')   // menos es mejor
      + pie(`Mediana de ${cuenta(x.medidas, 'intervalo medido', 'intervalos medidos')} · menos es mejor`), r.tiempo_semanal.map((s) => s.mediana_s), 's2'),
    tarjeta('Piezas por hora activa', x.piezas_por_hora == null ? '—' : n1(x.piezas_por_hora), delta(x.piezas_por_hora, a.piezas_por_hora, n1),
      r.tiempo_semanal.map((s) => s.piezas_por_hora), 's3'),
    tarjeta('Horas activas de captura', `${n1(x.horas_activas)} h`, delta(x.horas_activas, a.horas_activas, (v) => `${n1(v)} h`, 'neutro') + pie('Suma de personas, sin contar pausas')),
    tarjeta('De captura a etiqueta', duracionLarga(x.captura_a_etiqueta_s),
      pie(x.captura_a_etiqueta_n ? `Mediana de ${cuenta(x.captura_a_etiqueta_n, 'pieza', 'piezas')} con etiqueta registrada`
        : r.etiquetas.desde ? 'Sin etiquetas registradas en el periodo' : 'Aún no se registran etiquetas')),
    tarjeta('Corregidas tras la IA', pct(c.n, c.base),
      pie(c.base ? `${n0(c.n)} de ${n0(c.base)} piezas que llenó la IA · ${notaDesde(r)}` : `Sin piezas llenadas por la IA · ${notaDesde(r)}`)),
    tarjeta('Cola por revisar', n0(cola.n), pie(cola.n ? `ahora · la más vieja lleva ${edad(cola.mas_vieja, r.ahora)}` : 'ahora · nada esperando')),
  ].join('')}</div>`;
}

/* ---------- tablas ---------- */

const llave = (color) => `<span style="display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:8px;background:${color}"></span>`;
const celdaNum = (t) => `<td class="num">${escapar(t)}</td>`;

/** Por persona, con la fila de Total sacada de los totales del servidor (los mismos de las tarjetas). */
export function tablaPersonas(r) {
  const color = new Map();
  for (const g of agruparPersonas(r.personas)) for (const c of g.correos) color.set(c, g.color);
  const x = r.resumen;
  const fila = (p) => `<tr><td>${color.has(p.correo) ? llave(color.get(p.correo)) : ''}${escapar(p.nombre)}</td>${[
    n0(p.capturas), n0(p.dias_activos), p.correo ? n1(p.horas_activas) : '—', p.piezas_por_hora == null ? '—' : n1(p.piezas_por_hora), duracion(p.tiempo_mediano_s),
    pct(p.corregidas.n, p.corregidas.base), pct(p.descartadas, p.capturas + p.descartadas), pct(p.vendidas_14.n, p.vendidas_14.base),
    n0(p.sin_tiempo.rafaga + p.sin_tiempo.sin_autor),
  ].map(celdaNum).join('')}</tr>`;
  const total = `<tr><td><b>Total</b></td>${[
    n0(x.capturas), n0(x.dias_con_captura), n1(x.horas_activas), x.piezas_por_hora == null ? '—' : n1(x.piezas_por_hora), duracion(x.tiempo_mediano_s),
    pct(x.corregidas.n, x.corregidas.base), pct(x.descartadas, x.capturas + x.descartadas), pct(x.vendidas_14.n, x.vendidas_14.base),
    n0(x.sin_tiempo.rafaga + x.sin_tiempo.sin_autor),
  ].map((t) => `<td class="num"><b>${escapar(t)}</b></td>`).join('')}</tr>`;
  const cabeza = ['Persona', 'Capturas', 'Días activos', 'Horas activas', 'Piezas por hora', 'Tiempo mediano', 'Corregidas', 'Descartadas', 'Vendidas a 14 días', 'Sin tiempo medible'];
  return `<table class="tabla"><thead><tr>${cabeza.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
    <tbody>${r.personas.map(fila).join('')}${total}</tbody></table>`;
}

export const NOMBRE_TIPO = { upc: 'Con UPC (ficha del manifiesto)', general: 'Mercancía general con foto', ropa: 'Ropa' };
export function tablaTipos(r) {
  const total = r.resumen.capturas;
  return tabla(['Tipo', 'Capturas', 'Parte', 'Tiempo mediano', 'Corregidas'],
    r.tipos.map((t) => [NOMBRE_TIPO[t.clave], n0(t.capturas), pct(t.capturas, total), t.medidas ? duracion(t.tiempo_mediano_s) : '—', pct(t.corregidas.n, t.corregidas.base)]), [1, 2, 3, 4]);
}

export const NOMBRE_PENDIENTE = { por_revisar: 'Cola por revisar', sin_etiqueta: 'Capturadas sin etiqueta', con_error: 'Con error de análisis' };
export function tablaPendientes(r) {
  return tabla(['Pendiente', 'La más vieja', 'Piezas'],
    Object.keys(NOMBRE_PENDIENTE).map((k) => [NOMBRE_PENDIENTE[k], r.pendientes[k].n ? edad(r.pendientes[k].mas_vieja, r.ahora) : '—', n0(r.pendientes[k].n)]), [1, 2]);
}

const NOMBRE_PASO = { capturada: 'Capturada', analizada: 'Analizada', etiquetada: 'Etiquetada', vendida: 'Vendida' };
const TIEMPO_PASO = { analizada: duracion, etiquetada: duracionLarga, vendida: duracionLarga };
function textoPaso(p) {
  const t = TIEMPO_PASO[p.clave];
  return p.mediana_s == null || !t ? null : t(p.mediana_s);
}

/** El embudo capturada → analizada → etiquetada → vendida como barras; la tabla trae las piezas, la parte y la mediana desde el paso anterior. */
export function embudoHtml(r) {
  if (!r.resumen.capturas) return '<div class="vacio">Sin capturas en este periodo.</div>';
  return barrasHorizontales(r.embudo.map((p) => {
    const t = textoPaso(p);
    const aparte = p.base !== r.resumen.capturas ? ' (desde que se registran etiquetas)' : '';
    return { nombre: NOMBRE_PASO[p.clave], valor: p.n, texto: `${n0(p.n)} · ${pct(p.n, p.base)}`, sub: t ? `${t} desde el paso anterior` : undefined,
      tip: [NOMBRE_PASO[p.clave], `${n0(p.n)} de ${n0(p.base)} piezas${aparte}`, ...(t ? [`${t} (mediana, ${cuenta(p.n_tiempo, 'pieza', 'piezas')})`] : [])].join('\n') };
  }));
}
export function embudoTabla(r) {
  return tabla(['Paso', 'Piezas', 'Parte', 'Mediana desde el paso anterior', 'Piezas con tiempo'],
    r.embudo.map((p) => [NOMBRE_PASO[p.clave], n0(p.n), pct(p.n, p.base), textoPaso(p) ?? '—', p.n_tiempo ? n0(p.n_tiempo) : '—']), [1, 2, 3, 4]);
}

/* ---------- horario ---------- */

export const FORMATO_CALOR_CAPTURAS = {
  ...FORMATO_CALOR_DINERO, entero: true, valor: (n) => cuenta(n, 'captura', 'capturas'), eje: (n) => n0(n), vacio: 'Sin capturas',
  titulo: 'Capturas por día de la semana y hora', escala: 'Escala: el tono más fuerte es más capturas',
};
export const mapaHorario = (r) => mapaCalor(r.por_hora.map((f) => ({ dia_semana: f.dia_semana, hora: f.hora, tickets: f.n, total: f.n })),
  (n) => (n ? cuenta(n, 'captura', 'capturas') : 'Sin capturas'));

/* ---------- la vista ---------- */

function panel(id, titulo, sub, grafica, tablaHtml, nota = '') {
  return `<article class="panel" id="${id}"><header><h4>${titulo}${sub ? ` <span class="subtitulo">${sub}</span>` : ''}</h4>${tablaHtml ? '<button type="button" class="alterna">Ver tabla</button>' : ''}</header>
    <div class="${tablaHtml ? 'vista-grafica' : ''}">${grafica}</div>${tablaHtml ? `<div class="vista-tabla">${tablaHtml}</div>` : ''}${nota ? `<p class="nota">${nota}</p>` : ''}</article>`;
}

/** La serie por día (o semana) y persona en tabla, lo más reciente primero. */
export function tablaSerie(r) {
  const d = datosSerie(r);
  return tabla([r.grano === 'dia' ? 'Día' : 'Semana', ...d.grupos.map((g) => g.nombre), 'Total'],
    [...r.serie.keys()].reverse().map((i) => [d.titulos[i], ...d.series.map((s) => n0(s.valores[i])), n0(r.serie[i].total)]),
    d.grupos.map((_, i) => i + 1).concat(d.grupos.length + 1));
}

/** Todo el HTML de la vista; las gráficas SVG van en huecos `data-grafica` que `montarCapturas` llena al conocer el ancho. */
export function htmlVista(r) {
  const grano = r.grano === 'dia' ? 'por día' : 'por semana, de lunes a domingo';
  const sinTiempo = r.resumen.sin_tiempo, medidas = r.resumen.medidas;
  const mapa = mapaHorario(r), histo = datosHistograma(r);
  const metodo = `El tiempo por captura es el intervalo con la captura anterior de la misma persona; uno mayor que la pausa (${r.pausa_min} min) es un descanso y no cuenta.
    ${cuenta(sinTiempo.rafaga, 'captura llegó', 'capturas llegaron')} en ráfaga (fotos que subieron juntas al volver la señal: menos de ${r.rafaga_foto_s} s entre una y otra) y
    ${n0(sinTiempo.sin_autor)} no traen cuenta: cuentan como capturas, pero quedan sin tiempo medible.
    La hora es la que registra el servidor al recibir cada captura, no la de la toma.`;
  return `
    <div class="principal">${tarjetasCapturas(r)}</div>
    <div class="malla dos">
      ${panel('c-dia', 'Capturas', `${grano}, por persona`, `${leyendaSeries(datosSerie(r).grupos)}<div data-grafica="serie"></div>`, tablaSerie(r),
        r.grano === 'dia' ? 'La línea punteada es el promedio de los últimos 7 días.' : 'Con más de 35 días la gráfica agrupa por semana.')}
      ${panel('c-tiempo', 'Tiempo por captura', 'mediana por semana', '<div data-grafica="tiempo"></div>',
        tabla(['Semana', 'Mediana', 'Intervalos medidos'], [...r.tiempo_semanal].reverse().map((s) => [`Semana del ${diaCorto(s.lunes)}`, duracion(s.mediana_s), n0(s.n)]), [1, 2]),
        'Más bajo es mejor. Una semana sin intervalos medidos queda sin punto: no es cero.')}
    </div>
    ${panel('c-persona', 'Por persona', 'periodo elegido', `<div style="overflow-x:auto">${tablaPersonas(r)}</div>`, '',
      `«Vendidas a 14 días» mide la calidad de la captura: de lo que capturó cada quien con al menos 14 días de edad, cuánto se vendió en sus primeras dos semanas (caja y Mercado Libre).
       «Descartadas» es la parte de lo que subió y luego se canceló. ${metodo}`)}
    <div class="malla iguales">
      ${panel('c-histo', 'Distribución del tiempo por captura', cuenta(medidas, 'intervalo medido', 'intervalos medidos'), '<div data-grafica="histograma"></div>',
        tabla(['Tramo', 'Intervalos'], histo.etiquetas.map((e, i) => [e, n0(histo.series[0].valores[i])]), [1]),
        medidas ? `La mitad de los intervalos medidos dura ${duracion(r.resumen.tiempo_mediano_s)} o menos.` : 'Sin intervalos medidos en este periodo.')}
      ${panel('c-calor', 'Horario de captura', 'capturas por hora, hora de la tienda',
        mapa.mejor ? mapaCalorHtml(mapa, FORMATO_CALOR_CAPTURAS) : '<div class="vacio">Sin capturas en este periodo.</div>', mapa.mejor ? tablaCalor(mapa, n0) : '',
        mapa.mejor ? `La celda más fuerte: ${escapar(mapa.mejor.titulo)} · ${escapar(mapa.mejor.detalle)}. Cada celda suma todo el periodo.` : '')}
    </div>
    ${panel('c-embudo', 'De la captura a la venta', 'piezas capturadas en el periodo', embudoHtml(r), embudoTabla(r),
      `La mediana es el tiempo desde el paso anterior. «Analizada» y las correcciones salen de la bitácora de cambios, <b>${escapar(notaDesde(r))}</b>;
       lo capturado antes no tiene ese detalle. «Etiquetada» es que la etiqueta se mandó a la impresora (registro de etiquetas enviadas${r.etiquetas.desde ? `, desde el ${escapar(diaCorto(r.etiquetas.desde))}` : ', todavía vacío'});
       «vendida», que ya salió en un ticket (cancelados fuera) o en Mercado Libre.`)}
    <div class="malla iguales">
      ${panel('c-tipo', 'Por tipo de captura', '', tablaTipos(r), '',
        'Con UPC es la ficha del manifiesto; mercancía general incluye lo capturado con foto o dado de alta a mano; ropa es la foto de prenda sin código. El tiempo de cada tipo es el de sus intervalos medidos.')}
      ${panel('c-pend', 'Pendientes', 'ahora', tablaPendientes(r), '',
        `Lo que no tiene etiqueta no está en piso y no se puede vender. «Sin etiqueta» cuenta solo lo capturado desde que se registran las etiquetas enviadas${r.etiquetas.desde ? ` (${escapar(diaCorto(r.etiquetas.desde))})` : ''}.`)}
    </div>`;
}

/** Gráficas SVG del ancho que hay. */
export function graficaDe(clave, r, ancho) {
  if (clave === 'serie') return graficaColumnas(datosSerie(r), { ancho, descripcion: `Capturas ${r.grano === 'dia' ? 'por día' : 'por semana'}, por persona` });
  if (clave === 'tiempo') return graficaLinea(datosTiempo(r), { ancho, formato: (s) => duracion(s), descripcion: 'Mediana semanal del tiempo por captura' });
  const h = datosHistograma(r);   // el histograma usa las columnas de Dolarones: una serie, marcas enteras
  return columnas({ categorias: h.etiquetas.map((e) => ({ etiqueta: e, titulo: e })), series: h.series, ancho, entero: true, fmtValor: n0 });
}

/** Pone la vista en `raiz` y dibuja las gráficas al ancho de su hueco; se redibujan solas si el hueco cambia (ventana, «Ver tabla»). */
export function montarCapturas(raiz, r) {
  raiz.innerHTML = htmlVista(r);
  raiz._observadores?.forEach((o) => o.disconnect());
  raiz._observadores = [...raiz.querySelectorAll('[data-grafica]')].map((el) => {
    const pintar = () => {
      const ancho = Math.floor(el.clientWidth);
      if (ancho) el.innerHTML = graficaDe(el.dataset.grafica, r, ancho);
    };
    pintar();
    const o = new ResizeObserver(pintar);
    o.observe(el);
    return o;
  });
}
