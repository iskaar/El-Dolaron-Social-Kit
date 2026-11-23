// node --test src/caja-lector-siempre.test.ts
// Issue #913: lo que lee el lector USB entra siempre a la venta, esté donde esté el foco; sin ventana abierta, y sin tocar lo que una persona teclea.
// Corre lector.js y el cableado REAL de public/caja.html contra un DOM mínimo (sin navegador). El lector USB real sigue requiriendo prueba física.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { crearLector } from '../public/lector.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const lectorJs = readFileSync('public/lector.js', 'utf8').replace(/^export /gm, '');
const cableado = (() => {
  const i = fuente.indexOf('escucharLector(({ codigo })');
  assert.ok(i >= 0, 'la caja no escucha al lector fuera de #codigo');
  return fuente.slice(i, fuente.indexOf('\n\n', i));
})();

/** Un elemento mínimo: `closest` responde como el navegador para lo que el lector pregunta. */
class Nodo {
  value: string;
  eventos: string[] = [];
  id: string; editable: boolean; propio: boolean; type: string;
  constructor(id: string, editable = false, propio = false, type = 'text', valor = '') {
    this.id = id; this.editable = editable; this.propio = propio; this.type = type; this.value = valor;
  }
  closest(selector: string) {
    if (selector.includes('data-lector-propio')) return this.propio ? this : null;
    return this.editable ? this : null;
  }
  dispatchEvent(e: { type: string }) { this.eventos.push(e.type); }
}

const ESCANEO = '7501234567890';
const URL_VALE = 'https://dolarones.eldolaron.com/v#2' + '1'.repeat(29);

/** La caja real: lector.js + la línea de caja.html, con reloj y ventana abierta controlables. */
function armar() {
  let t = 1000, abierta = false;
  const escaneos: { codigo: string; efectivoAlLeer: string }[] = [];
  let oyente: ((e: unknown) => void) | undefined;
  const nodos = {
    body: new Nodo('body'),
    boton: new Nodo('cobrar-efectivo'),
    efectivo: new Nodo('efectivo', true, false, 'number', '500'),
    socio: new Nodo('socio', true, false, 'text', '#7'),
    selector: new Nodo('vendedora', true, false, 'select-one', 'ana'),
    codigo: new Nodo('codigo', true, true),
    dialogo: new Nodo('dev-q', true),
  };
  let foco = 'body';
  const contexto: Record<string, unknown> = {
    performance: { now: () => t }, setTimeout, clearTimeout, Event, console,
    document: { addEventListener: (_t: string, f: (e: unknown) => void) => { oyente = f; }, removeEventListener() {}, querySelector: () => (abierta ? {} : null) },
    escanear: (codigo: string) => escaneos.push({ codigo, efectivoAlLeer: nodos.efectivo.value }),
    $: (id: string) => ({ focus: () => { foco = id; } }),
  };
  runInNewContext(`${lectorJs}\n${cableado}`, contexto);
  assert.ok(oyente, 'no se registró el oyente de teclado');
  const tecla = (target: Nodo, key: string) => {
    const e = { key, target, prevenido: false, detenido: false, preventDefault() { this.prevenido = true; }, stopImmediatePropagation() { this.detenido = true; } };
    oyente!(e);
    return e;
  };
  /** Como el navegador: el manejador corre y DESPUÉS la tecla se escribe en el campo con foco. */
  const teclea = (target: Nodo, texto: string, hueco: number) => {
    for (const key of texto) {
      t += hueco;
      const e = tecla(target, key);
      // Un input number solo acepta dígitos y unos pocos signos; el resto de las teclas no llega a su valor.
      if (target.editable && !e.prevenido && (target.type !== 'number' || /[\d.e]/.test(key))) target.value += key;
    }
  };
  const enter = (target: Nodo) => { t += 15; return tecla(target, 'Enter'); };
  return { nodos, escaneos, tecla, teclea, enter, abrirVentana: (v: boolean) => { abierta = v; }, foco: () => foco, pasa: (ms: number) => { t += ms; } };
}

test('#913 ráfaga + Enter con el foco en el body o en un botón agrega la pieza, y el foco queda en #codigo', () => {
  for (const sitio of ['body', 'boton'] as const) {
    const c = armar();
    c.teclea(c.nodos[sitio], ESCANEO, 15);
    const e = c.enter(c.nodos[sitio]);
    assert.deepEqual(c.escaneos.map((x) => x.codigo), [ESCANEO], sitio);
    assert.equal(e.prevenido, true, `${sitio}: el Enter del lector no pulsa el botón`);
    assert.equal(e.detenido, true);
    assert.equal(c.foco(), 'codigo', sitio);
  }
});

test('#913 ráfaga + Enter con el foco en «Efectivo recibido» agrega la pieza y el campo conserva su valor previo', () => {
  const c = armar();
  c.teclea(c.nodos.efectivo, ESCANEO, 15);
  assert.notEqual(c.nodos.efectivo.value, '500', 'el navegador sí escribió en el campo a media ráfaga');
  c.enter(c.nodos.efectivo);
  assert.deepEqual(c.escaneos.map((x) => x.codigo), [ESCANEO]);
  assert.equal(c.nodos.efectivo.value, '500');
  assert.equal(c.escaneos[0].efectivoAlLeer, '500', 'el campo se restaura ANTES de leer: el destino puede escribir en él');
  assert.deepEqual(c.nodos.efectivo.eventos, ['input', 'change'], 'se avisa a la pantalla para que recalcule el cambio');
  assert.equal(c.foco(), 'codigo');
});

test('#913 otros campos y selectores también quedan como estaban (y #socio: lo que lee el lector se trata como código)', () => {
  const c = armar();
  c.teclea(c.nodos.selector, ESCANEO, 15);
  c.enter(c.nodos.selector);
  c.teclea(c.nodos.socio, URL_VALE, 15);   // el QR del vale trae : / . #
  c.enter(c.nodos.socio);
  assert.deepEqual(c.escaneos.map((x) => x.codigo), [ESCANEO, URL_VALE]);
  assert.equal(c.nodos.selector.value, 'ana');
  assert.equal(c.nodos.socio.value, '#7');
});

test('#913 un lector que manda mayúsculas con Shift no parte la ráfaga', () => {
  const c = armar();
  for (const key of ['Shift', 'J', 'Shift', 'U', '4', '9']) { c.pasa(15); c.tecla(c.nodos.body, key); }
  c.enter(c.nodos.body);
  assert.deepEqual(c.escaneos.map((x) => x.codigo), ['JU49']);
});

test('#913 lo que una persona teclea despacio no cambia: ni se agrega, ni se desvía, ni se pierde su Enter', () => {
  for (const campo of ['efectivo', 'socio'] as const) {
    const c = armar();
    const antes = c.nodos[campo].value;
    c.teclea(c.nodos[campo], '4500', 120);
    assert.equal(c.nodos[campo].value, antes + '4500', `${campo}: lo tecleado queda`);
    const e = c.enter(c.nodos[campo]);
    assert.equal(c.escaneos.length, 0, campo);
    assert.equal(e.prevenido, false, `${campo}: el Enter de una persona no se come`);
    assert.equal(c.nodos[campo].value, antes + '4500');
    assert.deepEqual(c.nodos[campo].eventos, []);
  }
  // Tres teclas seguidas rápidas y Enter tampoco son un código (hace falta 4 o más).
  const corto = armar();
  corto.teclea(corto.nodos.efectivo, '450', 15);
  assert.equal(corto.enter(corto.nodos.efectivo).prevenido, false);
  assert.equal(corto.nodos.efectivo.value, '500450');
  assert.equal(corto.escaneos.length, 0);
});

test('#913 con una ventana abierta no cambia nada: la ráfaga no llega a la venta ni toca ningún campo', () => {
  const c = armar();
  c.abrirVentana(true);
  for (const sitio of ['dialogo', 'body', 'efectivo'] as const) {
    c.teclea(c.nodos[sitio], ESCANEO, 15);
    const e = c.enter(c.nodos[sitio]);
    assert.equal(e.prevenido, false, sitio);
    assert.equal(e.detenido, false, sitio);
  }
  assert.equal(c.escaneos.length, 0);
  assert.equal(c.foco(), 'body');
  assert.deepEqual(c.nodos.efectivo.eventos, []);
  // Se cierra la ventana: el lector vuelve a la venta.
  c.abrirVentana(false);
  c.teclea(c.nodos.body, ESCANEO, 15);
  c.enter(c.nodos.body);
  assert.deepEqual(c.escaneos.map((x) => x.codigo), [ESCANEO]);
});

test('#913 #codigo conserva su propio Enter: el lector global no lo procesa (nada se agrega dos veces ni se duplican caracteres)', () => {
  assert.match(fuente, /<input id="codigo" data-lector-propio /, '#codigo se marca como destino propio del escaneo');
  const c = armar();
  c.teclea(c.nodos.codigo, ESCANEO, 15);
  assert.equal(c.nodos.codigo.value, ESCANEO, 'el campo escribe lo suyo, una sola vez');
  const e = c.enter(c.nodos.codigo);
  assert.equal(c.escaneos.length, 0, 'el manejador de #codigo es el único que lo agrega');
  assert.equal(e.prevenido, false);
  assert.equal(e.detenido, false, 'el Enter sigue hasta el manejador de #codigo');
  assert.equal(c.foco(), 'body');
});

test('#913 la ráfaga sin sufijo Enter (80 ms) también entra desde un botón y el Enter tardío se come una sola vez', () => {
  let t = 0, tic: (() => void) | undefined; const leidos: string[] = [];
  const lector = crearLector({ emitir: (d) => leidos.push(d.codigo), libre: () => true, ahora: () => t, esperar: (f) => { tic = f; return 1; }, cancelar: () => { tic = undefined; } });
  const boton = new Nodo('cobrar-tarjeta');
  for (const key of '1234') { t += 15; lector.tecla({ key, target: boton, preventDefault() {}, stopImmediatePropagation() {} }); }
  tic!();
  assert.deepEqual(leidos, ['1234']);
  let prevenido = 0;
  lector.tecla({ key: 'Enter', target: boton, preventDefault() { prevenido++; }, stopImmediatePropagation() {} });
  assert.equal(prevenido, 1);
});

test('#913 sin la opción `libre`, lector.js se porta igual que en inventario: un campo ajeno lo detiene', () => {
  let t = 0; const leidos: string[] = [];
  const lector = crearLector({ emitir: (d) => leidos.push(d.codigo), ahora: () => t, esperar: () => 1, cancelar: () => {} });
  const campo = new Nodo('otro', true);
  for (const key of ESCANEO) { t += 15; lector.tecla({ key, target: campo, preventDefault() {}, stopImmediatePropagation() {} }); }
  let prevenido = false;
  lector.tecla({ key: 'Enter', target: campo, preventDefault() { prevenido = true; }, stopImmediatePropagation() {} });
  assert.deepEqual(leidos, []);
  assert.equal(prevenido, false);
});
