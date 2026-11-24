// node --test src/vender.test.ts: API real, SQLite con migraciones y lógica del navegador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { tienda, DUENO, datosTransferencia } from './prueba-d1.ts';
import { olvidarVentasRecomendadas, olvidarLlamativas } from './vender.ts';
import { permiso, puede, esDeCaja, type Rol } from './cuentas.ts';
import * as venta from '../public/venta.js';
import { textoWhatsApp, telefonoInteresado, codigoDeRespuesta, enlaceApartar, textoSeguimiento, compartirTarjetas, crearTarjeta, partirNombre,
  fechaLegible, horaLegible, tituloLista, textoAvisoCliente, textoBienvenidaSocio, enlaceCliente, estadoMia, agruparMias, cobradoMias } from '../public/vender.js';

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
  db.prepare("insert into usuarios (correo, nombre, roles, activo, tienda, creado_en, actualizado_en) values (?, ?, ?, 1, ?, '', '')")
    .run(correo, nombre, rol, rol === 'computadora' ? 'soledad' : '');   // R2 de #793: la computadora cobra solo con tienda
}

test('texto de una pieza: centavos, antes, talla, acentos y cierre exactos', () => {
  assert.equal(textoWhatsApp([{ nombre: 'Blusa de algodón', talla: 'M', precio: 20050, precio_lista: 30000, codigo: 'ED-1234' }]),
    '🛍️ Blusa de algodón · Talla M\n💵 $200.50 (antes $300)\n🔖 ED-1234\n🔗 https://eldolaron.com/?pieza=ED-1234#catalogo\n'
    + 'Apártala con $100 por 7 días: responde con el código.\n🚚 Envíos todos los viernes.\n📍 Jardín Hidalgo 129, Soledad · todos los días de 11 a 8');
  const simple = textoWhatsApp([{ nombre: 'Jarrón\n azul', talla: null, precio: 10000, precio_lista: 10000, codigo: 'ED-1' }]);
  assert.match(simple, /^🛍️ Jarrón azul\n💵 \$100\n/);
  assert.ok(!simple.includes('antes') && !simple.includes('Talla'));
  assert.throws(() => textoWhatsApp([]));
  assert.throws(() => textoWhatsApp(Array(11).fill({})));
});

test('texto para revendedora: sin el apartado con $100 por 7 días y sin prometer anticipo (#575)', () => {
  const pieza = { nombre: 'Blusa', talla: 'M', precio: 20000, precio_lista: 30000, codigo: 'ED-1234' };
  const texto = textoWhatsApp([pieza], true);
  assert.ok(texto.includes('Apártala: responde con el código.'));
  assert.ok(!/15 %|7 días|\$100/.test(texto));
  assert.ok(texto.includes('Envíos todos los viernes') && texto.includes('Jardín Hidalgo 129'));
  assert.ok(!/\$100|7 días/.test(textoWhatsApp([pieza, pieza], true)));
  assert.match(textoWhatsApp([pieza]), /\$100 por 7 días/);   // la caja no cambia
  const i = { cliente: 'Ana', nombre: 'Blusa', codigo: 'ED-1', disponibilidad: 'Disponible' };
  assert.ok(!/\$100|7 días/.test(textoSeguimiento(i, true)));
  assert.match(textoSeguimiento(i), /\$100 por 7 días/);
});

test('varias piezas: una línea por pieza y un solo cierre, hasta diez', () => {
  const piezas = Array.from({ length: 10 }, (_, n) => ({ codigo: `ED-${n}`, nombre: 'Blusa', precio: 10001, precio_lista: 20000 }));
  const texto = textoWhatsApp(piezas);
  assert.equal(texto.split('\n').length, 13);   // 10 piezas (con su enlace, #590) + apartado + envíos + dirección
  assert.equal(texto.match(/Apártala/g)?.length, 1);
  assert.ok(texto.startsWith('ED-0 · Blusa · $100.01 · https://eldolaron.com/?pieza=ED-0#catalogo\nED-1'));
});

test('#875: la dirección y el horario solo salen para piezas de Soledad; las otras tiendas dicen su nombre y nada más', () => {
  const base = { nombre: 'Blusa', talla: 'M', precio: 20000, precio_lista: 20000 };
  const soledad = { ...base, codigo: 'ED-1', tiendas: ['Soledad'] };
  const salk = { ...base, codigo: 'ED-2', tiendas: ['Avenida Salk'] };
  const romero = { ...base, codigo: 'ED-3', tiendas: ['Coronel Romero'] };
  const ambas = { ...base, codigo: 'ED-4', tiendas: ['Soledad', 'Avenida Salk'] };
  const viejo = { ...base, codigo: 'ED-5' };   // caché o servidor anterior: sin `tiendas`
  const DIRECCION = /Jardín Hidalgo 129|11 a 8/;
  const cierre = (t: string) => t.split('\n').at(-1);
  // Una pieza.
  assert.equal(cierre(textoWhatsApp([soledad])), '📍 Jardín Hidalgo 129, Soledad · todos los días de 11 a 8');
  assert.equal(cierre(textoWhatsApp([viejo])), '📍 Jardín Hidalgo 129, Soledad · todos los días de 11 a 8');
  assert.equal(textoWhatsApp([viejo]), textoWhatsApp([{ ...viejo, tiendas: [] }]));
  assert.equal(cierre(textoWhatsApp([ambas])), '📍 Jardín Hidalgo 129, Soledad · todos los días de 11 a 8');
  for (const [pieza, nombre] of [[salk, 'Avenida Salk'], [romero, 'Coronel Romero']] as const) {
    const texto = textoWhatsApp([pieza]);
    assert.equal(cierre(texto), `📍 Está en El Dolarón ${nombre}`);
    assert.ok(!DIRECCION.test(texto), 'no inventa dirección ni horario');
    assert.match(texto, /Envíos todos los viernes/);
  }
  assert.ok(!DIRECCION.test(textoWhatsApp([salk], true)));
  // Varias de la misma tienda: igual que hoy, sin renglones extra.
  const dos = textoWhatsApp([soledad, viejo]);
  assert.equal(dos.split('\n').length, 5);
  assert.ok(!dos.includes('📍 Soledad'));
  // Varias solo de otras tiendas: cada renglón dice la suya y no hay dirección.
  const fuera = textoWhatsApp([salk, romero]);
  assert.ok(!DIRECCION.test(fuera));
  assert.match(fuera, /ED-2 · Blusa · \$200 · \S+ · 📍 Avenida Salk\n/);
  assert.match(fuera, /ED-3 · Blusa · \$200 · \S+ · 📍 Coronel Romero\n/);
  assert.ok(!cierre(fuera)!.startsWith('📍'));
  // Mezcla: cada renglón dice dónde está y la dirección se rotula como la de Soledad.
  const mezcla = textoWhatsApp([soledad, salk, ambas], true);
  assert.match(mezcla, /ED-1 · Blusa · \$200 · \S+ · 📍 Soledad\n/);
  assert.match(mezcla, /ED-2 · Blusa · \$200 · \S+ · 📍 Avenida Salk\n/);
  assert.match(mezcla, /ED-4 · Blusa · \$200 · \S+ · 📍 Soledad\n/);
  assert.equal(cierre(mezcla), '📍 Soledad: Jardín Hidalgo 129 · todos los días de 11 a 8');
  assert.equal(mezcla.match(/Jardín Hidalgo 129/g)?.length, 1);
  assert.equal(mezcla.match(/Apártala/g)?.length, 1);
  // Sin `tiendas` junto a una pieza de otra tienda: la vieja se cuenta como Soledad.
  assert.match(textoWhatsApp([viejo, salk]), /ED-5 .* · 📍 Soledad\n/);
});

test('#875: /vender da Compartir en un toque al personal y «La quiere» termina en «Ya pagó: apartar» o «Solo anotar»', () => {
  const html = readFileSync('public/vender.html', 'utf8').replace(/\r\n/g, '\n');
  // El botón Compartir de cada tarjeta ya no nace oculto ni se muestra solo en modo revendedora.
  assert.match(html, /<button type="button" class="principal compartir-uno">Compartir<\/button>/);
  assert.ok(!/compartir-uno'\)\.hidden/.test(html));
  // Dos salidas; «Ya pagó» solo navega con enlaceApartar y no llama a /api/interesados.
  assert.match(html, /<button id="apartar-ya" class="principal" type="button">Ya pagó: apartar<\/button><button id="guardar" type="submit">Solo anotar<\/button>/);
  const apartar = html.match(/\$\('apartar-ya'\)\.addEventListener\('click'[\s\S]*?\n\}\);\n/)![0];
  assert.match(apartar, /location\.href = enlaceApartar\(\{ codigo: piezaInteresado\.codigo, cliente, telefono \}\)/);
  assert.ok(!apartar.includes('/api/interesados'));
  assert.match(apartar, /if \(!telefono\)/);   // /pedidos exige el WhatsApp: vacío o inválido no navega
  assert.match(html, /\$\('apartar-ya'\)\.hidden = true;/);   // la revendedora no aparta: la tienda registra el pago
  // El tamaño táctil es de todos: ya no cuelga de body.rev.
  const reglas = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  assert.match(reglas, /\n {2}body \{[^}]*font-size: 18px/);
  assert.match(reglas, /\n {2}button, \.boton \{[^}]*min-height: 56px/);
  assert.deepEqual([...reglas.matchAll(/body\.rev [^{]+/g)].map((m) => m[0].trim()), ['body.rev .solo-caja', 'body.rev #ver-mias', 'body.rev #ver-interesados']);
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
    classList: { contains: () => false }, addEventListener() {}, focus() {}, scrollIntoView() {}, append() {} });
  const $ = (id: string) => { if (!nodos.has(id)) nodos.set(id, nodo()); return nodos.get(id); };
  const llamadas: string[] = [];
  let limpia = '';
  const script = readFileSync('public/pedidos.html', 'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)![1].replace(/^import .+;$/gm, '');
  const params = new URLSearchParams({ codigo: 'ED-000123', cliente: 'Ana <img>', telefono: '4441234567' });
  await runInNewContext(`(async () => { ${script} })()`, {
    document: { getElementById: $, querySelector: () => ({ value: 'tienda', checked: true, addEventListener() {} }), querySelectorAll: () => [] },
    location: { search: `?${params}`, pathname: '/pedidos' }, history: { replaceState: (_a: unknown, _b: unknown, url: string) => { limpia = url; } },
    URLSearchParams, navigator: { onLine: true }, setInterval() {}, localStorage: { getItem: () => null }, Option: class {},
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
  // Prellena el mínimo de la regla vigente ($100 fijos, #662), nunca lo envía.
  const reglas = venta as Record<string, any>;
  const minimo = reglas.anticipoMinimoDe ? reglas.anticipoMinimoDe(20000) : reglas.ANTICIPO_MINIMO;
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

test('bienvenida al socio (#739): nombre, número y portal; el mínimo de $1,000 solo con regalo de apertura', () => {
  const sin = textoBienvenidaSocio({ numero: 42, nombre: ' Ana\n María ', regalo: 0 });
  assert.equal(sin, 'Hola Ana María, te damos la bienvenida a Dolarones de El Dolarón. Tu número de socio es el 42. '
    + 'Para ver tu saldo de Dolarones, entra con tu celular a https://dolarones.eldolaron.com');
  assert.ok(!sin.includes('1,000'));
  assert.match(textoBienvenidaSocio({ numero: 42, nombre: 'Ana', regalo: 5000 }), /compras de \$1,000 MXN o más antes de descontar Dolarones.$/);
  const url = new URL(enlaceCliente('4441234567', sin));
  assert.equal(url.searchParams.get('text'), sin);
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

/* ---------- #882: por tienda y recomendados ---------- */

type Tiendas = ReturnType<typeof tienda>;
/** Unidades de una pieza en una sucursal, con su fecha de llegada (existencia_tienda.actualizado_en). */
const enSucursal = (db: DatabaseSync, id: string, sucursal: string, unidades: number, actualizado_en = new Date().toISOString()) =>
  db.prepare('insert or replace into existencia_tienda (producto_id, tienda, unidades, actualizado_en) values (?, ?, ?, ?)').run(id, sucursal, unidades, actualizado_en);
/** Una venta de `cantidad` unidades de la pieza, cobrada en `donde`. */
function vendido(db: DatabaseSync, p: { id: string; codigo: unknown; nombre: unknown }, donde: string, cantidad: number, extra: Record<string, unknown> = {}) {
  const id = crypto.randomUUID();
  const fila = { id, total: 1000, forma_pago: 'efectivo', creado_en: new Date().toISOString(), registrado_en: '', tienda: donde, ...extra };
  db.prepare(`insert into ventas (${Object.keys(fila).join(',')}) values (${Object.keys(fila).map(() => '?').join(',')})`).run(...Object.values(fila) as never[]);
  db.prepare('insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad) values (?, ?, ?, ?, 1000, ?)').run(id, p.id, p.codigo as string, p.nombre as string, cantidad);
}
const ids = (r: { cuerpo: Record<string, any> }) => r.cuerpo.piezas.map((p: any) => p.id);
const comoRevendedora = (t: Tiendas) => { usuario(t.db, 'rev@prueba.mx', 'revendedora', 'Rita'); (t.env as unknown as Record<string, string>).DEV_USUARIO = 'rev@prueba.mx'; };

test('#882: tienda=soledad pide stock en Soledad; tienda=sucursal pide unidades ahí; sin tienda sigue mezclado', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const soloSoledad = pieza(db);
  const soloSalk = pieza(db, { stock: 0 }); enSucursal(db, soloSalk.id, 'salk', 2);
  const ambas = pieza(db); enSucursal(db, ambas.id, 'salk', 1);
  const vacia = pieza(db, { stock: 0 }); enSucursal(db, vacia.id, 'salk', 0);   // la sucursal la agotó: no está en ninguna
  const lista = async (q: string) => new Set(ids(await pedir(`/api/vender${q}`)));
  assert.deepEqual(await lista(''), new Set([soloSoledad.id, soloSalk.id, ambas.id]));
  assert.deepEqual(await lista('?tienda=soledad'), new Set([soloSoledad.id, ambas.id]));
  assert.deepEqual(await lista('?tienda=salk'), new Set([soloSalk.id, ambas.id]));
  assert.deepEqual(await lista('?tienda=romero'), new Set());
  // Las tarjetas siguen diciendo dónde está (nombres, nunca unidades) con el filtro puesto.
  const salk = (await pedir('/api/vender?tienda=salk')).cuerpo.piezas;
  assert.deepEqual(salk.find((p: any) => p.id === ambas.id).tiendas, ['Soledad', 'Avenida Salk']);
  assert.deepEqual(salk.find((p: any) => p.id === soloSalk.id).tiendas, ['Avenida Salk']);
  assert.ok(!JSON.stringify(salk).includes('unidades'));
  // Una categoría y un nombre se combinan con la tienda.
  const hogar = pieza(db, { stock: 0, categoria: 'hogar', nombre: 'Jarrón azul' }); enSucursal(db, hogar.id, 'romero', 1);
  assert.deepEqual(await lista('?tienda=romero&categoria=hogar'), new Set([hogar.id]));
  assert.deepEqual(await lista('?tienda=romero&q=jarr'), new Set([hogar.id]));
  assert.deepEqual(await lista('?tienda=salk&categoria=hogar'), new Set());
});

test('#882: en una sucursal lo último en llegar va primero, 24 por página con empates y sin duplicar ni saltar al agotarse una pieza', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const base = Date.parse('2026-11-01T12:00:00.000Z');
  // Tres llegadas: 6 en el día 50, 24 empatadas en el día 40 (el corte de la página cae en medio del empate) y 6 en el día 30.
  // Se capturaron al revés (creado_en baja con n): el orden es el de llegada a la tienda, no el de alta.
  const todas = Array.from({ length: 36 }, (_, n) => {
    const p = pieza(db, { stock: 0, creado_en: new Date(base - n * 1000).toISOString() });
    enSucursal(db, p.id, 'salk', 1, new Date(base + 86_400_000 * (n < 6 ? 50 : n < 30 ? 40 : 30)).toISOString());
    return p;
  });
  const llegada = (id: string) => (db.prepare("select actualizado_en from existencia_tienda where producto_id = ? and tienda = 'salk'").get(id) as { actualizado_en: string }).actualizado_en;
  const primera = (await pedir('/api/vender?tienda=salk')).cuerpo;
  assert.equal(primera.piezas.length, 24);
  assert.ok(primera.siguiente);
  const fechas = primera.piezas.map((p: any) => llegada(p.id));
  assert.deepEqual(fechas, [...fechas].sort().reverse());
  assert.deepEqual(new Set(primera.piezas.slice(0, 6).map((p: any) => p.id)), new Set(todas.slice(0, 6).map((p) => p.id)));
  db.prepare('update existencia_tienda set unidades = 0 where producto_id = ?').run(primera.piezas[0].id);   // se agota entre páginas
  const segunda = (await pedir('/api/vender?' + new URLSearchParams({ tienda: 'salk', cursor: primera.siguiente }))).cuerpo;
  assert.equal(segunda.siguiente, null);
  assert.equal(segunda.piezas.length, 12);
  const vistas = [...primera.piezas, ...segunda.piezas].map((p: any) => p.id);
  assert.equal(new Set(vistas).size, vistas.length, 'sin duplicados');
  assert.deepEqual(new Set(vistas), new Set(todas.map((p) => p.id)), 'sin saltos');
  assert.ok(llegada(segunda.piezas[0].id) <= fechas.at(-1));
  // El cursor es la llegada a la tienda y la fila de la pieza; uno sin fila sigue siendo 400.
  assert.match(primera.siguiente, /^2026-.*~\d+$/);
  assert.equal((await pedir('/api/vender?tienda=salk&cursor=2026-10-01~0')).status, 400);
  // Con tope y por índice: ninguna consulta recorre existencia_tienda completa ni usa count/offset, y la tienda va ligada.
  const consultas: string[] = [];
  const preparar = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (sql.includes('from existencia_tienda e')) consultas.push(sql); return preparar(sql); };
  await pedir('/api/vender?tienda=salk');
  await pedir('/api/vender?' + new URLSearchParams({ tienda: 'salk', cursor: primera.siguiente }));
  assert.equal(consultas.length, 2);
  for (const sql of consultas) {
    assert.match(sql, /limit \?/);
    assert.ok(!/count\(|offset /i.test(sql));
    assert.ok(!sql.includes("'salk'"), 'la tienda va ligada, no escrita en el SQL');
    const plan = db.prepare('explain query plan ' + sql).all(...(sql.includes('<= ?') ? ['salk', '2026-11-30', '2026-11-30', 999999, 24] : ['salk', 24]));
    assert.ok(plan.some((p) => String(p.detail).includes('existencia_tienda_cambios')), JSON.stringify(plan));
    assert.ok(!plan.some((p) => /SCAN e/.test(String(p.detail))), JSON.stringify(plan));
  }
});

test('#882: hoy con tienda es «llegó hoy a esa tienda»', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const hoy = new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10);
  const apertura = `${hoy}T06:00:00.000Z`;
  const llegoHoy = pieza(db, { stock: 0, creado_en: '2026-01-01T00:00:00.000Z' }); enSucursal(db, llegoHoy.id, 'salk', 1, apertura);
  const llegoAyer = pieza(db, { stock: 0 }); enSucursal(db, llegoAyer.id, 'salk', 1, new Date(Date.parse(apertura) - 1).toISOString());
  const nuevaEnSoledad = pieza(db, { creado_en: apertura });
  const vieja = pieza(db, { creado_en: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(ids(await pedir('/api/vender?tienda=salk&hoy=1')), [llegoHoy.id]);
  assert.deepEqual(ids(await pedir('/api/vender?tienda=soledad&hoy=1')), [nuevaEnSoledad.id]);
  assert.ok(!ids(await pedir('/api/vender?hoy=1')).includes(vieja.id));
});

test('#882: tienda y orden inválidos dan 400 y el código exacto ignora la tienda', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const enSoledad = pieza(db, { nombre: 'Lámpara' });
  for (const q of ['tienda=foo', 'tienda=', 'tienda=SALK', 'tienda=salk%20', "tienda=salk'%20or%201=1",
    'orden=recomendado', 'orden=recomendado&tienda=foo', 'orden=nuevo&tienda=salk', 'orden=&tienda=salk',
    'orden=recomendado&tienda=salk&q=mpara', 'orden=recomendado&tienda=salk&hoy=1', 'orden=recomendado&tienda=salk&cursor=2026-11-01~3'])
    assert.equal((await pedir(`/api/vender?${q}`)).status, 400, q);
  // Un código exacto se encuentra aunque se pida otra tienda: la tarjeta dice dónde está.
  for (const quien of ['soledad', 'salk', 'romero']) assert.deepEqual(ids(await pedir(`/api/vender?q=${enSoledad.codigo}&tienda=${quien}`)), [enSoledad.id], quien);
  // Por nombre, en cambio, la tienda sí filtra.
  assert.deepEqual(ids(await pedir('/api/vender?q=mpara&tienda=salk')), []);
  assert.deepEqual(ids(await pedir('/api/vender?q=mpara&tienda=soledad')), [enSoledad.id]);
});

/** Salk vende 6 blusas (A) y 5 muñecos (B): 11 unidades. Quedan en Salk A, B, C, C2, D, D2 y una de hogar sin ventas. */
function mundoRecomendado() {
  olvidarVentasRecomendadas();
  const t = tienda();
  const { db } = t;
  const nueva = (n: number, cambios: Record<string, unknown>, unidades = 3) => {
    const p = pieza(db, { stock: 0, creado_en: new Date(Date.parse('2026-11-10T00:00:00.000Z') + n * 60_000).toISOString(), ...cambios });
    enSucursal(db, p.id, 'salk', unidades, p.creado_en as string);   // llegan en el orden de n
    return p;
  };
  const A = nueva(9, { nombre: 'Blusa A', categoria: 'ropa' });          // la más reciente de ropa y la más vendida: no se repite en el paso 2
  const B = nueva(1, { nombre: 'Muñeco B', categoria: 'juguetes' });
  const C = nueva(7, { nombre: 'Blusa C', categoria: 'ropa' });
  const C2 = nueva(2, { nombre: 'Blusa C2', categoria: 'ropa' });
  const D = nueva(3, { nombre: 'Carro D', categoria: 'juguetes' });
  const D2 = nueva(4, { nombre: 'Carro D2', categoria: 'juguetes' });
  const H = nueva(8, { nombre: 'Jarrón H', categoria: 'hogar' });
  vendido(db, A, 'salk', 4); vendido(db, A, 'salk', 2);
  vendido(db, B, 'salk', 5);
  return { ...t, A, B, C, C2, D, D2, H, nueva };
}

test('#882: recomendados de una tienda: lo vendido ahí que sigue en existencia y luego categorías que se venden, alternadas y sin repetir', async (t) => {
  const m = mundoRecomendado(); t.after(() => m.db.close());
  const { db, pedir, A, B, C, C2, D, D2, H } = m;
  // Ruido que no cuenta: otra tienda, cancelada, fuera de los 30 días, sin etiqueta ED- y una pieza agotada en Salk.
  const agotada = m.nueva(5, { nombre: 'Agotada', categoria: 'ropa' }, 0);
  vendido(db, agotada, 'salk', 9);
  vendido(db, H, 'soledad', 40);
  vendido(db, H, 'salk', 40, { cancelada: 1 });
  vendido(db, H, 'salk', 40, { creado_en: new Date(Date.now() - 31 * 86_400_000).toISOString() });
  const banda = pieza(db, { stock: 0, codigo: 'ZZ49', nombre: 'Juguetes $49', categoria: 'otros', sin_inventario: 1 }); enSucursal(db, banda.id, 'salk', 9);
  vendido(db, banda, 'salk', 40);
  const r = await pedir('/api/vender?tienda=salk&orden=recomendado');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.base, 'tienda');
  assert.equal(r.cuerpo.siguiente, null);
  // 1) A (6) y B (5); 2) ropa y juguetes alternando, de la más reciente: C, D2, C2, D. Hogar no entra.
  assert.deepEqual(ids(r), [A.id, B.id, C.id, D2.id, C2.id, D.id]);
  assert.deepEqual(r.cuerpo.piezas.map((p: any) => p.motivo), ['Aquí se vendieron 6 en 30 días', 'Aquí se vendieron 5 en 30 días',
    'Ropa y calzado se vende bien aquí', 'Juguetes se vende bien aquí', 'Ropa y calzado se vende bien aquí', 'Juguetes se vende bien aquí']);
  assert.ok(!ids(r).includes(H.id) && !ids(r).includes(agotada.id) && !ids(r).includes(banda.id));
  // Misma forma de tarjeta que la lista: tiendas, foto, cola.
  assert.deepEqual(r.cuerpo.piezas[0].tiendas, ['Avenida Salk']);
  assert.equal(r.cuerpo.piezas[0].foto, `/api/foto/${A.id}`);
  assert.deepEqual(r.cuerpo.piezas[0].cola, []);
  // Con categoría: solo esa.
  assert.deepEqual(ids(await pedir('/api/vender?tienda=salk&orden=recomendado&categoria=juguetes')), [B.id, D2.id, D.id]);
  assert.equal((await pedir('/api/vender?tienda=salk&orden=recomendado&categoria=hogar')).cuerpo.piezas.length, 0);
});

test('#882: con menos de 10 unidades vendidas en la tienda, los recomendados caen a todas las tiendas y no dicen «aquí»', async (t) => {
  const m = mundoRecomendado(); t.after(() => m.db.close());
  const { db, pedir, A, B } = m;
  // Romero casi no ha vendido (3 unidades) pero tiene la pieza A, una de ropa y una de hogar; Salk sí ha vendido.
  enSucursal(db, A.id, 'romero', 1);
  const ropaEnRomero = pieza(db, { stock: 0, categoria: 'ropa', nombre: 'Blusa R' }); enSucursal(db, ropaEnRomero.id, 'romero', 1);
  const hogarEnRomero = pieza(db, { stock: 0, categoria: 'hogar', nombre: 'Jarrón R' }); enSucursal(db, hogarEnRomero.id, 'romero', 1);
  vendido(db, hogarEnRomero, 'romero', 3);
  const r = await pedir('/api/vender?tienda=romero&orden=recomendado');
  assert.equal(r.cuerpo.base, 'todas');
  // Entre todas se vendieron A (6), B (5) y la de hogar (3); en Romero solo hay A, la de hogar y la de ropa.
  assert.deepEqual(ids(r), [A.id, hogarEnRomero.id, ropaEnRomero.id]);
  assert.deepEqual(r.cuerpo.piezas.map((p: any) => p.motivo), ['Se vendieron 6 en 30 días', 'Se vendieron 3 en 30 días', 'Ropa y calzado se vende bien']);
  assert.ok(!ids(r).includes(B.id), 'B no está en Romero');
  for (const p of r.cuerpo.piezas) assert.ok(!/aquí/i.test(p.motivo), p.motivo);
  // Sin nada vendido en ninguna tienda: lista vacía, sin rellenar con otras piezas.
  olvidarVentasRecomendadas();
  db.prepare('delete from venta_lineas').run(); db.prepare('delete from ventas').run();
  assert.deepEqual((await pedir('/api/vender?tienda=romero&orden=recomendado')).cuerpo, { piezas: [], siguiente: null, base: 'todas' });
});

test('#882: Soledad también tiene recomendados; las ventas se guardan una hora y la existencia se mira en cada carga', async (t) => {
  const m = mundoRecomendado(); t.after(() => m.db.close());
  const { db, pedir, A, C } = m;
  const enCentral = pieza(db, { nombre: 'Playera S', categoria: 'ropa' });
  for (let n = 0; n < 10; n++) vendido(db, enCentral, 'soledad', 1);
  const primera = await pedir('/api/vender?tienda=soledad&orden=recomendado');
  assert.equal(primera.cuerpo.base, 'tienda');
  assert.deepEqual(ids(primera), [enCentral.id]);
  assert.equal(primera.cuerpo.piezas[0].motivo, 'Aquí se vendieron 10 en 30 días');
  // Ventas nuevas durante la hora no cambian el agregado guardado...
  vendido(db, C, 'salk', 50);
  assert.equal((await pedir('/api/vender?tienda=salk&orden=recomendado')).cuerpo.piezas[0].id, A.id);
  // ...pero una pieza que se agota sale en seguida.
  db.prepare('update existencia_tienda set unidades = 0 where producto_id = ?').run(A.id);
  assert.ok(!ids(await pedir('/api/vender?tienda=salk&orden=recomendado')).includes(A.id));
  // Al olvidar lo guardado (o pasar la hora) se recalcula.
  olvidarVentasRecomendadas();
  assert.equal((await pedir('/api/vender?tienda=salk&orden=recomendado')).cuerpo.piezas[0].id, C.id);
});

test('#882: la revendedora no ve recomendados (403) y sigue viendo la lista de siempre', async (t) => {
  const m = mundoRecomendado(); t.after(() => m.db.close());
  comoRevendedora(m);
  for (const q of ['tienda=salk&orden=recomendado', 'orden=recomendado', 'tienda=foo&orden=recomendado']) assert.equal((await m.pedir(`/api/vender?${q}`)).status, 403, q);
  const lista = await m.pedir('/api/vender');
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.piezas.length, 7);
  assert.ok(!('base' in lista.cuerpo));
  assert.ok(lista.cuerpo.piezas.every((p: any) => !('motivo' in p)));
});

test('#882: el título dice qué se ve, con la tienda y la categoría por nombre', () => {
  assert.equal(tituloLista({ tienda: 'Avenida Salk' }), 'Lo nuevo en Avenida Salk');
  assert.equal(tituloLista({ orden: 'recomendado', tienda: 'Avenida Salk' }), 'Recomendados para Avenida Salk');
  assert.equal(tituloLista({ categoria: 'Juguetes' }), 'Juguetes en todas las tiendas');
  assert.equal(tituloLista({ tienda: 'Soledad', categoria: 'Juguetes' }), 'Juguetes en Soledad');
  assert.equal(tituloLista({ orden: 'recomendado', tienda: 'Coronel Romero', categoria: 'Ropa y calzado' }), 'Recomendados para Coronel Romero · Ropa y calzado');
  assert.equal(tituloLista({ tienda: 'Soledad', q: 'blusa', categoria: 'Ropa y calzado' }), 'Resultados de «blusa» en Soledad · Ropa y calzado');
  assert.equal(tituloLista({ hoy: true }), 'Ingresadas hoy en todas las tiendas');
  assert.equal(tituloLista(), 'Lo nuevo en todas las tiendas');
});

test('#882: la barra de tienda es solo del personal, conserva su estado al volver a la pestaña y no se guarda entre sesiones', () => {
  const html = readFileSync('public/vender.html', 'utf8').replace(/\r\n/g, '\n');
  // Nace oculta: la revendedora (y /manual, que no la usa) no la ven nunca; solo prepararVista la muestra y solo se llama fuera del modo revendedora.
  assert.match(html, /<section id="vista-tienda" class="panel" aria-label="Qué piezas ver" hidden>/);
  assert.equal(html.match(/\$\('vista-tienda'\)\.hidden = false/g)?.length, 1);
  assert.match(html, /if \(revendedora\) modoRevendedora\(\); else \{ \$\('acciones-interesado'\)\.classList\.add\('columna'\); prepararVista\(yo\); \}/);
  assert.equal(html.match(/prepararVista\(/g)?.length, 2);   // la definición y esa llamada
  const modo = html.match(/function modoRevendedora\(\) \{[\s\S]*?\n\}\n/)![0];
  assert.ok(!/vista-tienda|orden-|titulo-lista/.test(modo), 'el modo revendedora no toca la barra');
  // Controles nativos con su etiqueta, y los dos botones con aria-pressed.
  assert.match(html, /<label for="vista-tienda-sel">Tienda<\/label><select id="vista-tienda-sel">/);
  assert.match(html, /<label for="vista-categoria">Categoría<\/label><select id="vista-categoria">/);
  assert.match(html, /<button id="orden-nuevo" type="button" aria-pressed="true">Lo nuevo<\/button><button id="orden-recomendado" type="button" aria-pressed="false">Recomendados<\/button>/);
  // La tienda de la cuenta va primero y marcada; la lista parte de ella.
  assert.match(html, /\$\('vista-tienda-sel'\)\.value = miTienda;/);
  assert.match(html, /`\$\{t\.nombre\} · mi tienda`/);
  // El refresco al volver a la pestaña vuelve a pedir `consulta` y la página, que ya traen tienda, categoría y orden.
  const cargar = html.match(/async function cargarPiezas\(\) \{[\s\S]*?\n\}\n/)![0];
  assert.match(cargar, /new URLSearchParams\(consulta\)/);
  assert.match(cargar, /cursores\.at\(-1\)/);
  assert.match(html, /function refrescar\(\) \{[\s\S]*?recargar\(\);/);
  assert.match(html, /function consultaDePersonal\(\) \{[\s\S]*?'tienda'[\s\S]*?'categoria'[\s\S]*?'orden', 'recomendado'/);
  // Ni la tienda, ni la categoría, ni el orden van a localStorage.
  for (const memoria of html.matchAll(/localStorage\.\w+\([^)]*\)/g)) assert.ok(!/tienda|categoria|orden/.test(memoria[0]), memoria[0]);
  // Una lista vacía con tienda explica por qué y ofrece el botón.
  assert.match(html, /<button id="ver-todas" type="button">Ver todas las tiendas<\/button>/);
  assert.match(html, /solo salen las piezas con foto que llegan en bulto desde Soledad/);
  // La compartición pide cada pieza por código exacto, que ignora la tienda.
  assert.match(html, /api\('\/api\/vender\?' \+ new URLSearchParams\(\{ q: seleccionada\.codigo \}\)\)/);
});

/* ---------- #924: lo que también hay en otra tienda y lo más llamativo ---------- */

/** S solo Soledad · SK Soledad y Salk · K solo Salk · KR Salk y Romero · R solo Romero. */
function mundoCompartido() {
  const t = tienda();
  const { db } = t;
  const sucursal = (cambios: Record<string, unknown>, donde: [string, number][]) => {
    const p = pieza(db, { stock: 0, ...cambios });
    for (const [s, n] of donde) enSucursal(db, p.id, s, n, p.creado_en as string);
    return p;
  };
  const S = pieza(db, { nombre: 'Solo Soledad' });
  const SK = sucursal({ stock: 1, nombre: 'Soledad y Salk' }, [['salk', 2]]);
  const K = sucursal({ nombre: 'Solo Salk' }, [['salk', 1]]);
  const KR = sucursal({ nombre: 'Salk y Romero' }, [['salk', 1], ['romero', 1]]);
  const R = sucursal({ nombre: 'Solo Romero' }, [['romero', 1]]);
  return { ...t, S, SK, K, KR, R, sucursal };
}
const lista = async (pedir: Tiendas['pedir'], q: string) => new Set(ids(await pedir(`/api/vender?${q}`)));

test('#924: compartida pide unidades en la tienda y en al menos otra (Soledad = stock, sucursal = existencia_tienda)', async (t) => {
  const m = mundoCompartido(); t.after(() => m.db.close());
  const { db, pedir, S, SK, K, KR, R } = m;
  assert.deepEqual(await lista(pedir, 'tienda=salk&compartida=1'), new Set([SK.id, KR.id]));
  assert.deepEqual(await lista(pedir, 'tienda=soledad&compartida=1'), new Set([SK.id]));
  assert.deepEqual(await lista(pedir, 'tienda=romero&compartida=1'), new Set([KR.id]));
  // Sin la casilla nada cambia.
  assert.deepEqual(await lista(pedir, 'tienda=salk'), new Set([SK.id, K.id, KR.id]));
  assert.ok(!(await lista(pedir, 'tienda=soledad&compartida=1')).has(S.id) && !(await lista(pedir, 'tienda=romero&compartida=1')).has(R.id));
  // Una fila de la otra tienda en cero no cuenta; vuelve a contar al reponerla.
  enSucursal(db, KR.id, 'romero', 0);
  assert.deepEqual(await lista(pedir, 'tienda=salk&compartida=1'), new Set([SK.id]));
  enSucursal(db, KR.id, 'romero', 1);
  // Una pieza que Soledad agotó deja de ser compartida con Soledad, y la sucursal ya no la ve compartida.
  db.prepare('update productos set stock = 0 where id = ?').run(SK.id);
  assert.deepEqual(await lista(pedir, 'tienda=soledad&compartida=1'), new Set());
  assert.deepEqual(await lista(pedir, 'tienda=salk&compartida=1'), new Set([KR.id]));
  // Las tarjetas dicen en qué tiendas está (nombres, nunca unidades).
  const r = (await pedir('/api/vender?tienda=salk&compartida=1')).cuerpo.piezas;
  assert.deepEqual(r.map((p: any) => p.tiendas), [['Avenida Salk', 'Coronel Romero']]);
  assert.ok(!JSON.stringify(r).includes('unidades'));
});

test('#924: compartida se combina con categoría, nombre y hoy', async (t) => {
  const m = mundoCompartido(); t.after(() => m.db.close());
  const { db, pedir, SK, KR, sucursal } = m;
  const hogar = sucursal({ stock: 1, nombre: 'Jarrón azul', categoria: 'hogar' }, [['salk', 1]]);
  const hogarSalk = sucursal({ nombre: 'Jarrón rojo', categoria: 'hogar' }, [['salk', 1]]);
  for (const quien of ['salk', 'soledad']) {
    const con = quien === 'salk' ? [SK.id, KR.id, hogar.id] : [SK.id, hogar.id];
    assert.deepEqual(await lista(pedir, `tienda=${quien}&compartida=1`), new Set(con), quien);
    assert.deepEqual(await lista(pedir, `tienda=${quien}&compartida=1&categoria=hogar`), new Set([hogar.id]), quien);
    assert.deepEqual(await lista(pedir, `tienda=${quien}&compartida=1&q=jarr`), new Set([hogar.id]), quien);
    assert.deepEqual(await lista(pedir, `tienda=${quien}&compartida=1&q=nada`), new Set(), quien);
  }
  assert.ok(!(await lista(pedir, 'tienda=salk&compartida=1&categoria=hogar')).has(hogarSalk.id));
  // «Hoy»: en una sucursal es la llegada a esa sucursal; en Soledad, el alta.
  const apertura = `${new Date(Date.now() - 6 * 3_600_000).toISOString().slice(0, 10)}T06:00:00.000Z`;
  db.prepare('update productos set creado_en = ? where id = ?').run('2026-01-01T00:00:00.000Z', SK.id);
  db.prepare("update existencia_tienda set actualizado_en = ? where producto_id = ? and tienda = 'salk'").run(apertura, SK.id);
  db.prepare("update existencia_tienda set actualizado_en = '2026-01-01T00:00:00.000Z' where producto_id <> ?").run(SK.id);
  assert.deepEqual(await lista(pedir, 'tienda=salk&compartida=1&hoy=1'), new Set([SK.id]));
  assert.ok(!(await lista(pedir, 'tienda=soledad&compartida=1&hoy=1')).has(SK.id));
  assert.ok(!(await lista(pedir, 'tienda=salk&compartida=1&hoy=1')).has(KR.id));
});

test('#924: compartida pagina por cursor sin duplicar ni saltar, en una sucursal y en Soledad', async (t) => {
  const { db, pedir, sucursal, SK, KR } = mundoCompartido(); t.after(() => db.close());
  const base = Date.parse('2026-11-01T12:00:00.000Z');
  // 30 compartidas Soledad-Salk; las 24 más recientes empatan en fecha para que el corte caiga en medio del empate.
  const todas = Array.from({ length: 30 }, (_, n) => sucursal({ stock: 1, nombre: `Pieza ${'abcdefghijklmnopqrstuvwxyzñ'[n]}`, creado_en: new Date(base - (n < 24 ? 0 : n) * 1000).toISOString() }, [['salk', 1]]));
  const bajar = async (quien: string, esperadas: { id: string }[]) => {
    const vistas: string[] = [];
    let cursor: string | null = null;
    for (let paginas = 0; paginas < 4; paginas++) {
      const r: { piezas: { id: string }[]; siguiente: string | null } = (await pedir('/api/vender?' + new URLSearchParams({ tienda: quien, compartida: '1', ...(cursor ? { cursor } : {}) }))).cuerpo;
      assert.ok(r.piezas.length <= 24);
      vistas.push(...r.piezas.map((p) => p.id));
      if (!r.siguiente) break;
      cursor = r.siguiente;
    }
    assert.equal(new Set(vistas).size, vistas.length, `${quien}: sin duplicados`);
    assert.deepEqual(new Set(vistas), new Set(esperadas.map((p) => p.id)), `${quien}: sin saltos`);
    return vistas;
  };
  const enSalk = await bajar('salk', [...todas, SK, KR]);
  const enSoledad = await bajar('soledad', [...todas, SK]);
  assert.equal(enSalk.length, 32);
  assert.equal(enSoledad.length, 31);
  // Soledad ordena por alta (más reciente primero), como su lista de siempre.
  const alta = (id: string) => (db.prepare('select creado_en from productos where id = ?').get(id) as { creado_en: string }).creado_en;
  const fechas = enSoledad.map(alta);
  assert.deepEqual(fechas, [...fechas].sort().reverse());
});

test('#924: compartida en Soledad parte de existencia_tienda y no recorre productos', async (t) => {
  const { db, env, pedir } = mundoCompartido(); t.after(() => db.close());
  const consultas: string[] = [];
  const preparar = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (sql.includes('group by e.producto_id')) consultas.push(sql); return preparar(sql); };
  await pedir('/api/vender?tienda=soledad&compartida=1');
  assert.equal(consultas.length, 1);
  assert.match(consultas[0], /limit \?/);
  const plan = db.prepare('explain query plan ' + consultas[0]).all(24).map((p) => String(p.detail));
  // Recorre las filas de existencia_tienda (alias e) y busca cada pieza por su llave; nunca recorre productos (alias p).
  assert.ok(plan.some((d) => /^SCAN e\b/.test(d)), plan.join('\n'));
  assert.ok(plan.some((d) => /^SEARCH p USING INDEX sqlite_autoindex_productos_1 \(id=\?\)/.test(d)), plan.join('\n'));
  assert.ok(!plan.some((d) => /^SCAN p\b/.test(d)), `no debe recorrer productos:\n${plan.join('\n')}`);
});

test('#924: compartida pide tienda; otro valor, 400; un código exacto la ignora', async (t) => {
  const m = mundoCompartido(); t.after(() => m.db.close());
  const { pedir, S, K } = m;
  for (const q of ['compartida=1', 'compartida=0', 'compartida=true', 'compartida=', 'compartida=2&tienda=salk', 'compartida=1&tienda=foo', 'compartida=1&tienda=',
    `compartida=1&q=${S.codigo}`])
    assert.equal((await pedir(`/api/vender?${q}`)).status, 400, q);
  // El código exacto se encuentra aunque la pieza no sea compartida ni esté en esa tienda.
  assert.deepEqual(ids(await pedir(`/api/vender?q=${S.codigo}&tienda=salk&compartida=1`)), [S.id]);
  assert.deepEqual(ids(await pedir(`/api/vender?q=${K.codigo}&tienda=soledad&compartida=1`)), [K.id]);
});

test('#924: recomendados con compartida: solo lo vendido y lo de las categorías que está también en otra tienda', async (t) => {
  const m = mundoRecomendado(); t.after(() => m.db.close());
  const { db, pedir, A, B, C, C2 } = m;
  enSucursal(db, A.id, 'romero', 1);                              // A está en Salk y Romero
  db.prepare('update productos set stock = 1 where id = ?').run(C.id);   // C está en Salk y Soledad
  const r = await pedir('/api/vender?tienda=salk&orden=recomendado&compartida=1');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  // 1) vendidas y compartidas: A (B solo está en Salk); 2) ropa y juguetes: de ropa, C; C2 y los juguetes no se comparten.
  assert.deepEqual(ids(r), [A.id, C.id]);
  assert.deepEqual(r.cuerpo.piezas.map((p: any) => p.motivo), ['Aquí se vendieron 6 en 30 días', 'Ropa y calzado se vende bien aquí']);
  assert.ok(!ids(r).includes(B.id) && !ids(r).includes(C2.id));
  assert.deepEqual(ids(await pedir('/api/vender?tienda=salk&orden=recomendado&compartida=1&categoria=juguetes')), []);
  // Sin la casilla sigue como antes.
  assert.ok(ids(await pedir('/api/vender?tienda=salk&orden=recomendado')).includes(B.id));
});

/** Piezas con distinto ahorro en Salk, Soledad y Romero. */
function mundoLlamativo() {
  olvidarLlamativas();
  const t = tienda();
  const { db } = t;
  const dia = (n: number) => new Date(Date.parse('2026-11-10T00:00:00.000Z') + n * 60_000).toISOString();
  const limpio = { recorte_estado: 'listo', recorte_revision: 'ok' };
  const nueva = (nombre: string, precio: number, precio_lista: number, donde: ('soledad' | 'salk' | 'romero')[], n: number, extra: Record<string, unknown> = {}) => {
    const p = pieza(db, { nombre, precio, precio_lista, stock: donde.includes('soledad') ? 1 : 0, creado_en: dia(n), ...extra });
    for (const s of donde.filter((d) => d !== 'soledad')) enSucursal(db, p.id, s, 1, dia(n));
    return p;
  };
  const grande = nueva('Chamarra Nike', 10000, 133400, ['salk'], 1);                 // ahorra $1,234
  const gemela = nueva('Chamarra Nike', 20000, 80000, ['salk'], 2);                  // mismo nombre, ahorra $600: no se repite
  const sinRecorte = nueva('Bolsa Guess', 5000, 55000, ['salk', 'soledad'], 9);      // $500, la más nueva pero sin recorte
  const conRecorte = nueva('Reloj Casio', 5000, 55000, ['salk', 'romero'], 3, limpio);   // $500 con recorte, más vieja
  const conRecorteNueva = nueva('Lentes Ray', 5000, 55000, ['salk'], 8, limpio);     // $500 con recorte, más nueva: primero
  const hogar = nueva('Lámpara Ikea', 3000, 23000, ['salk', 'soledad'], 4, { categoria: 'hogar' });   // $200
  nueva('Sin descuento', 10000, 10000, ['salk'], 5);                                 // ahorra 0: no sale
  nueva('Lista menor', 10000, 9000, ['salk'], 6);                                    // ahorro negativo: no sale
  const deRomero = nueva('Tenis Adidas', 10000, 90000, ['romero'], 7);
  const deSoledad = nueva('Mochila Jansport', 10000, 70000, ['soledad'], 10);
  return { ...t, grande, gemela, sinRecorte, conRecorte, conRecorteNueva, hogar, deRomero, deSoledad, nueva };
}

test('#924: llamativos ordena por ahorro en pesos; empata con recorte limpio y luego lo más nuevo; sin repetir nombre ni ahorro ≤ 0', async (t) => {
  const m = mundoLlamativo(); t.after(() => m.db.close());
  const { pedir, grande, gemela, sinRecorte, conRecorte, conRecorteNueva, hogar } = m;
  const r = await pedir('/api/vender?tienda=salk&orden=llamativo');
  assert.equal(r.status, 200, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.siguiente, null);
  assert.deepEqual(ids(r), [grande.id, conRecorteNueva.id, conRecorte.id, sinRecorte.id, hogar.id]);
  assert.ok(!ids(r).includes(gemela.id));
  assert.deepEqual(r.cuerpo.piezas.map((p: any) => p.motivo), ['Ahorra $1,234', 'Ahorra $500', 'Ahorra $500', 'Ahorra $500', 'Ahorra $200']);
  // Misma forma de tarjeta que la lista: tiendas, foto (recorte solo si está aprobado), cola.
  assert.deepEqual(r.cuerpo.piezas[0].tiendas, ['Avenida Salk']);
  assert.equal(r.cuerpo.piezas[0].foto, `/api/foto/${grande.id}`);
  assert.equal(r.cuerpo.piezas[1].foto, `/api/recortes/${conRecorteNueva.id}/imagen`);
  assert.deepEqual(r.cuerpo.piezas[0].cola, []);
  // Categoría y tienda.
  assert.deepEqual(ids(await pedir('/api/vender?tienda=salk&orden=llamativo&categoria=hogar')), [hogar.id]);
  assert.deepEqual(ids(await pedir('/api/vender?tienda=romero&orden=llamativo')), [m.deRomero.id, conRecorte.id]);
  assert.deepEqual(ids(await pedir('/api/vender?tienda=soledad&orden=llamativo')), [m.deSoledad.id, sinRecorte.id, hogar.id]);
});

test('#924: llamativos con compartida: solo lo que también está en otra tienda', async (t) => {
  const m = mundoLlamativo(); t.after(() => m.db.close());
  const { pedir, sinRecorte, conRecorte, hogar } = m;
  assert.deepEqual(ids(await pedir('/api/vender?tienda=salk&orden=llamativo&compartida=1')), [conRecorte.id, sinRecorte.id, hogar.id]);
  assert.deepEqual(ids(await pedir('/api/vender?tienda=salk&orden=llamativo&compartida=1&categoria=hogar')), [hogar.id]);
  assert.deepEqual(ids(await pedir('/api/vender?tienda=soledad&orden=llamativo&compartida=1')), [sinRecorte.id, hogar.id]);
  assert.deepEqual(ids(await pedir('/api/vender?tienda=romero&orden=llamativo&compartida=1')), [conRecorte.id]);
  assert.deepEqual(ids(await pedir('/api/vender?tienda=romero&orden=llamativo&compartida=1&categoria=hogar')), []);
});

test('#924: llamativos guarda la lista una hora pero comprueba la existencia en cada carga', async (t) => {
  const m = mundoLlamativo(); t.after(() => m.db.close());
  const { db, env, pedir, grande, gemela, sinRecorte, conRecorteNueva, nueva } = m;
  const lecturas: string[] = [];
  const preparar = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (sql.includes('p.precio_lista > p.precio')) lecturas.push(sql); return preparar(sql); };
  assert.deepEqual(ids(await pedir('/api/vender?tienda=salk&orden=llamativo')).slice(0, 2), [grande.id, conRecorteNueva.id]);
  // Se vende la primera (queda sin unidades): sale en seguida y la gemela, de su mismo nombre, ocupa su lugar.
  db.prepare("update existencia_tienda set unidades = 0 where producto_id = ? and tienda = 'salk'").run(grande.id);
  const sin = ids(await pedir('/api/vender?tienda=salk&orden=llamativo'));
  assert.ok(!sin.includes(grande.id));
  assert.equal(sin[0], gemela.id);
  // Se mueve a otra tienda: deja de estar en Salk y de ser compartida con ella.
  db.prepare("update existencia_tienda set unidades = 0 where producto_id = ? and tienda = 'salk'").run(sinRecorte.id);
  assert.ok(!ids(await pedir('/api/vender?tienda=salk&orden=llamativo&compartida=1')).includes(sinRecorte.id));
  assert.ok(!ids(await pedir('/api/vender?tienda=salk&orden=llamativo')).includes(sinRecorte.id));
  assert.ok(!ids(await pedir('/api/vender?tienda=soledad&orden=llamativo&compartida=1')).includes(sinRecorte.id));
  // Se vende en Soledad (ya no hay stock): sale de Soledad. Cambia de precio: el motivo sale del precio de hoy.
  db.prepare('update productos set stock = 0 where id = ?').run(m.deSoledad.id);
  assert.ok(!ids(await pedir('/api/vender?tienda=soledad&orden=llamativo')).includes(m.deSoledad.id));
  db.prepare('update productos set precio = 10000 where id = ?').run(conRecorteNueva.id);   // ahora ahorra $450
  const r = await pedir('/api/vender?tienda=salk&orden=llamativo');
  assert.equal(r.cuerpo.piezas.find((p: any) => p.id === conRecorteNueva.id).motivo, 'Ahorra $450');
  // Una pieza que llega después no entra hasta que se recalcule la lista.
  const llegada = nueva('Reloj Nuevo', 1000, 99000, ['salk'], 20);
  assert.ok(!ids(await pedir('/api/vender?tienda=salk&orden=llamativo')).includes(llegada.id));
  assert.equal(lecturas.length, 1, 'una sola lectura de productos en todas las cargas');
  olvidarLlamativas();
  assert.equal(ids(await pedir('/api/vender?tienda=salk&orden=llamativo'))[0], llegada.id);
  assert.equal(lecturas.length, 2);
});

test('#924: llamativos entrega hasta 24 sin paginar', async (t) => {
  olvidarLlamativas();
  const { db, pedir } = tienda(); t.after(() => db.close());
  for (let n = 0; n < 30; n++) pieza(db, { nombre: `Pieza ${'abcdefghijklmnopqrstuvwxyzñáéíóú'[n]}`, precio: 10000, precio_lista: 20000 + n * 100 });
  const r = (await pedir('/api/vender?tienda=soledad&orden=llamativo')).cuerpo;
  assert.equal(r.piezas.length, 24);
  assert.equal(r.siguiente, null);
  const ahorros = r.piezas.map((p: any) => p.precio_lista - p.precio);
  assert.deepEqual(ahorros, [...ahorros].sort((a, b) => b - a));
});

test('#924: llamativos exige tienda y rechaza q, hoy y cursor; la revendedora no ve ni compartida ni llamativos', async (t) => {
  const m = mundoLlamativo(); t.after(() => m.db.close());
  for (const q of ['orden=llamativo', 'orden=llamativo&tienda=foo', 'orden=llamativo&tienda=salk&q=bolsa', 'orden=llamativo&tienda=salk&hoy=1',
    'orden=llamativo&tienda=salk&cursor=2026-11-01~3', 'orden=Llamativo&tienda=salk', 'orden=llamativos&tienda=salk', 'orden=llamativo&tienda=salk&categoria=nada',
    'orden=llamativo&tienda=salk&compartida=2'])
    assert.equal((await m.pedir(`/api/vender?${q}`)).status, 400, q);
  comoRevendedora(m);
  for (const q of ['tienda=salk&orden=llamativo', 'orden=llamativo', 'tienda=salk&compartida=1', 'compartida=1', 'tienda=foo&orden=llamativo'])
    assert.equal((await m.pedir(`/api/vender?${q}`)).status, 403, q);
  assert.equal((await m.pedir('/api/vender')).status, 200);
});

test('#924: el título dice llamativos y «también en otra tienda»', () => {
  assert.equal(tituloLista({ orden: 'llamativo', tienda: 'Avenida Salk' }), 'Llamativos en Avenida Salk');
  assert.equal(tituloLista({ orden: 'llamativo', tienda: 'Avenida Salk', categoria: 'Juguetes' }), 'Llamativos en Avenida Salk · Juguetes');
  assert.equal(tituloLista({ orden: 'llamativo', tienda: 'Avenida Salk', compartida: true }), 'Llamativos en Avenida Salk · también en otra tienda');
  assert.equal(tituloLista({ tienda: 'Avenida Salk', compartida: true }), 'Lo nuevo en Avenida Salk · también en otra tienda');
  assert.equal(tituloLista({ tienda: 'Soledad', categoria: 'Juguetes', compartida: true }), 'Juguetes en Soledad · también en otra tienda');
  assert.equal(tituloLista({ orden: 'recomendado', tienda: 'Coronel Romero', categoria: 'Ropa y calzado', compartida: true }),
    'Recomendados para Coronel Romero · Ropa y calzado · también en otra tienda');
  assert.equal(tituloLista({ tienda: 'Soledad', q: 'blusa', compartida: true }), 'Resultados de «blusa» en Soledad · también en otra tienda');
  assert.equal(tituloLista({ hoy: true, tienda: 'Soledad', compartida: true }), 'Ingresadas hoy en Soledad · también en otra tienda');
  // Sin la casilla, los títulos de #882 no cambian.
  assert.equal(tituloLista({ orden: 'recomendado', tienda: 'Avenida Salk' }), 'Recomendados para Avenida Salk');
  assert.equal(tituloLista({ compartida: false, tienda: 'Soledad' }), 'Lo nuevo en Soledad');
});

test('#924: tres botones de orden con aria-pressed y la casilla «también en otra tienda», solo del personal y sin guardarse', () => {
  const html = readFileSync('public/vender.html', 'utf8').replace(/\r\n/g, '\n');
  assert.match(html, /<div class="ordenes"><button id="orden-nuevo" type="button" aria-pressed="true">Lo nuevo<\/button><button id="orden-recomendado" type="button" aria-pressed="false">Recomendados<\/button><button id="orden-llamativo" type="button" aria-pressed="false">Llamativos<\/button><\/div>/);
  assert.match(html, /<label class="check"><input id="vista-compartida" type="checkbox"><span>Solo lo que también hay en otra tienda<\/span><\/label>/);
  // La casilla está dentro de la barra del personal (que nace oculta) y la letra de los botones no se achica.
  const barra = html.match(/<section id="vista-tienda"[\s\S]*?<\/section>/)![0];
  assert.ok(barra.includes('id="vista-compartida"') && barra.includes('id="orden-llamativo"'));
  assert.ok(!/\.ordenes[^}]*font-size/.test(html), 'los botones de orden conservan los 18 px de todo botón');
  const modo = html.match(/function modoRevendedora\(\) \{[\s\S]*?\n\}\n/)![0];
  assert.ok(!/vista-compartida|orden-llamativo/.test(modo));
  // La casilla va a la consulta solo con tienda y sin código exacto; con «Todas las tiendas» se desmarca y se deshabilita.
  assert.match(html, /function consultaDePersonal\(\) \{[\s\S]*?!porCodigo && \$\('vista-tienda-sel'\)\.value && \$\('vista-compartida'\)\.checked\) params\.set\('compartida', '1'\)[\s\S]*?params\.set\('orden', 'llamativo'\)/);
  assert.match(html, /\$\('vista-compartida'\)\.disabled = !hayTienda;\s*if \(!hayTienda\) \$\('vista-compartida'\)\.checked = false;/);
  // Buscar por nombre regresa a «Lo nuevo» y vuelve a leer la tienda, la categoría y la casilla de los controles.
  assert.match(html, /orden = 'nuevo';\s*pintarControles\(\);\s*consulta = consultaDePersonal\(\);/);
  // Los vacíos: con la casilla, el texto del Issue y el botón que la desmarca.
  assert.match(html, /`No hay piezas de \$\{tienda\} que también estén en otra tienda\.`/);
  assert.match(html, /textContent = `Ver todo lo de \$\{tienda\}`/);
  assert.match(html, /\$\('ver-todo-tienda'\)\.addEventListener\('click', \(\) => \{ \$\('vista-compartida'\)\.checked = false; cambiarVista\(\); \}\);/);
  assert.match(html, /Todavía no hay llamativos para \$\{tienda\}/);
  // Nada de esto va a localStorage.
  for (const memoria of html.matchAll(/localStorage\.\w+\([^)]*\)/g)) assert.ok(!/vista-compartida|llamativo/.test(memoria[0]), memoria[0]);
});
