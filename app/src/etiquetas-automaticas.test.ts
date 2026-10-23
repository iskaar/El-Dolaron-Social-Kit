// Worker + SQLite y el script real de /etiquetas, con BLE simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tienda, DUENO } from './prueba-d1.ts';
import worker from './worker.ts';
import { tsplEtiqueta, etiquetaVigente, partirNombre, NOMBRE_MAX, precioImpreso, textoImpreso, gradoImpreso, impresas as marcasReales, marcarImpresa as marcarReal,
  desmarcarDesde as desmarcarReal, olvidarMarca as olvidarReal, adoptarMarca as adoptarReal, adoptarMarcas as adoptarVarias, esPropia } from '../public/etiquetera.js';
import { esRopa } from '../public/ropa.js';
import { nombreEstado } from '../public/estados.js';

const modulo = readFileSync('public/imprimir-lote.js', 'utf8');
const fuente = readFileSync('public/envio-etiquetas.js', 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\n'
  + modulo.slice(modulo.indexOf('const lista ='), modulo.lastIndexOf('return { imprimir, pintar, cargar'));
const DESDE = '2026-10-11T15:00:00.000Z';
const ANTES = '2026-10-11T14:00:00.000Z';
const DESPUES = '2026-10-11T16:00:00.000Z';

test('/api/etiquetas conserva categoría al imprimir y reimprimir: Ropa sin grado y MG con grado', async t0 => {
  const t = tienda(); t0.after(() => t.db.close());
  const ropa = agregar(t), mg = agregar(t);
  t.db.prepare("update productos set categoria='hogar',estado_fisico='danado' where id=?").run(mg);
  assert.equal(t.db.prepare('select estado_fisico from productos where id=?').get(ropa)!.estado_fisico, 'nuevo');
  let codigos: string[] | undefined;
  for (let intento = 0; intento < 2; intento++) {
    const r = await t.pedir('/api/etiquetas', { ids: [ropa, mg] });
    assert.equal(r.status, 200);
    const prendas = r.cuerpo.filter((p: any) => p.categoria === 'ropa');
    const generales = r.cuerpo.filter((p: any) => p.categoria === 'hogar');
    assert.equal(prendas.length, 1); assert.equal(generales.length, 1);
    assert.doesNotMatch(tsplEtiqueta(prendas[0]), /^BOX |,"4",0,1,1,"[ABC]"/m);
    assert.match(tsplEtiqueta(generales[0]), /,"4",0,1,1,"B"/);
    const actuales = r.cuerpo.map((p: any) => p.codigo);
    if (codigos) assert.deepEqual(actuales, codigos);
    codigos = actuales;
  }
});

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

/** Una peticion al Worker por el host de la PC (`caja.prueba`) o por el del celular (`captura.prueba`, el HOST_VENDEDOR). */
function pedirPor(t: ReturnType<typeof tienda>, host: string) {
  return async (ruta: string, cuerpo?: unknown, metodo = 'POST') => {
    if (host === CELULAR) t.env.HOST_VENDEDOR = CELULAR;
    const r = await worker.fetch!(new Request(`https://${host}${ruta}`, cuerpo === undefined ? {} : {
      method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) }) as never, t.env, t.ctx as never);
    return { status: r.status, cuerpo: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
}
const CELULAR = 'captura.prueba';

/**
 * El script real de /etiquetas (motor + envio-etiquetas.js) con BLE simulado y la base de verdad detras. Las marcas locales
 * usan las funciones reales de etiquetera.js sobre el almacenamiento de ESTA pagina; solo el reclamo y la liberacion
 * (que son fetch) pasan por el Worker real, por el host de la PC o por el del celular.
 */
async function pagina(t: ReturnType<typeof tienda>, ambiente = 'sandbox', almacen = new Map<string, string>(), host = 'caja.prueba') {
  const elementos = new Map<string, any>();
  const $ = (id: string) => {
    if (!elementos.has(id)) elementos.set(id, { textContent: '', hidden: false, disabled: false, innerHTML: '', style: {},
      eventos: new Map(), addEventListener(evento: string, fn: any) { this.eventos.set(evento, fn); }, querySelectorAll: () => [] });
    return elementos.get(id);
  };
  const estado = { conectada: true, falloBle: false, falloRed: false, falloMarca: false, permiso: 0, exigirDudosa: true,
    enviadas: [] as { id: string; copias: number }[], detenido: false, antesDePreparar: null as null | (() => Promise<void>),
    reclamos: [] as { ids: string[]; reimprimir?: boolean }[], liberadas: [] as string[][], antesDeReclamar: null as null | (() => void | Promise<void>),
    sinRedParaReclamar: false, tiempoAgotado: false, liberadasEn: [] as (Record<string, string> | null)[] };
  const pedir = pedirPor(t, host);
  const almacenWeb = { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => almacen.set(k, v), removeItem: (k: string) => almacen.delete(k) };
  /** Las funciones de etiquetera.js leen globalThis.localStorage: aqui apunta al almacenamiento de esta pagina mientras corren. */
  const conAlmacen = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => {
    const previo = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { value: almacenWeb, configurable: true, writable: true });
    try { return fn(...a); } finally { if (previo) Object.defineProperty(globalThis, 'localStorage', previo); else delete (globalThis as any).localStorage; }
  };
  const marcas = conAlmacen(marcasReales);
  const contexto: Record<string, any> = {
    vista: null, document: { getElementById: $ }, navigator: { bluetooth: {}, locks: { request: async (_nombre: string, _opciones: any, fn: any) => fn({}) } },
    localStorage: almacenWeb,
    fetch: async (ruta: string, opciones?: any) => {
      if (estado.falloRed) throw new Error('sin red');
      if (ruta === '/api/salud') return { ok: true, json: async () => ({ estado: 'ok', ambiente, ahora: DESDE }) };
      if (ruta === '/api/etiquetas') await estado.antesDePreparar?.();
      const r = await pedir(ruta, opciones?.body ? JSON.parse(opciones.body) : undefined, opciones?.method);
      return { ok: r.status < 300, status: r.status, json: async () => r.cuerpo };
    },
    conectarEtiquetera: async () => { estado.permiso++; estado.conectada = true; }, etiqueteraLista: () => estado.conectada,
    imprimirEtiquetas: async (p: any, copias: number, avanzar: any) => {
      if (estado.exigirDudosa) assert.equal(almacen.get('etiqueta-automatica-dudosa'), p.id);
      estado.enviadas.push({ id: p.id, copias });
      // Como el real: falla (false) solo si salieron menos de las pedidas, y la primera etiqueta ya pudo haber salido.
      if (estado.falloBle) { if (copias > 1) avanzar(1); return false; }
      avanzar(1);
      return true;
    },
    impresas: marcas, marcarImpresa: (...a: Parameters<typeof marcarReal>) => { if (!estado.falloMarca) conAlmacen(marcarReal)(...a); },
    etiquetaVigente, precioImpreso, textoImpreso, gradoImpreso, esPropia, esRopa, nombreEstado, historialTexto: () => '',
    desmarcarDesde: conAlmacen(desmarcarReal), olvidarMarca: conAlmacen(olvidarReal), adoptarMarca: conAlmacen(adoptarReal), adoptarMarcas: conAlmacen(adoptarVarias),
    // El reclamo y la liberacion de etiquetera.js, contra el Worker real; sin red lanzan / devuelven false como los reales.
    reclamarEtiquetas: async (ids: string[], opciones: { reimprimir?: boolean; version?: string } = {}) => {
      estado.reclamos.push({ ids, reimprimir: opciones.reimprimir });
      await estado.antesDeReclamar?.();
      if (estado.tiempoAgotado) throw new Error('La base no respondió a tiempo. No se imprimió: revisa la red e intenta otra vez.');   // sin `sinRed`, como el real
      if (estado.falloRed || estado.sinRedParaReclamar) throw Object.assign(new Error('Sin red: sin red'), { sinRed: true });
      const r = await pedir('/api/etiquetas/enviadas', { ids, origen: host === CELULAR ? 'celular' : 'pc', ...opciones });
      if (r.status >= 300) throw new Error(r.cuerpo.error);
      return r.cuerpo;
    },
    // Igual que el real: con `en` solo se sueltan las piezas con hora de reclamo, y la hora viaja en `etiquetas_en`.
    soltarEtiquetas: async (ids: string[], en: Record<string, string> | null = null) => {
      estado.liberadas.push(ids); estado.liberadasEn.push(en);
      if (estado.falloRed) return false;
      const sueltas = en ? ids.filter((id) => en[id]) : ids;
      if (!sueltas.length) return true;
      return (await pedir('/api/etiquetas/enviadas', en ? { ids: sueltas, etiquetas_en: Object.fromEntries(sueltas.map((id) => [id, en[id]])) } : { ids: sueltas }, 'DELETE')).status === 200;
    },
    detenerEnvio: (valor = true) => { estado.detenido = valor; }, envioDetenido: () => estado.detenido, errorEnvio: () => 'BLE falló',
    setInterval() {}, AbortSignal, encodeURIComponent, Date, Map, Set, console,
  };
  const api = await runInNewContext(`(async () => { ${fuente}
    return { iniciarAutomatica, imprimirNuevas, imprimir, pausarAutomatica, cargar, noSalio, activa: () => automaticaActiva };
  })()`, contexto);
  return { ...api, estado, $, almacen, marcas };
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

test('corregir un precio reimprime una vez con el mismo código; solo el grado de MG reimprime; capturas eliminadas no imprimen', async () => {
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
    // Ropa no lleva grado: B a A no vuelve a imprimir ni altera la marca guardada.
    await t.pedir(`/api/borradores/${id}/revision`, { estado_fisico: 'nuevo' }, 'PATCH');
    await p.imprimirNuevas(); await p.imprimirNuevas(); assert.equal(p.estado.enviadas.length, 2);
    assert.equal(JSON.parse(p.almacen.get('etiqueta-impresas')!)[id].estado_fisico, 'danado');
    // MG escaneada sí conserva la reimpresión por grado y el mismo código.
    t.db.prepare("update productos set categoria='hogar',upc='012345678905' where id=?").run(id);
    await p.imprimirNuevas(); await p.imprimirNuevas(); assert.equal(p.estado.enviadas.length, 3);
    assert.equal(JSON.parse(p.almacen.get('etiqueta-impresas')!)[id].estado_fisico, 'nuevo');
    assert.equal(t.db.prepare('select codigo from productos where id=?').get(id)!.codigo, codigo);
    await t.pedir(`/api/borradores/${id}/revision`, {}, 'DELETE');
    await p.imprimirNuevas(); assert.equal(p.estado.enviadas.length, 3);
    const otra = crypto.randomUUID();
    await capturarRopa(t, otra, '5000');
    p.estado.antesDePreparar = async () => { await t.pedir(`/api/borradores/${otra}/revision`, {}, 'DELETE'); };
    await p.imprimirNuevas(); assert.equal(p.estado.enviadas.length, 3);
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

test('lo escaneado sale en cuanto se guarda, sin detener lo demás; se corrige o cancela solo mientras se identifica (#375, #377, #381)', async () => {
  const t = tienda();
  try {
    const ahora = new Date().toISOString();
    const sinFoto = agregar(t, ahora, 'error'), escaneada = agregar(t, ahora, 'listo', 2), ropa = agregar(t, ahora);
    t.db.prepare("update productos set nombre='', precio=0, upc='7501055320639', capturado_por=? where id=?").run(DUENO, sinFoto);
    t.db.prepare("update productos set categoria='hogar', nombre='Estuche Yoobi', upc='0191907910414', capturado_por=? where id=?")
      .run(DUENO, escaneada);
    const p = await pagina(t);
    await p.iniciarAutomatica();
    // La escaneada lista sale de inmediato con su cantidad; la que espera foto no detiene la ropa de atrás.
    assert.deepEqual(p.estado.enviadas, [{ id: escaneada, copias: 2 }, { id: ropa, copias: 1 }]);
    assert.equal(p.activa(), true);
    // Ya con etiqueta no se corrige ni se cancela desde el escáner.
    assert.equal((await t.pedir(`/api/borradores/${escaneada}/existencia`, { stock: 3 }, 'PATCH')).status, 404);
    assert.equal((await t.pedir(`/api/borradores/${escaneada}/existencia`, { stock: 0 }, 'PATCH')).status, 404);
    // La que aún espera foto sí: cambia su cantidad y en 0 sale de la cola.
    assert.equal((await t.pedir(`/api/borradores/${sinFoto}/existencia`, { stock: 3 }, 'PATCH')).status, 200);
    assert.equal((await t.pedir(`/api/borradores/${sinFoto}/existencia`, { stock: 0 }, 'PATCH')).cuerpo.descartado, true);
    assert.deepEqual({ ...t.db.prepare('select stock, estado_analisis from productos where id=?').get(sinFoto)! }, { stock: 0, estado_analisis: 'descartado' });
    // La foto sin UPC conserva sus 24 horas.
    t.db.prepare("update productos set capturado_por=? where id=?").run(DUENO, ropa);
    assert.equal((await t.pedir(`/api/borradores/${ropa}/existencia`, { stock: 2, esperado: 1 }, 'PATCH')).status, 200);   // listo: con la existencia vista (#468)
  } finally { t.db.close(); }
});

test('alta solo con foto desde el escáner: se guarda sin código y se imprime sola como lo escaneado (#379)', async (prueba) => {
  prueba.mock.method(globalThis, 'fetch', async () => { throw new Error('sin red en pruebas'); });
  const t = tienda();
  try {
    const id = crypto.randomUUID(), cuerpo = new FormData();
    cuerpo.set('id', id); cuerpo.set('upc', ''); cuerpo.set('cantidad', '2'); cuerpo.set('estado_fisico', 'nuevo');
    cuerpo.set('foto', new File([new Uint8Array([255, 216, 255])], 'foto.jpg', { type: 'image/jpeg' }));
    const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: cuerpo }) as never, t.env, t.ctx as never);
    assert.equal(r.status, 201);
    await t.esperar();   // el análisis falla sin llave; que termine antes de cerrar la base
    assert.equal(t.db.prepare('select upc from productos where id=?').get(id)!.upc, '');
    const malo = new FormData();
    for (const [k, v] of cuerpo) malo.set(k, v);
    malo.set('id', crypto.randomUUID()); malo.set('upc', 'abc');
    assert.equal((await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: malo }) as never, t.env, { waitUntil() {} } as never)).status, 400);
    // Ya analizada sale sola; una foto general de /captura (upc nulo) no.
    const vieja = new Date(Date.now() - 60_000).toISOString();
    t.db.prepare("update productos set nombre='Lámpara de mesa', categoria='hogar', precio=19900, estado_analisis='listo', creado_en=? where id=?").run(vieja, id);
    const general = agregar(t, vieja);
    t.db.prepare("update productos set categoria='hogar' where id=?").run(general);
    const p = await pagina(t);
    await p.iniciarAutomatica();
    assert.deepEqual(p.estado.enviadas, [{ id, copias: 2 }]);
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

test('la automática no se pausa si la única pieza se descartó entre listar y preparar, pero a mano esa pieza sigue sin salir (#468)', async () => {
  const t = tienda();
  try {
    const id = agregar(t);
    const p = await pagina(t);
    p.estado.antesDePreparar = async () => { t.db.prepare("update productos set estado_analisis='descartado' where id=?").run(id); };
    await p.iniciarAutomatica();
    assert.deepEqual(p.estado.enviadas, []);
    assert.equal(p.activa(), true, 'sin falla de impresión no hay motivo para pausar');
    // A mano no cambia: nada salió, y quien llama no debe anunciar «Etiqueta enviada».
    assert.equal(await p.imprimir([id]), false);
    // Una falla real de la impresora sí pausa.
    p.estado.antesDePreparar = null;
    const otra = agregar(t);
    p.estado.falloBle = true;
    await p.imprimirNuevas();
    assert.deepEqual(p.estado.enviadas, [{ id: otra, copias: 1 }]);
    assert.equal(p.activa(), false);
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

/* ---------- la PC y el celular se reparten las etiquetas (#440) ---------- */

const CELULAR_HOST = 'captura.prueba';
const espera = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/** Dos dispositivos con su propio almacenamiento: la PC y el celular del capturista (mismo usuario de prueba). */
async function dosDispositivos(t: ReturnType<typeof tienda>) {
  const pc = await pagina(t), celular = await pagina(t, 'produccion', new Map(), CELULAR_HOST);
  pc.estado.exigirDudosa = celular.estado.exigirDudosa = false;   // a mano no hay sesión automática
  return { pc, celular };
}

test('PC y celular nunca sacan la misma etiqueta: el segundo la omite, también si piden a la vez', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const uno = agregar(t, DESPUES, 'listo', 2);
    assert.equal(await celular.imprimir([uno], new Map([[uno, 2]])), true);
    assert.deepEqual(celular.estado.enviadas, [{ id: uno, copias: 2 }]);
    assert.equal(await pc.imprimir([uno], new Map([[uno, 2]])), true);
    assert.deepEqual(pc.estado.enviadas, []);   // ya la sacó el celular
    assert.match(pc.$('resumen').textContent, /0 piezas enviadas; 1 ya las había enviado otro dispositivo/);
    // La PC adoptó la marca: la pieza sale de su lista y ya no es candidata.
    assert.equal(pc.marcas()[uno].base, true);
    assert.equal(t.db.prepare('select etiqueta_origen o from etiquetas_enviadas where producto_id=?').get(uno)!.o, 'celular');
    for (let i = 0; i < 10; i++) {
      const id = agregar(t, DESPUES, 'listo', 1);
      await Promise.all([pc.imprimir([id]), celular.imprimir([id])]);
      assert.equal(pc.estado.enviadas.filter((e) => e.id === id).length + celular.estado.enviadas.filter((e) => e.id === id).length, 1, `ronda ${i}`);
    }
  } finally { t.db.close(); }
});

test('si la etiqueta no salió («No salió») se libera el reclamo y la PC o el celular pueden sacarla', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 1);
    celular.estado.falloBle = true;
    assert.equal(await celular.imprimir([id]), false);
    assert.deepEqual(celular.estado.liberadas.map((l) => [...l]), [[id]]);
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);
    assert.equal(celular.marcas()[id], undefined);
    assert.equal(await pc.imprimir([id]), true);
    assert.deepEqual(pc.estado.enviadas, [{ id, copias: 1 }]);
    // Si además la base no responde al liberar, el aviso lo dice en vez de callar.
    const otra = agregar(t, DESPUES, 'listo', 1);
    celular.estado.antesDeReclamar = () => { celular.estado.falloRed = true; };
    celular.estado.sinRedParaReclamar = true;
    assert.equal(await celular.imprimir([otra]), false);   // la impresora sigue fallando; sin base no hay nada que liberar
    celular.estado.antesDeReclamar = null; celular.estado.falloRed = false; celular.estado.sinRedParaReclamar = false;
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(otra)!.n, 0);
  } finally { t.db.close(); }
});

test('una reimpresión explícita sí sale y actualiza el reclamo; la marca vigente de esta pantalla también la fuerza', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 3);
    await pc.imprimir([id]);
    assert.equal(pc.estado.enviadas.length, 1);
    // Reimprimir (Buscar, ficha): el celular no tiene marca, pero lo pide a conciencia.
    await espera(5);
    assert.equal(await celular.imprimir([id], new Map([[id, 1]]), false, { reimprimir: true }), true);
    assert.deepEqual(celular.estado.enviadas, [{ id, copias: 1 }]);
    assert.equal(celular.estado.reclamos.at(-1)!.reimprimir, true);
    assert.equal(t.db.prepare('select etiqueta_origen o from etiquetas_enviadas where producto_id=?').get(id)!.o, 'celular');
    // La PC tiene su marca vigente: elegir esa fila en la lista es reimprimirla a propósito; un envío programático no.
    await pc.imprimir([id], new Map([[id, 1]]));
    assert.equal(pc.estado.enviadas.length, 1);
    await pc.imprimir([id], new Map([[id, 1]]), false, { deLista: true });
    assert.equal(pc.estado.enviadas.length, 2);
    assert.equal(pc.estado.reclamos.at(-1)!.reimprimir, true);
    // Una pantalla sin marca y sin pedirlo no repite lo ya enviado.
    const tercera = await pagina(t, 'produccion', new Map(), CELULAR_HOST);
    tercera.estado.exigirDudosa = false;
    await tercera.imprimir([id]);
    assert.deepEqual(tercera.estado.enviadas, []);
  } finally { t.db.close(); }
});

test('+1 a una pieza ya reclamada imprime 1 etiqueta de la unidad nueva; sin pedirlo, no se repite', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 4);
    await pc.imprimir([id], new Map([[id, 4]]));
    t.db.prepare('update productos set stock = 5 where id = ?').run(id);   // el +1 que hizo el servidor
    assert.equal(await celular.imprimir([id], new Map([[id, 1]]), false, { reimprimir: true }), true);
    assert.deepEqual(celular.estado.enviadas, [{ id, copias: 1 }]);
    // Reescanear la misma pieza sin sumar nada (mismo papel) no vuelve a sacar la etiqueta.
    const otro = await pagina(t, 'produccion', new Map(), CELULAR_HOST);
    otro.estado.exigirDudosa = false;
    await otro.imprimir([id], new Map([[id, 1]]));
    assert.deepEqual(otro.estado.enviadas, []);
  } finally { t.db.close(); }
});

test('una pieza que cambió de precio se reimprime una sola vez entre PC y celular, sin forzar', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 1);
    await pc.imprimir([id]); await celular.cargar();
    t.db.prepare('update productos set precio = 9900 where id = ?').run(id);
    await Promise.all([pc.imprimir([id]), celular.imprimir([id])]);
    assert.equal(pc.estado.enviadas.length + celular.estado.enviadas.length, 2);   // la original y UNA con el precio nuevo
    assert.equal(t.db.prepare('select etiqueta_precio p from etiquetas_enviadas where producto_id=?').get(id)!.p, 9900);
  } finally { t.db.close(); }
});

test('sin red al reclamar se imprime con la marca local y se sube después; la carga adopta y suelta lo de otros', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 1);
    celular.estado.sinRedParaReclamar = true;
    assert.equal(await celular.imprimir([id]), true);
    assert.deepEqual(celular.estado.enviadas, [{ id, copias: 1 }]);
    assert.equal(celular.marcas()[id].base, undefined);   // solo local
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);
    // Con red otra vez, la carga sube esa marca y la PC ya no la repite.
    celular.estado.sinRedParaReclamar = false;
    await celular.cargar(); await espera();
    assert.equal(t.db.prepare('select etiqueta_origen o from etiquetas_enviadas where producto_id=?').get(id)!.o, 'celular');
    assert.equal(celular.marcas()[id].base, true);
    await pc.imprimir([id]);
    assert.deepEqual(pc.estado.enviadas, []);
    // La PC la suelta («No salió»): al cargar, el celular olvida su marca de la base.
    await espera(5);
    t.db.prepare('delete from etiquetas_enviadas where producto_id=?').run(id);
    await celular.cargar();
    assert.equal(celular.marcas()[id], undefined);
    // Una marca de antes del registro (sin base) se sube sola; no se suelta por no estar en la base.
    const vieja = agregar(t, DESPUES, 'listo', 1);
    await pc.imprimir([vieja]);
    t.db.prepare('delete from etiquetas_enviadas where producto_id=?').run(vieja);
    const marcas = JSON.parse(pc.almacen.get('etiqueta-impresas')!);
    delete marcas[vieja].base;
    pc.almacen.set('etiqueta-impresas', JSON.stringify(marcas));
    await pc.cargar(); await espera();
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(vieja)!.n, 1);
    assert.equal(pc.marcas()[vieja].base, true);
  } finally { t.db.close(); }
});

test('si la pieza cambia entre preparar y reclamar no se imprime a ciegas', async () => {
  const t = tienda();
  try {
    const { pc } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 1);
    pc.estado.antesDeReclamar = () => { t.db.prepare('update productos set precio = 9900 where id = ?').run(id); };
    assert.equal(await pc.imprimir([id]), false);
    assert.deepEqual(pc.estado.enviadas, []);
    assert.match(pc.$('resumen').textContent, /cambió antes de imprimir/);
    pc.estado.antesDeReclamar = null;
    assert.equal(await pc.imprimir([id]), true);
    assert.deepEqual(pc.estado.enviadas, [{ id, copias: 1 }]);
  } finally { t.db.close(); }
});

test('«No salió desde aquí» no suelta lo que otro dispositivo sacó (marca adoptada), ni la base ni la marca (#464)', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const propia = agregar(t, DESPUES, 'listo', 1), ajena = agregar(t, DESPUES, 'listo', 1);
    await celular.imprimir([propia]); await espera(5);
    await pc.imprimir([ajena]);
    await celular.cargar();   // el celular adopta la de la PC, con una hora posterior a la suya
    assert.equal(celular.marcas()[ajena].propia, false);
    assert.equal(await celular.noSalio(ajena), true);
    assert.ok(celular.marcas()[ajena], 'la marca adoptada se queda');
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(ajena)!.n, 1, 'el reclamo de la PC se queda');
    assert.deepEqual(celular.estado.liberadas, []);
    // Lo suyo sí se suelta, y solo lo suyo: la adoptada posterior sigue puesta.
    assert.equal(await celular.noSalio(propia), true);
    assert.equal(celular.marcas()[propia], undefined);
    assert.ok(celular.marcas()[ajena]);
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 1);
    assert.deepEqual(celular.estado.liberadas.map((l) => [...l]), [[propia]]);
  } finally { t.db.close(); }
});

test('«No salió desde aquí» no borra el reclamo que otro dispositivo hizo después del suyo (#464)', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 2);
    await celular.imprimir([id]); await espera(5);
    await pc.imprimir([id], new Map(), false, { reimprimir: true });   // la PC reimprime: el reclamo vigente es el suyo
    const reclamoPc = t.db.prepare('select etiqueta_en e, etiqueta_origen o from etiquetas_enviadas where producto_id=?').get(id)!;
    assert.equal(reclamoPc.o, 'pc');
    assert.equal(await celular.noSalio(id), true);
    assert.equal(celular.marcas()[id], undefined, 'aquí sí regresa a la lista');
    assert.equal(t.db.prepare('select etiqueta_en e from etiquetas_enviadas where producto_id=?').get(id)!.e, reclamoPc.e, 'el reclamo de la PC sigue');
  } finally { t.db.close(); }
});

test('una pieza vendida no estorba: sale de la lista y el lote sigue sin ella (#464)', async () => {
  const t = tienda();
  try {
    const { celular } = await dosDispositivos(t);
    const vendida = agregar(t, DESPUES, 'listo', 0), buena = agregar(t, DESPUES, 'listo', 2);
    await celular.cargar();
    const lista = celular.$('lista').innerHTML;
    assert.ok(lista.includes(buena)); assert.ok(!lista.includes(vendida), 'lo vendido no se lista');
    // Aun si llega al lote (lista vieja), se salta y se cuenta; no aborta.
    assert.equal(await celular.imprimir([vendida, buena], new Map([[buena, 2]])), true);
    assert.deepEqual(celular.estado.enviadas, [{ id: buena, copias: 2 }]);
    assert.deepEqual(celular.estado.reclamos.map((r) => [...r.ids]), [[buena]], 'ni siquiera se pide a la base');
    assert.match(celular.$('resumen').textContent, /1 pieza ya no se puede imprimir \(vendidas o cambiaron\)/);
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(vendida)!.n, 0);
  } finally { t.db.close(); }
});

test('una reimpresión forzada que falla conserva el registro de las etiquetas ya pegadas (#464)', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 3);
    await pc.imprimir([id], new Map([[id, 2]]));
    t.db.prepare('update productos set stock = 4 where id = ?').run(id);   // el +1
    celular.estado.falloBle = true;
    assert.equal(await celular.imprimir([id], new Map([[id, 1]]), false, { reimprimir: true }), false);
    assert.deepEqual(celular.estado.liberadas, [], 'no se suelta');
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(id)!.n, 1);
    assert.match(celular.$('resumen').textContent, /siguen registradas/);
    // Sin forzar, un fallo sí libera, pero solo el reclamo propio (con su hora).
    const nueva = agregar(t, DESPUES, 'listo', 1);
    assert.equal(await celular.imprimir([nueva]), false);
    const hora = (celular.estado.liberadasEn.at(-1) as Record<string, string>)[nueva];
    assert.match(hora, /^\d{4}-\d\d-\d\dT/);
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(nueva)!.n, 0);
  } finally { t.db.close(); }
});

test('un tiempo agotado al reclamar no imprime; una red que se cae a media tanda o antes del primer reclamo detiene el resto, salvo una pieza suelta (#464)', async () => {
  const t = tienda();
  try {
    const { celular } = await dosDispositivos(t);
    const [a, b, c] = [1, 2, 3].map(() => agregar(t, DESPUES, 'listo', 1));
    celular.estado.tiempoAgotado = true;
    assert.equal(await celular.imprimir([a]), false);
    assert.deepEqual(celular.estado.enviadas, []);
    assert.match(celular.$('resumen').textContent, /Se detuvo.*no respondió a tiempo/);
    celular.estado.tiempoAgotado = false;
    // La red se cae después de la primera pieza: la segunda y la tercera no se mandan a ciegas.
    let llamadas = 0;
    celular.estado.antesDeReclamar = () => { if (++llamadas === 2) celular.estado.sinRedParaReclamar = true; };
    assert.equal(await celular.imprimir([a, b, c]), false);
    assert.deepEqual(celular.estado.enviadas, [{ id: a, copias: 1 }]);
    assert.match(celular.$('resumen').textContent, /Se detuvo en la pieza 2 de 3: se perdió la red/);
    // Un lote que se queda sin red justo después de preparar (antes del primer reclamo) tampoco se manda a ciegas.
    celular.estado.antesDeReclamar = null; celular.estado.sinRedParaReclamar = false;
    celular.estado.antesDePreparar = async () => { celular.estado.sinRedParaReclamar = true; };
    assert.equal(await celular.imprimir([b, c]), false);
    assert.deepEqual(celular.estado.enviadas.map((e) => e.id), [a], 'ni b ni c salieron');
    assert.match(celular.$('resumen').textContent, /Se detuvo en la pieza 1 de 2: se perdió la red/);
    // Una sola pieza sí sigue con la marca local (se sube en la siguiente carga).
    assert.equal(await celular.imprimir([b]), true);
    assert.deepEqual(celular.estado.enviadas.map((e) => e.id), [a, b]);
    assert.equal(celular.marcas()[b].base, undefined);
  } finally { t.db.close(); }
});

test('un envío parcial conserva el reclamo y continúa lo que falta como reimpresión, sin llamarlo de otro dispositivo (#464)', async () => {
  const t = tienda();
  try {
    const { celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 3);
    celular.estado.falloBle = true;
    assert.equal(await celular.imprimir([id], new Map([[id, 3]])), false);   // salió 1 de 3
    assert.deepEqual(celular.estado.liberadas, [], 'con etiquetas ya pegadas no se suelta: otra pantalla podría reclamar antes de continuar');
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(id)!.n, 1);
    celular.estado.falloBle = false;
    assert.equal(await celular.imprimir([id], new Map([[id, 2]])), true);   // «Reconectar y seguir (2)»
    assert.deepEqual(celular.estado.enviadas, [{ id, copias: 3 }, { id, copias: 2 }]);
    assert.equal(celular.estado.reclamos.at(-1)!.reimprimir, true);
    assert.doesNotMatch(celular.$('resumen').textContent, /otro dispositivo/);
    assert.ok(celular.marcas()[id], 'al terminar queda marcada');
  } finally { t.db.close(); }
});

test('«No salió desde aquí» sí suelta lo marcado con «Marcar como impresas»: la marca lleva la hora de su reclamo (#464)', async () => {
  const t = tienda();
  try {
    const { pc, celular } = await dosDispositivos(t);
    const id = agregar(t, DESPUES, 'listo', 1);
    await celular.cargar();
    celular.$('lista').querySelectorAll = () => [{ value: id }];
    await celular.$('marcar').eventos.get('click')();
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(id)!.n, 1);
    assert.equal(celular.marcas()[id].propia, true);
    assert.match(celular.marcas()[id].en, /^\d{4}-\d\d-\d\dT/, 'guarda la hora del reclamo');
    assert.equal(await celular.noSalio(id), true);
    assert.equal(t.db.prepare('select count(*) n from etiquetas_enviadas where producto_id=?').get(id)!.n, 0, 'la base la soltó');
    assert.equal(celular.marcas()[id], undefined);
    assert.equal(await pc.imprimir([id]), true);   // otra pantalla ya puede sacarla
  } finally { t.db.close(); }
});

test('D1 (#464): la corrección de captura NO escribe existencia absoluta en una pieza lista con UPC; el ajuste auditado detecta la venta o el apartado intermedio', async () => {
  const t = tienda();
  try {
    const ahora = new Date().toISOString();
    const id = agregar(t, ahora, 'listo', 3);
    t.db.prepare("update productos set categoria='hogar', nombre='Estuche', upc='0191907910414', foto_key='fotos/x.jpg', capturado_por=?, codigo='ED-000777' where id=?").run(DUENO, id);
    // 10:00 capturada y etiquetada con 3; 13:00 un apartado de WhatsApp la deja en 2.
    t.db.prepare('update productos set stock = 2 where id = ?').run(id);
    // La vía de captura (pre-PR, sin cambios) sigue rechazando una pieza lista con UPC: nunca pisa el 2 con un 4.
    const captura = await t.pedir(`/api/borradores/${id}/existencia`, { stock: 4 }, 'PATCH');
    assert.equal(captura.status, 404);
    assert.match(captura.cuerpo.error, /ajuste auditado en Buscar/);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(id)!.stock, 2);
    // 15:00 el capturista corrige "3 → 4" con lo que veía (esperado 3): 409, y la existencia sigue en 2.
    const folio = crypto.randomUUID();
    const viejo = await t.pedir(`/api/piezas/${id}/existencia`, { id: folio, fijar_a: 4, esperado: 3, motivo: 'correccion' });
    assert.equal(viejo.status, 409);
    assert.equal(t.db.prepare('select stock from productos where id=?').get(id)!.stock, 2);
    assert.equal(t.db.prepare('select count(*) n from conteo_ajustes where producto_id=?').get(id)!.n, 0);
    // Con la existencia vigente sí se ajusta, y deja renglón de auditoría.
    const bueno = await t.pedir(`/api/piezas/${id}/existencia`, { id: crypto.randomUUID(), fijar_a: 4, esperado: 2, motivo: 'correccion' });
    assert.equal(bueno.status, 200);
    assert.deepEqual({ ...t.db.prepare('select motivo, antes, despues from conteo_ajustes where producto_id=?').get(id)! }, { motivo: 'correccion', antes: 2, despues: 4 });
  } finally { t.db.close(); }
});

test('D1 (#468): la corrección de captura de una foto lista sin UPC es condicional a la existencia vista y deja auditoría; la vencida no pisa la venta', async () => {
  const t = tienda();
  try {
    const id = agregar(t, new Date().toISOString(), 'listo', 3);
    t.db.prepare("update productos set capturado_por=?, codigo='ED-000779' where id=?").run(DUENO, id);
    const stock = () => t.db.prepare('select stock from productos where id=?').get(id)!.stock;
    const rastros = () => t.db.prepare('select count(*) n from conteo_ajustes where producto_id=?').get(id)!.n;
    const corregir = (cuerpo: object) => t.pedir(`/api/borradores/${id}/existencia`, cuerpo, 'PATCH');
    // Sin la existencia vista no hay escritura a ciegas.
    const sin = await corregir({ stock: 4 });
    assert.equal(sin.status, 409); assert.equal(sin.cuerpo.stock, 3); assert.equal(stock(), 3); assert.equal(rastros(), 0);
    // 13:00 un apartado la deja en 2; la corrección "3 → 4" con lo que veía no la pisa.
    t.db.prepare('update productos set stock = 2 where id = ?').run(id);
    const vieja = await corregir({ stock: 4, esperado: 3 });
    assert.equal(vieja.status, 409); assert.equal(vieja.cuerpo.stock, 2); assert.equal(stock(), 2); assert.equal(rastros(), 0);
    // Con la existencia vigente sí se escribe, con su renglón de auditoría.
    assert.equal((await corregir({ stock: 4, esperado: 2 })).status, 200);
    assert.equal(stock(), 4);
    assert.deepEqual({ ...t.db.prepare('select motivo, antes, despues, ajustado_por from conteo_ajustes where producto_id=?').get(id)! }, { motivo: 'correccion', antes: 2, despues: 4, ajustado_por: DUENO });
    // Repetir la misma petición ya no coincide con la existencia: 409, sin segundo rastro.
    assert.equal((await corregir({ stock: 4, esperado: 2 })).status, 409);
    assert.equal(rastros(), 1);
    // Sigue siendo solo de quien la capturó.
    t.db.prepare("update productos set capturado_por='otro@x.com' where id=?").run(id);
    assert.equal((await corregir({ stock: 1, esperado: 4 })).status, 404);
    assert.equal(stock(), 4);
  } finally { t.db.close(); }
});

test('D1 (#464): dos correcciones simultáneas con la misma existencia vista: solo una gana', async () => {
  const t = tienda();
  try {
    const id = agregar(t, new Date().toISOString(), 'listo', 3);
    t.db.prepare("update productos set categoria='hogar', upc='0191907910414', foto_key='fotos/x.jpg', capturado_por=?, codigo='ED-000778' where id=?").run(DUENO, id);
    const intento = (n: number) => t.pedir(`/api/piezas/${id}/existencia`, { id: crypto.randomUUID(), fijar_a: n, esperado: 3, motivo: 'correccion' });
    const [a, b] = await Promise.all([intento(4), intento(5)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(t.db.prepare('select count(*) n from conteo_ajustes where producto_id=?').get(id)!.n, 1);
  } finally { t.db.close(); }
});

test('D2 (#464): FEP sigue el análisis de su captura por la revisión propia (el estado por UPC es solo de la tienda)', async () => {
  const t = tienda();
  try {
    const id = agregar(t, new Date().toISOString(), 'pendiente', 1);
    t.db.prepare("update productos set propietario='fep', upc='0191907910414', capturado_por=? where id=?").run(DUENO, id);
    t.db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('fep@prueba.mx', 'FEP', 'finanzas', 1, '', '')").run();
    const dueno = await t.pedir(`/api/borradores/upc/${id}`, undefined, 'GET');
    assert.equal(dueno.status, 404, 'el dueño de la tienda no ve piezas de FEP');
    t.env.DEV_USUARIO = 'fep@prueba.mx';
    t.db.prepare('update productos set capturado_por=? where id=?').run('fep@prueba.mx', id);
    // El estado por UPC es solo de la tienda (FEP no tiene manifiesto): el seguimiento usa la revisión de su propia captura.
    assert.equal((await t.pedir(`/api/borradores/upc/${id}`, undefined, 'GET')).status, 403);
    const fep = await t.pedir(`/api/borradores/${id}/revision`, undefined, 'GET');
    assert.equal(fep.status, 200);
    assert.equal(fep.cuerpo.estado_analisis, 'pendiente');
  } finally { t.db.close(); }
});

test('D3 (#464): si todo se rechazó (vendida o cambió) imprimir no dice que salió; con una buena sí', async () => {
  const t = tienda();
  try {
    const { celular } = await dosDispositivos(t);
    const vendida = agregar(t, DESPUES, 'listo', 0), buena = agregar(t, DESPUES, 'listo', 1);
    assert.equal(await celular.imprimir([vendida]), false);
    assert.deepEqual(celular.estado.enviadas, []);
    assert.match(celular.$('resumen').textContent, /ya no se puede imprimir \(vendidas o cambiaron\)/);
    assert.equal(await celular.imprimir([vendida, buena]), true);
  } finally { t.db.close(); }
});

test('Imprimir en el celular no pide /api/foto de las piezas sin foto (#464)', async () => {
  const t = tienda();
  try {
    const { celular } = await dosDispositivos(t);
    const con = agregar(t, DESPUES, 'listo', 1), sin = agregar(t, DESPUES, 'listo', 1);
    t.db.prepare("update productos set foto_key='fotos/a.jpg' where id=?").run(con);
    await celular.cargar();
    const lista = celular.$('lista').innerHTML;
    assert.ok(lista.includes(`/api/foto/${con}`));
    assert.ok(lista.includes(`value="${sin}"`) && !lista.includes(`/api/foto/${sin}`), 'sin foto no hay petición');
    const vista = readFileSync('public/inventario-imprimir.js', 'utf8');
    assert.match(vista, /if\(p\.foto_key\)imagen\.src=`\/api\/foto\/\$\{p\.id\}`;else imagen\.hidden=true/);
  } finally { t.db.close(); }
});
