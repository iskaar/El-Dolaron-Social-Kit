// node --test src/ficha-grado.test.ts
// #715: la ficha de Buscar edita el grado (A/B/C). Solo cambió el grado y el precio del formulario es el de la pieza →
// el cuerpo no lleva precio y el servidor recalcula con la banda del grado nuevo (#708); un precio editado se manda.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registroFoto, formularioPendiente } from '../public/foto-pendiente.js';
import { cuerpoCorreccion, resumenCorreccion } from '../public/ficha.js';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';

const P = { precio: 45000, precio_lista: 60000, destino: 'etiqueta', estado_fisico: 'nuevo', codigo: 'ED-002318', nombre: 'Chamarra', marca: 'Levis', talla: 'M' };
const C = { nombre: 'Chamarra', marca: 'Levis', talla: 'M', precio: '450', precio_lista: '600' };

test('cuerpoCorreccion: solo el grado omite el precio; precio editado, banda o sin cambio de grado lo conservan', () => {
  const solo = cuerpoCorreccion(P, { ...C, estado_fisico: 'danado' }, true).cuerpo!;
  assert.equal(solo.estado_fisico, 'danado'); assert.ok(!('precio' in solo));
  assert.ok(!('precio' in cuerpoCorreccion(P, { ...C, precio: '', estado_fisico: 'danado' }, false).cuerpo!), 'sin permiso de precio también recalcula el servidor');
  const manual = cuerpoCorreccion(P, { ...C, precio: '400', estado_fisico: 'danado' }, true).cuerpo!;
  assert.deepEqual([manual.precio, manual.estado_fisico], [40000, 'danado']);
  assert.equal(cuerpoCorreccion({ ...P, destino: 'banda_g119' }, { ...C, estado_fisico: 'danado' }, true).cuerpo!.precio, 45000);
  for (const campos of [C, { ...C, estado_fisico: 'nuevo' }, { ...C, estado_fisico: '' }]) {
    const c = cuerpoCorreccion(P, campos, true).cuerpo!;
    assert.ok(!('estado_fisico' in c)); assert.equal(c.precio, 45000);
  }
});

test('resumenCorreccion: muestra «Grado A → B» y avisa que el precio se recalcula', () => {
  const [linea, ...resto] = resumenCorreccion(P, cuerpoCorreccion(P, { ...C, estado_fisico: 'danado' }, true).cuerpo!, undefined);
  assert.match(linea, /^Grado A · Nuevo → B · Dañado\. El precio se recalcula con la banda/);
  assert.deepEqual(resto, []);
  const conPrecio = resumenCorreccion(P, cuerpoCorreccion(P, { ...C, precio: '400', estado_fisico: 'danado' }, true).cuerpo!, undefined);
  assert.match(conPrecio[0], /^Grado A · Nuevo → B · Dañado\.$/); assert.match(conPrecio[1], /^Precio \$450\.00 → \$400\.00/);
  assert.deepEqual(resumenCorreccion(P, cuerpoCorreccion(P, C, true).cuerpo!, undefined), []);
});

test('flujo de la ficha: el PATCH con solo el grado recalcula el precio y un grado ya ocupado da 409 con la existente', async (t0) => {
  const t = tienda(); t0.after(async () => { await t.esperar(); t.db.close(); });
  t.db.prepare("insert into manifiesto(upc,descripcion,nombre,precio_usd,tcin,actualizado_en) values('191907910414','Lámpara','Lámpara',1000,'','')").run();
  t.db.prepare("insert or replace into config(clave,valor) values('tipo_cambio','2000'),('pct_otros','50')").run();
  const crear = async (grado: string) => {
    const id = crypto.randomUUID();
    const f = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id, upc: '0191907910414', cantidad: 1, estado_fisico: grado }));
    assert.equal((await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never)).status, 201);
    const precios = (await t.pedir(`/api/borradores/${id}/revision`)).cuerpo.precios as Record<string, number>;
    assert.equal((await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true }, 'PATCH')).status, 200);
    return { id, precios };
  };
  const { id, precios } = await crear('nuevo');
  assert.ok(precios.danado < precios.nuevo);
  const { pieza } = (await t.pedir(`/api/piezas/${id}`)).cuerpo;
  const campos = { nombre: pieza.nombre, marca: pieza.marca ?? '', talla: pieza.talla ?? '', precio: String(pieza.precio / 100), precio_lista: String(pieza.precio_lista / 100), upc: pieza.upc ?? '' };
  const { cuerpo } = cuerpoCorreccion(pieza, { ...campos, estado_fisico: 'danado' }, true);
  assert.ok(cuerpo && !('precio' in cuerpo));
  const r = await t.pedir(`/api/borradores/${id}`, cuerpo, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([r.cuerpo.estado_fisico, r.cuerpo.precio], ['danado', precios.danado]);   // antes: se mandaba el precio de A y se quedaba

  // Otra pieza con el mismo UPC en grado A: pasarla a B choca con la primera (#709) y dice cuál es.
  t.db.prepare('delete from productos where id <> ?').run(id);
  const otra = await crear('nuevo');
  const choque = await t.pedir(`/api/borradores/${otra.id}`, { ...cuerpo, estado_fisico: 'danado' }, 'PATCH');
  assert.equal(choque.status, 409);
  assert.equal(choque.cuerpo.existente.id, id); assert.equal(choque.cuerpo.existente.estado_fisico, 'danado');
});
