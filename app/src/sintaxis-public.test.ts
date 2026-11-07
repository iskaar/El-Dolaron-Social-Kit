// node --test src/sintaxis-public.test.ts
// #735: un salto de línea literal dentro de una cadena en inventario-celular.js rompió /inventario en
// celulares («Invalid or unexpected token» / «Unexpected EOF»). Ningún test importaba ese archivo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = new URL('../public/', import.meta.url);

test('todo JS de public/ es sintaxis válida', () => {
  const malos = readdirSync(dir).filter(f => f.endsWith('.js')).flatMap(f => {
    const r = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(f, dir))], { encoding: 'utf8' });
    return r.status === 0 ? [] : [`${f}: ${r.stderr.split(/\r?\n/).find(l => l.includes('Error')) ?? r.stderr}`];
  });
  assert.deepEqual(malos, []);
});
