import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transferenciaDe, importeDeComprobante, envioDe, anticipoMinimoDe } from '../public/venta.js';

const fuente = readFileSync('public/pedidos.html', 'utf8').replace(/\r\n/g, '\n');

test('el módulo de pedidos completo tiene sintaxis válida', () => {
  const script = fuente.split('<script type="module">')[1].split('</script>')[0].replace(/^import .*;$/gm, '');
  const FuncionAsincrona = Object.getPrototypeOf(async () => {}).constructor;
  assert.doesNotThrow(() => new FuncionAsincrona(script));
});

function pantalla(memoria: Map<string, string>, enviar: (ruta: string, cuerpo: any) => Promise<any>, permiteGuardar = true) {
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, {
      value: '', hidden: false, disabled: false, textContent: '', className: '',
      addEventListener(tipo: string, fn: any) { this[tipo] = fn; },
      showModal() { this.open = true; },
      focus() { this.enfocado = true; },
      close() { this.open = false; },
    });
    return elementos.get(id);
  };
  $('caja-nombre').value = 'Caja 1';
  const contexto = {
    $, crypto, JSON, Number, Math, transferenciaDe, importeDeComprobante,
    localStorage: {
      getItem: (k: string) => memoria.get(k) ?? null,
      setItem: (k: string, v: string) => { if (!permiteGuardar) throw new Error('sin memoria'); memoria.set(k, v); },
      removeItem: (k: string) => memoria.delete(k),
    },
    pedidos: [{ folio: 17, cliente: 'Ana', faltante: 24900 }],
    buscarPieza: () => ({ id: 'pieza-1' }), pesos: (n: number) => `$${n / 100}`, fecha: String,
    decir: (id: string, texto: string) => { $(id).textContent = texto; },
    cargarLista: async () => {}, cargarCatalogo: async () => {},
    fetch: (ruta: string, opciones: any) => enviar(ruta, JSON.parse(opciones.body)),
  };
  const bloque = fuente.slice(fuente.indexOf('const CLAVE_MOVIMIENTO ='), fuente.indexOf('\npintar();\nawait cargarCatalogo();'));
  // Las ayudas de clave de rastreo (#593) viven antes del bloque: centavos, leerTransferencia, errorTransferencia, avisoExcedente.
  const ayudas = fuente.slice(fuente.indexOf('const centavos ='), fuente.indexOf("gerencia.` : '';") + "gerencia.` : '';".length);
  const abrir = runInNewContext(`${ayudas}\n${bloque}\nabrirMovimiento`, contexto);
  return { $, abrir, guardar: () => $('form-mover').submit({ preventDefault() {} }) };
}

test('abono con respuesta perdida conserva ID, importe y caja, incluso al recargar la página', async () => {
  const memoria = new Map<string, string>();
  const enviados: any[] = [];
  const primera = pantalla(memoria, async (_ruta, cuerpo) => { enviados.push(cuerpo); throw new Error('respuesta perdida'); });
  primera.abrir(17, 'abono');
  primera.$('mover-importe').value = '123.45';
  primera.$('mover-forma').value = 'tarjeta';
  await primera.guardar();
  assert.equal(memoria.size, 1);
  assert.match(primera.$('mover-aviso').textContent, /No recibas otra vez el dinero/);
  const segunda = pantalla(memoria, async (ruta, cuerpo) => {
    assert.equal(ruta, '/api/pedidos/17/abonos');
    enviados.push(cuerpo);
    return { ok: true, status: 200, json: async () => ({ faltante: 12555 }) };
  });
  segunda.abrir(99, 'pieza'); // un movimiento pendiente manda sobre un nuevo formulario
  segunda.$('mover-importe').value = '999';
  segunda.$('caja-nombre').value = 'Caja 2';
  await segunda.guardar();
  assert.deepEqual(enviados[1], enviados[0]);
  assert.equal(enviados[0].importe, 12345);
  assert.equal(enviados[0].caja, 'Caja 1');
  assert.equal(memoria.size, 0);
});

test('sin memoria durable no se envía un abono; un fallo 500 conserva el intento', async () => {
  const memoria = new Map<string, string>();
  let enviados = 0;
  const sinMemoria = pantalla(memoria, async () => { enviados++; }, false);
  sinMemoria.abrir(17, 'abono');
  sinMemoria.$('mover-forma').value = 'efectivo';
  await sinMemoria.guardar();
  assert.equal(enviados, 0);
  assert.equal(memoria.size, 0);
  assert.match(sinMemoria.$('mover-aviso').textContent, /Habilita la memoria/);
  const p = pantalla(memoria, async () => ({ ok: false, status: 500, json: async () => ({ error: 'fallo' }) }));
  p.abrir(17, 'abono');
  p.$('mover-forma').value = 'efectivo';
  await p.guardar();
  assert.equal(memoria.size, 1);
  assert.equal(p.$('recuperar-movimiento').hidden, false);
  assert.equal(p.$('mover-guardar').disabled, false);
});

test('Por enviar separa los viernes confirmados de los paquetes pendientes y muestra lo que falta', () => {
  const html = new Map<string, any>();
  const $ = (id: string) => {
    if (!html.has(id)) html.set(id, {});
    return html.get(id);
  };
  const base = { cliente: 'Ana', telefono: '4441234567', vendedora: 'caja@prueba.mx', entrega: 'envio', guia: '',
    anticipo: 10000, subtotal: 25000, envio: 9900, saldo: 10000, vence_en: '2030-01-01', lineas: [] };
  const pedidos = [
    { ...base, folio: 1, estado: 'apartado', liquidado_en: null, viernes_envio: null, faltante: 24900 },
    { ...base, folio: 2, estado: 'vendido', liquidado_en: '2026-10-22T19:00:00-06:00', viernes_envio: '2026-10-23', faltante: 0, saldo: 0 },
    { ...base, folio: 3, estado: 'vendido', liquidado_en: '2026-10-22T20:00:00-06:00', viernes_envio: '2026-10-30', faltante: 0, saldo: 0 },
  ];
  const bloque = fuente.slice(fuente.indexOf('const vendedoraDe ='), fuente.indexOf("$('actualizar').addEventListener"));
  const pintar = runInNewContext(`${bloque}\npintarLista`, {
    $, pedidos, Date, guardadas: new Map(), escapar: String, pesos: (n: number) => `$${n / 100}`, dia: () => '2026-10-22',
    fecha: (s: string) => s.slice(0, 10), piezasDe: () => 'Prenda', totalDe: () => 34900,
    enlaceWhatsApp: () => '#', mensajeConfirmar: () => '', mensajeGuia: () => '', mensajeSaldo: () => '',
  });
  pintar();
  const envios = $('lista-envios').innerHTML;
  assert.match(envios, /Por liquidar · viernes pendiente/);
  assert.match(envios, /Viernes 2026-10-23/);
  assert.match(envios, /Viernes 2026-10-30/);
  assert.match(envios, /Falta \$249/);
  assert.match(envios, /data-mover="1"/);
  assert.doesNotMatch(envios, /data-guia="1"/);
  assert.match(envios, /data-guia="2"/);
  assert.match(envios, /Liquidado: no vence/);
});

test('un apartado de revendedora (anticipo 0) dice «Sin anticipo · vence … · nombre» y trae su botón de abono; el normal con anticipo también, sin Sin anticipo (#575, #838)', () => {
  const html = new Map<string, any>();
  const $ = (id: string) => { if (!html.has(id)) html.set(id, {}); return html.get(id); };
  const base = { cliente: 'Ana', telefono: '4441234567', entrega: 'tienda', estado: 'apartado', guia: '', liquidado_en: null, envio: 0,
    subtotal: 20000, vence_en: '2030-01-01T12:00:00.000Z', lineas: [] };
  const pedidos = [
    { ...base, folio: 1, vendedora: 'ana@revende.mx', vendedora_nombre: 'Ana <R>', anticipo: 0, saldo: 0, faltante: 20000 },
    { ...base, folio: 2, vendedora: 'caja@prueba.mx', vendedora_nombre: 'Marta', anticipo: 3000, saldo: 3000, faltante: 17000 },
    { ...base, folio: 3, entrega: 'envio', vendedora: 'bety@revende.mx', vendedora_nombre: 'Bety', anticipo: 0, saldo: 0, faltante: 29900, viernes_envio: null },
  ];
  const bloque = fuente.slice(fuente.indexOf('const vendedoraDe ='), fuente.indexOf("$('actualizar').addEventListener"));
  const pintar = runInNewContext(`${bloque}
pintarLista`, {
    $, pedidos, Date, guardadas: new Map(), escapar: (t: string) => String(t).replace(/</g, '&lt;'), pesos: (n: number) => `$${n / 100}`, dia: () => '2026-10-22',
    fecha: (s: string) => s.slice(0, 10), piezasDe: () => 'Prenda', totalDe: () => 20000,
    enlaceWhatsApp: () => '#', mensajeConfirmar: () => '', mensajeRecordar: () => '', mensajeGuia: () => '', mensajeSaldo: () => '',
  });
  pintar();
  const apartados = $('lista-apartados').innerHTML as string;
  const [reventa, normal] = apartados.split('<div class="pedido">').slice(1);
  assert.match(reventa, /Sin anticipo · Vence (?:hoy,|el) 2030-01-01 · Ana &lt;R>/);
  assert.match(reventa, /data-mover="1" data-tipo="abono"/);
  assert.match(reventa, /Pagado \$0 de \$200 · Falta \$200/);
  assert.match(reventa, /data-cancelar="1"/);
  assert.doesNotMatch(normal, /Sin anticipo/);
  // #838: el apartado normal también recibe abonos, dice cuántos días quedan y que el abono no los alarga.
  assert.match(normal, /data-mover="2" data-tipo="abono"/);
  assert.match(normal, /Vence (?:hoy,|el) 2030-01-01 \((?:quedan \d+ días; )?los abonos no lo alargan\)/);
  assert.match(normal, /data-cancelar="2"/);
  assert.match($('lista-envios').innerHTML, /Sin anticipo · Vence el 2030-01-01 · Bety; cada pieza/);
});

test('abono por transferencia: sin clave o con monto menor el error queda junto al campo y no se envía ni se guarda nada', async () => {
  const memoria = new Map<string, string>();
  const enviados: any[] = [];
  const p = pantalla(memoria, async (_ruta, cuerpo) => { enviados.push(cuerpo); return { ok: true, status: 200, json: async () => ({ faltante: 0, excedente_transferencia: 1000 }) }; });
  p.abrir(17, 'abono');
  p.$('mover-forma').value = 'transferencia';
  await p.guardar();
  assert.match(p.$('mover-clave-error').textContent, /Escribe la clave de rastreo/);
  p.$('mover-clave').value = ' ejemplo 123456 ';
  await p.guardar();
  assert.match(p.$('mover-clave-error').textContent, /Escribe el monto que dice el comprobante/);
  assert.equal(p.$('mover-monto').enfocado, true);
  assert.equal(enviados.length, 0);
  assert.equal(memoria.size, 0);
  p.$('mover-monto').value = '60';
  await p.guardar();
  // El CEP de Banxico pide el banco emisor (#603): sin elegirlo no se envía y el error queda junto a su campo.
  assert.match(p.$('mover-clave-error').textContent, /Elige el banco/);
  assert.equal(p.$('mover-banco').enfocado, true);
  assert.equal(enviados.length, 0);
  p.$('mover-banco').value = '40012';
  await p.guardar();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].banco_emisor, '40012');
  assert.equal(enviados[0].clave_rastreo, 'EJEMPLO123456');
  assert.equal(enviados[0].monto_transferido, 6000);
  assert.equal(enviados[0].importe, 6000);   // #875: el abono es lo que dice el comprobante, no se captura aparte
  assert.match(p.$('aviso-lista').textContent, /Movimiento de P-17 registrado.*Sobraron \$10/);
});

test('abono por transferencia (#875): un solo importe, el del comprobante topado a lo que falta, y un renglón que dice qué se registra', async () => {
  const enviados: any[] = [];
  const p = pantalla(new Map(), async (_ruta, cuerpo) => { enviados.push(cuerpo); return { ok: true, status: 200, json: async () => ({ faltante: 0 }) }; });
  p.abrir(17, 'abono');   // falta $249
  p.$('mover-forma').value = 'transferencia';   // la forma por omisión de la pantalla real
  p.$('mover-forma').change();
  assert.equal(p.$('mover-importe-bloque').hidden, true);                 // transferencia es la forma por omisión: no se escribe el abono
  assert.equal(p.$('mover-transf').hidden, false);
  p.$('mover-forma').value = 'efectivo';
  p.$('mover-forma').change();
  assert.equal(p.$('mover-importe-bloque').hidden, false);               // efectivo y tarjeta: un solo campo, como siempre
  assert.equal(p.$('mover-transf').hidden, true);
  assert.equal(p.$('mover-cobro').textContent, '');
  p.$('mover-forma').value = 'transferencia';
  p.$('mover-forma').change();
  assert.match(p.$('mover-cobro').textContent, /Sube la foto del comprobante/);
  p.$('mover-monto').value = '100';
  p.$('mover-monto').input();
  assert.equal(p.$('mover-cobro').textContent, 'Se registra un abono de $100. Faltan $149.');
  p.$('mover-monto').value = '300';
  p.$('mover-monto').input();
  assert.match(p.$('mover-cobro').textContent, /^Se registra un abono de \$249\. No falta nada\. Sobraron \$51 en la transferencia/);
  p.$('mover-clave').value = 'EJEMPLO123456';
  p.$('mover-banco').value = '40012';
  await p.guardar();
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].importe, 24900);
  assert.equal(enviados[0].monto_transferido, 30000);
  assert.deepEqual(Object.keys(enviados[0]).sort(), ['banco_emisor', 'caja', 'clave_rastreo', 'forma_pago', 'id', 'importe', 'monto_transferido']);
});

test('abono: si el servidor rechaza la clave, el cuadro sigue abierto con el error junto al campo y el intento siguiente usa ID nuevo', async () => {
  const memoria = new Map<string, string>();
  const enviados: any[] = [];
  const p = pantalla(memoria, async (_ruta, cuerpo) => {
    enviados.push(cuerpo);
    return enviados.length === 1
      ? { ok: false, status: 409, json: async () => ({ error: 'Esa clave de rastreo ya se usó en el pedido P-3.', campo: 'clave' }) }
      : { ok: true, status: 200, json: async () => ({ faltante: 0 }) };
  });
  p.abrir(17, 'abono');
  p.$('mover-importe').value = '50';
  p.$('mover-forma').value = 'transferencia';
  p.$('mover-clave').value = 'EJEMPLO123456';
  p.$('mover-monto').value = '50';
  p.$('mover-banco').value = 'otro';
  await p.guardar();
  assert.match(p.$('mover-clave-error').textContent, /ya se usó en el pedido P-3/);
  assert.equal(memoria.size, 0);                      // nada se registró: no queda intento pendiente
  assert.equal(p.$('mover-guardar').disabled, false);
  assert.equal(p.$('mover-clave').disabled, false);
  p.$('mover-clave').value = 'EJEMPLO654321';
  await p.guardar();
  assert.equal(enviados.length, 2);
  assert.notEqual(enviados[1].id, enviados[0].id);
  assert.equal(enviados[1].clave_rastreo, 'EJEMPLO654321');
});

test('un apartado del portal (#668) se muestra como «Portal» y, sin anticipo, trae su botón de abono', () => {
  const html = new Map<string, any>();
  const $ = (id: string) => { if (!html.has(id)) html.set(id, {}); return html.get(id); };
  const base = { cliente: 'Lucía', telefono: '4441112222', entrega: 'tienda', estado: 'apartado', guia: '', liquidado_en: null, envio: 0,
    subtotal: 20000, vence_en: '2030-01-01T12:00:00.000Z', lineas: [], vendedora: 'portal', vendedora_nombre: null, anticipo: 0, saldo: 0, faltante: 20000, folio: 4 };
  const bloque = fuente.slice(fuente.indexOf('const vendedoraDe ='), fuente.indexOf("$('actualizar').addEventListener"));
  const pintar = runInNewContext(`${bloque}
pintarLista`, {
    $, pedidos: [base], Date, guardadas: new Map(), escapar: (t: string) => String(t).replace(/</g, '&lt;'), pesos: (n: number) => `$${n / 100}`, dia: () => '2026-10-22',
    fecha: (s: string) => s.slice(0, 10), piezasDe: () => 'Prenda', totalDe: () => 20000,
    enlaceWhatsApp: () => '#', mensajeConfirmar: () => '', mensajeRecordar: () => '', mensajeGuia: () => '', mensajeSaldo: () => '',
  });
  pintar();
  const apartados = $('lista-apartados').innerHTML as string;
  assert.match(apartados, /Sin anticipo · Vence (?:hoy,|el) 2030-01-01 · Portal/);
  assert.match(apartados, /Tienda · Portal/);
  assert.match(apartados, /data-mover="4" data-tipo="abono"/);
  assert.doesNotMatch(apartados, /portal</);
});

/* ---------- #838: días que quedan, en días de calendario de la tienda ---------- */

function apartadosEn(ahoraIso: string, pedidos: any[]) {
  const html = new Map<string, any>();
  const $ = (id: string) => { if (!html.has(id)) html.set(id, {}); return html.get(id); };
  const fijo = Date.parse(ahoraIso);
  class FechaFija extends Date { static now() { return fijo; } }
  const base = { cliente: 'Ana', telefono: '4441234567', entrega: 'tienda', estado: 'apartado', guia: '', liquidado_en: null, envio: 0,
    subtotal: 25000, lineas: [], vendedora: 'caja@prueba.mx', vendedora_nombre: 'Marta', anticipo: 10000, saldo: 10000, faltante: 15000 };
  const bloque = fuente.slice(fuente.indexOf('const vendedoraDe ='), fuente.indexOf("$('actualizar').addEventListener"));
  const pintar = runInNewContext(`${bloque}\npintarLista`, {
    $, pedidos: pedidos.map((p, i) => ({ ...base, folio: i + 1, ...p })), Date: FechaFija, guardadas: new Map(), escapar: String, pesos: (n: number) => `$${n / 100}`,
    dia: (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' }),
    fecha: (s: string) => s.slice(0, 10), piezasDe: () => 'Prenda', totalDe: () => 25000,
    enlaceWhatsApp: () => '#', mensajeConfirmar: () => '', mensajeRecordar: () => '', mensajeGuia: () => '', mensajeSaldo: () => '',
  });
  pintar();
  return ($('lista-apartados').innerHTML as string).split('<div class="pedido">').slice(1);
}

test('días que quedan: de calendario en hora de tienda, no ventanas de 24 horas; el día del plazo dice «Vence hoy» sin «queda 1 día»', () => {
  const [manana, finDeDia, hoy, cinco, mananaTarde] = apartadosEn('2026-11-22T08:00:00-06:00', [
    { vence_en: '2026-11-23T10:00:00-06:00' },          // mañana: 1 día
    { vence_en: '2026-11-22T23:30:00-06:00' },          // hoy mismo, tarde
    { vence_en: '2026-11-22T20:00:00-06:00' },
    { vence_en: '2026-11-27T10:00:00-06:00' },          // 5 días
    { vence_en: '2026-11-23T23:00:00-06:00' },          // 39 h después, pero sigue siendo mañana: 1 día
  ]);
  assert.match(manana, /\(queda 1 día; los abonos no lo alargan\)/);
  assert.match(mananaTarde, /\(queda 1 día; los abonos no lo alargan\)/);
  assert.match(cinco, /\(quedan 5 días; los abonos no lo alargan\)/);
  for (const c of [finDeDia, hoy]) {
    assert.match(c, /Vence hoy, /);
    assert.doesNotMatch(c, /queda/);
    assert.match(c, /\(los abonos no lo alargan\)/);
  }
});

test('«Recibir abono» se oculta en un apartado normal vencido o sin faltante; el de revendedora sigue con su botón', () => {
  const [vigente, vencido, pagado, reventa] = apartadosEn('2026-11-22T08:00:00-06:00', [
    { vence_en: '2026-11-25T10:00:00-06:00' },
    { vence_en: '2026-11-22T07:00:00-06:00' },
    { vence_en: '2026-11-25T10:00:00-06:00', saldo: 25000, faltante: 0 },
    { vence_en: '2026-11-22T20:00:00-06:00', anticipo: 0, saldo: 0, faltante: 25000, vendedora: 'ana@revende.mx', vendedora_nombre: 'Ana' },
  ]);
  assert.match(vigente, /data-tipo="abono"/);
  assert.doesNotMatch(vencido, /data-tipo="abono"/);
  assert.match(vencido, /Venció el/);
  assert.doesNotMatch(vencido, /los abonos no lo alargan/);
  assert.doesNotMatch(pagado, /data-tipo="abono"/);
  assert.match(reventa, /data-tipo="abono"/);
});

test('revendedora o portal sin pago no dice «los abonos no lo alargan»; con un pago sí y con sus días', () => {
  const [sinPago, conPago] = apartadosEn('2026-11-22T08:00:00-06:00', [
    { vence_en: '2026-11-23T10:00:00-06:00', anticipo: 0, saldo: 0, faltante: 25000, vendedora: 'portal' },
    { vence_en: '2026-11-28T10:00:00-06:00', anticipo: 0, saldo: 5000, faltante: 20000, vendedora: 'portal' },
  ]);
  assert.doesNotMatch(sinPago, /los abonos no lo alargan/);
  assert.match(sinPago, /Sin anticipo · Vence el/);
  assert.match(conPago, /\(quedan 6 días; los abonos no lo alargan\)/);
  assert.match(conPago, /data-tipo="abono"/);
});

test('nuevo apartado por transferencia (#875): el anticipo sale del comprobante; tienda hasta el total, envío abre con el mínimo, efectivo escribe el suyo', () => {
  const campos = new Map<string, any>();
  const $ = (id: string) => { if (!campos.has(id)) campos.set(id, { value: '' }); return campos.get(id); };
  let tipoEntrega = 'tienda';
  const bloque = fuente.slice(fuente.indexOf('function calcular() {'), fuente.indexOf('function pintar() {'))
    + fuente.slice(fuente.indexOf('/** Renglón de solo lectura con lo que se va a registrar con transferencia'), fuente.indexOf('function validar() {'));
  const desde = fuente.indexOf('const centavos =');
  const ayudas = fuente.slice(desde, fuente.indexOf('\n', desde));
  const avisoSrc = fuente.slice(fuente.indexOf('const avisoExcedente ='), fuente.indexOf("gerencia.` : '';") + "gerencia.` : '';".length);
  const piezas = [{ precio: 25000, cantidad: 1 }];
  const { calcular, textoCobro } = runInNewContext(`${ayudas}\n${avisoSrc}\n${bloque}\n({ calcular, textoCobro })`, {
    $, piezas, Number, Math, envioDe, anticipoMinimoDe, importeDeComprobante, pesos: (n: number) => `$${n / 100}`,
    entrega: () => tipoEntrega, telefonoLimpio: () => '4441234567',
  });
  $('cliente').value = 'Ana'; $('caja-nombre').value = 'Caja 1'; $('forma').value = 'transferencia';
  $('monto-transf').value = '150';
  assert.equal(calcular().anticipo, 15000);
  assert.equal(calcular().motivo, '');
  assert.equal(textoCobro(calcular()), 'Se registra anticipo de $150. Faltan $100.');
  $('monto-transf').value = '400';
  assert.equal(calcular().anticipo, 25000);                                  // topado al total del apartado
  assert.match(textoCobro(calcular()), /^Se registra anticipo de \$250\. No falta nada\. Sobraron \$150 en la transferencia/);
  $('monto-transf').value = '50';
  assert.equal(calcular().anticipo, 10000);                                  // menos del mínimo: queda el mínimo y transferenciaDe lo rechaza al apartar
  assert.match(textoCobro(calcular()), /El comprobante dice \$50 y el anticipo mínimo es \$100/);
  $('monto-transf').value = '';
  assert.match(textoCobro(calcular()), /Sube la foto del comprobante/);
  tipoEntrega = 'envio';
  $('monto-transf').value = '300';
  assert.equal(calcular().anticipo, 10000);                                  // envío: el paquete abre con el mínimo
  assert.match(textoCobro(calcular()), /^Se registra anticipo de \$100\. Faltan \$249\. Sobraron \$200/);
  tipoEntrega = 'tienda';
  $('forma').value = 'efectivo';
  $('anticipo').value = '120';
  assert.equal(calcular().anticipo, 12000);                                  // efectivo: un solo campo, como siempre
  assert.equal(textoCobro(calcular()), '');
});
