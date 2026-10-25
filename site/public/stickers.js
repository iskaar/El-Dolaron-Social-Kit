(() => {
  // Portada (Issue #526): el collage se cambia por un tablero de stickers despegables hechos con los
  // recortes reales del catálogo. Si algo falla, el collage del HTML se queda tal cual.
  const API = "https://dolarones.eldolaron.com";
  const VISIBLES = 4, META = 12, PAGINAS = 6;

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
  async function traerRollo(base, signal) {
    const rollo = [];
    let despues = null;
    for (let n = 0; n < PAGINAS; n++) {
      const params = new URLSearchParams({ recorte: "1" });   // API nueva: solo piezas con recorte; la vieja lo ignora y se filtra abajo
      if (despues) params.set("despues", despues);
      const r = await fetch(`${base}/api/catalogo?${params}`, { signal, headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      if (!d || !Array.isArray(d.piezas)) throw new Error("Respuesta inesperada");
      rollo.push(...d.piezas.filter((p) => https(p.recorte) && https(p.foto)));
      if (!d.hay_mas || !d.siguiente || rollo.length >= META) break;
      despues = d.siguiente;
    }
    return rollo;
  }

  // Sombra, frente (imagen con borde troquelado + aro holográfico) y dorso (la pestaña doblada).
  function pegatina(p) {
    const b = el("button", "sticker");
    b.type = "button";
    b.pieza = p;
    b.setAttribute("aria-label", `Ver ${p.nombre}, ${precio(p.precio)}`);
    b.style.setProperty("--src", `url(${JSON.stringify(p.recorte)})`);
    const img = (clase) => { const i = el("img", clase); i.src = p.recorte; i.alt = ""; i.draggable = false; return i; };
    const holo = el("span", "holo"); holo.append(el("span", "holo-fill"));
    const frente = el("span", "frente"); frente.append(img("arte"), holo);
    const dorso = el("span", "dorso"); dorso.append(img(""));
    b.append(img("sombra"), frente, dorso);
    return b;
  }

  async function arrancar() {
    const arte = document.querySelector(".hero-art");
    if (!arte || typeof fetch !== "function") return;
    const collage = arte.querySelector("img");
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 15000);
    const rollo = await traerRollo(apiBase(location.search), control.signal).finally(() => clearTimeout(reloj));
    let idx = 0;
    // La siguiente pieza del rollo cuyo recorte sí se decodifica; null cuando se acaba.
    async function sacar() {
      while (idx < rollo.length) {
        const p = rollo[idx++];
        const i = new Image();
        i.src = p.recorte;
        try { await i.decode(); return p; } catch {}
      }
      return null;
    }
    const primeras = await Promise.all(Array.from({ length: VISIBLES }, () => sacar()));
    if (primeras.filter(Boolean).length < 3) return;

    const tablero = el("div", "sticker-board");
    tablero.setAttribute("role", "group");
    tablero.setAttribute("aria-label", "Piezas de la tienda");
    tablero.append(...primeras.map((p) => (p ? pegatina(p) : el("span", "vacio"))));
    arte.append(tablero);
    arte.classList.add("con-stickers");
    requestAnimationFrame(() => tablero.classList.add("listo"));
    setTimeout(() => { collage.hidden = true; }, 400);

    // Toque corto o Enter/Espacio: abre el visor del catálogo (catalogo.js escucha este evento).
    let suprimir = null;   // el clic que sigue a un jalón no abre nada
    tablero.addEventListener("click", (e) => {
      const s = e.target.closest(".sticker");
      if (!s) return;
      if (suprimir === s) { suprimir = null; return; }
      document.dispatchEvent(new CustomEvent("dolaron:ver-pieza", { detail: { pieza: s.pieza, disparador: s, img: s.querySelector(".arte") } }));
    });

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return { rollo, tablero };

    // El aro holográfico sigue al puntero: una escritura por cuadro, en el tablero y no en :root.
    let raf = 0;
    tablero.addEventListener("pointermove", (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        tablero.style.setProperty("--px", (e.clientX / innerWidth).toFixed(3));
        tablero.style.setProperty("--py", (e.clientY / innerHeight).toFixed(3));
      });
    }, { passive: true });

    // Rellena un slot con la siguiente pieza del rollo; si se acabó, queda el hueco punteado.
    async function rellenar(slot) {
      const p = await sacar();
      if (!p) { slot.replaceWith(el("span", "vacio")); return; }
      const s = pegatina(p);
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
