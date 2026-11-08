// node --test src/retos.test.ts
// Retos (#752): logros con credito en Dolarones, cron diario idempotente, tope mensual, guardias y /api/retos/mios privado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { otorgarLogros } from './retos.ts';
import { repartir } from './dolarones.ts';
import { hoyTienda } from './reportes.ts';
import { sumarDias } from './equipo.ts';

const DIA_MS = 86_400_000;
const D8 = sumarDias(hoyTienda(), -8);   // el dia que evalua el cron de hoy
const a = (dia: string) => `${dia}T18:00:00.000Z`;   // mediodia de la tienda (UTC-6) de ese dia
const ANTIGUO = '2025-01-01T00:00:00.000Z';

function escenario() {
  const t = tienda();
  const usuario = (correo: string, roles: string) => t.db.prepare(
    `insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')`).run(correo, correo.split('@')[0], roles);
  usuario('ana@prueba.mx', 'cajero'); usuario('beto@prueba.mx', 'capturista');
  const config = (c: Record<string, number>) => {
    for (const [k, v] of Object.entries(c)) t.db.prepare('insert or replace into config (clave, valor) values (?, ?)').run(k, String(v));
  };
  // Solo el logro bajo prueba: los demas pagan 0 (desactivados).
  const soloUno = (activo: string, extra: Record<string, number> = {}) => config({
    reto_d_viejo: 0, reto_d_stock: 0, reto_d_racha: 0, reto_d_socio: 0, reto_d_apartado: 0, ...extra, ...(activo ? { [activo]: extra[activo] ?? 50 } : {}) });
  const empleado = async (nombre: string, correo: string) => {
    const id = crypto.randomUUID();
    const r = await t.pedir(`/api/nomina/empleados/${id}`, { nombre, periodo: 'diario', pago_dia: 30000, dias: [1, 2, 3], pin: '123456', correo });
    assert.equal(r.status, 201);
    return id;
  };
  const trabajo = (id: string, dia: string) => t.db.prepare(`insert into asistencias (empleado_id, fecha, entrada, origen) values (?, ?, '', 'manual')`).run(id, dia);
  const piezaAntigua = () => t.db.prepare('update productos set creado_en = ? where id = ?').run(ANTIGUO, PRODUCTO);
  /** Una venta de una pieza atendida por `vendedora` en el dia de la tienda `dia`. Devuelve el id de la venta. */
  const vender = async (vendedora: string, dia = D8) => {
    const id = crypto.randomUUID();
    assert.equal((await t.pedir('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, vendedora })).status, 201);
    t.db.prepare('update ventas set creado_en = ? where id = ?').run(a(dia), id);
    return id;
  };
  const logros = (correo = 'ana@prueba.mx') => (t.db.prepare('select logro, ref, d from retos_logros where correo = ? order by logro, ref').all(correo) as { logro: string; ref: string; d: number }[]).map((l) => ({ ...l }));
  const lotes = () => t.db.prepare(`select * from dolarones_lotes where origen = 'reto'`).all() as { cliente_id: string; importe: number; restante: number }[];
  const como = (correo: string) => { t.env.DEV_USUARIO = correo; };
  const mios = async (correo: string, ruta = '/api/retos/mios') => { como(correo); const r = await t.pedir(ruta); como(DUENO); return r; };
  return { t, config, soloUno, empleado, trabajo, piezaAntigua, vender, logros, lotes, mios };
}

test('antiguedad: un logro por linea aunque el cron corra dos veces, y paga un lote origen reto', async () => {
  const { t, soloUno, empleado, piezaAntigua, vender, logros, lotes, mios } = escenario();
  try {
    soloUno('reto_d_viejo');
    await empleado('Ana', 'ana@prueba.mx');
    piezaAntigua();
    const venta = await vender('ana@prueba.mx');
    const linea = (t.db.prepare('select id from venta_lineas where venta_id = ?').get(venta) as { id: number }).id;

    assert.equal(await otorgarLogros(t.env), 1);
    assert.equal(await otorgarLogros(t.env), 0);   // segunda corrida: nada nuevo
    assert.deepEqual(logros(), [{ logro: 'antiguedad', ref: String(linea), d: 50 }]);

    const cliente = (t.db.prepare(`select cliente_id from empleados where correo = 'ana@prueba.mx'`).get() as { cliente_id: string }).cliente_id;
    assert.ok(cliente);
    assert.equal((t.db.prepare('select registrado_por from clientes where id = ?').get(cliente) as { registrado_por: string }).registrado_por, 'retos');
    assert.deepEqual(lotes().map((l) => [l.cliente_id, l.importe, l.restante]), [[cliente, 5000, 5000]]);   // 50 D = 5,000 centavos
    const movs = t.db.prepare(`select tipo, importe, autor from dolarones_movimientos where cliente_id = ?`).all(cliente).map((m) => ({ ...m }));
    assert.deepEqual(movs, [{ tipo: 'reto', importe: 5000, autor: 'retos' }]);

    const r = await mios('ana@prueba.mx');
    assert.equal(r.cuerpo.saldo, 5000);
    assert.equal(r.cuerpo.logros.length, 1);
    // El lote se puede gastar como cualquier Dolaron (en un ticket chico, sin el minimo del regalo).
    const lote = { id: 'x', origen: 'reto', restante: 5000, disponible_desde: '2020-01-01T00:00:00Z', vence_en: '2099-01-01T00:00:00Z' };
    assert.deepEqual(repartir([lote], 3000, '2026-11-07T00:00:00Z', 5000), [{ id: 'x', importe: 3000 }]);
  } finally { t.db.close(); }
});

test('desatorar usa el stock que habia al momento de la venta', async () => {
  const { t, soloUno, empleado, vender, logros } = escenario();
  try {
    soloUno('reto_d_stock', { reto_d_stock: 30 });
    await empleado('Ana', 'ana@prueba.mx');
    await vender('ana@prueba.mx');   // stock 50 -> 49
    t.db.prepare('update productos set stock = 3 where id = ?').run(PRODUCTO);   // quedan 3: antes de la venta habia 4 (< 5)
    await otorgarLogros(t.env);
    assert.deepEqual(logros(), []);
    t.db.prepare('update productos set stock = 4 where id = ?').run(PRODUCTO);   // antes de la venta habia 5
    await otorgarLogros(t.env);
    assert.deepEqual(logros().map((l) => [l.logro, l.d]), [['desatorar', 30]]);
  } finally { t.db.close(); }
});

test('tope mensual: lo que no cabe se registra con d = 0 y no paga', async () => {
  const { t, soloUno, empleado, piezaAntigua, vender, logros, lotes } = escenario();
  try {
    soloUno('reto_d_viejo', { reto_d_tope_mes: 60 });
    await empleado('Ana', 'ana@prueba.mx');
    piezaAntigua();
    for (let i = 0; i < 3; i++) await vender('ana@prueba.mx');
    assert.equal(await otorgarLogros(t.env), 3);
    assert.deepEqual(logros().map((l) => l.d).sort((x, y) => y - x), [50, 10, 0]);   // 50 + 10 = tope; el tercero, 0
    assert.equal(lotes().reduce((s, l) => s + l.importe, 0), 6000);
    assert.equal(lotes().length, 2);
    await otorgarLogros(t.env);
    assert.equal(lotes().length, 2);
  } finally { t.db.close(); }
});

test('guardias: venta cancelada, con devolucion o comprada por la propia empleada no pagan', async () => {
  const { t, soloUno, empleado, piezaAntigua, vender, logros } = escenario();
  try {
    soloUno('reto_d_viejo');
    await empleado('Ana', 'ana@prueba.mx');
    piezaAntigua();
    const cancelada = await vender('ana@prueba.mx');
    const devuelta = await vender('ana@prueba.mx');
    const propia = await vender('ana@prueba.mx');
    t.db.prepare('update ventas set cancelada = 1 where id = ?').run(cancelada);
    t.db.prepare('update ventas set devuelto = 100 where id = ?').run(devuelta);
    t.db.prepare(`insert into clientes (id, numero, nombre, telefono, bases_version, registrado_por, creado_en) values ('c-ana', 1, 'Ana', 'retos-x', 'v', 'retos', '')`).run();
    t.db.prepare(`update empleados set cliente_id = 'c-ana' where correo = 'ana@prueba.mx'`).run();
    t.db.prepare(`update ventas set cliente_id = 'c-ana' where id = ?`).run(propia);
    assert.equal(await otorgarLogros(t.env), 0);
    assert.deepEqual(logros(), []);
    assert.equal((t.db.prepare(`select count(*) as n from dolarones_lotes where origen = 'reto'`).get() as { n: number }).n, 0);
  } finally { t.db.close(); }
});

test('socio nuevo (compra el mismo dia) y apartado cerrado', async () => {
  const { t, soloUno, empleado, vender, logros } = escenario();
  try {
    soloUno('reto_d_socio', { reto_d_socio: 30, reto_d_apartado: 30 });
    await empleado('Ana', 'ana@prueba.mx');
    const cliente = (id: string, numero: number) => t.db.prepare(
      `insert into clientes (id, numero, nombre, telefono, bases_version, registrado_por, creado_en) values (?, ?, ?, ?, 'v', 'ana@prueba.mx', ?)`)
      .run(id, numero, id, `55000000${numero}`, a(D8));
    cliente('compra', 1); cliente('no-compra', 2);
    const v1 = await vender('beto@prueba.mx');   // la atiende otra persona: el socio nuevo es de quien lo registro
    t.db.prepare(`update ventas set cliente_id = 'compra' where id = ?`).run(v1);
    const v2 = await vender('ana@prueba.mx');
    t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, envio, vendedora, estado, vence_en, anticipo, forma_pago, saldo, saldo_vence_en, venta_id, creado_en, actualizado_en)
      values ('ped-1', 1, 'X', '5500000000', 'tienda', 0, 'ana@prueba.mx', 'vendido', '', 0, 'efectivo', 0, '', ?, '', '')`).run(v2);
    await otorgarLogros(t.env);
    assert.deepEqual(logros().map((l) => [l.logro, l.ref, l.d]), [['apartado', 'ped-1', 30], ['socio', 'compra', 30]]);
  } finally { t.db.close(); }
});

test('racha: se corta con un dia trabajado sin venta y paga una vez en cada multiplo', async () => {
  const { t, config, empleado, trabajo, vender, logros } = escenario();
  try {
    config({ reto_d_viejo: 0, reto_d_stock: 0, reto_d_socio: 0, reto_d_apartado: 0, reto_racha_dias: 3, reto_d_racha: 100 });
    const ana = await empleado('Ana', 'ana@prueba.mx');
    const beto = await empleado('Beto', 'beto@prueba.mx');
    // Ana: 7 dias trabajados seguidos con venta, el ultimo es D8; descansa un dia antes y eso no corta la racha (es un dia no trabajado).
    const dias = Array.from({ length: 7 }, (_, i) => sumarDias(D8, i - 6));
    for (const d of dias) { trabajo(ana, d); await vender('ana@prueba.mx', d); }
    // Beto: tres dias trabajados pero el de en medio sin venta.
    const bdias = [sumarDias(D8, -2), sumarDias(D8, -1), D8];
    for (const d of bdias) trabajo(beto, d);
    await vender('beto@prueba.mx', bdias[0]); await vender('beto@prueba.mx', bdias[2]);

    // El cron corre todos los dias: se simula cada corrida desde la que ve el tercer dia hasta hoy.
    for (let k = 8; k >= 0; k--) await otorgarLogros(t.env, Date.now() - k * DIA_MS);
    await otorgarLogros(t.env);   // y hoy otra vez
    assert.deepEqual(logros().map((l) => [l.logro, l.ref, l.d]), [['racha', dias[2], 100], ['racha', dias[5], 100]]);   // largos 3 y 6; el 7 no
    assert.deepEqual(logros('beto@prueba.mx'), []);
  } finally { t.db.close(); }
});

test('/api/retos/mios devuelve solo lo de quien pregunta', async () => {
  const { t, soloUno, empleado, piezaAntigua, vender, mios } = escenario();
  try {
    soloUno('reto_d_viejo');
    await empleado('Ana', 'ana@prueba.mx');
    await empleado('Beto', 'beto@prueba.mx');
    piezaAntigua();
    await vender('ana@prueba.mx'); await vender('ana@prueba.mx'); await vender('beto@prueba.mx');
    await otorgarLogros(t.env);

    const ana = (await mios('ana@prueba.mx', '/api/retos/mios?correo=beto@prueba.mx')).cuerpo;   // el parametro no cambia de persona
    const beto = (await mios('beto@prueba.mx')).cuerpo;
    assert.equal(ana.nombre, 'Ana');
    assert.equal(ana.logros.length, 2); assert.equal(ana.saldo, 10000);
    assert.equal(beto.logros.length, 1); assert.equal(beto.saldo, 5000);
    assert.equal(JSON.stringify([ana, beto]).includes('ana@prueba.mx'), false);   // ni correos ni posiciones de nadie
    assert.equal(JSON.stringify(ana).includes('Beto'), false);
    // Alguien sin cuenta ligada no ve nada ajeno.
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cris@prueba.mx', 'Cris', 'cajero', 1, '', '')`).run();
    const cris = (await mios('cris@prueba.mx')).cuerpo;
    assert.deepEqual([cris.logros, cris.saldo, cris.semana.tickets], [[], 0, 0]);
    // Una revendedora no entra.
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('rev@prueba.mx', 'Rev', 'revendedora', 1, '', '')`).run();
    assert.equal((await mios('rev@prueba.mx')).status, 403);
  } finally { t.db.close(); }
});

test('una base nueva (schema + migraciones) trae cliente_id y el libro de logros con su indice unico', () => {
  const t = tienda();
  try {
    assert.ok(t.db.prepare(`select 1 from pragma_table_info('empleados') where name = 'cliente_id'`).get());
    t.db.prepare(`insert into retos_logros (id, correo, logro, ref, d, creado_en) values ('1', 'a', 'x', 'r', 1, '')`).run();
    assert.throws(() => t.db.prepare(`insert into retos_logros (id, correo, logro, ref, d, creado_en) values ('2', 'a', 'x', 'r', 1, '')`).run());
  } finally { t.db.close(); }
});
