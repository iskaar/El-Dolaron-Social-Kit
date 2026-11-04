// node --test src/upc-tallas.test.ts
// #709: un mismo código de barras con varias tallas (ropa y calzado). La identidad de una pieza es
// propietario + UPC + grado + talla; sin talla es su propio grupo.
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { registroFoto, formularioPendiente } from '../public/foto-pendiente.js';
import { crearCaptura, admiteOtraTalla, faltaCalzado } from '../public/inventario-capturar.js';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';

const UPC = '0191907910421';
type Tienda = ReturnType<typeof tienda>;
function montar() {
  const t = tienda();
  t.db.prepare(`insert into manifiesto(upc,descripcion,departamento,nombre,precio_usd,tcin,actualizado_en)
    values('191907910421',?,'SHOES','Tenis de mujer',2000,'','')`).run('Women Running Shoes');
  t.db.prepare("insert or replace into config(clave,valor) values('tipo_cambio','2000'),('pct_otros','50'),('pct_ropa','50')").run();
  return t;
}
const alta = (extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), upc: UPC, stock: 1, estado_fisico: 'nuevo', ...extra });
const piezas = (t: Tienda) => t.db.prepare("select id, talla, stock, codigo from productos where ltrim(upc,'0')='191907910421' order by rowid").all() as any[];
const inserta = (t: Tienda, extra: Record<string, unknown> = {}) => {
  const p = { id: crypto.randomUUID(), nombre: 'Tenis', codigo: null, stock: 3, precio: 9900, precio_lista: 19900, destino: 'etiqueta', estado_analisis: 'listo', propietario: 'dolaron',
    estado_fisico: 'nuevo', upc: UPC, talla: null, semana_ingreso: 'S43', creado_en: new Date().toISOString(), actualizado_en: '', ...extra };
  t.db.prepare(`insert into productos (${Object.keys(p).join(',')}) values (${Object.keys(p).map(() => '?').join(',')})`).run(...Object.values(p) as never[]);
  return p;
};
const subirFoto = async (t: Tienda, extra: Record<string, unknown>) => {
  const id = crypto.randomUUID();
  const f = formularioPendiente(registroFoto(new Blob(['foto'], { type: 'image/jpeg' }), { id, upc: UPC, cantidad: 1, estado_fisico: 'nuevo', ...extra }));
  const r = await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: f }) as never, t.env, t.ctx as never);
  return { id, estado: r.status, cuerpo: await r.json() as any };
};

test('mismo UPC con talla 26 y 27 son dos piezas con su ED-; cada suma va a la suya; la misma talla suma', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const a = alta({ talla: '26' }), b = alta({ talla: '27' });
  const ra = await t.pedir('/api/borradores/upc', a), rb = await t.pedir('/api/borradores/upc', b);
  assert.deepEqual([ra.status, rb.status], [201, 201]);
  assert.notEqual(ra.cuerpo.id, rb.cuerpo.id);
  assert.notEqual(ra.cuerpo.codigo, rb.cuerpo.codigo);
  assert.deepEqual([ra.cuerpo.talla, rb.cuerpo.talla], ['26', '27']);
  assert.equal(piezas(t).length, 2);
  const suma26 = await t.pedir('/api/borradores/upc', alta({ talla: '26', stock: 2 }));
  assert.deepEqual([suma26.cuerpo.id, suma26.cuerpo.existente, suma26.cuerpo.stock], [a.id, true, 3]);
  const suma27 = await t.pedir('/api/borradores/upc', alta({ talla: '27' }));
  assert.deepEqual([suma27.cuerpo.id, suma27.cuerpo.stock], [b.id, 2]);
  assert.deepEqual(piezas(t).map((p) => [p.talla, p.stock]), [['26', 3], ['27', 2]]);
  // Sin talla es su propio grupo: no se suma a ninguna talla.
  const sin = await t.pedir('/api/borradores/upc', alta());
  assert.equal(sin.status, 201);
  assert.ok(![a.id, b.id].includes(sin.cuerpo.id));
  const sinOtra = await t.pedir('/api/borradores/upc', alta());
  assert.equal(sinOtra.cuerpo.id, sin.cuerpo.id, 'sin talla suma a la pieza sin talla');
  assert.equal(piezas(t).length, 3);
});

test('la foto con UPC y una talla nueva crea una pieza; con la misma talla no duplica', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const a = await subirFoto(t, { talla: '26' }), b = await subirFoto(t, { talla: '27' }), otra26 = await subirFoto(t, { talla: '26' });
  assert.deepEqual([a.estado, b.estado, otra26.estado], [201, 201, 201]);
  assert.notEqual(b.cuerpo.id, a.cuerpo.id);
  assert.equal(otra26.cuerpo.id, a.cuerpo.id, 'la misma talla suma a la existente');
  assert.deepEqual(piezas(t).map((p) => [p.talla, p.stock]), [['26', 2], ['27', 1]]);
});

test('foto con UPC fuera del manifiesto y de lo ya fotografiado: la talla nueva tampoco se suma a otra talla', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  t.db.prepare('delete from manifiesto').run();
  const primera = inserta(t, { talla: '26', foto_key: '' });
  const nueva = await subirFoto(t, { talla: '27' });
  assert.equal(nueva.estado, 201, JSON.stringify(nueva.cuerpo));
  assert.deepEqual(piezas(t).map((p) => [p.talla, p.stock]), [['26', 3], ['27', 1]]);
  assert.equal(piezas(t).find((p) => p.id === primera.id)!.stock, 3);
});

test('cambiar la talla a una que ya existe con el mismo UPC y grado es conflicto; a otra libre, no', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const a = inserta(t, { talla: '26', codigo: 'ED-000100' }), b = inserta(t, { talla: '27' });
  const choque = await t.pedir(`/api/borradores/${b.id}`, { talla: '26' }, 'PATCH');
  assert.equal(choque.status, 409, JSON.stringify(choque.cuerpo));
  assert.equal(choque.cuerpo.existente.id, a.id);
  assert.equal(choque.cuerpo.existente.talla, '26');
  assert.equal(t.db.prepare('select talla from productos where id=?').get(b.id)!.talla, '27');
  assert.equal((await t.pedir(`/api/borradores/${b.id}`, { talla: '28' }, 'PATCH')).status, 200);
  assert.equal(t.db.prepare('select talla from productos where id=?').get(b.id)!.talla, '28');
  // Otro grado no choca.
  const c = inserta(t, { talla: '28', estado_fisico: 'danado' });
  assert.equal((await t.pedir(`/api/borradores/${c.id}`, { talla: '26' }, 'PATCH')).status, 200);
});

test('PATCH /talla de la captura (revisión del celular) también respeta la identidad con talla', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  const a = (await subirFoto(t, { talla: '26' })).id;
  t.db.prepare("update productos set talla = '27' where id = ?").run(a);
  const b = (await subirFoto(t, { talla: '26' })).id;
  assert.notEqual(a, b);
  const choque = await t.pedir(`/api/borradores/${b}/talla`, { talla: '27' }, 'PATCH');
  assert.equal(choque.status, 409, JSON.stringify(choque.cuerpo));
  assert.equal(t.db.prepare('select talla from productos where id=?').get(b)!.talla, '26');
  assert.equal((await t.pedir(`/api/borradores/${b}/talla`, { talla: '28' }, 'PATCH')).status, 200);
});

test('Repetidas no junta tallas distintas; dos piezas de la misma talla sí; juntar y fusionar exigen la misma talla', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  inserta(t, { talla: '26', codigo: 'ED-000100' }); inserta(t, { talla: '27', codigo: 'ED-000101' }); inserta(t);
  const sinRepetidas = await t.pedir('/api/piezas/repetidas');
  assert.equal(sinRepetidas.status, 200);
  assert.deepEqual(sinRepetidas.cuerpo.grupos, [], 'una pieza por talla y una sin talla no son repetidas');
  const vieja = inserta(t, { talla: '27', codigo: 'ED-000050' });
  const r = await t.pedir('/api/piezas/repetidas');
  assert.equal(r.cuerpo.grupos.length, 1);
  const g = r.cuerpo.grupos[0];
  assert.deepEqual([g.talla, g.destino_id, g.piezas.length], ['27', vieja.id, 2]);
  assert.ok(g.piezas.every((p: any) => p.talla === '27'));
  // Juntar piezas etiquetadas de otra talla: rechazado y sin mover existencias.
  const veintiseis = t.db.prepare("select id from productos where talla = '26'").get()!.id as string;
  const j = await t.pedir(`/api/piezas/${veintiseis}/juntar`, { id: crypto.randomUUID(), destino_id: vieja.id });
  assert.equal(j.status, 409);
  assert.match(j.cuerpo.error, /talla/);
  assert.equal(t.db.prepare('select stock from productos where id = ?').get(veintiseis)!.stock, 3);
  // Misma talla: sí junta.
  const hermana = t.db.prepare("select id from productos where talla = '27' and id <> ? and codigo = 'ED-000101'").get(vieja.id)!.id as string;
  assert.equal((await t.pedir(`/api/piezas/${hermana}/juntar`, { id: crypto.randomUUID(), destino_id: vieja.id })).status, 200);
  // Fusionar un borrador sin etiqueta con una original de otra talla: rechazado.
  const borrador = inserta(t, { talla: '28' });
  const f = await t.pedir(`/api/borradores/${borrador.id}/fusionar`, { destino_id: vieja.id });
  assert.equal(f.status, 409);
  assert.equal(t.db.prepare('select count(*) n from productos where id = ?').get(borrador.id)!.n, 1);
});

test('conflicto de grado en una pieza con talla solo mira su propia talla', async (t0) => {
  const t = montar(); t0.after(async () => { await t.esperar(); t.db.close(); });
  inserta(t, { talla: '26', estado_fisico: 'danado' });
  const b = inserta(t, { talla: '27' });
  const ok = await t.pedir(`/api/borradores/${b.id}`, { estado_fisico: 'danado' }, 'PATCH');
  assert.equal(ok.status, 200, JSON.stringify(ok.cuerpo));
  const c = inserta(t, { talla: '26' });
  assert.equal((await t.pedir(`/api/borradores/${c.id}`, { estado_fisico: 'danado' }, 'PATCH')).status, 409);
});

test('captura del cliente: «Otra talla» abre una pieza nueva con el mismo UPC y pide la talla antes de guardar', async () => {
  const llamadas: [string, any][] = [];
  const existente = { id: 'e1', upc: UPC, nombre: 'Tenis de mujer', talla: '26', estado_fisico: 'nuevo', categoria: 'ropa', stock: 2, estado_analisis: 'listo', codigo: 'ED-000100' };
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async () => true, uuid: () => 'nueva-1', api: async (ruta: string, cuerpo?: any) => {
    llamadas.push([ruta, cuerpo]);
    if (ruta.startsWith('/api/piezas/resolver')) return { piezas: [existente], siguiente: null };
    if (ruta.startsWith('/api/manifiesto/')) return { upc: '191907910421', nombre: 'Tenis de mujer', categoria: 'ropa', calzado: true, precio: 20000, precios: { nuevo: 20000 }, precio_lista: 40000 };
    return { id: cuerpo.id, estado_analisis: 'listo', codigo: 'ED-000101', talla: cuerpo.talla };
  } });
  await flujo.leer(UPC);
  assert.equal(flujo.actual().tipo, 'existente');
  assert.ok(admiteOtraTalla(flujo.actual().pieza));
  await flujo.otraTalla(flujo.actual().pieza);
  const a = flujo.actual();
  assert.deepEqual([a.tipo, a.id, a.upc, a.otraTalla], ['nueva', 'nueva-1', UPC, true]);
  assert.equal(faltaCalzado(a), 'Falta número de calzado', 'calzado: pide el número de la caja');
  await assert.rejects(flujo.guardar(), /número del calzado/);
  a.talla = '27';
  await flujo.guardar();
  const [ruta, cuerpo] = llamadas.at(-1)!;
  assert.equal(ruta, '/api/borradores/upc');
  assert.deepEqual([cuerpo.id, cuerpo.upc, cuerpo.talla], ['nueva-1', UPC, '27']);
});

test('captura del cliente: ropa pide talla de ropa; una pieza sin código de barras ni talla no ofrece «Otra talla»', async () => {
  const ropa = { id: 'r1', upc: '012345678905', nombre: 'Playera', talla: 'M', categoria: 'ropa', estado_fisico: 'nuevo', stock: 1, estado_analisis: 'listo' };
  const flujo = crearCaptura({ enLinea: () => true, imprimir: async () => true, uuid: () => 'n2', api: async (ruta: string) => {
    if (ruta.startsWith('/api/manifiesto/')) return { nombre: 'Playera', categoria: 'ropa', precio: 12000, precio_lista: 24000 };
    throw new Error('sin llamada ' + ruta);
  } });
  await flujo.otraTalla(ropa);
  assert.equal(flujo.actual().ficha.calzado, false);
  assert.equal(faltaCalzado(flujo.actual()), 'Falta talla');
  flujo.actual().talla = 'L';
  assert.equal(faltaCalzado(flujo.actual()), '');
  assert.equal(admiteOtraTalla({ id: 'x', upc: UPC, nombre: 'Lámpara', categoria: 'hogar', talla: null }), false);
  assert.equal(admiteOtraTalla({ id: 'x', upc: null, nombre: 'Playera', categoria: 'ropa', talla: 'M' }), false);
});

test('la pantalla de captura ofrece «Otra talla» en la tarjeta de una pieza existente y en la lista de tallas del mismo código', () => {
  // Sin DOM en las pruebas: se comprueba que los dos botones existen y llaman al flujo.
  const fuente = readFileSync('public/inventario-capturar.js', 'utf8');
  assert.equal(fuente.match(/boton\('Otra talla',\(\)=>flujo\.otraTalla\(/g)?.length, 2);
  assert.match(fuente, /Existencia \$\{p\.stock\}\$\{p\.talla\?/, 'la tarjeta muestra la talla de la pieza');
});
