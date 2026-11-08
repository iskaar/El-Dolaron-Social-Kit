// node --test src/plano.test.ts
// Plano del local (#756): lectura para piso, asignar áreas solo el dueño, validación del letrero y del empleado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';
import { NUM, LETREROS } from '../public/plano.js';
import { letrero } from '../public/letreros.js';

function escenario() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('ana@prueba.mx', 'ana', 'cajero', 1, '', '')`).run();
  const empleado = async (nombre: string, correo = '') => {
    const id = crypto.randomUUID();
    assert.equal((await t.pedir(`/api/nomina/empleados/${id}`, { nombre, periodo: 'diario', pago_dia: 30000, dias: [1], pin: '123456', correo })).status, 201);
    return id;
  };
  const como = (correo: string) => { t.env.DEV_USUARIO = correo; };
  return { t, empleado, como };
}

test('el plano tiene los letreros 1-36 una sola vez y letreros.js solo da letreros del plano', () => {
  const nums = Object.values(NUM).flat().sort((a, b) => (a as number) - (b as number));
  assert.deepEqual(nums, Array.from({ length: LETREROS }, (_, i) => i + 1));
  for (const categoria of ['ropa', 'hogar', 'juguetes', 'despensa', 'otros', ''])
    for (const nombre of ['', 'Vestido', 'Toalla de playa', 'Peluche', 'Detergente']) assert.ok(nums.includes(letrero({ categoria, nombre })));
});

test('GET /api/plano: forma, quién soy y solo empleados activos', async () => {
  const { t, empleado, como } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    const baja = await empleado('Baja');
    assert.equal((await t.pedir('/api/plano', { areas: { 3: ana, 7: baja } }, 'PUT')).status, 200);
    t.db.prepare('update empleados set activo = 0 where id = ?').run(baja);
    como('ana@prueba.mx');
    const r = await t.pedir('/api/plano');
    assert.equal(r.status, 200);
    assert.deepEqual(r.cuerpo, { areas: { 3: ana }, empleados: [{ id: ana, nombre: 'Ana' }], yo: ana, puede_asignar: false });
    como(DUENO);
    const dueno = await t.pedir('/api/plano');
    assert.equal(dueno.cuerpo.yo, null);
    assert.equal(dueno.cuerpo.puede_asignar, true);
  } finally { t.db.close(); }
});

test('el dueño asigna y se conserva; otro rol recibe 403 y no cambia nada', async () => {
  const { t, empleado, como } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    como('ana@prueba.mx');
    assert.equal((await t.pedir('/api/plano', { areas: { 1: ana } }, 'PUT')).status, 403);
    como(DUENO);
    assert.equal((await t.pedir('/api/plano', { areas: { 1: ana, 36: ana } }, 'PUT')).status, 200);
    como('ana@prueba.mx');
    assert.deepEqual((await t.pedir('/api/plano')).cuerpo.areas, { 1: ana, 36: ana });
    como(DUENO);
    assert.equal((await t.pedir('/api/plano', { areas: {} }, 'PUT')).status, 200);   // quitar todas
    assert.deepEqual((await t.pedir('/api/plano')).cuerpo.areas, {});
  } finally { t.db.close(); }
});

test('letrero fuera de 1-36 o empleado inexistente/inactivo: 400 y no guarda', async () => {
  const { t, empleado } = escenario();
  try {
    const ana = await empleado('Ana');
    const baja = await empleado('Baja');
    t.db.prepare('update empleados set activo = 0 where id = ?').run(baja);
    for (const areas of [{ 0: ana }, { 37: ana }, { '01': ana }, { x: ana }, { 1.5: ana }, { 1: 'nadie' }, { 1: baja }, { 1: 7 }, [ana]]) {
      assert.equal((await t.pedir('/api/plano', { areas }, 'PUT')).status, 400, JSON.stringify(areas));
    }
    assert.equal((await t.pedir('/api/plano', {}, 'PUT')).status, 400);
    assert.equal(t.db.prepare(`select count(*) as n from config where clave = 'plano_areas'`).get()!.n, 0);
  } finally { t.db.close(); }
});
