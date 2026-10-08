import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';

type Tienda = ReturnType<typeof tienda>;
const HOST = 'dolarones.prueba';

function publica() {
  const t = tienda();
  t.env.HOST_PORTAL = HOST;
  const llamar = (ruta: string, method = 'GET') =>
    worker.fetch!(new Request(`https://${HOST}${ruta}`, { method }) as never, t.env, t.ctx as never);
  return { ...t, llamar };
}

let n = 0;
/** Una pieza vendible salvo lo que se cambie. */
function pieza(t: Tienda, extra: Record<string, unknown> = {}): string {
  n++;
  const f = {
    id: `c${String(n).padStart(7, '0')}-1111-4111-8111-111111111111`, codigo: `ED-${String(n + 100).padStart(6, '0')}`,
    nombre: 'Jeans', marca: 'Levis', categoria: 'ropa', precio: 25000, precio_lista: 0, estado_fisico: 'nuevo',
    estado_analisis: 'listo', destino: 'etiqueta', sin_inventario: 0, stock: 3, ...extra,
  } as Record<string, any>;
  f.foto_key = 'foto_key' in extra ? extra.foto_key : `fotos/${f.id}.jpg`;
  t.db.prepare(
    `insert into productos (id, codigo, nombre, marca, categoria, precio, precio_lista, estado_fisico, estado_analisis, destino,
       sin_inventario, stock, foto_key, semana_ingreso, creado_en, actualizado_en)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'S40', ?, '')`,
  ).run(f.id, f.codigo, f.nombre, f.marca, f.categoria, f.precio, f.precio_lista, f.estado_fisico, f.estado_analisis, f.destino,
    f.sin_inventario, f.stock, f.foto_key, new Date(2026, 9, 1, 0, 0, n).toISOString());
  if (f.foto_key) (t.env.FOTOS as any).objetos.set(f.foto_key, Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer);
  return f.codigo;
}

const leer = async (r: Response) => (await r.json()) as Record<string, any>;

test('catalogo: lista solo piezas vendibles, sin campos internos', async () => {
  const t = publica();
  try {
    const buena = pieza(t, { nombre: 'Buena' });
    pieza(t, { stock: 0 });
    pieza(t, { precio: 0 });
    pieza(t, { foto_key: '' });
    pieza(t, { estado_analisis: 'pendiente' });
    pieza(t, { codigo: 'XX0001' });
    pieza(t, { estado_fisico: 'danado' });
    pieza(t, { sin_inventario: 1 });
    pieza(t, { destino: 'banda_ju49' });
    const r = await t.llamar('/api/catalogo');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    const c = await leer(r);
    assert.equal(c.total, 1);
    assert.equal(c.pagina, 1);
    assert.equal(c.hay_mas, false);
    assert.deepEqual(c.piezas, [{
      codigo: buena, nombre: 'Buena', marca: 'Levis', categoria: 'ropa', talla: null, precio: 25000, precio_lista: 0,
      foto: `https://${HOST}/api/catalogo/foto/${buena}`,
    }]);
  } finally { t.db.close(); }
});

test('catalogo: precio_lista solo si es mayor que el precio', async () => {
  const t = publica();
  try {
    const mayor = pieza(t, { precio: 10000, precio_lista: 19900 });
    const igual = pieza(t, { precio: 10000, precio_lista: 10000 });
    const menor = pieza(t, { precio: 10000, precio_lista: 500 });
    const { piezas } = await leer(await t.llamar('/api/catalogo'));
    const lista = (c: string) => piezas.find((p: any) => p.codigo === c).precio_lista;
    assert.equal(lista(mayor), 19900);
    assert.equal(lista(igual), 0);
    assert.equal(lista(menor), 0);
  } finally { t.db.close(); }
});

test('catalogo: filtro por categoria y 400 si no existe o la pagina es invalida', async () => {
  const t = publica();
  try {
    pieza(t, { categoria: 'ropa' });
    const hogar = pieza(t, { categoria: 'hogar' });
    const c = await leer(await t.llamar('/api/catalogo?categoria=hogar'));
    assert.deepEqual(c.piezas.map((p: any) => p.codigo), [hogar]);
    assert.equal(c.total, 1);
    for (const mala of ['categoria=zapatos', 'categoria=', 'pagina=0', 'pagina=-1', 'pagina=abc', 'pagina=1.5', 'pagina=' + '9'.repeat(30)]) {
      assert.equal((await t.llamar(`/api/catalogo?${mala}`)).status, 400, mala);
    }
  } finally { t.db.close(); }
});

test('catalogo: 24 por pagina, mas nuevas primero', async () => {
  const t = publica();
  try {
    const codigos = Array.from({ length: 25 }, () => pieza(t));
    const p1 = await leer(await t.llamar('/api/catalogo'));
    assert.equal(p1.piezas.length, 24);
    assert.equal(p1.hay_mas, true);
    assert.equal(p1.total, 25);
    assert.equal(p1.piezas[0].codigo, codigos[24]);
    const p2 = await leer(await t.llamar('/api/catalogo?pagina=2'));
    assert.deepEqual(p2.piezas.map((p: any) => p.codigo), [codigos[0]]);
    assert.equal(p2.hay_mas, false);
    assert.equal(p2.pagina, 2);
    const p3 = await leer(await t.llamar('/api/catalogo?pagina=3'));
    assert.deepEqual(p3.piezas, []);
    assert.equal(p3.total, 25);
  } finally { t.db.close(); }
});

test('catalogo: CORS solo para eldolaron.com, OPTIONS 204 y otros metodos 405', async () => {
  const t = publica();
  try {
    pieza(t);
    const r = await t.llamar('/api/catalogo');
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://eldolaron.com');
    const o = await t.llamar('/api/catalogo', 'OPTIONS');
    assert.equal(o.status, 204);
    assert.equal(o.headers.get('access-control-allow-origin'), 'https://eldolaron.com');
    assert.match(o.headers.get('access-control-allow-methods') ?? '', /GET/);
    assert.equal((await t.llamar('/api/catalogo/foto/ED-000001', 'OPTIONS')).status, 204);
    assert.equal((await t.llamar('/api/catalogo', 'POST')).status, 405);
    assert.equal((await t.llamar('/api/catalogo/foto/ED-000001', 'DELETE')).status, 405);
  } finally { t.db.close(); }
});

test('catalogo: foto solo de piezas vendibles', async () => {
  const t = publica();
  try {
    const buena = pieza(t);
    const r = await t.llamar(`/api/catalogo/foto/${buena}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);
    for (const extra of [{ stock: 0 }, { precio: 0 }, { estado_analisis: 'pendiente' }, { estado_fisico: 'danado' }, { sin_inventario: 1 }]) {
      assert.equal((await t.llamar(`/api/catalogo/foto/${pieza(t, extra)}`)).status, 404, JSON.stringify(extra));
    }
    // Pieza vendible cuya foto ya no esta en R2.
    const huerfana = pieza(t);
    (t.env.FOTOS as any).objetos.clear();
    assert.equal((await t.llamar(`/api/catalogo/foto/${huerfana}`)).status, 404);
    for (const mala of ['ED-999999', 'ED-', 'ED-1234567890123', 'ed-000101', 'XX0001', '..%2Fx', 'ED-1/x']) {
      assert.equal((await t.llamar(`/api/catalogo/foto/${mala}`)).status, 404, mala);
    }
  } finally { t.db.close(); }
});

test('catalogo: el host publico no abre rutas del personal', async () => {
  const t = publica();
  try {
    for (const ruta of ['/api/productos', '/caja', '/admin', '/api/yo', '/api/foto/a1111111-1111-4111-8111-111111111111', '/api/catalogo/otra']) {
      assert.equal((await t.llamar(ruta)).status, 404, ruta);
    }
  } finally { t.db.close(); }
});

test('catalogo destacados: mas vendido en 14 dias y vendible primero; completa con lo mas nuevo', async () => {
  const t = publica();
  try {
    pieza(t, { nombre: 'Vieja' });
    const hot = pieza(t, { nombre: 'Hot' });
    const tibia = pieza(t, { nombre: 'Tibia' });
    const cancelada = pieza(t, { nombre: 'Cancelada' });
    const agotada = pieza(t, { nombre: 'Agotada', stock: 0 });
    const antigua = pieza(t, { nombre: 'Antigua' });
    pieza(t, { nombre: 'Nueva' });
    const hoy = new Date().toISOString();
    const mes = new Date(Date.now() - 30 * 86_400_000).toISOString();
    let v = 0;
    const venta = (codigo: string, cantidad: number, creado: string, canc = 0) => {
      const id = `v${++v}`;
      t.db.prepare(`insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en, cancelada)
        values (?, 100, 'efectivo', 100, 0, ?, ?, ?)`).run(id, creado, creado, canc);
      t.db.prepare('insert into venta_lineas (venta_id, codigo, nombre, precio, cantidad) values (?, ?, ?, 100, ?)').run(id, codigo, 'x', cantidad);
    };
    venta(hot, 3, hoy);
    venta(tibia, 1, hoy);
    venta(cancelada, 9, hoy, 1);
    venta(agotada, 9, hoy);
    venta(antigua, 9, mes);
    const r = await t.llamar('/api/catalogo/destacados');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://eldolaron.com');
    const nombres = (await leer(r)).piezas.map((p: any) => p.nombre);
    assert.deepEqual(nombres, ['Hot', 'Tibia', 'Nueva', 'Antigua', 'Cancelada', 'Vieja']);
    assert.ok(!nombres.includes('Agotada'));
  } finally { t.db.close(); }
});

test('catalogo (Issue #220): nombre interno o sin foto o sin precio no sale en lista ni en destacados', async () => {
  const t = publica();
  try {
    const buena = pieza(t, { nombre: 'Blusa floreada' });
    const tarjeta = pieza(t, { nombre: 'Tarjeta regalo PlayStation Store $100' });
    pieza(t, { nombre: 'DAMA 150 12' });
    pieza(t, { nombre: 'Sin foto', foto_key: '' });
    pieza(t, { nombre: 'Sin precio', precio: 0 });
    const lista = await leer(await t.llamar('/api/catalogo'));
    assert.deepEqual(lista.piezas.map((p: any) => p.codigo).sort(), [buena, tarjeta].sort());
    assert.equal(lista.total, 2);
    const dest = await leer(await t.llamar('/api/catalogo/destacados'));
    assert.deepEqual(dest.piezas.map((p: any) => p.codigo).sort(), [buena, tarjeta].sort());
  } finally { t.db.close(); }
});

test('catalogo (Issue #220): revision solo para el personal, con los motivos', async () => {
  const t = tienda();
  const personal = (ruta: string) => worker.fetch!(new Request(`https://personal.prueba${ruta}`) as never, t.env, t.ctx as never);
  try {
    const bien = pieza(t, { nombre: 'Blusa' });
    const banda = pieza(t, { nombre: 'DAMA 150 12' });
    const sinFoto = pieza(t, { nombre: 'Gorra', foto_key: '' });
    const sinPrecio = pieza(t, { nombre: 'Cinto', precio: 0 });
    const todo = pieza(t, { nombre: 'CAJA 9', precio: 0, foto_key: '' });
    pieza(t, { nombre: 'Agotada', stock: 0 });
    const r = await personal('/api/catalogo/revision');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const { piezas } = await leer(r);
    const motivos = Object.fromEntries(piezas.map((p: any) => [p.codigo, p.motivos]));
    assert.deepEqual(Object.keys(motivos).sort(), [banda, sinFoto, sinPrecio, todo].sort());
    assert.ok(!(bien in motivos));
    assert.deepEqual(motivos[banda], ['nombre_interno']);
    assert.deepEqual(motivos[sinFoto], ['sin_foto']);
    assert.deepEqual(motivos[sinPrecio], ['sin_precio']);
    assert.deepEqual(motivos[todo], ['sin_foto', 'sin_precio', 'nombre_interno']);
    assert.equal(piezas.find((p: any) => p.codigo === banda).nombre, 'DAMA 150 12');
    assert.equal(piezas.find((p: any) => p.codigo === banda).id.length, 36);
  } finally { t.db.close(); }
});

test('catalogo (Issue #220): revision no existe en el host publico', async () => {
  const t = publica();
  try {
    pieza(t, { nombre: 'DAMA 150 12' });
    assert.equal((await t.llamar('/api/catalogo/revision')).status, 404);
  } finally { t.db.close(); }
});

test('catalogo: una pieza sin nombre no sale en el sitio, y la revision lo dice', async () => {
  const t = publica();
  const personal = (ruta: string) => worker.fetch!(new Request(`https://personal.prueba${ruta}`) as never, t.env, t.ctx as never);
  try {
    const buena = pieza(t, { nombre: 'Blusa' });
    const sinNombre = pieza(t, { nombre: '   ' });   // la IA a veces devuelve el nombre vacio
    const lista = await leer(await t.llamar('/api/catalogo'));
    assert.deepEqual(lista.piezas.map((p: any) => p.codigo), [buena]);
    const { piezas } = await leer(await personal('/api/catalogo/revision'));
    assert.deepEqual(piezas.find((p: any) => p.codigo === sinNombre)?.motivos, ['sin_nombre']);
  } finally { t.db.close(); }
});

test('catalogo (Issue #241): nombre interno en minusculas o con $ tampoco sale; un nombre normal si', async () => {
  const t = publica();
  try {
    const buena = pieza(t, { nombre: 'Tarjeta regalo PlayStation Store $100' });
    const jeans = pieza(t, { nombre: "Jeans Levi's 501 Hombre" });
    for (const nombre of ['dama 50', 'Dama 150 12', 'Juguetes $49', '  caballero 80  ']) pieza(t, { nombre });
    const lista = await leer(await t.llamar('/api/catalogo'));
    assert.deepEqual(lista.piezas.map((p: any) => p.codigo).sort(), [buena, jeans].sort());
  } finally { t.db.close(); }
});

test('catalogo (Issue #241): con cursor, una venta entre paginas no se salta ninguna pieza', async () => {
  const t = publica();
  try {
    const codigos = Array.from({ length: 26 }, () => pieza(t));
    const p1 = await leer(await t.llamar('/api/catalogo'));
    assert.equal(p1.piezas.length, 24);
    assert.equal(typeof p1.siguiente, 'string');
    // Se vende la mas nueva (ya mostrada en la pagina 1).
    t.db.prepare('update productos set stock = 0 where codigo = ?').run(codigos[25]);
    const p2 = await leer(await t.llamar(`/api/catalogo?despues=${encodeURIComponent(p1.siguiente)}`));
    assert.deepEqual(p2.piezas.map((p: any) => p.codigo), [codigos[1], codigos[0]]);
    assert.equal(p2.hay_mas, false);
    assert.equal(p2.siguiente, null);
    // Con pagina (offset) se hubiera saltado codigos[1]: lo que el sitio hacia antes.
    const viejo = await leer(await t.llamar('/api/catalogo?pagina=2'));
    assert.deepEqual(viejo.piezas.map((p: any) => p.codigo), [codigos[0]]);
    for (const malo of ['x', 'sin-tilde', '2026~ED-1;drop', '~ED-1']) {
      assert.equal((await t.llamar(`/api/catalogo?despues=${encodeURIComponent(malo)}`)).status, 400, malo);
    }
  } finally { t.db.close(); }
});
