import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, DUENO } from './prueba-d1.ts';
import worker from './worker.ts';
import { MISMO_UPC } from './upc-inventario.ts';

const UPC = '0012345678905';
type Tienda = ReturnType<typeof tienda>;
function preparar() {
  const t = tienda();
  t.db.prepare(`insert into manifiesto (upc, descripcion, precio_usd, tcin, nombre, actualizado_en)
    values ('12345678905', 'Termo', 10, '', 'Termo', '')`).run();
  t.db.prepare("insert or replace into config (clave, valor) values ('tipo_cambio','2000'), ('pct_otros','50')").run();
  Object.assign(t.env, { BUSQUEDAS:{ send:async () => {} } });
  return t;
}
const cuerpo = (extra = {}) => ({ id:crypto.randomUUID(), upc:UPC, stock:2, estado_fisico:'nuevo', ...extra });
const filas = (t: Tienda) => t.db.prepare("select * from productos where ltrim(upc,'0')='12345678905'").all();
const ajustes = (t: Tienda) => t.db.prepare('select * from conteo_ajustes').all();

test('mismo UPC y grado suma con rastro; ceros y reintentos de alta y suma no duplican', async () => {
  const t = preparar(), a = cuerpo(), b = cuerpo({ upc:'012345678905', stock:3 });
  const primera = await t.pedir('/api/borradores/upc', a);
  assert.equal(primera.status, 201);
  assert.ok(primera.cuerpo.codigo);
  assert.equal((await t.pedir('/api/borradores/upc', a)).cuerpo.stock, 2);
  const segunda = await t.pedir('/api/borradores/upc', b);
  assert.equal(segunda.status, 201);
  assert.deepEqual([segunda.cuerpo.id, segunda.cuerpo.existente, segunda.cuerpo.sumadas, segunda.cuerpo.stock], [a.id,true,3,5]);
  assert.equal((await t.pedir('/api/borradores/upc', b)).cuerpo.stock, 5);
  assert.equal(filas(t).length, 1);
  assert.deepEqual(ajustes(t).map(a => [a.id,a.motivo,a.antes,a.despues,a.cantidad]), [[b.id,'entrada',2,5,3]]);
  t.db.close();
});

test('distinto grado permite pieza distinta; dos capturas simultáneas sólo insertan una por grado', async () => {
  const t = preparar();
  const respuestas = await Promise.all([t.pedir('/api/borradores/upc', cuerpo()),t.pedir('/api/borradores/upc', cuerpo())]);
  assert.deepEqual(respuestas.map(r => r.status), [201,201]);
  assert.equal(filas(t).length, 1); assert.equal(filas(t)[0].stock, 4); assert.equal(ajustes(t).length, 1);
  await t.pedir('/api/borradores/upc', cuerpo({ estado_fisico:'danado' }));
  await t.pedir('/api/borradores/upc', cuerpo({ estado_fisico:'liquidacion' }));
  assert.equal(filas(t).length, 3); t.db.close();
});

test('desconocido pendiente/error también suma y su UUID original sigue consultable por quien capturó', async () => {
  const t = preparar(); t.db.prepare('delete from manifiesto').run();
  const a = cuerpo(), b = cuerpo();
  assert.equal((await t.pedir('/api/borradores/upc/buscar', a)).status, 202);
  const r = await t.pedir('/api/borradores/upc/buscar', b);
  assert.equal(r.cuerpo.id, a.id); assert.equal(r.cuerpo.existente, true);
  assert.equal((await t.pedir('/api/borradores/upc/buscar', b)).cuerpo.stock, 4);
  assert.equal((await t.pedir(`/api/borradores/upc/${b.id}`)).cuerpo.id, a.id);
  t.db.prepare("update productos set estado_analisis='error' where id=?").run(a.id);
  assert.equal((await t.pedir('/api/borradores/upc', cuerpo())).cuerpo.stock, 6);
  assert.equal(filas(t).length, 1); t.db.close();
});

test('suma que pasa 999 falla sin rastro ni producto nuevo; el folio simultáneo sólo suma una vez', async () => {
  const t = preparar(); const a = cuerpo({stock:998});
  await t.pedir('/api/borradores/upc', a);
  const r = await t.pedir('/api/borradores/upc', cuerpo());
  assert.equal(r.status, 409); assert.match(r.cuerpo.error, /999/);
  assert.equal(filas(t)[0].stock, 998); assert.equal(ajustes(t).length, 0);
  const b = cuerpo({stock:1});
  await Promise.all([t.pedir('/api/borradores/upc', b),t.pedir('/api/borradores/upc', b)]);
  assert.equal(filas(t)[0].stock, 999); assert.equal(ajustes(t).length, 1); t.db.close();
});

test('foto y captura manual con UPC reutilizan identidad y conservan reintentos de la cola', async () => {
  const t = preparar(); const a = cuerpo(); await t.pedir('/api/borradores/upc', a);
  const f = new FormData(); f.set('id',crypto.randomUUID()); f.set('upc',UPC); f.set('cantidad','3');
  f.set('foto',new File(['foto'],'foto.jpg',{type:'image/jpeg'}));
  const enviar = () => worker.fetch!(new Request('https://caja.prueba/api/borradores',{method:'POST',body:f}) as never,t.env,t.ctx as never);
  assert.equal((await (await enviar()).json() as any).sumadas, 3);
  assert.equal((await (await enviar()).json() as any).id, a.id);
  t.db.prepare('delete from manifiesto').run();
  const b = cuerpo({nombre:'Manual',precio:9900,categoria:'otros'});
  assert.equal((await t.pedir('/api/borradores/upc/manual', b)).cuerpo.id, a.id);
  assert.equal((await t.pedir('/api/borradores/upc/manual', b)).cuerpo.id, a.id);
  assert.equal(filas(t).length, 1); assert.equal(filas(t)[0].stock, 7); assert.equal(ajustes(t).length, 2);
  t.db.close();
});

test('la consulta de igualdad usa el índice por propietario, UPC normalizado y grado', () => {
  const t = preparar();
  const plan = t.db.prepare(`explain query plan select id from productos where ${MISMO_UPC} limit 1`).all('dolaron','12345678905','nuevo');
  assert.match(JSON.stringify(plan), /SEARCH productos USING INDEX productos_upc_grado/);
  t.db.close();
});
