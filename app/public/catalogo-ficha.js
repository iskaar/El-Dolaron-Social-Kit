// Catálogo completo y ficha de pieza del portal (Issue #649, docs/UX-COMPRA.md §4).
//
// COPIA DELIBERADA de site/public/catalogo.js (Issue #645): el sitio nunca importa de app/ ni la app de site/.
// Si cambian el enlace de «Lo quiero», la línea de apartado o el zoom, cámbialos en los dos lados.
// venta.js no se sirve en el host del portal (lo prueba portal.test.ts), por eso las constantes y viernesDeEnvio
// se copian aquí; src/catalogo-ficha.test.ts falla si se separan de venta.js o de categorias.js.

const WHATSAPP = 'https://wa.me/524445437754';

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
 */
export function iniciarCatalogo() {
  const root = document.getElementById('catalogo');
  const dialog = document.getElementById('ficha-dialogo');
  if (!root || !dialog) return;
  const q = (sel) => root.querySelector(sel);
  const f = (sel) => dialog.querySelector(sel);
  const chips = q('.chips'), grid = q('.catalogo-grid'), status = q('.catalogo-estado'), more = q('.catalogo-mas');
  const fallback = q('.catalogo-falla'), retry = q('.catalogo-reintentar');
  const searchForm = q('.catalogo-buscar'), searchInput = q('.catalogo-buscar input'), clearBtn = q('.catalogo-limpiar');
  const dialogClose = f('.ficha-cerrar'), dialogImg = f('.ficha-img'), dialogTitle = f('.ficha-titulo');
  const dialogMeta = f('.ficha-meta'), dialogPrice = f('.ficha-precio');
  const fotoBox = f('.ficha-foto'), selloUltima = f('.ficha-sello'), botonZoom = f('.ficha-zoom'), pista = f('.ficha-pista');
  const compra = f('.ficha-compra'), precioBarra = f('.ficha-barprecio'), botonQuiero = f('.ficha-quiero');
  const botonCompartir = f('.ficha-compartir'), avisoFicha = f('.ficha-aviso');
  let actual = null, categoria = '', busqueda = '', focoAnterior = null, controller = null, cargado = false;
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

  // ?pieza=: está en la primera página o se pide por código (la búsqueda del servidor incluye `codigo`). Si no aparece, no pasa nada.
  async function abrirDeseada(piezas) {
    const codigo = deseada; deseada = '';
    if (!codigo) return;
    let pieza = piezas.find((x) => x.codigo === codigo);
    if (!pieza) { try { pieza = (await pedir(new URLSearchParams({ q: codigo }))).piezas.find((x) => x.codigo === codigo); } catch { /* sin la pieza, queda el catálogo */ } }
    if (pieza && !dialog.open) abrirFicha(pieza, null);
  }

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
    const params = new URLSearchParams();
    if (siguiente) params.set('despues', siguiente);
    if (categoria) params.set('categoria', categoria);
    if (busqueda) params.set('q', busqueda);
    try {
      const data = await pedir(params, mio.signal);
      if (mio.signal.aborted) throw new Error('Cancelada');
      const primera = !cargado;
      cargado = true;
      chips.hidden = false;
      searchForm.hidden = false;
      siguiente = data.siguiente || null;
      grid.append(...data.piezas.map(tarjeta));
      more.hidden = !data.hay_mas;
      status.textContent = grid.children.length ? '' : busqueda
        ? `No encontramos piezas para «${busqueda}». Prueba otra palabra o pregunta por WhatsApp.`
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
    chip.setAttribute('aria-pressed', String(clave === categoria));
    chip.addEventListener('click', () => {
      if (clave === categoria) return;
      categoria = clave;
      for (const otro of chips.children) otro.setAttribute('aria-pressed', String(otro === chip));
      cargar(true);
    });
    chips.append(chip);
  }
  more.addEventListener('click', () => cargar(false));
  retry.addEventListener('click', () => cargar(true));
  cargar(true);
}
