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

/** Marcas «redondas» (1, 2, 2.5, 5 x 10^k pesos) hasta cubrir el maximo, en centavos. */
export function escala(maximoCentavos, objetivo = 4) {
  const maximo = Math.max(Number(maximoCentavos) || 0, 100) / 100;   // pesos; minimo $1 para no dividir entre cero
  const crudo = maximo / objetivo;
  const magnitud = 10 ** Math.floor(Math.log10(crudo));
  const paso = [1, 2, 2.5, 5, 10].map((m) => m * magnitud).find((p) => p >= crudo) ?? 10 * magnitud;
  const marcas = [0];
  for (let i = 1; marcas.at(-1) < maximo * 100; i++) marcas.push(Math.round(i * paso * 100));
  return { tope: marcas.at(-1), marcas };
}

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

const MS_DIA = 86_400_000;
export const sumarDias = (dia, n) => new Date(Date.parse(`${dia}T00:00:00Z`) + n * MS_DIA).toISOString().slice(0, 10);

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

/** «27 sep – 4 oct 2026» */
export function textoPeriodo(desdeDia, hastaDia) {
  const anio = hastaDia.slice(0, 4);
  return desdeDia === hastaDia ? `${diaCorto(hastaDia)} ${anio}` : `${diaCorto(desdeDia)} – ${diaCorto(hastaDia)} ${anio}`;
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
    ['De bruto a vendido', 'Bruto − devoluciones por pieza − cancelados', vendido, c.bruto - c.devoluciones_pieza - c.cancelados],
    ['Suma de los días', 'Lo vendido día por día', vendido, suma(r.por_dia)],
    ['Suma de las formas de pago', 'Efectivo + tarjeta + transferencia + Dolarones', vendido, suma(r.por_forma_pago)],
    ['Suma de las categorías', 'Lo vendido pieza por pieza', vendido, suma(r.por_categoria)],
  ];
  return revisiones.map(([nombre, detalle, esperado, obtenido]) => ({
    nombre, detalle, esperado, obtenido, diferencia: obtenido - esperado, ok: obtenido === esperado,
  }));
}

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
 * Ventas por dia. Hasta 45 dias, columnas; despues, linea con area. `datos`:
 * [{ clave, etiqueta, titulo, valor, detalle: [..] }]. Con `seleccion` (una clave) las demas
 * columnas se apagan: el dia elegido filtra la lista de tickets.
 */
export function graficaDias(datos, { ancho, alto = 230, seleccion = null }) {
  const n = datos.length;
  const ml = 58, mr = 10, mt = 18, mb = 26;
  const pw = Math.max(40, ancho - ml - mr), ph = alto - mt - mb;
  const maximo = Math.max(0, ...datos.map((d) => d.valor));
  const { tope, marcas } = escala(maximo);
  const y = (v) => mt + ph - (v / tope) * ph;

  const rejilla = marcas.map((m) => `
    <line class="${m === 0 ? 'eje' : 'rejilla'}" x1="${ml}" x2="${ancho - mr}" y1="${y(m)}" y2="${y(m)}"/>
    <text class="marca" x="${ml - 8}" y="${y(m) + 4}" text-anchor="end">${pesosEje(m)}</text>`).join('');

  const tip = (d) => escapar([d.titulo, d.valor ? pesos(d.valor) : 'Sin ventas', ...d.detalle].join('\n'));
  const aria = (d) => escapar(`${d.titulo}: ${d.valor ? pesos(d.valor) : 'sin ventas'}, ${d.detalle.join(', ')}`);
  const iMax = datos.findIndex((d) => d.valor === maximo && maximo > 0);

  if (n <= MAX_COLUMNAS) {
    const slot = pw / n;
    const ancho_barra = Math.min(24, Math.max(3, slot * 0.62));
    const paso = Math.max(1, Math.ceil(54 / slot));
    const base = y(0);
    const columnas = datos.map((d, i) => {
      const x = ml + i * slot + (slot - ancho_barra) / 2;
      const top = y(d.valor);
      const r = Math.min(4, (base - top) / 2);
      const barra = d.valor > 0
        ? `<path class="barra${seleccion && seleccion !== d.clave ? ' apagada' : ''}" d="M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + ancho_barra - r} Q${x + ancho_barra},${top} ${x + ancho_barra},${top + r} V${base} Z"/>`
        : '';
      const etiqueta = (n - 1 - i) % paso === 0
        ? `<text class="marca" x="${ml + i * slot + slot / 2}" y="${alto - 8}" text-anchor="middle">${escapar(d.etiqueta)}</text>` : '';
      return `<g class="col${seleccion === d.clave ? ' elegida' : ''}">${barra}${etiqueta}
        <rect class="hit" x="${ml + i * slot}" y="${mt}" width="${slot}" height="${ph}" data-dia="${escapar(d.clave)}"
          data-tip="${tip(d)}" tabindex="0" role="button" aria-label="${aria(d)}"/></g>`;
    }).join('');
    const maxTexto = iMax >= 0
      ? `<text class="valor-max" x="${Math.min(Math.max(ml + iMax * slot + slot / 2, ml + 38), ancho - mr - 38)}" y="${y(maximo) - 6}" text-anchor="middle">${pesos(maximo)}</text>` : '';
    return `<svg class="svg-grafica" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="img"
      aria-label="Ventas por día, de ${escapar(datos[0].titulo)} a ${escapar(datos[n - 1].titulo)}">${rejilla}${columnas}${maxTexto}</svg>`;
  }

  // Linea con area: un punto por dia; el cursor busca el dia mas cercano.
  const x = (i) => ml + (i / (n - 1)) * pw;
  const puntos = datos.map((d, i) => `${x(i).toFixed(1)},${y(d.valor).toFixed(1)}`);
  const linea = `M${puntos.join(' L')}`;
  const area = `${linea} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const meses = datos.map((d, i) => (d.clave.endsWith('-01') ? [i, d] : null)).filter(Boolean)
    .map(([i, d]) => `<text class="marca" x="${x(i)}" y="${alto - 8}" text-anchor="middle">${escapar(diaCorto(d.clave).split(' ')[1] ?? '')}</text>`).join('');
  const ultimo = datos[n - 1];
  return `<svg class="svg-grafica linea" width="${ancho}" height="${alto}" viewBox="0 0 ${ancho} ${alto}" role="img"
      aria-label="Ventas por día, de ${escapar(datos[0].titulo)} a ${escapar(ultimo.titulo)}"
      data-ml="${ml}" data-pw="${pw}" data-n="${n}" data-mt="${mt}" data-ph="${ph}">
    ${rejilla}${meses}
    <path class="area" d="${area}"/><path class="trazo" d="${linea}"/>
    <line class="mira" y1="${mt}" y2="${mt + ph}" hidden/>
    <circle class="punto-fin" cx="${x(n - 1)}" cy="${y(ultimo.valor)}" r="4"/>
    <circle class="punto-mira" r="4" hidden/>
    <rect class="hit-linea" x="${ml}" y="${mt}" width="${pw}" height="${ph}" tabindex="0" aria-label="Recorre los días con las flechas"/>
  </svg>`;
}

/** El crosshair de la variante en linea: engancha al dia mas cercano y muestra su globo. */
export function activarLinea(contenedor, datos) {
  const svg = contenedor.querySelector('svg.linea');
  if (!svg) return;
  const ml = +svg.dataset.ml, pw = +svg.dataset.pw, n = +svg.dataset.n, mt = +svg.dataset.mt, ph = +svg.dataset.ph;
  const maximo = Math.max(0, ...datos.map((d) => d.valor));
  const { tope } = escala(maximo);
  const mira = svg.querySelector('.mira'), punto = svg.querySelector('.punto-mira');
  let actual = n - 1;
  const ir = (i, puntero) => {
    actual = Math.min(n - 1, Math.max(0, i));
    const d = datos[actual];
    const px = ml + (actual / (n - 1)) * pw, py = mt + ph - (d.valor / tope) * ph;
    mira.setAttribute('x1', px); mira.setAttribute('x2', px); mira.hidden = false;
    punto.setAttribute('cx', px); punto.setAttribute('cy', py); punto.hidden = false;
    const caja = svg.getBoundingClientRect();
    mostrarGlobo([d.titulo, d.valor ? pesos(d.valor) : 'Sin ventas', ...d.detalle], puntero?.x ?? caja.left + px, puntero?.y ?? caja.top + py);
  };
  const oculta = () => { mira.hidden = true; punto.hidden = true; ocultarGlobo(); };
  const hit = svg.querySelector('.hit-linea');
  hit.addEventListener('pointermove', (e) => {
    const caja = svg.getBoundingClientRect();
    ir(Math.round(((e.clientX - caja.left - ml) / pw) * (n - 1)), { x: e.clientX, y: e.clientY });
  });
  hit.addEventListener('pointerleave', oculta);
  hit.addEventListener('blur', oculta);
  hit.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { ir(actual - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { ir(actual + 1); e.preventDefault(); }
  });
}

/**
 * Barras horizontales de una sola serie: un color, el valor en la punta. El orden ya viene
 * del servidor (de mayor a menor). `items`: [{ nombre, valor, texto, tip }].
 */
export function barrasHorizontales(items) {
  const maximo = Math.max(1, ...items.map((i) => i.valor));
  return `<div class="hbarras">${items.map((i) => `
    <div class="hbarra" data-tip="${escapar(i.tip)}" tabindex="0">
      <span class="hn">${escapar(i.nombre)}</span>
      <span class="hpista"><i style="width:${Math.max(i.valor > 0 ? 0.5 : 0, (i.valor / maximo) * 100)}%"></i></span>
      <span class="hv">${escapar(i.texto)}</span>
    </div>`).join('')}</div>`;
}

/**
 * Parte de un todo: una sola barra apilada con 2 px de aire entre segmentos y debajo la leyenda
 * con importe y porcentaje (la leyenda ES la tabla: nada depende del color). `items`:
 * [{ nombre, valor, color, texto }].
 */
export function apilada(items) {
  const total = suma(items, 'valor');
  if (total <= 0) return '<div class="vacio">Sin ventas en este periodo.</div>';
  const activos = items.filter((i) => i.valor > 0);
  const pct = (v) => ((v / total) * 100).toLocaleString('es-MX', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `<div class="apilada" role="img" aria-label="${escapar(activos.map((i) => `${i.nombre} ${pct(i.valor)}%`).join(', '))}">
      ${activos.map((i) => `<span class="segmento" style="flex:${i.valor};background:${i.color}"
        data-tip="${escapar(`${i.nombre}\n${i.texto}\n${pct(i.valor)}% del total`)}" tabindex="0"></span>`).join('')}
    </div>
    <table class="leyenda"><tbody>${items.map((i) => `
      <tr><td><span class="llave" style="background:${i.color}"></span>${escapar(i.nombre)}</td>
        <td class="num">${escapar(i.texto)}</td><td class="num sec">${i.valor > 0 ? `${pct(i.valor)}%` : '—'}</td></tr>`).join('')}
    </tbody></table>`;
}

/** Tabla simple: `numericas` son los indices de columnas que se alinean a la derecha. */
export function tabla(encabezados, filas, numericas = []) {
  const clase = (i) => (numericas.includes(i) ? ' class="num"' : '');
  return `<table class="tabla"><thead><tr>${encabezados.map((h, i) => `<th${clase(i)}>${escapar(h)}</th>`).join('')}</tr></thead>
    <tbody>${filas.map((f) => `<tr>${f.map((c, i) => `<td${clase(i)}>${escapar(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
