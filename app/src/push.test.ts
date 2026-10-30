// node --test src/push.test.ts
// Issue #600: botón «Ayuda» de la caja -> notificación push al dueño (Web Push con VAPID).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';
import { cifrar, clavePublica } from './push.ts';

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64url'));

test('cifrado aes128gcm: reproduce el ejemplo del RFC 8291 (apéndice A)', async () => {
  const asPublica = b64('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    x: Buffer.from(asPublica.slice(1, 33)).toString('base64url'), y: Buffer.from(asPublica.slice(33)).toString('base64url') };
  const efimera = {
    privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', asPublica, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
  };
  const cuerpo = await cifrar('When I grow up, I want to be a watermelon',
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg', b64('DGv6ra1nlYgDCS1FRnbzlw'), efimera);
  assert.equal(Buffer.from(cuerpo).toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

async function conPush() {
  const t = tienda();
  const llaves = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', llaves.privateKey) as JsonWebKey;
  t.env.VAPID_JWK = JSON.stringify(jwk);
  const correos: any[] = [];
  t.env.CORREO = { async send(m: any) { correos.push(m); return { messageId: 'x' }; } } as never;
  // El dispositivo: sus llaves como las da PushSubscription.toJSON().
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const keys = {
    p256dh: Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey) as ArrayBuffer).toString('base64url'),
    auth: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
  };
  const llegadas: { url: string; headers: Headers }[] = [];
  let respuesta = 201;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    llegadas.push({ url, headers: new Headers(init.headers) });
    return new Response('', { status: respuesta });
  }) as typeof fetch;
  test.after(() => { globalThis.fetch = original; });
  return { ...t, jwk, llaves, keys, llegadas, correos, responder: (s: number) => { respuesta = s; } };
}

test('el dueño activa push: se guarda, recibe una prueba con VAPID válido; la ayuda de caja le llega por push', async () => {
  const t = await conPush();
  const clave = await t.pedir('/api/push/clave', undefined);
  assert.equal(clave.cuerpo.clave, clavePublica(t.jwk));

  const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH';
  const alta = await t.pedir('/api/push/suscripcion', { endpoint, keys: t.keys });
  assert.equal(alta.status, 200);
  assert.equal(alta.cuerpo.prueba, true);
  const prueba = t.llegadas[0];
  assert.equal(prueba.url, endpoint);
  assert.equal(prueba.headers.get('content-encoding'), 'aes128gcm');
  // VAPID: JWT ES256 firmado con la llave del secreto, para el origen del servicio de push.
  const [, jwt, k] = prueba.headers.get('authorization')!.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(k, clave.cuerpo.clave);
  const [cab, carga, firma] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(carga, 'base64url').toString()).aud, 'https://web.push.apple.com');
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, t.llaves.publicKey, b64(firma), new TextEncoder().encode(`${cab}.${carga}`)));

  // Un cajero pide ayuda: push al dueño, sin correo.
  t.db.prepare("insert into usuarios(correo, nombre, roles, activo, creado_en, actualizado_en) values ('ana@prueba.mx', 'Ana', 'cajero', 1, '', '')").run();
  t.env.DEV_USUARIO = 'ana@prueba.mx';
  const ayuda = await t.pedir('/api/ayuda', { caja: 'Caja 2' });
  assert.deepEqual(ayuda.cuerpo, { ok: true, push: 1 });
  assert.equal(t.llegadas.length, 2);
  assert.equal(t.correos.length, 0);

  // El cajero no puede registrar dispositivos ni leer la llave.
  assert.equal((await t.pedir('/api/push/suscripcion', { endpoint, keys: t.keys })).status, 403);
  assert.equal((await t.pedir('/api/push/clave', undefined)).status, 403);
});

test('suscripción vencida (410) se borra y la ayuda cae al correo; datos inválidos se rechazan', async () => {
  const t = await conPush();
  assert.equal((await t.pedir('/api/push/suscripcion', { endpoint: 'http://x.mx/a', keys: t.keys })).status, 400);
  assert.equal((await t.pedir('/api/push/suscripcion', { endpoint: 'https://x.mx/a', keys: { ...t.keys, auth: 'corto' } })).status, 400);
  assert.equal((await t.pedir('/api/push/suscripcion', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: t.keys })).status, 200);

  t.responder(410);
  const ayuda = await t.pedir('/api/ayuda', { caja: 'no existe' });
  assert.deepEqual(ayuda.cuerpo, { ok: true, push: 0 });
  assert.equal((t.db.prepare('select count(*) n from push_suscripciones').get() as { n: number }).n, 0);
  assert.equal(t.correos.length, 1);
  assert.equal(t.correos[0].to, DUENO);
  assert.equal(t.correos[0].text, 'Isaac pide ayuda.');
});
