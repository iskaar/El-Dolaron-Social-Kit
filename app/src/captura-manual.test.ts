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

test('fusionar conserva la fila etiquetada; la original sin etiqueta recibe un código nuevo (#439)', async () => {
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
  assert.equal(fila.stock, 5);
  assert.match(fila.codigo, /^ED-\d{6}$/);
  assert.notEqual(fila.codigo, 'ED-000900');
  assert.equal(db.prepare("select count(*) n from productos where codigo = 'ED-000900'").get()!.n, 1);
  assert.deepEqual({ ...db.prepare('select codigo, stock, estado_analisis from productos where id = ?').get(repetida)! },
    { codigo: 'ED-000900', stock: 0, estado_analisis: 'descartado' });
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

test('un codigo nunca se repite aunque SQLite reutilice el rowid de una pieza borrada', async () => {
  const { db, pedir } = tienda();
  const alta = (id: string) => db.prepare(
    `insert into productos (id, nombre, precio, stock, estado_analisis, destino, foto_key, semana_ingreso, creado_en, actualizado_en)
     values (?, 'Taza', 4900, 1, 'listo', 'etiqueta', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
  const original = crypto.randomUUID(), repetida = crypto.randomUUID(), nueva = crypto.randomUUID();
  alta(original); alta(repetida);
  await pedir('/api/etiquetas', { ids: [repetida] });
  const impreso = (db.prepare('select codigo from productos where id = ?').get(repetida) as { codigo: string }).codigo;
  assert.equal((await pedir(`/api/borradores/${repetida}/fusionar`, { destino_id: original })).status, 200);
  alta(nueva);   // toma el rowid de la repetida
  const r = await pedir('/api/etiquetas', { ids: [nueva] });
  assert.equal(r.status, 200);
  const codigos = (db.prepare(`select codigo from productos where codigo like 'ED-%'`).all() as { codigo: string }[]).map((f) => f.codigo);
  assert.equal(new Set(codigos).size, codigos.length);
  assert.ok(codigos.includes(impreso));
});

// Escáner sin foto (#399): permiso de captura y las mismas reglas del servidor.
const RUTA_ESCANER = '/api/borradores/upc/manual';
test('capturista y dueño capturan sin código ni foto y sale a etiquetas con ED- y precio calculado', async () => {
  for (const rol of ['capturista', 'dueno']) {
    const t = tienda();
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('piso@prueba.mx', 'Piso', ?, 1, '', '')`).run(rol);
    t.env.DEV_USUARIO = 'piso@prueba.mx';
    const cuerpo = pieza({ upc: '', estado_fisico: 'danado', precio_lista: 100000, destino: 'banda_g19' });
    const r = await t.pedir(RUTA_ESCANER, cuerpo);
    assert.equal(r.status, 201);
    assert.equal(r.cuerpo.precio, 29900); // $1000 × 50 % × 60 %, con redondeo vigente.
    const p = t.db.prepare('select * from productos where id = ?').get(cuerpo.id)!;
    assert.equal(p.upc, ''); assert.equal(p.foto_key, ''); assert.equal(p.estado_analisis, 'listo');
    assert.equal(p.destino, 'etiqueta'); assert.equal(p.stock, 2);
    assert.match(String(p.codigo), /^ED-\d{6}$/);
    assert.ok((await t.pedir('/api/borradores?estado=listo')).cuerpo.some((p: any) => p.id === cuerpo.id));
    assert.equal((await t.pedir('/api/etiquetas', { ids: [cuerpo.id] })).cuerpo[0].codigo, p.codigo);
    // Un reenvío tras una venta no repone cantidad ni cambia nombre/precio, aun siendo dueño.
    t.db.prepare('update productos set stock = 1 where id = ?').run(cuerpo.id);
    const reintento = await t.pedir(RUTA_ESCANER, { ...cuerpo, nombre: 'Otro', precio: 100, stock: 9 });
    assert.equal(reintento.status, 201);
    assert.equal(reintento.cuerpo.stock, 1); assert.equal(reintento.cuerpo.nombre, cuerpo.nombre); assert.equal(reintento.cuerpo.precio, 29900);
  }
});

test('sin etiqueta el capturista pone precio de venta; con etiqueta no lo cambia (#75, #399)', async () => {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cap@prueba.mx', 'C', 'capturista', 1, '', '')`).run();
  t.env.DEV_USUARIO = 'cap@prueba.mx';
  const cuerpo = pieza({ upc: '00001234', precio_lista: 0, precio: 12345 });
  assert.equal((await t.pedir(RUTA_ESCANER, cuerpo)).cuerpo.precio, 12345);
  assert.equal(t.db.prepare('select upc from productos where id = ?').get(cuerpo.id)!.upc, '00001234');
  assert.equal((await t.pedir(`/api/borradores/${cuerpo.id}`, { precio: 100 }, 'PATCH')).status, 403);
  assert.equal((await t.pedir(RUTA_ESCANER, { ...cuerpo, precio: 100 })).cuerpo.precio, 12345);
  assert.equal((await t.pedir('/api/borradores/manual', pieza())).status, 403);
  // El manifiesto sigue imponiendo el precio: la nueva ruta no lo evade.
  t.db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, tcin, nombre, actualizado_en) values ('1234', 'Taza', 999, '1', 'Taza', '')`).run();
  assert.equal((await t.pedir(RUTA_ESCANER, pieza({ upc: '00001234', precio: 100 }))).status, 409);
});

test('FEP y cajero sin rol de captura reciben 403; validación y alcance no dejan piezas vacías', async () => {
  const t = tienda();
  for (const rol of ['finanzas', 'cajero']) {
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, 'P', ?, 1, '', '')`).run(`${rol}@prueba.mx`, rol);
    t.env.DEV_USUARIO = `${rol}@prueba.mx`;
    for (const metodo of ['POST', 'PATCH']) assert.equal((await t.pedir(RUTA_ESCANER, pieza({ upc: '' }), metodo)).status, 403);
  }
  t.env.DEV_USUARIO = 'dueno@prueba.mx';
  for (const extra of [{ nombre: '' }, { precio_lista: 0 }, { precio: -1 }, { categoria: 'autos' },
    { estado_fisico: 'roto' }, { stock: 1000 }, { stock: 0 }, { stock: 1.5 }, { precio: 100000 }, { upc: 'abc' }, { upc: undefined }, { precio_lista: 1e30 }]) {
    const cuerpo = pieza({ upc: '', ...extra });
    assert.equal((await t.pedir(RUTA_ESCANER, cuerpo)).status, 400, JSON.stringify(extra));
    assert.equal(t.db.prepare('select id from productos where id = ?').get(cuerpo.id), undefined);
  }
  const cuerpo = pieza({ upc: '' });
  await t.pedir(RUTA_ESCANER, cuerpo);
  t.db.prepare("update productos set capturado_por = 'otra@prueba.mx' where id = ?").run(cuerpo.id);
  assert.equal((await t.pedir(RUTA_ESCANER, cuerpo)).status, 404);
  assert.equal((await t.pedir(RUTA_ESCANER, { ...cuerpo, stock: 0 }, 'PATCH')).status, 404);
});

test('cantidad sin foto: cinco minutos desde la captura, en 0 cancela y un reintento no revive', async () => {
  const t = tienda();
  const cuerpo = pieza({ upc: '' });
  await t.pedir(RUTA_ESCANER, cuerpo);
  assert.equal((await t.pedir(RUTA_ESCANER, { id: cuerpo.id, stock: 3, precio: 1 }, 'PATCH')).status, 200);
  assert.equal(t.db.prepare('select precio from productos where id = ?').get(cuerpo.id)!.precio, 44900);
  t.db.prepare('update productos set creado_en = ? where id = ?').run(new Date(Date.now() - 301000).toISOString(), cuerpo.id);
  assert.equal((await t.pedir(RUTA_ESCANER, { id: cuerpo.id, stock: 4 }, 'PATCH')).status, 404);
  assert.equal((await t.pedir(RUTA_ESCANER, { id: cuerpo.id, stock: 0 }, 'PATCH')).status, 404);
  t.db.prepare('update productos set creado_en = ? where id = ?').run(new Date().toISOString(), cuerpo.id);
  assert.equal((await t.pedir(RUTA_ESCANER, { id: cuerpo.id, stock: 0 }, 'PATCH')).status, 200);
  const p = t.db.prepare('select estado_analisis, stock from productos where id = ?').get(cuerpo.id)!;
  assert.equal(p.estado_analisis, 'descartado'); assert.equal(p.stock, 0);
  assert.equal((await t.pedir(RUTA_ESCANER, cuerpo)).status, 409);
});

test('dos altas sin foto simultáneas conservan un solo resultado y una sola cantidad (#399)', async () => {
  const t = tienda(), cuerpo = pieza({ upc: '' });
  const respuestas = await Promise.all([t.pedir(RUTA_ESCANER, cuerpo), t.pedir(RUTA_ESCANER, { ...cuerpo, nombre: 'Otro envío', stock: 9 })]);
  assert.deepEqual(respuestas.map((r) => r.status), [201, 201]);
  assert.equal(respuestas[0].cuerpo.stock, respuestas[1].cuerpo.stock);
  assert.equal(respuestas[0].cuerpo.nombre, respuestas[1].cuerpo.nombre);
  const p = t.db.prepare('select count(*) n, max(stock) stock from productos where id = ?').get(cuerpo.id)!;
  assert.equal(p.n, 1); assert.equal(p.stock, respuestas[0].cuerpo.stock);
});

test('con más de 2000 piezas, la cola trae las más nuevas en orden de captura (#417)', async () => {
  const { db, pedir } = tienda();
  db.exec('delete from productos');
  const alta = db.prepare(`insert into productos (id, nombre, categoria, precio, stock, semana_ingreso, capturado_por, creado_en, actualizado_en, estado_analisis, destino, propietario)
    values (?, ?, 'otros', 100, 1, 'S43', 'dueno@prueba.mx', ?, ?, 'listo', 'etiqueta', 'dolaron')`);
  for (let i = 0; i < 2005; i++) {
    const fecha = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
    alta.run(crypto.randomUUID(), `Pieza ${i}`, fecha, fecha);
  }
  const lista = (await pedir('/api/borradores', undefined, 'GET')).cuerpo as Array<{ nombre: string }>;
  assert.equal(lista.length, 2000);
  assert.equal(lista[0].nombre, 'Pieza 5');
  assert.equal(lista.at(-1)!.nombre, 'Pieza 2004');
});
