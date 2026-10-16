import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

const id = '11111111-1111-4111-8111-111111111111';
const fechaLocal = (dias = 0) => new Date(Date.now() - 6 * 3600_000 + dias * 86400_000).toISOString().slice(0, 10);
const diaSemana = (fecha: string) => new Date(`${fecha}T12:00:00Z`).getUTCDay();
const pin = '123456';

async function empleado(t, opciones: Record<string, unknown> = {}) {
  const hoy = fechaLocal();
  const ayer = fechaLocal(-1);
  const horaActual = new Date(Date.now() - 6 * 3600_000).toISOString().slice(11, 16);
  const [hora, minuto] = horaActual.split(':').map(Number);
  const minutos = (hora * 60 + minuto + 1439) % 1440;
  const horaEntrada = `${String(Math.floor(minutos / 60)).padStart(2, '0')}:${String(minutos % 60).padStart(2, '0')}`;
  await t.pedir(`/api/nomina/empleados/${id}`, {
    nombre: 'Empleado prueba', periodo: 'quincenal', pago_dia: 10000,
    dias: [...new Set([diaSemana(ayer), diaSemana(hoy)])], hora_entrada: horaEntrada, pin,
    ...opciones,
  });
  t.db.prepare('update empleados set creado_en=? where id=?').run(`${ayer}T12:00:00-06:00`, id);
  return { hoy, ayer };
}

async function activar(t, config = {}) {
  return t.pedir('/api/nomina/config', {
    checador_activo: true, bono_centavos: 5000, tolerancia_minutos: 0, retardos_permitidos: 1,
    faltas_permitidas: 1, ...config,
  }, 'PUT');
}

test('checador apagado responde 404 y el día trabajado manual devenga una sola vez', async () => {
  const t = tienda();
  await empleado(t);
  const apagado = await t.pedir('/api/nomina/entrada', { empleado_id: id, pin });
  assert.equal(apagado.status, 404);
  const manual = await t.pedir('/api/nomina/movimientos', {
    id: crypto.randomUUID(), empleado_id: id, tipo: 'devengo', fecha: fechaLocal(), importe: 10000, origen: 'manual',
  });
  assert.equal(manual.status, 201, JSON.stringify(manual.cuerpo));
  const repetido = await t.pedir('/api/nomina/movimientos', {
    id: crypto.randomUUID(), empleado_id: id, tipo: 'devengo', fecha: fechaLocal(), importe: 10000, origen: 'manual',
  });
  assert.equal(repetido.status, 409);
  assert.equal(t.db.prepare("select count(*) n from nomina_movimientos where tipo='devengo'").get()!.n, 1);
  const ajuste = await t.pedir('/api/nomina/movimientos', {
    id: crypto.randomUUID(), empleado_id: id, tipo: 'ajuste', fecha: fechaLocal(), importe: 10000, nota: 'Marcado por error',
  });
  assert.equal(ajuste.status, 201);
  assert.equal(t.db.prepare("select importe from nomina_movimientos where tipo='ajuste'").get()!.importe, -10000);
  assert.equal(t.db.prepare('select count(*) n from asistencias where empleado_id=?').get(id)!.n, 0);
});

test('checador marca una vez; calcula faltas, retardos y bono sugerido que se suma al pago', async () => {
  const t = tienda();
  const { hoy } = await empleado(t);
  await activar(t);
  assert.equal((await t.pedir('/api/nomina/entrada', { empleado_id: id, pin: '000000' })).status, 401);
  const marcada = await t.pedir('/api/nomina/entrada', { empleado_id: id, pin });
  assert.equal(marcada.status, 201);
  assert.equal((await t.pedir('/api/nomina/entrada', { empleado_id: id, pin })).cuerpo.repetida, true);
  const periodo = await t.pedir(`/api/nomina/${id}/periodo`, undefined, 'GET');
  assert.equal(periodo.cuerpo.faltas, 1);
  assert.ok(periodo.cuerpo.retardos >= 1);
  assert.equal(periodo.cuerpo.bono_sugerido, 5000, JSON.stringify(periodo.cuerpo));
  const pago = await t.pedir('/api/nomina/movimientos', {
    id: crypto.randomUUID(), empleado_id: id, tipo: 'pago', fecha: hoy, importe: 15000,
    bono: periodo.cuerpo.bono_sugerido, abono: 0, origen: 'fuera', nota: 'Bono sugerido',
  });
  assert.equal(pago.status, 201, JSON.stringify(pago.cuerpo));
  assert.equal(pago.cuerpo.bono, 5000);
  assert.equal(t.db.prepare("select importe from nomina_movimientos where tipo='bono'").get()!.importe, 5000);
  const lista = await t.pedir('/api/nomina', undefined, 'GET');
  assert.equal(lista.cuerpo.empleados[0].debe, 0);
});

test('adelanto y pago de caja siguen restándose en el corte; el pago incluye bono', async () => {
  const t = tienda();
  const { hoy } = await empleado(t);
  await activar(t);
  await t.pedir('/api/nomina/movimientos', {
    id: crypto.randomUUID(), empleado_id: id, tipo: 'devengo', fecha: hoy, importe: 10000, origen: 'manual',
  });
  const adelanto = await t.pedir('/api/nomina/movimientos', {
    id: crypto.randomUUID(), empleado_id: id, tipo: 'adelanto', fecha: hoy, importe: 1000, origen: 'caja', caja: 'Caja 2',
  });
  assert.equal(adelanto.status, 201);
  const pago = await t.pedir('/api/nomina/movimientos', {
    id: crypto.randomUUID(), empleado_id: id, tipo: 'pago', fecha: hoy, importe: 10000,
    bono: 1000, abono: 1000, origen: 'caja', caja: 'Caja 2', nota: 'Bono por ventas',
  });
  assert.equal(pago.status, 201, JSON.stringify(pago.cuerpo));
  const lista = await t.pedir('/api/nomina', undefined, 'GET');
  assert.equal(lista.cuerpo.empleados[0].debe, 0);
  assert.equal(lista.cuerpo.empleados[0].adelantos, 0);
  const corte = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 47600 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.nomina, 11000);
});

test('el auxiliar entra a nómina, cajero no, y checador permite la caja sin PIN de cajero', async () => {
  const t = tienda();
  await activar(t);
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
    values ('aux@prueba.mx', 'Auxiliar', 'auxiliar', 1, '', '')`).run();
  t.env.DEV_USUARIO = 'aux@prueba.mx';
  assert.equal((await t.pedir('/api/nomina', undefined, 'GET')).status, 200);
  t.db.prepare(`insert into usuarios (correo,nombre,roles,activo,creado_en,actualizado_en)
    values ('cajero@prueba.mx','Cajero','cajero',1,'','')`).run();
  t.env.DEV_USUARIO = 'cajero@prueba.mx';
  assert.equal((await t.pedir('/api/nomina', undefined, 'GET')).status, 403);
  t.db.prepare(`insert into usuarios (correo,nombre,roles,activo,creado_en,actualizado_en)
    values ('pc@prueba.mx','Caja','computadora',1,'','')`).run();
  t.env.DEV_USUARIO = 'pc@prueba.mx';
  assert.equal((await t.pedir('/api/nomina/checador', undefined, 'GET')).status, 200);
});

test('el checador bloquea el PIN 15 minutos tras 5 intentos fallidos', async () => {
  const t = tienda();
  await empleado(t);
  await activar(t);
  for (let i = 0; i < 5; i++) assert.equal((await t.pedir('/api/nomina/entrada', { empleado_id: id, pin: '000000' })).status, 401);
  // Bloqueado: ni el PIN correcto marca la entrada (cada entrada vale un día de sueldo).
  assert.equal((await t.pedir('/api/nomina/entrada', { empleado_id: id, pin })).status, 423);
  assert.equal(t.db.prepare('select count(*) n from asistencias').get()!.n, 0);
});
