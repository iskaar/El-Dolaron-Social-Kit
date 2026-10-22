import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { permiso, puede, type Rol } from './cuentas.ts';
import { CONSULTA_BUZON } from './camara-remota.ts';
import { SIN_CODIGO } from '../public/upc.js';

const RUTA = '/api/camara/solicitud';
const telefono = crypto.randomUUID();
const solicitud = (datos = {}) => ({ id: crypto.randomUUID(), tipo: 'foto_pieza', pieza_id: PRODUCTO, ...datos });
const post = (id: string, accion: string) => `${RUTA}/${id}/${accion}`;

test('pendiente → tomada → lista: subida existente solo_foto conserva stock y talla; reintentos idénticos', async (t) => {
  const { db, env, pedir, ctx } = tienda(); t.after(() => db.close());
  db.prepare("update productos set talla = 'M', estado_fisico = 'danado' where id = ?").run(PRODUCTO);
  const datos = solicitud({ titulo: '<no confiar>' });
  const creada = await pedir(RUTA, datos, 'PUT');
  assert.equal(creada.status, 200); assert.equal(creada.cuerpo.solicitud.estado, 'pendiente');
  assert.equal(creada.cuerpo.solicitud.titulo, 'Ventilador · ED-000001');
  assert.equal(Date.parse(creada.cuerpo.solicitud.vence_en) - Date.parse(creada.cuerpo.solicitud.creado_en), 120_000);
  const repetir = () => pedir(RUTA, { ...datos, params: { cantidad: 99 } }, 'PUT');
  assert.deepEqual((await repetir()).cuerpo.solicitud, creada.cuerpo.solicitud);
  const tomada = await pedir(post(datos.id, 'tomar'), { telefono });
  assert.equal(tomada.cuerpo.solicitud.estado, 'tomada');
  assert.deepEqual((await pedir(post(datos.id, 'tomar'), { telefono })).cuerpo.solicitud, tomada.cuerpo.solicitud);
  assert.deepEqual((await repetir()).cuerpo.solicitud, tomada.cuerpo.solicitud);
  const ausente = await pedir(post(datos.id, 'lista'), { telefono });
  assert.equal(ausente.status, 409); assert.equal(ausente.cuerpo.error, 'La foto no llegó.');
  const form = new FormData();
  form.set('id', PRODUCTO); form.set('estado_fisico', 'nuevo'); form.set('solo_foto', '1');
  form.set('foto', new File(['foto real de prueba'], 'foto.jpg', { type: 'image/jpeg' }));
  const subida = await worker.fetch(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: form }), env, ctx as never);
  assert.equal(subida.status, 200);
  const pieza = db.prepare('select stock, talla, estado_fisico, foto_key from productos where id = ?').get(PRODUCTO)!;
  assert.equal(pieza.stock, 50); assert.equal(pieza.talla, 'M'); assert.equal(pieza.estado_fisico, 'danado');
  assert.ok(pieza.foto_key); assert.ok(await env.FOTOS.get(String(pieza.foto_key)));
  const lista = await pedir(post(datos.id, 'lista'), { telefono });
  assert.equal(lista.status, 200); assert.equal(lista.cuerpo.solicitud.estado, 'lista');
  assert.deepEqual((await pedir(post(datos.id, 'lista'), { telefono })).cuerpo.solicitud, lista.cuerpo.solicitud);
  assert.deepEqual((await repetir()).cuerpo.solicitud, lista.cuerpo.solicitud);
  assert.equal((await pedir(post(datos.id, 'cancelar'), {})).cuerpo.solicitud.estado, 'lista');
  assert.equal(db.prepare('select count(*) as n from camara_remota').get()!.n, 1);
});

test('vencida derivada, cancelación idempotente y reemplazo del buzón', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const a = solicitud(), b = solicitud();
  await pedir(RUTA, a, 'PUT');
  assert.equal((await pedir(RUTA, b, 'PUT')).cuerpo.solicitud.id, b.id);
  assert.equal((await pedir(post(a.id, 'tomar'), { telefono })).status, 404);
  db.exec("update camara_remota set vence_en = '2000-01-01T00:00:00.000Z'");
  assert.equal((await pedir(RUTA)).cuerpo.solicitud.estado, 'vencida');
  assert.equal(db.prepare('select estado from camara_remota').get()!.estado, 'pendiente');
  assert.equal((await pedir(post(b.id, 'tomar'), { telefono })).status, 410);
  const cancelada = await pedir(post(b.id, 'cancelar'), { motivo: 'No puedo' });
  assert.equal(cancelada.cuerpo.solicitud.estado, 'cancelada');
  assert.deepEqual((await pedir(post(b.id, 'cancelar'), { motivo: 'Otro motivo' })).cuerpo.solicitud, cancelada.cuerpo.solicitud);
  assert.deepEqual((await pedir(RUTA, b, 'PUT')).cuerpo.solicitud, cancelada.cuerpo.solicitud);
  assert.equal((await pedir(post(b.id, 'lista'), { telefono })).status, 409);
  await pedir(RUTA, a, 'PUT'); await pedir(post(a.id, 'tomar'), { telefono });
  assert.equal((await pedir(RUTA, b, 'PUT')).status, 409);
  db.exec("update camara_remota set vence_en = '2000-01-01T00:00:00.000Z'");
  assert.equal((await pedir(post(a.id, 'tomar'), { telefono })).status, 410);
  assert.equal((await pedir(RUTA, b, 'PUT')).status, 200);
  await pedir(post(b.id, 'tomar'), { telefono });
  await pedir(post(b.id, 'cancelar'), { motivo: 'La PC la canceló' });
  assert.equal((await pedir(post(b.id, 'tomar'), { telefono })).status, 409);
});

test('dos celulares compiten: un ganador, otro 409; lista tardía acepta efecto real', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const s = solicitud(); await pedir(RUTA, s, 'PUT');
  const telefonos = [crypto.randomUUID(), crypto.randomUUID()];
  const respuestas = await Promise.all(telefonos.map((telefono) => pedir(post(s.id, 'tomar'), { telefono })));
  assert.deepEqual(respuestas.map((r) => r.status).sort(), [200, 409]);
  const ganador = telefonos[respuestas.findIndex((r) => r.status === 200)];
  const perdedor = telefonos[respuestas.findIndex((r) => r.status === 409)];
  assert.equal((await pedir(post(s.id, 'lista'), { telefono: perdedor })).status, 409);
  db.exec("update camara_remota set vence_en = '2000-01-01T00:00:00.000Z'");
  db.prepare("update productos set foto_key = 'fotos/prueba.jpg', actualizado_en = '2999-01-01T00:00:00.000Z' where id = ?").run(PRODUCTO);
  assert.equal((await pedir(post(s.id, 'lista'), { telefono: ganador })).cuerpo.solicitud.estado, 'lista');
});

test('foto anterior no basta; pieza desaparecida/descartada cancela con motivo', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  db.prepare("update productos set foto_key = 'vieja', actualizado_en = '2000-01-01T00:00:00.000Z' where id = ?").run(PRODUCTO);
  const s = solicitud(); await pedir(RUTA, s, 'PUT'); await pedir(post(s.id, 'tomar'), { telefono });
  assert.equal((await pedir(post(s.id, 'lista'), { telefono })).status, 409);
  db.prepare("update productos set estado_analisis = 'descartado' where id = ?").run(PRODUCTO);
  assert.equal((await pedir(post(s.id, 'lista'), { telefono })).status, 409);
  const r = await pedir(RUTA);
  assert.equal(r.cuerpo.solicitud.estado, 'cancelada'); assert.match(r.cuerpo.solicitud.motivo, /pieza/);
});

test('tomar no entrega la solicitud si la pieza ya no existe (solo_foto crearía otra)', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const s = solicitud(); await pedir(RUTA, s, 'PUT');
  db.prepare("update productos set estado_analisis = 'descartado' where id = ?").run(PRODUCTO);
  assert.equal((await pedir(post(s.id, 'tomar'), { telefono })).status, 409);
  const r = await pedir(RUTA); assert.equal(r.cuerpo.solicitud.estado, 'cancelada'); assert.match(r.cuerpo.solicitud.motivo, /pieza/);
});

test('pieza_nueva exige foto y capturado_por del buzón', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const s = solicitud({ tipo: 'pieza_nueva', pieza_id: crypto.randomUUID(), params: { upc: SIN_CODIGO, cantidad: 3 } });
  await pedir(RUTA, s, 'PUT'); await pedir(post(s.id, 'tomar'), { telefono });
  assert.equal((await pedir(post(s.id, 'lista'), { telefono })).status, 409);
  assert.equal((await pedir(RUTA)).cuerpo.solicitud.estado, 'tomada');
  db.prepare(`insert into productos (id, semana_ingreso, creado_en, actualizado_en, foto_key, capturado_por)
    values (?, 'S40', '', '2999-01-01T00:00:00.000Z', 'foto', 'otro@prueba.mx')`).run(s.pieza_id);
  assert.equal((await pedir(post(s.id, 'lista'), { telefono })).status, 409);
  db.prepare('update productos set capturado_por = ? where id = ?').run(DUENO, s.pieza_id);
  assert.equal((await pedir(post(s.id, 'lista'), { telefono })).status, 200);
});

test('valida UUID, params acotados y pieza existente del propietario antes de solo_foto', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  for (const cambio of [{ id: 'mal' }, { pieza_id: 'mal' }, { tipo: 'otra' }, { params: [] }, { params: { solo_foto: 1 } },
    { params: { cantidad: 0 } }, { params: { cantidad: 1000 } }, { params: { cantidad: 1.5 } }, { params: { cantidad: '2' } },
    { params: { upc: 'hola' } }, { params: { estado_fisico: 'otro' } }, { params: { marca: {} } }, { params: { precio_ropa: 2.5 } }]) {
    assert.equal((await pedir(RUTA, solicitud(cambio), 'PUT')).status, 400, JSON.stringify(cambio));
  }
  assert.equal((await pedir(RUTA, solicitud({ pieza_id: crypto.randomUUID() }), 'PUT')).status, 404);
  db.prepare("update productos set propietario = 'fep' where id = ?").run(PRODUCTO);
  assert.equal((await pedir(RUTA, solicitud(), 'PUT')).status, 404);
  db.prepare("update productos set propietario = 'dolaron', estado_analisis = 'descartado' where id = ?").run(PRODUCTO);
  assert.equal((await pedir(RUTA, solicitud(), 'PUT')).status, 404);
});

test('otro correo no ve, toma, cancela ni cierra la solicitud', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const s = solicitud(); await pedir(RUTA, s, 'PUT');
  db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('otro@prueba.mx', 'Otro', 'capturista', 1, '', '')").run();
  env.DEV_USUARIO = 'otro@prueba.mx';
  assert.equal((await pedir(RUTA)).cuerpo.solicitud, null);
  for (const accion of ['tomar', 'lista', 'cancelar']) assert.equal((await pedir(post(s.id, accion), { telefono })).status, 404);
  await pedir(RUTA, solicitud(), 'PUT');
  assert.equal(db.prepare('select count(*) as n from camara_remota').get()!.n, 2);
});

test('permisos por rol y host; API siempre no-store', async (t) => {
  const { db, env, pedir, ctx } = tienda(); t.after(() => db.close());
  const s = solicitud();
  db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('respaldo@prueba.mx', 'Dueño', 'dueno', 1, '', '')").run();
  const rutas = [[RUTA, 'GET'], [RUTA, 'PUT'], ...['tomar', 'lista', 'cancelar'].map((a) => [post(s.id, a), 'POST'])];
  for (const rol of ['dueno', 'capturista', 'finanzas', 'cajero', 'computadora', 'auxiliar'] as Rol[]) {
    db.prepare('update usuarios set roles = ? where correo = ?').run(rol, DUENO);
    const permitido = ['dueno', 'capturista'].includes(rol);
    assert.equal(puede({ correo: DUENO, roles: [rol], activo: true, nombre: '', caja: '' }, permiso('/camara-remota', 'GET')), permitido);
    for (const [ruta, metodo] of rutas) {
      const r = await pedir(ruta, metodo === 'GET' ? undefined : { ...s, telefono }, metodo);
      assert.equal(r.status === 403, !permitido, `${rol} ${metodo} ${ruta}`);
    }
  }
  db.prepare("update usuarios set roles = 'dueno' where correo = ?").run(DUENO);
  const r = await worker.fetch(new Request('https://caja.prueba' + RUTA), env, ctx as never);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  env.HOST_VENDEDOR = 'captura.viste.com.mx';
  for (const [ruta, metodo] of [...rutas, ['/captura-pc', 'GET'], ['/camara-remota', 'GET']]) {
    assert.equal(permitidaParaVendedor(ruta, metodo), !(metodo === 'PUT' || ruta === '/captura-pc'));
    if (metodo === 'PUT' || ruta === '/captura-pc') {
      const r = await worker.fetch(new Request('https://captura.viste.com.mx' + ruta, { method: metodo, ...(metodo === 'PUT' ? { body: JSON.stringify(s) } : {}) }), env, ctx as never);
      assert.equal(r.status, 404);
    }
  }
});

test('sondeo lee una fila por llave sin SCAN; schema + todas las migraciones sobre base vacía', async (t) => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const archivos = ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f)).sort()];
  for (const f of archivos) db.exec(readFileSync(f, 'utf8'));
  assert.equal(db.prepare('select count(*) as n from camara_remota').get()!.n, 0);
  const { env, pedir, db: tiendaDb } = tienda(); t.after(() => tiendaDb.close());
  await pedir(RUTA, solicitud(), 'PUT');
  const preparar = env.DB.prepare.bind(env.DB); const consultas: string[] = [];
  env.DB.prepare = (sql) => { consultas.push(sql); return preparar(sql); };
  assert.equal((await pedir(RUTA)).status, 200);
  assert.equal(consultas.filter((sql) => sql.includes('camara_remota')).length, 1);
  assert.equal(consultas.length, 2);
  assert.ok(consultas.includes(CONSULTA_BUZON));
  const plan = db.prepare('explain query plan ' + CONSULTA_BUZON).all(DUENO);
  assert.ok(!plan.some((p) => /SCAN/.test(String(p.detail))), JSON.stringify(plan));
  assert.match(String(plan[0].detail), /SEARCH.*correo/);
});
