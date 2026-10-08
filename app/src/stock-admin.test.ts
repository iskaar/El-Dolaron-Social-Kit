// node --test src/stock-admin.test.ts
// Issue #242: el admin no devuelve a la existencia lo que la caja ya vendio, y
// "Retomar foto" solo cambia la foto.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const stock = (t: ReturnType<typeof tienda>, id = PRODUCTO) =>
  (t.db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;

test('PATCH sin stock conserva la existencia que bajo la caja; la respuesta trae la real', async () => {
  const t = tienda();
  t.db.prepare('update productos set stock = 47 where id = ?').run(PRODUCTO);   // se vendieron 3 despues de abrir la ficha
  const r = await t.pedir(`/api/borradores/${PRODUCTO}`, { nombre: 'Ventilador de pie', precio_lista: 30000 }, 'PATCH');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.stock, 47);
  assert.equal(stock(t), 47);
});

test('PATCH con stock explicito sigue fijando la existencia', async () => {
  const t = tienda();
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`, { stock: 12 }, 'PATCH')).cuerpo.stock, 12);
  assert.equal(stock(t), 12);
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`, { stock: 1000 }, 'PATCH')).status, 400);
  assert.equal(stock(t), 12);
});

function foto(id: string, extra: Record<string, string>) {
  const cuerpo = new FormData();
  cuerpo.append('id', id);
  cuerpo.append('estado_fisico', 'nuevo');
  cuerpo.append('foto', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], `${id}.jpg`, { type: 'image/jpeg' }));
  for (const [k, v] of Object.entries(extra)) cuerpo.append(k, v);
  return cuerpo;
}
const subir = (t: ReturnType<typeof tienda>, cuerpo: FormData) =>
  worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never, t.env, t.ctx as never);

test('Retomar foto conserva existencia, talla, estado y lo ya revisado', async () => {
  const t = tienda();
  const id = crypto.randomUUID();
  assert.equal((await subir(t, foto(id, { cantidad: '40', talla: 'M' }))).status, 201);
  await t.esperar();
  t.db.prepare("update productos set nombre = 'Playera Gap', precio = 9900, estado_analisis = 'listo', estado_fisico = 'danado' where id = ?").run(id);

  const r = await subir(t, foto(id, { solo_foto: '1' }));
  assert.equal(r.status, 200);
  await t.esperar();
  const fila = t.db.prepare('select stock, talla, estado_fisico, nombre, precio, estado_analisis from productos where id = ?').get(id);
  assert.deepEqual({ ...fila }, { stock: 40, talla: 'M', estado_fisico: 'danado', nombre: 'Playera Gap', precio: 9900, estado_analisis: 'listo' });
});

test('la camara reenvia el mismo id con cantidad y talla: sigue actualizando ambas', async () => {
  const t = tienda();
  const id = crypto.randomUUID();
  assert.equal((await subir(t, foto(id, { cantidad: '2', talla: 'S' }))).status, 201);
  assert.equal((await subir(t, foto(id, { cantidad: '5', talla: 'L' }))).status, 201);
  const fila = t.db.prepare('select stock, talla from productos where id = ?').get(id);
  assert.deepEqual({ ...fila }, { stock: 5, talla: 'L' });
});
