// node --test src/conteo.test.ts
// Conteo nocturno de piezas de alto valor (Issue #219) contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';

const CAJERO = 'ana@prueba.mx';
const ALTO = 'b2222222-2222-4222-8222-222222222222';
const ALTO_JUSTO = 'c3333333-3333-4333-8333-333333333333';
const BAJO = 'd4444444-4444-4444-8444-444444444444';
const BIN = 'e5555555-5555-4555-8555-555555555555';

function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
    values (?, 'Ana', 'cajero', 1, '', '')`).run(CAJERO);
  // Piezas: una de $500, una justo en el umbral ($300), una bajo el umbral, un bin sin inventario y una sin existencia.
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, sin_inventario, semana_ingreso, creado_en, actualizado_en) values
    (?, 'ED-000002', 'Chamarra', 50000, 4, 0, 'S40', '', ''),
    (?, 'ED-000003', 'Abrigo', 30000, 2, 0, 'S40', '', ''),
    (?, 'ED-000004', 'Playera', 29999, 9, 0, 'S40', '', ''),
    (?, 'ED-000005', 'Bin', 90000, 1, 1, 'S40', '', ''),
    (?, 'ED-000006', 'Agotada', 80000, 0, 0, 'S40', '', '')`).run(ALTO, ALTO_JUSTO, BAJO, BIN, crypto.randomUUID());
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const stock = (id: string) => (t.db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
  const auditoria = () => t.db.prepare('select * from conteo_ajustes').all() as Record<string, any>[];
  return { ...t, como, stock, auditoria };
}

test('la lista solo trae piezas en existencia con precio >= umbral', async () => {
  const { pedir } = montar();
  const { status, cuerpo } = await pedir('/api/conteo', undefined, 'GET');
  assert.equal(status, 200, JSON.stringify(cuerpo));
  const ids = (cuerpo as { id: string }[]).map((p) => p.id).sort();
  assert.deepEqual(ids, [ALTO, ALTO_JUSTO].sort());
});

test('CONTEO_UMBRAL cambia el corte; sin el, cae a 30000', async () => {
  const t = montar();
  (t.env as unknown as { CONTEO_UMBRAL: string }).CONTEO_UMBRAL = '20000';
  const { cuerpo } = await t.pedir('/api/conteo', undefined, 'GET');
  // Chamarra $500, Abrigo $300, Playera $299.99 y el Ventilador de la tienda ($250): los cuatro con stock.
  assert.equal((cuerpo as unknown[]).length, 4);
});

test('contar devuelve solo los faltantes, sin cambiar existencias', async () => {
  const { pedir, stock, auditoria } = montar();
  const r = await pedir('/api/conteo', { conteos: [
    { producto_id: ALTO, contado: 3 },
    { producto_id: ALTO_JUSTO, contado: 2 },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(r.cuerpo.faltantes, [{
    producto_id: ALTO, codigo: 'ED-000002', nombre: 'Chamarra', sistema: 4, contado: 3, faltan: 1,
  }]);
  assert.equal(stock(ALTO), 4);
  assert.equal(auditoria().length, 0);
});

test('un ajuste baja la existencia y deja rastro de quien, antes, despues y motivo', async () => {
  const { pedir, stock, auditoria } = montar();
  const r = await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 4, producto_id: ALTO, cantidad: 1, motivo: 'robo' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(stock(ALTO), 3);
  const [fila] = auditoria();
  assert.equal(fila.producto_id, ALTO);
  assert.equal(fila.codigo, 'ED-000002');
  assert.equal(fila.motivo, 'robo');
  assert.equal(fila.cantidad, 1);
  assert.equal(fila.antes, 4);
  assert.equal(fila.despues, 3);
  assert.equal(fila.ajustado_por, DUENO);
});

test('motivo invalido -> 400 y nada cambia', async () => {
  const { pedir, stock, auditoria } = montar();
  const r = await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 4, producto_id: ALTO, cantidad: 1, motivo: 'perdida' });
  assert.equal(r.status, 400);
  assert.equal(stock(ALTO), 4);
  assert.equal(auditoria().length, 0);
});

test('nunca deja la existencia en negativo, ni deja rastro del intento', async () => {
  const { pedir, stock, auditoria } = montar();
  const r = await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 4, producto_id: ALTO, cantidad: 5, motivo: 'merma' });
  assert.equal(r.status, 409);
  assert.equal(stock(ALTO), 4);
  assert.equal(auditoria().length, 0);
});

test('bins sin inventario y piezas inexistentes no se ajustan', async () => {
  const { pedir } = montar();
  assert.equal((await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 1, producto_id: BIN, cantidad: 1, motivo: 'robo' })).status, 400);
  assert.equal((await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 1, producto_id: crypto.randomUUID(), cantidad: 1, motivo: 'robo' })).status, 404);
});

test('el cajero cuenta, pero no ajusta ni ve el rastro', async () => {
  const { pedir, como, stock } = montar();
  como(CAJERO);
  assert.equal((await pedir('/api/conteo', undefined, 'GET')).status, 200);
  assert.equal((await pedir('/api/conteo', { conteos: [{ producto_id: ALTO, contado: 3 }] })).status, 200);
  const ajuste = await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 4, producto_id: ALTO, cantidad: 1, motivo: 'robo' });
  assert.equal(ajuste.status, 403);
  assert.equal((await pedir('/api/conteo/ajustes', undefined, 'GET')).status, 403);
  assert.equal(stock(ALTO), 4);
});

test('el dueno ve el rastro de los ultimos 30 dias', async () => {
  const { pedir, db } = montar();
  await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 4, producto_id: ALTO, cantidad: 1, motivo: 'merma' });
  db.prepare(`insert into conteo_ajustes (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en)
    values ('viejo', ?, 'ED-000002', 'Chamarra', 'robo', 1, 9, 8, ?, '2020-01-01T00:00:00.000Z')`).run(ALTO, DUENO);
  const { cuerpo } = await pedir('/api/conteo/ajustes', undefined, 'GET');
  assert.equal((cuerpo as unknown[]).length, 1);
  assert.equal((cuerpo as { motivo: string }[])[0].motivo, 'merma');
});

test('la cantidad de conteo y la de ajuste se validan', async () => {
  const { pedir } = montar();
  assert.equal((await pedir('/api/conteo', { conteos: [{ producto_id: ALTO, contado: -1 }] })).status, 400);
  assert.equal((await pedir('/api/conteo', { conteos: [{ producto_id: 'x', contado: 1 }] })).status, 400);
  assert.equal((await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 4, producto_id: ALTO, cantidad: 0, motivo: 'robo' })).status, 400);
});

test('D1 (#480): el mismo folio dos veces descuenta una sola vez y devuelve lo guardado', async () => {
  const { pedir, stock, auditoria } = montar();
  const cuerpo = { id: crypto.randomUUID(), esperado: 4, producto_id: ALTO, cantidad: 1, motivo: 'robo' };
  const a = await pedir('/api/conteo/ajustes', cuerpo);
  assert.equal(a.status, 201, JSON.stringify(a.cuerpo));
  const b = await pedir('/api/conteo/ajustes', cuerpo);   // la respuesta se perdió y el botón reintenta
  assert.equal(b.status, 200, JSON.stringify(b.cuerpo));
  assert.deepEqual({ ...b.cuerpo }, { producto_id: ALTO, antes: 4, despues: 3 });
  assert.equal(stock(ALTO), 3);
  assert.equal(auditoria().length, 1);
  // El folio de otro ajuste no se reutiliza para otra cosa.
  assert.equal((await pedir('/api/conteo/ajustes', { ...cuerpo, producto_id: ALTO_JUSTO, esperado: 2 })).status, 409);
  assert.equal(stock(ALTO_JUSTO), 2);
});

test('D1 (#480): sin folio o sin existencia vista no hay ajuste; con una vista vencida, 409 sin renglón', async () => {
  const { pedir, db, stock, auditoria } = montar();
  const base = { producto_id: ALTO, cantidad: 1, motivo: 'robo' };
  assert.equal((await pedir('/api/conteo/ajustes', { ...base, esperado: 4 })).status, 400);
  assert.equal((await pedir('/api/conteo/ajustes', { ...base, id: crypto.randomUUID() })).status, 400);
  db.prepare('update productos set stock = 3 where id = ?').run(ALTO);   // la caja vendió una después de contar
  const vieja = await pedir('/api/conteo/ajustes', { ...base, id: crypto.randomUUID(), esperado: 4 });
  assert.equal(vieja.status, 409);
  assert.equal(vieja.cuerpo.stock, 3);
  assert.equal(stock(ALTO), 3);
  assert.equal(auditoria().length, 0);
  assert.equal((await pedir('/api/conteo/ajustes', { ...base, id: crypto.randomUUID(), esperado: 3 })).status, 201);
  assert.equal(stock(ALTO), 2);
});

test('D1 (#480): FEP es un inquilino aparte: ni se ve ni se ajusta desde una cuenta de la tienda', async () => {
  const { pedir, db, stock, auditoria } = montar();
  const FEP = 'b9999999-9999-4999-8999-999999999999';
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, sin_inventario, semana_ingreso, creado_en, actualizado_en, propietario)
    values (?, 'ED-000090', 'Bolsa FEP', 90000, 3, 0, 'S40', '', '', 'fep')`).run(FEP);
  const ids = async () => ((await pedir('/api/conteo', undefined, 'GET')).cuerpo as { id: string }[]).map((p) => p.id);
  assert.ok(!(await ids()).includes(FEP));
  assert.deepEqual((await pedir('/api/conteo', { conteos: [{ producto_id: FEP, contado: 0 }] })).cuerpo.faltantes, []);
  assert.equal((await pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 3, producto_id: FEP, cantidad: 1, motivo: 'robo' })).status, 404);
  assert.equal(stock(FEP), 3);
  assert.equal(auditoria().length, 0);
  // El rastro de FEP tampoco aparece en la lista de ajustes de la tienda.
  db.prepare(`insert into conteo_ajustes (id, producto_id, codigo, nombre, motivo, cantidad, antes, despues, ajustado_por, ajustado_en)
    values ('fep1', ?, 'ED-000090', 'Bolsa FEP', 'descarte', 1, 3, 2, ?, ?)`).run(FEP, DUENO, new Date().toISOString());
  assert.equal(((await pedir('/api/conteo/ajustes', undefined, 'GET')).cuerpo as unknown[]).length, 0);
});
