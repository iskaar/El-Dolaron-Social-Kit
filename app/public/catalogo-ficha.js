// Catálogo completo y ficha de pieza del portal (Issue #649, docs/UX-COMPRA.md §4).
//
// COPIA DELIBERADA de site/public/catalogo.js (Issue #645): el sitio nunca importa de app/ ni la app de site/.
// Si cambian el enlace de «Lo quiero», la línea de apartado, el zoom o los filtros (#672), cámbialos en los dos lados.
// venta.js no se sirve en el host del portal (lo prueba portal.test.ts), por eso las constantes y viernesDeEnvio
// se copian aquí; src/catalogo-ficha.test.ts falla si se separan de venta.js o de categorias.js.

export const WHATSAPP = 'https://wa.me/524445437754';

// Copia de app/public/categorias.js (CATEGORIAS), con «Todo» al inicio.
export const CATEGORIAS = [
  ['', 'Todo'], ['ropa', 'Ropa y calzado'], ['accesorios', 'Bolsas y accesorios'],
  ['belleza', 'Belleza y cuidado personal'], ['hogar', 'Hogar y cocina'],
  ['jardin', 'Jardín y exteriores'], ['electronica', 'Electrónica'], ['juguetes', 'Juguetes'],
  ['mascotas', 'Mascotas'], ['papeleria', 'Papelería y libros'], ['despensa', 'Despensa'],
  ['deportes', 'Deportes'], ['otros', 'Otros'],
];

// Copia de app/public/venta.js (ANTICIPO, ENVIO_COSTO, ENVIO_GRATIS_DESDE), en centavos.
export const APARTADO = 100_00;
export const ENVIO_COSTO = 99_00;
export const ENVIO_GRATIS_DESDE = 1000_00;
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Los precios llegan en centavos MXN enteros.
export function precio(centavos) {
  const cents = Number(centavos) || 0;
  return new Intl.NumberFormat('es-MX', {
    style: 'currency', currency: 'MXN',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
  }).format(cents / 100);
}

// ?pieza=ED-000123 (Issue #590, mismo formato que CODIGO en app/src/catalogo.ts); lo malformado se ignora.
export function codigoDePieza(search) {
  const valor = (new URLSearchParams(search).get('pieza') || '').trim();
  return /^ED-\d{1,10}$/i.test(valor) ? valor.toUpperCase() : '';
}

// Filtros del catálogo (Issue #672). COPIA DELIBERADA en site/public/catalogo.js: cambia los dos lados.
// Bandas de precio en centavos: [parámetro de la API, valor, rótulo]. «Hasta» es inclusivo; «$200 o más» es precio_min.
export const BANDAS = [
  ['precio_max', 5000, 'Hasta $50'], ['precio_max', 8000, 'Hasta $80'], ['precio_max', 10000, 'Hasta $100'],
  ['precio_max', 15000, 'Hasta $150'], ['precio_min', 20000, '$200 o más'],
];
const DIAS_NUEVO = 7;   // «Llegó esta semana»
const TALLA_MAX = 30;   // mismo tope que la API
const PARAMS_FILTRO = ['categoria', 'talla', 'precio_min', 'precio_max', 'dias'];

// Estado de los filtros desde la URL (?categoria=&talla=&precio_max=&dias=); lo desconocido o malformado se ignora.
export function filtrosDeUrl(search) {
  const u = new URLSearchParams(search);
  const categoria = u.get('categoria') || '';
  return {
    categoria: CATEGORIAS.some(([clave]) => clave === categoria) ? categoria : '',
    talla: (u.get('talla') || '').trim().replace(/\s+/g, ' ').slice(0, TALLA_MAX),
    banda: BANDAS.findIndex(([k, v]) => u.get(k) === String(v)),   // -1 = ninguna
    dias: u.get('dias') === String(DIAS_NUEVO),
  };
}
// Los mismos nombres sirven para la URL de la página y para la consulta a la API.
export function paramsDeFiltros(elegido) {
  const p = new URLSearchParams();
  if (elegido.categoria) p.set('categoria', elegido.categoria);
  if (elegido.talla) p.set('talla', elegido.talla);
  if (elegido.banda >= 0) p.set(BANDAS[elegido.banda][0], String(BANDAS[elegido.banda][1]));
  if (elegido.dias) p.set('dias', String(DIAS_NUEVO));
  return p;
}
// La búsqueda de la página con los filtros puestos: conserva cualquier otro parámetro (?pieza=, referidos…).
export function busquedaConFiltros(search, elegido) {
  const u = new URLSearchParams(search);
  for (const k of PARAMS_FILTRO) u.delete(k);
  for (const [k, v] of paramsDeFiltros(elegido)) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

// Copia de viernesDeEnvio (app/public/venta.js): viernes en fecha de tienda; el jueves a las 20:00 ya pasó el corte. UTC-6 fijo.
export function viernesDeEnvio(instante) {
  const local = new Date(new Date(instante).getTime() - 6 * 3_600_000);
  const dia = local.getUTCDay();
  let dias = (5 - dia + 7) % 7;
  if (dia === 5 || (dia === 4 && local.getUTCHours() >= 20)) dias += 7;
  local.setUTCDate(local.getUTCDate() + dias);
  return local.toISOString().slice(0, 10);
}
// «2026-11-06» → «6 de noviembre»
export const fechaCorta = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)} de ${MESES[Number(m) - 1]}`; };

// La línea única de «cómo se compra» de la ficha.
export function lineaApartado(pieza, ahora = Date.now()) {
  const paga = pieza.precio < APARTADO ? 'Se paga completa al apartar.' : `Apártala con ${precio(APARTADO)} por 7 días.`;
  return `${paga} Recoge en Soledad (11 a 8) o te la enviamos el viernes ${fechaCorta(viernesDeEnvio(ahora))} (envío nacional gratis desde ${precio(ENVIO_GRATIS_DESDE)}; si no, ${precio(ENVIO_COSTO)}).`;
}

// «Lo quiero» (docs/UX-COMPRA.md §4): un solo mensaje corto; el equipo pregunta recoger o envío en el chat.
export const enlaceLoQuiero = (pieza) => `${WHATSAPP}?text=${encodeURIComponent(`Quiero producto ${pieza.codigo}`)}`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const rubroDe = (pieza) => pieza.marca || (CATEGORIAS.find(([k]) => k === pieza.categoria) || [])[1];
const TIEMPO = 'tiempo';

/**
 * Arma el catálogo en <section id="catalogo"> y la ficha en <dialog id="ficha-dialogo"> (portal.html).
 * `opciones.apartar(pieza)` (#668) abre la hoja de «Apartar aquí» (apartar.js); sin ella el botón no se muestra.
 * Devuelve { abrir(codigo, conHoja) }: abre la ficha de una pieza (y su hoja) al volver del registro.
 */
export function iniciarCatalogo(opciones = {}) {
  const root = document.getElementById('catalogo');
  const dialog = document.getElementById('ficha-dialogo');
  if (!root || !dialog) return;
  const q = (sel) => root.querySelector(sel);
  const f = (sel) => dialog.querySelector(sel);
  const chips = q('.chips'), grid = q('.catalogo-grid'), status = q('.catalogo-estado'), more = q('.catalogo-mas');
  const fallback = q('.catalogo-falla'), retry = q('.catalogo-reintentar');
  const searchForm = q('.catalogo-buscar'), searchInput = q('.catalogo-buscar input'), clearBtn = q('.catalogo-limpiar');
  const filtros = q('.catalogo-filtros'), tallaBox = q('.catalogo-talla'), tallaSelect = q('.catalogo-talla-select'), chipsFiltros = q('.chips-filtros');
  const dialogClose = f('.ficha-cerrar'), dialogImg = f('.ficha-img'), dialogTitle = f('.ficha-titulo');
  const dialogMeta = f('.ficha-meta'), dialogPrice = f('.ficha-precio');
  const fotoBox = f('.ficha-foto'), selloUltima = f('.ficha-sello'), botonZoom = f('.ficha-zoom'), pista = f('.ficha-pista');
  const compra = f('.ficha-compra'), precioBarra = f('.ficha-barprecio'), botonQuiero = f('.ficha-quiero');
  const botonCompartir = f('.ficha-compartir'), avisoFicha = f('.ficha-aviso'), botonApartar = f('.ficha-apartar');
  const elegido = filtrosDeUrl(location.search);   // categoría, talla, banda de precio y «Llegó esta semana» (#672)
  let actual = null, busqueda = '', focoAnterior = null, controller = null, cargado = false;
  let deseada = codigoDePieza(location.search);   // pieza a abrir tras la primera carga (#590)
  let siguiente = null;                           // cursor de la última página que SÍ llegó: un fallo reintenta la misma (#241)

  // ---- Zoom con gestos (copia de la ficha del sitio, Issue #645) ----
  // Doble toque 1× ↔ 2.5×, pellizco entre 1× y 4×, arrastre mueve la foto acercada. Pointer events + transform, sin librería;
  // `touch-action: none` en el contenedor (portal.css) evita que el navegador se quede el gesto o acerque la página.
  const ZOOM_DOBLE = 2.5, ZOOM_MAX = 4;
  const zoom = { s: 1, x: 0, y: 0 };
  const punteros = new Map();   // id → {x, y}
  let pellizco = null, toque = null, ultimoToque = null;
  const limite = (v, a, b) => Math.min(b, Math.max(a, v));
  function pintarZoom() {
    const r = fotoBox.getBoundingClientRect();
    const mx = (r.width * (zoom.s - 1)) / 2, my = (r.height * (zoom.s - 1)) / 2;
    zoom.x = limite(zoom.x, -mx, mx);
    zoom.y = limite(zoom.y, -my, my);
    dialogImg.style.transform = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    fotoBox.classList.toggle('acercada', zoom.s > 1);
    botonZoom.textContent = zoom.s > 1 ? 'Alejar' : 'Acercar';
    botonZoom.setAttribute('aria-pressed', String(zoom.s > 1));
  }
  // Cambia la escala dejando fijo el punto (px, py), medido desde el centro de la foto.
  function acercarEn(nueva, px, py) {
    nueva = limite(nueva, 1, ZOOM_MAX);
    const k = nueva / zoom.s;
    zoom.x = px - (px - zoom.x) * k;
    zoom.y = py - (py - zoom.y) * k;
    zoom.s = nueva;
    if (nueva === 1) { zoom.x = 0; zoom.y = 0; }
    if (nueva > 1) pista.hidden = true;
    pintarZoom();
  }
  function reiniciarZoom() {
    punteros.clear(); pellizco = null; toque = null; ultimoToque = null;
    zoom.s = 1; zoom.x = 0; zoom.y = 0;
    pista.hidden = true;
    pintarZoom();
  }
  const centroDe = () => { const r = fotoBox.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const alternarZoom = (x, y) => { const c = centroDe(); acercarEn(zoom.s > 1 ? 1 : ZOOM_DOBLE, x - c.x, y - c.y); };

  fotoBox.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;   // el botón Acercar no es parte del gesto
    punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { fotoBox.setPointerCapture(e.pointerId); } catch { /* sin captura: el gesto sigue dentro de la foto */ }
    if (punteros.size === 1) toque = { t: e.timeStamp, x: e.clientX, y: e.clientY, movido: false };
    else if (punteros.size === 2) {
      const [a, b] = [...punteros.values()];
      pellizco = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: zoom.s };
      if (toque) toque.movido = true;
    }
  });
  fotoBox.addEventListener('pointermove', (e) => {
    const antes = punteros.get(e.pointerId);
    if (!antes) return;
    const nuevo = { x: e.clientX, y: e.clientY };
    if (toque && Math.hypot(nuevo.x - toque.x, nuevo.y - toque.y) > 10) toque.movido = true;
    if (punteros.size === 2 && pellizco) {
      const viejo = [...punteros.values()];
      const m0 = { x: (viejo[0].x + viejo[1].x) / 2, y: (viejo[0].y + viejo[1].y) / 2 };
      punteros.set(e.pointerId, nuevo);
      const [a, b] = [...punteros.values()];
      const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const c = centroDe();
      acercarEn(pellizco.s * (Math.hypot(a.x - b.x, a.y - b.y) / pellizco.d), m1.x - c.x, m1.y - c.y);
      zoom.x += m1.x - m0.x; zoom.y += m1.y - m0.y;
      pintarZoom();
    } else {
      punteros.set(e.pointerId, nuevo);
      if (zoom.s > 1) { zoom.x += nuevo.x - antes.x; zoom.y += nuevo.y - antes.y; pintarZoom(); }
    }
  });
  const soltar = (e) => {
    if (!punteros.delete(e.pointerId)) return;
    pellizco = null;
    if (punteros.size > 0) { if (toque) toque.movido = true; return; }   // quedó un dedo: sigue como arrastre, no cuenta como toque
    const corto = toque && !toque.movido && e.type === 'pointerup' && e.timeStamp - toque.t < 300;
    if (!corto) { ultimoToque = null; toque = null; return; }
    if (ultimoToque && e.timeStamp - ultimoToque.t < 300 && Math.hypot(toque.x - ultimoToque.x, toque.y - ultimoToque.y) < 30) {
      ultimoToque = null;
      alternarZoom(toque.x, toque.y);
    } else ultimoToque = { t: e.timeStamp, x: toque.x, y: toque.y };
    toque = null;
  };
  fotoBox.addEventListener('pointerup', soltar);
  fotoBox.addEventListener('pointercancel', soltar);
  // Sin gestos (teclado, lector de pantalla): el mismo cambio 1× ↔ 2.5× con un botón.
  botonZoom.addEventListener('click', () => { const c = centroDe(); alternarZoom(c.x, c.y); });

  // Pista de 3 s la primera vez de la sesión; sin almacenamiento, siempre.
  function mostrarPista() {
    try { if (sessionStorage.getItem('ficha-pista')) return; sessionStorage.setItem('ficha-pista', '1'); } catch { /* sin almacenamiento */ }
    pista.hidden = false;
    setTimeout(() => { pista.hidden = true; }, 3000);
  }

  // Medición de la ficha (Issue #651): solo evento, código de pieza y origen. Mismo host, sin CORS; errores en silencio.
  function evento(nombre, codigo) {
    try {
      const cuerpo = JSON.stringify({ evento: nombre, codigo, origen: 'portal' });
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/catalogo/evento', cuerpo))) fetch('/api/catalogo/evento', { method: 'POST', body: cuerpo, keepalive: true }).catch(() => {});
    } catch { /* medir nunca rompe la ficha */ }
  }

  // ---- «Lo quiero» (enlace directo a WhatsApp) y Compartir ----
  async function compartir() {
    if (!actual) return;
    evento('compartir', actual.codigo);
    const url = `https://eldolaron.com/?pieza=${encodeURIComponent(actual.codigo)}`;
    try {
      if (navigator.share) { await navigator.share({ title: actual.nombre, text: `${actual.nombre} en El Dolarón`, url }); return; }
    } catch (error) { if (error?.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(url); avisoFicha.textContent = 'Enlace copiado'; }
    catch { avisoFicha.textContent = `Copia este enlace: ${url}`; }
  }
  botonQuiero.addEventListener('click', () => { if (actual) evento('lo_quiero', actual.codigo); });   // el enlace lo abre el navegador
  botonCompartir.addEventListener('click', compartir);
  botonApartar.hidden = !opciones.apartar;
  botonApartar.addEventListener('click', () => { if (actual) opciones.apartar(actual); });

  function abrirFicha(pieza, disparador) {
    focoAnterior = disparador;
    actual = pieza;
    evento('ficha_abierta', pieza.codigo);
    reiniciarZoom();
    dialogTitle.textContent = pieza.nombre;
    dialogImg.src = pieza.foto; dialogImg.alt = pieza.nombre;   // siempre la foto completa, no el recorte
    const rubro = rubroDe(pieza);
    dialogMeta.textContent = [rubro && rubro !== 'Otros' ? rubro : '', pieza.talla ? `Talla ${pieza.talla}` : '', pieza.codigo].filter(Boolean).join(' · ');
    pintarPrecio(dialogPrice, pieza);
    if (pieza.precio_lista > pieza.precio) dialogPrice.append(el('b', '', `Ahorras ${precio(pieza.precio_lista - pieza.precio)}`));
    precioBarra.textContent = precio(pieza.precio);
    selloUltima.hidden = pieza.ultima !== true;   // lo decide el servidor; sin el campo no se muestra nada
    compra.textContent = lineaApartado(pieza);
    avisoFicha.textContent = '';
    botonQuiero.href = enlaceLoQuiero(pieza);
    dialog.showModal();
    dialogClose.focus();
    mostrarPista();
  }
  dialogClose.addEventListener('click', () => dialog.close());
  // Esc cierra la ficha (comportamiento nativo del dialog); el fondo (fuera del cuadro) también.
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    reiniciarZoom();
    if (focoAnterior?.isConnected) focoAnterior.focus();
  });

  // Precio con su precio de lista tachado.
  function pintarPrecio(nodo, pieza) {
    nodo.textContent = precio(pieza.precio);
    if (pieza.precio_lista > pieza.precio) {
      const lista = el('s');
      lista.append(el('span', 'solo-lectores', 'Precio de lista '), precio(pieza.precio_lista));
      nodo.append(lista);
    }
  }

  // La tarjeta entera abre la ficha, nunca WhatsApp.
  function tarjeta(pieza) {
    const li = el('li');
    const boton = el('button', 'pieza');
    boton.type = 'button';
    boton.setAttribute('aria-label', `Ver ${pieza.nombre}, ${precio(pieza.precio)}${pieza.ultima ? ', última pieza' : ''}`);
    const foto = el('span', 'pieza-foto');
    const img = new Image();
    img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    img.addEventListener('error', () => {
      if (pieza.recorte && img.src === pieza.recorte) img.src = pieza.foto; else img.remove();
    });
    img.src = pieza.recorte || pieza.foto;
    foto.append(img);
    if (pieza.ultima) foto.append(el('span', 'pieza-sello', '¡Última pieza!'));
    const rubro = rubroDe(pieza);
    const nombre = el('span', 'pieza-nombre', pieza.nombre === 'Ropa' ? 'Ropa americana' : pieza.nombre);
    const detalle = el('span', 'pieza-detalle', [rubro && rubro !== 'Otros' ? rubro : '', pieza.talla ? `Talla ${pieza.talla}` : ''].filter(Boolean).join(' · '));
    const valor = el('strong', 'pieza-precio');
    pintarPrecio(valor, pieza);
    boton.append(foto, nombre, detalle, valor);
    boton.addEventListener('click', () => abrirFicha(pieza, boton));
    li.append(boton);
    return li;
  }

  async function pedir(params, signal) {
    const r = await fetch(`/api/catalogo?${params}`, { signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data?.piezas)) throw new Error('Respuesta inesperada');
    return data;
  }

  // Una pieza por código: está entre las ya cargadas o se pide (la búsqueda del servidor incluye `codigo`). Si no aparece, no pasa nada.
  async function abrirPorCodigo(codigo, piezas = []) {
    let pieza = piezas.find((x) => x.codigo === codigo);
    if (!pieza) { try { pieza = (await pedir(new URLSearchParams({ q: codigo }))).piezas.find((x) => x.codigo === codigo); } catch { /* sin la pieza, queda el catálogo */ } }
    if (pieza && !dialog.open) abrirFicha(pieza, null);
    return pieza;
  }
  // ?pieza= (#590): se abre tras la primera carga.
  async function abrirDeseada(piezas) {
    const codigo = deseada; deseada = '';
    if (codigo) await abrirPorCodigo(codigo, piezas);
  }

  // ---- Filtros (#672): chips de categoría, de precio y «Llegó esta semana», más el menú de talla ----
  const hayFiltros = () => Boolean(elegido.talla) || elegido.banda >= 0 || elegido.dias;
  const chipsCategoria = [];   // [clave, chip]
  const chipsExtra = [];       // [() => ¿activo?, chip]
  function pintar() {
    for (const [clave, chip] of chipsCategoria) chip.setAttribute('aria-pressed', String(clave === elegido.categoria));
    for (const [activo, chip] of chipsExtra) chip.setAttribute('aria-pressed', String(activo()));
    tallaSelect.value = elegido.talla;
  }
  // Menú de tallas con las que hay en la categoría y búsqueda actuales; si la elegida ya no está, se conserva para no esconder el filtro.
  function pintarTallas(tallas) {
    const lista = elegido.talla && !tallas.includes(elegido.talla) ? [elegido.talla, ...tallas] : tallas;
    tallaSelect.replaceChildren(...[['', 'Todas las tallas'], ...lista.map((t) => [t, t])].map(([valor, texto]) => { const o = el('option', '', texto); o.value = valor; return o; }));
    tallaSelect.value = elegido.talla;
    tallaBox.hidden = lista.length === 0;
  }
  // Cada cambio de filtro vuelve a la página 1, queda en la URL (compartir y botón Atrás) y recarga; la búsqueda `q` no se toca.
  function aplicar(cambio) {
    cambio();
    const nueva = busquedaConFiltros(location.search, elegido);
    if (nueva !== location.search) history.pushState(null, '', `${location.pathname}${nueva}${location.hash}`);
    pintar();
    cargar(true);
  }
  addEventListener('popstate', () => { Object.assign(elegido, filtrosDeUrl(location.search)); pintar(); cargar(true); });

  async function cargar(reiniciar) {
    controller?.abort();
    const mio = (controller = new AbortController());
    // 15 s y se da por fallida: una red lenta no deja «Cargando…» para siempre.
    const reloj = setTimeout(() => mio.abort(TIEMPO), 15000);
    if (reiniciar) { siguiente = null; grid.replaceChildren(); }
    fallback.hidden = true;
    more.hidden = true;
    status.textContent = 'Cargando piezas…';
    root.setAttribute('aria-busy', 'true');
    const params = paramsDeFiltros(elegido);
    if (siguiente) params.set('despues', siguiente);
    if (busqueda) params.set('q', busqueda);
    if (reiniciar) params.set('tallas', '1');   // el menú de tallas se arma con la primera página de cada búsqueda
    try {
      const data = await pedir(params, mio.signal);
      if (mio.signal.aborted) throw new Error('Cancelada');
      const primera = !cargado;
      cargado = true;
      chips.hidden = false;
      searchForm.hidden = false;
      // Una API anterior a #672 no manda `tallas` ni filtra: sin ella no se muestran filtros que no hacen nada.
      if (reiniciar) { filtros.hidden = !Array.isArray(data.tallas); if (!filtros.hidden) pintarTallas(data.tallas); }
      siguiente = data.siguiente || null;
      grid.append(...data.piezas.map(tarjeta));
      more.hidden = !data.hay_mas;
      status.textContent = grid.children.length ? `${grid.children.length} de ${Number(data.total) || grid.children.length} piezas` : busqueda
        ? `No encontramos piezas para «${busqueda}»${hayFiltros() ? ' con esos filtros' : ''}. Prueba otra palabra o pregunta por WhatsApp.`
        : hayFiltros()
          ? 'No hay piezas con esos filtros. Quita alguno para ver más.'
          : 'Por ahora no hay piezas en esta categoría. Prueba otra o pregunta por WhatsApp.';
      if (primera) abrirDeseada(data.piezas);
    } catch {
      if (mio.signal.aborted && mio.signal.reason !== TIEMPO) return;   // otra búsqueda la reemplazó
      status.textContent = '';
      if (!cargado) { chips.hidden = true; searchForm.hidden = true; }
      if (!grid.children.length) fallback.hidden = false;
      else { more.hidden = false; status.textContent = 'No pudimos cargar más piezas. Intenta de nuevo.'; }
    } finally {
      clearTimeout(reloj);
      if (controller === mio) root.removeAttribute('aria-busy');
    }
  }

  searchForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    busqueda = searchInput.value.trim();
    clearBtn.hidden = !busqueda;
    cargar(true);
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = ''; busqueda = ''; clearBtn.hidden = true;
    cargar(true);
  });
  for (const [clave, nombre] of CATEGORIAS) {
    const chip = el('button', 'chip', nombre);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(clave === elegido.categoria));
    chip.addEventListener('click', () => {
      if (clave === elegido.categoria) return;
      aplicar(() => { elegido.categoria = clave; elegido.talla = ''; });   // las tallas dependen de la categoría
    });
    chipsCategoria.push([clave, chip]);
    chips.append(chip);
  }
  // Un filtro de precio a la vez; tocar el activo lo quita. «Llegó esta semana» se combina con todo.
  function chipFiltro(texto, activo, cambio) {
    const chip = el('button', 'chip', texto);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(activo()));
    chip.addEventListener('click', () => aplicar(cambio));
    chipsExtra.push([activo, chip]);
    chipsFiltros.append(chip);
  }
  chipFiltro('Llegó esta semana', () => elegido.dias, () => { elegido.dias = !elegido.dias; });
  BANDAS.forEach(([, , rotulo], i) => chipFiltro(rotulo, () => elegido.banda === i, () => { elegido.banda = elegido.banda === i ? -1 : i; }));
  tallaSelect.addEventListener('change', () => aplicar(() => { elegido.talla = tallaSelect.value; }));
  more.addEventListener('click', () => cargar(false));
  retry.addEventListener('click', () => cargar(true));
  cargar(true);
  return { async abrir(codigo, conHoja) { const pieza = await abrirPorCodigo(codigo); if (pieza && conHoja) opciones.apartar?.(pieza); } };
}
