// node --test src/devoluciones.test.ts
// Desglose del ticket y cancelacion por pieza (Issue #138) contra SQLite real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tienda, PRODUCTO, codigoPrueba } from './prueba-d1.ts';
import { repartirDevolucion } from './devoluciones.ts';

type Pedir = ReturnType<typeof tienda>['pedir'];

// Dos piezas de $250 del producto de prueba, en efectivo, en la Caja 1.
const vender = async (pedir: Pedir, extra: Record<string, unknown> = {}) => {
  const venta = {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 2 }],
    forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1', ...extra,
  };
  const r = await pedir('/api/ventas', venta);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return venta.id;
};
const detalle = async (pedir: Pedir, id: string) => (await pedir(`/api/ventas/${id}`)).cuerpo;
const cancelarPieza = (pedir: Pedir, ventaId: string, lineaId: number, extra: Record<string, unknown> = {}) =>
  pedir(`/api/ventas/${ventaId}/lineas/${lineaId}/cancelar`, {
    id: crypto.randomUUID(), cantidad: 1, motivo: 'no le quedo', caja: 'Caja 1', ...extra,
  });
const stock = (db: ReturnType<typeof tienda>['db']) =>
  (db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock;
const cortar = (pedir: Pedir, contado: number) =>
  pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: contado, tarjeta_terminal: 0 });

test('dinero primero: la pieza sale en dinero hasta lo cobrado en dinero, el resto en Dolarones', () => {
  const base = { pagado: 40000, devuelto: 0, dolarones: 10000, dolaronesDevueltos: 0 };
  assert.deepEqual(repartirDevolucion({ ...base, importe: 25000 }), { dinero: 25000, dolarones: 0 });
  assert.deepEqual(repartirDevolucion({ ...base, importe: 25000, devuelto: 25000 }), { dinero: 15000, dolarones: 10000 });
  assert.deepEqual(repartirDevolucion({ ...base, importe: 5000, devuelto: 40000, dolaronesDevueltos: 8000 }),
    { dinero: 0, dolarones: 2000 });
});

test('cancelar una pieza: regresa la existencia, deja huella y el corte resta solo esa pieza', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  const antes = stock(db);
  const ticket = await detalle(pedir, id);
  assert.equal(ticket.lineas.length, 1);
  assert.equal(ticket.lineas[0].cantidad, 2);

  const r = await cancelarPieza(pedir, id, ticket.lineas[0].id);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devuelto, 25000);
  assert.equal(stock(db), antes + 1);

  const despues = await detalle(pedir, id);
  assert.equal(despues.cancelada, 0);
  assert.equal(despues.devuelto, 25000);
  assert.equal(despues.lineas[0].cancelada_cantidad, 1);
  assert.equal(despues.devoluciones.length, 1);
  assert.equal(despues.devoluciones[0].motivo, 'no le quedo');
  assert.equal(despues.devoluciones[0].caja, 'Caja 1');

  // 500 de fondo + 250 que quedaron vendidos: la pieza se devolvio antes del corte (#123)
  const c = (await cortar(pedir, 75000)).cuerpo;
  assert.equal(c.efectivo_ventas, 25000);
  assert.equal(c.efectivo_devoluciones, 0);
  assert.equal(c.diferencia, 0);

  // El dia de la caja y los reportes cuentan lo que quedo vendido.
  const dia = (await pedir('/api/ventas')).cuerpo;
  assert.equal(dia.total, 25000);
  assert.equal(dia.piezas, 1);
  const rep = (await pedir('/api/reportes')).cuerpo;
  assert.equal(rep.resumen.total, 25000);
  assert.equal(rep.resumen.piezas, 1);
  assert.equal(rep.cancelaciones.n, 1);
  assert.equal(rep.cancelaciones.detalle[0].piezas, '1 × Ventilador');
});

test('reenviar la misma cancelacion no devuelve dos veces, y no se cancela mas de lo vendido', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  const linea = (await detalle(pedir, id)).lineas[0].id;
  const antes = stock(db);

  const mismo = crypto.randomUUID();
  assert.equal((await cancelarPieza(pedir, id, linea, { id: mismo })).status, 201);
  const otra = await cancelarPieza(pedir, id, linea, { id: mismo });
  assert.equal(otra.cuerpo.duplicada, true);
  assert.equal(stock(db), antes + 1);

  assert.equal((await cancelarPieza(pedir, id, linea, { cantidad: 2 })).status, 400);
  assert.equal((await cancelarPieza(pedir, id, linea)).status, 201);
  assert.equal((await cancelarPieza(pedir, id, linea)).status, 409);
  assert.equal(stock(db), antes + 2);
  assert.equal((await cancelarPieza(pedir, id, linea, { motivo: '' })).status, 400);
});

test('cancelar el ticket completo despues de una pieza devuelve solo lo que quedaba', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  const antes = stock(db);
  await cancelarPieza(pedir, id, (await detalle(pedir, id)).lineas[0].id);

  const r = await pedir(`/api/ventas/${id}/cancelar`, { motivo: 'se arrepintio', caja: 'Caja 1' });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devuelto, 25000);
  assert.equal(stock(db), antes + 2);

  // Y ya no se pueden cancelar piezas de un ticket cancelado.
  assert.equal((await cancelarPieza(pedir, id, (await detalle(pedir, id)).lineas[0].id)).status, 409);

  const c = (await cortar(pedir, 50000)).cuerpo;    // cancelado antes del corte: solo el fondo (#123)
  assert.equal(c.efectivo_ventas, 0);
  assert.equal(c.efectivo_devoluciones, 0);
  assert.equal(c.diferencia, 0);

  const rep = (await pedir('/api/reportes')).cuerpo;
  assert.equal(rep.cancelaciones.total, 50000);     // 250 de la pieza + 250 del resto
});

test('con Dolarones: primero sale el dinero; lo pagado con D regresa al saldo y lo ganado se recalcula', async () => {
  const { db, pedir } = tienda();
  const socio = (await pedir('/api/socios', {
    id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000', acepta_bases: true, declara_mayor_edad: true,
  })).cuerpo;
  // Compra previa: las altas ya no entregan regalo automático ni aceptan PIN de socio.
  await vender(pedir, { cliente_id: socio.id });
  db.prepare("update dolarones_lotes set disponible_desde = '2000-01-01T00:00:00Z'").run();
  const saldoInicial = (await pedir('/api/socios?q=4449990000')).cuerpo.disponible;

  // $500: 50 D + $450 en efectivo. Gana 40 D.
  const id = await vender(pedir, { cliente_id: socio.id, dolarones: 5000,
    codigo_socio: await codigoPrueba(db, socio.id), efectivo: 45000 });
  const ganado = () => (db.prepare('select restante from dolarones_lotes where venta_id = ?').get(id) as { restante: number }).restante;
  assert.equal(ganado(), 4000);
  const linea = (await detalle(pedir, id)).lineas[0].id;

  const primera = (await cancelarPieza(pedir, id, linea)).cuerpo;
  assert.equal(primera.devuelto, 25000);
  assert.equal(primera.dolarones, 0);
  assert.equal(ganado(), 2000);                     // quedan $200 pagados: 20 D

  const segunda = (await cancelarPieza(pedir, id, linea)).cuerpo;
  assert.equal(segunda.devuelto, 20000);
  assert.equal(segunda.dolarones, 5000);
  assert.equal(ganado(), 0);
  assert.equal((await pedir('/api/socios?q=4449990000')).cuerpo.disponible, saldoInicial);

  const c = (await cortar(pedir, 100000)).cuerpo;   // fondo + compra previa; lo de 450 se devolvio antes del corte
  assert.equal(c.efectivo_devoluciones, 0);
  assert.equal(c.dolarones, 0);                     // 50 D cobrados y 50 D devueltos
  assert.equal(c.diferencia, 0);
});

test('socio: cancelar completo tras una pieza reconoce retiros previos; gastar crédito bloquea la pieza', async () => {
  const t = tienda();
  try {
    const socio = (await t.pedir('/api/socios', { id:crypto.randomUUID(), nombre:'Cliente',
      telefono:'4449990000', acepta_bases:true, declara_mayor_edad:true })).cuerpo;
    const id = await vender(t.pedir, { cliente_id:socio.id });
    const linea = (await detalle(t.pedir, id)).lineas[0].id;
    assert.equal((await cancelarPieza(t.pedir, id, linea)).status, 201);
    const r = await t.pedir(`/api/ventas/${id}/cancelar`, { motivo:'resto', caja:'Caja 1' });
    assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
    assert.equal(r.cuerpo.devuelto, 25000);
    assert.equal(stock(t.db), 50);
    assert.equal(t.db.prepare('select restante from dolarones_lotes where venta_id=?').get(id)!.restante, 0);

    const otro = await vender(t.pedir, { cliente_id:socio.id });
    t.db.prepare("update dolarones_lotes set disponible_desde='2000-01-01' where venta_id=?").run(otro);
    assert.equal((await t.pedir('/api/ventas', { id:crypto.randomUUID(),
      lineas:[{ producto_id:PRODUCTO, cantidad:1 }], forma_pago:'efectivo', efectivo:24900,
      cliente_id:socio.id, dolarones:100, codigo_socio:await codigoPrueba(t.db, socio.id) })).status, 201);
    const antes = await detalle(t.pedir, otro);
    assert.equal((await cancelarPieza(t.pedir, otro, antes.lineas[0].id)).status, 409);
    assert.deepEqual(await detalle(t.pedir, otro), antes);
    assert.equal(stock(t.db), 47);
  } finally { t.db.close(); }
});

for (const medio of ['vale', 'socio']) {
  for (const concurrente of [false, true]) {
    for (const precio of [500, 25000]) {
      test(`${medio}: cancelar $${precio / 100} de $255 con 1 D gastado${concurrente ? ' entre lectura y batch' : ''}`, async () => {
        const t = tienda();
        try {
          t.env.VALES_ABIERTOS = medio === 'vale' ? 'si' : 'no';
          const socio = medio === 'socio' ? (await t.pedir('/api/socios', {
            id:crypto.randomUUID(), nombre:'Cliente', telefono:'4449990000',
            acepta_bases:true, declara_mayor_edad:true,
          })).cuerpo : null;
          const barato = crypto.randomUUID();
          t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
            values (?, 'ED-000005', 'Pieza de $5', 500, 3, 'S40', '', '')`).run(barato);
          const id = await vender(t.pedir, { lineas:[
            { producto_id:PRODUCTO, cantidad:1 }, { producto_id:barato, cantidad:1 },
          ], efectivo:25500, cliente_id:socio?.id });
          const tabla = medio === 'vale' ? 'vales_dolarones' : 'dolarones_lotes';
          const credito = t.db.prepare(`select * from ${tabla} where venta_id=?`).get(id)!;
          assert.equal(credito.importe, medio === 'vale' ? 1000 : 2000);
          t.db.prepare(`update ${tabla} set disponible_desde='2000-01-01T00:00:00Z' where id=?`).run(credito.id);
          const ticket = await detalle(t.pedir, id);
          const linea = ticket.lineas.find((l: { precio:number }) => l.precio === precio);
          const estado = () => ['ventas', 'venta_lineas', 'productos', 'devoluciones',
            'vales_dolarones', 'vales_movimientos', 'dolarones_lotes', 'dolarones_movimientos', 'codigos_cliente']
            .map((tabla) => t.db.prepare(`select * from ${tabla} order by 1`).all());
          let antes: ReturnType<typeof estado>;
          const gastar = async () => {
            const canje = await t.pedir('/api/ventas', {
              id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:1 }],
              forma_pago:'efectivo', efectivo:24900, dolarones:100, caja:'Caja 2',
              ...(socio ? { cliente_id:socio.id, codigo_socio:await codigoPrueba(t.db, socio.id) }
                : { codigo_vale:credito.codigo }),
            });
            assert.equal(canje.status, 201, JSON.stringify(canje.cuerpo));
            antes = estado();
          };
          if (concurrente) {
            const batch = t.env.DB.batch.bind(t.env.DB);
            t.env.DB.batch = async (sentencias) => {
              t.env.DB.batch = batch;
              await gastar();
              return batch(sentencias);
            };
          } else await gastar();
          const r = await cancelarPieza(t.pedir, id, linea.id);
          assert.equal(r.status, precio === 500 ? 201 : 409, JSON.stringify(r.cuerpo));
          if (precio === 25000) {
            assert.deepEqual(estado(), antes!); // Dinero, stock, crédito y autorización: rollback completo.
          } else {
            assert.equal(r.cuerpo.devuelto, 500);
            assert.equal(r.cuerpo.dolarones, 0);
            const despues = await detalle(t.pedir, id);
            assert.equal(despues.devuelto, 500);
            assert.equal(despues.revision, ticket.revision + 1);
            assert.equal(despues.lineas.find((l: { id:number }) => l.id === linea.id).cancelada_cantidad, 1);
            assert.equal(despues.devoluciones.length, 1);
            assert.equal(t.db.prepare('select stock from productos where id=?').get(barato)!.stock, 3);
            assert.equal(stock(t.db), 48);
            assert.deepEqual(estado().slice(4), antes!.slice(4)); // Sin retiro ni movimiento cero.
          }
        } finally { t.db.close(); }
      });
    }
  }
}

test('el candado de revision rechaza una cancelacion que leyo un ticket ya cambiado', async () => {
  const { db, pedir } = tienda();
  const id = await vender(pedir);
  db.prepare('update ventas set revision = 1 where id = ?').run(id);
  assert.throws(() => db.prepare('update ventas set revision = 1 where id = ?').run(id), /ticket cambio/);
  assert.throws(() => db.prepare('update venta_lineas set cancelada_cantidad = 3 where venta_id = ?').run(id),
    /pieza ya cancelada/);
});

test('base de main con 015 y 020 admite 016 → 018 → 019 → 021 sin perder ventas ni PIN de cajero', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const pendientes = ['016', '018', '019', '021'];
    const migraciones = readdirSync('.').filter((f) => /^migracion-\d+/.test(f)).sort();
    const aplicar = (f: string) => db.exec(readFileSync(f, 'utf8'));
    aplicar('schema.sql');
    // La base de entonces llegaba hasta la 021; las posteriores (p. ej. 032 altera vales_dolarones) van al final.
    const posteriores = migraciones.filter((f) => f.slice(10, 13) > '021');
    for (const f of migraciones.filter((f) => !pendientes.includes(f.slice(10, 13)) && !posteriores.includes(f))) aplicar(f);
    const id = crypto.randomUUID();
    db.prepare("insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en) values (?, 25000, 'efectivo', 25000, 0, '', '')").run(id);
    db.prepare("insert into usuarios (correo, nombre, roles, pin_hash, pin_sal, creado_en, actualizado_en) values ('caja@prueba.mx', 'Caja', 'cajero', 'hash-prueba', 'sal-prueba', '', '')").run();
    for (const numero of pendientes) aplicar(migraciones.find((f) => f.startsWith(`migracion-${numero}-`))!);
    for (const f of posteriores) aplicar(f);
    assert.equal(db.prepare('select total, pedido_hash, revision from ventas where id = ?').get(id)!.total, 25000);
    assert.equal(db.prepare('select pedido_hash from ventas where id = ?').get(id)!.pedido_hash, null);
    assert.equal(db.prepare("select pin_hash from usuarios where correo = 'caja@prueba.mx'").get()!.pin_hash, 'hash-prueba');
    assert.equal(db.prepare('select count(*) as n from premios_apertura').get()!.n, 100);
    for (const tabla of ['codigos_cliente', 'vales_dolarones', 'devoluciones'])
      assert.equal(db.prepare(`select count(*) as n from ${tabla}`).get()!.n, 0);
    db.prepare('update ventas set revision = 1 where id = ?').run(id);
    assert.throws(() => db.prepare('update ventas set revision = 1 where id = ?').run(id), /ticket cambio/);
  } finally { db.close(); }
});

test('configuración por defecto: caja monetaria sigue vendiendo; alta, portal, SMS y emisión permanecen cerrados', async () => {
  const t = tienda();
  try {
    for (const clave of ['BASES_APROBADAS_VERSION', 'PORTAL_REGISTRO_ABIERTO', 'PROMOCION_INICIO',
      'PORTAL_BASES_TEXTO', 'PORTAL_AVISO_TEXTO', 'VALES_ABIERTOS', 'FIREBASE_PROJECT_ID', 'FIREBASE_WEB_API_KEY', 'HOST_PORTAL'] as const)
      delete t.env[clave];
    const id = await vender(t.pedir);
    assert.equal(stock(t.db), 48);
    assert.equal((await t.pedir(`/api/ventas/${id}/vale`, {})).status, 404);
    assert.equal((await t.pedir('/api/vales/config')).cuerpo.habilitado, false);
    const alta = await t.pedir('/api/socios', { id: crypto.randomUUID(), nombre: 'Cliente', telefono: '4449990000',
      acepta_bases: true, declara_mayor_edad: true });
    assert.equal(alta.status, 503);
    assert.equal((await t.pedir('/api/portal/config')).status, 404);
    assert.equal((await t.pedir('/api/vales/buscar', { codigo: 'DP-AAAAAAAAAAAAAAAA' })).status, 403);
    assert.equal((await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }],
      forma_pago: 'efectivo', efectivo: 24900, codigo_vale: 'DP-AAAAAAAAAAAAAAAA', dolarones: 100 })).status, 409);
    t.env.HOST_PORTAL = 'caja.prueba'; // Incluso con host, no ofrece Firebase/SMS ni registro.
    const config = (await t.pedir('/api/portal/config')).cuerpo;
    assert.equal(config.firebase, null);
    assert.equal(config.registro_abierto, false);
    assert.equal((await t.pedir('/api/portal/registro', {})).status, 401);
    assert.equal(t.db.prepare('select count(*) as n from clientes').get()!.n, 0);
    assert.equal(t.db.prepare('select count(*) as n from vales_dolarones').get()!.n, 0);
  } finally { t.db.close(); }
});

test('el comprobante de devolucion sale con piezas, lo devuelto, el motivo y las firmas', async () => {
  const pedazos: Uint8Array[] = [];
  const dev = {
    opened: false, configuration: { configurationValue: 1 },
    configurations: [{ interfaces: [{ interfaceNumber: 0, alternates: [{ endpoints: [{ direction: 'out', endpointNumber: 1 }] }] }] }],
    async open() { dev.opened = true; }, async close() { dev.opened = false; },
    async selectConfiguration() {}, async claimInterface() {}, async clearHalt() {},
    async transferOut(_e: number, datos: Uint8Array) { pedazos.push(datos.slice()); return { status: 'ok' }; },
  };
  Object.defineProperty(globalThis.navigator, 'usb', { value: { getDevices: async () => [dev] }, configurable: true });
  const { reconectarImpresora, imprimirDevolucion } = await import('../public/impresora.js');
  const { comprobanteDevolucion, comprobanteCancelacion } = await import('../public/ticket.js');
  await reconectarImpresora();

  // Lo que regresa GET /api/ventas/:id tras cancelar 1 de 2 ventiladores de un ticket de $500 con 100 D.
  const ticket = {
    creado_en: '2026-10-02T17:00:00Z', forma_pago: 'efectivo', total: 50000, dolarones: 10000,
    devuelto: 25000, dolarones_devueltos: 0, cancelada_caja: 'Caja 2', cancelada_por: 'caja2@prueba.mx',
    cancelada_en: '2026-10-02T19:00:00Z', motivo_cancelacion: 'Se arrepintio',
    lineas: [{ nombre: 'Ventilador', precio: 25000, cantidad: 2, cancelada_cantidad: 1 }],
    devoluciones: [{ id: 'x', nombre: 'Ventilador', cantidad: 1, importe: 25000, dolarones: 0, caja: 'Caja 1',
      autor: 'caja@prueba.mx', motivo: 'Venia con una aspa rota', creado_en: '2026-10-02T18:00:00Z' }],
  };
  assert.equal(await imprimirDevolucion(comprobanteDevolucion(ticket, 0)), true);
  let texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.match(texto, /DEVOLUCION DE PIEZAS[\s\S]*Caja: Caja 1[\s\S]*Ventilador\n +1 pieza +\$250\.00/);
  assert.match(texto, /DEVUELTO EN EFECTIVO +\$250\.00[\s\S]*Motivo:\nVenia con una aspa rota/);
  assert.match(texto, /Entrega: _+\n +caja@prueba\.mx[\s\S]*Recibe: +_+/);

  // Cancelar el resto: solo la pieza que quedaba, $150 en dinero y 100 D al saldo.
  pedazos.length = 0;
  assert.equal(await imprimirDevolucion(comprobanteCancelacion(ticket)), true);
  texto = new TextDecoder().decode(Uint8Array.from(pedazos.flatMap((p) => [...p])));
  assert.match(texto, /CANCELACION DE TICKET[\s\S]*Caja: Caja 2/);
  assert.match(texto, /DEVUELTO EN EFECTIVO +\$150\.00\n[\s\S]*Regresado al saldo \(Dolarones\) +100 D/);
});

test('Ventas de hoy abre el detalle: Imprimir vale aparece una sola vez en la ventana editable sin socio', async () => {
  const previo = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ textContent: '' }), head: { append() {} },
  } });
  try {
    const { pintarDetalle, renglonTicket } = await import('../public/ticket.js');
    const t = { id: crypto.randomUUID(), creado_en: new Date().toISOString(), forma_pago: 'efectivo',
      total: 25000, devuelto: 0, dolarones_devueltos: 0, cancelada: 0,
      lineas: [{ id: 1, nombre: '<script>', codigo: 'ED-1', precio: 25000, cantidad: 1, cancelada_cantidad: 0 }],
      devoluciones: [] };
    assert.match(renglonTicket(t), /data-ticket=/);
    assert.doesNotMatch(renglonTicket(t), /Imprimir vale/);
    const editable = pintarDetalle(t, { editable: true });
    assert.equal(editable.match(/Imprimir vale/g)?.length, 1);
    assert.match(editable, /data-imprimir-vale/);
    assert.match(editable, /&lt;script&gt;/);
    assert.doesNotMatch(pintarDetalle(t), /Imprimir vale/);
    assert.doesNotMatch(pintarDetalle({ ...t, socio: { numero: 1, nombre: 'Cliente' } }, { editable: true }), /Imprimir vale/);
    assert.doesNotMatch(pintarDetalle({ ...t, cancelada: 1 }, { editable: true }), /Imprimir vale/);
  } finally {
    if (previo) Object.defineProperty(globalThis, 'document', previo);
    else delete (globalThis as any).document;
  }
});
