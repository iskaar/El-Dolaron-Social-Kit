// node --test src/asistente.test.ts: enlace privado del asistente de WhatsApp (Issues #296 y #499).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { cuposPromocion } from './asistente.ts';
import { catalogoPublico } from './catalogo.ts';

const TOKEN = 'token-de-prueba-largo-0123456789';

type Datos = { nombre: string; precio: number; estado?: string; analisis?: string; stock?: number; sinInventario?: number;
  codigo?: string; categoria?: string; talla?: string; fotoKey?: string };
function producto(t: ReturnType<typeof tienda>, datos: Datos) {
  const id = crypto.randomUUID();
  t.db.prepare(`insert into productos (id, codigo, nombre, precio_lista, precio, estado_fisico, estado_analisis, stock, sin_inventario,
      categoria, talla, foto_key, semana_ingreso, creado_en, actualizado_en)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'S41', '2026-10-12T10:00:00Z', '2026-10-12T10:00:00Z')`)
    .run(id, datos.codigo ?? `ED-${crypto.randomUUID().slice(0, 8)}`, datos.nombre, datos.precio, datos.precio,
      datos.estado ?? 'nuevo', datos.analisis ?? 'listo', datos.stock ?? 1, datos.sinInventario ?? 0,
      datos.categoria ?? 'otros', datos.talla ?? null, datos.fotoKey ?? '');
  return id;
}

function abrir() {
  const t = tienda();
  t.env.ASISTENTE_TOKEN = TOKEN;
  producto(t, { nombre: 'Camisa polo caballero', precio: 25000 });
  producto(t, { nombre: 'Camisa dañada', precio: 9000, estado: 'danado' });
  producto(t, { nombre: 'Camisa sin revisar', precio: 9000, analisis: 'pendiente' });
  producto(t, { nombre: 'Camisa agotada', precio: 9000, stock: 0 });
  producto(t, { nombre: 'Bin de camisas', precio: 45000, stock: 0, sinInventario: 1 });
  producto(t, { nombre: 'Pantalón de mezclilla', precio: 30000 });
  return t;
}
const cabecera = (token: string | null) => (token === null ? {} : { 'x-asistente-token': token });

test('solo lista piezas nuevas, revisadas y con existencia; el bin sin inventario sí aparece', async () => {
  const t = abrir();
  try {
    const r = await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera(TOKEN));
    assert.equal(r.status, 200);
    const nombres = r.cuerpo.productos.map((p: { nombre: string }) => p.nombre).sort();
    assert.deepEqual(nombres, ['Bin de camisas', 'Camisa polo caballero']);
    const polo = r.cuerpo.productos.find((p: { nombre: string }) => p.nombre === 'Camisa polo caballero');
    assert.match(polo.precio, /250/);
    // Sin existencias exactas ni campos internos; sin foto la pieza no sale en el catálogo público: ni código ni foto.
    assert.equal(Object.keys(polo).sort().join(','), 'codigo,disponibilidad,foto,nombre,precio,talla,url');
    assert.deepEqual([polo.codigo, polo.foto, polo.url], [null, null, null]);
  } finally { t.db.close(); }
});

test('#499: filtra por categoría, talla y rango de precio en pesos; disponibilidad sin cifras', async () => {
  const t = abrir();
  try {
    producto(t, { nombre: 'Blusa M', precio: 15000, categoria: 'ropa', talla: 'M', stock: 10 });
    producto(t, { nombre: 'Blusa L', precio: 15000, categoria: 'ropa', talla: 'L', stock: 2 });
    producto(t, { nombre: 'Playera niño', precio: 9000, categoria: 'ropa', talla: 'Niño 6 años / M', stock: 1 });
    producto(t, { nombre: 'Blusa cara M', precio: 60000, categoria: 'ropa', talla: 'M' });
    producto(t, { nombre: 'Licuadora', precio: 40000, categoria: 'hogar' });
    const buscar = async (consulta: string) => {
      const r = await t.pedir(`/api/asistente/productos?${consulta}`, undefined, 'GET', cabecera(TOKEN));
      assert.equal(r.status, 200, consulta);
      return r.cuerpo.productos as { nombre: string; disponibilidad: string }[];
    };
    const nombres = (lista: { nombre: string }[]) => lista.map((p) => p.nombre).sort();
    assert.deepEqual(nombres(await buscar('categoria=hogar')), ['Licuadora']);
    // «M» de adulto no trae la de niño; «m» en minúscula también sirve.
    assert.deepEqual(nombres(await buscar('categoria=ropa&talla=m')), ['Blusa M', 'Blusa cara M']);
    assert.deepEqual(nombres(await buscar('talla=Ni%C3%B1o%206%20a%C3%B1os')), ['Playera niño']);
    assert.deepEqual(nombres(await buscar('categoria=ropa&talla=M&max=200')), ['Blusa M']);
    assert.deepEqual(nombres(await buscar('min=300&max=500')), ['Bin de camisas', 'Licuadora', 'Pantalón de mezclilla']);
    const ropa = await buscar('categoria=ropa');
    const de = (n: string) => ropa.find((p) => p.nombre === n)!.disponibilidad;
    assert.equal(de('Blusa M'), 'disponible');
    assert.equal(de('Blusa L'), 'quedan pocas');
    assert.equal(de('Playera niño'), 'última pieza');
    assert.equal(JSON.stringify(ropa).includes('stock'), false);
  } finally { t.db.close(); }
});

test('#499: categoría o precio inválidos se rechazan en vez de buscar todo', async () => {
  const t = abrir();
  try {
    const r = await t.pedir('/api/asistente/productos?categoria=armas', undefined, 'GET', cabecera(TOKEN));
    assert.equal(r.status, 400);
    assert.ok(r.cuerpo.categorias.includes('ropa'));
    assert.equal((await t.pedir('/api/asistente/productos?max=-5', undefined, 'GET', cabecera(TOKEN))).status, 400);
    assert.equal((await t.pedir('/api/asistente/productos?min=abc', undefined, 'GET', cabecera(TOKEN))).status, 400);
  } finally { t.db.close(); }
});

test('#499 B.4: código, foto y enlace solo de piezas del catálogo público, y la foto sí se sirve', async () => {
  const t = abrir();
  try {
    t.env.HOST_PORTAL = 'dolarones.eldolaron.com';
    const id = producto(t, { nombre: 'Sudadera gris', precio: 20000, codigo: 'ED-000777', fotoKey: 'fotos/sudadera.jpg' });
    await t.env.FOTOS.put('fotos/sudadera.jpg', new Uint8Array([0xff, 0xd8, 0xff]), { httpMetadata: { contentType: 'image/jpeg' } });
    const r = await t.pedir('/api/asistente/productos?q=sudadera', undefined, 'GET', cabecera(TOKEN));
    const [pieza] = r.cuerpo.productos;
    assert.equal(pieza.codigo, 'ED-000777');
    assert.equal(pieza.foto, 'https://dolarones.eldolaron.com/api/catalogo/foto/ED-000777');
    assert.equal(pieza.url, 'https://eldolaron.com/#catalogo');
    const foto = await catalogoPublico(new Request(pieza.foto), t.env, new URL(pieza.foto));
    assert.equal(foto?.status, 200);
    assert.equal(foto?.headers.get('content-type'), 'image/jpeg');
    // La misma pieza de un tercero (no VENDIBLE) no expone código ni foto.
    t.db.prepare(`update productos set propietario = 'fep' where id = ?`).run(id);
    const ajena = (await t.pedir('/api/asistente/productos?q=sudadera', undefined, 'GET', cabecera(TOKEN))).cuerpo.productos[0];
    assert.deepEqual([ajena.codigo, ajena.foto, ajena.url], [null, null, null]);
  } finally { t.db.close(); }
});

// Venta dentro de las ventanas de promo de estas pruebas: el cupo solo cuenta las de la ventana vigente.
const venta = (t: ReturnType<typeof tienda>, promo: number, cancelada = 0) =>
  t.db.prepare(`insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en, promo, cancelada)
    values (?, 30000, 'efectivo', 30000, 0, '2026-10-24T18:00:00.000Z', '', ?, ?)`).run(crypto.randomUUID(), promo, cancelada);

test('#499: cupos de la promo con el mismo cupo y ventana que la caja', async () => {
  const t = abrir();
  try {
    const ahora = Date.parse('2026-10-24T20:00:00Z');
    assert.deepEqual(await cuposPromocion(t.env, ahora), { estado: 'sin_promo', restantes: 0, mensaje: 'No hay promoción vigente.' });
    Object.assign(t.env, { PROMO_DESDE: '2026-10-24T17:00:00Z', PROMO_HASTA: '2026-10-26T02:00:00Z', PROMO_CUPO: '3' });
    venta(t, 10000); venta(t, 0); venta(t, 10000, 1);
    const vigente = await cuposPromocion(t.env, ahora);
    assert.equal(vigente.estado, 'vigente');
    assert.equal(vigente.restantes, 2, 'una con promo cuenta; sin promo y cancelada no');
    assert.match(String(vigente.descuento), /100/);
    assert.match(String(vigente.compra_minima), /300/);
    assert.match(String(vigente.desde), /24 de octubre/);
    assert.equal((await cuposPromocion(t.env, Date.parse('2026-10-24T16:00:00Z'))).estado, 'proxima');
    const fin = await cuposPromocion(t.env, Date.parse('2026-10-26T02:00:00Z'));
    assert.deepEqual([fin.estado, fin.restantes], ['terminada', 0]);
  } finally { t.db.close(); }
});

test('#499: promo agotada devuelve 0 y «ya se acabaron» por la ruta del asistente', async () => {
  const t = abrir();
  try {
    // Ventana que cubre «ahora» para probar la ruta real, sin reloj inyectado.
    Object.assign(t.env, { PROMO_DESDE: '2020-01-01T00:00:00Z', PROMO_HASTA: '2099-01-01T00:00:00Z', PROMO_CUPO: '2' });
    venta(t, 10000);
    const una = await t.pedir('/api/asistente/promocion', undefined, 'GET', cabecera(TOKEN));
    assert.equal(una.status, 200);
    assert.deepEqual([una.cuerpo.estado, una.cuerpo.restantes], ['vigente', 1]);
    venta(t, 10000);
    const agotada = (await t.pedir('/api/asistente/promocion', undefined, 'GET', cabecera(TOKEN))).cuerpo;
    assert.deepEqual([agotada.estado, agotada.restantes], ['agotada', 0]);
    assert.match(agotada.mensaje, /Ya se acabaron/);
    assert.equal((await t.pedir('/api/asistente/promocion', undefined, 'GET', cabecera(null))).status, 401);
  } finally { t.db.close(); }
});

test('los comodines de la búsqueda no devuelven todo el catálogo', async () => {
  const t = abrir();
  try {
    const r = await t.pedir('/api/asistente/productos?q=%25', undefined, 'GET', cabecera(TOKEN));
    assert.deepEqual(r.cuerpo.productos.map((p: { nombre: string }) => p.nombre), []);
  } finally { t.db.close(); }
});

test('sin token correcto o sin configurar, la tienda no responde datos', async () => {
  const t = abrir();
  try {
    assert.equal((await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera(null))).status, 401);
    assert.equal((await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera('otro'))).status, 401);
    t.env.ASISTENTE_TOKEN = undefined;
    assert.equal((await t.pedir('/api/asistente/productos?q=camisa', undefined, 'GET', cabecera(TOKEN))).status, 503);
  } finally { t.db.close(); }
});

test('otras rutas del asistente responden 404 aun con token', async () => {
  const t = abrir();
  try {
    assert.equal((await t.pedir('/api/asistente/apartar', {}, 'POST', cabecera(TOKEN))).status, 404);
  } finally { t.db.close(); }
});
