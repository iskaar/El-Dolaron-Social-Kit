// node --test src/caja-cobro-incierto.test.ts
// Issue #933: con un cobro en duda (la respuesta no llegó) la caja solo deja repetir ESE cobro. Todo cambio al ticket pasa por `cambiarTicket()`
// (public/caja.html); aquí se corre su código REAL contra una pantalla mínima, una prueba por cada vía de escape conocida. Lo que se guarda
// al recargar y su validación viven en public/venta.js. El reintento tras recargar sale idéntico: caja-botones-cobro.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { cobroEnDuda, fotoDeVenta, ventaRecuperada, totales, cancelarPideConfirmar, guiaVale, maximoCanje, leerMensajeAlta, agregar, descuentoDe, huellaTicket } from '../public/venta.js';
import { codigoDeDigitos } from '../public/code128.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const AVISO_DUDA = 'Primero termina el cobro pendiente: toca otra vez el mismo botón.';

/* ---------- la lógica pura (venta.js) ---------- */

test('#933 cobroEnDuda: solo si el folio del ticket es el del cobro dudoso', () => {
  assert.equal(cobroEnDuda({ idVenta: 'f1', cobroIncierto: { id: 'f1' } }), true);
  assert.equal(cobroEnDuda({ idVenta: 'f2', cobroIncierto: { id: 'f1' } }), false);
  assert.equal(cobroEnDuda({ idVenta: null, cobroIncierto: { id: 'f1' } }), false);
  assert.equal(cobroEnDuda({ idVenta: 'f1', cobroIncierto: null }), false);
});

test('#933 qué se guarda del cobro en duda: socio, código, vales, Dolarones y «sin promo»; y solo se acepta si es de ese cobro', () => {
  const socio = { id: 's1', numero: 7, nombre: 'Ana', disponible: 5000, maximo: 5000, expira_en: '2099-01-01T00:00:00Z', vale: false };
  const foto = fotoDeVenta({ socio, codigoSocio: 'DC-x', valesCargados: [{ codigo: 'DP-1' }], dolarones: 50, sinPromo: true });
  assert.deepEqual(foto, { socio, codigoSocio: 'DC-x', valesCargados: [{ codigo: 'DP-1' }], dolarones: '50', sinPromo: true });
  const guardado = JSON.parse(JSON.stringify({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: foto }));
  assert.deepEqual(ventaRecuperada(guardado), foto);
  // Sin socio ni nada: una foto vacía sigue siendo válida (el reintento es «sin socio» a propósito).
  assert.deepEqual(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: fotoDeVenta({}) }),
    { socio: null, codigoSocio: '', valesCargados: [], dolarones: '', sinPromo: false });
  // Un ticket guardado por la versión anterior (sin `venta`) o con un folio que no es el del cobro dudoso no trae nada: se carga como siempre.
  assert.equal(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' } }), null);
  assert.equal(ventaRecuperada({ idVenta: 'f2', cobroIncierto: { id: 'f1' }, venta: foto }), null);
  assert.equal(ventaRecuperada({ idVenta: 'f1', cobroIncierto: null, venta: foto }), null);
  assert.equal(ventaRecuperada(null), null);
  assert.equal(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: 'basura' }), null);
  // Lo mal formado se descarta campo por campo, sin romper la carga.
  assert.deepEqual(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: { socio: [1], codigoSocio: 5, valesCargados: 'x', dolarones: 3, sinPromo: 'sí' } }),
    { socio: null, codigoSocio: '', valesCargados: [], dolarones: '', sinPromo: false });
});

/* ---------- el folio solo se suelta en la puerta ---------- */

test('#933 `idVenta` solo se suelta en la puerta (cambiarTicket) y en tres sitios que no son del cajero: cobro terminado, descuento que ya no aplica o vencido', () => {
  const asignaciones = [...fuente.matchAll(/^\s+idVenta = (.+);$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(asignaciones, ['crypto.randomUUID()', 'g.idVenta ?? null', 'null', 'null', 'null', 'null'], 'cualquier otro `idVenta = …` nuevo es una vía sin puerta');
  const suelta = (desde: string, hasta: string) => [...entre(desde, hasta).matchAll(/^\s+idVenta = null;$/gm)].length;
  assert.equal(suelta('function cambiarTicket(', '// Pedido por WhatsApp cargado'), 1, 'la puerta');
  assert.equal(suelta('function pintar() {', 'function buscarPieza('), 1, 'pintar(): el descuento ya no corresponde al ticket (nunca con duda)');
  assert.equal(suelta('function revisarVencimientoDescuento(', 'const horaDe'), 1, 'descuento vencido (nunca con duda)');
  assert.equal(suelta('async function cobrar(', 'let sincronizando = false;'), 1, 'la venta ya cobrada');
});

/* ---------- la pantalla: el código real de cada vía, con un cobro en duda ---------- */

function elemento(id: string, foco: string[]) {
  const e: any = { id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, returnValue: '', style: {}, dataset: {}, contentWindow: {},
    oyentes: {} as Record<string, ((ev?: any) => unknown)[]>,
    addEventListener(t: string, f: (ev?: any) => unknown) { (e.oyentes[t] ??= []).push(f); },
    async disparar(t: string, ev: any = {}) { for (const f of e.oyentes[t] ?? []) await f(ev); },
    focus() { foco.push(id); }, click() { for (const f of e.oyentes.click ?? []) f(); }, close() { e.open = false; }, showModal() { e.open = true; }, replaceChildren() {}, append() {} };
  return e;
}
const SOCIO = { id: 's1', numero: 7, nombre: 'Ana', disponible: 50000, regalo_disponible: 0, maximo: 50000, expira_en: '2099-01-01T00:00:00Z', vale: false };
const SOCIO_NUEVO = { id: 's2', numero: 8, nombre: 'Beto', disponible: 1000, regalo_disponible: 0, maximo: 1000, expira_en: '2099-01-01T00:00:00Z', vale: false };
const PEDIDO = { pedido: { id: 'ped-1', folio: 17, cliente: 'Cli', estado: 'pagado', entrega: 'tienda', saldo: 10000, saldo_vence_en: '2099-01-01T00:00:00Z', lineas: [] } };
const DESCUENTO = { id: 'd1', monto: 1000, estado: 'aprobada', vence_en: '2099-01-01T00:00:00Z' };
const lineasDe = (n: number) => Array.from({ length: n }, (_, i) => ({ codigo: `ED-00000${i}`, nombre: `Pieza ${i}`, precio: 10000, cantidad: 1, producto_id: `p${i}` }));

function montar(op: { enDuda?: boolean; lineas?: number; cobrando?: boolean } = {}) {
  const enDuda = op.enDuda ?? true;
  const foco: string[] = [];
  const els = new Map<string, any>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, elemento(id, foco)); return els.get(id); };
  const peticiones: string[] = [];
  let teclado: (e: any) => void = () => {};
  let mensaje: (e: any) => unknown = () => {};
  const puesto = { responder: async (ruta: string): Promise<any> => ({ ok: true, json: async () => (ruta.includes('/api/pedidos/') ? PEDIDO : ruta === '/api/descuentos' ? DESCUENTO : SOCIO_NUEVO) }) };
  let pintadas = 0;
  $('dolarones').value = '50';
  const contexto: Record<string, unknown> = {
    $, totales, cancelarPideConfirmar, codigoDeDigitos, guiaVale, maximoCanje, leerMensajeAlta, cobroEnDuda, agregar, descuentoDe, huellaTicket,
    dolares: String, escapar: String, pesos: String, Promise, Date, Math, Number, JSON, setTimeout, clearTimeout, Object,
    navigator: { onLine: true }, location: { origin: 'https://caja' },
    document: { addEventListener: (t: string, f: (e: any) => void) => { if (t === 'keydown') teclado = f; }, querySelector: () => null },
    addEventListener: (t: string, f: (e: any) => unknown) => { if (t === 'message') mensaje = f; },
    pintar() { pintadas++; }, pintarDescuento() {}, quitarDescuentoEnServidor() {}, limpiarDatosTransferencia() {}, totalNeto: () => 30000, cajaActual: () => 'Caja 1',
    pasaDelTopeSinDueno: () => false, AVISO_TOPE: '', catalogo: new Map(), L: lineasDe(op.lineas ?? 3), S: SOCIO,
    fetch: async (ruta: string) => { peticiones.push(ruta); return puesto.responder(ruta); },
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const rutinas = runInNewContext(`let cobrando = ${!!op.cobrando}, idVenta = 'folio-1', creadoEnVenta = '2026-11-25T12:00:00.000Z',
      folioIncierto = ${enDuda ? "'folio-1'" : 'null'}, cobroIncierto = ${enDuda ? "{ id: 'folio-1', boton: 'tarjeta', efectivo: 0 }" : 'null'},
      lineas = L, sinPromo = false, socio = S, codigoSocio = 'DC-x', codigoLlegada = '', valesCargados = [], usarTodos = false, busquedaSocio = 0,
      valesPrueba = false, descuento = null, pedidoCargado = null, cancelarArmado = null;
    ${entre('function ticketEnDuda()', '// Pedido por WhatsApp cargado')}
    ${entre("$('quitar-promo').addEventListener('click'", '\nsetInterval(cargarConfigVales')}
    ${entre('async function enviarDescuento(', "$('enviar-descuento').addEventListener")}
    ${entre('function pintarSocio()', '/**\n * Con Dolarones el cobro espera')}
    ${avisoRojo}
    ${entre('async function cargarPedido(', '/**\n * Con pedido el cobro espera')}
    ${entre('// Doble Esc borra el ticket', 'function pintarRed()')}
    ({ buscarSocio, enviarDescuento, cargarPedido, abrirAlta,
       estado: () => JSON.stringify({ idVenta, socio, codigoSocio, valesCargados, sinPromo, usarTodos, lineas, descuento, pedidoCargado }),
       dudar: (id) => { idVenta = id; folioIncierto = id; cobroIncierto = { id, boton: 'tarjeta', efectivo: 0 }; } })`, contexto);
  return {
    ...rutinas, $, peticiones, foco, puesto, pintadas: () => pintadas,
    estado: () => JSON.parse(rutinas.estado() as string),
    mensajeAlta: (numero: number) => mensaje({ origin: 'https://caja', source: $('dlg-alta-marco').contentWindow, data: { tipo: 'alta-socio', numero } }),
    escape: (marca: number) => teclado({ key: 'Escape', repeat: false, timeStamp: marca }),
  };
}
type Caja = ReturnType<typeof montar>;

/** Cada vía por la que el cajero (o el lector, o una respuesta tardía) podía cambiar el ticket o soltar el folio con el cobro en duda. */
const VIAS: [string, (c: Caja) => Promise<unknown> | unknown, number?][] = [
  ['buscar un socio escribiendo su teléfono + Enter', async (c) => { c.$('socio').value = '4491112222'; await c.$('socio').disparar('keydown', { key: 'Enter' }); }],
  ['buscar un socio con el botón «Buscar»', async (c) => { c.$('socio').value = '#8'; await c.$('buscar-socio').disparar('click'); }],
  ['cerrar la ventana de alta con un socio nuevo', async (c) => { c.abrirAlta(); c.mensajeAlta(8); await c.$('dlg-alta').disparar('close'); }],
  ['teclear en «Pagar con Dolarones»', async (c) => { c.$('dolarones').value = '10'; await c.$('dolarones').disparar('input'); }],
  ['«Usar máximo»', async (c) => { await c.$('usar-maximo').disparar('click'); }],
  ['«Usar todos» de la ventana de Dolarones', async (c) => { await c.$('dlg-todos').disparar('click'); }],
  ['«No usar» de la ventana de Dolarones', async (c) => { await c.$('dlg-no').disparar('click'); }],
  ['«Ya usó la promo»', async (c) => { await c.$('quitar-promo').disparar('click'); }],
  ['«Cancelar venta» con 1 pieza (cancela de una vez)', async (c) => { await c.$('cancelar').disparar('click'); }, 1],
  ['«Cancelar venta» con 2 piezas (cancela de una vez)', async (c) => { await c.$('cancelar').disparar('click'); }, 2],
  ['«Cancelar venta» con 3 piezas, dos toques', async (c) => { await c.$('cancelar').disparar('click'); await c.$('cancelar').disparar('click'); }, 3],
  ['doble Esc con 2 piezas (cancela de una vez)', async (c) => { c.escape(1000); c.escape(1300); }, 2],
  ['pedir un descuento', async (c) => { c.$('descuento-tipo').value = 'porcentaje'; c.$('descuento-valor').value = '10'; c.$('descuento-motivo').value = 'x'; await c.enviarDescuento(); }],
  ['escribir el folio de un pedido', async (c) => { await c.cargarPedido(17); }],
];

// Una prueba por vía: si una vuelve a quedar sin puerta, falla ella y dice cuál.
for (const [nombre, via, piezas] of VIAS) {
  test(`#933 con un cobro en duda, «${nombre}» no cambia el ticket ni suelta el folio, y dice qué hacer`, async () => {
    const c = montar({ lineas: piezas });
    const antes = c.estado();
    await via(c);
    assert.deepEqual(c.estado(), antes, 'el ticket y el folio no cambian');
    assert.equal(c.estado().idVenta, 'folio-1');
    assert.equal(c.$('aviso').textContent, AVISO_DUDA, 'dice qué hacer');
    assert.deepEqual(c.peticiones, [], 'no sale ninguna petición');
    assert.equal(c.$('dolarones').value, nombre === 'teclear en «Pagar con Dolarones»' ? '10' : '50', 'lo pedido en Dolarones queda como se mandó');
  });

  test(`#933 control: sin cobro en duda, «${nombre}» sí cambia el ticket y suelta el folio (la prueba mueve el código real)`, async () => {
    const c = montar({ enDuda: false, lineas: piezas });
    const antes = c.estado();
    await via(c);
    assert.notEqual(c.estado().idVenta, 'folio-1', 'sin duda suelta el folio');
    assert.notEqual(c.$('aviso').textContent, AVISO_DUDA);
    assert.notDeepEqual(c.estado(), antes);
  });
}

test('#933 mientras se cobra (la petición va en camino) el ticket tampoco cambia: soltar el folio ahí borraría la duda', async () => {
  const c = montar({ enDuda: false, cobrando: true });
  const antes = c.estado();
  await c.$('quitar-promo').disparar('click');
  await c.$('cancelar').disparar('click');
  c.$('dolarones').value = '10';
  await c.$('dolarones').disparar('input');
  assert.deepEqual(c.estado(), antes);
});

test('#933 una respuesta que llega tarde (socio, pedido) no cambia el ticket si mientras tanto un cobro quedó en duda', async () => {
  for (const que of ['socio', 'pedido'] as const) {
    const c = montar({ enDuda: false });
    let soltar: (r: any) => void = () => {};
    c.puesto.responder = () => new Promise((r) => { soltar = r; });
    const busqueda = que === 'socio' ? ((c.$('socio').value = '#8'), c.buscarSocio()) : c.cargarPedido(17);
    c.dudar('folio-2');
    const antes = c.estado();
    soltar({ ok: true, json: async () => (que === 'socio' ? SOCIO_NUEVO : PEDIDO) });
    await busqueda;
    assert.deepEqual(c.estado(), antes, que);
    assert.equal(c.estado().idVenta, 'folio-2', que);
    assert.deepEqual(c.estado().socio, que === 'socio' ? null : antes.socio, que);
    assert.equal(c.estado().pedidoCargado, null, que);
  }
});

/* ---------- lo que invita a cobrar de otra forma ---------- */

test('#933 ningún aviso del cobro en duda invita a cobrar de otra forma ni «de nuevo»; la recarga con duda no sugiere borrar el ticket', () => {
  assert.doesNotMatch(fuente, /cobra sin Dolarones/);
  assert.doesNotMatch(fuente, /antes de cobrar de nuevo/);
  assert.doesNotMatch(fuente, /Sin red: no se pudo cobrar con Dolarones/);
  const arranque = entre('if (ticketRecuperado) {', 'pintar();\nawait pintarRechazadas()');
  const conDuda = arranque.slice(arranque.indexOf("cobroIncierto\n"), arranque.indexOf('    :'));
  assert.match(conDuda, /Se recuperó un cobro que quedó en duda\./);
  assert.doesNotMatch(conDuda, /Cancelar venta|Esc/);
});

test('#933 con un cobro en duda no se pregunta por el socio: el reintento va con lo que ya se mandó', () => {
  assert.match(entre('async function cobrar(', 'let sincronizando = false;'), /if \(!previo && debePreguntarSocio\(socio, navigator\.onLine\)\)/);
});
