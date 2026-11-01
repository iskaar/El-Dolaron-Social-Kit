// Run: node tools/check_site_catalogo.cjs
const assert = require("node:assert/strict");
const { precio, apiBase, codigoDePieza, viernesDeEnvio, fechaCorta, lineaApartado, enlaceLoQuiero, BANDAS, filtrosDeUrl, paramsDeFiltros, busquedaConFiltros } = require("../site/public/catalogo.js");

assert.equal(precio(15000), "$150");
assert.equal(precio(24950), "$249.50");
assert.equal(precio(5), "$0.05");
assert.equal(apiBase(""), "https://dolarones.eldolaron.com");
assert.equal(apiBase("?api=http://127.0.0.1:8787"), "http://127.0.0.1:8787");
for (const bad of ["javascript:alert(1)", "https://evil.example", "ftp://127.0.0.1", "no-es-url"]) {
  assert.equal(apiBase("?api=" + encodeURIComponent(bad)), "https://dolarones.eldolaron.com");
}

// ?pieza= (Issue #590): solo códigos válidos; lo demás se ignora.
assert.equal(codigoDePieza("?pieza=ED-000123"), "ED-000123");
assert.equal(codigoDePieza("?x=1&pieza=ed-7"), "ED-7");
for (const bad of ["", "?pieza=", "?pieza=ED-", "?pieza=ED-1%20OR%201", "?pieza=<script>", "?pieza=ED-12345678901", "?q=ED-1"]) assert.equal(codigoDePieza(bad), "");

// Ficha (Issue #645): viernes de envío (jueves 20:00 hora de tienda = corte), línea de apartado y enlace de «Lo quiero».
assert.equal(viernesDeEnvio("2026-10-31T18:00:00Z"), "2026-11-06");   // sábado
assert.equal(viernesDeEnvio("2026-11-06T01:59:00Z"), "2026-11-06");   // jueves 19:59 en la tienda
assert.equal(viernesDeEnvio("2026-11-06T02:00:00Z"), "2026-11-13");   // jueves 20:00: ya pasó el corte
assert.equal(viernesDeEnvio("2026-11-06T16:00:00Z"), "2026-11-13");   // viernes
assert.equal(fechaCorta("2026-11-06"), "6 de noviembre");
assert.equal(fechaCorta("2026-12-18"), "18 de diciembre");
const SABADO = Date.parse("2026-10-31T18:00:00Z");
assert.equal(lineaApartado({ precio: 15000 }, SABADO), "Apártala con $100 por 7 días. Recoge en Soledad (11 a 8) o te la enviamos el viernes 6 de noviembre (envío nacional gratis desde $1,000; si no, $99).");
assert.equal(lineaApartado({ precio: 5000 }, SABADO), "Se paga completa al apartar. Recoge en Soledad (11 a 8) o te la enviamos el viernes 6 de noviembre (envío nacional gratis desde $1,000; si no, $99).");
const sudadera = { nombre: "Sudadera Nike", talla: "M", codigo: "ED-001850", precio: 15000 };
assert.equal(enlaceLoQuiero(sudadera), "https://wa.me/524445437754?text=Quiero%20producto%20ED-001850");   // solo el código, nada más

// Filtros (Issue #672): la URL y la consulta a la API usan los mismos nombres; lo malformado se ignora y ?pieza=/?api= se conservan.
assert.deepEqual(BANDAS.map(([k, v]) => `${k}=${v}`), ["precio_max=5000", "precio_max=8000", "precio_max=10000", "precio_max=15000", "precio_min=20000"]);
assert.deepEqual(filtrosDeUrl(""), { categoria: "", talla: "", banda: -1, dias: false });
assert.deepEqual(filtrosDeUrl("?categoria=ropa&talla=%20Ni%C3%B1o%206%20a%C3%B1os%20/%20S&precio_max=8000&dias=7"), { categoria: "ropa", talla: "Niño 6 años / S", banda: 1, dias: true });
assert.deepEqual(filtrosDeUrl("?precio_min=20000"), { categoria: "", talla: "", banda: 4, dias: false });
assert.deepEqual(filtrosDeUrl("?categoria=armas&precio_max=123&dias=99&talla=" + "x".repeat(40)), { categoria: "", talla: "x".repeat(30), banda: -1, dias: false });
assert.equal(paramsDeFiltros({ categoria: "ropa", talla: "M", banda: 4, dias: true }).toString(), "categoria=ropa&talla=M&precio_min=20000&dias=7");
assert.equal(paramsDeFiltros({ categoria: "", talla: "", banda: -1, dias: false }).toString(), "");
assert.equal(busquedaConFiltros("?pieza=ED-9&api=http%3A%2F%2F127.0.0.1%3A8787&dias=7&precio_max=5000", { categoria: "ropa", talla: "", banda: 4, dias: false }),
  "?pieza=ED-9&api=http%3A%2F%2F127.0.0.1%3A8787&categoria=ropa&precio_min=20000");
assert.equal(busquedaConFiltros("?categoria=ropa&talla=M", { categoria: "", talla: "", banda: -1, dias: false }), "");

// Catálogo en una página falsa (Issue #241): reintento, talla, tiempo agotado y botón Reintentar.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const fuente = readFileSync(join(__dirname, "../site/public/catalogo.js"), "utf8");
class Nodo {
  constructor() { this.children = []; this.listeners = {}; this.attrs = {}; this.hidden = false; this.textContent = ""; this.value = ""; this.open = false; this.focused = false; this.style = {}; this.inert = false; this.classes = new Set(); this.classList = { add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v) }; }
  append(...xs) { this.children.push(...xs); }
  prepend(...xs) { this.children.unshift(...xs); }
  replaceChildren(...xs) { this.children = xs; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 375 }; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; if (this.listeners.close) this.listeners.close(); }
}
function pagina(fetcher, extra = {}) {
  const selectores = [
    ".chips", ".catalog-grid", ".catalog-status", ".catalog-more", ".catalog-fallback", ".catalog-retry",
    ".catalog-search", ".search-input", ".catalog-clear", ".piece-dialog", ".piece-dialog-close",
    ".piece-dialog-img", ".piece-dialog-title", ".piece-dialog-meta", ".piece-dialog-price",
    ".piece-dialog-photo", ".piece-dialog-stamp", ".ficha-zoom", ".ficha-pista", ".ficha-compra", ".ficha-barprecio", ".ficha-quiero",
    ".ficha-compartir", ".ficha-aviso", ".piece-dialog-head", ".piece-dialog-scroll", ".piece-dialog-bar",
    ".catalog-filters", ".filter-size", ".filter-size-select", ".chips-filters",
  ];
  const partes = Object.fromEntries(selectores.map((k) => [k, new Nodo()]));
  partes[".catalog-clear"].hidden = true;
  const root = new Nodo();
  root.querySelector = (k) => partes[k];
  const relojes = [];
  vm.runInNewContext(fuente, {
    document: { querySelector: () => null, getElementById: (id) => (id === "catalogo" ? root : id === "buscados" && extra.buscados ? extra.buscados : null), createElement: () => new Nodo(), ...extra.document },
    location: { search: extra.search || "" }, Image: extra.Image || class extends Nodo {}, matchMedia: extra.matchMedia, fetch: fetcher, ...extra.contexto, AbortController, URL, URLSearchParams, Intl, Number, String, encodeURIComponent,
    setTimeout: (fn) => relojes.push(fn), clearTimeout: () => {},
  });
  const textos = () => partes[".catalog-grid"].children.map((li) => li.children[1].children.map((n) => n.textContent));
  return { partes, root, relojes, textos };
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // Página 2 falla una vez: el reintento pide la MISMA (mismo cursor) y no se salta piezas.
  const pedidas = [];
  const busquedas = [];
  let falla = true;
  const p = pagina(async (url) => {
    const params = new URL(url).searchParams;
    const despues = params.get("despues");
    const q = params.get("q");
    pedidas.push(despues);
    busquedas.push(q);
    if (q === "nada") return { ok: true, json: async () => ({ piezas: [], total: 0, hay_mas: false, siguiente: null }) };
    if (despues === "c1" && falla) { falla = false; throw new Error("red"); }
    const n = despues === "c1" ? 2 : 1;
    return {
      ok: true,
      json: async () => ({
        piezas: [{ nombre: "Pieza " + n, codigo: "ED-" + n, marca: "Levis", precio: 10000, talla: n === 1 ? "M" : null, foto: "https://dolarones.eldolaron.com/api/catalogo/foto/ED-" + n, recorte: "https://dolarones.eldolaron.com/api/catalogo/recorte/ED-" + n }],
        total: 2, hay_mas: n === 1, siguiente: n === 1 ? "c1" : null,
      }),
    };
  });
  await tick();
  p.partes[".catalog-more"].listeners.click(); await tick();
  assert.match(p.partes[".catalog-status"].textContent, /Intenta de nuevo/);
  p.partes[".catalog-more"].listeners.click(); await tick();
  assert.deepEqual(pedidas, [null, "c1", "c1"]);
  assert.deepEqual(p.textos().map((t) => t[0]), ["Pieza 1", "Pieza 2"]);
  assert.deepEqual(p.textos()[0].slice(0, 3), ["Pieza 1", "Levis", "Talla M"]);   // marca y talla visibles
  assert.ok(!p.textos()[1].some((t) => /Talla/.test(t)));                         // sin talla, sin etiqueta vacía

  // Visor de foto completa: abre el diálogo, enfoca Cerrar y al cerrar devuelve el foco a la foto.
  const tarjeta1 = p.partes[".catalog-grid"].children[0];
  const fotoBtn = tarjeta1.children[1].children.at(-1);   // el foco vuelve al botón «Lo quiero»
  assert.ok(tarjeta1.children[0].classes.has("con-recorte"));
  assert.match(tarjeta1.children[0].children[0].src, /recorte/);
  tarjeta1.listeners.click();
  assert.equal(p.partes[".piece-dialog"].open, true);
  assert.equal(p.partes[".piece-dialog-title"].textContent, "Pieza 1");
  assert.equal(p.partes[".piece-dialog-meta"].textContent, "Levis · Talla M · ED-1");
  assert.equal(p.partes[".piece-dialog-close"].focused, true);
  p.partes[".piece-dialog-close"].listeners.click();
  assert.equal(p.partes[".piece-dialog"].open, false);
  assert.equal(fotoBtn.focused, true);

  // Morph del visor (View Transitions): la miniatura suelta su nombre, el visor abre y Esc cierra devolviendo el foco.
  const sinMovimiento = { matches: false };
  const morph = pagina(async () => ({
    ok: true,
    json: async () => ({ piezas: [{ nombre: "Pieza 1", codigo: "ED-1", precio: 10000, foto: "https://dolarones.eldolaron.com/api/catalogo/foto/ED-1" }], total: 1, hay_mas: false, siguiente: null }),
  }), {
    matchMedia: () => sinMovimiento,
    document: { startViewTransition: (fn) => { const p = Promise.resolve().then(fn); return { finished: p, ready: p, updateCallbackDone: p }; } },
    Image: class extends Nodo { decode() { return Promise.resolve(); } },
  });
  await tick();
  const morphLi = morph.partes[".catalog-grid"].children[0];
  const morphBtn = morphLi.children[1].children.at(-1);
  const morphImg = morphLi.children[0].children[0];
  morphLi.listeners.click();
  assert.equal(morphImg.style.viewTransitionName, "pieza-foto");   // única en la captura «antes»
  await tick();
  assert.equal(morph.partes[".piece-dialog"].open, true);
  assert.equal(morphImg.style.viewTransitionName, "");
  morph.partes[".piece-dialog"].listeners.cancel({ preventDefault() {} });
  await tick();
  assert.equal(morph.partes[".piece-dialog"].open, false);
  assert.equal(morphImg.style.viewTransitionName, "");
  assert.equal(morphBtn.focused, true);

  // Enlace a una pieza (Issue #590): busca el código y abre el visor solo con coincidencia exacta.
  const consultas = [];
  const enlace = pagina(async (url) => {
    const q = new URL(url).searchParams.get("q");
    consultas.push(q);
    const piezas = q === "ED-9" ? [{ nombre: "Otra", codigo: "ED-90", precio: 1000, foto: "https://x/y.jpg" }, { nombre: "Chamarra", codigo: "ED-9", precio: 30000, foto: "https://x/z.jpg" }] : [];
    return { ok: true, json: async () => ({ piezas, total: piezas.length, hay_mas: false, siguiente: null }) };
  }, { search: "?pieza=ED-9" });
  await tick();
  assert.deepEqual(consultas, ["ED-9"]);
  assert.equal(enlace.partes[".search-input"].value, "ED-9");
  assert.equal(enlace.partes[".piece-dialog"].open, true);
  assert.equal(enlace.partes[".piece-dialog-title"].textContent, "Chamarra");
  const vendida = pagina(async (url) => { consultas.push(new URL(url).searchParams.get("q")); return { ok: true, json: async () => ({ piezas: [], total: 0, hay_mas: false, siguiente: null }) }; }, { search: "?pieza=ED-5" });
  await tick();
  assert.equal(vendida.partes[".piece-dialog"].open, false);
  assert.match(vendida.partes[".catalog-status"].textContent, /No encontramos piezas para «ED-5»/);
  const mala = pagina(async (url) => { consultas.push(new URL(url).searchParams.get("q")); return { ok: true, json: async () => ({ piezas: [], total: 0, hay_mas: false, siguiente: null }) }; }, { search: "?pieza=hola" });
  await tick();
  assert.equal(consultas.at(-1), null);   // malformado: carga normal, sin búsqueda

  // Ficha (Issue #645): datos, última pieza, línea de apartado, enlace «Lo quiero», zoom y Compartir.
  const copiados = [];
  const eventos = [];
  const ficha = pagina(async () => ({
    ok: true,
    json: async () => ({ piezas: [
      { nombre: "Chamarra", marca: "Levis", talla: "L", codigo: "ED-5", precio: 30000, precio_lista: 90000, ultima: true, foto: "https://x/f.jpg", recorte: "https://x/r.png" },
      { nombre: "Taza", categoria: "hogar", codigo: "ED-6", precio: 4000, foto: "https://x/t.jpg" },
    ], total: 2, hay_mas: false, siguiente: null }),
  }), { contexto: { navigator: { clipboard: { writeText: async (t) => copiados.push(t) }, sendBeacon: (url, cuerpo) => { eventos.push(JSON.parse(cuerpo).evento); return true; } } } });
  await tick();
  const f = ficha.partes;
  const abre = (i) => f[".catalog-grid"].children[i].listeners.click();
  abre(0);
  assert.equal(f[".piece-dialog-img"].src, "https://x/f.jpg");   // la foto completa, no el recorte
  assert.equal(f[".piece-dialog-meta"].textContent, "Levis · Talla L · ED-5");
  assert.equal(f[".piece-dialog-price"].textContent, "$300");   // precio; la lista tachada y el ahorro son nodos hijos
  assert.equal(f[".piece-dialog-price"].children.at(-1).textContent, "Ahorras $600");
  assert.equal(f[".ficha-barprecio"].textContent, "$300");
  assert.equal(f[".piece-dialog-stamp"].hidden, false);
  assert.match(f[".ficha-compra"].textContent, /^Apártala con \$100 por 7 días\. Recoge en Soledad \(11 a 8\) o te la enviamos el viernes \d+ de \w+ \(envío nacional gratis desde \$1,000; si no, \$99\)\.$/);
  assert.equal(f[".ficha-pista"].hidden, false);   // primera vez, sin sessionStorage: se muestra
  abre(1);
  assert.equal(f[".piece-dialog-meta"].textContent, "Hogar y cocina · ED-6");   // sin marca, la categoría
  assert.equal(f[".piece-dialog-stamp"].hidden, true);                          // sin `ultima`, nada
  assert.match(f[".ficha-compra"].textContent, /^Se paga completa al apartar\./);
  // «Lo quiero» es un enlace directo a WhatsApp con solo el código; no hay hoja ni «Preguntar por WhatsApp».
  abre(0);
  assert.equal(f[".ficha-quiero"].href, "https://wa.me/524445437754?text=Quiero%20producto%20ED-5");
  abre(1);
  assert.equal(f[".ficha-quiero"].href, "https://wa.me/524445437754?text=Quiero%20producto%20ED-6");   // se actualiza con la pieza abierta
  assert.equal(f[".piece-dialog"].open, true);
  // Medición (#651): abrir manda ficha_abierta y tocar «Lo quiero» solo lo_quiero; nada de apartar_*, preguntar ni whatsapp_abierto.
  eventos.length = 0;
  abre(0);
  f[".ficha-quiero"].listeners.click();
  assert.deepEqual(eventos, ["ficha_abierta", "lo_quiero"]);
  f[".piece-dialog"].listeners.cancel({ preventDefault() {} });   // Esc cierra la ficha
  assert.equal(f[".piece-dialog"].open, false);
  abre(0);
  // Zoom: doble toque acerca a 2.5×, otro doble toque vuelve a 1×, cerrar reinicia.
  const foto = f[".piece-dialog-photo"];
  const toque = (id, t, x, y) => { const e = { pointerId: id, clientX: x, clientY: y, timeStamp: t, target: { closest: () => null } }; foto.listeners.pointerdown(e); foto.listeners.pointerup({ ...e, type: "pointerup" }); };
  toque(1, 1000, 150, 190); toque(1, 1100, 152, 190);
  assert.match(f[".piece-dialog-img"].style.transform, /scale\(2\.5\)/);
  assert.ok(foto.classes.has("acercada"));
  assert.equal(f[".ficha-zoom"].textContent, "Alejar");
  toque(1, 2000, 150, 190); toque(1, 2100, 150, 190);
  assert.equal(f[".piece-dialog-img"].style.transform, "");
  toque(1, 3000, 150, 190); toque(1, 3600, 150, 190);   // dos toques lentos no son doble toque
  assert.equal(f[".piece-dialog-img"].style.transform, "");
  // Pellizco: dos dedos que se separan al doble escalan y el tope es 4×.
  const d = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, timeStamp: 5000, target: { closest: () => null } });
  foto.listeners.pointerdown(d(1, 100, 190)); foto.listeners.pointerdown(d(2, 200, 190));
  foto.listeners.pointermove(d(2, 300, 190));   // distancia 100 → 200
  assert.match(f[".piece-dialog-img"].style.transform, /scale\(2\)/);
  foto.listeners.pointermove(d(2, 900, 190));   // pasa de 4×
  assert.match(f[".piece-dialog-img"].style.transform, /scale\(4\)/);
  f[".piece-dialog-close"].listeners.click();
  assert.equal(f[".piece-dialog-img"].style.transform, "");
  // Compartir sin navigator.share copia el enlace de la pieza y avisa.
  abre(0);
  await f[".ficha-compartir"].listeners.click();
  assert.deepEqual(copiados, ["https://eldolaron.com/?pieza=ED-5"]);
  assert.equal(f[".ficha-aviso"].textContent, "Enlace copiado");

  // Tarjetas (Issue #648): «Lo quiero» abre la ficha, sin chip «Ver foto» ni WhatsApp directo, y el sello solo con `ultima: true`.
  const solo = (nodo, clase) => nodo.children.filter((n) => String(n.className).split(" ").includes(clase));
  const [conSello, sinSello] = f[".catalog-grid"].children;
  for (const li of [conSello, sinSello]) {
    const [foto, cuerpo] = li.children;
    const quiero = cuerpo.children.at(-1);
    assert.equal(quiero.textContent, "Lo quiero");
    assert.equal(quiero.type, "button");
    assert.match(quiero.className, /(^| )piece-quiero( |$)/);
    assert.equal(quiero.href, undefined);                       // no es un enlace a WhatsApp
    assert.equal(cuerpo.children.at(-2).textContent, "Disponible");
    assert.equal(cuerpo.children.at(-2).className, "piece-disp");
    assert.ok(![...foto.children, ...cuerpo.children].some((n) => /Ver foto/.test(n.textContent)));
    assert.equal(typeof li.listeners.click, "function");         // toda la tarjeta abre la ficha
  }
  assert.equal(solo(conSello.children[0], "wanted-stamp").length, 1);
  assert.equal(solo(conSello.children[0], "wanted-stamp")[0].textContent, "¡Última pieza!");
  assert.equal(solo(sinSello.children[0], "wanted-stamp").length, 0);
  assert.equal(conSello.children[1].children.at(-1).attrs["aria-label"], "Lo quiero: Chamarra, última pieza");
  assert.equal(sinSello.children[1].children.at(-1).attrs["aria-label"], "Lo quiero: Taza");
  // Clic en el botón abre la ficha de esa pieza; el foco vuelve al botón al cerrar.
  f[".piece-dialog-close"].listeners.click();
  const botonTaza = sinSello.children[1].children.at(-1);
  sinSello.listeners.click();
  assert.equal(f[".piece-dialog-title"].textContent, "Taza");
  f[".piece-dialog-close"].listeners.click();
  assert.equal(botonTaza.focused, true);

  // «Los más buscados»: mismas reglas en la otra lista.
  const lista = new Nodo();
  const seccion = new Nodo();
  seccion.hidden = true;
  seccion.querySelector = () => lista;
  const mas = pagina(async (url) => {
    if (new URL(url).pathname.endsWith("/destacados")) {
      return { ok: true, json: async () => ({ piezas: [
        { nombre: "Maleta", codigo: "ED-11", precio: 50000, precio_lista: 90000, ultima: true, foto: "https://x/1.jpg" },
        { nombre: "Bolsa", codigo: "ED-12", precio: 40000, ultima: false, foto: "https://x/2.jpg" },
        { nombre: "Reloj", codigo: "ED-13", precio: 30000, ultima: false, foto: "https://x/3.jpg" },
      ] }) };
    }
    return { ok: true, json: async () => ({ piezas: [], total: 0, hay_mas: false, siguiente: null }) };
  }, { buscados: seccion, document: { createElement: () => new Nodo() } });
  await tick(); await tick();
  assert.equal(seccion.hidden, false);
  const items = lista.children.map((li) => li.children[0]);
  assert.equal(items.length, 3);
  const sellos = items.map((it) => solo(it.children[0], "wanted-stamp").length);
  assert.deepEqual(sellos, [1, 0, 0]);
  for (const it of items) {
    const quiero = it.children[1].children.at(-1);
    assert.equal(quiero.textContent, "Lo quiero");
    assert.equal(quiero.href, undefined);
    assert.equal(it.children[1].children.at(-2).textContent, "Disponible");
    assert.ok(!it.children[0].children.some((n) => /Ver foto/.test(n.textContent)));
    assert.equal(typeof it.listeners.click, "function");
  }
  assert.equal(items[0].children[1].children.at(-1).attrs["aria-label"], "Lo quiero: Maleta, última pieza");
  items[1].listeners.click();
  assert.equal(mas.partes[".piece-dialog"].open, true);
  assert.equal(mas.partes[".piece-dialog-title"].textContent, "Bolsa");
  assert.equal(mas.partes[".piece-dialog-stamp"].hidden, true);

  // Búsqueda por ?q= y botón Limpiar.
  p.partes[".search-input"].value = "  nada  ";
  p.partes[".catalog-search"].listeners.submit({ preventDefault() {} });
  await tick();
  assert.equal(busquedas.at(-1), "nada");
  assert.equal(p.partes[".catalog-clear"].hidden, false);
  assert.match(p.partes[".catalog-status"].textContent, /No encontramos piezas para «nada»/);
  p.partes[".catalog-clear"].listeners.click();
  await tick();
  assert.equal(busquedas.at(-1), null);
  assert.equal(p.partes[".catalog-clear"].hidden, true);

  // Sin respuesta: a los 15 s se rinde, muestra el respaldo y «Reintentar» vuelve a cargar con los filtros.
  let responde = false;
  const lenta = pagina((url, { signal }) => responde
    ? Promise.resolve({ ok: true, json: async () => ({ piezas: [{ nombre: "Ya", codigo: "ED-9", precio: 100 }], total: 1, hay_mas: false, siguiente: null }) })
    : new Promise((_, no) => signal.addEventListener("abort", () => no(signal.reason))));
  await tick();
  assert.equal(lenta.partes[".catalog-status"].textContent, "Cargando piezas…");
  lenta.relojes[0]();   // pasan los 15 s
  await tick();
  assert.equal(lenta.partes[".catalog-fallback"].hidden, false);
  assert.equal(lenta.partes[".chips"].hidden, true);
  assert.equal(lenta.partes[".catalog-search"].hidden, true);
  assert.equal(lenta.root.attrs["aria-busy"], undefined);
  responde = true;
  lenta.partes[".catalog-retry"].listeners.click(); await tick();
  assert.equal(lenta.partes[".chips"].hidden, false);
  assert.equal(lenta.partes[".catalog-search"].hidden, false);
  assert.equal(lenta.partes[".catalog-fallback"].hidden, true);
  assert.deepEqual(lenta.textos().map((t) => t[0]), ["Ya"]);
  // Filtros (Issue #672): chips de precio y novedad, menú de talla, URL compartible y búsqueda `q` intacta.
  const consultas2 = [];
  const empujadas = [];
  const sitio = { search: "?api=http%3A%2F%2F127.0.0.1%3A8787&talla=XL&dias=7", pathname: "/", hash: "#catalogo" };
  const filtrada = pagina(async (url) => {
    const u = new URL(url);
    consultas2.push(u.searchParams);
    const solo = u.searchParams.get("q") === "ninguna" || u.searchParams.get("precio_min") === "99999";
    return { ok: true, json: async () => ({ piezas: solo ? [] : [{ nombre: "Pieza", codigo: "ED-1", precio: 5000, foto: "https://x/1.jpg" }], total: solo ? 0 : 1, hay_mas: false, siguiente: null,
      ...(u.searchParams.get("tallas") === "1" ? { tallas: ["S", "M", "L"] } : {}) }) };
  }, {
    contexto: { location: sitio, history: { pushState: (_, __, destino) => { empujadas.push(destino); sitio.search = destino.slice(destino.indexOf("?")).replace(/#.*/, ""); } } },
  });
  await tick();
  const g = filtrada.partes;
  assert.equal(consultas2[0].get("talla"), "XL");               // vienen de la URL
  assert.equal(consultas2[0].get("dias"), "7");
  assert.equal(consultas2[0].get("tallas"), "1");               // el menú se pide con la primera página
  assert.equal(g[".catalog-filters"].hidden, false);
  assert.deepEqual(g[".filter-size-select"].children.map((o) => o.value), ["", "XL", "S", "M", "L"]);   // la elegida se conserva aunque no venga
  assert.equal(g[".filter-size-select"].value, "XL");
  assert.equal(g[".filter-size"].hidden, false);
  const rotulos = g[".chips-filters"].children.map((c) => c.textContent);
  assert.deepEqual(rotulos, ["Llegó esta semana", "Hasta $50", "Hasta $80", "Hasta $100", "Hasta $150", "$200 o más"]);
  assert.deepEqual(g[".chips-filters"].children.map((c) => c.attrs["aria-pressed"]), ["true", "false", "false", "false", "false", "false"]);
  // Búsqueda y filtros se combinan; quitar un filtro no borra `q`.
  g[".search-input"].value = "levis";
  g[".catalog-search"].listeners.submit({ preventDefault() {} });
  await tick();
  assert.equal(consultas2.at(-1).get("q"), "levis");
  const [llego, hasta50, , , , doscientos] = g[".chips-filters"].children;
  hasta50.listeners.click(); await tick();
  assert.equal(consultas2.at(-1).get("precio_max"), "5000");
  assert.equal(consultas2.at(-1).get("q"), "levis");
  assert.equal(consultas2.at(-1).get("despues"), null);          // vuelve a la primera página
  assert.equal(hasta50.attrs["aria-pressed"], "true");
  assert.match(empujadas.at(-1), /^\/\?api=.*&talla=XL&precio_max=5000&dias=7#catalogo$/);
  doscientos.listeners.click(); await tick();                     // una banda a la vez
  assert.equal(consultas2.at(-1).get("precio_max"), null);
  assert.equal(consultas2.at(-1).get("precio_min"), "20000");
  assert.equal(hasta50.attrs["aria-pressed"], "false");
  doscientos.listeners.click(); await tick();                     // tocar la activa la quita
  assert.equal(consultas2.at(-1).get("precio_min"), null);
  llego.listeners.click(); await tick();
  assert.equal(consultas2.at(-1).get("dias"), null);
  assert.equal(consultas2.at(-1).get("q"), "levis");
  g[".filter-size-select"].value = "M";
  g[".filter-size-select"].listeners.change(); await tick();
  assert.equal(consultas2.at(-1).get("talla"), "M");
  assert.match(sitio.search, /talla=M/);
  assert.match(sitio.search, /api=/);                             // lo demás de la URL se conserva
  // Cambiar de categoría suelta la talla (las tallas dependen de la categoría) y conserva precio.
  hasta50.listeners.click(); await tick();
  g[".chips"].children[4].listeners.click(); await tick();        // «Hogar y cocina»
  assert.equal(consultas2.at(-1).get("categoria"), "hogar");
  assert.equal(consultas2.at(-1).get("talla"), null);
  assert.equal(consultas2.at(-1).get("precio_max"), "5000");
  // Sin resultados con filtros, el aviso lo dice.
  assert.equal(g[".catalog-status"].textContent, "1 de 1 piezas");   // el total se anuncia en el aria-live
  doscientos.listeners.click(); await tick();
  assert.equal(consultas2.at(-1).get("precio_min"), "20000");
  g[".search-input"].value = "ninguna";
  g[".catalog-search"].listeners.submit({ preventDefault() {} });
  await tick();
  assert.match(g[".catalog-status"].textContent, /No encontramos piezas para «ninguna» con esos filtros/);
  g[".search-input"].value = "";
  g[".catalog-clear"].listeners.click(); await tick();
  const sinPiezas = pagina(async (url) => ({ ok: true, json: async () => ({ piezas: [], total: 0, hay_mas: false, siguiente: null, tallas: [] }) }), { search: "?dias=7" });
  await tick();
  assert.equal(sinPiezas.partes[".catalog-status"].textContent, "No hay piezas con esos filtros. Quita alguno para ver más.");
  assert.equal(sinPiezas.partes[".filter-size"].hidden, true);   // sin tallas, sin menú

  // Una API anterior a #672 no manda `tallas`: los filtros no se muestran.
  const vieja = pagina(async () => ({ ok: true, json: async () => ({ piezas: [{ nombre: "Pieza", codigo: "ED-1", precio: 5000 }], total: 1, hay_mas: false, siguiente: null }) }));
  await tick();
  assert.equal(vieja.partes[".catalog-filters"].hidden, true);

  console.log("Validated catalog prices in centavos, WhatsApp text, development-only API override, search, ficha, cards (Lo quiero button, stamp only with ultima), retry, size and timeout");
})().catch((error) => { console.error(error); process.exitCode = 1; });
