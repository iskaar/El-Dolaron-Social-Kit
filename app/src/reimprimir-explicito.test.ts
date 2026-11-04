// node --test src/reimprimir-explicito.test.ts
// #713: los botones amarillos de reimprimir que el usuario pulsa en Capturar mandan `reimprimir:true`. Sin él, una pieza cuya
// etiqueta ya figura reclamada en D1 se omitía y el botón decía «Etiqueta enviada» sin sacar nada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const precio = readFileSync('public/inventario-precio.js', 'utf8');
const capturar = readFileSync('public/inventario-capturar.js', 'utf8');
const corte = (fuente: string, desde: string, hasta: string) => { const i = fuente.indexOf(desde); assert.ok(i >= 0, desde); return fuente.slice(i, fuente.indexOf(hasta, i)); };

/** Un nodo mínimo: lo que los dos botones usan del DOM. */
const falso = () => { const n: any = { hijos: [] as any[], textContent: '', append(...x: any[]) { n.hijos.push(...x); }, replaceWith() {}, focus() {}, hidden: false }; return n; };
function botones() {
  const pulsables = new Map<string, () => Promise<void>>(), envios: { ids: string[]; copias: Map<string, number>; opciones: unknown }[] = [], mensajes: string[] = [];
  const ctx = { identidad: { vendedor: false }, imprimir: async (ids: string[], copias: Map<string, number>, opciones?: unknown) => { envios.push({ ids, copias, opciones }); return true; } };
  const boton = (texto: string, accion: () => Promise<void>) => { pulsables.set(texto, accion); return falso(); };
  return { pulsables, envios, mensajes, ctx, entorno: { boton, nodo: falso, mensaje: (t: string) => mensajes.push(t), pesos: (c: number) => `$${c / 100}`, Map } };
}

test('«Reimprimir etiqueta» del precio cambiado (dueño en Capturar) fuerza la reimpresión', async () => {
  const b = botones();
  const terminar = runInNewContext(`(s, ctx, form) => { ${corte(precio, '  function terminar(', '\n  async function resolver')} return terminar; }`, b.entorno);
  terminar({ producto_id: 'p1', codigo: 'ED-000001' }, b.ctx, { replaceWith() {} })('✓ Ahora $90', { antes: 10000, reimprimir: true });
  await b.pulsables.get('Reimprimir etiqueta')!();
  assert.equal(b.envios.length, 1);
  assert.equal(JSON.stringify(b.envios[0].ids), '["p1"]');
  assert.equal(JSON.stringify(b.envios[0].opciones), '{"reimprimir":true}');
  assert.deepEqual(b.mensajes, ['Etiqueta enviada']);
});

test('«Imprimir N etiquetas» de una captura que quedó sin etiqueta también fuerza: una marca vieja en D1 no la deja callada', async () => {
  const b = botones();
  const linea = corte(capturar, "    if(actual.faltaEtiqueta&&p.estado_analisis==='listo')", '\n');   // la línea del botón
  const actual = { faltaEtiqueta: true, impresas: 0, cantidad: 3 };
  runInNewContext(`const k=actual.impresas||actual.cantidad||1;${linea}`, { ...b.entorno, actual, p: { id: 'p2', estado_analisis: 'listo' }, tarjeta: falso(), ctx: b.ctx });
  await b.pulsables.get('Imprimir 3 etiquetas')!();
  assert.equal(JSON.stringify(b.envios[0].ids), '["p2"]');
  assert.equal(b.envios[0].copias.get('p2'), 3);
  assert.equal(JSON.stringify(b.envios[0].opciones), '{"reimprimir":true}');
  assert.equal(actual.faltaEtiqueta, false);
});
