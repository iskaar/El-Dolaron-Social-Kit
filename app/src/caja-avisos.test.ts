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

test('«parece texto»: solo lo que tiene letras y no es ED-, P-, DC-/DP-, BU- ni dígitos se busca por nombre', () => {
  for (const texto of ['bufanda', 'juguetes 49', '3*bufanda', 'budín', 'ñoño', 'camisa roja']) assert.equal(esBusquedaPorTexto(texto), true, texto);
  for (const codigo of ['123', '000123', '7501234567890', 'ED-000123', 'ed-1', 'P-17', 'p17', 'DC-abc', 'DP-XYZ', 'BU-K7Q2M', '3*ED-000001', ' 45 ', '5*123'])
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
  fetch?: (ruta: string, opciones: any) => Promise<unknown>;
  abrirCajon?: () => unknown;
  imprimirTicket?: () => unknown;
  valores?: Record<string, string>;
  pedido?: boolean;
}
function montarCobro(op: Opciones = {}) {
  const elementos = new Map<string, any>();
  const vistos: unknown[] = [];
  const guardadas: unknown[] = [];
  const $ = (id: string) => {
    if (!elementos.has(id)) {
      elementos.set(id, id === 'aviso' ? avisoFalso() : { value: op.valores?.[id] ?? (id === 'forma' ? 'efectivo' : id === 'efectivo' ? '300' : ''),
        textContent: '', style: {}, disabled: false, enfocado: false, focus() { if (!this.disabled) this.enfocado = true; } });
    }
    return elementos.get(id);
  };
  const contexto: Record<string, unknown> = {
    crypto, Date, $, AbortSignal, Object, Math, vistos, totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido,
    transferenciaDe, CLAVE_DESDE, debePreguntarSocio, navigator: { onLine: true }, window: { open() {} },
    document: { createElement: () => ({ style: {}, textContent: '' }) },
    lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: 30000, cantidad: 1 }],
    socio: null, valesCargados: [], catalogo: new Map(), pedidoCargado: op.pedido ? { id: 'ped-1', folio: 17, saldo: 10000 } : null,
    preguntarSocio: async () => 'cobrar', preguntarForma: async () => 'efectivo',
    impresionRemota: () => false, exigirCaja: () => true, cajaActual: () => 'Caja 1', dolaronesPedidos: () => 0,
    descuento: null, descuentoAplicado: () => 0, promoActual: () => 0, totalNeto: () => 30000, pintarDescuento() {},
    pesos: String, dolares: String, quitarSocio() {}, sincronizar() {}, cargarCatalogo() {}, pintarImpresora() {}, promoConfig: null,
    abrirCajon: op.abrirCajon ?? (async () => true), imprimirTicket: op.imprimirTicket ?? (async () => true),
    store: async (almacen: string, _m: string, fn: any) => fn({ put(v: unknown) { if (almacen === 'ventas') guardadas.push(v); } }),
    fetch: op.fetch ?? (async () => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null, saldo_pedido: 0 }) })),
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const falla = entre('function pintarFalla(', '\n}\n') + '\n}\n';
  const conPedido = entre('async function cobrarConPedido(', '/* ---------- cobro: primero');
  const errorClave = entre('function errorClave(', "for (const id of ['clave-rastreo'");
  const cobro = entre('async function cobrar()', 'let sincronizando = false;');
  // pintar() es el de la pantalla en lo que importa aquí: deshabilita #codigo mientras se cobra y guarda el folio que ve.
  const cobrar = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, formaElegida = false;
    function pintar() { $('codigo').disabled = cobrando; vistos.push(idVenta); }
    ${avisoRojo}\n${falla}\n${conPedido}\n${errorClave}\n${cobro}; cobrar`, contexto);
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

test('#817 cajón e impresora: si fallan, el aviso de «Cobrado» lo dice en rojo y no frena el cobro, llegue antes o después del aviso', async () => {
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

  const tarjeta = montarCobro({ valores: { forma: 'tarjeta' }, abrirCajon: () => assert.fail('con tarjeta no se abre el cajón'), imprimirTicket: async () => false });
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

/* ---------- Dolarones: límite de espera y reintento ---------- */

function montarDolarones(error: unknown) {
  const llamadas: any[] = [];
  const $ = (() => { const el = { textContent: '', style: {} }; return () => el; })();
  const cobrarConDolarones = runInNewContext(`${entre('async function cobrarConDolarones(', '/* ---------- pedidos por WhatsApp')}; cobrarConDolarones`, {
    $, AbortSignal, Date, Object, dolaronesGanados, promoAgotada() {},
    codigoSocio: 'DC-x', socio: { maximo: 99999, expira_en: '2099-01-01T00:00:00Z', vale: false, numero: 7, disponible: 5000 }, valesCargados: [],
    fetch: async (_r: string, o: any) => { llamadas.push(o); throw error; },
  });
  return { cobrarConDolarones, llamadas, $ };
}

test('#817 Dolarones: la petición tiene el mismo límite de 15 s y, si vence, dice que se puede volver a tocar Cobrar', async () => {
  const vencida = montarDolarones(new DOMException('timeout', 'TimeoutError'));
  assert.equal(await vencida.cobrarConDolarones({ dolarones: 1000 }, { aPagar: 5000 }), false);
  assert.ok(vencida.llamadas[0].signal instanceof AbortSignal);
  assert.match(vencida.$().textContent, /No se supo si se cobró\. Toca Cobrar otra vez.*mismo folio no se cobra dos veces.*Ventas de hoy/);
  const sinRed = montarDolarones(new TypeError('Failed to fetch'));
  await sinRed.cobrarConDolarones({ dolarones: 1000 }, { aPagar: 5000 });
  assert.match(sinRed.$().textContent, /^Sin red: no se pudo cobrar con Dolarones/);
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
    assert.equal((await t.pedir('/api/portal/llegada', { cliente_id: socio.id })).status, 200);
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
    moverSugerencia, esBusquedaPorTexto,
    buscarPieza: (t: string) => catalogo.find((p) => p.codigo === t.trim().toUpperCase()),
    buscarPorTexto: (t: string) => catalogo.filter((p) => p.nombre.toLowerCase().includes(t.trim().toLowerCase())),
    agregarCodigo: (leido: string, reintento = false) => { agregadas.push([leido, reintento]); return true; },
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

/* ---------- ticket, cancelar, rueda ---------- */

test('#817 renglón: Mayús + clic quita el renglón entero; el clic solo quita una pieza', () => {
  const montar = () => {
    const estado: any = { lineas: [{ codigo: 'A', cantidad: 3 }, { codigo: 'B', cantidad: 1 }], idVenta: 'x', pintada: 0 };
    let oyente: (e: any) => void = () => {};
    runInNewContext(`${entre("$('ticket').addEventListener('click'", "$('efectivo').addEventListener('input'")}`, {
      $: () => ({ addEventListener: (_t: string, f: any) => { oyente = f; } }),
      get lineas() { return estado.lineas; }, set lineas(v) { estado.lineas = v; },
      get idVenta() { return estado.idVenta; }, set idVenta(v) { estado.idVenta = v; },
      pintar() { estado.pintada++; },
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

test('#817 cancelar: con 3 piezas pide un segundo toque; con 2 o vacío cancela de una vez', () => {
  const montar = (lineas: any[], extra: Record<string, unknown> = {}) => {
    const temporizadores: (() => void)[] = [];
    const estado: any = { lineas, idVenta: 'x', limpiadas: 0 };
    const elementos = new Map<string, any>();
    const $ = (id: string) => {
      if (!elementos.has(id)) elementos.set(id, { value: '', textContent: id === 'cancelar' ? 'Cancelar venta' : '', style: {}, dataset: {}, focus() {}, addEventListener(_t: string, f: any) { this.clic = f; } });
      return elementos.get(id);
    };
    runInNewContext(entre('// Con descuento aprobado, pedido cargado', 'function pintarRed()'), {
      $, totales, cancelarPideConfirmar, descuento: null, pedidoCargado: null, sinPromo: false, formaElegida: false, ...extra,
      get lineas() { return estado.lineas; }, set lineas(v) { estado.lineas = v; },
      idVenta: 'x', pintarDescuento() {}, quitarSocio() { estado.limpiadas++; }, pintar() {}, clearTimeout() {},
      setTimeout: (f: () => void) => { temporizadores.push(f); return temporizadores.length; },
      document: { addEventListener() {} },
    });
    return { estado, $, temporizadores, clic: () => $('cancelar').clic() };
  };
  const linea = (cantidad: number) => ({ codigo: 'A', precio: 100, cantidad });
  const tres = montar([linea(3)]);
  tres.clic();
  assert.equal(tres.estado.lineas.length, 1, 'el primer toque no borra');
  assert.equal(tres.$('cancelar').textContent, 'Toca otra vez para borrar el ticket');
  assert.equal(tres.$('aviso').textContent, 'Toca otra vez para borrar el ticket.');
  tres.clic();
  assert.equal(tres.estado.lineas.length, 0);
  assert.equal(tres.$('cancelar').textContent, 'Cancelar venta');

  const vencido = montar([linea(3)]);
  vencido.clic();
  vencido.temporizadores[0]();   // pasaron 4 s sin el segundo toque
  assert.equal(vencido.$('cancelar').textContent, 'Cancelar venta');
  vencido.clic();
  assert.equal(vencido.estado.lineas.length, 1, 'otra vez pide confirmar');

  const dos = montar([linea(2)]);
  dos.clic();
  assert.equal(dos.estado.lineas.length, 0);
  assert.equal(dos.$('aviso').textContent, 'Venta cancelada');

  const aprobado = montar([linea(1)], { descuento: { estado: 'aprobada' } });
  aprobado.clic();
  assert.equal(aprobado.estado.lineas.length, 1);
  const vacio = montar([]);
  vacio.clic();
  assert.equal(vacio.$('aviso').textContent, 'Venta cancelada');
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

test('#817 agregarCodigo: el catálogo vacío tiene su aviso, y todo sonido sale del resultado de escanear()', () => {
  assert.match(fuente, /catalogo\.size === 0\n\s+\? 'El catálogo no ha cargado\. Recarga la página con red \(F5\)\.'/);
  const escanear = entre('function escanear(', '\n}\n');
  assert.match(escanear, /r === true\) sonar\(TONO_PIEZA\)/);
  assert.match(escanear, /r === false\) sonar\(TONO_RECHAZO\)/);
  assert.equal(fuente.match(/escanear\(/g)!.length >= 4, true, 'lector, sugerencias, Enter y cámara');
});

test('#817 pie del catálogo: «sin actualizar» se asigna completo, no se acumula', () => {
  const bloque = entre('async function cargarCatalogo()', '/* ---------- ticket');
  assert.doesNotMatch(bloque, /\+= ' · sin actualizar'/);
  assert.match(bloque, /textContent = `\$\{catalogo\.size\} códigos · sin actualizar`/);
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
  assert.equal(correr('gasto', '100.50'), 'Más de $100: lo registra el dueño.');
  assert.equal(correr('retiro', '5000'), '');
  assert.doesNotMatch(entre("$('retiro-registrar').addEventListener", '/* ---------- corte de caja'), /requiereDueno|Más de \$100/);
});

test('#817 cerrar sesión sin red: si el módulo no carga, avisa en vez de no hacer nada', () => {
  const bloque = entre("$('cerrar-sesion').addEventListener", "$('abrir-corte').addEventListener");
  assert.match(bloque, /try \{ \(\{ cerrarSesion \} = await import\('\/cerrar-sesion\.js'\)\); \}\n\s+catch \{ avisoRojo\('Sin red: no se puede cerrar sesión\.'\); return; \}/);
});

test('#817 foco: tras ligar un socio y tras «Usar todos» el lector sigue en #codigo', () => {
  const buscar = entre('async function buscarSocio()', "$('buscar-socio').addEventListener");
  assert.match(buscar, /pintar\(\);\n\s+\$\('codigo'\)\.focus\(\);[^\n]*\n\s+preguntarDolarones\(\);/);
  const cerrar = entre('function cerrarDialogo(', "$('dlg-todos').addEventListener");
  assert.match(cerrar, /if \(usar === 'otra'\) \$\('dolarones'\)\.focus\(\);\n\s+else \$\('codigo'\)\.focus\(\);/);
});

test('#817 «Ventas de hoy» abierta se refresca al actualizar el corte (tras cobrar y sincronizar)', () => {
  assert.match(entre('async function actualizarCorte()', '/* ---------- eventos'), /\n  cargarTickets\(\);/);
  assert.match(entre('async function sincronizar()', 'async function pendientes()'), /await actualizarCorte\(\)/);
});
