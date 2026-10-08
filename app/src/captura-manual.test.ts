// node --test src/captura-manual.test.ts
// Captura sin foto (Issue #115): solo el dueno, y con las reglas de la cola.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

const pieza = (extra: Record<string, unknown> = {}) =>
  ({ id: crypto.randomUUID(), nombre: 'Licuadora Oster', categoria: 'hogar', estado_fisico: 'nuevo', precio_lista: 89900, stock: 2, ...extra });

test('el dueno captura sin foto: la pieza queda revisada, con precio calculado y lista para etiqueta', async () => {
  const { db, pedir } = tienda();
  const cuerpo = pieza();
  const r = await pedir('/api/borradores/manual', cuerpo);
  assert.equal(r.status, 201);
  assert.ok(r.cuerpo.precio > 0 && r.cuerpo.precio <= 89900);
  const fila = db.prepare('select estado_analisis, foto_key, stock, capturado_por from productos where id = ?').get(cuerpo.id) as Record<string, unknown>;
  assert.deepEqual({ ...fila }, { estado_analisis: 'listo', foto_key: '', stock: 2, capturado_por: 'dueno@prueba.mx' });
  assert.equal((await pedir('/api/borradores/manual', cuerpo)).status, 201);   // reintento: la misma pieza
  assert.equal((db.prepare('select count(*) n from productos where nombre = ?').get('Licuadora Oster') as { n: number }).n, 1);
});

test('la pieza sin foto sale en la caja de inmediato, con el codigo que llevara su etiqueta', async () => {
  const { db, pedir } = tienda();
  const cuerpo = pieza({ nombre: 'Asador', destino: 'etiqueta' });
  assert.equal((await pedir('/api/borradores/manual', cuerpo)).status, 201);
  const { codigo } = db.prepare('select codigo from productos where id = ?').get(cuerpo.id) as { codigo: string };
  assert.match(codigo, /^ED-\d{6}$/);
  const catalogo = (await pedir('/api/catalogo')).cuerpo as { id: string; codigo: string }[];
  assert.equal(catalogo.find((p) => p.id === cuerpo.id)?.codigo, codigo);
  const etiquetas = (await pedir('/api/etiquetas', { ids: [cuerpo.id] })).cuerpo as { codigo: string }[];
  assert.equal(etiquetas[0].codigo, codigo);
});

test('datos malos no dejan pieza vacia; un capturista no puede', async () => {
  const { db, env, pedir } = tienda();
  const antes = (db.prepare('select count(*) n from productos').get() as { n: number }).n;
  assert.equal((await pedir('/api/borradores/manual', pieza({ nombre: '' }))).status, 400);
  assert.equal((await pedir('/api/borradores/manual', pieza({ precio_lista: 0 }))).status, 400);
  assert.equal((await pedir('/api/borradores/manual', pieza({ categoria: 'autos' }))).status, 400);
  assert.equal((db.prepare('select count(*) n from productos').get() as { n: number }).n, antes);

  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cap@prueba.mx', 'C', 'capturista', 1, '', '')`).run();
  (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'cap@prueba.mx';
  assert.equal((await pedir('/api/borradores/manual', pieza())).status, 403);
});

test('marca y categorias nuevas (#159): se guardan, salen en la cola y en el inventario', async () => {
  const { db, pedir } = tienda();
  const cuerpo = pieza({ nombre: 'Bálsamo labial', marca: '  e.l.f.  ', categoria: 'belleza' });
  assert.equal((await pedir('/api/borradores/manual', cuerpo)).status, 201);
  assert.deepEqual({ ...db.prepare('select marca, categoria from productos where id = ?').get(cuerpo.id) as object },
    { marca: 'e.l.f.', categoria: 'belleza' });
  const cola = (await pedir('/api/borradores')).cuerpo as { id: string; marca: string }[];
  assert.equal(cola.find((p) => p.id === cuerpo.id)?.marca, 'e.l.f.');
  const r = await pedir(`/api/borradores/${cuerpo.id}`, { marca: 'Elf' }, 'PATCH');
  assert.equal(r.status, 200);
  assert.equal((db.prepare('select marca from productos where id = ?').get(cuerpo.id) as { marca: string }).marca, 'Elf');
});

test('precio de venta escrito a mano en una etiqueta: queda con la decena quebrada, como el automatico', async () => {
  const { db, pedir } = tienda();
  const cuerpo = pieza();
  assert.equal((await pedir('/api/borradores/manual', cuerpo)).status, 201);
  const r = await pedir(`/api/borradores/${cuerpo.id}`, { precio: 25000 }, 'PATCH');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.precio, 24900);   // $250 -> $249, como ajustarManual
  assert.equal((db.prepare('select precio from productos where id = ?').get(cuerpo.id) as { precio: number }).precio, 24900);
});

test('fusionar dos fotos de la misma pieza: la que se queda conserva la etiqueta que ya salio impresa', async () => {
  const { db, pedir } = tienda();
  const original = crypto.randomUUID();
  const repetida = crypto.randomUUID();
  const alta = (id: string, codigo: string, stock: number) => db.prepare(
    `insert into productos (id, codigo, nombre, precio, precio_lista, stock, estado_analisis, destino, foto_key, semana_ingreso, creado_en, actualizado_en)
     values (?, ?, 'Tenis', 19900, 0, ?, 'listo', 'etiqueta', ?, 'S40', '', '')`).run(id, codigo, stock, `fotos/${id}.jpg`);
  alta(original, '', 2);            // la foto original aun no tiene etiqueta
  alta(repetida, 'ED-000900', 3);   // la repetida ya trae la suya, pegada en el anaquel
  const r = await pedir(`/api/borradores/${repetida}/fusionar`, { destino_id: original });
  assert.equal(r.status, 200);
  const fila = db.prepare('select codigo, stock from productos where id = ?').get(original) as { codigo: string; stock: number };
  assert.deepEqual({ ...fila }, { codigo: 'ED-000900', stock: 5 });
});

test('fusionar no deja pasar las 999 piezas: la suma se rechaza y no se pierde ninguna foto', async () => {
  const { db, pedir } = tienda();
  const original = crypto.randomUUID();
  const repetida = crypto.randomUUID();
  const alta = (id: string, stock: number) => db.prepare(
    `insert into productos (id, nombre, precio, stock, estado_analisis, destino, foto_key, semana_ingreso, creado_en, actualizado_en)
     values (?, 'Calcetines', 9900, ?, 'listo', 'etiqueta', ?, 'S40', '', '')`).run(id, stock, `fotos/${id}.jpg`);
  alta(original, 600);
  alta(repetida, 500);
  assert.equal((await pedir(`/api/borradores/${repetida}/fusionar`, { destino_id: original })).status, 409);
  assert.equal((db.prepare('select count(*) n from productos where id in (?, ?)').get(original, repetida) as { n: number }).n, 2);
  assert.equal((db.prepare('select stock from productos where id = ?').get(original) as { stock: number }).stock, 600);
});
