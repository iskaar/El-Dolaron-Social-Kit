// node --test src/descuentos.test.ts
// Descuentos con aprobacion del dueno (Issue #119).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { descuentoDe, totales } from '../public/venta.js';

const ANA = 'ana@prueba.mx';

function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
                values ('${ANA}', 'Ana', 'cajero', 1, '', '', '')`).run();
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  const pedirDescuento = (cuerpo: object) => t.pedir('/api/descuentos', { motivo: 'cliente frecuente', subtotal: 25000, ...cuerpo });
  const venta = (extra: object = {}, cantidad = 1) => t.pedir('/api/ventas', {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad }], forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1', ...extra,
  });
  /** Ana pide, el dueno resuelve; devuelve el id de la solicitud. */
  const pedidoResuelto = async (cuerpo: object, aprobar: boolean) => {
    como(ANA);
    const { cuerpo: pedido } = await pedirDescuento(cuerpo);
    como(DUENO);
    await t.pedir(`/api/solicitudes/${pedido.id}/resolver`, { aprobar });
    como(ANA);
    return pedido.id as string;
  };
  return { ...t, como, pedirDescuento, venta, pedidoResuelto };
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

test('flujo completo: pide Ana, aprueba el dueno, la venta sale con el descuento', async () => {
  const { db, pedidoResuelto, venta, pedir } = montar();
  const id = await pedidoResuelto({ tipo: 'porcentaje', valor: 10 }, true);
  assert.equal((await pedir(`/api/descuentos/${id}`)).cuerpo.estado, 'aprobada');

  const r = await venta({ descuento_id: id });
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.total, 22500);
  assert.equal(r.cuerpo.descuento, 2500);
  assert.equal(r.cuerpo.cambio, 27500);
  assert.deepEqual({ ...db.prepare('select total, descuento, descuento_id from ventas').get() },
    { total: 22500, descuento: 2500, descuento_id: id });
});

test('pendiente o rechazado no descuenta: la venta se rechaza', async () => {
  const { pedirDescuento, como, venta, pedidoResuelto } = montar();
  como(ANA);
  const { cuerpo: pendiente } = await pedirDescuento({ tipo: 'monto', valor: 2000 });
  const sinAprobar = await venta({ descuento_id: pendiente.id });
  assert.equal(sinAprobar.status, 409);
  assert.match(sinAprobar.cuerpo.error, /pendiente/);

  const rechazado = await pedidoResuelto({ tipo: 'monto', valor: 2000 }, false);
  assert.equal((await venta({ descuento_id: rechazado })).status, 409);
  assert.equal((await venta({ descuento_id: crypto.randomUUID() })).status, 400);
});

test('una aprobacion sirve para una sola venta', async () => {
  const { db, pedidoResuelto, venta } = montar();
  const id = await pedidoResuelto({ tipo: 'porcentaje', valor: 20 }, true);
  assert.equal((await venta({ descuento_id: id })).status, 201);
  const otra = await venta({ descuento_id: id });
  assert.equal(otra.status, 409);
  assert.match(otra.cuerpo.error, /ya se uso/);
  assert.equal(db.prepare('select count(*) as n from ventas').get()!.n, 1);
});

test('si el ticket cambia despues de aprobar, la aprobacion ya no vale', async () => {
  const { pedidoResuelto, venta } = montar();
  const id = await pedidoResuelto({ tipo: 'porcentaje', valor: 50 }, true);
  const dosPiezas = await venta({ descuento_id: id }, 2);
  assert.equal(dosPiezas.status, 409);
  assert.match(dosPiezas.cuerpo.error, /cambio/);
  assert.equal((await venta({ descuento_id: id })).status, 201);   // el ticket original si
});

test('el servidor rechaza pedir de mas: sin motivo, sobre el tope o con valores raros', async () => {
  const { pedirDescuento, como } = montar();
  como(ANA);
  assert.equal((await pedirDescuento({ tipo: 'porcentaje', valor: 10, motivo: '  ' })).status, 400);
  assert.equal((await pedirDescuento({ tipo: 'porcentaje', valor: 60 })).status, 400);
  assert.equal((await pedirDescuento({ tipo: 'monto', valor: 20000 })).status, 400);
  assert.equal((await pedirDescuento({ tipo: 'monto', valor: 100, subtotal: 0 })).status, 400);
  assert.equal((await pedirDescuento({ tipo: 'porcentaje', valor: 'x' })).status, 400);
});

test('el cajero no se aprueba a si mismo, y solo ve sus solicitudes', async () => {
  const { pedirDescuento, como, pedir, db } = montar();
  como(ANA);
  const { cuerpo } = await pedirDescuento({ tipo: 'porcentaje', valor: 10 });
  assert.equal((await pedir(`/api/solicitudes/${cuerpo.id}/resolver`, { aprobar: true })).status, 403);
  assert.equal(db.prepare('select estado from solicitudes where id = ?').get(cuerpo.id)!.estado, 'pendiente');

  db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en)
              values ('otra@prueba.mx', 'Otra', 'cajero', 1, '', '', '')`).run();
  como('otra@prueba.mx');
  assert.equal((await pedir(`/api/descuentos/${cuerpo.id}`)).status, 404);
  como(DUENO);
  assert.equal((await pedir(`/api/descuentos/${cuerpo.id}`)).status, 200);
});

test('pedir otro reemplaza el anterior, y el dueno lo ve en /cuentas con el monto', async () => {
  const { pedirDescuento, como, pedir } = montar();
  como(ANA);
  const primero = (await pedirDescuento({ tipo: 'porcentaje', valor: 10 })).cuerpo.id;
  const segundo = (await pedirDescuento({ tipo: 'monto', valor: 3000 })).cuerpo.id;
  assert.equal((await pedir(`/api/descuentos/${primero}`)).cuerpo.estado, 'rechazada');
  como(DUENO);
  const { cuerpo } = await pedir('/api/cuentas');
  const pendientes = cuerpo.solicitudes.filter((s: { tipo: string }) => s.tipo === 'descuento');
  assert.equal(pendientes.length, 1);
  assert.equal(pendientes[0].id, segundo);
  assert.equal(JSON.parse(pendientes[0].datos).monto, 3000);
});
