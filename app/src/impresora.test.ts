// node --test src/impresora.test.ts
// El ticket como pagina (Issue #97, impresion por Windows). La impresion en si
// necesita la Epson enfrente; aqui se prueba lo que la pagina dice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sinAcentos, htmlTicket } from '../public/impresora.js';

test('sinAcentos quita acentos y enye, sin romper el resto del texto', () => {
  assert.equal(sinAcentos('Almohada azúl, Peña'), 'Almohada azul, Pena');
});

test('sinAcentos cambia lo que no es ASCII por "?", en vez de mandarlo tal cual', () => {
  assert.equal(sinAcentos('日本語'), '???');
});

const venta = {
  total: 30700, forma_pago: 'efectivo', efectivo: 50000, cambio: 19300, creado_en: '2026-10-02T17:05:00Z',
};
const lineas = [
  { nombre: 'Ventilador de pedestal', precio: 25000, cantidad: 1 },
  { nombre: 'NIÑO 50 12', precio: 1900, cantidad: 3 },
];

test('el ticket lleva piezas, cantidades, total, efectivo y cambio, con acentos', () => {
  const html = htmlTicket(venta, lineas);
  assert.match(html, /Ventilador de pedestal/);
  assert.match(html, /NIÑO 50 12/);
  assert.match(html, /3 x \$19\.00<\/span><span>\$57\.00/);
  assert.match(html, /TOTAL<\/span><span>\$307\.00/);
  assert.match(html, /Efectivo<\/span><span>\$500\.00/);
  assert.match(html, /Cambio<\/span><span>\$193\.00/);
  assert.match(html, /width: 72mm/);
});

test('con Dolarones y socio: lo pagado con D, lo que falta, lo ganado y el saldo', () => {
  const html = htmlTicket(
    { ...venta, forma_pago: 'tarjeta', efectivo: 0, cambio: 0, dolarones: 12000, socio: { numero: 7, ganados: 1000, saldo: 38000 } },
    lineas,
  );
  assert.match(html, /Dolarones<\/span><span>-\$120\.00/);
  assert.match(html, /A pagar<\/span><span>\$187\.00/);
  assert.match(html, /<div>Tarjeta<\/div>/);
  assert.match(html, /Socio #7/);
  assert.match(html, /Ganaste \(usables desde mañana\)<\/span><span>10 D/);
  assert.match(html, /Saldo disponible<\/span><span>380 D/);
  assert.doesNotMatch(html, /Cambio/);
});

test('un nombre con HTML se imprime como texto, no como marcado', () => {
  const html = htmlTicket(venta, [{ nombre: '<img src=x onerror=alert(1)>', precio: 100, cantidad: 1 }]);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
