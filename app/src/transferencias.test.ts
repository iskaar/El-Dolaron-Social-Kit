// node --test src/transferencias.test.ts
// Clave de rastreo SPEI de cada transferencia (#593, paso 1): obligatoria donde se decidio, unica en toda la tienda
// por indice de D1, monto del comprobante, reintentos idempotentes. SQLite real con todas las migraciones.
// Todas las claves de este archivo son sinteticas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tienda, PRODUCTO, DUENO, datosTransferencia } from './prueba-d1.ts';
import { transferenciaDe, claveRastreoDe, CLAVE_DESDE } from '../public/venta.js';

type Tienda = ReturnType<typeof tienda>;
const claves = (db: DatabaseSync) => db.prepare('select * from transferencias_spei order by id').all() as Record<string, any>[];
const cuenta = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

// PRODUCTO vale $250 y hay 50: dos piezas son $500 por transferencia.
const venta = (t: Tienda, extra: Record<string, unknown> = {}) => {
  const cuerpo = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'transferencia',
    caja: 'Caja 1', promo: 0, ...extra };
  return t.pedir('/api/ventas', cuerpo).then((r) => ({ ...r, id: cuerpo.id as string }));
};
const apartar = (t: Tienda, extra: Record<string, unknown> = {}) => {
  const cuerpo = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], cliente: 'Ana', telefono: '4441234567',
    entrega: 'envio', anticipo: 10000, forma_pago: 'transferencia', caja: 'Caja 1', ...extra };
  return t.pedir('/api/pedidos', cuerpo).then((r) => ({ ...r, id: cuerpo.id as string }));
};
const abonar = (t: Tienda, folio: number, importe: number, extra: Record<string, unknown> = {}) => {
  const cuerpo = { id: crypto.randomUUID(), importe, forma_pago: 'transferencia', caja: 'Caja 1', ...extra };
  return t.pedir(`/api/pedidos/${folio}/abonos`, cuerpo).then((r) => ({ ...r, id: cuerpo.id as string }));
};
const pieza = (db: DatabaseSync, precio: number) => {
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, 'Pieza', ?, 5, 'listo', 'fotos/x.jpg', 'S40', '', '')`).run(id, `ED-${String(900000 + precio)}`, precio);
  return id;
};

/** Las dos solicitudes llegan al batch con sus lecturas hechas: la segunda debe perder dentro del SQL. */
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

test('la clave se normaliza (mayusculas, sin espacios) y solo acepta 6 a 30 letras y numeros', () => {
  assert.equal(claveRastreoDe('  ejemplo 1234\n56  '), 'EJEMPLO123456');
  const ok = (clave: string) => transferenciaDe({ clave, transferido: 50000, debido: 50000 });
  assert.equal(ok(' ejemplo 123456 ').ok, true);
  assert.equal(ok('A'.repeat(30)).ok, true);
  for (const mala of ['', '   ', 'ABC12', 'A'.repeat(31), 'EJEMPLO-123456', 'ÑANDÚ12345', 'EJEMPLO_123456', 'EJEMPLO.123456']) {
    const r = ok(mala);
    assert.equal(r.ok, false, mala);
    assert.equal((r as { campo: string }).campo, 'clave');
  }
});

test('el monto: menos de lo debido se rechaza, igual o mas se acepta y el excedente se anota', () => {
  const clave = 'EJEMPLO123456';
  assert.deepEqual(transferenciaDe({ clave, transferido: 50000, debido: 50000 }), { ok: true, clave, transferido: 50000, aplicado: 50000, excedente: 0 });
  assert.deepEqual(transferenciaDe({ clave, transferido: 60000, debido: 50000 }), { ok: true, clave, transferido: 60000, aplicado: 50000, excedente: 10000 });
  const poco = transferenciaDe({ clave, transferido: 49999, debido: 50000 });
  assert.equal(poco.ok, false);
  assert.match((poco as { error: string }).error, /\$499\.99 y se cobran \$500\.00.*\(\$0\.01\)/);
  for (const raro of [0, -5, NaN, 10.5, Infinity]) assert.equal(transferenciaDe({ clave, transferido: raro, debido: 50000 }).ok, false, String(raro));
});

test('caja: bajo $300 no pide clave; desde $300 si, y queda confirmada por cajero con quien la registro', async () => {
  const t = tienda();
  assert.equal(CLAVE_DESDE, 30000);
  const chica = await venta(t, { lineas: [{ producto_id: pieza(t.db, 29999), cantidad: 1 }] });
  assert.equal(chica.status, 201, JSON.stringify(chica.cuerpo));
  assert.equal(claves(t.db).length, 0);
  const justa = await venta(t, { lineas: [{ producto_id: pieza(t.db, 30000), cantidad: 1 }] });
  assert.equal(justa.status, 400);
  assert.equal(justa.cuerpo.campo, 'clave');
  assert.match(justa.cuerpo.error, /clave de rastreo/);
  assert.equal(cuenta(t.db, 'select count(*) as n from ventas'), 1);   // solo la chica
  // Efectivo y tarjeta de $500 siguen igual.
  assert.equal((await venta(t, { forma_pago: 'tarjeta' })).status, 201);
  assert.equal((await venta(t, { forma_pago: 'efectivo', efectivo: 50000 })).status, 201);
  const ok = await venta(t, { clave_rastreo: ' ejemplo 000111 ', monto_transferido: 50000 });
  assert.equal(ok.status, 201, JSON.stringify(ok.cuerpo));
  assert.equal(ok.cuerpo.excedente_transferencia, 0);
  const [fila] = claves(t.db);
  assert.equal(fila.clave_rastreo, 'EJEMPLO000111');
  assert.equal(fila.monto, 50000);
  assert.equal(fila.aplicado, 50000);
  assert.equal(fila.origen, 'venta');
  assert.equal(fila.venta_id, ok.id);
  assert.equal(fila.verificacion, 'cajero');
  assert.equal(fila.registrado_por, DUENO);
  assert.ok(fila.registrado_en);
});

test('caja: bajo $300 una clave voluntaria tambien cuenta y no se puede repetir', async () => {
  const t = tienda();
  const uno = await venta(t, { lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], clave_rastreo: 'CHICA0000001', monto_transferido: 25000 });
  assert.equal(uno.status, 201);
  const dos = await venta(t, { lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], clave_rastreo: 'chica0000001', monto_transferido: 25000 });
  assert.equal(dos.status, 409);
});

test('la misma clave se rechaza la segunda vez, entre un ticket de caja y un pedido, sin dejar nada a medias', async () => {
  const t = tienda();
  const datos = datosTransferencia(50000);
  const v = await venta(t, datos);
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));
  const stock = cuenta(t.db, `select stock as n from productos where id = '${PRODUCTO}'`);

  const otra = await venta(t, { ...datos, clave_rastreo: datos.clave_rastreo.toLowerCase() });
  assert.equal(otra.status, 409);
  assert.equal(otra.cuerpo.campo, 'clave');
  assert.match(otra.cuerpo.error, /Esa clave de rastreo ya se usó en el ticket [0-9A-F]{8}/);
  assert.equal(cuenta(t.db, 'select count(*) as n from ventas'), 1);
  assert.equal(cuenta(t.db, `select stock as n from productos where id = '${PRODUCTO}'`), stock);

  // Un anticipo de pedido con esa clave: igual.
  const anticipo = await apartar(t, { clave_rastreo: datos.clave_rastreo, monto_transferido: 10000 });
  assert.equal(anticipo.status, 409);
  assert.equal(cuenta(t.db, 'select count(*) as n from pedidos'), 0);

  // Y a la inversa: la clave de un anticipo no sirve en la caja ni en un abono.
  const ap = await apartar(t, datosTransferencia(10000));
  assert.equal(ap.status, 201, JSON.stringify(ap.cuerpo));
  const folio = ap.cuerpo.pedido.folio;
  const usadaEnPedido = claves(t.db).at(-1)!.clave_rastreo as string;
  const enCaja = await venta(t, { clave_rastreo: usadaEnPedido, monto_transferido: 50000 });
  assert.equal(enCaja.status, 409);
  assert.match(enCaja.cuerpo.error, new RegExp(`en el pedido P-${folio}\\.`));
  const saldo = () => cuenta(t.db, `select saldo as n from pedidos where folio = ${folio}`);
  const movimientos = () => cuenta(t.db, 'select count(*) as n from pedido_movimientos');
  const antes = [saldo(), movimientos()];
  const enAbono = await abonar(t, folio, 5000, { clave_rastreo: datos.clave_rastreo, monto_transferido: 5000 });
  assert.equal(enAbono.status, 409);
  assert.match(enAbono.cuerpo.error, /ya se usó en el ticket/);
  assert.deepEqual([saldo(), movimientos()], antes);   // el abono rechazado no movio el saldo
  assert.equal(claves(t.db).length, 2);
});

test('dos cobros simultaneos con la misma clave: uno gana, el otro recibe 409 y no registra venta ni baja existencias', async () => {
  for (const caso of ['caja-caja', 'caja-anticipo', 'abono-abono']) {
    const t = tienda();
    const datos = datosTransferencia(50000);
    // Dos paquetes distintos: en el mismo, la revision del pedido pararia al perdedor antes de llegar a la clave.
    const folios: number[] = [];
    if (caso === 'abono-abono') for (let i = 0; i < 2; i++) folios.push((await apartar(t, datosTransferencia(10000))).cuerpo.pedido.folio);
    const stock = cuenta(t.db, `select stock as n from productos where id = '${PRODUCTO}'`);
    const ventas = cuenta(t.db, 'select count(*) as n from ventas');
    const previas = claves(t.db).length;
    juntarDosBatches(t.env);
    const resultados = await Promise.all(caso === 'caja-caja' ? [venta(t, datos), venta(t, datos)]
      : caso === 'caja-anticipo' ? [venta(t, datos), apartar(t, { ...datos, monto_transferido: 10000 })]
      : folios.map((folio) => abonar(t, folio, 5000, { ...datos, monto_transferido: 5000 })));
    const estados = resultados.map((r) => r.status);
    assert.equal(estados.filter((s) => s < 300).length, 1, `${caso}: ${estados}`);
    const perdedor = resultados.find((r) => r.status === 409)!;
    assert.ok(perdedor, `${caso}: ${estados}`);
    assert.equal(perdedor.cuerpo.campo, 'clave', caso);
    assert.equal(claves(t.db).length, previas + 1, caso);
    if (caso === 'caja-caja') {
      assert.equal(cuenta(t.db, 'select count(*) as n from ventas'), ventas + 1);
      assert.equal(cuenta(t.db, `select stock as n from productos where id = '${PRODUCTO}'`), stock - 2);
    }
    if (caso === 'abono-abono') assert.equal(cuenta(t.db, 'select sum(saldo) as n from pedidos'), 25000);   // dos anticipos de $100 y un solo abono de $50
    if (caso === 'caja-anticipo') {
      assert.equal(cuenta(t.db, 'select count(*) as n from ventas') + cuenta(t.db, 'select count(*) as n from pedidos'), ventas + 1);
    }
  }
});

test('un reintento del mismo cobro devuelve el resultado original, no «ya se uso»', async () => {
  const t = tienda();
  // Caja.
  const datos = datosTransferencia(60000);
  const cuerpo = { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'transferencia', caja: 'Caja 1', promo: 0, ...datos };
  const primera = await t.pedir('/api/ventas', cuerpo);
  assert.equal(primera.status, 201);
  assert.equal(primera.cuerpo.excedente_transferencia, 10000);
  const reintento = await t.pedir('/api/ventas', cuerpo);
  assert.equal(reintento.status, 200);
  assert.equal(reintento.cuerpo.duplicada, true);
  assert.equal(reintento.cuerpo.excedente_transferencia, 10000);
  // Con otra clave el mismo folio ya es otra venta.
  assert.equal((await t.pedir('/api/ventas', { ...cuerpo, clave_rastreo: 'OTRA00000001' })).status, 409);
  assert.equal(cuenta(t.db, 'select count(*) as n from ventas'), 1);
  assert.equal(claves(t.db).length, 1);

  // Anticipo de pedido.
  const ap = await apartar(t, datosTransferencia(10000));
  assert.equal(ap.status, 201);
  const otra = await t.pedir('/api/pedidos', { id: ap.id, lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], cliente: 'Ana', telefono: '4441234567',
    entrega: 'envio', anticipo: 10000, forma_pago: 'transferencia', caja: 'Caja 1',
    clave_rastreo: claves(t.db).at(-1)!.clave_rastreo, monto_transferido: 10000 });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.pedido.folio, ap.cuerpo.pedido.folio);
  assert.equal(cuenta(t.db, 'select count(*) as n from pedidos'), 1);

  // Abono: el mismo ID y el mismo contenido devuelven la respuesta guardada; la clave no choca consigo misma.
  const abono = { id: crypto.randomUUID(), importe: 5000, forma_pago: 'transferencia', caja: 'Caja 1', ...datosTransferencia(7000) };
  const a1 = await t.pedir(`/api/pedidos/${ap.cuerpo.pedido.folio}/abonos`, abono);
  const a2 = await t.pedir(`/api/pedidos/${ap.cuerpo.pedido.folio}/abonos`, abono);
  assert.equal(a1.status, 200, JSON.stringify(a1.cuerpo));
  assert.equal(a2.status, 200);
  assert.deepEqual(a2.cuerpo, a1.cuerpo);
  assert.equal(a1.cuerpo.excedente_transferencia, 2000);
  assert.equal(cuenta(t.db, `select saldo as n from pedidos where id = '${ap.id}'`), 15000);
  // El mismo ID con otra clave es otro movimiento: 409 sin tocar nada.
  assert.equal((await t.pedir(`/api/pedidos/${ap.cuerpo.pedido.folio}/abonos`, { ...abono, clave_rastreo: 'OTRA00000002' })).status, 409);
  assert.equal(claves(t.db).length, 3);
});

test('transferencia de menos se rechaza en caja, anticipo y abono; no se registra nada', async () => {
  const t = tienda();
  const caja = await venta(t, { clave_rastreo: 'POCO00000001', monto_transferido: 49999 });
  assert.equal(caja.status, 400);
  assert.equal(caja.cuerpo.campo, 'monto');
  assert.match(caja.cuerpo.error, /Pídele al cliente que transfiera lo que falta/);
  const sinMonto = await venta(t, { clave_rastreo: 'POCO00000001' });
  assert.equal(sinMonto.status, 400);
  assert.equal(sinMonto.cuerpo.campo, 'monto');
  const ant = await apartar(t, { clave_rastreo: 'POCO00000002', monto_transferido: 9999 });
  assert.equal(ant.status, 400);
  assert.equal(cuenta(t.db, 'select count(*) as n from ventas') + cuenta(t.db, 'select count(*) as n from pedidos'), 0);
  assert.equal(cuenta(t.db, `select stock as n from productos where id = '${PRODUCTO}'`), 50);

  const ap = await apartar(t, datosTransferencia(10000));
  const folio = ap.cuerpo.pedido.folio;
  const ab = await abonar(t, folio, 5000, { clave_rastreo: 'POCO00000003', monto_transferido: 4999 });
  assert.equal(ab.status, 400);
  assert.equal(ab.cuerpo.campo, 'monto');
  assert.equal(cuenta(t.db, 'select count(*) as n from pedido_movimientos'), 0);
  assert.equal(cuenta(t.db, `select saldo as n from pedidos where folio = ${folio}`), 10000);
  assert.equal(claves(t.db).length, 1);   // solo el anticipo bueno
  // La clave rechazada por monto sigue libre.
  assert.equal((await abonar(t, folio, 5000, { clave_rastreo: 'POCO00000003', monto_transferido: 5000 })).status, 200);
});

test('transferencia de mas: se registra solo lo debido, se guarda lo transferido y el corte suma lo debido', async () => {
  const t = tienda();
  const v = await venta(t, { clave_rastreo: 'MUCHO0000001', monto_transferido: 65000 });
  assert.equal(v.status, 201);
  assert.equal(v.cuerpo.total, 50000);
  assert.equal(v.cuerpo.excedente_transferencia, 15000);
  assert.deepEqual([claves(t.db)[0].monto, claves(t.db)[0].aplicado], [65000, 50000]);

  const ap = await apartar(t, { clave_rastreo: 'MUCHO0000002', monto_transferido: 12000 });
  assert.equal(ap.status, 201);
  assert.equal(ap.cuerpo.excedente_transferencia, 2000);
  assert.equal(ap.cuerpo.pedido.anticipo, 10000);
  assert.equal(ap.cuerpo.pedido.saldo, 10000);
  const ab = await abonar(t, ap.cuerpo.pedido.folio, 5000, { clave_rastreo: 'MUCHO0000003', monto_transferido: 8000 });
  assert.equal(ab.status, 200);
  assert.equal(ab.cuerpo.excedente_transferencia, 3000);
  assert.equal(cuenta(t.db, `select saldo as n from pedidos where id = '${ap.id}'`), 15000);   // no sube por el excedente

  // Corte: solo lo debido entra a «Transferencias» (500 + 100 + 50).
  const corte = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 50000 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.transferencias, 65000);
});

test('efectivo y tarjeta no piden clave; una transferencia de apartado o abono sin clave se rechaza', async () => {
  const t = tienda();
  assert.equal((await apartar(t, { forma_pago: 'tarjeta' })).status, 201);
  assert.equal((await apartar(t, { forma_pago: 'efectivo' })).status, 201);
  const sin = await apartar(t, { clave_rastreo: '', monto_transferido: 10000 });
  assert.equal(sin.status, 400);
  assert.equal(sin.cuerpo.campo, 'clave');
  assert.equal(cuenta(t.db, 'select count(*) as n from pedidos'), 2);
  const ap = await apartar(t, { forma_pago: 'efectivo' });
  const folio = ap.cuerpo.pedido.folio;
  assert.equal((await abonar(t, folio, 1000, { forma_pago: 'efectivo' })).status, 200);
  assert.equal((await abonar(t, folio, 1000, { forma_pago: 'tarjeta' })).status, 200);
  const sinClave = await abonar(t, folio, 1000, { clave_rastreo: '', monto_transferido: 1000 });
  assert.equal(sinClave.status, 400);
  assert.equal(sinClave.cuerpo.campo, 'clave');
  assert.equal(claves(t.db).length, 0);
});

test('si el abono falla despues de leer, la clave no queda gastada', async () => {
  const t = tienda();
  const ap = await apartar(t, datosTransferencia(10000));
  const folio = ap.cuerpo.pedido.folio;
  const datos = { clave_rastreo: 'ATOMICA00001', monto_transferido: 5000 };
  // El paquete se cancela entre la lectura y el batch: el pago aborta y, con el, la fila de la clave.
  const batch = t.env.DB.batch.bind(t.env.DB);
  t.env.DB.batch = (async (sentencias: D1PreparedStatement[]) => {
    t.env.DB.batch = batch;
    t.db.prepare("update pedidos set estado = 'cancelado', revision = revision + 1 where folio = ?").run(folio);
    return batch(sentencias);
  }) as typeof t.env.DB.batch;
  const fallido = await abonar(t, folio, 5000, datos);
  assert.equal(fallido.status, 409, JSON.stringify(fallido.cuerpo));
  assert.equal(cuenta(t.db, 'select count(*) as n from pedido_movimientos'), 0);
  assert.equal(claves(t.db).some((c) => c.clave_rastreo === 'ATOMICA00001'), false);
  // La clave sigue libre para un pago bueno.
  const otro = await apartar(t, datosTransferencia(10000));
  assert.equal((await abonar(t, otro.cuerpo.pedido.folio, 5000, datos)).status, 200);
});

test('cancelar o devolver no libera la clave: queda usada', async () => {
  const t = tienda();
  const ap = await apartar(t, datosTransferencia(10000));
  const clave = claves(t.db)[0].clave_rastreo as string;
  assert.equal((await t.pedir(`/api/pedidos/${ap.cuerpo.pedido.folio}/cancelar`, {})).status, 200);
  const v = await venta(t, datosTransferencia(50000));
  assert.equal(v.status, 201);
  const cancelada = await t.pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'error de cobro', caja: 'Caja 1' });
  assert.equal(cancelada.status, 200, JSON.stringify(cancelada.cuerpo));
  assert.equal(claves(t.db).length, 2);
  for (const usada of [clave, claves(t.db)[1].clave_rastreo as string]) {
    const r = await venta(t, { clave_rastreo: usada, monto_transferido: 50000 });
    assert.equal(r.status, 409, usada);
  }
});

test('el indice unico de D1 impide la clave repetida aunque el codigo no la revise', async () => {
  const t = tienda();
  const v = await venta(t, datosTransferencia(50000));
  const w = await venta(t, datosTransferencia(50000));
  assert.deepEqual([v.status, w.status], [201, 201]);
  const insertar = (clave: string, ventaId: string) => t.db.prepare(`insert into transferencias_spei
    (clave_rastreo, monto, aplicado, origen, venta_id, registrado_por, registrado_en) values (?, 1, 1, 'venta', ?, 'x', '')`).run(clave, ventaId);
  assert.throws(() => insertar(claves(t.db)[0].clave_rastreo, w.id), /UNIQUE constraint failed: transferencias_spei\.clave_rastreo/);
  assert.throws(() => insertar('minuscula1', w.id), /CHECK/);
  assert.throws(() => t.db.prepare(`insert into transferencias_spei (clave_rastreo, monto, aplicado, origen, registrado_por, registrado_en)
    values ('SINORIGEN001', 1, 1, 'venta', 'x', '')`).run(), /CHECK/);
});
