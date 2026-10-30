// node --test src/manifiesto.test.ts
// Captura por UPC (#365/#461): el manifiesto precarga la ficha y el servidor autoriza cada edición.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { fichaDeManifiesto } from './manifiesto.ts';
import { calcularPrecio } from './precio.ts';

function conManifiesto(nombre = 'Gomitas Good & Gather Food Truck 198 g') {
  const t = tienda();
  t.db.prepare(`insert into manifiesto (upc, descripcion, departamento, precio_usd, tcin, nombre, marca, categoria, actualizado_en)
                values ('191907910414', 'GG GUMMY FOOD TRUCK 7OZ', 'CANDY', 499, '94911982', ?, 'Good & Gather', 'despensa', '')`).run(nombre);
  t.db.prepare(`insert into config (clave, valor) values ('tipo_cambio', '1850')`).run();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cap@prueba.mx', 'C', 'capturista', 1, '', '')`).run();
  (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'cap@prueba.mx';
  return t;
}

test('un capturista escanea, pone la cantidad y la pieza queda lista con su ED- y el precio del servidor', async () => {
  const { db, pedir } = conManifiesto();
  // El lector puede mandar el EAN-13 (con un 0 delante): es el mismo producto.
  const ficha = await pedir('/api/manifiesto/0191907910414', undefined, 'GET');
  assert.equal(ficha.status, 200);
  assert.equal(ficha.cuerpo.nombre, 'Gomitas Good & Gather Food Truck 198 g');
  assert.equal(ficha.cuerpo.precio_lista, 9232);   // US$4.99 x 18.50
  assert.equal(ficha.cuerpo.enlace, 'https://www.target.com/p/-/A-94911982');
  const config = Object.fromEntries((db.prepare('select clave, valor from config').all() as { clave: string; valor: string }[])
    .map((c) => [c.clave, c.valor]));
  const esperado = calcularPrecio({ precioLista: 9232, categoria: 'despensa', estadoFisico: 'nuevo', config }).precio;
  assert.equal(ficha.cuerpo.precio, esperado);

  const id = crypto.randomUUID();
  // #461: ahora un precio distinto sin ser dueño se rechaza, sin dejar pieza.
  assert.equal((await pedir('/api/borradores/upc', { id, upc: '191907910414', stock: 3, precio: 100, precio_lista: 100 })).status, 403);
  assert.equal(db.prepare('select id from productos where id = ?').get(id), undefined);
  const r = await pedir('/api/borradores/upc', { id, upc: '191907910414', stock: 3, precio_lista: 100 });
  assert.equal(r.status, 201);
  const fila = db.prepare('select upc, nombre, marca, categoria, precio_lista, precio, stock, codigo, estado_analisis, destino, capturado_por from productos where id = ?').get(id) as Record<string, unknown>;
  assert.match(String(fila.codigo), /^ED-\d{6}$/);
  assert.deepEqual({ ...fila, codigo: '' }, {
    upc: '191907910414', nombre: 'Gomitas Good & Gather Food Truck 198 g', marca: 'Good & Gather', categoria: 'despensa',
    precio_lista: 9232, precio: esperado, stock: 3, codigo: '', estado_analisis: 'listo', destino: 'etiqueta', capturado_por: 'cap@prueba.mx',
  });
  // Reintento del mismo envio (red lenta): la misma pieza, no otra.
  assert.equal((await pedir('/api/borradores/upc', { id, upc: '191907910414', stock: 3 })).status, 201);
  assert.equal((db.prepare('select count(*) n from productos where upc = ?').get('191907910414') as { n: number }).n, 1);
});

test('lo que no esta en el manifiesto, sin tipo de cambio o con cantidad mala no deja pieza', async () => {
  const { db, pedir } = conManifiesto();
  const antes = (db.prepare('select count(*) n from productos').get() as { n: number }).n;
  assert.equal((await pedir('/api/manifiesto/123456789012', undefined, 'GET')).status, 404);
  assert.equal((await pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: '123456789012', stock: 1 })).status, 404);
  assert.equal((await pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: '191907910414', stock: 0 })).status, 400);
  db.prepare("delete from config where clave = 'tipo_cambio'").run();
  assert.equal((await pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: '191907910414', stock: 1 })).status, 409);
  assert.equal((db.prepare('select count(*) n from productos').get() as { n: number }).n, antes);
});

test('FEP (finanzas) no captura por UPC: el manifiesto es de El Dolaron', async () => {
  const { db, env, pedir } = conManifiesto();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('fep@prueba.mx', 'F', 'finanzas', 1, '', '')`).run();
  (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = 'fep@prueba.mx';
  assert.equal((await pedir('/api/manifiesto/191907910414', undefined, 'GET')).status, 403);
  assert.equal((await pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: '191907910414', stock: 1 })).status, 403);
});

test('el nombre se traduce una sola vez por UPC; si falla, queda la descripcion y se reintenta', async () => {
  const { db, env } = conManifiesto('');
  let llamadas = 0;
  const falla = async () => { llamadas++; throw new Error('sin red'); };
  const sinTraducir = await fichaDeManifiesto('191907910414', env, falla);
  assert.equal(sinTraducir?.nombre, '');
  const traduce = async () => { llamadas++; return { nombre: 'Gomitas Good & Gather 198 g', marca: 'Good & Gather', categoria: 'inventada' }; };
  assert.equal((await fichaDeManifiesto('191907910414', env, traduce))?.nombre, 'Gomitas Good & Gather 198 g');
  assert.equal((await fichaDeManifiesto('191907910414', env, traduce))?.categoria, 'otros');   // categoria fuera de la lista
  assert.equal(llamadas, 2);
  assert.deepEqual({ ...db.prepare('select nombre, categoria from manifiesto').get() as object }, { nombre: 'Gomitas Good & Gather 198 g', categoria: 'otros' });
});
