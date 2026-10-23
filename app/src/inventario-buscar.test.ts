import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function tarjetas(imprimir: Function = async () => true, vendedor = false) {
  class Nodo {
    tag: string; texto = ''; className = ''; dataset: Record<string, string> = {};
    children: Nodo[] = []; atributos: Record<string, string> = {}; eventos: Record<string, Function> = {};
    constructor(tag = 'div') { this.tag = tag; }
    set textContent(t: string) { this.texto = t; this.children = []; }
    get textContent(): string { return this.texto + this.children.map(n => n.textContent).join(''); }
    set innerHTML(_s: string) { throw new Error('No se permiten datos como HTML'); }
    append(...n: Nodo[]) { this.children.push(...n); }
    prepend(...n: Nodo[]) { this.children.unshift(...n); }
    replaceChildren(...n: Nodo[]) { this.texto = ''; this.children = n; }
    setAttribute(k: string, v: string) { this.atributos[k] = v; }
    getAttribute(k: string) { return this.atributos[k]; }
    addEventListener(e: string, fn: Function) { this.eventos[e] = fn; }
  }
  const elementos = new Map<string, Nodo>(), abiertas: string[] = [];
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, new Nodo());
    return elementos.get(id)!;
  };
  const ui = readFileSync('public/inventario-ui.js', 'utf8').replace(/^export /gm, '');
  const codigo = readFileSync('public/inventario.js', 'utf8').split('export function resultado(')[1].split('const filtroCorto')[0];
  const resultado = runInNewContext(`${ui}\nfunction resultado(${codigo}\nresultado`, {
    document: { createElement: (tag: string) => new Nodo(tag), createElementNS: (_ns: string, tag: string) => new Nodo(tag), getElementById: $ },
    identidad: { vendedor }, contexto: { imprimir }, ficha: { abrir: (id: string) => abiertas.push(id) },
    pesos: () => '$450.00', setTimeout: () => 0, clearTimeout() {},
  });
  return { resultado, $, abiertas };
}

const p = { id: 'pieza', codigo: 'ED-000123', nombre: '<b>Chamarra</b>', precio: 45000, stock: 3, upc: '001234567890', destino: 'etiqueta', tiene_foto: 0 };

test('tarjeta: código primero, nombre seguro, precio/UPC/sin foto, existencia y consumidores sin Reimprimir (#446)', async () => {
  const ui = tarjetas(), li = ui.resultado(p), principal = li.children[0], texto = principal.children[1];
  assert.equal(texto.children[0].tag, 'code'); assert.equal(texto.children[0].textContent, p.codigo);
  assert.equal(texto.children[1].textContent, p.nombre);
  assert.equal(texto.children[2].textContent, '$450.00 · 001234567890 · sin foto');
  assert.equal(principal.children[0].className, 'mini-foto'); assert.equal(principal.children[2].textContent, '×3');
  assert.equal(li.children.length, 1);
  await principal.eventos.click(); assert.deepEqual(ui.abiertas, [p.id]);
  const sinCodigo = ui.resultado({ ...p, codigo: null, upc: null }).children[0].children[1];
  assert.equal(sinCodigo.children[0].tag, 'small'); assert.equal(sinCodigo.children[0].textContent, 'Sin código');
  assert.equal(sinCodigo.children[2].textContent, '$450.00 · sin foto');
  for (const pieza of [{ ...p, codigo: null }, { ...p, destino: 'banda_r19' }]) assert.equal(ui.resultado(pieza, undefined, true).children.length, 1);
  assert.equal(tarjetas(undefined, true).resultado(p, undefined, true).children.length, 1);
});

test('Reimprimir envía una copia, bloquea doble toque y conserva el botón de ficha como hermano (#446)', async () => {
  const envios: any[] = []; let terminar: (ok: boolean) => void = () => {};
  const ui = tarjetas(async (ids: string[], copias: Map<string, number>) => {
    envios.push({ ids: [...ids], copias: Array.from(copias, ([id, n]) => [id, n]) }); return new Promise<boolean>(r => { terminar = r; });
  });
  const li = ui.resultado(p, undefined, true), imprimir = li.children[1];
  assert.equal(imprimir.tag, 'button'); assert.equal(imprimir.textContent, 'Reimprimir');
  assert.equal(imprimir.children[0].children[0].getAttribute('href'), '#i-impresora');
  assert.ok(li.children[0].children.every((n: any) => n.tag !== 'button'));
  const envio = imprimir.eventos.click();
  assert.equal(imprimir.getAttribute('aria-disabled'), 'true'); assert.equal(imprimir.getAttribute('aria-busy'), 'true');
  await imprimir.eventos.click(); assert.equal(envios.length, 1);
  terminar(true); await envio;
  assert.deepEqual(envios, [{ ids: [p.id], copias: [[p.id, 1]] }]);
  assert.equal(imprimir.getAttribute('aria-disabled'), 'false'); assert.equal(imprimir.getAttribute('aria-busy'), 'false');
  assert.match(ui.$('estado').textContent, /Etiqueta enviada · ED-000123/); assert.deepEqual(ui.abiertas, []);
});

test('Reimprimir no anuncia éxito si el motor no envía y libera el botón tras un error (#446)', async () => {
  for (const falla of [false, true]) {
    const ui = tarjetas(async () => { if (falla) throw new Error('Impresora desconectada'); return false; });
    const imprimir = ui.resultado(p, undefined, true).children[1]; await imprimir.eventos.click();
    assert.equal(imprimir.getAttribute('aria-disabled'), 'false'); assert.doesNotMatch(ui.$('estado').textContent, /Etiqueta enviada/);
    if (falla) assert.match(ui.$('error').textContent, /Impresora desconectada/);
  }
});
