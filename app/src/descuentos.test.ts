// node --test src/descuentos.test.ts
// Descuentos con aprobacion del dueno (Issue #119) contra SQLite real, con la
// computadora de la tienda y el cajero entrando con PIN (Issue #112), como en cancelaciones.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { descuentoDe, totales } from '../public/venta.js';
import { resolverDescuento } from './descuentos.ts';
import { verificarCuadre } from '../public/graficas.js';

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
  // La computadora de la tienda con Ana en turno (PIN): todo lo de caja queda a su nombre.
  como(TIENDA);
  const token = async (correo: string, pin: string) =>
    (await t.pedir('/api/cajeros/entrar', { correo, pin })).cuerpo.token as string;
  const ana = { 'x-cajero': await token(ANA, PIN_ANA) };

  const pedirDescuento = (cuerpo: object = {}, encabezados: Record<string, string> = ana) =>
    t.pedir('/api/descuentos', { tipo: 'porcentaje', valor: 10, motivo: 'cliente frecuente', subtotal: 25000, ...cuerpo }, 'POST', encabezados);
  const venta = (extra: object = {}, cantidad = 1, encabezados: Record<string, string> = ana) => t.pedir('/api/ventas', {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad }], forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1', ...extra,
  }, 'POST', encabezados);
  const estado = async (id: string, encabezados: Record<string, string> = ana) =>
    (await t.pedir(`/api/solicitudes/${id}`, undefined, 'GET', encabezados)).cuerpo.estado as string;
  const solicitudes = () => t.db.prepare(`select * from solicitudes where tipo = 'descuento'`).all() as Record<string, any>[];
  /** Ana pide a distancia, el dueno resuelve desde /cuentas; vuelve a quedar la computadora con Ana. */
  const pedidoResuelto = async (cuerpo: object, aprobar: boolean) => {
    const { cuerpo: pedido } = await pedirDescuento(cuerpo);
    como(DUENO);
    const r = await t.pedir(`/api/solicitudes/${pedido.id}/resolver`, { aprobar });
    assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
    como(TIENDA);
    return pedido.id as string;
  };
  return { ...t, como, token, ana, pedirDescuento, venta, estado, solicitudes, pedidoResuelto };
}

test('la aritmetica: % o monto, tope de 50%, ticket vacio y valores raros', () => {
  assert.deepEqual(descuentoDe({ tipo: 'porcentaje', valor: 10 }, 25000), { monto: 2500 });
  assert.deepEqual(descuentoDe({ tipo: 'monto', valor: 3000 }, 25000), { monto: 3000 });
  assert.deepEqual(descuentoDe({ tipo: 'porcentaje', valor: 50 }, 25000), { monto: 12500 });
  assert.ok('error' in descuentoDe({ tipo: 'porcentaje', valor: 51 }, 25000));
  assert.ok('error' in descuentoDe({ tipo: 'monto', valor: 12501 }, 25000));
  assert.ok('error' in descuentoDe({ tipo: 'monto', valor: 100 }, 0));
  for (const valor of [0, -5, 1.5, NaN]) assert.ok('error' in descuentoDe({ tipo: 'porcentaje', valor }, 25000), `valor ${valor}`);
  assert.ok('error' in descuentoDe({ tipo: 'regalo', valor: 10 }, 25000));
  const t = totales([{ precio: 25000, cantidad: 1 }], 0, 0, 2500);
  assert.equal(t.subtotal, 25000);
  assert.equal(t.total, 22500);
});

test('a distancia: pide Ana, el dueno ve el pedido en /cuentas y lo aprueba, la venta sale con el descuento', async () => {
  const { como, db, pedirDescuento, venta, estado, pedir, ana, solicitudes } = await montar();
  const pedido = await pedirDescuento();
  assert.equal(pedido.status, 201, JSON.stringify(pedido.cuerpo));
  assert.equal(pedido.cuerpo.estado, 'pendiente');
  assert.equal(pedido.cuerpo.monto, 2500);
  const id = pedido.cuerpo.id as string;
  assert.equal(await estado(id), 'pendiente');
  assert.deepEqual(JSON.parse(solicitudes()[0].datos), { tipo: 'porcentaje', valor: 10, subtotal: 25000, monto: 2500, via: 'remoto' });

  // Cobrar con el descuento todavia pendiente no pasa.
  assert.equal((await venta({ descuento_id: id })).status, 409);

  // Un cajero no lista ni resuelve; el dueno si.
  assert.equal((await pedir('/api/solicitudes/descuentos', undefined, 'GET', ana)).status, 403);
  assert.equal((await pedir(`/api/solicitudes/${id}/resolver`, { aprobar: true }, 'POST', ana)).status, 403);
  como(DUENO);
  const lista = await pedir('/api/solicitudes/descuentos', undefined, 'GET');
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.length, 1);
  assert.deepEqual(
    { ...lista.cuerpo[0], creado_en: undefined },
    { id, correo: ANA, nombre: 'Ana', motivo: 'cliente frecuente', tipo: 'porcentaje', valor: 10, subtotal: 25000, monto: 2500, creado_en: undefined });
  const r = await pedir(`/api/solicitudes/${id}/resolver`, { aprobar: true });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.estado, 'aprobada');
  assert.equal((await pedir('/api/solicitudes/descuentos', undefined, 'GET')).cuerpo.length, 0);
  como(TIENDA);

  assert.equal(await estado(id), 'aprobada');
  const folio = crypto.randomUUID();
  const ok = await venta({ id: folio, descuento_id: id });
  assert.equal(ok.status, 201, JSON.stringify(ok.cuerpo));
  assert.equal(ok.cuerpo.total, 22500);
  assert.equal(ok.cuerpo.descuento, 2500);
  assert.equal(ok.cuerpo.cambio, 27500);
  assert.deepEqual({ ...db.prepare('select total, descuento, descuento_id, cajero from ventas').get() },
    { total: 22500, descuento: 2500, descuento_id: id, cajero: ANA });

  // Reintentar la misma venta tras perder la respuesta es idempotente, no «ya se uso».
  const reintento = await venta({ id: folio, descuento_id: id });
  assert.equal(reintento.status, 200);
  assert.equal(reintento.cuerpo.duplicada, true);
  assert.equal(db.prepare('select count(*) as n from ventas').get()!.n, 1);
  // El mismo folio con otro descuento ya es otra venta.
  const otro = await venta({ id: folio });
  assert.equal(otro.status, 409);
});

test('a distancia: si el dueno rechaza, la venta con ese descuento no pasa', async () => {
  const { venta, estado, pedidoResuelto } = await montar();
  const id = await pedidoResuelto({ tipo: 'monto', valor: 2000 }, false);
  assert.equal(await estado(id), 'rechazada');
  assert.equal((await venta({ descuento_id: id })).status, 409);
  assert.equal((await venta({ descuento_id: crypto.randomUUID() })).status, 400);
});

test('dos duenos a la vez: gana uno, el otro recibe 409 y la solicitud queda con un solo resultado', async () => {
  const { como, db, pedirDescuento, pedir, solicitudes, env } = await montar();
  const id = (await pedirDescuento()).cuerpo.id as string;
  como(DUENO);
  const [a, b] = await Promise.all([
    pedir(`/api/solicitudes/${id}/resolver`, { aprobar: true }),
    pedir(`/api/solicitudes/${id}/resolver`, { aprobar: false }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const ganador = a.status === 200 ? a : b;
  assert.equal(solicitudes()[0].estado, ganador.cuerpo.estado);

  // Si el otro dueno la gano justo entre la lectura y el UPDATE, el nuestro lo dice.
  como(TIENDA);
  const nuevo = (await pedirDescuento({ valor: 20 })).cuerpo.id as string;
  db.prepare(`update solicitudes set estado = 'rechazada' where id = ?`).run(nuevo);
  const perdio = await resolverDescuento(env, nuevo, true, DUENO);
  assert.equal(perdio.status, 409);
  assert.match(((await perdio.json()) as { error: string }).error, /Otro dueño/);
});

test('PIN del dueno en la caja: aprueba al momento, queda registrado via pin y la venta sale con el descuento', async () => {
  const { db, pedirDescuento, venta, estado, solicitudes } = await montar();
  const pedido = await pedirDescuento({ aprobador: DUENO.toUpperCase(), pin: PIN_DUENO });
  assert.equal(pedido.status, 201, JSON.stringify(pedido.cuerpo));
  assert.equal(pedido.cuerpo.estado, 'aprobada');
  assert.equal(pedido.cuerpo.monto, 2500);

  const [s, ...resto] = solicitudes();
  assert.equal(resto.length, 0);
  assert.equal(s.estado, 'aprobada');
  assert.equal(s.correo, ANA);
  assert.equal(s.nombre, 'Ana');
  assert.equal(s.justificacion, 'cliente frecuente');
  assert.equal(s.resuelto_por, DUENO);
  assert.ok(s.resuelto_en);
  assert.deepEqual(JSON.parse(s.datos), { tipo: 'porcentaje', valor: 10, subtotal: 25000, monto: 2500, via: 'pin' });
  assert.equal(await estado(s.id), 'aprobada');

  const r = await venta({ descuento_id: s.id });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.total, 22500);
  assert.deepEqual({ ...db.prepare('select total, descuento, descuento_id from ventas').get() },
    { total: 22500, descuento: 2500, descuento_id: s.id });
});

test('PIN equivocado no aprueba y cuenta el fallo; el PIN de un cajero como aprobador tampoco sirve', async () => {
  const { db, pedirDescuento, solicitudes } = await montar();
  const mal = await pedirDescuento({ aprobador: DUENO, pin: '000000' });
  assert.equal(mal.status, 403);
  assert.equal((db.prepare('select pin_fallos from usuarios where correo = ?').get(DUENO) as any).pin_fallos, 1);
  assert.equal((await pedirDescuento({ aprobador: DUENO, pin: '12' })).status, 400);

  // Ana (cajero) como aprobador, con su propio PIN correcto: no es dueno.
  const propio = await pedirDescuento({ aprobador: ANA, pin: PIN_ANA });
  assert.equal(propio.status, 404);
  assert.equal(solicitudes().length, 0);

  // Cinco malos bloquean al dueno tambien aqui, aun con el correcto.
  for (let i = 0; i < 4; i++) await pedirDescuento({ aprobador: DUENO, pin: '000000' });
  assert.equal((await pedirDescuento({ aprobador: DUENO, pin: PIN_DUENO })).status, 423);
  assert.equal(solicitudes().length, 0);
});

test('con PIN o sin el, el tope de 50% y el motivo siguen mandando', async () => {
  const { pedirDescuento, solicitudes } = await montar();
  assert.equal((await pedirDescuento({ valor: 60, aprobador: DUENO, pin: PIN_DUENO })).status, 400);
  assert.equal((await pedirDescuento({ motivo: ' ', aprobador: DUENO, pin: PIN_DUENO })).status, 400);
  assert.equal(solicitudes().length, 0);
});

test('si quien cobra es el dueno, aplica el descuento directo (sin aprobacion ni PIN)', async () => {
  const { como, pedir, db, token, solicitudes, venta } = await montar();
  // En su propia cuenta de Access...
  como(DUENO);
  const propio = await pedir('/api/descuentos', { tipo: 'monto', valor: 3000, motivo: 'pieza con detalle', subtotal: 25000 });
  assert.equal(propio.status, 201, JSON.stringify(propio.cuerpo));
  assert.equal(propio.cuerpo.estado, 'aprobada');
  assert.equal(propio.cuerpo.monto, 3000);
  assert.equal((await venta({ descuento_id: propio.cuerpo.id }, 1, {})).cuerpo.total, 22000);

  // ...o entrando con su PIN en la computadora de la tienda.
  como(TIENDA);
  const enCaja = await pedir('/api/descuentos', { tipo: 'porcentaje', valor: 20, motivo: 'liquidacion', subtotal: 25000 },
    'POST', { 'x-cajero': await token(DUENO, PIN_DUENO) });
  assert.equal(enCaja.cuerpo.estado, 'aprobada');

  const [a, b] = solicitudes();
  assert.equal(a.resuelto_por, DUENO);
  assert.equal(JSON.parse(a.datos).via, 'dueno');
  assert.equal(JSON.parse(b.datos).via, 'dueno');
  assert.equal(db.prepare('select count(*) as n from solicitudes where estado = ?').get('pendiente')!.n, 0);
  // Tambien al dueno lo frena el tope.
  como(DUENO);
  assert.equal((await pedir('/api/descuentos', { tipo: 'porcentaje', valor: 51, motivo: 'x', subtotal: 25000 })).status, 400);
});

test('una aprobacion sirve para una sola venta', async () => {
  const { db, pedidoResuelto, venta } = await montar();
  const id = await pedidoResuelto({ valor: 20 }, true);
  assert.equal((await venta({ descuento_id: id })).status, 201);
  const otra = await venta({ descuento_id: id });
  assert.equal(otra.status, 409);
  assert.match(otra.cuerpo.error, /ya se uso/);
  assert.equal(db.prepare('select count(*) as n from ventas').get()!.n, 1);
});

test('si el ticket cambia despues de aprobar, la aprobacion ya no vale (aprobada a distancia o con PIN)', async () => {
  const { pedidoResuelto, pedirDescuento, venta } = await montar();
  const remoto = await pedidoResuelto({ valor: 50 }, true);
  const conPin = (await pedirDescuento({ valor: 50, aprobador: DUENO, pin: PIN_DUENO })).cuerpo.id as string;
  for (const id of [remoto, conPin]) {
    const dosPiezas = await venta({ descuento_id: id }, 2);
    assert.equal(dosPiezas.status, 409);
    assert.match(dosPiezas.cuerpo.error, /cambio/);
  }
  assert.equal((await venta({ descuento_id: remoto })).status, 201);   // el ticket original si
  assert.equal((await venta({ descuento_id: conPin })).status, 201);
});

test('el servidor recalcula: una aprobacion manipulada por encima del tope no se cobra', async () => {
  const { db, pedidoResuelto, venta } = await montar();
  const id = await pedidoResuelto({ valor: 10 }, true);
  db.prepare(`update solicitudes set datos = ? where id = ?`)
    .run(JSON.stringify({ tipo: 'porcentaje', valor: 90, subtotal: 25000, monto: 22500 }), id);
  const r = await venta({ descuento_id: id });
  assert.equal(r.status, 400);
  assert.equal(db.prepare('select count(*) as n from ventas').get()!.n, 0);
});

test('el servidor rechaza pedir de mas: sin motivo, sobre el tope o con valores raros', async () => {
  const { pedirDescuento } = await montar();
  assert.equal((await pedirDescuento({ motivo: '  ' })).status, 400);
  assert.equal((await pedirDescuento({ valor: 60 })).status, 400);
  assert.equal((await pedirDescuento({ tipo: 'monto', valor: 20000 })).status, 400);
  assert.equal((await pedirDescuento({ tipo: 'monto', valor: 100, subtotal: 0 })).status, 400);
  assert.equal((await pedirDescuento({ valor: 'x' })).status, 400);
});

test('la computadora de la tienda sin PIN de cajero no pide descuentos; el cajero no se aprueba solo ni ve lo de otros', async () => {
  const { db, como, pedirDescuento, pedir, estado, token } = await montar();
  const sinPin = await pedirDescuento({}, {});
  assert.equal(sinPin.status, 401);
  assert.equal(sinPin.cuerpo.pin, true);

  const { cuerpo } = await pedirDescuento();
  assert.equal((await pedir(`/api/solicitudes/${cuerpo.id}/resolver`, { aprobar: true }, 'POST', { 'x-cajero': await token(ANA, PIN_ANA) })).status, 403);
  assert.equal(db.prepare('select estado from solicitudes where id = ?').get(cuerpo.id)!.estado, 'pendiente');

  db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
              values ('otra@prueba.mx', 'Otra', 'cajero', 1, '', '', '')`).run();
  como(DUENO);
  await pedir('/api/cuentas/pin', { correo: 'otra@prueba.mx', pin: '654321' }, 'PUT');
  como(TIENDA);
  const otra = { 'x-cajero': await token('otra@prueba.mx', '654321') };
  assert.equal((await pedir(`/api/solicitudes/${cuerpo.id}`, undefined, 'GET', otra)).status, 404);
  como(DUENO);
  assert.equal(await estado(cuerpo.id, {}), 'pendiente');
});

test('pedir otro reemplaza el pendiente anterior', async () => {
  const { pedirDescuento, estado, solicitudes } = await montar();
  const primero = (await pedirDescuento()).cuerpo.id as string;
  const segundo = (await pedirDescuento({ tipo: 'monto', valor: 3000 })).cuerpo.id as string;
  assert.equal(await estado(primero), 'rechazada');
  assert.equal(await estado(segundo), 'pendiente');
  assert.equal(solicitudes().filter((s) => s.estado === 'pendiente').length, 1);
});

test('/api/descuentos/duenos lista solo a los duenos con PIN, para aprobar en la caja', async () => {
  const { pedir, ana } = await montar();
  const r = await pedir('/api/descuentos/duenos', undefined, 'GET', ana);
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo, [{ correo: DUENO, nombre: 'Isaac' }]);   // Ana tiene PIN pero no es dueno
});

test('cancelar una venta con descuento devuelve lo que se pago, no el precio de lista; el descuento no se reusa', async () => {
  const { db, pedirDescuento, venta, pedir, ana, estado } = await montar();
  const id = (await pedirDescuento({ aprobador: DUENO, pin: PIN_DUENO })).cuerpo.id as string;
  const folio = crypto.randomUUID();
  assert.equal((await venta({ id: folio, descuento_id: id })).status, 201);
  const stockAntes = (db.prepare('select stock from productos where id = ?').get(PRODUCTO) as any).stock;

  const r = await pedir(`/api/ventas/${folio}/cancelar`, { motivo: 'cliente se arrepintio', caja: 'Caja 1' }, 'POST', ana);
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devuelto, 22500);
  assert.equal((db.prepare('select stock from productos where id = ?').get(PRODUCTO) as any).stock, stockAntes + 1);
  // Una venta cancelada no libera la aprobacion.
  assert.equal(await estado(id), 'aprobada');
  assert.equal((await venta({ descuento_id: id })).status, 409);
});

test('cancelar piezas sueltas de un ticket con descuento devuelve su parte de lo cobrado y la ultima cierra al centavo', async () => {
  const { db, pedirDescuento, venta, pedir, ana } = await montar();
  // Dos piezas de $250 con 10%: se cobran $450.
  const id = (await pedirDescuento({ subtotal: 50000, aprobador: DUENO, pin: PIN_DUENO })).cuerpo.id as string;
  const folio = crypto.randomUUID();
  const r = await venta({ id: folio, descuento_id: id }, 2);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.total, 45000);
  const linea = (db.prepare('select id from venta_lineas where venta_id = ?').get(folio) as any).id;
  const cancelarPieza = () => pedir(`/api/ventas/${folio}/lineas/${linea}/cancelar`,
    { id: crypto.randomUUID(), cantidad: 1, motivo: 'defecto', caja: 'Caja 1' }, 'POST', ana);

  const primera = await cancelarPieza();
  assert.equal(primera.status, 201, JSON.stringify(primera.cuerpo));
  assert.equal(primera.cuerpo.devuelto, 22500);   // no los $250 de lista
  const ultima = await cancelarPieza();
  assert.equal(ultima.cuerpo.devuelto, 22500);
  assert.equal((db.prepare('select devuelto from ventas where id = ?').get(folio) as any).devuelto, 45000);
});

test('el desglose del ticket trae el descuento para la caja y los reportes', async () => {
  const { pedirDescuento, venta, pedir, ana } = await montar();
  const id = (await pedirDescuento({ aprobador: DUENO, pin: PIN_DUENO })).cuerpo.id as string;
  const folio = crypto.randomUUID();
  await venta({ id: folio, descuento_id: id });
  const detalle = await pedir(`/api/ventas/${folio}`, undefined, 'GET', ana);
  assert.equal(detalle.cuerpo.total, 22500);
  assert.equal(detalle.cuerpo.descuento, 2500);
});

test('promo de inauguracion: $100 menos en tickets de $300 o mas dentro de la ventana, una vez, y se suma al descuento aprobado', async () => {
  const { env, venta, pedidoResuelto, pedir, ana } = await montar();
  // Sin fechas configuradas no hay promo, ni en la caja ni al cobrar.
  assert.equal((await venta({}, 2)).cuerpo.total, 50000);
  assert.equal((await pedir('/api/vales/config', undefined, 'GET', ana)).cuerpo.promo, null);

  Object.assign(env, { PROMO_DESDE: '2026-01-01T06:00:00Z', PROMO_HASTA: '2026-01-08T06:00:00Z' });
  assert.deepEqual((await pedir('/api/vales/config', undefined, 'GET', ana)).cuerpo.promo,
    { desde: '2026-01-01T06:00:00Z', hasta: '2026-01-08T06:00:00Z' });
  const dentro = '2026-01-03T20:00:00Z';
  const con = await venta({ creado_en: dentro }, 2);
  assert.equal(con.status, 201, JSON.stringify(con.cuerpo));
  assert.equal(con.cuerpo.descuento, 10000);
  assert.equal(con.cuerpo.total, 40000);
  // Una vez por ticket: $750 tambien baja solo $100.
  assert.equal((await venta({ creado_en: dentro, efectivo: 80000 }, 3)).cuerpo.total, 65000);
  assert.equal((await venta({ creado_en: dentro }, 1)).cuerpo.total, 25000, '$250 no alcanza los $300');
  assert.equal((await venta({ creado_en: '2026-01-01T05:59:59Z' }, 2)).cuerpo.total, 50000, 'antes de empezar');
  assert.equal((await venta({ creado_en: '2026-01-08T06:00:00Z' }, 2)).cuerpo.total, 50000, 'ya termino');
  // Una hora futura de la caja no cuenta: se usa la del servidor, fuera de la ventana.
  assert.equal((await venta({ creado_en: '2999-01-01T00:00:00Z' }, 2)).cuerpo.total, 50000);
  // Con un descuento aprobado, se suman los dos.
  const id = await pedidoResuelto({ tipo: 'monto', valor: 5000, subtotal: 50000 }, true);
  const ambos = await venta({ creado_en: dentro, descuento_id: id }, 2);
  assert.equal(ambos.cuerpo.descuento, 15000);
  assert.equal(ambos.cuerpo.total, 35000);
});

test('promo con cupo (Issue #250): en linea se rechaza al agotarse, sin red se respeta y cancelar devuelve el lugar', async () => {
  const { db, env, venta, pedir, ana } = await montar();
  Object.assign(env, { PROMO_DESDE: '2026-01-01T06:00:00Z', PROMO_HASTA: '2026-01-08T06:00:00Z', PROMO_CUPO: '2' });
  const dentro = '2026-01-03T20:00:00Z';
  const restantes = async () => (await pedir('/api/vales/config', undefined, 'GET', ana)).cuerpo.promo.restantes;
  assert.equal(await restantes(), 2);
  const primera = await venta({ creado_en: dentro, promo: 10000 }, 2);
  assert.equal(primera.cuerpo.total, 40000);
  // Una caja vieja no manda `promo`: cuenta igual.
  assert.equal((await venta({ creado_en: dentro }, 2)).cuerpo.total, 40000);
  assert.equal(await restantes(), 0);

  const agotada = await venta({ creado_en: dentro, promo: 10000 }, 2);
  assert.equal(agotada.status, 409);
  assert.equal(agotada.cuerpo.promo_agotada, true);
  // La caja ya sabe que se acabo: cobra completo.
  assert.equal((await venta({ creado_en: dentro, promo: 0 }, 2)).cuerpo.total, 50000);
  // Cobrada sin red con la promo: el cliente ya pago asi, se respeta aunque pase del tope.
  assert.equal((await venta({ creado_en: dentro, promo: 10000, sin_red: true }, 2)).cuerpo.total, 40000);
  assert.equal(await restantes(), 0);

  // Un ticket con promo cancelado devuelve su lugar (la ventana de cancelar ya paso para enero: directo en D1).
  db.prepare('update ventas set cancelada = 1 where id = ?').run(primera.cuerpo.id);
  assert.equal(await restantes(), 0, '3 con promo (una sin red) y una cancelada: siguen 2 de 2');
  db.prepare(`update ventas set cancelada = 1 where id = (select id from ventas where promo > 0 and cancelada = 0 limit 1)`).run();
  assert.equal(await restantes(), 1);
});

test('/reportes: con promo, descuento aprobado, pieza devuelta y ticket cancelado, categorias y top suman lo mismo que el total', async () => {
  const { db, env, pedirDescuento, venta, pedir, ana, como } = await montar();
  const Q = crypto.randomUUID();
  db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, stock, semana_ingreso, creado_en, actualizado_en)
              values (?, 'ED-000002', 'Mesa', 'hogar', 33333, 50, 'S40', '', '')`).run(Q);
  db.prepare(`update productos set categoria = 'ropa' where id = ?`).run(PRODUCTO);
  const lineas = (p: number, q: number) => [{ producto_id: PRODUCTO, cantidad: p }, ...(q ? [{ producto_id: Q, cantidad: q }] : [])];
  const aprobar = async (subtotal: number) =>
    (await pedirDescuento({ subtotal, valor: 7, aprobador: DUENO, pin: PIN_DUENO })).cuerpo.id as string;

  // A: solo promo ($100 menos, desde una hora antes hasta manana)
  Object.assign(env, { PROMO_DESDE: new Date(Date.now() - 3_600_000).toISOString(), PROMO_HASTA: new Date(Date.now() + 86_400_000).toISOString() });
  const a = await venta({ lineas: lineas(1, 1), efectivo: 100000 });
  assert.equal(a.cuerpo.descuento, 10000);
  // B: promo + descuento aprobado
  const b = await venta({ lineas: lineas(2, 1), efectivo: 100000, descuento_id: await aprobar(83333) });
  assert.equal(b.status, 201, JSON.stringify(b.cuerpo));
  // C: sin promo, descuento aprobado y una pieza devuelta
  delete (env as any).PROMO_DESDE;
  const folioC = crypto.randomUUID();
  assert.equal((await venta({ id: folioC, lineas: lineas(2, 1), efectivo: 100000, descuento_id: await aprobar(83333) })).status, 201);
  const lineaC = (db.prepare('select id from venta_lineas where venta_id = ? and producto_id = ?').get(folioC, PRODUCTO) as any).id;
  assert.equal((await pedir(`/api/ventas/${folioC}/lineas/${lineaC}/cancelar`,
    { id: crypto.randomUUID(), cantidad: 1, motivo: 'defecto', caja: 'Caja 1' }, 'POST', ana)).status, 201);
  // D: cancelado completo
  const d = await venta({ lineas: lineas(1, 0) });
  assert.equal((await pedir(`/api/ventas/${d.cuerpo.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' }, 'POST', ana)).status, 200);

  como(DUENO);
  const r = (await pedir('/api/reportes?dias=7')).cuerpo;
  const suma = (filas: { total: number }[]) => filas.reduce((s, f) => s + f.total, 0);
  assert.ok(r.resumen.total > 0 && r.resumen.total < 58333 + 83333 * 2, 'hay descuentos de por medio');
  assert.equal(suma(r.por_categoria), r.resumen.total);
  assert.equal(suma(r.top_productos), r.resumen.total);
  assert.deepEqual(verificarCuadre(r).filter((c: { ok: boolean }) => !c.ok), []);
});
