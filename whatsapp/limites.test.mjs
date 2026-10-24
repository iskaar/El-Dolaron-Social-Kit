import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.mjs';
import { enRafaga, MAX_CARACTERES, MAX_MODELO_DIA, MAX_MODELO_GLOBAL_DIA, MAX_POR_MINUTO, recortar, reservarModelo, SIN_CUOTA } from './limites.mjs';

function kv(datos = {}) {
  const guardados = new Map(Object.entries(datos));
  return {
    guardados,
    get: async (k, tipo) => {
      const v = guardados.get(k);
      if (v === undefined) return null;
      return tipo === 'json' ? JSON.parse(v) : v;
    },
    put: async (k, v) => { guardados.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
  };
}
const T = Date.UTC(2026, 9, 24, 18, 0, 0);

test('la ráfaga deja pasar MAX_POR_MINUTO mensajes por minuto y frena el siguiente; otro minuto empieza de cero', async () => {
  const k = kv();
  for (let i = 0; i < MAX_POR_MINUTO; i++) assert.equal(await enRafaga(k, '521', T), false);
  assert.equal(await enRafaga(k, '521', T + 5000), true);
  assert.equal(await enRafaga(k, '522', T), false);
  assert.equal(await enRafaga(k, '521', T + 61000), false);
});

test('la cuota diaria por número se agota antes que la global y se reinicia al día siguiente', async () => {
  const k = kv();
  for (let i = 0; i < MAX_MODELO_DIA; i++) assert.equal(await reservarModelo(k, '521', T), null);
  assert.equal(await reservarModelo(k, '521', T), 'numero');
  assert.equal(await reservarModelo(k, '522', T), null);
  assert.equal(await reservarModelo(k, '521', T + 86400000), null);
});

test('la cuota global corta a todos los números cuando la tienda ya gastó su día', async () => {
  const k = kv({ [`cuota:2026-10-24:global`]: String(MAX_MODELO_GLOBAL_DIA) });
  assert.equal(await reservarModelo(k, '529', T), 'global');
});

test('recortar limpia espacios y corta al tope de caracteres', () => {
  assert.equal(recortar('  hola \n\n  mundo  '), 'hola mundo');
  assert.equal(recortar('a'.repeat(MAX_CARACTERES + 50)).length, MAX_CARACTERES);
});

// --- el Worker aplica los límites -----------------------------------------------------------
const endpoint = 'https://whatsapp.eldolaron.com/webhook';
const secreto = 'test-app-secret';
const firmado = (cuerpo) => new Request(endpoint, {
  method: 'POST', body: cuerpo,
  headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` },
});
const evento = (mensajes) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: mensajes } }] }] });
const texto = (id, de, cuerpo) => ({ id, from: de, type: 'text', text: { body: cuerpo } });
function red(respuestaModelo) {
  const llamadas = { modelo: [], meta: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => {
    const cuerpo = JSON.parse(opciones.body);
    if (String(url).includes('anthropic')) {
      llamadas.modelo.push(cuerpo);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: respuestaModelo }] }), { status: 200 });
    }
    llamadas.meta.push(cuerpo);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${llamadas.meta.length}` }] }), { status: 200 });
  };
  return { llamadas, restaurar: () => { globalThis.fetch = original; } };
}
const pendientes = [];
const ctx = { waitUntil: (p) => pendientes.push(p) };
const entorno = (datos = {}) => ({
  WHATSAPP_VERIFY_TOKEN: 'v', META_APP_SECRET: secreto, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p',
  ANTHROPIC_API_KEY: 'clave', EVENTS: kv(datos),
});
const correr = async (env, mensajes) => {
  await worker.fetch(firmado(evento(mensajes)), env, ctx);
  await Promise.all(pendientes.splice(0));
};
const largo = (n) => `necesito ayuda para elegir un regalo bonito y barato, intento ${n}, para mi hermana`;

test('una ráfaga del mismo número deja de recibir respuestas, incluso del FAQ', async () => {
  const r = red('Claro.\nSCORE: 2');
  try {
    const env = entorno();
    const mensajes = Array.from({ length: MAX_POR_MINUTO + 3 }, (_, i) => texto(`r${i}`, '5214421111111', 'horario'));
    await correr(env, mensajes);
    assert.equal(r.llamadas.meta.length, MAX_POR_MINUTO);
    assert.equal(r.llamadas.modelo.length, 0);
  } finally { r.restaurar(); }
});

test('al agotar la cuota diaria el número recibe la respuesta fija y el modelo ya no se llama; el FAQ sigue', async () => {
  const r = red('Claro.\nSCORE: 2');
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const env = entorno({ [`cuota:${hoy}:5214422222222`]: String(MAX_MODELO_DIA) });
    await correr(env, [texto('c1', '5214422222222', largo(1))]);
    assert.equal(r.llamadas.modelo.length, 0);
    assert.equal(r.llamadas.meta[0].text.body, SIN_CUOTA);
    await correr(env, [texto('c2', '5214422222222', 'horario')]);
    assert.match(r.llamadas.meta[1].text.body, /11 a\. m\./);
  } finally { r.restaurar(); }
});

test('con la cuota global agotada todos caen al FAQ fijo o al respaldo, sin modelo', async () => {
  const r = red('Claro.\nSCORE: 2');
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const env = entorno({ [`cuota:${hoy}:global`]: String(MAX_MODELO_GLOBAL_DIA) });
    await correr(env, [texto('g1', '5214423333333', largo(2))]);
    assert.equal(r.llamadas.modelo.length, 0);
    assert.match(r.llamadas.meta[0].text.body, /este mismo chat/);
  } finally { r.restaurar(); }
});

test('el texto que recibe el modelo va recortado al tope de caracteres', async () => {
  const r = red('Claro.\nSCORE: 2');
  try {
    await correr(entorno(), [texto('l1', '5214424444444', 'x '.repeat(900))]);
    const ultimo = r.llamadas.modelo[0].messages.at(-1).content;
    assert.ok(ultimo.length <= MAX_CARACTERES);
  } finally { r.restaurar(); }
});
