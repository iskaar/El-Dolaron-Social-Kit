// node --test src/talla.test.ts
// Talla de ropa (Issue #218): lista compartida, captura con talla, correccion en
// el admin y salida en el catalogo publico y en la etiqueta.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';
import { tallaValida, tallaUs, TABLAS_CALZADO, CALZADO_US_HOMBRE, CALZADO_US_MUJER, CALZADO_US_NINO, TALLAS_CALZADO_NINO,
  buscarCalzado, tipoCalzadoDeNombre, esCalzado, calzadoRenglon } from '../public/tallas.js';
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
  assert.equal((await patch({ talla: 'L', nombre: 'Camisa', precio: 5000 })).status, 200);
  assert.equal(talla(t, id), 'L');
  assert.equal((await patch({ talla: 'Niño 2 años / XXL' })).status, 400);
  assert.equal(talla(t, id), 'L');
  assert.equal((await patch({ talla: '', nombre: 'Camisa', precio: 5000 })).status, 200);
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
  assert.equal((await patch({ talla: '', nombre: 'Camisa', precio: 5000 })).status, 400);
  assert.equal(talla(t, id), 'Niño 18-24 meses / XL');
  // Fuera de las 24 h ya no se toca desde la camara.
  t.db.prepare("update productos set creado_en = '2020-01-01T00:00:00Z' where id = ?").run(id);
  assert.equal((await patch({ talla: 'S' })).status, 404);
});

test('calzado (#543): talla MX en cm de adulto y de nino; fuera de rango no pasa', async () => {
  for (const valida of ['22', '25.5', '32', 'Niño 10', 'Niño 15', 'Niño 25']) assert.ok(tallaValida(valida), valida);
  for (const invalida of ['21.5', '32.5', '25.0', '25,5', 'Niño 9.5', 'Niño 25.5', 'Niño 15 / S']) assert.ok(!tallaValida(invalida), invalida);

  const t = tienda();
  for (const buena of ['25.5', 'Niño 15']) {
    const id = crypto.randomUUID();
    assert.equal((await capturar(t, id, buena)).status, 201, buena);
    assert.equal(talla(t, id), buena);
  }
  const antes = (t.db.prepare('select count(*) n from productos').get() as { n: number }).n;
  for (const mala of ['32.5', 'Niño 9']) assert.equal((await capturar(t, crypto.randomUUID(), mala)).status, 400, mala);
  assert.equal((t.db.prepare('select count(*) n from productos').get() as { n: number }).n, antes);

  // Corregir a calzado desde la camara, y la etiqueta lo imprime tal cual.
  const id = crypto.randomUUID();
  assert.equal((await capturar(t, id, 'M')).status, 201);
  const patch = (cuerpo: unknown) => worker.fetch!(new Request(`https://caja.prueba/api/borradores/${id}/talla`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
  }) as never, t.env, t.ctx as never);
  assert.equal((await patch({ talla: '26.5' })).status, 200);
  assert.equal(talla(t, id), '26.5');
  assert.equal((await patch({ talla: 'Niño 14.5' })).status, 200);
  assert.equal(talla(t, id), 'Niño 14.5');
  assert.equal((await patch({ talla: 'Niño 9' })).status, 400);
  assert.equal(talla(t, id), 'Niño 14.5');
  assert.match(tsplEtiqueta({ nombre: 'Tenis', precio: 30000, precio_lista: 0, codigo: 'ED-000778', semana_ingreso: 'S44', talla: 'Niño 14.5' }),
    /ED-000778 \/ Nino 14\.5 - S44/);
});

test('toda talla de las tablas US->MX (#546) guarda un cm valido y sin repetir la talla US', () => {
  assert.deepEqual(Object.values(TABLAS_CALZADO), [CALZADO_US_HOMBRE, CALZADO_US_MUJER, CALZADO_US_NINO]);
  for (const [tipo, tabla] of Object.entries(TABLAS_CALZADO)) {
    for (const [us, cm] of tabla) assert.ok(tallaValida(tipo === 'Calzado niño' ? `Niño ${cm}` : cm), `${tipo} US ${us} -> ${cm}`);
    assert.equal(new Set(tabla.map(([us]) => us)).size, tabla.length, tipo);
  }
});

test('los desplegables de ficha, Revisar y admin rotulan cada cm de calzado con la talla US de la caja (#546)', () => {
  assert.equal(tallaUs('26'), 'US 8 H · US 9 M');
  assert.equal(tallaUs('22'), 'US 5 M');
  assert.equal(tallaUs('32'), 'US 14 H');
  assert.equal(tallaUs('Niño 19'), 'US 13C');
  assert.equal(tallaUs('Niño 24.5'), 'US 5.5Y · US 6Y');
  for (const ropa of ['M', 'Niño 6 años', 'Niño 6 años / S']) assert.equal(tallaUs(ropa), '', ropa);
});

test('calzado de nino (#552): cada terna [us, cm, eu] guarda un cm valido y la EU no se repite', () => {
  for (const [us, cm, eu] of CALZADO_US_NINO) {
    assert.ok(TALLAS_CALZADO_NINO.includes(cm), `${us} -> ${cm}`);
    assert.ok(Number(eu) >= 19 && Number(eu) <= 40, `${us} EU ${eu}`);
  }
  assert.equal(new Set(CALZADO_US_NINO.map(([, , eu]) => eu)).size, CALZADO_US_NINO.length);
  assert.equal(calzadoRenglon(['11C', '17', '28']), 'US 11C · EU 28 · 17');
  assert.equal(calzadoRenglon(['9', '27']), 'US 9 · 27');
});

test('buscarCalzado: el numero de la caja por US, C/Y, EU y cm; exactos antes que prefijos (#552)', () => {
  const rotulos = (texto: string, preferido?: string | null) => buscarCalzado(texto, preferido).map((f) => f.rotulo);
  assert.deepEqual(buscarCalzado(''), []);
  assert.deepEqual(buscarCalzado('   '), []);
  assert.deepEqual(buscarCalzado('99'), []);

  const nueve = rotulos('9');
  assert.deepEqual(nueve.slice(0, 2), ['US 9 H · 27', 'US 9 M · 26']);
  assert.ok(nueve.indexOf('US 9.5 H · 27.5') > 1 && nueve.indexOf('US 9.5 M · 26.5') > 1, 'el prefijo va despues de los exactos');
  assert.deepEqual(rotulos('9', 'Calzado M').slice(0, 2), ['US 9 M · 26', 'US 9 H · 27']);
  assert.deepEqual(rotulos('9,5').slice(0, 2), ['US 9.5 H · 27.5', 'US 9.5 M · 26.5'], 'la coma decimal se acepta');

  assert.ok(rotulos('12').includes('US 12C · EU 29.5 · 18'));
  assert.ok(rotulos('12c').includes('US 12C · EU 29.5 · 18'));
  assert.deepEqual(rotulos('12C'), rotulos('12c'), 'mayusculas indistintas');
  assert.deepEqual(rotulos('5y'), ['US 5Y · EU 37.5 · 24']);
  assert.deepEqual(rotulos('5.5y'), ['US 5.5Y · EU 38 · 24.5']);

  const eu = buscarCalzado('28').find((f) => f.tipo === 'Calzado niño')!;
  assert.deepEqual([eu.rotulo, eu.valor], ['EU 28 · US 11C · 17', 'Niño 17']);
  assert.equal(buscarCalzado('28', 'Calzado niño')[0].tipo, 'Calzado niño');

  const cm = buscarCalzado('27').find((f) => f.tipo === 'Calzado H')!;
  assert.deepEqual([cm.rotulo, cm.valor], ['27 cm · US 9 H', '27']);

  // Todo lo que se ofrece se puede guardar y el valor es el de calzadoValor.
  for (const texto of ['9', '12', '28', '27', '1', '5y'])
    for (const f of buscarCalzado(texto)) assert.ok(tallaValida(f.valor), `${texto}: ${f.rotulo} -> ${f.valor}`);
});

test('tipoCalzadoDeNombre: el nombre en ingles ordena la lista; nino gana sobre mujer y "women" no es "men" (#552)', () => {
  assert.equal(tipoCalzadoDeNombre("Women's Running Shoes"), 'Calzado M');
  assert.equal(tipoCalzadoDeNombre('Womens Sandals'), 'Calzado M');
  assert.equal(tipoCalzadoDeNombre("Toddler Girls' Sneakers"), 'Calzado niño');
  assert.equal(tipoCalzadoDeNombre("Girls' Boots"), 'Calzado niño');
  assert.equal(tipoCalzadoDeNombre("Boys' Slides"), 'Calzado niño');
  assert.equal(tipoCalzadoDeNombre('Little Kid Light-Up Shoes'), 'Calzado niño');
  assert.equal(tipoCalzadoDeNombre("Men's Boots"), 'Calzado H');
  assert.equal(tipoCalzadoDeNombre('Mens Slip-on'), 'Calzado H');
  assert.equal(tipoCalzadoDeNombre('Lámpara'), null);
  assert.equal(tipoCalzadoDeNombre('Moment Shoes'), null, '"men" dentro de otra palabra no cuenta');
  assert.equal(tipoCalzadoDeNombre(undefined), null);
});

test('esCalzado: departamento SHOES/FOOTWEAR o una palabra de calzado completa en nombre o descripcion (#552)', () => {
  assert.ok(esCalzado({ nombre: 'Lámpara', descripcion: 'Lamp', departamento: 'SHOES' }));
  assert.ok(esCalzado({ nombre: '', descripcion: '', departamento: 'Mens Footwear' }));
  assert.ok(esCalzado({ nombre: 'Tenis Nike Court', descripcion: '' }));
  assert.ok(esCalzado({ nombre: 'Botín de mujer', descripcion: '' }));
  assert.ok(esCalzado({ nombre: '', descripcion: "Boys' Flip-Flops", departamento: 'APPAREL' }));
  assert.ok(esCalzado({ nombre: 'Pantuflas', descripcion: '' }));
  assert.ok(!esCalzado({ nombre: 'Lámpara', descripcion: 'Desk lamp', departamento: 'HOME' }));
  assert.ok(!esCalzado({ nombre: 'Bootcamp planner', descripcion: 'Notebook' }), 'palabra completa');
  assert.ok(!esCalzado({}));
  assert.ok(!esCalzado({ nombre: 'Water slide', categoria: 'juguetes' }), 'palabra de calzado fuera de ropa');
  assert.ok(esCalzado({ nombre: 'Water slide', categoria: 'juguetes', departamento: 'SHOES' }), 'el departamento manda');
});
