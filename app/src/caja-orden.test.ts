// node --test src/caja-orden.test.ts
// Issue #931: caja reordenada. Lógica pura (orden en pantalla, contador de avisos) y el cableado REAL de caja.html
// (paneles «Avisos» y «Más», Esc, foco) contra un DOM mínimo, sin navegador. El lector, la impresora y la pantalla de la tienda siguen pidiendo prueba física.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { agregar, agregarYMarcar, ordenEnPantalla, resumenAvisos } from '../public/venta.js';
import { crearLector } from '../public/lector.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const pieza = (codigo: string, precio = 1000) => ({ codigo, nombre: codigo, precio, producto_id: codigo });

/* ---------- orden en pantalla ---------- */

test('#931 orden: lo recién escaneado va primero; una pieza repetida que ya estaba sube sin duplicarse ni cambiar de lugar en los datos', () => {
  let l: any[] = [];
  l = agregarYMarcar(l, pieza('A'), 1, 1000);
  l = agregarYMarcar(l, pieza('B'), 1, 1001);
  l = agregarYMarcar(l, pieza('C'), 1, 1002);
  assert.deepEqual(ordenEnPantalla(l).map((i) => l[i].codigo), ['C', 'B', 'A']);
  l = agregarYMarcar(l, pieza('A'), 1, 1003);   // A ya estaba: suma una pieza y pasa al primer renglón
  assert.equal(l.length, 3, 'no se duplica');
  assert.equal(l[0].cantidad, 2);
  assert.deepEqual(l.map((x) => x.codigo), ['A', 'B', 'C'], 'los datos siguen en orden de captura');
  assert.deepEqual(ordenEnPantalla(l).map((i) => l[i].codigo), ['A', 'C', 'B']);
});

test('#931 orden: el sello nunca empata ni retrocede aunque el reloj no avance; agregar() sigue igual que siempre', () => {
  let l: any[] = [];
  for (const c of ['A', 'B', 'A', 'C']) l = agregarYMarcar(l, pieza(c), 1, 5000);   // mismo milisegundo
  assert.deepEqual(ordenEnPantalla(l).map((i) => l[i].codigo), ['C', 'A', 'B']);
  assert.equal(new Set(l.map((x) => x.tocada)).size, 3);
  // Lo marcado se distingue de lo que agregar() devuelve solo por `tocada`.
  const sin = agregar(agregar([], pieza('A')), pieza('B'));
  assert.deepEqual(sin.map((x: any) => 'tocada' in x), [false, false]);
  // «Sin etiqueta» (renglones propios) sigue sin juntarse y el último queda arriba.
  const libre = { codigo: 'LIBRE', nombre: 'x', precio: 500, producto_id: 'libre', libre: true };
  let m = agregarYMarcar(agregarYMarcar([], libre, 1, 1), libre, 1, 2);
  assert.equal(m.length, 2);
  assert.deepEqual(ordenEnPantalla(m), [1, 0]);
});

test('#931 orden: ordenEnPantalla no toca el arreglo y sin sello (ticket anterior a este cambio, pedido) el más nuevo es el último de la lista', () => {
  const l = [{ codigo: 'A' }, { codigo: 'B' }, { codigo: 'C' }];
  assert.deepEqual(ordenEnPantalla(l), [2, 1, 0]);
  assert.deepEqual(l.map((x) => x.codigo), ['A', 'B', 'C']);
  assert.deepEqual(ordenEnPantalla([]), []);
});

test('#931 la caja arma el envío campo por campo: el sello de pantalla no tiene por dónde viajar', () => {
  const cobro = entre('async function cobrar(', 'let sincronizando = false;');
  assert.match(cobro, /lineas: lineas\.map\(\(\{ codigo, nombre, precio, precio_lista, cantidad, producto_id, en_mano, descripcion \}\) =>/);
  assert.doesNotMatch(cobro, /tocada/);
  assert.doesNotMatch(fuente, /lineas\.(reverse|sort)\(/, 'ningún orden se aplica sobre los datos del ticket');
});

/* ---------- contador de avisos ---------- */

test('#931 avisos: lo que pide atención suma al número rojo; las promos se listan y no suman', () => {
  const t = { impresora: 'Impresora: USB falló', subir: '⚠ 2 ventas sin enviar', reloj: '⚠ reloj', promo: 'Quedan 12 lugares', buenfin: '', fallaImpresion: false };
  const nada = resumenAvisos({ servidor: [], impresora: 'ok', subir: 'ok', catalogo: 'ok', reloj: false, rechazadas: 0 }, t);
  assert.equal(nada.total, 0);
  assert.deepEqual(nada.informativos, [{ texto: 'Quedan 12 lugares', dorado: true }], 'la promo se muestra pero no cuenta');
  const aviso = resumenAvisos({ servidor: ['📦 1 venta de Mercado Libre por atender'], impresora: 'aviso', subir: 'aviso', reloj: false, rechazadas: 0 }, t);
  assert.equal(aviso.total, 1, 'ámbar (impresora sin conectar, ventas por subir recientes) no suma');
  const todo = resumenAvisos({ servidor: ['a', 'b'], impresora: 'rojo', subir: 'rojo', reloj: true, rechazadas: 3 }, { ...t, fallaImpresion: true });
  assert.equal(todo.total, 2 + 1 + 1 + 1 + 1 + 3);
  assert.deepEqual(todo.rojos.map((r: any) => r.texto), ['a', 'b', 'Impresora: USB falló', '⚠ 2 ventas sin enviar', '⚠ reloj']);
  assert.ok(todo.rojos.slice(0, 2).every((r: any) => r.enlace === '/avisos'));
});

/* ---------- paneles «Avisos» y «Más»: teclado, foco y Esc ---------- */

class Falso {
  id: string; hidden: boolean; mundo?: { activo: string };
  atributos: Record<string, string> = {}; oyentes: Record<string, ((e: any) => unknown)[]> = {};
  constructor(id: string, hidden = false, mundo?: { activo: string }) { this.id = id; this.hidden = hidden; this.mundo = mundo; }
  setAttribute(k: string, v: string) { this.atributos[k] = v; }
  addEventListener(t: string, f: (e: any) => unknown) { (this.oyentes[t] ??= []).push(f); }
  focus() { if (this.mundo) this.mundo.activo = this.id; }
}

function montarPaneles() {
  const mundo = { activo: 'codigo' };
  const el = new Map<string, Falso>();
  const estado = { lineas: [{ codigo: 'A' }, { codigo: 'B' }], aviso: '', cancelados: 0, dialogoAbierto: false };
  const $ = (id: string) => {
    if (!el.has(id)) {
      const f: any = new Falso(id, id.startsWith('panel-'), mundo);
      f.style = {};
      Object.defineProperty(f, 'textContent', { get: () => estado.aviso, set: (v: string) => { if (id === 'aviso') estado.aviso = v; } });
      f.click = () => { if (id === 'cancelar') estado.cancelados++; };
      el.set(id, f);
    }
    return el.get(id)!;
  };
  const doc = new Falso('document');
  // Los dos trozos reales de caja.html: los paneles y el doble Esc.
  const codigo = `${entre('const PANELES =', '// Estado de lo que pide atención')}
    ${entre('// Doble Esc borra el ticket completo', '// Con descuento aprobado')}`;
  runInNewContext(codigo, { $, document: Object.assign(doc, { querySelector: () => (estado.dialogoAbierto ? {} : null) }), get lineas() { return estado.lineas; } });
  const tecla = (key: string, extra: Record<string, unknown> = {}) => { for (const f of doc.oyentes.keydown ?? []) f({ key, repeat: false, timeStamp: 10000, ...extra }); };
  const clic = (id: string) => { const e = { stopPropagation() { this.parado = true; }, parado: false, target: { closest: () => null } }; for (const f of $(id).oyentes.click ?? []) f(e); return e; };
  return { $, doc, mundo, estado, tecla, clic };
}

test('#931 teclado: «Avisos» y «Más» abren y cierran (clic, mismo botón, Esc), aria-expanded lo dice y al cerrar el foco vuelve a #codigo', () => {
  const p = montarPaneles();
  for (const [boton, panel] of [['abrir-avisos', 'panel-avisos'], ['abrir-mas', 'panel-mas']]) {
    p.clic(boton);
    assert.equal(p.$(panel).hidden, false, `${panel} abre`);
    assert.equal(p.$(boton).atributos['aria-expanded'], 'true');
    p.mundo.activo = boton;   // el clic dejó el foco en el botón
    p.tecla('Escape');
    assert.equal(p.$(panel).hidden, true, `Esc cierra ${panel}`);
    assert.equal(p.$(boton).atributos['aria-expanded'], 'false');
    assert.equal(p.mundo.activo, 'codigo', 'el foco vuelve a #codigo');
    p.clic(boton); p.clic(boton);   // abre y cierra con el mismo botón
    assert.equal(p.$(panel).hidden, true);
    assert.equal(p.mundo.activo, 'codigo');
  }
  // Abrir uno cierra el otro: nunca hay dos.
  p.clic('abrir-avisos'); p.clic('abrir-mas');
  assert.deepEqual([p.$('panel-avisos').hidden, p.$('panel-mas').hidden], [true, false]);
});

test('#931 Esc que cierra un panel NUNCA cuenta para el doble Esc que borra el ticket; sin panel abierto el doble Esc sigue igual', () => {
  const p = montarPaneles();
  p.clic('abrir-avisos');
  p.tecla('Escape', { timeStamp: 10100 });
  p.tecla('Escape', { timeStamp: 10300 });   // el primero cerró el panel; este es el primer Esc «de verdad»
  assert.equal(p.estado.cancelados, 0, 'el ticket sigue');
  assert.match(p.estado.aviso, /Esc otra vez para borrar el ticket/);
  p.tecla('Escape', { timeStamp: 10500 });   // este sí es el segundo
  assert.equal(p.estado.cancelados, 1, 'sin panel abierto el doble Esc cancela como siempre');
  // Y un panel abierto entre los dos Esc no los junta.
  const q = montarPaneles();
  q.tecla('Escape', { timeStamp: 10100 });
  q.clic('abrir-mas');
  q.tecla('Escape', { timeStamp: 10200 });   // cierra «Más»: no es el segundo Esc
  assert.equal(q.estado.cancelados, 0);
  q.tecla('Escape', { timeStamp: 10300 });   // un Esc suelto dentro de la ventana: el panel ya reinició el reloj, así que tampoco cancela
  assert.equal(q.estado.cancelados, 0, 'Esc, abrir «Más», Esc, Esc no borra el ticket');
  q.tecla('Escape', { timeStamp: 10400 });   // este sí es el segundo Esc seguido de verdad
  assert.equal(q.estado.cancelados, 1);
});

test('#931 los paneles no son <dialog>: el lector sigue activo con uno abierto, el escaneo no se pierde y cae en #codigo; un escaneo los cierra sin mover el foco', () => {
  assert.match(fuente, /<div class="flota" id="panel-avisos" hidden>/);
  assert.match(fuente, /<div class="flota" id="panel-mas" hidden>/);
  assert.doesNotMatch(fuente, /<dialog id="panel-/);
  // Con paneles abiertos `libre()` (ninguna ventana abierta) es verdadero: la ráfaga del lector llega a la caja aunque el foco esté en el botón del panel.
  const libre = new Function('document', `return () => !document.querySelector('dialog[open]')`)({ querySelector: () => null });
  const lecturas: string[] = [];
  const reloj = { t: 0 };
  const lector = crearLector({ emitir: ({ codigo }: { codigo: string }) => lecturas.push(codigo), libre, ahora: () => reloj.t, esperar: () => 0, cancelar: () => {} });
  const botonPanel = { closest: () => null };   // el foco quedó en «Avisos»
  let enterEvitado = false;
  for (const k of '7501234') { reloj.t += 10; lector.tecla({ key: k, target: botonPanel }); }
  lector.tecla({ key: 'Enter', target: botonPanel, preventDefault() { enterEvitado = true; }, stopImmediatePropagation() {} });
  assert.deepEqual(lecturas, ['7501234']);
  assert.equal(enterEvitado, true, 'el Enter del lector no pulsa el botón que tenga el foco');
  // El evento `lectura` cierra los paneles sin cambiar el foco (el lector ya lo manda a #codigo).
  const p = montarPaneles();
  p.clic('abrir-avisos');
  p.mundo.activo = 'otro';
  for (const f of p.doc.oyentes.lectura ?? []) f({});
  assert.equal(p.$('panel-avisos').hidden, true);
  assert.equal(p.mundo.activo, 'otro', 'cerrar por escaneo no roba el foco');
});

test('#931 el escaneo vive junto a su aviso: #aviso conserva su nodo y su lugar entre el campo y las sugerencias, y los controles viejos siguen con su id', () => {
  assert.match(fuente, /<div id="aviso" role="status"><\/div>/);
  assert.ok(fuente.indexOf('id="codigo"') < fuente.indexOf('id="aviso"') && fuente.indexOf('id="aviso"') < fuente.indexOf('id="ticket"'));
  const ids = ['abrir-corte', 'abrir-retiro', 'abrir-guia', 'pedir-ayuda', 'alta-socios', 'marcar-entrada', 'cerrar-sesion', 'pedir-descuento', 'abrir-devolucion', 'abrir-cajon', 'cancelar',
    'tickets', 'vale-folio', 'vale-por-folio', 'cupon-manual', 'modo-remoto', 'imprimir-en', 'efectivo', 'rapidos', 'cambio', 'cobrar-efectivo', 'cobrar-tarjeta', 'cobrar-transferencia',
    'cobrar-sin-dinero', 'socio', 'dolarones', 'pedido-cargado', 'datos-transferencia', 'rechazadas', 'impresiones-aviso', 'abrir-impresion-fallida', 'promo-cupo', 'buenfin', 'franja-meta',
    'corte', 'pendientes', 'reloj', 'catalogo-info', 'impresora-estado', 'conectar-impresora', 'impresiones-destino', 'aviso-remoto'];
  for (const id of ids) assert.equal(fuente.split(`id="${id}"`).length - 1, 1, `#${id} está una vez`);
  assert.match(fuente, /<div id="franja-meta" hidden>\s*<span id="meta-nombre"><\/span>/, 'la barra de la meta (#940) vive en su lugar, oculta hasta que llega el dato');
});

test('#931 cobro: efectivo, rápidos, cambio y los botones de cobro están juntos fuera de la parte que se desplaza; socio, Dolarones, pedido y transferencia, dentro', () => {
  const medio = entre('<div id="cobro-medio">', '<div id="cobro-pago">');
  const pago = entre('<div id="cobro-pago">', '</section>');
  for (const id of ['socio', 'dolarones', 'pedido-cargado', 'datos-transferencia', 'vendedora', 'mas-opciones']) assert.ok(medio.includes(`id="${id}"`), `${id} se desplaza`);
  for (const id of ['efectivo', 'rapidos', 'cambio', 'cobrar-efectivo', 'cobrar-tarjeta', 'cobrar-transferencia', 'cobrar-sin-dinero', 'aviso-remoto', 'cancelar', 'abrir-cajon', 'abrir-devolucion', 'pedir-descuento'])
    assert.ok(pago.includes(`id="${id}"`), `${id} no se desplaza`);
  // Si ni así cabe (ventana baja, zoom), la columna entera se desplaza: la parte de en medio tiene su mínimo y #cobro su respaldo.
  assert.match(fuente, /#cobro-medio \{ flex: 1 1 auto; min-height: 130px; overflow-y: auto;/);
  assert.match(fuente, /#cobro \{ overflow-y: auto; \}/);
  assert.doesNotMatch(fuente, /#cobro \{ overflow: hidden; \}/);
  // Sin forma de pago por omisión: ningún botón de cobro lleva `autofocus` ni deja de ignorar el Enter del lector.
  assert.doesNotMatch(pago, /autofocus/);
});

test('#931 «Imprimir en otra caja» vive en «Más opciones», pero con el modo activo se ve junto a los botones por qué falta «Efectivo»', () => {
  const bloque = entre('function pintarImpresionRemota()', 'function exigirCaja()');
  const el: Record<string, any> = {};
  const $ = (id: string) => (el[id] ??= { hidden: false, textContent: '', value: '' });
  const correr = (remota: boolean) => {
    runInNewContext(`${bloque}; pintarImpresionRemota()`, { $, impresionRemota: () => remota, impresoraLista: () => false, cobrando: false });
  };
  correr(true);
  assert.equal(el['aviso-remoto'].hidden, false);
  assert.match(el['aviso-remoto'].textContent, /se imprime en otra caja.*no hay «Efectivo»/);
  assert.equal(el['cobrar-efectivo'].hidden, true);
  assert.match(el['mas-opciones-resumen'].textContent, /otra caja/);
  correr(false);
  assert.equal(el['aviso-remoto'].hidden, true);
  assert.equal(el['aviso-remoto'].textContent, '');
  assert.ok(entre('<div id="cobro-medio">', '<div id="cobro-pago">').includes('id="modo-remoto"'));
});

test('#931 un escaneo cierra los paneles aunque el foco ya esté en #codigo (el evento `lectura` no cubre ese caso) y no mueve el foco', () => {
  const llamadas: unknown[] = [];
  const escanear = runInNewContext(`${entre('function escanear(', '// Sugerencia resaltada')}; escanear`, {
    cerrarPaneles: (o: unknown) => llamadas.push(o), agregarCodigo: () => true, sonar() {}, TONO_PIEZA: {}, TONO_RECHAZO: {},
  });
  escanear('7501234567890');
  assert.deepEqual(JSON.parse(JSON.stringify(llamadas)), [{ enfocar: false }]);
  // Con el panel real abierto y el foco ya en #codigo, el escaneo lo cierra y el foco queda donde estaba.
  const p = montarPaneles();
  p.clic('abrir-avisos');
  p.mundo.activo = 'codigo';
  const cerrar = runInNewContext(`${entre('const PANELES =', '// Estado de lo que pide atención')}; cerrarPaneles`, { $: p.$, document: p.doc });
  cerrar({ enfocar: false });
  assert.equal(p.$('panel-avisos').hidden, true);
  assert.equal(p.mundo.activo, 'codigo');
});

test('#931 «Avisos» dice con palabras «venta rechazada» y se pone rojo mientras haya una; sin ellas vuelve a lo normal; nada toma el foco', () => {
  const el: Record<string, any> = {};
  const nodo = () => ({ children: [] as any[], className: '', textContent: '', append(...h: any[]) { this.children.push(...h); }, set href(_v: string) {} });
  const $ = (id: string) => (el[id] ??= {
    hidden: id === 'promo-cupo' || id === 'buenfin', textContent: '', dataset: {}, atributos: {} as Record<string, string>, clases: new Set<string>(), foco: 0,
    classList: { toggle(c: string, v: boolean) { v ? el[id].clases.add(c) : el[id].clases.delete(c); } },
    setAttribute(k: string, v: string) { this.atributos[k] = v; }, removeAttribute(k: string) { delete this.atributos[k]; },
    replaceChildren(...h: any[]) { this.hijos = h; }, focus() { this.foco++; },
  });
  const pintarAvisos = runInNewContext(`${entre('const senales =', '// Lo que una acción revela')}; pintarAvisos`, {
    $, resumenAvisos, document: { createElement: nodo }, JSON, Object,
  });
  pintarAvisos({ rechazadas: 1 });
  assert.equal($('avisos-rechazo').hidden, false);
  assert.equal($('avisos-rechazo').textContent, '· venta rechazada');
  assert.ok($('abrir-avisos').clases.has('urgente'));
  assert.match($('abrir-avisos').atributos['aria-label'], /hay una venta rechazada.*ya cobrado/);
  assert.equal($('avisos-n').textContent, '1');
  pintarAvisos({ rechazadas: 3 });
  assert.equal($('avisos-rechazo').textContent, '· ventas rechazadas');
  assert.match($('abrir-avisos').atributos['aria-label'], /hay 3 ventas rechazadas/);
  pintarAvisos({ rechazadas: 0 });
  assert.equal($('avisos-rechazo').hidden, true);
  assert.ok(!$('abrir-avisos').clases.has('urgente'));
  assert.equal('aria-label' in $('abrir-avisos').atributos, false);
  assert.equal(Object.values(el).reduce((n: number, e: any) => n + e.foco, 0), 0, 'pintarAvisos nunca enfoca nada');
  assert.match(fuente, /<span id="avisos-rechazo" hidden><\/span>/);
});

test('#931 franja: sin promo ni barra de meta a la vista no ocupa lugar; con cualquiera reaparece (regla CSS sobre sus hijos)', () => {
  assert.match(fuente, /#franja:not\(:has\(> :not\(\[hidden\]\)\)\) \{ display: none; \}/);
  assert.match(fuente, /<div id="franja">\s*<div id="franja-meta" hidden>[\s\S]*?<\/div>\s*<span id="promo-cupo" role="status" hidden><\/span>\s*<span id="buenfin" role="status" hidden><\/span>/);
});

test('#931 lo que una acción revela se acerca a la vista dentro de la parte que se desplaza, sin tocar el foco', () => {
  const bloque = entre('// Lo que una acción revela', 'contarAvisos();');
  assert.match(bloque, /\['datos-transferencia', 'descuento-form', 'pagar-dolarones'\]/);
  assert.match(bloque, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.doesNotMatch(bloque, /\.focus\(/);
});
