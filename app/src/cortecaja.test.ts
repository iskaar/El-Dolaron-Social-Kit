// node --test src/cortecaja.test.ts
// Corte de caja (Issue #100) contra SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { contadoDe, DENOMINACIONES } from '../public/venta.js';

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
const cortar = (pedir: Pedir, caja: string, conteo: Record<string, number>, extra: Record<string, unknown> = {}) =>
  pedir('/api/cortes', { id: crypto.randomUUID(), caja, conteo, tarjeta_terminal: 0, ...extra });

test('contadoDe suma billetes y monedas, y rechaza lo que no existe', () => {
  assert.equal(contadoDe({ 50000: 1, 20000: 2, 50: 3 }), 90150);
  assert.equal(contadoDe({}), 0);
  assert.equal(contadoDe({ 30000: 1 }), null);          // no hay billete de $300
  assert.equal(contadoDe({ 10000: -1 }), null);
  assert.equal(contadoDe({ 10000: 1.5 }), null);
  assert.ok(DENOMINACIONES.includes(2000));
});

test('el corte cuadra: fondo + efectivo - devoluciones - retiros, y tarjeta, transferencia y Dolarones aparte', async () => {
  const { pedir } = tienda();
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', pin: '1234', acepta_bases: true,
  })).cuerpo;

  await vender(pedir, 'Caja 1');                                                      // +250 efectivo
  await vender(pedir, 'Caja 1', { forma_pago: 'tarjeta', efectivo: 0 });              // +250 tarjeta
  await vender(pedir, 'Caja 1', { forma_pago: 'transferencia', efectivo: 0 });        // +250 transferencia
  const cancelada = await vender(pedir, 'Caja 1');                                    // +250 y luego -250
  assert.equal((await cancelar(pedir, cancelada.id, 'Caja 1')).status, 200);
  await vender(pedir, 'Caja 1', { cliente_id: socio.id, dolarones: 5000, pin: '1234', efectivo: 20000 }); // 50 D + 200
  await vender(pedir, 'Caja 2');                                                      // otra caja: no cuenta
  assert.equal((await pedir('/api/retiros', { id: crypto.randomUUID(), caja: 'Caja 1', importe: 20000, motivo: 'caja fuerte' })).status, 201);

  // Esperado: 500 + (250 + 250 + 200) - 250 - 200 = 750
  const r = await cortar(pedir, 'Caja 1', { 50000: 1, 20000: 1, 5000: 1 }, { tarjeta_terminal: 25000, notas: 'todo bien' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const c = r.cuerpo;
  assert.equal(c.tickets, 5);
  assert.equal(c.fondo_inicial, 50000);
  assert.equal(c.efectivo_ventas, 70000);
  assert.equal(c.efectivo_devoluciones, 25000);
  assert.equal(c.retiros, 20000);
  assert.equal(c.efectivo_esperado, 75000);
  assert.equal(c.efectivo_contado, 75000);
  assert.equal(c.diferencia, 0);
  assert.equal(c.tarjeta_sistema, 25000);
  assert.equal(c.tarjeta_terminal, 25000);
  assert.equal(c.transferencias, 25000);
  assert.equal(c.dolarones, 5000);
  assert.equal(c.fondo_siguiente, 50000);
  assert.equal(c.entregado, 25000);
  assert.equal(c.cajero, DUENO);
  assert.equal(c.desde, null);
  assert.equal(c.notas, 'todo bien');
});

test('cancelar en otra caja o en otro turno resta donde se devuelve el dinero', async () => {
  const { pedir } = tienda();
  const venta = await vender(pedir, 'Caja 1');
  const primero = (await cortar(pedir, 'Caja 1', { 50000: 1, 20000: 1, 5000: 1 })).cuerpo;   // 500 + 250
  assert.equal(primero.diferencia, 0);

  assert.equal((await cancelar(pedir, venta.id, 'Caja 2')).status, 200);   // el dinero sale de la Caja 2

  const caja1 = (await cortar(pedir, 'Caja 1', { 50000: 1 })).cuerpo;
  assert.equal(caja1.tickets, 0);
  assert.equal(caja1.fondo_inicial, 50000);                                 // lo que se quedo en el corte anterior
  assert.equal(caja1.efectivo_devoluciones, 0);
  assert.equal(caja1.diferencia, 0);
  assert.equal(caja1.desde, primero.hasta);

  // Caja 2 arranca con el fondo de la configuracion, devolvio 250 y contaron 200: faltan 50.
  const caja2 = (await cortar(pedir, 'Caja 2', { 20000: 1 })).cuerpo;
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
  const primero = await pedir('/api/cortes', { id, caja: 'Caja 1', conteo: { 100000: 1, 20000: 1, 5000: 1 }, tarjeta_terminal: 0 });
  assert.equal(primero.cuerpo.efectivo_esperado, 125000);
  assert.equal(primero.cuerpo.entregado, 25000);
  // Reenvio con otro conteo: regresa el corte original, no se vuelve a contar.
  const reenvio = await pedir('/api/cortes', { id, caja: 'Caja 1', conteo: { 100000: 2 }, tarjeta_terminal: 0 });
  assert.equal(reenvio.status, 200);
  assert.equal(reenvio.cuerpo.efectivo_contado, 125000);
  const { n } = db.prepare('select count(*) as n from cortes').get() as { n: number };
  assert.equal(n, 1);
  assert.equal((await pedir('/api/cortes?caja=Caja%201')).cuerpo.id, id);   // para reimprimir
});

test('datos invalidos no hacen corte ni retiro', async () => {
  const { pedir } = tienda();
  assert.equal((await cortar(pedir, '', {})).status, 400);
  assert.equal((await cortar(pedir, 'Caja 1', { 30000: 1 })).status, 400);
  assert.equal((await cortar(pedir, 'Caja 1', {}, { tarjeta_terminal: -1 })).status, 400);
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
  assert.equal((await cortar(pedir, 'Caja 1', { 50000: 1, 20000: 1, 5000: 1 })).status, 201);
  assert.equal((await pedir('/api/reportes?dias=1')).status, 403);

  como('captura@prueba.mx');
  assert.equal((await cortar(pedir, 'Caja 1', {})).status, 403);
  assert.equal((await pedir('/api/retiros', { id: crypto.randomUUID(), caja: 'Caja 1', importe: 100, motivo: 'x' })).status, 403);

  como(DUENO);
  const r = (await pedir('/api/reportes?dias=1')).cuerpo;
  assert.equal(r.cortes.length, 1);
  assert.equal(r.cortes[0].caja, 'Caja 1');
  assert.equal(r.cortes[0].cajero, 'caja@prueba.mx');
});
