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

// Filtros del catálogo (#672): la copia del portal debe comportarse igual que la del sitio.
test('filtros: la URL y la consulta usan los mismos nombres y no pisan otros parámetros', () => {
  assert.deepEqual(ficha.BANDAS.map(([k, v]) => `${k}=${v}`), ['precio_max=5000', 'precio_max=8000', 'precio_max=10000', 'precio_max=15000', 'precio_min=20000']);
  assert.deepEqual(ficha.filtrosDeUrl(''), { categoria: '', talla: '', banda: -1, dias: false });
  assert.deepEqual(ficha.filtrosDeUrl('?categoria=ropa&talla=%20Ni%C3%B1o%206%20a%C3%B1os%20/%20S&precio_max=8000&dias=7'), { categoria: 'ropa', talla: 'Niño 6 años / S', banda: 1, dias: true });
  assert.deepEqual(ficha.filtrosDeUrl('?precio_min=20000'), { categoria: '', talla: '', banda: 4, dias: false });
  assert.deepEqual(ficha.filtrosDeUrl(`?categoria=armas&precio_max=123&dias=99&talla=${'x'.repeat(40)}`), { categoria: '', talla: 'x'.repeat(30), banda: -1, dias: false });
  assert.equal(ficha.paramsDeFiltros({ categoria: 'ropa', talla: 'M', banda: 4, dias: true }).toString(), 'categoria=ropa&talla=M&precio_min=20000&dias=7');
  assert.equal(ficha.busquedaConFiltros('?pieza=ED-9&r=ABC&dias=7&precio_max=5000', { categoria: 'ropa', talla: '', banda: 4, dias: false }), '?pieza=ED-9&r=ABC&categoria=ropa&precio_min=20000');
  assert.equal(ficha.busquedaConFiltros('?categoria=ropa&talla=M', { categoria: '', talla: '', banda: -1, dias: false }), '');
});

test('filtros: portal.html trae el contenedor de filtros dentro de #catalogo y el sitio y el portal comparten bandas y reglas', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const catalogo = html.slice(html.indexOf('id="catalogo"'), html.indexOf('id="monedero"'));
  assert.match(catalogo, /class="catalogo-filtros"/);
  assert.match(catalogo, /<label for="catalogo-talla">Talla<\/label>\s*<select id="catalogo-talla" class="catalogo-talla-select">/);
  assert.match(catalogo, /class="chips chips-filtros" role="group" aria-label="Filtrar por precio y novedad"/);
  const sitio = readFileSync('../site/public/catalogo.js', 'utf8');
  const bloque = (src: string) => src.slice(src.indexOf('BANDAS = ['), src.indexOf('];', src.indexOf('BANDAS = [')) + 2).replace(/["']/g, "'").replace(/\s+/g, ' ');
  assert.equal(bloque(readFileSync('public/catalogo-ficha.js', 'utf8')), bloque(sitio));
  for (const regla of ['DIAS_NUEVO = 7', 'TALLA_MAX = 30']) {
    assert.ok(sitio.includes(regla) && readFileSync('public/catalogo-ficha.js', 'utf8').includes(regla), regla);
  }
  const css = readFileSync('public/portal.css', 'utf8');
  assert.match(css, /\.catalogo-talla-select \{[^}]*min-height:44px/);
});
