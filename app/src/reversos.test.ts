// node --test src/reversos.test.ts
// Guardian (Issue #765): todo tipo/origen que el codigo inserta en Dolarones y vales tiene que decir
// que pasa al devolver. Lee los .ts de src (no tests); no necesita D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PROGRAMAS, SIN_VENTA } from './reversos.ts';

const DIR = new URL('.', import.meta.url);
const archivos = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** Parte por comas de nivel 0 (ignora las de parentesis y de comillas). */
function partir(texto: string): string[] {
  const partes: string[] = [];
  let nivel = 0, comilla = false, actual = '';
  for (const c of texto) {
    if (c === "'") comilla = !comilla;
    if (!comilla && c === '(') nivel++;
    if (!comilla && c === ')') nivel--;
    if (!comilla && nivel === 0 && c === ',') { partes.push(actual.trim()); actual = ''; } else actual += c;
  }
  return [...partes, actual.trim()];
}

/** El texto de `values (...)` o de `select ... from|where` que sigue al insert. */
function valores(resto: string): string {
  if (/^values\s*\(/i.test(resto)) {
    let nivel = 0, comilla = false;
    const ini = resto.indexOf('(') + 1;
    for (let i = ini - 1; i < resto.length; i++) {
      if (resto[i] === "'") comilla = !comilla;
      if (comilla) continue;
      if (resto[i] === '(') nivel++;
      if (resto[i] === ')' && --nivel === 0) return resto.slice(ini, i);
    }
    return resto.slice(ini);
  }
  const sel = resto.replace(/^select\s+/i, '');
  const fin = sel.search(/\s(from|where)\s|`/i);
  return fin < 0 ? sel : sel.slice(0, fin);
}

type Hallazgo = { tabla: string; campo: 'tipo' | 'origen'; valor: string; archivo: string };

function inserciones(): { hallazgos: Hallazgo[]; sinResolver: string[] } {
  const hallazgos: Hallazgo[] = [];
  const sinResolver: string[] = [];
  for (const archivo of archivos) {
    const src = readFileSync(new URL(archivo, DIR), 'utf8');
    // Un parametro tipado `tipo: 'a' | 'b'` / `origen: 'a' | 'b'` cubre los inserts con `?` del mismo archivo.
    const uniones: Record<string, string[]> = { tipo: [], origen: [] };
    for (const u of src.matchAll(/\b(tipo|origen)\s*:\s*('[a-z_]+'(?:\s*\|\s*'[a-z_]+')*)/g))
      uniones[u[1]].push(...[...u[2].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    const re = /insert\s+into\s+(dolarones_movimientos|vales_movimientos|dolarones_lotes|vales_dolarones)\s*\(([^)]*)\)\s*(values\s*\(|select\s+)/gi;
    for (const m of src.matchAll(re)) {
      const columnas = m[2].split(',').map((c) => c.trim());
      const items = partir(valores(src.slice(m.index! + m[0].length - m[3].length)));
      for (const campo of ['tipo', 'origen'] as const) {
        const i = columnas.indexOf(campo);
        if (i < 0) continue;   // sin la columna: vale el default del esquema
        const lit = /^'([a-z_]+)'$/.exec(items[i] ?? '');
        if (lit) hallazgos.push({ tabla: m[1], campo, valor: lit[1], archivo });
        else if (uniones[campo].length) uniones[campo].forEach((valor) => hallazgos.push({ tabla: m[1], campo, valor, archivo }));
        else sinResolver.push(`${archivo}: insert en ${m[1]} con ${campo} = ${items[i]}`);
      }
    }
  }
  return { hallazgos, sinResolver };
}

const dedup = (a: (string[] | undefined)[]) => new Set(a.flatMap((x) => x ?? []));
const tiposD = dedup([...PROGRAMAS.map((p) => p.tiposD), ...SIN_VENTA.map((s) => s.tiposD)]);
const tiposVale = dedup(PROGRAMAS.map((p) => p.tiposVale));
const origenes = dedup([...PROGRAMAS.map((p) => p.origenes), ...SIN_VENTA.map((s) => s.origenes)]);

test('todo tipo y origen que el codigo inserta esta cubierto por src/reversos.ts', () => {
  const { hallazgos, sinResolver } = inserciones();
  assert.ok(hallazgos.length > 15, 'el lector de inserts dejo de encontrar los de Dolarones: revisa reversos.test.ts');
  assert.deepEqual(sinResolver, [],
    'tipo/origen que no se pudo leer: usa un literal en el insert o un parametro tipado `tipo: \'a\' | \'b\'`');
  const faltan = hallazgos.filter((h) => !(
    h.campo === 'origen' ? origenes : h.tabla === 'vales_movimientos' ? tiposVale : tiposD).has(h.valor));
  assert.deepEqual([...new Set(faltan.map((h) => `${h.campo} '${h.valor}' (${h.tabla}, src/${h.archivo})`))], [],
    'Oferta nueva sin reverso. Agrega una entrada a PROGRAMAS en src/reversos.ts con sus tiposD/tiposVale/origenes y que hace ' +
    'al cancelar completa y al devolver parcial (sentencias, `derivado` o `nada` con la razon). ' +
    'Si el tipo no nace de una venta (alta, regalo, cupon), agregalo a SIN_VENTA con su razon.');
});

test('el registro no lista tipos u origenes que el codigo ya no inserta', () => {
  const { hallazgos } = inserciones();
  const vistos = (campo: string, tabla: (t: string) => boolean) => new Set(hallazgos.filter((h) => h.campo === campo && tabla(h.tabla)).map((h) => h.valor));
  const sobran = [
    ...[...tiposD].filter((t) => !vistos('tipo', (x) => x === 'dolarones_movimientos').has(t)).map((t) => `tiposD '${t}'`),
    ...[...tiposVale].filter((t) => !vistos('tipo', (x) => x === 'vales_movimientos').has(t)).map((t) => `tiposVale '${t}'`),
    ...[...origenes].filter((o) => !vistos('origen', () => true).has(o)).map((o) => `origen '${o}'`),
  ];
  assert.deepEqual(sobran, [], 'Quitalos de src/reversos.ts o corrige el nombre: un registro que no coincide con el codigo no protege nada.');
});

test('cada programa decide completa y parcial, con razon cuando no escribe nada', () => {
  assert.equal(new Set(PROGRAMAS.map((p) => p.nombre)).size, PROGRAMAS.length, 'nombres de programa repetidos');
  for (const p of PROGRAMAS) {
    for (const accion of [p.completa, p.parcial]) {
      if (typeof accion === 'function') continue;
      const razon = 'nada' in accion ? accion.nada : accion.derivado;
      assert.ok(razon.trim().length > 20, `${p.nombre}: escribe por que no hay sentencias`);
    }
  }
  for (const s of SIN_VENTA) assert.ok(s.razon.trim().length > 20, 'SIN_VENTA necesita su razon');
});
