// node --test src/equipo.test.ts
// Equipo y bono semanal de la tienda (#751): reparto por dias, umbral, semanas cerradas, idempotencia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { repartirBono, lunesDe, semanasCerradas } from './equipo.ts';
import { hoyTienda } from './reportes.ts';
import { acreditarReto } from './dolarones.ts';

const sumar = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const LUNES = sumar(lunesDe(hoyTienda()), -14);   // una semana cerrada
const DESDE = Number(sumar(LUNES, -35).replaceAll('-', ''));   // primera semana del bono por tienda: un lunes de antes

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
  const usuario = (correo: string, roles: string, tiendaCuenta = '') => t.db.prepare(
    `insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values (?, ?, ?, 1, ?, '', '')`).run(correo, correo.split('@')[0], roles, tiendaCuenta);
  t.db.prepare(`insert into config (clave, valor) values ('bono_tienda_desde', ?)`).run(String(DESDE));
  usuario('ana@prueba.mx', 'cajero'); usuario('beto@prueba.mx', 'capturista', 'salk'); usuario('rev@prueba.mx', 'revendedora');
  const empleado = async (nombre: string, correo?: string) => {
    const id = crypto.randomUUID();
    const r = await t.pedir(`/api/nomina/empleados/${id}`, { nombre, periodo: 'diario', pago_dia: 30000, dias: [1, 2, 3], pin: '123456', ...(correo === undefined ? {} : { correo }) });
    return { id, ...r };
  };
  const dias = (id: string, desde: string, n: number) => {
    for (let i = 0; i < n; i++) t.db.prepare(`insert into asistencias (empleado_id, fecha, entrada, origen) values (?, ?, '', 'manual')`).run(id, sumar(desde, i));
  };
  // `n` tickets atendidos por ana y cobrados en `deTienda`; el reloj de la venta se mueve a un miercoles de la semana LUNES. Devuelve lo vendido.
  const vender = async (cuando = `${sumar(LUNES, 2)}T18:00:00.000Z`, deTienda = 'soledad', n = 3) => {
    let suma = 0;
    for (let i = 0; i < n; i++) {
      const id = crypto.randomUUID();
      assert.equal((await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, vendedora: 'ana@prueba.mx' })).status, 201);
      t.db.prepare('update ventas set creado_en = ?, tienda = ? where id = ?').run(cuando, deTienda, id);
      suma += (t.db.prepare('select total - devuelto - dolarones_devueltos as n from ventas where id = ?').get(id) as { n: number }).n;
    }
    return suma;
  };
  const config = (c: Record<string, number>) => t.pedir('/api/config', c, 'PUT');
  const bono = (semana: string) => t.pedir('/api/reportes/equipo/bono', { semana });
  const semana = async (lunes = LUNES) => (await t.pedir('/api/reportes/equipo')).cuerpo.semanas.find((s: { lunes: string }) => s.lunes === lunes) as
    { tiendas: { tienda: string; ventas: number; linea: number; alcanzada: boolean; bolsa: number; record: boolean; partes: { nombre: string; dias: number; importe: number; d: number; registrado: boolean }[] }[] };
  const deTienda = (s: Awaited<ReturnType<typeof semana>>, clave: string) => s.tiendas.find((x) => x.tienda === clave)!;
  const movimientos = () => t.db.prepare(`select * from nomina_movimientos where tipo = 'bono' order by empleado_id`).all();
  const lotes = () => t.db.prepare(`select * from dolarones_lotes where id like 'bono-tienda:%' order by id`).all() as { id: string; importe: number; origen: string }[];
  return { t, empleado, dias, vender, config, bono, semana, deTienda, movimientos, lotes };
}

test('cada tienda tiene su linea: la bolsa es el porcentaje de lo vendido arriba de ella, repartida entre las de ESA tienda', async () => {
  const { t, empleado, dias, vender, config, bono, semana, deTienda, movimientos } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');      // cuenta sin tienda: cuenta como la central
    const beto = await empleado('Beto', 'beto@prueba.mx');   // cuenta de Salk
    const sinCuenta = await empleado('Carla');
    assert.equal(ana.status, 201); assert.equal(sinCuenta.status, 201);
    const fantasma = await empleado('Fabia');   // con un correo que no es de ninguna cuenta: tampoco cobra
    t.db.prepare(`update empleados set correo = 'fantasma@prueba.mx' where id = ?`).run(fantasma.id);
    dias(fantasma.id, LUNES, 4);
    dias(ana.id, LUNES, 2); dias(beto.id, LUNES, 3); dias(sinCuenta.id, LUNES, 5);
    dias(ana.id, sumar(LUNES, 7), 3);   // dias de OTRA semana no cuentan
    const soledad = await vender(undefined, 'soledad', 3);
    const salk = await vender(undefined, 'salk', 2);
    // Soledad rebasa su linea por 10,000 centavos; Salk se queda corta; Romero no tiene linea.
    await config({ bono_tienda_pb: 1000, bono_tienda_linea_soledad: soledad - 10000, bono_tienda_linea_salk: salk + 5000 });

    const s = await semana();
    const sol = deTienda(s, 'soledad'), sal = deTienda(s, 'salk'), rom = deTienda(s, 'romero');
    assert.deepEqual([sol.ventas, sol.linea, sol.alcanzada, sol.bolsa], [soledad, soledad - 10000, true, 1000]);
    assert.deepEqual(sol.partes.map((p) => [p.nombre, p.importe]), [['Ana', 1000]]);   // Carla sin cuenta: fuera; Beto es de otra tienda
    assert.deepEqual([sal.ventas, sal.alcanzada, sal.bolsa], [salk, false, 0]);         // una tienda no arrastra a la otra
    assert.deepEqual(sal.partes.map((p) => [p.nombre, p.importe]), [['Beto', 0]]);
    assert.deepEqual([rom.linea, rom.alcanzada, rom.bolsa, rom.partes], [0, false, 0, []]);   // sin linea = apagada

    const primera = await bono(LUNES);
    assert.equal(primera.status, 201);
    assert.deepEqual(primera.cuerpo.creados.map((c: { nombre: string; importe: number }) => [c.nombre, c.importe]), [['Ana', 1000]]);
    const filas = movimientos() as { fecha: string; nota: string; importe: number; creado_por: string }[];
    assert.equal(filas.length, 1);
    assert.ok(filas.every((f) => f.nota === `bono tienda semana ${LUNES}` && f.fecha === sumar(LUNES, 6) && f.creado_por === 'dueno@prueba.mx'));

    const segunda = await bono(LUNES);   // repetir no duplica
    assert.equal(segunda.cuerpo.creados.length, 0);
    assert.equal(segunda.cuerpo.ya_estaban.length, 1);
    assert.equal(movimientos().length, 1);
    assert.ok(deTienda(await semana(), 'soledad').partes.every((p) => p.registrado));
  } finally { t.db.close(); }
});

test('reparto por dias dentro de la tienda: piso por dias y el resto a quien mas dias tuvo, suma exacta', async () => {
  const { t, empleado, dias, vender, config, semana, deTienda } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values ('zoe@prueba.mx', 'zoe', 'cajero', 1, 'soledad', '', '')`).run();
    const zoe = await empleado('Zoe', 'zoe@prueba.mx');
    assert.equal(zoe.status, 201);
    const total = await vender();
    dias(ana.id, LUNES, 1); dias(zoe.id, LUNES, 2);
    await config({ bono_tienda_pb: 757, bono_tienda_linea_soledad: total - 10000 });   // bolsa: floor(10000 x 7.57 %) = 757
    const sol = deTienda(await semana(), 'soledad');
    assert.equal(sol.bolsa, 757);
    assert.deepEqual(sol.partes.map((p) => [p.nombre, p.dias, p.importe]).sort(), [['Ana', 1, 252], ['Zoe', 2, 505]]);
  } finally { t.db.close(); }
});

test('semana justo en la linea o bajo ella, y tienda sin linea: bolsa 0 y no se registra nada', async () => {
  const { t, empleado, dias, vender, config, bono, semana, deTienda, movimientos } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    dias(ana.id, LUNES, 3);
    const total = await vender();
    // Sin ninguna linea configurada (el estado inicial): apagado.
    assert.ok((await semana()).tiendas.every((x) => x.bolsa === 0 && x.linea === 0 && !x.alcanzada && x.partes.length === 0));
    await config({ bono_tienda_linea_soledad: total });   // exactamente en la linea: llego, pero no hay excedente
    const justo = deTienda(await semana(), 'soledad');
    assert.deepEqual([justo.alcanzada, justo.bolsa], [false, 0]);   // llegar no es pasar: sin excedente no hay bolsa ni «Hay bono»
    await config({ bono_tienda_linea_soledad: total + 1 });
    const bajo = deTienda(await semana(), 'soledad');
    assert.deepEqual([bajo.alcanzada, bajo.bolsa], [false, 0]);
    const r = await bono(LUNES);
    assert.equal(r.status, 200);
    assert.deepEqual(r.cuerpo.creados, []);
    assert.equal(movimientos().length, 0);
  } finally { t.db.close(); }
});

test('Dolarones del bono: 1 D por cada tanto de bono con tope semanal, lote de id fijo y doble asentado sin duplicar', async () => {
  const { t, empleado, dias, vender, config, bono, semana, deTienda, lotes } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    dias(ana.id, LUNES, 2);
    const total = await vender();
    // Bolsa de 1,000 centavos; 1 D por cada 100 centavos = 10 D, pero el tope semanal es 4.
    await config({ bono_tienda_pb: 1000, bono_tienda_linea_soledad: total - 10000, bono_d_cada: 100, bono_d_tope: 4 });
    const parte = deTienda(await semana(), 'soledad').partes[0];
    assert.deepEqual([parte.importe, parte.d, parte.registrado], [1000, 4, false]);
    // Con el tope en 0 no hay Dolarones del bono (antes de asentar: lo asentado ya no se recalcula).
    await config({ bono_d_tope: 0 });
    assert.equal(deTienda(await semana(), 'soledad').partes[0].d, 0);
    await config({ bono_d_tope: 4 });

    assert.equal((await bono(LUNES)).status, 201);
    assert.equal((await bono(LUNES)).status, 200);   // segunda vez: nada nuevo
    assert.deepEqual(lotes().map((l) => [l.id, l.importe, l.origen]), [[`bono-tienda:${LUNES}:${ana.id}`, 400, 'reto']]);
    const cliente = (t.db.prepare('select cliente_id from empleados where id = ?').get(ana.id) as { cliente_id: string }).cliente_id;
    assert.ok(cliente);
    assert.equal((t.db.prepare(`select count(*) as n from dolarones_movimientos where cliente_id = ? and tipo = 'reto'`).get(cliente) as { n: number }).n, 1);
    assert.equal(deTienda(await semana(), 'soledad').partes[0].registrado, true);
  } finally { t.db.close(); }
});

test('semana record: premio fijo solo si fue la mejor de la tienda y no llego a su linea', async () => {
  const { t, empleado, dias, vender, config, bono, semana, deTienda, lotes, movimientos } = escenario();
  try {
    const beto = await empleado('Beto', 'beto@prueba.mx');   // Salk
    dias(beto.id, LUNES, 2); dias(beto.id, sumar(LUNES, -7), 1);
    await vender(`${sumar(LUNES, -5)}T18:00:00.000Z`, 'salk', 1);   // la semana anterior: 1 ticket
    const ahora = await vender(undefined, 'salk', 2);                // esta semana: 2 tickets, mejor que la anterior
    await config({ bono_tienda_linea_salk: ahora + 100000, bono_d_record: 7 });
    let sal = deTienda(await semana(), 'salk');
    assert.deepEqual([sal.alcanzada, sal.record, sal.bolsa], [false, true, 0]);
    assert.deepEqual(sal.partes.map((p) => [p.importe, p.d]), [[0, 7]]);
    assert.equal(deTienda(await semana(sumar(LUNES, -7)), 'salk').record, false);   // la primera semana con ventas no tiene con quien compararse

    assert.equal((await bono(LUNES)).status, 201);
    assert.equal((await bono(LUNES)).status, 200);
    assert.deepEqual(lotes().map((l) => l.importe), [700]);
    assert.equal(movimientos().length, 0);   // sin bolsa no hay efectivo

    // Si la tienda llega a su linea ya no es «record»: cobra el bono normal.
    await config({ bono_tienda_linea_salk: ahora - 1000 });
    sal = deTienda(await semana(), 'salk');
    assert.deepEqual([sal.alcanzada, sal.record], [true, false]);
    // Y una semana peor que la mejor anterior tampoco lo es.
    await vender(`${sumar(LUNES, -12)}T18:00:00.000Z`, 'salk', 4);
    await config({ bono_tienda_linea_salk: ahora + 100000 });
    assert.equal(deTienda(await semana(), 'salk').record, false);
  } finally { t.db.close(); }
});

test('cambiar la config despues de asentar no cambia lo pagado, ni se paga otra vez ni se muestra otro importe', async () => {
  const { t, empleado, dias, vender, config, bono, semana, deTienda, movimientos, lotes } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    dias(ana.id, LUNES, 2);
    const total = await vender();
    await config({ bono_tienda_pb: 1000, bono_tienda_linea_soledad: total - 10000, bono_d_cada: 100, bono_d_tope: 4 });
    assert.equal((await bono(LUNES)).status, 201);
    assert.deepEqual([(movimientos() as { importe: number }[])[0].importe, lotes()[0].importe], [1000, 400]);

    // Gerencia sube el porcentaje y los Dolarones: lo pagado se queda y no hay nada nuevo que registrar.
    await config({ bono_tienda_pb: 5000, bono_d_cada: 50, bono_d_tope: 9 });
    const otra = await bono(LUNES);
    assert.equal(otra.status, 200);
    assert.deepEqual([otra.cuerpo.creados.length, otra.cuerpo.ya_estaban.length], [0, 1]);
    assert.deepEqual([(movimientos() as { importe: number }[])[0].importe, lotes()[0].importe, lotes().length], [1000, 400, 1]);
    const parte = deTienda(await semana(), 'soledad').partes[0];
    assert.deepEqual([parte.importe, parte.d, parte.registrado], [1000, 4, true]);   // se muestra lo pagado, no el recalculo
  } finally { t.db.close(); }
});

test('una semana anterior a la fecha de inicio (o sin fecha) no se asienta ni paga Dolarones, tampoco la pagada con el esquema anterior', async () => {
  const { t, empleado, dias, vender, config, bono, semana, movimientos, lotes } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    dias(ana.id, LUNES, 2);
    const total = await vender();
    await config({ bono_tienda_pb: 1000, bono_tienda_linea_soledad: total - 10000, bono_d_cada: 100, bono_d_tope: 4 });
    // Un movimiento del esquema anterior (misma nota y mismo id fijo) de esa semana.
    t.db.prepare(`insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, creado_por, creado_en)
      values (?, ?, ?, 'bono', 777, ?, 'dueno@prueba.mx', '')`).run(`bono-tienda:${LUNES}:${ana.id}`, ana.id, sumar(LUNES, 6), `bono tienda semana ${LUNES}`);

    await config({ bono_tienda_desde: Number(sumar(LUNES, 7).replaceAll('-', '')) });   // el esquema nuevo empieza una semana despues
    const antes = await bono(LUNES);
    assert.equal(antes.status, 400);
    assert.match(antes.cuerpo.error, /empieza en la semana/);
    assert.deepEqual([lotes().length, movimientos().length], [0, 1]);
    assert.ok((await semana()).tiendas.every((x) => x.linea === 0 && x.bolsa === 0 && x.partes.length === 0));   // para la tabla, esa semana ya no tiene bono

    await config({ bono_tienda_desde: 0 });   // sin fecha: apagado para todas las semanas
    assert.equal((await bono(LUNES)).status, 400);
    assert.equal(lotes().length, 0);
    // La fecha debe ser un lunes real.
    for (const malo of [20260101, 20261301, 'x', 1.5, '', true]) assert.equal((await config({ bono_tienda_desde: malo as number })).status, 400, String(malo));
    assert.equal((await config({ bono_tienda_desde: Number(LUNES.replaceAll('-', '')) })).status, 200);
  } finally { t.db.close(); }
});

test('si el asentado se corto despues de la nomina y antes del lote de Dolarones, repetirlo completa el lote sin duplicar la nomina', async () => {
  const { t, empleado, dias, vender, config, bono, movimientos, lotes } = escenario();
  try {
    const ana = await empleado('Ana', 'ana@prueba.mx');
    dias(ana.id, LUNES, 2);
    const total = await vender();
    await config({ bono_tienda_pb: 1000, bono_tienda_linea_soledad: total - 10000, bono_d_cada: 100, bono_d_tope: 4 });
    assert.equal((await bono(LUNES)).status, 201);
    t.db.prepare(`delete from dolarones_movimientos where lote_id like 'bono-tienda:%'`).run();   // como si el corte hubiera sido antes del lote
    t.db.prepare(`delete from dolarones_lotes where id like 'bono-tienda:%'`).run();
    assert.equal(lotes().length, 0);
    const retry = await bono(LUNES);
    assert.equal(retry.status, 201);
    assert.deepEqual([retry.cuerpo.creados.length, movimientos().length, lotes().map((l) => l.importe)], [1, 1, [400]]);
    assert.equal((await bono(LUNES)).status, 200);
    assert.deepEqual([movimientos().length, lotes().length], [1, 1]);
    // Dos asentados a la vez: el que llega con la cuenta de socio aun sin crear (lectura vieja) no falla y usa la misma cuenta.
    const cliente = (t.db.prepare('select cliente_id from empleados where id = ?').get(ana.id) as { cliente_id: string }).cliente_id;
    t.db.prepare(`update empleados set cliente_id = '' where id = ?`).run(ana.id);
    assert.equal(await acreditarReto(t.env, { id: ana.id, nombre: 'Ana', correo: 'ana@prueba.mx', cliente_id: '' }, 'bono-tienda:otro', 100, Date.now()), cliente);
  } finally { t.db.close(); }
});

test('GET /api/config: quien no es gerencia no recibe la linea de las tiendas ni los valores del bono', async () => {
  const { t, config } = escenario();
  try {
    await config({ bono_tienda_linea_soledad: 123400, bono_tienda_meta_tope: 234500, bono_tienda_pb: 100, bono_d_cada: 100, bono_d_tope: 3, bono_d_record: 5 });
    const dueno = (await t.pedir('/api/config')).cuerpo;
    assert.ok(Object.keys(dueno).filter((k) => /^bono_(tienda|d)_/.test(k)).length >= 7);
    (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'beto@prueba.mx';   // capturista: puede leer config, no es gerencia
    const captura = await t.pedir('/api/config');
    assert.equal(captura.status, 200);
    assert.deepEqual(Object.keys(captura.cuerpo).filter((k) => /^bono_(tienda|d)_/.test(k)), []);
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
