import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { SQL_CODIGO, SQL_TEXTO, SQL_EMPATE, SQL_UPC } from './piezas.ts';

test('búsqueda usa índices sin SCAN ni TEMP B-TREE, también con fechas empatadas', () => {
  const { db } = tienda();
  for (const [sql, args, indice] of [
    [SQL_CODIGO, ['ED-000001', 'dolaron'], 'codigo'],
    [SQL_TEXTO, ['dolaron', '9999', 200], 'productos_propietario_creado'],
    [SQL_EMPATE, ['dolaron', '', 3000, 200], 'productos_propietario_creado'],
    [SQL_UPC, ['0123456789', 10, 200], 'productos_upc'],
  ] as const) {
    const plan = JSON.stringify(db.prepare(`explain query plan ${sql}`).all(...args));
    assert.doesNotMatch(plan, /SCAN|TEMP B-TREE/);
    assert.match(plan, new RegExp(indice));
  }
});

test('busca más allá de las 2000, incluye cero y excluye descartadas, bandas sin inventario y FEP', async () => {
  const t = tienda();
  t.db.prepare("update productos set nombre = 'Tesoro antiguo', stock = 0").run();
  const insertar = t.db.prepare(`insert into productos (id,nombre,marca,semana_ingreso,creado_en,actualizado_en,propietario,estado_analisis,sin_inventario)
    values (?, ?, 'Acme', 'S40', ?, '', ?, ?, ?)`);
  for (let n = 0; n < 3000; n++) insertar.run(crypto.randomUUID(), n < 3 ? 'Tesoro antiguo' : 'Otro producto', '2026-10-20', n === 0 ? 'fep' : 'dolaron', n === 1 ? 'descartado' : 'listo', n === 2 ? 1 : 0);
  let cursor = '', peticiones = 0;
  const halladas = [];
  const original = t.env.DB.prepare.bind(t.env.DB);
  let leidas = 0;
  t.env.DB.prepare = ((sql: string) => {
    const s = original(sql);
    const all = s.all.bind(s);
    s.all = async (...args: never[]) => { const r = await all(...args); leidas += r.results.length; return r; };
    return s;
  }) as typeof t.env.DB.prepare;
  do {
    leidas = 0;
    const r = await t.pedir(`/api/piezas?q=tesoro%20antiguo&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(r.status, 200);
    assert.ok(leidas <= 1000, `${leidas} filas`);
    halladas.push(...r.cuerpo.piezas);
    cursor = r.cuerpo.siguiente;
    assert.ok(++peticiones < 12);
  } while (cursor);
  assert.deepEqual(halladas.map((p) => p.id), [PRODUCTO]);
  assert.equal(halladas[0].stock, 0);
  assert.ok(peticiones >= 3);
});

test('códigos, UPC con ceros sin foto, palabras AND, páginas de 25 y entradas inválidas', async () => {
  const t = tienda();
  for (const q of ['1', '0001', 'ed1', 'ED-000001']) assert.equal((await t.pedir(`/api/piezas?q=${q}`)).cuerpo.piezas[0].id, PRODUCTO);
  t.db.prepare("update productos set upc = '000123456', marca = 'Oster'").run();
  for (const q of ['123456', '00000000123456']) assert.equal((await t.pedir(`/api/piezas?q=${q}`)).cuerpo.piezas[0].id, PRODUCTO);
  assert.equal((await t.pedir('/api/piezas?q=oster%20ventilador')).cuerpo.piezas.length, 1);
  assert.equal((await t.pedir('/api/piezas?q=oster%20mesa')).cuerpo.piezas.length, 0);
  for (const q of ['', 'ab', 'a'.repeat(81)]) assert.equal((await t.pedir(`/api/piezas?q=${q}`)).status, 400);
  assert.equal((await t.pedir('/api/piezas?q=ventilador&cursor=basura')).status, 400);
  const insertar = t.db.prepare(`insert into productos (id,nombre,semana_ingreso,creado_en,actualizado_en) values (?, 'Ventilador', 'S40', '2026', '')`);
  for (let n = 0; n < 55; n++) insertar.run(crypto.randomUUID());
  const ids: string[] = [];
  let cursor = '';
  do {
    const r = await t.pedir(`/api/piezas?q=ventilador&cursor=${encodeURIComponent(cursor)}`);
    assert.ok(r.cuerpo.piezas.length <= 25);
    ids.push(...r.cuerpo.piezas.map((p: { id: string }) => p.id));
    cursor = r.cuerpo.siguiente;
  } while (cursor);
  assert.equal(ids.length, 56);
  assert.equal(new Set(ids).size, 56);
});
