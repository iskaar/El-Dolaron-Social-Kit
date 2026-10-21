// Worker + SQLite y el script real de /etiquetas, con BLE simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tienda, DUENO } from './prueba-d1.ts';
import worker from './worker.ts';
import { tsplEtiqueta, etiquetaVigente, partirNombre, NOMBRE_MAX } from '../public/etiquetera.js';
import { CORRECCION_ESCANER_MS } from '../public/upc.js';

const fuente = readFileSync('public/etiquetas.html', 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)![1]
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*'[^']+';/g, '');
const DESDE = '2026-10-11T15:00:00.000Z';
const ANTES = '2026-10-11T14:00:00.000Z';
const DESPUES = '2026-10-11T16:00:00.000Z';

function agregar(t: ReturnType<typeof tienda>, creado = DESPUES, estado = 'listo', stock = 1) {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into productos (id, nombre, categoria, estado_analisis, precio, stock, semana_ingreso, creado_en, actualizado_en)
                values (?, 'Camisa', 'ropa', ?, 7900, ?, '2026-S41', ?, ?)`).run(id, estado, stock, creado, new Date().toISOString());   // como la app: actualizado_en es ahora
  return id;
}

test('desde filtra en servidor antes del tope de 2000 y combina el estado sin cambiar la API anterior', async () => {
  const t = tienda();
  try {
    for (let i = 0; i < 2001; i++) agregar(t, ANTES);
    const listo = agregar(t), pendiente = agregar(t, DESPUES, 'pendiente');
    assert.equal((await t.pedir('/api/borradores')).cuerpo.length, 2000);
    const nuevas = await t.pedir(`/api/borradores?desde=${DESDE}`);
    assert.equal(nuevas.status, 200);
    assert.deepEqual(nuevas.cuerpo.map((p: any) => p.id), [listo, pendiente]);
    assert.deepEqual((await t.pedir(`/api/borradores?estado=listo&desde=${DESDE}`)).cuerpo.map((p: any) => p.id), [listo]);
    for (const fecha of ['', 'ayer', '2026-13-01', "' or 1=1 --", '2026-10-11']) {
      assert.equal((await t.pedir(`/api/borradores?desde=${encodeURIComponent(fecha)}`)).status, 400);
    }
  } finally { t.db.close(); }
});

test('salud identifica sandbox y da la hora del servidor sin credenciales', async () => {
  const t = tienda();
  try {
    assert.equal((await t.pedir('/api/salud')).cuerpo.ambiente, 'produccion');
    t.env.AMBIENTE = 'sandbox';
    const salud = (await t.pedir('/api/salud')).cuerpo;
    assert.equal(salud.estado, 'ok');
    assert.equal(salud.ambiente, 'sandbox');
    assert.equal(new Date(salud.ahora).toISOString(), salud.ahora);
    assert.deepEqual(Object.keys(salud).sort(), ['ahora', 'ambiente', 'estado']);
  } finally { t.db.close(); }
});

test('la cámara recibe precios en producción y sandbox; solo sandbox lleva franja', async () => {
  const t = tienda(), anterior = (globalThis as any).HTMLRewriter;
  t.env.ASSETS = { fetch: async () => new Response('<html><body></body></html>', { headers: { 'content-type': 'text/html' } }) } as Fetcher;
  (globalThis as any).HTMLRewriter = class {
    handler: any;
    on(_selector: string, handler: any) { this.handler = handler; return this; }
    transform() {
      const datos = { precios: '', franja: '' };
      this.handler.element({ setAttribute: (nombre: string, valor: string) => { assert.equal(nombre, 'data-precios-ropa'); datos.precios = valor; },
        prepend: (html: string) => { datos.franja = html; } });
      return new Response(JSON.stringify(datos));
    }
  };
  try {
    for (const ambiente of [undefined, 'sandbox']) {
      t.env.AMBIENTE = ambiente;
      const r = await worker.fetch!(new Request('https://caja.prueba/captura') as never, t.env, t.ctx as never);
      assert.equal(r.status, 200);
      const datos = await r.json() as any;
      assert.deepEqual(JSON.parse(datos.precios), [30000, 20000, 15000, 12000, 10000, 8000, 5000]);
      assert.equal(datos.franja.includes('SANDBOX'), ambiente === 'sandbox');
    }
  } finally { (globalThis as any).HTMLRewriter = anterior; t.db.close(); }
});

async function pagina(t: ReturnType<typeof tienda>, ambiente = 'sandbox', almacen = new Map<string, string>()) {
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, { textContent: '', hidden: false, disabled: false, innerHTML: '', style: {},
      eventos: new Map(), addEventListener(evento: string, fn: any) { this.eventos.set(evento, fn); }, querySelectorAll: () => [] });
    return elementos.get(id);
  };
  const estado = { conectada: true, falloBle: false, falloRed: false, falloMarca: false, permiso: 0,
    enviadas: [] as { id: string; copias: number }[], detenido: false, antesDePreparar: null as null | (() => Promise<void>) };
  const marcas = () => JSON.parse(almacen.get('etiqueta-impresas') || '{}');
  const api = await runInNewContext(`(async () => { ${fuente}
    return { iniciarAutomatica, imprimirNuevas, imprimir, pausarAutomatica, activa: () => automaticaActiva };
  })()`, {
    document: { getElementById: $ }, navigator: { bluetooth: {}, locks: { request: async (_nombre: string, _opciones: any, fn: any) => fn({}) } },
    localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => almacen.set(k, v), removeItem: (k: string) => almacen.delete(k) },
    fetch: async (ruta: string, opciones?: any) => {
      if (estado.falloRed) throw new Error('sin red');
      if (ruta === '/api/salud') return { ok: true, json: async () => ({ estado: 'ok', ambiente, ahora: DESDE }) };
      if (ruta === '/api/etiquetas') await estado.antesDePreparar?.();
      const r = await t.pedir(ruta, opciones?.body ? JSON.parse(opciones.body) : undefined);
      return { ok: r.status < 300, status: r.status, json: async () => r.cuerpo };
    },
    conectarEtiquetera: async () => { estado.permiso++; estado.conectada = true; }, etiqueteraLista: () => estado.conectada,
    imprimirEtiquetas: async (p: any, copias: number, avanzar: any) => {
      assert.equal(almacen.get('etiqueta-automatica-dudosa'), p.id);
      estado.enviadas.push({ id: p.id, copias }); avanzar(1);
      return !estado.falloBle;
    },
    impresas: marcas, marcarImpresa: (id: string, hora?: string, p?: any) => {
      if (!estado.falloMarca) almacen.set('etiqueta-impresas', JSON.stringify({ ...marcas(), [id]: { hora: hora || DESDE, ...p } }));
    },
    etiquetaVigente, CORRECCION_ESCANER_MS, desmarcarDesde() {}, historialTexto: () => '',
    detenerEnvio: (valor = true) => { estado.detenido = valor; }, envioDetenido: () => estado.detenido, errorEnvio: () => 'BLE falló',
    setInterval() {}, AbortSignal, encodeURIComponent, Date, Map, console,
  });
  return { ...api, estado, $, almacen };
}

function capturarRopa(t: ReturnType<typeof tienda>, id: string, precio: string, datos: { prenda?: string; marca?: string } = {}) {
  const cuerpo = new FormData();
  cuerpo.append('id', id);
  cuerpo.append('estado_fisico', 'nuevo');
  cuerpo.append('cantidad', '2');
  cuerpo.append('talla', 'M');
  cuerpo.append('precio_ropa', precio);
  if (datos.prenda !== undefined) cuerpo.append('prenda', datos.prenda);
  if (datos.marca !== undefined) cuerpo.append('marca', datos.marca);
  cuerpo.append('foto', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], `${id}.jpg`, { type: 'image/jpeg' }));
  return worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never,
    t.env, { waitUntil() { assert.fail('La ropa con precio asignado no necesita IA'); } } as never);
}

test('las siete categorías se guardan con foto, talla y precio exacto, sin IA, redondeo ni precio de lista inventado', async () => {
  const t = tienda();
  try {
    t.env.AMBIENTE = 'sandbox';
    for (const precio of [30000, 20000, 15000, 12000, 10000, 8000, 5000]) {
      const id = crypto.randomUUID();
      const captura = await capturarRopa(t, id, String(precio));
      assert.equal(captura.status, 201);
      assert.equal((await captura.json() as any).estado_analisis, 'listo');
      t.db.prepare('update productos set creado_en=? where id=?').run(DESPUES, id);
      const fila = t.db.prepare('select nombre, categoria, precio, precio_lista, talla, stock from productos where id=?').get(id)!;
      assert.deepEqual({ ...fila }, { nombre: 'Ropa', categoria: 'ropa', precio, precio_lista: 0, talla: 'M', stock: 2 });
      assert.ok(await t.env.FOTOS.get(`fotos/${id}.jpg`));
      const lista = (await t.pedir('/api/etiquetas', { ids: [id] })).cuerpo;
      const etiqueta = tsplEtiqueta(lista[0]);
      assert.ok(etiqueta.includes(`$${precio / 100}`));
      assert.ok(etiqueta.includes('M'));
    }
    const p = await pagina(t);
    await p.iniciarAutomatica();
    assert.equal(p.estado.enviadas.length, 7);
    assert.ok(p.estado.enviadas.every((p: any) => p.copias === 2));
  } finally { t.db.close(); }
});

test('ropa guarda nombre y marca con prenda+marca, solo prenda, solo marca o ninguna; rechaza datos invalidos', async () => {
  const t = tienda();
  try {
    t.env.AMBIENTE = 'sandbox';
    const casos = [
      [{ prenda: '  Sudadera ', marca: ' All in Motion  ' }, 'Sudadera All in Motion', 'All in Motion'],
      [{ prenda: 'Vestido' }, 'Vestido', ''],
      [{ marca: 'Universal Thread' }, 'Ropa Universal Thread', 'Universal Thread'],
      [{}, 'Ropa', ''],
    ] as const;
    for (const [datos, nombre, marca] of casos) {
      const id = crypto.randomUUID();
      assert.equal((await capturarRopa(t, id, '15000', datos)).status, 201);
      assert.deepEqual({ ...t.db.prepare('select nombre, marca from productos where id=?').get(id)! }, { nombre, marca });
    }
    for (const datos of [{ prenda: 'Abrigo' }, { prenda: 'Sudadera\n' }, { marca: 'x'.repeat(41) }, { marca: 'Marca\nX' }]) {
      const id = crypto.randomUUID();
      assert.equal((await capturarRopa(t, id, '15000', datos)).status, 400);
      assert.equal(t.db.prepare('select count(*) n from productos where id=?').get(id)!.n, 0);
    }
  } finally { t.db.close(); }
});

test('nombre largo de ropa cabe en los dos renglones actuales de AE240', () => {
  const [primero, segundo] = partirNombre('Traje de baño Universal Thread');
  assert.equal(primero, 'Traje de bano Universal Thread');
  assert.equal(segundo, undefined);
  assert.ok(primero.length <= NOMBRE_MAX);
  assert.ok(tsplEtiqueta({ codigo: 'ED-000001', nombre: 'Traje de baño Universal Thread', precio: 15000, precio_lista: 0, semana_ingreso: '2026-S41' }).includes('Universal Thread'));
});

test('precio de ropa en producción y sandbox con rol de captura; valores alterados no guardan foto ni producto', async () => {
  const t = tienda();
  try {
    const antes = t.db.prepare('select count(*) n from productos').get()!.n;
    const prod = crypto.randomUUID();
    assert.equal((await capturarRopa(t, prod, '20000')).status, 201);
    assert.equal(t.db.prepare('select precio from productos where id=?').get(prod)!.precio, 20000);
    t.env.AMBIENTE = 'sandbox';
    for (const precio of ['', 'NaN', '-5000', '5001', '19900', '50', '8000.5']) {
      const id = crypto.randomUUID();
      assert.equal((await capturarRopa(t, id, precio)).status, 400);
      assert.equal(await t.env.FOTOS.get(`fotos/${id}.jpg`), null);
    }
    assert.equal(t.db.prepare('select count(*) n from productos').get()!.n, antes + 1);
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en)
                  values ('caja@prueba.mx', 'Caja', 'cajero', 1, '', '')`).run();
    t.env.DEV_USUARIO = 'caja@prueba.mx';
    assert.equal((await capturarRopa(t, crypto.randomUUID(), '5000')).status, 403);
  } finally { t.db.close(); }
});

test('reintentar la foto de ropa no repone ventas ni pisa nombre, precio, talla o código ya revisados', async () => {
  const t = tienda();
  try {
    t.env.AMBIENTE = 'sandbox';
    const id = crypto.randomUUID();
    assert.equal((await capturarRopa(t, id, '20000')).status, 201);
    const codigo = (await t.pedir('/api/etiquetas', { ids: [id] })).cuerpo[0].codigo;
    t.db.prepare("update productos set stock=1, nombre='Camisa All in Motion', marca='All in Motion', precio=15000, talla='L' where id=?").run(id);
    assert.equal((await capturarRopa(t, id, '20000', { prenda: 'Playera', marca: 'Cat & Jack' })).status, 201);
    const fila = t.db.prepare('select nombre, marca, precio, stock, talla, codigo, estado_analisis from productos where id=?').get(id)!;
    assert.deepEqual({ ...fila }, { nombre: 'Camisa All in Motion', marca: 'All in Motion', precio: 15000, stock: 1, talla: 'L', codigo, estado_analisis: 'listo' });
  } finally { t.db.close(); }
});

const camara = readFileSync('public/captura.html', 'utf8');

test('cámara exige precio y talla y guarda la categoría junto a la foto antes de subir', async () => {
  const llamadas: string[] = [], guardadas: any[] = [];
  const contexto = {
    modoRopa: true, preciosRopa: [30000, 20000, 15000, 12000, 10000, 8000, 5000], precioRopa: null as number | null,
    panelPrecio: { classList: { add() { llamadas.push('falta precio'); } } }, document: { getElementById: () => ({ textContent: '' }) },
    selector: { valor: () => 'M', faltante() { assert.fail('talla ya elegida'); } },
    capturar: async () => { llamadas.push('foto'); contexto.precioRopa = 5000; return new Blob(['foto']); },
    guardar: async (p: any) => { llamadas.push('guardar'); guardadas.push(p); },
    pintarMiniatura() {}, actualizarContador() {}, procesarCola() { llamadas.push('subir'); },
    crypto, Date, estadoFisico: 'nuevo', cantidad: 2, tomadas: 0, piezasTotales: 0, prendaRopa: 'Sudadera', marcaRopa: 'All in Motion',
  };
  const disparar = runInNewContext(`${camara.slice(camara.indexOf('async function disparar()'), camara.indexOf('/* ---------- subida:'))}; disparar`, contexto);
  await disparar();
  assert.deepEqual(llamadas, ['falta precio']);
  contexto.precioRopa = 10000;
  await disparar();
  assert.deepEqual(llamadas.slice(1), ['foto', 'guardar', 'subir']);
  assert.equal(guardadas[0].precio_ropa, 10000);
  assert.equal(guardadas[0].talla, 'M');
  assert.equal(guardadas[0].cantidad, 2);
  assert.equal(guardadas[0].prenda, 'Sudadera');
  assert.equal(guardadas[0].marca, 'All in Motion');
});

test('una foto sin red o con sesión vencida conserva su precio local y lo reenvía al volver la conexión', async () => {
  const registro = { id: crypto.randomUUID(), foto: new Blob(['foto']), estado_fisico: 'nuevo', talla: 'M', cantidad: 1, precio_ropa: 5000 };
  const cola = new Map([[registro.id, registro]]), sesion = new Map([[registro.id, { ...registro, subida: false }]]);
  let sinRed = true, sesionVencida = false, precioEnviado: unknown;
  const procesar = runInNewContext(`${camara.slice(camara.indexOf('async function procesarCola()'), camara.indexOf('function actualizarContador()'))}; procesarCola`, {
    subiendo: false, idSubiendo: null, subidas: 0, idActual: null, sesion, FormData, preciosRopa: [5000],
    pendientes: async () => [...cola.values()], leer: async (id: string) => cola.get(id), borrar: async (id: string) => cola.delete(id),
    fetch: async (_ruta: string, opciones: any) => {
      if (sinRed) throw new Error('sin red');
      if (sesionVencida) return { ok: false, status: 403 };
      precioEnviado = opciones.body.get('precio_ropa');
      return { ok: true, status: 201, json: async () => ({ stock: 1, talla: 'M', precio: 5000 }) };
    }, repintarMiniatura() {}, actualizarContador() {}, abrirRevision() {}, setTimeout() {},
    piezasTotales: 1,
    document: { getElementById: () => ({ textContent: '' }) },
  });
  await procesar();
  assert.equal(cola.size, 1);
  assert.equal(cola.get(registro.id)!.precio_ropa, 5000);
  sinRed = false;
  sesionVencida = true;
  await procesar();
  assert.equal(cola.size, 1);
  sesionVencida = false;
  await procesar();
  assert.equal(precioEnviado, '5000');
  assert.equal(cola.size, 0);
});

test('automática imprime lo nuevo una sola vez, con código estable y una copia por existencia', async () => {
  const t = tienda();
  try {
    const vieja = agregar(t, ANTES), nueva = agregar(t, DESPUES, 'listo', 120);
    const p = await pagina(t);
    await p.iniciarAutomatica();
    await Promise.all([p.imprimirNuevas(), p.imprimirNuevas()]);
    assert.deepEqual(p.estado.enviadas, [{ id: nueva, copias: 120 }]);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(nueva)!.stock, 120);
    assert.equal(t.db.prepare('select codigo from productos where id=?').get(vieja)!.codigo, null);
    const codigo = t.db.prepare('select codigo from productos where id=?').get(nueva)!.codigo;
    assert.match(String(codigo), /^ED-\d+$/);
    assert.equal(p.almacen.has('etiqueta-automatica-dudosa'), false);
    const recarga = await pagina(t, 'sandbox', p.almacen);
    await recarga.iniciarAutomatica();
    assert.deepEqual(recarga.estado.enviadas, []);
    assert.equal(t.db.prepare('select codigo from productos where id=?').get(nueva)!.codigo, codigo);
  } finally { t.db.close(); }
});

test('corregir un precio reimprime una vez con el mismo código; condición sola y capturas eliminadas no imprimen', async () => {
  const t = tienda();
  try {
    t.env.AMBIENTE = 'sandbox';
    const id = crypto.randomUUID();
    await capturarRopa(t, id, '15000');
    const p = await pagina(t);
    await p.iniciarAutomatica();
    const codigo = t.db.prepare('select codigo from productos where id=?').get(id)!.codigo;
    assert.equal(p.estado.enviadas.length, 1);
    assert.equal((await t.pedir(`/api/borradores/${id}/revision`, { prenda: 'Sudadera', marca: 'All in Motion' }, 'PATCH')).status, 200);
    assert.deepEqual({ ...t.db.prepare('select nombre, marca from productos where id=?').get(id)! }, { nombre: 'Sudadera All in Motion', marca: 'All in Motion' });
    assert.equal((await t.pedir(`/api/borradores/${id}/revision`, { prenda: 'Abrigo' }, 'PATCH')).status, 400);
    await t.pedir(`/api/borradores/${id}/revision`, { precio: 8000, estado_fisico: 'danado' }, 'PATCH');
    await p.imprimirNuevas(); await p.imprimirNuevas();
    assert.equal(p.estado.enviadas.length, 2);
    assert.equal(JSON.parse(p.almacen.get('etiqueta-impresas')!)[id].precio, 8000);
    assert.equal(t.db.prepare('select codigo from productos where id=?').get(id)!.codigo, codigo);
    await t.pedir(`/api/borradores/${id}/revision`, { estado_fisico: 'nuevo' }, 'PATCH');
    await p.imprimirNuevas(); assert.equal(p.estado.enviadas.length, 2);
    await t.pedir(`/api/borradores/${id}/revision`, {}, 'DELETE');
    await p.imprimirNuevas(); assert.equal(p.estado.enviadas.length, 2);
    const otra = crypto.randomUUID();
    await capturarRopa(t, otra, '5000');
    p.estado.antesDePreparar = async () => { await t.pedir(`/api/borradores/${otra}/revision`, {}, 'DELETE'); };
    await p.imprimirNuevas(); assert.equal(p.estado.enviadas.length, 2);
  } finally { t.db.close(); }
});

test('espera el nombre y precio en orden; sin precio, con error o stock cero no manda etiqueta', async () => {
  const t = tienda();
  try {
    const primera = agregar(t, DESPUES, 'pendiente'), segunda = agregar(t);
    const p = await pagina(t);
    await p.iniciarAutomatica();
    assert.deepEqual(p.estado.enviadas, []);
    t.db.prepare("update productos set estado_analisis=?, precio=0, actualizado_en=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=?").run('listo', primera);
    await p.imprimirNuevas();
    assert.deepEqual(p.estado.enviadas, []);
    t.db.prepare("update productos set estado_analisis=?, actualizado_en=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=?").run('error', primera);
    await p.imprimirNuevas();
    assert.match(p.$('resumen').textContent, /revisión/);
    t.db.prepare("update productos set estado_analisis=?, precio=7900, actualizado_en=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=?").run('listo', primera);
    await p.imprimirNuevas();
    assert.deepEqual(p.estado.enviadas.map((p: any) => p.id), [primera, segunda]);
    agregar(t, DESPUES, 'listo', 0);
    await p.imprimirNuevas();
    assert.equal(p.estado.enviadas.length, 2);
  } finally { t.db.close(); }
});

test('la automática solo imprime ropa: mercancía general sin precio o nombre no detiene la cola (#335)', async () => {
  const t = tienda();
  try {
    const sinPrecio = agregar(t, DESPUES), sinNombre = agregar(t, DESPUES), error = agregar(t, DESPUES, 'error'), conPrecio = agregar(t, DESPUES);
    t.db.prepare("update productos set categoria='hogar', precio=0 where id=?").run(sinPrecio);
    t.db.prepare("update productos set categoria='hogar', nombre='' where id=?").run(sinNombre);
    t.db.prepare("update productos set categoria='hogar' where id in (?, ?)").run(error, conPrecio);
    const ropa = agregar(t, '2026-10-11T17:00:00.000Z');
    const p = await pagina(t);
    await p.iniciarAutomatica();
    // Ni siquiera la general lista con precio sale sola: se imprime a mano.
    assert.deepEqual(p.estado.enviadas, [{ id: ropa, copias: 1 }]);
    assert.equal(t.db.prepare('select codigo from productos where id=?').get(conPrecio)!.codigo, null);
    assert.equal(p.activa(), true);
  } finally { t.db.close(); }
});

test('lo escaneado sale al cerrar sus 5 minutos de corrección, con la cantidad final y en orden (#369)', async () => {
  const t = tienda();
  try {
    const ahora = new Date().toISOString();
    const escaneada = agregar(t, ahora, 'listo', 2), ropa = agregar(t, ahora);
    t.db.prepare("update productos set categoria='hogar', nombre='Estuche Yoobi', upc='0191907910414', capturado_por=?, creado_en=? where id=?")
      .run(DUENO, new Date(Date.now() - 1000).toISOString(), escaneada);
    const p = await pagina(t);
    await p.iniciarAutomatica();
    // Dentro de la ventana no sale nada, ni la ropa que viene detrás en la mesa.
    assert.deepEqual(p.estado.enviadas, []);
    assert.match(p.$('resumen').textContent, /corrección de cantidad de: Estuche Yoobi/);
    assert.equal((await t.pedir(`/api/borradores/${escaneada}/existencia`, { stock: 3 }, 'PATCH')).status, 200);
    // Cerrada la ventana el servidor ya no acepta cambios y se imprime la cantidad corregida.
    const vieja = new Date(Date.now() - CORRECCION_ESCANER_MS - 60_000).toISOString();
    t.db.prepare("update productos set creado_en=?, actualizado_en=? where id=?").run(vieja, new Date().toISOString(), escaneada);
    assert.equal((await t.pedir(`/api/borradores/${escaneada}/existencia`, { stock: 9 }, 'PATCH')).status, 404);
    await p.imprimirNuevas();
    assert.deepEqual(p.estado.enviadas, [{ id: escaneada, copias: 3 }, { id: ropa, copias: 1 }]);
    // La foto sin UPC conserva sus 24 horas.
    t.db.prepare("update productos set capturado_por=?, creado_en=? where id=?").run(DUENO, vieja, ropa);
    assert.equal((await t.pedir(`/api/borradores/${ropa}/existencia`, { stock: 2 }, 'PATCH')).status, 200);
  } finally { t.db.close(); }
});

test('si una prenda espera su precio, el aviso dice cuál es y a qué hora se capturó', async () => {
  const t = tienda();
  try {
    const pieza = agregar(t, DESPUES, 'pendiente');
    t.db.prepare("update productos set nombre='Chamarra azul', precio=0 where id=?").run(pieza);
    const p = await pagina(t);
    await p.iniciarAutomatica();
    const hora = new Date(DESPUES).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    assert.equal(p.$('resumen').textContent, `Esperando precio de: Chamarra azul (capturada ${hora}).`);
    t.db.prepare("update productos set nombre='', estado_analisis='error', actualizado_en=strftime('%Y-%m-%dT%H:%M:%fZ','now') where id=?").run(pieza);
    await p.imprimirNuevas();
    assert.ok(p.$('resumen').textContent.includes(`revisión: pieza sin nombre (capturada ${hora})`));
    assert.deepEqual(p.estado.enviadas, []);
  } finally { t.db.close(); }
});

test('fallo de BLE pausa y una recarga no reenvía una pieza incierta', async () => {
  const t = tienda();
  try {
    const id = agregar(t);
    const p = await pagina(t);
    p.estado.falloBle = true;
    await p.iniciarAutomatica();
    assert.equal(p.activa(), false);
    assert.equal(p.almacen.get('etiqueta-automatica-dudosa'), id);
    assert.equal(p.almacen.has('etiqueta-impresas'), false);
    const recarga = await pagina(t, 'sandbox', p.almacen);
    await recarga.iniciarAutomatica();
    assert.deepEqual(recarga.estado.enviadas, []);
    assert.match(recarga.$('resumen').textContent, /incierto/);
    await recarga.imprimir([id]);
    assert.equal(p.almacen.has('etiqueta-automatica-dudosa'), false);
    await recarga.iniciarAutomatica();
    assert.equal(recarga.estado.enviadas.length, 1);
  } finally { t.db.close(); }
});

test('sin red pausa sin perder la sesión; al retomar imprime la pendiente', async () => {
  const t = tienda();
  try {
    const p = await pagina(t);
    await p.iniciarAutomatica();
    const id = agregar(t);
    p.estado.falloRed = true;
    await p.imprimirNuevas();
    assert.equal(p.activa(), false);
    assert.deepEqual(p.estado.enviadas, []);
    p.estado.falloRed = false;
    await p.iniciarAutomatica();
    assert.deepEqual(p.estado.enviadas, [{ id, copias: 1 }]);
  } finally { t.db.close(); }
});

test('producción ofrece automática sin imprimir inventario anterior; desconexión no abre un selector desde el timer', async () => {
  const t = tienda(), sandbox = tienda();
  try {
    agregar(t, ANTES);
    const prod = await pagina(t, 'produccion');
    await prod.iniciarAutomatica();
    assert.equal(prod.$('automatica').hidden, false);
    assert.equal(prod.activa(), true);
    assert.equal(prod.estado.permiso, 0);
    assert.deepEqual(prod.estado.enviadas, []);
    const nueva = agregar(t);
    await prod.imprimirNuevas();
    assert.deepEqual(prod.estado.enviadas, [{ id: nueva, copias: 1 }]);
    const p = await pagina(sandbox);
    await p.iniciarAutomatica();
    agregar(sandbox);
    p.estado.conectada = false;
    await p.imprimirNuevas();
    assert.equal(p.activa(), false);
    assert.equal(p.estado.permiso, 0);
    assert.deepEqual(p.estado.enviadas, []);
  } finally { t.db.close(); sandbox.db.close(); }
});

test('Detener durante la preparación evita el envío y una marca fallida conserva la recuperación', async () => {
  const t = tienda();
  try {
    const id = agregar(t);
    const p = await pagina(t);
    p.estado.antesDePreparar = async () => p.$('detener').eventos.get('click')();
    await p.iniciarAutomatica();
    assert.deepEqual(p.estado.enviadas, []);
    assert.equal(p.activa(), false);
    p.estado.antesDePreparar = null;
    p.estado.falloMarca = true;
    await p.iniciarAutomatica();
    assert.equal(p.almacen.get('etiqueta-automatica-dudosa'), id);
    assert.equal(p.activa(), false);
  } finally { t.db.close(); }
});

test('cambios trae solo lo modificado de la sesión, incluidas las descartadas (cuota de D1, 15/10)', async () => {
  const t = tienda();
  try {
    const vieja = agregar(t), cambiada = agregar(t), quitada = agregar(t);
    t.db.prepare("update productos set actualizado_en='2026-10-11T16:00:00.000Z' where id in (?, ?, ?)").run(vieja, cambiada, quitada);
    t.db.prepare("update productos set precio=9900, actualizado_en='2026-10-11T17:00:00.000Z' where id=?").run(cambiada);
    t.db.prepare("update productos set estado_analisis='descartado', actualizado_en='2026-10-11T17:00:00.000Z' where id=?").run(quitada);
    const r = await t.pedir(`/api/borradores?desde=${DESDE}&cambios=2026-10-11T16:30:00.000Z`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.cuerpo.map((p: any) => [p.id, p.estado_analisis]).sort(), [[cambiada, 'listo'], [quitada, 'descartado']].sort());
    assert.equal((await t.pedir(`/api/borradores?desde=${DESDE}&cambios=ayer`)).status, 400);
    // Sin `cambios`, la lista de siempre: sin descartadas.
    assert.equal((await t.pedir(`/api/borradores?desde=${DESDE}`)).cuerpo.some((p: any) => p.id === quitada), false);
  } finally { t.db.close(); }
});
