// #439: conservación de etiquetas/fotos y precondiciones reales dentro del batch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda, PRODUCTO, DUENO } from './prueba-d1.ts';
import { VENDIBLE } from './catalogo.ts';
import { PUBLICABLE } from './mercadolibre.ts';

async function repetida(t: ReturnType<typeof tienda>, codigo: string | null = 'ED-002318') {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into productos (id, codigo, nombre, precio, stock, estado_analisis, foto_key,
    semana_ingreso, creado_en, actualizado_en, capturado_por) values (?, ?, 'Ventilador', 35000, 3,
    'listo', ?, 'S43', ?, '', ?)`).run(id, codigo, `fotos/${id}.jpg`, new Date().toISOString(), DUENO);
  await t.env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
  return id;
}
const fila = (t: ReturnType<typeof tienda>, id: string) => t.db.prepare('select * from productos where id = ?').get(id)!;
const codigos = (t: ReturnType<typeof tienda>) => t.db.prepare("select codigo, count(*) n from productos where codigo <> '' group by codigo order by codigo").all();
const fusionar = (t: ReturnType<typeof tienda>, id: string) => t.pedir(`/api/borradores/${id}/fusionar`, { destino_id: PRODUCTO });

test('fusionar con dos etiquetas conserva count por código, fila y foto; reintentar no suma otra vez', async () => {
  const t = tienda(), id = await repetida(t), antes = codigos(t);
  const r = await fusionar(t, id);
  assert.equal(r.status, 200); assert.equal(r.cuerpo.stock, 53);
  assert.deepEqual(codigos(t), antes);
  assert.equal(fila(t, id).stock, 0); assert.equal(fila(t, id).estado_analisis, 'descartado');
  assert.equal(fila(t, id).foto_key, `fotos/${id}.jpg`);
  assert.deepEqual(new Uint8Array(await (await t.env.FOTOS.get(`fotos/${id}.jpg`))!.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal((await fusionar(t, id)).status, 409);
  assert.equal(fila(t, PRODUCTO).stock, 53);
  assert.equal((await t.pedir(`/api/borradores/${id}`, {}, 'DELETE')).status, 200);
  assert.deepEqual(codigos(t), antes);
});

test('solo se borra físicamente sin código; descartar con código mantiene fila, código y R2', async () => {
  for (const codigo of [null, '', 'ED-002319']) {
    const t = tienda(), id = await repetida(t, codigo), antes = codigos(t);
    assert.equal((await t.pedir(`/api/borradores/${id}`, {}, 'DELETE')).status, 200);
    assert.deepEqual(codigos(t), antes);
    if (codigo) {
      assert.equal(fila(t, id).stock, 0); assert.equal(fila(t, id).estado_analisis, 'descartado');
      assert.equal(fila(t, id).foto_key, `fotos/${id}.jpg`);
      assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
    } else {
      assert.equal(fila(t, id), undefined);
      assert.equal(await t.env.FOTOS.get(`fotos/${id}.jpg`), null);
    }
  }
});

test('fusionar sin etiqueta borra solo la repetida y su foto', async () => {
  const t = tienda(), id = await repetida(t, null);
  assert.equal((await fusionar(t, id)).status, 200);
  assert.equal(fila(t, PRODUCTO).stock, 53); assert.equal(fila(t, id), undefined);
  assert.equal(await t.env.FOTOS.get(`fotos/${id}.jpg`), null);
});

test('etiquetar entre prelectura y batch conserva el código y la foto en fusión y descarte', async () => {
  for (const fusion of [false, true]) {
    const t = tienda(), id = await repetida(t, null), batch = t.env.DB.batch.bind(t.env.DB);
    t.env.DB.batch = async (sentencias) => {
      t.db.prepare("update productos set codigo = 'ED-002318' where id = ?").run(id);
      return batch(sentencias);
    };
    const r = fusion ? await fusionar(t, id) : await t.pedir(`/api/borradores/${id}`, {}, 'DELETE');
    assert.equal(r.status, 200); assert.equal(fila(t, id).codigo, 'ED-002318');
    assert.equal(fila(t, id).stock, 0); assert.equal(fila(t, id).estado_analisis, 'descartado');
    assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
  }
});

test('dos fusiones simultáneas de una etiquetada suman una sola vez incluso con la misma hora', async (ctx) => {
  ctx.mock.method(Date.prototype, 'toISOString', () => '2026-10-22T18:00:00.000Z');
  const t = tienda(), id = await repetida(t), antes = codigos(t), batch = t.env.DB.batch.bind(t.env.DB);
  let llegadas = 0, abrir!: () => void;
  const puerta = new Promise<void>((r) => { abrir = r; });
  t.env.DB.batch = async (sentencias) => { if (++llegadas === 2) abrir(); await puerta; return batch(sentencias); };
  const respuestas = await Promise.all([fusionar(t, id), fusionar(t, id)]);
  assert.deepEqual(respuestas.map((r) => r.status).sort(), [200, 409]);
  assert.equal(fila(t, PRODUCTO).stock, 53); assert.deepEqual(codigos(t), antes);
  assert.equal(fila(t, id).stock, 0);
});

test('UPDATE que sumaría cero filas no permite borrar con una marca de tiempo coincidente', async (ctx) => {
  const ahora = '2026-10-22T18:00:00.000Z';
  ctx.mock.method(Date.prototype, 'toISOString', () => ahora);
  const t = tienda(), id = await repetida(t, null), batch = t.env.DB.batch.bind(t.env.DB);
  t.env.DB.batch = async (sentencias) => {
    t.db.prepare('update productos set stock = 999, actualizado_en = ? where id = ?').run(ahora, PRODUCTO);
    return batch(sentencias);
  };
  assert.equal((await fusionar(t, id)).status, 409);
  assert.equal(fila(t, PRODUCTO).stock, 999); assert.equal(fila(t, id).stock, 3);
  assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
});

test('fusión usa stock vigente; no lo repone desde la prelectura', async () => {
  const t = tienda(), id = await repetida(t), batch = t.env.DB.batch.bind(t.env.DB);
  t.env.DB.batch = async (sentencias) => {
    t.db.prepare('update productos set stock = stock - 1 where id = ?').run(PRODUCTO);
    t.db.prepare('update productos set stock = 2 where id = ?').run(id);
    return batch(sentencias);
  };
  assert.equal((await fusionar(t, id)).cuerpo.stock, 51);
});

test('fallar después de sumar revierte el stock de ambas piezas y deja R2 intacto', async () => {
  const t = tienda(), id = await repetida(t), antes = t.db.prepare('select * from productos order by id').all();
  t.db.exec(`create trigger fallo_descarte before update of estado_analisis on productos
    when new.estado_analisis = 'descartado' begin select raise(abort, 'fallo simulado'); end`);
  assert.equal((await fusionar(t, id)).status, 500);
  assert.deepEqual(t.db.prepare('select * from productos order by id').all(), antes);
  assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
});

test('cambios concurrentes abortan TODO el batch: propietario, descarte, desaparición y límite 999', async () => {
  for (const codigo of [null, 'ED-002318']) for (const cual of ['origen', 'destino']) {
    for (const cambio of ['propietario', 'descartado', 'desaparece', 'limite']) {
      const t = tienda(), id = await repetida(t, codigo), batch = t.env.DB.batch.bind(t.env.DB);
      let antes: unknown;
      t.env.DB.batch = async (sentencias) => {
        const objetivo = cual === 'origen' ? id : PRODUCTO;
        if (cambio === 'propietario') t.db.prepare("update productos set propietario = 'fep' where id = ?").run(objetivo);
        if (cambio === 'descartado') t.db.prepare("update productos set estado_analisis = 'descartado', stock = 0 where id = ?").run(objetivo);
        if (cambio === 'desaparece') t.db.prepare('delete from productos where id = ?').run(objetivo);
        if (cambio === 'limite') t.db.prepare('update productos set stock = 999 where id = ?').run(objetivo);
        antes = t.db.prepare('select * from productos order by id').all();
        return batch(sentencias);
      };
      const r = await fusionar(t, id);
      assert.equal(r.status, cambio === 'propietario' || cambio === 'desaparece' ? 404 : 409, `${cual}/${cambio}/${codigo}`);
      assert.deepEqual(t.db.prepare('select * from productos order by id').all(), antes);
      assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
    }
  }
});

test('venta, pedido o publicación después de preleer impiden fusión/descarte y conservan fotos', async () => {
  for (const fusion of [false, true]) for (const cambio of ['venta', 'pedido', 'publicacion', 'propietario']) {
    const t = tienda(), id = await repetida(t), batch = t.env.DB.batch.bind(t.env.DB);
    let antes: unknown;
    t.env.DB.batch = async (sentencias) => {
      t.env.DB.batch = batch;
      if (cambio === 'venta') assert.equal((await t.pedir('/api/ventas', {
        id: crypto.randomUUID(), caja: 'Caja 1', forma_pago: 'efectivo', efectivo: 35000,
        lineas: [{ producto_id: id, cantidad: 1 }],
      })).status, 201);
      if (cambio === 'pedido') assert.equal((await t.pedir('/api/pedidos', {
        id: crypto.randomUUID(), caja: 'Caja 1', cliente: 'Prueba', telefono: '4441234567',
        entrega: 'tienda', anticipo: 10000, forma_pago: 'transferencia', lineas: [{ producto_id: id, cantidad: 1 }],
      })).status, 201);
      if (cambio === 'publicacion') t.db.prepare(`insert into ml_publicaciones (producto_id, estado, actualizado_en)
        values (?, 'publicando', ?)`).run(id, new Date().toISOString());
      if (cambio === 'propietario') t.db.prepare("update productos set propietario = 'fep' where id = ?").run(id);
      antes = t.db.prepare('select * from productos order by id').all();
      return batch(sentencias);
    };
    const r = fusion ? await fusionar(t, id) : await t.pedir(`/api/borradores/${id}`, {}, 'DELETE');
    assert.equal(r.status, fusion && cambio === 'propietario' ? 404 : 409, `${fusion}/${cambio}`);
    assert.deepEqual(t.db.prepare('select * from productos order by id').all(), antes);
    assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
  }
});

test('aislamiento en ambos sentidos y operaciones válidas con piezas propias de FEP', async () => {
  const t = tienda(), fep = await repetida(t), propia = await repetida(t, 'ED-002319');
  t.db.prepare("update productos set propietario = 'fep' where id in (?, ?)").run(fep, propia);
  t.db.prepare(`insert into usuarios (correo, roles, activo, creado_en, actualizado_en) values ('fep@prueba.mx', 'finanzas', 1, '', '')`).run();
  for (const correo of [DUENO, 'fep@prueba.mx']) {
    t.env.DEV_USUARIO = correo;
    const ajena = correo === DUENO ? fep : PRODUCTO;
    assert.equal((await t.pedir(`/api/borradores/${ajena}`, {}, 'DELETE')).status, 404);
    assert.equal((await fusionar(t, fep)).status, 404);
    assert.equal((await t.pedir(`/api/borradores/${PRODUCTO}/fusionar`, { destino_id: fep })).status, 404);
  }
  assert.equal((await t.pedir(`/api/borradores/${fep}/fusionar`, { destino_id: propia })).status, 200);
  assert.equal(fila(t, propia).stock, 6); assert.equal(fila(t, fep).stock, 0);
  assert.equal((await t.pedir(`/api/borradores/${propia}`, {}, 'DELETE')).status, 200);
  assert.equal(fila(t, propia).estado_analisis, 'descartado');
});

test('descartada no es vendible ni imprimible; catálogo incremental retira también la copia de caja', async () => {
  const t = tienda(), id = await repetida(t);
  const desde = '2000-01-01T00:00:00.000Z';
  assert.equal((await t.pedir(`/api/borradores/${id}`, {}, 'DELETE')).status, 200);
  for (const ruta of ['/api/borradores', '/api/catalogo', '/api/conteo']) {
    assert.equal((await t.pedir(ruta)).cuerpo.some((p: any) => p.id === id), false, ruta);
  }
  assert.equal((await t.pedir('/api/marketplace')).cuerpo.products.some((p: any) => p.id === id), false);
  for (const criterio of [PUBLICABLE, VENDIBLE]) assert.equal(t.db.prepare(`select count(*) n from productos p where ${criterio} and p.id = ?`).get(id)!.n, 0);
  const cambios = (await t.pedir(`/api/catalogo?desde=${desde}`)).cuerpo.piezas.find((p: any) => p.id === id);
  assert.equal(cambios.precio, 0); assert.equal(cambios.stock, 0);
  assert.equal((await t.pedir('/api/borradores?cambios=' + desde)).cuerpo.find((p: any) => p.id === id).estado_analisis, 'descartado');
  assert.equal((await t.pedir('/api/etiquetas', { ids: [id] })).cuerpo.length, 0);
  assert.equal((await t.pedir('/api/reportes')).cuerpo.inventario.unidades, 50);
  assert.equal((await t.pedir('/api/ml/piezas')).cuerpo.piezas.some((p: any) => p.producto.id === id), false);
  assert.equal((await t.pedir('/api/ventas', { id: crypto.randomUUID(), caja: 'Caja 1', forma_pago: 'efectivo', efectivo: 35000,
    lineas: [{ producto_id: id, cantidad: 1 }] })).status, 409);
});

test('el descarte desde miniatura también conserva la foto si ya tenía código', async () => {
  const t = tienda(), id = await repetida(t), antes = codigos(t);
  assert.equal((await t.pedir(`/api/borradores/${id}/revision`, {}, 'DELETE')).status, 200);
  assert.deepEqual(codigos(t), antes); assert.equal(fila(t, id).stock, 0);
  assert.equal(fila(t, id).foto_key, `fotos/${id}.jpg`);
  assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
});
