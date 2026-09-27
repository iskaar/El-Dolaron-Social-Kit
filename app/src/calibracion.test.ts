// node --test src/calibracion.test.ts
// La calibracion de la etiquetera vive en `config` (Issue #89), no en el navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';

test('la calibracion se guarda en config y se lee con /api/config', async () => {
  const { pedir } = tienda();
  const guardar = (cuerpo: unknown) => pedir('/api/calibracion', cuerpo, 'PUT');
  assert.deepEqual((await guardar({ corrimiento: -12, modulo: 3 })).cuerpo, { corrimiento: -12, modulo: 3 });
  const config = (await pedir('/api/config')).cuerpo;
  assert.equal(config.etiqueta_corrimiento, '-12');
  assert.equal(config.etiqueta_modulo, '3');
  // Solo el corrimiento: el ancho se conserva.
  assert.deepEqual((await guardar({ corrimiento: 8 })).cuerpo, { corrimiento: 8, modulo: 3 });
});

test('valores fuera de rango no se guardan', async () => {
  const { pedir } = tienda();
  for (const cuerpo of [{ corrimiento: 1.5 }, { corrimiento: 999 }, { modulo: 1 }, { modulo: 9 }, {}]) {
    assert.equal((await pedir('/api/calibracion', cuerpo, 'PUT')).status, 400, JSON.stringify(cuerpo));
  }
});

test('quien captura puede calibrar; el cajero no', async () => {
  const { db, env, pedir } = tienda();
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    ('captura@prueba.mx', 'C', 'capturista', 1, '', ''), ('caja@prueba.mx', 'K', 'cajero', 1, '', '')`).run();
  const como = (correo: string) => { (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  como('captura@prueba.mx');
  assert.equal((await pedir('/api/calibracion', { modulo: 4 }, 'PUT')).status, 200);
  como('caja@prueba.mx');
  assert.equal((await pedir('/api/calibracion', { modulo: 4 }, 'PUT')).status, 403);
});
