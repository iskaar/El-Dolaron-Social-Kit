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
      const response = await fetch(`${apiBase(location.search)}/api/catalogo/destacados`, { headers: { accept: "application/json" } });
      if (!response.ok) return;
      const { piezas } = await response.json();
      if (!Array.isArray(piezas) || piezas.length < 4) return;
      const capa = document.createElement("div");
      capa.className = "stickers";
      for (const pieza of piezas.slice(0, 5)) {
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
  let categoria = "";
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

  function tarjeta(pieza) {
    const li = el("li", "piece");
    const photo = el("div", "piece-photo");
    if (/^https?:\/\//.test(pieza.foto || "")) {
      const img = new Image();
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => img.remove());
      img.src = pieza.foto;
      photo.append(img);
    }
    const body = el("div", "piece-body");
    body.append(el("h3", "", pieza.nombre));
    if (pieza.marca) body.append(el("p", "piece-brand", pieza.marca));
    if (pieza.talla) body.append(el("p", "piece-size", `Talla ${pieza.talla}`));
    const price = el("p", "piece-price", precio(pieza.precio));
    if (pieza.precio_lista > pieza.precio) {
      const lista = el("s", "", precio(pieza.precio_lista));
      lista.prepend(el("span", "sr-only", "Precio de lista "));
      price.append(lista);
    }
    const ask = el("a", "button button-yellow piece-ask", "Preguntar por WhatsApp");
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
    try {
      const response = await fetch(`${base}/api/catalogo?${params}`, { signal: mio.signal, headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || !Array.isArray(data.piezas)) throw new Error("Respuesta inesperada");
      if (mio.signal.aborted) throw new Error("Cancelada");
      cargado = true;
      proxima = pedida + 1;
      chips.hidden = false;
      siguiente = data.siguiente || null;
      grid.append(...data.piezas.map(tarjeta));
      more.hidden = !data.hay_mas;
      status.textContent = grid.children.length
        ? `${grid.children.length} de ${Number(data.total) || grid.children.length} piezas`
        : "Por ahora no hay piezas en esta categoría. Prueba otra o pregunta por WhatsApp.";
    } catch (error) {
      if (mio.signal.aborted && mio.signal.reason !== TIEMPO) return;   // otra búsqueda la reemplazó
      status.textContent = "";
      if (!cargado) chips.hidden = true;
      if (!grid.children.length) fallback.hidden = false;
      else { more.hidden = false; status.textContent = "No pudimos cargar más piezas. Intenta de nuevo."; }
    } finally {
      clearTimeout(reloj);
      if (controller === mio) root.removeAttribute("aria-busy");
    }
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
