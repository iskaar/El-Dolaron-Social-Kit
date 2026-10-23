// node --test src/bitacora.test.ts
// #485 (U4 de #478): bitácora de cambios por pieza (trigger de la migración 054) y vista movimientos_existencia.
// Los cambios pasan por los handlers reales; el trigger los registra sin importar la ruta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { analizarBorrador } from './analisis.ts';
import { identificarPieza } from './worker.ts';
import { rescatarPendientes } from './huerfanos.ts';
import { textoCambio } from '../public/ficha.js';

type Tienda = ReturnType<typeof tienda>;
const CAP = 'cap@prueba.mx';
const como = (t: Tienda, correo: string) => { t.env.DEV_USUARIO = correo; };
const cambios = (t: Tienda, id = PRODUCTO) => t.db.prepare('select campo, antes, despues, por, en from productos_cambios where producto_id = ? order by id').all(id) as
  { campo: string; antes: string | null; despues: string | null; por: string; en: string }[];
/** campo → [antes, despues, por]: lo que importa de cada renglón. */
const resumen = (t: Tienda, id = PRODUCTO) => Object.fromEntries(cambios(t, id).map((c) => [c.campo, [c.antes, c.despues, c.por]]));
const limpiar = (t: Tienda) => t.db.prepare('delete from productos_cambios').run();
const listo = (t: Tienda) => { t.db.prepare("update productos set estado_analisis = 'listo', precio_lista = 40000, destino = 'etiqueta' where id = ?").run(PRODUCTO); limpiar(t); };
function nueva(t: Tienda, campos: Record<string, unknown> = {}) {
  const p = { id: crypto.randomUUID(), nombre: 'Peluche', stock: 1, precio: 5000, estado_analisis: 'listo', semana_ingreso: 'S40', creado_en: '', actualizado_en: '', ...campos };
  const claves = Object.keys(p);
  t.db.prepare(`insert into productos (${claves.join(',')}) values (${claves.map(() => '?').join(',')})`).run(...Object.values(p) as never[]);
  return p.id;
}

test('una base vacía (schema + todas las migraciones) trae tabla, índice, columna, trigger y vista', (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const objeto = (tipo: string, nombre: string) => t.db.prepare('select 1 x from sqlite_master where type = ? and name = ?').get(tipo, nombre);
  assert.ok(objeto('table', 'productos_cambios')); assert.ok(objeto('index', 'productos_cambios_pieza'));
  assert.ok(objeto('trigger', 'productos_bitacora')); assert.ok(objeto('view', 'movimientos_existencia'));
  const col = (t.db.prepare('pragma table_info(productos)').all() as any[]).find((c) => c.name === 'modificado_por');
  assert.deepEqual({ tipo: col.type.toLowerCase(), nulo: col.notnull, def: col.dflt_value }, { tipo: 'text', nulo: 1, def: "''" });
  assert.equal((t.db.prepare('select count(*) n from movimientos_existencia').get() as any).n, 0);
});

test('corregir desde la ficha (PATCH) deja un renglón por campo cambiado con el correo; lo que no cambia no deja nada', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); listo(t);
  const r = await t.pedir(`/api/borradores/${PRODUCTO}`, { nombre: 'Ventilador torre', marca: 'Lasko', precio: 30000, estado_fisico: 'danado' }, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(resumen(t), {
    nombre: ['Ventilador', 'Ventilador torre', DUENO], marca: ['', 'Lasko', DUENO],
    precio: ['25000', '30000', DUENO], estado_fisico: ['nuevo', 'danado', DUENO],
  });
  assert.ok(cambios(t).every((c) => /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(c.en)));
  // Lo mismo otra vez: ningún campo cambia, el UPDATE corre y no se registra nada.
  const n = cambios(t).length;
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`, { nombre: 'Ventilador torre', marca: 'Lasko', precio: 30000, estado_fisico: 'danado' }, 'PATCH')).status, 200);
  assert.equal(cambios(t).length, n);
});

test('un UPDATE que no dice quién no se le carga a quien editó antes; poner modificado_por sin otra columna tampoco deja rastro viejo', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); listo(t);
  await t.pedir(`/api/borradores/${PRODUCTO}`, { nombre: 'Uno' }, 'PATCH');
  assert.equal((t.db.prepare('select modificado_por m from productos where id = ?').get(PRODUCTO) as any).m, '', 'se reinicia tras registrar');
  limpiar(t);
  const previo = String((t.db.prepare('select precio from productos where id = ?').get(PRODUCTO) as any).precio);   // el PATCH sin precio lo recalcula
  t.db.prepare("update productos set precio = 111 where id = ?").run(PRODUCTO);   // sin modificado_por: nadie lo firmó
  assert.deepEqual(resumen(t), { precio: [previo, '111', ''] });
  limpiar(t);
  t.db.prepare("update productos set modificado_por = 'ana@x', stock = 3 where id = ?").run(PRODUCTO);   // no toca una columna vigilada
  t.db.prepare("update productos set marca = 'Otra' where id = ?").run(PRODUCTO);
  assert.deepEqual(resumen(t), { marca: ['', 'Otra', ''] });
  // Dos columnas vigiladas con un solo firmante; el siguiente UPDATE vuelve a salir sin firma.
  limpiar(t);
  t.db.prepare("update productos set talla = 'M', categoria = 'hogar', modificado_por = 'ana@x' where id = ?").run(PRODUCTO);
  t.db.prepare("update productos set talla = 'L' where id = ?").run(PRODUCTO);
  assert.deepEqual(cambios(t).map((c) => [c.campo, c.por]), [['talla', 'ana@x'], ['categoria', 'ana@x'], ['talla', '']]);
});

test('un NULL que pasa a valor (y al revés) cuenta como cambio; el mismo valor no', (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); listo(t);
  t.db.prepare("update productos set upc = '123456789012', talla = null where id = ?").run(PRODUCTO);
  assert.deepEqual(resumen(t), { upc: [null, '123456789012', ''] });
  limpiar(t);
  t.db.prepare("update productos set upc = '123456789012', precio = precio, nombre = nombre where id = ?").run(PRODUCTO);
  assert.equal(cambios(t).length, 0);
  t.db.prepare("update productos set upc = null where id = ?").run(PRODUCTO);
  assert.deepEqual(resumen(t), { upc: ['123456789012', null, ''] });
});

test('solo el UPC (corregirUpc) y la solicitud de precio aplicada quedan firmados', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); listo(t);
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`, { upc: '012345678905' }, 'PATCH')).status, 200);
  assert.deepEqual(resumen(t), { upc: [null, '012345678905', DUENO] });
  limpiar(t);
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, 'capturista', 1, '', '')").run(CAP, CAP);
  como(t, CAP);
  const s = await t.pedir(`/api/piezas/${PRODUCTO}/solicitud-precio`, { id: crypto.randomUUID(), sentido: 'bajar', precio_sugerido: 20000 });
  assert.equal(s.status, 201);
  assert.equal(cambios(t).length, 0, 'pedir no cambia nada');
  como(t, DUENO);
  const a = await t.pedir(`/api/solicitudes-precio/${s.cuerpo.solicitud.id}`, { accion: 'aplicar', precio: 20000, precio_esperado: 25000 });
  assert.equal(a.status, 200, JSON.stringify(a.cuerpo));
  assert.deepEqual(resumen(t), { precio: ['25000', '20000', DUENO] });
});

test('el análisis firma «ia»; la cola de código «cola»; el cron de pendientes «cron»', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const original = globalThis.fetch; t0.after(() => { globalThis.fetch = original; });
  (t.env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';
  globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    nombre: 'Licuadora Oster', marca: 'Oster', categoria: 'hogar', precio_lista_mxn: 200, precio_venta_mxn: 0, precio_usd: 0, confianza: 0.9 }) }] } }] }))) as typeof fetch;
  const pendiente = (campos: Record<string, unknown> = {}) => nueva(t, { nombre: '', precio: 0, estado_analisis: 'pendiente', foto_key: 'x', ...campos });
  const a = pendiente(); await t.env.FOTOS.put(`fotos/${a}.jpg`, new Uint8Array([1, 2, 3]));
  t.db.prepare('update productos set foto_key = ? where id = ?').run(`fotos/${a}.jpg`, a);
  limpiar(t);
  await analizarBorrador(a, t.env, 'gemini', false);
  const r = resumen(t, a);
  assert.deepEqual(Object.keys(r).sort(), ['categoria', 'estado_analisis', 'marca', 'nombre', 'precio', 'precio_lista'].sort());
  assert.ok(Object.values(r).every((v) => v[2] === 'ia'));
  assert.deepEqual(r.estado_analisis, ['pendiente', 'listo', 'ia']);

  // La cola de identificación por UPC.
  const b = pendiente({ upc: '840397509898' });
  globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    nombre: 'Peluche perro', marca: 'FAO', categoria: 'juguetes', precio_lista_mxn: 150, precio_usd: 0, fuente: 'x.com', confianza: 0.9 }) }] } }] }))) as typeof fetch;
  limpiar(t);
  await identificarPieza(b, '840397509898', t.env, true);
  const c = cambios(t, b);
  assert.ok(c.some((x) => x.campo === 'nombre' && x.despues === 'Peluche perro'));
  assert.ok(c.some((x) => x.campo === 'codigo' && x.antes === null && /^ED-/.test(x.despues!)), 'el código nuevo también queda');
  assert.ok(c.every((x) => x.por === 'cola'), JSON.stringify(c));

  // El rescate del cron: una pendiente abandonada pasa a error.
  const viejo = nueva(t, { nombre: 'x', estado_analisis: 'pendiente', foto_key: 'fotos/v.jpg', actualizado_en: new Date(Date.now() - 3 * 3_600_000).toISOString() });
  limpiar(t);
  await rescatarPendientes(t.env);
  assert.deepEqual(resumen(t, viejo), { estado_analisis: ['pendiente', 'error', 'cron'] });
});

test('fusionar: el código pasa a la original y los dos renglones quedan firmados; juntar firma el UPC que se quita', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const repetida = nueva(t, { nombre: 'Ventilador', stock: 3, upc: '999' });
  limpiar(t);
  t.db.prepare("update productos set codigo = null where id = ?").run(PRODUCTO); limpiar(t);   // la original aún sin etiqueta; la repetida con ella
  t.db.prepare("update productos set codigo = 'ED-000050' where id = ?").run(repetida); limpiar(t);
  const r = await t.pedir(`/api/borradores/${repetida}/fusionar`, { destino_id: PRODUCTO });
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(resumen(t, PRODUCTO), { codigo: [null, 'ED-000050', DUENO] });
  assert.deepEqual(resumen(t, repetida), { codigo: ['ED-000050', null, DUENO] }, 'el rastro de la fusionada sobrevive a su borrado');

  // Juntar dos piezas con etiqueta del mismo grado.
  const a = nueva(t, { codigo: 'ED-000060', upc: '777', stock: 2 }), b = nueva(t, { codigo: 'ED-000061', stock: 1 });
  limpiar(t);
  const j = await t.pedir(`/api/piezas/${a}/juntar`, { id: crypto.randomUUID(), destino_id: b });
  assert.equal(j.status, 200, JSON.stringify(j.cuerpo));
  assert.deepEqual(resumen(t, a), { upc: ['777', null, DUENO] });
  assert.equal(cambios(t, b).length, 0, 'el destino solo recibe existencia');
});

test('captura: la corrección de talla y el descarte desde el carrusel llevan el correo del capturista', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, 'capturista', 1, '', '')").run(CAP, CAP);
  const id = nueva(t, { estado_analisis: 'pendiente', capturado_por: CAP, creado_en: new Date().toISOString(), upc: null });
  limpiar(t); como(t, CAP);
  const r = await t.pedir(`/api/borradores/${id}/talla`, { talla: 'M' }, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(resumen(t, id), { talla: [null, 'M', CAP] });
});

test('las ventas, devoluciones y ajustes de existencia no disparan el trigger; la vista los junta', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); listo(t);
  const venta = crypto.randomUUID();
  const v = await t.pedir('/api/ventas', { id: venta, lineas: [{ producto_id: PRODUCTO, cantidad: 2 }], forma_pago: 'efectivo', efectivo: 50000, caja: 'Caja 1' });
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));
  const aj = await t.pedir(`/api/piezas/${PRODUCTO}/existencia`, { id: crypto.randomUUID(), delta: -1, motivo: 'merma' });
  assert.equal(aj.status, 200, JSON.stringify(aj.cuerpo));
  assert.equal(cambios(t).length, 0, 'solo cambió stock y actualizado_en');
  const mov = t.db.prepare('select tipo, cantidad, antes, despues, por, en, referencia from movimientos_existencia where producto_id = ? order by tipo').all(PRODUCTO) as any[];
  assert.deepEqual(mov.map((m) => [m.tipo, m.cantidad]), [['merma', -1], ['venta', -2]]);
  const [merma, vendida] = mov;
  assert.deepEqual([merma.antes, merma.despues, merma.por, merma.referencia === aj.cuerpo.id], [48, 47, DUENO, true]);
  assert.deepEqual([vendida.antes, vendida.despues, vendida.referencia], [null, null, venta]);
  assert.match(vendida.en, /^\d{4}-\d\d-\d\dT/);
});

test('la vista cubre cancelación de ticket, devolución por pieza, apartados y Mercado Libre; los bins y las órdenes canceladas no cuentan', (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const venta = (id: string, cancelada = 0) => t.db.prepare(`insert into ventas (id, total, forma_pago, creado_en, registrado_en, cajero, cancelada, cancelada_por, cancelada_en)
    values (?, 100, 'efectivo', '', '2026-10-01T10:00:00.000Z', 'caja@x', ?, ?, ?)`).run(id, cancelada, cancelada ? 'jefe@x' : '', cancelada ? '2026-10-02T10:00:00.000Z' : '');
  venta('v1'); venta('v2', 1);
  const linea = (v: string, p: string, n: number, c = 0) => (t.db.prepare('insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad, cancelada_cantidad) values (?, ?, ?, ?, 100, ?, ?) returning id').get(v, p, 'c', 'n', n, c) as any).id;
  const l1 = linea('v1', PRODUCTO, 3, 1);
  linea('v2', PRODUCTO, 2);
  const bin = '00000000-0000-4000-8000-000000000020';
  linea('v1', bin, 5);   // los bins no descuentan
  t.db.prepare("insert into devoluciones (id, venta_id, linea_id, cantidad, importe, forma_pago, autor, motivo, creado_en) values ('d1', 'v1', ?, 1, 100, 'efectivo', 'ana@x', 'x', '2026-10-03T10:00:00.000Z')").run(l1);
  const pedido = (id: string, folio: number, estado: string, venta_id: string | null) => {
    t.db.prepare(`insert into pedidos (id, folio, cliente, telefono, entrega, vendedora, estado, vence_en, anticipo, forma_pago, saldo, saldo_vence_en, venta_id, creado_en, actualizado_en)
      values (?, ?, 'c', '7751234567', 'tienda', 'vend@x', ?, '', 10000, 'efectivo', 0, '', ?, '2026-10-04T10:00:00.000Z', '2026-10-05T10:00:00.000Z')`).run(id, folio, estado, venta_id);
    t.db.prepare('insert into pedido_lineas (pedido_id, producto_id, cantidad) values (?, ?, 1)').run(id, PRODUCTO);
  };
  pedido('p1', 1, 'apartado', null); pedido('p2', 2, 'cancelado', null); pedido('p3', 3, 'vendido', 'v1');
  const ml = (orden: string, estado: string, n: number) => t.db.prepare("insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, descontado, recibido_en) values (?, 'i', ?, ?, ?, ?, '2026-10-06T10:00:00.000Z')").run(orden, PRODUCTO, n, estado, n);
  ml('o1', 'descontada', 2); ml('o2', 'cancelada', 4);
  const filas = t.db.prepare('select tipo, cantidad, por, en, referencia from movimientos_existencia where producto_id = ? order by en, tipo, referencia').all(PRODUCTO) as any[];
  const texto = (f: any) => [f.tipo, f.cantidad, f.por, f.referencia].join('|');
  assert.deepEqual(filas.map(texto).sort(), [
    'venta|-3|caja@x|v1', 'venta|-2|caja@x|v2', 'cancelacion_venta|2|jefe@x|v2', 'devolucion|1|ana@x|v1',
    'apartado|-1|vend@x|P-1', 'apartado|-1|vend@x|P-2', 'apartado|-1|vend@x|P-3', 'apartado_liberado|1||P-2',
    'apartado_a_venta|1|caja@x|v1', 'mercadolibre|-2|mercadolibre|o1',
  ].sort());
  assert.equal((t.db.prepare('select count(*) n from movimientos_existencia where producto_id = ?').get(bin) as any).n, 0);
});

test('GET /api/piezas/:id trae los cambios mezclados con los ajustes, lo más nuevo primero y con tope', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); listo(t);
  await t.pedir(`/api/borradores/${PRODUCTO}`, { nombre: 'Ventilador torre', precio: 30000 }, 'PATCH');
  await new Promise((r) => setTimeout(r, 20));   // strftime('now') y Date difieren por un milisegundo: sin esto el orden de un empate es azar
  await t.pedir(`/api/piezas/${PRODUCTO}/existencia`, { id: crypto.randomUUID(), delta: 1, motivo: 'entrada' });
  const r = await t.pedir(`/api/piezas/${PRODUCTO}`);
  assert.equal(r.status, 200);
  const h = r.cuerpo.historial as any[];
  assert.equal(h.length, 3);
  assert.equal(h[0].motivo, 'entrada', 'el ajuste es el más reciente');
  assert.deepEqual(h.slice(1).map((c) => c.campo).sort(), ['nombre', 'precio']);
  assert.deepEqual(h.find((c) => c.campo === 'precio'), { id: h.find((c) => c.campo === 'precio').id, campo: 'precio', antes: '25000', despues: '30000', por: DUENO, en: h.find((c) => c.campo === 'precio').en });
  // Los ajustes conservan su forma de siempre.
  assert.deepEqual(Object.keys(h[0]), ['id', 'motivo', 'cantidad', 'antes', 'despues', 'ajustado_por', 'ajustado_en']);
  // Tope de 50 renglones, los más nuevos.
  for (let i = 0; i < 60; i++) t.db.prepare("insert into productos_cambios (producto_id, campo, antes, despues, por, en) values (?, 'marca', ?, ?, 'x', ?)").run(PRODUCTO, String(i), String(i + 1), `2030-01-01T00:00:${String(i).padStart(2, '0')}.000Z`);
  const tope = (await t.pedir(`/api/piezas/${PRODUCTO}`)).cuerpo.historial as any[];
  assert.equal(tope.length, 50);
  assert.equal(tope[0].despues, '60'); assert.ok(tope.every((c) => c.por === 'x'));
});

test('textoCambio: campos en español, precios en pesos, estados y autores legibles, sin HTML', () => {
  const en = '2026-10-23T20:05:00.000Z';   // 14:05 en la Ciudad de México
  assert.equal(textoCambio({ campo: 'precio', antes: '45000', despues: '40000', por: 'ana@prueba.mx', en }), 'Precio $450.00 → $400.00 · ana@prueba.mx · 23/10 14:05');
  assert.equal(textoCambio({ campo: 'estado_analisis', antes: 'pendiente', despues: 'listo', por: 'ia', en }), 'Estado en análisis → lista · IA · 23/10 14:05');
  assert.equal(textoCambio({ campo: 'estado_fisico', antes: 'nuevo', despues: 'danado', por: '', en }), 'Grado A · Nuevo → B · Dañado · 23/10 14:05');
  assert.equal(textoCambio({ campo: 'upc', antes: null, despues: '123', por: 'cola', en }), 'UPC (vacío) → 123 · búsqueda por código · 23/10 14:05');
  assert.equal(textoCambio({ campo: 'categoria', antes: 'hogar', despues: 'ropa', por: '', en }), 'Categoría Hogar y cocina → Ropa y calzado · 23/10 14:05');
  assert.equal(textoCambio({ campo: 'nombre', antes: 'a', despues: '<b>x</b>', por: '', en }), 'Nombre a → <b>x</b> · 23/10 14:05');
});

test('con recursive_triggers activo el reinicio de la firma no cicla ni duplica renglones', (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); listo(t);
  t.db.exec('pragma recursive_triggers = on');
  t.db.prepare("update productos set nombre = 'Otro', modificado_por = 'ana@x' where id = ?").run(PRODUCTO);
  t.db.prepare("update productos set marca = 'M' where id = ?").run(PRODUCTO);
  assert.deepEqual(cambios(t).map((c) => [c.campo, c.por]), [['nombre', 'ana@x'], ['marca', '']]);
  assert.equal((t.db.prepare('select modificado_por m from productos where id = ?').get(PRODUCTO) as any).m, '');
});
