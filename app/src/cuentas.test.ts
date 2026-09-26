// node --test src/cuentas.test.ts
// Quien entra y a que. El JWT se firma aqui con una llave generada en la prueba:
// lo que se prueba es que solo pase uno firmado, vigente, para esta aplicacion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { permiso, puede, verificarJwt, leerRoles, type Usuario } from './cuentas.ts';

const usuario = (roles: Usuario['roles'], activo = true): Usuario => ({ correo: 'a@b.mx', nombre: 'A', roles, activo });

test('cada rol entra a lo suyo y el dueno a todo', () => {
  const cajero = usuario(['cajero']);
  const capturista = usuario(['capturista']);
  const dueno = usuario(['dueno']);
  const ambos = usuario(['cajero', 'capturista']);

  assert.equal(puede(cajero, permiso('/caja', 'GET')), true);
  assert.equal(puede(cajero, permiso('/api/ventas', 'POST')), true);
  assert.equal(puede(cajero, permiso('/admin', 'GET')), false);
  assert.equal(puede(cajero, permiso('/api/borradores', 'GET')), false);

  assert.equal(puede(capturista, permiso('/captura', 'GET')), true);
  assert.equal(puede(capturista, permiso('/admin.html', 'GET')), true);
  assert.equal(puede(capturista, permiso('/api/borradores/x', 'PATCH')), true);
  assert.equal(puede(capturista, permiso('/api/config', 'GET')), true);
  assert.equal(puede(capturista, permiso('/api/config', 'PUT')), false);
  assert.equal(puede(capturista, permiso('/caja', 'GET')), false);

  for (const ruta of ['/reportes', '/cuentas', '/api/reportes', '/api/cuentas', '/api/solicitudes/x/resolver']) {
    assert.equal(puede(cajero, permiso(ruta, 'GET')), false, ruta);
    assert.equal(puede(capturista, permiso(ruta, 'GET')), false, ruta);
    assert.equal(puede(dueno, permiso(ruta, 'GET')), true, ruta);
  }
  assert.equal(puede(ambos, permiso('/caja', 'GET')) && puede(ambos, permiso('/captura', 'GET')), true);
});

test('una pantalla o API que nadie listo es solo del dueno', () => {
  assert.deepEqual(permiso('/pantalla-nueva', 'GET'), []);
  assert.deepEqual(permiso('/api/algo-nuevo', 'POST'), []);
  assert.equal(puede(usuario(['cajero', 'capturista']), permiso('/pantalla-nueva', 'GET')), false);
});

test('sin cuenta activa solo se ve lo de pedir acceso', () => {
  assert.equal(permiso('/sin-acceso', 'GET'), 'cuenta');
  assert.equal(permiso('/api/yo', 'GET'), 'cuenta');
  assert.equal(permiso('/api/solicitudes/acceso', 'POST'), 'cuenta');
  assert.equal(permiso('/api/salud', 'GET'), 'libre');
  assert.equal(puede(null, permiso('/', 'GET')), false);
  assert.equal(puede(usuario(['dueno'], false), permiso('/caja', 'GET')), false);   // desactivado
  // Un .js dentro de /api no se cuela como archivo de pantalla.
  assert.deepEqual(permiso('/api/reportes.js', 'GET'), []);
});

test('los roles guardados se leen sin dejar pasar uno inventado', () => {
  assert.deepEqual(leerRoles('dueno, cajero,admin,'), ['dueno', 'cajero']);
});

/* ---------- JWT ---------- */

const b64url = (datos: Uint8Array | string) =>
  Buffer.from(datos).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const par = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
) as CryptoKeyPair;
const otro = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
) as CryptoKeyPair;

const AUD = 'aud-escaner';
const EMISOR = 'https://equipo.cloudflareaccess.com';
const AHORA = 1_790_000_000;
const llave = async (kid: string) => (kid === 'k1' ? par.publicKey : undefined);

async function firmar(carga: Record<string, unknown>, privada = par.privateKey, kid = 'k1', alg = 'RS256') {
  const cabeza = `${b64url(JSON.stringify({ alg, kid }))}.${b64url(JSON.stringify(carga))}`;
  const firma = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privada, new TextEncoder().encode(cabeza)));
  return `${cabeza}.${b64url(firma)}`;
}

const BUENA = { aud: [AUD], iss: EMISOR, exp: AHORA + 600, nbf: AHORA - 10, email: 'Cajera@Gmail.com' };

test('un JWT de Access valido da el correo, en minusculas', async () => {
  assert.equal(await verificarJwt(await firmar(BUENA), AUD, EMISOR, llave, AHORA), 'cajera@gmail.com');
});

test('se rechaza el JWT de otra aplicacion, otro equipo, vencido, sin correo o mal firmado', async () => {
  const casos: [string, string][] = [
    ['otra aplicacion', await firmar({ ...BUENA, aud: ['aud-captura'] })],
    ['otro equipo', await firmar({ ...BUENA, iss: 'https://otro.cloudflareaccess.com' })],
    ['vencido', await firmar({ ...BUENA, exp: AHORA - 1 })],
    ['sin correo', await firmar({ ...BUENA, email: '' })],
    ['firmado con otra llave', await firmar(BUENA, otro.privateKey)],
    ['kid desconocido', await firmar(BUENA, par.privateKey, 'k2')],
    ['algoritmo none', await firmar(BUENA, par.privateKey, 'k1', 'none')],
    ['basura', 'no.es.jwt'],
  ];
  for (const [nombre, token] of casos) {
    assert.equal(await verificarJwt(token, AUD, EMISOR, llave, AHORA), null, nombre);
  }
  // Cambiar el correo despues de firmar rompe la firma.
  const [cabeza, , firma] = (await firmar(BUENA)).split('.');
  const alterado = `${cabeza}.${b64url(JSON.stringify({ ...BUENA, email: 'dueno@gmail.com' }))}.${firma}`;
  assert.equal(await verificarJwt(alterado, AUD, EMISOR, llave, AHORA), null);
});
