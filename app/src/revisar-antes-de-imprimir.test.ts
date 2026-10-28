// node --test src/revisar-antes-de-imprimir.test.ts
// #573: ninguna pieza NUEVA imprime etiqueta hasta «Guardar» en una tarjeta que muestra nombre, precio, cantidad y grado A/B/C.
import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCaptura, cuerpoRevision } from '../public/inventario-capturar.js';
import { registroFoto, formularioPendiente } from '../public/foto-pendiente.js';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';

const UPC = '0191907910414';
function montar() {
  const t = tienda();
  t.db.prepare("insert into manifiesto(upc,descripcion,nombre,precio_usd,tcin,actualizado_en) values('191907910414','Lámpara','Lámpara',1000,'','')").run();
  t.db.prepare("insert or replace into config(clave,valor) values('tipo_cambio','2000'),('pct_otros','50')").run();
  t.db.prepare("insert into usuarios(correo,roles,activo,editar_inventario,creado_en,actualizado_en) values('cap@prueba.mx','capturista',1,0,'','')").run();
  /** La foto que sube el celular (cola de fotos): con UPC del manifiesto. */
  const foto = (id = crypto.randomUUID(), extra: Record<string, unknown> = {}) => {
    const f = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id, upc: UPC, cantidad: 2, estado_fisico: 'nuevo', ...extra }));
    return worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never).then(async (r) => ({ id, status: r.status, cuerpo: await r.json() as any }));
  };
  /** Otra foto del mismo UPC: se retira la anterior para que no se sume a ella como pieza existente. */
  const nueva = () => { t.db.prepare('delete from productos where upc is not null').run(); return foto(); };
  const fila = (id: string) => t.db.prepare('select nombre, precio, estado_fisico, stock, por_revisar, codigo from productos where id=?').get(id) as any;
  return { ...t, foto, nueva, fila };
}

test('servidor: la tarjeta UPC («Guardar») crea la pieza confirmada; la foto con UPC y la ropa con foto nacen por revisar', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const guardada = await t.pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: '0012345678905', stock: 1, estado_fisico: 'nuevo' });
  assert.equal(guardada.status, 404, 'sin ficha no hay alta por tarjeta (el UPC del manifiesto es el que sí)');
  const tarjeta = await t.pedir('/api/borradores/upc', { id: crypto.randomUUID(), upc: UPC, stock: 2, estado_fisico: 'nuevo' });
  assert.equal(tarjeta.status, 201);
  assert.equal(t.fila(tarjeta.cuerpo.id).por_revisar, 0, 'Guardar desde la tarjeta ya es la confirmación');
  t.db.prepare('delete from productos where upc is not null').run();

  const f = await t.foto();
  assert.equal(f.status, 201);
  assert.equal(f.cuerpo.estado_analisis, 'listo');
  assert.equal(t.fila(f.id).por_revisar, 1, 'una foto con UPC no libera la etiqueta');
  const lista = (await t.pedir('/api/borradores?desde=2020-01-01T00:00:00.000Z')).cuerpo as any[];
  assert.equal(lista.find((p) => p.id === f.id).por_revisar, 1);

  const ropa = new FormData();
  const idRopa = crypto.randomUUID();
  for (const [k, v] of Object.entries({ id: idRopa, estado_fisico: 'nuevo', cantidad: '2', talla: 'M', precio_ropa: '15000' })) ropa.set(k, v);
  ropa.set('foto', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'r.jpg', { type: 'image/jpeg' }));
  const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: ropa }) as never, t.env, t.ctx as never);
  assert.equal(r.status, 201);
  assert.equal(t.fila(idRopa).por_revisar, 1);
});

test('servidor: «Guardar e imprimir» de la revisión confirma de una vez con los cambios; el grado nuevo recalcula el precio de su banda', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const { id } = await t.foto();
  const revision = (await t.pedir(`/api/borradores/${id}/revision`)).cuerpo;
  assert.equal(revision.por_revisar, 1);
  assert.equal(revision.stock, 2);
  assert.ok(revision.precios.nuevo > revision.precios.danado && revision.precios.danado > revision.precios.liquidacion, JSON.stringify(revision.precios));
  assert.equal(revision.precio, revision.precios.nuevo);
  const r = await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true, estado_fisico: 'danado' }, 'PATCH');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual([t.fila(id).por_revisar, t.fila(id).estado_fisico, t.fila(id).precio], [0, 'danado', revision.precios.danado]);
  // Precio y nombre escritos por el dueño mandan sobre la banda.
  const otra = await t.nueva();
  const p = await t.pedir(`/api/borradores/${otra.id}/revision`, { confirmar: true, estado_fisico: 'liquidacion', precio: 1900, nombre: '  Lámpara de mesa ' }, 'PATCH');
  assert.equal(p.status, 200, JSON.stringify(p.cuerpo));
  assert.deepEqual([t.fila(otra.id).nombre, t.fila(otra.id).precio, t.fila(otra.id).por_revisar], ['Lámpara de mesa', 1900, 0]);
  for (const malo of [{ confirmar: false }, { confirmar: 1 }, { nombre: '   ' }, { precio: 0 }, { precio: 1.5 }, { precio: 'x' }]) {
    const uno = await t.nueva();
    assert.equal((await t.pedir(`/api/borradores/${uno.id}/revision`, malo, 'PATCH')).status, 400, JSON.stringify(malo));
    assert.equal(t.fila(uno.id).por_revisar, 1, 'un cuerpo inválido no confirma');
  }
  const lista = await t.nueva();
  assert.equal((await t.pedir(`/api/borradores/${lista.id}/revision`, { confirmar: true, precio: 999999999 }, 'PATCH')).status, 409, 'nunca por encima del precio de lista');
  assert.equal(t.fila(lista.id).por_revisar, 1);
});

test('servidor: nombre solo con la casilla «Editar inventario»; el precio de una pieza con etiqueta lo pide el capturista al dueño (#479) y aun así confirma', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  t.env.DEV_USUARIO = 'cap@prueba.mx';
  const { id } = await t.foto();
  const antes = t.fila(id);
  assert.equal((await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true, nombre: 'Otro nombre' }, 'PATCH')).status, 403);
  assert.deepEqual([t.fila(id).nombre, t.fila(id).por_revisar], [antes.nombre, 1], 'el 403 no confirma ni cambia nada');
  const mismo = await t.pedir(`/api/borradores/${id}/revision`, { confirmar: true, nombre: antes.nombre }, 'PATCH');
  assert.equal(mismo.status, 200, 'sin cambiarlo, el nombre no pide casilla');
  const { id: otra } = await t.nueva();
  t.db.prepare("update usuarios set editar_inventario=1 where correo='cap@prueba.mx'").run();
  assert.equal((await t.pedir(`/api/borradores/${otra}/revision`, { nombre: 'Con casilla' }, 'PATCH')).status, 200);
  assert.equal(t.fila(otra).nombre, 'Con casilla');
  assert.equal(t.fila(otra).por_revisar, 1, 'guardar sin `confirmar` no libera la etiqueta');
  const caro = t.fila(otra).precio - 100;
  const pedido = await t.pedir(`/api/borradores/${otra}/revision`, { confirmar: true, precio: caro }, 'PATCH');
  assert.equal(pedido.status, 200);
  assert.ok(pedido.cuerpo.aviso, 'se pidió el cambio de precio al dueño');
  assert.equal(t.fila(otra).precio, antes.precio, 'el precio no cambió');
  assert.equal(t.fila(otra).por_revisar, 0);
});

test('tarjeta UPC: elegir el grado cambia el precio mostrado al de ese grado y respeta el que el dueño ya escribió; el grado viaja en el alta', async () => {
  const llamadas: any[] = [];
  const ficha = { nombre: 'Lámpara', precio: 9000, precio_lista: 12000, precios: { nuevo: 9000, danado: 6000, liquidacion: 3000 } };
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async () => true, api: async (ruta, cuerpo) => {
    if (ruta.startsWith('/api/piezas/resolver')) return { ficha };
    llamadas.push({ ruta, cuerpo }); return { id: cuerpo.id, estado_analisis: 'listo' };
  } });
  await flujo.leer(UPC);
  flujo.gradoNueva('danado');
  assert.equal(flujo.actual().estado, 'danado');
  assert.equal(flujo.actual().precio, undefined, 'sin precio escrito, la tarjeta muestra el de la banda del grado');
  flujo.actual().precio = '75.00';
  flujo.gradoNueva('liquidacion');
  assert.equal(flujo.actual().precio, '75.00', 'el precio que escribió el dueño se conserva');
  flujo.actual().precio = '60.00';   // igual al de la banda anterior = sin tocar
  flujo.gradoNueva('danado'); flujo.gradoNueva('nuevo');
  await flujo.guardar();
  assert.equal(llamadas[0].cuerpo.estado_fisico, 'nuevo');
});

test('tarjeta de una pieza hallada en internet: «Guardar» ajusta la existencia, confirma por la revisión y solo entonces imprime', async () => {
  const orden: string[] = [];
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async (id: string, n: number, o: any) => { orden.push(`imprimir ${id} ${n} ${JSON.stringify(o)}`); return true; },
    api: async (ruta: string, cuerpo: any, metodo = 'POST') => {
      orden.push(`${metodo} ${ruta} ${JSON.stringify(cuerpo)}`);
      if (ruta.endsWith('/revision')) return { id: 'h1', nombre: cuerpo.nombre ?? 'Hallada', precio: 5000, estado_analisis: 'listo', por_revisar: 0 };
      return { despues: 3 };
    } });
  flujo.retomar({ tipo: 'nueva', revision: true, imagenBuscada: true, id: 'h1', upc: UPC, cantidad: 1, estado: 'nuevo', estadoInicial: 'nuevo',
    ficha: { nombre: 'Hallada', precio: 5000, precios: { nuevo: 5000, danado: 3500 }, precio_lista: 8000, stock: 1 } });
  flujo.cantidad(3); flujo.gradoNueva('danado'); flujo.actual().nombre = 'Hallada y corregida';
  assert.deepEqual(orden, [], 'nada se guarda ni imprime al editar la tarjeta');
  await flujo.guardar();
  assert.match(orden[0], /^POST \/api\/piezas\/h1\/existencia .*"fijar_a":3/);
  assert.equal(orden[1], 'PATCH /api/borradores/h1/revision {"confirmar":true,"nombre":"Hallada y corregida","estado_fisico":"danado"}');
  assert.equal(orden[2], 'imprimir h1 3 {}', 'la cantidad confirmada, sin forzar reimpresión');
  assert.equal(orden.length, 3);
  assert.equal(flujo.actual().tipo, 'guardada');
});

test('cuerpoRevision: solo manda lo que cambió y siempre confirma', () => {
  const a = { ficha: { nombre: 'Lámpara', precio: 9000, precios: { nuevo: 9000, danado: 6000 } }, estado: 'nuevo', estadoInicial: 'nuevo' } as any;
  assert.deepEqual(cuerpoRevision(a), { confirmar: true });
  assert.deepEqual(cuerpoRevision({ ...a, nombre: ' Lámpara ', precio: '90.00' }), { confirmar: true });
  assert.deepEqual(cuerpoRevision({ ...a, nombre: 'Otra', precio: '80', estado: 'danado' }), { confirmar: true, nombre: 'Otra', precio: 8000, estado_fisico: 'danado' });
  assert.throws(() => cuerpoRevision({ ...a, nombre: '' }), /nombre/);
});
