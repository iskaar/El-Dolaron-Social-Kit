// node --test src/grado-precio.test.ts
// #708: cambiar el grado (A/B/C) de una pieza YA capturada recalcula su precio con la banda del grado nuevo,
// en la miniatura del celular (/revision) y en Revisar/admin (PATCH /api/borradores/:id). Precio escrito manda;
// sin precio de lista se conserva; sin permiso de precio (#479) el grado se guarda y el precio se pide al dueño.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registroFoto, formularioPendiente } from '../public/foto-pendiente.js';
import { cuerpoRevision } from '../public/inventario-revisar.js';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';

const UPC = '0191907910414';
function montar(correo?: string) {
  const t = tienda();
  t.db.prepare("insert into manifiesto(upc,descripcion,nombre,precio_usd,tcin,actualizado_en) values('191907910414','Lámpara','Lámpara',1000,'','')").run();
  t.db.prepare("insert or replace into config(clave,valor) values('tipo_cambio','2000'),('pct_otros','50')").run();
  t.db.prepare("insert into usuarios(correo,roles,activo,editar_inventario,creado_en,actualizado_en) values('cap@prueba.mx','capturista',1,1,'','')").run();
  if (correo) t.env.DEV_USUARIO = correo;
  /** Pieza con UPC ya confirmada (`por_revisar = 0`), con los precios de cada grado que ve la tarjeta. */
  const confirmada = async () => {
    const id = crypto.randomUUID();
    t.db.prepare('delete from productos where upc is not null').run();
    const f = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id, upc: UPC, cantidad: 2, estado_fisico: 'nuevo' }));
    const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never);
    assert.equal(r.status, 201);
    const precios = (await t.pedir(`/api/borradores/${id}/revision`)).cuerpo.precios as Record<string, number>;
    const ok = await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true }, 'PATCH');
    assert.equal(ok.status, 200, JSON.stringify(ok.cuerpo));
    return { id, precios };
  };
  const fila = (id: string) => t.db.prepare('select precio, precio_lista, estado_fisico, destino, codigo, por_revisar from productos where id=?').get(id) as any;
  const solicitudes = (id: string) => t.db.prepare("select sentido, precio_actual, precio_sugerido from solicitudes_precio where producto_id=? and estado='pendiente'").all(id) as any[];
  return { ...t, confirmada, fila, solicitudes };
}

test('celular: corregir el grado de una pieza confirmada recalcula el precio; sin precio de lista se conserva', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const { id, precios } = await t.confirmada();
  assert.ok(precios.danado < precios.nuevo);
  const r = await t.pedir(`/api/borradores/${id}/revision`, { estado_fisico: 'danado' }, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([t.fila(id).estado_fisico, t.fila(id).precio], ['danado', precios.danado]);   // antes: el precio se quedaba en el de A
  assert.equal(r.cuerpo.precio, precios.danado);

  t.db.prepare('update productos set precio_lista = 0 where id = ?').run(id);
  assert.equal((await t.pedir(`/api/borradores/${id}/revision`, { estado_fisico: 'liquidacion' }, 'PATCH')).status, 200);
  assert.deepEqual([t.fila(id).estado_fisico, t.fila(id).precio], ['liquidacion', precios.danado], 'sin precio de lista no hay banda que aplicar');
});

test('celular: capturista sin permiso de precio con etiqueta → el grado se guarda y el precio nuevo se pide al dueño', async (t0) => {
  const t = montar('cap@prueba.mx'); t0.after(async () => { await t.esperar(); t.db.close(); });
  const { id, precios } = await t.confirmada();
  t.db.prepare("update productos set codigo = 'ED-000777' where id = ?").run(id);
  const r = await t.pedir(`/api/borradores/${id}/revision`, { estado_fisico: 'danado' }, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.ok(r.cuerpo.aviso, 'avisa que se pidió al dueño');
  assert.deepEqual([t.fila(id).estado_fisico, t.fila(id).precio], ['danado', precios.nuevo], 'grado nuevo, precio de la etiqueta intacto');
  assert.deepEqual(t.solicitudes(id).map((s) => [s.sentido, s.precio_actual, s.precio_sugerido]), [['bajar', precios.nuevo, precios.danado]]);
});

test('Revisar/admin: PATCH con solo el grado recalcula, un precio escrito manda y sin permiso se pide al dueño', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const { id, precios } = await t.confirmada();
  const p = () => ({ ...t.fila(id), nombre: 'Lámpara', marca: '', talla: '', categoria: 'otros', stock: 2 });
  // Lo que manda Revisar con la pieza tal cual y solo otro grado: cuerpoRevision omite el precio.
  const cuerpo = (campos: Record<string, unknown>) => cuerpoRevision(p(), { nombre: 'Lámpara', marca: '', talla: '', categoria: 'otros', destino: 'etiqueta',
    precio_lista: String(p().precio_lista / 100), precio: String(p().precio / 100), stock: '2', stock_visto: '2', ...campos }, true).cuerpo!;
  const solo = cuerpo({ estado_fisico: 'danado' });
  assert.equal('precio' in solo, false, 'solo cambió el grado: el servidor recalcula');
  assert.equal('precio' in cuerpo({ estado_fisico: 'danado', precio: '55' }), true, 'precio editado: se manda');
  assert.equal('precio' in cuerpo({}), true, 'sin cambio de grado: se manda el vigente');
  const r = await t.pedir(`/api/borradores/${id}`, solo, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([t.fila(id).estado_fisico, t.fila(id).precio], ['danado', precios.danado]);

  const manual = await t.pedir(`/api/borradores/${id}`, { ...solo, estado_fisico: 'liquidacion', precio: 1900 }, 'PATCH');
  assert.equal(manual.status, 200, JSON.stringify(manual.cuerpo));
  assert.deepEqual([t.fila(id).estado_fisico, t.fila(id).precio], ['liquidacion', 1900], 'el precio escrito manda sobre la banda');

  // Sin precio de lista el precio se conserva.
  t.db.prepare('update productos set precio_lista = 0 where id = ?').run(id);
  const sin = await t.pedir(`/api/borradores/${id}`, { ...solo, estado_fisico: 'nuevo', precio_lista: 0 }, 'PATCH');
  assert.equal(sin.status, 200, JSON.stringify(sin.cuerpo));
  assert.deepEqual([t.fila(id).estado_fisico, t.fila(id).precio], ['nuevo', 1900]);

  // Editor sin permiso de precio (pieza con etiqueta): el grado se guarda, el precio se pide.
  const o = await t.confirmada();
  t.db.prepare("update productos set codigo = 'ED-000888' where id = ?").run(o.id);
  t.env.DEV_USUARIO = 'cap@prueba.mx';
  const pedido = await t.pedir(`/api/borradores/${o.id}`, { nombre: 'Lámpara', marca: '', talla: '', precio_lista: t.fila(o.id).precio_lista, destino: 'etiqueta', categoria: 'otros', estado_fisico: 'danado' }, 'PATCH');
  assert.equal(pedido.status, 200, JSON.stringify(pedido.cuerpo));
  assert.ok(pedido.cuerpo.aviso);
  assert.deepEqual([t.fila(o.id).estado_fisico, t.fila(o.id).precio], ['danado', o.precios.nuevo]);
  assert.deepEqual(t.solicitudes(o.id).map((s) => s.precio_sugerido), [o.precios.danado]);
});
