// node --test src/grado-caducado.test.ts
// #733: grado D · Caducidad (estado_fisico = 'caducado'). Se captura como merma y NUNCA se vende ni se ofrece:
// el servidor rechaza venta y apartado, no sale en catálogo/ML/Marketplace, no suma al inventario en piso y sí a la merma de /reportes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ESTADOS, nombreEstado, siguienteEstado } from '../public/estados.js';
import { calcularPrecio } from './precio.ts';
import { tienda, PRODUCTO, datosTransferencia } from './prueba-d1.ts';
import { PUBLICABLE } from './mercadolibre.ts';
import { VENDIBLE } from './catalogo.ts';

const pieza = (extra: Record<string, unknown> = {}) =>
  ({ id: crypto.randomUUID(), nombre: 'Yogurt griego', categoria: 'hogar', estado_fisico: 'caducado', stock: 3, ...extra });

/** Una pieza D lista, con código, foto y hasta precio (de antes de pasar a D) para probar que el servidor no se fía de eso. */
function piezaD(db: DatabaseSync, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const f = { codigo: 'ED-000500', nombre: 'Leche caducada', precio: 5000, precio_lista: 8000, stock: 4, creado_en: new Date().toISOString(), ...extra };
  db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, precio_lista, stock, estado_fisico, estado_analisis, destino, foto_key,
      semana_ingreso, creado_en, actualizado_en, propietario) values (?, ?, ?, 'hogar', ?, ?, ?, 'caducado', 'listo', 'etiqueta', 'fotos/x.jpg', 'S44', ?, ?, 'dolaron')`)
    .run(id, f.codigo, f.nombre, f.precio, f.precio_lista, f.stock, f.creado_en, f.creado_en);
  return id;
}

test('D · Caducidad es el cuarto grado y la rueda de grados da la vuelta a A', () => {
  assert.deepEqual(ESTADOS.map(([e]) => e), ['nuevo', 'danado', 'liquidacion', 'caducado']);
  assert.equal(nombreEstado('caducado'), 'D · Caducidad');
  assert.equal(siguienteEstado('liquidacion'), 'caducado');
  assert.equal(siguienteEstado('caducado'), 'nuevo');
});

test('calcularPrecio: la D no tiene precio ni banda, con o sin precio de lista', () => {
  assert.deepEqual(calcularPrecio({ precioLista: 89900, categoria: 'hogar', estadoFisico: 'caducado', config: {} }), { precio: 0, destino: 'etiqueta' });
  assert.deepEqual(calcularPrecio({ precioLista: 0, categoria: 'hogar', estadoFisico: 'caducado', config: {} }), { precio: 0, destino: 'etiqueta' });
});

test('capturar una pieza D sin precio: queda lista en $0, con código y sin pedirle precio a nadie', async () => {
  const { db, pedir } = tienda();
  const c = pieza();
  const r = await pedir('/api/borradores/manual', c);
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const fila = db.prepare('select estado_fisico, estado_analisis, precio, codigo from productos where id = ?').get(c.id) as any;
  assert.deepEqual({ ...fila, codigo: /^ED-\d{6}$/.test(fila.codigo) }, { estado_fisico: 'caducado', estado_analisis: 'listo', precio: 0, codigo: true });
  // Sigue exigiendo precio a las demás: la excepción es solo de la D.
  assert.equal((await pedir('/api/borradores/manual', pieza({ estado_fisico: 'nuevo' }))).status, 400);
});

test('cambiar una pieza existente a D y de D a otro grado; pasar a D no abre solicitud de precio', async () => {
  const { db, pedir } = tienda();
  const c = pieza({ nombre: 'Licuadora Oster', estado_fisico: 'nuevo', precio_lista: 89900, stock: 2 });
  assert.equal((await pedir('/api/borradores/manual', c)).status, 201);
  const antes = (db.prepare('select precio from productos where id = ?').get(c.id) as { precio: number }).precio;
  assert.ok(antes > 0);

  const aD = await pedir(`/api/borradores/${c.id}`, { nombre: 'Licuadora Oster', estado_fisico: 'caducado' }, 'PATCH');
  assert.equal(aD.status, 200, JSON.stringify(aD.cuerpo));
  assert.deepEqual({ ...(db.prepare('select estado_fisico, precio from productos where id = ?').get(c.id) as any) }, { estado_fisico: 'caducado', precio: 0 });
  assert.equal((db.prepare('select count(*) n from solicitudes_precio where producto_id = ?').get(c.id) as { n: number }).n, 0);

  const deD = await pedir(`/api/borradores/${c.id}`, { nombre: 'Licuadora Oster', estado_fisico: 'danado' }, 'PATCH');
  assert.equal(deD.status, 200, JSON.stringify(deD.cuerpo));
  const fila = db.prepare('select estado_fisico, precio from productos where id = ?').get(c.id) as any;
  assert.equal(fila.estado_fisico, 'danado');
  assert.ok(fila.precio > 0, 'al salir de D vuelve a tener la banda del grado nuevo');
});

test('POST /api/ventas rechaza una línea con pieza D aunque traiga precio y existencias; no descuenta ni registra', async () => {
  const { db, pedir } = tienda();
  const id = piezaD(db);
  const r = await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: id, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 5000, caja: 'Caja 1' });
  assert.equal(r.status, 400, JSON.stringify(r.cuerpo));
  assert.match(String(r.cuerpo.error), /caducada/);
  assert.equal((db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock, 4);
  assert.equal((db.prepare('select count(*) n from ventas').get() as { n: number }).n, 0);
  // Una D mezclada con una pieza normal también tira todo el ticket.
  const mezcla = await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }, { producto_id: id, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 30000, caja: 'Caja 1' });
  assert.equal(mezcla.status, 400);
  assert.equal((db.prepare('select count(*) n from ventas').get() as { n: number }).n, 0);
});

test('un apartado de una pieza D se rechaza en el servidor', async () => {
  const { db, pedir } = tienda();
  const id = piezaD(db, { precio: 20000 });
  const cuerpo = { id: crypto.randomUUID(), lineas: [{ producto_id: id, cantidad: 1 }], cliente: 'Ana', telefono: '4441234567', entrega: 'tienda', anticipo: 10000,
    forma_pago: 'transferencia', caja: 'Caja 1', ...datosTransferencia(10000) };
  // Control: el mismo apartado de una pieza igual con grado A sí pasa (sin esto, el rechazo podría ser por otra razón).
  const a = piezaD(db, { codigo: 'ED-000501', precio: 20000 });
  db.prepare("update productos set estado_fisico = 'nuevo' where id = ?").run(a);
  const control = await pedir('/api/pedidos', { ...cuerpo, lineas: [{ producto_id: a, cantidad: 1 }] });
  assert.equal(control.status, 201, JSON.stringify(control.cuerpo));
  const r = await pedir('/api/pedidos', { ...cuerpo, id: crypto.randomUUID(), ...datosTransferencia(10000) });
  assert.equal(r.status, 400, JSON.stringify(r.cuerpo));
  assert.equal((db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock, 4);
});

test('la caja recibe la D en su catálogo, marcada, para avisar en vez de «código no encontrado»', async () => {
  const { db, pedir } = tienda();
  const c = pieza();
  assert.equal((await pedir('/api/borradores/manual', c)).status, 201);
  const catalogo = (await pedir('/api/catalogo')).cuerpo as unknown as { id: string; estado_fisico: string; precio: number }[];
  assert.deepEqual(catalogo.filter((p) => p.id === c.id).map((p) => [p.estado_fisico, p.precio]), [['caducado', 0]]);
  const delta = (await pedir('/api/catalogo?desde=2000-01-01T00:00:00Z')).cuerpo.piezas as { id: string; estado_fisico: string }[];
  assert.equal(delta.find((p) => p.id === c.id)?.estado_fisico, 'caducado');
  const html = readFileSync('public/caja.html', 'utf8');
  assert.match(html, /estado_fisico === 'caducado'[\s\S]{0,300}return false/);   // no la agrega
  void db;
});

test('la D no es publicable ni vendible (ML, portal, apartados, WhatsApp) ni elegible en Marketplace', async () => {
  const { db, pedir } = tienda();
  const id = piezaD(db);
  const cuenta = (donde: string) => (db.prepare(`select count(*) n from productos p where ${donde} and p.id = ?`).get(id) as { n: number }).n;
  assert.equal(cuenta(PUBLICABLE), 0);
  assert.equal(cuenta(VENDIBLE), 0);
  db.prepare("update productos set estado_fisico = 'nuevo' where id = ?").run(id);
  assert.equal(cuenta(PUBLICABLE), 1, 'control: con grado A la misma pieza sí era publicable');
  db.prepare("update productos set estado_fisico = 'caducado' where id = ?").run(id);
  const mp = (await pedir('/api/marketplace')).cuerpo.products as { id: string }[];
  assert.equal(mp.some((p) => p.id === id), false);
  const publicar = await pedir(`/api/ml/preparar/${id}`, {});
  assert.equal(publicar.status, 409);
  assert.match(String(publicar.cuerpo.error), /caducidad/);
  const lista = (await pedir('/api/ml/piezas?filtro=pendientes', undefined, 'GET')).cuerpo.piezas as { producto: { id: string } }[];
  assert.equal(lista.some((x) => x.producto.id === id), false);
  assert.match(readFileSync('public/marketplace.html', 'utf8'), /estado_fisico !== 'caducado'/);
});

test('/reportes: la D cuenta en la merma del periodo, no en ventas ni en el inventario vendible', async () => {
  const { db, pedir } = tienda();
  const reciente = piezaD(db, { codigo: 'ED-000501', nombre: 'Yogurt', precio: 0, precio_lista: 3000, stock: 4 });
  piezaD(db, { codigo: 'ED-000502', nombre: 'Leche vieja', precio: 0, precio_lista: 0, stock: 1, creado_en: '2020-01-01T00:00:00.000Z' });   // fuera del periodo
  const base = (await pedir('/api/reportes?dias=7')).cuerpo;
  assert.equal(base.merma_caducidad.piezas, 1);
  assert.equal(base.merma_caducidad.unidades, 4);
  assert.equal(base.merma_caducidad.valor_lista, 12000);
  assert.equal(base.merma_caducidad.sin_valor, 0);
  assert.deepEqual(base.merma_caducidad.detalle.map((p: any) => [p.id, p.codigo, p.stock]), [[reciente, 'ED-000501', 4]]);

  // Inventario en piso: solo el Ventilador (50 × $250). Aunque la D tuviera precio, no entra.
  db.prepare('update productos set precio = 9900 where id = ?').run(reciente);
  const piso = (await pedir('/api/reportes?dias=7')).cuerpo.inventario;
  assert.deepEqual([piso.piezas, piso.unidades, piso.valor], [1, 50, 50 * 25000]);

  // Ventas: intentar cobrarla no mueve el resumen.
  await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: reciente, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 9900, caja: 'Caja 1' });
  const final = (await pedir('/api/reportes?dias=7')).cuerpo;
  assert.deepEqual([final.resumen.ventas, final.resumen.total, final.resumen.piezas], [0, 0, 0]);
  assert.match(readFileSync('public/reportes.html', 'utf8'), /Merma por caducidad/);
});
