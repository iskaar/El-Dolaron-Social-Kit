// node --test src/cajeros.test.ts
// PIN del cajero (Issue #112): la computadora de caja no cobra sola.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';

const TIENDA = 'tienda@prueba.mx';
const ANA = 'ana@prueba.mx';

function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en) values
    ('${TIENDA}', 'Computadora', 'computadora', 1, '', '', ''),
    ('${ANA}', 'Ana', 'cajero', 1, 'Caja 2', '', '')`).run();
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const venta = (token?: string) => t.pedir('/api/ventas', {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1',
  }, 'POST', token ? { 'x-cajero': token } : {});
  return { ...t, como, venta };
}

test('la computadora sin PIN no cobra; con el PIN de Ana, la venta queda a nombre de Ana y en su caja', async () => {
  const { db, pedir, como, venta } = montar();
  assert.equal((await pedir('/api/cuentas/pin', { correo: ANA, pin: '1234' }, 'PUT')).status, 400);   // 6 digitos
  assert.equal((await pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT')).status, 200);

  como(TIENDA);
  const sinPin = await venta();
  assert.equal(sinPin.status, 401);
  assert.equal(sinPin.cuerpo.pin, true);
  assert.deepEqual((await pedir('/api/cajeros')).cuerpo, [{ correo: ANA, nombre: 'Ana' }]);   // el dueno no tiene PIN aun

  const { cuerpo: sesion, status } = await pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' });
  assert.equal(status, 201);
  assert.equal(sesion.nombre, 'Ana');
  assert.equal((await pedir('/api/yo', undefined, 'GET', { 'x-cajero': sesion.token })).cuerpo.cajero.nombre, 'Ana');

  assert.equal((await venta(sesion.token)).status, 201);
  assert.deepEqual({ ...db.prepare('select cajero, caja from ventas').get() }, { cajero: ANA, caja: 'Caja 2' });
  assert.ok(!JSON.stringify(db.prepare('select * from sesiones_cajero').all()).includes(sesion.token), 'solo el hash');

  // Salir cierra la sesion.
  await pedir('/api/cajeros/salir', {}, 'POST', { 'x-cajero': sesion.token });
  assert.equal((await venta(sesion.token)).status, 401);
});

test('el PIN solo abre lo de caja: con el del dueno, reportes y cuentas siguen cerrados', async () => {
  const { pedir, como, venta } = montar();
  await pedir('/api/cuentas/pin', { correo: DUENO, pin: '111222' }, 'PUT');
  como(TIENDA);
  const token = (await pedir('/api/cajeros/entrar', { correo: DUENO, pin: '111222' })).cuerpo.token;
  assert.equal((await venta(token)).status, 201);
  assert.equal((await pedir('/api/reportes?dias=1', undefined, 'GET', { 'x-cajero': token })).status, 403);
  assert.equal((await pedir('/api/cuentas', undefined, 'GET', { 'x-cajero': token })).status, 403);
  assert.equal((await pedir('/api/cuentas/pin', { correo: ANA, pin: '000000' }, 'PUT', { 'x-cajero': token })).status, 403);
});

test('5 PIN incorrectos bloquean 15 minutos, aun con el correcto', async () => {
  const { pedir, como } = montar();
  await pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
  como(TIENDA);
  for (let i = 0; i < 4; i++) assert.equal((await pedir('/api/cajeros/entrar', { correo: ANA, pin: '000000' })).status, 403);
  assert.match((await pedir('/api/cajeros/entrar', { correo: ANA, pin: '000000' })).cuerpo.error, /bloqueo/);
  assert.equal((await pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).status, 423);
});

test('desactivar a Ana o cambiarle el PIN corta su sesion al momento', async () => {
  const { db, pedir, como, venta } = montar();
  await pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
  como(TIENDA);
  const entrarAna = async () => (await pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).cuerpo.token;

  let token = await entrarAna();
  db.prepare('update usuarios set activo = 0 where correo = ?').run(ANA);
  assert.equal((await venta(token)).status, 401);
  db.prepare('update usuarios set activo = 1 where correo = ?').run(ANA);

  token = await entrarAna();
  como(DUENO);
  await pedir('/api/cuentas/pin', { correo: ANA, pin: '999888' }, 'PUT');
  como(TIENDA);
  assert.equal((await venta(token)).status, 401);
});

test('un cajero con su propio correo cobra como siempre, sin PIN', async () => {
  const { db, como, venta } = montar();
  como(ANA);
  assert.equal((await venta()).status, 201);
  assert.equal((db.prepare('select cajero from ventas').get() as { cajero: string }).cajero, ANA);
});
