import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { permiso, puede, type Rol } from './cuentas.ts';
import { LIMITE_ESTADO, CONSULTA_ESPEJO } from './espejo-captura.ts';

const RUTA = '/api/captura/espejo';
const pc = crypto.randomUUID(), celular = crypto.randomUUID();
const tarjeta = { tipo: 'nueva', id: crypto.randomUUID(), upc: '012345678905', cantidad: 2 };
const poner = (version_esperada: number, estado: unknown, dispositivo = pc) => ({ version_esperada, estado, dispositivo });

test('sin fila: version 0; PUT escribe, sube la versión y GET lo devuelve', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const vacio = await pedir(RUTA);
  assert.equal(vacio.status, 200); assert.equal(vacio.cuerpo.version, 0); assert.deepEqual(vacio.cuerpo.estado, {});
  const uno = await pedir(RUTA, poner(0, tarjeta), 'PUT');
  assert.equal(uno.status, 200); assert.equal(uno.cuerpo.version, 1); assert.equal(uno.cuerpo.dispositivo, pc);
  const dos = await pedir(RUTA, poner(1, { ...tarjeta, cantidad: 3 }, celular), 'PUT');
  assert.equal(dos.cuerpo.version, 2);
  const leida = await pedir(RUTA);
  assert.equal(leida.cuerpo.version, 2); assert.equal(leida.cuerpo.dispositivo, celular); assert.equal(leida.cuerpo.estado.cantidad, 3);
  assert.ok(leida.cuerpo.actualizado_en);
  assert.equal(db.prepare('select count(*) as n from espejo_captura').get()!.n, 1);
});

test('versión vieja → 409 con la vigente y sin cambiar nada', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  await pedir(RUTA, poner(0, tarjeta), 'PUT');
  await pedir(RUTA, poner(1, { ...tarjeta, cantidad: 5 }, celular), 'PUT');
  const vieja = await pedir(RUTA, poner(1, { ...tarjeta, cantidad: 9 }), 'PUT');
  assert.equal(vieja.status, 409);
  assert.equal(vieja.cuerpo.vigente.version, 2); assert.equal(vieja.cuerpo.vigente.estado.cantidad, 5); assert.equal(vieja.cuerpo.vigente.dispositivo, celular);
  const nueva = await pedir(RUTA, poner(0, tarjeta), 'PUT');   // «primera vez» tampoco pisa una fila que ya existe
  assert.equal(nueva.status, 409);
  assert.equal(db.prepare('select version from espejo_captura').get()!.version, 2);
});

test('dos aparatos con la misma versión: uno gana y el otro recibe 409', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  await pedir(RUTA, poner(0, tarjeta), 'PUT');
  const r = await Promise.all([pedir(RUTA, poner(1, { a: 1 }, pc), 'PUT'), pedir(RUTA, poner(1, { b: 1 }, celular), 'PUT')]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  assert.equal(db.prepare('select version from espejo_captura').get()!.version, 2);
});

test('reintento de la propia escritura perdida: 409 cuya vigente es la mía', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  await pedir(RUTA, poner(0, tarjeta), 'PUT');
  const otra = await pedir(RUTA, poner(0, tarjeta), 'PUT');
  assert.equal(otra.status, 409); assert.equal(otra.cuerpo.vigente.dispositivo, pc); assert.equal(otra.cuerpo.vigente.version, 1);
});

test('estado inválido, enorme o dispositivo sin UUID → 400 y nada se guarda', async (t) => {
  const { db, env, ctx, pedir } = tienda(); t.after(() => db.close());
  for (const cuerpo of [poner(0, null), poner(0, 'texto'), poner(0, [1]), poner(0, 5), poner(-1, {}), poner(1.5, {}), { ...poner(0, {}), version_esperada: '0' },
    poner(0, {}, 'no-uuid'), { version_esperada: 0, estado: {} }]) {
    assert.equal((await pedir(RUTA, cuerpo, 'PUT')).status, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await pedir(RUTA, poner(0, { x: 'a'.repeat(LIMITE_ESTADO) }), 'PUT')).status, 400);
  assert.equal(db.prepare('select count(*) as n from espejo_captura').get()!.n, 0);
  assert.equal((await pedir(RUTA, poner(0, { x: 'a'.repeat(LIMITE_ESTADO - 100) }), 'PUT')).status, 200);
  const raro = await worker.fetch(new Request('https://caja.prueba' + RUTA, { method: 'PUT', body: '{no es json' }), env, ctx as never);
  assert.equal(raro.status, 400);
});

test('cada cuenta tiene su espejo: otro correo no ve ni escribe el de Isaac', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  await pedir(RUTA, poner(0, tarjeta), 'PUT');
  db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('otro@prueba.mx', 'Otro', 'capturista', 1, '', '')").run();
  env.DEV_USUARIO = 'otro@prueba.mx';
  const suyo = await pedir(RUTA);
  assert.equal(suyo.cuerpo.version, 0); assert.deepEqual(suyo.cuerpo.estado, {});
  assert.equal((await pedir(RUTA, poner(1, { robo: true }, celular), 'PUT')).status, 409);   // la versión 1 es de Isaac: la suya es 0
  assert.equal((await pedir(RUTA, poner(0, { mio: true }, celular), 'PUT')).status, 200);
  env.DEV_USUARIO = DUENO;
  assert.deepEqual((await pedir(RUTA)).cuerpo.estado, tarjeta);
  assert.equal(db.prepare('select count(*) as n from espejo_captura').get()!.n, 2);
});

test('permisos por rol; API siempre no-store', async (t) => {
  const { db, env, pedir, ctx } = tienda(); t.after(() => db.close());
  db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('respaldo@prueba.mx', 'Dueño', 'dueno', 1, '', '')").run();
  for (const rol of ['dueno', 'capturista', 'finanzas', 'cajero', 'computadora', 'auxiliar'] as Rol[]) {
    db.prepare('update usuarios set roles = ? where correo = ?').run(rol, DUENO);
    const permitido = ['dueno', 'capturista', 'finanzas'].includes(rol);
    const usuario = { correo: DUENO, roles: [rol], activo: true, nombre: '', caja: '' };
    assert.equal(puede(usuario, permiso(RUTA, 'GET')), permitido, rol);
    assert.equal((await pedir(RUTA)).status === 403, !permitido, `GET ${rol}`);
    assert.equal((await pedir(RUTA, poner(0, {}), 'PUT')).status === 403, !permitido, `PUT ${rol}`);
    db.exec('delete from espejo_captura');
  }
  db.prepare("update usuarios set roles = 'dueno' where correo = ?").run(DUENO);
  const r = await worker.fetch(new Request('https://caja.prueba' + RUTA), env, ctx as never);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('host del celular (captura.viste.com.mx): GET y PUT del espejo y su script; nada más de esta ruta', async (t) => {
  const { db, env, ctx } = tienda(); t.after(() => db.close());
  env.HOST_VENDEDOR = 'captura.viste.com.mx';
  assert.equal(permitidaParaVendedor(RUTA, 'GET'), true); assert.equal(permitidaParaVendedor(RUTA, 'PUT'), true);
  assert.equal(permitidaParaVendedor(RUTA, 'DELETE'), false); assert.equal(permitidaParaVendedor('/espejo-captura.js', 'GET'), true);
  const desde = (host: string, metodo: string, cuerpo?: unknown) => worker.fetch(new Request(`https://${host}${RUTA}`,
    { method: metodo, ...(cuerpo ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) } : {}) }), env, ctx as never);
  assert.equal((await desde('caja.prueba', 'PUT', poner(0, tarjeta))).status, 200);   // la PC escribe...
  const leido = await desde('captura.viste.com.mx', 'GET');                              // ...y el celular lo ve
  assert.equal(leido.status, 200); assert.deepEqual(((await leido.json()) as any).estado, tarjeta);
  const escrito = await desde('captura.viste.com.mx', 'PUT', poner(1, { ...tarjeta, cantidad: 4 }, celular));
  assert.equal(escrito.status, 200); assert.equal(((await escrito.json()) as any).version, 2);
  assert.equal((await desde('captura.viste.com.mx', 'DELETE')).status, 404);
});

test('una lectura por llave sin SCAN', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  await pedir(RUTA, poner(0, tarjeta), 'PUT');
  const plan = db.prepare('explain query plan ' + CONSULTA_ESPEJO).all(DUENO);
  assert.ok(!plan.some((p) => /SCAN/.test(String(p.detail))), JSON.stringify(plan));
});
