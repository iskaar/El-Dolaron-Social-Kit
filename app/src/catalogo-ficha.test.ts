import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as ficha from '../public/catalogo-ficha.js';
import { ANTICIPO_ENVIO, ENVIO_COSTO, ENVIO_GRATIS_DESDE, viernesDeEnvio } from '../public/venta.js';
import { CATEGORIAS } from '../public/categorias.js';

// catalogo-ficha.js es copia de la ficha del sitio y no puede importar venta.js (el host del portal no lo sirve): estas pruebas la atan a su fuente.
test('las constantes y viernesDeEnvio copiados coinciden con venta.js y categorias.js', () => {
  assert.equal(ficha.APARTADO, ANTICIPO_ENVIO);
  assert.equal(ficha.ENVIO_COSTO, ENVIO_COSTO);
  assert.equal(ficha.ENVIO_GRATIS_DESDE, ENVIO_GRATIS_DESDE);
  for (const iso of ['2026-10-29T13:00:00Z', '2026-10-30T05:00:00Z', '2026-11-01T18:00:00Z', '2026-11-06T02:00:00Z'])
    assert.equal(ficha.viernesDeEnvio(new Date(iso)), viernesDeEnvio(new Date(iso)), iso);
  assert.deepEqual(ficha.CATEGORIAS, [['', 'Todo'], ...CATEGORIAS]);
});

test('los textos de «Lo quiero» llevan pieza, precio y día de envío; bajo $100 se paga completa', () => {
  const pieza = { codigo: 'ED-000123', nombre: 'Chamarra Levis', talla: 'M', precio: 250_00 };
  const ahora = Date.parse('2026-10-31T18:00:00Z'); // sábado → viernes 6 de noviembre
  assert.equal(ficha.mensajeQuiero(pieza, 'preguntar', ahora), 'Hola, tengo una pregunta sobre *Chamarra Levis talla M* (ED-000123) de $250.');
  assert.match(ficha.mensajeQuiero(pieza, 'recoger', ahora), /Dejo \$100 de apartado y paso a recogerla a Jardín Hidalgo 129\.$/);
  assert.match(ficha.mensajeQuiero(pieza, 'envio', ahora), /viernes 6 de noviembre \(gratis desde \$1,000; si no, \$99\)/);
  assert.match(ficha.mensajeQuiero({ ...pieza, precio: 60_00 }, 'recoger', ahora), /La pago completa al apartarla/);
  assert.match(ficha.lineaApartado(pieza, ahora), /^Apártala con \$100 por 7 días\./);
  assert.match(ficha.lineaApartado({ ...pieza, precio: 60_00 }, ahora), /^Se paga completa al apartar\./);
  assert.ok(ficha.enlaceQuiero(pieza, 'recoger', ahora).startsWith('https://wa.me/524445437754?text='));
  assert.equal(ficha.codigoDePieza('?pieza=ed-12'), 'ED-12');
  assert.equal(ficha.codigoDePieza('?pieza=x'), '');
});

test('portal.html trae todo lo que catalogo-ficha.js busca y el catálogo ya no manda a eldolaron.com ni abre WhatsApp desde la tarjeta', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const js = readFileSync('public/catalogo-ficha.js', 'utf8');
  const clases = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' ')));
  const selectores = [...js.matchAll(/\b[qf]\('([^']+)'\)/g)].map((m) => m[1]).concat(['.ficha-op', '.ficha-cabeza', '.ficha-scroll', '.ficha-barra']);
  assert.ok(selectores.length > 20);
  for (const sel of new Set(selectores.flatMap((s) => s.split(' ')))) {
    const clase = sel.match(/^\.([a-z-]+)/)?.[1];
    if (clase) assert.ok(clases.has(clase), sel);
  }
  assert.match(html, /id="catalogo"/);
  assert.match(html, /Entra con tu celular \(arriba\) y acumulas Dolarones con esta compra\. O sigue como invitado:/);
  assert.equal(html.match(/data-op="/g)?.length, 3);
  assert.doesNotMatch(html, /eldolaron\.com\/#catalogo|novedades/);
  assert.doesNotMatch(readFileSync('public/portal.js', 'utf8'), /novedades|wa\.me\/524445437754\?text/);
  // D7: el catálogo ya no cuelga de la sesión.
  const portal = readFileSync('public/portal.js', 'utf8');
  assert.doesNotMatch(portal.slice(portal.indexOf('async function cargarCuenta'), portal.indexOf('async function actualizarSaldo')), /iniciarCatalogo/);
});
