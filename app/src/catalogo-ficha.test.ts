import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ficha from '../public/catalogo-ficha.js';
import { ANTICIPO, ENVIO_COSTO, ENVIO_GRATIS_DESDE, viernesDeEnvio } from '../public/venta.js';
import { CATEGORIAS } from '../public/categorias.js';

// catalogo-ficha.js es copia de la ficha del sitio y no puede importar venta.js (el host del portal no lo sirve): estas pruebas la atan a su fuente.
test('las constantes y viernesDeEnvio copiados coinciden con venta.js y categorias.js', () => {
  assert.equal(ficha.APARTADO, ANTICIPO);
  assert.equal(ficha.ENVIO_COSTO, ENVIO_COSTO);
  assert.equal(ficha.ENVIO_GRATIS_DESDE, ENVIO_GRATIS_DESDE);
  for (const iso of ['2026-10-29T13:00:00Z', '2026-10-30T05:00:00Z', '2026-11-01T18:00:00Z', '2026-11-06T02:00:00Z'])
    assert.equal(ficha.viernesDeEnvio(new Date(iso)), viernesDeEnvio(new Date(iso)), iso);
  assert.deepEqual(ficha.CATEGORIAS, [['', 'Todo'], ...CATEGORIAS]);
});

test('«Lo quiero» es un solo mensaje corto con el código; bajo $100 se paga completa', () => {
  const pieza = { codigo: 'ED-000123', nombre: 'Chamarra Levis', talla: 'M', precio: 250_00 };
  const ahora = Date.parse('2026-10-31T18:00:00Z'); // sábado → viernes 6 de noviembre
  assert.equal(ficha.enlaceLoQuiero(pieza), 'https://wa.me/524445437754?text=Quiero%20producto%20ED-000123');
  assert.match(ficha.lineaApartado(pieza, ahora), /^Apártala con \$100 por 7 días\./);
  assert.match(ficha.lineaApartado({ ...pieza, precio: 60_00 }, ahora), /^Se paga completa al apartar\./);
  assert.equal(ficha.codigoDePieza('?pieza=ed-12'), 'ED-12');
  assert.equal(ficha.codigoDePieza('?pieza=x'), '');
});

test('portal.html trae todo lo que catalogo-ficha.js busca y el catálogo ya no manda a eldolaron.com ni abre WhatsApp desde la tarjeta', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const js = readFileSync('public/catalogo-ficha.js', 'utf8');
  const clases = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' ')));
  const selectores = [...js.matchAll(/\b[qf]\('([^']+)'\)/g)].map((m) => m[1]).concat(['.ficha-cabeza', '.ficha-scroll', '.ficha-barra']);
  assert.ok(selectores.length > 20);
  for (const sel of new Set(selectores.flatMap((s) => s.split(' ')))) {
    const clase = sel.match(/^\.([a-z-]+)/)?.[1];
    if (clase) assert.ok(clases.has(clase), sel);
  }
  assert.match(html, /id="catalogo"/);
  assert.match(html, /Disponible hoy en tienda<\/p>\s*<p class="ficha-cond">Condición A · Como nueva<\/p>/);
  // «Lo quiero» es un enlace a WhatsApp (el código se agrega al abrir la pieza); no hay hoja de opciones ni «Preguntar por WhatsApp» en la ficha.
  assert.match(html, /<a class="ficha-quiero" href="https:\/\/wa\.me\/524445437754" target="_blank" rel="noopener">Lo quiero<\/a>/);
  assert.doesNotMatch(html, /ficha-hoja|ficha-op|data-op|ficha-entra|ficha-preguntar/);
  assert.doesNotMatch(html, /eldolaron\.com\/#catalogo|novedades/);
  assert.doesNotMatch(readFileSync('public/portal.js', 'utf8'), /novedades|wa\.me\/524445437754\?text/);
  // D7: el catálogo ya no cuelga de la sesión.
  const portal = readFileSync('public/portal.js', 'utf8');
  assert.doesNotMatch(portal.slice(portal.indexOf('async function cargarCuenta'), portal.indexOf('async function actualizarSaldo')), /iniciarCatalogo/);
});
