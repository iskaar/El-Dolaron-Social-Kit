// node --test src/caja-botones-cobro.test.ts
// Issue #830: tres botones de cobro (efectivo, tarjeta, transferencia), sin forma por omisión. Reemplaza la ventana «¿Efectivo o tarjeta?» (#260, 17/10).
// Corre el cobrar() y el cableado REALES de public/caja.html contra una pantalla mínima (foco, Enter del lector, clic) sin navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE, debePreguntarSocio,
  descuentoDe, TOPE_DESCUENTO,
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
  fetch?: () => Promise<unknown>;
}

function armar(op: Opciones = {}) {
  const p = new Pantalla();
  const enviadas: any[] = [];
  const guardadas: unknown[] = [];
  const $ = (id: string) => p.el(id);
  $('efectivo').value = op.efectivo ?? '300';
  $('imprimir-en').value = 'Caja 2';
  for (const [id, valor] of Object.entries(op.valores ?? {})) $(id).value = valor;
  for (const id of BOTONES) $(id).dataset.forma = FORMA[id];
  const respuestaOk = async () => ({ ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null, saldo_pedido: 0 }) });
  const contexto: Record<string, unknown> = {
    crypto, Date, $, AbortSignal, Object, Math, vistos: [] as unknown[], totales, efectivoAlcanza, saldoCanjeable, dolaronesGanados, anticipoDePedido,
    transferenciaDe, CLAVE_DESDE, debePreguntarSocio, descuentoDe, TOPE_DESCUENTO, navigator: { onLine: true }, window: { open() {} },
    document: { querySelectorAll: (s: string) => (s === '#botones-cobro button' ? BOTONES.map($) : []), createElement: () => ({ style: {}, textContent: '' }) },
    lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: op.precio ?? 30000, cantidad: 1 }],
    errorImpresora: () => 'no conectada', socio: null, valesCargados: [], catalogo: new Map(), pedidoCargado: op.pedido ?? null,
    preguntarSocio: async () => op.respuestaSocio ?? 'cobrar', abrirAlta() {},
    impresionRemota: () => !!op.remota,
    exigirCaja: () => { if (op.sinCaja) $('aviso').textContent = 'Elige arriba qué caja es esta computadora.'; return !op.sinCaja; },
    cajaActual: () => 'Caja 1', dolaronesPedidos: () => 0,
    descuento: op.descuento ?? null, descuentoAplicado: () => 0, promoActual: () => 0, totalNeto: () => op.precio ?? 30000, pintarDescuento() {},
    pesos: String, dolares: String, quitarSocio() {}, sincronizar() {}, cargarCatalogo() {}, pintarImpresora() {}, promoConfig: null,
    abrirCajon: async () => true, imprimirTicket: async () => true,
    store: async (almacen: string, _m: string, fn: any) => fn({ put(v: unknown) { if (almacen === 'ventas') guardadas.push(v); } }),
    fetch: async (_ruta: string, o: any) => { enviadas.push(JSON.parse(o.body)); return (op.fetch ?? respuestaOk)(); },
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const falla = entre('function textoFalla(', '/**\n * Escribir o escanear P-17');
  const conPedido = entre('async function cobrarConPedido(', '/* ---------- cobro: primero');
  const errorClave = entre('function errorClave(', "for (const id of ['clave-rastreo'");
  const cobro = entre('async function cobrar(', 'let sincronizando = false;');
  const cableado = entre('/* ---------- botones de cobro (#830) ---------- */', '// Para cambiar billetes sin cobrar nada.');
  // pintar() es el de la pantalla en lo que importa aquí: mientras se cobra no hay nada habilitado.
  runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false;
    function pintar() { for (const id of ['codigo', ${BOTONES.map((b) => `'${b}'`).join(', ')}]) $(id).disabled = cobrando; vistos.push(idVenta); }
    ${avisoRojo}\n${falla}\n${conPedido}\n${errorClave}\n${cobro}\n${cableado}`, contexto);

  return {
    p, $, enviadas, guardadas,
    /** Un clic de ratón: el navegador enfoca el botón antes de que corra el manejador. */
    clic: async (id: string) => { $(id).focus(); await $(id).disparar('click'); },
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

const SALIDAS: [string, Opciones, string, RegExp, string][] = [
  ['efectivo vacío', { efectivo: '' }, 'cobrar-efectivo', /^Escribe cuánto te dio el cliente$/, 'efectivo'],
  ['efectivo en cero', { efectivo: '0' }, 'cobrar-efectivo', /^Escribe cuánto te dio el cliente$/, 'efectivo'],
  ['efectivo insuficiente', { efectivo: '100' }, 'cobrar-efectivo', /^Faltan/, 'codigo'],
  ['efectivo en el celular con impresión remota', { remota: true }, 'cobrar-efectivo', /En el celular sólo tarjeta o transferencia/, 'codigo'],
  ['descuento esperando al dueño', { descuento: { estado: 'pendiente' } }, 'cobrar-tarjeta', /esperando al dueño/, 'codigo'],
  ['sin caja elegida', { sinCaja: true }, 'cobrar-tarjeta', /Elige arriba qué caja/, 'codigo'],
  ['ventana de socio: «Es socio: buscarlo»', { respuestaSocio: 'buscar' }, 'cobrar-tarjeta', /^$/, 'socio'],
  ['ventana de socio: «Darlo de alta»', { respuestaSocio: 'alta' }, 'cobrar-tarjeta', /^$/, 'socio'],
  ['ventana de socio: cerrada con Enter o Escape', { respuestaSocio: '' }, 'cobrar-tarjeta', /^$/, 'socio'],
  ['transferencia sin clave de rastreo', {}, 'cobrar-transferencia', /^$/, 'clave-rastreo'],
  ['transferencia sin banco', { valores: { 'clave-rastreo': 'EJEMPLO123456', 'monto-transferido': '300' } }, 'cobrar-transferencia', /^$/, 'banco-emisor'],
  ['el servidor rechaza la venta', { fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'No hay existencia suficiente para completar la venta.' }) }) },
    'cobrar-tarjeta', /No hay existencia suficiente/, 'codigo'],
];
test('#830 lector: tras cada salida del cobro que no cobra, el foco está en #codigo (o en #efectivo si falta el monto) y un escaneo no cobra', async () => {
  for (const [nombre, op, boton, aviso, foco] of SALIDAS) {
    const c = armar(op);
    await c.clic(boton);
    const antes = c.enviadas.length;                       // el rechazo del servidor sí llegó a pedir; lo demás ni eso
    assert.ok(antes <= (nombre.startsWith('el servidor') ? 1 : 0), `${nombre}: ${antes} peticiones`);
    assert.equal(c.guardadas.length, 0, nombre);
    assert.match(c.$('aviso').textContent, aviso, nombre);
    assert.equal(c.p.activo, foco, `${nombre}: foco`);
    assert.ok(!BOTONES.includes(c.p.activo), `${nombre}: ningún botón de cobro conserva el foco`);
    await c.escanear();
    assert.equal(c.enviadas.length, antes, `${nombre}: el escaneo no cobra`);
    assert.equal(c.guardadas.length, 0, nombre);
    assert.equal(c.$(boton).disabled, false, `${nombre}: el botón queda disponible para otro clic`);
  }
});

test('#830 lector: el error de la transferencia queda junto a su campo y los datos del comprobante aparecen con el primer clic', async () => {
  const c = armar();
  c.$('datos-transferencia').hidden = true;
  await c.clic('cobrar-transferencia');
  assert.equal(c.$('datos-transferencia').hidden, false);
  assert.match(c.$('clave-error').textContent, /Escribe la clave de rastreo/);
  assert.equal(c.enviadas.length, 0);
});

test('#830 lector: Enter con el foco en un botón de cobro no cobra (el peor caso: un Tab o un clic que dejó el foco ahí)', async () => {
  for (const id of BOTONES) {
    const c = armar({ pedido: { id: 'ped-1', folio: 17, saldo: 30000 } });
    c.$(id).focus();
    assert.equal(c.p.activo, id);
    await c.escanear();
    assert.equal(c.enviadas.length, 0, id);
    assert.equal(c.guardadas.length, 0, id);
  }
  // El control: sin ese freno, el mismo Enter sí cobraría; el clic (o Espacio) sigue funcionando.
  const control = armar();
  await control.clic('cobrar-efectivo');
  assert.equal(control.enviadas.length, 1);
});

test('#830 lector: el Enter dentro de «Efectivo recibido» no cobra, aunque el lector haya escrito dígitos ahí', async () => {
  const c = armar({ efectivo: '' });
  c.$('efectivo').focus();
  await c.escanear();
  assert.equal(c.$('efectivo').value, ESCANEO);
  assert.equal(c.enviadas.length, 0);
  assert.equal(c.guardadas.length, 0);
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
  const pendiente = armar({ efectivo: '300', descuento: { estado: 'pendiente' } });
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
  const billete = armar({ efectivo: '500' });
  await billete.clic('cobrar-efectivo');
  assert.equal(billete.enviadas[0].efectivo, 50000);
  assert.match(billete.$('aviso').textContent, /^Cobrado\. Cambio 20000/);
});

test('#830 transferencia: bajo $300 un clic cobra; desde $300 el primer clic muestra los datos y con datos válidos cobra, sin efectivo', async () => {
  const baja = armar({ precio: 29999, efectivo: '300' });
  await baja.clic('cobrar-transferencia');
  assert.equal(baja.enviadas.length, 1);
  assert.equal(baja.enviadas[0].forma_pago, 'transferencia');
  assert.equal(baja.enviadas[0].efectivo, 0);
  assert.equal(baja.enviadas[0].clave_rastreo, undefined);
  assert.equal(baja.$('efectivo').value, '');

  const c = armar({ efectivo: '300' });
  await c.clic('cobrar-transferencia');
  assert.equal(c.enviadas.length, 0, 'sin datos no cobra');
  assert.equal(c.$('efectivo').value, '', 'transferencia también borra el efectivo escrito');
  assert.equal(c.p.activo, 'clave-rastreo');
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

test('#830 nada por pagar en dinero (Dolarones, vale o pedido lo cubren): un solo botón cierra la venta como siempre y no hay forma que elegir', async () => {
  const saldo = { id: 'ped-1', folio: 17, saldo: 30000 };
  const c = armar({ pedido: saldo, efectivo: '' });
  await c.clic('cobrar-sin-dinero');
  assert.equal(c.enviadas.length, 1);
  assert.equal(c.enviadas[0].forma_pago, 'efectivo', 'igual que hoy: sin dinero de por medio se registra efectivo en cero');
  assert.equal(c.enviadas[0].efectivo, 0);
  assert.equal(c.enviadas[0].anticipo, 30000);
  const celular = armar({ pedido: saldo, efectivo: '', remota: true });
  await celular.clic('cobrar-sin-dinero');
  assert.equal(celular.enviadas[0].forma_pago, 'tarjeta', 'en el celular nunca efectivo, igual que hoy');
  assert.equal(celular.enviadas[0].imprimir_en, 'Caja 2');
  // pintar() solo muestra ese botón con todo cubierto y deshabilita los cuatro mientras se cobra.
  const pintar = entre('function pintar() {', 'function buscarPieza(');
  assert.match(pintar, /const sinDinero = t\.total > 0 && t\.aPagar === 0;/);
  assert.match(pintar, /\$\('cobrar-sin-dinero'\)\.hidden = !sinDinero;/);
  assert.match(pintar, /\$\('botones-dinero'\)\.hidden = sinDinero;/);
  assert.match(pintar, /const sinCobro = cobrando \|\|/);
  assert.match(pintar, /for \(const id of \['cobrar-efectivo', 'cobrar-tarjeta', 'cobrar-transferencia', 'cobrar-sin-dinero'\]\) \$\(id\)\.disabled = sinCobro;/);
});

test('#830 mientras se cobra no hay nada que tocar: los cuatro botones se deshabilitan y el foco vuelve a #codigo al terminar', async () => {
  let soltar: () => void = () => {};
  const espera = new Promise<void>((r) => { soltar = r; });
  const c = armar({ fetch: async () => { await espera; return { ok: true, status: 201, json: async () => ({ id: 'x', ganados: 0, vale_emitido: null }) }; } });
  const cobro = c.clic('cobrar-tarjeta');
  await new Promise((r) => setTimeout(r, 0));
  for (const id of BOTONES) assert.equal(c.$(id).disabled, true, id);
  await c.clic('cobrar-efectivo');                         // un segundo clic en pleno cobro no hace nada
  assert.equal(c.enviadas.length, 1);
  soltar();
  await cobro;
  for (const id of BOTONES) assert.equal(c.$(id).disabled, false, id);
  assert.equal(c.p.activo, 'codigo');
});
