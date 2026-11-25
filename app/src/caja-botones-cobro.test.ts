// node --test src/caja-botones-cobro.test.ts
// Issue #830: tres botones de cobro (efectivo, tarjeta, transferencia), sin forma por omisión. Reemplaza la ventana «¿Efectivo o tarjeta?» (#260, 17/10).
// Corre el pintar(), el cobrar(), el guardado del ticket y el cableado REALES de public/caja.html contra una pantalla mínima
// (un solo foco, Enter del lector, clic de ratón) sin navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE, debePreguntarSocio,
  descuentoDe, TOPE_DESCUENTO, huellaTicket, TICKET_VIGENTE_MS, maximoCanje, montosRapidos, montoTransferidoRazonable, MINIMO_REGALO, SIN_RED_EN_MANO, ordenEnPantalla,
} from '../public/venta.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};

const FORMA: Record<string, string> = {
  'cobrar-efectivo': 'efectivo', 'cobrar-tarjeta': 'tarjeta', 'cobrar-transferencia': 'transferencia', 'cobrar-sin-dinero': 'sin-dinero',
};
const BOTONES = Object.keys(FORMA);
const DE_DINERO = ['cobrar-efectivo', 'cobrar-tarjeta', 'cobrar-transferencia'];
const CAMPOS = new Set(['codigo', 'efectivo', 'socio', 'clave-rastreo', 'monto-transferido']);
const ESCANEO = '7501234567890';

/* ---------- pantalla mínima: un solo foco, como el navegador ---------- */

class Pantalla {
  activo = 'body';
  elementos = new Map<string, Elemento>();
  el(id: string): Elemento {
    if (!this.elementos.has(id)) this.elementos.set(id, new Elemento(id, this));
    return this.elementos.get(id)!;
  }
}
class Elemento {
  id: string;
  p: Pantalla;
  value = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  oyentes: Record<string, ((e: any) => unknown)[]> = {};
  #disabled = false;
  constructor(id: string, p: Pantalla) { this.id = id; this.p = p; }
  get disabled() { return this.#disabled; }
  // Un elemento que se deshabilita con el foco lo pierde, igual que en el navegador.
  set disabled(v: boolean) { this.#disabled = v; if (v && this.p.activo === this.id) this.p.activo = 'body'; }
  focus() { if (!this.#disabled) this.p.activo = this.id; }
  addEventListener(tipo: string, f: (e: any) => unknown) { (this.oyentes[tipo] ??= []).push(f); }
  async disparar(tipo: string, evento: any = {}) {
    evento.target ??= this;
    for (const f of this.oyentes[tipo] ?? []) await f(evento);
  }
}

interface Opciones {
  efectivo?: string;
  precio?: number;
  remota?: boolean;
  descuento?: unknown;
  respuestaSocio?: string;
  sinCaja?: boolean;
  pedido?: { id: string; folio: number; saldo: number };
  valores?: Record<string, string>;
  datosVisibles?: boolean;                      // el bloque de la transferencia ya está a la vista
  dolarones?: number;                           // Dolarones del ticket (con socio y código de prueba)
  fetch?: (n: number) => Promise<unknown>;      // n = número de petición, desde 1
  almacen?: Record<string, string>;             // localStorage compartido entre «cargas» de la caja
  recargar?: boolean;                           // arranca como una caja recién abierta: el ticket sale del almacén
  enMano?: boolean;                             // #832: el renglón lleva «La tengo en la mano»
  enLinea?: boolean;                            // navigator.onLine (por omisión, sí)
  lineas?: any[];                               // #931: el ticket de la prueba, en el orden de captura
}

const respuestaOk = async () => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null, saldo_pedido: 0 }) });
const sinRed = async () => { throw new Error('sin red'); };
const rechazo = (error: string, status = 409) => async () => ({ ok: false, status, json: async () => ({ error }) });

function armar(op: Opciones = {}) {
  const p = new Pantalla();
  const enviadas: any[] = [];
  const guardadas: unknown[] = [];
  const cajones: number[] = [];
  const impresos: any[][] = [];                // lo que se manda a imprimir: (venta, lineas)
  const almacen = op.almacen ?? {};
  const $ = (id: string) => p.el(id);
  $('efectivo').value = op.efectivo ?? '300';
  $('imprimir-en').value = 'Caja 2';
  $('datos-transferencia').hidden = !op.datosVisibles;
  $('cobrar-sin-dinero').hidden = true;
  for (const [id, valor] of Object.entries(op.valores ?? {})) $(id).value = valor;
  for (const id of BOTONES) $(id).dataset.forma = FORMA[id];
  const socio = op.dolarones
    ? { id: 's1', numero: 7, disponible: 500000, regalo_disponible: 0, maximo: 500000, expira_en: '2099-01-01T00:00:00Z', vale: false } : null;
  let n = 0;
  const contexto: Record<string, any> = {
    crypto, Date, JSON, ordenEnPantalla, $, AbortSignal, Object, Math, Number, String, vistos: [] as unknown[], totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados,
    anticipoDePedido, transferenciaDe, CLAVE_DESDE, debePreguntarSocio, descuentoDe, TOPE_DESCUENTO, maximoCanje, montosRapidos, montoTransferidoRazonable,
    MINIMO_REGALO, navigator: { onLine: op.enLinea ?? true }, window: { open() {} }, ocultarEnMano() {}, SIN_RED_EN_MANO,
    localStorage: { getItem: (k: string) => almacen[k] ?? null, setItem: (k: string, v: string) => { almacen[k] = v; } },
    document: { querySelectorAll: (s: string) => (s === '#botones-cobro button' ? BOTONES.map($) : []), createElement: () => ({ style: {}, textContent: '' }) },
    lineas: op.recargar ? [] : op.lineas ?? [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: op.precio ?? 30000, cantidad: 1, ...(op.enMano ? { en_mano: { motivo: 'no_se', esperado: 0 } } : {}) }],
    errorImpresora: () => 'no conectada', socio, valesCargados: [], catalogo: new Map(), pedidoCargado: op.recargar ? null : op.pedido ?? null,
    descuento: op.descuento ? { huella: huellaTicket([{ producto_id: 'p1', cantidad: 1 }], op.precio ?? 30000), ...op.descuento } : null,
    huellaTicket, TICKET_VIGENTE_MS, quitarDescuentoEnServidor() {}, descuentoCerrado: () => false, revisarVencimientoDescuento: () => false,
    preguntarSocio: async () => op.respuestaSocio ?? 'cobrar', abrirAlta() {},
    impresionRemota: () => !!op.remota, cajaActual: () => (op.sinCaja ? '' : 'Caja 1'), dolaronesPedidos: () => op.dolarones ?? 0,
    descuentoAplicado: () => 0, promoActual: () => 0, totalNeto: () => op.precio ?? 30000, pintarDescuento() {}, promoAgotada() {},
    pintarPromoCupo() {}, revisarCancelarArmado() {}, pintarImpresionRemota() {}, escapar: String, pesos: String, dolares: String,
    quitarSocio() {}, sincronizar() {}, cargarCatalogo() {}, pintarImpresora() {}, promoConfig: null,
    abrirCajon: async () => { cajones.push(1); return true; }, imprimirTicket: async (...args: any[]) => { impresos.push(args); return true; },
    store: async (almacenIdb: string, _m: string, fn: any) => fn({ put(v: unknown) { if (almacenIdb === 'ventas') guardadas.push(v); } }),
    fetch: async (_ruta: string, o: any) => { enviadas.push(JSON.parse(o.body)); n++; return (op.fetch ?? respuestaOk)(n); },
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const falla = entre('function textoFalla(', '/**\n * Escribir o escanear P-17');
  const conDolarones = entre('async function cobrarConDolarones(', '/* ---------- pedidos por WhatsApp');
  const conPedido = entre('async function cobrarConPedido(', '/* ---------- cobro: primero');
  const errorClave = entre('function errorClave(', "for (const id of ['clave-rastreo'");
  const exigirCaja = entre('function exigirCaja() {', '/* ---------- almacen local');
  const pintar = entre('function pintar() {', 'function buscarPieza(');
  const guardado = entre("const CLAVE_TICKET = 'caja-ticket';", 'const descuentoAplicado');
  const cobro = entre('async function cobrar(', 'let sincronizando = false;');
  const cableado = entre('/* ---------- botones de cobro (#830) ---------- */', '// Para cambiar billetes sin cobrar nada.');
  const rutinas = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, folioIncierto = null, cobroIncierto = null,
      usarTodos = false, sinPromo = false, codigoSocio = ${op.dolarones ? "'DC-x'" : "''"};
    ${pintar}\n${guardado}\n${avisoRojo}\n${falla}\n${conDolarones}\n${conPedido}\n${errorClave}\n${exigirCaja}\n${cobro}\n${cableado}
    ({ pintar, estado: () => ({ idVenta, folioIncierto, cobroIncierto }) })`, contexto);
  rutinas.pintar();                                          // como al abrir la caja

  return {
    p, $, enviadas, guardadas, cajones, impresos, almacen, contexto, rutinas,
    estado: () => rutinas.estado() as { idVenta: string | null; folioIncierto: string | null; cobroIncierto: any },
    habilitados: () => BOTONES.filter((id) => !$(id).disabled),
    /** Un clic de ratón: el navegador enfoca el botón (si está habilitado) y solo entonces corre el manejador. */
    clic: async (id: string) => { if ($(id).disabled) return; $(id).focus(); await $(id).disparar('click'); },
    /** Lo que hace el lector: escribe en lo que tenga el foco y manda Enter; el navegador pulsa un botón con foco si nadie cancela el Enter. */
    escanear: async (texto = ESCANEO) => {
      for (const letra of texto) {
        const el = p.elementos.get(p.activo);
        if (el && CAMPOS.has(el.id)) { el.value += letra; await el.disparar('input'); }
      }
      const el = p.elementos.get(p.activo);
      if (!el) return;
      const enter = { key: 'Enter', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      await el.disparar('keydown', enter);
      if (!enter.defaultPrevented && BOTONES.includes(el.id)) await el.disparar('click');
    },
  };
}

const respiro = () => new Promise((r) => setTimeout(r, 0));

/* ---------- seguridad del lector: tras cada salida, un escaneo no cobra ---------- */

test('#830 lector: tras cobrar, el foco queda en #codigo y un escaneo no cobra otra vez ni cae en un botón', async () => {
  const c = armar();
  await c.clic('cobrar-efectivo');
  assert.equal(c.enviadas.length, 1);
  assert.equal(c.p.activo, 'codigo');
  await c.escanear();
  assert.equal(c.enviadas.length, 1, 'el escaneo posterior no cobra');
  assert.equal(c.$('codigo').value, ESCANEO, 'lo escaneado cae en #codigo');
});

test('#830 lector: «Escribe cuánto te dio el cliente» deja el foco en #codigo: lo que escanee el lector NO se vuelve el efectivo recibido', async () => {
  for (const efectivo of ['', '0']) {
    const c = armar({ efectivo });
    await c.clic('cobrar-efectivo');
    assert.match(c.$('aviso').textContent, /^Escribe cuánto te dio el cliente: toca «Exacto», un billete o escríbelo en «Efectivo recibido»\.$/);
    assert.equal(c.p.activo, 'codigo');
    await c.escanear();
    assert.equal(c.$('codigo').value, ESCANEO, 'el escaneo cae en #codigo');
    assert.equal(c.$('efectivo').value, efectivo, '#efectivo no recibió ni un dígito');
    assert.equal(c.enviadas.length, 0);
  }
});

const SALIDAS: [string, Opciones, string, RegExp, string][] = [
  ['efectivo vacío', { efectivo: '' }, 'cobrar-efectivo', /^Escribe cuánto te dio el cliente/, 'codigo'],
  ['efectivo insuficiente', { efectivo: '100' }, 'cobrar-efectivo', /^Faltan/, 'codigo'],
  ['efectivo en el celular con impresión remota', { remota: true }, 'cobrar-efectivo', /En el celular sólo tarjeta o transferencia/, 'codigo'],
  ['descuento esperando a gerencia', { descuento: { estado: 'pendiente', tipo: 'monto', subtotal: 30000, monto: 1000 } }, 'cobrar-tarjeta', /esperando a gerencia/, 'codigo'],
  ['ventana de socio: «Es socio: buscarlo»', { respuestaSocio: 'buscar' }, 'cobrar-tarjeta', /^$/, 'socio'],
  ['ventana de socio: «Darlo de alta»', { respuestaSocio: 'alta' }, 'cobrar-tarjeta', /^$/, 'socio'],
  ['ventana de socio: cerrada con Enter o Escape', { respuestaSocio: '' }, 'cobrar-tarjeta', /^$/, 'socio'],
  ['transferencia: el primer clic solo muestra los datos', {}, 'cobrar-transferencia', /Llena la clave, el monto y el banco/, 'codigo'],
  ['el servidor rechaza la venta', { fetch: rechazo('No hay existencia suficiente para completar la venta.') }, 'cobrar-tarjeta', /No hay existencia suficiente/, 'codigo'],
];
test('#830 lector: tras cada salida del cobro que no cobra, el foco está en #codigo (o en el campo de la ventana a la que se vuelve) y un escaneo no cobra', async () => {
  for (const [nombre, op, boton, aviso, foco] of SALIDAS) {
    const c = armar(op);
    await c.clic(boton);
    const antes = c.enviadas.length;                       // el rechazo del servidor sí llegó a pedir; lo demás ni eso
    assert.ok(antes <= (nombre.startsWith('el servidor') ? 1 : 0), `${nombre}: ${antes} peticiones`);
    assert.equal(c.guardadas.length, 0, nombre);
    assert.match(c.$('aviso').textContent, aviso, nombre);
    assert.equal(c.p.activo, foco, `${nombre}: foco`);
    assert.ok(!BOTONES.includes(c.p.activo), `${nombre}: ningún botón de cobro conserva el foco`);
    const campos = ['clave-rastreo', 'monto-transferido', 'efectivo'].map((id) => c.$(id).value);
    await c.escanear();
    assert.equal(c.enviadas.length, antes, `${nombre}: el escaneo no cobra`);
    assert.equal(c.guardadas.length, 0, nombre);
    if (foco === 'codigo') assert.deepEqual(['clave-rastreo', 'monto-transferido', 'efectivo'].map((id) => c.$(id).value), campos, `${nombre}: el escaneo no tocó ningún campo de pago`);
    assert.equal(c.$(boton).disabled, false, `${nombre}: el botón queda disponible para otro clic`);
  }
});

test('#830 lector: sin caja elegida, el foco que deja la caja real (exigirCaja) no cobra con un escaneo', async () => {
  const c = armar({ sinCaja: true });
  await c.clic('cobrar-tarjeta');
  assert.match(c.$('aviso').textContent, /Elige arriba qué caja es esta computadora/);
  assert.equal(c.p.activo, 'caja-nombre', 'exigirCaja lleva el foco al selector de caja');
  await c.escanear();
  assert.equal(c.enviadas.length, 0);
  assert.equal(c.guardadas.length, 0);
  assert.equal(c.$('efectivo').value, '300', 'ni siquiera el campo de efectivo cambió');
});

test('#830 transferencia ≥ $300: el primer clic solo muestra los datos y deja el foco en #codigo; un error real lleva al campo que falló', async () => {
  const c = armar();
  await c.clic('cobrar-transferencia');
  assert.equal(c.$('datos-transferencia').hidden, false);
  assert.equal(c.p.activo, 'codigo', 'una pieza escaneada no puede volverse clave o monto');
  await c.escanear();
  assert.equal(c.$('clave-rastreo').value, '');
  assert.equal(c.$('monto-transferido').value, '');
  assert.equal(c.enviadas.length, 0);

  const clave = armar({ datosVisibles: true });
  await clave.clic('cobrar-transferencia');
  assert.match(clave.$('clave-error').textContent, /Escribe la clave de rastreo/);
  assert.equal(clave.p.activo, 'clave-rastreo');
  const banco = armar({ datosVisibles: true, valores: { 'clave-rastreo': 'EJEMPLO123456', 'monto-transferido': '300' } });
  await banco.clic('cobrar-transferencia');
  assert.match(banco.$('clave-error').textContent, /Elige el banco/);
  assert.equal(banco.p.activo, 'banco-emisor');
  for (const x of [clave, banco]) { await x.escanear(); assert.equal(x.enviadas.length, 0); }
});

test('#830 transferencia: un monto de más de $5,000 sobre lo que se debe (un código escaneado en «Monto») no cobra; $5,000 de más sí', async () => {
  const datos = { 'clave-rastreo': 'EJEMPLO123456', 'banco-emisor': '40012' };
  const absurdo = armar({ datosVisibles: true, valores: { ...datos, 'monto-transferido': ESCANEO } });
  await absurdo.clic('cobrar-transferencia');
  assert.equal(absurdo.$('clave-error').textContent, 'Revisa el monto del comprobante.');
  assert.equal(absurdo.p.activo, 'monto-transferido');
  assert.equal(absurdo.enviadas.length, 0);
  const justo = armar({ datosVisibles: true, valores: { ...datos, 'monto-transferido': '5300' } });
  await justo.clic('cobrar-transferencia');
  assert.equal(justo.enviadas.length, 1);
  assert.equal(justo.enviadas[0].monto_transferido, 530000);
});

test('#830 transferencia: con los datos escondidos el clic solo los muestra aunque queden valores de antes que pasarían; se limpian con el ticket', async () => {
  const viejos = { 'clave-rastreo': 'EJEMPLO123456', 'monto-transferido': '300', 'banco-emisor': '40012' };
  const c = armar({ valores: viejos });                    // quedaron de otra venta y el bloque está escondido
  await c.clic('cobrar-transferencia');
  assert.equal(c.enviadas.length, 0, 'no cobra con datos que nadie vio');
  assert.equal(c.$('datos-transferencia').hidden, false);
  await c.clic('cobrar-transferencia');                    // ya a la vista: el segundo clic sí cobra
  assert.equal(c.enviadas.length, 1);
  assert.equal(c.enviadas[0].clave_rastreo, 'EJEMPLO123456');

  // Otra forma que se completa limpia lo de la transferencia; también un ticket que se queda vacío.
  const otra = armar({ valores: viejos, datosVisibles: true });
  await otra.clic('cobrar-tarjeta');
  assert.equal(otra.enviadas.length, 1);
  for (const id of Object.keys(viejos)) assert.equal(otra.$(id).value, '', id);
  const vacio = armar({ valores: viejos, datosVisibles: true });
  vacio.contexto.lineas = [];
  vacio.rutinas.pintar();
  for (const id of Object.keys(viejos)) assert.equal(vacio.$(id).value, '', `ticket vacío: ${id}`);
});

test('#830 lector: Enter con el foco en un botón de cobro o en un rápido no cobra (el peor caso: un Tab o un clic que dejó el foco ahí)', async () => {
  for (const id of BOTONES) {
    const c = armar({ pedido: { id: 'ped-1', folio: 17, saldo: 30000 } });
    c.$(id).focus();
    assert.equal(c.p.activo, id);
    await c.escanear();
    assert.equal(c.enviadas.length, 0, id);
    assert.equal(c.guardadas.length, 0, id);
  }
  const rapido = armar({ efectivo: '' });
  const enter = { key: 'Enter', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, target: { dataset: { centavos: '50000' } } };
  await rapido.$('rapidos').disparar('keydown', enter);
  assert.equal(enter.defaultPrevented, true, 'el Enter no activa un botón rápido');
  // El control: sin ese freno, el mismo Enter sí cobraría; el clic (o Espacio) sigue funcionando.
  const control = armar();
  await control.clic('cobrar-efectivo');
  assert.equal(control.enviadas.length, 1);
});

test('#830 lector: Enter dentro de «Efectivo recibido» no cobra, no cambia el monto y manda el foco a #codigo', async () => {
  const c = armar({ efectivo: '350' });
  c.$('efectivo').focus();
  const enter = { key: 'Enter', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  await c.$('efectivo').disparar('keydown', enter);
  assert.equal(c.p.activo, 'codigo');
  assert.equal(c.$('efectivo').value, '350');
  assert.equal(c.enviadas.length, 0);
  await c.escanear();
  assert.equal(c.$('efectivo').value, '350', 'el siguiente escaneo ya no cae en el efectivo');
  assert.equal(c.enviadas.length, 0);
});

test('#830 no hay cobro sin un clic en un botón de cobro: ni teclear el efectivo, ni la forma, ni un valor desconocido', async () => {
  const c = armar({ efectivo: '' });
  c.$('efectivo').value = '300';
  await c.$('efectivo').disparar('input');                 // escribir lo que dieron no elige nada ni cobra
  assert.equal(c.enviadas.length, 0);
  assert.equal(c.guardadas.length, 0);
  // cobrar() solo acepta las formas de los botones: cualquier otra cosa no cobra.
  const rara = armar();
  const boton = rara.$('cobrar-efectivo');
  for (const forma of [undefined, '', 'Efectivo', 'cheque']) {
    boton.dataset.forma = forma as string;
    await boton.disparar('click');
  }
  assert.equal(rara.enviadas.length, 0);
  assert.equal(rara.guardadas.length, 0);
  assert.equal(rara.$('efectivo').value, '300', 'sin forma no se toca nada');
  // Ningún rastro del selector, de la ventana ni de un único «Cobrar»; solo una llamada a cobrar() y es la del clic.
  assert.doesNotMatch(fuente, /id="forma"|\$\('forma'\)|dlg-forma|preguntarForma|formaElegida|id="cobrar"|\$\('cobrar'\)/);
  const codigo = fuente.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.deepEqual(codigo.match(/(?<!function )\bcobrar\(/g), ['cobrar('], 'cobrar() solo se llama desde el clic de un botón de cobro');
  assert.match(codigo, /boton\.addEventListener\('click', \(\) => cobrar\(boton\.dataset\.forma\)\)/);
});

/* ---------- cada botón es la elección y el cobro ---------- */

test('#830 tarjeta: un clic cobra con tarjeta, no manda efectivo y borra lo que hubiera en «Efectivo recibido»', async () => {
  const c = armar({ efectivo: '300' });
  await c.clic('cobrar-tarjeta');
  assert.equal(c.enviadas.length, 1);
  assert.equal(c.enviadas[0].forma_pago, 'tarjeta');
  assert.equal(c.enviadas[0].efectivo, 0);
  assert.equal(c.$('efectivo').value, '');
  // Aunque el cobro no se complete, tocar tarjeta ya borró el efectivo: manda la elección explícita.
  const pendiente = armar({ efectivo: '300', descuento: { estado: 'pendiente', tipo: 'monto', subtotal: 30000, monto: 1000 } });
  await pendiente.clic('cobrar-tarjeta');
  assert.equal(pendiente.enviadas.length, 0);
  assert.equal(pendiente.$('efectivo').value, '');
});

test('#830 efectivo: cobra solo con el monto recibido; el cambio sale de lo escrito y vacío ya no es «exacto»', async () => {
  const vacio = armar({ efectivo: '' });
  await vacio.clic('cobrar-efectivo');
  assert.equal(vacio.enviadas.length, 0);
  const exacto = armar({ efectivo: '300' });
  await exacto.clic('cobrar-efectivo');
  assert.equal(exacto.enviadas[0].forma_pago, 'efectivo');
  assert.equal(exacto.enviadas[0].efectivo, 30000);
  assert.match(exacto.$('aviso').textContent, /^Cobrado\./);
  assert.equal(exacto.cajones.length, 1, 'efectivo recibido: el cajón se abre');
  const billete = armar({ efectivo: '500' });
  await billete.clic('cobrar-efectivo');
  assert.equal(billete.enviadas[0].efectivo, 50000);
  assert.match(billete.$('aviso').textContent, /^Cobrado\. Cambio 20000/);
});

test('#830 transferencia: bajo $300 un clic cobra; desde $300 el primer clic muestra los datos y con datos válidos el segundo cobra, sin efectivo', async () => {
  const baja = armar({ precio: 29999, efectivo: '300' });
  await baja.clic('cobrar-transferencia');
  assert.equal(baja.enviadas.length, 1);
  assert.equal(baja.enviadas[0].forma_pago, 'transferencia');
  assert.equal(baja.enviadas[0].efectivo, 0);
  assert.equal(baja.enviadas[0].clave_rastreo, undefined);
  assert.equal(baja.$('efectivo').value, '');
  assert.equal(baja.cajones.length, 0, 'sin efectivo no se abre el cajón');

  const c = armar({ efectivo: '300' });
  await c.clic('cobrar-transferencia');
  assert.equal(c.enviadas.length, 0, 'sin datos no cobra');
  assert.equal(c.$('efectivo').value, '', 'transferencia también borra el efectivo escrito');
  c.$('clave-rastreo').value = ' ejemplo 123456 ';
  c.$('monto-transferido').value = '300';
  c.$('banco-emisor').value = '40012';
  await c.clic('cobrar-transferencia');
  assert.equal(c.enviadas.length, 1);
  assert.equal(c.enviadas[0].forma_pago, 'transferencia');
  assert.equal(c.enviadas[0].clave_rastreo, 'EJEMPLO123456');
  assert.equal(c.enviadas[0].monto_transferido, 30000);
  assert.equal(c.p.activo, 'codigo');
});

test('#830 rápidos: «Exacto» y los billetes solo llenan el campo, devuelven el foco al lector y no cobran', async () => {
  const c = armar({ efectivo: '' });
  await c.$('rapidos').disparar('click', { target: { dataset: { centavos: '50000' } } });
  assert.equal(c.$('efectivo').value, '500');
  assert.equal(c.p.activo, 'codigo');
  assert.equal(c.enviadas.length, 0);
  await c.escanear();
  assert.equal(c.enviadas.length, 0);
  await c.$('rapidos').disparar('click', { target: { dataset: {} } });   // el hueco entre botones no hace nada
  assert.equal(c.$('efectivo').value, '500');
  await c.clic('cobrar-efectivo');                                       // cobra el botón de cobro, con lo que quedó en el campo
  assert.equal(c.enviadas[0].efectivo, 50000);
});

/* ---------- nada por pagar en dinero ---------- */

const TODO_CUBIERTO = { id: 'ped-1', folio: 17, saldo: 30000 };
test('#830 nada por pagar en dinero (Dolarones, vale o pedido lo cubren): un solo botón cierra la venta como siempre, sin abrir el cajón', async () => {
  const c = armar({ pedido: TODO_CUBIERTO, efectivo: '' });
  await c.clic('cobrar-sin-dinero');
  assert.equal(c.enviadas.length, 1);
  assert.equal(c.enviadas[0].forma_pago, 'efectivo', 'igual que hoy: sin dinero de por medio se registra efectivo en cero');
  assert.equal(c.enviadas[0].efectivo, 0);
  assert.equal(c.enviadas[0].anticipo, 30000);
  await respiro();
  assert.equal(c.cajones.length, 0, 'sin efectivo recibido no se abre el cajón');
  const celular = armar({ pedido: TODO_CUBIERTO, efectivo: '', remota: true });
  await celular.clic('cobrar-sin-dinero');
  assert.equal(celular.enviadas[0].forma_pago, 'tarjeta', 'en el celular nunca efectivo, igual que hoy');
  assert.equal(celular.enviadas[0].imprimir_en, 'Caja 2');
});

test('#830 «Cobrar: ya está pagado» con dinero por cobrar no cobra y lo dice', async () => {
  const c = armar();
  await c.$('cobrar-sin-dinero').disparar('click');         // el botón está escondido; aun así llegara
  assert.match(c.$('aviso').textContent, /Todavía queda dinero por cobrar: toca «Efectivo», «Tarjeta» o «Transferencia»\./);
  assert.equal(c.$('aviso').style.color, '#D72B32');
  assert.equal(c.enviadas.length, 0);
  assert.equal(c.p.activo, 'codigo');
});

/* ---------- pintar(): qué botones hay y cuáles se pueden tocar ---------- */

test('#830 pintar: ticket vacío, con dinero por cobrar, todo cubierto y cobrando; solo se ve y se habilita lo que corresponde', async () => {
  const vacio = armar();
  vacio.contexto.lineas = [];
  vacio.rutinas.pintar();
  assert.deepEqual(vacio.habilitados(), [], 'sin piezas no hay nada que cobrar');
  assert.equal(vacio.$('rapidos').innerHTML, '');

  const normal = armar({ efectivo: '' });                  // $300 por cobrar
  assert.deepEqual(normal.habilitados(), [...DE_DINERO, 'cobrar-sin-dinero'], 'habilitados todos; el grupo que no toca va escondido');
  assert.equal(normal.$('botones-dinero').hidden, false);
  assert.equal(normal.$('cobrar-sin-dinero').hidden, true);
  assert.deepEqual([...normal.$('rapidos').innerHTML.matchAll(/data-centavos="(\d+)"/g)].map((m) => m[1]), ['30000', '50000', '100000'], 'Exacto y los billetes que cubren');
  assert.match(normal.$('rapidos').innerHTML, /Exacto/);

  const cubierto = armar({ pedido: TODO_CUBIERTO, efectivo: '' });
  assert.equal(cubierto.$('botones-dinero').hidden, true, 'no hay forma de pago que elegir');
  assert.equal(cubierto.$('cobrar-sin-dinero').hidden, false);
  assert.equal(cubierto.$('cobrar-sin-dinero').disabled, false);
  assert.equal(cubierto.$('rapidos').innerHTML, '');

  let soltar: () => void = () => {};
  const espera = new Promise<void>((r) => { soltar = r; });
  const ocupada = armar({ fetch: async () => { await espera; return respuestaOk(); } });
  const cobro = ocupada.clic('cobrar-tarjeta');
  await respiro();
  assert.deepEqual(ocupada.habilitados(), [], 'mientras se cobra no hay nada que tocar');
  assert.match(ocupada.$('rapidos').innerHTML, /disabled/);
  await ocupada.clic('cobrar-efectivo');                   // deshabilitado: ni llega
  await ocupada.$('cobrar-efectivo').disparar('click');    // y aunque llegara, cobrar() lo ignora
  assert.equal(ocupada.enviadas.length, 1);
  soltar();
  await cobro;
  assert.deepEqual(ocupada.habilitados(), [], 'vendida: el ticket quedó vacío');
  assert.equal(ocupada.p.activo, 'codigo');
});

/* ---------- folio en duda: el reintento sale con lo mismo y del mismo botón ---------- */

const PEDIDO_PARCIAL = { id: 'ped-1', folio: 17, saldo: 10000 };
test('#830 folio en duda: tras un timeout solo se deja tocar el mismo botón y el reintento manda el mismo cuerpo aunque cambie el efectivo', async () => {
  const c = armar({ pedido: PEDIDO_PARCIAL, efectivo: '200', fetch: (n) => (n === 1 ? sinRed() : respuestaOk()) });
  await c.clic('cobrar-efectivo');
  assert.equal(c.enviadas.length, 1);
  assert.match(c.$('aviso').textContent, /Toca otra vez el botón «Efectivo»: con el mismo folio no se cobra dos veces/);
  assert.equal(c.estado().cobroIncierto.boton, 'efectivo');
  assert.deepEqual(c.habilitados(), ['cobrar-efectivo'], 'solo el mismo botón');
  assert.equal(c.p.activo, 'codigo');
  // Otro botón: ni se puede tocar ni, aunque llegara el clic, manda nada.
  await c.clic('cobrar-tarjeta');
  await c.$('cobrar-tarjeta').disparar('click');
  assert.equal(c.enviadas.length, 1);
  assert.match(c.$('aviso').textContent, /^El cobro anterior quedó en duda\. Toca otra vez el botón «Efectivo»/);
  // El mismo botón con otro efectivo escrito: se reenvía lo guardado.
  c.$('efectivo').value = '999';
  await c.clic('cobrar-efectivo');
  assert.equal(c.enviadas.length, 2);
  assert.deepEqual(c.enviadas[1], c.enviadas[0], 'cuerpo idéntico: mismo folio, forma, efectivo y fecha');
  assert.equal(c.enviadas[1].efectivo, 20000);
  assert.match(c.$('aviso').textContent, /^Cobrado/);
  assert.equal(c.estado().cobroIncierto, null);
});

test('#830 folio en duda: una respuesta del servidor suelta la duda y vuelven todos los botones', async () => {
  const c = armar({ pedido: PEDIDO_PARCIAL, efectivo: '200', fetch: (n) => (n === 1 ? sinRed() : rechazo('El saldo del pedido cambió o venció. Vuelve a cargarlo.')()) });
  await c.clic('cobrar-efectivo');
  assert.deepEqual(c.habilitados(), ['cobrar-efectivo']);
  await c.clic('cobrar-efectivo');
  assert.equal(c.enviadas.length, 2);
  assert.match(c.$('aviso').textContent, /Vuelve a cargarlo/);
  assert.equal(c.estado().cobroIncierto, null);
  assert.equal(c.estado().folioIncierto, null);
  assert.deepEqual(DE_DINERO.filter((id) => c.habilitados().includes(id)), DE_DINERO, 'los tres botones de dinero vuelven');
});

test('#830 folio en duda: recargar la caja conserva el botón, el efectivo y el folio; el reintento sale idéntico', async () => {
  const antes = armar({ pedido: PEDIDO_PARCIAL, efectivo: '200', fetch: sinRed });
  await antes.clic('cobrar-efectivo');
  assert.deepEqual(antes.habilitados(), ['cobrar-efectivo']);
  const folio = antes.estado().idVenta;
  assert.ok(folio);

  // La caja se vuelve a abrir: el ticket sale del almacén, el campo de efectivo está vacío.
  const despues = armar({ almacen: antes.almacen, recargar: true, efectivo: '', fetch: respuestaOk });
  assert.equal(despues.estado().idVenta, folio);
  assert.equal(despues.estado().cobroIncierto.boton, 'efectivo');
  assert.deepEqual(despues.habilitados(), ['cobrar-efectivo'], 'solo el mismo botón, también tras recargar');
  await despues.clic('cobrar-efectivo');
  assert.equal(despues.enviadas.length, 1);
  assert.deepEqual(despues.enviadas[0], antes.enviadas[0], 'mismo folio, forma, efectivo, fecha y pedido');
  assert.match(despues.$('aviso').textContent, /^Cobrado/);
  assert.equal(despues.estado().cobroIncierto, null);
});

test('#830 folio en duda: una transferencia reintenta con la clave y el monto guardados aunque se hayan editado', async () => {
  const datos = { 'clave-rastreo': 'EJEMPLO123456', 'monto-transferido': '300', 'banco-emisor': '40012' };
  const c = armar({ datosVisibles: true, valores: datos, fetch: (n) => (n === 1 ? sinRed() : respuestaOk()) });
  await c.clic('cobrar-transferencia');
  assert.match(c.$('aviso').textContent, /Toca otra vez el botón «Transferencia»/);
  assert.deepEqual(c.habilitados(), ['cobrar-transferencia']);
  c.$('monto-transferido').value = '350';
  c.$('clave-rastreo').value = 'OTRA999999';
  await c.clic('cobrar-transferencia');
  assert.equal(c.enviadas.length, 2);
  assert.deepEqual(c.enviadas[1], c.enviadas[0]);
  assert.equal(c.enviadas[1].clave_rastreo, 'EJEMPLO123456');
  assert.equal(c.enviadas[1].monto_transferido, 30000);
});

test('#830 folio en duda con Dolarones: el aviso nombra el botón y solo ese queda habilitado', async () => {
  const c = armar({ dolarones: 5000, efectivo: '250', fetch: (n) => (n === 1 ? Promise.reject(new DOMException('timeout', 'TimeoutError')) : respuestaOk()) });
  await c.clic('cobrar-efectivo');
  assert.match(c.$('aviso').textContent, /^No se supo si se cobró\. Toca otra vez el botón «Efectivo»: con el mismo folio no se cobra dos veces/);
  assert.deepEqual(c.habilitados(), ['cobrar-efectivo']);
  c.$('efectivo').value = '700';
  await c.clic('cobrar-efectivo');
  assert.equal(c.enviadas.length, 2);
  assert.deepEqual(c.enviadas[1], c.enviadas[0]);
  assert.equal(c.enviadas[1].codigo_socio, 'DC-x');
});

/* ---------- #832: una venta con una pieza «La tengo en la mano» no se encola; usa el folio en duda de #830 ---------- */

const cincoXX = async () => ({ ok: false, status: 503, json: async () => ({}) });
const timeout = async () => { throw new DOMException('timeout', 'TimeoutError'); };
const RESPUESTAS_DESCONOCIDAS: [string, () => Promise<unknown>][] = [['sin red', sinRed], ['timeout', timeout], ['5xx', cincoXX]];

test('#832 en la mano: con respuesta desconocida no se escribe nada en IndexedDB; queda el folio en duda de #830 (solo el mismo botón) y el reintento sale idéntico', async () => {
  for (const [que, falla] of RESPUESTAS_DESCONOCIDAS) {
    const c = armar({ enMano: true, fetch: (n) => (n === 1 ? falla() : respuestaOk()) });
    await c.clic('cobrar-tarjeta');
    assert.equal(c.enviadas.length, 1, que);
    assert.equal(c.guardadas.length, 0, `${que}: nada en IndexedDB`);
    assert.match(c.$('aviso').textContent, /^No se supo si se cobró\. Toca otra vez el botón «Tarjeta»: con el mismo folio no se cobra dos veces/, que);
    assert.equal(c.estado().cobroIncierto.boton, 'tarjeta', que);
    assert.deepEqual(c.habilitados(), ['cobrar-tarjeta'], `${que}: solo el mismo botón`);
    assert.equal(c.p.activo, 'codigo', que);
    await c.clic('cobrar-efectivo');
    assert.equal(c.enviadas.length, 1, `${que}: otro botón no manda nada`);
    await c.clic('cobrar-tarjeta');
    assert.equal(c.enviadas.length, 2, que);
    assert.deepEqual(c.enviadas[1], c.enviadas[0], `${que}: mismo folio y mismo cuerpo, con la marca`);
    assert.deepEqual(c.enviadas[1].lineas[0].en_mano, { motivo: 'no_se', esperado: 0 });
    assert.match(c.$('aviso').textContent, /^Cobrado/, que);
    assert.equal(c.estado().cobroIncierto, null, que);
    assert.equal(c.guardadas.length, 0, que);
  }
});

test('#832 en la mano: recargar la caja con el cobro en duda conserva la marca, el folio y el botón', async () => {
  const antes = armar({ enMano: true, fetch: sinRed });
  await antes.clic('cobrar-tarjeta');
  const folio = antes.estado().idVenta;
  const despues = armar({ almacen: antes.almacen, recargar: true, fetch: respuestaOk });
  assert.equal(despues.estado().idVenta, folio);
  assert.deepEqual(despues.habilitados(), ['cobrar-tarjeta']);
  await despues.clic('cobrar-tarjeta');
  assert.deepEqual(despues.enviadas[0], antes.enviadas[0]);
  assert.equal(despues.guardadas.length, 0);
});

test('#832 en la mano: una respuesta definitiva del servidor al reintento suelta la duda (no queda el ticket trabado)', async () => {
  const c = armar({ enMano: true, fetch: (n) => (n === 1 ? sinRed() : rechazo('Va en el bulto BU-K7Q2M: recíbelo primero en «Bultos».')()) });
  await c.clic('cobrar-tarjeta');
  assert.deepEqual(c.habilitados(), ['cobrar-tarjeta']);
  await c.clic('cobrar-tarjeta');
  assert.match(c.$('aviso').textContent, /Va en el bulto/);
  assert.equal(c.estado().cobroIncierto, null);
  assert.equal(c.estado().folioIncierto, null);
  assert.deepEqual(DE_DINERO.filter((id) => c.habilitados().includes(id)), DE_DINERO);
  assert.equal(c.guardadas.length, 0);
});

test('#832 en la mano: sin red no se envía ni se encola, y sin la marca la venta sigue en cola como siempre', async () => {
  const marcada = armar({ enMano: true, enLinea: false, fetch: sinRed });
  await marcada.clic('cobrar-tarjeta');
  assert.equal(marcada.enviadas.length, 0);
  assert.equal(marcada.guardadas.length, 0);
  assert.equal(marcada.$('aviso').textContent, SIN_RED_EN_MANO);
  assert.equal(marcada.p.activo, 'codigo');
  assert.equal(marcada.estado().cobroIncierto, null, 'no hubo cobro: no hay duda');
  for (const [que, falla] of RESPUESTAS_DESCONOCIDAS) {
    const normal = armar({ fetch: falla });
    await normal.clic('cobrar-tarjeta');
    assert.equal(normal.guardadas.length, 1, `${que}: una venta sin la marca se encola`);
    assert.equal(normal.estado().cobroIncierto, null, que);
  }
});

test('#832 en la mano: la marca viaja en su línea (motivo y existencia que vio la caja) y solo en ella; sin marca el cuerpo no cambia', async () => {
  const c = armar({ enMano: true });
  await c.clic('cobrar-tarjeta');
  assert.deepEqual(c.enviadas[0].lineas, [{ codigo: 'ED-000001', nombre: 'Ventilador', precio: 30000, cantidad: 1, producto_id: 'p1', en_mano: { motivo: 'no_se', esperado: 0 } }]);
  const normal = armar();
  await normal.clic('cobrar-tarjeta');
  assert.deepEqual(Object.keys(normal.enviadas[0].lineas[0]), ['codigo', 'nombre', 'precio', 'cantidad', 'producto_id']);
});

/* ---------- #931: lo último escaneado arriba, solo en pantalla ---------- */

// Orden de captura A, B, C. B se escaneó otra vez al final (sumó una pieza): en pantalla va primero, en los datos sigue en su lugar.
const TICKET_931 = [
  { producto_id: 'pa', codigo: 'ED-A', nombre: 'Pieza A', precio: 10000, cantidad: 1, tocada: 1000 },
  { producto_id: 'pb', codigo: 'ED-B', nombre: 'Pieza B', precio: 20000, cantidad: 2, tocada: 3000 },
  { producto_id: 'pc', codigo: 'ED-C', nombre: 'Pieza C', precio: 30000, cantidad: 1, tocada: 2000 },
];
const codigosEnPantalla = (html: string) => [...html.matchAll(/class="codigo">(ED-[A-C])/g)].map((m) => m[1]);

test('#931 pantalla: el ticket dibuja lo último escaneado arriba (incluida una pieza repetida que ya estaba) y el ✕ quita la línea real, no la de pantalla', async () => {
  const c = armar({ lineas: structuredClone(TICKET_931).map((l) => ({ ...l, tocada: l.tocada + Date.now() })) });
  assert.deepEqual(codigosEnPantalla(c.$('ticket').innerHTML), ['ED-B', 'ED-C', 'ED-A']);
  // Cada ✕ lleva el índice REAL en `lineas` (B es la 1, aunque salga primero).
  assert.deepEqual([...c.$('ticket').innerHTML.matchAll(/data-quitar="(\d+)"/g)].map((m) => m[1]), ['1', '2', '0']);
  assert.deepEqual(c.contexto.lineas.map((l: any) => l.codigo), ['ED-A', 'ED-B', 'ED-C'], 'pintar() no reordena los datos');
  // Sin sello (ticket de antes de este cambio o de un pedido) cae al más nuevo primero por posición.
  const viejo = armar({ lineas: TICKET_931.map(({ tocada, ...l }) => l) });
  assert.deepEqual(codigosEnPantalla(viejo.$('ticket').innerHTML), ['ED-C', 'ED-B', 'ED-A']);
});

test('#931 pantalla: solo el renglón recién tocado se resalta (y sigue donde lo dejó la animación); uno viejo no', () => {
  const ahora = Date.now();
  const c = armar({ lineas: [{ ...TICKET_931[0], tocada: ahora - 60_000 }, { ...TICKET_931[1], tocada: ahora - 300 }] });
  const html: string = c.$('ticket').innerHTML;
  assert.equal((html.match(/class="renglon nuevo"/g) ?? []).length, 1);
  assert.match(html, /class="renglon nuevo" style="animation-delay:-\d+ms"[\s\S]*ED-B/);
  assert.ok(html.indexOf('renglon nuevo') < html.indexOf('ED-A'), 'el resaltado es el de arriba');
  assert.equal(c.$('ticket').scrollTop, 0);
});

for (const forma of ['con red', 'sin red (se encola)']) {
  test(`#931 lo que se envía, se encola y se imprime sale en el orden de captura y sin el dato de pantalla (${forma})`, async () => {
    const c = armar({ lineas: structuredClone(TICKET_931), fetch: forma === 'con red' ? respuestaOk : sinRed });
    // Antes de cobrar la pantalla dibuja B primero: si el envío usara ese orden, esta prueba lo vería.
    assert.deepEqual(codigosEnPantalla(c.$('ticket').innerHTML), ['ED-B', 'ED-C', 'ED-A']);
    await c.clic('cobrar-tarjeta');
    const salida = forma === 'con red' ? c.enviadas[0].lineas : (c.guardadas[0] as any).lineas;
    assert.deepEqual(salida.map((l: any) => l.codigo), ['ED-A', 'ED-B', 'ED-C']);
    assert.ok(salida.every((l: any) => !('tocada' in l)), 'el sello de pantalla no viaja');
    assert.deepEqual(c.impresos[0][1].map((l: any) => l.codigo), ['ED-A', 'ED-B', 'ED-C'], 'el ticket impreso lleva el mismo orden');
  });
}
