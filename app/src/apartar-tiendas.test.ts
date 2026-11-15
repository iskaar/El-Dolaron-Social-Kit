// node --test src/apartar-tiendas.test.ts
// Sucursales 4/4 (#793, #800): en línea se vende la mercancía de cualquier tienda; el cliente recoge donde elija y la tienda donde está
// la pieza recibe el aviso. Contra SQLite real con todas las migraciones.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { tienda, DUENO } from './prueba-d1.ts';
import { apartarPortal, cancelarDeSocio, vencerPedidos, elegirOrigen, HORAS_PORTAL } from './pedidos.ts';
import { avisarTiendas } from './avisos-pedidos.ts';
import { PUBLICABLE } from './mercadolibre.ts';
import { PATRON_FOLIO } from './bultos.ts';
import { VENDIBLE } from './catalogo.ts';
import worker from './worker.ts';

const PC_SALK = 'pcsalk@prueba.mx';
const PC_ROMERO = 'pcromero@prueba.mx';
const PC_SOLEDAD = 'pcsoledad@prueba.mx';
const ANA = 'ana@prueba.mx';
const PIN = '482913';
const SOCIA = { nombre: 'Lucía Socia', telefono: '4441112222' };
const OTRA_SOCIA = { nombre: 'Marta Otra', telefono: '4449998888' };

let consecutivo = 200;

function montar() {
  const t = tienda();
  const { db } = t;
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values
    (?, 'PC Salk', 'computadora', 1, 'salk', '', ''), (?, 'PC Romero', 'computadora', 1, 'romero', '', ''),
    (?, 'PC Soledad', 'computadora', 1, 'soledad', '', ''), (?, 'Ana', 'cajero', 1, '', '', '')`).run(PC_SALK, PC_ROMERO, PC_SOLEDAD, ANA);
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const sesiones = new Map<string, string>();
  let conPin = false;
  /** La computadora de caja de una tienda con el PIN del cajero. */
  const terminal = async (pc: string) => {
    if (!conPin) { como(DUENO); await t.pedir('/api/cuentas/pin', { correo: ANA, pin: PIN }, 'PUT'); conPin = true; }
    como(pc);
    const token = sesiones.get(pc) ?? (await t.pedir('/api/cajeros/entrar', { correo: ANA, pin: PIN })).cuerpo.token as string;
    sesiones.set(pc, token);
    return (ruta: string, cuerpo?: unknown, metodo = 'POST') => { como(pc); return t.pedir(ruta, cuerpo, metodo, { 'x-cajero': token }); };
  };
  const dueno = (ruta: string, cuerpo?: unknown, metodo = 'POST') => { como(DUENO); return t.pedir(ruta, cuerpo, metodo); };
  /** Una pieza vendible con sus unidades repartidas. */
  const pieza = (precio: number, soledad: number, salk = 0, romero = 0, nombre = "Chamarra Levis") => {
    const id = crypto.randomUUID();
    const codigo = `ED-${String(++consecutivo).padStart(6, '0')}`;
    db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
      values (?, ?, ?, ?, ?, 'listo', 'fotos/x.jpg', 'S40', '', '')`).run(id, codigo, nombre, precio, soledad);
    for (const [clave, n] of [['salk', salk], ['romero', romero]] as const)
      if (n) db.prepare("insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, ?, ?, '')").run(id, clave, n);
    return { id, codigo };
  };
  const portal = async (codigo: string, extra: Record<string, unknown> = {}, socio = SOCIA) => {
    const cuerpo = { id: crypto.randomUUID(), codigo, entrega: 'tienda', ...extra };
    const r = await apartarPortal(new Request('https://portal.prueba/api/portal/apartar', { method: 'POST', body: JSON.stringify(cuerpo) }) as never,
      t.env, t.ctx as never, socio);
    return { status: r.status, cuerpo: (await r.json()) as Record<string, any>, id: cuerpo.id as string };
  };
  const unidades = (id: string, de: 'soledad' | 'salk' | 'romero') => de === 'soledad'
    ? (db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock
    : (db.prepare('select unidades from existencia_tienda where producto_id = ? and tienda = ?').get(id, de) as { unidades: number } | undefined)?.unidades ?? 0;
  /** Soledad + sucursales + en bultos + apartadas: lo que cada operación de este PR debe conservar. */
  const total = (id: string) => unidades(id, 'soledad') + unidades(id, 'salk') + unidades(id, 'romero')
    + (db.prepare(`select coalesce(sum(l.cantidad), 0) as n from bulto_lineas l join bultos b on b.id = l.bulto_id
        where l.producto_id = ? and l.quitada_en is null and b.estado in ('abierto', 'cerrado')`).get(id) as { n: number }).n
    + (db.prepare(`select coalesce(sum(l.cantidad), 0) as n from pedido_lineas l join pedidos p on p.id = l.pedido_id
        where l.producto_id = ? and p.estado = 'apartado'`).get(id) as { n: number }).n;
  const avisos = async (quien: Awaited<ReturnType<typeof terminal>> | typeof dueno) => (await quien('/api/avisos', undefined, 'GET')).cuerpo as Record<string, any[]>;
  const marcar = (quien: Awaited<ReturnType<typeof terminal>> | typeof dueno, folio: number, productoId: string, accion: string) =>
    quien(`/api/avisos/pedidos/${folio}/${productoId}/${accion}`, {});
  const linea = (folio: number, productoId: string) => db.prepare(
    'select l.* from pedido_lineas l join pedidos p on p.id = l.pedido_id where p.folio = ? and l.producto_id = ?').get(folio, productoId) as Record<string, any>;
  const pedido = (folio: number) => db.prepare('select * from pedidos where folio = ?').get(folio) as Record<string, any>;
  const venta = (quien: Awaited<ReturnType<typeof terminal>>, productoId: string, pedidoId: string, anticipo: number, caja: string, precio = 25000) =>
    quien('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: productoId, cantidad: 1 }], forma_pago: 'efectivo',
      efectivo: precio - anticipo, caja, pedido_id: pedidoId, anticipo });
  return { ...t, como, terminal, dueno, pieza, portal, unidades, total, avisos, marcar, linea, pedido, venta };
}

/** Ambas solicitudes llegan al batch con lecturas previas: la segunda debe perder dentro del SQL. */
function juntarDosBatches(env: Env) {
  const batch = env.DB.batch.bind(env.DB);
  let llegaron = 0;
  let liberar!: () => void;
  const juntas = new Promise<void>((r) => { liberar = r; });
  env.DB.batch = (async (sentencias: D1PreparedStatement[]) => {
    if (++llegaron === 2) liberar();
    await juntas;
    return batch(sentencias);
  }) as typeof env.DB.batch;
}

test('elegirOrigen: una sola tienda con todas las unidades; prefiere donde se recoge, luego Soledad, luego la que más tiene', () => {
  assert.equal(elegirOrigen({ soledad: 1, salk: 1, romero: 1 }, 1, 'romero'), 'romero');
  assert.equal(elegirOrigen({ soledad: 1, salk: 1, romero: 0 }, 1, 'romero'), 'soledad');
  assert.equal(elegirOrigen({ soledad: 0, salk: 1, romero: 3 }, 1, 'soledad'), 'romero');
  assert.equal(elegirOrigen({ soledad: 1, salk: 1, romero: 1 }, 2, 'soledad'), null, 'ninguna tienda sola alcanza');
  assert.equal(elegirOrigen({ soledad: 0, salk: 2, romero: 0 }, 2, 'romero'), 'salk');
});

test('apartar desde el portal una pieza que solo está en Salk: baja Salk, no Soledad; aparece por separar en Salk y no en Romero', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const antes = m.total(a.id);
  const r = await m.portal(a.codigo);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(m.unidades(a.id, 'salk'), 0);
  assert.equal(m.unidades(a.id, 'soledad'), 0);
  assert.equal(m.total(a.id), antes, 'Soledad + sucursales + bultos + apartadas se conserva');
  const l = m.linea(1, a.id);
  assert.deepEqual([l.tienda, l.separada_en], ['salk', null]);
  assert.equal(r.cuerpo.pedido.recoge_en_nombre, 'Soledad');
  assert.deepEqual(r.cuerpo.pedido.lineas.map((x: any) => [x.tienda_nombre, x.lista]), [['Avenida Salk', false]]);
  const salk = await m.terminal(PC_SALK), romero = await m.terminal(PC_ROMERO), soledad = await m.terminal(PC_SOLEDAD);
  const deSalk = await m.avisos(salk);
  assert.deepEqual(deSalk.por_separar.map((x) => [x.folio, x.codigo, x.canal, x.recoge_en]), [[1, a.codigo, 'Portal', 'soledad']]);
  assert.deepEqual([(await m.avisos(romero)).por_separar, (await m.avisos(soledad)).por_separar], [[], []]);
  assert.equal((await m.avisos(m.dueno)).por_separar.length, 1, 'el dueño ve las de todas las tiendas');
  // Un reintento del mismo apartado no baja otra unidad.
  assert.equal((await m.portal(a.codigo, { id: r.id })).status, 200);
  assert.equal(m.total(a.id), antes);
});

test('cancelar o vencer ese apartado devuelve la unidad a Salk una sola vez; ya separada, aparece por regresar al piso', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1), b = m.pieza(25000, 0, 1);
  const salk = await m.terminal(PC_SALK);
  assert.equal((await m.portal(a.codigo)).status, 201);                       // folio 1: se cancela
  assert.equal((await m.portal(b.codigo, {}, OTRA_SOCIA)).status, 201);       // folio 2: vence
  assert.equal((await m.marcar(salk, 1, a.id, 'separar')).status, 200);
  assert.equal((await m.marcar(salk, 2, b.id, 'separar')).status, 200);
  const cancelar = () => cancelarDeSocio(1, m.env, m.ctx as never, SOCIA.telefono);
  assert.equal((await cancelar()).status, 200);
  assert.equal((await cancelar()).status, 409, 'la segunda cancelación no devuelve otra unidad');
  assert.equal(m.unidades(a.id, 'salk'), 1);
  assert.equal(m.unidades(a.id, 'soledad'), 0);
  const tarde = new Date(Date.now() + (HORAS_PORTAL + 1) * 3_600_000);
  assert.equal(await vencerPedidos(m.env, tarde), 1);
  assert.equal(await vencerPedidos(m.env, tarde), 0, 'el cron no devuelve dos veces');
  assert.equal(m.unidades(b.id, 'salk'), 1);
  assert.deepEqual((await m.avisos(salk)).por_regresar.map((x) => x.folio).sort(), [1, 2]);
  assert.equal((await m.marcar(salk, 1, a.id, 'regreso')).status, 200);
  assert.equal((await m.marcar(salk, 1, a.id, 'regreso')).status, 409, 'dos toques cuentan uno');
  assert.deepEqual((await m.avisos(salk)).por_regresar.map((x) => x.folio), [2]);
  assert.equal(m.total(a.id) + m.total(b.id), 2);
});

test('una pieza que nunca se separó no aparece por regresar; cancelar crea la fila de una tienda que ya no la tenía', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  assert.equal((await m.portal(a.codigo)).status, 201);
  m.db.prepare('delete from existencia_tienda where producto_id = ?').run(a.id);   // la fila se borró a mano: devolver la recrea
  assert.equal((await cancelarDeSocio(1, m.env, m.ctx as never, SOCIA.telefono)).status, 200);
  assert.equal(m.unidades(a.id, 'salk'), 1);
  const salk = await m.terminal(PC_SALK);
  assert.deepEqual((await m.avisos(salk)).por_regresar, []);
});

test('recoger en Romero una pieza de Salk: sin dinero no se manda; con abono sí; tras mandarla y recibirla se cobra solo en Romero', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const salk = await m.terminal(PC_SALK), romero = await m.terminal(PC_ROMERO), soledad = await m.terminal(PC_SOLEDAD);
  const r = await m.portal(a.codigo, { recoge_en: 'romero' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.pedido.recoge_en_nombre, 'Coronel Romero');
  assert.equal(m.pedido(1).recoge_en, 'romero');
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 409, 'antes de separarla no se manda');
  assert.equal((await m.marcar(salk, 1, a.id, 'separar')).status, 200);
  assert.deepEqual((await m.avisos(salk)).por_mandar, [], 'sin dinero no viaja');
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 409);
  // El abono lo recibe la caja de Romero; el pedido del portal no tenía anticipo.
  const abono = await romero('/api/pedidos/1/abonos', { id: crypto.randomUUID(), importe: 10000, forma_pago: 'efectivo', caja: 'Romero 1' });
  assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
  assert.equal(m.db.prepare("select caja from pedido_movimientos where tipo = 'abono'").get()!.caja, 'Romero 1');
  const mandar = (await m.avisos(salk)).por_mandar;
  assert.deepEqual(mandar.map((x) => [x.folio, x.recoge_en_nombre]), [[1, 'Coronel Romero']]);
  assert.equal((await m.marcar(romero, 1, a.id, 'mandar')).status, 409, 'Romero no es dueño de la pieza: solo Salk la manda');
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 200);
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 409, 'dos toques cuentan uno');
  assert.deepEqual([m.linea(1, a.id).tienda, m.linea(1, a.id).enviada_desde], ['romero', 'salk']);
  assert.deepEqual([(await m.avisos(salk)).por_mandar, (await m.avisos(salk)).por_llegar], [[], []]);
  assert.deepEqual((await m.avisos(romero)).por_llegar.map((x) => [x.folio, x.desde_nombre]), [[1, 'Avenida Salk']]);
  // Todavía no llega: ninguna caja puede cobrarla.
  for (const [caja, quien] of [['Salk 1', salk], ['Caja 1', soledad]] as const) {
    const r409 = await m.venta(quien, a.id, m.pedido(1).id as string, 10000, caja);
    assert.equal(r409.status, 409, JSON.stringify(r409.cuerpo));
    assert.match(r409.cuerpo.error, /se recoge en Coronel Romero/);
  }
  const temprano = await m.venta(romero, a.id, m.pedido(1).id as string, 10000, 'Romero 1');
  assert.equal(temprano.status, 409);
  assert.match(temprano.cuerpo.error, /Todavía falta .*viene de Avenida Salk/);
  assert.equal((await m.marcar(salk, 1, a.id, 'llego')).status, 409, 'solo el destino marca que llegó');
  assert.equal((await m.marcar(romero, 1, a.id, 'llego')).status, 200);
  assert.equal((await m.marcar(romero, 1, a.id, 'llego')).status, 409);
  assert.deepEqual((await m.avisos(romero)).por_llegar, []);
  const antes = m.total(a.id);
  const vendida = await m.venta(romero, a.id, m.pedido(1).id as string, 10000, 'Romero 1');
  assert.equal(vendida.status, 201, JSON.stringify(vendida.cuerpo));
  assert.equal(m.db.prepare('select tienda, caja from ventas').get()!.tienda, 'romero');
  assert.deepEqual([m.unidades(a.id, 'soledad'), m.unidades(a.id, 'salk'), m.unidades(a.id, 'romero')], [0, 0, 0]);
  assert.equal(m.pedido(1).estado, 'vendido');
  assert.equal(antes - m.total(a.id), 1, 'la venta se lleva la única unidad');
});

test('cancelar con la pieza ya enviada la regresa a la existencia de Romero; al llegar queda por regresar al piso', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const salk = await m.terminal(PC_SALK), romero = await m.terminal(PC_ROMERO), soledad = await m.terminal(PC_SOLEDAD);
  assert.equal((await m.portal(a.codigo, { recoge_en: 'romero' })).status, 201);
  assert.equal((await m.marcar(salk, 1, a.id, 'separar')).status, 200);
  assert.equal((await romero('/api/pedidos/1/abonos', { id: crypto.randomUUID(), importe: 10000, forma_pago: 'efectivo', caja: 'Romero 1' })).status, 200);
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 200);
  const cancelar = await soledad('/api/pedidos/1/cancelar', {});
  assert.equal(cancelar.status, 200, JSON.stringify(cancelar.cuerpo));
  assert.deepEqual([m.unidades(a.id, 'salk'), m.unidades(a.id, 'romero'), m.unidades(a.id, 'soledad')], [0, 1, 0]);
  assert.equal((await soledad('/api/pedidos/1/cancelar', {})).status, 409);
  assert.deepEqual([m.unidades(a.id, 'salk'), m.unidades(a.id, 'romero')], [0, 1], 'la segunda cancelación no suma otra');
  assert.equal((await m.avisos(romero)).por_llegar.length, 1, 'la pieza sigue en camino aunque se canceló');
  assert.deepEqual((await m.avisos(romero)).por_regresar, []);
  assert.equal((await m.marcar(romero, 1, a.id, 'llego')).status, 200);
  assert.deepEqual((await m.avisos(romero)).por_regresar.map((x) => x.folio), [1]);
  assert.equal((await m.marcar(romero, 1, a.id, 'regreso')).status, 200);
});

test('dos apartados a la vez por la última unidad de una sucursal: gana uno y la existencia nunca queda negativa', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  juntarDosBatches(m.env);
  const [x, y] = await Promise.all([m.portal(a.codigo), m.portal(a.codigo, {}, OTRA_SOCIA)]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409], JSON.stringify([x.cuerpo, y.cuerpo]));
  assert.equal(m.unidades(a.id, 'salk'), 0);
  assert.equal((m.db.prepare('select count(*) as n from pedidos').get() as { n: number }).n, 1, 'el pedido perdedor no dejó nada');
  assert.equal(m.total(a.id), 1);
});

test('una terminal de Salk levanta un pedido con anticipo: entra a una caja de Salk, su corte lo cuenta y la pieza nace separada', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const salk = await m.terminal(PC_SALK);
  const r = await salk('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: a.id, cantidad: 1 }], cliente: 'Cliente Prueba',
    telefono: '4441234567', entrega: 'tienda', anticipo: 10000, forma_pago: 'efectivo', caja: 'Salk 1', recoge_en: 'salk' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual([m.pedido(1).caja, m.pedido(1).recoge_en], ['Salk 1', 'salk']);
  assert.notEqual(m.linea(1, a.id).separada_en, null, 'quien lo levanta tiene la pieza a la mano');
  assert.deepEqual((await m.avisos(salk)).por_separar, []);
  assert.equal(m.unidades(a.id, 'salk'), 0);
  assert.equal((await salk('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: a.id, cantidad: 1 }], cliente: 'Otro', telefono: '4441234567',
    entrega: 'tienda', anticipo: 10000, forma_pago: 'efectivo', caja: 'Caja 1' })).status, 400, 'una caja de otra tienda no es válida');
  const corte = await salk('/api/cortes', { id: crypto.randomUUID(), caja: 'Salk 1', efectivo_contado: 60000, tarjeta_terminal: 0 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.efectivo_ventas, 10000);
  assert.equal(corte.cuerpo.diferencia, 0);
  // Recoger ahí mismo: la pieza ya está en la tienda donde se recoge.
  const vendida = await m.venta(salk, a.id, m.pedido(1).id as string, 10000, 'Salk 1');
  assert.equal(vendida.status, 201, JSON.stringify(vendida.cuerpo));
  assert.equal(m.db.prepare('select tienda from ventas').get()!.tienda, 'salk');
  assert.equal(m.unidades(a.id, 'salk'), 0);
});

test('reportes: el anticipo recibido en una caja de Salk cuenta en tienda=salk y no en tienda=soledad; el total no cambia', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1), b = m.pieza(25000, 2);
  const salk = await m.terminal(PC_SALK), soledad = await m.terminal(PC_SOLEDAD);
  const pedir = (quien: typeof salk, pieza: { id: string }, caja: string, anticipo: number) => quien('/api/pedidos', {
    id: crypto.randomUUID(), lineas: [{ producto_id: pieza.id, cantidad: 1 }], cliente: 'Cliente Prueba', telefono: '4441234567', entrega: 'tienda',
    anticipo, forma_pago: 'efectivo', caja });
  assert.equal((await pedir(salk, a, 'Salk 1', 10000)).status, 201);
  assert.equal((await pedir(soledad, b, 'Caja 1', 12000)).status, 201);
  const efectivo = async (filtro: string) => ((await m.dueno(`/api/reportes?dias=7${filtro}`, undefined, 'GET')).cuerpo.por_forma_pago as { forma_pago: string; total: number }[])
    .find((f) => f.forma_pago === 'efectivo')?.total ?? 0;
  assert.equal(await efectivo(''), 22000);
  assert.equal(await efectivo('&tienda=salk'), 10000);
  assert.equal(await efectivo('&tienda=soledad'), 12000);
  assert.equal(await efectivo('&tienda=romero'), 0);
});

test('envío con una pieza de sucursal: sale de Soledad, la sucursal recibe «por mandar» y el paquete no está listo hasta que llega', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const salk = await m.terminal(PC_SALK), soledad = await m.terminal(PC_SOLEDAD);
  const r = await soledad('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: a.id, cantidad: 1 }], cliente: 'Cliente Prueba',
    telefono: '4441234567', entrega: 'envio', anticipo: 10000, forma_pago: 'efectivo', caja: 'Caja 1', recoge_en: 'romero' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(m.pedido(1).recoge_en, 'soledad', 'un envío siempre sale de la tienda que envía');
  assert.equal(r.cuerpo.pedido.lista_para_entregar, false);
  assert.equal((await m.avisos(salk)).por_separar.length, 1);
  assert.equal((await m.marcar(salk, 1, a.id, 'separar')).status, 200);
  assert.deepEqual((await m.avisos(salk)).por_mandar.map((x) => [x.folio, x.recoge_en_nombre]), [[1, 'Soledad']]);
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 200);
  assert.equal(((await soledad('/api/pedidos/1', undefined, 'GET')).cuerpo.pedido.lista_para_entregar), false);
  assert.equal((await m.marcar(soledad, 1, a.id, 'llego')).status, 200);
  assert.equal(((await soledad('/api/pedidos/1', undefined, 'GET')).cuerpo.pedido.lista_para_entregar), true);
});

test('agregar una pieza de sucursal a un paquete: sale de esa sucursal y avisa a su tienda; otra unidad sale de la misma', async () => {
  const m = montar();
  const a = m.pieza(25000, 5), b = m.pieza(25000, 0, 2);
  const salk = await m.terminal(PC_SALK), soledad = await m.terminal(PC_SOLEDAD);
  const r = await soledad('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: a.id, cantidad: 1 }], cliente: 'Cliente Prueba',
    telefono: '4441234567', entrega: 'envio', anticipo: 10000, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(m.linea(1, a.id).separada_en !== null, true);
  const antes = m.total(b.id);
  assert.equal((await soledad('/api/pedidos/1/piezas', { id: crypto.randomUUID(), producto_id: b.id, cantidad: 1 })).status, 200);
  assert.deepEqual([m.unidades(b.id, 'salk'), m.unidades(b.id, 'soledad'), m.linea(1, b.id).tienda], [1, 0, 'salk']);
  assert.equal((await soledad('/api/pedidos/1/piezas', { id: crypto.randomUUID(), producto_id: b.id, cantidad: 1 })).status, 200);
  assert.deepEqual([m.unidades(b.id, 'salk'), m.linea(1, b.id).cantidad], [0, 2]);
  assert.equal((await soledad('/api/pedidos/1/piezas', { id: crypto.randomUUID(), producto_id: b.id, cantidad: 1 })).status, 409, 'ya no queda');
  assert.equal(m.total(b.id), antes);
  assert.deepEqual((await m.avisos(salk)).por_separar.map((x) => [x.folio, x.cantidad]), [[1, 2]]);
});

test('cancelar un apartado con piezas de dos tiendas devuelve cada renglón a la suya', async () => {
  const m = montar();
  const a = m.pieza(25000, 1), b = m.pieza(25000, 0, 0, 1);
  const r = await m.portal(a.codigo);
  assert.equal(r.status, 201);
  const soledad = await m.terminal(PC_SOLEDAD);
  assert.equal((await soledad('/api/pedidos/1/piezas', { id: crypto.randomUUID(), producto_id: b.id, cantidad: 1 })).status, 409, 'un apartado de tienda no recibe piezas');
  // Un pedido de dos renglones levantado en Soledad (anticipo) con una pieza en Romero.
  const dos = await soledad('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: m.pieza(25000, 1).id, cantidad: 1 }, { producto_id: b.id, cantidad: 1 }],
    cliente: 'Cliente Prueba', telefono: '4441234567', entrega: 'tienda', anticipo: 10000, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(dos.status, 201, JSON.stringify(dos.cuerpo));
  assert.equal(m.unidades(b.id, 'romero'), 0);
  assert.equal((await soledad('/api/pedidos/2/cancelar', {})).status, 200);
  assert.equal(m.unidades(b.id, 'romero'), 1);
  assert.equal(m.unidades(b.id, 'soledad'), 0, 'la de Romero no se devuelve a Soledad');
  assert.equal(m.db.prepare('select sum(stock) as n from productos where id != ?').get(b.id)!.n > 0, true);
});

test('en línea (VENDIBLE) cuenta Soledad y sucursales; Mercado Libre (PUBLICABLE) sigue con solo Soledad; un bulto no se ofrece', async () => {
  const m = montar();
  const soloSalk = m.pieza(25000, 0, 1), soloSoledad = m.pieza(25000, 1), enBulto = m.pieza(25000, 0, 0);
  const cuenta = (condicion: string, id: string) => (m.db.prepare(`select count(*) as n from productos p where ${condicion} and p.id = ?`).get(id) as { n: number }).n;
  assert.deepEqual([cuenta(VENDIBLE, soloSalk.id), cuenta(PUBLICABLE, soloSalk.id)], [1, 0], 'solo en Salk: en línea sí, Mercado Libre no');
  assert.deepEqual([cuenta(VENDIBLE, soloSoledad.id), cuenta(PUBLICABLE, soloSoledad.id)], [1, 1]);
  // Una pieza cuya única unidad va en un bulto cerrado no la puede separar nadie.
  m.db.prepare('update productos set stock = 1 where id = ?').run(enBulto.id);
  const capturista = 'cap@prueba.mx';
  m.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, 'Cap', 'capturista', 1, '', '')").run(capturista);
  m.como(capturista);
  const bulto = await m.pedir('/api/bultos', { id: crypto.randomUUID(), destino: 'salk' });
  assert.equal(bulto.status, 201, JSON.stringify(bulto.cuerpo));
  assert.equal((await m.pedir(`/api/bultos/${bulto.cuerpo.folio}/piezas`, { id: crypto.randomUUID(), codigo: enBulto.codigo })).status, 201);
  assert.deepEqual([cuenta(VENDIBLE, enBulto.id), cuenta(PUBLICABLE, enBulto.id)], [0, 0]);
  await m.esperar();
  // El portal tampoco la deja apartar.
  assert.equal((await m.portal(enBulto.codigo)).status, 409);
  assert.equal((await m.portal(soloSalk.codigo)).status, 201);
});

test('/vender y el catálogo dicen en qué tienda está la pieza, nunca cuántas hay; con una sola unidad en sucursal es la última', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1), b = m.pieza(25000, 2, 3);
  const lista = (await m.dueno('/api/vender', undefined, 'GET')).cuerpo.piezas as Record<string, any>[];
  assert.deepEqual(lista.find((p) => p.codigo === a.codigo)!.tiendas, ['Avenida Salk']);
  assert.deepEqual(lista.find((p) => p.codigo === b.codigo)!.tiendas, ['Soledad', 'Avenida Salk']);
  for (const p of lista) for (const clave of ['stock', 'unidades', 'a_la_venta', 'en_soledad', 'sucursales']) assert.equal(clave in p, false, clave);
  m.env.HOST_PORTAL = 'dolarones.prueba';
  const publico = async (codigo: string) => (await (await worker.fetch!(new Request(`https://dolarones.prueba/api/catalogo?codigo=${codigo}`) as never, m.env, m.ctx as never)).json()) as Record<string, any>;
  const pa = (await publico(a.codigo)).piezas[0], pb = (await publico(b.codigo)).piezas[0];
  assert.deepEqual([pa.tiendas, pa.ultima, pb.tiendas, pb.ultima], [['Avenida Salk'], true, ['Soledad', 'Avenida Salk'], false]);
  assert.equal(JSON.stringify([pa, pb]).includes('"stock"'), false);
});

test('quien no es dueño no marca avisos de otra tienda; el dueño sí; una pieza inexistente es 404', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const romero = await m.terminal(PC_ROMERO);
  assert.equal((await m.portal(a.codigo)).status, 201);
  assert.equal((await m.marcar(romero, 1, a.id, 'separar')).status, 409);
  assert.equal(m.linea(1, a.id).separada_en, null);
  assert.equal((await m.marcar(romero, 99, a.id, 'separar')).status, 404);
  const dueno = await m.marcar(m.dueno, 1, a.id, 'separar');
  assert.equal(dueno.status, 200);
  assert.equal(m.linea(1, a.id).separada_por, DUENO);
});

test('«Ya la mandé» cambia la revisión del pedido: un cobro que ya la había leído en la tienda aborta', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const salk = await m.terminal(PC_SALK), romero = await m.terminal(PC_ROMERO);
  assert.equal((await m.portal(a.codigo, { recoge_en: 'romero' })).status, 201);
  await m.marcar(salk, 1, a.id, 'separar');
  assert.equal((await romero('/api/pedidos/1/abonos', { id: crypto.randomUUID(), importe: 10000, forma_pago: 'efectivo', caja: 'Romero 1' })).status, 200);
  const antes = m.pedido(1).revision;
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 200);
  assert.equal(m.pedido(1).revision, antes + 1);
});

test('push: llega a las cuentas de esa tienda con notificaciones y a los dueños, no a las de otra tienda', async () => {
  const m = montar();
  const llaves = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  m.env.VAPID_JWK = JSON.stringify(await crypto.subtle.exportKey('jwk', llaves.privateKey));
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const keys = {
    p256dh: Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey) as ArrayBuffer).toString('base64url'),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
  const llegadas: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => { llegadas.push(url); return new Response('', { status: 201 }); }) as typeof fetch;
  try {
    // La suscripción queda a nombre de la cuenta de Access de la terminal (no del cajero que escribió su PIN).
    const salk = await m.terminal(PC_SALK), romero = await m.terminal(PC_ROMERO);
    assert.equal((await salk('/api/push/suscripcion', { endpoint: 'https://push.prueba/salk', keys })).status, 200);
    assert.equal((await romero('/api/push/suscripcion', { endpoint: 'https://push.prueba/romero', keys })).status, 200);
    assert.equal((await m.dueno('/api/push/suscripcion', { endpoint: 'https://push.prueba/dueno', keys })).status, 200);
    assert.deepEqual(m.db.prepare('select endpoint, correo from push_suscripciones order by endpoint').all().map((f) => [f.endpoint, f.correo]),
      [['https://push.prueba/dueno', DUENO], ['https://push.prueba/romero', PC_ROMERO], ['https://push.prueba/salk', PC_SALK]]);
    llegadas.length = 0;
    await avisarTiendas(m.env, [{ tienda: 'salk', titulo: 'Pieza por separar', cuerpo: 'Separa una pieza del pedido P-1.' }]);
    assert.deepEqual(llegadas.sort(), ['https://push.prueba/dueno', 'https://push.prueba/salk']);
    // Un apartado del portal avisa por push a la tienda de origen (y solo a esa).
    llegadas.length = 0;
    const a = m.pieza(25000, 0, 1);
    assert.equal((await m.portal(a.codigo)).status, 201);
    await m.esperar();
    assert.deepEqual(llegadas.sort(), ['https://push.prueba/dueno', 'https://push.prueba/salk']);
  } finally { globalThis.fetch = original; }
});

test('el mostrador de la propia tienda no recibe aviso: un pedido de Salk con pieza de Salk no manda push ni queda por separar', async () => {
  const m = montar();
  const a = m.pieza(25000, 0, 1);
  const salk = await m.terminal(PC_SALK);
  assert.equal((await salk('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: a.id, cantidad: 1 }], cliente: 'Cliente Prueba',
    telefono: '4441234567', entrega: 'tienda', anticipo: 10000, forma_pago: 'efectivo', caja: 'Salk 2', recoge_en: 'romero' })).status, 201);
  assert.deepEqual((await m.avisos(salk)).por_separar, []);
  // Quien lo levanta ya la tiene a la mano: solo falta mandarla (el anticipo ya está registrado).
  assert.deepEqual((await m.avisos(salk)).por_mandar.map((x) => [x.folio, x.recoge_en]), [[1, 'romero']]);
});

test('migración 078: base vacía completa; lo apartado hasta hoy queda en Soledad, separado y sin avisos', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('pragma foreign_keys = on; begin');
    const archivos = ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f)).sort()];
    for (const archivo of archivos.filter((f) => !f.startsWith('migracion-078'))) db.exec(readFileSync(archivo, 'utf8'));
    db.exec(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en) values ('p1', 'ED-000900', 'Vieja', 100, 0, 'S40', '', '');
      insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, anticipo, saldo, forma_pago, saldo_vence_en, creado_en, actualizado_en)
        values ('a', 1, 'X', '4441234567', 'tienda', 'portal', 'apartado', 'z', 0, 0, 'transferencia', 'z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
               ('c', 2, 'X', '4441234567', 'tienda', 'portal', 'cancelado', 'z', 0, 0, 'transferencia', 'z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z');
      insert into pedido_lineas (pedido_id, producto_id, cantidad, precio) values ('a', 'p1', 1, 100), ('c', 'p1', 1, 100);`);
    db.exec(readFileSync(archivos.find((f) => f.startsWith('migracion-078'))!, 'utf8'));
    db.exec('commit');
    assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
    const filas = db.prepare('select pedido_id, tienda, separada_en is not null as separada, regresada_en is not null as regresada from pedido_lineas order by pedido_id').all()
      .map((f) => [f.pedido_id, f.tienda, f.separada, f.regresada]);
    assert.deepEqual(filas, [['a', 'soledad', 1, 0], ['c', 'soledad', 1, 1]]);
    assert.equal(db.prepare("select recoge_en from pedidos where id = 'a'").get()!.recoge_en, 'soledad');
  } finally { db.close(); }
});

test('caja (arreglo a #797): el folio de un bulto se reconoce solo si no hay pieza con ese código y tiene la forma exacta del folio', () => {
  const html = readFileSync('public/caja.html', 'utf8');
  const cuerpo = html.slice(html.indexOf('function agregarCodigo'));
  const busca = cuerpo.indexOf('const pieza = buscarPieza(codigo);');
  const bulto = cuerpo.indexOf('es un bulto, no una pieza');
  assert.ok(busca > 0 && bulto > busca, 'primero se busca la pieza, después se piensa en un bulto');
  const patron = /if \(!pieza && (\/\^BU-\[A-HJ-NP-Z2-9\]\{5\}\$\/i)\.test/.exec(cuerpo);
  assert.ok(patron, 'el patrón es el del folio de bultos.ts');
  const re = new RegExp(patron![1].slice(1, -2), 'i');
  assert.equal(re.source, PATRON_FOLIO.source.replace('^BU-', '^BU-'));
  for (const bueno of ['BU-K7Q2M', 'bu-k7q2m']) assert.equal(re.test(bueno), true, bueno);
  for (const malo of ['bufanda', 'BUFANDA', 'BU-K7Q20', 'BUK7Q2M', 'ED-000001']) assert.equal(re.test(malo), false, malo);
  assert.match(cuerpo, /if \(!reintento && navigator\.onLine\) cargarCatalogo\(\)/, 'el reintento tras cargarCatalogo sigue');
});

test('la guía de un envío liquidado no se guarda mientras una pieza siga en una sucursal o en camino', async () => {
  const m = montar();
  const a = m.pieza(5000, 0, 1);
  const salk = await m.terminal(PC_SALK), soledad = await m.terminal(PC_SOLEDAD);
  const r = await soledad('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: a.id, cantidad: 1 }], cliente: 'Cliente Prueba',
    telefono: '4441234567', entrega: 'envio', anticipo: 5000, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const abono = await soledad('/api/pedidos/1/abonos', { id: crypto.randomUUID(), importe: 9900, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
  assert.equal(m.pedido(1).estado, 'vendido');
  // Liquidado, con dinero: la sucursal la separa y la manda; sigue en la lista de «por mandar» aunque el pedido ya sea un ticket.
  const guia = () => soledad('/api/pedidos/1/guia', { guia: 'GUIA-123' }, 'PUT');
  assert.equal((await guia()).status, 409);
  assert.equal((await m.marcar(salk, 1, a.id, 'separar')).status, 200);
  assert.equal((await m.avisos(salk)).por_mandar.length, 1);
  assert.equal((await m.marcar(salk, 1, a.id, 'mandar')).status, 200);
  assert.equal((await guia()).status, 409, 'en camino todavía');
  assert.equal((await m.marcar(soledad, 1, a.id, 'llego')).status, 200);
  const lista = await guia();
  assert.equal(lista.status, 200, JSON.stringify(lista.cuerpo));
  assert.deepEqual([(await m.avisos(salk)).por_mandar, (await m.avisos(soledad)).por_llegar], [[], []]);
});
