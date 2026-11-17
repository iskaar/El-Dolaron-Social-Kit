// node --test src/caja-avisos.test.ts
// Issue #817: foco del lector, avisos que se ven, teclado, corte por total y confirmación del conteo.
// La lógica pura vive en public/venta.js; el cableado de pantalla se ejecuta aquí con un DOM mínimo, sin navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE, debePreguntarSocio,
  leerMultiplicador, contadoDe, esBusquedaPorTexto, avisoExistencia, moverSugerencia, cancelarPideConfirmar, nVentas,
  avisoCorteSinEnviar, GASTO_MAXIMO_CAJERO, gastoRequiereDueno, centavosDeTexto, alertaConteo, pesosExactos, PIEZAS_IMPROBABLES,
} from '../public/venta.js';
import { LIMITE_GASTO_CAJERO } from './corte.ts';
import { codigoDeDigitos, codigoEnDigitos } from '../public/code128.js';
import { agregar, guiaVale, descuentoDe, TOPE_DESCUENTO } from '../public/venta.js';
import { puedeVenderEnMano } from '../public/venta.js';
import { tienda, codigoPrueba, PRODUCTO } from './prueba-d1.ts';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ---------- lógica pura ---------- */

test('«parece texto»: solo lo que tiene letras y no puede ser un código (ED-, P-, DC-/DP-, BU-, banda, URL de vale, dígitos) se busca por nombre', () => {
  for (const texto of ['bufanda', 'bufanda azul', 'juguetes 49', '3*juguetes', '3*bufanda', 'budín', 'ñoño', 'camisa roja']) assert.equal(esBusquedaPorTexto(texto), true, texto);
  const vale = 'https://dolarones.eldolaron.com/v#' + codigoEnDigitos('DP-abcdefghijklmnop');
  for (const codigo of ['123', '000123', '7501234567890', 'ED-000123', 'ed-1', 'P-17', 'p17', 'DC-abc', 'DP-XYZ', 'BU-K7Q2M', '3*ED-000001', ' 45 ', '5*123',
    'JU49', 'ju49', 'JU199', 'R19', '3*JU49', vale, 'http://x.mx/a'])
    assert.equal(esBusquedaPorTexto(codigo), false, codigo);
});

test('existencia: cada caso dice qué hacer', () => {
  assert.equal(avisoExistencia('Lámpara', 1, 0, 1), '');
  assert.equal(avisoExistencia('Lámpara', 5, 2, 2), '');
  assert.equal(avisoExistencia('Lámpara', 1, 1, 1), 'Lámpara ya está en este ticket.');
  assert.equal(avisoExistencia('Lámpara', 0, 1, 1), 'Lámpara ya está en este ticket.', 'una pieza de un pedido ya cargado tiene existencia 0');
  assert.equal(avisoExistencia('Lámpara', 0, 0, 1), 'Lámpara ya se vendió, está apartada o no está en esta tienda. Si es de un pedido, escanea su folio (P-…).');
  assert.equal(avisoExistencia('Lámpara', 3, 3, 1), 'Lámpara: solo hay 3 en existencia.');
  assert.equal(avisoExistencia('Lámpara', 1, 0, 2), 'Lámpara: solo hay 1 en existencia.');
});

test('flechas: bajan hasta la última, suben hasta «ninguna» y sin sugerencias no hay nada que resaltar', () => {
  assert.equal(moverSugerencia(-1, 3, 'ArrowDown'), 0);
  assert.equal(moverSugerencia(0, 3, 'ArrowDown'), 1);
  assert.equal(moverSugerencia(2, 3, 'ArrowDown'), 2);
  assert.equal(moverSugerencia(1, 3, 'ArrowUp'), 0);
  assert.equal(moverSugerencia(0, 3, 'ArrowUp'), -1);
  assert.equal(moverSugerencia(-1, 3, 'ArrowUp'), -1);
  assert.equal(moverSugerencia(0, 0, 'ArrowDown'), -1);
});

test('«Cancelar venta» pide segundo toque con descuento aprobado, pedido cargado o 3 piezas o más; con el ticket vacío no', () => {
  assert.equal(cancelarPideConfirmar({ piezas: 0, descuentoAprobado: true, pedido: true }), false);
  assert.equal(cancelarPideConfirmar({ piezas: 2, descuentoAprobado: false, pedido: false }), false);
  assert.equal(cancelarPideConfirmar({ piezas: 3, descuentoAprobado: false, pedido: false }), true);
  assert.equal(cancelarPideConfirmar({ piezas: 1, descuentoAprobado: true, pedido: false }), true);
  assert.equal(cancelarPideConfirmar({ piezas: 1, descuentoAprobado: false, pedido: true }), true);
});

test('corte sin enviar: singular y plural; sin red y sin cola no dice «0 ventas»', () => {
  assert.equal(nVentas(1), '1 venta');
  assert.equal(nVentas(2), '2 ventas');
  assert.equal(avisoCorteSinEnviar(0, true), '');
  assert.equal(avisoCorteSinEnviar(0, false), 'Sin red: el corte necesita conexión.');
  assert.equal(avisoCorteSinEnviar(1, true), 'Hay 1 venta sin sincronizar. Espera a tener red antes del corte.');
  assert.equal(avisoCorteSinEnviar(3, false), 'Hay 3 ventas sin sincronizar. Espera a tener red antes del corte.');
});

test('gasto de más de $100: el aviso usa el mismo tope que el servidor y no aplica a retiros', () => {
  assert.equal(GASTO_MAXIMO_CAJERO, LIMITE_GASTO_CAJERO);
  assert.equal(gastoRequiereDueno('gasto', 10000), false);
  assert.equal(gastoRequiereDueno('gasto', 10001), true);
  assert.equal(gastoRequiereDueno('retiro', 500000), false);
  assert.equal(gastoRequiereDueno('terminal', 500000), false);
});

test('total del corte en pesos con centavos → centavos enteros, sin float', () => {
  const casos: [string, number | null][] = [['1234.50', 123450], ['19.99', 1999], ['0', 0], ['0.00', 0], ['.5', 50], [' 7 ', 700], ['1000000', 100000000],
    ['', null], ['1000000.01', null], ['10.005', null], ['-5', null], ['1e3', null], ['12,5', null], ['abc', null]];
  for (const [texto, esperado] of casos) assert.equal(centavosDeTexto(texto), esperado, texto);
  assert.equal(pesosExactos(123450), '$1,234.50');
  assert.equal(pesosExactos(0), '$0.00');
});

test('conteo improbable: más de 200 piezas de una denominación se resalta con su cuenta; 200 o menos no', () => {
  assert.equal(PIEZAS_IMPROBABLES, 200);
  assert.equal(alertaConteo(500, 200), '');
  assert.equal(alertaConteo(500, 0), '');
  assert.equal(alertaConteo(500, 201), '¿Seguro? 201 × $5.00 = $1,005.00');
  assert.equal(alertaConteo(50, 250), '¿Seguro? 250 × $0.50 = $125.00');
});

/* ---------- cobrar: foco, folio, cajón e impresora ---------- */

const avisoFalso = () => {
  const el: any = { hijos: [] as { textContent: string }[], style: {}, nodo: null as null | { texto: string } };
  Object.defineProperty(el, 'textContent', {
    get: () => (el.nodo?.texto ?? '') + el.hijos.map((h: { textContent: string }) => h.textContent).join(''),
    set: (v) => { el.nodo = { texto: String(v) }; el.hijos = []; },
  });
  Object.defineProperty(el, 'firstChild', { get: () => el.nodo });
  el.append = (h: { textContent: string }) => el.hijos.push(h);
  return el;
};

interface Opciones {
  errorImpresora?: string;
  descuento?: unknown;
  remota?: boolean;
  fetch?: (ruta: string, opciones: any) => Promise<unknown>;
  abrirCajon?: () => unknown;
  imprimirTicket?: () => unknown;
  valores?: Record<string, string>;
  forma?: string;   // el botón de cobro que se toca (#830); sin él, efectivo
  pedido?: boolean;
}
function montarCobro(op: Opciones = {}) {
  const elementos = new Map<string, any>();
  const vistos: unknown[] = [];
  const guardadas: unknown[] = [];
  const $ = (id: string) => {
    if (!elementos.has(id)) {
      elementos.set(id, id === 'aviso' ? avisoFalso() : { value: op.valores?.[id] ?? (id === 'efectivo' ? '300' : ''),
        textContent: '', style: {}, disabled: false, enfocado: false, focus() { if (!this.disabled) this.enfocado = true; } });
    }
    return elementos.get(id);
  };
  const contexto: Record<string, unknown> = {
    crypto, Date, $, AbortSignal, Object, Math, vistos, totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido,
    transferenciaDe, CLAVE_DESDE, debePreguntarSocio, navigator: { onLine: true }, window: { open() {} },
    document: { createElement: () => ({ style: {}, textContent: '' }) },
    lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: 30000, cantidad: 1 }],
    errorImpresora: () => op.errorImpresora ?? 'USB falló',
    socio: null, valesCargados: [], catalogo: new Map(), pedidoCargado: op.pedido ? { id: 'ped-1', folio: 17, saldo: 10000 } : null,
    preguntarSocio: async () => 'cobrar',
    impresionRemota: () => !!op.remota, exigirCaja: () => true, cajaActual: () => 'Caja 1', dolaronesPedidos: () => 0,
    descuento: op.descuento ?? null, descuentoAplicado: () => ((op.descuento as any)?.estado === 'aprobada' ? (op.descuento as any).monto : 0), descuentoDe, TOPE_DESCUENTO, revisarVencimientoDescuento: () => false, promoActual: () => 0, totalNeto: () => 30000, pintarDescuento() {},
    pesos: String, dolares: String, quitarSocio() {}, sincronizar() {}, cargarCatalogo() {}, pintarImpresora() {}, promoConfig: null,
    abrirCajon: op.abrirCajon ?? (async () => true), imprimirTicket: op.imprimirTicket ?? (async () => true),
    store: async (almacen: string, _m: string, fn: any) => fn({ put(v: unknown) { if (almacen === 'ventas') guardadas.push(v); } }),
    fetch: op.fetch ?? (async () => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null, saldo_pedido: 0 }) })),
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const falla = entre('function textoFalla(', '/**\n * Escribir o escanear P-17');
  const conPedido = entre('async function cobrarConPedido(', '/* ---------- cobro: primero');
  const errorClave = entre('function errorClave(', "for (const id of ['clave-rastreo'");
  const cobro = entre('async function cobrar(', 'let sincronizando = false;');
  // pintar() es el de la pantalla en lo que importa aquí: deshabilita #codigo mientras se cobra y guarda el folio que ve.
  const cobrarReal = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, folioIncierto = null, cobroIncierto = null;
    function pintar() { $('codigo').disabled = cobrando; vistos.push(idVenta); }
    ${avisoRojo}\n${falla}\n${conPedido}\n${errorClave}\n${cobro}; cobrar`, contexto);
  // Sin argumento se toca «Cobrar en efectivo»; las pruebas de otras formas lo dicen en `forma`.
  const cobrar = (forma: string = op.forma ?? 'efectivo') => cobrarReal(forma);
  return { cobrar, $, vistos, guardadas, contexto };
}

test('#817 foco: tras cobrar, #codigo vuelve a tener el foco cuando ya no está deshabilitado', async () => {
  const c = montarCobro();
  await c.cobrar();
  assert.match(c.$('aviso').textContent, /^Cobrado/);
  assert.equal(c.$('codigo').disabled, false);
  assert.equal(c.$('codigo').enfocado, true);
});

test('#817 foco: tras un cobro que falla (pedido sin red) el lector también sigue en #codigo', async () => {
  const c = montarCobro({ pedido: true, fetch: async () => { throw new Error('sin red'); } });
  await c.cobrar();
  assert.match(c.$('aviso').textContent, /Sin red/);
  assert.equal(c.$('codigo').enfocado, true);
});

test('#817 folio: el id existe antes del primer pintar() de cobrar, que es el que guarda el ticket', async () => {
  const c = montarCobro();
  await c.cobrar();
  assert.ok(typeof c.vistos[0] === 'string' && (c.vistos[0] as string).length > 20, `el primer pintar() vio ${String(c.vistos[0])}`);
});

test('#817 cajón e impresora: si fallan con la impresora conectada, el aviso de «Cobrado» lo dice en rojo y no frena el cobro, llegue antes o después del aviso', async () => {
  // Fallan al instante (antes de que el aviso exista) y fallan tarde (después de verlo).
  for (const tarde of [false, true]) {
    let soltar: () => void = () => {};
    const espera = new Promise<void>((r) => { soltar = r; });
    const falla = async () => { if (tarde) await espera; return false; };
    const c = montarCobro({ abrirCajon: falla, imprimirTicket: falla });
    await c.cobrar();
    assert.match(c.$('aviso').textContent, /^Cobrado/);
    soltar();
    await tick();
    const rojos = c.$('aviso').hijos;
    assert.deepEqual(rojos.map((h: any) => h.textContent), ['El cajón no abrió: ábrelo con la llave.', 'El ticket no se imprimió: reimprímelo desde Ventas de hoy.'], `tarde=${tarde}`);
    assert.equal(c.$('aviso').style.color, '#1f7a4d');
    assert.equal(rojos[0].style.cssText.includes('#D72B32'), true);
  }
});

test('#817 cajón e impresora: si todo sale bien no se agrega nada; con tarjeta no se menciona el cajón; otro aviso nuevo no se contamina', async () => {
  const bien = montarCobro();
  await bien.cobrar(); await tick();
  assert.equal(bien.$('aviso').hijos.length, 0);

  const tarjeta = montarCobro({ forma: 'tarjeta', abrirCajon: () => assert.fail('con tarjeta no se abre el cajón'), imprimirTicket: async () => false });
  await tarjeta.cobrar(); await tick();
  assert.deepEqual(tarjeta.$('aviso').hijos.map((h: any) => h.textContent), ['El ticket no se imprimió: reimprímelo desde Ventas de hoy.']);

  let soltar: () => void = () => {};
  const espera = new Promise<void>((r) => { soltar = r; });
  const otro = montarCobro({ imprimirTicket: async () => { await espera; return false; } });
  await otro.cobrar();
  otro.$('aviso').textContent = 'Código no encontrado: X';   // el cajero ya escaneó otra cosa
  soltar(); await tick();
  assert.equal(otro.$('aviso').hijos.length, 0, 'la falla del ticket anterior no se pega al aviso nuevo');
});

test('#817 cajón e impresora: sin impresora conectada es una sola línea tranquila (el pie ya dice «Impresora no conectada»), no dos rojas', async () => {
  const efectivo = montarCobro({ errorImpresora: 'no conectada', abrirCajon: async () => false, imprimirTicket: async () => false });
  await efectivo.cobrar(); await tick();
  assert.deepEqual(efectivo.$('aviso').hijos.map((h: any) => h.textContent), ['Sin impresora: abre el cajón con la llave.']);
  assert.equal(efectivo.$('aviso').hijos[0].style.cssText.includes('#D72B32'), false);
  assert.match(efectivo.$('aviso').textContent, /^Cobrado/);

  const tarjeta = montarCobro({ forma: 'tarjeta', errorImpresora: 'no conectada', imprimirTicket: async () => false });
  await tarjeta.cobrar(); await tick();
  assert.equal(tarjeta.$('aviso').hijos.length, 0, 'con tarjeta y sin impresora no hay nada que decir aparte del pie');
});

test('#817 cobrar: los retornos antes del cobro dejan el foco en #codigo, no en «Cobrar» (el Enter del lector lo pulsaría otra vez)', async () => {
  const casos: [string, Opciones, RegExp][] = [
    ['descuento pendiente', { descuento: { estado: 'pendiente' } }, /El descuento sigue esperando a gerencia/],
    ['descuento sobre el tope', { descuento: { estado: 'aprobada', tipo: 'monto', valor: 29000, monto: 29000 } }, /pasa del 50% del ticket/],
    ['impresión remota con efectivo', { remota: true, valores: { 'imprimir-en': 'Caja 2' } }, /En el celular sólo tarjeta o transferencia/],
    ['faltan pesos', { valores: { efectivo: '100' } }, /^Faltan/],
  ];
  for (const [nombre, op, mensaje] of casos) {
    const c = montarCobro(op);
    await c.cobrar();
    assert.match(c.$('aviso').textContent, mensaje, nombre);
    assert.equal(c.$('codigo').enfocado, true, nombre);
    assert.equal(c.guardadas.length, 0, nombre);
  }
  const regalo = montarCobro();
  regalo.contexto.dolaronesPedidos = () => 5000;   // socio null: no alcanza ni el saldo canjeable
  await regalo.cobrar();
  assert.match(regalo.$('aviso').textContent, /Los regalos de apertura/);
  assert.equal(regalo.$('codigo').enfocado, true);
});

/* ---------- Dolarones: límite de espera y reintento ---------- */

/** Cobro con Dolarones con respuestas guionadas: un Error se lanza (red, timeout) y un objeto es la respuesta del servidor. */
function montarDolarones(respuestas: any[], socio: Record<string, unknown> = {}) {
  const llamadas: any[] = [];
  const el = { textContent: '', style: {} };
  const contexto = {
    $: () => el, AbortSignal, Date, Object, dolaronesGanados, promoAgotada() {}, valesCargados: [],
    codigoSocio: 'DC-x', socio: { maximo: 99999, expira_en: '2099-01-01T00:00:00Z', vale: false, numero: 7, disponible: 5000, ...socio },
    fetch: async (_r: string, o: any) => {
      llamadas.push(JSON.parse(o.body));
      const siguiente = respuestas.shift();
      if (siguiente instanceof Error || siguiente instanceof DOMException) throw siguiente;
      return siguiente;
    },
  };
  const rutina = runInNewContext(`let folioIncierto = null; ${entre('async function cobrarConDolarones(', '/* ---------- pedidos por WhatsApp')};
    ({ cobrarConDolarones, incierto: () => folioIncierto })`, contexto);
  return { ...rutina, llamadas, aviso: el, socio: contexto.socio as Record<string, unknown> };
}
const respuesta = (status: number, cuerpo: Record<string, unknown>) => ({ ok: status < 400, status, json: async () => cuerpo });
const VENTA = { id: 'folio-1', dolarones: 1000 };

test('#817 Dolarones: la petición tiene el mismo límite de 15 s y, si vence, dice que se puede volver a tocar el mismo botón de cobro', async () => {
  const vencida = montarDolarones([new DOMException('timeout', 'TimeoutError')]);
  assert.equal(await vencida.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 }), false);
  assert.ok(vencida.llamadas.length === 1);
  assert.match(vencida.aviso.textContent, /No se supo si se cobró\. Toca otra vez el mismo botón de cobro.*mismo folio no se cobra dos veces.*Ventas de hoy/);
  const sinRed = montarDolarones([new TypeError('Failed to fetch')]);
  await sinRed.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 });
  assert.match(sinRed.aviso.textContent, /^Sin red: no se pudo cobrar con Dolarones/);
  assert.match(fuente, /signal: AbortSignal\.timeout\(15000\)/, 'la fetch de Dolarones lleva la señal (la prueba solo ve que hay una)');
});

test('#817 Dolarones: tras un timeout el reintento va al servidor con el mismo folio y código aunque aquí parezca vencido; un 4xx cierra la duda', async () => {
  const c = montarDolarones([new DOMException('timeout', 'TimeoutError'), respuesta(200, { id: 'folio-1', duplicada: true, ganados: 0 }),
    new DOMException('timeout', 'TimeoutError'), respuesta(403, { error: 'Código de socio usado, vencido o actualizado. Pide otro al cliente.' })]);
  await c.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 });
  assert.equal(c.incierto(), 'folio-1');
  c.socio.expira_en = '2000-01-01T00:00:00Z';                  // pasó el minuto del código mientras tanto
  const resultado = await c.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 });
  assert.equal(c.llamadas.length, 2, 'el reintento sí salió');
  assert.deepEqual(c.llamadas[1], { ...VENTA, codigo_socio: 'DC-x' }, 'mismo folio y mismo código');
  assert.ok(resultado, 'duplicada se toma como cobrado');
  assert.equal(c.incierto(), null, 'una respuesta del servidor cierra la duda');
  // Sin duda, un código vencido sigue sin salir.
  assert.equal(await c.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 }), false);
  assert.equal(c.llamadas.length, 2);
  assert.match(c.aviso.textContent, /debe autorizar este importe y mostrar un código vigente/);

  // Un rechazo definitivo (4xx) también cierra la duda; un 5xx no.
  const d = montarDolarones([new DOMException('timeout', 'TimeoutError'), respuesta(403, { error: 'Código de socio usado, vencido o actualizado.' })]);
  await d.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 });
  d.socio.expira_en = '2000-01-01T00:00:00Z';
  assert.equal(await d.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 }), false);
  assert.equal(d.llamadas.length, 2);
  assert.equal(d.incierto(), null);
  const e = montarDolarones([respuesta(503, { error: 'D1 no responde' })]);
  await e.cobrarConDolarones({ ...VENTA }, { aPagar: 5000 });
  assert.equal(e.incierto(), 'folio-1', 'un 5xx no dice si se cobró');
});

test('#817 Dolarones: reintentar el mismo folio con el mismo código de socio responde `duplicada` (el servidor lo revisa antes de validar el código)', async () => {
  // La caja no pide otro folio tras un timeout: el servidor contesta duplicada antes de gastar o validar el código otra vez.
  const registrar = fuente.slice(fuente.indexOf('async function cobrarConDolarones('));
  assert.match(registrar, /signal: AbortSignal\.timeout\(15000\)/);
  const t = tienda();
  try {
    const { db } = t;
    const socio = (await t.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234',
      acepta_bases: true, declara_mayor_edad: true })).cuerpo;
    assert.equal((await t.pedir('/api/portal/llegada', { codigo: await codigoPrueba(db, socio.id) })).status, 200);
    const venta = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 4 }], forma_pago: 'efectivo', efectivo: 1000_00, caja: 'Caja 1',
      cliente_id: socio.id, dolarones: 5000, codigo_socio: await codigoPrueba(db, socio.id) };
    assert.equal((await t.pedir('/api/ventas', venta)).status, 201);
    const otra = await t.pedir('/api/ventas', venta);
    assert.equal(otra.status, 200);
    assert.equal(otra.cuerpo.duplicada, true);
  } finally { t.db.close(); }
});

/* ---------- escaneo: sugerencias con flechas, Enter y texto ---------- */

function montarEscaneo() {
  const oyentes = new Map<string, Record<string, (e: any) => void>>();
  const agregadas: [string, boolean][] = [];
  const sugerencias: any = { children: [] as any[], addEventListener(t: string, f: any) { oyentes.get('sugerencias')![t] = f; } };
  Object.defineProperty(sugerencias, 'innerHTML', {
    set(html: string) {
      sugerencias.children = [...html.matchAll(/data-codigo="([^"]+)"/g)].map(([, codigo]) => ({
        dataset: { codigo }, activa: false, classList: { toggle(_c: string, v: boolean) { this.dueno.activa = v; }, dueno: null as any },
        setAttribute() {}, scrollIntoView() {},
      }));
      for (const h of sugerencias.children) h.classList.dueno = h;
    },
  });
  const codigo: any = { value: '', seleccionado: false, select() { this.seleccionado = true; }, focus() {}, addEventListener(t: string, f: any) { oyentes.get('codigo')![t] = f; } };
  oyentes.set('sugerencias', {}); oyentes.set('codigo', {});
  const $ = (id: string) => (id === 'sugerencias' ? sugerencias : codigo);
  const catalogo = [{ codigo: 'ED-000001', nombre: 'Bufanda roja', precio: 5000 }, { codigo: 'ED-000002', nombre: 'Bufanda azul', precio: 6000 }];
  const contexto = {
    $, leerMultiplicador, escapar: String, pesos: String, precioHoy: (p: any) => p.precio, TONO_PIEZA: {}, TONO_RECHAZO: {}, sonar() {},
    moverSugerencia, esBusquedaPorTexto, codigoDeDigitos,
    buscarPieza: (t: string) => catalogo.find((p) => p.codigo === t.trim().toUpperCase()),
    buscarPorTexto: (t: string) => catalogo.filter((p) => p.nombre.toLowerCase().includes(t.trim().toLowerCase())),
    // Como el real: true si entró una pieza del catálogo, false si no se encontró.
    agregarCodigo: (leido: string, reintento = false) => { agregadas.push([leido, reintento]); return !!catalogo.find((p) => p.codigo === (leerMultiplicador(leido)?.codigo ?? leido).trim().toUpperCase()); },
  };
  runInNewContext(`${entre('/** Agrega con sonido', '/* ---------- socio y Dolarones')}\n${entre("$('codigo').addEventListener('keydown'", '// Camara del celular')}`, contexto);
  const tecla = (key: string) => {
    const e = { key, target: codigo, evitado: false, preventDefault() { this.evitado = true; } };
    oyentes.get('codigo')!.keydown(e);
    return e;
  };
  const escribir = (texto: string) => { codigo.value = texto; oyentes.get('codigo')!.input({}); };
  return { tecla, escribir, agregadas, codigo, sugerencias };
}

test('#817 teclado: lo que manda el lector (dígitos + Enter) se agrega y limpia el campo, igual que siempre', () => {
  const e = montarEscaneo();
  e.escribir('123');
  e.tecla('Enter');
  assert.deepEqual(e.agregadas, [['123', false]]);
  assert.equal(e.codigo.value, '');
});

test('#817 teclado: Enter sin sugerencia resaltada NUNCA elige una; el texto sin pieza se queda, seleccionado y sin reintento de catálogo', () => {
  const e = montarEscaneo();
  e.escribir('bufanda');
  assert.equal(e.sugerencias.children.length, 2);
  const enter = e.tecla('Enter');
  assert.deepEqual(e.agregadas, [['bufanda', true]], 'se intentó como código, no se escogió la primera sugerencia');
  assert.equal(enter.evitado, false);
  assert.equal(e.codigo.value, 'bufanda');
  assert.equal(e.codigo.seleccionado, true);
  assert.equal(e.sugerencias.children.length, 2, 'las sugerencias siguen a la vista');
});

test('#817 teclado: flecha abajo resalta, Enter agrega la resaltada con su cantidad y limpia; flecha arriba desde la primera deja «ninguna»', () => {
  const e = montarEscaneo();
  e.escribir('3*bufanda');
  assert.equal(e.tecla('ArrowDown').evitado, true);
  e.tecla('ArrowDown');
  assert.deepEqual(e.sugerencias.children.map((h: any) => h.activa), [false, true]);
  const enter = e.tecla('Enter');
  assert.equal(enter.evitado, true);
  assert.deepEqual(e.agregadas, [['3*ED-000002', false]]);
  assert.equal(e.codigo.value, '');

  const f = montarEscaneo();
  f.escribir('bufanda');
  f.tecla('ArrowDown'); f.tecla('ArrowUp');
  assert.deepEqual(f.sugerencias.children.map((h: any) => h.activa), [false, false]);
  f.tecla('Enter');
  assert.deepEqual(f.agregadas, [['bufanda', true]], 'sin resaltar, Enter es el del lector');
});

test('#817 teclado: cualquier carácter nuevo (el lector escribiendo) quita el resaltado y su Enter no elige sugerencia', () => {
  const e = montarEscaneo();
  e.escribir('bufanda');
  e.tecla('ArrowDown');
  e.escribir('bufanda1');   // el lector empieza a escribir
  assert.equal(e.sugerencias.children.length, 0);
  e.escribir('bufanda');    // y aun si vuelven a aparecer sugerencias...
  e.tecla('Enter');
  assert.deepEqual(e.agregadas, [['bufanda', true]]);
});

test('#817 teclado: las flechas sin sugerencias no se tragan la tecla', () => {
  const e = montarEscaneo();
  e.escribir('123');
  assert.equal(e.tecla('ArrowDown').evitado, false);
});

test('#817 teclado: lo que puede ser un código (banda JU49, QR de vale, ED-, dígitos) se limpia y conserva su recarga de catálogo; solo el texto se queda', () => {
  const vale = 'https://dolarones.eldolaron.com/v#' + codigoEnDigitos('DP-abcdefghijklmnop');
  for (const codigo of ['JU49', vale, 'ED-000123', '7501234567890', '3*JU49']) {
    const e = montarEscaneo();
    e.escribir(codigo);
    e.tecla('Enter');
    assert.deepEqual(e.agregadas, [[codigo, false]], `${codigo}: reintento de catálogo permitido`);
    assert.equal(e.codigo.value, '', `${codigo}: campo limpio`);
    assert.equal(e.codigo.seleccionado, false, codigo);
  }
  for (const texto of ['bufanda azul', '3*juguetes']) {
    const e = montarEscaneo();
    e.escribir(texto);
    e.tecla('Enter');
    assert.deepEqual(e.agregadas, [[texto, true]], `${texto}: sin reintento`);
    assert.equal(e.codigo.value, texto);
    assert.equal(e.codigo.seleccionado, true);
  }
});

/* ---------- ticket, cancelar, rueda ---------- */

test('#817 renglón: Mayús + clic quita el renglón entero; el clic solo quita una pieza', () => {
  const montar = () => {
    const estado: any = { lineas: [{ codigo: 'A', cantidad: 3 }, { codigo: 'B', cantidad: 1 }], idVenta: 'x', pintada: 0 };
    let oyente: (e: any) => void = () => {};
    runInNewContext(`${entre("$('ticket').addEventListener('click'", "$('efectivo').addEventListener('input'")}`, {
      $: () => ({ addEventListener: (_t: string, f: any) => { oyente = f; } }),
      get lineas() { return estado.lineas; }, set lineas(v) { estado.lineas = v; },
      get idVenta() { return estado.idVenta; }, set idVenta(v) { estado.idVenta = v; },
      pintar() { estado.pintada++; }, ticketEnDuda: () => false,
    });
    return { estado, clic: (shiftKey: boolean) => oyente({ shiftKey, target: { dataset: { quitar: '0' } } }) };
  };
  const solo = montar();
  solo.clic(false);
  assert.equal(solo.estado.lineas[0].cantidad, 2);
  const entera = montar();
  entera.clic(true);
  assert.deepEqual(entera.estado.lineas.map((l: any) => l.codigo), ['B']);
});

test('#817 renglón: el botón ✕ dice qué quita', () => {
  assert.match(fuente, /aria-label="Quitar \$\{escapar\(l\.nombre\)\}"/);
});

function montarCancelar(lineas: any[], extra: Record<string, unknown> = {}) {
  const temporizadores: (() => void)[] = [];
  const estado: any = { lineas, activo: '', limpiadas: 0 };
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, { value: '', textContent: id === 'cancelar' ? 'Cancelar venta' : '', style: {}, dataset: {},
      focus() { estado.activo = id; }, addEventListener(_t: string, f: any) { this.clic = f; } });
    return elementos.get(id);
  };
  const rutinas = runInNewContext(`let cancelarArmado = null; ${entre('// Con descuento aprobado, pedido cargado', 'function pintarRed()')}
    ({ revisarCancelarArmado })`, {
    $, totales, cancelarPideConfirmar, descuento: null, pedidoCargado: null, sinPromo: false, limpiarDatosTransferencia() {}, quitarDescuentoEnServidor() {}, ...extra,
    get lineas() { return estado.lineas; }, set lineas(v) { estado.lineas = v; },
    idVenta: 'x', pintarDescuento() {}, quitarSocio() { estado.limpiadas++; }, pintar() {}, clearTimeout() {},
    setTimeout: (f: () => void) => { temporizadores.push(f); return temporizadores.length; },
    document: { addEventListener() {} },
  });
  return {
    estado, $, temporizadores, revisar: rutinas.revisarCancelarArmado,
    // Un clic de ratón enfoca el botón antes de que corra el manejador.
    clic: () => { estado.activo = 'cancelar'; $('cancelar').clic(); },
    // Lo que hace el navegador con el Enter del lector: pulsa el botón si él tiene el foco; en #codigo solo agrega piezas.
    enterDelLector: () => { if (estado.activo === 'cancelar') $('cancelar').clic(); },
  };
}
const linea = (cantidad: number) => ({ codigo: 'A', precio: 100, cantidad });

test('#817 cancelar: con 3 piezas pide un segundo toque; con 2 o vacío cancela de una vez', () => {
  const tres = montarCancelar([linea(3)]);
  tres.clic();
  assert.equal(tres.estado.lineas.length, 1, 'el primer toque no borra');
  assert.equal(tres.$('cancelar').textContent, 'Toca otra vez para borrar el ticket');
  assert.equal(tres.$('aviso').textContent, 'Toca otra vez para borrar el ticket.');
  tres.clic();
  assert.equal(tres.estado.lineas.length, 0);
  assert.equal(tres.$('cancelar').textContent, 'Cancelar venta');

  const vencido = montarCancelar([linea(3)]);
  vencido.clic();
  vencido.temporizadores[0]();   // pasaron 4 s sin el segundo toque
  assert.equal(vencido.$('cancelar').textContent, 'Cancelar venta');
  vencido.clic();
  assert.equal(vencido.estado.lineas.length, 1, 'otra vez pide confirmar');

  const dos = montarCancelar([linea(2)]);
  dos.clic();
  assert.equal(dos.estado.lineas.length, 0);
  assert.equal(dos.$('aviso').textContent, 'Venta cancelada');

  const aprobado = montarCancelar([linea(1)], { descuento: { estado: 'aprobada' } });
  aprobado.clic();
  assert.equal(aprobado.estado.lineas.length, 1);
  const vacio = montarCancelar([]);
  vacio.clic();
  assert.equal(vacio.$('aviso').textContent, 'Venta cancelada');
});

test('#817 cancelar: tras el primer toque el foco vuelve a #codigo y el Enter del lector no borra el ticket', () => {
  const c = montarCancelar([linea(3)]);
  c.clic();
  assert.equal(c.estado.activo, 'codigo', 'el foco salió del botón');
  c.enterDelLector();                          // un escaneo dentro de los 4 s...
  c.enterDelLector();                          // ...o dos
  assert.equal(c.estado.lineas.length, 1, 'el ticket sigue');
  assert.equal(c.estado.limpiadas, 0);
  // El control: si el foco se quedara en el botón (como antes), ese Enter sí lo borraría.
  c.estado.activo = 'cancelar';
  c.enterDelLector();
  assert.equal(c.estado.lineas.length, 0);
});

test('#817 cancelar: el toque armado se desarma si el ticket cambia o se cobra; el ticket siguiente vuelve a pedirlo', () => {
  const c = montarCancelar([linea(3)]);
  c.clic();
  c.estado.lineas = [linea(4)];                // agregó una pieza
  c.revisar();                                 // pintar() lo llama en cada cambio
  assert.equal(c.$('cancelar').textContent, 'Cancelar venta');
  c.clic();
  assert.equal(c.estado.lineas.length, 1, 'otra vez pide confirmar, no borra');

  const cobro = montarCancelar([linea(3)]);
  cobro.clic();
  cobro.estado.lineas = [];                    // se cobró (cobrar() vacía el ticket y su finally pinta)
  cobro.revisar();
  cobro.estado.lineas = [linea(3)];            // y el siguiente ticket llega a 3 piezas antes de los 4 s
  cobro.clic();
  assert.equal(cobro.estado.lineas.length, 1, 'un solo toque no borra el ticket nuevo');

  const igual = montarCancelar([linea(3)]);
  igual.clic();
  igual.revisar();                             // pintar() sin cambios (consulta de promos, etc.) no lo desarma
  igual.clic();
  assert.equal(igual.estado.lineas.length, 0);
  const fuentePintar = entre('function pintar() {', 'const subtotal');
  assert.match(fuentePintar, /revisarCancelarArmado\(\);/, 'pintar() revisa el toque armado');
});

test('#817 rueda: en un campo numérico con foco se le quita el foco antes de que gire el valor y se le devuelve; fuera de eso no toca nada', () => {
  class Campo { type: string; foco = true; llamadas: string[] = []; constructor(type: string) { this.type = type; }
    blur() { this.llamadas.push('blur'); this.foco = false; } focus() { this.llamadas.push('focus'); this.foco = true; } }
  let oyente: (e: any) => void = () => {};
  const pendientes: (() => void)[] = [];
  const doc: any = { activeElement: null, addEventListener: (_t: string, f: any) => { oyente = f; } };
  runInNewContext(entre("document.addEventListener('wheel'", "// Y en el corte, las flechas"), {
    document: doc, HTMLInputElement: Campo, setTimeout: (f: () => void) => pendientes.push(f),
  });
  const numero = new Campo('number');
  doc.activeElement = numero;
  oyente({ target: numero });
  assert.deepEqual(numero.llamadas, ['blur']);
  pendientes.shift()!();
  assert.deepEqual(numero.llamadas, ['blur', 'focus']);

  const texto = new Campo('text'); doc.activeElement = texto; oyente({ target: texto });
  const otro = new Campo('number'); doc.activeElement = texto; oyente({ target: otro });
  oyente({ target: {} });
  assert.deepEqual([texto.llamadas, otro.llamadas, pendientes.length], [[], [], 0]);
});

test('#817 corte: las flechas arriba y abajo no cambian los campos numéricos del conteo, pero sí funcionan en lo demás', () => {
  let oyente: (e: any) => void = () => {};
  runInNewContext(entre("$('dialogo-corte').addEventListener('keydown'", '\n});\n') + '\n});\n', { $: () => ({ addEventListener: (_t: string, f: any) => { oyente = f; } }) });
  const evento = (key: string, type: string) => { const e = { key, target: { type }, evitado: false, preventDefault() { this.evitado = true; } }; oyente(e); return e.evitado; };
  assert.equal(evento('ArrowUp', 'number'), true);
  assert.equal(evento('ArrowDown', 'number'), true);
  assert.equal(evento('ArrowDown', 'radio'), false);
  assert.equal(evento('Enter', 'number'), false);
});

/* ---------- corte: por denominación o por total, y «Contaste $X» ---------- */

function montarCorte({ forma = 'total', total = '', conteo = {} as Record<string, number>, terminal = '0', reciente = null as number | null, fallos = 0 } = {}) {
  const elementos = new Map<string, any>();
  const enviados: any[] = [];
  const pendientes: Promise<unknown>[] = [];
  const $ = (id: string) => {
    if (!elementos.has(id)) {
      const valores: Record<string, string> = { 'corte-total': total, 'corte-terminal': terminal, 'corte-notas': '' };
      elementos.set(id, { value: valores[id] ?? '', textContent: '', hidden: id === 'corte-confirmar', disabled: false, focoDe: 0, oyentes: {} as Record<string, any>,
        focus() { this.focoDe++; }, addEventListener(t: string, f: any) { this.oyentes[t] = f; },
        click() { const p = this.oyentes.click?.(); if (p) pendientes.push(p); } });
    }
    return elementos.get(id);
  };
  const contexto = {
    $, formaCorte: () => forma, conteoCorte: () => conteo, contadoDe, centavosDeTexto, pesosExactos, enfocarConteo() { $('conteo').focus(); },
    cajaActual: () => 'Caja 1', pintarResultado() {}, imprimirCorte: async () => true, pintarImpresora() {}, actualizarCorte() {},
    fetch: async (_r: string, o: any) => {
      enviados.push(JSON.parse(o.body));
      if (enviados.length <= fallos) throw new Error('sin red');
      return { ok: true, json: async () => ({ id: 'c', efectivo_contado: 1 }) };
    },
  };
  const modulo = entre('/** «Contaste $X» en grande', "$('corte-reimprimir')");
  const estado = runInNewContext(`let corteMontoConfirmado = false, corteSinEfectivo = false, corteConfirmado = false, corteReciente = ${reciente},
    idCorte = 'id-corte', ultimoCorte = null;
    ${modulo}
    ({ confirmado: () => corteMontoConfirmado })`, contexto);
  return { $, enviados, estado, registrar: async () => { $('corte-registrar').click(); await tick(); await Promise.all(pendientes); await tick(); } };
}

test('#817 corte por total: «Registrar conteo» muestra «Contaste $X» en grande y no envía; registrar manda efectivo_contado en centavos y sin conteo', async () => {
  const c = montarCorte({ total: '1234.50' });
  await c.registrar();
  assert.equal(c.enviados.length, 0);
  assert.equal(c.$('corte-contaste').textContent, 'Contaste $1,234.50');
  assert.equal(c.$('corte-confirmar-ok').textContent, 'Registrar $1,234.50');
  assert.equal(c.$('corte-formulario').hidden, true);
  assert.equal(c.$('corte-confirmar').hidden, false);
  assert.equal(c.$('corte-volver').focoDe, 1, 'el foco queda en «Volver a contar», no en registrar');
  assert.equal(c.$('corte-confirmar-ok').focoDe, 0);
  c.$('corte-confirmar-ok').click();
  await tick(); await tick();
  assert.equal(c.enviados.length, 1);
  assert.deepEqual(c.enviados[0], { id: 'id-corte', caja: 'Caja 1', efectivo_contado: 123450, tarjeta_terminal: 0, notas: '', sin_efectivo: false });
});

test('#817 corte por denominación: pide la misma confirmación y manda el conteo (sin efectivo_contado)', async () => {
  const c = montarCorte({ forma: 'denominaciones', conteo: { '50000': 1, '2000': 3 }, terminal: '150.25' });
  await c.registrar();
  assert.equal(c.$('corte-contaste').textContent, 'Contaste $560.00');
  assert.equal(c.enviados.length, 0);
  c.$('corte-confirmar-ok').click();
  await tick(); await tick();
  assert.deepEqual(c.enviados[0], { id: 'id-corte', caja: 'Caja 1', conteo: { '50000': 1, '2000': 3 }, tarjeta_terminal: 15025, notas: '', sin_efectivo: false });
});

test('#817 corte: «Volver a contar» regresa al formulario sin enviar y la siguiente vez vuelve a pedir confirmar', async () => {
  const c = montarCorte({ total: '500' });
  await c.registrar();
  c.$('corte-volver').click();
  assert.equal(c.$('corte-formulario').hidden, false);
  assert.equal(c.$('corte-confirmar').hidden, true);
  assert.equal(c.enviados.length, 0);
  assert.equal(c.estado.confirmado(), false);
  await c.registrar();
  assert.equal(c.$('corte-confirmar').hidden, false, 'otra vez «Contaste»');
  assert.equal(c.enviados.length, 0);
});

test('#817 corte por total: vacío o inválido no avanza; $0 conserva el aviso de cajón vacío antes de confirmar', async () => {
  for (const total of ['', 'abc', '10.005']) {
    const c = montarCorte({ total });
    await c.registrar();
    assert.match(c.$('corte-aviso').textContent, /Escribe el total contado/, total);
    assert.equal(c.$('corte-confirmar').hidden, true, 'no hay confirmación');
  }
  const cero = montarCorte({ total: '0' });
  await cero.registrar();
  assert.match(cero.$('corte-aviso').textContent, /No contaste efectivo/);
  assert.equal(cero.$('corte-registrar').textContent, 'Registrar con el cajón vacío');
  assert.equal(cero.$('corte-confirmar-ok').textContent, '', 'todavía no hay «Contaste»');
  await cero.registrar();
  assert.equal(cero.$('corte-contaste').textContent, 'Contaste $0.00');
  cero.$('corte-confirmar-ok').click();
  await tick(); await tick();
  assert.deepEqual(cero.enviados[0], { id: 'id-corte', caja: 'Caja 1', efectivo_contado: 0, tarjeta_terminal: 0, notas: '', sin_efectivo: true });
});

test('#817 corte: la confirmación de corte reciente sigue antes de «Contaste»', async () => {
  const c = montarCorte({ total: '800', reciente: 12 });
  await c.registrar();
  assert.match(c.$('corte-aviso').textContent, /El último corte de esta caja fue hace 12 min/);
  assert.equal(c.$('corte-confirmar-ok').textContent, '');
  await c.registrar();
  assert.equal(c.$('corte-contaste').textContent, 'Contaste $800.00');
  assert.equal(c.enviados.length, 0);
});

test('#817 corte: sin red el mismo id se reintenta y no vuelve a pedir «Contaste» si no cambió nada', async () => {
  const c = montarCorte({ total: '800', fallos: 1 });
  await c.registrar();
  c.$('corte-confirmar-ok').click();
  await tick(); await tick();
  assert.match(c.$('corte-aviso').textContent, /Sin red: intenta otra vez/);
  assert.equal(c.$('corte-registrar').disabled, false);
  await c.registrar();
  assert.equal(c.enviados.length, 2);
  assert.equal(c.enviados[1].id, 'id-corte');
  assert.equal(c.enviados[1].efectivo_contado, 80000);
  assert.equal(c.$('corte-confirmar').hidden, true, 'no se pidió confirmar otra vez');
});

test('#817 corte: abrir el corte reinicia la confirmación, recuerda la forma elegida y el aviso de ventas pendientes se ve mientras se espera', () => {
  assert.match(fuente, /corteMontoConfirmado = false;\n  let forma = 'denominaciones';/);
  assert.match(fuente, /localStorage\.setItem\(CLAVE_FORMA_CORTE, formaCorte\(\)\)/);
  const abrir = entre("$('abrir-corte').addEventListener", "$('corte-salir')");
  assert.ok(abrir.indexOf("'Enviando las ventas pendientes…'") > 0 && abrir.indexOf("'Enviando las ventas pendientes…'") < abrir.indexOf('await sincronizar()'));
  assert.ok(abrir.indexOf("$('corte-aviso').textContent = '';", abrir.indexOf('await sincronizar()')) > 0, 'se limpia al terminar de enviar');
  assert.match(abrir, /avisoCorteSinEnviar\(pendientes, navigator\.onLine\)/);
});

test('#817 conteo por tabla: más de 200 piezas se resalta y no bloquea', () => {
  const bloque = entre('function pintarContado()', "$('corte-denominaciones').innerHTML");
  const celdas: any[] = [];
  const campo = (denominacion: string, valor: string) => {
    const celda: any = { textContent: '', clases: new Set<string>(), classList: { toggle(c: string, v: boolean) { v ? celda.clases.add(c) : celda.clases.delete(c); } } };
    celdas.push(celda);
    return { value: valor, dataset: { denominacion }, closest: () => ({ lastElementChild: celda }) };
  };
  const campos = [campo('500', '250'), campo('2000', '3'), campo('100000', '')];
  const total = { textContent: '' };
  runInNewContext(`${bloque}; pintarContado()`, {
    document: { querySelectorAll: () => campos }, Number, conteoCorte: () => ({ '500': 250, '2000': 3 }), contadoDe, alertaConteo, pesos: (c: number) => `$${c / 100}`,
    $: () => total,
  });
  assert.equal(celdas[0].textContent, '¿Seguro? 250 × $5.00 = $1,250.00');
  assert.equal(celdas[0].clases.has('dudoso'), true);
  assert.equal(celdas[1].textContent, '$60');
  assert.equal(celdas[1].clases.has('dudoso'), false);
  assert.equal(celdas[2].textContent, '');
  assert.equal(total.textContent, '$1310', 'el total sigue sumando la cantidad improbable: avisa, no bloquea');
});

test('#817 corte por total: el servidor ya lo acepta sin conteo y el corte impreso queda sin tabla (contrato que usa la caja)', async () => {
  const t = tienda();
  try {
    const r = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 123450, tarjeta_terminal: 0 });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.efectivo_contado, 123450);
    assert.equal(r.cuerpo.conteo, '{}');
    const cero = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 0, tarjeta_terminal: 0, sin_efectivo: true });
    assert.equal(cero.status, 201);
  } finally { t.db.close(); }
});

/* ---------- avisos sueltos ---------- */

test('#817 aviso: está en el panel del escaneo, bajo #codigo y antes de las sugerencias, con role="status"', () => {
  const html = fuente.slice(0, fuente.indexOf('<script type="module">'));
  const campo = html.indexOf('id="codigo"');
  const aviso = html.indexOf('id="aviso"');
  assert.ok(campo > 0 && aviso > campo && aviso < html.indexOf('id="sugerencias"'), 'junto al campo de escaneo');
  assert.ok(aviso < html.indexOf('<section class="panel" id="cobro">'), 'en el panel izquierdo');
  assert.match(html, /<div id="aviso" role="status"><\/div>/);
  assert.equal(html.match(/id="aviso"/g)!.length, 1);
});

test('#817 tonos: las constantes de calibración están arriba del script, el sonido no depende de archivos y un fallo no rompe nada', () => {
  const script = fuente.slice(fuente.indexOf('<script type="module">'));
  assert.ok(script.indexOf('const TONO_PIEZA') < script.indexOf('const $ = '), 'constantes antes del resto del script');
  assert.match(script, /const TONO_RECHAZO = \{ hz: \d+, ms: \d+, volumen: [\d.]+, veces: 2, pausaMs: \d+ \}/);
  const sonar = entre('function sonar(', '\n}\n') + '\n}\n';
  // Sin AudioContext (o con uno que se niega) no pasa nada.
  assert.doesNotThrow(() => runInNewContext(`${sonar}; sonar({ hz: 1, ms: 1, volumen: 1, veces: 1, pausaMs: 0 })`, { audio: null }));
  const creados: any[] = [];
  const AudioContext = function () {
    return { state: 'suspended', currentTime: 0, destination: {}, resume: () => Promise.reject(new Error('sin gesto')),
      createOscillator: () => { const o = { frequency: {}, connect: (x: any) => x, start() {}, stop() {} }; creados.push(o); return o; },
      createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x: any) => x }) };
  };
  runInNewContext(`let audio = null; ${sonar}; sonar({ hz: 280, ms: 110, volumen: 0.3, veces: 2, pausaMs: 70 })`, { AudioContext });
  assert.equal(creados.length, 2, 'el tono de rechazo es doble');
});

function montarAgregar(piezas: any[], { enLinea = true, recarga = [] as any[] } = {}) {
  const $ = (() => { const el = { textContent: '', style: {} }; return () => el; })();
  const escaneos: [string, boolean][] = [];
  const recargas: number[] = [];
  const catalogo = new Map(piezas.map((p) => [p.codigo, p]));
  const contexto: Record<string, unknown> = {
    $, catalogo, agregar, leerMultiplicador, codigoDeDigitos, avisoExistencia, precioHoy: (p: any) => p.precio, Map, Date, puedeVenderEnMano, ocultarEnMano() {}, ofrecerEnMano() {}, ticketEnDuda: () => false,
    navigator: { onLine: enLinea }, pintar() {}, cargarPedido() {}, buscarSocio() {},
    // El catálogo que baja la recarga: reemplaza lo que había (como cargarCatalogo).
    cargarCatalogo: async () => { recargas.push(1); for (const p of recarga) catalogo.set(p.codigo, p); },
    escanear: (leido: string, reintento: boolean) => { escaneos.push([leido, reintento]); return true; },
  };
  const rutina = runInNewContext(`let cobrando = false, idVenta = null, lineas = [];
    ${entre('function buscarPieza(', '/* ---------- busqueda a mano')}
    ({ agregarCodigo, lineas: () => lineas })`, contexto);
  return { ...rutina, aviso: $(), escaneos, recargas };
}
const pieza = (codigo: string, stock: number, extra: Record<string, unknown> = {}) => ({ codigo, nombre: `Pieza ${codigo}`, precio: 5000, stock, id: `id-${codigo}`, ...extra });

test('#817 agregarCodigo: el catálogo vacío dice que no ha cargado (y recarga una vez); con catálogo, «no encontrado»', async () => {
  const vacio = montarAgregar([]);
  assert.equal(vacio.agregarCodigo('ED-000001'), false);
  assert.equal(vacio.aviso.textContent, 'El catálogo no ha cargado. Recarga la página con red (F5).');
  await tick();
  assert.equal(vacio.recargas.length, 1);
  const con = montarAgregar([pieza('ED-000002', 1)]);
  assert.equal(con.agregarCodigo('ED-000001'), false);
  assert.equal(con.aviso.textContent, 'Código no encontrado: ED-000001');
});

test('#817 agregarCodigo: sin existencia dice qué hacer, baja el catálogo UNA vez y, si ya hay, la agrega; sin red o ya reintentado no recarga', async () => {
  const sinExistencia = 'Pieza ED-000001 ya se vendió, está apartada o no está en esta tienda. Si es de un pedido, escanea su folio (P-…).';
  const a = montarAgregar([pieza('ED-000001', 0)], { recarga: [pieza('ED-000001', 1)] });
  assert.equal(a.agregarCodigo('ED-000001'), false);
  assert.equal(a.aviso.textContent, sinExistencia, 'el aviso sale sin esperar la recarga');
  await tick();
  assert.equal(a.recargas.length, 1);
  assert.deepEqual(a.escaneos, [['ED-000001', true]], 'con la existencia nueva se reintenta una vez');

  const sigueVendida = montarAgregar([pieza('ED-000001', 0)], { recarga: [pieza('ED-000001', 0)] });
  sigueVendida.agregarCodigo('ED-000001');
  await tick();
  assert.equal(sigueVendida.recargas.length, 1);
  assert.deepEqual(sigueVendida.escaneos, [], 'sigue vendida: nada más que el aviso');

  const reintento = montarAgregar([pieza('ED-000001', 0)]);
  reintento.agregarCodigo('ED-000001', true);
  const sinRed = montarAgregar([pieza('ED-000001', 0)], { enLinea: false });
  sinRed.agregarCodigo('ED-000001');
  await tick();
  assert.equal(reintento.recargas.length + sinRed.recargas.length, 0);
  const ya = montarAgregar([pieza('ED-000001', 1)]);
  assert.equal(ya.agregarCodigo('ED-000001'), true);
  assert.equal(ya.agregarCodigo('ED-000001'), false);
  assert.equal(ya.aviso.textContent, 'Pieza ED-000001 ya está en este ticket.');
});

test('#817 pie del catálogo: sin red el texto se asigna completo, no se acumula cada minuto', async () => {
  const pie = { textContent: '' };
  const cargar = runInNewContext(`let catalogo = new Map();
    ${entre('const CATALOGO_COMPLETO_MS', '/* ---------- ticket')}; cargarCatalogo`, {
    $: () => pie, Map, Date, Number, store: async () => undefined, fetch: async () => { throw new TypeError('sin red'); },
  });
  await cargar(); await cargar(); await cargar();
  assert.equal(pie.textContent, '0 códigos · sin actualizar');
});

test('#817 pie de ventas por sincronizar: singular y plural', async () => {
  const bloque = entre('async function pendientes()', '/** Ventas que el servidor rechazo');
  const pie: any = { textContent: '', style: {} };
  const cola = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i), creado_en: new Date().toISOString() }));
  const correr = async (n: number) => {
    await runInNewContext(`${bloque}; pendientes()`, { $: () => pie, store: async () => cola(n), nVentas, Date, Math });
    return pie.textContent;
  };
  assert.equal(await correr(1), '1 venta por sincronizar');
  assert.equal(await correr(3), '3 ventas por sincronizar');
});

test('#817 gasto: se avisa al escribir el importe pero no se bloquea el registro', () => {
  const bloque = entre('function avisarGastoGrande()', "$('retiro-importe').addEventListener");
  const aviso = { textContent: '' };
  const correr = (tipo: string, importe: string) => {
    runInNewContext(`${bloque}; avisarGastoGrande()`, { $: (id: string) => (id === 'retiro-aviso' ? aviso : { value: importe }), tipoSalida: () => tipo, gastoRequiereDueno, Math, Number });
    return aviso.textContent;
  };
  assert.equal(correr('gasto', '100'), '');
  assert.equal(correr('gasto', '100.50'), 'Más de $100: lo registra gerencia.');
  assert.equal(correr('retiro', '5000'), '');
});

test('#817 cerrar sesión sin red: si el módulo no carga, avisa y no cierra; con red cierra', async () => {
  // `import()` dinámico no corre dentro de vm: se cambia por una función del contexto y se prueba lo que el manejador hace con su resultado.
  const bloque = entre("$('cerrar-sesion').addEventListener", "$('abrir-corte').addEventListener").replace("import('/cerrar-sesion.js')", "importar('/cerrar-sesion.js')");
  assert.match(bloque, /importar\(/, 'el reemplazo aplicó');
  for (const sinRed of [true, false]) {
    let manejador: () => Promise<void> = async () => {};
    const avisos: string[] = []; const cierres: unknown[] = [];
    runInNewContext(bloque, {
      $: () => ({ addEventListener: (_t: string, f: any) => { manejador = f; } }), avisoRojo: (t: string) => avisos.push(t), store() {},
      importar: async () => { if (sinRed) throw new TypeError('Failed to fetch dynamically imported module'); return { cerrarSesion: async (o: unknown) => { cierres.push(o); } }; },
    });
    await manejador();
    assert.deepEqual(avisos, sinRed ? ['Sin red: no se puede cerrar sesión.'] : []);
    assert.equal(cierres.length, sinRed ? 0 : 1);
  }
});

function montarBuscarSocio(respuesta: { ok: boolean; cuerpo: Record<string, unknown> }) {
  const orden: string[] = [];
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, { value: '', textContent: '', innerHTML: '', hidden: false, style: {}, focus() { orden.push(`foco:${id}`); } });
    return elementos.get(id);
  };
  $('socio').value = '#7';
  const rutinas = runInNewContext(`let socio = null, valesCargados = [], busquedaSocio = 0, cobrando = false, valesPrueba = false, codigoSocio = '', usarTodos = false;
    ${entre('function pintarSocio()', "$('buscar-socio').addEventListener")}; ({ buscarSocio })`, {
    $, guiaVale, dolares: String, escapar: String, idVenta: 'x', pintar() {}, avisoRojo() {}, setTimeout, Promise, Date, Math, codigoDeDigitos,
    preguntarDolarones() { orden.push('ventana-dolarones'); },
    fetch: async () => ({ ok: respuesta.ok, json: async () => respuesta.cuerpo }),
  });
  return { ...rutinas, orden, $ };
}

test('#817 foco: tras ligar un socio el lector sigue en #codigo (antes de abrir la ventana de Dolarones); si no se encuentra, el foco se queda en la búsqueda', async () => {
  const bien = montarBuscarSocio({ ok: true, cuerpo: { numero: 7, nombre: 'Ana', disponible: 500, maximo: 500, expira_en: '2099-01-01T00:00:00Z' } });
  await bien.buscarSocio();
  assert.deepEqual(bien.orden, ['foco:codigo', 'ventana-dolarones']);
  const mal = montarBuscarSocio({ ok: false, cuerpo: { error: 'No se encontró el socio.' } });
  await mal.buscarSocio();
  assert.deepEqual(mal.orden, [], 'sin socio no se mueve el foco');
});

test('#817 foco: «Usar todos» y «No usar» devuelven el foco a #codigo; «Otra cantidad» lo deja en Dolarones', () => {
  const montar = () => {
    const orden: string[] = [];
    const $ = (id: string) => ({ close() { orden.push(`cerrar:${id}`); }, focus() { orden.push(`foco:${id}`); } });
    const rutinas = runInNewContext(`let usarTodos = false, idVenta = 'x'; ${entre('function cerrarDialogo(', "$('dlg-todos').addEventListener")}
      ({ cerrarDialogo, usarTodos: () => usarTodos })`, { $, pintar() { orden.push('pintar'); } });
    return { ...rutinas, orden };
  };
  const todos = montar(); todos.cerrarDialogo('todos');
  assert.equal(todos.usarTodos(), true);
  assert.deepEqual(todos.orden, ['cerrar:dlg-dolarones', 'pintar', 'foco:codigo']);
  const no = montar(); no.cerrarDialogo('no');
  assert.deepEqual(no.orden.slice(-1), ['foco:codigo']);
  const otra = montar(); otra.cerrarDialogo('otra');
  assert.deepEqual(otra.orden.slice(-1), ['foco:dolarones']);
});

test('#817 «Ventas de hoy» abierta se refresca tras cobrar y sincronizar (actualizarCorte, aun sin red)', async () => {
  for (const sinRed of [false, true]) {
    let listas = 0;
    const corte = { textContent: '' };
    const actualizar = runInNewContext(`${entre('async function actualizarCorte()', '/* ---------- eventos')}; actualizarCorte`, {
      $: () => corte, cargarTickets: () => { listas++; },
      fetch: async () => { if (sinRed) throw new TypeError('sin red'); return { json: async () => ({ por_forma_pago: [{ tickets: 2 }], piezas: 5 }) }; },
    });
    await actualizar();
    assert.equal(listas, 1, `sinRed=${sinRed}`);
    assert.equal(corte.textContent, sinRed ? '' : 'Hoy: 2 ventas · 5 piezas');
  }
  // sincronizar() termina siempre en actualizarCorte(): ahí se refresca la lista.
  let corteActualizado = 0;
  const sincronizar = runInNewContext(`${entre('let sincronizando = false;', 'async function pendientes()')}; sincronizar`, {
    store: async () => [], fetch: async () => { throw new Error('sin red'); }, AbortSignal, $: () => ({ textContent: '' }), dolares: String,
    pintarResultadosVales() {}, pendientes() {}, pintarRechazadas() {}, actualizarCorte: () => { corteActualizado++; },
  });
  await sincronizar();
  assert.equal(corteActualizado, 1);
});
