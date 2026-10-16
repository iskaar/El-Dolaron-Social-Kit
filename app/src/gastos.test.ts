import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DUENO, tienda } from './prueba-d1.ts';

test('gastos fuera y de caja: el corte descuenta caja y el mes une ambos sin duplicar', async () => {
  const t = tienda();
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const mes = fecha.slice(0, 7);
  const fuera = await t.pedir('/api/gastos', {
    fecha, categoria: 'renta', importe: 120000, nota: 'Renta mensual', origen: 'fuera',
  });
  assert.equal(fuera.status, 201);
  const caja = await t.pedir('/api/gastos', {
    fecha, categoria: 'limpieza', importe: 2500, nota: 'Jabón', origen: 'caja', caja: 'Caja 2',
  });
  assert.equal(caja.status, 201);
  assert.ok(caja.cuerpo.retiro_id);
  const antiguo = crypto.randomUUID();
  t.db.prepare(`insert into retiros (id, tipo, caja, cajero, importe, motivo, creado_en)
    values (?, 'gasto', 'Caja 2', ?, 100, 'Gasto viejo', ?)`)
    .run(antiguo, DUENO, `${fecha}T12:00:00-06:00`);
  assert.deepEqual({ tipo: t.db.prepare('select tipo from retiros where id = ?').get(caja.cuerpo.retiro_id)?.tipo,
    categoria: t.db.prepare('select categoria from retiros where id = ?').get(caja.cuerpo.retiro_id)?.categoria },
  { tipo: 'gasto', categoria: 'limpieza' });

  const corte = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 47400 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.gastos, 2600);
  const lista = await t.pedir(`/api/gastos?mes=${mes}`, undefined, 'GET');
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.gastos.filter((g: { retiro_id: string | null }) => g.retiro_id === caja.cuerpo.retiro_id).length, 1);
  assert.equal(lista.cuerpo.gastos.length, 3);
  assert.equal(lista.cuerpo.gastos.find((g: { id: string }) => g.id === antiguo).categoria, 'sin_categoria');
  assert.equal(lista.cuerpo.total, 122600);
  assert.deepEqual(Object.fromEntries(lista.cuerpo.por_categoria.map((g: { categoria: string; importe: number }) => [g.categoria, g.importe])),
    { limpieza: 2500, renta: 120000, sin_categoria: 100 });

  const borrado = await t.pedir(`/api/gastos/${fuera.cuerpo.id}`, {}, 'DELETE');
  assert.equal(borrado.status, 200);
  assert.equal((await t.pedir(`/api/gastos/${caja.cuerpo.id}`, {}, 'DELETE')).status, 400);
});

test('categoría inválida, permisos de dueño y categoría obligatoria en caja', async () => {
  const t = tienda();
  assert.equal((await t.pedir('/api/gastos', {
    fecha: '2026-10-15', categoria: 'inventada', importe: 500, origen: 'fuera',
  })).status, 400);
  assert.equal((await t.pedir('/api/retiros', {
    id: crypto.randomUUID(), tipo: 'gasto', caja: 'Caja 1', importe: 500, motivo: 'Sin categoría',
  })).status, 400);
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
    values ('cajero@prueba.mx', 'Cajero', 'cajero', 1, '', '', '')`).run();
  t.env.DEV_USUARIO = 'cajero@prueba.mx';
  assert.equal((await t.pedir('/api/gastos?mes=2026-10', undefined, 'GET')).status, 403);
  const caja = readFileSync('public/caja.html', 'utf8');
  assert.match(caja, /tipo === 'gasto' && !categoria/);
  assert.match(caja, /retiro-categoria/);
});

test('reintentar el mismo gasto de caja no lo duplica ni duplica su retiro', async () => {
  const t = tienda();
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const cuerpo = { id: crypto.randomUUID(), fecha, categoria: 'luz', importe: 50000, nota: 'CFE', origen: 'caja', caja: 'Caja 1' };
  assert.equal((await t.pedir('/api/gastos', cuerpo)).status, 201);
  assert.equal((await t.pedir('/api/gastos', cuerpo)).status, 201);
  assert.equal(t.db.prepare('select count(*) n from gastos').get()!.n, 1);
  assert.equal(t.db.prepare(`select count(*) n from retiros where tipo = 'gasto'`).get()!.n, 1);
});
