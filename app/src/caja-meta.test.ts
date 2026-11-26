// node --test src/caja-meta.test.ts
// Issue #940: barra de la meta semanal de la tienda en la franja de /caja. El bloque REAL de caja.html contra un DOM mínimo, sin navegador:
// pinta con metas, se oculta sin metas, conserva el último valor con error, no apila peticiones, el «?» se comporta como «Avisos» y «Más», sin importes.
// El lector, la pantalla real de la tienda y la red mala siguen pidiendo prueba física.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as retos from '../public/retos.js';
import { crearLector } from '../public/lector.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};

/* ---------- DOM mínimo ---------- */

class Falso {
  hidden = false; textContent = ''; innerHTML = ''; title = ''; value = '';
  style: Record<string, string> = {}; atributos: Record<string, string> = {}; clases = new Set<string>();
  oyentes: Record<string, ((e: any) => unknown)[]> = {};
  classList = { toggle: (c: string, on: boolean) => { if (on) this.clases.add(c); else this.clases.delete(c); } };
  id: string; mundo?: { activo: string };
  constructor(id: string, mundo?: { activo: string }) { this.id = id; this.mundo = mundo; this.hidden = id.startsWith('panel-') || id === 'franja-meta'; }
  setAttribute(k: string, v: string) { this.atributos[k] = v; }
  addEventListener(t: string, f: (e: any) => unknown) { (this.oyentes[t] ??= []).push(f); }
  focus() { if (this.mundo) this.mundo.activo = this.id; }
}
const mundoDom = () => {
  const mundo = { activo: 'codigo' };
  const el = new Map<string, Falso>();
  const $ = (id: string) => { if (!el.has(id)) el.set(id, new Falso(id, mundo)); return el.get(id)!; };
  return { mundo, $ };
};

/** El bloque real de caja.html, con retos.js ya cargado (en la página se baja con import(), que aquí no existe). */
const bloqueMeta = () => entre('const META = {', '/* ---------- fin de la meta semanal (#940) ---------- */')
  .replace(/^let RETOS = null;$/m, 'let RETOS = __retos;').replace(/^import\('\/retos\.js'\).*$/m, '');

/* ---------- la barra: pintar, ocultar, conservar, no apilar ---------- */

const metas = (...pcts: number[]) => pcts.map((pct, i) => ({ n: i + 1, pct, lograda: pct > 100 }));   // >100 = lograda (los porcentajes son de ejemplo)
const datos = (m: { n: number; pct: number; lograda: boolean }[], dia = 3) => ({ tienda: 'Tienda de prueba', metas: m, dia, por_delante: true });

function montarBarra() {
  const { $, mundo } = mundoDom();
  const peticiones: { url: string; resolver: (r: unknown) => void; rechazar: (e: unknown) => void }[] = [];
  const estado = { oculta: false, intervalos: 0, ultimoIntervalo: null as null | (() => void) };
  const documento = new Falso('document');
  Object.defineProperty(documento, 'hidden', { get: () => estado.oculta });
  const fetchFalso = (url: string, opciones: { signal?: unknown }) => {
    assert.ok(opciones?.signal, 'toda petición lleva su tope de espera');
    return new Promise((resolver, rechazar) => peticiones.push({ url, resolver: resolver as never, rechazar }));
  };
  const codigo = `${bloqueMeta()}
    ;({ META, refrescarMeta, pintarMeta, recibirMeta, htmlPanelMetas, metaValida })`;
  const api = runInNewContext(codigo, {
    __retos: retos, $, document: documento, fetch: fetchFalso, AbortSignal: { timeout: () => ({}) }, escapar: (t: unknown) => String(t),
    setInterval: () => { estado.intervalos++; return 1; }, setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, Date, Number, Math, Array,
  }) as any;
  const responder = (i: number, cuerpo: unknown, ok = true) => peticiones[i].resolver({ ok, json: async () => cuerpo });
  const vacio = () => new Promise((r) => setImmediate(r));
  return { $, api, peticiones, estado, responder, vacio, mundo };
}

test('#940 pinta la meta más cercana sin lograr, su porcentaje, la marca de ritmo y si va por delante; la lista del «?» marca las logradas', async () => {
  const b = montarBarra();
  await b.vacio();
  assert.equal(b.peticiones.length, 1, 'al abrir la caja pide una vez');
  assert.equal(b.peticiones[0].url, '/api/caja/meta');
  assert.equal(b.$('franja-meta').hidden, true, 'hasta que llega el dato no se ve');
  b.responder(0, datos([{ n: 1, pct: 100, lograda: true }, { n: 2, pct: 62, lograda: false }, { n: 3, pct: 31, lograda: false }, { n: 4, pct: 20, lograda: false }, { n: 5, pct: 12, lograda: false }], 3));
  await b.vacio();
  assert.equal(b.$('franja-meta').hidden, false);
  assert.equal(b.$('meta-nombre').textContent, 'Meta 2');
  assert.equal(b.$('meta-pct').textContent, '62 %');
  assert.equal(b.$('meta-relleno').style.width, '62%');
  assert.equal(b.$('meta-marca').style.left, `${retos.ritmoPct(3)}%`);
  assert.equal(b.$('meta-ritmo').textContent, '▲ Por delante del ritmo');
  assert.match(b.$('meta-barra').atributos['aria-label'], /62 por ciento.*ritmo esperado hoy es 43 por ciento/);
  const lista = b.$('panel-meta').innerHTML;
  assert.match(lista, /✓ Meta 1 · Arranca el bono[\s\S]*Lograda/);
  for (const nombre of ['Meta 2', 'Meta 3', 'Meta 4', 'La grande']) assert.ok(lista.includes(nombre), nombre);
  assert.equal((lista.match(/meta-fila/g) ?? []).length, 5);
});

test('#940 la primera meta se llama «Arranca el bono»; por detrás del ritmo lo dice sin culpa; con todas logradas, celebración', async () => {
  const b = montarBarra();
  await b.vacio();
  b.responder(0, datos(metas(10, 8, 5, 3, 1), 5));
  await b.vacio();
  assert.equal(b.$('meta-nombre').textContent, 'Meta 1 · Arranca el bono');
  assert.equal(b.$('meta-ritmo').textContent, '▼ Por detrás del ritmo');
  assert.ok(b.$('meta-ritmo').clases.has('atras'));
  b.api.recibirMeta(datos(metas(150, 140, 130, 120, 110), 5));   // todas logradas
  assert.equal(b.$('meta-ritmo').textContent, '¡Lograda: La grande!', 'primero el aviso de lo recién logrado');
  b.api.META.avisoHasta = 0;
  b.api.pintarMeta();
  assert.equal(b.$('meta-nombre').textContent, 'Todas las metas');
  assert.equal(b.$('meta-pct').textContent, '100 %');
  assert.match(b.$('meta-ritmo').textContent, /Todas las metas logradas/);
  assert.equal(b.$('meta-marca').hidden, true);
  // La última se llama «La grande»: es la meta actual cuando solo queda ella.
  b.api.recibirMeta(datos([...metas(150, 140, 130, 120), { n: 5, pct: 77, lograda: false }], 6));
  assert.equal(b.$('meta-nombre').textContent, 'La grande');
});

test('#940 meta lograda: aviso breve en la franja y pasa a la siguiente; la primera lectura solo fija el punto de partida', async () => {
  const b = montarBarra();
  await b.vacio();
  b.responder(0, datos([{ n: 1, pct: 130, lograda: true }, { n: 2, pct: 98, lograda: false }, { n: 3, pct: 40, lograda: false }], 4));
  await b.vacio();
  assert.doesNotMatch(b.$('meta-ritmo').textContent, /Lograda/, 'al abrir la caja con una meta ya lograda no se celebra otra vez');
  b.api.recibirMeta(datos([{ n: 1, pct: 130, lograda: true }, { n: 2, pct: 104, lograda: true }, { n: 3, pct: 41, lograda: false }], 4));
  assert.equal(b.$('meta-ritmo').textContent, '¡Lograda: Meta 2!');
  assert.equal(b.$('meta-nombre').textContent, 'La grande', 'ya apunta a la siguiente');
  assert.ok(b.$('meta-ritmo').clases.has('aviso'));
  // Pasado el aviso (el reloj pasó de avisoHasta) vuelve el estado de ritmo.
  b.api.META.avisoHasta = 0;
  b.api.pintarMeta();
  assert.match(b.$('meta-ritmo').textContent, /ritmo/);
});

test('#940 sin metas (tienda sin línea o bono sin fecha de inicio) la barra sigue oculta y cierra el «?» si estaba abierto; sin dato nunca aparece', async () => {
  const b = montarBarra();
  await b.vacio();
  b.responder(0, datos([], 3));
  await b.vacio();
  assert.equal(b.$('franja-meta').hidden, true);
  assert.equal(b.$('panel-meta').hidden, true);
  // Con metas primero y luego sin ellas (cambió la tienda o el bono): se oculta y el «?» abierto se cierra.
  b.api.recibirMeta(datos(metas(10, 5), 3));
  b.$('panel-meta').hidden = false;
  b.api.recibirMeta(datos([], 3));
  assert.equal(b.$('franja-meta').hidden, true);
  assert.equal(b.$('panel-meta').hidden, true);
  assert.equal(b.$('abrir-meta').atributos['aria-expanded'], 'false');
  // Error desde el principio: nada que mostrar.
  const c = montarBarra();
  await c.vacio();
  c.peticiones[0].rechazar(new Error('sin red'));
  await c.vacio();
  assert.equal(c.$('franja-meta').hidden, true);
});

test('#940 con error, sin red o una respuesta que no es de la caja se conserva el último valor, atenuado; al volver el dato se quita lo atenuado', async () => {
  const b = montarBarra();
  await b.vacio();
  b.responder(0, datos(metas(10, 8, 5, 3, 1), 5));
  await b.vacio();
  assert.equal(b.$('meta-pct').textContent, '10 %');
  assert.ok(!b.$('franja-meta').clases.has('viejo'));
  const intentos: [string, (i: number) => void][] = [
    ['sin red', (i) => b.peticiones[i].rechazar(new Error('Failed to fetch'))],
    ['500', (i) => b.responder(i, { error: 'x' }, false)],
    ['HTML de un portal cautivo', (i) => b.peticiones[i].resolver({ ok: true, json: async () => { throw new SyntaxError('no es JSON'); } })],
    ['JSON de otra cosa', (i) => b.responder(i, { hola: 1 })],
    ['metas con basura', (i) => b.responder(i, { metas: [{ n: 1 }], dia: 2 })],
  ];
  for (const [que, falla] of intentos) {
    b.api.refrescarMeta();
    const i = b.peticiones.length - 1;
    falla(i);
    await b.vacio();
    assert.equal(b.$('franja-meta').hidden, false, que);
    assert.equal(b.$('meta-pct').textContent, '10 %', `${que}: conserva el valor`);
    assert.ok(b.$('franja-meta').clases.has('viejo'), `${que}: atenuado`);
    assert.match(b.$('franja-meta').title, /Sin conexión/);
  }
  b.api.refrescarMeta();
  b.responder(b.peticiones.length - 1, datos(metas(20, 8, 5, 3, 1), 5));
  await b.vacio();
  assert.equal(b.$('meta-pct').textContent, '20 %');
  assert.ok(!b.$('franja-meta').clases.has('viejo'));
});

test('#940 un solo temporizador y nunca dos peticiones a la vez: lo que llega con una en camino pide UNA repetición al terminar; con la pestaña oculta no consulta', async () => {
  const b = montarBarra();
  assert.equal(b.estado.intervalos, 1, 'un solo setInterval');
  await b.vacio();
  b.api.refrescarMeta(); b.api.refrescarMeta(); b.api.refrescarMeta();   // un tic, un cobro y otro cobro mientras la primera sigue en camino
  assert.equal(b.peticiones.length, 1);
  b.responder(0, datos(metas(10, 8), 2));
  await b.vacio();
  assert.equal(b.peticiones.length, 2, 'una repetición (pudo salir antes del cobro), no tres');
  b.responder(1, datos(metas(12, 8), 2));
  await b.vacio();
  assert.equal(b.peticiones.length, 2);
  b.estado.oculta = true;
  b.api.refrescarMeta();
  assert.equal(b.peticiones.length, 2, 'pestaña oculta: no consulta');
  b.estado.oculta = false;
  b.api.refrescarMeta();
  assert.equal(b.peticiones.length, 3);
  // Una petición colgada no se apila: el tope de espera (AbortSignal.timeout) la cierra en el navegador; aquí basta que `finally` libere el turno.
  b.peticiones[2].rechazar(new DOMException('timeout', 'TimeoutError'));
  await b.vacio();
  b.api.refrescarMeta();
  assert.equal(b.peticiones.length, 4);
});

test('#940 refrescarMeta jamás lanza ni devuelve nada que esperar: un cobro no puede retrasarse ni fallar por la barra', async () => {
  const { $ } = mundoDom();
  // fetch que lanza al instante y un DOM roto: aun así refrescarMeta() regresa undefined sin excepción.
  const api = runInNewContext(`${bloqueMeta()}\n;({ refrescarMeta })`, {
    __retos: retos, $, document: { hidden: false, addEventListener() {} }, fetch: () => { throw new Error('boom'); }, AbortSignal: { timeout: () => ({}) },
    escapar: String, setInterval() {}, setTimeout() {}, clearTimeout() {}, addEventListener() {}, Date, Number, Math, Array,
  }) as any;
  assert.equal(api.refrescarMeta(), undefined);
  assert.equal(api.refrescarMeta(), undefined);
});

test('#940 solo porcentajes: ningún importe en lo que la barra y el «?» muestran, ni se pide ni se lee nada en pesos', async () => {
  const b = montarBarra();
  await b.vacio();
  b.responder(0, { ...datos(metas(100, 62, 31, 20, 12), 3), ventas: 123456, linea: 99999 });   // aunque el servidor mandara importes, la barra no los toca
  await b.vacio();
  const visible = ['meta-nombre', 'meta-pct', 'meta-ritmo'].map((id) => b.$(id).textContent).join(' ') + b.$('panel-meta').innerHTML + b.$('meta-barra').atributos['aria-label'];
  assert.doesNotMatch(visible, /\$|peso|MXN|123456|99999/i);
  const bloque = entre('const META = {', '/* ---------- fin de la meta semanal (#940) ---------- */');
  assert.doesNotMatch(bloque.replace(/\/\/[^\n]*/g, ''), /pesos\(|ventas|linea|importe|MXN/);
});

test('#940 htmlPanelMetas escapa lo que pinta y limita el porcentaje a 0–100', () => {
  const b = montarBarra();
  const html = b.api.htmlPanelMetas({ lista: [{ n: 1, etiqueta: 'A', pct: 250, lograda: false }, { n: 2, etiqueta: 'B', pct: -5, lograda: false }] });
  assert.match(html, /100 %/);
  assert.match(html, /0 %/);
  assert.doesNotMatch(html, /250|-5/);
});

/* ---------- el «?» es un panel más: Esc, escaneo, foco, Enter del lector ---------- */

function montarPaneles() {
  const { $, mundo } = mundoDom();
  const estado = { lineas: [{ codigo: 'A' }], aviso: '', cancelados: 0 };
  const el = $('aviso');
  Object.defineProperty(el, 'textContent', { get: () => estado.aviso, set: (v: string) => { estado.aviso = v; } });
  $('cancelar').click = () => { estado.cancelados++; };
  const doc = new Falso('document') as Falso & { querySelector: () => null };
  doc.querySelector = () => null;
  const codigo = `${entre('const PANELES =', '// Estado de lo que pide atención')}
    ${entre('// Doble Esc borra el ticket completo', '// Con descuento aprobado')}`;
  runInNewContext(codigo, { $, document: doc, get lineas() { return estado.lineas; } });
  const tecla = (key: string, extra: Record<string, unknown> = {}) => { for (const f of doc.oyentes.keydown ?? []) f({ key, repeat: false, timeStamp: 10000, ...extra }); };
  const clic = (id: string) => { for (const f of $(id).oyentes.click ?? []) f({ stopPropagation() {}, target: { closest: () => null } }); };
  return { $, doc, mundo, estado, tecla, clic };
}

test('#940 el «?» abre y cierra la lista (clic, mismo botón, Esc), aria-expanded lo dice, abrir otro panel lo cierra y el foco vuelve a #codigo', () => {
  const p = montarPaneles();
  p.clic('abrir-meta');
  assert.equal(p.$('panel-meta').hidden, false);
  assert.equal(p.$('abrir-meta').atributos['aria-expanded'], 'true');
  p.mundo.activo = 'abrir-meta';
  p.tecla('Escape');
  assert.equal(p.$('panel-meta').hidden, true);
  assert.equal(p.$('abrir-meta').atributos['aria-expanded'], 'false');
  assert.equal(p.mundo.activo, 'codigo');
  p.clic('abrir-meta'); p.clic('abrir-meta');
  assert.equal(p.$('panel-meta').hidden, true);
  p.clic('abrir-meta'); p.clic('abrir-avisos');
  assert.deepEqual([p.$('panel-meta').hidden, p.$('panel-avisos').hidden], [true, false]);
  p.clic('abrir-meta');
  assert.deepEqual([p.$('panel-meta').hidden, p.$('panel-avisos').hidden], [false, true]);
});

test('#940 Esc con el «?» abierto solo lo cierra: no cuenta para el doble Esc que borra el ticket y reinicia su temporizador', () => {
  const p = montarPaneles();
  p.tecla('Escape', { timeStamp: 10100 });
  p.clic('abrir-meta');
  p.tecla('Escape', { timeStamp: 10200 });   // cierra el «?»
  p.tecla('Escape', { timeStamp: 10300 });   // primer Esc de verdad: no cancela
  assert.equal(p.estado.cancelados, 0, 'Esc, abrir «?», Esc, Esc no borra el ticket');
  assert.match(p.estado.aviso, /Esc otra vez/);
  p.tecla('Escape', { timeStamp: 10400 });
  assert.equal(p.estado.cancelados, 1, 'sin panel abierto el doble Esc cancela como siempre');
});

test('#940 un escaneo con el «?» abierto no se pierde: el lector sigue activo, su Enter no pulsa el botón y la lectura cierra el panel sin robar el foco', () => {
  assert.match(fuente, /<div class="flota" id="panel-meta" hidden><\/div>/);
  assert.doesNotMatch(fuente, /<dialog id="panel-meta/);
  const libre = new Function('document', `return () => !document.querySelector('dialog[open]')`)({ querySelector: () => null });
  const lecturas: string[] = [];
  const reloj = { t: 0 };
  const lector = crearLector({ emitir: ({ codigo }: { codigo: string }) => lecturas.push(codigo), libre, ahora: () => reloj.t, esperar: () => 0, cancelar: () => {} });
  const botonMeta = { closest: () => null };   // el foco quedó en el «?»
  let enterEvitado = false;
  for (const k of '7501234') { reloj.t += 10; lector.tecla({ key: k, target: botonMeta }); }
  lector.tecla({ key: 'Enter', target: botonMeta, preventDefault() { enterEvitado = true; }, stopImmediatePropagation() {} });
  assert.deepEqual(lecturas, ['7501234']);
  assert.equal(enterEvitado, true);
  const p = montarPaneles();
  p.clic('abrir-meta');
  p.mundo.activo = 'otro';
  for (const f of p.doc.oyentes.lectura ?? []) f({});
  assert.equal(p.$('panel-meta').hidden, true);
  assert.equal(p.mundo.activo, 'otro');
  // Y el escaneo que ya tiene el foco en #codigo (escanear() cierra los paneles con enfocar:false) lo cierra igual.
  p.clic('abrir-meta');
  p.mundo.activo = 'codigo';
  const cerrar = runInNewContext(`${entre('const PANELES =', '// Estado de lo que pide atención')}; cerrarPaneles`, { $: p.$, document: p.doc });
  cerrar({ enfocar: false });
  assert.equal(p.$('panel-meta').hidden, true);
  assert.equal(p.mundo.activo, 'codigo');
});

/* ---------- cableado: lo que no debe cambiar ---------- */

test('#940 el cobro solo gana UNA llamada fire-and-forget al terminar la venta; no se tocó la lógica de cobro, y la barra no usa await en esa ruta', () => {
  const cobro = entre('async function cobrar(', 'let sincronizando = false;');
  assert.equal((cobro.match(/refrescarMeta/g) ?? []).length, 1);
  assert.match(cobro, /\n {4}sincronizar\(\);\n {4}refrescarMeta\(\);[^\n]*\n {2}\} finally \{/, 'después de sincronizar(), ya con la venta terminada y el ticket limpio');
  assert.doesNotMatch(cobro, /await refrescarMeta|return refrescarMeta/);
  assert.doesNotMatch(entre('function refrescarMeta()', 'setInterval(refrescarMeta'), /\bawait\b/);
});

test('#940 retos.js se baja con import() y su falla no tumba la caja; está en la copia sin red del service worker y el caché subió de versión', () => {
  assert.match(fuente, /import\('\/retos\.js'\)\.then\(\(m\) => \{ RETOS = m; refrescarMeta\(\); \}, \(\) => \{\}\)/);
  assert.doesNotMatch(fuente, /^import .* from '\/retos\.js'/m);
  const sw = readFileSync('public/sw-caja.js', 'utf8');
  const rutas: string[] = JSON.parse(sw.match(/const RUTAS = (\[[^\]]*\])/)![1].replace(/'/g, '"'));
  assert.ok(rutas.includes('/retos.js'));
  assert.match(sw, /const CACHE = 'caja-v4'/);
  // retos.js no importa nada: no arrastra otros módulos que también habría que cachear.
  assert.doesNotMatch(readFileSync('public/retos.js', 'utf8'), /^\s*import\b/m);
});

test('#940 estructura: la barra vive dentro de #franja-meta (oculta de inicio), el «?» es un botón y el panel una lista flotante, no un <dialog>', () => {
  assert.match(fuente, /<div id="franja-meta" hidden>\s*<span id="meta-nombre"><\/span>[\s\S]*?<button id="abrir-meta" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="panel-meta"/);
  assert.match(fuente, /const PANELES = \[\['abrir-mas', 'panel-mas'\], \['abrir-avisos', 'panel-avisos'\], \['abrir-meta', 'panel-meta'\]\]/);
  // Pantalla angosta: solo barra y porcentaje (y el «?», que sigue alcanzable).
  assert.match(fuente, /@media \(max-width: 700px\) \{ #meta-nombre, #meta-ritmo \{ display: none; \} \}/);
  // La franja sigue escondiéndose sola sin promo ni barra.
  assert.match(fuente, /#franja:not\(:has\(> :not\(\[hidden\]\)\)\) \{ display: none; \}/);
});
