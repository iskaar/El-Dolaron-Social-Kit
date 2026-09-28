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
