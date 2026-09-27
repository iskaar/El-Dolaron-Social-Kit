// node --test src/cajon.test.ts
// «Abrir cajon» deja quien y cuando (Issue #97).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';

const apertura = (abierto_en = '2026-10-02T17:00:00.000Z') => ({ id: crypto.randomUUID(), abierto_en });

test('la apertura queda con el correo de quien la hizo y sale en reportes', async () => {
  const { pedir } = tienda();
  const a = apertura(new Date().toISOString());
  assert.equal((await pedir('/api/cajon', a)).status, 201);
  assert.equal((await pedir('/api/cajon', a)).status, 201);   // reenvio tras red caida: no duplica
  const r = (await pedir('/api/reportes?dias=1')).cuerpo;
  assert.equal(r.aperturas_cajon.length, 1);
  assert.equal(r.aperturas_cajon[0].abierto_por, DUENO);
});

test('datos invalidos no se registran', async () => {
  const { pedir } = tienda();
  assert.equal((await pedir('/api/cajon', { id: 'x', abierto_en: '2026-10-02T17:00:00Z' })).status, 400);
  assert.equal((await pedir('/api/cajon', { id: crypto.randomUUID(), abierto_en: 'ayer' })).status, 400);
});

test('el cajero registra aperturas; quien solo captura no', async () => {
  const { db, env, pedir } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('caja@prueba.mx', 'K', 'cajero', 1, '', ''), ('captura@prueba.mx', 'C', 'capturista', 1, '', '')`).run();
  const como = (correo: string) => { (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  como('caja@prueba.mx');
  assert.equal((await pedir('/api/cajon', apertura())).status, 201);
  como('captura@prueba.mx');
  assert.equal((await pedir('/api/cajon', apertura())).status, 403);
});
