// node --test src/vender.test.ts: API real, SQLite con migraciones y lógica del navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { tienda, DUENO, datosTransferencia } from './prueba-d1.ts';
import { permiso, puede, esDeCaja, type Rol } from './cuentas.ts';
import * as venta from '../public/venta.js';
import { textoWhatsApp, telefonoInteresado, codigoDeRespuesta, enlaceApartar, textoSeguimiento, compartirTarjetas, crearTarjeta, partirNombre,
  fechaLegible, horaLegible, textoAvisoCliente, enlaceCliente, estadoMia, agruparMias, cobradoMias } from '../public/vender.js';

function pieza(db: DatabaseSync, cambios: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const fila = { id, codigo: `ED-${String((db.prepare('select count(*) as n from productos').get()!.n as number) + 1).padStart(6, '0')}`,
    nombre: 'Blusa de algodón', categoria: 'ropa', talla: 'M', marca: 'Target', precio: 20000, precio_lista: 30000,
    estado_analisis: 'listo', estado_fisico: 'nuevo', stock: 1, sin_inventario: 0, destino: 'etiqueta',
    foto_key: `fotos/${id}.jpg`, propietario: 'dolaron', semana_ingreso: 'S43',
    creado_en: new Date().toISOString(), actualizado_en: new Date().toISOString(), ...cambios };
  db.prepare(`insert into productos (${Object.keys(fila).join(',')}) values (${Object.keys(fila).map(() => '?').join(',')})`).run(...Object.values(fila) as never[]);
  return fila;
}
const registro = (producto_id: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), producto_id, cliente: 'Ana', telefono: '4441234567', nota: '', ...extra,
});
function usuario(db: DatabaseSync, correo: string, rol: Rol, nombre = 'Marta') {
  db.prepare("insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, '', '')").run(correo, nombre, rol);
}

test('texto de una pieza: centavos, antes, talla, acentos y cierre exactos', () => {
  assert.equal(textoWhatsApp([{ nombre: 'Blusa de algodón', talla: 'M', precio: 20050, precio_lista: 30000, codigo: 'ED-1234' }]),
    '🛍️ Blusa de algodón · Talla M\n💵 $200.50 (antes $300)\n🔖 ED-1234\n🔗 https://eldolaron.com/?pieza=ED-1234#catalogo\n'
    + 'Apártala con el 15 % por 7 días: responde con el código.\n🚚 Envíos todos los viernes.\n📍 Jardín Hidalgo 129, Soledad · todos los días de 11 a 8');
  const simple = textoWhatsApp([{ nombre: 'Jarrón\n azul', talla: null, precio: 10000, precio_lista: 10000, codigo: 'ED-1' }]);
  assert.match(simple, /^🛍️ Jarrón azul\n💵 \$100\n/);
  assert.ok(!simple.includes('antes') && !simple.includes('Talla'));
  assert.throws(() => textoWhatsApp([]));
  assert.throws(() => textoWhatsApp(Array(11).fill({})));
});

test('texto para revendedora: sin el apartado con 15 % por 7 días y sin prometer anticipo (#575)', () => {
  const pieza = { nombre: 'Blusa', talla: 'M', precio: 20000, precio_lista: 30000, codigo: 'ED-1234' };
  const texto = textoWhatsApp([pieza], true);
  assert.ok(texto.includes('Apártala: responde con el código.'));
  assert.ok(!/15 %|7 días|\$100/.test(texto));
  assert.ok(texto.includes('Envíos todos los viernes') && texto.includes('Jardín Hidalgo 129'));
  assert.ok(!/15 %|7 días/.test(textoWhatsApp([pieza, pieza], true)));
  assert.match(textoWhatsApp([pieza]), /15 % por 7 días/);   // la caja no cambia
  const i = { cliente: 'Ana', nombre: 'Blusa', codigo: 'ED-1', disponibilidad: 'Disponible' };
  assert.ok(!/15 %|7 días/.test(textoSeguimiento(i, true)));
  assert.match(textoSeguimiento(i), /15 % por 7 días/);
});

test('varias piezas: una línea por pieza y un solo cierre, hasta diez', () => {
  const piezas = Array.from({ length: 10 }, (_, n) => ({ codigo: `ED-${n}`, nombre: 'Blusa', precio: 10001, precio_lista: 20000 }));
  const texto = textoWhatsApp(piezas);
  assert.equal(texto.split('\n').length, 13);   // 10 piezas (con su enlace, #590) + apartado + envíos + dirección
  assert.equal(texto.match(/Apártala/g)?.length, 1);
  assert.ok(texto.startsWith('ED-0 · Blusa · $100.01 · https://eldolaron.com/?pieza=ED-0#catalogo\nED-1'));
});

test('teléfono opcional: valida, normaliza +52 y rechaza tipos y letras; código pegado o escaneado', () => {
  for (const valor of ['', '  ']) assert.equal(telefonoInteresado(valor), '');
  for (const valor of ['4441234567', '+52 (444) 123-4567', '52 444 123 4567']) assert.equal(telefonoInteresado(valor), '4441234567');
  for (const valor of ['123', '1 4441234567', 'abc4441234567', '++++++++', 4441234567, {}, null, ' '.repeat(25)]) assert.equal(telefonoInteresado(valor), null);
  assert.equal(codigoDeRespuesta('quiero la ed-000123, por favor'), 'ED-000123');
  assert.equal(codigoDeRespuesta('123\n'), 'ED-000123');
  assert.equal(codigoDeRespuesta('me apartas la ED-2335?'), 'ED-002335');
  assert.equal(codigoDeRespuesta('quiero dos'), null);
  const params = new URL('https://prueba' + enlaceApartar({ codigo: 'ED-123', cliente: 'Ana & Luis <b>', telefono: '' })).searchParams;
  assert.equal(params.get('cliente'), 'Ana & Luis <b>');
  assert.equal(params.get('codigo'), 'ED-123');
  assert.match(textoSeguimiento({ cliente: 'Ana', nombre: 'Blusa', codigo: 'ED-1', disponibilidad: 'Disponible' }), /sigue disponible/);
  assert.ok(!textoSeguimiento({ disponibilidad: 'Vendida' }).includes('sigue disponible'));
});

test('base vacía y actualización: 057 es aditiva, repetible y conserva productos/stock', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(readFileSync('schema.sql', 'utf8'));
  for (const f of readdirSync('.').filter((f) => /^migracion-\d+/.test(f) && !f.startsWith('migracion-057')).sort()) db.exec(readFileSync(f, 'utf8'));
  const p = pieza(db);
  const antes = db.prepare('select * from productos').all();
  const sql = readFileSync('migracion-057-interesados.sql', 'utf8');
  db.exec(sql); db.exec(sql);
  assert.deepEqual(db.prepare('select * from productos').all(), antes);
  assert.equal(db.prepare('pragma foreign_keys').get()!.foreign_keys, 1);
  db.prepare("insert into interesados values (?, ?, 'Ana', '', '', 'marta', 'abierto', '', '')").run(crypto.randomUUID(), p.id);
  assert.throws(() => db.prepare("insert into interesados values (?, ?, 'Ana', '', '', 'marta', 'abierto', '', '')").run(crypto.randomUUID(), crypto.randomUUID()), /FOREIGN KEY/);
  assert.deepEqual(db.prepare('pragma foreign_key_check').all(), []);
});

test('/api/vender excluye FEP, stock cero y toda pieza no VENDIBLE; usa recorte solo aprobado', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const original = pieza(db);
  const recorte = pieza(db, { recorte_estado: 'listo', recorte_revision: 'ok' });
  const pendiente = pieza(db, { recorte_estado: 'listo', recorte_revision: null });
  for (const cambios of [
    { propietario: 'fep' }, { stock: 0 }, { precio: 0 }, { foto_key: '' }, { nombre: 'DAMA 150' },
    { nombre: '' }, { estado_analisis: 'pendiente' }, { estado_analisis: 'descartado' },
    { estado_fisico: 'danado' }, { estado_fisico: 'liquidacion' }, { codigo: null }, { destino: 'banda_r19' }, { sin_inventario: 1 },
  ]) pieza(db, cambios);
  const r = await pedir('/api/vender');
  assert.equal(r.status, 200);
  assert.deepEqual(new Set(r.cuerpo.piezas.map((p: any) => p.id)), new Set([original.id, recorte.id, pendiente.id]));
  assert.equal(r.cuerpo.piezas.find((p: any) => p.id === original.id).foto, `/api/foto/${original.id}`);
  assert.equal(r.cuerpo.piezas.find((p: any) => p.id === recorte.id).foto, `/api/recortes/${recorte.id}/imagen`);
  assert.equal(r.cuerpo.piezas.find((p: any) => p.id === pendiente.id).foto, `/api/foto/${pendiente.id}`);
  assert.equal(r.cuerpo.piezas[0].precio, 20000);
});

test('24 por página con empates, sin duplicar ni saltar al vender o insertar entre páginas', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const todas = Array.from({ length: 50 }, () => pieza(db, { creado_en: '2026-10-01T00:00:00.000Z' }));
  const primera = (await pedir('/api/vender')).cuerpo;
  assert.equal(primera.piezas.length, 24);
  assert.ok(primera.siguiente);
  db.prepare('update productos set stock = 0 where id = ?').run(primera.piezas[0].id);
  pieza(db, { creado_en: '2026-10-22T00:00:00.000Z' });
  const segunda = (await pedir('/api/vender?' + new URLSearchParams({ cursor: primera.siguiente }))).cuerpo;
  const tercera = (await pedir('/api/vender?' + new URLSearchParams({ cursor: segunda.siguiente }))).cuerpo;
  assert.equal(segunda.piezas.length, 24);
  assert.equal(tercera.piezas.length, 2);
  assert.equal(tercera.siguiente, null);
  assert.deepEqual(new Set([...primera.piezas, ...segunda.piezas, ...tercera.piezas].map((p) => p.id)), new Set(todas.map((p) => p.id)));
});

test('filtros, hoy en UTC-6 y consultas con tope aun cuando el nombre no existe', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const hoy = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
  const apertura = `${hoy}T06:00:00.000Z`;
  const p = pieza(db, { nombre: 'Blusa %_azul', creado_en: apertura });
  pieza(db, { creado_en: new Date(Date.parse(apertura) - 1).toISOString() });
  assert.equal((await pedir('/api/vender?hoy=1')).cuerpo.piezas.length, 1);
  assert.equal((await pedir(`/api/vender?q=${p.codigo}`)).cuerpo.piezas[0].id, p.id);
  assert.equal((await pedir('/api/vender?q=%25_azul&categoria=ropa')).cuerpo.piezas[0].id, p.id);
  assert.equal((await pedir('/api/vender?categoria=hogar')).cuerpo.piezas.length, 0);
  for (const q of ['cursor=foo', 'cursor=2026-10-01~0', 'categoria=foo', 'hoy=ayer', `q=${'x'.repeat(81)}`]) assert.equal((await pedir(`/api/vender?${q}`)).status, 400);
  for (let n = 0; n < 270; n++) pieza(db);
  const consultas: string[] = [];
  const preparar = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (sql.includes('from productos p')) consultas.push(sql); return preparar(sql); };
  const vacia = await pedir('/api/vender?q=NoExiste');
  assert.equal(vacia.cuerpo.piezas.length, 0);
  assert.ok(vacia.cuerpo.siguiente);
  assert.equal(consultas.length, 10);
  for (const sql of consultas) {
    assert.match(sql, /limit \?/);
    assert.ok(!/count\(|offset /i.test(sql));
    const plan = db.prepare('explain query plan ' + sql).all(...(sql.includes('p.rowid) <') ? ['NoExiste', '9999', 999999, 24] : ['NoExiste', 24]));
    assert.ok(plan.some((p) => String(p.detail).includes('productos_propietario_creado')));
    assert.ok(!plan.some((p) => /SCAN p|TEMP B-TREE/.test(String(p.detail))));
  }
});

test('alta idempotente, identidad del servidor y dos vendedoras: orden visible, stock intacto', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const p = pieza(db);
  usuario(db, 'marta@prueba.mx', 'cajero');
  const uno = registro(p.id, { cliente: 'Ana <img src=x>', telefono: '+52 (444) 123-4567', vendedora: 'falsa@prueba.mx' });
  env.DEV_USUARIO = 'marta@prueba.mx';
  const primero = await pedir('/api/interesados', uno);
  assert.equal(primero.status, 201, JSON.stringify(primero.cuerpo));
  assert.equal(primero.cuerpo.interesado.vendedora, 'marta@prueba.mx');
  assert.equal(primero.cuerpo.interesado.telefono, '4441234567');
  assert.equal((await pedir('/api/interesados', uno)).status, 200);
  assert.equal((await pedir('/api/interesados', { ...uno, cliente: 'Otra' })).status, 409);
  env.DEV_USUARIO = DUENO;
  assert.equal((await pedir('/api/interesados', uno)).status, 409);
  const dos = registro(p.id, { cliente: 'Luis', telefono: '' });
  assert.equal((await pedir('/api/interesados', dos)).status, 201);
  const lista = (await pedir('/api/vender')).cuerpo.piezas[0];
  assert.equal(lista.interesados, 2);
  assert.deepEqual(lista.cola.map((i: any) => i.cliente), ['Ana <img src=x>', 'Luis']);
  assert.equal(lista.cola[0].vendedora_nombre, 'Marta');
  assert.equal((await pedir('/api/interesados?mios=1')).cuerpo.interesados.length, 1);
  assert.equal(db.prepare('select stock from productos where id = ?').get(p.id)!.stock, 1);
  assert.equal(db.prepare('select count(*) as n from pedidos').get()!.n, 0);
  assert.equal((await pedir(`/api/interesados/${uno.id}`, { estado: 'descartado' }, 'PATCH')).status, 200);
  assert.equal((await pedir(`/api/interesados/${uno.id}`, { estado: 'descartado' }, 'PATCH')).status, 200);
  assert.equal((await pedir('/api/interesados', uno)).status, 409); // sigue perteneciendo a Marta
  env.DEV_USUARIO = 'marta@prueba.mx';
  assert.equal((await pedir('/api/interesados', uno)).cuerpo.interesado.estado, 'descartado');
  assert.equal((await pedir('/api/vender')).cuerpo.piezas[0].interesados, 1);
});

test('validación rechaza cuerpos, longitudes, teléfono, ajenas y no vendibles sin escribir', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const p = pieza(db);
  for (const extra of [{ id: 'foo' }, { producto_id: 'foo' }, { cliente: '' }, { cliente: ' '.repeat(10) }, { cliente: 3 },
    { cliente: 'x'.repeat(81) }, { nota: 'x'.repeat(501) }, { nota: {} }, { telefono: '123' }, { telefono: 4441234567 }, { telefono: 'abc4441234567' }]) {
    assert.equal((await pedir('/api/interesados', registro(p.id, extra))).status, 400);
  }
  for (const cuerpo of [null, [], 42, 'foo']) assert.equal((await pedir('/api/interesados', cuerpo)).status, 400);
  assert.equal((await pedir('/api/interesados', registro(crypto.randomUUID()))).status, 404);
  assert.equal((await pedir('/api/interesados', registro(pieza(db, { propietario: 'fep' }).id))).status, 404);
  for (const cambios of [{ stock: 0 }, { precio: 0 }, { estado_fisico: 'danado' }, { foto_key: '' }])
    assert.equal((await pedir('/api/interesados', registro(pieza(db, cambios).id))).status, 409);
  assert.equal(db.prepare('select count(*) as n from interesados').get()!.n, 0);
  assert.equal((await pedir('/api/interesados/foo', { estado: 'descartado' }, 'PATCH')).status, 400);
  assert.equal((await pedir(`/api/interesados/${crypto.randomUUID()}`, { estado: 'descartado' }, 'PATCH')).status, 404);
  for (const cuerpo of [null, {}, { estado: 'abierto' }, { estado: 'descartado', cliente: 'Otra' }])
    assert.equal((await pedir(`/api/interesados/${crypto.randomUUID()}`, cuerpo, 'PATCH')).status, 400);
});

test('reintento concurrente conserva el registro y la venta entre lectura e inserción impide el alta', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const p = pieza(db);
  const cuerpo = registro(p.id);
  const r = await Promise.all([pedir('/api/interesados', cuerpo), pedir('/api/interesados', cuerpo)]);
  assert.deepEqual(r.map((r) => r.status).sort(), [200, 201]);
  assert.equal(db.prepare('select count(*) as n from interesados').get()!.n, 1);
  const preparar = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.startsWith('insert into interesados')) db.prepare('update productos set stock = 0 where id = ?').run(p.id);
    return preparar(sql);
  };
  assert.equal((await pedir('/api/interesados', registro(p.id))).status, 409);
  assert.equal(db.prepare('select count(*) as n from interesados').get()!.n, 1);
});

test('cola paginada compartida: excluye más de siete días y descartados; mios no altera el orden', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const p = pieza(db);
  const ids = [];
  for (let n = 0; n < 27; n++) {
    const c = registro(p.id, { cliente: `Cliente ${n}` });
    assert.equal((await pedir('/api/interesados', c)).status, 201);
    ids.push(c.id);
  }
  const primera = (await pedir('/api/interesados')).cuerpo;
  assert.equal(primera.interesados.length, 24);
  const segunda = (await pedir('/api/interesados?' + new URLSearchParams({ cursor: primera.siguiente }))).cuerpo;
  assert.equal(segunda.interesados.length, 3);
  assert.deepEqual([...primera.interesados, ...segunda.interesados].map((i) => i.id), ids);
  db.prepare('update interesados set creado_en = ? where id = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString(), ids[0]);
  await pedir(`/api/interesados/${ids[1]}`, { estado: 'descartado' }, 'PATCH');
  assert.equal((await pedir('/api/vender')).cuerpo.piezas[0].interesados, 25);
  assert.equal((await pedir('/api/interesados')).cuerpo.interesados[0].id, ids[2]);
  for (const query of ['mios=otro', 'cursor=no']) assert.equal((await pedir(`/api/interesados?${query}`)).status, 400);
});

test('disponibilidad sale de stock y pedidos; apartar sigue exigiendo anticipo y su API existente', async (t) => {
  const { db, pedir, esperar } = tienda(); t.after(() => db.close());
  const p = pieza(db);
  await pedir('/api/interesados', registro(p.id));
  const leer = async () => (await pedir('/api/interesados')).cuerpo.interesados[0];
  assert.equal((await leer()).disponibilidad, 'Disponible');
  const pedido = { id: crypto.randomUUID(), lineas: [{ producto_id: p.id, cantidad: 1 }], cliente: 'Ana', telefono: '4441234567',
    entrega: 'tienda', anticipo: 10000, forma_pago: 'transferencia', caja: 'Caja 1', ...datosTransferencia(10000) };
  assert.equal((await pedir('/api/pedidos', { ...pedido, anticipo: 0 })).status, 400);
  const apartado = await pedir('/api/pedidos', pedido);
  assert.equal(apartado.status, 201);
  assert.equal((await leer()).disponibilidad, 'Apartada');
  assert.equal((await pedir('/api/vender')).cuerpo.piezas.length, 0);
  await pedir(`/api/pedidos/${apartado.cuerpo.pedido.folio}/cancelar`, {});
  assert.equal((await leer()).disponibilidad, 'Disponible');
  assert.equal((await pedir('/api/ventas', { id: crypto.randomUUID(), lineas: [{ producto_id: p.id, cantidad: 1 }], forma_pago: 'transferencia' })).status, 201);
  assert.equal((await leer()).disponibilidad, 'Vendida');
  await esperar();
});

test('permisos de caja, métodos, PIN de computadora y aislamiento de hosts', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  for (const ruta of ['/vender', '/vender.html', '/vender.js', '/api/vender', '/api/interesados', '/api/interesados/un-id']) {
    assert.equal(esDeCaja(permiso(ruta, 'GET')), true);
    for (const rol of ['capturista', 'finanzas', 'auxiliar'] as Rol[]) {
      assert.equal(puede({ correo: '', nombre: '', caja: '', activo: true, roles: [rol] }, permiso(ruta, 'GET')), false);
    }
  }
  const foto = `/api/recortes/${crypto.randomUUID()}/imagen`;
  assert.deepEqual(permiso(foto, 'GET'), ['capturista', 'cajero', 'computadora', 'revendedora']);   // #575: la revendedora ve las fotos de /vender
  assert.deepEqual(permiso(foto, 'POST'), ['capturista']);
  usuario(db, 'foto@prueba.mx', 'capturista');
  env.DEV_USUARIO = 'foto@prueba.mx';
  assert.equal((await pedir('/api/vender')).status, 403);
  env.DEV_USUARIO = DUENO;
  assert.equal((await pedir('/api/vender', {})).status, 405);
  assert.equal((await pedir('/api/interesados', {}, 'PUT')).status, 405);
  usuario(db, 'pc@prueba.mx', 'computadora');
  env.DEV_USUARIO = 'pc@prueba.mx';
  assert.equal((await pedir('/api/interesados')).cuerpo.pin, true);
  env.DEV_USUARIO = DUENO;
  env.HOST_PORTAL = 'caja.prueba';
  assert.equal((await pedir('/api/vender')).status, 404);
  env.HOST_PORTAL = 'otro.prueba'; env.HOST_VENDEDOR = 'caja.prueba';
  assert.equal((await pedir('/api/interesados')).status, 404);
});

test('pedidos prellena pieza y cliente por URL, escapa texto y nunca manda un anticipo automáticamente', async () => {
  const nodos = new Map<string, any>();
  const nodo = () => ({ value: '', textContent: '', innerHTML: '', hidden: true, className: '', firstChild: { textContent: '' },
    classList: { contains: () => false }, addEventListener() {}, focus() {}, scrollIntoView() {} });
  const $ = (id: string) => { if (!nodos.has(id)) nodos.set(id, nodo()); return nodos.get(id); };
  const llamadas: string[] = [];
  let limpia = '';
  const script = readFileSync('public/pedidos.html', 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^import .+;$/gm, '');
  const params = new URLSearchParams({ codigo: 'ED-000123', cliente: 'Ana <img>', telefono: '4441234567' });
  await runInNewContext(`(async () => { ${script} })()`, {
    document: { getElementById: $, querySelector: () => ({ value: 'tienda', checked: true, addEventListener() {} }), querySelectorAll: () => [] },
    location: { search: `?${params}`, pathname: '/pedidos' }, history: { replaceState: (_a: unknown, _b: unknown, url: string) => { limpia = url; } },
    URLSearchParams, navigator: { onLine: true }, setInterval() {}, localStorage: { getItem: () => null },
    // Los imports de pedidos.html salen del venta.js real: la regla del anticipo vive ahí (#434).
    ...venta, codigoDeDigitos: () => null,
    fetch: async (url: string, opciones?: unknown) => {
      llamadas.push(`${opciones ? 'POST' : 'GET'} ${url}`);
      return { ok: true, json: async () => url === '/api/catalogo' ? [{ id: 'p', codigo: 'ED-000123', nombre: 'Blusa <azul>', precio: 20000, stock: 1, propietario: 'dolaron' }]
        : url === '/api/pedidos' ? { pedidos: [] } : {} };
    },
  });
  assert.equal($('cliente').value, 'Ana <img>');
  assert.equal($('telefono').value, '4441234567');
  assert.equal($('codigo').value, '');
  assert.match($('piezas').innerHTML, /Blusa &lt;azul&gt;/);
  // Prellena el mínimo de la regla vigente (sin #434: $100; con #434: 15 % de $200 = $30), nunca lo envía.
  const reglas = venta as Record<string, any>;
  const minimo = reglas.anticipoMinimoDe ? reglas.anticipoMinimoDe(20000, 'tienda') : reglas.ANTICIPO_MINIMO;
  assert.equal($('anticipo').value, String(minimo / 100));
  assert.ok(llamadas.every((r) => r.startsWith('GET')));
  assert.equal(limpia, '/pedidos');
});

test('compartir copia antes de comprobar files y enviar; AbortError es silencioso', async (t) => {
  const previo = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (previo) Object.defineProperty(globalThis, 'navigator', previo); });
  const pasos: string[] = [];
  const files = [new File(['foto'], 'ED-1.jpg', { type: 'image/jpeg' })];
  const navegador = { clipboard: { writeText: async () => { pasos.push('copiar'); } },
    canShare: ({ files: enviados }: { files: File[] }) => { assert.equal(enviados, files); pasos.push('canShare'); return true; },
    share: async (datos: { files: File[]; text: string }) => { assert.equal(datos.files, files); assert.equal(datos.text, 'Texto'); pasos.push('share'); } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navegador });
  assert.equal((await compartirTarjetas(files, 'Texto')).compartida, true);
  assert.deepEqual(pasos, ['copiar', 'canShare', 'share']);
  navegador.share = async () => { throw Object.assign(new Error(), { name: 'AbortError' }); };
  assert.equal((await compartirTarjetas(files, 'Texto')).compartida, false);
  navegador.share = async () => { throw new Error('No permitido'); };
  await assert.rejects(() => compartirTarjetas(files, 'Texto'), /¿No se abrió WhatsApp\?/);
});

test('sin Web Share descarga cada imagen y abre WhatsApp con el texto; copiar puede fallar', async (t) => {
  const globals = ['navigator', 'document', 'window', 'setTimeout'] as const;
  const previos = globals.map((clave) => [clave, Object.getOwnPropertyDescriptor(globalThis, clave)] as const);
  t.after(() => { for (const [clave, previo] of previos) {
    if (previo) Object.defineProperty(globalThis, clave, previo); else Reflect.deleteProperty(globalThis, clave);
  } });
  const descargas: string[] = [], abiertos: string[] = [], orden: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => { orden.push('copiar'); throw new Error('Sin permiso'); } } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: { append() {} }, createElement: () => ({ download: '', href: '', click() { descargas.push(this.download); orden.push('descarga'); }, remove() {} }),
  } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { open: (url: string) => abiertos.push(url) } });
  Object.defineProperty(globalThis, 'setTimeout', { configurable: true, value: (fn: () => void) => fn() });
  const files = [1, 2, 3].map((n) => new File(['foto'], `ED-${n}.jpg`, { type: 'image/jpeg' }));
  const r = await compartirTarjetas(files, 'Texto & acentos: algodón');
  assert.equal(r.compartida, true); assert.equal(r.copiado, false); assert.equal(r.descarga, true);
  assert.deepEqual(descargas, files.map((f) => f.name));
  assert.equal(orden[0], 'copiar');
  assert.equal(new URL(abiertos[0]).searchParams.get('text'), 'Texto & acentos: algodón');
});

test('tarjeta JPEG 1080 × 1350, foto contain y precio/código/talla/logo sin deformar', async (t) => {
  const globals = ['document', 'Image'] as const;
  const previos = globals.map((clave) => [clave, Object.getOwnPropertyDescriptor(globalThis, clave)] as const);
  t.after(() => { for (const [clave, previo] of previos) {
    if (previo) Object.defineProperty(globalThis, clave, previo); else Reflect.deleteProperty(globalThis, clave);
  } });
  const dibujos: unknown[][] = [], textos: string[] = [];
  let tachados = 0;
  const rects: number[][] = [];
  const ctx = { fillStyle: '', font: '', strokeStyle: '', lineWidth: 0, imageSmoothingQuality: '',
    fillRect: (...args: number[]) => rects.push(args), drawImage: (...args: unknown[]) => dibujos.push(args), fillText: (texto: string) => textos.push(texto),
    measureText: () => ({ width: 120 }), beginPath() {}, moveTo() {}, lineTo() {}, stroke() { tachados++; } };
  const canvas = { width: 0, height: 0, getContext: () => ctx,
    toBlob: (fn: (b: Blob) => void, tipo: string, calidad: number) => {
      assert.equal(tipo, 'image/jpeg'); assert.equal(calidad, 0.85); fn(new Blob(['foto'], { type: tipo }));
    } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => canvas } });
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    naturalWidth = 400; naturalHeight = 800; onload = () => {};
    set src(valor: string) {
      if (valor.includes('logo')) { this.naturalWidth = 600; this.naturalHeight = 156; }
      queueMicrotask(() => this.onload());
    }
  } });
  const r = await crearTarjeta({ foto: '/api/foto/x', nombre: 'Blusa de algodón', codigo: 'ED-123', precio: 20000, precio_lista: 30000, talla: 'M' });
  assert.equal(canvas.width, 1080); assert.equal(canvas.height, 1350);
  assert.equal(r.type, 'image/jpeg'); assert.equal(r.name, 'ED-123.jpg');
  assert.ok(Math.abs(Number(dibujos[0][3]) - 469) < 1e-9);
  assert.ok(Math.abs(Number(dibujos[0][4]) - 938) < 1e-9);
  assert.equal(dibujos.length, 2);
  assert.ok(Math.abs(Number(dibujos[1][3]) / Number(dibujos[1][4]) - 600 / 156) < 0.001);
  // El logo va directo sobre el azul: ningún rectángulo (solo fondo, franja azul) se pinta tras él.
  assert.equal(rects.length, 2);
  assert.deepEqual(rects.map((r) => r[1]), [0, 1000]);
  assert.equal(Number(dibujos[1][1]) + Number(dibujos[1][3]), 1040);
  assert.ok(Number(dibujos[1][2]) + Number(dibujos[1][4]) <= 1350);
  assert.deepEqual(textos, ['Blusa de algodón', '$200', '$300', 'ED-123', 'Talla M']);
  assert.equal(tachados, 1);
});

test('partirNombre: cabe en una línea, parte por palabras, recorta con «…» y limpia espacios', () => {
  const medidor = { measureText: (t: string) => ({ width: t.length * 10 }) }; // 10 px por carácter
  assert.deepEqual(partirNombre(medidor, '  Blusa \n de   algodón ', 200, 2), ['Blusa de algodón']);
  assert.deepEqual(partirNombre(medidor, 'Tenis Nike Air Max originales nuevos', 150, 2), ['Tenis Nike Air', 'Max originales…']);
  assert.deepEqual(partirNombre(medidor, 'Tenis Nike Air Max 270', 150, 2), ['Tenis Nike Air', 'Max 270']);
  assert.deepEqual(partirNombre(medidor, 'Pantalón corte recto', 100, 1), ['Pantalón…']);
  assert.deepEqual(partirNombre(medidor, 'Supercalifragilisticoespialidoso piña', 100, 2), ['Supercalif', 'ragilisti…']);
  assert.deepEqual(partirNombre(medidor, '', 100, 2), []);
  assert.deepEqual(partirNombre(medidor, undefined as unknown as string, 100, 2), []);
  for (const t of ['a'.repeat(200), 'Camisa ñandú '.repeat(8)]) for (const l of partirNombre(medidor, t, 300, 2)) assert.ok(l.length * 10 <= 300);
});

test('una computadora registra al interesado con el cajero del PIN, nunca la cuenta compartida', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const p = pieza(db);
  usuario(db, 'pc@prueba.mx', 'computadora'); usuario(db, 'marta@prueba.mx', 'cajero');
  await pedir('/api/cuentas/pin', { correo: 'marta@prueba.mx', pin: '482913' }, 'PUT');
  env.DEV_USUARIO = 'pc@prueba.mx';
  const sesion = (await pedir('/api/cajeros/entrar', { correo: 'marta@prueba.mx', pin: '482913' })).cuerpo;
  const r = await pedir('/api/interesados', registro(p.id), 'POST', { 'x-cajero': sesion.token });
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.interesado.vendedora, 'marta@prueba.mx');
});

/* ---------- Revendedoras (#579): funciones puras de /vender ---------- */

test('fecha y hora legibles: zona de la tienda, 12 horas con «a. m.» y «p. m.», medianoche y mediodía', () => {
  assert.equal(fechaLegible('2026-10-30T20:00:00.000Z'), 'viernes 30 oct, 2:00 p. m.');
  assert.equal(fechaLegible('2026-10-31T03:30:00.000Z'), 'viernes 30 oct, 9:30 p. m.');   // UTC ya es 31, en la tienda sigue siendo 30
  assert.equal(horaLegible('2026-10-30T06:05:00.000Z'), '12:05 a. m.');
  assert.equal(horaLegible('2026-10-30T18:00:00.000Z'), '12:00 p. m.');
  assert.equal(horaLegible(Date.parse('2026-10-30T20:35:00.000Z')), '2:35 p. m.');
});

test('aviso al cliente: nombre, talla solo si existe, código, precio en pesos, fecha de vencimiento y enlace wa.me/52', () => {
  const vence = '2026-10-30T20:00:00.000Z';
  const sin = textoAvisoCliente({ nombre: 'Blusa de algodón', codigo: 'ED-002335', precio: 20050 }, 'Ana', vence);
  assert.equal(sin, 'Hola Ana, ya te aparté Blusa de algodón (ED-002335) por $200.50. La tengo apartada hasta el viernes 30 oct, 2:00 p. m. '
    + 'Para pagar, escríbeme y te paso los datos de la tienda.');
  const con = textoAvisoCliente({ nombre: 'Blusa\n azul', codigo: 'ED-1', precio: 30000, talla: 'M' }, ' Ana  María ', vence);
  assert.match(con, /^Hola Ana María, ya te aparté Blusa azul talla M \(ED-1\) por \$300\. /);
  const url = new URL(enlaceCliente('4441234567', 'Hola & más'));
  assert.equal(url.origin + url.pathname, 'https://wa.me/524441234567');
  assert.equal(url.searchParams.get('text'), 'Hola & más');
});

test('chip de Mis ventas: umbrales de 6 h y 1 h, vencido por reloj, pago registrado y estados cerrados', () => {
  const ahora = Date.parse('2026-10-29T12:00:00.000Z');
  const vence = (ms: number) => new Date(ahora + ms).toISOString();
  const H = 3_600_000, M = 60_000;
  const apartado = (ms: number, extra: Record<string, unknown> = {}) => ({ estado: 'apartado', saldo: 0, vence_en: vence(ms), ...extra });
  assert.deepEqual(estadoMia(apartado(30 * H), ahora), { clase: 'aviso', texto: '⏳ Esperando pago · te quedan 30 h' });
  assert.deepEqual(estadoMia(apartado(6 * H + M), ahora), { clase: 'aviso', texto: '⏳ Esperando pago · te quedan 6 h' });
  assert.deepEqual(estadoMia(apartado(6 * H), ahora), { clase: 'alerta', texto: '⚠ Se vence pronto · te quedan 6 h' });
  assert.deepEqual(estadoMia(apartado(5 * H + 59 * M), ahora), { clase: 'alerta', texto: '⚠ Se vence pronto · te quedan 5 h' });
  assert.deepEqual(estadoMia(apartado(H), ahora), { clase: 'alerta', texto: '⚠ Se vence pronto · te quedan 1 h' });
  assert.deepEqual(estadoMia(apartado(59 * M), ahora), { clase: 'alerta', texto: '⚠ Se vence pronto · te queda menos de 1 h' });
  for (const ms of [0, -M, -5 * H]) assert.deepEqual(estadoMia(apartado(ms), ahora), { clase: 'alerta', texto: '⚠ Ya venció. En unos minutos la pieza vuelve a la venta.' });
  const pagado = estadoMia(apartado(-H, { saldo: 10000 }), ahora);   // con pago, la tienda ya extendió el plazo: no es «venció»
  assert.equal(pagado.clase, 'ok');
  assert.match(pagado.texto, /^✓ La tienda ya registró su pago · Recoger antes del /);
  assert.deepEqual(estadoMia({ estado: 'vendido' }, ahora), { clase: 'ok', texto: '✓ Cobrada: la tienda ya cobró' });
  assert.deepEqual(estadoMia({ estado: 'vencido' }, ahora), { clase: 'cerrada', texto: '✕ Se venció · la pieza volvió a la venta' });
  assert.deepEqual(estadoMia({ estado: 'cancelado' }, ahora), { clase: 'cerrada', texto: '✕ Cancelada' });
});

test('Mis ventas: grupos por urgencia, cerradas por folio descendente y total cobrado solo de lo vendido', () => {
  const ahora = Date.parse('2026-10-29T12:00:00.000Z');
  const en = (h: number) => new Date(ahora + h * 3_600_000).toISOString();
  const pedidos = [
    { folio: 5, estado: 'apartado', saldo: 0, vence_en: en(30), subtotal: 10000 },
    { folio: 9, estado: 'apartado', saldo: 0, vence_en: en(4), subtotal: 20000 },
    { folio: 7, estado: 'apartado', saldo: 5000, vence_en: en(20), subtotal: 30000 },
    { folio: 3, estado: 'vendido', saldo: 0, vence_en: en(-50), subtotal: 40000 },
    { folio: 6, estado: 'vendido', saldo: 0, vence_en: en(-10), subtotal: 15050 },
    { folio: 8, estado: 'cancelado', saldo: 0, vence_en: en(-5), subtotal: 99900 },
    { folio: 4, estado: 'vencido', saldo: 0, vence_en: en(-9), subtotal: 99900 },
  ];
  const g = agruparMias(pedidos);
  assert.deepEqual(g.esperando.map((p) => p.folio), [9, 5]);
  assert.deepEqual(g.pagadas.map((p) => p.folio), [7, 6, 3]);
  assert.deepEqual(g.anteriores.map((p) => p.folio), [8, 4]);
  assert.equal(pedidos[0].folio, 5);   // no reordena la lista original
  assert.equal(cobradoMias(pedidos), 55050);
  assert.equal(cobradoMias([]), 0);
});

test('regresión U6: ninguna recarga escribe en la franja #resultado, que solo cambia por una acción de la usuaria', () => {
  const html = readFileSync('public/vender.html', 'utf8').replace(/\r\n/g, '\n');
  for (const nombre of ['cargarPiezas', 'cargarInteresados', 'cargarMias', 'recargar', 'refrescar']) {
    const cuerpo = html.match(new RegExp(String.raw`(?:async )?function ${nombre}\(\) \{[\s\S]*?\n\}\n`))?.[0];
    assert.ok(cuerpo, nombre);
    assert.ok(!/\bresultado\(/.test(cuerpo), `${nombre} no debe escribir en #resultado`);
  }
  assert.match(html, /id="resultado-ok"[^>]*>Entendido</);   // se quita solo con «Entendido»
});
