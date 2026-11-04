// node --test src/ropa-prendas.test.ts
// #714: ropa sin código con todas las prendas, paquete ×N en el nombre, Unitalla y precio libre solo para quien fija precios.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';
import { PRENDAS_ROPA, PRECIO_PRENDA, PRECIOS_ROPA, PAQUETES, PAQUETE_MAX, nombreRopa, partesDeNombre, pluralPrenda } from '../public/ropa.js';
import { tallaValida, TALLAS, TALLAS_ADULTO, TALLA_NINO_UNICA } from '../public/tallas.js';
import { tsplEtiqueta } from '../public/etiquetera.js';
import { registroFoto, formularioPendiente } from '../public/foto-pendiente.js';

type Tienda = ReturnType<typeof tienda>;
const NUEVAS = ['Ropa interior', 'Calcetines', 'Brasier', 'Gorra', 'Sombrero', 'Gorro', 'Guantes', 'Bufanda', 'Tenis', 'Zapatos', 'Botas', 'Sandalias', 'Pantuflas'];

/** La foto de ropa sin código como la sube el celular (FormData de formularioPendiente) o la cámara remota. */
function subir(t: Tienda, id: string, datos: Record<string, unknown> = {}) {
  const f = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id, talla: 'M', precio_ropa: 10000, cantidad: 1, ...datos } as never));
  return worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never);
}
const nombre = (t: Tienda, id: string) => (t.db.prepare('select nombre, precio, stock, talla from productos where id = ?').get(id) as any);

test('las prendas nuevas están en el catálogo, con precio sugerido dentro de los escalones', () => {
  for (const p of NUEVAS) {
    assert.ok(PRENDAS_ROPA.includes(p), p);
    assert.ok(PRECIOS_ROPA.includes(PRECIO_PRENDA[p]), `${p} sugiere un precio fuera de los escalones`);
  }
  assert.equal(new Set(PRENDAS_ROPA).size, PRENDAS_ROPA.length, 'sin repetidas');
});

test('el nombre de un paquete va y viene: prenda, paquete y marca se recuperan de «Paquete de 3 Playeras Hanes»', () => {
  assert.equal(nombreRopa('Playera', 'Hanes', 3), 'Paquete de 3 Playeras Hanes');
  assert.equal(nombreRopa('Playera', 'Hanes'), 'Playera Hanes');
  assert.equal(nombreRopa('', '', 0), 'Ropa');
  assert.equal(nombreRopa('', '', 4), 'Paquete de 4 Prendas');
  assert.equal(nombreRopa('Ropa interior', 'Fruit of the Loom', 5), 'Paquete de 5 Ropa interior Fruit of the Loom');
  assert.equal(nombreRopa('Pantalón', '', 2), 'Paquete de 2 Pantalones');
  assert.equal(pluralPrenda('Traje de baño'), 'Trajes de baño');
  assert.deepEqual(partesDeNombre('Paquete de 3 Playeras Hanes', 'Hanes'), { prenda: 'Playera', paquete: 3 });
  assert.deepEqual(partesDeNombre('Playera Hanes', 'Hanes'), { prenda: 'Playera', paquete: 0 });
  assert.deepEqual(partesDeNombre('Ropa', ''), { prenda: '', paquete: 0 });
  // Todas las combinaciones, con y sin marca (también una con espacios y símbolos).
  for (const marca of ['', 'Hanes', 'Cat & Jack']) for (const prenda of ['', ...PRENDAS_ROPA]) for (const paquete of [0, ...PAQUETES, 7, PAQUETE_MAX]) {
    const n = nombreRopa(prenda, marca, paquete);
    assert.deepEqual(partesDeNombre(n, marca), { prenda, paquete }, n);
  }
  // Un paquete fuera de 2 a 24 no es paquete.
  assert.equal(nombreRopa('Playera', '', 1), 'Playera');
  assert.equal(nombreRopa('Playera', '', 25), 'Playera');
});

test('POST: el paquete queda en el nombre, es UNA pieza con UNA etiqueta (el stock no se multiplica) y el servidor lo valida', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const id = crypto.randomUUID();
  const r = await subir(t, id, { prenda: 'Playera', marca: 'Hanes', paquete: 3, cantidad: 2 });
  assert.equal(r.status, 201);
  const cuerpo = await r.json() as any;
  assert.equal(cuerpo.nombre, 'Paquete de 3 Playeras Hanes');
  assert.deepEqual([cuerpo.prenda, cuerpo.paquete], ['Playera', 3]);
  assert.deepEqual({ ...nombre(t, id) }, { nombre: 'Paquete de 3 Playeras Hanes', precio: 10000, stock: 2, talla: 'M' }, 'cantidad = paquetes, no prendas');
  // Sin paquete (ausente o 0): nombre de siempre.
  const sin = crypto.randomUUID();
  assert.equal((await subir(t, sin, { prenda: 'Playera', marca: 'Hanes', paquete: 0 })).status, 201);
  assert.equal(nombre(t, sin).nombre, 'Playera Hanes');
  // Inválido: 400 y no queda pieza.
  for (const paquete of ['1', '25', '2.5', 'tres', '-3', '1000']) {
    const malo = crypto.randomUUID();
    const f = formularioPendiente(registroFoto(new Blob(['foto']), { id: malo, talla: 'M', precio_ropa: 10000 } as never));
    f.set('paquete', paquete);
    const x = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never);
    assert.equal(x.status, 400, paquete);
    assert.equal(t.db.prepare('select count(*) n from productos where id = ?').get(malo)!.n, 0);
  }
});

test('revisión: GET devuelve prenda y paquete; PATCH los corrige y conserva lo que no se manda', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const id = crypto.randomUUID();
  assert.equal((await subir(t, id, { prenda: 'Calcetines', marca: 'Hanes', paquete: 6 })).status, 201);
  const ruta = `/api/borradores/${id}/revision`;
  const g = (await t.pedir(ruta)).cuerpo;
  assert.deepEqual([g.prenda, g.paquete, g.marca], ['Calcetines', 6, 'Hanes']);
  // Solo la marca: el paquete se conserva.
  assert.equal((await t.pedir(ruta, { marca: 'Nike' }, 'PATCH')).status, 200);
  assert.equal(nombre(t, id).nombre, 'Paquete de 6 Calcetines Nike');
  // Cambia el paquete y la prenda.
  assert.equal((await t.pedir(ruta, { prenda: 'Guantes', paquete: 2 }, 'PATCH')).status, 200);
  assert.equal(nombre(t, id).nombre, 'Paquete de 2 Guantes Nike');
  // Quitar el paquete.
  assert.equal((await t.pedir(ruta, { paquete: 0 }, 'PATCH')).status, 200);
  assert.equal(nombre(t, id).nombre, 'Guantes Nike');
  for (const paquete of [1, 25, 2.5, '3', null]) assert.equal((await t.pedir(ruta, { paquete }, 'PATCH')).status, 400, String(paquete));
});

test('ropa sin prenda sigue siendo válida: lo obligatorio es talla y precio', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const id = crypto.randomUUID();
  assert.equal((await subir(t, id, { talla: 'Unitalla', precio_ropa: 8000 })).status, 201);
  assert.equal(nombre(t, id).nombre, 'Ropa');
  const g = (await t.pedir(`/api/borradores/${id}/revision`)).cuerpo;
  assert.deepEqual([g.prenda, g.paquete], ['', 0]);
});

test('Unitalla (adulto y niño) es talla válida y sale legible en la etiqueta TSPL, sin acentos', async (t0) => {
  assert.ok(tallaValida('Unitalla') && tallaValida(TALLA_NINO_UNICA) && TALLA_NINO_UNICA === 'Niño Unitalla');
  assert.ok(TALLAS_ADULTO.includes('Unitalla') && TALLAS.includes('Niño Unitalla'));
  for (const invalida of ['unitalla', 'Niño Unitalla / S', 'Niño 6 años / Unitalla', 'Unitalla ']) assert.ok(!tallaValida(invalida), invalida);
  const pieza = { nombre: 'Gorro', precio: 8000, precio_lista: 0, codigo: 'ED-000777', semana_ingreso: 'S44' };
  assert.match(tsplEtiqueta({ ...pieza, talla: 'Unitalla' }), /"ED-000777 \/ Unitalla - S44"/);
  assert.match(tsplEtiqueta({ ...pieza, talla: 'Niño Unitalla' }), /"ED-000777 \/ Nino Unitalla - S44"/);
  // El servidor la guarda en la captura, y la corrección de talla también la acepta.
  const t = tienda(); t0.after(() => t.db.close());
  for (const talla of ['Unitalla', 'Niño Unitalla']) {
    const id = crypto.randomUUID();
    assert.equal((await subir(t, id, { talla, prenda: 'Gorro' })).status, 201);
    assert.equal(nombre(t, id).talla, talla);
  }
  const id = crypto.randomUUID();
  assert.equal((await subir(t, id, { talla: 'M' })).status, 201);
  assert.equal((await t.pedir(`/api/borradores/${id}/talla`, { talla: 'Niño Unitalla' }, 'PATCH')).status, 200);
  assert.equal(nombre(t, id).talla, 'Niño Unitalla');
});

test('precio libre en ropa sin código: lo acepta el dueño; la captura y la revisión del capturista siguen con los escalones', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  t.db.prepare("insert into usuarios(correo,roles,activo,editar_inventario,creado_en,actualizado_en) values('cap@prueba.mx','capturista',1,1,'','')").run();
  const DUENO = t.env.DEV_USUARIO as string;
  const ruta = (id: string) => `/api/borradores/${id}/revision`;

  // Dueño: cualquier monto positivo en centavos, en el alta y en la revisión.
  const libre = crypto.randomUUID();
  assert.equal((await subir(t, libre, { prenda: 'Tenis', precio_ropa: 23500 })).status, 201);
  assert.equal(nombre(t, libre).precio, 23500);
  const otro = crypto.randomUUID();
  assert.equal((await subir(t, otro, { prenda: 'Tenis', precio_ropa: 15000 })).status, 201);
  assert.equal((await t.pedir(ruta(otro), { precio: 17900, confirmar: true }, 'PATCH')).status, 200);
  assert.equal(nombre(t, otro).precio, 17900);
  for (const precio of [0, -100, 150.5, '5000']) assert.equal((await t.pedir(ruta(otro), { precio }, 'PATCH')).status, 400, String(precio));

  // Capturista: los escalones pasan; un precio libre se rechaza en el alta (400: un 403 detendría la cola de fotos) y en la revisión (403).
  t.env.DEV_USUARIO = 'cap@prueba.mx';
  const ok = crypto.randomUUID();
  assert.equal((await subir(t, ok, { precio_ropa: 12000 })).status, 201);
  const rechazada = crypto.randomUUID();
  assert.equal((await subir(t, rechazada, { precio_ropa: 23500 })).status, 400);
  assert.equal(t.db.prepare('select count(*) n from productos where id = ?').get(rechazada)!.n, 0);
  assert.equal((await t.pedir(ruta(ok), { precio: 8000 }, 'PATCH')).status, 200, 'un escalón sí');
  assert.equal((await t.pedir(ruta(ok), { precio: 17900 }, 'PATCH')).status, 403, 'un precio libre no');
  assert.equal(nombre(t, ok).precio, 8000);
  // Si el dueño ya puso un precio libre, el capturista puede corregir la talla y la prenda sin tocarlo (el celular manda el precio actual).
  t.db.prepare('update productos set precio = 17900 where id = ?').run(ok);
  assert.equal((await t.pedir(ruta(ok), { precio: 17900, prenda: 'Botas' }, 'PATCH')).status, 200);
  assert.equal(nombre(t, ok).precio, 17900);
  t.env.DEV_USUARIO = DUENO;
});

test('cámara remota: el paquete viaja en los params y se valida (0 = sin paquete, 2 a 24)', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const pedir = (params: object) => t.pedir('/api/camara/solicitud', { id: crypto.randomUUID(), tipo: 'pieza_nueva', pieza_id: crypto.randomUUID(), params }, 'PUT');
  for (const paquete of [0, 2, 3, 24]) assert.equal((await pedir({ prenda: 'Playera', paquete })).status, 200, String(paquete));
  for (const paquete of [1, 25, 2.5, '3', null]) assert.equal((await pedir({ prenda: 'Playera', paquete })).status, 400, String(paquete));
});

test('el registro de la cola lleva el paquete en el formulario; sin paquete no manda el campo', () => {
  const con = formularioPendiente(registroFoto(new Blob(['f']), { id: crypto.randomUUID(), talla: 'M', precio_ropa: 10000, prenda: 'Playera', paquete: 3 } as never));
  assert.equal(con.get('paquete'), '3');
  const sin = formularioPendiente(registroFoto(new Blob(['f']), { id: crypto.randomUUID(), talla: 'M', precio_ropa: 10000, prenda: 'Playera' } as never));
  assert.equal(sin.has('paquete'), false);
});
