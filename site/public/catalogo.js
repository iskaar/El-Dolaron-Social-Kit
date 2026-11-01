(() => {
  const WHATSAPP = "https://wa.me/524445437754";
  const API = "https://dolarones.eldolaron.com";
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

  // Filtros del catálogo (Issue #672). COPIA DELIBERADA en app/public/catalogo-ficha.js: cambia los dos lados.
  // Bandas de precio en centavos: [parámetro de la API, valor, rótulo]. «Hasta» es inclusivo; «$200 o más» es precio_min.
  const BANDAS = [
    ["precio_max", 5000, "Hasta $50"], ["precio_max", 8000, "Hasta $80"], ["precio_max", 10000, "Hasta $100"],
    ["precio_max", 15000, "Hasta $150"], ["precio_min", 20000, "$200 o más"],
  ];
  const DIAS_NUEVO = 7;   // «Llegó esta semana»
  const TALLA_MAX = 30;   // mismo tope que la API
  const PARAMS_FILTRO = ["categoria", "talla", "precio_min", "precio_max", "dias"];

  // Estado de los filtros desde la URL (?categoria=&talla=&precio_max=&dias=); lo desconocido o malformado se ignora.
  function filtrosDeUrl(search) {
    const u = new URLSearchParams(search);
    const categoria = u.get("categoria") || "";
    return {
      categoria: CATEGORIAS.some(([clave]) => clave === categoria) ? categoria : "",
      talla: (u.get("talla") || "").trim().replace(/\s+/g, " ").slice(0, TALLA_MAX),
      banda: BANDAS.findIndex(([k, v]) => u.get(k) === String(v)),   // -1 = ninguna
      dias: u.get("dias") === String(DIAS_NUEVO),
    };
  }
  // Los mismos nombres sirven para la URL de la página y para la consulta a la API.
  function paramsDeFiltros(elegido) {
    const p = new URLSearchParams();
    if (elegido.categoria) p.set("categoria", elegido.categoria);
    if (elegido.talla) p.set("talla", elegido.talla);
    if (elegido.banda >= 0) p.set(BANDAS[elegido.banda][0], String(BANDAS[elegido.banda][1]));
    if (elegido.dias) p.set("dias", String(DIAS_NUEVO));
    return p;
  }
  // La búsqueda de la página con los filtros puestos: conserva ?pieza=, ?api= y cualquier otro parámetro.
  function busquedaConFiltros(search, elegido) {
    const u = new URLSearchParams(search);
    for (const k of PARAMS_FILTRO) u.delete(k);
    for (const [k, v] of paramsDeFiltros(elegido)) u.set(k, v);
    const s = u.toString();
    return s ? `?${s}` : "";
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

  // «Lo quiero» (docs/UX-COMPRA.md §4): un solo mensaje corto; el equipo pregunta recoger o envío en el chat.
  const enlaceLoQuiero = (pieza) => `${WHATSAPP}?text=${encodeURIComponent(`Quiero producto ${pieza.codigo}`)}`;

  if (typeof module !== "undefined") module.exports = { precio, apiBase, codigoDePieza, viernesDeEnvio, fechaCorta, lineaApartado, enlaceLoQuiero, BANDAS, filtrosDeUrl, paramsDeFiltros, busquedaConFiltros };

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

  // Piezas de las dos listas (Issue #648): sello «¡Última pieza!», línea «Disponible» y botón «Lo quiero».
  // El botón de la tarjeta abre la ficha; WhatsApp se abre desde la ficha.
  function crearSello() {
    const sello = document.createElement("span");
    sello.className = "wanted-stamp";
    sello.setAttribute("aria-hidden", "true");
    sello.textContent = "¡Última pieza!";
    return sello;
  }
  function lineaDisponible() {
    const linea = document.createElement("p");
    linea.className = "piece-disp";
    linea.textContent = "Disponible";
    return linea;
  }
  function botonQuieroTarjeta(pieza, clase) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = `button piece-quiero ${clase}`.trim();
    boton.textContent = "Lo quiero";
    boton.setAttribute("aria-label", `Lo quiero: ${pieza.nombre}${pieza.ultima === true ? ", última pieza" : ""}`);
    return boton;
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
        // Toda la tarjeta abre la ficha; la foto ya no es un botón aparte.
        const foto = document.createElement("div");
        foto.className = "wanted-photo";
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
        foto.append(img);
        if (pieza.ultima) foto.append(crearSello());   // lo dice el servidor cuando queda una sola pieza
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
        const quiero = botonQuieroTarjeta(pieza, "wanted-ask");
        cuerpo.append(linea, nombre, valor, lineaDisponible(), quiero);
        item.addEventListener("click", () => abrirVisor(pieza, quiero, img));
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
  const filtros = root.querySelector(".catalog-filters");
  const tallaBox = root.querySelector(".filter-size");
  const tallaSelect = root.querySelector(".filter-size-select");
  const chipsFiltros = root.querySelector(".chips-filters");
  const dialog = root.querySelector(".piece-dialog");
  const dialogClose = root.querySelector(".piece-dialog-close");
  const dialogImg = root.querySelector(".piece-dialog-img");
  const dialogTitle = root.querySelector(".piece-dialog-title");
  const dialogMeta = root.querySelector(".piece-dialog-meta");
  const dialogPrice = root.querySelector(".piece-dialog-price");
  const fotoBox = root.querySelector(".piece-dialog-photo");
  const selloUltima = root.querySelector(".piece-dialog-stamp");
  const botonZoom = root.querySelector(".ficha-zoom");
  const pista = root.querySelector(".ficha-pista");
  const compra = root.querySelector(".ficha-compra");
  const precioBarra = root.querySelector(".ficha-barprecio");
  const botonQuiero = root.querySelector(".ficha-quiero");
  const botonCompartir = root.querySelector(".ficha-compartir");
  const avisoFicha = root.querySelector(".ficha-aviso");
  let actual = null;   // pieza que muestra la ficha
  const elegido = filtrosDeUrl(location.search);   // categoría, talla, banda de precio y «Llegó esta semana» (Issue #672)
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

  // ---- Ficha: «Lo quiero» (enlace directo a WhatsApp) y Compartir ----
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
  if (botonQuiero) botonQuiero.addEventListener("click", () => { if (actual) evento("lo_quiero", actual.codigo); });   // el enlace lo abre el navegador
  if (botonCompartir) botonCompartir.addEventListener("click", compartir);

  function abrirVisor(pieza, disparador, img) {
    if (!dialog) return;
    focoAnterior = disparador;
    fotoOrigen = img || null;
    if (dialogTitle) dialogTitle.textContent = pieza.nombre;
    actual = pieza;
    evento("ficha_abierta", pieza.codigo);
    reiniciarZoom();
    if (dialogImg) { if (pieza.foto) dialogImg.src = pieza.foto; else dialogImg.removeAttribute("src"); dialogImg.alt = pieza.nombre; }   // siempre la foto completa, no el recorte
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
    if (botonQuiero) botonQuiero.href = enlaceLoQuiero(pieza);
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
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); cerrarVisor(); });
    dialog.addEventListener("click", (ev) => { if (ev.target === dialog && typeof dialog.close === "function") cerrarVisor(); });
    dialog.addEventListener("close", () => {
      reiniciarZoom();
      if (focoAnterior && typeof focoAnterior.focus === "function") focoAnterior.focus();
    });
  }

  function tarjeta(pieza) {
    const li = el("li", "piece");
    const conFoto = /^https?:\/\//.test(pieza.foto || "");
    const photo = el("div", "piece-photo");
    let img = null;
    if (conFoto) {
      if (pieza.recorte) photo.classList.add("con-recorte");
      img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        if (pieza.recorte && img.src === pieza.recorte) { photo.classList.remove("con-recorte"); img.src = pieza.foto; }
        else img.remove();
      });
      img.src = pieza.recorte || pieza.foto;
      photo.append(img);
    }
    if (pieza.ultima === true) photo.append(crearSello());
    const body = el("div", "piece-body");
    // ponytail: la ropa se captura sin nombre propio; hasta tener marca/equipo dice «Ropa americana».
    body.append(el("h3", "", pieza.nombre === "Ropa" ? "Ropa americana" : pieza.nombre));
    if (pieza.marca) body.append(el("p", "piece-brand", pieza.marca));
    if (pieza.talla) body.append(el("p", "piece-size", `Talla ${pieza.talla}`));
    const price = el("p", "piece-price");
    pintarPrecio(price, pieza);
    const quiero = botonQuieroTarjeta(pieza, "");
    body.append(price, lineaDisponible(), quiero);
    li.append(photo, body);
    // Toda la tarjeta abre la ficha; el foco vuelve al botón al cerrarla.
    li.addEventListener("click", () => abrirVisor(pieza, quiero, img));
    return li;
  }

  // ---- Filtros (Issue #672): chips de categoría, de precio y «Llegó esta semana», más el menú de talla ----
  const hayFiltros = () => Boolean(elegido.talla) || elegido.banda >= 0 || elegido.dias;
  const chipsCategoria = [];   // [clave, chip]
  const chipsExtra = [];       // [() => ¿activo?, chip]

  function pintar() {
    for (const [clave, chip] of chipsCategoria) chip.setAttribute("aria-pressed", String(clave === elegido.categoria));
    for (const [activo, chip] of chipsExtra) chip.setAttribute("aria-pressed", String(activo()));
    if (tallaSelect) tallaSelect.value = elegido.talla;
  }
  // Menú de tallas con las que hay en la categoría y búsqueda actuales; si la elegida ya no está, se conserva para no esconder el filtro.
  function pintarTallas(tallas) {
    if (!tallaSelect) return;
    const lista = elegido.talla && !tallas.includes(elegido.talla) ? [elegido.talla, ...tallas] : tallas;
    tallaSelect.replaceChildren(...[["", "Todas las tallas"], ...lista.map((t) => [t, t])].map(([valor, texto]) => { const o = el("option", "", texto); o.value = valor; return o; }));
    tallaSelect.value = elegido.talla;
    if (tallaBox) tallaBox.hidden = lista.length === 0;
  }
  // Cada cambio de filtro vuelve a la página 1, queda en la URL (compartir y botón Atrás) y recarga; la búsqueda `q` no se toca.
  function aplicar(cambio) {
    cambio();
    if (typeof history !== "undefined" && typeof history.pushState === "function") {
      const nueva = busquedaConFiltros(location.search, elegido);
      if (nueva !== location.search) history.pushState(null, "", `${location.pathname}${nueva}${location.hash}`);
    }
    pintar();
    cargar(true);
  }
  if (typeof addEventListener === "function") addEventListener("popstate", () => { Object.assign(elegido, filtrosDeUrl(location.search)); pintar(); cargar(true); });

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
    const params = paramsDeFiltros(elegido);
    if (pedida > 1) params.set("pagina", pedida);
    if (siguiente) params.set("despues", siguiente);
    if (busqueda) params.set("q", busqueda);
    if (reiniciar) params.set("tallas", "1");   // el menú de tallas se arma con la primera página de cada búsqueda
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
      // Una API anterior a #672 no manda `tallas` ni filtra: sin ella no se muestran filtros que no hacen nada.
      if (reiniciar && filtros) { filtros.hidden = !Array.isArray(data.tallas); if (!filtros.hidden) pintarTallas(data.tallas); }
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
          ? `No encontramos piezas para «${busqueda}»${hayFiltros() ? " con esos filtros" : ""}. Prueba otra palabra o pregunta por WhatsApp.`
          : hayFiltros()
            ? "No hay piezas con esos filtros. Quita alguno para ver más."
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
    chip.setAttribute("aria-pressed", String(clave === elegido.categoria));
    chip.addEventListener("click", () => {
      if (clave === elegido.categoria) return;
      const cambiar = () => aplicar(() => { elegido.categoria = clave; elegido.talla = ""; });   // las tallas dependen de la categoría
      if (conMorph) document.startViewTransition(cambiar); else cambiar();
    });
    chipsCategoria.push([clave, chip]);
    chips.append(chip);
  }
  // Un filtro de precio a la vez; tocar el activo lo quita. «Llegó esta semana» se combina con todo.
  function chipFiltro(texto, activo, cambio) {
    const chip = el("button", "chip", texto);
    chip.type = "button";
    chip.setAttribute("aria-pressed", String(activo()));
    chip.addEventListener("click", () => aplicar(cambio));
    chipsExtra.push([activo, chip]);
    if (chipsFiltros) chipsFiltros.append(chip);
  }
  chipFiltro("Llegó esta semana", () => elegido.dias, () => { elegido.dias = !elegido.dias; });
  BANDAS.forEach(([, , rotulo], i) => chipFiltro(rotulo, () => elegido.banda === i, () => { elegido.banda = elegido.banda === i ? -1 : i; }));
  if (tallaSelect) tallaSelect.addEventListener("change", () => aplicar(() => { elegido.talla = tallaSelect.value; }));
  more.addEventListener("click", () => cargar(false));
  retry.addEventListener("click", () => cargar(true));
  if (deseada && searchInput) {   // la búsqueda del servidor ya incluye `codigo`
    busqueda = deseada;
    searchInput.value = deseada;
    if (clearBtn) clearBtn.hidden = false;
  } else deseada = "";
  cargar(true);
})();
