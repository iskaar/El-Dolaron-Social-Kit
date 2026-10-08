// node --test src/talla.test.ts
// Talla de ropa (Issue #218): lista compartida, captura con talla, correccion en
// el admin y salida en el catalogo publico y en la etiqueta.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';
import { tallaValida } from '../public/tallas.js';
import { tsplEtiqueta } from '../public/etiquetera.js';

const HOST = 'dolarones.prueba';

/** Una foto de capture, como la manda captura.html (FormData, con talla opcional). */
function capturar(t: ReturnType<typeof tienda>, id: string, talla?: string) {
  const cuerpo = new FormData();
  cuerpo.append('id', id);
  cuerpo.append('estado_fisico', 'nuevo');
  cuerpo.append('cantidad', '1');
  cuerpo.append('foto', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], `${id}.jpg`, { type: 'image/jpeg' }));
  if (talla !== undefined) cuerpo.append('talla', talla);
  return worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never,
    t.env, t.ctx as never);
}

const talla = (t: ReturnType<typeof tienda>, id: string) =>
  (t.db.prepare('select talla from productos where id = ?').get(id) as { talla: string | null }).talla;

test('la lista compartida: tallas de adulto y de nino, con o sin talla de nino', () => {
  for (const valida of ['M', '3XL', 'Niño 6 años', 'Niño 0-3 meses / XS', 'Niño 16 años / XL']) assert.ok(tallaValida(valida), valida);
  for (const invalida of ['XXXL', '4', 'Niño 1 año', 'Niño 6 años / XXL', 'Niño 6 años / S / M', 'm', '']) assert.ok(!tallaValida(invalida), invalida);
});

test('captura en modo Ropa: la talla se guarda con la foto; sin talla queda nula como antes', async () => {
  const t = tienda();
  const con = crypto.randomUUID();
  assert.equal((await capturar(t, con, 'Niño 6 años / S')).status, 201);
  assert.equal(talla(t, con), 'Niño 6 años / S');

  const sin = crypto.randomUUID();
  assert.equal((await capturar(t, sin)).status, 201);
  assert.equal(talla(t, sin), null);
});

test('talla invalida en la captura: 400 y no queda pieza', async () => {
  const t = tienda();
  const antes = (t.db.prepare('select count(*) n from productos').get() as { n: number }).n;
  const id = crypto.randomUUID();
  const r = await capturar(t, id, 'XXXL');
  assert.equal(r.status, 400);
  assert.equal((t.db.prepare('select count(*) n from productos').get() as { n: number }).n, antes);
});

test('el admin corrige la talla y rechaza una que no existe', async () => {
  const t = tienda();
  const id = crypto.randomUUID();
  assert.equal((await capturar(t, id)).status, 201);
  const patch = (cuerpo: unknown) => worker.fetch!(new Request(`https://caja.prueba/api/borradores/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
  }) as never, t.env, t.ctx as never);
  assert.equal((await patch({ talla: 'L' })).status, 200);
  assert.equal(talla(t, id), 'L');
  assert.equal((await patch({ talla: 'Niño 2 años / XXL' })).status, 400);
  assert.equal(talla(t, id), 'L');
  assert.equal((await patch({ talla: '' })).status, 200);
  assert.equal(talla(t, id), null);
});

test('el catalogo publico devuelve la talla; la etiqueta la imprime', async () => {
  const t = tienda();
  t.env.HOST_PORTAL = HOST;
  const id = 'c0000001-1111-4111-8111-111111111111';
  t.db.prepare(`insert into productos (id, codigo, nombre, marca, categoria, precio, precio_lista, estado_fisico, estado_analisis,
      destino, sin_inventario, stock, foto_key, talla, semana_ingreso, creado_en, actualizado_en)
    values (?, 'ED-000777', 'Playera', 'Gap', 'ropa', 15000, 0, 'nuevo', 'listo', 'etiqueta', 0, 2, ?, 'Niño 6 años / S', 'S40', '', '')`)
    .run(id, `fotos/${id}.jpg`);
  (t.env.FOTOS as any).objetos.set(`fotos/${id}.jpg`, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer);

  const r = await worker.fetch!(new Request(`https://${HOST}/api/catalogo`) as never, t.env, t.ctx as never);
  const { piezas } = (await r.json()) as { piezas: Record<string, unknown>[] };
  assert.equal(piezas.length, 1);
  assert.equal(piezas[0].talla, 'Niño 6 años / S');
  assert.equal('id' in piezas[0], false);

  const tspl = tsplEtiqueta({ nombre: 'Playera', precio: 15000, precio_lista: 0, codigo: 'ED-000777', semana_ingreso: 'S40', talla: 'Niño 6 años / S' });
  assert.match(tspl, /ED-000777 \/ Nino 6 anos \/ S - S40/);
  assert.match(tsplEtiqueta({ nombre: 'Playera', precio: 15000, precio_lista: 0, codigo: 'ED-000777', semana_ingreso: 'S40' }),
    /"ED-000777 - S40"/);
});

test('la camara corrige la talla de lo que acaba de capturar; una talla que no existe no pasa', async () => {
  const { permitidaParaVendedor } = await import('./worker.ts');
  const t = tienda();
  const id = crypto.randomUUID();
  assert.equal((await capturar(t, id, 'M')).status, 201);
  assert.equal(permitidaParaVendedor(`/api/borradores/${id}/talla`, 'PATCH'), true);
  const patch = (cuerpo: unknown, pieza = id) => worker.fetch!(new Request(`https://caja.prueba/api/borradores/${pieza}/talla`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
  }) as never, t.env, t.ctx as never);
  assert.equal((await patch({ talla: 'Niño 18-24 meses / XL' })).status, 200);
  assert.equal(talla(t, id), 'Niño 18-24 meses / XL');
  assert.equal((await patch({ talla: 'XXXL' })).status, 400);
  assert.equal((await patch({ talla: '' })).status, 400);
  assert.equal(talla(t, id), 'Niño 18-24 meses / XL');
  // Fuera de las 24 h ya no se toca desde la camara.
  t.db.prepare("update productos set creado_en = '2020-01-01T00:00:00Z' where id = ?").run(id);
  assert.equal((await patch({ talla: 'S' })).status, 404);
});
