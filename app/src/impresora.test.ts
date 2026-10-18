// node --test src/impresora.test.ts
// Solo la parte de texto del ticket: el envio por WebUSB necesita hardware real
// y no se puede probar aqui (ver el issue #32 para la validacion fisica).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sinAcentos, centrarTexto, renglonMontoTexto, explicarErrorUsb, COLUMNAS } from '../public/impresora.js';

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
  const { reconectarImpresora, imprimirTicket, abrirCajon, errorImpresora, impresoraLista, PEDAZO } = await import('../public/impresora.js');
  await reconectarImpresora();
  dev.fallarEn = 1;                                   // se corta a media transferencia
  const { venta, lineas } = ticketLargo();
  assert.equal(await imprimirTicket(venta, lineas), false);
  assert.match(errorImpresora(), new RegExp(`NetworkError.*a los ${PEDAZO} de`));
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

test('el ticket arranca con EL DOLARON en texto grande y centrado, sin imagen', async () => {
  const { dev, pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket } = await import('../public/impresora.js');
  await reconectarImpresora();
  const { venta, lineas } = ticketLargo();
  assert.equal(await imprimirTicket(venta, lineas), true);
  const bytes = Uint8Array.from(pedazos.flatMap((p) => [...p]));
  assert.deepEqual([...bytes.slice(0, 8)], [0x1b, 0x40, 0x1b, 0x61, 1, 0x1b, 0x21, 0x30]);
  assert.equal(new TextDecoder().decode(bytes.slice(8, 18)), 'EL DOLARON');
  assert.ok(!bytes.some((b, i) => b === 0x1d && bytes[i + 1] === 0x76), 'ningun GS v 0 (imagen)');
  void dev;
});

test('el corte impreso trae lo esperado, lo contado, el faltante en negritas y dos firmas', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirCorte } = await import('../public/impresora.js');
  await reconectarImpresora();
  const antes = pedazos.length;
  assert.equal(await imprimirCorte({
    caja: 'Caja 2', cajero: 'caja@prueba.mx', desde: null, hasta: '2026-10-03T02:05:00Z', tickets: 12,
    fondo_inicial: 50000, efectivo_ventas: 180000, efectivo_devoluciones: 4900, retiros: 100000,
    efectivo_esperado: 125100, efectivo_contado: 120100, diferencia: -5000,
    tarjeta_sistema: 60000, tarjeta_terminal: 60000, transferencias: 14900, dolarones: 5000,
    fondo_siguiente: 50000, entregado: 70100, gastos: 0,
    notas: 'Se cayo un billete detras del cajon',
  }), true);
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.slice(antes).flatMap((p) => [...p])));
  assert.match(texto, /CORTE DE CAJA/);
  assert.match(texto, /Caja: Caja 2/);
  assert.match(texto, /primer corte de esta caja/);
  assert.match(texto, /= Esperado +\$1251\.00/);
  assert.match(texto, /Contado +\$1201\.00/);
  assert.match(texto, /\x1bE\x01FALTANTE +\$50\.00/);
  assert.match(texto, /SE ENTREGA +\$701\.00/);
  assert.match(texto, /Se cayo un billete/);
  assert.match(texto, /Entrega: _+\n +caja@prueba\.mx[\s\S]*Recibe: +_+/);
});

test('el retiro impreso trae importe, motivo y firmas', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirRetiro } = await import('../public/impresora.js');
  await reconectarImpresora();
  const antes = pedazos.length;
  await imprimirRetiro({ caja: 'Caja 1', cajero: 'caja@prueba.mx', creado_en: '2026-10-02T20:00:00Z', importe: 100000, motivo: 'Caja fuerte' });
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.slice(antes).flatMap((p) => [...p])));
  assert.match(texto, /RETIRO DE EFECTIVO[\s\S]*IMPORTE +\$1000\.00[\s\S]*Caja fuerte[\s\S]*Recibe:/);
});

test('el gasto impreso dice GASTO DE CAJA y el concepto', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirRetiro } = await import('../public/impresora.js');
  await reconectarImpresora();
  const antes = pedazos.length;
  await imprimirRetiro({ tipo: 'gasto', caja: 'Caja 1', cajero: 'caja@prueba.mx', creado_en: '2026-10-02T20:00:00Z', importe: 4500, motivo: 'Garrafon de agua' });
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.slice(antes).flatMap((p) => [...p])));
  assert.match(texto, /GASTO DE CAJA[\s\S]*IMPORTE +\$45\.00[\s\S]*Concepto:\nGarrafon de agua/);
});

test('vale usa Code128 nativo con longitud, saldo y vencimiento; no raster ni comandos inyectados', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket, imprimirVale, codigoBarrasVale } = await import('../public/impresora.js');
  await reconectarImpresora();
  const vale = { codigo:'DP-abcdefghijklmnop', restante:1000,
    disponible_desde:'2026-10-03T06:00:00Z', vence_en:'2026-11-01T18:00:00Z', creado_en:'2026-10-02T18:00:00Z' };
  const codigo = codigoBarrasVale(vale.codigo);
  const pos = [...codigo].findIndex((b,i) => b===0x1d && codigo[i+1]===0x6b);
  // Conjunto C: {C + 15 pares de los 30 dígitos que el lector escribe y la caja traduce.
  const { codigoEnDigitos, codigoDeDigitos } = await import('../public/code128.js');
  const digitos = codigoEnDigitos(vale.codigo);
  assert.deepEqual([...codigo.slice(pos,pos+4)], [0x1d,0x6b,73,17]);
  assert.deepEqual([...codigo.slice(pos+4,pos+21)], [0x7b,0x43,...digitos.match(/../g)!.map(Number)]);
  assert.equal(codigoDeDigitos(digitos), vale.codigo);
  assert.equal(codigoDeDigitos('000123'), null);   // etiqueta de pieza: sigue siendo pieza
  assert.throws(() => codigoBarrasVale('DP-abc\x1b@'), /inválido/);
  const { venta, lineas } = ticketLargo();
  await imprimirTicket({ ...venta, vale_emitido:vale }, lineas);
  await imprimirVale(vale);
  const bytes = Uint8Array.from(pedazos.flatMap((p) => [...p]));
  const texto = new TextDecoder().decode(bytes);
  assert.match(texto, /Saldo del vale +10\.00 D/);
  assert.match(texto, /Vence:.*2026/);
  assert.match(texto, /Disponible: 03\/10\/2026, (00:00|12:00 a\.m\.)/);
  assert.doesNotMatch(texto, /Usalo en tu siguiente compra/);
  assert.match(texto, /Copias comparten el saldo/);
  // El ticket no lleva código de barras; el vale sale aparte, más la reimpresión: 2.
  assert.equal(bytes.filter((b,i) => b===0x1d && bytes[i+1]===0x6b).length, 2);
  assert.equal(texto.split('DP-abcdefghijklmnop').length-1, 3);
  assert.ok(!bytes.some((b,i) => b===0x1d && bytes[i+1]===0x76), 'sin imagen raster');
});

test('vale nuevo anuncia siguiente compra en ticket y reimpresión; socio conserva mañana', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket, imprimirVale } = await import('../public/impresora.js');
  await reconectarImpresora();
  const vale = { codigo:'DP-abcdefghijklmnop', restante:1000, creado_en:'2026-10-02T18:00:00.000Z',
    disponible_desde:'2026-10-02T18:00:00Z', vence_en:'2026-11-01T18:00:00Z' };
  const { venta, lineas } = ticketLargo();
  await imprimirTicket({ ...venta, vale_emitido:vale, vale_usado:vale,
    socio:{ numero:1, ganados:2000, saldo:0 } }, lineas);
  await imprimirVale({ ...vale, disponible_desde:'2026-10-02T17:59:59Z' });
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.equal(texto.split('Usalo en tu siguiente compra').length - 1, 4);   // ticket x2, vale aparte, reimpresión
  assert.doesNotMatch(texto, /Disponible:/);
  assert.match(texto, /Ganaste \(usables desde manana\)/);
  assert.match(texto, /Vence: 01\/11\/2026, 12:00/);
});

test('un ticket pendiente no imprime un barcode gastable', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket } = await import('../public/impresora.js');
  await reconectarImpresora();
  const { venta, lineas } = ticketLargo();
  await imprimirTicket({ ...venta, vale_pendiente:true }, lineas);
  const bytes = Uint8Array.from(pedazos.flatMap((p) => [...p]));
  assert.match(new TextDecoder().decode(bytes), /Elegibilidad de vale sin confirmar/);
  assert.ok(!bytes.some((b,i) => b===0x1d && bytes[i+1]===0x6b));
});

test('ticket de socio en cola no anuncia Dolarones antes de la respuesta del servidor', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirTicket } = await import('../public/impresora.js');
  await reconectarImpresora();
  const { venta, lineas } = ticketLargo();
  await imprimirTicket({ ...venta, socio:{ numero:1, ganados:0, saldo:0 }, recompensa_pendiente:true }, lineas);
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.match(texto, /Dolarones de compra sin confirmar/);
  assert.doesNotMatch(texto, /Ganaste/);
});

test('el corte impreso lista las piezas del conteo, de mayor a menor', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirCorte } = await import('../public/impresora.js');
  await reconectarImpresora();
  const antes = pedazos.length;
  await imprimirCorte({
    caja: 'Caja 1', cajero: 'caja@prueba.mx', desde: null, hasta: '2026-10-03T02:05:00Z', tickets: 1,
    fondo_inicial: 50000, efectivo_ventas: 25000, efectivo_devoluciones: 0, retiros: 0, gastos: 0,
    efectivo_esperado: 75000, efectivo_contado: 75000, diferencia: 0,
    tarjeta_sistema: 0, tarjeta_terminal: 0, transferencias: 0, dolarones: 0,
    fondo_siguiente: 50000, entregado: 25000, notas: '',
    conteo: JSON.stringify({ '5000': 1, '50000': 1, '10000': 2 }),
  });
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.slice(antes).flatMap((p) => [...p])));
  assert.match(texto, /CONTEO\n +1 x \$500\.00 +\$500\.00\n +2 x \$100\.00 +\$200\.00\n +1 x \$50\.00 +\$50\.00/);
});

test('QR del vale (Issue #258): URL al portal con el código tras #; la caja lo sigue leyendo; invita solo si está completo', async () => {
  const { pedazos } = impresoraFalsa();
  const { reconectarImpresora, imprimirVale, codigoQrVale, URL_VALE } = await import('../public/impresora.js');
  const { codigoEnDigitos, codigoDeDigitos } = await import('../public/code128.js');
  await reconectarImpresora();
  const vale = { codigo:'DP-abcdefghijklmnop', importe:1000, restante:1000, creado_en:'2026-10-02T18:00:00.000Z',
    disponible_desde:'2026-10-02T18:00:00Z', vence_en:'2026-11-01T18:00:00Z' };
  const url = URL_VALE + codigoEnDigitos(vale.codigo);
  assert.equal(url, 'https://dolarones.eldolaron.com/v#' + codigoEnDigitos(vale.codigo));
  assert.ok(new TextDecoder().decode(codigoQrVale(vale.codigo)).includes(url));
  assert.equal(codigoDeDigitos(url), vale.codigo);   // la cámara de la caja lee el QR nuevo
  await imprimirVale(vale);
  await imprimirVale({ ...vale, restante:400 });      // usado en parte: ya no se puede pasar
  const texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.equal(texto.split('registrate y recibe el doble').length - 1, 1);
});
