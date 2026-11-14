// node --test src/bultos.test.ts
// Sucursales 2/3 (#793, #795): existencias por sucursal y bultos (R3 y R4).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { leerFolio, nuevoFolio, PATRON_FOLIO } from './bultos.ts';

const PC_SALK = 'pcsalk@prueba.mx';
const PC_ROMERO = 'pcromero@prueba.mx';
const PC_SOLEDAD = 'pcsoledad@prueba.mx';
const CAPTURISTA = 'cap@prueba.mx';
const ANA = 'ana@prueba.mx';
const PIN = '482913';
const PIEZA2 = 'b2222222-2222-4222-8222-222222222222';

function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values
    (?, 'PC Salk', 'computadora', 1, 'salk', '', ''), (?, 'PC Romero', 'computadora', 1, 'romero', '', ''),
    (?, 'PC Soledad', 'computadora', 1, 'soledad', '', ''), (?, 'Cap', 'capturista', 1, '', '', ''), (?, 'Ana', 'cajero', 1, '', '', '')`)
    .run(PC_SALK, PC_ROMERO, PC_SOLEDAD, CAPTURISTA, ANA);
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
    values (?, 'ED-000002', 'Lámpara', 15000, 3, 'S40', '', '')`).run(PIEZA2);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const sesiones = new Map<string, string>();
  let conPin = false;
  const terminal = async (pc: string, cajero = ANA) => {   // la computadora de caja de una tienda con el PIN del cajero
    if (!conPin) { como(DUENO); await t.pedir('/api/cuentas/pin', { correo: ANA, pin: PIN }, 'PUT'); conPin = true; }   // poner el PIN cierra sus sesiones: una sola vez
    como(pc);
    const token = sesiones.get(pc) ?? (await t.pedir('/api/cajeros/entrar', { correo: cajero, pin: PIN })).cuerpo.token as string;
    sesiones.set(pc, token);
    return (ruta: string, cuerpo?: unknown, metodo = 'POST') => { como(pc); return t.pedir(ruta, cuerpo, metodo, { 'x-cajero': token }); };
  };
  const yo = (correo: string) => (ruta: string, cuerpo?: unknown, metodo = 'POST') => { como(correo); return t.pedir(ruta, cuerpo, metodo); };
  const nuevoBulto = async (quien: ReturnType<typeof yo>, destino = 'salk', origen?: string) => {
    const r = await quien('/api/bultos', { id: crypto.randomUUID(), destino, ...(origen ? { origen } : {}) });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    return r.cuerpo.folio as string;
  };
  const escanear = (quien: ReturnType<typeof yo>, folio: string, codigo: string, id = crypto.randomUUID(), extra = {}) =>
    quien(`/api/bultos/${folio}/piezas`, { id, codigo, ...extra });
  const stock = (id = PRODUCTO) => (t.db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
  const enSucursal = (tiendaClave: string, id = PRODUCTO) =>
    (t.db.prepare('select unidades from existencia_tienda where producto_id = ? and tienda = ?').get(id, tiendaClave) as { unidades: number } | undefined)?.unidades ?? 0;
  const enCamino = (id = PRODUCTO) => (t.db.prepare(`select coalesce(sum(l.cantidad), 0) as n from bulto_lineas l join bultos b on b.id = l.bulto_id
    where l.producto_id = ? and l.quitada_en is null and b.estado in ('abierto', 'cerrado')`).get(id) as { n: number }).n;
  /** Soledad + sucursales + en camino: lo que el negocio tiene de una pieza (cambia solo con ventas, ajustes y capturas, nunca con un bulto). */
  const total = (id = PRODUCTO) => stock(id) + enSucursal('salk', id) + enSucursal('romero', id) + enCamino(id);
  return { ...t, como, terminal, yo, nuevoBulto, escanear, stock, enSucursal, enCamino, total };
}

const conteos = (db: DatabaseSync) => Object.fromEntries((db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as { name: string }[])
  .map(({ name }) => [name, (db.prepare(`select count(*) as n from "${name}"`).get() as { n: number }).n]));

test('folio: BU- y cinco caracteres sin 0, O, 1 ni I; se lee con o sin guion y en minúsculas; no se confunde con un código de pieza', () => {
  for (let i = 0; i < 200; i += 1) assert.match(nuevoFolio(), PATRON_FOLIO);
  assert.equal(leerFolio(' bu-k7q2m '), 'BU-K7Q2M');
  assert.equal(leerFolio('BUK7Q2M'), 'BU-K7Q2M');
  for (const malo of ['ED-000123', '123', 'P-17', 'DC-ABCDE', 'BU-K7Q20', 'BU-K7Q', '']) assert.equal(leerFolio(malo), null, malo);
});

test('armar: la misma pieza con el mismo UUID no se mete dos veces; cada escaneo baja Soledad y la suma se conserva', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap);
  const antes = m.total();
  const id = crypto.randomUUID();
  const primero = await m.escanear(cap, folio, 'ED-000001', id);
  assert.equal(primero.status, 201, JSON.stringify(primero.cuerpo));
  const otra = await m.escanear(cap, folio, 'ED-000001', id);
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.repetido, true);
  assert.equal(m.stock(), 49);
  assert.equal(m.enCamino(), 1);
  assert.equal((m.db.prepare('select count(*) as n from bulto_lineas').get() as { n: number }).n, 1);
  assert.equal((await m.escanear(cap, folio, '1')).status, 201, 'solo dígitos: el código completo se arma como en la caja');
  assert.equal(m.stock(), 48);
  assert.equal(m.total(), antes);
});

test('armar: meter más unidades de las que hay en el origen falla sin renglón; bandas, botes y mercancía de FEP no se escanean', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap);
  for (let i = 0; i < 3; i += 1) assert.equal((await m.escanear(cap, folio, 'ED-000002')).status, 201);
  const sinExistencia = await m.escanear(cap, folio, 'ED-000002');
  assert.equal(sinExistencia.status, 409);
  assert.match(sinExistencia.cuerpo.error, /No hay existencia de Lámpara/);
  assert.equal(m.stock(PIEZA2), 0);
  assert.equal((m.db.prepare('select count(*) as n from bulto_lineas where producto_id = ?').get(PIEZA2) as { n: number }).n, 3, 'sin renglón de la cuarta');
  const demas = await m.escanear(cap, folio, 'ED-000001', crypto.randomUUID(), { cantidad: 100 });
  assert.equal(demas.status, 400, 'tope por escaneo');
  m.db.prepare("update productos set sin_inventario = 1 where id = ?").run(PRODUCTO);
  assert.equal((await m.escanear(cap, folio, 'ED-000001')).status, 409);
  m.db.prepare("update productos set sin_inventario = 0, propietario = 'fep' where id = ?").run(PRODUCTO);
  assert.equal((await m.escanear(cap, folio, 'ED-000001')).status, 409);
  assert.equal((await m.escanear(cap, folio, 'ED-999999')).status, 404);
  assert.equal((await m.escanear(cap, folio, folio)).status, 400, 'el folio de un bulto no es una pieza');
});

test('armar: el trigger rechaza una línea en bulto cerrado o de pieza sin existencia contable, aunque se escriba directo', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap);
  await m.escanear(cap, folio, 'ED-000001');
  assert.equal((await cap(`/api/bultos/${folio}/cerrar`, {})).status, 200);
  const insertar = () => m.db.prepare(`insert into bulto_lineas (id, bulto_id, producto_id, cantidad, creado_por, creado_en)
    select ?, id, ?, 1, 'x', '' from bultos where folio = ?`).run(crypto.randomUUID(), PRODUCTO, folio);
  assert.throws(insertar, /bulto no abierto/);
  assert.equal((await m.escanear(cap, folio, 'ED-000001')).status, 409);
  assert.equal(m.stock(), 49);
});

test('quitar una pieza la regresa al origen una sola vez', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap);
  await m.escanear(cap, folio, 'ED-000001');
  const linea = (m.db.prepare('select id from bulto_lineas').get() as { id: string }).id;
  assert.equal(m.stock(), 49);
  assert.equal((await cap(`/api/bultos/${folio}/quitar`, { linea })).status, 200);
  assert.equal(m.stock(), 50);
  const otra = await cap(`/api/bultos/${folio}/quitar`, { linea });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.repetido, true);
  assert.equal(m.stock(), 50, 'el reintento no suma otra vez');
  assert.equal(m.total(), 50);
  assert.equal((await cap(`/api/bultos/${folio}/cerrar`, {})).status, 409, 'un bulto sin piezas no se cierra');
});

test('cancelar un bulto abierto devuelve todo al origen, una sola vez; uno cerrado ya no se cancela', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap);
  for (const [codigo, veces] of [['ED-000001', 2], ['ED-000002', 3]] as const) for (let i = 0; i < veces; i += 1) await m.escanear(cap, folio, codigo);
  const quitada = (m.db.prepare('select id from bulto_lineas where producto_id = ? limit 1').get(PRODUCTO) as { id: string }).id;
  await cap(`/api/bultos/${folio}/quitar`, { linea: quitada });
  assert.deepEqual([m.stock(), m.stock(PIEZA2)], [49, 0]);
  const r = await cap(`/api/bultos/${folio}/cancelar`, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([m.stock(), m.stock(PIEZA2)], [50, 3]);
  const otra = await cap(`/api/bultos/${folio}/cancelar`, {});
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.ya_estaba, true);
  assert.deepEqual([m.stock(), m.stock(PIEZA2)], [50, 3], 'cancelar dos veces devuelve una');
  assert.equal((await m.escanear(cap, folio, 'ED-000001')).status, 409);
  const cerrado = await m.nuevoBulto(cap);
  await m.escanear(cap, cerrado, 'ED-000001');
  await cap(`/api/bultos/${cerrado}/cerrar`, {});
  assert.equal((await cap(`/api/bultos/${cerrado}/cancelar`, {})).status, 409);
  assert.equal(m.stock(), 49);
});

test('recibir: las unidades entran al destino en un solo paso; recibir dos veces suma una; tienda equivocada rechaza y dice a dónde va', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap, 'salk');
  await m.escanear(cap, folio, 'ED-000001'); await m.escanear(cap, folio, 'ED-000001'); await m.escanear(cap, folio, 'ED-000002');
  const salk = await m.terminal(PC_SALK), romero = await m.terminal(PC_ROMERO);
  const total = [m.total(), m.total(PIEZA2)];
  assert.equal((await salk('/api/bultos/recibir', { folio })).status, 409, 'abierto: aún no sale de Soledad');
  assert.equal((await cap(`/api/bultos/${folio}/cerrar`, {})).status, 200);
  assert.deepEqual([m.total(), m.total(PIEZA2)], total);
  const equivocada = await romero('/api/bultos/recibir', { folio });
  assert.equal(equivocada.status, 409);
  assert.match(equivocada.cuerpo.error, /va a Avenida Salk/);
  assert.equal(m.enSucursal('romero') + m.enSucursal('salk'), 0);
  const entrantes = await salk('/api/bultos/entrantes', undefined, 'GET');
  assert.deepEqual(entrantes.cuerpo.map((b: { folio: string }) => b.folio), [folio]);
  assert.deepEqual((await romero('/api/bultos/entrantes', undefined, 'GET')).cuerpo, []);
  const recibido = await salk('/api/bultos/recibir', { folio: folio.toLowerCase().replace('-', '') });
  assert.equal(recibido.status, 200, JSON.stringify(recibido.cuerpo));
  assert.equal(recibido.cuerpo.estado, 'recibido');
  assert.equal(recibido.cuerpo.piezas, 3);
  assert.deepEqual([m.enSucursal('salk'), m.enSucursal('salk', PIEZA2)], [2, 1]);
  assert.deepEqual([m.total(), m.total(PIEZA2)], total, 'la suma se conserva');
  const otra = await salk('/api/bultos/recibir', { folio });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.ya_estaba, true);
  assert.deepEqual([m.enSucursal('salk'), m.enSucursal('salk', PIEZA2)], [2, 1], 'recibir dos veces suma una');
  assert.equal((await romero('/api/bultos/recibir', { folio })).status, 409, 'ya recibido, la tienda equivocada sigue rechazada');
  assert.equal((await salk('/api/bultos/recibir', { folio: 'ED-000001' })).status, 400);
  assert.equal((await salk('/api/bultos/recibir', { folio: 'BU-ZZZZZ' })).status, 404);
});

test('recibir lo hace la tienda destino o el dueño; la computadora sin PIN o sin tienda no recibe; un capturista no recibe', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap, 'romero');
  await m.escanear(cap, folio, 'ED-000001');
  await cap(`/api/bultos/${folio}/cerrar`, {});
  m.como(PC_ROMERO);
  assert.equal((await m.pedir('/api/bultos/recibir', { folio })).status, 401, 'sin PIN');
  assert.equal((await cap('/api/bultos/recibir', { folio })).status, 403);
  const dueno = await m.yo(DUENO)('/api/bultos/recibir', { folio });
  assert.equal(dueno.status, 200, JSON.stringify(dueno.cuerpo));
  assert.equal(m.enSucursal('romero'), 1, 'entra al destino del bulto, no a la tienda del dueño');
  assert.equal(m.enSucursal('salk'), 0);
});

test('regresar a Soledad: el mismo flujo con otro origen; el capturista no arma desde sucursal, el dueño sí', async () => {
  const m = montar();
  m.db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'salk', 5, '')").run(PRODUCTO);
  const cap = m.yo(CAPTURISTA), dueno = m.yo(DUENO);
  assert.equal((await cap('/api/bultos', { id: crypto.randomUUID(), destino: 'soledad', origen: 'salk' })).status, 403);
  const folio = await m.nuevoBulto(dueno, 'soledad', 'salk');
  const total = m.total();
  await m.escanear(dueno, folio, 'ED-000001'); await m.escanear(dueno, folio, 'ED-000001');
  assert.deepEqual([m.enSucursal('salk'), m.stock()], [3, 50]);
  for (let i = 0; i < 4; i += 1) await m.escanear(dueno, folio, 'ED-000001');
  assert.equal((await m.escanear(dueno, folio, 'ED-000001')).status, 409, 'solo había 5 en la sucursal');
  assert.equal(m.enSucursal('salk'), 0);
  assert.equal(m.total(), total);
  await dueno(`/api/bultos/${folio}/cerrar`, {});
  const r = await dueno('/api/bultos/recibir', { folio });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([m.stock(), m.enSucursal('salk')], [55, 0]);
  assert.equal(m.total(), total);
});

test('la suma Soledad + sucursales + en camino se conserva en cada operación de bulto', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA), salk = await m.terminal(PC_SALK);
  const base = m.total();
  const revisar = (que: string) => assert.equal(m.total(), base, que);
  const folio = await m.nuevoBulto(cap, 'salk');
  for (let i = 0; i < 5; i += 1) await m.escanear(cap, folio, 'ED-000001'); revisar('armar');
  await cap(`/api/bultos/${folio}/quitar`, { linea: (m.db.prepare('select id from bulto_lineas limit 1').get() as { id: string }).id }); revisar('quitar');
  await cap(`/api/bultos/${folio}/cerrar`, {}); revisar('cerrar');
  await salk('/api/bultos/recibir', { folio }); revisar('recibir');
  const segundo = await m.nuevoBulto(cap, 'romero');
  await m.escanear(cap, segundo, 'ED-000001'); revisar('armar otro');
  await cap(`/api/bultos/${segundo}/cancelar`, {}); revisar('cancelar');
  assert.equal(m.enSucursal('salk'), 4);
  assert.equal(m.stock(), 46);
});

test('venta en sucursal: baja la existencia de esa sucursal y no la de Soledad; la venta guarda su tienda; el reintento no vuelve a bajar', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA), salk = await m.terminal(PC_SALK);
  const folio = await m.nuevoBulto(cap, 'salk');
  for (let i = 0; i < 3; i += 1) await m.escanear(cap, folio, 'ED-000001');
  await cap(`/api/bultos/${folio}/cerrar`, {});
  await salk('/api/bultos/recibir', { folio });
  const id = crypto.randomUUID();
  const venta = { id, lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'efectivo', efectivo: 50000, caja: 'Salk 1' };
  assert.equal((await salk('/api/ventas', venta)).status, 201);
  assert.deepEqual([m.enSucursal('salk'), m.stock()], [1, 47]);
  assert.deepEqual({ ...(m.db.prepare('select tienda, caja from ventas where id = ?').get(id) as object) }, { tienda: 'salk', caja: 'Salk 1' });
  assert.equal((await salk('/api/ventas', venta)).status, 200);
  assert.equal(m.enSucursal('salk'), 1);
  const demas = await salk('/api/ventas', { ...venta, id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }] });
  assert.equal(demas.status, 409, 'más de las que hay en la sucursal aborta el ticket');
  assert.equal(m.enSucursal('salk'), 1);
});

test('dos ventas concurrentes por la última unidad de una sucursal: gana una', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA), salk = await m.terminal(PC_SALK);
  const folio = await m.nuevoBulto(cap, 'salk');
  await m.escanear(cap, folio, 'ED-000001');
  await cap(`/api/bultos/${folio}/cerrar`, {});
  await salk('/api/bultos/recibir', { folio });
  const una = () => salk('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Salk 2' });
  const resultados = await Promise.all([una(), una()]);
  assert.deepEqual(resultados.map((r) => r.status).sort(), [201, 409]);
  assert.equal(m.enSucursal('salk'), 0);
  assert.equal((m.db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 1);
});

test('venta en sucursal de una pieza que nunca llegó aborta sin venta, sin Dolarones y sin fila a medias', async () => {
  const m = montar();
  const salk = await m.terminal(PC_SALK);
  m.como(DUENO);
  await m.pedir('/api/socios', { nombre: 'Socia', telefono: '4441234567' }, 'POST').catch(() => null);
  const antes = conteos(m.db);
  const r = await salk('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Salk 1' });
  assert.equal(r.status, 409);
  assert.deepEqual(conteos(m.db), antes);
  assert.equal(m.stock(), 50);
});

test('devolución y cancelación entran a la tienda donde se hacen, aunque la venta fuera de otra', async () => {
  const m = montar();
  const salk = await m.terminal(PC_SALK), soledad = await m.terminal(PC_SOLEDAD);
  const venta = async (id: string, cantidad: number) => {
    const r = await soledad('/api/ventas', { id, lineas: [{ producto_id: PRODUCTO, cantidad }], forma_pago: 'efectivo', efectivo: 100000, caja: 'Caja 1' });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  };
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  await venta(a, 3); await venta(b, 2);
  assert.equal(m.stock(), 45);
  // Una pieza suelta devuelta en Salk entra a Salk.
  const linea = (m.db.prepare('select id from venta_lineas where venta_id = ?').get(a) as { id: number }).id;
  const pieza = await salk(`/api/ventas/${a}/lineas/${linea}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'no le quedó', caja: 'Salk 1' });
  assert.equal(pieza.status, 201, JSON.stringify(pieza.cuerpo));
  assert.deepEqual([m.enSucursal('salk'), m.stock()], [1, 45]);
  assert.equal((m.db.prepare('select tienda, caja from devoluciones').get() as { tienda: string }).tienda, 'salk');
  // Un ticket cancelado completo en Romero entra a Romero.
  const romero = await m.terminal(PC_ROMERO);
  const completa = await romero(`/api/ventas/${b}/cancelar`, { motivo: 'error', caja: 'Romero 1' });
  assert.equal(completa.status, 200, JSON.stringify(completa.cuerpo));
  assert.deepEqual([m.enSucursal('romero'), m.stock()], [2, 45]);
  assert.equal((m.db.prepare('select cancelada_tienda as t, cancelada_caja as c from ventas where id = ?').get(b) as { t: string }).t, 'romero');
  // Sin caja una terminal de sucursal no cancela: de la caja sale la tienda si el dueño aprueba a distancia.
  assert.equal((await salk(`/api/ventas/${a}/cancelar`, { motivo: 'x' })).status, 400);
  // En Soledad, lo de siempre.
  const c = crypto.randomUUID(); await venta(c, 1);
  assert.equal((await soledad(`/api/ventas/${c}/cancelar`, { motivo: 'error', caja: 'Caja 1' })).status, 200);
  assert.equal(m.stock(), 45);
});

test('el catálogo de la caja trae la existencia de su tienda, también en el incremental', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA), salk = await m.terminal(PC_SALK), soledad = await m.terminal(PC_SOLEDAD);
  const existencia = async (quien: typeof salk, id = PRODUCTO) => ((await quien('/api/catalogo', undefined, 'GET')).cuerpo as { id: string; stock: number }[]).find((p) => p.id === id)?.stock;
  assert.equal(await existencia(salk), 0, 'la pieza nunca llegó a Salk');
  assert.equal(await existencia(soledad), 50);
  const desde = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  const folio = await m.nuevoBulto(cap, 'salk');
  await m.escanear(cap, folio, 'ED-000001'); await m.escanear(cap, folio, 'ED-000001');
  await cap(`/api/bultos/${folio}/cerrar`, {});
  await salk('/api/bultos/recibir', { folio });
  assert.equal(await existencia(salk), 2);
  const incremental = await salk(`/api/catalogo?desde=${encodeURIComponent(desde)}`, undefined, 'GET');
  assert.equal((incremental.cuerpo.piezas as { id: string; stock: number }[]).find((p) => p.id === PRODUCTO)?.stock, 2, 'recibir mueve existencia_tienda, no productos');
  assert.equal(await existencia(soledad), 48);
});

test('apartados y pedidos son solo de Soledad; una cuenta de sucursal no captura ni ajusta Soledad; una venta de sucursal no usa un apartado', async () => {
  const m = montar();
  const salk = await m.terminal(PC_SALK);
  assert.equal((await salk('/api/pedidos', {})).status, 409);
  assert.equal((await salk('/api/ventas', { id: crypto.randomUUID(), pedido_id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Salk 1' })).status, 409);
  m.db.prepare("insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values ('capsalk@prueba.mx', 'Cap', 'capturista', 1, 'salk', '', '')").run();
  const cap = m.yo('capsalk@prueba.mx');
  assert.equal((await cap(`/api/piezas/${PRODUCTO}/existencia`, { id: crypto.randomUUID(), delta: 1, motivo: 'entrada' })).status, 403);
  assert.equal((await cap('/api/borradores/manual', {})).status, 403);
  assert.equal(m.stock(), 50);
});

test('una cuenta de sucursal no aparta desde /vender ni escribe existencia de Soledad por ropa-ia o piezas', async () => {
  const m = montar();
  const cuenta = (correo: string, roles: string) => m.db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values (?, 'X', ?, 1, 'salk', '', '')`).run(correo, roles);
  cuenta('rev@prueba.mx', 'revendedora'); cuenta('duenosalk@prueba.mx', 'dueno'); cuenta('capsalk@prueba.mx', 'capturista');
  const antes = conteos(m.db);
  const rev = m.yo('rev@prueba.mx'), duenoSalk = m.yo('duenosalk@prueba.mx'), cap = m.yo('capsalk@prueba.mx');
  const apartar = await rev('/api/vender/apartar', { id: crypto.randomUUID(), producto_id: PRODUCTO, cliente: 'Ana', telefono: '4441234567' });
  assert.equal(apartar.status, 409, JSON.stringify(apartar.cuerpo));
  assert.match(apartar.cuerpo.error, /solo de Soledad/);
  assert.equal((await rev('/api/vender/apartados/1/cancelar', {})).status, 409);
  assert.equal((await rev('/api/vender/apartados/1/pago', {})).status, 409);
  assert.equal((await cap('/api/ropa-ia/x', {})).status, 403);
  assert.equal((await duenoSalk(`/api/piezas/${PRODUCTO}/existencia`, { id: crypto.randomUUID(), delta: -1, motivo: 'merma' })).status, 403);
  assert.deepEqual(conteos(m.db), antes);
  assert.equal(m.stock(), 50);
});

test('fusión, juntar y descarte se bloquean si la pieza tiene unidades en una sucursal o en camino', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap, 'salk');
  await m.escanear(cap, folio, 'ED-000001');
  const descartar = () => m.yo(DUENO)(`/api/borradores/${PRODUCTO}`, {}, 'DELETE');
  const enCamino = await descartar();
  assert.equal(enCamino.status, 409, JSON.stringify(enCamino.cuerpo));
  assert.match(enCamino.cuerpo.error, /sucursal o en camino/);
  assert.notEqual(m.stock(), 0);
  const otra = 'c3333333-3333-4333-8333-333333333333';
  m.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, 'ED-000003', 'Lámpara 2', 15000, 1, 'S40', '', '')`).run(otra);
  const juntar = await m.yo(DUENO)(`/api/piezas/${PRODUCTO}/juntar`, { id: crypto.randomUUID(), destino_id: otra });
  assert.equal(juntar.status, 409);
  assert.match(juntar.cuerpo.error, /sucursal o en camino/);
  // En una sucursal, recibido, sigue bloqueado; con la existencia en cero deja de estarlo.
  await cap(`/api/bultos/${folio}/cerrar`, {});
  await (await m.terminal(PC_SALK))('/api/bultos/recibir', { folio });
  assert.equal((await descartar()).status, 409);
  const borrador = 'd4444444-4444-4444-8444-444444444444';
  m.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values (?, 'ED-000004', 'Repetida', 15000, 1, 'S40', '', '')`).run(borrador);
  m.db.prepare("update productos set codigo = null where id = ?").run(otra);
  m.db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, 'romero', 1, '')").run(borrador);
  const fusion = await m.yo(DUENO)(`/api/borradores/${borrador}/fusionar`, { destino_id: otra });
  assert.equal(fusion.status, 409);
  assert.match(fusion.cuerpo.error, /sucursal o en camino/);
});

test('ajuste de faltante o sobrante en sucursal: sobre su propia existencia, con renglón en conteo_ajustes con tienda, idempotente y solo del dueño', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA), dueno = m.yo(DUENO);
  const folio = await m.nuevoBulto(cap, 'romero');
  for (let i = 0; i < 4; i += 1) await m.escanear(cap, folio, 'ED-000001');
  await cap(`/api/bultos/${folio}/cerrar`, {});
  await (await m.terminal(PC_ROMERO))('/api/bultos/recibir', { folio });
  const ajustar = (cuerpo: Record<string, unknown>, quien = dueno) => quien(`/api/piezas/${PRODUCTO}/existencia`, { id: crypto.randomUUID(), tienda: 'romero', ...cuerpo });
  const id = crypto.randomUUID();
  const faltante = await ajustar({ id, fijar_a: 3, esperado: 4, motivo: 'merma' });
  assert.equal(faltante.status, 200, JSON.stringify(faltante.cuerpo));
  assert.deepEqual([m.enSucursal('romero'), m.stock()], [3, 46], 'Soledad no se toca');
  assert.deepEqual({ ...(m.db.prepare('select tienda, antes, despues, motivo from conteo_ajustes where id = ?').get(id) as object) }, { tienda: 'romero', antes: 4, despues: 3, motivo: 'merma' });
  assert.equal((await ajustar({ id, fijar_a: 3, esperado: 4, motivo: 'merma' })).status, 200);
  assert.equal(m.enSucursal('romero'), 3, 'el mismo folio no descuenta dos veces');
  assert.equal((await ajustar({ fijar_a: 2, esperado: 4, motivo: 'merma' })).status, 409, 'esperado vencido');
  assert.equal((await ajustar({ delta: 2, motivo: 'correccion' })).status, 200, 'sobrante');
  assert.equal(m.enSucursal('romero'), 5);
  assert.equal((await ajustar({ delta: -9, motivo: 'robo' })).status, 409, 'no baja de cero');
  assert.equal((await ajustar({ delta: 1, motivo: 'entrada' })).status, 400);
  assert.equal((await ajustar({ delta: 1, motivo: 'correccion' }, cap)).status, 403);
  assert.equal((await ajustar({ delta: 1, motivo: 'correccion', tienda: 'otra' })).status, 400);
  // Una pieza que nunca llegó a esa sucursal: sobrante crea la existencia con rastro.
  const sobrante = await dueno(`/api/piezas/${PIEZA2}/existencia`, { id: crypto.randomUUID(), tienda: 'salk', delta: 1, motivo: 'correccion' });
  assert.equal(sobrante.status, 200, JSON.stringify(sobrante.cuerpo));
  assert.equal(m.enSucursal('salk', PIEZA2), 1);
});

test('la ficha de la pieza trae lo que hay en sucursales y los movimientos por bulto; el historial de Soledad no mezcla a las sucursales', async () => {
  const m = montar();
  const cap = m.yo(CAPTURISTA);
  const folio = await m.nuevoBulto(cap, 'salk');
  await m.escanear(cap, folio, 'ED-000001'); await m.escanear(cap, folio, 'ED-000001');
  await cap(`/api/bultos/${folio}/cerrar`, {});
  await (await m.terminal(PC_SALK))('/api/bultos/recibir', { folio });
  const ficha = (await m.yo(DUENO)(`/api/piezas/${PRODUCTO}`, undefined, 'GET')).cuerpo;
  assert.deepEqual(ficha.en_sucursales, [{ tienda: 'salk', unidades: 2 }]);
  assert.deepEqual(ficha.movimientos_bulto.map((x: { tipo: string; cantidad: number; tienda: string }) => [x.tipo, x.cantidad, x.tienda]).sort(),
    [['bulto_entrada', 1, 'salk'], ['bulto_entrada', 1, 'salk'], ['bulto_salida', -1, 'soledad'], ['bulto_salida', -1, 'soledad']].sort());
  const soledad = m.db.prepare(`select coalesce(sum(cantidad), 0) as n from movimientos_existencia where producto_id = ? and tienda = 'soledad'`).get(PRODUCTO) as { n: number };
  assert.equal(soledad.n, -2, 'la vista de Soledad solo ve las salidas del bulto');
});

test('la pantalla de bultos: abre para dueño, capturista y caja; la API de armar no es de la caja y la de recibir sí', async () => {
  const m = montar();
  m.como(PC_SALK);
  assert.notEqual((await m.enviar('/bultos', undefined, 'GET')).status, 403);
  m.como(ANA);
  assert.equal((await m.pedir('/api/bultos', { id: crypto.randomUUID(), destino: 'salk' })).status, 403, 'armar no es del cajero');
  assert.equal((await m.pedir('/api/bultos', undefined, 'GET')).status, 403);
});
