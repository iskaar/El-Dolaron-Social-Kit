// Guía «¿Cómo se hace?» de la caja (Issue #818): un solo render para la página /ayuda y para el cuadro de /caja.
// Sin red: nada de fetch. Todo el texto entra con textContent (nunca como HTML).
import { CATEGORIAS, ESCENARIOS } from './ayuda-contenido.js';

/** Minúsculas y sin acentos: «Devolución» y «devolucion» son lo mismo para el buscador. */
export const sinAcentos = (texto) => String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Palabras de lo que escribió el cajero; «tarjetas» y «tarjeta» se buscan igual. */
export const palabrasDe = (texto) => sinAcentos(texto).split(/[^a-z0-9$#*]+/).filter(Boolean)
  .map((p) => (p.length > 3 ? p.replace(/(es|s)$/, '') : p));

/**
 * Escenarios que contienen TODAS las palabras (en título, palabras, pasos, ojo o si_no), los más claros primero:
 * título 3, sinónimos 2, el resto 1. Sin texto, todos en su orden. `categoria` '' = todas.
 */
export function buscar(escenarios, texto = '', categoria = '') {
  const dentro = categoria ? escenarios.filter((e) => e.categoria === categoria) : escenarios;
  const palabras = palabrasDe(texto);
  if (!palabras.length) return [...dentro];
  const puntuados = [];
  dentro.forEach((e, orden) => {
    const titulo = sinAcentos(e.titulo);
    const sinonimos = sinAcentos((e.palabras ?? []).join(' '));
    const resto = sinAcentos([...(e.pasos ?? []), e.ojo, e.si_no].filter(Boolean).join(' '));
    let puntos = 0;
    for (const p of palabras) {
      const mejor = titulo.includes(p) ? 3 : sinonimos.includes(p) ? 2 : resto.includes(p) ? 1 : 0;
      if (!mejor) return;
      puntos += mejor;
    }
    puntuados.push({ e, puntos, orden });
  });
  return puntuados.sort((a, b) => b.puntos - a.puntos || a.orden - b.orden).map((x) => x.e);
}

/** Parte un texto en pedazos normales y pedazos entre «» (lo que dice la pantalla: va en negritas). */
export function partesDe(entrada) {
  const texto = String(entrada ?? '');
  const partes = [];
  let desde = 0;
  for (const m of texto.matchAll(/«([^»]+)»/g)) {
    if (m.index > desde) partes.push({ texto: texto.slice(desde, m.index), ui: false });
    partes.push({ texto: m[0], ui: true });
    desde = m.index + m[0].length;
  }
  if (desde < texto.length) partes.push({ texto: texto.slice(desde), ui: false });
  return partes;
}

const ESTILOS = `
.guia-ayuda { font: 18px/1.5 system-ui, -apple-system, sans-serif; color: #1a1f2b; text-align: left; }
.guia-ayuda *, .guia-ayuda *::before, .guia-ayuda *::after { box-sizing: border-box; }
.guia-ayuda .guia-etiqueta { display: block; margin: 0 0 6px; font-size: 16px; font-weight: 700; color: #16366B; }
.guia-ayuda input.guia-q { display: block; width: 100%; padding: 12px 14px; font-size: 18px; border: 2px solid #16366B; border-radius: 10px; background: #fff; color: inherit; }
.guia-ayuda .guia-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.guia-ayuda .guia-chips button { min-height: 44px; padding: 6px 14px; font-size: 16px; border: 1px solid #16366B; background: #fff; color: #16366B; border-radius: 999px; cursor: pointer; }
.guia-ayuda .guia-chips button[aria-pressed="true"] { background: #16366B; color: #fff; }
.guia-ayuda .guia-cuenta { margin: 4px 0 12px; font-size: 15px; color: #5b6478; }
.guia-ayuda h2, .guia-ayuda h3 { margin: 18px 0 8px; font-size: 19px; color: #16366B; }
.guia-ayuda details { margin: 0 0 10px; background: #fff; border: 1px solid #dfe3ea; border-radius: 12px; }
.guia-ayuda summary { display: flex; align-items: center; gap: 8px; min-height: 52px; padding: 8px 14px; cursor: pointer; }
.guia-ayuda summary > h3, .guia-ayuda summary > h4 { display: inline; margin: 0; font-size: 18px; font-weight: 700; color: #1a1f2b; }
.guia-ayuda .guia-tema { margin-left: auto; font-size: 13px; color: #5b6478; white-space: nowrap; }
.guia-ayuda .guia-cuerpo { padding: 0 16px 14px; }
.guia-ayuda ol { margin: 6px 0 10px; padding-left: 1.5em; }
.guia-ayuda li { margin: 8px 0; }
.guia-ayuda strong.guia-ui { color: #16366B; }
.guia-ayuda .guia-ojo, .guia-ayuda .guia-sino { margin: 10px 0; padding: 8px 12px; border-radius: 8px; }
.guia-ayuda .guia-ojo { background: #FFF6D9; border-left: 4px solid #FFD447; }
.guia-ayuda .guia-sino { background: #eef1f6; }
.guia-ayuda .guia-regla { margin: 10px 0; padding: 8px 12px; border-radius: 8px; border: 2px dashed #D72B32; color: #7a1519; font-weight: 700; }
.guia-ayuda .guia-ver { margin: 10px 0; font-size: 16px; }
.guia-ayuda .guia-ver button { margin: 4px 6px 4px 0; min-height: 40px; padding: 4px 12px; font: inherit; font-size: 15px; border: 1px solid #16366B; background: #fff; color: #16366B; border-radius: 8px; cursor: pointer; text-align: left; }
.guia-ayuda .guia-final { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid #dfe3ea; font-size: 16px; color: #5b6478; }
.guia-ayuda .guia-nada { padding: 14px; background: #fff; border: 1px solid #dfe3ea; border-radius: 12px; }
.guia-ayuda :focus-visible { outline: 3px solid #D72B32; outline-offset: 2px; }
@media (max-width: 480px) { .guia-ayuda summary { flex-wrap: wrap; } .guia-ayuda .guia-tema { margin-left: 0; } }
`;

function asegurarEstilos(doc) {
  if (doc.getElementById('ayuda-estilos')) return;
  const estilo = doc.createElement('style');
  estilo.id = 'ayuda-estilos';
  estilo.textContent = ESTILOS;
  doc.head.append(estilo);
}

export const FINAL = '¿No se resolvió? Toca «Ayuda» y viene el encargado.';
export const REGLA = 'Regla de la tienda: pregunta al encargado.';

/**
 * Pinta la guía dentro de `contenedor`: buscador, temas y tarjetas.
 * @param {HTMLElement} contenedor
 * @param {{ ancla?: string, conHash?: boolean, nivel?: number }} [opciones] ancla = id del escenario que se abre;
 *   conHash = la página (y no el cuadro de la caja) actualiza #id; nivel = el título de cada tema (los escenarios van un nivel abajo).
 */
export function montarAyuda(contenedor, { ancla = '', conHash = false, nivel = 2 } = {}) {
  const doc = contenedor.ownerDocument;
  asegurarEstilos(doc);
  const porId = new Map(ESCENARIOS.map((e) => [e.id, e]));
  const nombreTema = new Map(CATEGORIAS.map((c) => [c.id, c.titulo]));
  const estado = { texto: '', categoria: '' };

  const h = (tag, atributos = {}, ...hijos) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(atributos)) if (v != null) el.setAttribute(k, v);
    for (const hijo of hijos.flat()) if (hijo != null) el.append(hijo);
    return el;
  };
  const conNegritas = (texto) => partesDe(texto).map((p) => (p.ui ? h('strong', { class: 'guia-ui' }, p.texto) : p.texto));

  const q = h('input', { class: 'guia-q', id: 'guia-q', type: 'search', autocomplete: 'off', placeholder: 'Ej.: etiqueta, tarjeta, devolución' });
  const chips = h('div', { class: 'guia-chips', role: 'group', 'aria-label': 'Temas' });
  const cuenta = h('p', { class: 'guia-cuenta', role: 'status', 'aria-live': 'polite' });
  const lista = h('div', { class: 'guia-lista' });
  contenedor.replaceChildren(h('div', { class: 'guia-ayuda' },
    h('label', { class: 'guia-etiqueta', for: 'guia-q' }, '¿Qué pasó? Escribe una palabra'), q, chips, cuenta, lista));

  function tarjeta(e, conTema) {
    const ver = (e.ver ?? []).map((id) => porId.get(id)).filter(Boolean);
    const detalle = h('details', { id: `ayuda-${e.id}`, 'data-id': e.id },
      h('summary', {}, h(`h${nivel + 1}`, {}, e.titulo), conTema ? h('span', { class: 'guia-tema' }, nombreTema.get(e.categoria)) : null),
      h('div', { class: 'guia-cuerpo' },
        h('ol', {}, e.pasos.map((paso) => h('li', {}, conNegritas(paso)))),
        e.ojo ? h('p', { class: 'guia-ojo' }, h('strong', {}, 'Ojo: '), conNegritas(e.ojo)) : null,
        e.si_no ? h('p', { class: 'guia-sino' }, h('strong', {}, 'Si no se resuelve: '), conNegritas(e.si_no)) : null,
        e.pendiente?.startsWith('¿') ? h('p', { class: 'guia-regla' }, REGLA) : null,   // «Falta en la caja:» es para el desarrollador, no para el cajero
        ver.length ? h('p', { class: 'guia-ver' }, 'Ver también: ', ver.map((v) => h('button', { type: 'button', 'data-ver': v.id }, v.titulo))) : null,
        h('p', { class: 'guia-final' }, conNegritas(FINAL))));
    if (conHash) detalle.addEventListener('toggle', () => {
      if (detalle.open) { try { history.replaceState(null, '', `#${e.id}`); } catch { /* sin historial */ } }
    });
    return detalle;
  }

  function pintar(abrirId = '') {
    for (const b of chips.children) b.setAttribute('aria-pressed', String(b.dataset.tema === estado.categoria));
    const encontrados = buscar(ESCENARIOS, estado.texto, estado.categoria);
    cuenta.textContent = encontrados.length === 1 ? '1 respuesta' : `${encontrados.length} respuestas`;
    if (!encontrados.length) {
      lista.replaceChildren(h('p', { class: 'guia-nada' }, 'No hay respuestas para eso. Prueba con otra palabra o toca «Ayuda» y viene el encargado.'));
      return;
    }
    const buscando = palabrasDe(estado.texto).length > 0;
    const grupos = buscando || estado.categoria ? [[null, encontrados]]
      : CATEGORIAS.map((c) => [c, encontrados.filter((e) => e.categoria === c.id)]).filter(([, es]) => es.length);
    lista.replaceChildren(...grupos.flatMap(([categoria, escenarios]) => [
      categoria ? h(`h${nivel}`, {}, categoria.titulo) : null,
      ...escenarios.map((e) => tarjeta(e, buscando && !estado.categoria)),
    ]));
    if (abrirId) lista.querySelector(`[data-id="${abrirId}"]`)?.setAttribute('open', '');
    else if (buscando && encontrados.length === 1) lista.querySelector('details')?.setAttribute('open', '');
  }

  const temas = [{ id: '', titulo: 'Todo' }, ...CATEGORIAS];
  chips.replaceChildren(...temas.map((c) => h('button', { type: 'button', 'data-tema': c.id, 'aria-pressed': 'false' }, c.titulo)));
  chips.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-tema]');
    if (!b) return;
    estado.categoria = b.dataset.tema;
    pintar();
  });
  q.addEventListener('input', () => { estado.texto = q.value; pintar(); });
  // Un lector de códigos escribe aquí y manda Enter: Enter solo lleva a la primera respuesta, nunca toca la venta.
  q.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    lista.querySelector('summary')?.focus();
  });
  lista.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-ver]');
    if (b) abrir(b.dataset.ver);
  });

  /** Abre el escenario `id` (quita el filtro si lo escondía), lo enseña y deja el foco en su título. */
  function abrir(id) {
    const e = porId.get(id);
    if (!e) return false;
    estado.texto = ''; estado.categoria = ''; q.value = '';
    pintar(id);
    const detalle = lista.querySelector(`[data-id="${id}"]`);
    detalle?.scrollIntoView?.({ block: 'start' });
    detalle?.querySelector('summary')?.focus({ preventScroll: true });
    return true;
  }

  pintar();
  if (ancla && porId.has(ancla)) abrir(ancla);
  if (conHash) addEventListener('hashchange', () => abrir(location.hash.slice(1)));
  return { abrir, enfocar: () => q.focus() };
}
