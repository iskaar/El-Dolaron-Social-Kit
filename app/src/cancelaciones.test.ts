// node --test src/cancelaciones.test.ts
// Cancelaciones con aprobacion del dueno (Issue #200) contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { VENTANA_CANCELACION_MS } from './cancelaciones.ts';

const TIENDA = 'tienda@prueba.mx';
const ANA = 'ana@prueba.mx';
const PIN_DUENO = '111222';
const PIN_ANA = '482913';

async function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en) values
    ('${TIENDA}', 'Computadora', 'computadora', 1, '', '', ''),
    ('${ANA}', 'Ana', 'cajero', 1, 'Caja 2', '', '')`).run();
  await t.pedir('/api/cuentas/pin', { correo: DUENO, pin: PIN_DUENO }, 'PUT');
  await t.pedir('/api/cuentas/pin', { correo: ANA, pin: PIN_ANA }, 'PUT');
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  // La computadora de la tienda con Ana en turno (PIN).
  como(TIENDA);
  const token = (await t.pedir('/api/cajeros/entrar', { correo: ANA, pin: PIN_ANA })).cuerpo.token as string;
  const ana = { 'x-cajero': token };
  const vender = async (haceMs = 0) => {
    const id = crypto.randomUUID();
    const r = await t.pedir('/api/ventas', {
      id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1',
    }, 'POST', ana);
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    if (haceMs) t.db.prepare('update ventas set creado_en = ? where id = ?').run(new Date(Date.now() - haceMs).toISOString(), id);
    return id;
  };
  const cancelar = (id: string, extra: Record<string, unknown> = {}, encabezados: Record<string, string> = ana) =>
    t.pedir(`/api/ventas/${id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1', ...extra }, 'POST', encabezados);
  const venta = (id: string) => ({ ...t.db.prepare('select cancelada, cancelada_por, motivo_cancelacion from ventas where id = ?').get(id) } as
    { cancelada: number; cancelada_por: string | null; motivo_cancelacion: string | null });
  const stock = () => (t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;
  const solicitudes = () => t.db.prepare('select * from solicitudes').all() as Record<string, any>[];
  return { ...t, como, ana, vender, cancelar, venta, stock, solicitudes };
}

const VIEJA = VENTANA_CANCELACION_MS + 60_000;

test('el dueno cancela directo aunque hayan pasado mas de 5 minutos', async () => {
  const { como, vender, cancelar, venta, solicitudes } = await montar();
  const id = await vender(VIEJA);
  como(DUENO);
  const r = await cancelar(id, {}, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(venta(id).cancelada, 1);
  assert.equal(venta(id).cancelada_por, DUENO);
  assert.equal(solicitudes().length, 0);
});

test('el cajero cancela solo dentro de los 5 minutos', async () => {
  const { vender, cancelar, venta, stock } = await montar();
  const id = await vender(60_000);
  const antes = stock();
  const r = await cancelar(id);
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(venta(id).cancelada_por, ANA);
  assert.equal(stock(), antes + 1);
});

test('pasados 5 minutos el cajero no cancela: pide aprobacion y no se crea solicitud', async () => {
  const { vender, cancelar, venta, stock, solicitudes } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const r = await cancelar(id);
  assert.equal(r.status, 403);
  assert.equal(r.cuerpo.requiere_aprobacion, true);
  assert.match(r.cuerpo.error, /5 minutos/);
  assert.deepEqual(r.cuerpo.duenos, [{ correo: DUENO, nombre: 'Isaac' }]);   // Ana tiene PIN pero no es dueno
  assert.equal(venta(id).cancelada, 0);
  assert.equal(stock(), antes);
  assert.equal(solicitudes().length, 0);
});

test('PIN del dueno equivocado: no cancela y cuenta el fallo; el de Ana o de otro no dueno tampoco sirve', async () => {
  const { db, vender, cancelar, venta, solicitudes } = await montar();
  const id = await vender(VIEJA);

  const mal = await cancelar(id, { aprobador: DUENO, pin: '000000' });
  assert.equal(mal.status, 403);
  assert.equal(venta(id).cancelada, 0);
  assert.equal((db.prepare('select pin_fallos from usuarios where correo = ?').get(DUENO) as any).pin_fallos, 1);

  // Ana (cajero) como aprobador, con su propio PIN correcto: no es dueno.
  const propio = await cancelar(id, { aprobador: ANA, pin: PIN_ANA });
  assert.equal(propio.status, 404);
  assert.equal(venta(id).cancelada, 0);

  assert.equal(solicitudes().length, 0);
});

test('5 PIN malos del dueno lo bloquean tambien aqui, aun con el correcto', async () => {
  const { vender, cancelar, venta } = await montar();
  const id = await vender(VIEJA);
  for (let i = 0; i < 5; i++) await cancelar(id, { aprobador: DUENO, pin: '000000' });
  const r = await cancelar(id, { aprobador: DUENO, pin: PIN_DUENO });
  assert.equal(r.status, 423);
  assert.equal(venta(id).cancelada, 0);
});

test('PIN correcto del dueno: cancela a nombre de Ana y deja la solicitud aprobada por pin', async () => {
  const { vender, cancelar, venta, stock, solicitudes } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const r = await cancelar(id, { aprobador: DUENO.toUpperCase(), pin: PIN_DUENO });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(venta(id).cancelada_por, ANA);
  assert.equal(stock(), antes + 1);

  const [s, ...resto] = solicitudes();
  assert.equal(resto.length, 0);
  assert.equal(s.tipo, 'cancelacion');
  assert.equal(s.estado, 'aprobada');
  assert.equal(s.correo, ANA);
  assert.equal(s.nombre, 'Ana');
  assert.equal(s.justificacion, 'error de cobro');
  assert.equal(s.resuelto_por, DUENO);
  assert.ok(s.resuelto_en);
  assert.deepEqual(JSON.parse(s.datos), { venta_id: id, caja: 'Caja 1', via: 'pin' });
});

test('solicitar: 202 pendiente, una segunda peticion devuelve la misma y nada se cancela', async () => {
  const { vender, cancelar, venta, solicitudes, pedir, ana } = await montar();
  const id = await vender(VIEJA);
  const r = await cancelar(id, { solicitar: true });
  assert.equal(r.status, 202);
  assert.equal(r.cuerpo.pendiente, true);
  const otra = await cancelar(id, { solicitar: true });
  assert.equal(otra.status, 202);
  assert.equal(otra.cuerpo.solicitud_id, r.cuerpo.solicitud_id);
  assert.equal(venta(id).cancelada, 0);

  const [s, ...resto] = solicitudes();
  assert.equal(resto.length, 0);
  assert.equal(s.estado, 'pendiente');
  assert.equal(s.correo, ANA);
  assert.deepEqual(JSON.parse(s.datos), { venta_id: id, caja: 'Caja 1', via: 'remoto' });

  // La caja puede preguntar como va; otro cajero no.
  const estado = await pedir(`/api/solicitudes/${r.cuerpo.solicitud_id}`, undefined, 'GET', ana);
  assert.equal(estado.status, 200);
  assert.equal(estado.cuerpo.estado, 'pendiente');
});

test('el dueno aprueba desde cuentas: se cancela a nombre de Ana con la caja pedida y la solicitud queda aprobada', async () => {
  const { como, vender, cancelar, venta, stock, solicitudes, pedir, ana } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const { cuerpo: { solicitud_id } } = await cancelar(id, { solicitar: true });

  // Un cajero no puede listar ni resolver.
  assert.equal((await pedir('/api/solicitudes/cancelaciones', undefined, 'GET', ana)).status, 403);
  assert.equal((await pedir(`/api/solicitudes/${solicitud_id}/resolver`, { aprobar: true }, 'POST', ana)).status, 403);

  como(DUENO);
  const lista = await pedir('/api/solicitudes/cancelaciones', undefined, 'GET');
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.length, 1);
  assert.deepEqual(
    { id: lista.cuerpo[0].id, correo: lista.cuerpo[0].correo, nombre: lista.cuerpo[0].nombre, venta_id: lista.cuerpo[0].venta_id,
      total: lista.cuerpo[0].total, motivo: lista.cuerpo[0].motivo },
    { id: solicitud_id, correo: ANA, nombre: 'Ana', venta_id: id, total: 25000, motivo: 'error de cobro' });
  assert.ok(lista.cuerpo[0].creado_en && lista.cuerpo[0].venta_creado_en);

  const r = await pedir(`/api/solicitudes/${solicitud_id}/resolver`, { aprobar: true });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.estado, 'aprobada');
  assert.equal(venta(id).cancelada_por, ANA);
  assert.equal(venta(id).motivo_cancelacion, 'error de cobro');
  assert.equal(stock(), antes + 1);
  assert.equal(solicitudes()[0].estado, 'aprobada');
  assert.equal(solicitudes()[0].resuelto_por, DUENO);
  assert.equal((await pedir('/api/solicitudes/cancelaciones', undefined, 'GET')).cuerpo.length, 0);

  // Resolver otra vez ya no se puede.
  assert.equal((await pedir(`/api/solicitudes/${solicitud_id}/resolver`, { aprobar: true })).status, 409);

  // La caja ve el resultado.
  como(TIENDA);
  assert.equal((await pedir(`/api/solicitudes/${solicitud_id}`, undefined, 'GET', ana)).cuerpo.estado, 'aprobada');
});

test('si la venta ya se cancelo mientras tanto, aprobar cierra la solicitud con ya_estaba', async () => {
  const { como, vender, cancelar, solicitudes, pedir } = await montar();
  const id = await vender(VIEJA);
  const { cuerpo: { solicitud_id } } = await cancelar(id, { solicitar: true });
  como(DUENO);
  assert.equal((await cancelar(id, {}, {})).status, 200);   // el dueno la cancela directo
  const r = await pedir(`/api/solicitudes/${solicitud_id}/resolver`, { aprobar: true });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.ya_estaba, true);
  assert.equal(solicitudes()[0].estado, 'aprobada');
});

test('si el vale de la compra ya se uso, aprobar da 409 y la solicitud sigue pendiente', async () => {
  const { como, db, vender, cancelar, venta, solicitudes, pedir } = await montar();
  const id = await vender(VIEJA);
  const { cuerpo: { solicitud_id } } = await cancelar(id, { solicitar: true });
  // Un trigger de la propia tabla de ventas simula el rechazo de cancelarVales.
  db.exec(`create trigger prueba_vale_usado before update of cancelada on ventas
    when new.cancelada = 1 begin select raise(abort, 'saldo de vale invalido'); end`);
  como(DUENO);
  const r = await pedir(`/api/solicitudes/${solicitud_id}/resolver`, { aprobar: true });
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /vale/);
  assert.equal(venta(id).cancelada, 0);
  assert.equal(solicitudes()[0].estado, 'pendiente');
});

test('el dueno rechaza: la venta sigue activa y la solicitud queda rechazada', async () => {
  const { como, vender, cancelar, venta, solicitudes, pedir, ana } = await montar();
  const id = await vender(VIEJA);
  const { cuerpo: { solicitud_id } } = await cancelar(id, { solicitar: true });
  como(DUENO);
  const r = await pedir(`/api/solicitudes/${solicitud_id}/resolver`, { aprobar: false });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.estado, 'rechazada');
  assert.equal(venta(id).cancelada, 0);
  assert.equal(solicitudes()[0].estado, 'rechazada');
  como(TIENDA);
  assert.equal((await pedir(`/api/solicitudes/${solicitud_id}`, undefined, 'GET', ana)).cuerpo.estado, 'rechazada');
});

test('cancelar una pieza suelta sigue libre para el cajero pasados 5 minutos', async () => {
  const { vender, pedir, ana, stock } = await montar();
  const id = await vender(VIEJA);
  const antes = stock();
  const ticket = await pedir(`/api/ventas/${id}`, undefined, 'GET', ana);
  const r = await pedir(`/api/ventas/${id}/lineas/${ticket.cuerpo.lineas[0].id}/cancelar`,
    { id: crypto.randomUUID(), cantidad: 1, motivo: 'no le quedo', caja: 'Caja 1' }, 'POST', ana);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(stock(), antes + 1);
});

test('solo la cajera que pidio (o el dueno) lee su solicitud', async () => {
  const { como, db, vender, cancelar, pedir } = await montar();
  const id = await vender(VIEJA);
  const { cuerpo: { solicitud_id } } = await cancelar(id, { solicitar: true });
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('beto@prueba.mx', 'Beto', 'cajero', 1, '', '')`).run();
  como('beto@prueba.mx');
  assert.equal((await pedir(`/api/solicitudes/${solicitud_id}`, undefined, 'GET')).status, 404);
  como(DUENO);
  assert.equal((await pedir(`/api/solicitudes/${solicitud_id}`, undefined, 'GET')).status, 200);
});
