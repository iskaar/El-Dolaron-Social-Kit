// node --test src/pagos-reportados.test.ts
// Pago reportado por la revendedora (#609): foto y/o clave de rastreo desde «Mis ventas»; la tienda lo acepta con el abono
// de siempre o lo rechaza. SQLite real con todas las migraciones, detras del fetch del Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.ts';
import { tienda, DUENO, datosTransferencia } from './prueba-d1.ts';
import { permiso, puede, type Rol } from './cuentas.ts';
import { vencerPedidos } from './pedidos.ts';
import { estadoMia, agruparMias } from '../public/vender.js';

const ANA = 'ana@revende.mx';
const BETY = 'bety@revende.mx';
const CAJERO = 'caja@prueba.mx';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

let consecutivo = 8000;
function pieza(db: DatabaseSync) {
  const id = crypto.randomUUID();
  const fila = { id, codigo: `ED-${String(++consecutivo).padStart(6, '0')}`, nombre: 'Blusa de algodón', categoria: 'ropa', talla: 'M',
    marca: 'Target', precio: 20000, precio_lista: 30000, estado_analisis: 'listo', estado_fisico: 'nuevo', stock: 1, sin_inventario: 0,
    destino: 'etiqueta', foto_key: `fotos/${id}.jpg`, propietario: 'dolaron', semana_ingreso: 'S43',
    creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString() };
  db.prepare(`insert into productos (${Object.keys(fila).join(',')}) values (${Object.keys(fila).map(() => '?').join(',')})`).run(...Object.values(fila) as never[]);
  return fila;
}
const cuenta = (db: DatabaseSync, correo: string, roles: string, nombre = correo.split('@')[0]) =>
  db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')").run(correo, nombre, roles);
const comoUsuario = (env: Env, correo: string) => { (env as unknown as Record<string, string>).DEV_USUARIO = correo; };
const fila = (db: DatabaseSync, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args as never[]) as Record<string, any>;
const stockDe = (db: DatabaseSync, id: string) => (db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;

type Tienda = ReturnType<typeof tienda>;
const mundo = () => {
  const t = tienda();
  cuenta(t.db, ANA, 'revendedora', 'Ana R.');
  cuenta(t.db, BETY, 'revendedora', 'Bety R.');
  cuenta(t.db, CAJERO, 'cajero', 'Marta');
  return t;
};
/** Apartado de la revendedora actual: { folio, id (pedido), pieza }. */
async function apartado(t: Tienda, entrega = 'tienda') {
  const p = pieza(t.db);
  const r = await t.pedir('/api/vender/apartar', { id: crypto.randomUUID(), lineas: [{ producto_id: p.id, cantidad: 1 }], cliente: 'Carla Cliente', telefono: '4441234567', entrega });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return { folio: r.cuerpo.pedido.folio as number, id: r.cuerpo.pedido.id as string, pieza: p };
}
const clave = () => datosTransferencia(0).clave_rastreo;
const reportar = (t: Tienda, folio: number, cuerpo: Record<string, unknown> = {}) =>
  t.pedir(`/api/vender/apartados/${folio}/pago`, { id: crypto.randomUUID(), clave_rastreo: clave(), ...cuerpo });
const subirFoto = async (t: Tienda, folio: number, cuerpo: BodyInit = JPEG, tipo = 'image/jpeg') => {
  const r = await worker.fetch!(new Request(`https://caja.prueba/api/vender/apartados/${folio}/comprobante`, { method: 'POST', headers: { 'content-type': tipo }, body: cuerpo }) as never, t.env, t.ctx as never);
  return { status: r.status, cuerpo: (await r.json().catch(() => ({}))) as Record<string, any> };
};
const mios = async (t: Tienda) => (await t.pedir('/api/vender/mios', undefined, 'GET')).cuerpo.pedidos as Record<string, any>[];
const reportes = (db: DatabaseSync) => db.prepare('select * from pagos_reportados order by id').all() as Record<string, any>[];

test('la migracion 063 queda completa en una base vacia: al menos clave o foto, clave en mayusculas, un pendiente por pedido', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const base = (extra: string) => t.db.prepare(`insert into pagos_reportados (pedido_id, solicitud_id, reportado_por, reportado_en ${extra.split('|')[0]}) values (?, ?, 'x', 'y' ${extra.split('|')[1]})`);
  assert.throws(() => base('|').run(a.id, crypto.randomUUID()), /CHECK constraint failed/);
  assert.throws(() => base(', clave_rastreo|, \'abcdef12\'').run(a.id, crypto.randomUUID()), /CHECK constraint failed/);
  base(', clave_rastreo|, \'ABCDEF12\'').run(a.id, crypto.randomUUID());
  assert.throws(() => base(', clave_rastreo|, \'ABCDEF13\'').run(a.id, crypto.randomUUID()), /UNIQUE constraint failed/);
  t.db.close();
});

test('reportar: queda pendiente, no marca el pedido pagado, la clave se normaliza y el dueno recibe un aviso sin clave ni cliente', async () => {
  const t = mundo();
  const enviados: { subject: string; text: string }[] = [];
  (t.env as any).CORREO = { send: async (m: any) => { enviados.push(m); } };
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const r = await reportar(t, a.folio, { clave_rastreo: ' ejemplo 123456 ', monto: 20000, banco_emisor: '40012' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.reporte.estado, r.cuerpo.reporte.motivo], ['pendiente', '']);
  const f = reportes(t.db);
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].clave_rastreo, f[0].monto, f[0].banco_emisor, f[0].reportado_por], ['EJEMPLO123456', 20000, '40012', ANA]);
  // no es dinero: ni saldo, ni movimientos, ni transferencia, ni existencia devuelta
  assert.deepEqual({ ...fila(t.db, 'select saldo, estado from pedidos where id = ?', a.id) }, { saldo: 0, estado: 'apartado' });
  assert.equal((t.db.prepare('select count(*) as n from transferencias_spei').get() as any).n, 0);
  assert.equal((t.db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 0);
  await t.esperar();
  assert.equal(enviados.length, 1);
  assert.match(enviados[0].text, new RegExp(`Ana R\\. mandó el pago de P-${a.folio}\\.`));
  assert.match(enviados[0].text, /\/pedidos/);
  for (const secreto of ['EJEMPLO123456', 'Carla', '4441234567']) assert.ok(!enviados[0].text.includes(secreto) && !enviados[0].subject.includes(secreto), secreto);
  t.db.close();
});

test('solo SU apartado: otra revendedora recibe 404 al reportar y al subir foto; uno ya pagado o cancelado se rechaza', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  comoUsuario(t.env, BETY);
  assert.equal((await reportar(t, a.folio)).status, 404);
  assert.equal((await subirFoto(t, a.folio)).status, 404);
  assert.equal((await reportar(t, 99999)).status, 404);
  assert.equal(reportes(t.db).length, 0);
  assert.equal((await t.pedir(`/api/vender/apartados/${a.folio}/pago`, undefined, 'GET')).status, 405);
  // con dinero ya registrado ya no se manda nada
  comoUsuario(t.env, ANA);
  t.db.prepare('update pedidos set saldo = 5000 where id = ?').run(a.id);
  assert.equal((await reportar(t, a.folio)).status, 409);
  t.db.prepare("update pedidos set saldo = 0, estado = 'cancelado' where id = ?").run(a.id);
  assert.equal((await reportar(t, a.folio)).status, 409);
  assert.equal((await subirFoto(t, a.folio)).status, 409);
  assert.equal(reportes(t.db).length, 0);
  t.db.close();
});

test('el personal de la tienda no reporta pagos: dueno y cajero reciben 403 aunque el apartado exista', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  for (const quien of [DUENO, CAJERO]) {
    comoUsuario(t.env, quien);
    assert.equal((await reportar(t, a.folio)).status, 403, quien);
    assert.equal((await subirFoto(t, a.folio)).status, 403, quien);
  }
  assert.equal(reportes(t.db).length, 0);
  const regla = (ruta: string) => permiso(ruta, 'POST');
  const cuentaDe = (...roles: Rol[]) => ({ correo: 'x@prueba.mx', nombre: '', caja: '', activo: true, editar_inventario: false, roles });
  for (const ruta of ['/api/vender/apartados/7/pago', '/api/vender/apartados/7/comprobante']) {
    assert.equal(puede(cuentaDe('revendedora'), regla(ruta)), true, ruta);
    assert.equal(puede(cuentaDe('capturista'), regla(ruta)), false, ruta);
  }
  // la foto que sube la revendedora no se ve desde ninguna ruta suya ni de la caja: solo el dueno (por omision)
  assert.equal(puede(cuentaDe('revendedora'), permiso('/api/pagos-reportados/3/comprobante', 'GET')), false);
  assert.equal(puede(cuentaDe('cajero'), permiso('/api/pagos-reportados/3/comprobante', 'GET')), false);
  assert.equal(puede(cuentaDe('dueno'), permiso('/api/pagos-reportados/3/comprobante', 'GET')), true);
  t.db.close();
});

test('al menos foto o clave; una clave con formato invalido, banco o monto raros y una foto ajena se rechazan', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const vacio = await t.pedir(`/api/vender/apartados/${a.folio}/pago`, { id: crypto.randomUUID() });
  assert.deepEqual([vacio.status, vacio.cuerpo.campo], [400, 'clave']);
  assert.equal((await reportar(t, a.folio, { clave_rastreo: '' })).status, 400);
  assert.equal((await reportar(t, a.folio, { clave_rastreo: 'ñandú-1' })).cuerpo.campo, 'clave');
  assert.equal((await reportar(t, a.folio, { clave_rastreo: 'AB' })).status, 400);
  assert.equal((await reportar(t, a.folio, { banco_emisor: '11111' })).cuerpo.campo, 'banco');
  for (const monto of [-5, 0, 10.5, 'mucho']) assert.equal((await reportar(t, a.folio, { monto })).cuerpo.campo, 'monto', String(monto));
  assert.equal((await t.pedir(`/api/vender/apartados/${a.folio}/pago`, { id: 'no-es-uuid', clave_rastreo: clave() })).status, 400);
  // una foto que nunca se subio para esta venta (aunque tenga forma valida)
  const inventada = `comprobantes/${crypto.randomUUID()}.jpg`;
  const ajena = await reportar(t, a.folio, { clave_rastreo: '', comprobante_key: inventada });
  assert.deepEqual([ajena.status, ajena.cuerpo.campo], [400, 'foto']);
  assert.equal((await reportar(t, a.folio, { comprobante_key: '../fotos/x.jpg' })).cuerpo.campo, 'foto');
  assert.equal(reportes(t.db).length, 0);
  // solo la foto basta
  const subida = await subirFoto(t, a.folio);
  assert.equal(subida.status, 200);
  const ok = await reportar(t, a.folio, { clave_rastreo: '', comprobante_key: subida.cuerpo.key });
  assert.equal(ok.status, 201, JSON.stringify(ok.cuerpo));
  assert.deepEqual([reportes(t.db)[0].clave_rastreo, reportes(t.db)[0].comprobante_key], [null, subida.cuerpo.key]);
  t.db.close();
});

test('una revendedora no puede adjuntar la foto de otra ni la de otra venta suya', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const a2 = await apartado(t);
  const foto = (await subirFoto(t, a.folio)).cuerpo.key;
  comoUsuario(t.env, BETY);
  const b = await apartado(t);
  const robada = await reportar(t, b.folio, { clave_rastreo: '', comprobante_key: foto });
  assert.deepEqual([robada.status, robada.cuerpo.campo], [400, 'foto']);
  comoUsuario(t.env, ANA);
  assert.equal((await reportar(t, a2.folio, { clave_rastreo: '', comprobante_key: foto })).cuerpo.campo, 'foto');
  assert.equal((await reportar(t, a.folio, { clave_rastreo: '', comprobante_key: foto })).status, 201);
  t.db.close();
});

test('clave ya usada: en un pago registrado o en el reporte pendiente de otra venta se rechaza con 409', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const b = await apartado(t);
  // registrada por la tienda en otro pago
  comoUsuario(t.env, CAJERO);
  const dato = datosTransferencia(5000);
  const abono = await t.pedir(`/api/pedidos/${b.folio}/abonos`, { id: crypto.randomUUID(), importe: 5000, forma_pago: 'transferencia', caja: 'Caja 1', ...dato });
  assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
  comoUsuario(t.env, ANA);
  const usada = await reportar(t, a.folio, { clave_rastreo: dato.clave_rastreo.toLowerCase() });
  assert.deepEqual([usada.status, usada.cuerpo.campo], [409, 'clave']);
  assert.match(usada.cuerpo.error, /Esa clave ya se usó en otro pago/);
  assert.ok(!usada.cuerpo.error.includes(`P-${b.folio}`));
  // esperando en el reporte de otra venta
  const c = await apartado(t);
  const k = clave();
  assert.equal((await reportar(t, a.folio, { clave_rastreo: k })).status, 201);
  const repetida = await reportar(t, c.folio, { clave_rastreo: k });
  assert.deepEqual([repetida.status, repetida.cuerpo.campo], [409, 'clave']);
  assert.equal(reportes(t.db).length, 1);
  t.db.close();
});

test('reintento con el mismo id: un solo reporte; otro id con uno pendiente da 409; el id de otro pedido o persona tambien', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const b = await apartado(t);
  const cuerpo = { id: crypto.randomUUID(), clave_rastreo: clave() };
  const primera = await t.pedir(`/api/vender/apartados/${a.folio}/pago`, cuerpo);
  const repetida = await t.pedir(`/api/vender/apartados/${a.folio}/pago`, cuerpo);
  assert.equal(primera.status, 201);
  assert.equal(repetida.status, 200);
  assert.deepEqual(repetida.cuerpo, { reporte: { ...primera.cuerpo.reporte } });
  assert.equal(reportes(t.db).length, 1);
  const segundo = await reportar(t, a.folio);
  assert.equal(segundo.status, 409);
  assert.match(segundo.cuerpo.error, /la tienda lo está revisando/);
  assert.equal((await t.pedir(`/api/vender/apartados/${b.folio}/pago`, cuerpo)).status, 409);
  assert.equal(reportes(t.db).length, 1);
  t.db.close();
});

test('«Mis ventas»: el estado del reporte llega con el pedido, el chip lo dice y no se puede cancelar mientras esta por revisar', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const antes = (await mios(t))[0];
  assert.equal(antes.pago_reportado, null);
  assert.equal(antes.cancelable, true);
  assert.equal(estadoMia(antes, Date.now()).clase, 'aviso');   // «Esperando pago»
  await reportar(t, a.folio);
  const pendiente = (await mios(t))[0];
  assert.equal(pendiente.pago_reportado.estado, 'pendiente');
  assert.equal(pendiente.cancelable, false);
  assert.deepEqual(estadoMia(pendiente, Date.now()), { clase: 'aviso', texto: 'Pago enviado · la tienda lo revisa' });
  // la clave no vuelve a la lista de la revendedora
  assert.ok(!JSON.stringify(pendiente.pago_reportado).includes('clave'));
  const cancelar = await t.pedir(`/api/vender/apartados/${a.folio}/cancelar`, {});
  assert.equal(cancelar.status, 409);
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', a.id).estado, 'apartado');
  assert.equal(stockDe(t.db, a.pieza.id), 0);
  // sigue en «Esperando pago» para agruparla
  assert.equal(agruparMias([pendiente]).esperando.length, 1);
  t.db.close();
});

test('el cron no vence un apartado con pago por revisar; al aceptar o rechazar vuelve a regir', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const b = await apartado(t);
  await reportar(t, a.folio);
  const pasado = new Date(Date.now() - 3_600_000).toISOString();
  t.db.prepare('update pedidos set vence_en = ?').run(pasado);
  assert.equal(await vencerPedidos(t.env), 1);   // solo b
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', a.id).estado, 'apartado');
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', b.id).estado, 'vencido');
  assert.equal(stockDe(t.db, a.pieza.id), 0);
  assert.equal(stockDe(t.db, b.pieza.id), 1);
  assert.equal(await vencerPedidos(t.env), 0);
  // la tienda lo rechaza: el plazo ya habia pasado, asi que da un margen corto y no la vence en el acto
  comoUsuario(t.env, CAJERO);
  const rechazo = await t.pedir(`/api/pedidos/${a.folio}/rechazar-pago`, { motivo: 'No nos llegó' });
  assert.equal(rechazo.status, 200, JSON.stringify(rechazo.cuerpo));
  const margen = (Date.parse(fila(t.db, 'select vence_en from pedidos where id = ?', a.id).vence_en) - Date.now()) / 3_600_000;
  assert.ok(margen > 1.9 && margen <= 2, `margen ${margen} h`);
  assert.equal(await vencerPedidos(t.env), 0);
  // pasado el margen, vence como cualquier apartado
  assert.equal(await vencerPedidos(t.env, new Date(Date.now() + 3 * 3_600_000)), 1);
  assert.equal(stockDe(t.db, a.pieza.id), 1);
  t.db.close();
});

test('rechazar con el plazo todavia vigente conserva el plazo original; pide motivo; solo una vez', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  await reportar(t, a.folio);
  const vence = fila(t.db, 'select vence_en from pedidos where id = ?', a.id).vence_en;
  comoUsuario(t.env, CAJERO);
  assert.equal((await t.pedir(`/api/pedidos/${a.folio}/rechazar-pago`, { motivo: '  ' })).status, 400);
  assert.equal((await t.pedir(`/api/pedidos/${a.folio}/rechazar-pago`, { motivo: 'x'.repeat(141) })).status, 400);
  assert.equal(fila(t.db, 'select estado from pagos_reportados').estado, 'pendiente');
  assert.equal((await t.pedir(`/api/pedidos/99999/rechazar-pago`, { motivo: 'no' })).status, 404);
  assert.equal((await t.pedir(`/api/pedidos/${a.folio}/rechazar-pago`, { motivo: 'No nos llegó ese dinero' })).status, 200);
  assert.equal(fila(t.db, 'select vence_en from pedidos where id = ?', a.id).vence_en, vence);
  const f = fila(t.db, 'select estado, motivo, revisado_por from pagos_reportados');
  assert.deepEqual({ ...f }, { estado: 'rechazado', motivo: 'No nos llegó ese dinero', revisado_por: CAJERO });
  assert.equal((await t.pedir(`/api/pedidos/${a.folio}/rechazar-pago`, { motivo: 'otra vez' })).status, 409);
  assert.equal((await t.pedir(`/api/pedidos/${a.folio}/rechazar-pago`, undefined, 'GET')).status, 405);
  t.db.close();
});

test('rechazado: ella ve el motivo en su chip, puede cancelar y puede mandar otro comprobante', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  await reportar(t, a.folio);
  comoUsuario(t.env, CAJERO);
  await t.pedir(`/api/pedidos/${a.folio}/rechazar-pago`, { motivo: 'La clave no existe' });
  comoUsuario(t.env, ANA);
  const p = (await mios(t))[0];
  assert.deepEqual([p.pago_reportado.estado, p.pago_reportado.motivo, p.cancelable], ['rechazado', 'La clave no existe', true]);
  assert.deepEqual(estadoMia(p, Date.now()), { clase: 'alerta', texto: '⚠ La tienda no encontró el pago: La clave no existe' });
  const otro = await reportar(t, a.folio);
  assert.equal(otro.status, 201, JSON.stringify(otro.cuerpo));
  assert.deepEqual(reportes(t.db).map((r) => r.estado), ['rechazado', 'pendiente']);
  assert.equal((await mios(t))[0].pago_reportado.estado, 'pendiente');   // lo ultimo que paso
  t.db.close();
});

test('la tienda ve el reporte pendiente en /api/pedidos; con la foto, pero sin que la revendedora la vea de vuelta', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const b = await apartado(t);
  const foto = (await subirFoto(t, a.folio)).cuerpo.key;
  await reportar(t, a.folio, { monto: 20000, banco_emisor: '40012', comprobante_key: foto, fecha_comprobante: '2026-10-29' });
  comoUsuario(t.env, CAJERO);
  const lista = (await t.pedir('/api/pedidos', undefined, 'GET')).cuerpo.pedidos as Record<string, any>[];
  const de = (folio: number) => lista.find((p) => p.folio === folio)!;
  assert.equal(de(b.folio).reporte, null);
  const r = de(a.folio).reporte;
  assert.deepEqual([r.monto, r.banco_emisor, r.comprobante_key, r.fecha_comprobante, r.revendedora], [20000, '40012', foto, '2026-10-29', 'Ana R.']);
  assert.match(r.clave, /^PRUEBA/);
  t.db.close();
});

test('aceptar = registrar el abono de siempre: crea la transferencia con la foto, cierra el reporte en el mismo batch, aunque el plazo ya pasara', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const foto = (await subirFoto(t, a.folio)).cuerpo.key;
  const k = clave();
  await reportar(t, a.folio, { clave_rastreo: k, monto: 20000, banco_emisor: '40012', comprobante_key: foto });
  // el cron la salto: el plazo pasó pero el apartado sigue vivo
  t.db.prepare('update pedidos set vence_en = ? where id = ?').run(new Date(Date.now() - 3_600_000).toISOString(), a.id);
  assert.equal(await vencerPedidos(t.env), 0);
  comoUsuario(t.env, CAJERO);
  const id = crypto.randomUUID();
  const cuerpo = { id, importe: 20000, forma_pago: 'transferencia', caja: 'Caja 1', clave_rastreo: k, monto_transferido: 20000, banco_emisor: '40012', comprobante_key: foto };
  const abono = await t.pedir(`/api/pedidos/${a.folio}/abonos`, cuerpo);
  assert.equal(abono.status, 200, JSON.stringify(abono.cuerpo));
  assert.equal(fila(t.db, 'select saldo from pedidos where id = ?', a.id).saldo, 20000);
  const t1 = fila(t.db, 'select clave_rastreo, comprobante_key, banco_emisor, origen, movimiento_id from transferencias_spei');
  assert.deepEqual({ ...t1 }, { clave_rastreo: k, comprobante_key: foto, banco_emisor: '40012', origen: 'abono', movimiento_id: id });
  const rep = fila(t.db, 'select estado, revisado_por, movimiento_id from pagos_reportados');
  assert.deepEqual({ ...rep }, { estado: 'aceptado', revisado_por: CAJERO, movimiento_id: id });
  // el reintento devuelve lo mismo y no repite nada
  assert.deepEqual((await t.pedir(`/api/pedidos/${a.folio}/abonos`, cuerpo)).cuerpo, abono.cuerpo);
  assert.equal((t.db.prepare('select count(*) as n from pagos_reportados').get() as any).n, 1);
  // ella ve que la tienda ya registro su pago
  comoUsuario(t.env, ANA);
  const p = (await mios(t))[0];
  assert.equal(p.pago_reportado.estado, 'aceptado');
  assert.match(estadoMia(p, Date.now()).texto, /La tienda ya registró su pago/);
  // y lo aceptado ya no sale pendiente en /pedidos
  comoUsuario(t.env, CAJERO);
  assert.equal(((await t.pedir('/api/pedidos', undefined, 'GET')).cuerpo.pedidos as any[])[0].reporte, null);
  t.db.close();
});

test('si el abono falla (clave repetida, monto de menos) el reporte sigue pendiente: nada queda a medias', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const b = await apartado(t);
  const usada = datosTransferencia(5000);
  comoUsuario(t.env, CAJERO);
  assert.equal((await t.pedir(`/api/pedidos/${b.folio}/abonos`, { id: crypto.randomUUID(), importe: 5000, forma_pago: 'transferencia', caja: 'Caja 1', ...usada })).status, 200);
  comoUsuario(t.env, ANA);
  await reportar(t, a.folio, { clave_rastreo: clave() });
  comoUsuario(t.env, CAJERO);
  const abono = (extra: Record<string, unknown>) => t.pedir(`/api/pedidos/${a.folio}/abonos`, { id: crypto.randomUUID(), importe: 20000, forma_pago: 'transferencia', caja: 'Caja 1', ...extra });
  assert.equal((await abono({ clave_rastreo: usada.clave_rastreo, monto_transferido: 20000 })).status, 409);
  assert.equal((await abono({ clave_rastreo: clave(), monto_transferido: 100 })).status, 400);
  assert.equal(fila(t.db, 'select estado from pagos_reportados').estado, 'pendiente');
  assert.equal(fila(t.db, 'select saldo from pedidos where id = ?', a.id).saldo, 0);
  t.db.close();
});

test('un abono en efectivo tambien cierra el reporte pendiente (el dinero ya llego); un apartado sin reporte vencido sigue sin recibir abonos', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const b = await apartado(t);
  await reportar(t, a.folio);
  t.db.prepare('update pedidos set vence_en = ?').run(new Date(Date.now() - 1000).toISOString());
  comoUsuario(t.env, CAJERO);
  const abono = (folio: number) => t.pedir(`/api/pedidos/${folio}/abonos`, { id: crypto.randomUUID(), importe: 100, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal((await abono(b.folio)).status, 409);
  assert.equal((await abono(a.folio)).status, 200);
  assert.equal(fila(t.db, 'select estado from pagos_reportados').estado, 'aceptado');
  t.db.close();
});

test('la foto: tope por venta, solo JPEG, y la lee el mismo servicio que la caja (clave, banco y monto vuelven para confirmar)', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  assert.equal((await subirFoto(t, a.folio, 'no soy imagen', 'text/plain')).status, 415);
  assert.equal((await subirFoto(t, a.folio, new Uint8Array(0))).status, 413);
  assert.equal((t.db.prepare('select count(*) as n from comprobantes_subidos').get() as any).n, 0);   // las rechazadas no gastan tope
  (t.env as any).ANTHROPIC_API_KEY = 'prueba';
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ clave_rastreo: 'ejemplo 123456', banco_emisor: '40012', monto_mxn: 200, fecha: '2026-10-29' }) }],
    usage: { input_tokens: 1, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
  test.after(() => { globalThis.fetch = original; });
  const leida = await subirFoto(t, a.folio);
  assert.deepEqual(leida.cuerpo.lectura, { clave: 'EJEMPLO123456', banco_emisor: '40012', monto: 20000, fecha: '2026-10-29' });
  for (let i = 0; i < 5; i++) assert.equal((await subirFoto(t, a.folio)).status, 200);
  const tope = await subirFoto(t, a.folio);
  assert.equal(tope.status, 429);
  assert.match(tope.cuerpo.error, /clave de rastreo/);
  assert.equal((t.db.prepare('select count(*) as n from comprobantes_subidos').get() as any).n, 6);
  t.db.close();
});

test('la foto del reporte la ve solo el dueno: ni la revendedora, ni el cajero', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t);
  const foto = (await subirFoto(t, a.folio)).cuerpo.key;
  const sin = await reportar(t, a.folio, { clave_rastreo: clave() });
  assert.equal(sin.status, 201);
  const ver = (id: number) => worker.fetch!(new Request(`https://caja.prueba/api/pagos-reportados/${id}/comprobante`) as never, t.env, t.ctx as never);
  const id = reportes(t.db)[0].id as number;
  assert.equal((await ver(id)).status, 403);   // ella
  comoUsuario(t.env, CAJERO);
  assert.equal((await ver(id)).status, 403);
  comoUsuario(t.env, DUENO);
  assert.equal((await ver(id)).status, 404);   // este reporte no tiene foto
  t.db.prepare('update pagos_reportados set comprobante_key = ? where id = ?').run(foto, id);
  const r = await ver(id);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [...JPEG]);
  t.db.close();
});

test('envio de revendedora: tambien puede reportar y su abono acepta el reporte', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const a = await apartado(t, 'envio');
  assert.equal((await reportar(t, a.folio)).status, 201);
  comoUsuario(t.env, CAJERO);
  const lista = (await t.pedir('/api/pedidos', undefined, 'GET')).cuerpo.pedidos as any[];
  assert.equal(lista.find((p) => p.folio === a.folio).reporte.revendedora, 'Ana R.');
  const k = clave();
  assert.equal((await t.pedir(`/api/pedidos/${a.folio}/abonos`, { id: crypto.randomUUID(), importe: 5000, forma_pago: 'transferencia', caja: 'Caja 1', clave_rastreo: k, monto_transferido: 5000 })).status, 200);
  assert.equal(fila(t.db, 'select estado from pagos_reportados').estado, 'aceptado');
  t.db.close();
});

/* ---------- pantallas ---------- */

test('comprobante.js: con la ruta de la revendedora sube ahi, rellena la clave y usa sus textos; un rechazo del servidor se dice tal cual', async () => {
  const { adjuntar } = await import('../public/comprobante.js');
  const g = globalThis as any;
  const guardado = { bitmap: g.createImageBitmap, doc: g.document, fetch: g.fetch };
  g.createImageBitmap = async () => ({ width: 100, height: 100, close() {} });
  g.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob: (cb: (b: Blob) => void) => cb(new Blob([JPEG])) }) };
  test.after(() => { g.createImageBitmap = guardado.bitmap; g.document = guardado.doc; g.fetch = guardado.fetch; });
  const elementos = new Map<string, any>();
  const $ = (id: string) => elementos.get(id) ?? elementos.set(id, { value: '', textContent: '' }).get(id);
  const ids = { clave: 'c', monto: 'm', banco: 'b', aviso: 'a', ruta: '/api/vender/apartados/7/comprobante',
    texto: { leido: (l: string[]) => `leido ${l.join('+')}`, noLeyo: 'no leyo', sinRed: 'sin red' } };
  const usadas: string[] = [];
  const responder = (cuerpo: unknown, status = 200) => { g.fetch = async (url: string) => { usadas.push(url); return new Response(JSON.stringify(cuerpo), { status }); }; };
  const entrada = () => ({ files: [{}], dataset: {} as Record<string, string> });

  responder({ key: 'comprobantes/x.jpg', lectura: { clave: 'ABCDEF123', monto: 50000, banco_emisor: '40012', fecha: '2026-10-29' } });
  const a = entrada();
  await adjuntar(a, ids, $);
  assert.deepEqual([usadas[0], a.dataset.key, a.dataset.fecha, $('c').value, $('a').textContent], ['/api/vender/apartados/7/comprobante', 'comprobantes/x.jpg', '2026-10-29', 'ABCDEF123', 'leido clave de rastreo+monto+banco']);
  responder({ key: 'comprobantes/y.jpg', lectura: null });
  await adjuntar(entrada(), ids, $);
  assert.equal($('a').textContent, 'no leyo');
  responder({ error: 'Ya mandaste varias fotos de esta venta.' }, 429);
  const b = entrada();
  await adjuntar(b, ids, $);
  assert.deepEqual([b.dataset.key, $('a').textContent], ['', 'Ya mandaste varias fotos de esta venta.']);
  responder({ error: 'x' }, 500);
  await adjuntar(entrada(), ids, $);
  assert.equal($('a').textContent, 'sin red');
  // la caja sigue igual: sin ruta ni textos propios usa los suyos
  responder({ key: 'comprobantes/z.jpg', lectura: { clave: 'ABCDEF123', monto: 0, banco_emisor: '', fecha: '' } });
  await adjuntar(entrada(), { clave: 'c', monto: 'm', banco: 'b', aviso: 'a' }, $);
  assert.equal(usadas.at(-1), '/api/transferencias/comprobante');
  assert.match($('a').textContent, /antes de cobrar/);
});

test('las pantallas estan conectadas: Mis ventas manda el pago, /pedidos registra o rechaza, el manual lo explica', async () => {
  const { readFileSync } = await import('node:fs');
  const leer = (r: string) => readFileSync(r, 'utf8').replace(/\r\n/g, '\n');
  const vender = leer('public/vender.html');
  assert.match(vender, /`\/api\/vender\/apartados\/\$\{pagoFolio\}\/pago`/);
  assert.match(vender, /`\/api\/vender\/apartados\/\$\{pagoFolio\}\/comprobante`/);
  assert.match(vender, /Ya me pagó: mandar comprobante/);
  assert.match(vender, /No es el «número de referencia»/);
  const pedidos = leer('public/pedidos.html');
  assert.match(pedidos, /data-registrar/);
  assert.match(pedidos, /\/rechazar-pago/);
  assert.match(pedidos, /abrirMovimiento\(.*'abono', .*reporte/);
  assert.match(leer('public/manual.html'), /Ya me pagó: mandar comprobante/);
  for (const [nombre, html] of [['vender', vender], ['pedidos', pedidos]]) {
    const script = html.split('<script type="module">')[1].split('</script>')[0].replace(/^import[\s\S]*?;$/gm, '');
    const FuncionAsincrona = Object.getPrototypeOf(async () => {}).constructor;
    assert.doesNotThrow(() => new FuncionAsincrona(script), nombre);
  }
});
