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
assert.equal(apiBase(""), "https://dolarones.eldolaron.com");
assert.equal(apiBase("?api=http://127.0.0.1:8787"), "http://127.0.0.1:8787");
for (const bad of ["javascript:alert(1)", "https://evil.example", "ftp://127.0.0.1", "no-es-url"]) {
  assert.equal(apiBase("?api=" + encodeURIComponent(bad)), "https://dolarones.eldolaron.com");
}
console.log("Validated catalog prices in centavos, WhatsApp text and development-only API override");
