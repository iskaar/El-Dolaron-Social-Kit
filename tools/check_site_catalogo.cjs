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
  constructor() { this.children = []; this.listeners = {}; this.attrs = {}; this.hidden = false; this.textContent = ""; }
  append(...xs) { this.children.push(...xs); }
  prepend(...xs) { this.children.unshift(...xs); }
  replaceChildren(...xs) { this.children = xs; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
}
function pagina(fetcher) {
  const partes = Object.fromEntries([".chips", ".catalog-grid", ".catalog-status", ".catalog-more", ".catalog-fallback", ".catalog-retry"].map((k) => [k, new Nodo()]));
  const root = new Nodo();
  root.querySelector = (k) => partes[k];
  const relojes = [];
  vm.runInNewContext(fuente, {
    document: { querySelector: () => null, getElementById: () => root, createElement: () => new Nodo() },
    location: { search: "" }, Image: class extends Nodo {}, fetch: fetcher, AbortController, URL, URLSearchParams, Intl, Number, encodeURIComponent,
    setTimeout: (fn) => relojes.push(fn), clearTimeout: () => {},
  });
  const textos = () => partes[".catalog-grid"].children.map((li) => li.children[1].children.map((n) => n.textContent));
  return { partes, root, relojes, textos };
}
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // Página 2 falla una vez: el reintento pide la MISMA (mismo cursor) y no se salta piezas.
  const pedidas = [];
  let falla = true;
  const p = pagina(async (url) => {
    const despues = new URL(url).searchParams.get("despues");
    pedidas.push(despues);
    if (despues === "c1" && falla) { falla = false; throw new Error("red"); }
    const n = despues === "c1" ? 2 : 1;
    return { ok: true, json: async () => ({ piezas: [{ nombre: "Pieza " + n, codigo: "ED-" + n, precio: 10000, talla: n === 1 ? "M" : null }], total: 2, hay_mas: n === 1, siguiente: n === 1 ? "c1" : null }) };
  });
  await tick();
  p.partes[".catalog-more"].listeners.click(); await tick();
  assert.match(p.partes[".catalog-status"].textContent, /Intenta de nuevo/);
  p.partes[".catalog-more"].listeners.click(); await tick();
  assert.deepEqual(pedidas, [null, "c1", "c1"]);
  assert.deepEqual(p.textos().map((t) => t[0]), ["Pieza 1", "Pieza 2"]);
  assert.deepEqual(p.textos()[0].slice(0, 2), ["Pieza 1", "Talla M"]);   // talla visible
  assert.ok(!p.textos()[1].some((t) => /Talla/.test(t)));               // sin talla, sin etiqueta vacía

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
  assert.equal(lenta.root.attrs["aria-busy"], undefined);
  responde = true;
  lenta.partes[".catalog-retry"].listeners.click(); await tick();
  assert.equal(lenta.partes[".chips"].hidden, false);
  assert.equal(lenta.partes[".catalog-fallback"].hidden, true);
  assert.deepEqual(lenta.textos().map((t) => t[0]), ["Ya"]);
  console.log("Validated catalog prices in centavos, WhatsApp text, development-only API override, retry, size and timeout");
})().catch((error) => { console.error(error); process.exitCode = 1; });
