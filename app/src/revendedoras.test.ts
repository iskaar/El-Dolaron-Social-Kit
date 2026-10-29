// node --test src/revendedoras.test.ts
// Revendedoras externas (Issue #575): rol propio, apartado de 48 h sin anticipo, pago solo por la tienda,
// privacidad entre ellas y reporte. SQLite real con todas las migraciones, detras del fetch del Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { permiso, puede, esDeCaja, ROL_POR_OMISION, type Rol } from './cuentas.ts';
import { vencerPedidos } from './pedidos.ts';

const ANA = 'ana@revende.mx';
const BETY = 'bety@revende.mx';
const CAJERO = 'caja@prueba.mx';

let consecutivo = 5000;
/** Pieza lista para /api/vender (foto, analisis, etiqueta) y para apartar. */
function pieza(db: DatabaseSync, cambios: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const fila = { id, codigo: `ED-${String(++consecutivo).padStart(6, '0')}`, nombre: "Blusa de algodón", categoria: 'ropa', talla: 'M',
    marca: 'Target', precio: 20000, precio_lista: 30000, estado_analisis: 'listo', estado_fisico: 'nuevo', stock: 1, sin_inventario: 0,
    destino: 'etiqueta', foto_key: `fotos/${id}.jpg`, propietario: 'dolaron', semana_ingreso: 'S43',
    creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(), ...cambios };
  db.prepare(`insert into productos (${Object.keys(fila).join(',')}) values (${Object.keys(fila).map(() => '?').join(',')})`).run(...Object.values(fila) as never[]);
  return fila;
}
function cuenta(db: DatabaseSync, correo: string, roles: string, nombre = correo.split('@')[0]) {
  db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')").run(correo, nombre, roles);
}
const stockDe = (db: DatabaseSync, id: string) => (db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
const comoUsuario = (env: Env, correo: string) => { (env as unknown as Record<string, string>).DEV_USUARIO = correo; };

type Tienda = ReturnType<typeof tienda>;
const mundo = () => {
  const t = tienda();
  cuenta(t.db, ANA, 'revendedora', 'Ana R.');
  cuenta(t.db, BETY, 'revendedora', 'Bety R.');
  cuenta(t.db, CAJERO, 'cajero', 'Marta');
  return t;
};
const apartar = (t: Tienda, productos: string[], extra: Record<string, unknown> = {}) => {
  const cuerpo = { id: crypto.randomUUID(), lineas: productos.map((producto_id) => ({ producto_id, cantidad: 1 })),
    cliente: 'Carla', telefono: '4441234567', entrega: 'tienda', ...extra };
  return t.pedir('/api/vender/apartar', cuerpo).then((r) => ({ ...r, id: cuerpo.id as string }));
};
const abonar = (t: Tienda, folio: number, importe: number, extra: Record<string, unknown> = {}) =>
  t.pedir(`/api/pedidos/${folio}/abonos`, { id: crypto.randomUUID(), importe, forma_pago: 'efectivo', caja: 'Caja 1', ...extra });
const cobrar = (t: Tienda, pedido: { id: string }, productoId: string, anticipo: number, efectivo: number, extra: Record<string, unknown> = {}) =>
  t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: productoId, cantidad: 1 }], forma_pago: 'efectivo', efectivo,
    caja: 'Caja 1', pedido_id: pedido.id, anticipo, ...extra });
const fila = (db: DatabaseSync, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args as never[]) as Record<string, any>;

/* ---------- permisos ---------- */

test('el rol existe, /cuentas lo ofrece y no es el de omision', async () => {
  const t = mundo();
  const lista = (await t.pedir('/api/cuentas', undefined, 'GET')).cuerpo;
  assert.ok(lista.roles.includes('revendedora'));
  assert.notEqual(ROL_POR_OMISION, 'revendedora');
  t.db.close();
});

test('la revendedora abre /vender y lo suyo; todo lo demas de la tienda le da 403 o la manda a sin-acceso', async () => {
  const t = mundo();
  const p = pieza(t.db);
  comoUsuario(t.env, ANA);
  for (const ruta of ['/api/vender', '/api/interesados', '/api/vender/mios', `/api/foto/${p.id}`, `/api/recortes/${p.id}/imagen`]) {
    const r = await t.pedir(ruta, undefined, 'GET');
    assert.notEqual(r.status, 403, ruta);
    assert.notEqual(r.status, 401, ruta);
  }
  for (const [ruta, metodo] of [
    ['/api/ventas', 'GET'], ['/api/ventas', 'POST'], ['/api/cortes', 'GET'], ['/api/cortes', 'POST'], ['/api/retiros', 'POST'],
    ['/api/pedidos', 'GET'], ['/api/pedidos', 'POST'], ['/api/pedidos/1', 'GET'], ['/api/pedidos/1/abonos', 'POST'], ['/api/pedidos/1/cancelar', 'POST'],
    ['/api/pedidos/1/piezas', 'POST'], ['/api/cuentas', 'GET'], ['/api/cuentas', 'PUT'], ['/api/reportes', 'GET'], ['/api/catalogo', 'GET'],
    ['/api/cajon', 'POST'], ['/api/descuentos', 'POST'], ['/api/avisos', 'GET'], ['/api/socios', 'GET'], ['/api/conteo', 'GET'],
    ['/api/impresiones', 'GET'], ['/api/piezas', 'GET'], ['/api/borradores', 'GET'], ['/api/nomina/entrada', 'POST'],
  ] as const) {
    const r = await t.pedir(ruta, metodo === 'GET' ? undefined : {}, metodo);
    assert.equal(r.status, 403, `${metodo} ${ruta}`);
  }
  // Las pantallas de la tienda no se abren: el servidor la manda a sin-acceso, y `/` a su unica pantalla.
  for (const ruta of ['/caja', '/pedidos', '/avisos', '/reportes', '/cuentas', '/socios', '/tarjeta-bandas']) {
    const r = await t.pedir(ruta, undefined, 'GET');
    assert.equal(r.status, 302, ruta);
    assert.match(r.ubicacion ?? '', /\/sin-acceso/, ruta);
  }
  for (const ruta of ['/', '/index', '/index.html']) {
    const r = await t.pedir(ruta, undefined, 'GET');
    assert.equal(r.status, 302, ruta);
    assert.equal(new URL(r.ubicacion!).pathname, '/vender', ruta);
  }
  t.db.close();
});

test('permiso(): la revendedora solo entra a las reglas de /vender; sus rutas nuevas y el PIN de la computadora', () => {
  const ana = { correo: ANA, nombre: '', caja: '', activo: true, editar_inventario: false, roles: ['revendedora'] as Rol[] };
  const abiertas: [string, string][] = [['/vender', 'GET'], ['/vender.js', 'GET'], ['/api/vender', 'GET'], ['/api/interesados', 'GET'],
    ['/api/interesados', 'POST'], ['/api/interesados/x', 'PATCH'], ['/api/foto/x', 'GET'], ['/api/recortes/x/imagen', 'GET'],
    ['/api/vender/apartar', 'POST'], ['/api/vender/mios', 'GET'], ['/api/vender/apartados/12/cancelar', 'POST']];
  for (const [ruta, metodo] of abiertas) assert.equal(puede(ana, permiso(ruta, metodo)), true, `${metodo} ${ruta}`);
  // Solo lectura de fotos: escribir en /api/foto o aprobar un recorte no es suyo.
  for (const [ruta, metodo] of [['/api/foto/x', 'PUT'], ['/api/recortes/x/aprobar', 'POST'], ['/api/vender/otra', 'GET'], ['/', 'GET'], ['/caja', 'GET'], ['/pedidos', 'GET']])
    assert.equal(puede(ana, permiso(ruta, metodo)), false, `${metodo} ${ruta}`);
  // La computadora de caja sigue necesitando el PIN en /vender y sus API: esDeCaja no puede perder esas reglas.
  for (const [ruta, metodo] of [['/vender', 'GET'], ['/vender.js', 'GET'], ['/api/vender', 'GET'], ['/api/interesados', 'GET'],
    ['/api/vender/apartar', 'POST'], ['/api/vender/mios', 'GET'], ['/api/vender/apartados/3/cancelar', 'POST']])
    assert.equal(esDeCaja(permiso(ruta, metodo)), true, `${metodo} ${ruta}`);
});

test('regresion: la computadora sin PIN recibe 401 pin:true en /api/vender* y /api/interesados*', async () => {
  const t = mundo();
  cuenta(t.db, 'pc@prueba.mx', 'computadora');
  comoUsuario(t.env, 'pc@prueba.mx');
  for (const [ruta, metodo] of [['/api/vender', 'GET'], ['/api/interesados', 'GET'], ['/api/vender/mios', 'GET']] as const) {
    const r = await t.pedir(ruta, undefined, metodo);
    assert.equal(r.status, 401, ruta);
    assert.equal(r.cuerpo.pin, true, ruta);
  }
  const r = await t.pedir('/api/vender/apartar', {});
  assert.equal(r.status, 401);
  assert.equal(r.cuerpo.pin, true);
  t.db.close();
});

test('el apartado sin anticipo es solo de la revendedora: cajero, dueno y computadora con PIN reciben 403 y no se aparta nada', async () => {
  const t = mundo();
  const p = pieza(t.db);
  for (const correo of [CAJERO, DUENO]) {
    comoUsuario(t.env, correo);
    const r = await apartar(t, [p.id]);
    assert.equal(r.status, 403, correo);
    assert.equal((await t.pedir('/api/vender/mios', undefined, 'GET')).status, 403, correo);
    assert.equal((await t.pedir('/api/vender/apartados/1/cancelar', {})).status, 403, correo);
  }
  // Quien tiene revendedora Y cajero es personal: conserva el flujo de la tienda (con anticipo).
  cuenta(t.db, 'doble@prueba.mx', 'cajero,revendedora');
  comoUsuario(t.env, 'doble@prueba.mx');
  assert.equal((await apartar(t, [p.id])).status, 403);
  assert.equal(stockDe(t.db, p.id as string), 1);
  assert.equal((t.db.prepare('select count(*) as n from pedidos').get() as any).n, 0);
  t.db.close();
});

/* ---------- apartar ---------- */

test('apartar como revendedora: stock -1 una vez, sin dinero, 48 h, y el reintento con el mismo UUID no repite', async () => {
  const t = mundo();
  const p = pieza(t.db);
  comoUsuario(t.env, ANA);
  const r = await apartar(t, [p.id as string]);
  await t.esperar();
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const ped = r.cuerpo.pedido;
  assert.equal(ped.vendedora, ANA);
  assert.equal(ped.estado, 'apartado');
  assert.equal(ped.anticipo, 0);
  assert.equal(ped.saldo, 0);
  assert.equal(ped.caja, '');
  assert.equal(ped.entrega, 'tienda');
  assert.equal(ped.envio, 0);
  assert.equal(ped.faltante, 20000);
  assert.equal(ped.liquidado_en, null);
  const horas = (Date.parse(ped.vence_en) - Date.parse(ped.creado_en)) / 3_600_000;
  assert.ok(Math.abs(horas - 48) < 0.01, `${horas} h`);
  const meses = (Date.parse(ped.saldo_vence_en) - Date.parse(ped.vence_en)) / 86_400_000;
  assert.ok(meses >= 28 && meses <= 31, `${meses} d`);
  assert.equal(stockDe(t.db, p.id as string), 0);
  // sin movimientos ni ventas: no entro dinero
  assert.equal((t.db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 0);
  assert.equal((t.db.prepare('select count(*) as n from ventas').get() as any).n, 0);

  const otra = await t.pedir('/api/vender/apartar', { id: r.id, lineas: [{ producto_id: p.id, cantidad: 1 }], cliente: 'Carla', telefono: '4441234567', entrega: 'tienda' });
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.pedido.folio, ped.folio);
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal((t.db.prepare('select count(*) as n from pedidos').get() as any).n, 1);

  // El cuerpo no decide el dinero: anticipo, forma de pago y caja se ignoran.
  const q = pieza(t.db);
  const manipulado = await apartar(t, [q.id as string], { anticipo: 99999, forma_pago: 'efectivo', caja: 'Caja 2', saldo: 5 });
  assert.equal(manipulado.status, 201);
  assert.deepEqual([manipulado.cuerpo.pedido.anticipo, manipulado.cuerpo.pedido.saldo, manipulado.cuerpo.pedido.caja, manipulado.cuerpo.pedido.forma_pago],
    [0, 0, '', 'transferencia']);

  // Otra revendedora no puede leer ni repetir el pedido de Ana con su UUID.
  comoUsuario(t.env, BETY);
  const robo = await t.pedir('/api/vender/apartar', { id: r.id, lineas: [{ producto_id: p.id, cantidad: 1 }], cliente: 'X', telefono: '4441234567', entrega: 'tienda' });
  assert.equal(robo.status, 409);
  assert.equal(robo.cuerpo.pedido, undefined);
  t.db.close();
});

test('dos revendedoras por la misma pieza unica: una gana, la otra recibe 409 y el stock no baja de cero', async () => {
  const t = mundo();
  const p = pieza(t.db);
  comoUsuario(t.env, ANA);
  assert.equal((await apartar(t, [p.id as string])).status, 201);
  comoUsuario(t.env, BETY);
  const r = await apartar(t, [p.id as string]);
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /ya no está disponible/);
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal((t.db.prepare('select count(*) as n from pedidos').get() as any).n, 1);
  // la pieza apartada ya no sale en /api/vender
  assert.equal((await t.pedir('/api/vender', undefined, 'GET')).cuerpo.piezas.length, 0);
  t.db.close();
});

test('piezas de FEP, sin etiqueta o sin inventario se rechazan sin tocar existencias', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  const fep = pieza(t.db, { propietario: 'fep' });
  const sinCodigo = pieza(t.db, { codigo: null });
  const banda = pieza(t.db, { sin_inventario: 1 });
  for (const p of [fep, sinCodigo, banda]) {
    const r = await apartar(t, [p.id as string]);
    assert.equal(r.status, 400, JSON.stringify(r.cuerpo));
    assert.equal(stockDe(t.db, p.id as string), 1);
  }
  // una linea buena con una de FEP: no se aparta ni la buena
  const buena = pieza(t.db);
  assert.equal((await apartar(t, [buena.id as string, fep.id as string])).status, 400);
  assert.equal(stockDe(t.db, buena.id as string), 1);
  assert.equal((await apartar(t, [])).status, 400);
  assert.equal((await apartar(t, [buena.id as string], { telefono: '123' })).status, 400);
  assert.equal((await apartar(t, [buena.id as string], { cliente: ' ' })).status, 400);
  assert.equal((await apartar(t, [buena.id as string], { entrega: 'domicilio' })).status, 400);
  assert.equal((t.db.prepare('select count(*) as n from pedidos').get() as any).n, 0);
  t.db.close();
});

test('tope de 10 piezas apartadas abiertas por revendedora; cancelar una libera lugar y las demas no se afectan', async () => {
  const t = mundo();
  const piezas = Array.from({ length: 12 }, () => pieza(t.db).id as string);
  comoUsuario(t.env, ANA);
  const primeras = await apartar(t, piezas.slice(0, 6));
  assert.equal(primeras.status, 201, JSON.stringify(primeras.cuerpo));
  assert.equal((await apartar(t, piezas.slice(6, 10))).status, 201);
  const de_mas = await apartar(t, [piezas[10]]);
  assert.equal(de_mas.status, 409);
  assert.match(de_mas.cuerpo.error, /Máximo 10/);
  assert.equal(stockDe(t.db, piezas[10]), 1);
  // Bety tiene su propio tope
  comoUsuario(t.env, BETY);
  assert.equal((await apartar(t, [piezas[10]])).status, 201);
  // Ana cancela el pedido de 6 y ya cabe otra
  comoUsuario(t.env, ANA);
  assert.equal((await t.pedir(`/api/vender/apartados/${primeras.cuerpo.pedido.folio}/cancelar`, {})).status, 200);
  assert.equal((await apartar(t, [piezas[11]])).status, 201);
  // Con el pago registrado, el pedido ya no cuenta para el tope
  assert.equal((await apartar(t, Array.from({ length: 5 }, () => pieza(t.db).id as string))).status, 201);   // 10 sin pago
  const extra = pieza(t.db).id as string;
  assert.equal((await apartar(t, [extra])).status, 409);
  const ultimo = fila(t.db, "select folio from pedidos where vendedora = ? and estado = 'apartado' order by folio desc limit 1", ANA);
  comoUsuario(t.env, DUENO);
  assert.equal((await t.pedir(`/api/pedidos/${ultimo.folio}/abonos`, { id: crypto.randomUUID(), importe: 1000, forma_pago: 'efectivo', caja: 'Caja 1' })).status, 200);
  comoUsuario(t.env, ANA);
  assert.equal((await apartar(t, [extra])).status, 201);
  t.db.close();
});

test('envio de revendedora: costo de envio, sin cobrar paquete ni emitir ticket, y se liquida con abonos del personal', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  // PRODUCTO vale $250: envio $99
  const r = await apartar(t, [PRODUCTO], { entrega: 'envio' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const ped = r.cuerpo.pedido;
  assert.equal(ped.envio, 9900);
  assert.equal(ped.saldo, 0);
  assert.equal(ped.faltante, 34900);
  assert.equal(ped.liquidado_en, null);
  assert.equal(fila(t.db, 'select stock from productos where id = ?', PRODUCTO).stock, 49);
  assert.equal((t.db.prepare('select count(*) as n from ventas').get() as any).n, 0);

  // El personal registra el dinero: abonos que extienden el plazo y, al completar, liquidan el paquete.
  comoUsuario(t.env, DUENO);
  const a1 = await abonar(t, ped.folio, 10000, { forma_pago: 'transferencia' });
  assert.equal(a1.status, 200, JSON.stringify(a1.cuerpo));
  assert.equal(a1.cuerpo.faltante, 24900);
  assert.equal(a1.cuerpo.liquidado_en, null);
  const a2 = await abonar(t, ped.folio, 24900, { forma_pago: 'transferencia' });
  assert.equal(a2.status, 200, JSON.stringify(a2.cuerpo));
  assert.ok(a2.cuerpo.liquidado_en);
  const cerrado = fila(t.db, 'select estado, saldo, venta_id, liquidado_en from pedidos where id = ?', ped.id);
  assert.equal(cerrado.estado, 'vendido');
  assert.ok(cerrado.venta_id);
  assert.equal(fila(t.db, 'select stock from productos where id = ?', PRODUCTO).stock, 49);   // sin segundo descuento
  assert.equal(fila(t.db, 'select total from ventas where id = ?', cerrado.venta_id).total, 34900);
  t.db.close();
});

/* ---------- vencimiento y cancelacion ---------- */

test('a las 48 h el cron devuelve la pieza una sola vez; antes no la toca', async () => {
  const t = mundo();
  const p = pieza(t.db);
  comoUsuario(t.env, ANA);
  const r = await apartar(t, [p.id as string]);
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal(await vencerPedidos(t.env, new Date(Date.now() + 47 * 3_600_000)), 0);
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal(await vencerPedidos(t.env, new Date(Date.now() + 49 * 3_600_000)), 1);
  assert.equal(stockDe(t.db, p.id as string), 1);
  assert.equal(await vencerPedidos(t.env, new Date(Date.now() + 50 * 3_600_000)), 0);
  assert.equal(stockDe(t.db, p.id as string), 1);
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', r.id).estado, 'vencido');
  // vuelve a la lista de piezas
  assert.equal((await t.pedir('/api/vender', undefined, 'GET')).cuerpo.piezas.length, 1);
  t.db.close();
});

test('cancelar: solo lo propio, solo apartado sin pago; dos veces devuelve la existencia una vez', async () => {
  const t = mundo();
  const p = pieza(t.db);
  const q = pieza(t.db);
  comoUsuario(t.env, ANA);
  const suyo = await apartar(t, [p.id as string]);
  const folio = suyo.cuerpo.pedido.folio;
  // otra revendedora y un pedido de la tienda: 404, sin tocar nada
  comoUsuario(t.env, BETY);
  assert.equal((await t.pedir(`/api/vender/apartados/${folio}/cancelar`, {})).status, 404);
  comoUsuario(t.env, DUENO);
  const deTienda = await t.pedir('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: q.id, cantidad: 1 }], cliente: 'Z',
    telefono: '4441234567', entrega: 'tienda', anticipo: 3000, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(deTienda.status, 201);
  comoUsuario(t.env, ANA);
  assert.equal((await t.pedir(`/api/vender/apartados/${deTienda.cuerpo.pedido.folio}/cancelar`, {})).status, 404);
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal(stockDe(t.db, q.id as string), 0);

  assert.equal((await t.pedir(`/api/vender/apartados/${folio}/cancelar`, {})).status, 200);
  assert.equal(stockDe(t.db, p.id as string), 1);
  const otra = await t.pedir(`/api/vender/apartados/${folio}/cancelar`, {});
  assert.equal(otra.status, 409);
  assert.equal(stockDe(t.db, p.id as string), 1);
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', suyo.id).estado, 'cancelado');
  assert.equal((await t.pedir('/api/vender/apartados/999/cancelar', {})).status, 404);
  assert.equal((await t.pedir('/api/vender/apartados/1/cancelar', undefined, 'GET')).status, 405);

  // con un abono de la tienda ya no cancela ella: solo el personal
  const r = pieza(t.db);
  const pagado = await apartar(t, [r.id as string]);
  comoUsuario(t.env, DUENO);
  assert.equal((await abonar(t, pagado.cuerpo.pedido.folio, 5000)).status, 200);
  comoUsuario(t.env, ANA);
  const negado = await t.pedir(`/api/vender/apartados/${pagado.cuerpo.pedido.folio}/cancelar`, {});
  assert.equal(negado.status, 409);
  assert.equal(stockDe(t.db, r.id as string), 0);
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', pagado.id).estado, 'apartado');
  t.db.close();
});

test('si el personal registra un pago entre la lectura y el batch de cancelar, la condicion en SQL lo detiene', async () => {
  const t = mundo();
  const p = pieza(t.db);
  comoUsuario(t.env, ANA);
  const r = await apartar(t, [p.id as string]);
  const batch = t.env.DB.batch.bind(t.env.DB);
  t.env.DB.batch = (async (sentencias: D1PreparedStatement[]) => {
    t.db.prepare('update pedidos set saldo = 5000 where id = ?').run(r.id);   // llego un abono despues de la lectura
    return batch(sentencias);
  }) as typeof t.env.DB.batch;
  const cancelar = await t.pedir(`/api/vender/apartados/${r.cuerpo.pedido.folio}/cancelar`, {});
  assert.equal(cancelar.status, 409);
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', r.id).estado, 'apartado');
  t.db.close();
});

test('/api/vender/mios: solo los suyos de los ultimos 60 dias, con estado, plazo y lineas', async () => {
  const t = mundo();
  const [a, b, c] = [pieza(t.db), pieza(t.db), pieza(t.db)];
  comoUsuario(t.env, ANA);
  const suyo = await apartar(t, [a.id as string], { cliente: 'Carla' });
  const viejo = await apartar(t, [b.id as string]);
  t.db.prepare("update pedidos set creado_en = ?, estado = 'vencido' where id = ?").run(new Date(Date.now() - 70 * 86_400_000).toISOString(), viejo.id);
  comoUsuario(t.env, BETY);
  await apartar(t, [c.id as string], { cliente: 'Secreta' });
  comoUsuario(t.env, ANA);
  const r = await t.pedir('/api/vender/mios', undefined, 'GET');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.pedidos.length, 1);
  const m = r.cuerpo.pedidos[0];
  assert.equal(m.folio, suyo.cuerpo.pedido.folio);
  assert.equal(m.estado, 'apartado');
  assert.equal(m.cliente, 'Carla');
  assert.equal(m.entrega, 'tienda');
  assert.equal(m.subtotal, 20000);
  assert.equal(m.cancelable, true);
  assert.equal(m.lineas[0].codigo, a.codigo);
  assert.equal(m.vence_en, suyo.cuerpo.pedido.vence_en);
  assert.ok(!JSON.stringify(r.cuerpo).includes('Secreta'));
  t.db.close();
});

/* ---------- pago del personal ---------- */

test('abono del personal a un apartado de revendedora: entra al corte de su caja, es idempotente y extiende el plazo', async () => {
  const t = mundo();
  const p = pieza(t.db, { precio: 30000 });
  comoUsuario(t.env, ANA);
  const r = await apartar(t, [p.id as string]);
  const ped = r.cuerpo.pedido;
  comoUsuario(t.env, DUENO);

  const id = crypto.randomUUID();
  const cuerpo = { id, importe: 12000, forma_pago: 'efectivo', caja: 'Caja 1' };
  const a = await t.pedir(`/api/pedidos/${ped.folio}/abonos`, cuerpo);
  assert.equal(a.status, 200, JSON.stringify(a.cuerpo));
  assert.equal(a.cuerpo.saldo, 12000);
  assert.equal(a.cuerpo.faltante, 18000);
  assert.equal(a.cuerpo.liquidado_en, null);
  const despues = fila(t.db, 'select estado, saldo, anticipo, vence_en, saldo_vence_en, venta_id, revision from pedidos where id = ?', ped.id);
  assert.equal(despues.estado, 'apartado');
  assert.equal(despues.saldo, 12000);
  assert.equal(despues.anticipo, 0);   // sigue siendo un apartado de revendedora
  assert.equal(despues.venta_id, null);   // en tienda no se liquida ni se emite ticket
  const dias = (Date.parse(despues.vence_en) - Date.now()) / 86_400_000;
  assert.ok(dias > 6.9 && dias < 7.1, `vence en ${dias} d (antes 2)`);
  assert.ok(Date.parse(despues.saldo_vence_en) > Date.parse(despues.vence_en));
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal((t.db.prepare('select count(*) as n from ventas').get() as any).n, 0);

  // Mismo id y mismo cuerpo: la misma respuesta y un solo cobro. Mismo id, otro cuerpo: 409.
  const repetido = await t.pedir(`/api/pedidos/${ped.folio}/abonos`, cuerpo);
  assert.deepEqual(repetido.cuerpo, a.cuerpo);
  assert.equal(fila(t.db, 'select saldo from pedidos where id = ?', ped.id).saldo, 12000);
  assert.equal((t.db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 1);
  assert.equal((await t.pedir(`/api/pedidos/${ped.folio}/abonos`, { ...cuerpo, importe: 12001 })).status, 409);
  // no se pasa de lo que falta
  assert.equal((await abonar(t, ped.folio, 18001)).status, 400);
  assert.equal(fila(t.db, 'select saldo from pedidos where id = ?', ped.id).saldo, 12000);

  // El corte de Caja 1 cuenta el abono; en Caja 2 no aparece.
  const corte = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 62000, tarjeta_terminal: 0 });
  assert.equal(corte.status, 201, JSON.stringify(corte.cuerpo));
  assert.equal(corte.cuerpo.efectivo_ventas, 12000);
  assert.equal(corte.cuerpo.efectivo_esperado, 62000);   // fondo $500 + $120
  const otra = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 50000 });
  assert.equal(otra.cuerpo.efectivo_ventas, 0);   // no se cuenta dos veces
  t.db.close();
});

test('el abono a un apartado normal de tienda (con anticipo) sigue rechazado; la pieza y el envio de la tienda no cambian', async () => {
  const t = mundo();
  const p = pieza(t.db);
  const normal = await t.pedir('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: p.id, cantidad: 1 }], cliente: 'Z',
    telefono: '4441234567', entrega: 'tienda', anticipo: 3000, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(normal.status, 201);
  assert.equal((await abonar(t, normal.cuerpo.pedido.folio, 100)).status, 409);
  assert.equal(fila(t.db, 'select saldo from pedidos where id = ?', normal.id ?? normal.cuerpo.pedido.id).saldo, 3000);
  assert.equal((t.db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 0);
  // agregar piezas sigue siendo solo de paquetes de envio, tambien para el apartado de revendedora
  comoUsuario(t.env, ANA);
  const q = pieza(t.db);
  const suyo = await apartar(t, [q.id as string]);
  comoUsuario(t.env, DUENO);
  const mas = await t.pedir(`/api/pedidos/${suyo.cuerpo.pedido.folio}/piezas`, { id: crypto.randomUUID(), producto_id: PRODUCTO, cantidad: 1 });
  assert.equal(mas.status, 409);
  assert.equal(fila(t.db, 'select stock from productos where id = ?', PRODUCTO).stock, 50);
  t.db.close();
});

test('un apartado de revendedora vencido ya no recibe abonos', async () => {
  const t = mundo();
  const p = pieza(t.db);
  comoUsuario(t.env, ANA);
  const r = await apartar(t, [p.id as string]);
  t.db.prepare('update pedidos set vence_en = ? where id = ?').run(new Date(Date.now() - 1000).toISOString(), r.id);
  comoUsuario(t.env, DUENO);
  assert.equal((await abonar(t, r.cuerpo.pedido.folio, 100)).status, 409);
  assert.equal((t.db.prepare('select count(*) as n from pedido_movimientos').get() as any).n, 0);
  t.db.close();
});

test('recoger en caja un apartado SIN abono: lo cobra completo, queda vendido y la existencia baja una sola vez', async () => {
  const t = mundo();
  const p = pieza(t.db, { precio: 20000 });
  comoUsuario(t.env, ANA);
  const r = await apartar(t, [p.id as string]);
  assert.equal(stockDe(t.db, p.id as string), 0);
  comoUsuario(t.env, DUENO);
  // La caja carga el apartado con GET /api/pedidos/<folio> y cobra con su id (anticipo 0).
  const cargado = (await t.pedir(`/api/pedidos/${r.cuerpo.pedido.folio}`, undefined, 'GET')).cuerpo.pedido;
  assert.equal(cargado.anticipo, 0);
  assert.equal(cargado.saldo, 0);
  const v = await cobrar(t, r.cuerpo.pedido, p.id as string, 0, 20000);
  await t.esperar();
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));
  assert.equal(v.cuerpo.total, 20000);
  assert.equal(v.cuerpo.anticipo, 0);
  assert.equal(stockDe(t.db, p.id as string), 0);   // devuelta por el apartado y descontada por la venta: no queda en -1 ni en 1
  const cerrado = fila(t.db, 'select estado, saldo, venta_id from pedidos where id = ?', r.id);
  assert.equal(cerrado.estado, 'vendido');
  assert.ok(cerrado.venta_id);
  const corte = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 70000 });
  assert.equal(corte.cuerpo.efectivo_ventas, 20000);
  // un segundo cobro con el mismo pedido ya no tiene apartado: 409 y nada cambia
  const otra = await cobrar(t, r.cuerpo.pedido, p.id as string, 0, 20000);
  assert.equal(otra.status, 409, JSON.stringify(otra.cuerpo));
  assert.equal(stockDe(t.db, p.id as string), 0);
  t.db.close();
});

test('recoger en caja un apartado CON abono parcial: el abono es del corte donde entro y la caja cobra solo el resto', async () => {
  const t = mundo();
  const p = pieza(t.db, { precio: 20000 });
  comoUsuario(t.env, ANA);
  const r = await apartar(t, [p.id as string]);
  comoUsuario(t.env, DUENO);
  assert.equal((await abonar(t, r.cuerpo.pedido.folio, 5000, { forma_pago: 'transferencia', caja: 'Caja 2' })).status, 200);
  const cargado = (await t.pedir(`/api/pedidos/${r.cuerpo.pedido.folio}`, undefined, 'GET')).cuerpo.pedido;
  assert.equal(cargado.saldo, 5000);
  // el anticipo no puede pasar del saldo
  assert.equal((await cobrar(t, r.cuerpo.pedido, p.id as string, 5001, 15000)).status, 409);
  assert.equal(stockDe(t.db, p.id as string), 0);
  const v = await cobrar(t, r.cuerpo.pedido, p.id as string, 5000, 15000);
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));
  assert.equal(v.cuerpo.anticipo, 5000);
  assert.equal(v.cuerpo.saldo_pedido, 0);
  assert.equal(stockDe(t.db, p.id as string), 0);
  assert.equal(fila(t.db, 'select estado from pedidos where id = ?', r.id).estado, 'vendido');
  // Caja 1 cobro $150 en efectivo; la transferencia de $50 entro en Caja 2. Juntas suman el precio de la pieza.
  const caja1 = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 1', efectivo_contado: 65000 });
  assert.equal(caja1.cuerpo.efectivo_ventas, 15000);
  assert.equal(caja1.cuerpo.transferencias, 0);
  const caja2 = await t.pedir('/api/cortes', { id: crypto.randomUUID(), caja: 'Caja 2', efectivo_contado: 50000 });
  assert.equal(caja2.cuerpo.transferencias, 5000);
  const reportes = (await t.pedir('/api/reportes?dias=1', undefined, 'GET')).cuerpo;
  assert.equal(reportes.resumen.total, 20000);
  t.db.close();
});

/* ---------- privacidad ---------- */

test('interesados: la revendedora siempre ve y descarta solo los suyos; el personal sigue viendo todos', async () => {
  const t = mundo();
  const p = pieza(t.db);
  const crear = async (correo: string, cliente: string) => {
    comoUsuario(t.env, correo);
    const id = crypto.randomUUID();
    assert.equal((await t.pedir('/api/interesados', { id, producto_id: p.id, cliente, telefono: '4441234567', nota: '' })).status, 201);
    return id;
  };
  const deAna = await crear(ANA, 'Cliente de Ana');
  const deBety = await crear(BETY, 'Cliente de Bety');
  await crear(CAJERO, 'Cliente de caja');

  comoUsuario(t.env, ANA);
  for (const query of ['', '?mios=1']) {
    const lista = (await t.pedir(`/api/interesados${query}`, undefined, 'GET')).cuerpo.interesados;
    assert.deepEqual(lista.map((i: any) => i.cliente), ['Cliente de Ana'], query);
  }
  assert.equal((await t.pedir('/api/interesados?mios=otro', undefined, 'GET')).status, 400);
  // no puede descartar el de otra: 404 y sigue abierto
  const ajeno = await t.pedir(`/api/interesados/${deBety}`, { estado: 'descartado' }, 'PATCH');
  assert.equal(ajeno.status, 404);
  assert.equal(fila(t.db, 'select estado from interesados where id = ?', deBety).estado, 'abierto');
  assert.equal((await t.pedir(`/api/interesados/${deAna}`, { estado: 'descartado' }, 'PATCH')).status, 200);
  assert.equal(fila(t.db, 'select estado from interesados where id = ?', deAna).estado, 'descartado');

  // el personal ve todo y puede descartar cualquiera, como antes
  comoUsuario(t.env, CAJERO);
  assert.equal((await t.pedir('/api/interesados', undefined, 'GET')).cuerpo.interesados.length, 2);
  assert.equal((await t.pedir(`/api/interesados/${deBety}`, { estado: 'descartado' }, 'PATCH')).status, 200);
  t.db.close();
});

test('/api/vender: la cola de una revendedora muestra orden y hora, no clientes ni vendedoras ajenas; el personal lo ve completo', async () => {
  const t = mundo();
  const p = pieza(t.db);
  const anota = async (correo: string, cliente: string) => {
    comoUsuario(t.env, correo);
    assert.equal((await t.pedir('/api/interesados', { id: crypto.randomUUID(), producto_id: p.id, cliente, telefono: '', nota: '' })).status, 201);
  };
  await anota(BETY, 'Cliente de Bety');
  await anota(ANA, 'Cliente de Ana');
  await anota(CAJERO, 'Cliente de caja');

  comoUsuario(t.env, ANA);
  const cola = (await t.pedir('/api/vender', undefined, 'GET')).cuerpo.piezas[0].cola;
  assert.equal(cola.length, 3);   // la posicion se conserva
  assert.deepEqual(cola.map((i: any) => i.vendedora_nombre), ['Otra vendedora', 'Ana R.', 'Otra vendedora']);
  assert.deepEqual(cola.map((i: any) => i.cliente), ['', 'Cliente de Ana', '']);
  assert.ok(cola.every((i: any) => i.creado_en));
  const texto = JSON.stringify(cola);
  for (const secreto of ['Cliente de Bety', 'Cliente de caja', BETY, CAJERO, 'Marta']) assert.ok(!texto.includes(secreto), secreto);

  comoUsuario(t.env, CAJERO);
  const completa = (await t.pedir('/api/vender', undefined, 'GET')).cuerpo.piezas[0].cola;
  assert.deepEqual(completa.map((i: any) => i.cliente), ['Cliente de Bety', 'Cliente de Ana', 'Cliente de caja']);
  assert.ok(completa.every((i: any) => i.vendedora.includes('@')));
  t.db.close();
});

test('/api/yo dice si la cuenta es revendedora (la pantalla decide con eso)', async () => {
  const t = mundo();
  comoUsuario(t.env, ANA);
  assert.equal((await t.pedir('/api/yo', undefined, 'GET')).cuerpo.revendedora, true);
  comoUsuario(t.env, CAJERO);
  assert.equal((await t.pedir('/api/yo', undefined, 'GET')).cuerpo.revendedora, false);
  comoUsuario(t.env, DUENO);
  assert.equal((await t.pedir('/api/yo', undefined, 'GET')).cuerpo.revendedora, false);
  t.db.close();
});

/* ---------- reporte ---------- */

test('/api/reportes: por revendedora, pedidos vendidos, piezas e importe de lo que cerro en caja; sin cancelados ni tickets de la tienda', async () => {
  const t = mundo();
  const [a, b, c, d] = [pieza(t.db, { precio: 20000 }), pieza(t.db, { precio: 30000 }), pieza(t.db, { precio: 10000 }), pieza(t.db, { precio: 40000 })];
  comoUsuario(t.env, ANA);
  const pa = await apartar(t, [a.id as string, b.id as string]);
  const pb = await apartar(t, [c.id as string]);
  comoUsuario(t.env, BETY);
  const pc = await apartar(t, [d.id as string]);
  comoUsuario(t.env, DUENO);
  // un apartado normal de la tienda, otro vendedor: no sale en el reporte de revendedoras
  const e = pieza(t.db, { precio: 5000 });
  const normal = await t.pedir('/api/pedidos', { id: crypto.randomUUID(), lineas: [{ producto_id: e.id, cantidad: 1 }], cliente: 'Z',
    telefono: '4441234567', entrega: 'tienda', anticipo: 800, forma_pago: 'efectivo', caja: 'Caja 1' });
  assert.equal(normal.status, 201);

  const cobra = async (ped: { id: string }, productos: Record<string, unknown>[], anticipo = 0) => {
    const total = productos.reduce((s, x) => s + (x.precio as number), 0);
    const r = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: productos.map((x) => ({ producto_id: x.id, cantidad: 1 })),
      forma_pago: 'efectivo', efectivo: total - anticipo, caja: 'Caja 1', pedido_id: ped.id, anticipo });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    return r;
  };
  await cobra(pa.cuerpo.pedido, [a, b]);          // Ana: 2 piezas, $500
  const cancelada = await cobra(pb.cuerpo.pedido, [c]);   // Ana: se cancela despues
  await cobra(pc.cuerpo.pedido, [d]);             // Bety: 1 pieza, $400
  await cobra(normal.cuerpo.pedido, [e], 800);
  t.db.prepare('update ventas set cancelada = 1 where id = ?').run(fila(t.db, 'select id from ventas where pedido_id = ?', pb.cuerpo.pedido.id).id);
  void cancelada;

  const r = (await t.pedir('/api/reportes?dias=1', undefined, 'GET')).cuerpo;
  assert.deepEqual(r.revendedoras.map((x: any) => ({ ...x })), [
    { vendedora: ANA, nombre: 'Ana R.', pedidos: 1, piezas: 2, importe: 50000 },
    { vendedora: BETY, nombre: 'Bety R.', pedidos: 1, piezas: 1, importe: 40000 },
  ]);
  // Fuera del rango no suma
  t.db.prepare("update ventas set creado_en = '2020-01-01T00:00:00.000Z'").run();
  assert.deepEqual((await t.pedir('/api/reportes?dias=1', undefined, 'GET')).cuerpo.revendedoras, []);
  // Quien deja de ser revendedora ya no sale
  t.db.prepare("update ventas set creado_en = ?").run(new Date().toISOString());
  t.db.prepare("update usuarios set roles = 'cajero' where correo = ?").run(ANA);
  assert.deepEqual((await t.pedir('/api/reportes?dias=1', undefined, 'GET')).cuerpo.revendedoras.map((x: any) => x.vendedora), [BETY]);
  t.db.close();
});

/* ---------- pantallas ---------- */

test('las pantallas que cambian (vender, caja, reportes, pedidos) siguen con sintaxis valida y la caja carga el apartado sin anticipo', async () => {
  const { readFileSync } = await import('node:fs');
  const FuncionAsincrona = Object.getPrototypeOf(async () => {}).constructor;
  for (const pagina of ['vender', 'caja', 'reportes', 'pedidos']) {
    const html = readFileSync(`public/${pagina}.html`, 'utf8').replace(/\r\n/g, '\n');
    const modulo = html.split('<script type="module">')[1].split('</script>')[0].replace(/^import[\s\S]*?;$/gm, '');
    assert.doesNotThrow(() => new FuncionAsincrona(modulo), pagina);
  }
  const caja = readFileSync('public/caja.html', 'utf8');
  // Sin esta condicion la caja contesta «no tiene saldo a favor» y el apartado sin abono no se puede cobrar al recoger.
  assert.match(caja, /p\.entrega === 'tienda' && p\.anticipo === 0 && Date\.parse\(p\.vence_en\) > Date\.now\(\)/);
  const vender = readFileSync('public/vender.html', 'utf8');
  assert.match(vender, /Guardar venta/);
  assert.match(vender, /Quien la compró paga en la tienda/);
  assert.match(vender, /\/api\/vender\/apartar/);
});
