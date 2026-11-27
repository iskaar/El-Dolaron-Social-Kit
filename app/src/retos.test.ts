// node --test src/retos.test.ts
// Retos (#752): logros con credito en Dolarones, cron diario idempotente, tope mensual, guardias y /api/retos/mios privado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { otorgarLogros } from './retos.ts';
import { repartir } from './dolarones.ts';
import { hoyTienda } from './reportes.ts';
import { sumarDias, lunesDe } from './equipo.ts';
import { TIENDAS } from './cuentas.ts';

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

test('ligar la cuenta de socia por telefono: el cron acredita ahi y no crea una cuenta de relleno', async () => {
  const { t, soloUno, empleado, piezaAntigua, vender, lotes } = escenario();
  try {
    soloUno('reto_d_viejo');
    const id = await empleado('Ana', 'ana@prueba.mx');
    t.db.prepare(`insert into clientes (id, numero, nombre, telefono, bases_version, registrado_por, creado_en) values ('socia', 1, 'Ana socia', '5512345678', 'v', 'otro@prueba.mx', '')`).run();
    const editar = (extra: Record<string, unknown>) => t.pedir(`/api/nomina/empleados/${id}`,
      { nombre: 'Ana', periodo: 'diario', pago_dia: 30000, dias: [1], ...extra }, 'PUT');

    assert.equal((await editar({ telefono_socia: '5599999999' })).status, 404);   // ningun socio con ese telefono
    assert.equal((await editar({ telefono_socia: '' })).status, 200);             // vacio: sin cambio
    assert.equal((t.db.prepare('select cliente_id from empleados where id = ?').get(id) as { cliente_id: string }).cliente_id, '');
    assert.equal((await editar({ telefono_socia: '+52 (55) 1234-5678' })).status, 200);   // se normaliza a 10 digitos
    assert.equal((t.db.prepare('select cliente_id from empleados where id = ?').get(id) as { cliente_id: string }).cliente_id, 'socia');
    assert.equal((await editar({})).status, 200);   // sin la llave tampoco la desliga
    assert.equal((t.db.prepare('select cliente_id from empleados where id = ?').get(id) as { cliente_id: string }).cliente_id, 'socia');

    const lista = (await t.pedir('/api/nomina')).cuerpo.empleados.find((e: { id: string }) => e.id === id);
    assert.deepEqual([lista.cliente_id, lista.cliente_telefono], ['socia', '5512345678']);

    piezaAntigua();
    await vender('ana@prueba.mx');
    await otorgarLogros(t.env);
    assert.deepEqual(lotes().map((l) => [l.cliente_id, l.importe]), [['socia', 5000]]);
    assert.equal((t.db.prepare('select count(*) as n from clientes').get() as { n: number }).n, 1);   // ninguna cuenta nueva
  } finally { t.db.close(); }
});

test('/api/retos/mios: el avance de la tienda de quien pregunta sale solo como porcentajes, nunca pesos', async () => {
  const { t, config, empleado, vender, mios } = escenario();
  try {
    // La linea de Soledad vale 2 tickets de 25,000; la meta tope, 6; la de Salk, otra.
    config({ bono_tienda_desde: Number(sumarDias(lunesDe(hoyTienda()), -7).replaceAll('-', '')), bono_tienda_linea_soledad: 50000, bono_tienda_meta_tope: 150000, bono_tienda_linea_salk: 90000, bono_tienda_pb: 150 });
    await empleado('Ana', 'ana@prueba.mx');
    await vender('beto@prueba.mx', hoyTienda());   // 25,000 centavos de la semana, atendidos por otra persona
    const m = (await mios('ana@prueba.mx')).cuerpo;   // cuenta sin tienda: Soledad
    assert.equal(m.tienda_pct, 50);
    assert.equal(Number.isInteger(m.tienda_pct), true);
    assert.equal(m.tienda_alcanzada, false);
    assert.equal(m.bono_pct, 1.5);
    // Cinco metas a pasos iguales entre la linea y el tope (50k, 75k, 100k, 125k, 150k), solo con numero, porcentaje y si ya se logro.
    assert.deepEqual(m.metas, [{ n: 1, pct: 50, lograda: false }, { n: 2, pct: 33, lograda: false }, { n: 3, pct: 25, lograda: false },
      { n: 4, pct: 20, lograda: false }, { n: 5, pct: 16, lograda: false }]);
    // Ni el total (25000), ni la linea (50000) ni el tope (150000), ni llaves con su nombre.
    const texto = JSON.stringify(m);
    for (const prohibido of ['25000', '50000', '75000', '100000', '125000', '150000', '90000']) assert.equal(texto.includes(prohibido), false, prohibido);
    assert.deepEqual(Object.keys(m).filter((k) => /meta|total|linea/.test(k) && !['tienda_alcanzada', 'metas'].includes(k)), []);
    assert.equal(m.semana.ventas, 0);   // lo de Ana, no lo de la tienda
    // Pasar la linea: pasa de 100 y se marca alcanzada. Una meta se logra al SUPERARLA: con exactamente 75,000 la meta 2 aun no.
    await vender('beto@prueba.mx', hoyTienda()); await vender('beto@prueba.mx', hoyTienda());
    const arriba = (await mios('ana@prueba.mx')).cuerpo;
    assert.equal(arriba.tienda_pct, 150);
    assert.equal(arriba.tienda_alcanzada, true);
    assert.deepEqual(arriba.metas.map((x: { lograda: boolean }) => x.lograda), [true, false, false, false, false]);
    // Otra tienda tiene su propio avance: Beto es de Salk y lo vendido en Soledad no cuenta para su linea.
    t.db.prepare(`update usuarios set tienda = 'salk' where correo = 'beto@prueba.mx'`).run();
    const salk = (await mios('beto@prueba.mx')).cuerpo;
    assert.equal(salk.tienda_pct, 0);
    assert.equal(salk.tienda_alcanzada, false);
    t.db.prepare(`update usuarios set tienda = 'romero' where correo = 'beto@prueba.mx'`).run();
    const sinLinea = (await mios('beto@prueba.mx')).cuerpo;   // Romero no tiene linea: bono apagado
    assert.deepEqual([sinLinea.tienda_pct, sinLinea.tienda_alcanzada, sinLinea.metas], [0, false, []]);
  } finally { t.db.close(); }
});

test('/api/retos/mios: racha en curso con datos reales; hoy sin venta no la corta ni la cuenta', async () => {
  const { t, empleado, trabajo, vender, mios } = escenario();
  try {
    const hoy = hoyTienda();
    const ana = await empleado('Ana', 'ana@prueba.mx');
    const sinFicha = (await mios('ana@prueba.mx')).cuerpo.racha;
    assert.deepEqual([sinFicha.largo, sinFicha.cajas, sinFicha.hoy], [0, 0, 'sin_registro']);
    for (const k of [2, 1]) { trabajo(ana, sumarDias(hoy, -k)); await vender('ana@prueba.mx', sumarDias(hoy, -k)); }
    trabajo(ana, hoy);   // llego hoy, todavia no vende
    const pendiente = (await mios('ana@prueba.mx')).cuerpo.racha;
    assert.deepEqual([pendiente.largo, pendiente.cajas, pendiente.meta, pendiente.d, pendiente.hoy], [2, 2, 5, 100, 'pendiente']);
    await vender('ana@prueba.mx', hoy);
    const vendio = (await mios('ana@prueba.mx')).cuerpo.racha;
    assert.deepEqual([vendio.largo, vendio.cajas, vendio.hoy], [3, 3, 'vendio']);
    // Un dia trabajado sin venta en el pasado la corta; un dia libre no.
    trabajo(ana, sumarDias(hoy, -4));   // sin venta
    trabajo(ana, sumarDias(hoy, -5)); await vender('ana@prueba.mx', sumarDias(hoy, -5));
    assert.equal((await mios('ana@prueba.mx')).cuerpo.racha.largo, 3);   // el -3 es libre (no trabajo); el -4 sin venta la corta
    // Una persona sin ficha de empleada no trae racha.
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cris@prueba.mx', 'Cris', 'cajero', 1, '', '')`).run();
    assert.equal((await mios('cris@prueba.mx')).cuerpo.racha, null);
  } finally { t.db.close(); }
});

test('/api/retos/mios: Dolarones en camino con su fecha, logros por tipo e ids para el aviso de premio nuevo', async () => {
  const { t, soloUno, empleado, piezaAntigua, vender, mios } = escenario();
  try {
    soloUno('reto_d_viejo');
    await empleado('Ana', 'ana@prueba.mx');
    piezaAntigua();
    await vender('ana@prueba.mx'); await vender('ana@prueba.mx');
    await otorgarLogros(t.env);
    const cliente = (t.db.prepare(`select cliente_id from empleados where correo = 'ana@prueba.mx'`).get() as { cliente_id: string }).cliente_id;
    const futuro = new Date(Date.now() + 3 * DIA_MS).toISOString();
    t.db.prepare(`insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
      values ('lote-futuro', ?, 'compra', null, 8000, 8000, ?, '2099-01-01T00:00:00Z', '')`).run(cliente, futuro);
    const m = (await mios('ana@prueba.mx')).cuerpo;
    assert.equal(m.por_liberar, 8000);
    assert.equal(m.liberan_el, futuro);
    assert.deepEqual(m.logros_por_tipo, { antiguedad: 2 });
    assert.equal(m.logros.every((l: { id: string }) => typeof l.id === 'string' && l.id.length > 0), true);
    assert.ok(m.reglas.every((r: { etiqueta: string }) => r.etiqueta));
    // Sin cuenta ligada no hay fecha que inventar.
    const sola = (await mios('beto@prueba.mx')).cuerpo;
    assert.deepEqual([sola.liberan_el, sola.por_liberar, sola.racha], [null, 0, null]);
  } finally { t.db.close(); }
});

// Cifras inventadas para las pruebas de #935; ninguna es un importe real.
const LINEA = 50000, TOPE = 150000, LINEA_SALK = 90000, VENTA = 25000;
const PESOS_DE_LA_TIENDA = ['25000', '50000', '75000', '100000', '125000', '150000', '90000'];

test('/api/caja/meta: porcentajes de la tienda de la CUENTA, mismas metas que /api/retos/mios, sin pesos y sin tomar nada de la peticion', async () => {
  const { t, config, vender, mios } = escenario();
  try {
    config({ bono_tienda_desde: Number(sumarDias(lunesDe(hoyTienda()), -7).replaceAll('-', '')), bono_tienda_linea_soledad: LINEA, bono_tienda_meta_tope: TOPE, bono_tienda_linea_salk: LINEA_SALK, bono_tienda_pb: 150 });
    const cuenta = (correo: string, roles: string, tiendaCuenta = '') => t.db.prepare(
      `insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values (?, ?, ?, 1, ?, '', '')`).run(correo, correo.split('@')[0], roles, tiendaCuenta);
    cuenta('cajasalk@prueba.mx', 'cajero', 'salk'); cuenta('cajaromero@prueba.mx', 'cajero', 'romero');
    cuenta('pcsalk@prueba.mx', 'computadora', 'salk'); cuenta('pcsola@prueba.mx', 'computadora'); cuenta('rev@prueba.mx', 'revendedora');
    await vender('beto@prueba.mx', hoyTienda());   // lo vendido en Soledad esta semana
    const caja = async (correo: string, ruta = '/api/caja/meta', cuerpo?: unknown) => {
      t.env.DEV_USUARIO = correo; const r = cuerpo === undefined ? await t.pedir(ruta) : await t.pedir(ruta, cuerpo); t.env.DEV_USUARIO = DUENO; return r;
    };

    const ana = await caja('ana@prueba.mx');   // cajera sin tienda: la central
    assert.equal(ana.status, 200);
    assert.deepEqual(Object.keys(ana.cuerpo).sort(), ['dia', 'metas', 'por_delante', 'tienda']);
    assert.equal(ana.cuerpo.tienda, TIENDAS.soledad.nombre);
    assert.deepEqual(ana.cuerpo.metas, (await mios('ana@prueba.mx')).cuerpo.metas);   // misma fuente
    assert.deepEqual(ana.cuerpo.metas.map((x: { pct: number }) => x.pct), [50, 33, 25, 20, 16]);
    assert.equal(ana.cuerpo.dia, (new Date(`${hoyTienda()}T12:00:00Z`).getUTCDay() + 6) % 7 + 1);
    assert.equal(ana.cuerpo.por_delante, 50 >= Math.round(ana.cuerpo.dia * 100 / 7));
    const texto = JSON.stringify(ana.cuerpo);
    for (const prohibido of PESOS_DE_LA_TIENDA) assert.equal(texto.includes(prohibido), false, prohibido);
    assert.equal(texto.includes('@'), false);
    // El navegador no elige tienda ni persona.
    assert.deepEqual((await caja('ana@prueba.mx', '/api/caja/meta?tienda=salk&correo=cajasalk@prueba.mx')).cuerpo, ana.cuerpo);
    // Otra tienda ve la suya: lo vendido en Soledad no cuenta; Romero no tiene linea.
    const salk = await caja('cajasalk@prueba.mx');
    assert.deepEqual([salk.status, salk.cuerpo.tienda, salk.cuerpo.metas, salk.cuerpo.por_delante], [200, TIENDAS.salk.nombre, [{ n: 1, pct: 0, lograda: false }, { n: 2, pct: 0, lograda: false }, { n: 3, pct: 0, lograda: false }, { n: 4, pct: 0, lograda: false }, { n: 5, pct: 0, lograda: false }], false]);
    assert.deepEqual((await caja('cajaromero@prueba.mx')).cuerpo.metas, []);
    // La computadora de caja entra sin PIN (la franja se pinta antes) y tiene la tienda de su cuenta; sin tienda asignada, nada.
    const pcSalk = await caja('pcsalk@prueba.mx');
    assert.deepEqual([pcSalk.status, pcSalk.cuerpo.tienda], [200, TIENDAS.salk.nombre]);
    assert.deepEqual((await caja('pcsola@prueba.mx')).cuerpo, { tienda: '', metas: [], dia: ana.cuerpo.dia, por_delante: false });
    // Quien no abre /caja no entra: capturista, revendedora, y escribir no existe.
    assert.equal((await caja('beto@prueba.mx')).status, 403);
    assert.equal((await caja('rev@prueba.mx')).status, 403);
    assert.equal((await caja('ana@prueba.mx', '/api/caja/meta', {})).status, 403);
    // Gerencia lo puede leer (la tienda central).
    assert.equal((await t.pedir('/api/caja/meta')).status, 200);
  } finally { t.db.close(); }
});

test('/api/caja/meta: sin linea o sin fecha de inicio del bono, metas vacio; con todas logradas, por delante del ritmo', async () => {
  const { t, config, vender } = escenario();
  try {
    const pedir = async (correo = 'ana@prueba.mx') => { t.env.DEV_USUARIO = correo; const r = await t.pedir('/api/caja/meta'); t.env.DEV_USUARIO = DUENO; return r.cuerpo; };
    assert.deepEqual((await pedir()).metas, []);   // nada configurado
    config({ bono_tienda_linea_soledad: LINEA });   // linea sin fecha de inicio: apagado
    assert.deepEqual((await pedir()).metas, []);
    config({ bono_tienda_desde: Number(sumarDias(lunesDe(hoyTienda()), -7).replaceAll('-', '')), bono_tienda_linea_soledad: 10000 });
    await vender('beto@prueba.mx', hoyTienda());   // 25,000 contra una linea de 10,000: solo hay una meta y ya paso
    const cuerpo = await pedir();
    assert.deepEqual(cuerpo.metas, [{ n: 1, pct: 250, lograda: true }]);
    assert.equal(cuerpo.por_delante, true);
  } finally { t.db.close(); }
});

test('/api/retos/mios: «mi bono de la semana pasada» sale solo de lo asentado y solo para su dueña; sin asentar no hay importe', async () => {
  const { t, config, empleado, trabajo, vender, mios } = escenario();
  try {
    const pasada = sumarDias(lunesDe(hoyTienda()), -7);
    config({ bono_tienda_desde: Number(sumarDias(pasada, -7).replaceAll('-', '')), bono_tienda_linea_soledad: 10000, bono_tienda_pb: 1000, bono_d_cada: 100, bono_d_tope: 50 });
    const ana = await empleado('Ana', 'ana@prueba.mx');
    const beto = await empleado('Beto', 'beto@prueba.mx');
    for (let i = 0; i < 3; i++) trabajo(ana, sumarDias(pasada, i));
    trabajo(beto, pasada);
    await vender('beto@prueba.mx', sumarDias(pasada, 2));   // 25,000 contra una linea de 10,000: bolsa de 1,500, 3 de 4 dias para Ana

    // Aun sin asentar: no hay importe (no se recalcula) y el JSON no trae nada de la tienda.
    const antes = (await mios('ana@prueba.mx')).cuerpo;
    assert.deepEqual(antes.bono_pasado, { semana: pasada, registrado: false, importe: null, d: null });
    assert.equal(JSON.stringify(antes).includes('1125'), false);

    assert.equal((await t.pedir('/api/reportes/equipo/bono', { semana: pasada })).status, 201);
    const a = (await mios('ana@prueba.mx', '/api/retos/mios?correo=beto@prueba.mx&empleado=' + beto)).cuerpo;   // la peticion no cambia de persona
    const b = (await mios('beto@prueba.mx')).cuerpo;
    assert.deepEqual(a.bono_pasado, { semana: pasada, registrado: true, importe: 1125, d: 11 });
    assert.deepEqual(b.bono_pasado, { semana: pasada, registrado: true, importe: 375, d: 3 });
    // Cada quien ve lo suyo: nada de la otra persona ni de la tienda (ni ventas, ni linea, ni bolsa, ni dias, ni el reparto).
    assert.equal(JSON.stringify(a).includes('375'), false);
    assert.equal(JSON.stringify(a).includes('Beto'), false);
    for (const prohibido of ['25000', '10000', '1500']) { assert.equal(JSON.stringify(a).includes(prohibido), false, prohibido); assert.equal(JSON.stringify(b).includes(prohibido), false, prohibido); }
    assert.deepEqual(Object.keys(a.bono_pasado).sort(), ['d', 'importe', 'registrado', 'semana']);
    // Cambiar la config despues de asentar no cambia lo que se muestra: es lo pagado, no un recalculo.
    config({ bono_tienda_pb: 100, bono_tienda_linea_soledad: 20000 });
    assert.deepEqual((await mios('ana@prueba.mx')).cuerpo.bono_pasado, { semana: pasada, registrado: true, importe: 1125, d: 11 });
    // Alguien sin ficha de empleada, o que no estaba en el reparto, no ve importe aunque la semana ya este asentada.
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cris@prueba.mx', 'Cris', 'cajero', 1, '', '')`).run();
    assert.deepEqual((await mios('cris@prueba.mx')).cuerpo.bono_pasado, { semana: pasada, registrado: false, importe: null, d: null });
  } finally { t.db.close(); }
});
