// node --test src/correcciones-revision.test.ts
// Correcciones de la revisión de cuentas y Dolarones (7/10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';

const TIENDA = 'tienda@prueba.mx';
const ANA = 'ana@prueba.mx';

function montar() {
  const t = tienda();
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, caja, creado_en, actualizado_en) values
    ('${TIENDA}', 'Computadora', 'computadora', 1, '', '', ''),
    ('${ANA}', 'Ana', 'cajero', 1, 'Caja 2', '', '')`).run();
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  return { ...t, como };
}

test('PIN: una ráfaga en paralelo no prueba más de 5 PIN ni delata el correcto', async () => {
  const { pedir, como } = montar();
  await pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
  como(TIENDA);
  // 39 incorrectos y, al final, el correcto: todos salen antes de que el bloqueo exista.
  const pines = Array.from({ length: 39 }, (_, i) => String(100000 + i));
  const respuestas = await Promise.all([...pines, '482913'].map((pin) => pedir('/api/cajeros/entrar', { correo: ANA, pin })));
  const evaluados = respuestas.filter((r) => r.status === 403 || r.status === 201).length;
  assert.ok(evaluados <= 5, `se evaluaron ${evaluados} PIN en una sola ventana`);
  // Pasada la ráfaga, el correcto sigue bloqueado.
  assert.equal((await pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).status, 423);
});

test('sesión de caja: desactivar o quitar el rol a Ana la cierra para siempre, aunque la reactiven', async () => {
  const { pedir, como, db } = montar();
  const PRODUCTO = 'a1111111-1111-4111-8111-111111111111';
  const venta = (token: string) => pedir('/api/ventas', {
    id: crypto.randomUUID(), lineas: [{ producto_id: PRODUCTO, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 25000,
  }, 'POST', { 'x-cajero': token });
  await pedir('/api/cuentas/pin', { correo: ANA, pin: '482913' }, 'PUT');
  const entrar = async () => { como(TIENDA); const t = (await pedir('/api/cajeros/entrar', { correo: ANA, pin: '482913' })).cuerpo.token; return t as string; };

  let token = await entrar();
  como(DUENO);
  assert.equal((await pedir('/api/cuentas', { correo: ANA, nombre: 'Ana', roles: ['cajero'], activo: false }, 'PUT')).status, 200);
  assert.equal(db.prepare('select count(*) as n from sesiones_cajero where correo = ?').get(ANA)!.n, 0);
  await pedir('/api/cuentas', { correo: ANA, nombre: 'Ana', roles: ['cajero'], activo: true }, 'PUT');
  como(TIENDA);
  assert.equal((await venta(token)).status, 401, 'el token viejo no revive');

  token = await entrar();
  como(DUENO);
  await pedir('/api/cuentas', { correo: ANA, nombre: 'Ana', roles: ['capturista'] }, 'PUT');   // ya no cobra
  await pedir('/api/cuentas', { correo: ANA, nombre: 'Ana', roles: ['cajero'] }, 'PUT');
  como(TIENDA);
  assert.equal((await venta(token)).status, 401, 'quitar el rol tambien cierra la sesion');
});

test('aprobar una solicitud de acceso vieja no deja a la tienda sin dueño', async () => {
  const { pedir, db } = montar();
  // Solicitud que quedó pendiente de alguien que luego fue dado de alta como dueño por otra vía.
  db.prepare(`insert into solicitudes (id, tipo, correo, nombre, justificacion, creado_en) values ('s1', 'acceso', ?, 'Isaac', 'entrar', '')`).run(DUENO);
  const r = await pedir('/api/solicitudes/s1/resolver', { aprobar: true }, 'POST');
  assert.equal(r.status, 400);
  assert.equal(db.prepare('select roles from usuarios where correo = ?').get(DUENO)!.roles, 'dueno');
  assert.equal(db.prepare('select estado from solicitudes where id = ?').get('s1')!.estado, 'pendiente');

  // Una solicitud normal sigue aprobándose, con el rol por omisión.
  db.prepare(`insert into solicitudes (id, tipo, correo, nombre, justificacion, creado_en) values ('s2', 'acceso', 'nueva@prueba.mx', 'Nueva', 'entrar', '')`).run();
  assert.equal((await pedir('/api/solicitudes/s2/resolver', { aprobar: true }, 'POST')).status, 200);
  assert.equal(db.prepare('select roles from usuarios where correo = ?').get('nueva@prueba.mx')!.roles, 'cajero');
});

test('el host del vendedor sirve todo lo que importa la pantalla de captura', async () => {
  const { readFileSync } = await import('node:fs');
  const { permitidaParaVendedor } = await import('./worker.ts');
  const html = readFileSync('public/captura.html', 'utf8');
  const modulos = [...html.matchAll(/from '(\/[^']+\.js)'/g)].map((m) => m[1]);
  assert.ok(modulos.includes('/foto.js') && modulos.includes('/tallas.js'));
  for (const ruta of modulos) assert.equal(permitidaParaVendedor(ruta, 'GET'), true, `${ruta} da 404 en captura.viste.com.mx`);
});

test('un cuerpo JSON "null" es un 400, no un 500, en entrar, cuentas y vales', async () => {
  const { pedir, como } = montar();
  for (const [ruta, metodo] of [['/api/cuentas/pin', 'PUT'], ['/api/cuentas', 'PUT'], ['/api/solicitudes/x/resolver', 'POST'],
    ['/api/vales/buscar', 'POST'], ['/api/socios', 'POST']] as const) {
    const r = await pedir(ruta, null, metodo);
    assert.ok(r.status >= 400 && r.status < 500, `${metodo} ${ruta} -> ${r.status}`);
  }
  como(TIENDA);
  assert.equal((await pedir('/api/cajeros/entrar', null)).status, 400);
  como(ANA);
  assert.equal((await pedir('/api/solicitudes/acceso', null)).status, 409);   // ya tiene cuenta
});
