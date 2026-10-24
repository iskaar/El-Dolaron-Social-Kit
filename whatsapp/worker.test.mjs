import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from './worker.mjs';

const endpoint = 'https://whatsapp.eldolaron.com/webhook';
const env = { WHATSAPP_VERIFY_TOKEN: 'test-verify', META_APP_SECRET: 'test-app-secret' };
const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const signed = (body = payload, secret = env.META_APP_SECRET) => new Request(endpoint, {
  method: 'POST', body,
  headers: { 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
});

test('Meta verification returns the exact challenge and rejects invalid tokens or parameters', async () => {
  const url = `${endpoint}?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=12345`;
  const response = await worker.fetch(new Request(url), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '12345');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await worker.fetch(new Request(url.replace('test-verify', 'wrong')), env)).status, 403);
  assert.equal((await worker.fetch(new Request(endpoint), env)).status, 400);
  assert.equal((await worker.fetch(new Request(url), {})).status, 503);
});

test('signed events are saved privately with expiry before acknowledgement', async () => {
  const writes = [];
  const response = await worker.fetch(signed(), { ...env, EVENTS: { put: async (...args) => writes.push(args) } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'EVENT_RECEIVED');
  assert.equal(writes.length, 1);
  assert.match(writes[0][0], /^event:/);
  assert.equal(new TextDecoder().decode(writes[0][1]), payload);
  assert.equal(writes[0][2].expirationTtl, 604800);
});

test('forgeries, malformed payloads and incomplete configuration never save events', async () => {
  const configured = { ...env, EVENTS: { put: async () => assert.fail('must not store') } };
  assert.equal((await worker.fetch(signed(payload, 'wrong-secret'), configured)).status, 403);
  assert.equal((await worker.fetch(new Request(endpoint, { method: 'POST', body: payload }), configured)).status, 403);
  assert.equal((await worker.fetch(signed('{'), configured)).status, 400);
  assert.equal((await worker.fetch(signed('null'), configured)).status, 400);
  assert.equal((await worker.fetch(signed(), { EVENTS: configured.EVENTS })).status, 503);
  assert.equal((await worker.fetch(signed(), env)).status, 503);
});

test('storage failure returns a retryable error instead of falsely acknowledging delivery', async () => {
  const response = await worker.fetch(signed(), { ...env, EVENTS: { put: async () => { throw Error('failed'); } } });
  assert.equal(response.status, 503);
});

test('oversized streaming bodies are rejected even without Content-Length', async () => {
  const request = signed('x'.repeat(1024 * 1024 + 1));
  assert.equal(request.headers.get('content-length'), null);
  assert.equal((await worker.fetch(request, { ...env, EVENTS: {} })).status, 413);
});

test('only the intended public host, path and methods are served', async () => {
  assert.equal((await worker.fetch(new Request('https://escaner.viste.com.mx/webhook'), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`${endpoint}/other`), env)).status, 404);
  const response = await worker.fetch(new Request(endpoint, { method: 'DELETE' }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('#507: /alta no existe sin ALTA_CONFIG_ID; con ella sirve la página y canjea el código sin exponer el token', async () => {
  const alta = 'https://whatsapp.eldolaron.com/alta';
  assert.equal((await worker.fetch(new Request(alta), env)).status, 404);
  const conAlta = { ...env, ALTA_CONFIG_ID: '123456' };
  const pagina = await worker.fetch(new Request(alta), conAlta);
  assert.equal(pagina.status, 200);
  assert.match(await pagina.text(), /config_id: '123456'.*whatsapp_business_app_onboarding/s);
  const post = (cuerpo) => new Request(alta, { method: 'POST', body: JSON.stringify(cuerpo) });
  assert.equal((await worker.fetch(post({}), conAlta)).status, 400);
  assert.equal((await worker.fetch(post({ code: 'c', waba_id: 'x' }), conAlta)).status, 400);

  const original = globalThis.fetch;
  const llamadas = [];
  globalThis.fetch = async (url, opciones = {}) => {
    llamadas.push([String(url), opciones.method ?? 'GET', opciones.headers?.authorization]);
    if (String(url).includes('/oauth/access_token')) return Response.json({ access_token: 'tok-negocio' });
    if (String(url).includes('/subscribed_apps')) return Response.json({ success: true });
    if (String(url).includes('/debug_token')) return Response.json({ data: { granular_scopes: [
      { scope: 'whatsapp_business_messaging', target_ids: ['777'] }, { scope: 'whatsapp_business_management', target_ids: ['888'] }] } });
    return Response.json({ data: [{ id: '999', display_phone_number: '+52 444 543 7754', is_on_biz_app: true, platform_type: 'CLOUD_API' }] });
  };
  try {
    const respuesta = await worker.fetch(post({ code: 'c0d3', waba_id: '777' }), conAlta);
    const texto = await respuesta.text();
    assert.equal(respuesta.status, 200);
    assert.doesNotMatch(texto, /tok-negocio|test-app-secret/);
    const numeros = [{ id: '999', display_phone_number: '+52 444 543 7754', is_on_biz_app: true, platform_type: 'CLOUD_API' }];
    assert.deepEqual(JSON.parse(texto), { cuentas: [{ waba_id: '777', suscrita: true, numeros }] });
    assert.match(llamadas[0][0], /client_id=1891249878510930&client_secret=test-app-secret&code=c0d3/);
    assert.deepEqual(llamadas[1], ['https://graph.facebook.com/v26.0/777/subscribed_apps', 'POST', 'Bearer tok-negocio']);
    // Sin waba_id de la ventana: las cuentas salen de los permisos del token.
    llamadas.length = 0;
    const sinWaba = await worker.fetch(post({ code: 'c0d3' }), conAlta);
    assert.deepEqual(await sinWaba.json(), { cuentas: [{ waba_id: '888', suscrita: true, numeros }] });
    assert.match(llamadas[1][0], /debug_token\?input_token=tok-negocio&access_token=1891249878510930%7Ctest-app-secret/);
    assert.deepEqual(llamadas[2], ['https://graph.facebook.com/v26.0/888/subscribed_apps', 'POST', 'Bearer tok-negocio']);
  } finally { globalThis.fetch = original; }
});
