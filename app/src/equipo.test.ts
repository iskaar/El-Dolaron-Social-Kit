// node --test src/equipo.test.ts
// Equipo y bono semanal de la tienda (#751): reparto por dias, umbral, semanas cerradas, idempotencia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { repartirBono, lunesDe, semanasCerradas } from './equipo.ts';
import { hoyTienda } from './reportes.ts';

const sumar = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const LUNES = sumar(lunesDe(hoyTienda()), -14);   // una semana cerrada

test('repartirBono: piso por dias, el resto al de mas dias (empate: correo), suma exacta', () => {
  const dos = repartirBono(757, [{ correo: 'a@x', dias: 1 }, { correo: 'b@x', dias: 2 }]);
  assert.deepEqual(dos.map((p) => p.importe), [252, 505]);
  assert.equal(dos.reduce((s, p) => s + p.importe, 0), 757);
  const empate = repartirBono(101, [{ correo: 'z@x', dias: 3 }, { correo: 'a@x', dias: 3 }, { correo: 'm@x', dias: 3 }]);
  assert.deepEqual(empate.map((p) => [p.correo, p.importe]), [['z@x', 33], ['a@x', 35], ['m@x', 33]]);
  assert.deepEqual(repartirBono(500, [{ correo: 'a@x', dias: 0 }]).map((p) => p.importe), [0]);
  assert.deepEqual(repartirBono(0, [{ correo: 'a@x', dias: 4 }]).map((p) => p.importe), [0]);
});

test('lunesDe y semanasCerradas: lunes a domingo, la semana en curso no cuenta', () => {
  assert.equal(lunesDe('2026-11-08'), '2026-11-02');   // domingo
  assert.equal(lunesDe('2026-11-02'), '2026-11-02');   // lunes
  assert.equal(lunesDe('2026-11-04'), '2026-11-02');
  const s = semanasCerradas('2026-11-07');   // sabado de la semana del 2/11
  assert.equal(s.length, 8);
  assert.equal(s[0], '2026-10-26');
  assert.equal(s[7], '2026-09-07');
});

function escenario() {
  const t = tienda();
  const usuario = (correo: string, roles: string) => t.db.prepare(
    `insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')`).run(correo, correo.split('@')[0], roles);
  usuario('ana@prueba.mx', 'cajero'); usuario('beto@prueba.mx', 'capturista'); usuario('rev@prueba.mx', 'revendedora');
  const empleado = async (nombre: string, correo?: string) => {
    const id = crypto.randomUUID();
    const r = await t.pedir(`/api/nomina/empleados/${id}`, { nombre, periodo: 'diario', pago_dia: 30000, dias: [1, 2, 3], pin: '123456', ...(correo === undefined ? {} : { correo }) });
    return { id, ...r };
  };
  const dias = (id: string, desde: string, n: number) => {
    for (let i = 0; i < n; i++) t.db.prepare(`insert into asistencias (empleado_id, fecha, entrada, origen) values (?, ?, '', 'manual')`).run(id, sumar(desde, i));
  };
  // Tres tickets atendidos por ana; el reloj de la venta se mueve a un miercoles de la semana LUNES.
  const vender = async (cuando = `${sumar(LUNES, 2)}T18:00:00.000Z`) => {
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      assert.equal((await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, vendedora: 'ana@prueba.mx' })).status, 201);
      t.db.prepare('update ventas set creado_en = ? where id = ?').run(cuando, id);
    }
    return (t.db.prepare('select sum(total - devuelto - dolarones_devueltos) as n from ventas').get() as { n: number }).n;
  };
  const bono = (semana: string) => t.pedir('/api/reportes/equipo/bono', { semana });
  const movimientos = () => t.db.prepare(`select * from nomina_movimientos where tipo = 'bono' order by empleado_id`).all();
  return { t, empleado, dias, vender, bono, movimientos };
}

test('la semana que pasa la meta reparte la bolsa por dias de esa semana y registra una sola vez', async () => {
  const { t, empleado, dias, vender, bono, movimientos } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    const beto = await empleado('Beto', 'beto@prueba.mx');
    const sinCuenta = await empleado('Carla');
    assert.equal(ana.status, 201); assert.equal(sinCuenta.status, 201);
    dias(ana.id, LUNES, 1); dias(beto.id, LUNES, 2); dias(sinCuenta.id, LUNES, 5);
    dias(ana.id, sumar(LUNES, 7), 3);   // dias de OTRA semana no cuentan
    const total = await vender();
    await t.pedir('/api/config', { bono_tienda_meta_semana: 40000, bono_tienda_pb: 101 }, 'PUT');
    const bolsa = Math.floor(total * 101 / 10000);

    const semana = (await t.pedir('/api/reportes/equipo')).cuerpo.semanas.find((s: { lunes: string }) => s.lunes === LUNES);
    assert.equal(semana.ventas, total);
    assert.equal(semana.alcanzada, true);
    assert.equal(semana.bolsa, bolsa);
    assert.deepEqual(semana.partes.map((p: { nombre: string }) => p.nombre).sort(), ['Ana', 'Beto']);   // Carla sin cuenta: fuera
    assert.equal(semana.partes.reduce((s: number, p: { importe: number }) => s + p.importe, 0), bolsa);

    const primera = await bono(LUNES);
    assert.equal(primera.status, 201);
    assert.equal(primera.cuerpo.creados.length, 2);
    const filas = movimientos() as { fecha: string; nota: string; importe: number; creado_por: string }[];
    assert.equal(filas.length, 2);
    assert.ok(filas.every((f) => f.nota === `bono tienda semana ${LUNES}` && f.fecha === sumar(LUNES, 6) && f.creado_por === 'dueno@prueba.mx'));
    assert.equal(filas.reduce((s, f) => s + f.importe, 0), bolsa);

    const segunda = await bono(LUNES);   // repetir no duplica
    assert.equal(segunda.cuerpo.creados.length, 0);
    assert.equal(segunda.cuerpo.ya_estaban.length, 2);
    assert.equal(movimientos().length, 2);
    const despues = (await t.pedir('/api/reportes/equipo')).cuerpo.semanas.find((s: { lunes: string }) => s.lunes === LUNES);
    assert.ok(despues.partes.every((p: { registrado: boolean }) => p.registrado));
  } finally { t.db.close(); }
});

test('semana bajo la meta: bolsa 0 y no se registra nada', async () => {
  const { t, empleado, dias, vender, bono, movimientos } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    dias(ana.id, LUNES, 3);
    await vender();   // meta por omision: $100,000
    const semana = (await t.pedir('/api/reportes/equipo')).cuerpo.semanas.find((s: { lunes: string }) => s.lunes === LUNES);
    assert.equal(semana.alcanzada, false);
    assert.equal(semana.bolsa, 0);
    assert.ok(semana.partes.every((p: { importe: number }) => p.importe === 0));
    const r = await bono(LUNES);
    assert.equal(r.status, 200);
    assert.deepEqual(r.cuerpo.creados, []);
    assert.equal(movimientos().length, 0);
  } finally { t.db.close(); }
});

test('la semana en curso y los dias que no son lunes se rechazan', async () => {
  const { t, bono, movimientos } = escenario();
  try {
    assert.equal((await bono(lunesDe(hoyTienda()))).status, 400);
    assert.equal((await bono(sumar(LUNES, 1))).status, 400);
    assert.equal((await bono('basura')).status, 400);
    assert.equal(movimientos().length, 0);
  } finally { t.db.close(); }
});

test('la tabla Equipo atribuye ventas y dias trabajados; ligar cuenta valida rol y unicidad', async () => {
  const { t, empleado, dias, vender } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    dias(ana.id, sumar(hoyTienda(), -2), 2);
    const total = await vender(new Date().toISOString());   // dentro del rango de 30 dias
    const fila = (await t.pedir('/api/reportes/equipo?dias=30')).cuerpo.personas.find((p: { correo: string }) => p.correo === 'ana@prueba.mx');
    assert.equal(fila.ventas, total);
    assert.equal(fila.tickets, 3);
    assert.equal(fila.dias_trabajados, 2);

    assert.equal((await empleado('Rev', 'rev@prueba.mx')).status, 400);          // no es cajero ni capturista
    assert.equal((await empleado('Otra', 'ana@prueba.mx')).status, 409);         // ya ligada a Ana
    const lista = (await t.pedir('/api/nomina')).cuerpo;
    assert.equal(lista.empleados.find((e: { id: string }) => e.id === ana.id).correo, 'ana@prueba.mx');
    assert.deepEqual(lista.cuentas.map((c: { correo: string }) => c.correo).sort(), ['ana@prueba.mx', 'beto@prueba.mx']);
    // PUT sin la llave `correo` conserva la cuenta; con '' la desliga.
    await t.pedir(`/api/nomina/empleados/${ana.id}`, { nombre: 'Ana', periodo: 'diario', pago_dia: 30000, dias: [1] }, 'PUT');
    assert.equal(t.db.prepare('select correo from empleados where id = ?').get(ana.id)!.correo, 'ana@prueba.mx');
    await t.pedir(`/api/nomina/empleados/${ana.id}`, { nombre: 'Ana', periodo: 'diario', pago_dia: 30000, dias: [1], correo: '' }, 'PUT');
    assert.equal(t.db.prepare('select correo from empleados where id = ?').get(ana.id)!.correo, '');
  } finally { t.db.close(); }
});
