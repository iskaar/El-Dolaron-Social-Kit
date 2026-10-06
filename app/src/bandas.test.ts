// node --test src/bandas.test.ts
// Los nueve montos de banda (Issue #168): lo que dan las migraciones y lo que crea una familia nueva.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

const MONTOS = [19, 29, 49, 79, 99, 119, 129, 149, 199];

test('/api/familias ofrece los nueve montos y cada familia sembrada tiene sus nueve productos', async () => {
  const { db, pedir } = tienda();
  const { montos, familias } = (await pedir('/api/familias')).cuerpo;
  assert.deepEqual(montos, MONTOS);
  assert.equal(familias.length, 18);

  for (const f of familias as { nombre: string; prefijo: string }[]) {
    for (const monto of MONTOS) {
      const p = db.prepare('select nombre, precio, destino, stock, sin_inventario from productos where codigo = ?')
        .get(`${f.prefijo.toUpperCase()}${monto}`) as Record<string, unknown> | undefined;
      assert.ok(p, `falta ${f.prefijo.toUpperCase()}${monto}`);
      assert.equal(p.precio, monto * 100);
      assert.equal(p.destino, `banda_${f.prefijo}${monto}`);
      assert.equal(p.sin_inventario, 1);
      assert.equal(p.stock, 0);
    }
  }
  assert.equal((db.prepare(`select count(*) as n from productos where destino like 'banda_%'`).get() as { n: number }).n, 18 * 9);
});

test('la migracion 024 es repetible: correrla otra vez no duplica nada', async () => {
  const { db } = tienda();
  const antes = (db.prepare('select count(*) as n from productos').get() as { n: number }).n;
  const sql = (await import('node:fs')).readFileSync('migracion-024-bandas-119-129.sql', 'utf8');
  db.exec(sql);
  assert.equal((db.prepare('select count(*) as n from productos').get() as { n: number }).n, antes);
  assert.equal((db.prepare(`select valor from config where clave = 'banda_119'`).get() as { valor: string }).valor, '11900');
});

test('una familia nueva nace con los nueve montos, y el precio de la configuracion manda', async () => {
  const { db, pedir } = tienda();
  db.prepare(`update config set valor = '12500' where clave = 'banda_129'`).run();
  const r = await pedir('/api/familias', { nombre: 'Termos' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const filas = db.prepare(`select codigo, precio from productos where destino like ? order by precio`)
    .all(`banda_${r.cuerpo.prefijo}%`) as { codigo: string; precio: number }[];
  assert.equal(filas.length, 9);
  assert.ok(filas.some((f) => f.codigo === `${r.cuerpo.prefijo.toUpperCase()}119`));
  assert.equal(filas.find((f) => f.codigo.endsWith('129'))?.precio, 12500);
});
