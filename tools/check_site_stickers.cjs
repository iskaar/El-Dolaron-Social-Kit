// Run: node tools/check_site_stickers.cjs
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { runInNewContext } = require("node:vm");
const script = readFileSync(join(__dirname, "../site/public/stickers.js"), "utf8");

class Nodo {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.hidden = false; this.classes = new Set(); this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } }; this.classList = { add: (v) => this.classes.add(v) }; }
  append(...xs) { this.children.push(...xs); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  querySelector() { return this.imagen; }
}
const pieza = (n) => ({ nombre: "Pieza " + n, codigo: "ED-" + n, precio: 149900, foto: "https://x.test/foto/" + n, recorte: "https://x.test/recorte/" + n });
const paginas = [
  { piezas: [pieza(1), pieza(2), pieza(3), { ...pieza(0), recorte: null }], hay_mas: true, siguiente: "c1" },   // la sin recorte no entra al rollo
  { piezas: [pieza(4), pieza(5), pieza(6), pieza(7)], hay_mas: false, siguiente: null },
];
function corre(pila) {
  const urls = [];
  const arte = new Nodo("figure");
  arte.imagen = new Nodo("img");
  const modulo = { exports: {} };
  runInNewContext(script, {
    module: modulo, location: { search: "" }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, Intl, Promise, JSON, Math, Number, Array,
    document: { querySelector: () => arte, createElement: (t) => new Nodo(t), addEventListener() {} },
    Image: class { decode() { return Promise.resolve(); } },
    matchMedia: () => ({ matches: false }), requestAnimationFrame: (fn) => fn(),
    fetch: async (url) => {
      if (String(url).includes("pila.json")) {   // pila.json: se lee relativo a la página; puede fallar
        if (!pila) throw new Error("sin red");
        return { ok: true, json: async () => pila };
      }
      urls.push(String(url));
      return { ok: true, json: async () => paginas[urls.length - 1] };
    },
  });
  return modulo.exports.hecho.then((r) => ({ ...r, urls, arte, precio: modulo.exports.precio }));
}
(async () => {
  // La pila ya muestra ED-2 y ED-5: no deben repetirse en el rollo.
  const { rollo, tablero, urls, arte, precio } = await corre({ piezas: [{ codigo: "ED-2" }, { codigo: "ED-5" }] });
  assert.equal(precio(149900), "$1,499");
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => new URL(u).searchParams.get("recorte") === "1"));   // pide solo piezas con recorte
  assert.ok(!urls[0].includes("despues"));
  assert.equal(new URL(urls[1]).searchParams.get("despues"), "c1");   // pidió la 2 con el cursor y paró: hay_mas era false
  assert.equal(rollo.map((p) => p.codigo).join(), ["ED-1", "ED-3", "ED-4", "ED-6", "ED-7"].join());   // sin la de recorte null ni las de la pila
  assert.equal(tablero.children.length, 5);
  assert.equal(tablero.children[0].attrs["aria-label"], "Ver Pieza 1, $1,499");
  const lugares = tablero.children.map((n) => [n.lugar, n.style.props["--l"], n.style.props["--t"], n.style.props["--w"], n.style.props["--r"]].join("|"));
  assert.equal(new Set(lugares).size, 5);   // cinco lugares distintos, cada uno con caja y giro
  assert.ok(lugares.every((l) => !l.includes("undefined")));
  assert.ok(arte.classes.has("con-stickers"));
  assert.equal(arte.children.length, 1);   // el tablero se suma sin quitar la pila (la imagen del HTML)

  // Si pila.json falla no se excluye nada.
  const sin = await corre(null);
  assert.equal(sin.rollo.length, 7);
  assert.equal(sin.tablero.children.length, 5);
  console.log("Validated sticker roll: recorte=1 and cursor pages, pila.json codes excluded (and kept when it fails), 5 fixed slots, price format");
})().catch((error) => { console.error(error); process.exitCode = 1; });
