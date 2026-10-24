// node --test src/cuentas.test.ts
// Quien entra y a que. El JWT se firma aqui con una llave generada en la prueba:
// lo que se prueba es que solo pase uno firmado, vigente, para esta aplicacion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { permiso, puede, verificarJwt, leerRoles, leerUsuario, puedeEditarInventario, type Usuario } from './cuentas.ts';
import { tienda, DUENO } from './prueba-d1.ts';

const usuario = (roles: Usuario['roles'], activo = true): Usuario => ({ correo: 'a@b.mx', nombre: 'A', roles, activo, caja:'', editar_inventario:false });

test('cada rol entra a lo suyo y el dueno a todo', () => {
  const cajero = usuario(['cajero']);
  const capturista = usuario(['capturista']);
  const dueno = usuario(['dueno']);
  const ambos = usuario(['cajero', 'capturista']);

  assert.equal(puede(cajero, permiso('/caja', 'GET')), true);
  assert.equal(puede(cajero, permiso('/api/ventas', 'POST')), true);
  assert.equal(puede(cajero, permiso('/admin', 'GET')), false);
  assert.equal(puede(cajero, permiso('/api/borradores', 'GET')), false);
  assert.equal(puede(cajero, permiso('/api/foto/x', 'GET')), true);   // miniatura en la caja (#358)

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
  assert.deepEqual(permiso('/api/ropa-ia', 'GET'), ['capturista']);
  assert.deepEqual(permiso('/api/ropa-ia/abc/aceptar', 'POST'), ['capturista']);
  assert.deepEqual(permiso('/api/recortes', 'GET'), ['capturista']);
  assert.deepEqual(permiso('/api/recortes/abc/original', 'POST'), ['capturista']);
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

test('dos dueños quitandose el rol a la vez: uno pasa y el otro no; nunca queda la tienda sin dueño (Issue #253)', async () => {
  const { db, env, pedir } = tienda();
  const OTRO = 'otro@prueba.mx';
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, 'Otro', 'dueno', 1, '', '')`).run(OTRO);
  const duenos = () => (db.prepare(`select count(*) n from usuarios where activo = 1 and roles like '%dueno%'`).get() as { n: number }).n;
  const quitar = (correo: string, extra = {}) => pedir('/api/cuentas', { correo, nombre: 'X', roles: ['cajero'], ...extra }, 'PUT');

  const estados = (await Promise.all([quitar(DUENO), quitar(OTRO)])).map((r) => r.status).sort();
  assert.deepEqual(estados, [200, 400]);
  assert.equal(duenos(), 1);
  const queda = (db.prepare(`select correo from usuarios where roles like '%dueno%'`).get() as { correo: string }).correo;
  (env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = queda;
  assert.equal((await pedir('/api/cuentas', { correo: queda, nombre: 'X', roles: ['dueno'], activo: false }, 'PUT')).status, 400);

  // Aprobar una solicitud que le quitaria el rol al ultimo: 400 y la solicitud sigue pendiente (todo el batch se deshace).
  db.prepare(`insert into solicitudes (id, tipo, correo, nombre, justificacion, creado_en) values ('s1', 'acceso', ?, 'X', '', '')`).run(queda);
  assert.equal((await pedir('/api/solicitudes/s1/resolver', { aprobar: true, roles: ['cajero'] })).status, 400);
  assert.equal((db.prepare(`select estado from solicitudes where id = 's1'`).get() as { estado: string }).estado, 'pendiente');
  assert.equal(duenos(), 1);
});

test('Editar inventario: solo dueño lo guarda; se lee en cuentas y yo; cliente anterior conserva la casilla', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const cuenta = { correo:'cap@prueba.mx', nombre:'Captura', roles:['capturista'] };
  const guardar = (extra = {}) => pedir('/api/cuentas', { ...cuenta, ...extra }, 'PUT');
  assert.equal((await guardar()).cuerpo.editar_inventario, false);
  assert.equal((await guardar({ editar_inventario:true })).cuerpo.editar_inventario, true);
  assert.equal((await guardar({ nombre:'Nuevo nombre' })).cuerpo.editar_inventario, true);
  assert.equal((await leerUsuario(env, cuenta.correo))!.editar_inventario, true);
  const lista = await pedir('/api/cuentas');
  assert.equal(lista.cuerpo.usuarios.find((u: any) => u.correo === cuenta.correo).editar_inventario, true);
  for (const crudo of [1, 'true', null]) assert.equal((await guardar({ editar_inventario:crudo })).status, 400);
  env.DEV_USUARIO = cuenta.correo;
  assert.equal((await pedir('/api/yo')).cuerpo.usuario.editar_inventario, true);
  assert.equal((await guardar({ editar_inventario:false })).status, 403);
  env.DEV_USUARIO = DUENO;
  assert.equal((await guardar({ editar_inventario:false })).cuerpo.editar_inventario, false);
  assert.equal((await leerUsuario(env, cuenta.correo))!.editar_inventario, false);
  for (const rol of ['dueno','capturista','finanzas','cajero','computadora','auxiliar'] as const) {
    const u = usuario([rol]);
    assert.equal(puedeEditarInventario(u), rol === 'dueno');
    u.editar_inventario = true;
    assert.equal(puedeEditarInventario(u), ['dueno','capturista','finanzas'].includes(rol));
    assert.equal(puede(u, permiso('/api/piezas/uuid/existencia', 'POST')), ['dueno','capturista','finanzas'].includes(rol));
    u.activo = false; assert.equal(puedeEditarInventario(u), false);
  }
  const html = readFileSync('public/cuentas.html', 'utf8');
  assert.match(html, /data-campo="editar_inventario".*Editar inventario/);
  assert.match(html, /editar_inventario: nodo.querySelector\('\[data-campo="editar_inventario"\]'\).checked/);
});

test('schema + todas las migraciones en prueba-d1 deja el permiso completo y cerrado por omisión', (t) => {
  const { db } = tienda(); t.after(() => db.close());
  const columna = db.prepare('pragma table_info(usuarios)').all().find((c) => c.name === 'editar_inventario')!;
  assert.equal(columna.notnull, 1); assert.equal(columna.dflt_value, '0');
  assert.equal(db.prepare('select editar_inventario from usuarios where correo = ?').get(DUENO)!.editar_inventario, 0);
  assert.throws(() => db.exec('update usuarios set editar_inventario = 2'), /CHECK/);
  assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
});

test('050 sobre la base anterior conserva usuarios, stock e historial y no reconstruye tablas', (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('pragma foreign_keys = on');
  for (const f of ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f) && !f.startsWith('migracion-050-')).sort()])
    db.exec(readFileSync(f, 'utf8'));
  db.exec(`insert into usuarios (correo,nombre,roles,activo,caja,pin_hash,creado_en,actualizado_en)
    values ('cap@prueba.mx','Captura','capturista',1,'Caja 2','hash sintético','','');
    insert into productos (id,nombre,stock,semana_ingreso,creado_en,actualizado_en) values ('pieza','Pieza',8,'S40','','');
    insert into conteo_ajustes (id,producto_id,motivo,cantidad,antes,despues,ajustado_por,ajustado_en)
    values ('rastro','pieza','robo',1,9,8,'cap@prueba.mx','');`);
  const usuarios = db.prepare('select * from usuarios').all(), productos = db.prepare('select * from productos').all(), rastros = db.prepare('select * from conteo_ajustes').all();
  const sql = readFileSync('migracion-050-editar-inventario.sql', 'utf8');
  assert.doesNotMatch(sql, /\b(drop|rename|delete|writable_schema)\b/i);
  assert.ok(sql.split('\n').every((linea) => /^\s*--/.test(linea) || !linea.includes('--')));
  db.exec(sql);
  for (const u of db.prepare('select * from usuarios').all()) {
    const { editar_inventario, ...anterior } = u;
    assert.equal(editar_inventario, 0); assert.deepEqual(anterior, { ...usuarios[0] });
  }
  assert.deepEqual(db.prepare('select * from productos').all(), productos);
  assert.deepEqual(db.prepare('select * from conteo_ajustes').all(), rastros);
  for (const motivo of ['entrada', 'correccion']) db.prepare(`insert into conteo_ajustes
    (id,producto_id,motivo,cantidad,antes,despues,ajustado_por,ajustado_en) values (?,'pieza',?,1,8,9,'prueba','')`).run(motivo, motivo);
  assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
});
