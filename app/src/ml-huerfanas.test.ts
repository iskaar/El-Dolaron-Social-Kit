// node --test src/ml-huerfanas.test.ts
// Issue #246: una pieza con publicacion viva en ML no se borra ni se fusiona, y la
// conciliacion nunca sube la cantidad de ML. Ninguna prueba toca la red.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';
import { guardarTokens, conciliarPublicaciones } from './mercadolibre.ts';

const LLAVE = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const fetchReal = globalThis.fetch;
const REPETIDA = 'b2222222-2222-4222-8222-222222222222';

async function conML(prueba: (t: ReturnType<typeof tienda>, puts: any[], ml: { cantidad: number }) => Promise<void>) {
  const t = tienda();
  Object.assign(t.env, { ML_CLIENT_ID: '123', ML_CLIENT_SECRET: 's', ML_LLAVE_TOKENS: LLAVE });
  await guardarTokens(t.env, { access_token: 'AT-0', refresh_token: 'RT-0', expires_in: 10800, user_id: 555 });
  const puts: any[] = [];
  const ml = { cantidad: 1 };
  globalThis.fetch = (async (entrada: unknown, init: RequestInit = {}) => {
    const u = new URL(String(entrada));
    if (init.method === 'PUT') { puts.push(JSON.parse(String(init.body))); return Response.json({}); }
    return Response.json([{ code: 200, body: { id: 'MLM1', status: 'active', available_quantity: ml.cantidad } }]);
  }) as typeof fetch;
  try { await prueba(t, puts, ml); } finally { globalThis.fetch = fetchReal; }
}

const publicar = (t: ReturnType<typeof tienda>, id: string, estado = 'activa', item: string | null = 'MLM1') =>
  t.db.prepare(`insert into ml_publicaciones (producto_id, ml_item_id, estado, actualizado_en) values (?, ?, ?, ?)`)
    .run(id, item, estado, new Date().toISOString());
const existe = (t: ReturnType<typeof tienda>, id: string) => !!t.db.prepare('select 1 from productos where id = ?').get(id);

test('descartar una pieza con publicacion viva en ML: 409 y no se borra', async () => {
  const t = tienda();
  publicar(t, PRODUCTO);
  const r = await t.pedir(`/api/borradores/${PRODUCTO}`, {}, 'DELETE');
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /Mercado Libre/);
  assert.ok(existe(t, PRODUCTO));
});

test('descartar sin publicacion (o con la publicacion cerrada) sigue funcionando', async () => {
  const t = tienda();
  publicar(t, PRODUCTO, 'cerrada');
  assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}`, {}, 'DELETE')).status, 200);
  assert.ok(!existe(t, PRODUCTO));
  const u = tienda();
  assert.equal((await u.pedir(`/api/borradores/${PRODUCTO}`, {}, 'DELETE')).status, 200);
  assert.ok(!existe(u, PRODUCTO));
});

test('fusionar una repetida con publicacion viva en ML: 409 y nada cambia', async () => {
  const t = tienda();
  t.db.prepare(`insert into productos (id, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
                values (?, 'Ventilador', 25000, 3, 'S40', '', '')`).run(REPETIDA);
  publicar(t, REPETIDA, 'pausada');
  const r = await t.pedir(`/api/borradores/${REPETIDA}/fusionar`, { destino_id: PRODUCTO });
  assert.equal(r.status, 409);
  assert.ok(existe(t, REPETIDA));
  assert.equal((t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 50);
});

test('conciliar: con 2 en D1 y 1 en ML (orden aun sin pagar) no sube la cantidad de ML', async () => {
  await conML(async (t, puts, ml) => {
    t.db.prepare('update productos set stock = 2 where id = ?').run(PRODUCTO);
    publicar(t, PRODUCTO);
    ml.cantidad = 1;
    await conciliarPublicaciones(t.env);
    assert.deepEqual(puts, []);
  });
});

test('conciliar: con 1 en D1 y 3 en ML baja ML a 1', async () => {
  await conML(async (t, puts, ml) => {
    t.db.prepare('update productos set stock = 1 where id = ?').run(PRODUCTO);
    publicar(t, PRODUCTO);
    ml.cantidad = 3;
    await conciliarPublicaciones(t.env);
    assert.deepEqual(puts, [{ available_quantity: 1 }]);
  });
});
