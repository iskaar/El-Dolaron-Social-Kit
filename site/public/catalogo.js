(() => {
  const WHATSAPP = "https://wa.me/524445437754";
  const API = "https://dolarones.eldolaron.com";
  // El mismo ícono del botón de WhatsApp de la portada (index.html).
  // Logo de WhatsApp (Simple Icons, CC0) en círculo blanco: se reconoce de un vistazo.
  const WHATSAPP_ICONO = '<span class="wa-logo" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg></span>';
  // Copia de app/public/categorias.js: el sitio no importa código de otras carpetas.
  const CATEGORIAS = [
    ["", "Todo"], ["ropa", "Ropa y calzado"], ["accesorios", "Bolsas y accesorios"],
    ["belleza", "Belleza y cuidado personal"], ["hogar", "Hogar y cocina"],
    ["jardin", "Jardín y exteriores"], ["electronica", "Electrónica"], ["juguetes", "Juguetes"],
    ["mascotas", "Mascotas"], ["papeleria", "Papelería y libros"], ["despensa", "Despensa"],
    ["deportes", "Deportes"], ["otros", "Otros"],
  ];

  // Los precios llegan en centavos MXN enteros.
  function precio(centavos) {
    const cents = Number(centavos) || 0;
    return new Intl.NumberFormat("es-MX", {
      style: "currency", currency: "MXN",
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
    }).format(cents / 100);
  }

  function consulta(pieza, quiero = "me interesa") {
    const talla = pieza.talla ? ` talla ${pieza.talla}` : "";
    const texto = `Hola, ${quiero} ${pieza.nombre}${talla} (${pieza.codigo}) de ${precio(pieza.precio)}. ¿Sigue disponible?`;
    return `${WHATSAPP}?text=${encodeURIComponent(texto)}`;
  }

  // ?api= solo sirve para desarrollo: únicamente acepta http(s) hacia esta misma máquina.
  function apiBase(search) {
    try {
      const url = new URL(new URLSearchParams(search).get("api"));
      if (/^https?:$/.test(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin;
    } catch {}
    return API;
  }

  // Issue #590: ?pieza=ED-000123 (mismo formato que CODIGO en app/src/catalogo.ts); lo malformado se ignora.
  function codigoDePieza(search) {
    const valor = (new URLSearchParams(search).get("pieza") || "").trim();
    return /^ED-\d{1,10}$/i.test(valor) ? valor.toUpperCase() : "";
  }

  // Apartado y envío (Issue #645). Copia de app/public/venta.js (ANTICIPO_ENVIO, ENVIO_COSTO, ENVIO_GRATIS_DESDE):
  // el sitio no importa de app/. Si allá cambian, cámbialas aquí y en los textos de la ficha.
  const APARTADO = 100_00;
  const ENVIO_COSTO = 99_00;
  const ENVIO_GRATIS_DESDE = 1000_00;
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  // Copia de viernesDeEnvio (app/public/venta.js): viernes en fecha de tienda; el jueves a las 20:00 ya pasó el corte. UTC-6 fijo.
  function viernesDeEnvio(instante) {
    const local = new Date(new Date(instante).getTime() - 6 * 3_600_000);
    const dia = local.getUTCDay();
    let dias = (5 - dia + 7) % 7;
    if (dia === 5 || (dia === 4 && local.getUTCHours() >= 20)) dias += 7;
    local.setUTCDate(local.getUTCDate() + dias);
    return local.toISOString().slice(0, 10);
  }
  // «2026-11-06» → «6 de noviembre»
  const fechaCorta = (iso) => { const [, m, d] = iso.split("-"); return `${Number(d)} de ${MESES[Number(m) - 1]}`; };

  // La línea única de «cómo se compra» de la ficha.
  function lineaApartado(pieza, ahora = Date.now()) {
    const paga = pieza.precio < APARTADO ? "Se paga completa al apartar." : `Apártala con ${precio(APARTADO)} por 7 días.`;
    return `${paga} Recoge en Soledad (11 a 8) o te la enviamos el viernes ${fechaCorta(viernesDeEnvio(ahora))} (envío nacional gratis desde ${precio(ENVIO_GRATIS_DESDE)}; si no, ${precio(ENVIO_COSTO)}).`;
  }

  // Los tres mensajes de la hoja «Lo quiero» (docs/UX-COMPRA.md §4). `opcion`: recoger | envio | preguntar.
  function mensajeQuiero(pieza, opcion, ahora = Date.now()) {
    const talla = pieza.talla ? ` talla ${pieza.talla}` : "";
    const cual = `*${pieza.nombre}${talla}* (${pieza.codigo}) de ${precio(pieza.precio)}`;
    if (opcion === "preguntar") return `Hola, tengo una pregunta sobre ${cual}.`;
    // Bajo $100 no hay "apartado": se paga completa.
    const deja = pieza.precio < APARTADO ? "La pago completa al apartarla" : `Dejo ${precio(APARTADO)} de apartado`;
    if (opcion === "recoger") return `Hola, quiero apartar ${cual}. ${deja} y paso a recogerla a Jardín Hidalgo 129.`;
    return `Hola, quiero apartar ${cual}. ${deja} para el envío del viernes ${fechaCorta(viernesDeEnvio(ahora))} (gratis desde ${precio(ENVIO_GRATIS_DESDE)}; si no, ${precio(ENVIO_COSTO)}). ¿Me pasan los datos para transferir?`;
  }
  const enlaceQuiero = (pieza, opcion, ahora) => `${WHATSAPP}?text=${encodeURIComponent(mensajeQuiero(pieza, opcion, ahora))}`;

  if (typeof module !== "undefined") module.exports = { precio, consulta, apiBase, codigoDePieza, viernesDeEnvio, fechaCorta, lineaApartado, mensajeQuiero, enlaceQuiero };

  // Los precios con su precio de lista tachado, igual en tarjetas y visor.
  function pintarPrecio(nodo, pieza) {
    nodo.textContent = precio(pieza.precio);
    if (pieza.precio_lista > pieza.precio) {
      const lista = document.createElement("s");
      const aviso = document.createElement("span");
      aviso.className = "sr-only";
      aviso.textContent = "Precio de lista ";
      lista.append(aviso, precio(pieza.precio_lista));
      nodo.append(lista);
    }
  }

  // «Los más buscados» (Issue #339): lo de mayor precio que sigue a la venta, en tarjetas como las del catálogo (Issue #630).
  // Si la API falla o trae menos de 3 con foto, la sección se queda oculta.
  async function buscados(seccion) {
    try {
      const response = await fetch(`${apiBase(location.search)}/api/catalogo/destacados?orden=precio`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const { piezas } = await response.json();
      const conFoto = (Array.isArray(piezas) ? piezas : []).filter((p) => /^https?:\/\//.test(p.foto || ""));
      if (conFoto.length < 3) return;
      // Un Worker anterior a #339 ignora ?orden=precio y manda los más vendidos sin `ultima`: no son «los más buscados».
      if (!conFoto.every((p) => typeof p.ultima === "boolean")) return;
      const lista = seccion.querySelector(".wanted-grid");
      for (const pieza of conFoto) {
        const li = document.createElement("li");
        const item = document.createElement("article");
        item.className = "wanted-item";
        item.setAttribute("aria-label", pieza.ultima ? `${pieza.nombre}, última pieza` : pieza.nombre);
        // La foto abre el visor grande (el mismo del catálogo): las fotos de celular se ven recortadas.
        const foto = document.createElement("button");
        foto.type = "button";
        foto.className = "wanted-photo";
        foto.setAttribute("aria-label", `Ver foto completa: ${pieza.nombre}`);
        const img = new Image();
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        // Una foto rota quita su tarjeta; con menos de 3 la sección vuelve a ocultarse.
        if (pieza.recorte) foto.classList.add("con-recorte");
        img.addEventListener("error", () => {
          if (pieza.recorte && img.src === pieza.recorte) { foto.classList.remove("con-recorte"); img.src = pieza.foto; return; }
          li.remove(); if (lista.children.length < 3) seccion.hidden = true;
        });
        img.src = pieza.recorte || pieza.foto;
        const zoom = document.createElement("span");
        zoom.className = "piece-zoom";
        zoom.setAttribute("aria-hidden", "true");
        zoom.textContent = "Ver foto";
        foto.append(img, zoom);
        if (pieza.ultima) {
          // Sello de goma sobre la foto: lo dice el servidor cuando queda una sola pieza.
          const sello = document.createElement("span");
          sello.className = "wanted-stamp";
          sello.setAttribute("aria-hidden", "true");
          sello.textContent = "¡Última pieza!";
          foto.append(sello);
        }
        foto.addEventListener("click", () => abrirVisor(pieza, foto, img));
        const cuerpo = document.createElement("div");
        cuerpo.className = "wanted-body";
        // Marca (lo que vende «calidad americana») o, si no hay, la categoría.
        const rubro = pieza.marca || (CATEGORIAS.find(([k]) => k === pieza.categoria) || [])[1];
        const linea = document.createElement("p");
        linea.className = "piece-brand";
        linea.textContent = rubro && rubro !== "Otros" ? rubro : "";
        const nombre = document.createElement("h3");
        nombre.className = "wanted-name";
        nombre.textContent = pieza.nombre;
        const valor = document.createElement("p");
        valor.className = "wanted-price";
        valor.textContent = precio(pieza.precio);
        if (pieza.precio_lista > pieza.precio) {
          // Precio de lista tachado y el ahorro en pesos, calculado con los mismos centavos que manda la API.
          const antes = document.createElement("span");
          antes.className = "wanted-was";
          const lista = document.createElement("s");
          const aviso = document.createElement("span");
          aviso.className = "sr-only";
          aviso.textContent = "Precio de lista ";
          lista.append(aviso, precio(pieza.precio_lista));
          const ahorro = document.createElement("b");
          ahorro.textContent = `Ahorras ${precio(pieza.precio_lista - pieza.precio)}`;
          antes.append(lista, ahorro);
          valor.append(antes);
        }
        const apartar = document.createElement("a");
        apartar.className = "button button-whatsapp wanted-ask";
        apartar.href = consulta(pieza, "quiero apartar");
        apartar.setAttribute("aria-label", `Apartar por WhatsApp: ${pieza.nombre}`);
        apartar.innerHTML = WHATSAPP_ICONO;
        apartar.append("Apartar por WhatsApp");
        cuerpo.append(linea, nombre, valor, apartar);
        item.append(foto, cuerpo);
        li.append(item);
        lista.append(li);
      }
      seccion.hidden = false;
    } catch {}
  }
  const destacados = typeof document !== "undefined" && document.getElementById("buscados");
  if (destacados) buscados(destacados);
  const root = typeof document !== "undefined" && document.getElementById("catalogo");
  if (!root) return;

  const base = apiBase(location.search);
  // Medición de la ficha (Issue #651): solo evento, código de pieza y origen. text/plain evita la consulta previa de CORS; errores en silencio.
  function evento(nombre, codigo) {
    try {
      const url = `${base}/api/catalogo/evento`;
      const cuerpo = JSON.stringify({ evento: nombre, codigo, origen: "sitio" });
      if (!(navigator.sendBeacon && navigator.sendBeacon(url, cuerpo))) fetch(url, { method: "POST", body: cuerpo, keepalive: true }).catch(() => {});
    } catch {}
  }
  const chips = root.querySelector(".chips");
  const grid = root.querySelector(".catalog-grid");
  const status = root.querySelector(".catalog-status");
  const more = root.querySelector(".catalog-more");
  const fallback = root.querySelector(".catalog-fallback");
  const retry = root.querySelector(".catalog-retry");
  const searchForm = root.querySelector(".catalog-search");
  const searchInput = root.querySelector(".search-input");
  const clearBtn = root.querySelector(".catalog-clear");
  const dialog = root.querySelector(".piece-dialog");
  const dialogClose = root.querySelector(".piece-dialog-close");
  const dialogImg = root.querySelector(".piece-dialog-img");
  const dialogTitle = root.querySelector(".piece-dialog-title");
  const dialogMeta = root.querySelector(".piece-dialog-meta");
  const dialogPrice = root.querySelector(".piece-dialog-price");
  const dialogAsk = root.querySelector(".piece-dialog-ask");
  const fotoBox = root.querySelector(".piece-dialog-photo");
  const selloUltima = root.querySelector(".piece-dialog-stamp");
  const botonZoom = root.querySelector(".ficha-zoom");
  const pista = root.querySelector(".ficha-pista");
  const compra = root.querySelector(".ficha-compra");
  const precioBarra = root.querySelector(".ficha-barprecio");
  const botonQuiero = root.querySelector(".ficha-quiero");
  const botonCompartir = root.querySelector(".ficha-compartir");
  const avisoFicha = root.querySelector(".ficha-aviso");
  const hoja = root.querySelector(".ficha-hoja");
  const hojaCerrar = root.querySelector(".ficha-hoja-cerrar");
  const opciones = [...root.querySelectorAll(".ficha-op")];
  const detras = [".piece-dialog-head", ".piece-dialog-scroll", ".piece-dialog-bar"].map((k) => root.querySelector(k));   // se inactivan con la hoja abierta
  let actual = null;   // pieza que muestra la ficha
  let categoria = "";
  let busqueda = "";
  let deseada = codigoDePieza(location.search);   // pieza a abrir tras la primera carga (#590)
  let focoAnterior = null;
  // Cursor de la última página que SÍ llegó: un fallo reintenta la misma (Issue #241).
  // `pagina` solo por si el sitio se publica antes que la API con cursor: la API nueva lo ignora con `despues`.
  let siguiente = null;
  let proxima = 1;
  let controller = null;
  const TIEMPO = "tiempo";
  let cargado = false;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Morph miniatura → visor con View Transitions (Chrome 111+, Safari 18+, Firefox 144+).
  // Sin soporte o con movimiento reducido, el visor abre y cierra de golpe como hasta ahora.
  const conMorph = typeof document.startViewTransition === "function"
    && typeof matchMedia === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let fotoOrigen = null;   // la <img> de la tarjeta que abrió el visor

  // ---- Ficha: zoom con gestos (Issue #645) ----
  // Doble toque 1× ↔ 2.5×, pellizco entre 1× y 4×, arrastre mueve la foto acercada. Pointer events + transform, sin librería;
  // `touch-action: none` en el contenedor (styles.css) evita que el navegador se quede el gesto o acerque la página (mismo truco que stickers.js, #537).
  const ZOOM_DOBLE = 2.5;
  const ZOOM_MAX = 4;
  const zoom = { s: 1, x: 0, y: 0 };
  const punteros = new Map();   // id → {x, y}
  let pellizco = null;          // {d, s} al empezar con dos dedos
  let toque = null;             // {t, x, y, movido} del dedo que está abajo
  let ultimoToque = null;       // {t, x, y} del toque corto anterior (para el doble)
  const limite = (v, a, b) => Math.min(b, Math.max(a, v));

  function pintarZoom() {
    const r = fotoBox.getBoundingClientRect();
    const mx = (r.width * (zoom.s - 1)) / 2, my = (r.height * (zoom.s - 1)) / 2;
    zoom.x = limite(zoom.x, -mx, mx);
    zoom.y = limite(zoom.y, -my, my);
    dialogImg.style.transform = zoom.s === 1 ? "" : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    fotoBox.classList[zoom.s > 1 ? "add" : "remove"]("acercada");
    if (botonZoom) { botonZoom.textContent = zoom.s > 1 ? "Alejar" : "Acercar"; botonZoom.setAttribute("aria-pressed", String(zoom.s > 1)); }
  }
  // Cambia la escala dejando fijo el punto (px, py), medido desde el centro de la foto.
  function acercarEn(nueva, px, py) {
    nueva = limite(nueva, 1, ZOOM_MAX);
    const k = nueva / zoom.s;
    zoom.x = px - (px - zoom.x) * k;
    zoom.y = py - (py - zoom.y) * k;
    zoom.s = nueva;
    if (nueva === 1) { zoom.x = 0; zoom.y = 0; }
    if (nueva > 1 && pista) pista.hidden = true;
    pintarZoom();
  }
  function reiniciarZoom() {
    if (!fotoBox || !dialogImg) return;
    punteros.clear(); pellizco = null; toque = null; ultimoToque = null;
    zoom.s = 1; zoom.x = 0; zoom.y = 0;
    if (pista) pista.hidden = true;
    pintarZoom();
  }
  const centroDe = () => { const r = fotoBox.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const alternarZoom = (x, y) => { const c = centroDe(); acercarEn(zoom.s > 1 ? 1 : ZOOM_DOBLE, x - c.x, y - c.y); };

  if (fotoBox && dialogImg) {
    fotoBox.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.closest && e.target.closest("button")) return;   // el botón Acercar no es parte del gesto
      punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (typeof fotoBox.setPointerCapture === "function") { try { fotoBox.setPointerCapture(e.pointerId); } catch {} }
      if (punteros.size === 1) toque = { t: e.timeStamp, x: e.clientX, y: e.clientY, movido: false };
      else if (punteros.size === 2) {
        const [a, b] = [...punteros.values()];
        pellizco = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: zoom.s };
        if (toque) toque.movido = true;
      }
    });
    fotoBox.addEventListener("pointermove", (e) => {
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
      const corto = toque && !toque.movido && e.type === "pointerup" && e.timeStamp - toque.t < 300;
      if (!corto) { ultimoToque = null; toque = null; return; }
      if (ultimoToque && e.timeStamp - ultimoToque.t < 300 && Math.hypot(toque.x - ultimoToque.x, toque.y - ultimoToque.y) < 30) {
        ultimoToque = null;
        alternarZoom(toque.x, toque.y);
      } else ultimoToque = { t: e.timeStamp, x: toque.x, y: toque.y };
      toque = null;
    };
    fotoBox.addEventListener("pointerup", soltar);
    fotoBox.addEventListener("pointercancel", soltar);
  }
  // Sin gestos (teclado, lector de pantalla): el mismo cambio 1× ↔ 2.5× con un botón.
  if (botonZoom) botonZoom.addEventListener("click", () => { const c = centroDe(); alternarZoom(c.x, c.y); });

  // Pista de 3 s la primera vez de la sesión; sin almacenamiento, siempre.
  function mostrarPista() {
    if (!pista) return;
    try { if (sessionStorage.getItem("ficha-pista")) return; sessionStorage.setItem("ficha-pista", "1"); } catch {}
    pista.hidden = false;
    setTimeout(() => { pista.hidden = true; }, 3000);
  }

  // ---- Ficha: «Lo quiero», hoja de tres opciones y Compartir ----
  function abrirHoja() {
    if (!hoja || !actual) return;
    evento("lo_quiero", actual.codigo);
    const ahora = Date.now();
    for (const op of opciones) op.href = enlaceQuiero(actual, op.getAttribute("data-op"), ahora);
    hoja.hidden = false;
    for (const nodo of detras) if (nodo) nodo.inert = true;
    if (opciones[0] && typeof opciones[0].focus === "function") opciones[0].focus();
  }
  function cerrarHoja(devolverFoco) {
    if (!hoja || hoja.hidden) return;
    hoja.hidden = true;
    for (const nodo of detras) if (nodo) nodo.inert = false;
    if (devolverFoco && botonQuiero && typeof botonQuiero.focus === "function") botonQuiero.focus();
  }
  async function compartir() {
    if (!actual) return;
    evento("compartir", actual.codigo);
    const url = `https://eldolaron.com/?pieza=${encodeURIComponent(actual.codigo)}`;
    try {
      if (navigator.share) { await navigator.share({ title: actual.nombre, text: `${actual.nombre} en El Dolarón`, url }); return; }
    } catch (error) { if (error && error.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(url); avisoFicha.textContent = "Enlace copiado"; }
    catch { avisoFicha.textContent = `Copia este enlace: ${url}`; }
  }
  if (botonQuiero) botonQuiero.addEventListener("click", abrirHoja);
  if (hojaCerrar) hojaCerrar.addEventListener("click", () => cerrarHoja(true));
  if (hoja) hoja.addEventListener("click", (ev) => { if (ev.target === hoja) cerrarHoja(true); });
  if (botonCompartir) botonCompartir.addEventListener("click", compartir);
  for (const op of opciones) op.addEventListener("click", () => { if (actual) evento(op.getAttribute("data-op") === "preguntar" ? "preguntar" : `apartar_${op.getAttribute("data-op")}`, actual.codigo); });
  if (dialogAsk) dialogAsk.addEventListener("click", () => { if (actual) evento("whatsapp_abierto", actual.codigo); });

  function abrirVisor(pieza, disparador, img) {
    if (!dialog) return;
    focoAnterior = disparador;
    fotoOrigen = img || null;
    if (dialogTitle) dialogTitle.textContent = pieza.nombre;
    actual = pieza;
    evento("ficha_abierta", pieza.codigo);
    cerrarHoja(false);
    reiniciarZoom();
    if (dialogImg) { dialogImg.src = pieza.foto; dialogImg.alt = pieza.nombre; }   // siempre la foto completa, no el recorte
    if (dialogMeta) {
      // Marca (o categoría si no hay) · talla · código
      const rubro = pieza.marca || (CATEGORIAS.find(([k]) => k === pieza.categoria) || [])[1];
      dialogMeta.textContent = [rubro && rubro !== "Otros" ? rubro : "", pieza.talla ? `Talla ${pieza.talla}` : "", pieza.codigo].filter(Boolean).join(" · ");
    }
    if (dialogPrice) {
      pintarPrecio(dialogPrice, pieza);
      if (pieza.precio_lista > pieza.precio) {
        const ahorro = document.createElement("b");
        ahorro.textContent = `Ahorras ${precio(pieza.precio_lista - pieza.precio)}`;
        dialogPrice.append(ahorro);
      }
    }
    if (precioBarra) precioBarra.textContent = precio(pieza.precio);
    if (selloUltima) selloUltima.hidden = pieza.ultima !== true;   // lo decide el servidor; sin el campo no se muestra nada
    if (compra) compra.textContent = lineaApartado(pieza);
    if (avisoFicha) avisoFicha.textContent = "";
    if (dialogAsk) {
      dialogAsk.href = consulta(pieza);
      dialogAsk.setAttribute("aria-label", `Preguntar por WhatsApp: ${pieza.nombre}`);
    }
    const abrir = () => {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.open = true;
      if (dialogClose && typeof dialogClose.focus === "function") dialogClose.focus();
      mostrarPista();
    };
    if (!conMorph || !fotoOrigen || !fotoOrigen.style) { abrir(); return; }
    // El nombre debe ser único en pantalla: la miniatura lo lleva solo en la captura «antes»;
    // la foto del visor lo tiene en CSS y solo está en pantalla con el diálogo abierto.
    fotoOrigen.style.viewTransitionName = "pieza-foto";
    document.startViewTransition(async () => {
      fotoOrigen.style.viewTransitionName = "";
      abrir();
      // La foto grande necesita tamaño antes de la captura «después»; tope de 250 ms para no congelar la página.
      await Promise.race([dialogImg && typeof dialogImg.decode === "function" ? dialogImg.decode().catch(() => {}) : null, new Promise((r) => setTimeout(r, 250))]);
    });
  }

  // La portada (stickers.js) abre el mismo visor con este evento.
  if (typeof document.addEventListener === "function") document.addEventListener("dolaron:ver-pieza", (ev) => { const d = ev.detail || {}; if (d.pieza) abrirVisor(d.pieza, d.disparador, d.img); });

  function cerrarVisor() {
    if (!conMorph || !fotoOrigen || !fotoOrigen.style) { dialog.close(); return; }
    const origen = fotoOrigen;
    const t = document.startViewTransition(() => { dialog.close(); origen.style.viewTransitionName = "pieza-foto"; });
    t.finished.then(() => { origen.style.viewTransitionName = ""; });
  }

  if (dialogClose && dialog) {
    dialogClose.addEventListener("click", () => {
      if (typeof dialog.close === "function") cerrarVisor();
      else { dialog.open = false; if (focoAnterior && typeof focoAnterior.focus === "function") focoAnterior.focus(); }
    });
    // Esc y el fondo cierran con el mismo morph.
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); if (hoja && !hoja.hidden) cerrarHoja(true); else cerrarVisor(); });
    dialog.addEventListener("click", (ev) => { if (ev.target === dialog && typeof dialog.close === "function") cerrarVisor(); });
    dialog.addEventListener("close", () => {
      cerrarHoja(false);
      reiniciarZoom();
      if (focoAnterior && typeof focoAnterior.focus === "function") focoAnterior.focus();
    });
  }

  function tarjeta(pieza) {
    const li = el("li", "piece");
    const conFoto = /^https?:\/\//.test(pieza.foto || "");
    const photo = el(conFoto ? "button" : "div", "piece-photo");
    if (conFoto) {
      if (pieza.recorte) photo.classList.add("con-recorte");
      photo.type = "button";
      photo.setAttribute("aria-label", `Ver foto completa: ${pieza.nombre}`);
      const img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        if (pieza.recorte && img.src === pieza.recorte) { photo.classList.remove("con-recorte"); img.src = pieza.foto; }
        else img.remove();
      });
      img.src = pieza.recorte || pieza.foto;
      const zoom = el("span", "piece-zoom", "Ver foto");
      zoom.setAttribute("aria-hidden", "true");
      photo.append(img, zoom);
      photo.addEventListener("click", () => abrirVisor(pieza, photo, img));
    }
    const body = el("div", "piece-body");
    // ponytail: la ropa se captura sin nombre propio; hasta tener marca/equipo dice «Ropa americana».
    body.append(el("h3", "", pieza.nombre === "Ropa" ? "Ropa americana" : pieza.nombre));
    if (pieza.marca) body.append(el("p", "piece-brand", pieza.marca));
    if (pieza.talla) body.append(el("p", "piece-size", `Talla ${pieza.talla}`));
    const price = el("p", "piece-price");
    pintarPrecio(price, pieza);
    const ask = el("a", "button button-whatsapp piece-link");
    ask.innerHTML = WHATSAPP_ICONO;
    ask.append("Preguntar por WhatsApp");
    ask.href = consulta(pieza);
    ask.setAttribute("aria-label", `Preguntar por WhatsApp: ${pieza.nombre}`);
    body.append(price, ask);
    li.append(photo, body);
    return li;
  }

  async function cargar(reiniciar) {
    if (controller) controller.abort();
    const mio = (controller = new AbortController());
    // 15 s y se da por fallida: una red lenta no deja «Cargando…» para siempre.
    const reloj = setTimeout(() => mio.abort(TIEMPO), 15000);
    if (reiniciar) { siguiente = null; proxima = 1; grid.replaceChildren(); }
    const pedida = proxima;
    fallback.hidden = true;
    more.hidden = true;
    status.textContent = "Cargando piezas…";
    root.setAttribute("aria-busy", "true");
    const params = new URLSearchParams();
    if (pedida > 1) params.set("pagina", pedida);
    if (siguiente) params.set("despues", siguiente);
    if (categoria) params.set("categoria", categoria);
    if (busqueda) params.set("q", busqueda);
    try {
      const response = await fetch(`${base}/api/catalogo?${params}`, { signal: mio.signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.piezas)) throw new Error("Respuesta inesperada");
      if (mio.signal.aborted) throw new Error("Cancelada");
      cargado = true;
      proxima = pedida + 1;
      chips.hidden = false;
      if (searchForm) searchForm.hidden = false;
      siguiente = data.siguiente || null;
      grid.append(...data.piezas.map(tarjeta));
      if (deseada) {   // Issue #590: solo coincidencia exacta; si no está, queda el mensaje de búsqueda vacía
        const pieza = data.piezas.find((x) => x.codigo === deseada);
        deseada = "";
        if (pieza) abrirVisor(pieza, null, null);
      }
      more.hidden = !data.hay_mas;
      status.textContent = grid.children.length
        ? `${grid.children.length} de ${Number(data.total) || grid.children.length} piezas`
        : busqueda
          ? `No encontramos piezas para «${busqueda}». Prueba otra palabra o pregunta por WhatsApp.`
          : "Por ahora no hay piezas en esta categoría. Prueba otra o pregunta por WhatsApp.";
    } catch (error) {
      if (mio.signal.aborted && mio.signal.reason !== TIEMPO) return;   // otra búsqueda la reemplazó
      status.textContent = "";
      if (!cargado) {
        chips.hidden = true;
        if (searchForm) searchForm.hidden = true;
      }
      if (!grid.children.length) fallback.hidden = false;
      else { more.hidden = false; status.textContent = "No pudimos cargar más piezas. Intenta de nuevo."; }
    } finally {
      clearTimeout(reloj);
      if (controller === mio) root.removeAttribute("aria-busy");
    }
  }

  if (searchForm && searchInput) {
    searchForm.addEventListener("submit", (ev) => {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      busqueda = String(searchInput.value || "").trim();
      if (clearBtn) clearBtn.hidden = !busqueda;
      cargar(true);
    });
  }
  if (clearBtn && searchInput) {
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      busqueda = "";
      clearBtn.hidden = true;
      cargar(true);
    });
  }

  for (const [clave, nombre] of CATEGORIAS) {
    const chip = el("button", "chip", nombre);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(clave === categoria));
    chip.addEventListener("click", () => {
      if (clave === categoria) return;
      categoria = clave;
      const cambiar = () => {
        for (const other of chips.children) other.setAttribute("aria-pressed", String(other === chip));
        cargar(true);
      };
      if (conMorph) document.startViewTransition(cambiar); else cambiar();
    });
    chips.append(chip);
  }
  more.addEventListener("click", () => cargar(false));
  retry.addEventListener("click", () => cargar(true));
  if (deseada && searchInput) {   // la búsqueda del servidor ya incluye `codigo`
    busqueda = deseada;
    searchInput.value = deseada;
    if (clearBtn) clearBtn.hidden = false;
  } else deseada = "";
  cargar(true);
})();
