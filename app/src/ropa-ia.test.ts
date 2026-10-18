import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { procesarColaRopa } from './ropa-ia.ts';
import { analizarFotoRopa } from './analisis.ts';

const sugerencia = (prenda_confianza: 'alta'|'media'|'baja' = 'alta', marca = '', marca_confianza: 'alta'|'media'|'baja' = 'baja') =>
  ({ prenda: 'Playera', prenda_confianza, marca, marca_confianza, motivo: 'Etiqueta visible.' });
function pieza(db: any, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  db.prepare(`insert into productos (id,nombre,categoria,precio,stock,foto_key,semana_ingreso,creado_en,actualizado_en)
    values (?,'Ropa','ropa',10000,1,?,'S42','','')`).run(id, `fotos/${id}.jpg`);
  return id;
}
const encender = (db: any) => db.prepare("insert into config (clave,valor) values ('ropa_ia_activo','1')").run();

test('ropa IA apagada por defecto y no altera el producto', async () => {
  const { db, env } = tienda(); const id = pieza(db);
  await procesarColaRopa(env, async () => { throw Error('no deberÃ­a llamar al modelo'); });
  assert.equal((db.prepare('select ropa_ia_estado from productos where id=?').get(id) as any).ropa_ia_estado, null);
});

test('la instrucción específica y el JSON estructurado usan el proveedor existente', async (t) => {
  const { env } = tienda();
  (env as any).MODELO_ANALISIS = 'gemini'; (env as any).GEMINI_API_KEY = 'simulada';
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.match(payload.systemInstruction.parts[0].text, /etiqueta legible/);
    assert.deepEqual(Object.keys(payload.generationConfig.responseSchema.properties), ['prenda','prenda_confianza','marca','marca_confianza','motivo']);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(sugerencia('alta','Cat & Jack','alta')) }] } }] }));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  assert.deepEqual(await analizarFotoRopa(new Uint8Array([1,2,3]).buffer, env), sugerencia('alta','Cat & Jack','alta'));
});

test('confianzas: alta aplica, media aplica y revisa, baja conserva nombre', async () => {
  const { db, env } = tienda(); encender(db);
  for (const [conf, nombre, estado] of [['alta','Playera','aplicado'], ['media','Playera','revisar'], ['baja','Ropa','revisar']] as const) {
    const id = pieza(db); await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1]));
    await procesarColaRopa(env, async () => sugerencia(conf));
    const fila = db.prepare('select nombre,ropa_ia_estado from productos where id=?').get(id) as any;
    assert.deepEqual([fila.nombre, fila.ropa_ia_estado], [nombre, estado]);
  }
});

test('cada confianza con cada bandera conserva o aplica el nombre según la regla', async () => {
  const { db, env } = tienda(); encender(db);
  for (const confianza of ['alta','media','baja'] as const) for (const bandera of ['ninguna','precio_no_coincide','marca_desconocida','sin_prenda']) {
    const id = pieza(db); await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1]));
    if (bandera === 'precio_no_coincide') db.prepare('update productos set precio=15000 where id=?').run(id);
    await procesarColaRopa(env, async () => ({ ...sugerencia(confianza, bandera === 'marca_desconocida' ? 'Marca Rara' : '', 'alta'), prenda: bandera === 'sin_prenda' ? '' : 'Playera' }));
    const fila = db.prepare('select nombre,ropa_ia_estado from productos where id=?').get(id) as any;
    const sinBandera = bandera === 'ninguna';
    assert.equal(fila.nombre, sinBandera && confianza !== 'baja' ? 'Playera' : 'Ropa', `${confianza}/${bandera}`);
    assert.equal(fila.ropa_ia_estado, sinBandera && confianza === 'alta' ? 'aplicado' : 'revisar', `${confianza}/${bandera}`);
  }
});
test('banderas bloquean cambios y precio/situaciÃ³n de etiqueta permanecen intactos', async () => {
  const { db, env } = tienda(); encender(db);
  for (const s of [sugerencia('alta', 'Marca Rara', 'alta'), sugerencia()]) {
    const id = pieza(db, { });
    if (s.prenda === 'Playera') db.prepare('update productos set precio=15000 where id=?').run(id);
    await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1]));
    await procesarColaRopa(env, async () => s);
    const fila = db.prepare('select nombre,precio,estado_analisis,ropa_ia_estado,ropa_ia_sugerencia from productos where id=?').get(id) as any;
    assert.equal(fila.nombre, 'Ropa'); assert.equal(fila.precio, 15000);
    assert.equal(fila.estado_analisis, 'pendiente'); assert.equal(fila.ropa_ia_estado, 'revisar');
    assert.ok(JSON.parse(fila.ropa_ia_sugerencia).banderas.length);
  }
});

test('Suéter a $300 no genera bandera y marca media se omite', async () => {
  const { db, env } = tienda(); encender(db); const id = pieza(db);
  db.prepare("update productos set precio=30000 where id=?").run(id);
  await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1]));
  await procesarColaRopa(env, async () => ({ ...sugerencia('alta', 'All in Motion', 'media'), prenda: 'Suéter' }));
  const f = db.prepare('select nombre,marca,ropa_ia_estado from productos where id=?').get(id) as any;
  assert.deepEqual([f.nombre, f.marca, f.ropa_ia_estado], ['Suéter', '', 'revisar']);
});

test('lÃ­mite 10 y nombre distinto de Ropa excluido', async () => {
  const { db, env } = tienda(); encender(db); const ids = Array.from({ length: 12 }, () => pieza(db));
  const plan = db.prepare(`explain query plan select id,precio,ropa_ia_sugerencia from productos indexed by productos_ropa_ia_pendiente
    where ropa_ia_estado is null and categoria='ropa' and nombre='Ropa' and foto_key<>'' and stock>0 order by creado_en limit 10`).all();
  assert.ok(plan.some((p: any) => String(p.detail).includes('productos_ropa_ia_pendiente')));
  db.prepare("update productos set nombre='SuÃ©ter' where id=?").run(ids[11]);
  for (const id of ids) await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1]));
  let llamadas = 0; await procesarColaRopa(env, async () => { llamadas++; return sugerencia(); });
  assert.equal(llamadas, 10);
  assert.equal((db.prepare('select ropa_ia_estado from productos where id=?').get(ids[11]) as any).ropa_ia_estado, null);
});

test('falla reintenta dos veces y al tercero pasa a error', async () => {
  const { db, env } = tienda(); encender(db); const id = pieza(db);
  await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1]));
  for (const intento of [1,2,3]) {
    await procesarColaRopa(env, async () => { throw Error('red'); });
    const f = db.prepare('select ropa_ia_estado,ropa_ia_sugerencia from productos where id=?').get(id) as any;
    assert.equal(f.ropa_ia_estado, intento === 3 ? 'error' : null);
    assert.equal(JSON.parse(f.ropa_ia_sugerencia).intentos, intento);
  }
});

test('rutas admin enumeran, aceptan, corrigen y descartan sin cambiar precio', async () => {
  const { db, env, pedir } = tienda(); encender(db);
  const ids = [pieza(db), pieza(db), pieza(db)];
  for (const id of ids) await env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1]));
  await procesarColaRopa(env, async () => sugerencia('media'));
  assert.equal((await pedir('/api/ropa-ia', undefined, 'GET')).status, 200);
  assert.equal((await pedir(`/api/ropa-ia/${ids[0]}/aceptar`, {})).status, 200);
  assert.equal((await pedir(`/api/ropa-ia/${ids[1]}/corregir`, { prenda: 'Blusa', marca: 'Cat & Jack' })).status, 200);
  assert.equal((await pedir(`/api/ropa-ia/${ids[2]}/descartar`, {})).status, 200);
  const filas = ids.map((id) => db.prepare('select nombre,marca,precio,estado_analisis,ropa_ia_estado from productos where id=?').get(id) as any);
  assert.deepEqual(filas.map((f) => [f.nombre, f.marca, f.precio, f.estado_analisis, f.ropa_ia_estado]), [
    ['Playera', '', 10000, 'pendiente', 'aceptado'],
    ['Blusa Cat & Jack', 'Cat & Jack', 10000, 'pendiente', 'aceptado'],
    ['Playera', '', 10000, 'pendiente', 'descartado'],
  ]);
});
