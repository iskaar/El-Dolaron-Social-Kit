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

  if (typeof module !== "undefined") module.exports = { precio, consulta, apiBase, codigoDePieza };

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

  function abrirVisor(pieza, disparador, img) {
    if (!dialog) return;
    focoAnterior = disparador;
    fotoOrigen = img || null;
    if (dialogTitle) dialogTitle.textContent = pieza.nombre;
    if (dialogImg) { dialogImg.src = pieza.foto; dialogImg.alt = pieza.nombre; }
    if (dialogMeta) {
      dialogMeta.textContent = [pieza.marca, pieza.talla ? `Talla ${pieza.talla}` : "", pieza.codigo].filter(Boolean).join(" · ");
    }
    if (dialogPrice) pintarPrecio(dialogPrice, pieza);
    if (dialogAsk) {
      dialogAsk.href = consulta(pieza);
      dialogAsk.setAttribute("aria-label", `Preguntar por WhatsApp: ${pieza.nombre}`);
    }
    const abrir = () => {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.open = true;
      if (dialogClose && typeof dialogClose.focus === "function") dialogClose.focus();
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
