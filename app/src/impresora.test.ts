// node --test src/impresora.test.ts
// Solo la parte de texto del ticket: el envio por WebUSB necesita hardware real
// y no se puede probar aqui (ver el issue #32 para la validacion fisica).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sinAcentos, centrarTexto, renglonMontoTexto, explicarErrorUsb, rasterEscPos, logoEnFranjas, COLUMNAS } from '../public/impresora.js';

test('sinAcentos quita acentos y enye, sin romper el resto del texto', () => {
  assert.equal(sinAcentos('Almohada azúl, Peña'), 'Almohada azul, Pena');
});

test('sinAcentos cambia lo que no es ASCII por "?", en vez de mandarlo tal cual', () => {
  assert.equal(sinAcentos('日本語'), '???');
});

test('centrarTexto reparte el espacio sobrante a los lados', () => {
  const resultado = centrarTexto('EL DOLARON');
  assert.equal(resultado.length, Math.floor((COLUMNAS - 'EL DOLARON'.length) / 2) + 'EL DOLARON'.length);
  assert.ok(resultado.startsWith(' '.repeat(Math.floor((COLUMNAS - 'EL DOLARON'.length) / 2))));
});

test('centrarTexto con texto mas largo que el papel no lo recorta ni truena', () => {
  const largo = 'x'.repeat(COLUMNAS + 10);
  assert.equal(centrarTexto(largo), largo);
});

test('renglonMontoTexto llena el ancho completo del papel', () => {
  const resultado = renglonMontoTexto('TOTAL', '$150.00');
  assert.equal(resultado.length, COLUMNAS);
  assert.ok(resultado.startsWith('TOTAL'));
  assert.ok(resultado.endsWith('$150.00'));
});

test('renglonMontoTexto dejando un espacio minimo si etiqueta y monto no caben', () => {
  const etiqueta = 'x'.repeat(COLUMNAS);
  const resultado = renglonMontoTexto(etiqueta, '$1.00');
  assert.equal(resultado, `${etiqueta} $1.00`);
});

test('explicarErrorUsb siempre trae el error real; Access denied y NetworkError agregan que hacer', () => {
  const denegado = explicarErrorUsb({ name: 'SecurityError', message: 'Access denied.' });
  assert.ok(denegado.startsWith('SecurityError: Access denied.') && denegado.includes('WinUSB'));
  assert.ok(explicarErrorUsb({ name: 'NetworkError', message: 'Unable to claim interface.' }).includes('Otra pestaña'));
  assert.equal(explicarErrorUsb({ name: 'InvalidStateError', message: 'x' }), 'InvalidStateError: x');
});

test('rasterEscPos: encabezado GS v 0 y un bit por punto, oscuro = 1, transparente = blanco', () => {
  // 10 x 2: renglon 0 negro en x=0 y x=9; renglon 1 negro en x=1 pero transparente.
  const ancho = 10;
  const alto = 2;
  const rgba = new Uint8ClampedArray(ancho * alto * 4).fill(255);
  const pintar = (x: number, y: number, alfa = 255) => rgba.set([0, 0, 0, alfa], (y * ancho + x) * 4);
  pintar(0, 0);
  pintar(9, 0);
  pintar(1, 1, 0);
  const bytes = rasterEscPos(rgba, ancho, alto);
  assert.deepEqual([...bytes.slice(0, 8)], [0x1d, 0x76, 0x30, 0, 2, 0, 2, 0]);   // 2 bytes por renglon, 2 renglones
  assert.deepEqual([...bytes.slice(8)], [0b10000000, 0b01000000, 0, 0]);
});

// ---- Envio por WebUSB con una impresora falsa (Issue #97) ----

function impresoraFalsa() {
  const pedazos: Uint8Array[] = [];
  const dev = {
    opened: false,
    configuration: { configurationValue: 1 },
    configurations: [{ interfaces: [{ interfaceNumber: 0, alternates: [{ endpoints: [{ direction: 'out', endpointNumber: 1 }] }] }] }],
    fallarEn: -1,
    async open() { dev.opened = true; },
    async close() { dev.opened = false; },
    async selectConfiguration() {},
    async claimInterface() {},
    async clearHalt() {},
    async transferOut(_endpoint: number, datos: Uint8Array) {
      if (pedazos.length === dev.fallarEn) { dev.fallarEn = -1; throw new DOMException('A transfer error has occurred.', 'NetworkError'); }
      pedazos.push(datos.slice());
      return { status: 'ok', bytesWritten: datos.length };
    },
  };
  Object.defineProperty(globalThis.navigator, 'usb', { value: { getDevices: async () => [dev] }, configurable: true });
  return { dev, pedazos };
}

const ticketLargo = () => ({
  venta: { total: 99900, forma_pago: 'efectivo', efectivo: 100000, cambio: 100, creado_en: '2026-10-02T17:00:00Z' },
  lineas: Array.from({ length: 60 }, (_, i) => ({ nombre: `Pieza de prueba ${i}`, precio: 1900, cantidad: 1 })),
});

test('el ticket sale en pedazos de a lo mas PEDAZO bytes, completo y en orden', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket, PEDAZO } = await import('../public/impresora.js');
  assert.equal(await reconectarImpresora(), true);
  const { venta, lineas } = ticketLargo();
  assert.equal(await imprimirTicket(venta, lineas), true);
  assert.ok(pedazos.length > 1, 'un ticket largo va en varios pedazos');
  assert.ok(pedazos.every((p) => p.length <= PEDAZO));
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.match(texto, /Pieza de prueba 0\n[\s\S]*Pieza de prueba 59\n[\s\S]*Gracias por su compra/);
});

test('tras una falla, el cajon vuelve a abrir en el siguiente cobro sin recargar', async () => {
  const { dev, pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket, abrirCajon, errorImpresora, impresoraLista } = await import('../public/impresora.js');
  await reconectarImpresora();
  dev.fallarEn = 1;                                   // se corta a media transferencia
  const { venta, lineas } = ticketLargo();
  assert.equal(await imprimirTicket(venta, lineas), false);
  assert.match(errorImpresora(), /NetworkError.*a los 512 de/);
  assert.equal(impresoraLista(), false);
  assert.equal(await abrirCajon(), true);             // reabre sola, sin pedir permiso
  assert.equal(errorImpresora(), '');
  assert.deepEqual([...pedazos.at(-1)!], [0x1b, 0x70, 0x00, 25, 250]);
});

test('cajon y ticket van en fila: nunca se enciman en el puerto', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket, abrirCajon } = await import('../public/impresora.js');
  await reconectarImpresora();
  const antes = pedazos.length;
  const { venta, lineas } = ticketLargo();
  await Promise.all([abrirCajon(), imprimirTicket(venta, lineas)]);
  assert.deepEqual([...pedazos[antes]], [0x1b, 0x70, 0x00, 25, 250]);   // el cajon completo, primero
  assert.equal(pedazos[antes + 1][0], 0x1b);                             // luego arranca el ticket (ESC @)
  assert.equal(pedazos[antes + 1][1], 0x40);
});

test('logoEnFranjas: un GS v 0 por cada 24 renglones, con la misma imagen', () => {
  const ancho = 16;
  const alto = 50;                                   // 24 + 24 + 2
  const rgba = new Uint8ClampedArray(ancho * alto * 4).fill(255);
  rgba.set([0, 0, 0, 255], (49 * ancho + 15) * 4);   // ultimo punto, ultimo renglon
  const bytes = logoEnFranjas(rgba, ancho, alto);
  const encabezados = [];
  for (let i = 0; i < bytes.length;) {
    assert.deepEqual([...bytes.slice(i, i + 4)], [0x1d, 0x76, 0x30, 0]);
    const renglones = bytes[i + 6] | (bytes[i + 7] << 8);
    encabezados.push(renglones);
    i += 8 + 2 * renglones;                          // 2 bytes por renglon
  }
  assert.deepEqual(encabezados, [24, 24, 2]);
  assert.equal(bytes.at(-1), 0b00000001);            // el punto negro sigue en su lugar
});
