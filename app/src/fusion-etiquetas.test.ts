// node --test src/fusion-etiquetas.test.ts
// Carreras de Issue #244: fusionar en paralelo y reservar etiquetas en paralelo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO } from './prueba-d1.ts';

const REPETIDA = 'b2222222-2222-4222-8222-222222222222';

test('dos fusiones de la misma repetida suman una sola vez', async () => {
  const t = tienda();
  t.db.prepare(`insert into productos (id, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
                values (?, 'Ventilador', 25000, 3, 'S40', '', '')`).run(REPETIDA);
  // Ambas fusiones leen antes de que cualquiera escriba.
  const batch = t.env.DB.batch.bind(t.env.DB);
  let llegadas = 0;
  let abrir!: () => void;
  const puerta = new Promise<void>((r) => { abrir = r; });
  (t.env.DB as any).batch = async (sentencias: unknown[]) => {
    if (++llegadas === 2) abrir();
    await puerta;
    return batch(sentencias);
  };
  const [a, b] = await Promise.all([1, 2].map(() => t.pedir(`/api/borradores/${REPETIDA}/fusionar`, { destino_id: PRODUCTO })));
  assert.deepEqual([a.status, b.status].sort(), [200, 404]);
  assert.equal((t.db.prepare('select stock from productos where id = ?').get(PRODUCTO) as { stock: number }).stock, 53);
  assert.equal((a.status === 200 ? a : b).cuerpo.stock, 53);
});

test('una reserva de etiqueta que llega tarde no reemplaza el codigo ya emitido', async () => {
  const t = tienda();
  const id = 'c3333333-3333-4333-8333-333333333333';
  t.db.prepare(`insert into productos (id, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
                values (?, 'Lampara', 9000, 1, 'S40', '', '')`).run(id);
  const preparar = t.env.DB.prepare.bind(t.env.DB);
  let pausar = true;
  let leyo!: () => void;
  let liberar!: () => void;
  const alLeer = new Promise<void>((r) => { leyo = r; });
  const puerta = new Promise<void>((r) => { liberar = r; });
  (t.env.DB as any).prepare = (sql: string) => {
    const s = preparar(sql);
    if (!pausar || !sql.includes('select id from productos where id in')) return s;
    pausar = false;
    const todo = s.all.bind(s);
    s.all = async () => { const r = await todo(); leyo(); await puerta; return r; };
    return s;
  };
  const tarde = t.pedir('/api/etiquetas', { ids: [id] });
  await alLeer;
  const primera = await t.pedir('/api/etiquetas', { ids: [id] });
  const codigo = primera.cuerpo[0].codigo;
  assert.match(codigo, /^ED-\d{6}$/);
  liberar();
  const r = await tarde;
  assert.equal((t.db.prepare('select codigo from productos where id = ?').get(id) as { codigo: string }).codigo, codigo);
  assert.equal(r.cuerpo[0].codigo, codigo);
});
