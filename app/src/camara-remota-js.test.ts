// node --test src/camara-remota-js.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { desfase, segundosRestantes, estadoDe, reloj, inactivo, abierta, formularioFoto, INACTIVO_MS } from '../public/camara-remota.js';

const solicitud = (datos = {}) => ({ id: 'a', tipo: 'foto_pieza', pieza_id: 'p1', params: {}, estado: 'pendiente',
  vence_en: '2026-10-22T12:02:00.000Z', ...datos });

test('la cuenta regresiva usa la hora del servidor, no la del celular', () => {
  const servidor = '2026-10-22T12:00:12.000Z';
  const localAtrasado = Date.parse(servidor) - 60_000;   // celular con el reloj un minuto atrasado
  const d = desfase(servidor, localAtrasado);
  assert.equal(d, 60_000);
  assert.equal(segundosRestantes(solicitud(), d, localAtrasado), 108);
  assert.equal(reloj(108), '1:48');
  assert.equal(reloj(5), '0:05');
});

test('vencida se deriva entre sondeos; lista y cancelada no cambian', () => {
  const ahora = Date.parse('2026-10-22T12:02:00.000Z');
  assert.equal(estadoDe(solicitud(), 0, ahora - 1000), 'pendiente');
  assert.equal(estadoDe(solicitud(), 0, ahora), 'vencida');
  assert.equal(estadoDe(solicitud({ estado: 'tomada' }), 0, ahora + 5000), 'vencida');
  assert.equal(estadoDe(solicitud({ estado: 'lista' }), 0, ahora + 5000), 'lista');
  assert.equal(estadoDe(solicitud({ estado: 'cancelada' }), 0, ahora + 5000), 'cancelada');
  assert.equal(estadoDe(null, 0, ahora), null);
  assert.deepEqual(['pendiente', 'tomada', 'lista', 'cancelada', 'vencida'].map((estado) => abierta(solicitud({ estado }))),
    [true, true, false, false, false]);
});

test('el celular se apaga tras 60 min sin solicitudes', () => {
  assert.equal(inactivo(0, INACTIVO_MS - 1), false);
  assert.equal(inactivo(0, INACTIVO_MS), true);
});

test('el formulario es el mismo que entiende POST /api/borradores', async () => {
  const foto = new Blob(['x'], { type: 'image/jpeg' });
  const retomar = formularioFoto(solicitud(), foto);
  assert.equal(retomar.get('id'), 'p1'); assert.equal(retomar.get('solo_foto'), '1'); assert.equal(retomar.get('estado_fisico'), 'nuevo');
  assert.ok(retomar.get('foto') instanceof File);
  const nueva = formularioFoto(solicitud({ tipo: 'pieza_nueva', params: { estado_fisico: 'danado', cantidad: 3, upc: 'SIN_CODIGO' } }), foto);
  assert.equal(nueva.get('solo_foto'), null); assert.equal(nueva.get('estado_fisico'), 'danado');
  assert.equal(nueva.get('cantidad'), '3'); assert.equal(nueva.get('upc'), 'SIN_CODIGO'); assert.equal(nueva.get('talla'), null);
});
