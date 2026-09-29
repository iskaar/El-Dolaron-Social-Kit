// node --test src/cortecaja.test.ts
// Corte de caja (Issue #100) contra SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';

type Pedir = ReturnType<typeof tienda>['pedir'];

// Ventas de $250 (el producto de prueba) en la caja que se diga.
const vender = (pedir: Pedir, caja: string, extra: Record<string, unknown> = {}) => {
  const venta = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
    forma_pago: 'efectivo', efectivo: 25000, caja, ...extra,
  };
  return pedir('/api/ventas', venta).then((r) => ({ ...r, id: venta.id }));
};
const cancelar = (pedir: Pedir, id: string, caja: string) =>
  pedir(`/api/ventas/${id}/cancelar`, { motivo: 'prueba', caja });
// El cajero escribe solo el total de efectivo del cajon (Isaac, 28/09).
const cortar = (pedir: Pedir, caja: string, contado: number, extra: Record<string, unknown> = {}) =>
  pedir('/api/cortes', { id: crypto.randomUUID(), caja, efectivo_contado: contado, tarjeta_terminal: 0, ...extra });
const salida = (pedir: Pedir, tipo: string, importe: number, caja = 'Caja 1') =>
  pedir('/api/retiros', { id: crypto.randomUUID(), tipo, caja, importe, motivo: tipo === 'gasto' ? 'garrafon de agua' : 'caja fuerte' });

test('el corte cuadra: fondo + efectivo - devoluciones - retiros, y tarjeta, transferencia y Dolarones aparte', async () => {
  const { pedir } = tienda();
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true,
  })).cuerpo;

  await vender(pedir, 'Caja 1');                                                      // +250 efectivo
  await vender(pedir, 'Caja 1', { forma_pago: 'tarjeta', efectivo: 0 });              // +250 tarjeta
  await vender(pedir, 'Caja 1', { forma_pago: 'transferencia', efectivo: 0 });        // +250 transferencia
  const cancelada = await vender(pedir, 'Caja 1');                                    // cancelada antes del corte: no sale
  assert.equal((await cancelar(pedir, cancelada.id, 'Caja 1')).status, 200);
  await vender(pedir, 'Caja 1', { cliente_id: socio.id, dolarones: 5000, pin: '1234', efectivo: 20000 }); // 50 D + 200
  await vender(pedir, 'Caja 2');                                                      // otra caja: no cuenta
  assert.equal((await salida(pedir, 'retiro', 20000)).status, 201);
  assert.equal((await salida(pedir, 'gasto', 5000)).status, 201);

  // Esperado: 500 + (250 + 200) - 200 retiro - 50 gasto = 700
  const r = await cortar(pedir, 'Caja 1', 70000, { tarjeta_terminal: 25000, notas: 'todo bien' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const c = r.cuerpo;
  assert.equal(c.tickets, 4);
  assert.equal(c.fondo_inicial, 50000);
  assert.equal(c.efectivo_ventas, 45000);
  assert.equal(c.efectivo_devoluciones, 0);
  assert.equal(c.retiros, 20000);
  assert.equal(c.gastos, 5000);
  assert.equal(c.efectivo_esperado, 70000);
  assert.equal(c.efectivo_contado, 70000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.tarjeta_sistema, 25000);
  assert.equal(c.tarjeta_terminal, 25000);
  assert.equal(c.transferencias, 25000);
  assert.equal(c.dolarones, 5000);
  assert.equal(c.fondo_siguiente, 50000);
  assert.equal(c.entregado, 20000);
  assert.equal(c.cajero, DUENO);
  assert.equal(c.desde, null);
  assert.equal(c.notas, 'todo bien');
});

test('cobrada en una caja y cancelada en otra antes de cualquier corte: no sale en ninguno', async () => {
  const { pedir } = tienda();
  const venta = await vender(pedir, 'Caja 1');
  await vender(pedir, 'Caja 1');
  assert.equal((await cancelar(pedir, venta.id, 'Caja 3')).status, 200);

  const caja3 = (await cortar(pedir, 'Caja 3', 50000)).cuerpo;
  assert.equal(caja3.efectivo_devoluciones, 0);
  assert.equal(caja3.diferencia, 0);

  const caja1 = (await cortar(pedir, 'Caja 1', 75000)).cuerpo;   // 500 + solo la vigente
  assert.equal(caja1.tickets, 1);
  assert.equal(caja1.efectivo_ventas, 25000);
  assert.equal(caja1.efectivo_devoluciones, 0);
  assert.equal(caja1.diferencia, 0);
});

test('cancelar en otra caja o en otro turno resta donde se devuelve el dinero', async () => {
  const { pedir } = tienda();
  const venta = await vender(pedir, 'Caja 1');
  const primero = (await cortar(pedir, 'Caja 1', 75000)).cuerpo;   // 500 + 250
  assert.equal(primero.diferencia, 0);

  assert.equal((await cancelar(pedir, venta.id, 'Caja 2')).status, 200);   // el dinero sale de la Caja 2

  const caja1 = (await cortar(pedir, 'Caja 1', 50000)).cuerpo;
  assert.equal(caja1.tickets, 0);
  assert.equal(caja1.fondo_inicial, 50000);                                 // lo que se quedo en el corte anterior
  assert.equal(caja1.efectivo_devoluciones, 0);
  assert.equal(caja1.diferencia, 0);
  assert.equal(caja1.desde, primero.hasta);

  // Caja 2 arranca con el fondo de la configuracion, devolvio 250 y contaron 200: faltan 50.
  const caja2 = (await cortar(pedir, 'Caja 2', 20000)).cuerpo;
  assert.equal(caja2.efectivo_devoluciones, 25000);
  assert.equal(caja2.efectivo_esperado, 25000);
  assert.equal(caja2.diferencia, -5000);
  assert.equal(caja2.fondo_siguiente, 20000);                               // no alcanza el fondo: se queda todo
  assert.equal(caja2.entregado, 0);
});

test('el fondo sale de la configuracion y un corte no se cuenta dos veces', async () => {
  const { db, pedir } = tienda();
  db.prepare(`update config set valor = '100000' where clave = 'fondo_caja'`).run();
  await vender(pedir, 'Caja 1');
  const id = crypto.randomUUID();
  const primero = await pedir('/api/cortes', { id, caja: 'Caja 1', efectivo_contado: 125000, tarjeta_terminal: 0 });
  assert.equal(primero.cuerpo.efectivo_esperado, 125000);
  assert.equal(primero.cuerpo.entregado, 25000);
  // Reenvio con otro conteo: regresa el corte original, no se vuelve a contar.
  const reenvio = await pedir('/api/cortes', { id, caja: 'Caja 1', efectivo_contado: 200000, tarjeta_terminal: 0 });
  assert.equal(reenvio.status, 200);
  assert.equal(reenvio.cuerpo.efectivo_contado, 125000);
  const { n } = db.prepare('select count(*) as n from cortes').get() as { n: number };
  assert.equal(n, 1);
  assert.equal((await pedir('/api/cortes?caja=Caja%201')).cuerpo.id, id);   // para reimprimir
});

test('datos invalidos no hacen corte ni retiro', async () => {
  const { pedir } = tienda();
  assert.equal((await cortar(pedir, '', 0)).status, 400);
  assert.equal((await cortar(pedir, 'Caja 1', -100)).status, 400);
  assert.equal((await cortar(pedir, 'Caja 1', 10.5)).status, 400);
  assert.equal((await cortar(pedir, 'Caja 1', 0, { tarjeta_terminal: -1 })).status, 400);
  assert.equal((await salida(pedir, 'propina', 100)).status, 400);
  assert.equal((await pedir('/api/retiros', { id: crypto.randomUUID(), caja: 'Caja 1', importe: 0, motivo: 'x' })).status, 400);
  assert.equal((await pedir('/api/retiros', { id: crypto.randomUUID(), caja: 'Caja 1', importe: 100, motivo: '' })).status, 400);
});

test('la venta guarda caja y cajero; el cajero corta y retira, quien solo captura no; el dueno ve los cortes', async () => {
  const { db, env, pedir } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('caja@prueba.mx', 'K', 'cajero', 1, '', ''), ('captura@prueba.mx', 'C', 'capturista', 1, '', '')`).run();
  const como = (correo: string) => { (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };

  como('caja@prueba.mx');
  const venta = await vender(pedir, 'Caja 1');
  const fila = db.prepare('select caja, cajero from ventas where id = ?').get(venta.id) as { caja: string; cajero: string };
  assert.deepEqual({ ...fila }, { caja: 'Caja 1', cajero: 'caja@prueba.mx' });
  assert.equal((await cortar(pedir, 'Caja 1', 75000)).status, 201);
  assert.equal((await pedir('/api/reportes?dias=1')).status, 403);

  como('captura@prueba.mx');
  assert.equal((await cortar(pedir, 'Caja 1', 0)).status, 403);
  assert.equal((await pedir('/api/retiros', { id: crypto.randomUUID(), caja: 'Caja 1', importe: 100, motivo: 'x' })).status, 403);

  como(DUENO);
  const r = (await pedir('/api/reportes?dias=1')).cuerpo;
  assert.equal(r.cortes.length, 1);
  assert.equal(r.cortes[0].caja, 'Caja 1');
  assert.equal(r.cortes[0].cajero, 'caja@prueba.mx');
});

test('gastos: el cajero registra hasta $100 sin aprobacion; mas de $100, solo el dueno', async () => {
  const { db, env, pedir } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('caja@prueba.mx', 'K', 'cajero', 1, '', '')`).run();
  const como = (correo: string) => { (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };

  como('caja@prueba.mx');
  const gasto = await salida(pedir, 'gasto', 10000);                       // $100 justos: pasa
  assert.equal(gasto.status, 201);
  assert.equal(gasto.cuerpo.tipo, 'gasto');
  assert.equal(gasto.cuerpo.cajero, 'caja@prueba.mx');
  const mayor = await salida(pedir, 'gasto', 10001);                       // $100.01: no
  assert.equal(mayor.status, 403);
  assert.match(mayor.cuerpo.error, /dueno/);
  assert.equal((await salida(pedir, 'retiro', 500000)).status, 201);       // un retiro no tiene tope

  como(DUENO);
  assert.equal((await salida(pedir, 'gasto', 35000)).status, 201);          // el dueno registra el gasto mayor

  const r = (await pedir('/api/reportes?dias=1')).cuerpo;
  assert.deepEqual(r.retiros.map((x: { tipo: string; importe: number }) => [x.tipo, x.importe]).sort(),
    [['gasto', 10000], ['gasto', 35000], ['retiro', 500000]].sort());
});

test('el cajero con caja asignada cobra, gasta y corta en su caja, entre en la computadora que entre', async () => {
  const { db, env, pedir } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('ana@prueba.mx', 'Ana', 'cajero', 1, '', '')`).run();
  const como = (correo: string) => { (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };

  // El dueno le asigna la Caja 1 en /cuentas; una caja que no existe no se guarda.
  assert.equal((await pedir('/api/cuentas', { correo: 'ana@prueba.mx', nombre: 'Ana', roles: ['cajero'], caja: 'Caja 9' }, 'PUT')).status, 400);
  const guardada = await pedir('/api/cuentas', { correo: 'ana@prueba.mx', nombre: 'Ana', roles: ['cajero'], caja: 'Caja 1' }, 'PUT');
  assert.equal(guardada.cuerpo.caja, 'Caja 1');
  // Guardar sin mandar la caja (el alta, p.ej.) no se la quita.
  await pedir('/api/cuentas', { correo: 'ana@prueba.mx', nombre: 'Ana L.', roles: ['cajero'] }, 'PUT');

  como('ana@prueba.mx');
  assert.equal((await pedir('/api/yo')).cuerpo.usuario.caja, 'Caja 1');
  // Ana esta en la computadora de la Caja 2: todo cae en la Caja 1.
  const venta = await vender(pedir, 'Caja 2');
  assert.equal((db.prepare('select caja from ventas where id = ?').get(venta.id) as { caja: string }).caja, 'Caja 1');
  const gasto = await salida(pedir, 'gasto', 3000, 'Caja 2');
  assert.equal(gasto.cuerpo.caja, 'Caja 1');
  const corte = (await cortar(pedir, 'Caja 2', 72000)).cuerpo;
  assert.equal(corte.caja, 'Caja 1');
  assert.equal(corte.efectivo_esperado, 50000 + 25000 - 3000);
  assert.equal(corte.diferencia, 0);

  // El dueno no tiene caja asignada: usa la de la computadora.
  como(DUENO);
  const suya = await vender(pedir, 'Caja 2');
  assert.equal((db.prepare('select caja from ventas where id = ?').get(suya.id) as { caja: string }).caja, 'Caja 2');
});
