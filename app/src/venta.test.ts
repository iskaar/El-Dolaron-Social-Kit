// node --test src/venta.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, agregar, leerMultiplicador, efectivoAlcanza, saldoCanjeable, dolaronesGanados, maximoCanje, desfaseReloj, anticipoDePedido, envioDe, anticipoMinimoDe, viernesDeEnvio, promoInauguracion, letreroPromo, PROMO_DESCUENTO, PROMO_MINIMO, transferenciaDe, CLAVE_DESDE } from '../public/venta.js';

interface Linea { codigo: string; nombre: string; precio: number; cantidad: number }
const pieza = (codigo: string, precio: number) => ({ codigo, nombre: codigo, precio });

test('caja: solo el regalo requiere ticket de $1,000, sin descontar los D solicitados', () => {
  const socio = { disponible: 520_00, regalo_disponible: 500_00 };
  assert.equal(saldoCanjeable(null, 1000_00), 0);
  assert.equal(saldoCanjeable(socio, 999_99), 20_00);
  assert.equal(saldoCanjeable(socio, 1000_00), 520_00);
  assert.equal(saldoCanjeable(socio, 1000_01), 520_00);
  assert.equal(saldoCanjeable({ disponible: 20_00, regalo_disponible: 0 }, 20_00), 20_00);
});

test('el total suma precio por cantidad', () => {
  const lineas: Linea[] = [
    { codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 },
    { codigo: 'G19', nombre: 'General $19', precio: 1900, cantidad: 3 },
  ];
  const { piezas, total } = totales(lineas);
  assert.equal(piezas, 4);
  assert.equal(total, 30700); // $250 + 3 x $19 = $307
});

test('el cambio y lo que falta nunca son negativos a la vez', () => {
  const lineas: Linea[] = [{ codigo: 'G49', nombre: 'General $49', precio: 4900, cantidad: 1 }];
  assert.deepEqual(totales(lineas, 10000), { piezas: 1, subtotal: 4900, descuento: 0, total: 4900, aPagar: 4900, cambio: 5100, falta: 0 });
  assert.deepEqual(totales(lineas, 2000), { piezas: 1, subtotal: 4900, descuento: 0, total: 4900, aPagar: 4900, cambio: 0, falta: 2900 });
  assert.deepEqual(totales(lineas, 4900), { piezas: 1, subtotal: 4900, descuento: 0, total: 4900, aPagar: 4900, cambio: 0, falta: 0 });
});

test('un ticket vacio no cobra nada', () => {
  assert.deepEqual(totales([]), { piezas: 0, subtotal: 0, descuento: 0, total: 0, aPagar: 0, cambio: 0, falta: 0 });
});

test('escanear dos veces el mismo bote sube la cantidad, no agrega un renglon', () => {
  let lineas = agregar([], pieza('G19', 1900));
  lineas = agregar(lineas, pieza('G19', 1900));
  assert.equal(lineas.length, 1);
  assert.equal(lineas[0].cantidad, 2);
  assert.equal(totales(lineas).total, 3800);
});

test('dos piezas distintas son dos renglones', () => {
  let lineas = agregar([], pieza('ED-000001', 25000));
  lineas = agregar(lineas, pieza('ED-000002', 8500));
  assert.equal(lineas.length, 2);
  assert.equal(totales(lineas).total, 33500);
});

test('efectivo vacio (0) no alcanza para un total mayor a cero', () => {
  // Antes: dejar el campo en blanco enviaba efectivo=0 y la guarda no se activaba.
  assert.equal(efectivoAlcanza({ formaPago: 'efectivo', total: 4000, efectivo: 0 }), false);
});

test('efectivo exacto o de sobra si alcanza', () => {
  assert.equal(efectivoAlcanza({ formaPago: 'efectivo', total: 4000, efectivo: 4000 }), true);
  assert.equal(efectivoAlcanza({ formaPago: 'efectivo', total: 4000, efectivo: 5000 }), true);
});

test('tarjeta no se valida contra el efectivo', () => {
  assert.equal(efectivoAlcanza({ formaPago: 'tarjeta', total: 4000, efectivo: 0 }), true);
});

test('10 D por bloque completo de $100 pagado', async () => {
  const { dolaronesGanados } = await import('../public/venta.js');
  assert.equal(dolaronesGanados(9900), 0);        // $99 no llega al bloque
  assert.equal(dolaronesGanados(10000), 1000);    // $100 -> 10 D
  assert.equal(dolaronesGanados(25000), 2000);    // $250 -> 20 D
  assert.equal(dolaronesGanados(199900), 19000);  // $1,999 -> 190 D
  assert.equal(dolaronesGanados(-500), 0);
});

test('con Dolarones, el efectivo se compara contra lo que falta pagar', () => {
  const lineas: Linea[] = [{ codigo: 'X', nombre: 'X', precio: 25000, cantidad: 1 }];
  const t = totales(lineas, 20000, 5000);         // $250, paga 50 D y $200 en efectivo
  assert.equal(t.total, 25000);
  assert.equal(t.aPagar, 20000);
  assert.equal(t.cambio, 0);
  assert.equal(t.falta, 0);
});

test('papel: 5 D por bloque; Usar máximo cubre total o saldo elegible sin exceder autorización', () => {
  assert.equal(dolaronesGanados(9900, 5), 0);
  assert.equal(dolaronesGanados(10000, 5), 500);
  assert.equal(dolaronesGanados(25000, 5), 1000);
  assert.equal(dolaronesGanados(199900, 5), 9500);
  const s = { disponible:50000, maximo:50000, regalo_disponible:0, expira_en:'2030-01-01T00:00:00Z' };
  const ahora = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(maximoCanje(s, 30000, ahora), 30000);
  assert.equal(maximoCanje({ ...s, disponible:12000 }, 30000, ahora), 12000);
  assert.equal(maximoCanje({ ...s, maximo:5000 }, 30000, ahora), 5000);
  assert.equal(maximoCanje({ ...s, regalo_disponible:49000 }, 30000, ahora), 1000);
  assert.equal(maximoCanje({ ...s, maximo:undefined }, 30000, ahora), 0, 'teléfono no autoriza');
  assert.equal(maximoCanje({ ...s, expira_en:'fecha inválida' }, 30000, ahora), 0);
  assert.equal(maximoCanje(s, 30000, Date.parse(s.expira_en)), 0);
});

test('reloj de la caja: avisa solo pasados 10 min, con signo, y una cabecera ilegible no avisa', () => {
  const servidor = 'Wed, 07 Oct 2026 18:00:00 GMT';
  const t = Date.parse(servidor);
  assert.equal(desfaseReloj(t, servidor), 0);
  assert.equal(desfaseReloj(t + 10 * 60_000, servidor), 0);
  assert.equal(desfaseReloj(t + 25 * 60_000, servidor), 25);     // adelantado
  assert.equal(desfaseReloj(t - 90 * 60_000, servidor), -90);    // atrasado
  assert.equal(desfaseReloj(t, null), 0);
  assert.equal(desfaseReloj(t, 'basura'), 0);
});

test('el anticipo de un pedido baja lo que se cobra: efectivo y cambio se miden contra el resto', () => {
  const lineas: Linea[] = [{ codigo: 'ED-000001', nombre: 'Ventilador', precio: 30000, cantidad: 1 }];
  // $100 de anticipo en un ticket de $300: faltan $200, no $300.
  const t = totales(lineas, 20000, 0, 0, 10000);
  assert.equal(t.total, 30000);
  assert.equal(t.aPagar, 20000);
  assert.equal(t.falta, 0);
  assert.equal(t.cambio, 0);
  assert.equal(totales(lineas, 25000, 0, 0, 10000).cambio, 5000);
  assert.equal(totales(lineas, 15000, 0, 0, 10000).falta, 5000);
  // Sin anticipo todo sigue igual.
  assert.equal(totales(lineas, 20000).aPagar, 30000);
  // Con Dolarones tambien: 300 - 50 D - 100 de anticipo = 150.
  assert.equal(totales(lineas, 0, 5000, 0, 10000).aPagar, 15000);
});

test('anticipoDePedido: el saldo, sin pasar de lo que falta tras los Dolarones', () => {
  assert.equal(anticipoDePedido(10000, 30000), 10000);            // saldo menor al ticket
  assert.equal(anticipoDePedido(50000, 30000), 30000);            // saldo mayor: solo el ticket, el resto queda a favor
  assert.equal(anticipoDePedido(50000, 30000, 5000), 25000);      // con Dolarones, lo que falta
  assert.equal(anticipoDePedido(10000, 5000, 5000), 0);           // todo cubierto con Dolarones
  assert.equal(anticipoDePedido(10000, 0), 0);                    // ticket vacio
  assert.equal(anticipoDePedido(0, 30000), 0);
});

test('envio de un pedido: $99 bajo $1,000 de piezas, gratis desde $1,000', () => {
  assert.equal(envioDe(0), 0);
  assert.equal(envioDe(1_00), 99_00);
  assert.equal(envioDe(999_99), 99_00);
  assert.equal(envioDe(1000_00), 0);
  assert.equal(envioDe(2500_00), 0);
});

test('apartado: 15% al peso hacia arriba sin mínimo; paquete abre con $100', () => {
  for (const [subtotal, anticipo] of [[0, 0], [50_00, 8_00], [100_00, 15_00], [100_01, 16_00], [250_00, 38_00], [1000_00, 150_00]]) {
    assert.equal(anticipoMinimoDe(subtotal, 'tienda'), anticipo);
    assert.equal(anticipoMinimoDe(subtotal, 'envio'), 100_00);
  }
});

test('viernes de envío: corte estricto del jueves 20:00, con UTC-6 fijo', () => {
  for (const [instante, viernes] of [
    ['2026-10-22T19:59:59.999-06:00', '2026-10-23'],
    ['2026-10-22T20:00:00-06:00', '2026-10-30'],
    ['2026-10-23T00:00:00-06:00', '2026-10-30'],
    ['2026-10-23T19:00:00-06:00', '2026-10-30'],
    ['2026-10-24T09:00:00-06:00', '2026-10-30'],
    ['2026-10-25T09:00:00-06:00', '2026-10-30'],
    ['2026-12-31T19:59:00-06:00', '2027-01-01'],
    ['2026-12-31T20:00:00-06:00', '2027-01-08'],
    // Incluso en fechas históricas con horario de verano se usa UTC-6 fijo.
    ['2020-07-03T01:59:00Z', '2020-07-03'],
    ['2020-07-03T02:00:00Z', '2020-07-10'],
  ]) assert.equal(viernesDeEnvio(instante), viernes, instante);
});

// Cobro con pedido (Issue #269): el saldo solo existe en el servidor, asi que nunca se encola sin red.
const cajaFuente = readFileSync('public/caja.html', 'utf8');
const cobroPedido = (fetchSimulado: () => Promise<unknown>, respuestaForma = 'efectivo', opciones: { sinPedido?: boolean; valores?: Record<string, string> } = {}) => {
  const guardadas: unknown[] = [];
  const preguntas: number[] = [];
  const enviadas: any[] = [];
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, { value: opciones.valores?.[id] ?? (id === 'forma' ? 'efectivo' : id === 'efectivo' ? '200' : ''), textContent: '', style: {}, focus() { this.enfocado = true; } });
    return elementos.get(id);
  };
  const contexto: Record<string, unknown> = {
    crypto, Date, $, AbortSignal, Object, Math, totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE,
    lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: 30000, cantidad: 1 }],
    socio: null, catalogo: new Map(), pedidoCargado: opciones.sinPedido ? null : { id: 'ped-1', folio: 17, saldo: 10000 },
    preguntarForma: async (aPagar: number) => { preguntas.push(aPagar); return respuestaForma; },
    impresionRemota: () => false, exigirCaja: () => true, cajaActual: () => 'Caja 1', dolaronesPedidos: () => 0,
    descuento: null, descuentoAplicado: () => 0, promoActual: () => 0, totalNeto: () => 30000, pintarDescuento() {},
    pesos: String, dolares: String, pintar() {}, quitarSocio() {}, sincronizar() {}, cargarCatalogo() {},
    abrirCajon() {}, imprimirTicket: () => ({ then() {} }), pintarImpresora() {}, promoConfig: null,
    store: async (almacen: string, _modo: string, fn: any) => fn({ put(v: unknown) { if (almacen === 'ventas') guardadas.push(v); } }),
    fetch: async (ruta: string, opciones: any) => { enviadas.push({ ruta, ...JSON.parse(opciones.body) }); return fetchSimulado(); },
  };
  const avisoRojo = cajaFuente.slice(cajaFuente.indexOf('const avisoRojo ='), cajaFuente.indexOf('\n', cajaFuente.indexOf('const avisoRojo =')));
  const conPedido = cajaFuente.slice(cajaFuente.indexOf('async function cobrarConPedido('), cajaFuente.indexOf('/* ---------- cobro: primero'));
  const cobro = cajaFuente.slice(cajaFuente.indexOf('async function cobrar()'), cajaFuente.indexOf('let sincronizando = false;'));
  const errorClave = cajaFuente.slice(cajaFuente.indexOf('function errorClave('), cajaFuente.indexOf("for (const id of ['clave-rastreo'"));
  const cobrar = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, formaElegida = false;
    ${avisoRojo}\n${conPedido}\n${errorClave}\n${cobro}; cobrar`, contexto);
  return { cobrar, contexto, guardadas, enviadas, preguntas, $ };
};

test('17/10: aunque escriba el efectivo, si no eligio la forma se pregunta; con tarjeta no se manda efectivo', async () => {
  const ok = async () => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null, saldo_pedido: 0 }) });
  const conTarjeta = cobroPedido(ok, 'tarjeta');
  await conTarjeta.cobrar();
  assert.deepEqual(conTarjeta.preguntas, [20000]);
  assert.equal(conTarjeta.enviadas[0].forma_pago, 'tarjeta');
  assert.equal(conTarjeta.enviadas[0].efectivo, 0);
  const regresa = cobroPedido(ok, '');
  await regresa.cobrar();
  assert.equal(regresa.enviadas.length, 0);                        // «Regresar» (o el Enter del lector) no cobra
});

test('cobro con pedido sin red: avisa y no encola la venta ni cierra el ticket', async () => {
  const c = cobroPedido(async () => { throw new Error('sin red'); });
  await c.cobrar();
  assert.equal(c.guardadas.length, 0);
  assert.equal(c.enviadas.length, 1);
  assert.equal(c.enviadas[0].pedido_id, 'ped-1');
  assert.equal(c.enviadas[0].anticipo, 10000);
  assert.match(c.$('aviso').textContent, /Sin red.*pedido/);
  assert.equal((c.contexto.pedidoCargado as any).folio, 17);      // sigue cargado para reintentar
  assert.equal((c.contexto.lineas as unknown[]).length, 1);
});

test('cobro con pedido: espera al servidor, manda anticipo y cobra solo el resto', async () => {
  const c = cobroPedido(async () => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null, saldo_pedido: 0 }) }));
  await c.cobrar();
  assert.equal(c.guardadas.length, 0);                              // nunca pasa por la cola local
  assert.equal(c.enviadas[0].anticipo, 10000);
  assert.equal(c.enviadas[0].efectivo, 20000);
  assert.match(c.$('aviso').textContent, /Cobrado\. Cambio 0.*Anticipo P-17 −10000\./);
  assert.equal(c.contexto.pedidoCargado, null);
  assert.equal((c.contexto.lineas as unknown[]).length, 0);
});

// Transferencia desde $300 (#593): la caja pide la clave de rastreo y el monto, y el cobro espera al servidor.
const idToTransferencia = { 'clave-rastreo': ' ejemplo 123456 ', 'monto-transferido': '300' };
test('caja: transferencia de $300 o mas sin clave no se cobra; el error queda junto al campo', async () => {
  const c = cobroPedido(async () => { throw new Error('no debe pedir nada'); }, 'transferencia', { sinPedido: true });
  await c.cobrar();
  assert.equal(c.enviadas.length, 0);
  assert.equal(c.guardadas.length, 0);
  assert.match(c.$('clave-error').textContent, /Escribe la clave de rastreo/);
  assert.equal(c.$('clave-rastreo').enfocado, true);
  const poco = cobroPedido(async () => { throw new Error('no debe pedir nada'); }, 'transferencia',
    { sinPedido: true, valores: { ...idToTransferencia, 'monto-transferido': '299.99' } });
  await poco.cobrar();
  assert.equal(poco.enviadas.length, 0);
  assert.match(poco.$('clave-error').textContent, /Pídele al cliente que transfiera lo que falta/);
  assert.equal(poco.$('monto-transferido').enfocado, true);
});

test('caja: transferencia con clave se manda normalizada, espera al servidor y avisa el excedente; sin red no se encola', async () => {
  const ok = async () => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null, saldo_pedido: null, excedente_transferencia: 1500 }) });
  const c = cobroPedido(ok, 'transferencia', { sinPedido: true, valores: { ...idToTransferencia, 'monto-transferido': '315' } });
  await c.cobrar();
  assert.equal(c.enviadas[0].forma_pago, 'transferencia');
  assert.equal(c.enviadas[0].clave_rastreo, 'EJEMPLO123456');
  assert.equal(c.enviadas[0].monto_transferido, 31500);
  assert.equal(c.guardadas.length, 0);
  assert.match(c.$('aviso').textContent, /Cobrado.*Sobraron 1500 en la transferencia/);
  assert.equal(c.$('clave-rastreo').value, '');   // el siguiente ticket empieza limpio

  const sinRed = cobroPedido(async () => { throw new Error('sin red'); }, 'transferencia', { sinPedido: true, valores: idToTransferencia });
  await sinRed.cobrar();
  assert.equal(sinRed.guardadas.length, 0);
  assert.match(sinRed.$('aviso').textContent, /Sin red.*clave de rastreo/);
  assert.equal((sinRed.contexto.lineas as unknown[]).length, 1);
});

test('caja: transferencia bajo $300 sigue como siempre, sin clave y con la cola local', async () => {
  const c = cobroPedido(async () => { throw new Error('sin red'); }, 'transferencia', { sinPedido: true });
  (c.contexto.lineas as any[])[0].precio = 29999;
  await c.cobrar();
  assert.equal(c.guardadas.length, 1);                       // se encola como hoy
  assert.equal(c.enviadas[0].clave_rastreo, undefined);
});

test('cobro con pedido rechazado por el servidor deja el ticket y el pedido para corregir', async () => {
  const c = cobroPedido(async () => ({ ok: false, status: 409, json: async () => ({ error: 'El saldo del pedido cambió o venció. Vuelve a cargarlo.' }) }));
  await c.cobrar();
  assert.match(c.$('aviso').textContent, /Vuelve a cargarlo/);
  assert.equal((c.contexto.pedidoCargado as any).folio, 17);
  assert.equal(c.guardadas.length, 0);
});

test('3* antes del codigo agrega 3 piezas en un renglon (#358)', () => {
  assert.deepEqual(leerMultiplicador('ED-000123'), { cantidad: 1, codigo: 'ED-000123' });
  assert.deepEqual(leerMultiplicador('3*123'), { cantidad: 3, codigo: '123' });
  assert.deepEqual(leerMultiplicador(' 12 * juguetes 49'), { cantidad: 12, codigo: 'juguetes 49' });
  assert.equal(leerMultiplicador('0*123'), null);
  assert.equal(leerMultiplicador('100*123'), null);
  let lineas = agregar([], pieza('G19', 1900), 3);
  lineas = agregar(lineas, pieza('G19', 1900));
  assert.equal(lineas.length, 1);
  assert.equal(lineas[0].cantidad, 4);
  assert.equal(totales(lineas).total, 7600);
});

test('promo de inauguracion (#487): $100 desde $300.00 exactos, nada por debajo ni fuera de la ventana', () => {
  const ventana = { desde: '2026-10-24T17:00:00Z', hasta: '2026-10-26T02:00:00Z' };
  const dentro = Date.parse('2026-10-24T18:00:00Z');
  assert.equal(PROMO_DESCUENTO, 10000);
  assert.equal(PROMO_MINIMO, 30000);
  assert.equal(promoInauguracion(30000, dentro, ventana), 10000, 'borde: $300.00 exactos');
  assert.equal(promoInauguracion(29999, dentro, ventana), 0, '$299.99');
  assert.equal(promoInauguracion(500000, dentro, ventana), 10000, 'monto fijo, no porcentaje');
  assert.equal(promoInauguracion(30000, Date.parse('2026-10-24T16:59:59Z'), ventana), 0, 'antes de abrir');
  assert.equal(promoInauguracion(30000, Date.parse('2026-10-26T02:00:00Z'), ventana), 0, 'ya cerro');
  assert.equal(promoInauguracion(30000, dentro, null), 0, 'sin configurar');
});

test('letrero de promos en la caja: cuántas quedan solo dentro de la ventana', () => {
  const ventana = { desde: '2026-10-24T17:00:00Z', hasta: '2026-10-26T02:00:00Z' };
  const dentro = Date.parse('2026-10-24T18:00:00Z');
  assert.equal(letreroPromo({ ...ventana, restantes: 37 }, dentro), 'Promos de $100: quedan 37');
  assert.equal(letreroPromo({ ...ventana, restantes: 0 }, dentro), 'Promo de $100 agotada');
  assert.equal(letreroPromo(ventana, dentro), 'Promo $100 activa', 'sin tope');
  assert.equal(letreroPromo({ ...ventana, restantes: 37 }, Date.parse('2026-10-24T16:59:59Z')), '', 'antes de abrir');
  assert.equal(letreroPromo({ ...ventana, restantes: 37 }, Date.parse('2026-10-26T02:00:00Z')), '', 'ya cerró');
  assert.equal(letreroPromo(null, dentro), '', 'sin configurar');
});
