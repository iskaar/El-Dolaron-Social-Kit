// #481: fotos huérfanas en R2, recortes que se borran con la pieza, pendientes atascados y ED- solo para piezas listas.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { rescatarPendientes, reportarHuerfanosR2, llavesHuerfanas, esCorridaSemanal } from './huerfanos.ts';

const UPC = '036000291452';
const objetos = (t: ReturnType<typeof tienda>) => (t.env.FOTOS as any).objetos as Map<string, ArrayBuffer>;

function alta(t: ReturnType<typeof tienda>, id: string) {
  const cuerpo = new FormData();
  cuerpo.set('id', id); cuerpo.set('upc', UPC); cuerpo.set('cantidad', '2'); cuerpo.set('estado_fisico', 'nuevo');
  cuerpo.set('foto', new File([new Uint8Array([255, 216, 255])], 'foto.jpg', { type: 'image/jpeg' }));
  return worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never, t.env, t.ctx as never);
}

function pieza(t: ReturnType<typeof tienda>, id: string, datos: { estado?: string; precio?: number; stock?: number; foto?: string; hace?: number; upc?: string } = {}) {
  const antes = new Date(Date.now() - (datos.hace ?? 0) * 60_000).toISOString();
  t.db.prepare(`insert into productos (id, nombre, precio, stock, estado_analisis, foto_key, upc, semana_ingreso, creado_en, actualizado_en)
    values (?, 'Pieza', ?, ?, ?, ?, ?, 'S43', ?, ?)`)
    .run(id, datos.precio ?? 0, datos.stock ?? 1, datos.estado ?? 'pendiente', datos.foto ?? `fotos/${id}.jpg`, datos.upc ?? null, antes, antes);
}

/** Simula que otra captura del mismo UPC gana justo antes del insert (la carrera que dejaba la foto huérfana). */
function carrera(t: ReturnType<typeof tienda>, stock: number) {
  const base = t.env.DB.prepare.bind(t.env.DB);
  (t.env.DB as any).prepare = (sql: string) => {
    if (sql.includes('insert into productos (id, semana_ingreso')) {
      t.db.prepare(`insert into productos (id, nombre, precio, stock, estado_analisis, upc, estado_fisico, codigo, semana_ingreso, creado_en, actualizado_en)
        values (?, 'Taza', 5000, ?, 'listo', ?, 'nuevo', 'ED-009999', 'S43', '', '')`).run(crypto.randomUUID(), stock, UPC);
    }
    return base(sql);
  };
}

test('un 409 por conflicto de UPC no deja foto en R2', async () => {
  const t = tienda(), id = crypto.randomUUID();
  try {
    carrera(t, 999);   // la suma pasaría de 999 piezas: el alta responde 409
    const r = await alta(t, id);
    assert.equal(r.status, 409);
    assert.equal(objetos(t).has(`fotos/${id}.jpg`), false);
    assert.equal(t.db.prepare('select count(*) n from productos where id = ?').get(id)!.n, 0);
  } finally { t.db.close(); }
});

test('una captura sumada a otra pieza no deja foto huérfana', async () => {
  for (const carreraEnElInsert of [false, true]) {
    const t = tienda(), id = crypto.randomUUID();
    try {
      if (carreraEnElInsert) carrera(t, 1); else pieza(t, crypto.randomUUID(), { estado: 'listo', precio: 5000, upc: UPC });
      const r = await alta(t, id);
      assert.equal(r.status, 201);
      assert.equal(((await r.json()) as { existente?: boolean }).existente, true);
      assert.equal(objetos(t).has(`fotos/${id}.jpg`), false, `carrera ${carreraEnElInsert}`);
    } finally { t.db.close(); }
  }
});

test('el reintento del mismo id sigue guardando la foto, también si el primer put falló', async (prueba) => {
  prueba.mock.method(globalThis, 'fetch', async () => { throw new Error('sin red en pruebas'); });
  const t = tienda(), id = crypto.randomUUID();
  try {
    const put = t.env.FOTOS.put.bind(t.env.FOTOS);
    let falla = true;
    t.env.FOTOS.put = async (...args: Parameters<typeof put>) => { if (falla) { falla = false; throw new Error('R2 caído'); } return put(...args); };
    const primera = await alta(t, id).then((r) => r.status, () => 500);
    assert.ok(primera >= 500);
    assert.equal(objetos(t).has(`fotos/${id}.jpg`), false);
    assert.equal((await alta(t, id)).status, 201);
    assert.equal(objetos(t).get(`fotos/${id}.jpg`)!.byteLength, 3);
    assert.equal(t.db.prepare('select foto_key from productos where id = ?').get(id)!.foto_key, `fotos/${id}.jpg`);
    assert.equal((await alta(t, id)).status, 201);   // y un segundo reintento exitoso no la pierde
    assert.ok(objetos(t).has(`fotos/${id}.jpg`));
    await t.esperar();
  } finally { t.db.close(); }
});

test('descartar y fusionar borran también el recorte de la pieza', async () => {
  for (const accion of ['descartar', 'fusionar']) {
    const t = tienda(), id = crypto.randomUUID();
    try {
      pieza(t, id, { estado: 'listo', precio: 35000, stock: 3 });
      objetos(t).set(`fotos/${id}.jpg`, new ArrayBuffer(3));
      objetos(t).set(`recortes/${id}.webp`, new ArrayBuffer(3));
      objetos(t).set(`recortes/${PRODUCTO}.webp`, new ArrayBuffer(3));
      const r = accion === 'descartar' ? await t.pedir(`/api/borradores/${id}`, {}, 'DELETE')
        : await t.pedir(`/api/borradores/${id}/fusionar`, { destino_id: PRODUCTO });
      assert.equal(r.status, 200, accion);
      assert.equal(objetos(t).has(`fotos/${id}.jpg`), false);
      assert.equal(objetos(t).has(`recortes/${id}.webp`), false, accion);
      assert.ok(objetos(t).has(`recortes/${PRODUCTO}.webp`));   // el de la pieza que sigue viva no se toca
    } finally { t.db.close(); }
  }
});

test('el cron reencola pendientes viejos (máx. 5), manda a error los de más de 1 h y no toca listo', async (prueba) => {
  prueba.mock.method(console, 'error', () => {});
  prueba.mock.method(console, 'log', () => {});
  const t = tienda();
  try {
    const viejas = Array.from({ length: 8 }, (_, i) => { const id = crypto.randomUUID(); pieza(t, id, { hace: 30 + i / 100 }); return id; });
    const abandonada = crypto.randomUUID(), reciente = crypto.randomUUID(), listo = crypto.randomUUID(), sinFoto = crypto.randomUUID();
    pieza(t, abandonada, { hace: 120 });
    pieza(t, reciente, { hace: 5 });
    pieza(t, listo, { estado: 'listo', precio: 5000, hace: 500 });
    pieza(t, sinFoto, { foto: '', hace: 500 });
    const vistas: string[] = [];
    t.env.FOTOS.get = (async (llave: string) => { vistas.push(llave); return null; }) as never;   // el análisis falla y deja la pieza en error
    await rescatarPendientes(t.env);
    const estado = (id: string) => t.db.prepare('select estado_analisis e from productos where id = ?').get(id)!.e;
    assert.equal(vistas.length, 5);
    assert.deepEqual([...vistas].sort(), viejas.slice(3).map((id) => `fotos/${id}.jpg`).sort());   // las 5 más viejas
    assert.deepEqual(viejas.slice(0, 3).map(estado), ['pendiente', 'pendiente', 'pendiente']);
    assert.equal(estado(abandonada), 'error');
    assert.ok(!vistas.includes(`fotos/${abandonada}.jpg`));
    assert.equal(estado(reciente), 'pendiente');
    assert.equal(estado(listo), 'listo');
    assert.equal(estado(sinFoto), 'pendiente');
  } finally { t.db.close(); }
});

test('prepararEtiquetas solo codifica piezas listas con precio', async () => {
  const t = tienda();
  try {
    const ids = { pendiente: crypto.randomUUID(), error: crypto.randomUUID(), sinPrecio: crypto.randomUUID(), lista: crypto.randomUUID() };
    pieza(t, ids.pendiente, { estado: 'pendiente', precio: 5000 });
    pieza(t, ids.error, { estado: 'error', precio: 5000 });
    pieza(t, ids.sinPrecio, { estado: 'listo', precio: 0 });
    pieza(t, ids.lista, { estado: 'listo', precio: 5000 });
    const r = await t.pedir('/api/etiquetas', { ids: Object.values(ids) });
    assert.equal(r.status, 200);
    const codigo = (id: string) => (r.cuerpo as unknown as { id: string; codigo: string | null }[]).find((p) => p.id === id)?.codigo;
    assert.match(codigo(ids.lista)!, /^ED-\d{6}$/);
    for (const id of [ids.pendiente, ids.error, ids.sinPrecio]) assert.ok(!codigo(id), id);
    assert.equal(t.db.prepare("select count(*) n from productos where codigo like 'ED-%' and id in (?, ?, ?)").get(ids.pendiente, ids.error, ids.sinPrecio)!.n, 0);
  } finally { t.db.close(); }
});

test('el reporte semanal compara R2 con las piezas, solo registra y no borra nada', async (prueba) => {
  const registros: { huerfanos: number; primeros: string[]; total: number }[] = [];
  prueba.mock.method(console, 'log', (m: string) => { registros.push(JSON.parse(m)); });
  const t = tienda();
  try {
    const viva = crypto.randomUUID();
    pieza(t, viva);
    objetos(t).set(`fotos/${viva}.jpg`, new ArrayBuffer(1));
    objetos(t).set(`recortes/${viva}.webp`, new ArrayBuffer(1));
    for (let i = 0; i < 25; i++) objetos(t).set(`fotos/${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.jpg`, new ArrayBuffer(1));
    objetos(t).set(`recortes/${crypto.randomUUID()}.webp`, new ArrayBuffer(1));
    objetos(t).set('imagenes-upc/1/abc', new ArrayBuffer(1));
    await reportarHuerfanosR2(t.env);
    assert.equal(registros[0].huerfanos, 26);
    assert.equal(registros[0].primeros.length, 20);
    assert.equal(registros[0].total, 28);   // lo de otros prefijos ni se lista
    assert.equal(objetos(t).size, 29);
  } finally { t.db.close(); }
});

test('llavesHuerfanas ignora llaves ajenas y esCorridaSemanal cae solo el lunes a las 09:00 UTC', () => {
  const ids = new Set(['a', 'b']);
  assert.deepEqual(llavesHuerfanas(['fotos/a.jpg', 'fotos/c.jpg', 'recortes/b.webp', 'recortes/c.webp', 'fotos/c.png', 'otro/c.jpg'], ids), ['fotos/c.jpg', 'recortes/c.webp']);
  assert.equal(esCorridaSemanal(Date.parse('2026-10-26T09:00:00Z')), true);
  assert.equal(esCorridaSemanal(Date.parse('2026-10-26T09:14:00Z')), true);
  assert.equal(esCorridaSemanal(Date.parse('2026-10-26T09:15:00Z')), false);
  assert.equal(esCorridaSemanal(Date.parse('2026-10-26T10:00:00Z')), false);
  assert.equal(esCorridaSemanal(Date.parse('2026-10-27T09:00:00Z')), false);
});
