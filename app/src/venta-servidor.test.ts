// node --test src/venta-servidor.test.ts
// El servidor nunca confia en lo que manda la caja para precio, nombre o codigo:
// esos salen del catalogo. Aqui se prueba esa regla sin tocar D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, efectivoAlcanza, saldoCanjeable, debePreguntarSocio } from '../public/venta.js';
import { prepararLineas } from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const catalogo = () => new Map([
  ['a1111111-1111-4111-8111-111111111111',
    { id: 'a1111111-1111-4111-8111-111111111111', codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, sin_inventario: 0 }],
  ['00000000-0000-4000-8000-200000000019',
    { id: '00000000-0000-4000-8000-200000000019', codigo: 'G19', nombre: 'General $19', precio: 1900, sin_inventario: 1 }],
]);

test('un precio alterado por el navegador se ignora: manda el del catalogo', () => {
  const resultado = prepararLineas(
    [{ producto_id: 'a1111111-1111-4111-8111-111111111111', precio: 1, cantidad: 1 }],
    catalogo(),
  );
  assert.ok(resultado.ok);
  assert.equal(resultado.lineas[0].precio, 25000);
});

test('producto inexistente: 4xx logico, no hay linea que registrar', () => {
  const resultado = prepararLineas(
    [{ producto_id: 'no-existe', cantidad: 1 }],
    catalogo(),
  );
  assert.equal(resultado.ok, false);
  assert.match(resultado.error, /inexistente/);
});

test('cantidad invalida: cero, negativa o no entera se rechaza', () => {
  for (const cantidad of [0, -1, 1.5, NaN]) {
    const resultado = prepararLineas(
      [{ producto_id: 'a1111111-1111-4111-8111-111111111111', cantidad }],
      catalogo(),
    );
    assert.equal(resultado.ok, false, `cantidad ${cantidad} deberia rechazarse`);
  }
});

test('un ticket vacio no produce lineas', () => {
  const resultado = prepararLineas([], catalogo());
  assert.equal(resultado.ok, false);
});

test('la banda se marca sin inventario: la caja no le descuenta existencia', () => {
  const resultado = prepararLineas(
    [{ producto_id: '00000000-0000-4000-8000-200000000019', cantidad: 3 }],
    catalogo(),
  );
  assert.ok(resultado.ok);
  assert.equal(resultado.lineas[0].sinInventario, true);
  assert.equal(resultado.lineas[0].precio, 1900);
});

test('la puerta del capturista admite Buscar y Revisar, sin abrir Ajustes (#446)', async () => {
  const { permitidaParaVendedor } = await import('./worker.ts');
  const id = 'a1111111-1111-4111-8111-111111111111';
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}/existencia`, 'PATCH'), true);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}/existencia`, 'GET'), false);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}`, 'PATCH'), true);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}`, 'DELETE'), true);
  assert.equal(permitidaParaVendedor('/api/borradores', 'GET'), true);
  assert.equal(permitidaParaVendedor('/api/borradores', 'POST'), true);
});

test('líneas nulas o no objetos responden 400 sin registrar venta ni descontar stock', async () => {
  const t = tienda();
  try {
    for (const linea of [null, false, 1, 'pieza', [], {}]) {
      const r = await t.pedir('/api/ventas', { id:crypto.randomUUID(),
        lineas:[{ producto_id:PRODUCTO, cantidad:1 }, linea], efectivo:25000 });
      assert.equal(r.status, 400, JSON.stringify({ linea, respuesta:r.cuerpo }));
      assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 0);
      assert.equal(t.db.prepare('select count(*) as n from venta_lineas').get()!.n, 0);
      assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 50);
    }
  } finally { t.db.close(); }
});

test('un folio acepta sólo el mismo pedido; el catálogo posterior no altera el reintento', async () => {
  const t = tienda();
  try {
    const v = { id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:1 }],
      forma_pago:'efectivo', efectivo:25000, creado_en:'2026-10-02T18:00:00.000Z' };
    assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    t.db.prepare('update productos set precio=30000 where id=?').run(PRODUCTO);
    assert.equal((await t.pedir('/api/ventas', v)).cuerpo.duplicada, true);
    for (const cambiado of [
      { ...v, efectivo:30000 }, { ...v, lineas:[{ producto_id:PRODUCTO, cantidad:2 }] },
      { ...v, forma_pago:'tarjeta' },
    ]) assert.equal((await t.pedir('/api/ventas', cambiado)).status, 409);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 1);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 49);
  } finally { t.db.close(); }
});

test('una confirmación entre prelectura y batch se resuelve por el pedido confirmado', async () => {
  const t = tienda();
  try {
    const v = { id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:1 }],
      forma_pago:'efectivo', efectivo:25000 };
    const original = t.env.DB.batch.bind(t.env.DB);
    t.env.DB.batch = async (sentencias) => {
      t.env.DB.batch = original;
      assert.equal((await t.pedir('/api/ventas', v)).status, 201);
      return original(sentencias);
    };
    const r = await t.pedir('/api/ventas', v);
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.duplicada, true);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 49);
  } finally { t.db.close(); }
});

test('el reintento de un folio vale aunque cambie el cajero en turno o la venta sea anterior a la huella', async () => {
  const t = tienda();
  try {
    const v = { id:crypto.randomUUID(), lineas:[{ producto_id:PRODUCTO, cantidad:1 }],
      forma_pago:'efectivo', efectivo:25000 };
    assert.equal((await t.pedir('/api/ventas', v)).status, 201);
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
      values ('otro@prueba.mx', 'Otra', 'dueno', 1, '', '')`).run();
    t.env.DEV_USUARIO = 'otro@prueba.mx';
    assert.equal((await t.pedir('/api/ventas', v)).cuerpo.duplicada, true);
    t.db.prepare('update ventas set pedido_hash = null where id = ?').run(v.id);
    assert.equal((await t.pedir('/api/ventas', { ...v, efectivo:30000 })).cuerpo.duplicada, true);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(PRODUCTO)!.stock, 49);
  } finally { t.db.close(); }
});

test('caja reintenta un canje tras perder la respuesta con el mismo folio, fecha y pedido_hash', async () => {
  const t = tienda();
  try {
    t.env.VALES_ABIERTOS = 'si';
    const emitida = await t.pedir('/api/ventas', { id: crypto.randomUUID(),
      lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], efectivo: 25000, caja: 'Caja 1' });
    const vale = emitida.cuerpo.vale_emitido;
    const fuente = readFileSync('public/caja.html', 'utf8');
    const cobrar = fuente.slice(fuente.indexOf('async function cobrar()'), fuente.indexOf('let sincronizando = false;'));
    const respuestas: number[] = [];
    let reloj = 0;
    // Ejecutar el cobro real con una primera respuesta perdida. Devolver false mantiene el ticket abierto.
    const repetir = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, formaElegida = true;
      ${cobrar}; cobrar`, {
      crypto, debePreguntarSocio, navigator: { onLine: true }, preguntarSocio: async () => 'cobrar',   // #730: «cobrar así»
      Date: class extends Date { constructor() { super(1760000000000 + reloj++ * 1000); } },
      lineas: [{ producto_id: PRODUCTO, codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, cantidad: 1 }],
      socio: { vale: true, disponible: 1000 }, pedidoCargado: null,
      $: (id: string) => ({ value: id === 'efectivo' ? '245' : id === 'vendedora' ? '' : 'efectivo', style: {} }),
      exigirCaja: () => true, cajaActual: () => 'Caja 1', dolaronesPedidos: () => 500,
      impresionRemota: () => false,
      totales, efectivoAlcanza, saldoCanjeable, pintar() {},
      descuento: null, descuentoAplicado: () => 0, promoActual: () => 0, pintarDescuento() {},
      cobrarConDolarones: async (venta: Record<string, unknown>) => {
        respuestas.push((await t.pedir('/api/ventas', { ...venta, codigo_vale: vale.codigo })).status);
        return false;
      },
    });
    await repetir();
    await repetir();
    assert.deepEqual(respuestas, [201, 200]);
    assert.equal(t.db.prepare('select count(*) as n from ventas').get()!.n, 2);
    assert.equal(t.db.prepare('select stock from productos where id = ?').get(PRODUCTO)!.stock, 48);
    assert.equal(t.db.prepare('select restante from vales_dolarones where id = ?').get(vale.id)!.restante, 500);
  } finally { t.db.close(); }
});

test('el precio que mostro la caja gana si es el anterior y el cambio es de hace menos de 10 min', async () => {
  const t = tienda();
  const vender = (extra: object) => t.pedir('/api/ventas', {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1, precio: 25000 }], forma_pago: 'efectivo', efectivo: 25000, caja: 'Caja 1', ...extra,
  });
  // El trigger guarda el precio de antes y la hora del cambio; tocar otra columna no los mueve.
  t.db.prepare('update productos set nombre = ? where id = ?').run('Otro', PRODUCTO);
  assert.equal((t.db.prepare('select precio_anterior as a from productos where id = ?').get(PRODUCTO) as any).a, null);
  t.db.prepare('update productos set precio = 30000 where id = ?').run(PRODUCTO);
  const fila = t.db.prepare('select precio_anterior as a, precio_cambiado_en as c from productos where id = ?').get(PRODUCTO) as any;
  assert.equal(fila.a, 25000);
  assert.ok(Math.abs(Date.now() - Date.parse(fila.c)) < 5000);

  // La caja vendio hace 2 min con el catalogo viejo: efectivo y tarjeta quedan al precio que cobro.
  const hace2 = new Date(Date.now() - 120_000).toISOString();
  const efectivo = await vender({ creado_en: hace2 });
  assert.equal(efectivo.status, 201, JSON.stringify(efectivo.cuerpo));
  const tarjeta = await vender({ creado_en: hace2, forma_pago: 'tarjeta', efectivo: 0 });
  assert.equal(tarjeta.status, 201);
  assert.deepEqual(t.db.prepare('select total from ventas order by rowid').all().map((v: any) => v.total), [25000, 25000]);
  assert.deepEqual(t.db.prepare('select precio from venta_lineas').all().map((l: any) => l.precio), [25000, 25000]);

  // Un precio inventado (ni el actual ni el anterior) se ignora: manda el actual.
  const inventado = await vender({ creado_en: hace2, lineas: [{ producto_id: PRODUCTO, cantidad: 1, precio: 100 }], forma_pago: 'tarjeta', efectivo: 0 });
  assert.equal(inventado.status, 201);
  assert.equal((t.db.prepare('select total from ventas order by rowid desc').get() as any).total, 30000);

  // Pasados 10 min del cambio ya no vale el precio viejo: el efectivo de 25000 no alcanza.
  t.db.prepare('update productos set precio_cambiado_en = ? where id = ?').run(new Date(Date.now() - 20 * 60_000).toISOString(), PRODUCTO);
  const tarde = await vender({});
  assert.equal(tarde.status, 400);
  assert.match(tarde.cuerpo.error, /efectivo no alcanza/);
  const tardeTarjeta = await vender({ forma_pago: 'tarjeta', efectivo: 0 });
  assert.equal(tardeTarjeta.status, 201);
  assert.equal((t.db.prepare('select total from ventas order by rowid desc').get() as any).total, 30000);
});

// Buen Fin (#772): el servidor cobra con la hora de la venta y nunca le cree el precio a la caja.
const BUENFIN = { desde: '2026-11-14T06:00:00Z', hasta: '2026-11-18T06:00:00Z' };
const ROPA = 'b2222222-2222-4222-8222-222222222222';

test('Buen Fin: prepararLineas rebaja por categoria, no toca envio ni pedidos pactados y respeta el precio anterior', () => {
  const dentro = Date.parse('2026-11-15T18:00:00Z');
  const productos = new Map<string, any>([
    ['a', { id: 'a', codigo: 'ED-1', nombre: 'Ventilador', precio: 25000, sin_inventario: 0, categoria: 'hogar' }],
    ['r', { id: 'r', codigo: 'ED-2', nombre: 'Playera', precio: 12000, sin_inventario: 0, categoria: 'ropa' }],
    ['e', { id: '00000000-0000-4000-8000-000000000099', codigo: 'ENVIO', nombre: 'Envío', precio: 9900, sin_inventario: 1, categoria: 'otros' }],
    ['p', { id: 'p', codigo: 'ED-3', nombre: 'Apartada', precio: 8000, sin_inventario: 0, categoria: 'hogar', pactado: true }],
    ['v', { id: 'v', codigo: 'ED-4', nombre: 'Cambio de precio', precio: 30000, sin_inventario: 0, categoria: 'hogar',
      precio_anterior: 20000, precio_cambiado_en: new Date(dentro - 60_000).toISOString() }],
  ]);
  const ids = ['a', 'r', 'e', 'p'].map((producto_id) => ({ producto_id, cantidad: 1, precio: 1 }));
  const r = prepararLineas(ids, productos, dentro, BUENFIN);
  assert.ok(r.ok);
  assert.deepEqual(r.lineas.map((l) => l.precio), [17500, 9600, 9900, 8000]);
  // Fuera de la ventana, o sin ella, igual que hoy.
  for (const [hora, ventana] of [[Date.parse('2026-11-18T06:00:00Z'), BUENFIN], [dentro, null]] as const) {
    const fuera = prepararLineas(ids, productos, hora, ventana);
    assert.ok(fuera.ok);
    assert.deepEqual(fuera.lineas.map((l) => l.precio), [25000, 12000, 9900, 8000]);
  }
  // El precio que vio la caja (de catalogo, precio_lista) sigue valiendo 10 min; el Buen Fin se aplica encima.
  const anterior = prepararLineas([{ producto_id: 'v', cantidad: 1, precio: 10000, precio_lista: 20000 }], productos, dentro, BUENFIN);
  assert.ok(anterior.ok);
  assert.equal(anterior.lineas[0].precio, 14000);
  // Un precio_lista inventado no baja el precio: manda el del catalogo.
  const inventado = prepararLineas([{ producto_id: 'v', cantidad: 1, precio: 1, precio_lista: 1 }], productos, dentro, BUENFIN);
  assert.ok(inventado.ok);
  assert.equal(inventado.lineas[0].precio, 21000);
});

test('Buen Fin: ticket mixto cobra ropa -20 % y lo demas -30 %, no se le cree a la caja y devolver regresa lo pagado', async () => {
  const t = tienda();
  t.db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, stock, semana_ingreso, creado_en, actualizado_en)
    values (?, 'ED-000002', 'Playera', 'ropa', 12000, 10, 'S40', '', '')`).run(ROPA);
  t.db.prepare(`update productos set categoria = 'hogar' where id = ?`).run(PRODUCTO);
  // El servidor no acepta una hora de caja futura: el reloj de la prueba va despues de la ventana.
  const ahoraReal = Date.now;
  Date.now = () => Date.parse('2026-11-19T00:00:00Z');
  try {
    t.env.BUENFIN_DESDE = BUENFIN.desde;
    t.env.BUENFIN_HASTA = BUENFIN.hasta;
    const venta = (extra: Record<string, unknown>) => ({
      id: crypto.randomUUID(), forma_pago: 'tarjeta', efectivo: 0, caja: 'Caja 1',
      lineas: [{ producto_id: PRODUCTO, cantidad: 1, precio: 1 }, { producto_id: ROPA, cantidad: 1, precio: 1 }], ...extra,
    });
    const precios = (id: unknown) => t.db.prepare('select precio from venta_lineas where venta_id = ? order by rowid').all(id).map((l: any) => l.precio);

    // Dentro de la ventana: una caja que manda $0.01 por pieza no cobra de menos.
    const dentro = venta({ creado_en: '2026-11-15T18:00:00Z' });
    const r = await t.pedir('/api/ventas', dentro);
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    assert.deepEqual(precios(dentro.id), [17500, 9600]);
    assert.equal((t.db.prepare('select total from ventas where id = ?').get(dentro.id) as any).total, 27100);
    assert.equal(r.cuerpo.total, 27100);

    // Fuera de la ventana nada cambia.
    const antes = venta({ creado_en: '2026-11-13T18:00:00Z' });
    assert.equal((await t.pedir('/api/ventas', antes)).status, 201);
    assert.deepEqual(precios(antes.id), [25000, 12000]);
    // Sin red: la hora de la caja decide (vendida el 17 y sincronizada despues, conserva el descuento).
    const tarde = venta({ creado_en: '2026-11-18T05:59:00Z' });
    assert.equal((await t.pedir('/api/ventas', tarde)).status, 201);
    assert.deepEqual(precios(tarde.id), [17500, 9600]);

    // La caja recibe la categoria en su catalogo y la ventana en su configuracion.
    const cat = await t.pedir('/api/catalogo', undefined, 'GET');
    assert.equal(cat.status, 200);
    const config = await t.pedir('/api/vales/config', undefined, 'GET');
    assert.deepEqual(config.cuerpo.buenfin, BUENFIN);

    // Devolver una pieza regresa lo que se pago por ella, no el precio de lista.
    const ticket = (await t.pedir(`/api/ventas/${dentro.id}`, undefined, 'GET')).cuerpo;
    const lineaRopa = ticket.lineas.find((l: any) => l.codigo === 'ED-000002');
    const dev = await t.pedir(`/api/ventas/${dentro.id}/lineas/${lineaRopa.id}/cancelar`,
      { id: crypto.randomUUID(), cantidad: 1, motivo: 'no le quedo', caja: 'Caja 1' });
    assert.equal(dev.status, 201, JSON.stringify(dev.cuerpo));
    assert.equal(dev.cuerpo.devuelto, 9600);
  } finally { Date.now = ahoraReal; t.db.close(); }
});
