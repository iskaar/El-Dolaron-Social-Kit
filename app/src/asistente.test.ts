// node --test src/asistente.test.ts: enlace privado del asistente de WhatsApp (Issue #296).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

const TOKEN = 'token-de-prueba-largo-0123456789';

function producto(t: ReturnType<typeof tienda>, datos: { nombre: string; precio: number; estado?: string; analisis?: string; stock?: number; sinInventario?: number }) {
  t.db.prepare(`insert into productos (id, codigo, nombre, precio_lista, precio, estado_fisico, estado_analisis, stock, sin_inventario, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'S41', '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z')`)
    .run(crypto.randomUUID(), `ED-${crypto.randomUUID().slice(0, 8)}`, datos.nombre, datos.precio, datos.precio,
      datos.estado ?? 'nuevo', datos.analisis ?? 'listo', datos.stock ?? 1, datos.sinInventario ?? 0);
}

function abrir() {
  const t = tienda();
  t.env.ASISTENTE_TOKEN = TOKEN;
  producto(t, { nombre: 'Camisa polo caballero', precio: 25000 });
  producto(t, { nombre: 'Camisa dañada', precio: 9000, estado: 'danado' });
  producto(t, { nombre: 'Camisa sin revisar', precio: 9000, analisis: 'pendiente' });
  producto(t, { nombre: 'Camisa agotada', precio: 9000, stock: 0 });
  producto(t, { nombre: 'Bin de camisas', precio: 45000, stock: 0, sinInventario: 1 });
  producto(t, { nombre: 'Pantalón de mezclilla', precio: 30000 });
  return t;
}
const cabecera = (token: string | null) => (token === null ? {} : { 'x-asistente-token': token });

test('solo lista piezas nuevas, revisadas y con existencia; el bin sin inventario sí aparece', async () => {
  const t = abrir();
  try {
    const r = await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera(TOKEN));
    assert.equal(r.status, 200);
    const nombres = r.cuerpo.productos.map((p: { nombre: string }) => p.nombre).sort();
    assert.deepEqual(nombres, ['Bin de camisas', 'Camisa polo caballero']);
    const polo = r.cuerpo.productos.find((p: { nombre: string }) => p.nombre === 'Camisa polo caballero');
    assert.match(polo.precio, /250/);
    assert.equal(Object.keys(polo).sort().join(','), 'nombre,precio');
  } finally { t.db.close(); }
});

test('los comodines de la búsqueda no devuelven todo el catálogo', async () => {
  const t = abrir();
  try {
    const r = await t.pedir('/api/asistente/productos?q=%25', undefined, 'GET', cabecera(TOKEN));
    assert.deepEqual(r.cuerpo.productos.map((p: { nombre: string }) => p.nombre), []);
  } finally { t.db.close(); }
});

test('sin token correcto o sin configurar, la tienda no responde datos', async () => {
  const t = abrir();
  try {
    assert.equal((await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera(null))).status, 401);
    assert.equal((await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera('otro'))).status, 401);
    t.env.ASISTENTE_TOKEN = undefined;
    assert.equal((await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera(TOKEN))).status, 503);
  } finally { t.db.close(); }
});

test('otras rutas del asistente responden 404 aun con token', async () => {
  const t = abrir();
  try {
    assert.equal((await t.pedir('/api/asistente/apartar', {}, 'POST', cabecera(TOKEN))).status, 404);
  } finally { t.db.close(); }
});
