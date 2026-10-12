import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.mjs';
import { PROMPT, esFinDeConversacion, generarRespuesta, interpretar } from './asistente.mjs';

const endpoint = 'https://whatsapp.eldolaron.com/webhook';
const secreto = 'test-app-secret';
const firmado = (cuerpo) => new Request(endpoint, {
  method: 'POST', body: cuerpo,
  headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` },
});
const evento = (mensajes) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { messages: mensajes } }] }] });
const texto = (id, de, cuerpo) => ({ id, from: de, type: 'text', text: { body: cuerpo } });

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
    list: async () => ({ list_complete: true, keys: [] }),
  };
}

/** Simula Claude y Meta. `respuestaModelo` es el texto que devuelve el modelo, o null para fallar. */
function red(respuestaModelo) {
  const llamadas = { modelo: [], meta: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => {
    const cuerpo = JSON.parse(opciones.body);
    if (String(url).includes('anthropic')) {
      llamadas.modelo.push({ url, cuerpo, cabeceras: opciones.headers });
      if (respuestaModelo === null) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: respuestaModelo }] }), { status: 200 });
    }
    llamadas.meta.push(cuerpo);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${llamadas.meta.length}` }] }), { status: 200 });
  };
  return { llamadas, restaurar: () => { globalThis.fetch = original; } };
}
const pendientes = [];
const ctx = { waitUntil: (p) => pendientes.push(p) };
const entorno = (datos = {}, extra = {}) => ({
  WHATSAPP_VERIFY_TOKEN: 'v', META_APP_SECRET: secreto, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p',
  EVENTS: kv(datos), ...extra,
});
const correr = async (env, mensajes) => {
  await worker.fetch(firmado(evento(mensajes)), env, ctx);
  await Promise.all(pendientes.splice(0));
};

test('interpreta SCORE y ESCALAR sin mostrarlos al cliente', () => {
  const r = interpretar('Abrimos de 11:00 a 20:00.\nSCORE: 2');
  assert.equal(r.texto, 'Abrimos de 11:00 a 20:00.');
  assert.equal(r.puntaje, 2);
  assert.equal(r.escalar, false);
  assert.equal(interpretar('Lo confirmo con el equipo. ESCALAR\nSCORE: 3').escalar, true);
  assert.equal(interpretar('Te esperamos.\nSCORE: 8').escalar, true);
});

test('mensajes de cierre no se contestan con historial', () => {
  assert.equal(esFinDeConversacion('gracias', true), true);
  assert.equal(esFinDeConversacion('gracias', false), false);
  assert.equal(esFinDeConversacion('¿?', true), false);
});

test('el prompt solo afirma los datos aprobados', () => {
  assert.match(PROMPT, /444 543 7754/);
  assert.match(PROMPT, /11:00 a 20:00/);
  assert.match(PROMPT, /solo en sucursal/);
  assert.match(PROMPT, /no inventes nada/);
});

test('llama al modelo con el prompt y el historial, y propaga los errores', async () => {
  const r = red('Hola, con gusto.\nSCORE: 1');
  try {
    const texto = await generarRespuesta([{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hola' }], '¿abren?', 'clave');
    assert.equal(texto, 'Hola, con gusto.\nSCORE: 1');
    const llamada = r.llamadas.modelo[0];
    assert.equal(llamada.cuerpo.model, 'claude-haiku-5-5');
    assert.equal(llamada.cuerpo.system, PROMPT);
    assert.equal(llamada.cuerpo.messages.at(-1).content, '¿abren?');
    assert.equal(llamada.cabeceras['x-api-key'], 'clave');
  } finally { r.restaurar(); }
  const fallo = red(null);
  try {
    await assert.rejects(generarRespuesta([], 'hola', 'clave'));
  } finally { fallo.restaurar(); }
});

test('el asistente responde, guarda el turno y registra la respuesta para el personal', async () => {
  const r = red('Abrimos de 11:00 a 20:00.\nSCORE: 2');
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    await correr(env, [texto('m1', '5214421234567', '¿A qué hora abren?')]);
    assert.equal(r.llamadas.meta.length, 1);
    assert.equal(r.llamadas.meta[0].text.body, 'Abrimos de 11:00 a 20:00.');
    const historial = JSON.parse(env.EVENTS.guardados.get('historial:5214421234567'));
    assert.deepEqual(historial.map((t) => t.role), ['user', 'assistant']);
    const salida = [...env.EVENTS.guardados.entries()].find(([k]) => k.startsWith('saliente:'));
    assert.equal(JSON.parse(salida[1]).enviado_por, 'asistente automático');
  } finally { r.restaurar(); }
});

test('si el asistente escala, la conversación queda pausada y no vuelve a contestar', async () => {
  const r = red('Eso lo confirmo con el equipo. ESCALAR');
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    await correr(env, [texto('m2', '5214421234567', '¿Tienen promociones?')]);
    assert.equal(env.EVENTS.guardados.has('pausado:5214421234567'), true);
    await correr(env, [texto('m3', '5214421234567', '¿Y los precios?')]);
    assert.equal(r.llamadas.modelo.length, 1);
    assert.equal(r.llamadas.meta.length, 1);
  } finally { r.restaurar(); }
});

test('si el modelo falla o no hay clave, responde con el FAQ fijo', async () => {
  const r = red(null);
  try {
    const env = entorno({}, { ANTHROPIC_API_KEY: 'clave' });
    await correr(env, [texto('m4', '5214421234567', 'horario')]);
    assert.match(r.llamadas.meta[0].text.body, /11:00 a 20:00/);
  } finally { r.restaurar(); }
  const sinClave = red('no debe usarse');
  try {
    await correr(entorno(), [texto('m5', '5214429999999', 'telefono')]);
    assert.match(sinClave.llamadas.meta[0].text.body, /444 543 7754/);
    assert.equal(sinClave.llamadas.modelo.length, 0);
  } finally { sinClave.restaurar(); }
});

test('una imagen recibe la respuesta corta, sin el modelo', async () => {
  const r = red('no debe usarse');
  try {
    await correr(entorno({}, { ANTHROPIC_API_KEY: 'clave' }), [{ id: 'm6', from: '5214421234567', type: 'image', image: {} }]);
    assert.match(r.llamadas.meta[0].text.body, /Recibimos tu imagen/);
    assert.equal(r.llamadas.modelo.length, 0);
  } finally { r.restaurar(); }
});
