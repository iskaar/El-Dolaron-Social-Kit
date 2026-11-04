// node --test src/calzado-revision.test.ts
// #705 (ED-003552): calzado con UPC capturado con foto nace `por_revisar` en «ropa» (Ropa y calzado). Su revisión no puede
// exigir prenda de ropa ni precio fijo, la talla se tiene que poder guardar y una etiqueta impresa a mano la libera.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registroFoto, formularioPendiente } from '../public/foto-pendiente.js';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';

const UPC = '0195000000017';
function montar() {
  const t = tienda();
  t.db.prepare(`insert into manifiesto(upc,descripcion,departamento,nombre,marca,categoria,precio_usd,tcin,actualizado_en)
    values('195000000017','Squishmallows Girls'' Slipper','SHOES','Pantuflas Squishmallows para niña','Squishmallows','ropa',1500,'','')`).run();
  t.db.prepare("insert or replace into config(clave,valor) values('tipo_cambio','2000'),('pct_ropa','50'),('pct_otros','50')").run();
  /** La foto del celular con el UPC del manifiesto; cada una es una pieza nueva (se retira la anterior para que no se sume). */
  const foto = async () => {
    t.db.prepare('delete from productos').run();
    const id = crypto.randomUUID();
    const f = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id, upc: UPC, cantidad: 1, estado_fisico: 'nuevo' }));
    const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never);
    assert.equal(r.status, 201);
    return id;
  };
  const fila = (id: string) => ({ ...t.db.prepare('select nombre, precio, talla, categoria, por_revisar from productos where id=?').get(id) as any });
  return { ...t, foto, fila };
}

test('calzado con UPC por revisar: se guarda el número y se confirma con su nombre y su precio de banda, sin prenda de ropa', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const id = await t.foto();
  const antes = t.fila(id);
  assert.deepEqual([antes.categoria, antes.por_revisar, antes.talla], ['ropa', 1, null]);
  const rev = (await t.pedir(`/api/borradores/${id}/revision`)).cuerpo;
  assert.ok(rev.precios?.nuevo > 0, 'la tarjeta recibe el precio de banda por grado');

  const talla = await t.pedir(`/api/borradores/${id}/talla`, { talla: 'Niño 15-16' }, 'PATCH');
  assert.equal(talla.status, 200, JSON.stringify(talla.cuerpo));   // antes: 404 y el ✎ no se quitaba
  const ok = await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true }, 'PATCH');
  assert.equal(ok.status, 200, JSON.stringify(ok.cuerpo));
  assert.deepEqual(t.fila(id), { ...antes, talla: 'Niño 15-16', por_revisar: 0 }, 'nombre y precio intactos');
  assert.equal((await t.pedir(`/api/borradores/${id}/talla`, { talla: 'Niño 16' }, 'PATCH')).status, 404, 'confirmada ya no se corrige desde la captura');

  // El dueño corrige nombre y precio como en la tarjeta UPC: el precio no tiene que ser uno de ropa.
  const otra = await t.foto();
  const editada = await t.pedir(`/api/borradores/${otra}/revision`, { confirmar: true, nombre: 'Pantuflas Squishmallows Stitch', precio: 17900 }, 'PATCH');
  assert.equal(editada.status, 200, JSON.stringify(editada.cuerpo));
  assert.deepEqual([t.fila(otra).nombre, t.fila(otra).precio, t.fila(otra).por_revisar], ['Pantuflas Squishmallows Stitch', 17900, 0]);
});

test('ropa sin código sigue con prenda, marca y precio fijo', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const ropa = new FormData(), id = crypto.randomUUID();
  for (const [k, v] of Object.entries({ id, estado_fisico: 'nuevo', cantidad: '1', talla: 'Niño 15', precio_ropa: '15000', prenda: 'Pijama', marca: 'Squishmallows' })) ropa.set(k, v);
  ropa.set('foto', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'r.jpg', { type: 'image/jpeg' }));
  const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: ropa }) as never, t.env, t.ctx as never);
  assert.equal(r.status, 201);
  assert.equal(t.fila(id).nombre, 'Pijama Squishmallows');
  assert.equal((await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true, precio: 0 }, 'PATCH')).status, 400, 'precio no positivo (el libre es del dueño: ropa-prendas.test.ts)');
  assert.equal((await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true, nombre: 'Otro' }, 'PATCH')).status, 400, 'el nombre sale de prenda y marca');
  assert.equal(t.fila(id).por_revisar, 1);
});

test('una etiqueta impresa a mano (Buscar, Imprimir) libera la pieza por revisar; si no sale, no', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const id = await t.foto();
  t.db.prepare('update productos set stock = 0 where id = ?').run(id);
  assert.deepEqual((await t.pedir('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, []);
  assert.equal(t.fila(id).por_revisar, 1, 'sin reclamo no hay etiqueta y sigue por revisar');
  t.db.prepare('update productos set stock = 1 where id = ?').run(id);
  assert.deepEqual((await t.pedir('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, [id]);
  assert.equal(t.fila(id).por_revisar, 0);
  const lista = (await t.pedir('/api/borradores?desde=2020-01-01T00:00:00.000Z')).cuerpo as any[];
  assert.equal(lista.find((p) => p.id === id).por_revisar, 0, 'al recargar, el celular ya no la pinta ✎');
});

test('PC: la tarjeta de un calzado hallado en internet pide el número y lo guarda antes de confirmar e imprimir', async () => {
  const { crearCaptura } = await import('../public/inventario-capturar.js');
  const orden: string[] = [];
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async (id: string, n: number) => { orden.push(`imprimir ${id} ${n}`); return true; },
    api: async (ruta: string, cuerpo: any, metodo = 'POST') => { orden.push(`${metodo} ${ruta} ${JSON.stringify(cuerpo)}`); return { id: 'c1', estado_analisis: 'listo', por_revisar: 0 }; } });
  const ficha = { nombre: 'Pantuflas Squishmallows para niña', categoria: 'ropa', calzado: true, precio: 14900, precios: { nuevo: 14900 }, precio_lista: 30000, stock: 1 };
  flujo.retomar({ tipo: 'nueva', revision: true, imagenBuscada: true, id: 'c1', upc: UPC, cantidad: 1, estado: 'nuevo', estadoInicial: 'nuevo', ficha });
  await assert.rejects(flujo.guardar(), /número del calzado/);
  assert.deepEqual(orden, []);
  flujo.actual().talla = 'Niño 15-16';
  await flujo.guardar();
  assert.deepEqual(orden, ['PATCH /api/borradores/c1/talla {"talla":"Niño 15-16"}', 'PATCH /api/borradores/c1/revision {"confirmar":true}', 'imprimir c1 1']);
});
