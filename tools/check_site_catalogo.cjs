// Run: node tools/check_site_catalogo.cjs
const assert = require("node:assert/strict");
const { precio, consulta, apiBase } = require("../site/public/catalogo.js");

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

// Catálogo en una página falsa (Issue #241): reintento, talla, tiempo agotado y botón Reintentar.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const fuente = readFileSync(join(__dirname, "../site/public/catalogo.js"), "utf8");
class Nodo {
  constructor() { this.children = []; this.listeners = {}; this.attrs = {}; this.hidden = false; this.textContent = ""; this.value = ""; this.open = false; this.focused = false; this.classes = new Set(); this.classList = { add: (v) => this.classes.add(v), remove: (v) => this.classes.delete(v) }; }
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
function pagina(fetcher) {
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
    document: { querySelector: () => null, getElementById: (id) => (id === "catalogo" ? root : null), createElement: () => new Nodo() },
    location: { search: "" }, Image: class extends Nodo {}, fetch: fetcher, AbortController, URL, URLSearchParams, Intl, Number, String, encodeURIComponent,
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
  console.log("Validated catalog prices in centavos, WhatsApp text, development-only API override, search, photo viewer, retry, size and timeout");
})().catch((error) => { console.error(error); process.exitCode = 1; });
