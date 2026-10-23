// node --test src/solicitudes-precio.test.ts
// #451: el capturista pide cambio de precio, el dueño aplica o rechaza. El servidor autoriza cada paso.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import { permitidaParaVendedor } from './worker.ts';

type Tienda = ReturnType<typeof tienda>;
const CAP = 'cap@prueba.mx', CAJERO = 'cajero@prueba.mx', FEP = 'fep@prueba.mx', OTRO_DUENO = 'dueno2@prueba.mx';
const ruta = (id = PRODUCTO) => `/api/piezas/${id}/solicitud-precio`;
const como = (t: Tienda, correo: string) => { t.env.DEV_USUARIO = correo; };
function equipo(t: Tienda) {
  for (const [correo, roles] of [[CAP, 'capturista'], [CAJERO, 'cajero'], [FEP, 'finanzas'], [OTRO_DUENO, 'dueno']])
    t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')").run(correo, correo, roles);
  t.db.prepare("update productos set estado_analisis = 'listo', precio_lista = 40000, destino = 'etiqueta' where id = ?").run(PRODUCTO);
}
const pedir = (t: Tienda, cuerpo: Record<string, unknown> = {}, id = PRODUCTO) =>
  t.pedir(ruta(id), { id: crypto.randomUUID(), sentido: 'bajar', ...cuerpo });
const producto = (t: Tienda, id = PRODUCTO) => t.db.prepare('select precio, actualizado_en, precio_anterior from productos where id = ?').get(id) as any;
const solicitudes = (t: Tienda) => t.db.prepare('select * from solicitudes_precio order by pedido_en').all() as any[];

test('el capturista pide, el cajero y FEP no, y el dueño también puede', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t);
  como(t, CAJERO); assert.equal((await pedir(t)).status, 403);
  como(t, FEP); assert.equal((await pedir(t)).status, 403);
  como(t, CAP);
  const r = await pedir(t, { precio_sugerido: 20000, nota: '  Se ve   muy caro  ' });
  assert.equal(r.status, 201);
  assert.deepEqual({ ...r.cuerpo.solicitud }, { ...r.cuerpo.solicitud, producto_id: PRODUCTO, sentido: 'bajar', precio_actual: 25000,
    precio_sugerido: 20000, nota: 'Se ve muy caro', pedido_por: CAP, estado: 'pendiente', propietario: 'dolaron' });
  como(t, DUENO);
  assert.equal((await t.pedir(ruta(), { id: crypto.randomUUID(), sentido: 'subir' })).status, 409, 'ya hay una pendiente, también para el dueño');
});

test('la ficha trae la pendiente y null cuando no hay', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  assert.equal((await t.pedir(`/api/piezas/${PRODUCTO}`)).cuerpo.solicitud_precio, null);
  const { cuerpo } = await pedir(t, { sentido: 'subir', precio_sugerido: 30000 });
  const ficha = (await t.pedir(`/api/piezas/${PRODUCTO}`)).cuerpo;
  assert.equal(ficha.solicitud_precio.id, cuerpo.solicitud.id);
  assert.equal(ficha.solicitud_precio.sentido, 'subir');
});

test('valida sentido, sugerido coherente, nota y piezas que no admiten el pedido', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  for (const cuerpo of [{ sentido: 'igual' }, { sentido: 'subir', precio_sugerido: 25000 }, { sentido: 'subir', precio_sugerido: 20000 },
    { sentido: 'subir', precio_sugerido: 40001 /* pasa la lista de $400 */ }, { sentido: 'bajar', precio_sugerido: 25000 }, { sentido: 'bajar', precio_sugerido: 30000 },
    { sentido: 'bajar', precio_sugerido: 0 }, { sentido: 'bajar', precio_sugerido: -5 }, { sentido: 'bajar', precio_sugerido: 199.5 },
    { sentido: 'bajar', precio_sugerido: '200' }, { sentido: 'bajar', nota: 'x'.repeat(141) }, { sentido: 'bajar', nota: 7 }, { id: 'no-es-uuid' }])
    assert.equal((await pedir(t, cuerpo)).status, 400, JSON.stringify(cuerpo));
  assert.equal((await pedir(t, { sentido: 'bajar', precio_sugerido: 1, nota: 'x'.repeat(140) })).status, 201);
  assert.equal((await pedir(t, {}, crypto.randomUUID())).status, 404);
  const banda = crypto.randomUUID();
  t.db.prepare("insert into productos (id, codigo, nombre, precio, stock, destino, estado_analisis, semana_ingreso, creado_en, actualizado_en) values (?, 'ED-000002', 'Banda', 4900, 1, 'banda_g49', 'listo', 'S40', '', '')").run(banda);
  assert.equal((await pedir(t, {}, banda)).status, 400, 'una pieza de banda tiene el precio de su banda');
  const analizando = crypto.randomUUID();
  t.db.prepare("insert into productos (id, nombre, precio, stock, destino, estado_analisis, semana_ingreso, creado_en, actualizado_en) values (?, 'x', 0, 1, 'etiqueta', 'pendiente', 'S40', '', '')").run(analizando);
  assert.equal((await pedir(t, {}, analizando)).status, 400);
});

test('el mismo folio devuelve la misma solicitud; una segunda pendiente da 409 con la existente', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const id = crypto.randomUUID();
  const a = await t.pedir(ruta(), { id, sentido: 'bajar' }), b = await t.pedir(ruta(), { id, sentido: 'bajar' });
  assert.equal(a.status, 201); assert.equal(b.status, 200); assert.equal(b.cuerpo.solicitud.id, id);
  assert.equal(solicitudes(t).length, 1);
  const otra = await pedir(t, { sentido: 'subir' });
  assert.equal(otra.status, 409); assert.equal(otra.cuerpo.solicitud.id, id);
  como(t, OTRO_DUENO);
  assert.equal((await t.pedir(ruta(), { id, sentido: 'bajar' })).status, 409, 'el folio de otra persona no se reutiliza');
  assert.equal(solicitudes(t).length, 1);
});

test('solo el dueño lista y resuelve; el capturista recibe 403', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t, { precio_sugerido: 20000 });
  assert.equal((await t.pedir('/api/solicitudes-precio?estado=pendiente')).status, 403);
  for (const accion of [{ accion: 'aplicar', precio: 20000, precio_esperado: 25000 }, { accion: 'rechazar' }])
    assert.equal((await t.pedir(`/api/solicitudes-precio/${cuerpo.solicitud.id}`, accion)).status, 403);
  como(t, CAJERO);
  assert.equal((await t.pedir('/api/solicitudes-precio?estado=pendiente')).status, 403);
  assert.equal(producto(t).precio, 25000);
  assert.equal(solicitudes(t)[0].estado, 'pendiente');
});

test('el dueño lista con los datos de la pieza y el conteo', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  await pedir(t, { precio_sugerido: 20000, nota: 'Caro' });
  como(t, DUENO);
  const r = await t.pedir('/api/solicitudes-precio?estado=pendiente');
  assert.equal(r.status, 200); assert.equal(r.cuerpo.conteo, 1);
  const s = r.cuerpo.solicitudes[0];
  assert.deepEqual([s.codigo, s.nombre, s.precio, s.precio_lista, s.destino, s.precio_sugerido, s.nota, s.pedido_por, s.tiene_foto],
    ['ED-000001', 'Ventilador', 25000, 40000, 'etiqueta', 20000, 'Caro', CAP, 0]);
  assert.equal((await t.pedir('/api/solicitudes-precio?estado=aplicada')).status, 400);
});

test('aplicar cambia el precio por la lógica del PATCH y cierra la solicitud una sola vez', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t, { precio_sugerido: 20000 }); const id = cuerpo.solicitud.id;
  como(t, DUENO);
  const r = await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio: 20000, precio_esperado: 25000 });
  assert.equal(r.status, 200); assert.equal(r.cuerpo.precio, 20000); assert.equal(r.cuerpo.solicitud.estado, 'aplicada');
  assert.equal(r.cuerpo.solicitud.precio_nuevo, 20000); assert.equal(r.cuerpo.solicitud.resuelto_por, DUENO);
  assert.notEqual(producto(t).actualizado_en, '');
  assert.equal(producto(t).precio, 20000); assert.equal(producto(t).precio_anterior, 25000, 'el disparador de precio anterior sigue funcionando');
  // Un reintento (respuesta perdida) o un segundo clic no cambia nada más.
  const otra = await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio: 20000, precio_esperado: 25000 });
  assert.equal(otra.status, 409); assert.equal(otra.cuerpo.solicitud.estado, 'aplicada');
  assert.equal((await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'rechazar' })).status, 409);
  assert.equal(solicitudes(t)[0].estado, 'aplicada');
  // Resuelta, la pieza admite una solicitud nueva.
  como(t, CAP); assert.equal((await pedir(t, { sentido: 'subir' })).status, 201);
});

test('aplicar respeta las reglas del PATCH: no pasa del precio de lista y exige precio válido', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t, { sentido: 'subir' }); const id = cuerpo.solicitud.id; como(t, DUENO);
  const u = `/api/solicitudes-precio/${id}`;
  assert.equal((await t.pedir(u, { accion: 'aplicar', precio: 40001, precio_esperado: 25000 })).status, 400);
  for (const mala of [{ precio: 0, precio_esperado: 25000 }, { precio: -1, precio_esperado: 25000 }, { precio: 1.5, precio_esperado: 25000 },
    { precio: '300', precio_esperado: 25000 }, { precio: 20000 }, { precio: 20000, precio_esperado: '25000' }])
    assert.equal((await t.pedir(u, { accion: 'aplicar', ...mala })).status, 400, JSON.stringify(mala));
  assert.equal((await t.pedir(u, { accion: 'borrar' })).status, 400);
  assert.equal(producto(t).precio, 25000); assert.equal(solicitudes(t)[0].estado, 'pendiente', 'un intento fallido no cierra la solicitud');
  assert.equal((await t.pedir(u, { accion: 'aplicar', precio: 40000, precio_esperado: 25000 })).status, 200);
});

test('si el precio ya no es el esperado, 409 y no cambia nada', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t, { precio_sugerido: 20000 }); const id = cuerpo.solicitud.id; como(t, DUENO);
  t.db.prepare('update productos set precio = 30000 where id = ?').run(PRODUCTO);   // el dueño lo cambió desde «Editar»
  const r = await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio: 20000, precio_esperado: 25000 });
  assert.equal(r.status, 409); assert.equal(r.cuerpo.precio, 30000);
  assert.equal(producto(t).precio, 30000); assert.equal(solicitudes(t)[0].estado, 'pendiente');
  // El UI recarga y manda el precio que ve ahora.
  assert.equal((await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio: 20000, precio_esperado: 30000 })).status, 200);
  assert.equal(producto(t).precio, 20000);
});

test('una carrera entre dos dueños aplica una sola vez', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t, { precio_sugerido: 20000 }); const id = cuerpo.solicitud.id; como(t, DUENO);
  const aplicar = (precio: number) => t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio, precio_esperado: 25000 });
  const [a, b] = await Promise.all([aplicar(20000), aplicar(18000)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(solicitudes(t).filter((s) => s.estado === 'aplicada').length, 1);
  assert.equal(producto(t).precio, solicitudes(t)[0].precio_nuevo);
});

test('si el precio ya vale lo pedido (respuesta perdida) solo se cierra la solicitud', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t, { precio_sugerido: 20000 }); const id = cuerpo.solicitud.id; como(t, DUENO);
  t.db.prepare('update productos set precio = 20000 where id = ?').run(PRODUCTO);
  const r = await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio: 20000, precio_esperado: 25000 });
  assert.equal(r.status, 200); assert.equal(r.cuerpo.solicitud.estado, 'aplicada');
});

test('rechazar deja el precio igual y libera la pieza', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t); const id = cuerpo.solicitud.id; como(t, DUENO);
  const r = await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'rechazar' });
  assert.equal(r.status, 200); assert.equal(r.cuerpo.solicitud.estado, 'rechazada'); assert.equal(r.cuerpo.solicitud.resuelto_por, DUENO);
  assert.equal(producto(t).precio, 25000);
  assert.equal((await t.pedir('/api/solicitudes-precio?estado=pendiente')).cuerpo.conteo, 0);
  assert.equal((await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'rechazar' })).status, 409);
  como(t, CAP); assert.equal((await pedir(t)).status, 201);
});

test('el propietario acota: la solicitud de FEP no la ve ni la resuelve el dueño de El Dolarón', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t);
  const fep = crypto.randomUUID();
  t.db.prepare("insert into productos (id, codigo, nombre, precio, stock, destino, estado_analisis, propietario, semana_ingreso, creado_en, actualizado_en) values (?, 'FEP-000001', 'Pieza FEP', 9000, 1, 'etiqueta', 'listo', 'fep', 'S40', '', '')").run(fep);
  como(t, CAP); assert.equal((await pedir(t, {}, fep)).status, 404, 'el capturista de El Dolarón no ve piezas de FEP');
  t.db.prepare("insert into solicitudes_precio (id, producto_id, propietario, sentido, precio_actual, pedido_por, pedido_en) values (?, ?, 'fep', 'bajar', 9000, ?, '2026-10-22T10:00:00.000Z')").run(crypto.randomUUID(), fep, FEP);
  const id = (t.db.prepare("select id from solicitudes_precio where propietario = 'fep'").get() as any).id;
  como(t, DUENO);
  assert.equal((await t.pedir('/api/solicitudes-precio?estado=pendiente')).cuerpo.conteo, 0);
  assert.equal((await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'rechazar' })).status, 404);
  assert.equal((await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio: 5000, precio_esperado: 9000 })).status, 404);
  assert.equal((t.db.prepare('select precio from productos where id = ?').get(fep) as any).precio, 9000);
});

test('el host del capturista deja pedir y consultar; resolver sigue siendo del dueño', async (t0) => {
  assert.equal(permitidaParaVendedor(ruta(), 'POST'), true);
  assert.equal(permitidaParaVendedor(ruta(), 'GET'), false);
  assert.equal(permitidaParaVendedor('/inventario-precio.js', 'GET'), true);
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); t.env.HOST_VENDEDOR = 'caja.prueba'; como(t, CAP);
  const { cuerpo } = await pedir(t);
  assert.equal((await t.pedir('/api/solicitudes-precio?estado=pendiente')).status, 403);
  assert.equal((await t.pedir(`/api/solicitudes-precio/${cuerpo.solicitud.id}`, { accion: 'rechazar' })).status, 403);
});

test('el precio cambia en medio de aplicar: el UPDATE lo detecta y no pisa ni cierra la solicitud', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  const { cuerpo } = await pedir(t, { precio_sugerido: 20000 }); const id = cuerpo.solicitud.id; como(t, DUENO);
  const prepare = t.env.DB.prepare.bind(t.env.DB);
  (t.env.DB as any).prepare = (sql: string) => {   // alguien cambia el precio justo antes del UPDATE de la corrección
    if (/^update productos set nombre/.test(sql.trim())) t.db.prepare('update productos set precio = 30000 where id = ?').run(PRODUCTO);
    return prepare(sql);
  };
  const r = await t.pedir(`/api/solicitudes-precio/${id}`, { accion: 'aplicar', precio: 20000, precio_esperado: 25000 });
  assert.equal(r.status, 409); assert.equal(r.cuerpo.precio, 30000, 'la respuesta trae el precio de hoy para que el UI lo muestre');
  assert.equal(producto(t).precio, 30000); assert.equal(solicitudes(t)[0].estado, 'pendiente');
});

test('el dueño cambia el precio por el PATCH (Editar o Revisar): la solicitud pendiente se cierra sola, solo si el precio cambió', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); como(t, CAP);
  await pedir(t, { precio_sugerido: 20000 }); como(t, DUENO);
  const patch = (cuerpo: Record<string, unknown>) => t.pedir(`/api/borradores/${PRODUCTO}`, { destino: 'etiqueta', ...cuerpo }, 'PATCH');
  // Sin cambio de precio (solo el nombre): sigue pendiente.
  assert.equal((await patch({ nombre: 'Ventilador de mesa', precio: 25000 })).status, 200);
  assert.equal(solicitudes(t)[0].estado, 'pendiente');
  // Un PATCH que falla (precio sobre la lista) tampoco la cierra.
  assert.equal((await patch({ precio: 40001 })).status, 400);
  assert.equal(solicitudes(t)[0].estado, 'pendiente');
  const r21 = await patch({ precio: 21000 }); assert.equal(r21.status, 200, JSON.stringify(r21.cuerpo));
  const s = solicitudes(t)[0];
  assert.deepEqual([s.estado, s.precio_nuevo, s.resuelto_por], ['aplicada', 21000, DUENO]);
  assert.notEqual(s.resuelto_en, '');
  assert.equal(producto(t).precio, 21000);
  // Otra solicitud nueva sobre la misma pieza ya se puede pedir y un PATCH sin pendiente no falla.
  como(t, CAP); assert.equal((await pedir(t, { sentido: 'subir' })).status, 201);
  como(t, DUENO); assert.equal((await patch({ precio: 21000 })).status, 200);
  assert.equal(solicitudes(t)[1].estado, 'pendiente', 'mismo precio: no se cierra');
});
