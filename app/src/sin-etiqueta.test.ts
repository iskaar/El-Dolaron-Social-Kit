// node --test src/sin-etiqueta.test.ts
// «Sin etiqueta» (Issue #880): cobrar una pieza que no tiene etiqueta ni banda con el precio y la descripcion que escribe la caja.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { LIBRE_ID, agregar, descripcionLibre, centavosDeTexto, totales } from '../public/venta.js';

const venta = (lineas: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), caja: 'Caja 1', forma_pago: 'efectivo', efectivo: 100000, creado_en: new Date().toISOString(), lineas, ...extra,
});
const libre = (precio: unknown, descripcion: unknown = 'Bocina', extra: Record<string, unknown> = {}) =>
  ({ codigo: 'LIBRE', nombre: 'lo que mande la caja', producto_id: LIBRE_ID, cantidad: 1, precio, descripcion, ...extra });
const lineasDe = (db: ReturnType<typeof tienda>['db'], id: string) =>
  db.prepare('select producto_id, codigo, nombre, precio, cantidad, propietario from venta_lineas where venta_id = ? order by id').all(id) as
    { producto_id: string; codigo: string; nombre: string; precio: number; cantidad: number; propietario: string }[];

test('la migracion 086 deja el producto fijo: sin existencias, de la tienda y sin precio (no sale en el catalogo de la caja)', async () => {
  const { db, pedir } = tienda();
  const p = db.prepare('select codigo, nombre, precio, sin_inventario, stock, propietario, estado_analisis from productos where id = ?').get(LIBRE_ID) as Record<string, unknown>;
  assert.deepEqual({ ...p }, { codigo: 'LIBRE', nombre: 'Sin etiqueta', precio: 0, sin_inventario: 1, stock: 0, propietario: 'dolaron', estado_analisis: 'listo' });
  assert.equal(LIBRE_ID, '00000000-0000-4000-8000-000000000098');
  const catalogo = await pedir('/api/catalogo');
  assert.equal(catalogo.status, 200);
  assert.ok(!JSON.stringify(catalogo.cuerpo).includes('LIBRE'));
  // Repetible: correrla otra vez no duplica ni cambia nada.
  db.exec(readFileSync('migracion-086-sin-etiqueta.sql', 'utf8'));
  assert.equal((db.prepare(`select count(*) as n from productos where codigo = 'LIBRE'`).get() as { n: number }).n, 1);
});

test('una bocina de $600 sin etiqueta se cobra: guarda el precio y «Sin etiqueta: Bocina» y no toca existencias', async () => {
  const { db, pedir } = tienda();
  const v = venta([libre(60000)]);
  const r = await pedir('/api/ventas', v);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const venta_ = db.prepare('select total from ventas where id = ?').get(v.id) as { total: number };
  assert.equal(venta_.total, 60000);
  assert.deepEqual(lineasDe(db, v.id).map((l) => ({ ...l })), [
    { producto_id: LIBRE_ID, codigo: 'LIBRE', nombre: 'Sin etiqueta: Bocina', precio: 60000, cantidad: 1, propietario: 'dolaron' }]);
  assert.deepEqual({ ...(db.prepare('select stock, precio from productos where id = ?').get(LIBRE_ID) as object) }, { stock: 0, precio: 0 });
});

test('precio fuera de rango, con centavos sueltos, de texto o sin descripcion: 400 con mensaje claro y no se escribe nada', async () => {
  const { db, pedir } = tienda();
  const malas: [unknown, unknown, RegExp][] = [
    [undefined, 'Bocina', /precio/], [0, 'Bocina', /precio/], [99, 'Bocina', /precio/], [2_000_001, 'Bocina', /precio/],
    [600.5, 'Bocina', /precio/], ['600', 'Bocina', /precio/], [null, 'Bocina', /precio/], [Number.NaN, 'Bocina', /precio/],
    [60000, undefined, /qué es/], [60000, '', /qué es/], [60000, '   ', /qué es/], [60000, 'x'.repeat(41), /qué es/], [60000, 7, /qué es|precio/],
  ];
  for (const [precio, descripcion, mensaje] of malas) {
    const r = await pedir('/api/ventas', venta([{ ...libre(precio), descripcion }]));
    assert.equal(r.status, 400, `${String(precio)} / ${String(descripcion)}`);
    assert.match(String(r.cuerpo.error), mensaje);
  }
  assert.equal((db.prepare('select count(*) as n from ventas').get() as { n: number }).n, 0);
  // Los extremos valen: $1 y $20,000, y 40 letras.
  assert.equal((await pedir('/api/ventas', venta([libre(100)]))).status, 201);
  assert.equal((await pedir('/api/ventas', venta([libre(2_000_000, 'x'.repeat(40))], { efectivo: 2_000_000 }))).status, 201);
});

test('la descripcion se limpia: espacios juntos, saltos y comillas raras no pasan al nombre guardado', async () => {
  const { db, pedir } = tienda();
  assert.equal(descripcionLibre('  Bocina   <b>"JBL"</b>\n`x` '), 'Bocina b JBL /b x');
  const v = venta([libre(60000, '  Bocina\n"JBL"  ')]);
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  assert.equal(lineasDe(db, v.id)[0].nombre, 'Sin etiqueta: Bocina JBL');
});

test('en una pieza normal el precio que manda el cliente se sigue ignorando (y la descripcion tambien)', async () => {
  const { db, pedir } = tienda();
  const v = venta([{ producto_id: PRODUCTO, cantidad: 1, precio: 100, descripcion: 'Bocina' }]);
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  assert.deepEqual(lineasDe(db, v.id).map((l) => [l.nombre, l.precio]), [['Ventilador', 25000]]);
});

test('dos piezas sin etiqueta con precios distintos, y una normal, en el mismo ticket: cada una con su precio y total correcto', async () => {
  const { db, pedir } = tienda();
  const v = venta([libre(60000, 'Bocina'), libre(35050, 'Cable'), { producto_id: PRODUCTO, cantidad: 2 }], { efectivo: 200000 });
  const r = await pedir('/api/ventas', v);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.deepEqual(lineasDe(db, v.id).map((l) => [l.nombre, l.precio, l.cantidad]),
    [['Sin etiqueta: Bocina', 60000, 1], ['Sin etiqueta: Cable', 35050, 1], ['Ventilador', 25000, 2]]);
  assert.equal((db.prepare('select total from ventas where id = ?').get(v.id) as { total: number }).total, 60000 + 35050 + 50000);
  assert.equal((db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 48);
});

test('sin Buen Fin: el precio escrito es el final aunque la ventana este abierta', async () => {
  const { db, pedir, env } = tienda();
  (env as unknown as Record<string, string>).BUENFIN_DESDE = '2020-01-01T00:00:00Z';
  (env as unknown as Record<string, string>).BUENFIN_HASTA = '2099-01-01T00:00:00Z';
  const v = venta([libre(60000), { producto_id: PRODUCTO, cantidad: 1 }]);
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  const lineas = lineasDe(db, v.id);
  assert.equal(lineas[0].precio, 60000);
  assert.ok(lineas[1].precio < 25000, 'la ventana esta abierta: la pieza normal si baja');
});

test('el hash de una venta normal no cambia: es exactamente el de antes de #880', async () => {
  const { db, pedir } = tienda();
  const v = venta([{ producto_id: PRODUCTO, cantidad: 2, precio: 25000, descripcion: 'ignorada' }]);
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  // El pedido que armaba el servidor antes: producto y cantidad por linea, sin precio ni descripcion.
  const antes = JSON.stringify({
    lineas: [[PRODUCTO, 2]], forma_pago: 'efectivo', efectivo: v.efectivo, creado_en: v.creado_en, cliente_id: null, dolarones: 0,
    codigo_socio: '', codigo_vale: '', caja: 'Caja 1',
  });
  assert.equal((db.prepare('select pedido_hash from ventas where id = ?').get(v.id) as { pedido_hash: string }).pedido_hash,
    createHash('sha256').update(antes).digest('hex'));
});

test('reintento de una venta sin etiqueta: idempotente con lo mismo, 409 si cambia el precio o la descripcion', async () => {
  const { db, pedir } = tienda();
  const v = venta([libre(60000)]);
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  const otra = await pedir('/api/ventas', v);
  assert.equal(otra.status, 200);
  assert.equal(otra.cuerpo.duplicada, true);
  assert.equal((await pedir('/api/ventas', { ...v, lineas: [libre(70000)] })).status, 409);
  assert.equal((await pedir('/api/ventas', { ...v, lineas: [libre(60000, 'Parlante')] })).status, 409);
  assert.equal(lineasDe(db, v.id).length, 1);
  assert.equal((db.prepare('select total from ventas where id = ?').get(v.id) as { total: number }).total, 60000);
});

test('devolver una pieza sin etiqueta: regresa su dinero y no sube existencias de un producto que no las lleva', async () => {
  const { db, pedir } = tienda();
  const v = venta([libre(60000), libre(10000, 'Cable')]);
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  const [linea] = db.prepare('select id from venta_lineas where venta_id = ? order by id').all(v.id) as { id: number }[];
  const r = await pedir(`/api/ventas/${v.id}/lineas/${linea.id}/cancelar`, { id: crypto.randomUUID(), cantidad: 1, motivo: 'prueba', caja: 'Caja 1' });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.devuelto, 60000);
  assert.deepEqual({ ...(db.prepare('select stock from productos where id = ?').get(LIBRE_ID) as object) }, { stock: 0 });
  // La otra linea LIBRE sigue entera: se devuelve por linea, no por producto.
  assert.deepEqual((db.prepare('select cancelada_cantidad as c from venta_lineas where venta_id = ? order by id').all(v.id) as { c: number }[]).map((x) => x.c), [1, 0]);
});

test('cancelar el ticket completo con una pieza sin etiqueta: se cancela sin tocar existencias', async () => {
  const { db, pedir } = tienda();
  const v = venta([libre(60000)]);
  assert.equal((await pedir('/api/ventas', v)).status, 201);
  const r = await pedir(`/api/ventas/${v.id}/cancelar`, { motivo: 'prueba', caja: 'Caja 1' });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal((db.prepare('select cancelada from ventas where id = ?').get(v.id) as { cancelada: number }).cancelada, 1);
  assert.equal((db.prepare('select stock from productos where id = ?').get(LIBRE_ID) as { stock: number }).stock, 0);
});

test('la caja: agregar nunca junta dos renglones sin etiqueta aunque coincidan precio y descripcion; las demas piezas siguen juntandose', () => {
  const un = { codigo: 'LIBRE', nombre: 'Sin etiqueta: Bocina', precio: 60000, producto_id: LIBRE_ID, descripcion: 'Bocina', libre: true };
  const dos = agregar(agregar([], un), un);
  assert.deepEqual(dos.map((l: { cantidad: number }) => l.cantidad), [1, 1]);
  const normal = { codigo: 'ED-000001', nombre: 'Ventilador', precio: 25000, producto_id: PRODUCTO };
  assert.deepEqual(agregar(agregar(dos, normal), normal).map((l: { cantidad: number }) => l.cantidad), [1, 1, 2]);
  assert.equal(totales(dos).subtotal, 120000);
});

test('la caja convierte pesos a centavos enteros sin errores de flotante', () => {
  for (const [texto, centavos] of [['600', 60000], ['600.50', 60050], ['19.99', 1999], ['0.29', 29], ['1.15', 115], ['20000', 2_000_000]] as const)
    assert.equal(centavosDeTexto(texto), centavos, texto);
  for (const malo of ['', 'abc', '6,00', '-5', '1.234', '$600']) assert.equal(centavosDeTexto(malo), null, malo);
});

test('la pantalla de la caja trae el boton, su dialogo y manda descripcion solo en la linea sin etiqueta', () => {
  const html = readFileSync('public/caja.html', 'utf8');
  for (const trozo of ['id="sin-etiqueta"', 'id="dlg-libre"', 'id="libre-descripcion"', 'id="libre-precio"', 'Agregar al ticket', 'producto_id: LIBRE_ID', 'libre: true'])
    assert.ok(html.includes(trozo), trozo);
  assert.ok(html.includes('descripcion === undefined ? {} : { descripcion }'));
});
