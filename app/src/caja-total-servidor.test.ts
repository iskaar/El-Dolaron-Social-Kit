// node --test src/caja-total-servidor.test.ts
// Issue #943: la caja usa el total que registró el servidor y avisa si no es el que tenía en pantalla. Corre el cobrar() REAL de
// public/caja.html (las tres rutas: normal, con Dolarones y con pedido) y el sincronizar() REAL contra una pantalla mínima.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE, debePreguntarSocio,
  descuentoDe, TOPE_DESCUENTO } from '../public/venta.js';
import { PUERTA } from './prueba-caja.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

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

type Ruta = 'normal' | 'dolarones' | 'pedido';
interface Opciones {
  ruta?: Ruta;
  forma?: string;
  respuesta?: Record<string, unknown>;       // lo que contesta /api/ventas (201)
  status?: number;
  fetch?: (ruta: string, o: any) => Promise<unknown>;
  contexto?: Record<string, unknown>;
}
const SOCIO = { id: 's1', numero: 7, disponible: 5000, regalo_disponible: 0, maximo: 99999, expira_en: '2099-01-01T00:00:00Z', vale: false };
const PRECIO = 30000;

/** El cobro real con una pieza; `ruta` decide por dónde va: sin nada (normal), con socio y Dolarones, o con un pedido cargado. */
function montar(op: Opciones = {}) {
  const ruta = op.ruta ?? 'normal';
  const elementos = new Map<string, any>();
  const impresos: any[] = [];
  const guardadas: any[] = [];
  const cuerpos: string[] = [];
  const $ = (id: string) => {
    if (!elementos.has(id)) {
      elementos.set(id, id === 'aviso' ? avisoFalso() : { value: id === 'efectivo' ? '300' : '', textContent: '', style: {}, focus() {} });
    }
    return elementos.get(id);
  };
  const contexto: Record<string, unknown> = {
    crypto, Date, $, AbortSignal, Object, Math, Number, JSON, totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido,
    transferenciaDe, CLAVE_DESDE, debePreguntarSocio, descuentoDe, TOPE_DESCUENTO, ...PUERTA, navigator: { onLine: true },
    document: { createElement: () => ({ style: {}, textContent: '' }) },
    lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: PRECIO, cantidad: 1 }],
    errorImpresora: () => '', socio: ruta === 'dolarones' ? { ...SOCIO } : null, codigoSocio: ruta === 'dolarones' ? 'DC-x' : '', valesCargados: [],
    catalogo: new Map(), pedidoCargado: ruta === 'pedido' ? { id: 'ped-1', folio: 17, saldo: 10000 } : null,
    preguntarSocio: async () => 'cobrar', abrirAlta() {}, promoAgotada() {},
    impresionRemota: () => false, exigirCaja: () => true, cajaActual: () => 'Caja 1', dolaronesPedidos: () => (ruta === 'dolarones' ? 1000 : 0),
    descuento: null, descuentoAplicado: () => 0, revisarVencimientoDescuento: () => false, promoActual: () => 0, totalNeto: () => PRECIO, pintarDescuento() {},
    pesos: (c: number) => `$${c / 100}`, dolares: String, avisoReferido: String, quitarSocio() {}, sincronizar() {}, refrescarMeta() {}, cargarCatalogo() {}, pintarImpresora() {}, promoConfig: null,
    abrirCajon: async () => true, imprimirTicket: async (venta: unknown) => { impresos.push(venta); return true; },
    store: async (almacen: string, _m: string, fn: any) => fn({ put(v: unknown) { if (almacen === 'ventas') guardadas.push(v); } }),
    fetch: async (r: string, o: any) => {
      cuerpos.push(o.body);
      if (op.fetch) return op.fetch(r, o);
      const status = op.status ?? 201;
      return { ok: status < 400, status, json: async () => ({ id: JSON.parse(o.body).id, ganados: 0, vale_emitido: null, saldo_pedido: null, ...op.respuesta }) };
    },
    ...op.contexto,
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const cobrar = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, folioIncierto = null, cobroIncierto = null;
    function pintar() {}
    ${entre('async function cobrarConDolarones(', '/* ---------- pedidos por WhatsApp')}
    ${avisoRojo}\n${entre('function textoFalla(', '/**\n * Escribir o escanear P-17')}
    ${entre('async function cobrarConPedido(', '/* ---------- cobro: primero')}
    ${entre('function errorClave(', "for (const id of ['clave-rastreo'")}
    ${entre('async function cobrar(', 'let sincronizando = false;')}; cobrar`, contexto);
  return { cobrar: () => cobrar(op.forma ?? 'tarjeta') as Promise<unknown>, $, impresos, guardadas, cuerpos, contexto };
}
const rojos = (c: ReturnType<typeof montar>) => c.$('aviso').hijos.map((h: any) => h.textContent as string);

const RUTAS: Ruta[] = ['normal', 'dolarones', 'pedido'];

test('#943 si el servidor registró otro total, el ticket se imprime con el del servidor y la caja lo avisa en rojo con qué hacer (las tres rutas)', async () => {
  for (const ruta of RUTAS) {
    const c = montar({ ruta, respuesta: { total: 35000, descuento: 0, cambio: 0 } });
    await c.cobrar(); await tick();
    assert.match(c.$('aviso').textContent, /^Cobrado\./, ruta);            // la venta ya quedó: no se frena ni se reintenta
    assert.equal(c.cuerpos.length, 1, ruta);
    assert.equal(c.impresos.length, 1, ruta);
    assert.equal(c.impresos[0].total, 35000, `${ruta}: el ticket lleva el total registrado`);
    const aviso = rojos(c).find((t: string) => t.includes('El sistema registró'));
    assert.ok(aviso, `${ruta}: falta el aviso; salió ${JSON.stringify(rojos(c))}`);
    assert.match(aviso, /\$350/, ruta);
    assert.match(aviso, /\$300/, ruta);
    assert.match(aviso, /No vuelvas a cobrar.*gerencia/, ruta);
    assert.equal(c.$('aviso').hijos.find((h: any) => h.textContent === aviso).style.cssText.includes('#D72B32'), true, ruta);
  }
});

test('#943 con efectivo, el cambio que se anuncia y se imprime es el que registró el servidor', async () => {
  const c = montar({ forma: 'efectivo', respuesta: { total: 28000, descuento: 2000, cambio: 2000 } });
  await c.cobrar(); await tick();
  assert.match(c.$('aviso').textContent, /^Cobrado\. Cambio \$20/);
  assert.deepEqual([c.impresos[0].total, c.impresos[0].descuento, c.impresos[0].cambio], [28000, 2000, 2000]);
  assert.match(rojos(c).join('|'), /El sistema registró \$280, no \$300.*cambio.*gerencia/);
});

test('#943 la respuesta de un reintento (`duplicada`) también trae el total y se trata igual', async () => {
  const c = montar({ status: 200, respuesta: { duplicada: true, total: 35000, descuento: 0, cambio: 0 } });
  await c.cobrar(); await tick();
  assert.equal(c.impresos[0].total, 35000);
  assert.match(rojos(c).join('|'), /El sistema registró \$350, no \$300/);
});

test('#943 con el mismo total (o un servidor que no lo manda) nada cambia: sin aviso y el ticket con lo de la caja', async () => {
  for (const ruta of RUTAS) {
    for (const respuesta of [{ total: PRECIO, descuento: 0, cambio: 0 }, {}]) {
      const c = montar({ ruta, respuesta });
      await c.cobrar(); await tick();
      assert.match(c.$('aviso').textContent, /^Cobrado\./, ruta);
      assert.deepEqual(rojos(c), [], ruta);
      assert.deepEqual([c.impresos[0].total, c.impresos[0].descuento, c.impresos[0].cambio], [PRECIO, 0, 0], ruta);
    }
  }
});

test('#943 una sola función aplica la respuesta: las tres rutas dejan en la venta lo mismo que contestó el servidor', async () => {
  const respuesta = { vale_emitido: { importe: 500 }, vale_usado: null, vales_usados: [], saldo_pedido: 2500, excedente_transferencia: 0, referido_liberado: 300,
    ganados: 1000, bono_promo: 200, saldo: { disponible: 4321 } };
  for (const ruta of RUTAS) {
    // Con socio en los tres caminos (en el normal y el de pedido, sin canjear Dolarones): su premio, su bono y su saldo salen de la respuesta.
    const c = montar({ ruta, respuesta, contexto: { socio: { ...SOCIO }, codigoSocio: 'DC-x' } });
    await c.cobrar(); await tick();
    const v = c.impresos[0];
    assert.deepEqual([v.vale_emitido, v.vale_usado, v.vales_usados, v.saldo_pedido, v.excedente_transferencia, v.referido_liberado],
      [{ importe: 500 }, null, [], 2500, 0, 300], ruta);
    assert.deepEqual({ ...v.socio }, { numero: 7, ganados: 1000, bono_promo: 200, saldo: 4321 }, ruta);
    assert.match(c.$('aviso').textContent, /Ganó 1000 · Bono noviembre: \+200 · 300/, ruta);
  }
  // Sin `ganados` ni `saldo` en la respuesta y sin Dolarones canjeados, el ticket del socio se queda con lo que había: 0 ganados y su saldo.
  const pedido = montar({ ruta: 'pedido', contexto: { socio: { ...SOCIO } }, fetch: async (_r, o) => ({ ok: true, status: 200, json: async () => ({ id: JSON.parse(o.body).id, duplicada: true }) }) });
  await pedido.cobrar(); await tick();
  assert.deepEqual({ ...pedido.impresos[0].socio }, { numero: 7, ganados: 0, bono_promo: 0, saldo: 5000 });
  // La copia vive en un solo lugar del archivo.
  assert.equal(fuente.split('venta.vale_emitido = cuerpo.vale_emitido').length - 1, 1);
  assert.equal(fuente.split('venta.referido_liberado = ').length - 1, 1);
});

test('#943 Dolarones sin `saldo` ni `ganados` en la respuesta (reintento contra un servidor anterior): el ticket sigue con lo calculado aquí', async () => {
  const c = montar({ ruta: 'dolarones', status: 200, fetch: async (_r, o) => ({ ok: true, status: 200, json: async () => ({ id: JSON.parse(o.body).id, duplicada: true }) }) });
  await c.cobrar(); await tick();
  assert.deepEqual({ ...c.impresos[0].socio }, { numero: 7, ganados: dolaronesGanados(PRECIO - 1000), bono_promo: 0, saldo: 5000 - 1000 });
});

test('#943 el cuerpo de una venta normal sale byte a byte como antes (el pedidoHash y los reintentos no cambian)', async () => {
  const c = montar({ forma: 'efectivo' });
  await c.cobrar();
  const { id, creado_en } = JSON.parse(c.cuerpos[0]);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(c.cuerpos[0], '{"id":"' + id + '","lineas":[{"codigo":"ED-000001","nombre":"Ventilador","precio":30000,"cantidad":1,"producto_id":"p1"}],'
    + '"forma_pago":"efectivo","efectivo":30000,"creado_en":"' + creado_en + '","cliente_id":null,"dolarones":0,"caja":"Caja 1","descuento_id":null,"promo":0}');
  const d = montar({ ruta: 'dolarones' });
  await d.cobrar();
  const v = JSON.parse(d.cuerpos[0]);
  assert.equal(d.cuerpos[0], '{"id":"' + v.id + '","lineas":[{"codigo":"ED-000001","nombre":"Ventilador","precio":30000,"cantidad":1,"producto_id":"p1"}],'
    + '"forma_pago":"tarjeta","efectivo":0,"creado_en":"' + v.creado_en + '","cliente_id":"s1","dolarones":1000,"caja":"Caja 1","descuento_id":null,"promo":0,"codigo_socio":"DC-x"}');
  const p = montar({ ruta: 'pedido' });
  await p.cobrar();
  const w = JSON.parse(p.cuerpos[0]);
  assert.equal(p.cuerpos[0], '{"id":"' + w.id + '","lineas":[{"codigo":"ED-000001","nombre":"Ventilador","precio":30000,"cantidad":1,"producto_id":"p1"}],'
    + '"forma_pago":"tarjeta","efectivo":0,"creado_en":"' + w.creado_en + '","cliente_id":null,"dolarones":0,"caja":"Caja 1","descuento_id":null,"promo":0,"pedido_id":"ped-1","anticipo":10000}');
});

test('#943 el total se vuelve a calcular después de «¿El cliente es socio?»: si cambió con la ventana abierta, no se manda nada y se dice', async () => {
  // El descuento vence mientras la ventana está abierta.
  let vencido = false;
  const descuento = montar({ contexto: {
    descuento: { id: 'd1', estado: 'aprobada', monto: 5000, tipo: 'monto', valor: 5000 },
    descuentoAplicado: () => (vencido ? 0 : 5000), revisarVencimientoDescuento: () => false,
    preguntarSocio: async () => { vencido = true; return 'cobrar'; },
  } });
  await descuento.cobrar();
  assert.equal(descuento.cuerpos.length, 0, 'no se registra con un total que ya no es el que se validó');
  assert.match(descuento.$('aviso').textContent, /El total cambió mientras la ventana estaba abierta: ahora son \$300\..*gerencia/);
  assert.equal(descuento.$('aviso').style.color, '#D72B32');
  assert.equal(descuento.impresos.length, 0);

  // La promo se acaba mientras la ventana está abierta.
  let sinPromo = false;
  const promo = montar({ contexto: { promoActual: () => (sinPromo ? 0 : 3000), preguntarSocio: async () => { sinPromo = true; return 'cobrar'; } } });
  await promo.cobrar();
  assert.equal(promo.cuerpos.length, 0);
  assert.match(promo.$('aviso').textContent, /El total cambió mientras la ventana estaba abierta/);

  // Sin cambios, la ventana no estorba.
  const igual = montar({ contexto: { promoActual: () => 3000 } });
  await igual.cobrar();
  assert.equal(igual.cuerpos.length, 1);
  assert.equal(JSON.parse(igual.cuerpos[0]).promo, 3000);
  assert.match(igual.$('aviso').textContent, /^Cobrado\./);
});

/* ---------- ventas encoladas sin red ---------- */

test('#943 una venta encolada guarda el total de la caja; al sincronizar, si el servidor registró otro, se avisa en rojo', async () => {
  // Sin respuesta: la venta se encola con lo que la caja cobró.
  const c = montar({ forma: 'efectivo', fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await c.cobrar();
  assert.equal(c.guardadas.length, 1);
  assert.equal(c.guardadas[0].total_caja, PRECIO);
  assert.equal(JSON.parse(c.cuerpos[0]).total_caja, undefined, 'el primer intento no cambia');

  const sincronizar = (cola: any[], cuerpo: (v: any) => Record<string, unknown>) => {
    const aviso = avisoFalso();
    aviso.textContent = 'Cobrado. Cambio $20';   // lo que había en pantalla no se pierde
    const borradas: string[] = [];
    const correr = runInNewContext(`let sincronizando = false; ${entre('const avisoOtroTotal =', '\n')}
      ${entre('function pintarFalla(', '/**\n * Escribir o escanear P-17')}
      ${entre('async function sincronizar() {', '/**\n * #819: una venta rechazada')}; sincronizar`, {
      $: () => aviso, document: { createElement: () => ({ style: {}, textContent: '' }) }, AbortSignal, Object, Number, JSON, pesos: (x: number) => `$${x / 100}`, dolares: String, avisoReferido: String, console,
      store: async (almacen: string, _m: string, fn: any) => fn({ getAll: () => (almacen === 'ventas' ? cola : []), delete(id: string) { borradas.push(id); }, put() {} }),
      fetch: async (_r: string, o: any) => ({ status: 200, json: async () => cuerpo(JSON.parse(o.body)) }),
      pendientes: async () => {}, reportarRechazadas: async () => {}, pintarRechazadas: async () => {}, actualizarCorte: async () => {},
    });
    return correr().then(() => ({ aviso, borradas }));
  };
  const venta = { ...c.guardadas[0], vale_pendiente: false };   // sin vale por revisar, la sincronización no escribe otro aviso
  const distinta = await sincronizar([venta], (v) => ({ id: v.id, duplicada: true, total: 35000, ganados: 0, vale_emitido: null }));
  assert.deepEqual(distinta.borradas, [venta.id], 'la venta sí quedó registrada: sale de la cola');
  assert.match(distinta.aviso.textContent, /^Cobrado\. Cambio \$20Venta .* sincronizada.*El sistema registró \$350, no \$300.*gerencia/);
  assert.equal(distinta.aviso.hijos[0].style.cssText.includes('#D72B32'), true);
  // Mismo total, servidor sin `total` o venta encolada por una caja anterior (sin total_caja): nada nuevo.
  for (const [v, cuerpo] of [[venta, { total: PRECIO }], [venta, {}], [{ ...venta, total_caja: undefined }, { total: 35000 }]] as const) {
    const r = await sincronizar([v], (x) => ({ id: x.id, ganados: 0, vale_emitido: null, ...cuerpo }));
    assert.doesNotMatch(r.aviso.textContent, /El sistema registró/);
    assert.deepEqual(r.borradas, [venta.id]);
  }
});

/* ---------- servidor ---------- */

test('#943 servidor: la respuesta `duplicada` trae el total, el descuento y el cambio registrados, iguales a los del 201', async () => {
  const t = tienda();
  try {
    const venta = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 30000, caja: 'Caja 1' };
    const primera = await t.pedir('/api/ventas', venta);
    assert.equal(primera.status, 201, JSON.stringify(primera.cuerpo));
    const otra = await t.pedir('/api/ventas', venta);
    assert.equal(otra.status, 200);
    assert.equal(otra.cuerpo.duplicada, true);
    assert.equal(Number.isInteger(primera.cuerpo.total), true);
    assert.deepEqual([otra.cuerpo.total, otra.cuerpo.descuento, otra.cuerpo.cambio], [primera.cuerpo.total, primera.cuerpo.descuento, primera.cuerpo.cambio]);
    assert.equal(otra.cuerpo.cambio, 30000 - primera.cuerpo.total);
  } finally { t.db.close(); }
});
