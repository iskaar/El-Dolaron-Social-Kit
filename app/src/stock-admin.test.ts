// node --test src/stock-admin.test.ts
// Issue #242: el admin no devuelve a la existencia lo que la caja ya vendio, y
// "Retomar foto" solo cambia la foto.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';

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
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`, { stock: 12, precio: 25000 }, 'PATCH')).cuerpo.stock, 12);
  assert.equal(stock(t), 12);
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`, { stock: 1000, precio: 25000 }, 'PATCH')).status, 400);
  assert.equal(stock(t), 12);
});

test('D1 (#473): en una pieza lista, la existencia del PATCH exige la vista y deja auditoría; la vencida no pisa la venta', async () => {
  const t = tienda();
  try {
    const ruta = `/api/borradores/${PRODUCTO}`;
    const fila = () => t.db.prepare('select nombre, stock from productos where id = ?').get(PRODUCTO) as { nombre: string; stock: number };
    const rastros = () => (t.db.prepare('select count(*) n from conteo_ajustes where producto_id = ?').get(PRODUCTO) as { n: number }).n;
    const corregir = (cuerpo: object) => t.pedir(ruta, { nombre: 'Ventilador nuevo', precio: 25000, ...cuerpo }, 'PATCH');
    t.db.prepare("update productos set estado_analisis = 'listo' where id = ?").run(PRODUCTO);
    // Sin la existencia vista no hay escritura a ciegas; nada cambia, ni el nombre.
    const sin = await corregir({ stock: 40 });
    assert.equal(sin.status, 409); assert.equal(sin.cuerpo.stock, 50);
    assert.deepEqual({ ...fila() }, { nombre: 'Ventilador', stock: 50 }); assert.equal(rastros(), 0);
    // La caja vendió 3 después de abrir la ficha: la existencia vista (50) ya venció.
    t.db.prepare('update productos set stock = 47 where id = ?').run(PRODUCTO);
    const vieja = await corregir({ stock: 40, stock_esperado: 50 });
    assert.equal(vieja.status, 409); assert.equal(vieja.cuerpo.stock, 47);
    assert.deepEqual({ ...fila() }, { nombre: 'Ventilador', stock: 47 }); assert.equal(rastros(), 0);
    // Con la vigente se escribe, con su renglón; los demás campos se guardan.
    const buena = await corregir({ stock: 40, stock_esperado: 47 });
    assert.equal(buena.status, 200); assert.equal(buena.cuerpo.stock, 40);
    assert.deepEqual({ ...fila() }, { nombre: 'Ventilador nuevo', stock: 40 });
    assert.deepEqual({ ...t.db.prepare('select motivo, antes, despues, ajustado_por from conteo_ajustes where producto_id = ?').get(PRODUCTO)! },
      { motivo: 'correccion', antes: 47, despues: 40, ajustado_por: DUENO });
    // Sin tocar la existencia (stock = lo visto) no hay escritura ni renglón; sin `stock` tampoco se exige nada.
    assert.equal((await corregir({ stock: 40, stock_esperado: 40 })).status, 200);
    assert.equal((await corregir({})).status, 200);
    assert.equal(rastros(), 1);
    // Una pieza que aún no está lista conserva la escritura absoluta.
    t.db.prepare("update productos set estado_analisis = 'pendiente' where id = ?").run(PRODUCTO);
    assert.equal((await corregir({ stock: 7 })).cuerpo.stock, 7);
    assert.equal(rastros(), 1);
  } finally { t.db.close(); }
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

test('la camara reenvia el mismo id: actualiza la talla pero conserva el stock (#312)', async () => {
  const t = tienda();
  const id = crypto.randomUUID();
  assert.equal((await subir(t, foto(id, { cantidad: '2', talla: 'S' }))).status, 201);
  t.db.prepare('update productos set stock = 1 where id = ?').run(id);   // la caja vendio 1 antes del reenvio
  assert.equal((await subir(t, foto(id, { cantidad: '5', talla: 'L' }))).status, 201);
  const fila = t.db.prepare('select stock, talla from productos where id = ?').get(id);
  assert.deepEqual({ ...fila }, { stock: 1, talla: 'L' });
});

test('con etiqueta, solo el dueno cambia el precio; sin etiqueta, el capturista lo pone (#75)', async () => {
  const t = tienda();
  t.db.prepare("insert into usuarios(correo, roles, activo, editar_inventario, creado_en, actualizado_en) values ('cap@prueba.mx', 'capturista', 1, 1, '', '')").run();
  t.env.DEV_USUARIO = 'cap@prueba.mx';
  const precio = () => (t.db.prepare('select precio from productos where id = ?').get(PRODUCTO) as { precio: number }).precio;
  const ruta = `/api/borradores/${PRODUCTO}`;
  for (const cuerpo of [{ precio: 5000 }, { precio_lista: 10000 }]) {
    const r = await t.pedir(ruta, cuerpo, 'PATCH');
    assert.equal(r.status, 403, JSON.stringify(cuerpo));
    assert.equal(precio(), 25000);
  }
  assert.equal((await t.pedir(ruta, { nombre: 'Ventilador de pie', precio: 25000 }, 'PATCH')).status, 200);
  t.db.prepare("update productos set codigo = null where id = ?").run(PRODUCTO);
  assert.equal((await t.pedir(ruta, { precio: 5000 }, 'PATCH')).cuerpo.precio, 5000);
  t.db.prepare("update productos set codigo = 'ED-000001' where id = ?").run(PRODUCTO);
  t.env.DEV_USUARIO = DUENO;
  assert.equal((await t.pedir(ruta, { precio: 9000 }, 'PATCH')).cuerpo.precio, 9000);
});

test('La lista del admin trae el codigo para buscar por codigo de barras (#356)', async () => {
  const r = await tienda().pedir('/api/borradores', undefined, 'GET');
  assert.equal(r.status, 200);
  assert.equal((r.cuerpo as unknown as { id: string; codigo: string }[]).find((p) => p.id === PRODUCTO)?.codigo, 'ED-000001');
});
