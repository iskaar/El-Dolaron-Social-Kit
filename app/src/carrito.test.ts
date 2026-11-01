// node --test src/carrito.test.ts
// Carrito del portal (Issue #681): lista de códigos, tope, ?carrito=, revisión contra el catálogo y la hoja contra un DOM de mentira.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as carrito from '../public/carrito.js';

test('códigos: mayúsculas, sin repetir, solo ED-…, tope de 10; ?carrito= ignora lo malformado', () => {
  assert.equal(carrito.TOPE_CARRITO, 10);
  assert.deepEqual(carrito.codigosValidos([' ed-1 ', 'ED-1', 'ED-2', 'otra cosa', 7, null, 'ED-12345678901']), ['ED-1', 'ED-2']);
  assert.deepEqual(carrito.codigosValidos('ED-1'), []);
  assert.equal(carrito.codigosValidos(Array.from({ length: 15 }, (_, i) => `ED-${i + 1}`)).length, 10);
  assert.deepEqual(carrito.codigosDeUrl('?carrito=ED-000123,ed-000124,xx,ED-000123&r=ABC'), ['ED-000123', 'ED-000124']);
  assert.deepEqual(carrito.codigosDeUrl('?pieza=ED-1'), []);
  assert.deepEqual(carrito.agregarCodigo(['ED-1'], 'ED-2'), { lista: ['ED-1', 'ED-2'], estado: 'agregado' });
  assert.deepEqual(carrito.agregarCodigo(['ED-1'], 'ED-1'), { lista: ['ED-1'], estado: 'ya_estaba' });
  const llena = Array.from({ length: 10 }, (_, i) => `ED-${i + 1}`);
  assert.deepEqual(carrito.agregarCodigo(llena, 'ED-99'), { lista: llena, estado: 'lleno' });
});

test('piezasDe: separa disponibles, vendidas (el catálogo ya no las trae) y fallos de red', async () => {
  const llamadas: string[] = [];
  const pedir = async (url: string) => {
    llamadas.push(url);
    if (url.endsWith('ED-1')) return Response.json({ piezas: [{ codigo: 'ED-1', nombre: 'A', precio: 25000 }] });
    if (url.endsWith('ED-2')) return Response.json({ piezas: [] });
    if (url.endsWith('ED-3')) return new Response('x', { status: 503 });
    throw new TypeError('red');
  };
  const r = await carrito.piezasDe(['ED-1', 'ED-2', 'ED-3', 'ED-4'], pedir as never);
  assert.deepEqual(r.disponibles.map((p: any) => p.codigo), ['ED-1']);
  assert.deepEqual([r.vendidas, r.fallaron], [['ED-2'], ['ED-3', 'ED-4']]);
  assert.deepEqual(llamadas, ['ED-1', 'ED-2', 'ED-3', 'ED-4'].map((c) => `/api/catalogo?codigo=${c}`));
});

/** Un DOM mínimo con lo que toca carrito.js. */
function dominio(inicial?: string) {
  const nodos = new Map<string, any>();
  const nodo = (sel: string) => {
    if (!nodos.has(sel)) nodos.set(sel, { sel, hidden: false, textContent: '', disabled: false, hijos: [] as any[], oyentes: {} as Record<string, (e?: any) => any>,
      addEventListener(t: string, f: (e?: any) => any) { this.oyentes[t] = f; }, focus() { enfocado = this; }, replaceChildren(...h: any[]) { this.hijos = h; }, querySelector() { return this.hijos[0]?.hijos?.[2] ?? null; } });
    return nodos.get(sel);
  };
  let enfocado: any = null;
  const cerrar = nodo('.carrito-cerrar');
  const dialogo: any = { open: false, oyentes: {} as Record<string, (e?: any) => any>, querySelector: (sel: string) => nodo(sel), querySelectorAll: () => [cerrar],
    addEventListener(t: string, f: (e?: any) => any) { this.oyentes[t] = f; }, showModal() { this.open = true; }, close() { this.open = false; this.oyentes.close?.(); } };
  const n = { textContent: '0' };
  const boton: any = { oyentes: {} as Record<string, () => any>, querySelector: () => n, addEventListener(t: string, f: () => any) { this.oyentes[t] = f; } };
  const almacen = new Map<string, string>(inicial === undefined ? [] : [['carrito-dolaron', inicial]]);
  const poner = (nombre: string, valor: unknown) => Object.defineProperty(globalThis, nombre, { value: valor, configurable: true, writable: true });
  const elemento = (tag: string) => ({ tag, className: '', textContent: '', hijos: [] as any[], oyentes: {} as Record<string, () => any>, attrs: {} as Record<string, string>,
    append(...h: any[]) { this.hijos.push(...h); }, focus() {}, setAttribute(k: string, v: string) { this.attrs[k] = v; }, addEventListener(t: string, f: () => any) { this.oyentes[t] = f; } });
  poner('document', { getElementById: (id: string) => (id === 'carrito-dialogo' ? dialogo : null), querySelector: (sel: string) => (sel === '.carrito-boton' ? boton : null), createElement: elemento });
  poner('localStorage', { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v); } });
  poner('Image', class { alt = ''; loading = ''; decoding = ''; src = ''; remove() {} addEventListener() {} });
  const catalogo: Record<string, any> = {};
  poner('fetch', async (url: string) => {
    const codigo = decodeURIComponent(url.split('codigo=')[1]);
    if (catalogo[codigo] === 'falla') throw new TypeError('red');
    return Response.json({ piezas: catalogo[codigo] ? [{ codigo, ...catalogo[codigo] }] : [] });
  });
  const renglones = () => nodo('.carrito-lista').hijos.map((li: any) => ({
    nombre: li.hijos[1].hijos[0].textContent, precio: li.hijos[1].hijos[1].textContent, vendida: li.className.includes('vendida'), quitar: li.hijos[2] }));
  return { dialogo, boton, n, nodo, almacen, catalogo, renglones, enfocado: () => enfocado };
}

test('carrito: agregar guarda los códigos en el navegador, cuenta, no repite, topa en 10 y recoge ?carrito= del sitio sin pasarse', () => {
  const d = dominio('["ED-1"]');
  const c = carrito.iniciarCarrito({ alApartar() {} });
  assert.deepEqual([c.cantidad(), d.n.textContent, c.tiene('ED-1')], [1, '1', true]);   // lo guardado antes se recupera
  assert.equal(c.agregar({ codigo: 'ED-2' }), 'agregado');
  assert.equal(c.agregar({ codigo: 'ED-2' }), 'ya_estaba');
  assert.equal(d.almacen.get('carrito-dolaron'), '["ED-1","ED-2"]');
  assert.equal(d.n.textContent, '2');
  assert.deepEqual(c.sumar(Array.from({ length: 12 }, (_, i) => `ED-${i + 10}`)), Array.from({ length: 8 }, (_, i) => `ED-${i + 10}`));   // caben 8
  assert.equal(c.cantidad(), 10);
  assert.equal(c.agregar({ codigo: 'ED-99' }), 'lleno');
  assert.equal(c.cantidad(), 10);
  c.quitar(['ED-1', 'ED-2']);
  assert.deepEqual([c.cantidad(), d.n.textContent], [8, '8']);
  // Sin almacenamiento (modo privado): sigue funcionando en memoria.
  const e = dominio();
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('bloqueado'); } }, configurable: true, writable: true });
  const sin = carrito.iniciarCarrito({ alApartar() {} });
  assert.equal(sin.agregar({ codigo: 'ED-5' }), 'agregado');
  assert.deepEqual(sin.codigos(), ['ED-5']);
  assert.equal(e.n.textContent, '1');
});

test('hoja del carrito: revisa cada pieza, marca «Se vendió» y la saca del total, y «Apartar todo» manda solo las disponibles', async () => {
  const d = dominio('["ED-1","ED-2","ED-3"]');
  d.catalogo['ED-1'] = { nombre: 'Chamarra Levis', precio: 25000 };
  d.catalogo['ED-3'] = { nombre: 'Blusa floral', precio: 4000 };   // ED-2 ya no está
  const enviadas: any[] = [];
  const c = carrito.iniciarCarrito({ alApartar: (piezas: any[]) => enviadas.push(piezas.map((p) => p.codigo)) });
  await d.boton.oyentes.click();
  assert.equal(d.dialogo.open, true);
  assert.equal(d.nodo('.carrito-titulo').textContent, 'Tu carrito (3)');
  assert.deepEqual(d.renglones().map((r: any) => [r.nombre, r.precio, r.vendida]), [['Chamarra Levis', '$250', false], ['ED-2', 'Se vendió', true], ['Blusa floral', '$40', false]]);
  assert.equal(d.nodo('.carrito-total').textContent, 'Total de las piezas: $290');   // la vendida no suma
  assert.match(d.nodo('.carrito-aviso').textContent, /^Una pieza ya se vendió: no cuenta en el total\.$/);
  assert.equal(d.nodo('.carrito-apartar').disabled, false);
  assert.equal(d.nodo('.carrito-vacio').hidden, true);
  d.nodo('.carrito-apartar').oyentes.click();
  assert.deepEqual(enviadas, [['ED-1', 'ED-3']]);
  // Quitar una: sale de la lista, del total y del almacenamiento, y se avisa para lectores de pantalla.
  d.renglones()[0].quitar.oyentes.click();
  assert.equal(d.almacen.get('carrito-dolaron'), '["ED-2","ED-3"]');
  assert.equal(d.nodo('.carrito-total').textContent, 'Total de las piezas: $40');
  assert.equal(d.nodo('.carrito-aviso').textContent, 'Quitaste Chamarra Levis.');
  assert.equal(d.renglones()[1].quitar.attrs['aria-label'], 'Quitar Blusa floral del carrito');
  // Al cerrar, la vendida (ya avisada) sale del carrito.
  d.dialogo.close();
  assert.deepEqual(c.codigos(), ['ED-3']);
  assert.equal(d.n.textContent, '1');
});

test('hoja del carrito: vacío, red caída (no deja apartar sin revisar) y todo vendido', async () => {
  const d = dominio('[]');
  const c = carrito.iniciarCarrito({ alApartar() { throw new Error('no debe apartar'); } });
  await c.abrir();
  assert.equal(d.nodo('.carrito-vacio').hidden, false);
  assert.equal(d.nodo('.carrito-resumen').hidden, true);
  d.dialogo.close();
  c.agregar({ codigo: 'ED-1' });
  c.agregar({ codigo: 'ED-2' });
  d.catalogo['ED-1'] = { nombre: 'Chamarra Levis', precio: 25000 };
  d.catalogo['ED-2'] = 'falla';
  await c.abrir();
  assert.equal(d.nodo('.carrito-apartar').disabled, true);   // no se aparta algo que no se pudo revisar
  assert.match(d.nodo('.carrito-aviso').textContent, /No pudimos revisar todas las piezas/);
  assert.equal(d.renglones()[1].precio, 'No pudimos revisarla');
  d.nodo('.carrito-apartar').oyentes.click();   // aunque lo toquen, no manda nada (alApartar lanzaría)
  d.dialogo.close();
  assert.equal(c.cantidad(), 2);   // un fallo de red no borra piezas
  delete d.catalogo['ED-1'];
  d.catalogo['ED-2'] = undefined;
  await c.abrir();
  assert.equal(d.nodo('.carrito-apartar').disabled, true);
  assert.match(d.nodo('.carrito-aviso').textContent, /^2 piezas ya se vendieron: no cuentan en el total\.$/);
  d.dialogo.close();
  assert.equal(c.cantidad(), 0);
});

test('portal.html trae el botón y la hoja que carrito.js busca; el sitio y el portal comparten clave, tope y formato de ?carrito=', () => {
  const html = readFileSync('public/portal.html', 'utf8');
  const js = readFileSync('public/carrito.js', 'utf8');
  const clases = new Set([...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(' ')));
  const selectores = [...js.matchAll(/\bq\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(selectores.length >= 7);
  for (const sel of new Set(selectores)) assert.ok(clases.has(sel.slice(1)), sel);
  assert.match(html, /<dialog id="carrito-dialogo" aria-labelledby="carrito-titulo">/);
  assert.match(html, /<p class="carrito-aviso nota" role="status" aria-live="polite"><\/p>/);
  assert.match(html, /<button class="carrito-apartar" type="button">Apartar todo<\/button>/);
  // La copia del sitio (site/public/catalogo.js) se ata en check_site_catalogo.cjs; aquí, que el portal documente su origen.
  assert.match(js, /COPIA DELIBERADA en site\/public\/catalogo\.js/);
  const css = readFileSync('public/portal.css', 'utf8');
  assert.match(css, /\.catalogo-cabeza \{[^}]*position:sticky/);
});
