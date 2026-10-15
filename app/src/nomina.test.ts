import test from 'node:test';
import assert from 'node:assert/strict';
import { DUENO, tienda } from './prueba-d1.ts';
import { devengarNomina } from './nomina.ts';

const idDiario = '11111111-1111-4111-8111-111111111111';
const idQuincena = '22222222-2222-4222-8222-222222222222';

test('devengo diario y quincenal idempotente por el día de México', async () => {
  const t = tienda();
  t.db.prepare(`insert into empleados (id,nombre,periodo,sueldo,creado_en) values (?, 'Diario','diario',1000,''), (?, 'Quincena','quincenal',150000,'')`).run(idDiario,idQuincena);
  const local15 = Date.UTC(2026, 9, 15, 6);
  await devengarNomina(t.env, local15); await devengarNomina(t.env, local15);
  assert.equal(t.db.prepare('select count(*) n from nomina_movimientos').get()!.n, 2);
  assert.equal(t.db.prepare('select importe from nomina_movimientos where empleado_id=?').get(idDiario)!.importe, 1000);
  assert.equal(t.db.prepare('select importe from nomina_movimientos where empleado_id=?').get(idQuincena)!.importe, 150000);
});

test('falta quincenal descuenta sueldo entre 15; adelanto y pago de caja se reflejan en saldo y corte', async () => {
  const t = tienda();
  t.db.prepare(`insert into empleados (id,nombre,periodo,sueldo,creado_en) values (?, 'Quincena','quincenal',150000,'')`).run(idDiario);
  t.db.prepare(`insert into nomina_movimientos (id,empleado_id,fecha,tipo,importe,creado_por,creado_en) values ('dev',?,'2026-10-15','devengo',150000,?, '')`).run(idDiario,DUENO);
  const falta = await t.pedir('/api/nomina/movimientos',{id:crypto.randomUUID(),empleado_id:idDiario,tipo:'falta',fecha:'2026-10-15'});
  assert.equal(falta.status,201,JSON.stringify(falta.cuerpo));
  assert.equal(falta.cuerpo.importe,-10000);
  const adelanto = await t.pedir('/api/nomina/movimientos',{id:crypto.randomUUID(),empleado_id:idDiario,tipo:'adelanto',fecha:'2026-10-15',importe:1000,origen:'caja',caja:'Caja 2'});
  assert.equal(adelanto.status,201);
  // Nueva devengo para tener saldo disponible después de la falta.
  t.db.prepare(`insert into nomina_movimientos (id,empleado_id,fecha,tipo,importe,creado_por,creado_en) values ('dev2',?,'2026-10-16','devengo',150000,?, '')`).run(idDiario,DUENO);
  const pago = await t.pedir('/api/nomina/movimientos',{id:crypto.randomUUID(),empleado_id:idDiario,tipo:'pago',fecha:'2026-10-16',importe:400,abono:100,origen:'caja',caja:'Caja 2'});
  assert.equal(pago.status,201);
  assert.equal(pago.cuerpo.neto,400);
  const lista=await t.pedir('/api/nomina',undefined,'GET');
  assert.equal(lista.cuerpo.empleados[0].debe,289500);
  assert.equal(lista.cuerpo.empleados[0].adelantos,900);
  const corte=await t.pedir('/api/cortes',{id:crypto.randomUUID(),caja:'Caja 2',efectivo_contado:48600});
  assert.equal(corte.status,201,JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.nomina,1400);
  assert.equal(corte.cuerpo.efectivo_esperado,48600);
});

test('movimiento fuera de caja no crea retiro y nomina niega a cajero', async () => {
  const t=tienda();
  t.db.prepare(`insert into empleados (id,nombre,periodo,sueldo,creado_en) values (?, 'Diario','diario',10000,'')`).run(idDiario);
  t.db.prepare(`insert into nomina_movimientos (id,empleado_id,fecha,tipo,importe,creado_por,creado_en) values ('dev',?,'2026-10-15','devengo',10000,?, '')`).run(idDiario,DUENO);
  const r=await t.pedir('/api/nomina/movimientos',{id:crypto.randomUUID(),empleado_id:idDiario,tipo:'adelanto',fecha:'2026-10-15',importe:500,origen:'fuera'});
  assert.equal(r.status,201);
  assert.equal(t.db.prepare('select count(*) n from retiros').get()!.n,0);
  const corte=await t.pedir('/api/cortes',{id:crypto.randomUUID(),caja:'Caja 1',efectivo_contado:50000});
  assert.equal(corte.cuerpo.nomina,0);
  assert.equal(corte.cuerpo.efectivo_esperado,50000);
  t.db.prepare(`insert into usuarios (correo,nombre,roles,activo,creado_en,actualizado_en) values ('cajero@prueba.mx','Cajero','cajero',1,'','')`).run();
  t.env.DEV_USUARIO='cajero@prueba.mx';
  assert.equal((await t.pedir('/api/nomina',undefined,'GET')).status,403);
});

test('el auxiliar entra a nomina y gastos, y a nada mas del dueno', async () => {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
    values ('aux@prueba.mx', 'Auxiliar', 'auxiliar', 1, '', '')`).run();
  t.env.DEV_USUARIO = 'aux@prueba.mx';
  for (const ruta of ['/api/nomina', `/api/gastos?mes=2026-10`]) assert.equal((await t.pedir(ruta, undefined, 'GET')).status, 200, ruta);
  for (const ruta of ['/api/reportes', '/api/cuentas', '/api/mensajes']) assert.equal((await t.pedir(ruta, undefined, 'GET')).status, 403, ruta);
});
