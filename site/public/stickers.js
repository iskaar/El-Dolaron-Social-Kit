(() => {
  // Portada (Issues #526 y #531): cinco stickers despegables hechos con los recortes reales del catálogo flotan sobre la
  // pila semanal (assets/pila.webp). La pila siempre queda debajo: si algo falla, se ve sola.
  const API = "https://dolarones.eldolaron.com";
  const META = 12, PAGINAS = 6;
  // Lugares fijos como cajas en % de la portada (izquierda, arriba, ancho) y giro; se empalman entre sí y con la pila.
  const LUGARES = [
    { l: 2, t: 4, w: 44, r: -9 }, { l: 52, t: 0, w: 46, r: 7 }, { l: 28, t: 30, w: 44, r: -5 },
    { l: 0, t: 54, w: 46, r: 8 }, { l: 54, t: 52, w: 44, r: -11 },
  ];
  const VISIBLES = LUGARES.length;

  // Copias de catalogo.js (ese archivo es un IIFE aparte y no se importa).
  function precio(centavos) {
    const cents = Number(centavos) || 0;
    return new Intl.NumberFormat("es-MX", {
      style: "currency", currency: "MXN",
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
    }).format(cents / 100);
  }
  function apiBase(search) {
    try {
      const url = new URL(new URLSearchParams(search).get("api"));
      if (/^https?:$/.test(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return url.origin;
    } catch {}
    return API;
  }

  const https = (u) => /^https:\/\//.test(u || "");
  const el = (tag, clase) => { const n = document.createElement(tag); if (clase) n.className = clase; return n; };

  // El rollo: piezas con recorte transparente, siguiendo el cursor de /api/catalogo (como catalogo.js).
  // Los códigos que ya salen en la pila no se repiten en el rollo; si pila.json no carga, no se excluye nada.
  const traerExcluidos = () => fetch("assets/pila.json", { headers: { accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => new Set(d.piezas.map((p) => p.codigo)))
    .catch(() => new Set());

  async function traerRollo(base, signal, excluidos) {
    const rollo = [];
    let despues = null;
    for (let n = 0; n < PAGINAS; n++) {
      const params = new URLSearchParams({ recorte: "1" });   // API nueva: solo piezas con recorte; la vieja lo ignora y se filtra abajo
      if (despues) params.set("despues", despues);
      const r = await fetch(`${base}/api/catalogo?${params}`, { signal, headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d || !Array.isArray(d.piezas)) throw new Error("Respuesta inesperada");
      const fuera = await excluidos;
      rollo.push(...d.piezas.filter((p) => https(p.recorte) && https(p.foto) && !fuera.has(p.codigo)));
      if (!d.hay_mas || !d.siguiente || rollo.length >= META) break;
      despues = d.siguiente;
    }
    return rollo;
  }

  // Cada sticker (o hueco) ocupa su lugar con variables que usa styles.css.
  function colocar(n, i) {
    const { l, t, w, r } = LUGARES[i];
    n.lugar = i;
    n.style.setProperty("--l", `${l}%`);
    n.style.setProperty("--t", `${t}%`);
    n.style.setProperty("--w", `${w}%`);
    n.style.setProperty("--r", `${r}deg`);
    return n;
  }

  // Borde troquelado, sombra, dorso y aro holográfico se hornean UNA vez en canvas al construir el sticker (#539): en celular los
  // filtros SVG (feMorphology) se recalculaban en cada cuadro del despegue. Devuelve null si no hay canvas 2D (se usan <img> planas).
  function troquelar(img) {
    const ctx2d = (c) => c.getContext && c.getContext("2d");
    const S = 512, r = 18, M = r + 12, caja = S - 2 * M;   // r: grosor del borde en px del canvas (≈ 8 px CSS en un sticker de ~230 px)
    const lienzo = () => { const c = el("canvas"); c.width = c.height = S; return c; };
    const sil = lienzo(), sx = ctx2d(sil);
    if (!sx) return null;
    // Geometría "contain" de la imagen dentro de la caja con margen M.
    const k = Math.min(caja / img.naturalWidth, caja / img.naturalHeight), w = img.naturalWidth * k, h = img.naturalHeight * k;
    const x = M + (caja - w) / 2, y = M + (caja - h) / 2;
    const poner = (c, dx = 0, dy = 0) => c.drawImage(img, x + dx, y + dy, w, h);
    // Silueta blanca = imagen estampada en tres anillos de radio r (dilatar a mano) y rellenada de blanco.
    poner(sx);
    for (const f of [1, .66, .33]) for (let a = 0; a < 24; a++) poner(sx, Math.cos(a * Math.PI / 12) * r * f, Math.sin(a * Math.PI / 12) * r * f);
    const pintar = (c, color) => { c.globalCompositeOperation = "source-in"; c.fillStyle = color; c.fillRect(0, 0, S, S); c.globalCompositeOperation = "source-over"; };
    pintar(sx, "#fff");
    const arte = lienzo(), ax = ctx2d(arte); ax.drawImage(sil, 0, 0); poner(ax);
    // La silueta se dibuja fuera del lienzo y solo cae su sombra desenfocada.
    const sombra = lienzo(), bx = ctx2d(sombra);
    bx.shadowColor = "#000"; bx.shadowBlur = 24; bx.shadowOffsetX = S * 2; bx.drawImage(sil, -S * 2, 0);
    const dorso = lienzo(), dx = ctx2d(dorso); dx.drawImage(sil, 0, 0); pintar(dx, "#ededed");
    // Aro = silueta menos la imagen; sirve de máscara del degradado holográfico. Con canvas "tainted" (sin CORS) no hay aro.
    const aro = lienzo(), ox = ctx2d(aro); ox.drawImage(sil, 0, 0); ox.globalCompositeOperation = "destination-out"; poner(ox);
    let anillo = null;
    try { anillo = aro.toDataURL(); } catch {}
    sombra.className = "sombra"; arte.className = "arte";
    return { arte, sombra, dorso, anillo };
  }

  // Sombra, frente (imagen con borde troquelado + aro holográfico) y dorso (la pestaña doblada).
  function pegatina(p, imagen) {
    const b = el("button", "sticker");
    b.type = "button";
    b.pieza = p;
    b.setAttribute("aria-label", `Ver ${p.nombre}, ${precio(p.precio)}`);
    const img = (clase) => { const i = el("img", clase); i.src = p.recorte; i.alt = ""; i.draggable = false; return i; };
    const t = troquelar(imagen) || { sombra: img("sombra"), arte: img("arte"), dorso: img(""), anillo: null };
    const frente = el("span", "frente"); frente.append(t.arte);
    if (t.anillo) { const holo = el("span", "holo"); holo.style.setProperty("--anillo", `url(${JSON.stringify(t.anillo)})`); frente.append(holo); }
    const dorso = el("span", "dorso"); dorso.append(t.dorso);
    b.append(t.sombra, frente, dorso);
    return b;
  }

  async function arrancar() {
    const arte = document.querySelector(".hero-art");
    if (!arte || typeof fetch !== "function") return;
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 15000);
    const rollo = await traerRollo(apiBase(location.search), control.signal, traerExcluidos()).finally(() => clearTimeout(reloj));
    let idx = 0;
    // La siguiente pieza del rollo cuyo recorte sí se decodifica, con su imagen ({ p, img }); null cuando se acaba.
    // Primero con CORS para que el canvas no quede "tainted"; si falla, otra vez sin CORS (se ve, pero sin aro).
    async function sacar() {
      while (idx < rollo.length) {
        const p = rollo[idx++];
        for (const cors of [true, false]) {
          const i = new Image();
          if (cors) i.crossOrigin = "anonymous";
          i.src = p.recorte;
          try { await i.decode(); return { p, img: i }; } catch {}
        }
      }
      return null;
    }
    const primeras = await Promise.all(Array.from({ length: VISIBLES }, () => sacar()));
    if (primeras.filter(Boolean).length < 3) return;

    const tablero = el("div", "sticker-board");
    tablero.setAttribute("role", "group");
    tablero.setAttribute("aria-label", "Piezas de la tienda");
    tablero.append(...primeras.map((x, i) => colocar(x ? pegatina(x.p, x.img) : el("span", "vacio"), i)));
    arte.append(tablero);
    arte.classList.add("con-stickers");
    requestAnimationFrame(() => tablero.classList.add("listo"));

    // Toque corto o Enter/Espacio: abre el visor del catálogo (catalogo.js escucha este evento).
    let suprimir = null;   // el clic que sigue a un jalón no abre nada
    tablero.addEventListener("click", (e) => {
      const s = e.target.closest(".sticker");
      if (!s) return;
      if (suprimir === s) { suprimir = null; return; }
      document.dispatchEvent(new CustomEvent("dolaron:ver-pieza", { detail: { pieza: s.pieza, disparador: s, img: s.querySelector(".arte") } }));
    });

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return { rollo, tablero };

    // El aro holográfico sigue al puntero (no al dedo: en touch queda fijo): una escritura por cuadro, en el tablero y no en :root.
    let raf = 0;
    tablero.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch" || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        tablero.style.setProperty("--px", (e.clientX / innerWidth).toFixed(3));
        tablero.style.setProperty("--py", (e.clientY / innerHeight).toFixed(3));
      });
    }, { passive: true });

    // Rellena un slot con la siguiente pieza del rollo; si se acabó, queda el hueco punteado.
    async function rellenar(slot) {
      const x = await sacar();
      if (!x) { slot.replaceWith(colocar(el("span", "vacio"), slot.lugar)); return; }
      const s = colocar(pegatina(x.p, x.img), slot.lugar);
      s.classList.add("nuevo");
      slot.replaceWith(s);
    }
    // La esquina más cercana al puntero es la que se despega (la geometría se espeja con --sx/--sy).
    const esquina = (s, e) => {
      const r = s.getBoundingClientRect();
      s.style.setProperty("--sx", e.clientX < r.left + r.width / 2 ? 1 : -1);
      s.style.setProperty("--sy", e.clientY < r.top + r.height / 2 ? 1 : -1);
      return r;
    };
    let act = null;
    tablero.addEventListener("pointerover", (e) => {
      const s = e.target.closest(".sticker");
      if (s && !act && !s.contains(e.relatedTarget)) esquina(s, e);
    });
    tablero.addEventListener("pointerdown", (e) => {
      const s = e.target.closest(".sticker");
      if (!s || act || s.classList.contains("volando")) return;
      suprimir = null;
      const r = esquina(s, e);
      act = { s, x0: e.clientX, y0: e.clientY, L: r.width * .6, sx: +s.style.getPropertyValue("--sx"), sy: +s.style.getPropertyValue("--sy") };
      s.classList.remove("nuevo");
      s.classList.add("agarrado");
      s.setPointerCapture(e.pointerId);
    });
    tablero.addEventListener("pointermove", (e) => {
      if (!act) return;
      const { s, sx, sy } = act, dx = e.clientX - act.x0, dy = e.clientY - act.y0;
      const peel = Math.min(Math.max(((dx * sx + dy * sy) / Math.SQRT2) / act.L, 0), 1);   // jalón hacia el centro
      s.style.setProperty("--peel", peel.toFixed(3));
      if (peel < 1) return;
      // Despegado del todo: vuela en la dirección del jalón y el slot recibe la siguiente pieza.
      act = null;
      suprimir = s;
      const largo = Math.hypot(dx, dy) || 1;
      s.classList.remove("agarrado");
      s.style.setProperty("--vx", `${(dx / largo * 260).toFixed(0)}px`);
      s.style.setProperty("--vy", `${(dy / largo * 260).toFixed(0)}px`);
      s.style.setProperty("--giro", `${dx >= 0 ? 24 : -24}deg`);
      s.classList.add("volando");
      s.addEventListener("animationend", (ev) => { if (ev.target === s) rellenar(s); });
    });
    const soltar = (e) => {
      if (!act) return;
      const { s } = act;
      if (Math.hypot(e.clientX - act.x0, e.clientY - act.y0) >= 8) suprimir = s;
      s.classList.remove("agarrado");
      s.style.removeProperty("--peel");   // vuelve a su lugar con rebote
      act = null;
    };
    tablero.addEventListener("pointerup", soltar);
    tablero.addEventListener("pointercancel", soltar);
    return { rollo, tablero };
  }

  const hecho = arrancar().catch(() => {});
  if (typeof module !== "undefined") module.exports = { precio, hecho };
})();
