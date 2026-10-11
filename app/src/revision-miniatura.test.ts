import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker, { permitidaParaVendedor } from './worker.ts';
import { analizarBorrador } from './analisis.ts';
import { tienda, DUENO } from './prueba-d1.ts';

async function captura(t: ReturnType<typeof tienda>, id = crypto.randomUUID()) {
  const body = new FormData();
  body.set('id', id); body.set('precio_ropa', '15000'); body.set('talla', 'M');
  body.set('foto', new File(['foto de prueba'], 'foto.jpg', { type: 'image/jpeg' }));
  const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body }) as never, t.env, t.ctx as never);
  assert.equal(r.status, 201);
  return { id, cuerpo: await r.json() as any };
}

test('revisión valida cinco precios y condición; no recalcula precio ni repone stock o cambia código', async () => {
  const t = tienda(); t.env.AMBIENTE = 'sandbox';
  try {
    const { id } = await captura(t), ruta = `/api/borradores/${id}/revision`;
    const codigo = (await t.pedir('/api/etiquetas', { ids: [id] })).cuerpo[0].codigo;
    for (const precio of [20000, 15000, 10000, 8000, 5000]) {
      assert.equal((await t.pedir(ruta, { precio }, 'PATCH')).status, 200);
      assert.equal((await t.pedir(ruta)).cuerpo.precio, precio);
    }
    t.db.prepare('update productos set stock=0 where id=?').run(id);
    const r = await t.pedir(ruta, { estado_fisico: 'danado' }, 'PATCH');
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.precio, 5000); assert.equal(r.cuerpo.stock, 0); assert.equal(r.cuerpo.codigo, codigo);
    assert.equal(r.cuerpo.estado_fisico, 'danado');
    for (const cuerpo of [null, [], {}, { precio: '5000' }, { precio: 4999 }, { precio: 5000.5 },
      { estado_fisico: ['danado'] }, { estado_fisico: 'usado' }, { stock: 1 }, { nombre: 'Otra' }]) {
      assert.equal((await t.pedir(ruta, cuerpo, 'PATCH')).status, 400, JSON.stringify(cuerpo));
    }
    const reenvio = await captura(t, id);
    assert.equal(reenvio.cuerpo.estado_fisico, 'danado');
    assert.equal(reenvio.cuerpo.precio, 5000); assert.equal(reenvio.cuerpo.stock, 0);
  } finally { t.db.close(); }
});

test('revisión sólo en sandbox, con rol, captura propia reciente y métodos permitidos', async () => {
  const t = tienda(); t.env.AMBIENTE = 'sandbox';
  try {
    const { id } = await captura(t), ruta = `/api/borradores/${id}/revision`;
    for (const metodo of ['GET', 'PATCH', 'DELETE']) assert.equal(permitidaParaVendedor(ruta, metodo), true);
    assert.equal(permitidaParaVendedor(ruta, 'POST'), false);
    t.env.AMBIENTE = 'produccion';
    assert.equal((await t.pedir(ruta)).status, 404);
    assert.equal((await t.pedir(ruta, { precio: 5000 }, 'PATCH')).status, 404);
    assert.equal((await t.pedir(ruta, {}, 'DELETE')).status, 404);
    t.env.AMBIENTE = 'sandbox';
    t.db.prepare("insert into usuarios(correo, roles, activo, creado_en, actualizado_en) values ('otro@prueba.mx', 'capturista', 1, '', '')").run();
    t.env.DEV_USUARIO = 'otro@prueba.mx';
    for (const metodo of ['GET', 'PATCH', 'DELETE']) assert.equal((await t.pedir(ruta, metodo === 'GET' ? undefined : { precio: 5000 }, metodo)).status, 404);
    t.env.DEV_USUARIO = DUENO;
    t.db.prepare("update productos set creado_en='2020-01-01T00:00:00.000Z' where id=?").run(id);
    assert.equal((await t.pedir(ruta, {}, 'DELETE')).status, 404);
    t.db.prepare("update usuarios set roles='cajero' where correo='otro@prueba.mx'").run();
    t.env.DEV_USUARIO = 'otro@prueba.mx';
    assert.equal((await t.pedir(ruta)).status, 403);
  } finally { t.db.close(); }
});

test('eliminar después de subir y antes del POST conserva UUID; reintento/análisis no reviven ni imprimen', async () => {
  const t = tienda(); t.env.AMBIENTE = 'sandbox';
  try {
    const { id } = await captura(t);
    for (const pieza of [id, crypto.randomUUID()]) {
      const ruta = `/api/borradores/${pieza}/revision`;
      assert.equal((await t.pedir(ruta, {}, 'DELETE')).status, 200);
      assert.equal((await t.pedir(ruta, {}, 'DELETE')).status, 200);
      assert.equal(await t.env.FOTOS.get(`fotos/${pieza}.jpg`), null);
      const repetida = await captura(t, pieza);
      assert.equal(repetida.cuerpo.estado_analisis, 'descartado');
      assert.equal(repetida.cuerpo.stock, 0);
      await analizarBorrador(pieza, t.env); // foto ausente: tampoco el catch puede reabrirla.
      assert.equal((await t.pedir(ruta)).cuerpo.estado_analisis, 'descartado');
      assert.equal((await t.pedir(ruta, { precio: 5000 }, 'PATCH')).status, 409);
      assert.equal((await t.pedir(`/api/borradores/${pieza}/existencia`, { stock: 1 }, 'PATCH')).status, 404);
      assert.equal((await t.pedir('/api/borradores')).cuerpo.some((p: any) => p.id === pieza), false);
      assert.equal((await t.pedir('/api/etiquetas', { ids: [pieza] })).cuerpo.length, 0);
      assert.equal((await t.pedir(`/api/foto/${pieza}`)).status, 404);
    }
  } finally { t.db.close(); }
});

test('no descarta una captura vendida ni una con publicación; la foto se conserva', async () => {
  const t = tienda(); t.env.AMBIENTE = 'sandbox';
  try {
    const { id } = await captura(t);
    await t.pedir('/api/etiquetas', { ids: [id] });
    assert.equal((await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: id, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 15000 })).status, 201);
    assert.equal((await t.pedir(`/api/borradores/${id}/revision`, {}, 'DELETE')).status, 409);
    assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
    const otra = await captura(t);
    t.db.prepare("insert into ml_publicaciones(producto_id, estado, actualizado_en) values (?, 'publicando', '')").run(otra.id);
    assert.equal((await t.pedir(`/api/borradores/${otra.id}/revision`, {}, 'DELETE')).status, 409);
    assert.ok(await t.env.FOTOS.get(`fotos/${otra.id}.jpg`));
  } finally { t.db.close(); }
});

test('descarte intercalado con R2/POST no deja foto ni revive la captura', async () => {
  const t = tienda(); t.env.AMBIENTE = 'sandbox';
  try {
    const id = crypto.randomUUID(), original = t.env.FOTOS.put.bind(t.env.FOTOS);
    t.env.FOTOS.put = async (...args) => {
      const r = await original(...args);
      assert.equal((await t.pedir(`/api/borradores/${id}/revision`, {}, 'DELETE')).status, 200);
      return r;
    };
    const r = await captura(t, id);
    assert.equal(r.cuerpo.estado_analisis, 'descartado');
    assert.equal(r.cuerpo.stock, 0);
    assert.equal(await t.env.FOTOS.get(`fotos/${id}.jpg`), null);
  } finally { t.db.close(); }
});

test('venta intercalada antes de editar no se repone; venta antes de descartar impide la eliminación', async () => {
  const t = tienda(); t.env.AMBIENTE = 'sandbox';
  try {
    const { id } = await captura(t), ruta = `/api/borradores/${id}/revision`;
    await t.pedir('/api/etiquetas', { ids: [id] });
    const original = t.env.DB.prepare.bind(t.env.DB);
    let vendida = false;
    t.env.DB.prepare = (sql) => {
      const s = original(sql);
      if (sql.startsWith('update productos set stock = 0,')) {
        const run = s.run.bind(s);
        s.run = async () => {
          if (!vendida) {
            vendida = true;
            assert.equal((await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: id, cantidad: 1 }], forma_pago: 'efectivo', efectivo: 15000 })).status, 201);
          }
          return run();
        };
      }
      return s;
    };
    assert.equal((await t.pedir(ruta, {}, 'DELETE')).status, 409);
    assert.equal((await t.pedir(ruta, { precio: 8000, estado_fisico: 'danado' }, 'PATCH')).cuerpo.stock, 0);
    assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
  } finally { t.db.close(); }
});

const html = readFileSync('public/captura.html', 'utf8');
function miniatura(subida: boolean) {
  const id = crypto.randomUUID(), registro = { id, foto: new Blob(['foto']), precio_ropa: 15000, estado_fisico: 'nuevo', cantidad: 1, talla: 'M' };
  const cola = new Map<string, any>(subida ? [] : [[id, structuredClone(registro)]]);
  const sesion = new Map([[id, { ...registro, subida }]]);
  const elementos = new Map<string, any>();
  const $ = (nombre: string): any => {
    if (!elementos.has(nombre)) elementos.set(nombre, { textContent: '', style: {}, children: [], hidden: false,
      eventos: new Map(), classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(tipo: string, fn: any) { this.eventos.set(tipo, fn); }, querySelectorAll: () => [] });
    return elementos.get(nombre);
  };
  const estado = { sinRed: false, quitada: false, llamadas: [] as any[] };
  const api = runInNewContext(`${html.slice(html.indexOf('const elRevisar ='), html.indexOf('async function disparar()'))}
    ({ abrirRevision, cerrarRevision, precio: v => { fichaRevision.precio = v; },
       guardar: () => elGuardarRevision.eventos.get('click')(), condicion: () => elRevisarEstado.eventos.get('click')(),
       eliminar: () => elDescartar.eventos.get('click')() })`, {
    document: { getElementById: $ }, sesion, preciosRopa: [20000, 15000, 10000, 8000, 5000], idSubiendo: null,
    chips() {}, selectorTalla: () => ({ poner() {} }), activarControlCantidad() {},
    leer: async (id: string) => structuredClone(cola.get(id)), guardar: async (r: any) => cola.set(r.id, structuredClone(r)),
    borrar: async (id: string) => cola.delete(id), procesarCola() {}, repintarMiniatura() {}, actualizarContador() {},
    miniaturas: { querySelector: () => ({ src: 'blob:foto', querySelector: () => ({ src: 'blob:foto' }), remove() { estado.quitada = true; } }) },
    URL: { revokeObjectURL() {} }, tomadas: 1, piezasTotales: 1, subidas: subida ? 1 : 0,
    fetch: async (_ruta: string, opciones: any) => {
      estado.llamadas.push(opciones);
      if (estado.sinRed) throw new TypeError('sin red');
      return { ok: true, json: async () => opciones.method === 'GET'
        ? { precio: 15000, estado_fisico: 'nuevo', estado_analisis: 'listo' }
        : opciones.method === 'DELETE' ? { descartado: true } : { precio: 8000, estado_fisico: 'danado' } };
    },
  });
  return { ...api, id, $, cola, sesion, estado };
}

test('miniatura subida muestra controles, guarda precio/condición y elimina sólo tras confirmar y éxito', async () => {
  const p = miniatura(true);
  await p.abrirRevision(p.id);
  assert.equal(p.$('revisar-guardar').hidden, false);
  assert.equal(p.$('revisar-local').style.display, '');
  p.precio(8000); await p.condicion(); await p.guardar();
  assert.deepEqual(JSON.parse(p.estado.llamadas.at(-1).body), { precio: 8000, estado_fisico: 'danado' });
  assert.equal(p.sesion.get(p.id)!.precio_ropa, 8000);
  await p.eliminar(); assert.equal(p.estado.quitada, false);
  p.estado.sinRed = true;
  await p.eliminar(); assert.equal(p.estado.quitada, false); assert.equal(p.sesion.size, 1);
  p.estado.sinRed = false;
  await p.eliminar(); assert.equal(p.estado.quitada, true); assert.equal(p.sesion.size, 0);
});

test('miniatura local guarda precio/condición offline junto a la foto y deja pendiente la corrección explícita', async () => {
  const p = miniatura(false); p.estado.sinRed = true;
  await p.abrirRevision(p.id);
  p.precio(5000); await p.condicion(); await p.guardar();
  assert.equal(p.estado.llamadas.length, 0);
  assert.equal(p.cola.get(p.id).precio_ropa, 5000);
  assert.equal(p.cola.get(p.id).estado_fisico, 'danado');
  assert.deepEqual(p.cola.get(p.id).correccion_ficha, { precio: 5000, estado_fisico: 'danado' });
  assert.equal(await p.cola.get(p.id).foto.text(), 'foto');
});

test('subida reintenta la corrección local si se pierde su respuesta; no borra la foto pendiente', async () => {
  const id = crypto.randomUUID();
  const registro = { id, foto: new Blob(['foto']), precio_ropa: 8000, estado_fisico: 'danado', cantidad: 1,
    correccion_ficha: { precio: 8000, estado_fisico: 'danado' }, version: 1 };
  const cola = new Map([[id, registro]]), sesion = new Map([[id, { ...registro, subida: false }]]);
  let falla = true, correcciones = 0;
  const procesar = runInNewContext(`${html.slice(html.indexOf('async function procesarCola()'), html.indexOf('function actualizarContador()'))}; procesarCola`, {
    subiendo: false, idSubiendo: null, idActual: null, subidas: 0, piezasTotales: 1, sesion, preciosRopa: [8000], FormData,
    pendientes: async () => [...cola.values()], leer: async (id: string) => cola.get(id), borrar: async (id: string) => cola.delete(id),
    fetch: async () => ({ ok: true, status: 201, json: async () => ({ precio: 15000, stock: 1, estado_fisico: 'nuevo' }) }),
    pedirRevision: async (_id: string, method: string, cambios: any) => {
      assert.equal(method, 'PATCH'); assert.deepEqual(cambios, registro.correccion_ficha); correcciones++;
      if (falla) throw new TypeError('respuesta perdida');
      return { precio: 8000, stock: 1, estado_fisico: 'danado' };
    }, repintarMiniatura() {}, actualizarContador() {}, setTimeout() {}, document: { getElementById: () => ({ textContent: '' }) },
  });
  await procesar(); assert.equal(cola.size, 1); assert.equal(sesion.get(id)!.subida, false);
  falla = false;
  await procesar(); assert.equal(cola.size, 0); assert.equal(correcciones, 2);
  assert.equal(sesion.get(id)!.precio_ropa, 8000); assert.equal(sesion.get(id)!.estado_fisico, 'danado');
});
