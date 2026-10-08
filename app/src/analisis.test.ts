// node --test src/analisis.test.ts
// Si el modelo no contesta, el analisis termina solo y la fila queda en `error`, no en `pendiente`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { analizarBorrador, LIMITES_MS } from './analisis.ts';

test('un modelo que nunca responde deja la fila en error (Claude y Gemini)', async (t) => {
  const { db, env } = tienda();
  const fetchOriginal = globalThis.fetch;
  const limitesOriginales = { ...LIMITES_MS };
  // Nunca responde; solo se entera de que lo cancelaron.
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_ok, fallo) => {
    init?.signal?.addEventListener('abort', () => fallo(new Error('cancelado')));
  })) as typeof fetch;
  LIMITES_MS.claude = 50;
  LIMITES_MS.gemini = 50;
  t.after(() => { globalThis.fetch = fetchOriginal; Object.assign(LIMITES_MS, limitesOriginales); });
  (env as { ANTHROPIC_API_KEY: string; GEMINI_API_KEY: string }).ANTHROPIC_API_KEY = 'prueba';
  (env as { ANTHROPIC_API_KEY: string; GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';

  for (const modelo of ['claude', 'gemini'] as const) {
    const id = crypto.randomUUID();
    await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
    db.prepare(
      `insert into productos (id, nombre, estado_analisis, foto_key, semana_ingreso, creado_en, actualizado_en)
       values (?, '', 'pendiente', ?, 'S40', '', '')`).run(id, `fotos/${id}.jpg`);
    const inicio = Date.now();
    await analizarBorrador(id, env, modelo);
    assert.ok(Date.now() - inicio < 5000, `${modelo} tardo demasiado`);
    const fila = db.prepare('select estado_analisis from productos where id = ?').get(id) as { estado_analisis: string };
    assert.equal(fila.estado_analisis, 'error', modelo);
  }
});
