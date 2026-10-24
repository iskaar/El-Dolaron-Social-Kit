// node --test src/precio-gobierno.test.ts
// #479 (U1+U2 de #478): una sola regla de precio (autorizarPrecio) y el análisis nunca pisa una pieza `listo`.
// Quien no puede fijar el precio de una pieza con etiqueta lo pide al dueño (solicitud #451); el análisis solo sugiere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';
import { analizarBorrador } from './analisis.ts';
import { autorizarPrecio } from './piezas.ts';
import type { Usuario } from './cuentas.ts';

type Tienda = ReturnType<typeof tienda>;
const CAP = 'cap@prueba.mx', CAP_CASILLA = 'casilla@prueba.mx';
const como = (t: Tienda, correo: string) => { t.env.DEV_USUARIO = correo; };
function equipo(t: Tienda) {
  t.env.AMBIENTE = 'sandbox';
  for (const [correo, casilla] of [[CAP, 0], [CAP_CASILLA, 1]])
    t.db.prepare("insert into usuarios (correo, nombre, roles, activo, editar_inventario, creado_en, actualizado_en) values (?, ?, 'capturista', 1, ?, '', '')").run(correo, correo, casilla);
}
/** Prenda de ropa `listo` capturada por `capturadoPor` hace un momento; con `codigo` ya tiene etiqueta. */
function ropa(t: Tienda, { codigo = 'ED-000002', capturadoPor = CAP } = {}) {
  const id = crypto.randomUUID(), ahora = new Date().toISOString();
  t.db.prepare(`insert into productos (id, codigo, nombre, marca, categoria, precio, precio_lista, stock, estado_analisis, destino, capturado_por, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, 'Playera', '', 'ropa', 15000, 0, 1, 'listo', 'etiqueta', ?, 'S40', ?, ?)`).run(id, codigo, capturadoPor, ahora, ahora);
  return id;
}
const fila = (t: Tienda, id: string) => t.db.prepare('select nombre, precio, precio_sugerido, estado_analisis, estado_fisico from productos where id = ?').get(id) as any;
const solicitudes = (t: Tienda) => t.db.prepare('select * from solicitudes_precio').all() as any[];

test('autorizarPrecio: el dueño siempre; las demás cuentas solo sin etiqueta; el precio de sistema es del dueño', () => {
  const u = (roles: string[], activo = true) => ({ activo, roles } as unknown as Usuario);
  assert.equal(autorizarPrecio(u(['dueno']), { codigo: 'ED-000001' }), true);
  assert.equal(autorizarPrecio(u(['capturista']), { codigo: 'ED-000001' }), false);
  assert.equal(autorizarPrecio(u(['capturista']), { codigo: null }), true);
  assert.equal(autorizarPrecio(u(['capturista']), { codigo: '' }), true);
  assert.equal(autorizarPrecio(u(['capturista']), { codigo: null, preciadaPorSistema: true }), false);
  assert.equal(autorizarPrecio(u(['dueno']), { codigo: null, preciadaPorSistema: true }), true);
  assert.equal(autorizarPrecio(u(['dueno'], false), { codigo: 'ED-000001' }), false);
});

test('miniatura 24 h con etiqueta: el capturista no cambia el precio, se pide al dueño y lo demás se guarda', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t);
  const id = ropa(t), ruta = `/api/borradores/${id}/revision`;
  como(t, CAP);
  const r = await t.pedir(ruta, { precio: 20000, estado_fisico: 'danado' }, 'PATCH');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.solicitud_precio, true);
  assert.equal(r.cuerpo.aviso, 'Se pidió el cambio de precio al dueño');
  assert.equal(r.cuerpo.precio, 15000);
  assert.deepEqual({ precio: fila(t, id).precio, estado_fisico: fila(t, id).estado_fisico }, { precio: 15000, estado_fisico: 'danado' });
  const pendientes = solicitudes(t);
  assert.equal(pendientes.length, 1);
  assert.deepEqual({ ...pendientes[0] }, { ...pendientes[0], producto_id: id, sentido: 'subir', precio_actual: 15000, precio_sugerido: 20000,
    pedido_por: CAP, estado: 'pendiente' });
  // Otro intento: sigue una sola pendiente y el precio no se mueve.
  const otra = await t.pedir(ruta, { precio: 10000 }, 'PATCH');
  assert.equal(otra.status, 200); assert.equal(otra.cuerpo.solicitud_precio, true);
  assert.equal(solicitudes(t).length, 1); assert.equal(fila(t, id).precio, 15000);
  // El mismo precio, o solo la condición, no pide nada.
  assert.equal((await t.pedir(ruta, { precio: 15000, estado_fisico: 'nuevo' }, 'PATCH')).cuerpo.solicitud_precio, undefined);
});

test('miniatura con etiqueta: el dueño cambia el precio directo; sin etiqueta el capturista también', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t);
  const etiquetada = ropa(t, { capturadoPor: DUENO });
  const r = await t.pedir(`/api/borradores/${etiquetada}/revision`, { precio: 8000 }, 'PATCH');
  assert.equal(r.status, 200); assert.equal(r.cuerpo.precio, 8000); assert.equal(r.cuerpo.solicitud_precio, undefined);
  assert.equal(solicitudes(t).length, 0);
  const sinEtiqueta = ropa(t, { codigo: '' });
  como(t, CAP);
  const s = await t.pedir(`/api/borradores/${sinEtiqueta}/revision`, { precio: 5000 }, 'PATCH');
  assert.equal(s.status, 200); assert.equal(s.cuerpo.precio, 5000); assert.equal(s.cuerpo.solicitud_precio, undefined);
  assert.equal(solicitudes(t).length, 0);
});

test('la ficha (corregirBorrador) sigue negando el precio de una pieza etiquetada a quien no es dueño', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t);
  const id = ropa(t);
  como(t, CAP_CASILLA);
  const r = await t.pedir(`/api/borradores/${id}`, { precio: 20000 }, 'PATCH');
  assert.equal(r.status, 403);
  assert.equal(fila(t, id).precio, 15000);
  // El mismo precio no es un cambio de precio: lo demás se guarda. El alta por UPC (validarEdicion) lo cubre manifiesto.test.ts.
  assert.equal((await t.pedir(`/api/borradores/${id}`, { precio: 15000, marca: 'Levi' }, 'PATCH')).status, 200);
});

// El análisis: Gemini responde siempre lo mismo; el precio calculado queda por debajo del precio actual de la pieza.
function conGemini(t: Tienda, t0: { after: (f: () => void) => void }, nombre = 'Licuadora Oster') {
  const original = globalThis.fetch;
  t0.after(() => { globalThis.fetch = original; });
  (t.env as { GEMINI_API_KEY: string }).GEMINI_API_KEY = 'prueba';
  globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    nombre, marca: 'Oster', categoria: 'hogar', precio_lista_mxn: 200, precio_venta_mxn: 0 }) }] } }] }))) as typeof fetch;
}
async function pieza(t: Tienda, estado: string) {
  const id = crypto.randomUUID();
  await t.env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
  t.db.prepare(`insert into productos (id, codigo, nombre, marca, categoria, precio, precio_lista, stock, estado_analisis, destino, foto_key, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, 'Licuadora corregida', 'Marca', 'hogar', 25000, 40000, 1, ?, 'etiqueta', ?, 'S40', '', '')`)
    .run(id, estado === 'listo' ? 'ED-000009' : null, estado, `fotos/${id}.jpg`);
  return id;
}

test('reintentar análisis sobre una pieza lista sugiere y pide aprobación: nombre y precio quedan', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); conGemini(t, t0);
  const id = await pieza(t, 'listo');
  como(t, CAP_CASILLA);
  const r = await t.pedir(`/api/borradores/${id}/analizar?modelo=gemini`, {});
  assert.equal(r.status, 202);
  assert.equal(r.cuerpo.sugerencia, true); assert.equal(r.cuerpo.estado_analisis, 'listo');
  assert.equal(r.cuerpo.mensaje, 'Sugerencia enviada para aprobación');
  await t.esperar();
  const p = fila(t, id);
  assert.deepEqual({ nombre: p.nombre, precio: p.precio, estado: p.estado_analisis }, { nombre: 'Licuadora corregida', precio: 25000, estado: 'listo' });
  assert.ok(p.precio_sugerido > 0 && p.precio_sugerido < 25000, `precio_sugerido ${p.precio_sugerido}`);
  const [s, ...demas] = solicitudes(t);
  assert.equal(demas.length, 0);
  assert.deepEqual({ ...s }, { ...s, producto_id: id, sentido: 'bajar', precio_actual: 25000, precio_sugerido: p.precio_sugerido, pedido_por: CAP_CASILLA, estado: 'pendiente' });
  assert.match(s.nota, /Licuadora Oster/);
});

test('un resultado tardío tras la corrección humana no la pisa: sugiere con autor «ia»; un fallo tampoco la baja de listo', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); conGemini(t, t0);
  const id = await pieza(t, 'listo');
  await analizarBorrador(id, t.env, 'gemini', false);
  const p = fila(t, id);
  assert.deepEqual({ nombre: p.nombre, precio: p.precio, estado: p.estado_analisis }, { nombre: 'Licuadora corregida', precio: 25000, estado: 'listo' });
  assert.equal(solicitudes(t).length, 1); assert.equal(solicitudes(t)[0].pedido_por, 'ia');
  // Sin foto el análisis falla: el catch tampoco toca una pieza lista (antes la dejaba en error si no tenía UPC).
  t.db.prepare('delete from solicitudes_precio').run();
  await t.env.FOTOS.delete(`fotos/${id}.jpg`);
  await analizarBorrador(id, t.env, 'gemini', false);
  assert.equal(fila(t, id).estado_analisis, 'listo');
  assert.equal(solicitudes(t).length, 0);
});

test('una pieza pendiente se analiza como siempre: nombre, precio y listo; sin solicitudes', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close()); equipo(t); conGemini(t, t0);
  const id = await pieza(t, 'pendiente');
  await analizarBorrador(id, t.env, 'gemini', false);
  const p = fila(t, id);
  assert.equal(p.estado_analisis, 'listo'); assert.equal(p.nombre, 'Licuadora Oster');
  assert.ok(p.precio > 0 && p.precio !== 25000);
  assert.equal(p.precio_sugerido, p.precio);
  assert.equal(solicitudes(t).length, 0);
});
