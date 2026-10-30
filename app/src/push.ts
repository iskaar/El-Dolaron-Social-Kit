/**
 * Botón «Ayuda» de la caja y notificaciones push al dueño (Issue #600). Web Push
 * estándar (RFC 8291 cifrado aes128gcm, RFC 8292 VAPID) con WebCrypto, sin
 * dependencias. VAPID_JWK es la llave privada P-256 en JWK; la pública sale de x,y.
 * Una suscripción por dispositivo en push_suscripciones (migración 061). Sin
 * VAPID_JWK o sin dispositivos, la ayuda llega por correo (avisos.ts).
 */
import { correoADuenos, REMITENTE } from './avisos.ts';
import { leerRoles, leerUsuario, CAJAS } from './cuentas.ts';

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

const texto = (s: string) => new TextEncoder().encode(s);
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const unir = (...partes: Uint8Array[]) => {
  const todo = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) { todo.set(p, i); i += p.length; }
  return todo;
};

/** La llave pública VAPID (65 bytes sin comprimir, base64url): la que pide pushManager.subscribe. */
export const clavePublica = (jwk: JsonWebKey) => b64url(unir(new Uint8Array([4]), deB64url(jwk.x!), deB64url(jwk.y!)));

async function vapid(endpoint: string, jwk: JsonWebKey): Promise<string> {
  const llave = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const firmado = [{ typ: 'JWT', alg: 'ES256' }, {
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: `mailto:${REMITENTE}`,
  }].map((parte) => b64url(texto(JSON.stringify(parte)))).join('.');
  const firma = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, llave, texto(firmado)));
  return `vapid t=${firmado}.${b64url(firma)}, k=${clavePublica(jwk)}`;
}

async function hkdf(sal: Uint8Array, ikm: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const llave = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: sal, info }, llave, bits));
}

/**
 * RFC 8291: un solo registro aes128gcm para el dispositivo (p256dh, auth de su PushSubscription).
 * La sal y la llave efímera solo se pasan en la prueba, para reproducir el ejemplo del RFC.
 */
export async function cifrar(
  mensaje: string, p256dh: string, auth: string,
  sal = crypto.getRandomValues(new Uint8Array(16)),
  efimera?: CryptoKeyPair,
): Promise<Uint8Array> {
  const uaPublica = deB64url(p256dh);
  efimera ??= await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublica = new Uint8Array(await crypto.subtle.exportKey('raw', efimera.publicKey) as ArrayBuffer);
  const ua = await crypto.subtle.importKey('raw', uaPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const compartido = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua } as never, efimera.privateKey, 256));
  const ikm = await hkdf(deB64url(auth), compartido, unir(texto('WebPush: info\0'), uaPublica, asPublica), 256);
  const cek = await crypto.subtle.importKey('raw', await hkdf(sal, ikm, texto('Content-Encoding: aes128gcm\0'), 128), 'AES-GCM', false, ['encrypt']);
  const nonce = await hkdf(sal, ikm, texto('Content-Encoding: nonce\0'), 96);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, unir(texto(mensaje), new Uint8Array([2]))));
  const encabezado = new Uint8Array(21);   // sal (16) | tamaño de registro (4) | largo de la llave (1)
  encabezado.set(sal);
  new DataView(encabezado.buffer).setUint32(16, 4096);
  encabezado[20] = asPublica.length;
  return unir(encabezado, asPublica, cifrado);
}

interface Suscripcion { endpoint: string; p256dh: string; auth: string }

/** true si el servicio de push la aceptó. Una suscripción vencida (404/410) se borra. */
async function enviar(env: Env, jwk: JsonWebKey, s: Suscripcion, titulo: string, cuerpo: string): Promise<boolean> {
  try {
    const r = await fetch(s.endpoint, {
      method: 'POST',
      headers: {
        authorization: await vapid(s.endpoint, jwk), 'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream', ttl: '600', urgency: 'high',
      },
      body: await cifrar(JSON.stringify({ titulo, cuerpo }), s.p256dh, s.auth),
    });
    if (r.status === 404 || r.status === 410) await env.DB.prepare('delete from push_suscripciones where endpoint = ?').bind(s.endpoint).run();
    if (!r.ok) console.error(JSON.stringify({ mensaje: 'push rechazado', status: r.status, servicio: new URL(s.endpoint).host, detalle: (await r.text()).slice(0, 200) }));
    return r.ok;
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'push fallido', servicio: new URL(s.endpoint).host, error: String(error) }));
    return false;
  }
}

/** Push a cada dispositivo de los dueños activos. Devuelve cuántos lo aceptaron. */
export async function pushADuenos(env: Env, titulo: string, cuerpo: string): Promise<number> {
  if (!env.VAPID_JWK) return 0;
  const jwk = JSON.parse(env.VAPID_JWK) as JsonWebKey;
  const { results } = await env.DB.prepare(
    `select s.endpoint, s.p256dh, s.auth, u.roles from push_suscripciones s
     join usuarios u on u.correo = s.correo where u.activo = 1`,
  ).all<Suscripcion & { roles: string }>();
  const enviados = await Promise.all(results.filter((s) => leerRoles(s.roles).includes('dueno'))
    .map((s) => enviar(env, jwk, s, titulo, cuerpo)));
  return enviados.filter(Boolean).length;
}

/** /api/ayuda (caja, a nombre del cajero con PIN) y /api/push/* (solo el dueño, por permiso()). */
export async function rutaPush(request: Request, env: Env, pathname: string, correo: string): Promise<Response | null> {
  if (pathname === '/api/ayuda' && request.method === 'POST') {
    const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const caja = CAJAS.includes(String(cuerpo.caja)) ? ` en ${cuerpo.caja}` : '';
    const quien = (await leerUsuario(env, correo))?.nombre || correo;
    const aviso = `${quien} pide ayuda${caja}.`;
    const push = await pushADuenos(env, 'Ayuda en caja', aviso);
    // ponytail: sin dispositivo que lo reciba, el correo de siempre.
    if (!push) await correoADuenos(env, 'Ayuda en caja', aviso);
    return json({ ok: true, push });
  }
  if (pathname === '/api/push/clave' && request.method === 'GET') {
    if (!env.VAPID_JWK) return json({ error: 'Falta el secreto VAPID_JWK.' }, 503);
    return json({ clave: clavePublica(JSON.parse(env.VAPID_JWK)) });
  }
  if (pathname === '/api/push/suscripcion' && request.method === 'POST') {
    if (!env.VAPID_JWK) return json({ error: 'Falta el secreto VAPID_JWK.' }, 503);
    const cuerpo = (await request.json().catch(() => ({}))) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    const s = { endpoint: String(cuerpo.endpoint ?? ''), p256dh: String(cuerpo.keys?.p256dh ?? ''), auth: String(cuerpo.keys?.auth ?? '') };
    let valida = false;
    try { valida = new URL(s.endpoint).protocol === 'https:' && deB64url(s.p256dh).length === 65 && deB64url(s.auth).length === 16; } catch { /* no es base64url */ }
    if (!valida) return json({ error: 'Suscripción inválida.' }, 400);
    await env.DB.prepare(
      `insert into push_suscripciones (endpoint, correo, p256dh, auth, creado_en) values (?, ?, ?, ?, ?)
       on conflict(endpoint) do update set correo = excluded.correo, p256dh = excluded.p256dh, auth = excluded.auth`,
    ).bind(s.endpoint, correo, s.p256dh, s.auth, new Date().toISOString()).run();
    // La prueba llega solo a este dispositivo: así se sabe que este quedó bien.
    const prueba = await enviar(env, JSON.parse(env.VAPID_JWK), s, 'El Dolarón', 'Notificaciones activadas.');
    return json({ ok: true, prueba });
  }
  return null;
}
