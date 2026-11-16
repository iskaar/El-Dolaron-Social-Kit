// node --test src/caja-en-mano.test.ts
// Issue #832: «La tengo en la mano: venderla» en la caja. La regla vive en public/venta.js; el cableado de pantalla se ejecuta aquí con un DOM mínimo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  agregar, leerMultiplicador, avisoExistencia, totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE,
  debePreguntarSocio, descuentoDe, TOPE_DESCUENTO, puedeVenderEnMano, MOTIVOS_EN_MANO, SIN_RED_EN_MANO, moverSugerencia, esBusquedaPorTexto,
} from '../public/venta.js';
import { codigoDeDigitos } from '../public/code128.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const pieza = (codigo: string, stock: number, extra: Record<string, unknown> = {}) =>
  ({ codigo, nombre: `Pieza ${codigo}`, precio: 5000, stock, id: `id-${codigo}`, sin_inventario: 0, ...extra });

test('cuándo se ofrece: pieza con etiqueta y precio, de inventario, no caducada, sin existencia y que aún no está en el ticket', () => {
  assert.equal(puedeVenderEnMano(pieza('ED-000001', 0), 0), true);
  assert.equal(puedeVenderEnMano(pieza('ED-000001', 1), 0), false, 'tiene existencia');
  assert.equal(puedeVenderEnMano(pieza('ED-000001', 0), 1), false, 'ya está en el ticket: no se sube la cantidad escaneando otra vez');
  assert.equal(puedeVenderEnMano(pieza('ED-000001', 0, { sin_inventario: 1 }), 0), false, 'banda');
  assert.equal(puedeVenderEnMano(pieza('ED-000001', 0, { estado_fisico: 'caducado' }), 0), false, 'grado D');
  assert.equal(puedeVenderEnMano(pieza('ED-000001', 0, { precio: 0 }), 0), false, 'sin precio');
  assert.equal(puedeVenderEnMano(pieza('', 0), 0), false, 'sin etiqueta');
  assert.deepEqual(Object.values(MOTIVOS_EN_MANO), ['Tiene otra etiqueta igual', 'Estaba devuelta o apartada', 'No sé']);
  assert.equal(SIN_RED_EN_MANO, 'Sin red: no se puede vender una pieza sin existencia.');
  // Es el caso del último mensaje de avisoExistencia, y solo ese.
  assert.match(avisoExistencia('X', 0, 0, 1), /ya se vendió/);
  assert.match(avisoExistencia('X', 0, 1, 1), /ya está en este ticket/);
});

/* ---------- la pantalla ---------- */

function elemento() {
  const e: any = { hidden: false, hijos: [] as any[], textContent: '', style: {}, oyentes: {} as Record<string, (ev?: any) => void>, enfocado: 0, type: '',
    addEventListener(tipo: string, f: (ev?: any) => void) { e.oyentes[tipo] = f; },
    replaceChildren(...h: any[]) { e.hijos = h; },
    focus() { e.enfocado++; }, click() { e.oyentes.click?.(); } };
  return e;
}
const botones = (e: any) => e.hijos.filter((h: any) => typeof h === 'object');
const textos = (e: any) => botones(e).map((b: any) => b.textContent);

function montar(piezas: any[], { enLinea = true } = {}) {
  const els = new Map<string, any>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, id === 'en-mano' ? Object.assign(elemento(), { hidden: true }) : elemento()); return els.get(id); };
  const catalogo = new Map(piezas.map((p) => [p.codigo, p]));
  const pintados: number[] = [];
  const red = { onLine: enLinea };
  const contexto: Record<string, unknown> = {
    $, catalogo, agregar, leerMultiplicador, codigoDeDigitos, avisoExistencia, puedeVenderEnMano, MOTIVOS_EN_MANO, SIN_RED_EN_MANO, Map, Date, Math,
    precioHoy: (p: any) => p.precio, navigator: red, cargarPedido() {}, buscarSocio() {}, cargarCatalogo: async () => {},
    pintar: () => pintados.push(1), sonar() {}, TONO_RECHAZO: {}, escapar: String, pesos: String, moverSugerencia, esBusquedaPorTexto, TONO_PIEZA: {}, document: { createElement: () => elemento() },
  };
  const rutina = runInNewContext(`let cobrando = false, idVenta = null, lineas = [];
    ${entre('/* ---------- «La tengo en la mano» (#832) ---------- */', '/**\n * La etiqueta impresa codifica')}
    ${entre('function buscarPieza(', '/* ---------- socio y Dolarones')}
    ${entre("$('codigo').addEventListener('keydown'", '// Camara del celular')}
    ({ agregarCodigo, lineas: () => lineas, quitar: (i) => { lineas = lineas.filter((_, j) => j !== i); }, cobrando: (v) => { cobrando = v; } })`, contexto);
  return { ...rutina, $, panel: $('en-mano'), aviso: $('aviso'), codigo: $('codigo'), pintados, catalogo, red };
}

test('sin existencia: junto al aviso aparece el botón (sin tomar el foco) y los motivos solo salen al tocarlo', () => {
  const c = montar([pieza('ED-000001', 0)]);
  assert.equal(c.agregarCodigo('ED-000001'), false);
  assert.match(c.aviso.textContent, /ya se vendió, está apartada o no está en esta tienda/);
  assert.equal(c.panel.hidden, false);
  assert.deepEqual(textos(c.panel), ['La tengo en la mano: venderla']);
  assert.equal(c.codigo.enfocado, 0, 'ofrecerlo no mueve el foco');
  assert.equal(botones(c.panel)[0].enfocado, 0, 'ningún botón recibe foco por programa: el Enter del lector sigue cayendo en #codigo');
  // El ratón no le quita el foco a #codigo.
  let evitado = false;
  c.panel.oyentes.mousedown({ preventDefault() { evitado = true; } });
  assert.equal(evitado, true);
  botones(c.panel)[0].click();
  assert.deepEqual(textos(c.panel), ['Tiene otra etiqueta igual', 'Estaba devuelta o apartada', 'No sé']);
  assert.equal(c.codigo.enfocado, 1, 'tras tocar, el foco vuelve a #codigo');
  assert.equal(c.lineas().length, 0, 'todavía no se agregó nada: faltan el motivo');
});

test('un toque de motivo agrega la línea marcada, con la existencia que vio la caja y cantidad 1; otro escaneo no sube la cantidad ni la vuelve a ofrecer', () => {
  const c = montar([pieza('ED-000001', 0)]);
  c.agregarCodigo('ED-000001');
  botones(c.panel)[0].click();
  botones(c.panel)[1].click();   // «Estaba devuelta o apartada»
  assert.deepEqual(JSON.parse(JSON.stringify(c.lineas().map((l: any) => ({ codigo: l.codigo, cantidad: l.cantidad, precio: l.precio, en_mano: l.en_mano })))),
    [{ codigo: 'ED-000001', cantidad: 1, precio: 5000, en_mano: { motivo: 'devuelta_o_apartada', esperado: 0 } }]);
  assert.equal(c.panel.hidden, true);
  assert.deepEqual(c.panel.hijos, []);
  assert.equal(c.codigo.enfocado, 2);
  assert.match(c.aviso.textContent, /se vende sin existencia en el sistema/);
  assert.ok(c.pintados.length >= 1);
  // Escanearla otra vez (o con «3*»): «ya está en este ticket», sin botón y sin subir la cantidad.
  for (const leido of ['ED-000001', '3*ED-000001']) {
    assert.equal(c.agregarCodigo(leido), false);
    assert.equal(c.aviso.textContent, 'Pieza ED-000001 ya está en este ticket.');
    assert.equal(c.panel.hidden, true);
    assert.equal(c.lineas()[0].cantidad, 1);
  }
  // Quitar el renglón se lleva la marca: es del renglón.
  c.quitar(0);
  assert.deepEqual(c.lineas(), []);
});

test('el siguiente escaneo (de lo que sea) quita el botón y los motivos', () => {
  const c = montar([pieza('ED-000001', 0), pieza('ED-000002', 3)]);
  c.agregarCodigo('ED-000001');
  assert.equal(c.panel.hidden, false);
  assert.equal(c.agregarCodigo('ED-000002'), true);
  assert.equal(c.panel.hidden, true);
  assert.deepEqual(c.panel.hijos, []);
  c.agregarCodigo('ED-000001');
  botones(c.panel)[0].click();   // ya muestra los motivos
  assert.equal(botones(c.panel).length, 3);
  assert.equal(c.agregarCodigo('ED-999999'), false, 'código que no existe');
  assert.equal(c.panel.hidden, true);
  assert.deepEqual(c.panel.hijos, []);
});

test('no se ofrece cuando no corresponde: con existencia parcial, ya en el ticket, grado D, banda, sin precio, o sin red (ahí solo el aviso)', () => {
  const casos: [string, any, string?][] = [
    ['grado D', pieza('ED-000003', 0, { estado_fisico: 'caducado' })],
    ['banda', pieza('JU49', 0, { sin_inventario: 1 })],
    ['sin precio', pieza('ED-000004', 0, { precio: 0 })],
  ];
  for (const [que, p] of casos) {
    const c = montar([p]);
    c.agregarCodigo(p.codigo);
    assert.equal(c.panel.hidden, true, que);
    assert.equal(botones(c.panel).length, 0, que);
  }
  const parcial = montar([pieza('ED-000005', 1)]);
  assert.equal(parcial.agregarCodigo('2*ED-000005'), false);
  assert.match(parcial.aviso.textContent, /solo hay 1/);
  assert.equal(botones(parcial.panel).length, 0, 'ahí no falta una pieza: hay menos de las que se piden');
  const sinRed = montar([pieza('ED-000001', 0)], { enLinea: false });
  sinRed.agregarCodigo('ED-000001');
  assert.deepEqual(sinRed.panel.hijos, [SIN_RED_EN_MANO], 'sin red: el texto, ningún botón');
});

test('con los motivos a la vista: si se cae la red o el cobro empieza, el toque no agrega nada; si el catálogo ya trae existencia, pide escanear otra vez', () => {
  const c = montar([pieza('ED-000001', 0)]);
  c.agregarCodigo('ED-000001');
  botones(c.panel)[0].click();
  c.red.onLine = false;
  botones(c.panel)[2].click();
  assert.equal(c.lineas().length, 0);
  assert.equal(c.aviso.textContent, SIN_RED_EN_MANO);
  c.red.onLine = true;
  c.agregarCodigo('ED-000001');
  botones(c.panel)[0].click();
  botones(c.panel)[2].click();   // «No sé» con red: entra
  assert.equal(c.lineas().length, 1);
  assert.equal(c.lineas()[0].en_mano.motivo, 'no_se');

  // Se refrescó el catálogo y ya hay existencia: no se marca nada, se pide escanear otra vez.
  const refrescada = montar([pieza('ED-000001', 0)]);
  refrescada.agregarCodigo('ED-000001');
  botones(refrescada.panel)[0].click();
  refrescada.catalogo.set('ED-000001', pieza('ED-000001', 2));
  botones(refrescada.panel)[0].click();
  assert.equal(refrescada.lineas().length, 0);
  assert.match(refrescada.aviso.textContent, /La existencia cambió: escanea la pieza otra vez\./);

  // Cobrando: el toque no hace nada.
  const cobrando = montar([pieza('ED-000001', 0)]);
  cobrando.agregarCodigo('ED-000001');
  botones(cobrando.panel)[0].click();
  cobrando.cobrando(true);
  botones(cobrando.panel)[0].click();
  assert.equal(cobrando.lineas().length, 0);
});

test('el renglón del ticket lleva la insignia, y pintar() quita la oferta al empezar a cobrar', () => {
  const pintar = entre('function pintar() {', '// «Usar todos» elegido');
  assert.match(pintar, /l\.en_mano \? ' · <b class="en-mano">Sin existencia en el sistema<\/b>' : ''/);
  assert.match(pintar, /if \(cobrando\) ocultarEnMano\(\);/);
  assert.match(fuente, /<div id="en-mano" hidden><\/div>/);
  // Está en el panel del escaneo, entre el aviso y las sugerencias.
  assert.ok(fuente.indexOf('id="aviso"') < fuente.indexOf('id="en-mano"') && fuente.indexOf('id="en-mano"') < fuente.indexOf('id="sugerencias"'));
});

/* ---------- cobrar ---------- */

function montarCobro({ enLinea = true, marcada = true, respuesta = async (_r: string, _o: any) => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null }) }) as any } = {}) {
  const els = new Map<string, any>();
  const $ = (id: string) => {
    if (!els.has(id)) els.set(id, { value: id === 'forma' ? 'tarjeta' : '', textContent: '', style: {}, disabled: false, enfocado: false, focus() { this.enfocado = true; } });
    return els.get(id);
  };
  const enviadas: any[] = [];
  const guardadas: any[] = [];
  const contexto: Record<string, unknown> = {
    crypto, Date, $, AbortSignal, Object, Math, totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE,
    debePreguntarSocio, navigator: { onLine: enLinea }, window: { open() {} }, document: { createElement: () => ({ style: {}, textContent: '' }) },
    lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Lámpara', precio: 30000, cantidad: 1, ...(marcada ? { en_mano: { motivo: 'no_se', esperado: 0 } } : {}) }],
    errorImpresora: () => 'x', socio: null, valesCargados: [], catalogo: new Map(), pedidoCargado: null, SIN_RED_EN_MANO,
    preguntarSocio: async () => 'cobrar', preguntarForma: async () => 'tarjeta', impresionRemota: () => false, exigirCaja: () => true, cajaActual: () => 'Caja 1',
    dolaronesPedidos: () => 0, descuento: null, descuentoAplicado: () => 0, descuentoDe, TOPE_DESCUENTO, promoActual: () => 0, totalNeto: () => 30000, pintarDescuento() {},
    pesos: String, dolares: String, quitarSocio() {}, sincronizar() {}, cargarCatalogo() {}, pintarImpresora() {}, promoConfig: null,
    abrirCajon: async () => true, imprimirTicket: async () => true,
    store: async (almacen: string, _m: string, fn: any) => fn({ put(v: unknown) { if (almacen === 'ventas') guardadas.push(v); } }),
    fetch: async (ruta: string, o: any) => { enviadas.push(JSON.parse(o.body)); return respuesta(ruta, o); },
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const falla = entre('function textoFalla(', '/**\n * Escribir o escanear P-17');
  const conPedido = entre('async function cobrarConPedido(', '/* ---------- cobro: primero');
  const errorClave = entre('function errorClave(', "for (const id of ['clave-rastreo'");
  const cobro = entre('async function cobrar()', 'let sincronizando = false;');
  const cobrar = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, formaElegida = false;
    function pintar() {}
    ${avisoRojo}\n${falla}\n${conPedido}\n${errorClave}\n${cobro}; cobrar`, contexto);
  return { cobrar, $, enviadas, guardadas };
}

test('cobrar: la marca viaja en la línea del pedido al servidor (con su motivo y la existencia que vio la caja) y solo en esa línea', async () => {
  const c = montarCobro();
  await c.cobrar();
  assert.equal(c.enviadas.length, 1);
  assert.deepEqual(c.enviadas[0].lineas, [{ codigo: 'ED-000001', nombre: 'Lámpara', precio: 30000, cantidad: 1, producto_id: 'p1', en_mano: { motivo: 'no_se', esperado: 0 } }]);
  const normal = montarCobro({ marcada: false });
  await normal.cobrar();
  assert.deepEqual(Object.keys(normal.enviadas[0].lineas[0]), ['codigo', 'nombre', 'precio', 'cantidad', 'producto_id'], 'sin marca el cuerpo no cambia');
});

test('cobrar sin red con una pieza marcada: no se envía ni se encola, lo dice y el foco sigue en #codigo; sin marca se encola como siempre', async () => {
  const c = montarCobro({ enLinea: false });
  await c.cobrar();
  assert.equal(c.enviadas.length, 0);
  assert.equal(c.guardadas.length, 0, 'no se encola una venta con una pieza sin existencia');
  assert.equal(c.$('aviso').textContent, SIN_RED_EN_MANO);
  assert.equal(c.$('codigo').enfocado, true);
  const normal = montarCobro({ enLinea: false, marcada: false, respuesta: async () => { throw new Error('sin red'); } });
  await normal.cobrar();
  assert.equal(normal.guardadas.length, 1, 'el resto de las ventas sin red sigue en cola');
});

test('cobrar: si no se sabe cómo salió el cobro (timeout, error de red con la red arriba o 5xx), la venta marcada NO se encola: el ticket sigue abierto con el mismo folio', async () => {
  const fallas: [string, () => Promise<any>][] = [
    ['timeout', async () => { throw new DOMException('timeout', 'TimeoutError'); }],
    ['error de red', async () => { throw new TypeError('Failed to fetch'); }],
    ['5xx', async () => ({ ok: false, status: 503, json: async () => ({}) })],
  ];
  for (const [que, falla] of fallas) {
    let llamada = 0;
    const c = montarCobro({ respuesta: async () => (llamada++ === 0 ? falla() : { ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null }) }) as any });
    await c.cobrar();
    assert.equal(c.guardadas.length, 0, `${que}: nada en IndexedDB`);
    assert.match(c.$('aviso').textContent, /toca el mismo botón de cobro otra vez/, que);
    assert.equal(c.$('aviso').style.color, '#D72B32', que);
    assert.equal(c.$('codigo').enfocado, true, que);
    await c.cobrar();   // el mismo botón
    assert.equal(c.enviadas.length, 2, que);
    assert.equal(c.enviadas[1].id, c.enviadas[0].id, `${que}: el mismo folio en el reintento`);
    assert.deepEqual(c.enviadas[1].lineas, c.enviadas[0].lineas, que);
    assert.match(c.$('aviso').textContent, /^Cobrado/, que);
    assert.equal(c.guardadas.length, 0, que);
  }
  // Sin la marca, la misma falla sigue encolando la venta para reintentarla sola (nada cambia).
  const normal = montarCobro({ marcada: false, respuesta: async () => { throw new Error('sin red'); } });
  await normal.cobrar();
  assert.equal(normal.guardadas.length, 1);
});

test('lector: caracteres + Enter nunca activan «venderla» ni un motivo; lo que hacen es escanear (y quitar la oferta)', () => {
  const c = montar([pieza('ED-000001', 0), pieza('ED-000002', 4)]);
  const codigo = c.codigo;
  const enter = () => codigo.oyentes.keydown({ key: 'Enter', target: codigo, preventDefault() {} });
  const escanear = (texto: string) => {
    codigo.value = texto;                       // el lector teclea en el campo que tiene el foco: #codigo
    codigo.oyentes.input?.({});
    enter();
  };
  escanear('ED-000001');
  const [venderla] = botones(c.panel);
  assert.deepEqual(Object.keys(venderla.oyentes), ['click'], 'el botón solo responde a un clic: ni keydown, ni keypress ni keyup');
  assert.equal(venderla.enfocado, 0);
  assert.equal(codigo.value, '', 'el Enter del lector limpia #codigo, que conserva el foco');
  // Un escaneo perdido o repetido (otro Enter, con o sin texto) no toca el botón.
  enter();
  escanear('ED-000001');
  assert.equal(c.lineas().length, 0);
  assert.equal(textos(c.panel).length, 1, 'la oferta sigue siendo solo el botón, sin motivos');
  // Con los motivos a la vista, lo que se escanea los quita y no elige ninguno.
  venderla.click();
  assert.equal(botones(c.panel).length, 3);
  for (const b of botones(c.panel)) assert.deepEqual(Object.keys(b.oyentes), ['click']);
  escanear('ED-000002');
  assert.equal(c.panel.hidden, true);
  assert.deepEqual(JSON.parse(JSON.stringify(c.lineas().map((l: any) => [l.codigo, l.en_mano ?? null]))), [['ED-000002', null]]);
  // Y un Enter a secas con el campo vacío no hace nada.
  codigo.value = '';
  enter();
  assert.equal(c.lineas().length, 1);
});
