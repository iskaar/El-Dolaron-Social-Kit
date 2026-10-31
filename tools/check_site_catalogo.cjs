// Run: node tools/check_site_catalogo.cjs
const assert = require("node:assert/strict");
const { precio, consulta, apiBase, codigoDePieza, variadas } = require("../site/public/catalogo.js");

assert.equal(precio(15000), "$150");
assert.equal(precio(24950), "$249.50");
assert.equal(precio(5), "$0.05");
assert.equal(
  consulta({ nombre: "Vestido floral", codigo: "ED-1", precio: 15000 }),
  "https://wa.me/524445437754?text=" + encodeURIComponent("Hola, me interesa Vestido floral (ED-1) de $150. ¿Sigue disponible?"),
);
assert.equal(
  consulta({ nombre: "Blusa", codigo: "ED-2", precio: 8000, talla: "M" }),
  "https://wa.me/524445437754?text=" + encodeURIComponent("Hola, me interesa Blusa talla M (ED-2) de $80. ¿Sigue disponible?"),
);
assert.equal(apiBase(""), "https://dolarones.eldolaron.com");
assert.equal(apiBase("?api=http://127.0.0.1:8787"), "http://127.0.0.1:8787");
for (const bad of ["javascript:alert(1)", "https://evil.example", "ftp://127.0.0.1", "no-es-url"]) {
  assert.equal(apiBase("?api=" + encodeURIComponent(bad)), "https://dolarones.eldolaron.com");
}

// ?pieza= (Issue #590): solo códigos válidos; lo demás se ignora.
assert.equal(codigoDePieza("?pieza=ED-000123"), "ED-000123");
assert.equal(codigoDePieza("?x=1&pieza=ed-7"), "ED-7");
for (const bad of ["", "?pieza=", "?pieza=ED-", "?pieza=ED-1%20OR%201", "?pieza=<script>", "?pieza=ED-12345678901", "?q=ED-1"]) assert.equal(codigoDePieza(bad), "");

// Portada (Issue #630): solo recortes y fotos https, sin repetir marca ni tipo de pieza (cuatro globos iguales no).
{
  const f = (codigo, nombre, marca, recorte = true) => ({ codigo, nombre, marca, foto: `https://x/${codigo}.jpg`, recorte: recorte ? `https://x/r/${codigo}.png` : null });
  const piezas = [
    f("ED-1", "Letrero neón Open", "Pen+Gear"), f("ED-2", "Globos Minnidip", "Minnidip"), f("ED-3", "Globos Minnidip", "Minnidip"),
    f("ED-4", "Globos Mnnidip", "Mnnidip"), f("ED-5", "Toalla de playa", "Sun Squad"), f("ED-6", "Vela", "", false),
    { ...f("ED-7", "Caja de fieltro", "Brightroom"), recorte: "http://x/r/ED-7.png" }, f("ED-8", "Dulces Sugarfina", "Sugarfina"),
    f("ED-9", "Dulces otra marca", "Otra"), f("ED-10", "Cortina", "Sun Squad"), f("ED-11", "Calzones Pampers", ""),
  ];
  assert.deepEqual(variadas(piezas, 6).map((p) => p.codigo), ["ED-1", "ED-2", "ED-5", "ED-8", "ED-11"]);
  assert.deepEqual(variadas(piezas, 2).map((p) => p.codigo), ["ED-1", "ED-2"]);
  assert.deepEqual(variadas(null, 6), []);
}

// Catálogo en una página falsa (Issue #241): reintento, talla, tiempo agotado y botón Reintentar.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const fuente = readFileSync(join(__dirname, "../site/public/catalogo.js"), "utf8");
class Nodo {
  constructor() { this.children = []; this.listeners = {}; this.attrs = {}; this.hidden = false; this.textContent = ""; this.value = ""; this.open = false; this.focused = false; this.style = {}; this.classes = new Set(); this.classList = { add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v) }; }
  append(...xs) { this.children.push(...xs); }
  prepend(...xs) { this.children.unshift(...xs); }
  replaceChildren(...xs) { this.children = xs; }
  setAttribute(k, v) { this.attrs[k] = v; }
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
    ".piece-dialog-img", ".piece-dialog-title", ".piece-dialog-meta", ".piece-dialog-price", ".piece-dialog-ask",
  ];
  const partes = Object.fromEntries(selectores.map((k) => [k, new Nodo()]));
  partes[".catalog-clear"].hidden = true;
  const root = new Nodo();
  root.querySelector = (k) => partes[k];
  const relojes = [];
  vm.runInNewContext(fuente, {
    document: { querySelector: () => null, getElementById: (id) => (id === "catalogo" ? root : null), createElement: () => new Nodo(), ...extra.document },
    location: { search: extra.search || "" }, Image: extra.Image || class extends Nodo {}, matchMedia: extra.matchMedia, fetch: fetcher, AbortController, URL, URLSearchParams, Intl, Number, String, encodeURIComponent,
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
  const fotoBtn = p.partes[".catalog-grid"].children[0].children[0];
  assert.ok(fotoBtn.classes.has("con-recorte"));
  assert.match(fotoBtn.children[0].src, /recorte/);
  fotoBtn.listeners.click();
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
  const morphBtn = morph.partes[".catalog-grid"].children[0].children[0];
  const morphImg = morphBtn.children[0];
  morphBtn.listeners.click();
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
  console.log("Validated catalog prices in centavos, varied hero picks, WhatsApp text, development-only API override, search, photo viewer, retry, size and timeout");
})().catch((error) => { console.error(error); process.exitCode = 1; });
