// node --test src/tiendas.test.ts
// Sucursales 1/3 (#793, #794): cada caja y cada cuenta pertenece a una tienda; la tienda la decide el servidor.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { TIENDAS, CAJAS, cajasDe, tiendaDe, esTienda, TIENDA_CENTRAL, type Usuario } from './cuentas.ts';

const PC = 'pc@prueba.mx';
const ANA = 'ana@prueba.mx';

function montar(tiendaPc: string, cajaAna = '') {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, tienda, creado_en, actualizado_en) values
    (?, 'Computadora', 'computadora', 1, '', ?, '', ''), (?, 'Ana', 'cajero', 1, ?, '', '', '')`).run(PC, tiendaPc, ANA, cajaAna);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const entrar = async () => {
    como(DUENO);
    await t.pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
    como(PC);
    return (await t.pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).cuerpo.token as string;
  };
  const venta = (token: string, extra: Record<string, unknown> = {}) => t.pedir('/api/ventas', {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, ...extra,
  }, 'POST', { 'x-cajero': token });
  const stock = () => (t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;
  const cuenta = (roles: string[], extra: Record<string, unknown> = {}) => ({ tienda: undefined, roles, ...extra }) as unknown as Usuario;
  return { ...t, como, entrar, venta, stock, cuenta };
}

test('constantes: tres tiendas, cajas únicas entre tiendas y CAJAS las reúne todas', () => {
  assert.deepEqual(Object.keys(TIENDAS), ['soledad', 'salk', 'romero']);
  assert.deepEqual(cajasDe('soledad'), ['Caja 1', 'Caja 2', 'Caja 3']);
  assert.deepEqual(cajasDe('salk'), ['Salk 1', 'Salk 2']);
  assert.deepEqual(cajasDe('romero'), ['Romero 1', 'Romero 2']);
  assert.deepEqual(cajasDe('inexistente'), []);
  assert.equal(CAJAS.length, 7);
  assert.equal(new Set(CAJAS).size, 7);
  assert.ok(esTienda('salk') && !esTienda('toString') && !esTienda(''));
});

test('R1: tiendaDe — la de la cuenta; sin tienda, Soledad; la computadora sin tienda no cobra (R2)', () => {
  const u = (roles: string[], tiendaCuenta: string) => ({ roles, tienda: tiendaCuenta }) as unknown as Usuario;
  assert.equal(tiendaDe(u(['computadora'], 'salk')), 'salk');
  assert.equal(tiendaDe(u(['cajero'], 'romero')), 'romero');
  assert.equal(tiendaDe(u(['dueno'], '')), TIENDA_CENTRAL);
  assert.equal(tiendaDe(null), TIENDA_CENTRAL);
  assert.equal(tiendaDe(u(['computadora'], '')), '');
});

test('/api/yo informa la tienda y las cajas de esa tienda; la caja del cajero de otra tienda no se informa', async () => {
  const { pedir, como, entrar } = montar('salk', 'Caja 2');
  como(PC);
  const sinPin = await pedir('/api/yo');
  assert.equal(sinPin.cuerpo.tienda, 'salk');
  assert.equal(sinPin.cuerpo.tienda_nombre, 'Avenida Salk');
  assert.deepEqual(sinPin.cuerpo.cajas, ['Salk 1', 'Salk 2']);
  const token = await entrar();
  assert.equal((await pedir('/api/yo', undefined, 'GET', { 'x-cajero': token })).cuerpo.cajero.caja, '');
  como(DUENO);
  const dueno = await pedir('/api/yo');
  assert.equal(dueno.cuerpo.tienda, 'soledad');
  assert.deepEqual(dueno.cuerpo.cajas, ['Caja 1', 'Caja 2', 'Caja 3']);
});

test('Soledad: la venta guarda tienda soledad, usa la caja asignada y el reintento no cambia nada', async () => {
  const { db, entrar, venta, stock } = montar('soledad', 'Caja 2');
  const token = await entrar();
  const id = crypto.randomUUID();
  const primera = await venta(token, { id, caja: 'Caja 1' });
  assert.equal(primera.status, 201);
  assert.deepEqual({ ...(db.prepare('select tienda, caja from ventas where id = ?').get(id) as object) }, { tienda: 'soledad', caja: 'Caja 2' });
  assert.equal(stock(), 49);
  const reintento = await venta(token, { id, caja: 'Caja 1' });
  assert.equal(reintento.status, 200);
  assert.equal(stock(), 49);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 1);
});

test('cajero con caja asignada de otra tienda: se usa la elegida en la computadora', async () => {
  const { db, entrar, venta } = montar('soledad', 'Salk 1');
  const token = await entrar();
  const id = crypto.randomUUID();
  assert.equal((await venta(token, { id, caja: 'Caja 3' })).status, 201);
  assert.equal((db.prepare('select caja from ventas where id = ?').get(id) as { caja: string }).caja, 'Caja 3');
});

test('una caja que no es de la tienda rechaza la venta completa, el corte, el retiro y el cajón', async () => {
  const { db, entrar, venta, pedir, stock } = montar('soledad');
  const token = await entrar();
  const h = { 'x-cajero': token };
  assert.equal((await venta(token, { caja: 'Salk 1' })).status, 400);
  assert.equal(stock(), 50);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 0);
  assert.equal((await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Romero 1', efectivo_contado: 0, tarjeta_terminal: 0 }, 'POST', h)).status, 400);
  assert.equal((await pedir('/api/retiros', { id: crypto.randomUUID(), caja: 'Salk 2', importe: 100, motivo: 'x' }, 'POST', h)).status, 400);
  assert.equal((await pedir('/api/cajon', { id: crypto.randomUUID(), abierto_en: new Date().toISOString(), caja: 'Salk 2' }, 'POST', h)).status, 400);
  assert.equal((await venta(token, { imprimir_en: 'Salk 1', forma_pago: 'tarjeta' })).status, 400);
});

test('la computadora sin tienda no cobra (R2): 403 en lo de caja, después del PIN', async () => {
  const { pedir, como, db, stock } = montar('', '');
  como(PC);
  const sinPin = await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000 });
  assert.equal(sinPin.status, 401);
  como(DUENO);
  await pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
  como(PC);
  const token = (await pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).cuerpo.token;
  const r = await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000 }, 'POST', { 'x-cajero': token });
  assert.equal(r.status, 403);
  assert.match(r.cuerpo.error, /tienda/);
  assert.equal(stock(), 50);
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 0);
});

const conteos = (db: DatabaseSync) => Object.fromEntries((db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[])
  .map(({ name }) => [name, (db.prepare(`select count(*) as n from "${name}"`).get() as { n: number }).n]));

test('terminal de sucursal: vender una pieza que nunca llegó aborta el ticket sin escribir nada; los pedidos ya no se rechazan por la tienda (#800)', async () => {
  const { db, entrar, venta, pedir, stock } = montar('salk');
  const token = await entrar();
  const antes = conteos(db);
  const r = await venta(token, { caja: 'Salk 1' });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /existencia suficiente en esta sucursal/);
  // #800: un pedido desde sucursal ya llega a la validación (400 por el cuerpo vacío), no a un rechazo por tienda.
  assert.equal((await pedir('/api/pedidos', {}, 'POST', { 'x-cajero': token })).status, 400);
  assert.equal(stock(), 50, 'Soledad no se toca');
  assert.deepEqual(conteos(db), antes, 'ni venta, ni líneas, ni fila de existencia a medias');
});

test('terminal de sucursal: lo que no mueve existencia sí funciona con su caja (corte)', async () => {
  const { entrar, pedir } = montar('romero');
  const token = await entrar();
  const r = await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Romero 1', efectivo_contado: 0, sin_efectivo: true, tarjeta_terminal: 0 }, 'POST', { 'x-cajero': token });
  assert.ok(r.status < 400, JSON.stringify(r.cuerpo));
  assert.equal((await pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 0, tarjeta_terminal: 0 }, 'POST', { 'x-cajero': token })).status, 400);
});

test('/cuentas: lista las tiendas; exige tienda al dar rol computadora; la caja debe ser de la tienda de la cuenta', async () => {
  const { pedir } = montar('soledad');
  const lista = await pedir('/api/cuentas');
  assert.deepEqual(lista.cuerpo.tiendas.map((x: { clave: string }) => x.clave), ['soledad', 'salk', 'romero']);
  const base = { correo: 'nueva@prueba.mx', nombre: 'Nueva', roles: ['computadora'] };
  assert.equal((await pedir('/api/cuentas', base, 'PUT')).status, 400);
  assert.equal((await pedir('/api/cuentas', { ...base, tienda: 'otra' }, 'PUT')).status, 400);
  const ok = await pedir('/api/cuentas', { ...base, tienda: 'salk' }, 'PUT');
  assert.equal(ok.status, 200);
  assert.equal(ok.cuerpo.tienda, 'salk');
  assert.equal((await pedir('/api/cuentas', { correo: 'c@prueba.mx', nombre: 'C', roles: ['cajero'], tienda: 'salk', caja: 'Caja 1' }, 'PUT')).status, 400);
  assert.equal((await pedir('/api/cuentas', { correo: 'c@prueba.mx', nombre: 'C', roles: ['cajero'], tienda: 'salk', caja: 'Salk 2' }, 'PUT')).status, 200);
  // Sin `tienda` en el cuerpo (versión vieja de /cuentas) no se toca la guardada.
  const sinCampo = await pedir('/api/cuentas', { ...base, nombre: 'Nueva 2' }, 'PUT');
  assert.equal(sinCampo.status, 200);
  assert.equal(sinCampo.cuerpo.tienda, 'salk');
  // Desactivarla no exige tienda.
  assert.equal((await pedir('/api/cuentas', { correo: 'x@prueba.mx', nombre: 'X', roles: ['computadora'], activo: false }, 'PUT')).status, 200);
});

test('migración 076: las computadoras activas quedan en Soledad, las demás cuentas sin tienda', async () => {
  const { readFileSync } = await import('node:fs');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const previas = (await import('node:fs')).readdirSync('.').filter((f) => /^migracion-\d+/.test(f) && f < 'migracion-076').sort();
  for (const f of ['schema.sql', ...previas]) db.exec(readFileSync(f, 'utf8'));
  db.exec(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('a@x.mx','A','computadora',1,'',''), ('b@x.mx','B','computadora',0,'',''), ('c@x.mx','C','cajero,computadora',1,'',''), ('d@x.mx','D','dueno',1,'','')`);
  db.exec(readFileSync('migracion-076-tiendas.sql', 'utf8'));
  const filas = db.prepare('select correo, tienda from usuarios order by correo').all().map((f) => ({ ...f }));
  assert.deepEqual(filas, [{ correo: 'a@x.mx', tienda: 'soledad' }, { correo: 'b@x.mx', tienda: '' }, { correo: 'c@x.mx', tienda: 'soledad' }, { correo: 'd@x.mx', tienda: '' }]);
});
