// node --test src/mercadolibre.test.ts
// Mercado Libre (Issue #170) contra una ML simulada: ninguna prueba toca la red.
// Se reemplaza globalThis.fetch y se restaura al terminar cada una.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda, DUENO } from './prueba-d1.ts';
import { guardarTokens, mlFetch, precioML, tituloML, dimensionesJpeg, idProductoML, gtinDe, modeloDe, descripcionPorDefecto } from './mercadolibre.ts';

const LLAVE = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const RUTA = 'ruta-secreta-de-prueba';
const fetchReal = globalThis.fetch;

interface Llamada { metodo: string; ruta: string; cuerpo: any; auth: string | null }

const ATRIBUTOS = [
  { id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } },
  { id: 'MODEL', name: 'Modelo', value_type: 'string', tags: { required: true, catalog_required: true } },
  { id: 'GENDER', name: 'Género', value_type: 'list', tags: { required: true, grid_template_required: true },
    values: [{ id: '339666', name: 'Hombre' }, { id: '339665', name: 'Mujer' }] },
  { id: 'SIZE', name: 'Talla', value_type: 'string', tags: { required: true, allow_variations: true } },
  { id: 'COLOR', name: 'Color', value_type: 'string', tags: { required: true } },
  { id: 'GTIN', name: 'Código de barras', value_type: 'string', tags: { conditional_required: true } },
  { id: 'EMPTY_GTIN_REASON', name: 'Razón de GTIN vacío', value_type: 'list', tags: { conditional_required: true, hidden: true },
    values: [{ id: '17055160', name: 'El producto no tiene código registrado' }, { id: '17055161', name: 'Otra razón' }] },
  { id: 'PANT_TYPE', name: 'Tipo', value_type: 'string', tags: { required: true, read_only: true } },
  { id: 'UNITS_PER_PACK', name: 'Unidades por paquete', value_type: 'number', tags: { conditional_required: true } },
  { id: 'GRADING', name: 'Estado', value_type: 'list', tags: { conditional_required: true, new_hidden: true },
    values: [{ id: '1', name: 'Excelente' }] },
  { id: 'ITEM_CONDITION', name: 'Condición', value_type: 'list', tags: {} },
  { id: 'SIZE_GRID_ID', name: 'Guía', value_type: 'string', tags: { required: true } },
  { id: 'NOTAS', name: 'Notas', value_type: 'string', tags: {} },
];

/** La API de ML en memoria: responde lo justo y anota cada llamada. */
class SimML {
  llamadas: Llamada[] = [];
  tags: string[] = [];
  refrescos = 0;
  refreshVigente = 'RT-0';
  fallar401 = 0;
  /** Se corre antes de contestar cada peticion (para simular que pasa algo en medio). */
  antesDe: ((l: Llamada) => Promise<void>) | null = null;
  rechazarItem: unknown = null;
  items = new Map<string, { id: string; status: string; available_quantity: number }>();
  ordenes = new Map<string, unknown>();
  productoActivo = true;
  /** Lo que contesta la IA (Gemini) a la propuesta de atributos (por omisión, nada); null = no responde. Cada cuerpo pedido se anota en `pedidosIA`. */
  ia: ((cuerpo: any) => Record<string, string>) | null = () => ({});
  pedidosIA: any[] = [];
  catalogo: { status?: number; cuerpo: unknown } = { cuerpo: { results: [{
    id: 'MLM2001', name: 'Lanzador SplatRball 800 Pyro', settings: { listing_strategy: 'catalog_required' },
    pictures: [{ url: 'http://http2.mlstatic.com/a.jpg', secure_url: 'https://http2.mlstatic.com/a.jpg' }],
    attributes: [{ id: 'BRAND', value_name: 'Splat R Ball' }],
  }] } };
  /** Lo que contesta el diagnostico de fotos (#564): por omision, foto valida. */
  diagnostico: { status?: number; cuerpo: unknown } = { cuerpo: { pictures: [{ id: 'pieza', results: { thumbnail: { action: 'empty', detections: [] } } }] } };
  /** Categorias que con el token de la app responden 403 y sin token si (#186). 'todo' = tambien sin token. */
  publicasSoloSinToken: false | true | 'todo' = false;

  de(metodo: string, patron: RegExp) { return this.llamadas.filter((l) => l.metodo === metodo && patron.test(l.ruta)); }

  responder(l: Llamada): { status?: number; cuerpo: unknown } {
    const { metodo, ruta } = l;
    if (metodo === 'POST' && ruta === '/oauth/token') {
      if (l.cuerpo.grant_type === 'authorization_code') {
        return { cuerpo: { access_token: 'AT-0', refresh_token: 'RT-0', expires_in: 10800, user_id: 555 } };
      }
      if (l.cuerpo.refresh_token !== this.refreshVigente) {
        return { status: 400, cuerpo: { error: 'invalid_grant', message: 'Error validating grant.' } };
      }
      this.refrescos++;
      this.refreshVigente = `RT-${this.refrescos}`;
      return { cuerpo: { access_token: `AT-${this.refrescos}`, refresh_token: this.refreshVigente, expires_in: 10800, user_id: 555 } };
    }
    if (this.fallar401 > 0 && ruta === '/users/me') { this.fallar401--; return { status: 401, cuerpo: { message: 'invalid access token', error: 'not_found', status: 401 } }; }
    if (metodo === 'GET' && ruta === '/users/me') return { cuerpo: { id: 555, nickname: 'TIENDA', tags: this.tags } };
    const publica = ruta.startsWith('/sites/MLM/domain_discovery/search') || /^\/categories\//.test(ruta);
    if (metodo === 'GET' && publica && this.publicasSoloSinToken && (l.auth || this.publicasSoloSinToken === 'todo')) {
      return { status: 403, cuerpo: { message: 'forbidden', error: 'forbidden', status: 403, cause: [] } };
    }
    if (metodo === 'GET' && ruta.startsWith('/sites/MLM/domain_discovery/search')) {
      if (ruta.includes('sin-resultados')) return { cuerpo: [] };
      return { cuerpo: [
        { domain_id: 'MLM-PANTS', domain_name: 'Pantalones', category_id: 'MLM194175', category_name: 'Pantalones' },
        { domain_id: 'MLM-SHORTS', domain_name: 'Shorts', category_id: 'MLM1234', category_name: 'Shorts' },
      ] };
    }
    if (metodo === 'GET' && ruta.startsWith('/products/search?')) return this.catalogo;
    const producto = /^\/products\/(MLM\d+)$/.exec(ruta);
    if (metodo === 'GET' && producto) return { cuerpo: { id: producto[1], status: this.productoActivo ? 'active' : 'inactive', domain_id: 'MLM-SHORTS', name: 'Lanzador SplatRball 800' } };
    const cat = /^\/categories\/(MLM\d+)$/.exec(ruta);
    if (metodo === 'GET' && cat) return { cuerpo: { id: cat[1], settings: { catalog_domain: cat[1] === 'MLM1234' ? 'MLM-SHORTS' : 'MLM-PANTS' } } };
    if (metodo === 'GET' && ruta === '/categories/MLM194175/attributes') return { cuerpo: ATRIBUTOS };
    if (metodo === 'GET' && /^\/categories\/MLM\d+\/attributes$/.test(ruta)) return { cuerpo: [{ id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } }] };
    if (metodo === 'POST' && ruta === '/catalog/charts/search') {
      return { cuerpo: { charts: [{ id: '26008', names: { MLM: 'Jeans hombre' }, rows: [{ id: '26008:1', attributes: [{ id: 'SIZE', values: [{ name: '32' }] }] }] }] } };
    }
    if (metodo === 'POST' && ruta === '/pictures/items/upload') return { cuerpo: { id: 'PIC-1' } };
    if (metodo === 'POST' && ruta === '/moderations/pictures/diagnostic') return this.diagnostico;
    if (metodo === 'POST' && ruta === '/items') {
      if (this.rechazarItem) return { status: 400, cuerpo: this.rechazarItem };
      const id = `MLM${100 + this.items.size}`;
      this.items.set(id, { id, status: 'active', available_quantity: l.cuerpo.available_quantity });
      return { status: 201, cuerpo: { id, status: 'active', permalink: `https://articulo.mercadolibre.com.mx/${id}` } };
    }
    if (metodo === 'POST' && /^\/items\/MLM\d+\/description$/.test(ruta)) return { cuerpo: {} };
    const put = /^\/items\/(MLM\d+)$/.exec(ruta);
    if (metodo === 'PUT' && put) {
      const item = this.items.get(put[1]);
      if (item) Object.assign(item, l.cuerpo);
      return { cuerpo: { id: put[1] } };
    }
    if (metodo === 'GET' && ruta.startsWith('/items?ids=')) {
      const ids = new URL(`https://x${ruta}`).searchParams.get('ids')!.split(',');
      return { cuerpo: ids.map((id) => this.items.has(id) ? { code: 200, body: this.items.get(id) } : { code: 404, body: {} }) };
    }
    if (metodo === 'GET' && ruta.startsWith('/orders/search')) return { cuerpo: { results: [...this.ordenes.values()] } };
    const orden = /^\/orders\/(\d+)$/.exec(ruta);
    if (metodo === 'GET' && orden) {
      return this.ordenes.has(orden[1]) ? { cuerpo: this.ordenes.get(orden[1]) } : { status: 404, cuerpo: { message: 'Order not found', error: 'not_found', status: 404 } };
    }
    return { status: 404, cuerpo: { message: `no simulado: ${metodo} ${ruta}`, error: 'not_found', status: 404 } };
  }
}

function instalar(sim: SimML) {
  globalThis.fetch = (async (entrada: unknown, init: RequestInit = {}) => {
    const u = new URL(String(entrada));
    if (u.origin === 'https://generativelanguage.googleapis.com') {
      const pedido = JSON.parse(String(init.body));
      sim.pedidosIA.push(pedido);
      if (!sim.ia) throw new Error('la IA simulada no responde');
      const texto = JSON.stringify(sim.ia(pedido));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: texto }] } }] }), { status: 200 });
    }
    assert.equal(u.origin, 'https://api.mercadolibre.com', 'solo se habla con la API de ML');
    const cuerpo = init.body instanceof URLSearchParams ? Object.fromEntries(init.body)
      : init.body instanceof FormData ? { archivo: (init.body.get('file') as File).size, tipo: (init.body.get('file') as File).type }
      : init.body ? JSON.parse(String(init.body)) : undefined;
    const llamada = { metodo: init.method ?? 'GET', ruta: u.pathname + u.search, cuerpo, auth: new Headers(init.headers).get('authorization') };
    sim.llamadas.push(llamada);
    await sim.antesDe?.(llamada);
    const { status = 200, cuerpo: respuesta } = sim.responder(llamada);
    return new Response(JSON.stringify(respuesta), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

type Tienda = ReturnType<typeof tienda> & { sim: SimML };

/** Una tienda con ML configurada (y conectada, salvo que se diga lo contrario) y su simulacion. */
async function conML(prueba: (t: Tienda) => Promise<void>, conectada = true) {
  const t = Object.assign(tienda(), { sim: new SimML() });
  Object.assign(t.env, {
    ML_CLIENT_ID: '123', ML_CLIENT_SECRET: 'secreto-de-la-app', ML_LLAVE_TOKENS: LLAVE,
    ML_RUTA_NOTIFICACIONES: RUTA, ML_REDIRECT_URI: 'https://escaner.prueba/ml/callback',
    MODELO_ANALISIS: 'gemini', GEMINI_API_KEY: 'prueba',
  });
  instalar(t.sim);
  try {
    if (conectada) {
      await guardarTokens(t.env, { access_token: 'AT-0', refresh_token: 'RT-0', expires_in: 10800, user_id: 555 });
      t.db.prepare(`update ml_cuenta set nickname = 'TIENDA' where id = 1`).run();
    }
    await prueba(t);
  } finally {
    globalThis.fetch = fetchReal;
  }
}

const jpeg = (ancho: number, alto: number) => Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, alto >> 8, alto & 255, ancho >> 8, ancho & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
]);

let consecutivo = 100;
/** Una pieza publicable (revisada, con foto, etiqueta ED-, existencias) salvo lo que se cambie. */
function pieza(t: Tienda, extra: Record<string, unknown> = {}): string {
  const n = ++consecutivo;
  const fila = {
    id: `b${String(n).padStart(7, '0')}-1111-4111-8111-111111111111`, codigo: `ED-${String(n).padStart(6, '0')}`,
    nombre: "Jeans Levi's 501 Hombre", marca: "Levi's", categoria: 'ropa', precio: 25000, estado_fisico: 'nuevo',
    estado_analisis: 'listo', destino: 'etiqueta', sin_inventario: 0, stock: 3, ...extra,
  } as Record<string, any>;
  fila.foto_key = extra.foto_key ?? `fotos/${fila.id}.jpg`;
  t.db.prepare(
    `insert into productos (id, codigo, nombre, marca, categoria, precio, estado_fisico, estado_analisis, destino, sin_inventario,
                            stock, foto_key, talla, upc, semana_ingreso, creado_en, actualizado_en)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'S40', ?, '')`,
  ).run(fila.id, fila.codigo, fila.nombre, fila.marca, fila.categoria, fila.precio, fila.estado_fisico, fila.estado_analisis,
    fila.destino, fila.sin_inventario, fila.stock, fila.foto_key, fila.talla ?? null, fila.upc ?? null, new Date(2026, 9, 1, 0, 0, n).toISOString());
  if (fila.foto_key) (t.env.FOTOS as any).objetos.set(fila.foto_key, jpeg(1200, 1200).buffer);
  return fila.id;
}

const cuerpoPublicar = (extra: Record<string, unknown> = {}) => ({
  titulo: 'Jeans Levis 501 Hombre', categoria_id: 'MLM194175', precio_ml: 29900,
  atributos: [{ id: 'BRAND', value_name: "Levi's" }, { id: 'SIZE', value_name: '32' }, { id: 'COLOR', value_name: 'Azul' }],
  guia_fila_id: '26008:1', descripcion: 'Jeans nuevos', ...extra,
});

const publicarPieza = async (t: Tienda, id = pieza(t)) => {
  const r = await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar());
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return { id, itemId: r.cuerpo.publicacion.ml_item_id as string };
};

const stockDe = (t: Tienda, id: string) => (t.db.prepare('select stock from productos where id = ?').get(id) as { stock: number }).stock;
const estadoDe = (t: Tienda, id: string) => (t.db.prepare('select estado from ml_publicaciones where producto_id = ?').get(id) as { estado: string }).estado;
const orden = (id: number, estado: string, items: [string, number][], vendedor = 555) =>
  ({ id, status: estado, seller: { id: vendedor }, order_items: items.map(([item, quantity]) => ({ item: { id: item }, quantity })) });
const avisar = (t: Tienda, recurso: string, extra: Record<string, unknown> = {}) =>
  t.pedir(`/api/ml/notificaciones/${RUTA}`, { topic: 'orders_v2', resource: recurso, user_id: 555, application_id: 123, ...extra });

/* ---------- precio y utilidades ---------- */

test('precio ML: precio de tienda + %, quebrado a X9, nunca menos de $35', () => {
  assert.equal(precioML(25000, 20), 29900);
  assert.equal(precioML(25000, 30), 32900);
  assert.equal(precioML(24900, 20), 29900);
  assert.equal(precioML(4900, 20), 5900);
  assert.equal(precioML(900, 20), 3500);
  assert.equal(precioML(1900, 0), 3500);
});

test('título: sin puntuación, con la marca, máximo 60 sin cortar palabras; JPEG: lee sus medidas', () => {
  assert.equal(tituloML("Jeans Levi's 501 Hombre", "Levi's"), 'Jeans Levis 501 Hombre');
  assert.equal(tituloML('Playera estampada', 'Nike'), 'Nike Playera estampada');
  const largo = tituloML('Chamarra impermeable ligera para correr en montaña con capucha ajustable y bolsillos', '');
  assert.ok(largo.length <= 60 && !largo.endsWith(' '), largo);
  assert.deepEqual(dimensionesJpeg(jpeg(640, 480)), { ancho: 640, alto: 480 });
  assert.equal(dimensionesJpeg(new Uint8Array([1, 2, 3])), null);
});

/* ---------- conexión y tokens ---------- */

test('estado: sin conectar muestra qué falta (nombres, nunca valores); conectada, el vendedor y la config', async () => {
  const sin = tienda();
  const r = await sin.pedir('/api/ml/estado');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.conectado, false);
  assert.equal(r.cuerpo.usuario, null);
  assert.deepEqual(r.cuerpo.config, { ml_pct: 20, ml_tipo_publicacion: 'gold_special' });
  assert.deepEqual(r.cuerpo.faltan, ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'ML_LLAVE_TOKENS', 'ML_RUTA_NOTIFICACIONES', 'ML_REDIRECT_URI']);

  await conML(async (t) => {
    t.sim.tags = ['user_product_seller'];
    await mlFetch(t.env, '/users/me');   // aprende los tags
    const e = (await t.pedir('/api/ml/estado')).cuerpo;
    assert.equal(e.conectado, true);
    assert.deepEqual(e.usuario, { id: '555', nickname: 'TIENDA' });
    assert.equal(e.user_product_seller, false);   // lo aprende preparar/publicar
    assert.deepEqual(e.faltan, []);
  });
});

test('OAuth: conectar manda a ML con state y PKCE; el retorno guarda tokens cifrados', async () => {
  await conML(async (t) => {
    const salto = await t.pedir('/api/ml/conectar');
    assert.equal(salto.status, 302);
    const ml = new URL(salto.ubicacion!);
    assert.equal(ml.origin + ml.pathname, 'https://auth.mercadolibre.com.mx/authorization');
    assert.equal(ml.searchParams.get('client_id'), '123');
    assert.equal(ml.searchParams.get('redirect_uri'), 'https://escaner.prueba/ml/callback');
    assert.equal(ml.searchParams.get('code_challenge_method'), 'S256');
    const state = ml.searchParams.get('state')!;

    const vuelta = await t.pedir(`/ml/callback?code=TG-1&state=${state}`);
    assert.equal(vuelta.status, 302);
    assert.equal(new URL(vuelta.ubicacion!).pathname + new URL(vuelta.ubicacion!).search, '/mercadolibre?conectado=1');
    const canje = t.sim.de('POST', /^\/oauth\/token$/)[0].cuerpo;
    assert.equal(canje.grant_type, 'authorization_code');
    assert.equal(canje.code, 'TG-1');
    assert.equal(canje.redirect_uri, 'https://escaner.prueba/ml/callback');
    assert.ok(canje.code_verifier && canje.client_secret);

    const fila = t.db.prepare('select * from ml_cuenta where id = 1').get() as Record<string, string>;
    assert.equal(fila.ml_user_id, '555');
    assert.equal(fila.nickname, 'TIENDA');
    for (const valor of Object.values(fila)) assert.ok(!String(valor).includes('AT-0') && !String(valor).includes('RT-0'), 'token en claro en D1');
    assert.notEqual(fila.access_token_cifrado, '');
    // Se descifra al usarlo: ML recibe el token de verdad.
    await mlFetch(t.env, '/users/me');
    assert.equal(t.sim.de('GET', /^\/users\/me$/).at(-1)!.auth, 'Bearer AT-0');

    // El state es de un solo uso, y uno inventado no sirve.
    assert.match((await t.pedir(`/ml/callback?code=TG-1&state=${state}`)).ubicacion!, /error=estado_invalido/);
    assert.match((await t.pedir('/ml/callback?code=TG-1&state=inventado')).ubicacion!, /error=estado_invalido/);
    assert.match((await t.pedir('/ml/callback?error=access_denied')).ubicacion!, /error=access_denied/);
  }, false);
});

test('refresh: dos peticiones con el token vencido gastan UN solo refresh token', async () => {
  await conML(async (t) => {
    t.db.prepare(`update ml_cuenta set expira_en = '2020-01-01T00:00:00.000Z'`).run();
    await Promise.all([mlFetch(t.env, '/users/me'), mlFetch(t.env, '/users/me')]);
    assert.equal(t.sim.refrescos, 1);
    assert.equal(t.sim.de('POST', /^\/oauth\/token$/).length, 1);
    assert.deepEqual(t.sim.de('GET', /^\/users\/me$/).map((l) => l.auth), ['Bearer AT-1', 'Bearer AT-1']);
    // El refresh token nuevo quedo guardado: el siguiente refresh usa RT-1.
    t.db.prepare(`update ml_cuenta set expira_en = '2020-01-01T00:00:00.000Z'`).run();
    await mlFetch(t.env, '/users/me');
    assert.equal(t.sim.refreshVigente, 'RT-2');
  });
});

test('refresh con invalid_grant: la cuenta queda desconectada y se pide reconectar', async () => {
  await conML(async (t) => {
    t.sim.refreshVigente = 'otro';
    t.db.prepare(`update ml_cuenta set expira_en = '2020-01-01T00:00:00.000Z'`).run();
    await assert.rejects(mlFetch(t.env, '/users/me'), /venció/);
    assert.equal((await t.pedir('/api/ml/estado')).cuerpo.conectado, false);
    const r = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
    assert.equal(r.status, 409);
    assert.match(r.cuerpo.error, /no está conectado/);
  });
});

test('un 401 de ML renueva el token una vez y reintenta', async () => {
  await conML(async (t) => {
    t.sim.fallar401 = 1;
    const yo = await mlFetch(t.env, '/users/me');
    assert.equal(yo.id, 555);
    assert.equal(t.sim.refrescos, 1);
    assert.equal(t.sim.de('GET', /^\/users\/me$/).at(-1)!.auth, 'Bearer AT-1');
  });
});

/* ---------- preparar ---------- */

test('preparar: categoría, atributos pedidos, precio con ml_pct, guía de tallas', async () => {
  await conML(async (t) => {
    const id = pieza(t);
    const r = await t.pedir(`/api/ml/preparar/${id}`, {});
    assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
    const { producto, propuesta: p } = r.cuerpo;
    assert.deepEqual(producto, { id, codigo: producto.codigo, nombre: "Jeans Levi's 501 Hombre", categoria: 'ropa', marca: "Levi's", precio: 25000, estado_fisico: 'nuevo', stock: 3, talla: null });
    assert.equal(p.titulo, 'Jeans Levis 501 Hombre');
    assert.equal(p.usa_family_name, false);
    assert.deepEqual([p.categoria_id, p.categoria_nombre, p.dominio], ['MLM194175', 'Pantalones', 'MLM-PANTS']);
    assert.equal(p.sugerencias.length, 2);
    assert.equal(p.precio_ml, 29900);
    assert.equal(p.tipo_publicacion, 'gold_special');
    const ids = p.atributos.map((a: any) => a.id);
    // Lo obligatorio, sin lo que ML llena o el sistema pone; el GTIN deja de ser obligatorio con razon de vacio.
    assert.deepEqual([...ids].sort(), ['BRAND', 'COLOR', 'EMPTY_GTIN_REASON', 'GENDER', 'GTIN', 'MODEL', 'SIZE', 'UNITS_PER_PACK']);
    assert.equal(p.atributos.find((a: any) => a.id === 'GTIN').requerido, false);
    assert.deepEqual(p.atributos.find((a: any) => a.id === 'BRAND').valor_sugerido, { id: null, nombre: "Levi's" });
    assert.equal(p.atributos.find((a: any) => a.id === 'EMPTY_GTIN_REASON').valor_sugerido.id, '17055160');
    assert.deepEqual(p.atributos.find((a: any) => a.id === 'GENDER').valores[0], { id: '339666', nombre: 'Hombre' });
    assert.deepEqual(p.guia_tallas, { requerida: true, guias: [{ id: '26008', nombre: 'Jeans hombre', filas: [{ id: '26008:1', talla: '32' }] }] });
    assert.deepEqual(p.avisos, []);
    assert.equal(t.sim.de('POST', /^\/catalog\/charts\/search$/)[0].cuerpo.domain_id, 'PANTS');
    assert.equal(t.sim.de('POST', /^\/items$/).length, 0, 'preparar no publica nada');

    // Con ml_pct 30 y user_product_seller: otro precio y family_name.
    assert.equal((await t.pedir('/api/ml/config', { ml_pct: 30 }, 'PUT')).status, 200);
    t.sim.tags = ['user_product_seller'];
    const q = (await t.pedir(`/api/ml/preparar/${id}`, {})).cuerpo.propuesta;
    assert.equal(q.precio_ml, 32900);
    assert.equal(q.usa_family_name, true);
  });
});

test('preparar: la talla de la pieza va en producto y llena SIZE (adulto y de niño)', () => conML(async (t) => {
  const adulto = (await t.pedir(`/api/ml/preparar/${pieza(t, { talla: 'M' })}`, {})).cuerpo;
  assert.equal(adulto.producto.talla, 'M');
  assert.deepEqual(adulto.propuesta.atributos.find((a: any) => a.id === 'SIZE').valor_sugerido, { id: null, nombre: 'M' });
  const nino = (await t.pedir(`/api/ml/preparar/${pieza(t, { talla: 'Niño 6 años / S' })}`, {})).cuerpo;
  assert.equal(nino.producto.talla, 'Niño 6 años / S');
  assert.deepEqual(nino.propuesta.atributos.find((a: any) => a.id === 'SIZE').valor_sugerido, { id: null, nombre: '6 años' });
  assert.equal((await t.pedir(`/api/ml/preparar/${pieza(t)}`, {})).cuerpo.producto.talla, null);
}));

/* ---------- atributos propuestos (#555) ---------- */

const atributo = (r: any, id: string) => r.cuerpo.propuesta.atributos.find((a: any) => a.id === id);

test('GTIN desde el UPC: solo con dígito verificador; se completa el cero perdido', () => {
  assert.equal(gtinDe('012345678905'), '012345678905');   // UPC-A
  assert.equal(gtinDe('12345678905'), '012345678905');    // sin el cero inicial
  assert.equal(gtinDe('4006381333931'), '4006381333931');  // EAN-13
  assert.equal(gtinDe('012345678900'), '');                // dígito verificador malo
  assert.equal(gtinDe(''), '');
  assert.equal(gtinDe(null), '');
  assert.equal(gtinDe('ABC123456789'), '');
});

test('MODEL desde el nombre sin la marca', () => {
  assert.equal(modeloDe("Jeans Levi's 501 Hombre", "Levi's"), 'Jeans 501 Hombre');
  assert.equal(modeloDe('Sartén Tramontina 24 cm', 'tramontina'), 'Sartén 24 cm');
  assert.equal(modeloDe('Licuadora 10 velocidades', ''), 'Licuadora 10 velocidades');
  assert.equal(modeloDe("Levi's", "Levi's"), '');
});

test('preparar: lo que trae la pieza llega propuesto y marcado de dónde sale (marca, talla, modelo, GTIN)', () => conML(async (t) => {
  const r = await t.pedir(`/api/ml/preparar/${pieza(t, { talla: 'M', upc: '012345678905' })}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  const ids = r.cuerpo.propuesta.atributos.map((a: any) => a.id);
  // Con GTIN no hace falta la razón de GTIN vacío; GRADING (new_hidden) no aplica a lo nuevo.
  assert.ok(!ids.includes('EMPTY_GTIN_REASON'));
  assert.ok(!ids.includes('GRADING'));
  assert.deepEqual(atributo(r, 'GTIN').valor_sugerido, { id: null, nombre: '012345678905' });
  assert.equal(atributo(r, 'GTIN').origen, 'pieza');
  assert.deepEqual(atributo(r, 'MODEL').valor_sugerido, { id: null, nombre: 'Jeans 501 Hombre' });
  assert.equal(atributo(r, 'MODEL').origen, 'pieza');
  assert.equal(atributo(r, 'BRAND').origen, 'pieza');
  assert.equal(atributo(r, 'SIZE').origen, 'pieza');
  assert.deepEqual(atributo(r, 'UNITS_PER_PACK').valor_sugerido, { id: null, nombre: '1' });
  assert.equal(atributo(r, 'UNITS_PER_PACK').origen, 'defecto');
  // El GTIN con UPC no es obligatorio (la categoría lo acepta vacío con razón) pero sí viaja.
  assert.equal(atributo(r, 'GTIN').requerido, false);
}));

test('preparar: sin UPC válido se propone la razón de GTIN vacío aunque ML la marque hidden', () => conML(async (t) => {
  for (const upc of [null, '', '012345678900']) {
    const r = await t.pedir(`/api/ml/preparar/${pieza(t, { upc })}`, {});
    assert.equal(atributo(r, 'EMPTY_GTIN_REASON').valor_sugerido.id, '17055160', String(upc));
    assert.equal(atributo(r, 'EMPTY_GTIN_REASON').origen, 'defecto');
    assert.equal(atributo(r, 'GTIN').valor_sugerido, null);
  }
}));

test('preparar: GTIN va aunque la categoría no lo marque obligatorio, si la pieza tiene UPC', () => conML(async (t) => {
  const sinGtin = t.sim.responder.bind(t.sim);
  t.sim.responder = (l) => l.ruta === '/categories/MLM194175/attributes'
    ? { cuerpo: [{ id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true } },
      { id: 'GTIN', name: 'Código de barras', value_type: 'string', tags: {} }] }
    : sinGtin(l);
  const con = await t.pedir(`/api/ml/preparar/${pieza(t, { upc: '012345678905' })}`, {});
  assert.deepEqual(atributo(con, 'GTIN').valor_sugerido, { id: null, nombre: '012345678905' });
  const sin = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(atributo(sin, 'GTIN'), undefined);
}));

test('preparar: lo que la pieza no trae (color, género) lo propone la IA eligiendo de la lista de ML', () => conML(async (t) => {
  t.sim.ia = () => ({ COLOR: 'Azul', GENDER: 'Hombre' });
  const r = await t.pedir(`/api/ml/preparar/${pieza(t, { talla: 'M', upc: '012345678905' })}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(t.sim.pedidosIA.length, 1);
  const pedido = t.sim.pedidosIA[0];
  const esquema = pedido.generationConfig.responseSchema;
  // Solo lo que falta: la marca, la talla, el GTIN y el modelo ya los trae la pieza.
  assert.deepEqual(Object.keys(esquema.properties).sort(), ['COLOR', 'GENDER']);
  assert.deepEqual(esquema.properties.GENDER.enum, ['Hombre', 'Mujer', '']);
  assert.equal(esquema.properties.GENDER.type, 'string');
  assert.ok(pedido.contents[0].parts.some((p: any) => p.inlineData), 'la foto va al modelo');
  assert.deepEqual(atributo(r, 'GENDER').valor_sugerido, { id: '339666', nombre: 'Hombre' });
  assert.equal(atributo(r, 'GENDER').origen, 'ia');
  assert.deepEqual(atributo(r, 'COLOR').valor_sugerido, { id: null, nombre: 'Azul' });
  assert.equal(atributo(r, 'COLOR').origen, 'ia');
  assert.equal(atributo(r, 'COLOR').motivo, undefined);
}));

test('preparar: una lista cerrada no acepta lo que la IA invente, y queda con su motivo', () => conML(async (t) => {
  t.sim.ia = () => ({ GENDER: 'Alienígena', COLOR: '' });
  const r = await t.pedir(`/api/ml/preparar/${pieza(t, { talla: 'M' })}`, {});
  assert.equal(atributo(r, 'GENDER').valor_sugerido, null);
  assert.match(atributo(r, 'GENDER').motivo, /IA no lo distinguió/);
  assert.match(atributo(r, 'COLOR').motivo, /IA no lo distinguió/);
}));

test('preparar: la categoría exige MODEL y la pieza no lo tiene -> la IA lo intenta; sin respuesta queda con motivo, sin bloquear en silencio', () => conML(async (t) => {
  // El nombre es solo la marca: no queda modelo.
  const id = pieza(t, { nombre: "Levi's", talla: 'M' });
  t.sim.ia = () => ({ MODEL: '501', COLOR: 'Azul', GENDER: 'Hombre' });
  const conIA = await t.pedir(`/api/ml/preparar/${id}`, {});
  assert.deepEqual(atributo(conIA, 'MODEL').valor_sugerido, { id: null, nombre: '501' });
  assert.equal(atributo(conIA, 'MODEL').origen, 'ia');

  t.sim.ia = null;   // la IA no responde
  const sinIA = await t.pedir(`/api/ml/preparar/${id}`, {});
  assert.equal(sinIA.status, 200, 'la IA caída no rompe preparar');
  const modelo = atributo(sinIA, 'MODEL');
  assert.equal(modelo.valor_sugerido, null);
  assert.equal(modelo.requerido, true);
  assert.match(modelo.motivo, /No se pudo proponer con IA \(la IA no respondió\)/);
  assert.match(atributo(sinIA, 'COLOR').motivo, /No se pudo proponer con IA/);
  // Lo que la pieza sí trae sigue propuesto.
  assert.equal(atributo(sinIA, 'BRAND').origen, 'pieza');
  // Cada obligatorio vacío trae su motivo.
  for (const a of sinIA.cuerpo.propuesta.atributos.filter((x: any) => x.requerido && !x.valor_sugerido)) assert.ok(a.motivo, a.id);
}));

test('preparar: sin marca ni talla el motivo lo dice; sin_ia no llama al modelo', () => conML(async (t) => {
  t.sim.ia = () => ({});
  const r = await t.pedir(`/api/ml/preparar/${pieza(t, { marca: '' })}`, { sin_ia: true });
  assert.equal(t.sim.pedidosIA.length, 0);
  assert.match(atributo(r, 'BRAND').motivo, /no tiene marca/);
  assert.match(atributo(r, 'SIZE').motivo, /no tiene talla/);
}));

test('publicar manda tal cual lo propuesto (GTIN, razón de GTIN vacío, unidades) junto con ITEM_CONDITION', () => conML(async (t) => {
  const id = pieza(t, { upc: '012345678905' });
  const r = await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar({ atributos: [
    { id: 'GTIN', value_name: '012345678905' }, { id: 'MODEL', value_name: 'Jeans 501 Hombre' },
    { id: 'UNITS_PER_PACK', value_name: '1' }, { id: 'GENDER', value_id: '339666' },
  ] }));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const enviado = t.sim.de('POST', /^\/items$/)[0].cuerpo.attributes;
  assert.deepEqual(enviado.map((a: any) => a.id), ['GTIN', 'MODEL', 'UNITS_PER_PACK', 'GENDER', 'ITEM_CONDITION', 'SIZE_GRID_ID', 'SIZE_GRID_ROW_ID']);
  assert.equal(enviado.find((a: any) => a.id === 'ITEM_CONDITION').value_id, '2230284');
}));

test('preparar: avisos de marca restringida, sin marca, precio mínimo y foto chica', async () => {
  await conML(async (t) => {
    const nike = pieza(t, { marca: 'Nike', nombre: 'Playera Nike', precio: 900, foto_key: 'fotos/chica.jpg' });
    (t.env.FOTOS as any).objetos.set('fotos/chica.jpg', jpeg(400, 300).buffer);
    const avisos: string[] = (await t.pedir(`/api/ml/preparar/${nike}`, {})).cuerpo.propuesta.avisos;
    assert.ok(avisos.some((a) => /Nike.*restringida/.test(a)), avisos.join('|'));
    assert.ok(avisos.some((a) => /\$35/.test(a)));
    assert.ok(avisos.some((a) => /400 x 300/.test(a)));
    const sinMarca = pieza(t, { marca: '' });
    assert.ok((await t.pedir(`/api/ml/preparar/${sinMarca}`, {})).cuerpo.propuesta.avisos.some((a: string) => /no tiene marca/.test(a)));
  });
});

const detectado = (...nombres: string[]) => ({ cuerpo: { pictures: [{ id: 'pieza', results: { thumbnail: {
  action: 'diagnostic', detections: nombres.map((name) => ({ name, wordings: [{ kind: 'REMEDY_SHORT', value: 'x' }] })),
} } }] } });
const avisoFoto = (r: any) => r.cuerpo.propuesta.avisos.find((a: string) => /diagnóstico/.test(a));

test('preparar: el diagnóstico de la foto (#564) avisa lo que falla, y con foto válida no avisa', () => conML(async (t) => {
  const valida = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(avisoFoto(valida), undefined, valida.cuerpo.propuesta.avisos.join('|'));
  const [llamada] = t.sim.de('POST', /^\/moderations\/pictures\/diagnostic$/);
  assert.deepEqual(llamada.cuerpo.context, { category_id: 'MLM194175', picture_type: 'thumbnail' });
  assert.ok(llamada.cuerpo.pictures[0].base64.length > 10);

  t.sim.diagnostico = detectado('white_background', 'text_logo');
  const mala = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(mala.status, 200);
  assert.match(avisoFoto(mala), /fondo no blanco, texto o logo visible.*publicar igual/);
}));

test('preparar: si el diagnóstico de la foto falla (red o cuota), Preparar sigue y lo dice', () => conML(async (t) => {
  t.sim.diagnostico = { status: 429, cuerpo: { message: 'quota exceeded', error: 'too_many_requests', status: 429 } };
  const cuota = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(cuota.status, 200);
  assert.match(avisoFoto(cuota), /No se pudo revisar la foto.*publicar igual/);
  assert.equal(cuota.cuerpo.propuesta.categoria_id, 'MLM194175');

  t.sim.antesDe = async (l) => { if (l.ruta.includes('/moderations/')) throw new Error('sin red'); };
  const red = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(red.status, 200);
  assert.match(avisoFoto(red), /No se pudo revisar la foto.*sin red/);
  assert.equal(red.cuerpo.propuesta.categoria_id, 'MLM194175');

  t.sim.antesDe = null;
  t.sim.diagnostico = { cuerpo: { algo: 'raro' } };
  assert.match(avisoFoto(await t.pedir(`/api/ml/preparar/${pieza(t)}`, {})), /formato que no se entendió/);
}));

test('preparar con categoria_id: usa esa categoría y sigue ofreciendo las sugerencias', async () => {
  await conML(async (t) => {
    const r = await t.pedir(`/api/ml/preparar/${pieza(t)}`, { categoria_id: 'MLM1234' });
    const p = r.cuerpo.propuesta;
    assert.equal(p.categoria_id, 'MLM1234');
    assert.equal(p.dominio, 'MLM-SHORTS');
    assert.equal(p.sugerencias.length, 2);
    assert.ok(t.sim.de('GET', /^\/categories\/MLM1234\/attributes$/).length === 1);
    assert.equal(p.guia_tallas, null);
    assert.deepEqual(p.atributos.map((a: any) => a.id), ['BRAND']);
    // Una categoria fuera de las sugerencias tambien vale; un id raro no.
    assert.equal((await t.pedir(`/api/ml/preparar/${pieza(t)}`, { categoria_id: 'MLM999' })).cuerpo.propuesta.categoria_id, 'MLM999');
    assert.equal((await t.pedir(`/api/ml/preparar/${pieza(t)}`, { categoria_id: '../x' })).status, 400);
  });
});

/* ---------- publicar ---------- */

test('publicar conserva el tipo de la imagen guardada en R2 (#413)', () => conML(async (t) => {
  const id = pieza(t);
  await t.env.FOTOS.put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/png' } });
  await publicarPieza(t, id);
  const [subida] = t.sim.de('POST', /^\/pictures\/items\/upload$/);
  assert.equal(subida.cuerpo.tipo, 'image/png');
  assert.equal(subida.cuerpo.archivo, 3);
}));

test('publicar (modelo clásico): foto de R2, título, precio en pesos, guía y descripción', async () => {
  await conML(async (t) => {
    const id = pieza(t);
    const r = await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar());
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    assert.deepEqual({ ...r.cuerpo.publicacion, publicado_en: 'x', actualizado_en: 'x' }, {
      producto_id: id, ml_item_id: 'MLM100', estado: 'activa', precio_ml: 29900, categoria_id: 'MLM194175',
      permalink: 'https://articulo.mercadolibre.com.mx/MLM100', ultimo_error: '', publicado_en: 'x', actualizado_en: 'x',
    });
    const subida = t.sim.de('POST', /^\/pictures\/items\/upload$/);
    assert.equal(subida.length, 1);
    assert.equal(subida[0].cuerpo.archivo, jpeg(1200, 1200).length);   // los bytes salieron de R2

    const item = t.sim.de('POST', /^\/items$/)[0].cuerpo;
    assert.equal(item.title, 'Jeans Levis 501 Hombre');
    assert.equal('family_name' in item, false);
    assert.deepEqual({ ...item, attributes: undefined }, {
      title: 'Jeans Levis 501 Hombre', category_id: 'MLM194175', price: 299, currency_id: 'MXN', available_quantity: 3,
      buying_mode: 'buy_it_now', condition: 'new', listing_type_id: 'gold_special', pictures: [{ id: 'PIC-1' }],
      attributes: undefined, shipping: { mode: 'me2', local_pick_up: false, free_shipping: false },
    });
    const attrs = Object.fromEntries(item.attributes.map((a: any) => [a.id, a.value_id ?? a.value_name]));
    assert.deepEqual(attrs, { BRAND: "Levi's", SIZE: '32', COLOR: 'Azul', ITEM_CONDITION: '2230284', SIZE_GRID_ID: '26008', SIZE_GRID_ROW_ID: '26008:1' });
    assert.deepEqual(t.sim.de('POST', /\/description$/)[0].cuerpo, { plain_text: 'Jeans nuevos' });
    assert.equal(stockDe(t, id), 3);   // publicar no mueve existencias

    // Ya publicada: 409.
    assert.equal((await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar())).status, 409);
  });
});

test('descripción por defecto (#565): ropa con talla -> US y MX, estado y origen; sin talla no inventa nada', () => {
  const base = { nombre: "Jeans Levi's 501 Hombre", marca: "Levi's", categoria: 'ropa' };
  const cierre = ['Condición: nuevo.', 'Mercancía americana, pieza única.', 'Incluye solo lo que se ve en las fotos.'];
  assert.equal(descripcionPorDefecto({ ...base, talla: 'M' }),
    ["Jeans Levi's 501 Hombre", "Marca: Levi's", 'Talla US: M', 'Talla MX: M (mediana)', ...cierre].join('\n'));
  // Sin talla: solo nombre, marca y lo fijo; nada de tallas ni medidas inventadas.
  assert.equal(descripcionPorDefecto({ ...base, talla: null }), ["Jeans Levi's 501 Hombre", "Marca: Levi's", ...cierre].join('\n'));
  // Calzado: la talla guardada son los cm de MX; la US sale de la tabla.
  assert.match(descripcionPorDefecto({ ...base, talla: '26' }), /Talla MX: 26 cm\nTalla US: 8 hombre \/ 9 mujer\n/);
  assert.match(descripcionPorDefecto({ ...base, talla: 'Niño 19.5' }), /Talla MX: 19.5 cm\nTalla US: 13.5C\n/);
  assert.match(descripcionPorDefecto({ ...base, talla: 'Niño 6 años / S' }), /\nTalla: Niño 6 años \(talla S\)\n/);
  // Fuera de ropa no hay talla; sin emojis ni signos; sin enlaces ni correos.
  assert.equal(descripcionPorDefecto({ nombre: 'Lego 🚀 Set <b>', marca: '', categoria: 'juguetes', talla: 'M' }),
    ['Lego  Set b', ...cierre].join('\n'));
  assert.ok(!/https?:|www\.|@/.test(descripcionPorDefecto({ ...base, nombre: 'Playera www.tienda.com ventas@x.mx', talla: 'M' })));
});

test('publicar: sin descripción del dueño va la plantilla; con ella, la del dueño', () => conML(async (t) => {
  const id = pieza(t, { talla: 'L' });
  assert.equal((await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar({ descripcion: '' }))).status, 201);
  const texto = t.sim.de('POST', /\/description$/)[0].cuerpo.plain_text as string;
  assert.match(texto, /Talla US: L\nTalla MX: L \(grande\)\n/);
  assert.match(texto, /Mercancía americana, pieza única\./);
  await publicarPieza(t);   // cuerpoPublicar trae «Jeans nuevos»
  assert.deepEqual(t.sim.de('POST', /\/description$/)[1].cuerpo, { plain_text: 'Jeans nuevos' });
}));

test('publicar: dos clics a la vez crean un solo artículo', async () => {
  await conML(async (t) => {
    const id = pieza(t);
    const [a, b] = await Promise.all([t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar()), t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar())]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal(t.sim.de('POST', /^\/items$/).length, 1);
  });
});

test('publicar (User Products): family_name y no title', async () => {
  await conML(async (t) => {
    t.sim.tags = ['user_product_seller'];
    const r = await t.pedir(`/api/ml/publicar/${pieza(t)}`, cuerpoPublicar({ guia_fila_id: undefined }));
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    const item = t.sim.de('POST', /^\/items$/)[0].cuerpo;
    assert.equal(item.family_name, 'Jeans Levis 501 Hombre');
    assert.equal('title' in item, false);
    assert.ok(!item.attributes.some((a: any) => a.id === 'SIZE_GRID_ID'));
    assert.equal(JSON.parse((t.db.prepare('select tags from ml_cuenta').get() as any).tags)[0], 'user_product_seller');
  });
});

test('publicar: error de validación de ML -> 422 en español, estado error, y se puede reintentar', async () => {
  await conML(async (t) => {
    const id = pieza(t);
    t.sim.rechazarItem = { message: 'Validation error', error: 'validation_error', status: 400,
      cause: [{ code: 'moderations.seller.not_authorized', message: 'Seller is not authorized for this brand and category', type: 'error' },
        { code: 'x', message: 'solo un aviso', type: 'warning' }] };
    const r = await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar());
    assert.equal(r.status, 422);
    assert.match(r.cuerpo.detalle, /no está autorizada para vender esta marca/);
    assert.ok(!r.cuerpo.detalle.includes('solo un aviso'));
    assert.equal(r.cuerpo.causas.length, 1);
    assert.match(r.cuerpo.causas[0].texto, /no está autorizada/);
    assert.equal(r.cuerpo.causas[0].mensaje, 'Seller is not authorized for this brand and category');
    const fila = t.db.prepare('select estado, ml_item_id, ultimo_error from ml_publicaciones where producto_id = ?').get(id) as any;
    assert.equal(fila.estado, 'error');
    assert.equal(fila.ml_item_id, null);
    assert.match(fila.ultimo_error, /no está autorizada/);
    // Sigue en pendientes, con el error a la vista, para reintentar.
    const lista = (await t.pedir('/api/ml/piezas')).cuerpo.piezas;
    assert.equal(lista[0].publicacion.estado, 'error');

    t.sim.rechazarItem = null;
    assert.equal((await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar())).status, 201);
    assert.equal(estadoDe(t, id), 'activa');
  });
});

test('publicar: dañadas, bandas, sin revisar, sin existencias o inexistentes no se publican (409/404)', async () => {
  await conML(async (t) => {
    const casos: [string, string, number][] = [
      [pieza(t, { estado_fisico: 'danado' }), 'dañado', 409],
      [pieza(t, { estado_fisico: 'liquidacion' }), 'liquidación', 409],
      [pieza(t, { destino: 'banda_ju49', sin_inventario: 1, codigo: 'XX49', stock: 0 }), 'bandas', 409],
      [pieza(t, { estado_analisis: 'pendiente' }), 'revisa', 409],
      [pieza(t, { stock: 0 }), 'existencias', 409],
      [pieza(t, { foto_key: '' }), 'foto', 409],
      ['a9999999-1111-4111-8111-111111111111', 'no existe', 404],
    ];
    for (const [id, texto, status] of casos) {
      for (const ruta of ['preparar', 'publicar']) {
        const r = await t.pedir(`/api/ml/${ruta}/${id}`, ruta === 'publicar' ? cuerpoPublicar() : {});
        assert.equal(r.status, status, `${ruta} ${texto}`);
        assert.match(r.cuerpo.error, new RegExp(texto, 'i'));
      }
    }
    assert.equal(t.sim.de('POST', /^\/items$/).length, 0);
    // Cuerpo malo: 400 antes de tocar ML.
    const buena = pieza(t);
    assert.equal((await t.pedir(`/api/ml/publicar/${buena}`, cuerpoPublicar({ precio_ml: 3000 }))).status, 400);
    assert.equal((await t.pedir(`/api/ml/publicar/${buena}`, cuerpoPublicar({ titulo: '' }))).status, 400);
    assert.equal((await t.pedir(`/api/ml/publicar/${buena}`, cuerpoPublicar({ categoria_id: 'x' }))).status, 400);
  });
});

test('pausar y reactivar: cambian ML y la fila; sin existencias no se reactiva', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t);
    const p = await t.pedir(`/api/ml/pausar/${id}`, {});
    assert.equal(p.status, 200);
    assert.equal(p.cuerpo.publicacion.estado, 'pausada');
    assert.equal(t.sim.items.get(itemId)!.status, 'paused');
    assert.equal((await t.pedir(`/api/ml/pausar/${id}`, {})).status, 409);   // ya esta pausada
    const r = await t.pedir(`/api/ml/reactivar/${id}`, {});
    assert.equal(r.cuerpo.publicacion.estado, 'activa');
    assert.deepEqual(t.sim.items.get(itemId), { id: itemId, status: 'active', available_quantity: 3 });
    t.db.prepare('update productos set stock = 0 where id = ?').run(id);
    await t.pedir(`/api/ml/pausar/${id}`, {});
    assert.equal((await t.pedir(`/api/ml/reactivar/${id}`, {})).status, 409);
    assert.equal((await t.pedir(`/api/ml/pausar/${pieza(t)}`, {})).status, 404);   // sin publicar
  });
});

test('piezas: pendientes, publicadas y todas; 50 por página', async () => {
  await conML(async (t) => {
    const a = pieza(t);
    const dañada = pieza(t, { estado_fisico: 'danado' });
    pieza(t, { destino: 'banda_ju49', sin_inventario: 1, codigo: 'XX49' });
    let r = (await t.pedir('/api/ml/piezas?filtro=pendientes')).cuerpo;
    assert.deepEqual(r.piezas.map((x: any) => x.producto.id), [a]);
    assert.equal(r.piezas[0].publicacion, null);
    assert.equal(r.hay_mas, false);
    assert.deepEqual(Object.keys(r.piezas[0].producto).sort(), ['categoria', 'codigo', 'estado_fisico', 'id', 'marca', 'nombre', 'precio', 'stock']);

    await publicarPieza(t, a);
    assert.equal((await t.pedir('/api/ml/piezas?filtro=pendientes')).cuerpo.piezas.length, 0);
    r = (await t.pedir('/api/ml/piezas?filtro=publicadas')).cuerpo;
    assert.equal(r.piezas.length, 1);
    assert.deepEqual(Object.keys(r.piezas[0].publicacion).sort(), ['actualizado_en', 'estado', 'ml_item_id', 'permalink', 'precio_ml', 'ultimo_error']);
    assert.equal(r.piezas[0].publicacion.estado, 'activa');
    assert.deepEqual((await t.pedir('/api/ml/piezas?filtro=todas')).cuerpo.piezas.map((x: any) => x.producto.id), [a]);
    assert.ok(!(await t.pedir('/api/ml/piezas?filtro=todas')).cuerpo.piezas.some((x: any) => x.producto.id === dañada));

    for (let i = 0; i < 51; i++) pieza(t);
    const p1 = (await t.pedir('/api/ml/piezas')).cuerpo;
    assert.equal(p1.piezas.length, 50);
    assert.equal(p1.hay_mas, true);
    const p2 = (await t.pedir('/api/ml/piezas?pagina=2')).cuerpo;
    assert.equal(p2.piezas.length, 1);
    assert.equal(p2.hay_mas, false);
  });
});

/* ---------- notificaciones y existencias ---------- */

test('notificaciones: ruta equivocada 404; ruta correcta 200 sin sesión de Access', async () => {
  await conML(async (t) => {
    // Con Access "real" y sin JWT, todo lo demas da 401; el aviso de ML pasa.
    (t.env as any).ACCESS_EQUIPO = 'equipo.cloudflareaccess.com';
    assert.equal((await t.pedir('/api/ml/estado')).status, 401);
    assert.equal((await t.pedir('/api/ml/notificaciones/otra-ruta', { topic: 'orders_v2', user_id: 555 })).status, 404);
    assert.equal((await t.pedir(`/api/ml/notificaciones/${RUTA}x`, { topic: 'orders_v2', user_id: 555 })).status, 404);
    const ok = await avisar(t, '/orders/1');
    assert.equal(ok.status, 200);
    assert.equal(ok.cuerpo.ok, true);
    await t.esperar();
    assert.equal((t.db.prepare('select count(*) n from ml_notificaciones').get() as any).n, 1);
    // Solo POST.
    const get = await worker.fetch!(new Request(`https://caja.prueba/api/ml/notificaciones/${RUTA}`) as never, t.env, t.ctx as never);
    assert.equal(get.status, 401);
    // Sin ML_RUTA_NOTIFICACIONES configurada, ninguna ruta sirve.
    delete (t.env as any).ML_RUTA_NOTIFICACIONES;
    assert.equal((await t.pedir('/api/ml/notificaciones/', { user_id: 555 })).status, 401);
    assert.equal((await avisar(t, '/orders/1')).status, 404);
  });
});

test('notificaciones: también por el host público del portal; el resto del portal sigue cerrado', async () => {
  await conML(async (t) => {
    (t.env as any).HOST_PORTAL = 'dolarones.prueba';
    const aviso = (ruta: string) => worker.fetch!(new Request(`https://dolarones.prueba/api/ml/notificaciones/${ruta}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ topic: 'items', resource: '/items/MLM1', user_id: 555 }),
    }) as never, t.env, t.ctx as never);
    assert.equal((await aviso(RUTA)).status, 200);
    assert.equal((await aviso('mal')).status, 404);
    const otra = await worker.fetch!(new Request('https://dolarones.prueba/api/ml/estado') as never, t.env, t.ctx as never);
    assert.equal(otra.status, 404);
    await t.esperar();
  });
});

test('aviso de otra cuenta, o sin cuenta conectada: se ignora; el cuerpo nunca se cree', async () => {
  await conML(async (t) => {
    const { id } = await publicarPieza(t);
    const ajeno = await avisar(t, '/orders/1', { user_id: 999 });
    assert.equal(ajeno.status, 200);
    assert.equal(ajeno.cuerpo.ignorada, true);
    assert.equal((t.db.prepare('select count(*) n from ml_notificaciones').get() as any).n, 0);
    // Una orden que ML no conoce (aviso falso): se pide a ML, da 404, no se mueve nada.
    assert.equal((await avisar(t, '/orders/777', { order_items: [{ item: { id: 'MLM100' }, quantity: 3 }] })).status, 200);
    await t.esperar();
    assert.equal(stockDe(t, id), 3);
    assert.match((t.db.prepare('select error from ml_notificaciones').get() as any).error, /Order not found/);
    assert.equal(t.sim.de('GET', /^\/orders\/777$/).length, 1);
  });
  await conML(async (t) => {
    assert.equal((await avisar(t, '/orders/1')).cuerpo.ignorada, true);
  }, false);
});

test('venta en ML: descuenta una sola vez por orden, aunque el aviso llegue repetido', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t);
    t.sim.ordenes.set('9001', orden(9001, 'paid', [[itemId, 1]]));
    await avisar(t, '/orders/9001');
    await t.esperar();
    assert.equal(stockDe(t, id), 2);
    await avisar(t, '/orders/9001');
    await avisar(t, '/orders/9001', { topic: 'orders_v2', attempts: 2 });
    await t.esperar();
    assert.equal(stockDe(t, id), 2);
    const venta = t.db.prepare('select * from ml_ventas').get() as any;
    assert.deepEqual([venta.order_id, venta.ml_item_id, venta.cantidad, venta.estado, venta.descontado, venta.conflicto], ['9001', itemId, 1, 'descontada', 1, 0]);
    assert.equal((t.db.prepare('select count(*) n from ml_ventas').get() as any).n, 1);
    assert.equal(estadoDe(t, id), 'activa');   // quedan 2
    // No toca ventas ni cortes: no hay cajon de por medio.
    assert.equal((t.db.prepare('select count(*) n from ventas').get() as any).n, 0);
    // Una orden aun no pagada no descuenta.
    t.sim.ordenes.set('9002', orden(9002, 'confirmed', [[itemId, 1]]));
    await avisar(t, '/orders/9002');
    await t.esperar();
    assert.equal(stockDe(t, id), 2);
    // Otro articulo que no es nuestro, u otro vendedor: nada.
    t.sim.ordenes.set('9003', orden(9003, 'paid', [['MLM999999', 1]]));
    t.sim.ordenes.set('9004', orden(9004, 'paid', [[itemId, 1]], 777));
    await avisar(t, '/orders/9003');
    await avisar(t, '/orders/9004');
    await t.esperar();
    assert.equal(stockDe(t, id), 2);
  });
});

test('venta en ML: un correo a los dueños por venta; sin existencias en D1, el asunto pide cancelar (#427)', async () => {
  await conML(async (t) => {
    const enviados: any[] = [];
    t.env.CORREO = { async send(m: any) { enviados.push(m); return { messageId: 'x' }; } } as never;
    const { id, itemId } = await publicarPieza(t);
    const codigo = (t.db.prepare('select codigo from productos where id = ?').get(id) as { codigo: string }).codigo;
    t.sim.ordenes.set('9101', { ...orden(9101, 'paid', [[itemId, 1]]), order_items: [{ item: { id: itemId }, quantity: 1, unit_price: 299 }] });
    await avisar(t, '/orders/9101');
    await avisar(t, '/orders/9101');
    await t.esperar();
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].to, DUENO);
    assert.match(enviados[0].subject, new RegExp(`^Vendido en Mercado Libre: ${codigo}`));
    assert.match(enviados[0].text, /a \$299\.00[\s\S]*ventas\/9101\/detalle/);
    assert.match(enviados[0].text, /Márcala atendida en https:\/\/escaner\.prueba\/avisos/);   // #429
    // Se vendió todo en tienda y luego llega otra venta de ML.
    t.db.prepare('update productos set stock = 0 where id = ?').run(id);
    t.sim.ordenes.set('9102', orden(9102, 'paid', [[itemId, 1]]));
    await avisar(t, '/orders/9102');
    await t.esperar();
    assert.equal(enviados.length, 2);
    assert.match(enviados[1].subject, /^¡Sin existencias!/);
    assert.match(enviados[1].text, /Cancela la venta en Mercado Libre/);
  });
});

test('centro de avisos: la venta espera en /avisos hasta que un cajero la marca; si ML la cancela, vuelve (#429)', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t);
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
      ('cajera@prueba.mx', 'Cajera', 'cajero', 1, '', ''), ('captura@prueba.mx', 'Captura', 'capturista', 1, '', '')`).run();
    t.sim.ordenes.set('9201', orden(9201, 'paid', [[itemId, 1]]));
    await avisar(t, '/orders/9201');
    await t.esperar();

    t.env.DEV_USUARIO = 'captura@prueba.mx';
    assert.equal((await t.pedir('/api/avisos')).status, 403);
    t.env.DEV_USUARIO = 'cajera@prueba.mx';
    const lista = (await t.pedir('/api/avisos')).cuerpo.ventas_ml;
    assert.equal(lista.length, 1);
    assert.deepEqual([lista[0].order_id, lista[0].ml_item_id, lista[0].producto_id, lista[0].estado, lista[0].conflicto], ['9201', itemId, id, 'descontada', false]);

    const marcar = () => t.pedir(`/api/avisos/ml/9201/${itemId}`, {});
    assert.equal((await marcar()).status, 200);
    assert.equal((await marcar()).status, 409);
    assert.equal((await t.pedir('/api/avisos')).cuerpo.ventas_ml.length, 0);
    assert.equal((t.db.prepare('select atendida_por from ml_ventas').get() as any).atendida_por, 'cajera@prueba.mx');

    // ML la cancela despues de empacarla: vuelve a la lista para regresar la pieza al piso.
    t.sim.ordenes.set('9201', orden(9201, 'cancelled', [[itemId, 1]]));
    await avisar(t, '/orders/9201');
    await t.esperar();
    const otra = (await t.pedir('/api/avisos')).cuerpo.ventas_ml;
    assert.deepEqual(otra.map((v: any) => v.estado), ['cancelada']);
    assert.equal(stockDe(t, id), 3);
  });
});

test('centro de avisos: la cancelación de un conflicto no vuelve; una venta a medias que ML cancela deja de pedir empacarla (#429)', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t);
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cajera@prueba.mx', 'Cajera', 'cajero', 1, '', '')`).run();
    t.env.DEV_USUARIO = 'cajera@prueba.mx';
    const pendientes = async () => (await t.pedir('/api/avisos')).cuerpo.ventas_ml.map((v: any) => [v.order_id, v.estado]);

    // Sin existencias: la cajera cancela en ML como se le pidio; el aviso de ML no la regresa.
    t.db.prepare('update productos set stock = 0 where id = ?').run(id);
    t.sim.ordenes.set('9301', orden(9301, 'paid', [[itemId, 1]]));
    await avisar(t, '/orders/9301');
    await t.esperar();
    assert.equal((await t.pedir(`/api/avisos/ml/9301/${itemId}`, {})).status, 200);
    t.sim.ordenes.set('9301', orden(9301, 'cancelled', [[itemId, 1]]));
    await avisar(t, '/orders/9301');
    await t.esperar();
    assert.deepEqual(await pendientes(), []);
    assert.equal(stockDe(t, id), 0);

    // El proceso murio entre el insert y el batch de pago (estado 'recibida', sin descontar) y ML la cancela.
    t.db.prepare('update productos set stock = 3 where id = ?').run(id);
    t.db.prepare(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, recibido_en) values ('9302', ?, ?, 1, 'recibida', ?)`)
      .run(itemId, id, new Date().toISOString());
    t.sim.ordenes.set('9302', orden(9302, 'cancelled', [[itemId, 1]]));
    await avisar(t, '/orders/9302');
    await t.esperar();
    assert.deepEqual(await pendientes(), [['9302', 'cancelada']]);
    assert.equal(stockDe(t, id), 3);
  });
});

test('publicar: si la pieza se vende en tienda mientras ML la crea, queda pausada en ML (no se vende de mas)', async () => {
  await conML(async (t) => {
    const id = pieza(t, { stock: 1 });
    let vendida = false;
    t.sim.antesDe = async (l) => {
      if (l.metodo === 'POST' && l.ruta === '/items' && !vendida) {
        vendida = true;
        const r = await t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: id, cantidad: 1 }], forma_pago: 'tarjeta' });
        assert.equal(r.status, 201);
        await t.esperar();
      }
    };
    const { itemId } = await publicarPieza(t, id);
    await t.esperar();
    assert.equal(stockDe(t, id), 0);
    assert.equal(estadoDe(t, id), 'pausada_por_venta');
    assert.equal(t.sim.items.get(itemId)!.status, 'paused');
  });
});

test('venta en ML de la última pieza: stock 0 y publicación vendida; si D1 ya no tenía, queda en conflicto', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t, pieza(t, { stock: 1 }));
    t.sim.ordenes.set('9101', orden(9101, 'paid', [[itemId, 1]]));
    await avisar(t, '/orders/9101');
    await t.esperar();
    assert.equal(stockDe(t, id), 0);
    assert.equal(estadoDe(t, id), 'vendida');
    // Otra orden por la misma pieza que ya no existe: no baja de 0 y se marca conflicto.
    t.sim.ordenes.set('9102', orden(9102, 'paid', [[itemId, 1]]));
    await avisar(t, '/orders/9102');
    await t.esperar();
    assert.equal(stockDe(t, id), 0);
    const venta = t.db.prepare(`select estado, descontado, conflicto from ml_ventas where order_id = '9102'`).get() as any;
    assert.deepEqual({ ...venta }, { estado: 'descontada', descontado: 0, conflicto: 1 });
    // Si ML cancela la que si descontaba, vuelve la pieza; la del conflicto no suma nada.
    t.sim.ordenes.set('9102', orden(9102, 'cancelled', [[itemId, 1]]));
    await avisar(t, '/orders/9102');
    await t.esperar();
    assert.equal(stockDe(t, id), 0);
    t.sim.ordenes.set('9101', orden(9101, 'cancelled', [[itemId, 1]]));
    await avisar(t, '/orders/9101');
    await t.esperar();
    assert.equal(stockDe(t, id), 1);
    // ...y ya se reactivo en ML (la conciliacion sigue al aviso).
    assert.equal(estadoDe(t, id), 'activa');
    assert.equal(t.sim.items.get(itemId)!.status, 'active');
  });
});

test('ventas en ML: lista (nuevas primero), conflictos y conteos del estado', async () => {
  await conML(async (t) => {
    const vacio = (await t.pedir('/api/ml/ventas')).cuerpo;
    assert.deepEqual(vacio, { ventas: [], pendientes_conflicto: 0, hay_mas: false });
    assert.deepEqual([(await t.pedir('/api/ml/estado')).cuerpo.ventas_sin_despachar, (await t.pedir('/api/ml/estado')).cuerpo.conflictos], [0, 0]);

    const { id, itemId } = await publicarPieza(t, pieza(t, { stock: 1 }));
    const otra = await publicarPieza(t, pieza(t, { stock: 5, nombre: 'Playera azul' }));
    t.sim.ordenes.set('9301', orden(9301, 'paid', [[itemId, 1]]));
    t.sim.ordenes.set('9302', orden(9302, 'paid', [[itemId, 1]]));         // ya no habia: conflicto
    t.sim.ordenes.set('9303', orden(9303, 'paid', [[otra.itemId, 2]]));
    for (const n of [9301, 9302, 9303]) { await avisar(t, `/orders/${n}`); await t.esperar(); }

    const r = (await t.pedir('/api/ml/ventas')).cuerpo;
    assert.equal(r.hay_mas, false);
    assert.equal(r.pendientes_conflicto, 1);
    assert.deepEqual(r.ventas.map((v: any) => v.order_id), ['9303', '9302', '9301']);
    const v = r.ventas[1];
    assert.deepEqual(Object.keys(v).sort(), ['cantidad', 'conflicto', 'descontado', 'estado', 'ml_item_id', 'order_id', 'permalink', 'producto', 'recibido_en']);
    assert.deepEqual({ ...v, recibido_en: 'x', producto: { ...v.producto, codigo: 'x' } }, {
      order_id: '9302', ml_item_id: itemId, cantidad: 1, descontado: 0, estado: 'descontada', conflicto: 1, recibido_en: 'x',
      permalink: `https://articulo.mercadolibre.com.mx/${itemId}`,
      producto: { id, codigo: 'x', nombre: "Jeans Levi's 501 Hombre", marca: "Levi's", precio: 25000 },
    });
    assert.equal(r.ventas[0].descontado, 2);
    const e = (await t.pedir('/api/ml/estado')).cuerpo;
    assert.equal(e.ventas_sin_despachar, 3);
    assert.equal(e.conflictos, 1);

    // Las de hace mas de 7 dias ya no estan "sin despachar"; cancelada no es conflicto.
    t.db.prepare(`update ml_ventas set recibido_en = '2020-01-01T00:00:00.000Z' where order_id = '9301'`).run();
    t.sim.ordenes.set('9302', orden(9302, 'cancelled', [[itemId, 1]]));
    await avisar(t, '/orders/9302'); await t.esperar();
    const despues = (await t.pedir('/api/ml/estado')).cuerpo;
    assert.deepEqual([despues.ventas_sin_despachar, despues.conflictos], [1, 0]);
    assert.equal((await t.pedir('/api/ml/ventas')).cuerpo.pendientes_conflicto, 0);

    // 50 por pagina.
    for (let i = 0; i < 50; i++) {
      t.db.prepare(`insert into ml_ventas (order_id, ml_item_id, producto_id, cantidad, estado, recibido_en) values (?, 'MLM1', ?, 1, 'descontada', ?)`)
        .run(`8${String(i).padStart(3, '0')}`, id, new Date(Date.now() + i * 1000).toISOString());
    }
    const p1 = (await t.pedir('/api/ml/ventas')).cuerpo;
    assert.equal(p1.ventas.length, 50);
    assert.equal(p1.hay_mas, true);
    assert.equal((await t.pedir('/api/ml/ventas?pagina=2')).cuerpo.ventas.length, 3);
  });
});

test('notificación de items: refleja lo que el dueño hizo en ML', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t);
    t.sim.items.get(itemId)!.status = 'paused';
    await t.pedir(`/api/ml/notificaciones/${RUTA}`, { topic: 'items', resource: `/items/${itemId}`, user_id: 555 });
    await t.esperar();
    assert.equal(estadoDe(t, id), 'pausada');
    assert.equal(t.sim.de('PUT', /./).length, 0);
  });
});

/* ---------- venta en tienda -> ML ---------- */

test('venta en tienda: si se agota una pieza publicada, se pausa en ML', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t, pieza(t, { stock: 1 }));
    const otra = await publicarPieza(t, pieza(t, { stock: 2 }));
    const venta = (lineas: unknown[]) => t.pedir('/api/ventas', { id: crypto.randomUUID(), lineas, forma_pago: 'tarjeta' });
    assert.equal((await venta([{ producto_id: otra.id, cantidad: 1 }])).status, 201);
    await t.esperar();
    assert.equal(t.sim.items.get(otra.itemId)!.status, 'active', 'queda una: no se pausa');
    assert.equal(t.sim.items.get(otra.itemId)!.available_quantity, 1);   // pero la cantidad se iguala (D1 manda)

    assert.equal((await venta([{ producto_id: id, cantidad: 1 }])).status, 201);
    await t.esperar();
    assert.equal(estadoDe(t, id), 'pausada_por_venta');
    assert.equal(t.sim.items.get(itemId)!.status, 'paused');

    // Se cancela la venta: la pieza regresa y el cron la reactiva.
    const ticket = t.db.prepare('select venta_id from venta_lineas where producto_id = ?').get(id) as { venta_id: string };
    assert.equal((await t.pedir(`/api/ventas/${ticket.venta_id}/cancelar`, { motivo: 'prueba' })).status, 200);
    await worker.scheduled!({ cron: '*/15 * * * *' } as never, t.env, t.ctx as never);
    await t.esperar();
    assert.equal(estadoDe(t, id), 'activa');
    assert.deepEqual(t.sim.items.get(itemId), { id: itemId, status: 'active', available_quantity: 1 });
  });
});

/* ---------- cron ---------- */

test('cron: sin cuenta conectada no llama a ML', async () => {
  await conML(async (t) => {
    await worker.scheduled!({} as never, t.env, t.ctx as never);
    await t.esperar();
    assert.equal(t.sim.llamadas.length, 0);
  }, false);
});

test('cron: pausa lo agotado, iguala cantidades, respeta pausas del dueño y recoge ordenes perdidas', async () => {
  await conML(async (t) => {
    const a = await publicarPieza(t);
    const b = await publicarPieza(t);
    const c = await publicarPieza(t);
    t.db.prepare('update productos set stock = 0 where id = ?').run(a.id);                         // vendida en tienda sin aviso
    t.sim.items.get(b.itemId)!.available_quantity = 9;                                              // ML desfasado
    await t.pedir(`/api/ml/pausar/${c.id}`, {});                                                    // pausa del dueno
    t.sim.ordenes.set('9201', orden(9201, 'paid', [[b.itemId, 1]]));                                // aviso perdido

    await worker.scheduled!({} as never, t.env, t.ctx as never);
    await t.esperar();
    assert.equal(estadoDe(t, a.id), 'pausada_por_venta');
    assert.equal(t.sim.items.get(a.itemId)!.status, 'paused');
    assert.equal(stockDe(t, b.id), 2);                                                              // la orden perdida descuenta
    assert.equal(t.sim.items.get(b.itemId)!.available_quantity, 2);
    assert.equal(estadoDe(t, c.id), 'pausada');                                                     // no se reactiva sola
    assert.equal(t.sim.items.get(c.itemId)!.status, 'paused');

    // Vuelve a haber existencias de la agotada: se reactiva.
    t.db.prepare('update productos set stock = 1 where id = ?').run(a.id);
    await worker.scheduled!({} as never, t.env, t.ctx as never);
    await t.esperar();
    assert.equal(estadoDe(t, a.id), 'activa');
    assert.equal(t.sim.items.get(a.itemId)!.status, 'active');
    // La orden ya vista no vuelve a descontar.
    assert.equal(stockDe(t, b.id), 2);
    // El dueno la reactivo en ML por su cuenta: se refleja.
    t.sim.items.get(c.itemId)!.status = 'active';
    await worker.scheduled!({} as never, t.env, t.ctx as never);
    await t.esperar();
    assert.equal(estadoDe(t, c.id), 'activa');
  });
});

test('cron: reintenta el aviso que fallo, aunque la orden sea vieja (Issue #253)', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t);
    t.sim.ordenes.set('9301', orden(9301, 'paid', [[itemId, 1]]));
    await avisar(t, '/orders/9301');
    await t.esperar();
    assert.equal(stockDe(t, id), 2);
    // La cancelacion llega dos dias despues y su unico intento falla (ML caido): queda con error.
    t.sim.ordenes.delete('9301');
    await avisar(t, '/orders/9301');
    await t.esperar();
    const vieja = new Date(Date.now() - 3_600_000).toISOString();
    t.db.prepare(`update ml_notificaciones set recibido_en = ?`).run(vieja);
    assert.equal((t.db.prepare(`select count(*) n from ml_notificaciones where error != ''`).get() as any).n, 1);
    // La busqueda de 24 h no la ve; el reintento si.
    t.sim.ordenes.set('9301', orden(9301, 'cancelled', [[itemId, 1]]));
    const buscar = t.sim.responder.bind(t.sim);
    t.sim.responder = (l) => l.ruta.startsWith('/orders/search') ? { cuerpo: { results: [] } } : buscar(l);
    await worker.scheduled!({} as never, t.env, t.ctx as never);
    await t.esperar();
    assert.equal(stockDe(t, id), 3);
    assert.equal((t.db.prepare(`select count(*) n from ml_notificaciones where error != ''`).get() as any).n, 0);
  });
});

/* ---------- permisos ---------- */

test('permisos: cajero y capturista reciben 403 en /api/ml/*; el dueño entra', async () => {
  await conML(async (t) => {
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cajero@prueba.mx', 'C', 'cajero', 1, '', '')`).run();
    t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('cap@prueba.mx', 'K', 'capturista', 1, '', '')`).run();
    const id = pieza(t);
    for (const correo of ['cajero@prueba.mx', 'cap@prueba.mx']) {
      (t.env as any).DEV_USUARIO = correo;
      for (const [ruta, cuerpo, metodo] of [
        ['/api/ml/estado', undefined, 'GET'], ['/api/ml/piezas', undefined, 'GET'], ['/api/ml/ventas', undefined, 'GET'], ['/api/ml/conectar', undefined, 'GET'],
        [`/api/ml/preparar/${id}`, {}, 'POST'], [`/api/ml/publicar/${id}`, cuerpoPublicar(), 'POST'],
        [`/api/ml/pausar/${id}`, {}, 'POST'], [`/api/ml/reactivar/${id}`, {}, 'POST'], ['/api/ml/config', { ml_pct: 50 }, 'PUT'],
      ] as [string, unknown, string][]) {
        const r = await t.pedir(ruta, cuerpo, metodo);
        assert.equal(r.status, 403, `${correo} ${metodo} ${ruta}`);
      }
      // El retorno de OAuth tambien es del dueno: un cajero va a "sin acceso".
      assert.match((await t.pedir('/ml/callback?code=x&state=y')).ubicacion!, /sin-acceso/);
      // ...pero el aviso de ML no pide sesion.
      assert.equal((await avisar(t, '/orders/1')).status, 200);
    }
    (t.env as any).DEV_USUARIO = DUENO;
    assert.equal((await t.pedir('/api/ml/estado')).status, 200);
    assert.equal(t.sim.de('POST', /^\/items$/).length, 0);
    await t.esperar();
  });
});

test('config de ML: porcentaje y tipo de publicación, validados', async () => {
  await conML(async (t) => {
    assert.equal((await t.pedir('/api/ml/config', { ml_pct: 25, ml_tipo_publicacion: 'gold_pro' }, 'PUT')).status, 200);
    assert.deepEqual((await t.pedir('/api/ml/estado')).cuerpo.config, { ml_pct: 25, ml_tipo_publicacion: 'gold_pro' });
    for (const malo of [{ ml_pct: -1 }, { ml_pct: 1.5 }, { ml_pct: 999 }, { ml_tipo_publicacion: 'gold' }, {}]) {
      assert.equal((await t.pedir('/api/ml/config', malo, 'PUT')).status, 400, JSON.stringify(malo));
    }
  });
});

test('tokens: sin ML_LLAVE_TOKENS válida no se guarda nada en claro', async () => {
  const t = tienda();
  (t.env as any).ML_LLAVE_TOKENS = 'corta';
  await assert.rejects(guardarTokens(t.env, { access_token: 'AT-0', refresh_token: 'RT-0', expires_in: 10 }), /ML_LLAVE_TOKENS/);
  assert.equal((t.db.prepare('select count(*) n from ml_cuenta').get() as any).n, 0);
});

/* ---------- categoria (Issue #186) ---------- */

test('preparar: si ML rechaza categorías con el token, las pide sin token', () => conML(async (t) => {
  t.sim.publicasSoloSinToken = true;
  const r = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.propuesta.categoria_id, 'MLM194175');
  assert.ok(r.cuerpo.propuesta.atributos.length > 0, 'los atributos también llegan sin token');
  const sinToken = t.sim.llamadas.filter((l) => l.auth === null).map((l) => l.ruta.split('?')[0]);
  assert.deepEqual(sinToken, ['/sites/MLM/domain_discovery/search', '/categories/MLM194175/attributes']);
}));

test('preparar: si ML no contesta categorías, lo dice y no inventa una', () => conML(async (t) => {
  t.sim.publicasSoloSinToken = 'todo';
  const r = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.propuesta.categoria_id, null);
  assert.ok(r.cuerpo.propuesta.avisos.some((a: string) => a.startsWith('No se pudieron pedir categorías')));
  assert.ok(r.cuerpo.propuesta.avisos.some((a: string) => a.includes('Buscar categoría')));
}));

test('preparar: busca categorías con otro texto y lo devuelve', () => conML(async (t) => {
  const id = pieza(t);
  const sin = await t.pedir(`/api/ml/preparar/${id}`, { consulta: 'sin-resultados' });
  assert.equal(sin.cuerpo.propuesta.categoria_id, null);
  const r = await t.pedir(`/api/ml/preparar/${id}`, { consulta: '  pantalon   de   mezclilla ' });
  assert.equal(r.cuerpo.propuesta.consulta, 'pantalon de mezclilla');
  assert.equal(r.cuerpo.propuesta.categoria_id, 'MLM194175');
  const ultima = t.sim.de('GET', /^\/sites\/MLM\/domain_discovery/).at(-1)!;
  assert.equal(ultima.ruta, '/sites/MLM/domain_discovery/search?q=pantalon%20de%20mezclilla&limit=4');
  // Categoria vacia = sin elegir, no un error.
  assert.equal((await t.pedir(`/api/ml/preparar/${id}`, { categoria_id: '', consulta: 'jeans' })).status, 200);
}));

/* ---------- catalogo (Issue #192) ---------- */

const juguete = (t: Tienda) => pieza(t, { categoria: 'juguetes', nombre: 'SplatRball 800 Pyro Blaster Kit', marca: 'Splat R Ball' });

test('preparar: lo nuevo de marca trae candidatos del catálogo con foto oficial', () => conML(async (t) => {
  const r = await t.pedir(`/api/ml/preparar/${juguete(t)}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(r.cuerpo.propuesta.catalogo.candidatos, [{
    id: 'MLM2001', nombre: 'Lanzador SplatRball 800 Pyro', foto: 'https://http2.mlstatic.com/a.jpg', marca: 'Splat R Ball', catalogo_obligatorio: true,
  }]);
  const [busqueda] = t.sim.de('GET', /^\/products\/search/);
  assert.match(busqueda.ruta, /^\/products\/search\?status=active&site_id=MLM&q=Splat/);
  assert.equal(t.sim.de('POST', /^\/items/).length, 0, 'no publica nada');
}));

test('preparar: la ropa no busca en el catálogo', () => conML(async (t) => {
  const r = await t.pedir(`/api/ml/preparar/${pieza(t)}`, {});
  assert.equal(r.cuerpo.propuesta.catalogo, null);
  assert.equal(t.sim.de('GET', /^\/products\/search/).length, 0);
}));

test('preparar: si ML niega el catálogo, lo dice sin romper la propuesta', () => conML(async (t) => {
  t.sim.catalogo = { status: 403, cuerpo: { message: 'forbidden', error: 'forbidden', status: 403, cause: [] } };
  const r = await t.pedir(`/api/ml/preparar/${juguete(t)}`, {});
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.deepEqual(r.cuerpo.propuesta.catalogo.candidatos, []);
  assert.match(r.cuerpo.propuesta.catalogo.error, /no dejó buscar en su catálogo \(403/);
  assert.equal(t.sim.de('GET', /^\/products\/search/).length, 2, 'con token y luego sin token');
}));

test('publicar en catálogo: sin foto propia, categoría del dominio del producto y ficha oficial', () => conML(async (t) => {
  const id = juguete(t);
  const r = await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar({ catalogo_id: 'MLM2001' }));
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const [post] = t.sim.de('POST', /^\/items$/);
  assert.equal(post.cuerpo.catalog_product_id, 'MLM2001');
  assert.equal(post.cuerpo.catalog_listing, true);
  assert.deepEqual(post.cuerpo.pictures, []);
  assert.equal(post.cuerpo.category_id, 'MLM1234', 'MLM194175 es de otro dominio: toma la del dominio del producto');
  assert.ok(!post.cuerpo.attributes.some((a: any) => a.id === 'BRAND'), 'no manda atributos propios');
  assert.equal(t.sim.de('POST', /^\/pictures/).length, 0, 'no sube la foto de la tienda');
  assert.equal(t.sim.de('POST', /\/description$/).length, 0, 'la descripción la pone ML');
  assert.equal(r.cuerpo.publicacion.categoria_id, 'MLM1234');
}));

test('publicar en catálogo: producto inactivo o id inválido no publica', () => conML(async (t) => {
  const id = juguete(t);
  assert.equal((await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar({ catalogo_id: 'x; drop' }))).status, 400);
  t.sim.productoActivo = false;
  const r = await t.pedir(`/api/ml/publicar/${id}`, cuerpoPublicar({ catalogo_id: 'MLM2001' }));
  assert.equal(r.status, 409, JSON.stringify(r.cuerpo));
  assert.equal(t.sim.de('POST', /^\/items$/).length, 0);
  assert.equal(estadoDe(t, id), 'error');
}));

/* ---------- buscar en el catalogo (Issue #195) ---------- */

test('idProductoML: id solo o enlace /p/, nunca una publicación', () => {
  assert.equal(idProductoML('MLM15149561'), 'MLM15149561');
  assert.equal(idProductoML(' mlm15149561 '), 'MLM15149561');
  assert.equal(idProductoML('https://www.mercadolibre.com.mx/lanzador-splatrball/p/MLM15149561?pdp_filters=item_id:MLM1'), 'MLM15149561');
  assert.equal(idProductoML('https://www.mercadolibre.com.mx/x/p/MLM42#reviews'), 'MLM42');
  assert.equal(idProductoML('https://articulo.mercadolibre.com.mx/MLM-123456-lanzador-_JM'), '');
  assert.equal(idProductoML('lanzador de hidrogel'), '');
});

test('preparar: busca en el catálogo con otras palabras', () => conML(async (t) => {
  const r = await t.pedir(`/api/ml/preparar/${juguete(t)}`, { consulta_catalogo: '  lanzador   hidrogel ' });
  assert.equal(r.cuerpo.propuesta.catalogo.consulta, 'lanzador hidrogel');
  assert.equal(t.sim.de('GET', /^\/products\/search/).at(-1)!.ruta, '/products/search?status=active&site_id=MLM&q=lanzador%20hidrogel&limit=5');
}));

test('preparar: con el enlace del producto lo trae directo', () => conML(async (t) => {
  const r = await t.pedir(`/api/ml/preparar/${juguete(t)}`, { consulta_catalogo: 'https://www.mercadolibre.com.mx/lanzador/p/MLM2002' });
  assert.deepEqual(r.cuerpo.propuesta.catalogo.candidatos.map((x: any) => x.id), ['MLM2002']);
  assert.equal(t.sim.de('GET', /^\/products\/search/).length, 0);
  t.sim.productoActivo = false;
  const inactivo = await t.pedir(`/api/ml/preparar/${juguete(t)}`, { consulta_catalogo: 'MLM2002' });
  assert.match(inactivo.cuerpo.propuesta.catalogo.error, /no está activo/);
}));

test('preparar: el enlace de una publicación explica qué copiar; sin marca también busca', () => conML(async (t) => {
  const r = await t.pedir(`/api/ml/preparar/${juguete(t)}`, { consulta_catalogo: 'https://articulo.mercadolibre.com.mx/MLM-123456-lanzador-_JM' });
  assert.match(r.cuerpo.propuesta.catalogo.error, /\/p\/MLM/);
  assert.equal(t.sim.de('GET', /^\/products/).length, 0);
  const sinMarca = await t.pedir(`/api/ml/preparar/${pieza(t, { categoria: 'juguetes', nombre: 'Lanzador de hidrogel', marca: '' })}`, {});
  assert.equal(sinMarca.cuerpo.propuesta.catalogo.candidatos.length, 1);
}));

test('conteo: un faltante (robo) que deja la pieza sin existencias la pausa en ML', async () => {
  await conML(async (t) => {
    const { id, itemId } = await publicarPieza(t, pieza(t, { stock: 1 }));
    const r = await t.pedir('/api/conteo/ajustes', { id: crypto.randomUUID(), esperado: 1, producto_id: id, cantidad: 1, motivo: 'robo' });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
    await t.esperar();
    assert.equal(stockDe(t, id), 0);
    assert.equal(estadoDe(t, id), 'pausada_por_venta');
    assert.equal(t.sim.items.get(itemId)!.status, 'paused');
  });
});
