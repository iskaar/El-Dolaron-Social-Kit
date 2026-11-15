// Piezas de /reportes (Issue #166): dinero al centavo, escalas, graficas en SVG/HTML y el cuadre
// entre secciones. Sin dependencias; lo que no toca el DOM se prueba en src/graficas.test.ts.
// Metodo del skill dataviz: marcas delgadas, rejilla recesiva, una sola escala, tooltip en cada
// marca y una tabla equivalente para cada grafica. Los colores son variables CSS de la pagina.

// Nombres, motivos y correos los escriben otras personas: texto, nunca HTML.
export const escapar = (texto) =>
  String(texto ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- dinero: centavos enteros, sin pasar por decimales ---------- */

const grupos = (n) => n.toLocaleString('es-MX', { maximumFractionDigits: 0 });

/** 123456 -> «$1,234.56»; negativos con signo menos tipografico. Siempre con centavos. */
export function pesos(centavos) {
  const c = Math.round(Number(centavos) || 0);
  const abs = Math.abs(c);
  return `${c < 0 ? '−' : ''}$${grupos(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/** Igual que pesos pero en Dolarones: 12050 -> «120.50 D». */
export function dolarones(centavos) {
  const c = Math.round(Number(centavos) || 0);
  const abs = Math.abs(c);
  return `${c < 0 ? '−' : ''}${grupos(Math.trunc(abs / 100))}.${String(abs % 100).padStart(2, '0')} D`;
}

/** Pesos enteros para las marcas del eje, donde los centavos estorban. */
export const pesosEje = (centavos) => `$${grupos(Math.round(centavos / 100))}`;

/** Con signo explicito (+/−): para diferencias. */
export const pesosConSigno = (centavos) => (centavos > 0 ? `+${pesos(centavos)}` : pesos(centavos));

/* ---------- escalas y comparaciones ---------- */

/** Cambio contra el periodo anterior: null si no hay con que comparar. */
export function cambio(actual, previo) {
  if (!(previo > 0)) return null;
  const pct = ((actual - previo) / previo) * 100;
  const redondeado = Math.round(pct * 10) / 10;
  return {
    pct: redondeado,
    direccion: redondeado > 0 ? 'sube' : redondeado < 0 ? 'baja' : 'igual',
    texto: `${redondeado > 0 ? '+' : redondeado < 0 ? '−' : ''}${Math.abs(redondeado).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`,
  };
}

/** «▲ +12.3%»: la flecha y el signo van escritos, el color solo los refuerza. */
export const flechaCambio = (c) => `${c.direccion === 'sube' ? '▲' : c.direccion === 'baja' ? '▼' : '='} ${c.texto}`;

const MS_DIA = 86_400_000;
export const sumarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * MS_DIA).toISOString().slice(0, 10);

/**
 * LAS FECHAS DE /reportes (#802 B5): un formato para un dia («15 nov», `diaCorto`) y uno para un instante («15 nov 2026, 8:29 p.m.», `fechaHora`),
 * en la hora del aparato. Ninguna vista escribe otro. `FECHAS_TICKET` es lo mismo para las listas de tickets (ticket.js las recibe como
 * opcion para no cambiar la ventana de la caja).
 */
const diaMes = (iso, opciones) => new Date(iso).toLocaleDateString('es-MX', opciones).replace('.', '');   // «nov.» -> «nov»
const horaDe = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' });
export const fechaHora = (iso) => `${diaMes(iso, { day: 'numeric', month: 'short', year: 'numeric' })}, ${horaDe(iso)}`;
export const FECHAS_TICKET = { fecha: (iso) => diaMes(iso, { day: 'numeric', month: 'short' }), hora: horaDe };

/** Un renglon por dia del rango, con ceros donde no hubo ventas: una barra ausente no es un cero. */
export function rellenarDias(porDia, desdeDia, hastaDia) {
  const mapa = new Map(porDia.map((f) => [f.dia, f]));
  const dias = [];
  for (let dia = desdeDia; dia <= hastaDia; dia = sumarDias(dia, 1)) {
    const f = mapa.get(dia);
    dias.push({ dia, total: f?.total ?? 0, tickets: f?.tickets ?? 0, piezas: f?.piezas ?? 0 });
  }
  return dias;
}

const fechaDe = (dia) => new Date(`${dia}T12:00:00`);
export const diaCorto = (dia) => fechaDe(dia).toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }).replace('.', '');
export const diaLargo = (dia) =>
  fechaDe(dia).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const diaSemana = (dia) => fechaDe(dia).toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', '');

/** «27 sep – 4 oct 2026»; si el rango cruza de año, el año va en los dos extremos: «15 nov 2025 – 15 nov 2026». */
export function textoPeriodo(desdeDia, hastaDia) {
  const conAnio = (dia) => `${diaCorto(dia)} ${dia.slice(0, 4)}`;
  if (desdeDia === hastaDia) return conAnio(hastaDia);
  return desdeDia.slice(0, 4) === hastaDia.slice(0, 4) ? `${diaCorto(desdeDia)} – ${conAnio(hastaDia)}` : `${conAnio(desdeDia)} – ${conAnio(hastaDia)}`;
}

/* ---------- cuadre: que todo sume lo mismo, al centavo ---------- */

const suma = (filas, campo = 'total') => filas.reduce((s, f) => s + (f[campo] ?? 0), 0);

/**
 * Las comprobaciones entre secciones. `esperado` es siempre lo vendido que reporta el
 * servidor; `obtenido` lo que suma cada seccion. Una diferencia distinta de cero se
 * muestra en centavos: es un hallazgo (un descuento, un redondeo), no se esconde.
 */
export function verificarCuadre(r) {
  const vendido = r.resumen.total;
  const c = r.cuadre;
  const revisiones = [
    ['De bruto a vendido', 'Bruto − devoluciones por pieza − cancelados − piezas de FEP', vendido, c.bruto - c.devoluciones_pieza - c.cancelados - (c.fep ?? 0)],
    ['Suma de los días', 'Lo vendido día por día', vendido, suma(r.por_dia)],
    ['Suma de las formas de pago', 'Efectivo + tarjeta + transferencia + Dolarones', vendido, suma(r.por_forma_pago)],
    ['Suma de las categorías', 'Lo vendido pieza por pieza', vendido, suma(r.por_categoria)],
    ['Suma por hora', 'Lo vendido por día de la semana y hora', vendido, suma(r.por_hora)],
  ];
  return revisiones.map(([nombre, detalle, esperado, obtenido]) => ({
    nombre, detalle, esperado, obtenido, diferencia: obtenido - esperado, ok: obtenido === esperado,
  }));
}

/* ---------- ventas por hora y dia de la semana (mapa de calor) ---------- */

export const PASOS_CALOR = 6;   // pasos de la escala: mas de seis no se distinguen a simple vista
const HORAS_SIN_VENTAS = [9, 21];   // el rango que se dibuja cuando aun no hay ventas
// Semana mexicana, lunes primero. El numero es el %w de SQLite (0 = domingo), como llega de /api/reportes.
const SEMANA = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];

/** 14 -> «14:00»; 14 -> «14:00–15:00» con `rangoHora`. La hora 23 cierra a las 00:00. */
export const textoHora = (h) => `${String(h).padStart(2, '0')}:00`;
export const rangoHora = (h) => `${textoHora(h)}–${textoHora((h + 1) % 24)}`;

/** De la primera a la ultima hora con ventas; sin ventas, de 9 a 21. */
export function horasConVentas(porHora) {
  const horas = porHora.filter((f) => f.tickets > 0).map((f) => f.hora);
  return horas.length ? { desde: Math.min(...horas), hasta: Math.max(...horas) } : { desde: HORAS_SIN_VENTAS[0], hasta: HORAS_SIN_VENTAS[1] };
}

/**
 * El paso (1 a 6) de una celda en la escala secuencial: lineal de $0 al maximo, y 0 para
 * una celda sin ventas, que no se pinta. El maximo siempre cae en el ultimo paso.
 */
export const pasoCalor = (total, maximo) =>
  total > 0 && maximo > 0 ? Math.min(PASOS_CALOR, Math.max(1, Math.ceil((total * PASOS_CALOR) / maximo))) : 0;

/** Los rangos de la escala para la leyenda: [{ paso, hasta }], con `hasta` en centavos. El ultimo es el maximo. */
export const pasosDeLaEscala = (maximo) =>
  Array.from({ length: PASOS_CALOR }, (_, i) => ({ paso: i + 1, hasta: Math.round((maximo * (i + 1)) / PASOS_CALOR) }));

const tickets = (n) => `${n.toLocaleString('es-MX')} ${n === 1 ? 'ticket' : 'tickets'}`;

/**
 * Del reporte (`por_hora`: [{ dia_semana, hora, tickets, total }]) al mapa: siete filas, de lunes a
 * domingo, y una columna por hora del rango. `mejor` es la celda mas fuerte (la primera si empatan).
 */
export function mapaCalor(porHora, detalleDe = (n) => (n ? tickets(n) : 'Sin ventas')) {
  const { desde, hasta } = horasConVentas(porHora);
  const horas = Array.from({ length: hasta - desde + 1 }, (_, i) => desde + i);
  const celda = new Map(porHora.map((f) => [`${f.dia_semana}-${f.hora}`, f]));
  const maximo = Math.max(0, ...porHora.filter((f) => f.hora >= desde && f.hora <= hasta).map((f) => f.total));
  let mejor = null;
  const filas = SEMANA.map(([dia, nombre]) => {
    const celdas = horas.map((hora) => {
      const f = celda.get(`${dia}-${hora}`);
      const c = { dia_semana: dia, dia: nombre, hora, tickets: f?.tickets ?? 0, total: f?.total ?? 0 };
      c.paso = pasoCalor(c.total, maximo);
      c.titulo = `${nombre} ${rangoHora(hora)}`;
      c.detalle = detalleDe(c.tickets);
      if (c.total > 0 && (!mejor || c.total > mejor.total)) mejor = c;
      return c;
    });
    return { dia_semana: dia, nombre, celdas, total: celdas.reduce((s, c) => s + c.total, 0) };
  });
  return { horas, filas, maximo, mejor };
}

/** Lo que cambia entre el mapa de ventas (dinero) y otros mapas, p. ej. capturas por hora (conteos): `valor`, `eje`, `vacio`, `titulo` y `escala`. */
export const FORMATO_CALOR_DINERO = {
  valor: pesos, eje: pesosEje, vacio: 'Sin ventas', titulo: 'Ventas por día de la semana y hora', escala: 'Escala: más oscuro es más vendido',
};

/**
 * El mapa de calor como HTML: una cuadricula con los dias a la izquierda y las horas arriba. Cada celda
 * con ventas es un cuadro redondeado en su paso de la escala (clase `p1`..`p6`, los colores viven en la
 * pagina) y se puede enfocar; las vacias solo llevan borde. Solo la celda mas fuerte lleva su importe escrito.
 */
export function mapaCalorHtml(mapa, fmt = FORMATO_CALOR_DINERO) {   // fmt.entero: la escala es de conteos enteros
  const { horas, filas, maximo, mejor } = mapa;
  const encabezado = horas.map((h) => `<div class="calor-hora">${h}</div>`).join('');
  const cuerpo = filas.map((f) => `<div class="calor-dia"><span class="largo">${escapar(f.nombre)}</span><span class="corto" aria-hidden="true">${escapar(f.nombre.slice(0, 3))}</span></div>` + f.celdas.map((c) => {
    const valor = c.total > 0 ? fmt.valor(c.total) : fmt.vacio;
    const aria = escapar(`${c.titulo}: ${valor}, ${c.detalle}`);
    const tip = escapar([c.titulo, valor, ...(c.total > 0 ? [c.detalle] : [])].join('\n'));
    // ponytail: solo las celdas con ventas entran al tabulador (168 paradas serian un castigo); la tabla cubre el resto.
    return c.paso
      ? `<div class="celda p${c.paso}${c === mejor ? ' mejor' : ''}" data-tip="${tip}" tabindex="0" role="img" aria-label="${aria}">${c === mejor ? escapar(fmt.eje(c.total)) : ''}</div>`
      : `<div class="celda vacia" data-tip="${tip}" role="img" aria-label="${aria}"></div>`;
  }).join('')).join('');
  // Conteos chicos (`fmt.entero`, maximo menor que los pasos): un escalon por cada valor posible (1, 2, 3...), sin rangos repetidos como «1–1» o «hasta 0».
  const leyenda = fmt.entero && maximo < PASOS_CALOR
    ? Array.from({ length: maximo }, (_, i) => `<span class="calor-paso"><i class="celda p${pasoCalor(i + 1, maximo)}"></i>${escapar(fmt.eje(i + 1))}</span>`).join('')
    : pasosDeLaEscala(maximo).map((p, i, todos) =>
      `<span class="calor-paso"><i class="celda p${p.paso}"></i>${escapar(i === 0 ? `hasta ${fmt.eje(p.hasta)}` : `${fmt.eje(todos[i - 1].hasta)}–${fmt.eje(p.hasta)}`)}</span>`).join('');
  return `<div class="calor" style="--horas:${horas.length}" role="group" aria-label="${escapar(fmt.titulo)}">
      <div></div>${encabezado}${cuerpo}</div>
    <div class="calor-leyenda" aria-label="${escapar(fmt.escala)}"><span class="calor-paso sec">${escapar(fmt.vacio)}</span><i class="celda vacia"></i>${leyenda}</div>`;
}

/** La misma informacion en tabla: dia por hora (importes con centavos) y el total de cada dia. */
export function tablaCalor(mapa, valor = pesos) {
  const celda = (c) => (c.total > 0 ? valor(c.total) : '—');
  return tabla(['Día', ...mapa.horas.map(textoHora), 'Total'],
    mapa.filas.map((f) => [f.nombre, ...f.celdas.map(celda), valor(f.total)]),
    mapa.horas.map((_, i) => i + 1).concat(mapa.horas.length + 1));
}

/* ---------- inventario en piso: antiguedad (Issue #174) ---------- */

// Los tramos, en orden: son categorias ORDENADAS, asi que se pintan con la escala secuencial, no con tonos.
export const TRAMOS_ANTIGUEDAD = [['0-2', '0–2 semanas'], ['3-4', '3–4 semanas'], ['5-8', '5–8 semanas'], ['9+', '9 o más semanas']];

/** Dias desde la captura -> tramo, por semanas COMPLETAS (floor): 20 dias = 2 semanas = '0-2'; 21 = '3-4'; 63 = '9+'. */
export function tramoDeDias(dias) {
  const semanas = Math.floor(Math.max(0, dias) / 7);
  return semanas <= 2 ? '0-2' : semanas <= 4 ? '3-4' : semanas <= 8 ? '5-8' : '9+';
}

/** El paso (1 a 6) de la escala secuencial para el tramo `i` de `n`: el mas claro al primero, el mas oscuro al ultimo. */
export const pasoOrdinal = (i, n) => (n <= 1 ? PASOS_CALOR : 1 + Math.round((i * (PASOS_CALOR - 1)) / (n - 1)));

/* ---------- tooltip: un solo globo para todo /reportes ---------- */

let globo = null;
function asegurarGlobo() {
  if (globo) return globo;
  globo = document.createElement('div');
  globo.className = 'globo';
  globo.setAttribute('role', 'status');
  globo.hidden = true;
  document.body.append(globo);
  return globo;
}

/** `lineas`: [titulo, valor, ...detalle]. El valor manda; todo entra como texto. */
export function mostrarGlobo(lineas, x, y) {
  const g = asegurarGlobo();
  g.replaceChildren(...lineas.map((texto, i) => {
    const l = document.createElement('div');
    l.className = i === 0 ? 'g-titulo' : i === 1 ? 'g-valor' : 'g-detalle';
    l.textContent = texto;
    return l;
  }));
  g.hidden = false;
  const { width, height } = g.getBoundingClientRect();
  const izquierda = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8);
  const arriba = y - height - 12 < 8 ? y + 18 : y - height - 12;
  g.style.left = `${izquierda}px`;
  g.style.top = `${arriba}px`;
}
export const ocultarGlobo = () => { if (globo) globo.hidden = true; };

/** Cualquier elemento con `data-tip` (lineas separadas por salto de linea) muestra el globo. */
export function activarGlobos(raiz) {
  const lineasDe = (el) => el.dataset.tip.split('\n');
  raiz.addEventListener('pointermove', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (el) mostrarGlobo(lineasDe(el), e.clientX, e.clientY); else ocultarGlobo();
  });
  raiz.addEventListener('pointerleave', ocultarGlobo);
  raiz.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tip]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    mostrarGlobo(lineasDe(el), r.left + r.width / 2, r.top);
  });
  raiz.addEventListener('focusout', ocultarGlobo);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') ocultarGlobo(); });
}

/* ---------- graficas ---------- */

const MAX_COLUMNAS = 45;   // pasado esto, una linea: 365 barras ya no se leen

/**
 * Barras horizontales de una sola serie: un color, el valor en la punta. El orden ya viene
 * del servidor (de mayor a menor). `items`: [{ nombre, valor, texto, tip, sub?, direccion? }]. `sub` es una linea
 * chica bajo el valor (p. ej. «▲ +12.3%»); `direccion` ('sube'|'baja'|'igual') solo la colorea: el signo ya va escrito.
 */
export function barrasHorizontales(items) {
  const maximo = Math.max(1, ...items.map((i) => i.valor));
  return `<div class="hbarras">${items.map((i) => `
    <div class="hbarra" data-tip="${escapar(i.tip)}" tabindex="0">
      <span class="hn">${escapar(i.nombre)}</span>
      <span class="hpista"><i style="width:${Math.max(i.valor > 0 ? 0.5 : 0, (i.valor / maximo) * 100)}%"></i></span>
      <span class="hv">${escapar(i.texto)}${i.sub ? `<small class="hs ${escapar(i.direccion ?? '')}">${escapar(i.sub)}</small>` : ''}</span>
    </div>`).join('')}</div>`;
}

/**
 * Parte de un todo: una sola barra apilada con 2 px de aire entre segmentos y debajo la leyenda
 * con importe y porcentaje (la leyenda ES la tabla: nada depende del color). `items`:
 * [{ nombre, valor, color, texto, extra? }]. `extra` agrega una columna de texto (p. ej. las piezas) a la leyenda.
 */
export function apilada(items) {
  const total = suma(items, 'valor');
  if (total <= 0) return '<div class="vacio">Sin ventas en este periodo.</div>';
  const activos = items.filter((i) => i.valor > 0);
  const conExtra = items.some((i) => i.extra !== undefined);
  const pct =(v) => ((v / total) * 100).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `<div class="apilada" role="img" aria-label="${escapar(activos.map((i) => `${i.nombre} ${pct(i.valor)}%`).join(', '))}">
      ${activos.map((i) => `<span class="segmento" style="flex:${i.valor};background:${i.color}"
        data-tip="${escapar(`${i.nombre}\n${i.texto}\n${pct(i.valor)}% del total`)}" tabindex="0"></span>`).join('')}
    </div>
    <table class="leyenda"><tbody>${items.map((i) => `
      <tr><td><span class="llave" style="background:${i.color}"></span>${escapar(i.nombre)}</td>
        ${conExtra ? `<td class="num sec">${escapar(i.extra ?? '')}</td>` : ''}<td class="num">${escapar(i.texto)}</td><td class="num sec">${i.valor > 0 ? `${pct(i.valor)}%` : '—'}</td></tr>`).join('')}
    </tbody></table>`;
}

/** Tabla simple: `numericas` son los indices de columnas que se alinean a la derecha. */
export function tabla(encabezados, filas, numericas = []) {
  const clase = (i) => (numericas.includes(i) ? ' class="num"' : '');
  return `<table class="tabla"><thead><tr>${encabezados.map((h, i) => `<th${clase(i)}>${escapar(h)}</th>`).join('')}</tr></thead>
    <tbody>${filas.map((f) => `<tr>${f.map((c, i) => `<td${clase(i)}>${escapar(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/* ---------- series en el tiempo: UNA funcion de columnas y UNA de linea para todas las vistas (#802, B11) ---------- */

/**
 * La escala de UN eje, para todas las graficas. Marcas 1, 2, 5 x 10^k hasta cubrir el maximo, en las unidades que sean (cuentas, segundos,
 * porcentajes). `entero`: nunca menos de 1 por paso (conteos). `dinero`: el maximo viene en centavos y las marcas son «redondas» en pesos
 * (1, 2, 2.5, 5 x 10^k, con un minimo de $1) y tambien en centavos.
 */
export function escalaNumero(maximo, { objetivo = 4, entero = false, dinero = false } = {}) {
  if (dinero) {
    const tope = Math.max(Number(maximo) || 0, 100) / 100;   // pesos; minimo $1 para no dividir entre cero
    const crudo = tope / objetivo;
    const magnitud = 10 ** Math.floor(Math.log10(crudo));
    const paso = [1, 2, 2.5, 5, 10].map((m) => m * magnitud).find((p) => p >= crudo) ?? 10 * magnitud;
    const marcas = [0];
    for (let i = 1; marcas.at(-1) < tope * 100; i++) marcas.push(Math.round(i * paso * 100));
    return { tope: marcas.at(-1), marcas };
  }
  const m = Math.max(Number(maximo) || 0, entero ? 4 : 1);
  const crudo = m / objetivo;
  const magnitud = 10 ** Math.floor(Math.log10(crudo));
  let paso = [1, 2, 5, 10].map((k) => k * magnitud).find((p) => p >= crudo) ?? 10 * magnitud;
  if (entero) paso = Math.max(1, Math.ceil(paso));
  const marcas = [0];
  while (marcas.at(-1) < m) marcas.push(Math.round(marcas.length * paso * 1e6) / 1e6);
  return { tope: marcas.at(-1), marcas };
}

const MARGEN = { ml: 56, mr: 10, mt: 14, mb: 28 };

function ejes(ancho, alto, tope, marcas, fmtEje, margen = MARGEN) {
  const { ml, mr, mt, mb } = margen;
  const pw = Math.max(40, ancho - ml - mr), ph = alto - mt - mb;
  const y = (v) => mt + ph - (v / tope) * ph;
  const rejilla = marcas.map((m) => `
    <line class="${m === 0 ? 'eje' : 'rejilla'}" x1="${ml}" x2="${ancho - mr}" y1="${y(m)}" y2="${y(m)}"/>
    <text class="marca" x="${ml - 8}" y="${y(m) + 4}" text-anchor="end">${escapar(fmtEje(m))}</text>`).join('');
  return { pw, ph, y, rejilla };
}

/** Promedio movil de `n` valores (7 dias por omision): null hasta que hay `n`, sin rampa falsa al arrancar. `decimales`: 0 enteros (centavos), 1 conteos. */
export function promedioMovil(valores, n = 7, decimales = 0) {
  const k = 10 ** decimales;
  return valores.map((_, i) => (i < n - 1 ? null : Math.round((valores.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n) * k) / k));
}

/** Los tramos continuos de un trazo con huecos: { pts: ['x,y', ..], i0, i1 }. Un null (o NaN) corta el trazo, no baja a cero. */
function tramosDe(valores, x, y) {
  const tramos = [];
  let actual = null;
  valores.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { if (actual) tramos.push(actual); actual = null; return; }
    actual ??= { pts: [], i0: i, i1: i };
    actual.pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    actual.i1 = i;
  });
  if (actual) tramos.push(actual);
  return tramos;
}

const etiquetasEje = (categorias, slot, ml, alto) => {
  const paso = Math.max(1, Math.ceil(64 / slot));
  return categorias.map((c, i) => (categorias.length - 1 - i) % paso === 0
    ? `<text class="marca" x="${ml + i * slot + slot / 2}" y="${alto - 8}" text-anchor="middle">${escapar(c.etiqueta)}</text>` : '').join('');
};

/**
 * UNA grafica de columnas para todas las vistas: `modo` 'agrupadas' (una columna por serie) o 'apiladas'; escala de dinero (`fmtEje`/`fmtValor`
 * con pesos) o de conteos (`entero`). `categorias`: [{ etiqueta, titulo }]; `series`: [{ nombre, color, valores }]. Cada categoria es un blanco
 * con su globo (titulo, cada serie y, apiladas, el total) y entra al teclado como parte de UNA sola parada (`activarTeclado`). Las categorias sin
 * nada no pintan columna, pero si globo. Opciones: `linea` { nombre, valores: [numero | null] }, una linea de referencia (p. ej. el promedio
 * de 7 dias) sobre la misma escala, con un hueco donde hay null; `unidad` ('capturas'): el globo abre con el total y su unidad y lista solo
 * las series con algo; `descripcion` la lee el lector de pantalla.
 */
export function columnas({ categorias, series, ancho, alto = 240, modo = 'agrupadas', fmtEje = String, fmtValor = String, entero = false, linea = null, unidad = '', descripcion = '' }) {
  const n = categorias.length;
  const { ml, mt } = MARGEN;
  const totales = categorias.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.valores[i]), 0));
  const maximo = Math.max(0, ...categorias.map((_, i) => (modo === 'apiladas'
    ? totales[i] : Math.max(0, ...series.map((x) => x.valores[i])))), ...(linea?.valores ?? []).map((v) => v ?? 0));
  const { tope, marcas } = escalaNumero(maximo, { entero });
  const { pw, ph, y, rejilla } = ejes(ancho, alto, tope, marcas, fmtEje);
  const slot = pw / n;
  const grupo = Math.min(slot * 0.78, modo === 'apiladas' ? 44 : 22 * series.length);
  const base = y(0);
  const cuerpo = categorias.map((c, i) => {
    const x0 = ml + i * slot + (slot - grupo) / 2;
    let barras = '';
    if (modo === 'apiladas') {
      let acumulado = 0;
      for (const s of series) {
        const v = Math.max(0, s.valores[i]);
        if (v > 0) {
          const top = y(acumulado + v), bajo = y(acumulado);
          barras += `<rect x="${x0}" y="${top}" width="${grupo}" height="${Math.max(1, bajo - top - 1)}" rx="2" style="fill:${s.color}"/>`;
        }
        acumulado += v;
      }
    } else {
      const ancho_b = Math.max(2, (grupo - (series.length - 1) * 2) / series.length);
      series.forEach((s, j) => {
        const v = Math.max(0, s.valores[i]);
        if (v > 0) barras += `<rect x="${x0 + j * (ancho_b + 2)}" y="${y(v)}" width="${ancho_b}" height="${Math.max(1, base - y(v))}" rx="2" style="fill:${s.color}"/>`;
      });
    }
    const extra = linea?.valores[i] != null ? [`${linea.nombre}: ${fmtValor(linea.valores[i])}`] : [];
    const lineas = unidad
      ? [c.titulo, totales[i] ? `${fmtValor(totales[i])} ${unidad}` : `Sin ${unidad}`, ...series.filter((s) => s.valores[i] > 0).map((s) => `${s.nombre}: ${fmtValor(s.valores[i])}`), ...extra]
      : [c.titulo, ...series.map((s) => `${s.nombre}: ${fmtValor(s.valores[i])}`), ...(modo === 'apiladas' ? [`Total: ${fmtValor(series.reduce((t, s) => t + s.valores[i], 0))}`] : []), ...extra];
    return `<g class="col">${barras}<rect class="hit" x="${ml + i * slot}" y="${mt}" width="${slot}" height="${ph}"
      data-tip="${escapar(lineas.join('\n'))}" tabindex="0" role="img" aria-label="${escapar(lineas.join(', '))}"/></g>`;
  }).join('');
  const trazoRef = linea ? tramosDe(linea.valores, (i) => ml + i * slot + slot / 2, y).filter((t) => t.pts.length > 1)
    .map((t) => `<path d="M${t.pts.join(' L')}" style="fill:none;stroke:var(--tinta);stroke-width:2;stroke-dasharray:5 3;stroke-linejoin:round"/>`).join('') : '';
  return `<svg class="svg-grafica" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="group"
    aria-label="${escapar(descripcion || `${series.map((s) => s.nombre).join(', ')} por ${n} periodos`)}">${rejilla}${cuerpo}${trazoRef}${etiquetasEje(categorias, slot, ml, alto)}</svg>`;
}

/**
 * UNA grafica de linea para todas las vistas: un punto por categoria (el globo de cada punto trae su valor). `valores`: un numero por
 * categoria o null (un hueco: corta la linea y el globo dice «Sin datos»; no es un cero). `categorias`: [{ etiqueta, titulo, detalle?: [..] }].
 * `area`: relleno bajo la linea (por omision si); `entero`: marcas de conteos; `descripcion` la lee el lector de pantalla (por omision, `nombre`).
 */
export function lineaSerie({ categorias, valores, nombre, ancho, alto = 240, fmtEje = String, fmtValor = String, color = 'var(--acento)', area = true, entero = false, descripcion = '' }) {
  const n = categorias.length;
  const { ml, mt } = MARGEN;
  const { tope, marcas } = escalaNumero(Math.max(0, ...valores.map((v) => v ?? 0)), { entero });
  const { pw, ph, y, rejilla } = ejes(ancho, alto, tope, marcas, fmtEje);
  const slot = pw / n;
  const x = (i) => ml + i * slot + slot / 2;
  // Un tramo de un solo punto no es una linea: queda como punto. Cada tramo con area cierra al eje por sus dos extremos.
  const largos = tramosDe(valores, x, y).filter((t) => t.pts.length > 1);
  const areas = !area ? '' : largos.map((t) => `<path class="area" d="M${t.pts.join(' L')} L${x(t.i1)},${y(0)} L${x(t.i0)},${y(0)} Z" style="fill:${color}"/>`).join('');
  const trazos = largos.map((t) => `<path class="trazo" d="M${t.pts.join(' L')}" style="stroke:${color}"/>`).join('');
  const marcasPunto = valores.map((v, i) => {
    const lineas = [categorias[i].titulo ?? categorias[i].etiqueta, v == null ? 'Sin datos' : `${nombre}: ${fmtValor(v)}`, ...(categorias[i].detalle ?? [])];
    return `${v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="${i === n - 1 ? 4 : 3}" style="fill:${color};stroke:var(--superficie);stroke-width:2"/>`}
      <rect class="hit" x="${ml + i * slot}" y="${mt}" width="${slot}" height="${ph}" data-tip="${escapar(lineas.join('\n'))}" tabindex="0" role="img" aria-label="${escapar(lineas.join(', '))}"/>`;
  }).join('');
  return `<svg class="svg-grafica" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="group" aria-label="${escapar(descripcion || nombre)}">
    ${rejilla}${areas}${trazos}${marcasPunto}${etiquetasEje(categorias, slot, ml, alto)}</svg>`;
}

/** La leyenda de una grafica de varias series: llave de color y nombre (el color nunca es lo unico: ahi esta el nombre y la tabla). */
export const leyendaSeries = (series) => `<div class="leyenda-series">${series.map((s) =>
  `<span><i class="llave" style="background:${s.color}"></i>${escapar(s.nombre)}</span>`).join('')}</div>`;

/* ---------- minigrafica y serie en el tiempo (Issue #802: Resumen) ---------- */

/**
 * Minigrafica sin ejes: una linea con area que se estira al ancho de su caja (viewBox 100 de ancho).
 * `valores` puede traer null: un hueco, no un cero. Con menos de dos puntos no hay tendencia que dibujar ('').
 * `clase` es el tono de la serie (s1, s2, s3 = --serie-1..3); `etiqueta` la lee el lector de pantalla.
 */
export function minigrafica(valores, { alto = 34, clase = 's1', etiqueta = '' } = {}) {
  const n = valores.length;
  const reales = valores.filter((v) => v != null && Number.isFinite(v));
  if (n < 2 || reales.length < 2) return '';
  const minimo = Math.min(...reales), maximo = Math.max(...reales);
  const rango = maximo - minimo || 1;
  const x = (i) => (i / (n - 1)) * 100;
  const y = (v) => (maximo === minimo ? alto / 2 : alto - 3 - ((v - minimo) / rango) * (alto - 6));
  const tramos = [];
  let actual = [];
  valores.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) { if (actual.length) tramos.push(actual); actual = []; } else actual.push([x(i), y(v)]);
  });
  if (actual.length) tramos.push(actual);
  const trazos = tramos.filter((t) => t.length >= 2).map((t) => {
    const linea = `M${t.map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(' L')}`;
    return `<path class="area" d="${linea} L${t.at(-1)[0].toFixed(2)},${alto} L${t[0][0].toFixed(2)},${alto} Z"/><path class="linea" d="${linea}"/>`;
  }).join('');
  return `<svg class="mini ${escapar(clase)}" viewBox="0 0 100 ${alto}" preserveAspectRatio="none" height="${alto}" role="img" aria-label="${escapar(etiqueta)}">${trazos}</svg>`;
}

/**
 * Una serie por cubeta (dia, semana o mes) con lo que ayuda a leerla: columnas de `valor` (hasta 45; despues, linea con area), y
 * encima, si vienen, `media` (promedio movil, trazo continuo), `comparacion` (el periodo comparado, punteado gris, alineado cubeta a
 * cubeta) y `ritmo` (el paso de la meta, punteado de color). Un null corta la linea: no hay dato, no es un cero. `datos`:
 * [{ clave, etiqueta, titulo, valor, detalle: [..], media?, comparacion?, ritmo? }]. Con `clicable` cada cubeta lleva data-dia
 * (la clave) para filtrar los tickets de ese dia; `seleccion` apaga las demas.
 */
export function graficaTiempo(datos, { ancho, alto = 250, seleccion = null, clicable = false, nombre = 'Ventas netas' }) {
  const n = datos.length;
  if (n === 0) return '';
  const ml = 58, mr = 12, mt = 18, mb = 26;
  const todos = datos.flatMap((d) => [d.valor, d.media, d.comparacion, d.ritmo]).filter((v) => v != null && Number.isFinite(v));
  const maximo = Math.max(0, ...todos);
  const { tope, marcas } = escalaNumero(maximo, { dinero: true });
  const { pw, ph, y, rejilla } = ejes(ancho, alto, tope, marcas, pesosEje, { ml, mr, mt, mb });
  const barras = n <= MAX_COLUMNAS;
  const slot = pw / n;
  const x = (i) => (barras ? ml + i * slot + slot / 2 : ml + (n === 1 ? pw / 2 : (i / (n - 1)) * pw));

  // Una linea por serie, cortada donde falta el dato.
  const trazo = (campo, clase) => tramosDe(datos.map((d) => d[campo]), x, y).map(({ pts }) => (pts.length > 1
    ? `<path class="${clase}" d="M${pts.join(' L')}"/>` : `<circle class="${clase}-punto" cx="${pts[0].split(',')[0]}" cy="${pts[0].split(',')[1]}" r="2.5"/>`)).join('');

  const tip = (d) => escapar([d.titulo, d.valor ? pesos(d.valor) : 'Sin ventas', ...d.detalle].join('\n'));
  const aria = (d) => escapar(`${d.titulo}: ${d.valor ? pesos(d.valor) : 'sin ventas'}, ${d.detalle.join(', ')}`);
  const mayor = Math.max(...datos.map((e) => e.valor));
  const iMax = datos.findIndex((d) => d.valor === mayor && d.valor > 0);
  const paso = Math.max(1, Math.ceil(54 / Math.max(slot, 1)));
  const etiquetaDe = (i) => `<text class="marca" x="${x(i)}" y="${alto - 8}" text-anchor="middle">${escapar(datos[i].etiqueta)}</text>`;

  let cuerpo = '';
  if (barras) {
    const ancho_barra = Math.min(28, Math.max(3, slot * 0.62));
    const base = y(0);
    cuerpo = datos.map((d, i) => {
      const bx = x(i) - ancho_barra / 2, top = y(d.valor), r = Math.min(4, (base - top) / 2);
      const barra = d.valor > 0
        ? `<path class="barra${seleccion && seleccion !== d.clave ? ' apagada' : ''}" d="M${bx},${base} V${top + r} Q${bx},${top} ${bx + r},${top} H${bx + ancho_barra - r} Q${bx + ancho_barra},${top} ${bx + ancho_barra},${top + r} V${base} Z"/>` : '';
      return `<g class="col${seleccion === d.clave ? ' elegida' : ''}">${barra}${(n - 1 - i) % paso === 0 ? etiquetaDe(i) : ''}</g>`;
    }).join('');
  } else {
    const puntos = datos.map((d, i) => `${x(i).toFixed(1)},${y(d.valor).toFixed(1)}`);
    const linea = `M${puntos.join(' L')}`;
    const salto = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 70))));
    cuerpo = `<path class="area" d="${linea} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z"/><path class="trazo" d="${linea}"/>`
      + datos.map((_, i) => (i % salto === 0 ? etiquetaDe(i) : '')).join('');
  }
  // Una zona sensible por cubeta; solo con pocas cubetas se pueden recorrer con Tab (366 paradas serian un castigo: la tabla cubre el resto).
  const ancho_hit = barras ? slot : Math.max(2, pw / Math.max(1, n - 1));
  const zonas = datos.map((d, i) => `<rect class="hit${clicable ? '' : ' pasiva'}" x="${(barras ? ml + i * slot : x(i) - ancho_hit / 2).toFixed(1)}" y="${mt}" width="${ancho_hit.toFixed(1)}" height="${ph}"
    ${clicable ? `data-dia="${escapar(d.clave)}" role="button"` : 'role="img"'} data-tip="${tip(d)}" ${n <= MAX_COLUMNAS ? 'tabindex="0"' : ''} aria-label="${aria(d)}"/>`).join('');
  const maxTexto = barras && iMax >= 0
    ? `<text class="valor-max" x="${Math.min(Math.max(x(iMax), ml + 38), ancho - mr - 38)}" y="${y(datos[iMax].valor) - 6}" text-anchor="middle">${pesos(datos[iMax].valor)}</text>` : '';
  return `<svg class="svg-grafica" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="img"
    aria-label="${escapar(nombre)}, de ${escapar(datos[0].titulo)} a ${escapar(datos[n - 1].titulo)}">${rejilla}${cuerpo}${trazo('ritmo', 'ritmo')}${trazo('comparacion', 'comp')}${trazo('media', 'media')}${maxTexto}${zonas}</svg>`;
}
