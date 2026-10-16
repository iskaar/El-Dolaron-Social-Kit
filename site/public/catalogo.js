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

  function consulta(pieza) {
    const talla = pieza.talla ? ` talla ${pieza.talla}` : "";
    const texto = `Hola, me interesa ${pieza.nombre}${talla} (${pieza.codigo}) de ${precio(pieza.precio)}. ¿Sigue disponible?`;
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

  if (typeof module !== "undefined") module.exports = { precio, consulta, apiBase };

  // Portada: las piezas más vendidas (o más nuevas) como estampas. Si la API falla
  // o trae menos de 4, se queda el collage fijo. ponytail: posiciones fijas para 5; la etiqueta de ropa ocupa la esquina libre.
  async function destacados(arte) {
    try {
      const response = await fetch(`${apiBase(location.search)}/api/catalogo?categoria=ropa`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const { piezas } = await response.json();
      if (!Array.isArray(piezas) || piezas.length < 4) return;
      const capa = document.createElement("div");
      capa.className = "stickers";
      for (const pieza of piezas.slice(0, 4)) {
        if (!/^https?:\/\//.test(pieza.foto || "")) continue;
        const a = document.createElement("a");
        a.className = "sticker";
        a.href = consulta(pieza);
        a.setAttribute("aria-label", `Preguntar por WhatsApp: ${pieza.nombre}, ${precio(pieza.precio)}`);
        const img = new Image();
        img.alt = "";
        img.decoding = "async";
        img.src = pieza.foto;
        const etiqueta = document.createElement("span");
        etiqueta.className = "sticker-price";
        etiqueta.textContent = precio(pieza.precio);
        if (pieza.precio_lista > pieza.precio) {
          const lista = document.createElement("s");
          const aviso = document.createElement("span");
          aviso.className = "sr-only";
          aviso.textContent = "Precio de lista ";
          lista.append(aviso, precio(pieza.precio_lista));
          etiqueta.append(lista);
        }
        a.append(img, etiqueta);
        capa.append(a);
      }
      // Solo cambia el collage cuando las fotos ya cargaron: nunca deja marcos vacíos.
      const espera = new Promise((listo) => setTimeout(listo, 6000));
      await Promise.race([Promise.allSettled([...capa.querySelectorAll("img")].map((img) => img.decode().catch(() => img.closest("a").remove()))), espera]);
      for (const img of capa.querySelectorAll("img")) if (!img.complete || !img.naturalWidth) img.closest("a").remove();
      if (capa.children.length < 4) return;
      arte.append(capa);
      arte.classList.add("en-vivo");
    } catch {}
  }
  // Pausar la cinta que corre (Issue #241, WCAG «pausar, detener, ocultar»).
  const pausa = typeof document !== "undefined" && document.querySelector(".ticker-pause");
  if (pausa) pausa.addEventListener("click", () => {
    const pausada = pausa.closest(".ticker").classList.toggle("pausada");
    pausa.setAttribute("aria-pressed", String(pausada));
  });
  const arte = typeof document !== "undefined" && document.querySelector(".hero-art");
  if (arte) destacados(arte);
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

  function pintarPrecio(nodo, pieza) {
    nodo.textContent = precio(pieza.precio);
    if (pieza.precio_lista > pieza.precio) {
      const lista = el("s", "", precio(pieza.precio_lista));
      lista.prepend(el("span", "sr-only", "Precio de lista "));
      nodo.append(lista);
    }
  }

  function abrirVisor(pieza, disparador) {
    if (!dialog) return;
    focoAnterior = disparador;
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
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.open = true;
    if (dialogClose && typeof dialogClose.focus === "function") dialogClose.focus();
  }

  if (dialogClose && dialog) {
    dialogClose.addEventListener("click", () => {
      if (typeof dialog.close === "function") dialog.close();
      else { dialog.open = false; if (focoAnterior && typeof focoAnterior.focus === "function") focoAnterior.focus(); }
    });
    dialog.addEventListener("close", () => {
      if (focoAnterior && typeof focoAnterior.focus === "function") focoAnterior.focus();
    });
  }

  function tarjeta(pieza) {
    const li = el("li", "piece");
    const conFoto = /^https?:\/\//.test(pieza.foto || "");
    const photo = el(conFoto ? "button" : "div", "piece-photo");
    if (conFoto) {
      photo.type = "button";
      photo.setAttribute("aria-label", `Ver foto completa: ${pieza.nombre}`);
      const img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => img.remove());
      img.src = pieza.foto;
      const zoom = el("span", "piece-zoom", "Ver foto");
      zoom.setAttribute("aria-hidden", "true");
      photo.append(img, zoom);
      photo.addEventListener("click", () => abrirVisor(pieza, photo));
    }
    const body = el("div", "piece-body");
    // ponytail: la ropa se captura sin nombre propio; hasta tener marca/equipo dice «Ropa americana».
    body.append(el("h3", "", pieza.nombre === "Ropa" ? "Ropa americana" : pieza.nombre));
    if (pieza.marca) body.append(el("p", "piece-brand", pieza.marca));
    if (pieza.talla) body.append(el("p", "piece-size", `Talla ${pieza.talla}`));
    const price = el("p", "piece-price");
    pintarPrecio(price, pieza);
    const ask = el("a", "piece-link", "Preguntar por WhatsApp ↗");
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
      for (const other of chips.children) other.setAttribute("aria-pressed", String(other === chip));
      cargar(true);
    });
    chips.append(chip);
  }
  more.addEventListener("click", () => cargar(false));
  retry.addEventListener("click", () => cargar(true));
  cargar(true);
})();
