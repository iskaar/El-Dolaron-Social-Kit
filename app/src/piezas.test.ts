import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tienda, DUENO } from './prueba-d1.ts';
import { permiso, puede, type Rol } from './cuentas.ts';
import { permitidaParaVendedor } from './worker.ts';

function pieza(db: ReturnType<typeof tienda>['db'], cambios: Record<string, unknown> = {}) {
  const p = { id: crypto.randomUUID(), codigo: null, nombre: 'Chamarra', marca: 'Levis', stock: 1,
    propietario: 'dolaron', estado_analisis: 'listo', creado_en: '2026-10-01T12:00:00.000Z',
    actualizado_en: '2026-10-01T12:00:00.000Z', semana_ingreso: 'S40', precio: 45000, ...cambios };
  const claves = Object.keys(p);
  db.prepare(`insert into productos (${claves.join(',')}) values (${claves.map(() => '?').join(',')})`).run(...Object.values(p) as never[]);
  return p;
}

function registrarConsultas(env: Env, db: ReturnType<typeof tienda>['db']) {
  const consultas: { sql: string; args: unknown[]; filas: number }[] = [];
  const preparar = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (!sql.includes('from productos p')) return preparar(sql);
    let args: unknown[] = [];
    const original = preparar(sql);
    const s = {
      bind(...valores: unknown[]) { args = valores; original.bind(...valores as never[]); return s; },
      async all() {
        const r = await original.all(); consultas.push({ sql, args, filas: r.results.length }); return r;
      },
      async first() {
        const r = await original.first(); consultas.push({ sql, args, filas: r ? 1 : 0 }); return r;
      },
    };
    return s as D1PreparedStatement;
  };
  return {
    consultas,
    planes() {
      for (const { sql, args } of consultas) {
        const plan = db.prepare('explain query plan ' + sql).all(...args as never[]);
        assert.ok(!plan.some((p) => /SCAN|TEMP B-TREE/.test(String(p.detail))), JSON.stringify(plan));
        assert.ok(plan.some((p) => /SEARCH p USING/.test(String(p.detail))), JSON.stringify(plan));
      }
    },
  };
}

test('normaliza código y UPC con ceros; búsqueda por palabras en nombre y marca', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const p = pieza(db, { codigo: 'ED-002318', nombre: 'Chamarra <azul>', stock: 0 });
  const upc = pieza(db, { upc: '000123456789', nombre: 'Ventilador', propietario: 'dolaron' });
  const corto = pieza(db, { upc: '000654321', nombre: 'Ventilador' });
  const registro = registrarConsultas(env, db);
  for (const q of ['2318', 'ed2318', 'ED-2318', 'ED-002318', '  ed002318  ']) {
    const r = await pedir('/api/piezas?' + new URLSearchParams({ q }));
    assert.equal(r.status, 200); assert.equal(r.cuerpo.piezas[0].id, p.id);
    assert.equal(r.cuerpo.piezas[0].stock, 0); assert.equal(r.cuerpo.siguiente, null);
  }
  for (const q of ['000123456789', '123456789', '00000123456789'])
    assert.equal((await pedir(`/api/piezas?q=${q}`)).cuerpo.piezas[0].id, upc.id);
  assert.equal((await pedir('/api/piezas?q=654321')).cuerpo.piezas[0].id, corto.id);
  for (const q of ['azul levis', 'Levis chamarra', '<azul>']) {
    const r = await pedir('/api/piezas?' + new URLSearchParams({ q }));
    assert.equal(r.cuerpo.piezas.length, 1); assert.equal(r.cuerpo.piezas[0].id, p.id);
    assert.equal(r.cuerpo.piezas[0].nombre, 'Chamarra <azul>');
    assert.ok(!('fila' in r.cuerpo.piezas[0])); assert.ok(!('elegible' in r.cuerpo.piezas[0]));
  }
  assert.equal((await pedir('/api/piezas?q=%25_azul')).cuerpo.piezas.length, 0);
  registro.planes();
  assert.ok(registro.consultas.some((c) => c.sql.includes('productos_propietario_creado')));
  assert.ok(registro.consultas.some((c) => c.sql.includes('productos_upc')));
});

test('3000 filas: el cursor avanza sin coincidencias y encuentra la más vieja; tope 1000 por petición', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  db.exec('delete from productos');
  const vieja = pieza(db, { nombre: 'Tesoro antiguo', stock: 0 });
  // Misma fecha: el rowid debe desempatar sin saltar ni repetir piezas.
  for (let i = 1; i < 3000; i++) pieza(db, { nombre: 'Otra pieza' });
  const registro = registrarConsultas(env, db);
  let cursor: string | null = null;
  const encontradas: string[] = [];
  let peticiones = 0;
  do {
    registro.consultas.length = 0;
    const r = await pedir('/api/piezas?' + new URLSearchParams({ q: 'Tesoro', ...(cursor ? { cursor } : {}) }));
    assert.equal(r.status, 200); assert.ok(r.cuerpo.piezas.length <= 25);
    assert.ok(registro.consultas.reduce((n, c) => n + c.filas, 0) <= 1000);
    assert.ok(registro.consultas.length <= 10); // Un seek separado resuelve cada empate de fecha.
    for (const c of registro.consultas) {
      assert.ok(!/count\(|offset\s/i.test(c.sql)); assert.ok(Number(c.args.at(-1)) <= 200);
    }
    registro.planes();
    encontradas.push(...r.cuerpo.piezas.map((p: any) => p.id));
    assert.notEqual(r.cuerpo.siguiente, cursor || 'imposible');
    cursor = r.cuerpo.siguiente;
    assert.ok(++peticiones <= 4);
  } while (cursor);
  assert.deepEqual(encontradas, [vieja.id]); assert.equal(peticiones, 4);
});

test('25 por página sin perder coincidencias dentro de un tramo; excluye descartadas y bandas', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  db.exec('delete from productos');
  const ids = Array.from({ length: 61 }, () => pieza(db).id).reverse();
  const descartada = pieza(db, { estado_analisis: 'descartado', codigo: 'ED-007777' });
  const banda = pieza(db, { sin_inventario: 1 });
  let cursor: string | null = null;
  const leidas: string[] = [];
  do {
    const r = await pedir('/api/piezas?' + new URLSearchParams({ q: 'chamarra', ...(cursor ? { cursor } : {}) }));
    assert.ok(r.cuerpo.piezas.length <= 25);
    leidas.push(...r.cuerpo.piezas.map((p: any) => p.id)); cursor = r.cuerpo.siguiente;
  } while (cursor);
  assert.deepEqual(leidas, ids);
  for (const p of [descartada, banda]) assert.equal((await pedir(`/api/piezas/${p.id}`)).status, 404);
  assert.deepEqual((await pedir('/api/piezas?q=7777')).cuerpo.piezas, []);
});

test('FEP y dueño aislados en lista, código, UPC, ficha e historial; capturista consulta y cajero recibe 403', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const propia = pieza(db, { codigo: 'ED-008888', upc: '001234567890' });
  const ajena = pieza(db, { propietario: 'fep', codigo: 'ED-009999', upc: '001234567890' });
  for (const [correo, rol] of [['cap@prueba.mx', 'capturista'], ['fep@prueba.mx', 'finanzas'], ['caja@prueba.mx', 'cajero']])
    db.prepare("insert into usuarios (correo,nombre,roles,activo,creado_en,actualizado_en) values (?, 'Prueba', ?, 1, '', '')").run(correo, rol);
  for (const [correo, visible, oculta] of [[DUENO, propia, ajena], ['cap@prueba.mx', propia, ajena], ['fep@prueba.mx', ajena, propia]] as const) {
    env.DEV_USUARIO = correo;
    for (const q of ['chamarra', '001234567890', String(visible.codigo)]) {
      const r = await pedir('/api/piezas?' + new URLSearchParams({ q }));
      assert.equal(r.status, 200); assert.deepEqual(r.cuerpo.piezas.map((p: any) => p.id), [visible.id]);
    }
    assert.deepEqual((await pedir(`/api/piezas?q=${oculta.codigo}`)).cuerpo.piezas, []);
    assert.equal((await pedir(`/api/piezas/${visible.id}`)).status, 200);
    assert.equal((await pedir(`/api/piezas/${oculta.id}`)).status, 404);
  }
  env.DEV_USUARIO = 'caja@prueba.mx';
  for (const ruta of ['/api/piezas', `/api/piezas/${propia.id}`]) assert.equal((await pedir(ruta)).status, 403);
  for (const ruta of ['/pieza', '/pieza.html', '/pieza/', '/api/piezas', `/api/piezas/${propia.id}`]) {
    for (const rol of ['dueno', 'capturista', 'finanzas', 'cajero'] as Rol[])
      assert.equal(puede({ correo: '', nombre: '', caja: '', activo: true, roles: [rol] }, permiso(ruta, 'GET')), rol !== 'cajero');
    assert.equal(permitidaParaVendedor(ruta, 'GET'), false);
  }
  env.DEV_USUARIO = DUENO;
  env.HOST_VENDEDOR = 'caja.prueba'; assert.equal((await pedir('/api/piezas')).status, 404);
  env.HOST_VENDEDOR = ''; env.HOST_PORTAL = 'caja.prueba'; assert.equal((await pedir('/api/piezas')).status, 404);
});

test('ficha trae los últimos diez ajustes en orden estable; validación y métodos sin escrituras', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  const p = pieza(db, { foto_key: 'fotos/prueba.jpg' });
  for (let i = 0; i < 12; i++) db.prepare(`insert into conteo_ajustes
    (id,producto_id,motivo,cantidad,antes,despues,ajustado_por,ajustado_en) values (?,?,'merma',1,3,2,?,?)`)
    .run(String(i), p.id, DUENO, '2026-10-22T12:00:00.000Z');
  const r = await pedir(`/api/piezas/${p.id}`);
  assert.equal(r.cuerpo.pieza.tiene_foto, 1);
  assert.deepEqual(r.cuerpo.historial.map((a: any) => a.id), ['11','10','9','8','7','6','5','4','3','2']);
  assert.equal((await pedir(`/api/piezas/${crypto.randomUUID()}`)).status, 404);
  assert.equal((await pedir('/api/piezas/foo')).status, 400);
  for (const filtro of ['q=', 'q=ab', `q=${'x'.repeat(81)}`, 'cursor=foo', 'cursor=2026-10-01~0', 'q=123456789&cursor=123~5'])
    assert.equal((await pedir('/api/piezas?' + filtro)).status, 400);
  for (const ruta of ['/api/piezas', `/api/piezas/${p.id}`])
    for (const metodo of ['POST', 'PATCH', 'DELETE']) assert.equal((await pedir(ruta, {}, metodo)).status, 405);
  assert.equal(db.prepare('select stock from productos where id = ?').get(p.id)!.stock, 1);
});

test('UPC repetido: el límite cuenta también piezas ajenas y pagina sin saltar duplicados', async (t) => {
  const { db, env, pedir } = tienda(); t.after(() => db.close());
  const propia = pieza(db, { upc: '00123456' });
  for (let i = 0; i < 1500; i++) pieza(db, { upc: '00123456', propietario: 'fep' });
  const registro = registrarConsultas(env, db);
  const primera = (await pedir('/api/piezas?q=123456')).cuerpo;
  assert.deepEqual(primera.piezas, []); assert.ok(primera.siguiente);
  assert.ok(registro.consultas.reduce((n, c) => n + c.filas, 0) <= 1000);
  const segunda = (await pedir('/api/piezas?' + new URLSearchParams({ q: '123456', cursor: primera.siguiente }))).cuerpo;
  assert.deepEqual(segunda.piezas.map((p: any) => p.id), [propia.id]);
  registro.planes();
});

test('completar la página al terminar un empate conserva el cursor hacia fechas anteriores', async (t) => {
  const { db, pedir } = tienda(); t.after(() => db.close());
  db.exec('delete from productos');
  const vieja = pieza(db, { nombre: 'Tesoro', creado_en: '2026-09-01T00:00:00.000Z' });
  for (let i = 0; i < 215; i++) pieza(db, { nombre: i < 25 ? 'Tesoro' : 'Otra pieza' });
  const primera = (await pedir('/api/piezas?q=tesoro')).cuerpo;
  assert.equal(primera.piezas.length, 25); assert.ok(primera.siguiente);
  const segunda = (await pedir('/api/piezas?' + new URLSearchParams({ q: 'tesoro', cursor: primera.siguiente }))).cuerpo;
  assert.deepEqual(segunda.piezas.map((p: any) => p.id), [vieja.id]);
});

function pantalla(responder: (url: string, cuerpo?: any) => unknown | Promise<unknown>, confirmar = () => true) {
  class Nodo {
    value = ''; textContent = ''; hidden = false; disabled = false; className = ''; dataset: Record<string, string> = {};
    children: Nodo[] = []; eventos: Record<string, Function> = {}; atributos: Record<string, string> = {};
    clases = new Set<string>(); classList = { add: (c: string) => this.clases.add(c), remove: (c: string) => this.clases.delete(c) };
    tag: string;
    constructor(tag = 'div') { this.tag = tag; }
    set innerHTML(_s: string) { throw new Error('No se permiten datos como HTML'); }
    append(...n: Nodo[]) { this.children.push(...n); }
    replaceChildren() { this.children = []; }
    addEventListener(e: string, fn: Function) { this.eventos[e] = fn; }
    setAttribute(k: string, v: string) { this.atributos[k] = v; }
    matches() { return this.tag === 'input'; }
    focus() { enfocado = this; }
    select() {}
  }
  let enfocado: Nodo;
  const nodos = new Map<string, Nodo>();
  const $ = (id: string) => {
    if (!nodos.has(id)) nodos.set(id, new Nodo(id === 'consulta' ? 'input' : 'div'));
    return nodos.get(id)!;
  };
  const eventos: Record<string, Function> = {};
  const llamadas: string[] = [];
  let camaras = 0, apagadas = 0, alLeer: (s: string) => void = () => {};
  const temporizadores: { fn: Function; ms: number }[] = [];
  const fuente = readFileSync('public/pieza.js', 'utf8').replace(/^import .+;$/gm, '');
  const api = runInNewContext(`${fuente}; ({buscar, abrir})`, {
    document: { getElementById: $, createElement: (tag: string) => new Nodo(tag),
      querySelectorAll: () => $('resultados').children.map((li) => li.children[0]),
      addEventListener: (e: string, fn: Function) => { eventos[e] = fn; }, body: new Nodo() },
    CATEGORIAS: [['ropa', 'Ropa']], nombreEstado: () => 'A · Nuevo',
    matchMedia: () => ({ matches: true }), AbortSignal, crypto, confirm:confirmar,
    setTimeout: (fn: Function, ms: number) => { temporizadores.push({ fn, ms }); return temporizadores.length; }, clearTimeout: () => {},
    abrirCamara: async (_id: string, fn: (s: string) => void) => { camaras++; alLeer = fn; return async () => { apagadas++; }; },
    fetch: async (url: string, opciones: RequestInit) => {
      llamadas.push(url);
      const datos = await responder(url, opciones.body ? JSON.parse(String(opciones.body)) : undefined);
      return { ok: !datos?.error, status: datos?.status ?? 200, json: () => datos };
    },
  });
  return { $, api, eventos, llamadas, temporizadores, enfocado: () => enfocado, camaras: () => camaras, apagadas: () => apagadas, escanear: (s: string) => alLeer(s) };
}

test('pantalla: texto seguro, Buscar más tras tramo vacío, lector y cámara consultan sin escribir', async () => {
  const p = { id: 'pieza', codigo: 'ED-002318', nombre: '<img src=x onerror=alert(1)> & algodón',
    marca: 'Levis', talla: 'M', categoria: 'ropa', precio: 12345, precio_lista: 20000, stock: 0, tiene_foto: 0 };
  const ui = pantalla((url) => url.startsWith('/api/piezas/') ? { pieza: p, historial: [{ antes: 1, despues: 0,
    motivo: '<script>', ajustado_por: 'Isaac', ajustado_en: '2026-10-22T12:00:00Z' }] }
    : url.includes('cursor=') ? { piezas: [p], siguiente: null } : { piezas: [], siguiente: '2026-10-01~2' });
  const { $, api } = ui;
  assert.equal(ui.enfocado(), $('consulta')); assert.equal(ui.camaras(), 0);
  $('consulta').value = 'chamarra'; await api.buscar();
  assert.equal($('mas').hidden, false); assert.match($('estado').textContent, /Buscar más/);
  await api.buscar(true); assert.equal($('resultados').children.length, 1);
  assert.equal($('resultados').children[0].children[0].children[1].children[0].textContent, p.nombre);
  await api.abrir(p.id); assert.equal($('nombre').textContent, p.nombre); assert.equal($('stock').value, '0');
  assert.match($('historial').children[0].textContent, /-1.*1 → 0.*<script>/);
  let prevenido = false;
  for (const key of '2318') ui.eventos.keydown({ target: $('volver'), key });
  ui.eventos.keydown({ target: $('volver'), key: 'Enter', preventDefault() { prevenido = true; } });
  await new Promise(setImmediate);
  assert.equal(prevenido, true); assert.ok(ui.llamadas.includes('/api/piezas?q=2318'));
  await $('camara').eventos.click(); assert.equal(ui.camaras(), 1);
  ui.escanear('ED-002318'); await new Promise(setImmediate);
  assert.ok(ui.llamadas.includes('/api/piezas?q=ED-002318'));
  await $('camara').eventos.click(); assert.equal(ui.apagadas(), 1);
  const html = readFileSync('public/pieza.html', 'utf8');
  assert.match(html, /min-width:1000px/);
  assert.equal($('existencia').hidden, true);
  assert.doesNotMatch(html, /id="(?:editor|imprimir|copias)"/);
  assert.match(html, /#menos, #sumar \{ width:56px; height:56px/);
});

test('pantalla: una respuesta atrasada no reemplaza la siguiente búsqueda ni reabre una ficha', async () => {
  let terminar: (c: unknown) => void = () => {};
  const ui = pantalla((url) => url.includes('vieja') ? new Promise((ok) => { terminar = ok; }) : { piezas: [], siguiente: null });
  ui.$('consulta').value = 'vieja'; const vieja = ui.api.buscar();
  await new Promise(setImmediate);
  ui.$('consulta').value = 'nueva'; await ui.api.buscar();
  terminar({ piezas: [{ id: 'anterior' }], siguiente: '2026-10-01~5' }); await vieja;
  assert.equal(ui.$('resultados').children.length, 0); assert.equal(ui.$('mas').hidden, true);
  const ficha = ui.api.abrir('vieja'); await new Promise(setImmediate);
  ui.$('consulta').eventos.input();
  terminar({ pieza: { nombre: 'Desfasada' }, historial: [] }); await ficha;
  assert.equal(ui.$('ficha').hidden, true);
});

test('venta intercalada antes del batch de ajuste: conserva ambos deltas y el rastro real', async (t) => {
  const { db, env, pedir, esperar } = tienda(); t.after(() => db.close());
  const p = pieza(db, { stock:5 });
  const batch = env.DB.batch.bind(env.DB);
  let conciliaciones = 0;
  const preparar = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    if (sql.includes('from ml_publicaciones')) conciliaciones++;
    return preparar(sql);
  };
  env.DB.batch = async (sentencias) => {
    env.DB.batch = batch;
    const venta = await pedir('/api/ventas', { id:crypto.randomUUID(), forma_pago:'tarjeta', lineas:[{ producto_id:p.id, cantidad:1 }] });
    assert.equal(venta.status, 201);
    return batch(sentencias);
  };
  const r = await pedir(`/api/piezas/${p.id}/existencia`, { id:crypto.randomUUID(), delta:2, motivo:'entrada' });
  assert.equal(r.status, 200); assert.equal(r.cuerpo.antes, 4); assert.equal(r.cuerpo.despues, 6);
  assert.equal(db.prepare('select stock from productos where id = ?').get(p.id)!.stock, 6);
  assert.equal(db.prepare('select count(*) n from venta_lineas where producto_id = ?').get(p.id)!.n, 1);
  await esperar(); assert.ok(conciliaciones >= 2);
});

test('límites 0 y 999; motivos y cuerpos inválidos nunca dejan rastro', async (t) => {
  const { db, pedir, esperar } = tienda(); t.after(() => db.close());
  const p = pieza(db, { stock:0 });
  const ajustar = (c: unknown) => pedir(`/api/piezas/${p.id}/existencia`, c);
  for (const [stock, delta] of [[0,-1],[999,1]]) {
    db.prepare('update productos set stock = ? where id = ?').run(stock, p.id);
    const r = await ajustar({ id:crypto.randomUUID(), delta, motivo:'correccion' });
    assert.equal(r.status, 409); assert.equal(r.cuerpo.stock, stock);
  }
  const malos = [null, [], {}, { id:'foo', delta:1, motivo:'entrada' },
    ...[0, 0.5, 1000, -1000, '1', null].map((delta) => ({ id:crypto.randomUUID(), delta, motivo:'correccion' })),
    ...['robo', 'merma', 'inventado'].map((motivo) => ({ id:crypto.randomUUID(), delta:1, motivo })),
    { id:crypto.randomUUID(), delta:-1, motivo:'entrada' },
    { id:crypto.randomUUID(), delta:1, esperado:1, motivo:'correccion' },
    ...[{ fijar_a:2 }, { fijar_a:2, esperado:'1' }, { fijar_a:1000, esperado:1 }, { fijar_a:2, esperado:1, delta:1 }]
      .map((c) => ({ id:crypto.randomUUID(), motivo:'correccion', ...c }))];
  for (const c of malos) assert.equal((await ajustar(c)).status, 400, JSON.stringify(c));
  assert.equal(db.prepare('select count(*) n from conteo_ajustes').get()!.n, 0);
  for (const [stock, delta, motivo] of [[1,-1,'robo'],[1,-1,'merma'],[1,-1,'error de captura'],[998,1,'entrada'],[0,1,'correccion']] as const) {
    db.prepare('update productos set stock = ? where id = ?').run(stock, p.id);
    const r = await ajustar({ id:crypto.randomUUID(), delta, motivo });
    assert.equal(r.status, 200); assert.equal(r.cuerpo.despues, stock + delta);
  }
  await esperar();
});

test('dos peticiones con el mismo UUID antes del batch aplican una sola vez y devuelven el mismo resultado', async (t) => {
  const { db, env, pedir, esperar } = tienda(); t.after(() => db.close());
  const p = pieza(db, { stock:5 });
  const cuerpo = { id:crypto.randomUUID(), delta:1, motivo:'correccion' };
  const batch = env.DB.batch.bind(env.DB);
  let llegadas = 0, liberar: () => void = () => {};
  const barrera = new Promise<void>((ok) => { liberar = ok; });
  env.DB.batch = async (s) => { if (++llegadas === 2) liberar(); await barrera; return batch(s); };
  const [a,b] = await Promise.all([pedir(`/api/piezas/${p.id}/existencia`, cuerpo), pedir(`/api/piezas/${p.id}/existencia`, cuerpo)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.deepEqual(a.cuerpo, b.cuerpo);
  env.DB.batch = batch;
  db.prepare('update productos set stock = stock - 1 where id = ?').run(p.id);
  const otra = await pedir(`/api/piezas/${p.id}/existencia`, cuerpo);
  assert.deepEqual(otra.cuerpo, a.cuerpo);
  assert.equal(db.prepare('select stock from productos where id = ?').get(p.id)!.stock, 5);
  assert.equal(db.prepare('select count(*) n from conteo_ajustes').get()!.n, 1);
  for (const cambios of [{ delta:2 }, { motivo:'entrada' }])
    assert.equal((await pedir(`/api/piezas/${p.id}/existencia`, { ...cuerpo, ...cambios })).status, 409);
  const otraPieza = pieza(db);
  assert.equal((await pedir(`/api/piezas/${otraPieza.id}/existencia`, cuerpo)).status, 409);
  await esperar();
});

test('fijar exige esperado vigente incluso si una venta llega entre lectura y escritura; reintento conserva resultado', async (t) => {
  const { db, env, pedir, esperar } = tienda(); t.after(() => db.close());
  const p = pieza(db, { stock:5 });
  const cuerpo = { id:crypto.randomUUID(), fijar_a:8, esperado:5, motivo:'correccion' };
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (s) => {
    env.DB.batch = batch;
    assert.equal((await pedir('/api/ventas', { id:crypto.randomUUID(), forma_pago:'tarjeta', lineas:[{ producto_id:p.id, cantidad:1 }] })).status, 201);
    return batch(s);
  };
  const viejo = await pedir(`/api/piezas/${p.id}/existencia`, cuerpo);
  assert.equal(viejo.status, 409); assert.equal(viejo.cuerpo.stock, 4);
  assert.equal(db.prepare('select count(*) n from conteo_ajustes').get()!.n, 0);
  const nuevo = { ...cuerpo, esperado:4 };
  const a = await pedir(`/api/piezas/${p.id}/existencia`, nuevo);
  assert.equal(a.status, 200); assert.equal(a.cuerpo.despues, 8);
  assert.deepEqual((await pedir(`/api/piezas/${p.id}/existencia`, nuevo)).cuerpo, a.cuerpo);
  await esperar();
});

test('misma hora: un UPDATE sin filas no inventa rastro; error al insertar revierte stock', async (t) => {
  const { db, pedir, esperar } = tienda(); t.after(() => db.close());
  t.mock.timers.enable({ apis:['Date'], now:Date.parse('2026-10-22T12:00:00Z') });
  const p = pieza(db, { stock:1 });
  assert.equal((await pedir(`/api/piezas/${p.id}/existencia`, { id:crypto.randomUUID(), delta:-1, motivo:'correccion' })).status, 200);
  assert.equal((await pedir(`/api/piezas/${p.id}/existencia`, { id:crypto.randomUUID(), delta:-1, motivo:'merma' })).status, 409);
  const antes = db.prepare('select stock, actualizado_en from productos where id = ?').get(p.id)!;
  assert.ok(Number.isFinite(Date.parse(String(antes.actualizado_en))));
  db.exec("create trigger fallo_rastro before insert on conteo_ajustes begin select raise(abort, 'fallo simulado de rastro'); end");
  assert.equal((await pedir(`/api/piezas/${p.id}/existencia`, { id:crypto.randomUUID(), delta:1, motivo:'entrada' })).status, 500);
  assert.deepEqual(db.prepare('select stock, actualizado_en from productos where id = ?').get(p.id), antes);
  assert.equal(db.prepare('select count(*) n from conteo_ajustes').get()!.n, 1);
  await esperar();
});

test('cada petición verifica rol y casilla; FEP solo sus piezas; descartadas y bandas no se ajustan', async (t) => {
  const { db, env, pedir, esperar } = tienda(); t.after(() => db.close());
  const propia = pieza(db), fep = pieza(db, { propietario:'fep' });
  const cambiar = (id = propia.id) => pedir(`/api/piezas/${id}/existencia`, { id:crypto.randomUUID(), delta:1, motivo:'correccion' });
  const ficha = (id = propia.id) => pedir(`/api/piezas/${id}`);
  assert.equal((await ficha()).cuerpo.puede_editar, true);
  for (const rol of ['capturista', 'finanzas', 'cajero', 'computadora', 'auxiliar']) {
    const correo = `${rol}@prueba.mx`;
    db.prepare("insert into usuarios (correo,nombre,roles,activo,creado_en,actualizado_en) values (?,'Prueba',?,1,'','')").run(correo, rol);
    env.DEV_USUARIO = correo;
    assert.equal((await cambiar()).status, 403);
    if (rol === 'capturista' || rol === 'finanzas') assert.equal((await ficha(rol === 'finanzas' ? fep.id : propia.id)).cuerpo.puede_editar, false);
    db.prepare('update usuarios set editar_inventario = 1 where correo = ?').run(correo);
    if (rol === 'capturista' || rol === 'finanzas') {
      const id = rol === 'finanzas' ? fep.id : propia.id;
      assert.equal((await ficha(id)).cuerpo.puede_editar, true);
      assert.equal((await cambiar(id)).status, 200);
      assert.equal((await cambiar(rol === 'finanzas' ? propia.id : fep.id)).status, 404);
      db.prepare('update usuarios set editar_inventario = 0 where correo = ?').run(correo);
      assert.equal((await cambiar(id)).status, 403);
    } else assert.equal((await cambiar()).status, 403);
    assert.equal((await pedir('/api/cuentas', { correo, roles:[rol], editar_inventario:true }, 'PUT')).status, 403);
  }
  env.DEV_USUARIO = DUENO;
  for (const p of [pieza(db, { sin_inventario:1 }), pieza(db, { estado_analisis:'descartado' }), fep]) assert.equal((await cambiar(p.id)).status, 404);
  assert.equal(permitidaParaVendedor(`/api/piezas/${propia.id}/existencia`, 'POST'), false);
  for (const host of ['HOST_VENDEDOR', 'HOST_PORTAL'] as const) {
    env[host] = 'caja.prueba'; assert.equal((await cambiar()).status, 404); env[host] = '';
  }
  await esperar();
});

test('propietario, visibilidad y límites se comprueban dentro del batch', async (t) => {
  const { db, env, pedir, esperar } = tienda(); t.after(() => db.close());
  const batch = env.DB.batch.bind(env.DB);
  for (const cambio of ["propietario = 'fep'", "sin_inventario = 1", "estado_analisis = 'descartado'", 'stock = 999']) {
    const p = pieza(db);
    env.DB.batch = async (s) => { db.prepare(`update productos set ${cambio} where id = ?`).run(p.id); return batch(s); };
    const r = await pedir(`/api/piezas/${p.id}/existencia`, { id:crypto.randomUUID(), delta:1, motivo:'entrada' });
    assert.equal(r.status, cambio === 'stock = 999' ? 409 : 404);
    assert.equal(db.prepare('select count(*) n from conteo_ajustes where producto_id = ?').get(p.id)!.n, 0);
  }
  await esperar();
});

test('pantalla: ajustar, motivos, confirmar fijar, deshacer por delta y refrescar historial', async () => {
  const p = { id:'pieza', nombre:'Chamarra', stock:5, precio:10000 };
  const escritos: any[] = [], confirmaciones: string[] = [];
  let historial: any[] = [];
  const ui = pantalla((_url, cuerpo) => {
    if (!cuerpo) return { pieza:{ ...p }, puede_editar:true, historial };
    escritos.push(cuerpo);
    const antes = p.stock; p.stock = cuerpo.delta === undefined ? cuerpo.fijar_a : p.stock + cuerpo.delta;
    const a = { antes, despues:p.stock, motivo:cuerpo.motivo, ajustado_por:DUENO, ajustado_en:new Date().toISOString() };
    historial = [a, ...historial]; return a;
  }, (s: string) => { confirmaciones.push(s); return true; });
  await ui.api.abrir(p.id);
  assert.equal(ui.$('existencia').hidden, false);
  await ui.$('sumar').eventos.click();
  assert.equal(escritos[0].delta, 1); assert.equal(escritos[0].motivo, 'correccion');
  assert.equal(ui.$('stock').value, '6'); assert.match(ui.$('historial').children[0].textContent, /5 → 6/);
  assert.match(ui.$('estado').textContent, /de 5 a 6/);
  assert.equal(ui.$('deshacer').hidden, false); assert.equal(ui.temporizadores[0].ms, 5000);
  // Venta intercalada: deshacer quita solo el +1, no restaura el valor anterior.
  p.stock--;
  ui.$('deshacer').eventos.click(); await new Promise(setImmediate);
  assert.equal(escritos[1].delta, -1); assert.equal(escritos[1].motivo, 'correccion'); assert.equal(p.stock, 4);
  ui.$('fijar-a').value = '9'; ui.$('fijar').eventos.submit({ preventDefault() {} }); await new Promise(setImmediate);
  assert.match(confirmaciones[0], /de 4 a 9/);
  assert.equal(escritos[2].fijar_a, 9); assert.equal(escritos[2].esperado, 4);
  ui.temporizadores.at(-1)!.fn(); assert.equal(ui.$('deshacer').hidden, true);
  ui.$('motivo').value = 'robo'; ui.$('motivo').eventos.change(); assert.equal(ui.$('sumar').disabled, true);
  ui.$('motivo').value = 'entrada'; ui.$('motivo').eventos.change(); assert.equal(ui.$('menos').disabled, true);
});

test('pantalla: respuesta perdida reintenta el mismo UUID; conflicto refresca stock y respuesta atrasada no pisa otra pieza', async () => {
  const cuerpos: any[] = [];
  let fallo = true, conflicto = false;
  const ui = pantalla((url, cuerpo) => {
    if (cuerpo) {
      cuerpos.push(cuerpo);
      if (fallo) { fallo = false; throw new Error('red caída'); }
      return conflicto ? { error:'Cambió, recarga.', status:409, stock:3 } : { antes:5, despues:6 };
    }
    return { pieza:{ id:url.split('/').at(-1), nombre:'Pieza', stock:conflicto ? 3 : 5, precio:10000 }, puede_editar:true, historial:[] };
  });
  await ui.api.abrir('uno'); await ui.$('sumar').eventos.click();
  assert.equal(ui.$('reintentar').hidden, false); assert.equal(ui.$('sumar').disabled, true);
  await ui.$('reintentar').eventos.click();
  assert.deepEqual(cuerpos[0], cuerpos[1]); assert.equal(ui.$('reintentar').hidden, true);
  conflicto = true; await ui.$('sumar').eventos.click();
  assert.equal(ui.$('stock').value, '3'); assert.match(ui.$('estado').textContent, /Cambió/);
  let terminar: (v: unknown) => void = () => {};
  const otra = pantalla((url, cuerpo) => cuerpo ? new Promise((ok) => { terminar = ok; })
    : { pieza:{ id:url.split('/').at(-1), nombre:'Pieza', stock:2, precio:10000 }, puede_editar:true, historial:[] });
  await otra.api.abrir('uno'); const ajuste = otra.$('sumar').eventos.click();
  await otra.api.abrir('dos'); terminar({ antes:2, despues:3 }); await ajuste;
  assert.equal(otra.$('stock').value, '2'); assert.equal(otra.$('deshacer').hidden, true);
});
