import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.mjs';
import { respuestaPara } from './respuestas.mjs';

test('preguntas del FAQ reciben la respuesta aprobada, con o sin acentos', () => {
  assert.match(respuestaPara('¿A qué hora abren?'), /11:00 a 20:00/);
  assert.match(respuestaPara('cual es su telefono'), /444 543 7754/);
  assert.match(respuestaPara('Hacen envíos a domicilio?'), /solo en sucursal/);
  assert.match(respuestaPara('hola buenas tardes'), /gracias por escribir/);
});

test('lo no confirmado (ubicacion, precios) recibe el mensaje de respaldo con telefono y horario', () => {
  for (const pregunta of ['¿Dónde están?', 'cuanto cuesta el sofa', 'tienen promocion']) {
    assert.match(respuestaPara(pregunta), /no tengo esa información.*444 543 7754/);
  }
  assert.match(respuestaPara(undefined), /no tengo esa información/);
});

const endpoint = 'https://whatsapp.eldolaron.com/webhook';
const secreto = 'test-app-secret';
const firmado = (cuerpo) => new Request(endpoint, {
  method: 'POST', body: cuerpo,
  headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` },
});
const evento = (mensajes) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '0', changes: [{
  field: 'messages', value: { messages: mensajes } }] }] });
const kv = () => {
  const datos = new Map();
  return { datos, get: async (k) => datos.get(k) ?? null, put: async (k, v) => { datos.set(k, v); } };
};
function conEnvio(envs) {
  const llamadas = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opciones) => { llamadas.push({ url, cuerpo: JSON.parse(opciones.body), opciones }); return new Response('{}', { status: envs ?? 200 }); };
  return { llamadas, restaurar: () => { globalThis.fetch = original; } };
}
const pendientes = [];
const ctx = { waitUntil: (p) => pendientes.push(p) };

test('un mensaje de texto recibe una respuesta del FAQ una sola vez', async () => {
  const envio = conEnvio();
  try {
    const env = { WHATSAPP_VERIFY_TOKEN: 'v', META_APP_SECRET: secreto, WHATSAPP_ACCESS_TOKEN: 'token', WHATSAPP_PHONE_NUMBER_ID: '1433484303171531', EVENTS: kv() };
    const mensaje = [{ id: 'wamid.1', from: '5214421234567', type: 'text', text: { body: 'Horario?' } }];
    assert.equal((await worker.fetch(firmado(evento(mensaje)), env, ctx)).status, 200);
    await Promise.all(pendientes.splice(0));
    // Meta reintenta el mismo evento: no se contesta de nuevo.
    await worker.fetch(firmado(evento(mensaje)), env, ctx);
    await Promise.all(pendientes.splice(0));
    assert.equal(envio.llamadas.length, 1);
    assert.match(envio.llamadas[0].url, /\/1433484303171531\/messages$/);
    assert.equal(envio.llamadas[0].opciones.headers.authorization, 'Bearer token');
    assert.equal(envio.llamadas[0].cuerpo.to, '5214421234567');
    assert.match(envio.llamadas[0].cuerpo.text.body, /11:00 a 20:00/);
  } finally { envio.restaurar(); }
});

test('sin token de envio o con mensajes que no son texto no se contesta nada', async () => {
  const envio = conEnvio();
  try {
    const env = { WHATSAPP_VERIFY_TOKEN: 'v', META_APP_SECRET: secreto, EVENTS: kv() };
    assert.equal((await worker.fetch(firmado(evento([{ id: 'wamid.2', from: '1', type: 'text', text: { body: 'hola' } }])), env, ctx)).status, 200);
    await Promise.all(pendientes.splice(0));
    assert.equal(envio.llamadas.length, 0);
    const conToken = { ...env, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p' };
    await worker.fetch(firmado(evento([{ id: 'wamid.3', from: '1', type: 'image', image: {} }])), conToken, ctx);
    await Promise.all(pendientes.splice(0));
    assert.equal(envio.llamadas.length, 0);
  } finally { envio.restaurar(); }
});

test('un fallo de envio no cambia el acuse a Meta', async () => {
  const envio = conEnvio(500);
  try {
    const env = { WHATSAPP_VERIFY_TOKEN: 'v', META_APP_SECRET: secreto, WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'p', EVENTS: kv() };
    const respuesta = await worker.fetch(firmado(evento([{ id: 'wamid.4', from: '1', type: 'text', text: { body: 'hola' } }])), env, ctx);
    assert.equal(respuesta.status, 200);
    assert.equal(await respuesta.text(), 'EVENT_RECEIVED');
    await Promise.all(pendientes.splice(0));
    assert.equal(envio.llamadas.length, 1);
  } finally { envio.restaurar(); }
});
