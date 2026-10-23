// node --test src/editar-inventario.test.ts
// #441 PR D: la casilla «Editar inventario» se exige en la cola vieja (/admin) y la ficha de /pieza
// corrige nombre, marca, talla y precios sin caer en la trampa del PATCH (precio/destino/stock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker from './worker.ts';
import { tienda, DUENO } from './prueba-d1.ts';
import { aCentavos, avisoReimpresion, cuerpoCorreccion, resumenCorreccion } from '../public/ficha.js';

type Tienda = ReturnType<typeof tienda>;
const CAP = 'cap@prueba.mx', FEP = 'fep@prueba.mx';
const URL_IMAGEN = 'http://foto.prueba/x.jpg';   // no es HTTPS: pasa la casilla y falla después con 400

function usuario(t: Tienda, correo: string, roles: string, editar = 0) {
  t.db.prepare("insert into usuarios (correo, nombre, roles, activo, editar_inventario, creado_en, actualizado_en) values (?, ?, ?, 1, ?, '', '')")
    .run(correo, correo, roles, editar);
}
const comoCaptura = (t: Tienda, correo: string) => { t.env.DEV_USUARIO = correo; };
function pieza(t: Tienda, cambios: Record<string, unknown> = {}) {
  const p = { id: crypto.randomUUID(), codigo: null, nombre: 'Chamarra', marca: 'Levis', stock: 2, precio: 45000, precio_lista: 60000,
    estado_analisis: 'listo', semana_ingreso: 'S43', creado_en: new Date().toISOString(), actualizado_en: '2026-10-01T00:00:00.000Z', ...cambios };
  const claves = Object.keys(p);
  t.db.prepare(`insert into productos (${claves.join(',')}) values (${claves.map(() => '?').join(',')})`).run(...Object.values(p) as never[]);
  return p.id;
}
const fila = (t: Tienda, id: string) => t.db.prepare('select * from productos where id = ?').get(id);
const todas = (t: Tienda) => t.db.prepare('select * from productos order by id').all();

// Las escrituras de la cola vieja que exigen la casilla, con el estado esperado cuando sí pasan.
function escrituras(t: Tienda) {
  const id = pieza(t), destino = pieza(t), borrar = pieza(t), foto = pieza(t, { foto_key: '' });
  return [
    ['PATCH', `/api/borradores/${id}`, { nombre: 'Corregida', precio: 45000, destino: 'etiqueta' }, 200],
    ['POST', `/api/borradores/${id}/fusionar`, { destino_id: destino }, 200],
    ['DELETE', `/api/borradores/${borrar}`, {}, 200],
    ['POST', `/api/borradores/${foto}/analizar`, {}, 202],
    ['POST', `/api/borradores/${foto}/imagen/buscar`, {}, 503],   // sin VERTEX_API_KEY: ya pasó la casilla
    ['PUT', `/api/borradores/${foto}/imagen`, { imagen: URL_IMAGEN }, 400],
  ] as const;
}

test('capturista sin casilla: 403 en PATCH, DELETE, fusionar, analizar e imagen, y no cambia nada', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  usuario(t, CAP, 'capturista');
  const lista = escrituras(t), antes = todas(t);
  comoCaptura(t, CAP);
  for (const [metodo, ruta, cuerpo] of lista) {
    const r = await t.pedir(ruta, cuerpo, metodo);
    assert.equal(r.status, 403, `${metodo} ${ruta}`);
    assert.match(r.cuerpo.error, /editar el inventario/);
  }
  assert.deepEqual(todas(t), antes);
  await t.esperar();
});

test('capturista con casilla: las mismas rutas llegan al handler; el dueño pasa sin casilla propia', async (t0) => {
  for (const quien of ['capturista', 'dueno'] as const) {
    const t = tienda(); t0.after(() => t.db.close());
    // El dueño de prueba tiene editar_inventario = 0: pasa por su rol, no por la casilla.
    assert.equal(t.db.prepare('select editar_inventario e from usuarios where correo = ?').get(DUENO)!.e, 0);
    if (quien === 'capturista') { usuario(t, CAP, 'capturista', 1); comoCaptura(t, CAP); }
    for (const [metodo, ruta, cuerpo, esperado] of escrituras(t)) {
      assert.equal((await t.pedir(ruta, cuerpo, metodo)).status, esperado, `${quien} ${metodo} ${ruta}`);
    }
    await t.esperar();
  }
});

const REVISIONES = [
  ['ropa-ia', 'aceptar', {}, { nombre: 'Playera Levis', marca: 'Levis', ropa_ia_estado: 'aceptado' }],
  ['ropa-ia', 'corregir', { prenda: 'Blusa', marca: 'Cat & Jack' }, { nombre: 'Blusa Cat & Jack', marca: 'Cat & Jack', ropa_ia_estado: 'aceptado' }],
  ['ropa-ia', 'descartar', {}, { ropa_ia_estado: 'descartado' }],
  ['recortes', 'aprobar', {}, { recorte_revision: 'ok' }],
  ['recortes', 'reintentar', {}, { recorte_estado: null, recorte_revision: null }],
  ['recortes', 'original', {}, { recorte_estado: 'original', recorte_revision: null }],
] as const;

async function piezaRevision(t: Tienda) {
  const id = pieza(t, { categoria: 'ropa', nombre: 'Ropa', marca: '', foto_key: 'fotos/revision.jpg',
    ropa_ia_estado: 'revisar', ropa_ia_sugerencia: JSON.stringify({ prenda: 'Playera', marca: 'Levis', marca_confianza: 'alta' }),
    recorte_estado: 'listo', recorte_revision: JSON.stringify({ problemas: ['Gancho visible'] }) });
  await t.env.FOTOS.put('fotos/revision.jpg', new Uint8Array([1, 2, 3]));
  await t.env.FOTOS.put(`recortes/${id}.webp`, new Uint8Array([4, 5, 6]));
  return id;
}

for (const [modulo, accion, cuerpo, cambios] of REVISIONES) {
  test(`POST ${modulo}/${accion}: sin casilla 403 sin escrituras; con casilla y dueño 200`, async (t0) => {
    for (const [rol, editar, permitido] of [
      ['capturista', 0, false], ['capturista', 1, true], ['dueno', 0, true],
      // FEP sigue sin acceso a estas colas de Dolarón, incluso con la casilla (#318).
      ['finanzas', 0, false], ['finanzas', 1, false],
    ] as const) {
      const t = tienda(); t0.after(() => t.db.close());
      usuario(t, CAP, rol, editar); comoCaptura(t, CAP);
      const id = await piezaRevision(t), antes = todas(t);
      const escriturasAntes = t.db.prepare('select total_changes() n').get()!.n;
      const r = await t.pedir(`/api/${modulo}/${id}/${accion}`, cuerpo);
      assert.equal(r.status, permitido ? 200 : 403, `${rol}, casilla ${editar}`);
      if (!permitido) {
        if (rol === 'capturista') assert.match(r.cuerpo.error, /editar el inventario/);
        assert.deepEqual(todas(t), antes);
        assert.equal(t.db.prepare('select total_changes() n').get()!.n, escriturasAntes);
      } else {
        const despues = fila(t, id)!;
        for (const [campo, valor] of Object.entries(cambios)) assert.equal(despues[campo], valor, campo);
        assert.equal(despues.precio, 45000); assert.equal(despues.stock, 2);
      }
      assert.deepEqual([...new Uint8Array(await (await t.env.FOTOS.get('fotos/revision.jpg'))!.arrayBuffer())], [1, 2, 3]);
      const recorte = await t.env.FOTOS.get(`recortes/${id}.webp`);
      if (permitido && accion === 'original') assert.equal(recorte, null);
      else assert.deepEqual([...new Uint8Array(await recorte!.arrayBuffer())], [4, 5, 6]);
    }
  });
}

test('GET de ropa IA, recortes e imagen conserva el acceso actual sin casilla', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  const id = await piezaRevision(t);
  for (const rol of ['capturista', 'dueno', 'finanzas']) {
    usuario(t, `consulta-${rol}@prueba.mx`, rol); comoCaptura(t, `consulta-${rol}@prueba.mx`);
    for (const ruta of ['/api/ropa-ia', '/api/recortes', `/api/recortes/${id}/imagen`]) {
      const r = await worker.fetch!(new Request(`https://caja.prueba${ruta}`) as never, t.env, t.ctx as never);
      assert.equal(r.status, rol === 'finanzas' ? 403 : 200, `${rol} ${ruta}`);
      if (rol !== 'finanzas') {
        if (ruta.endsWith('/imagen')) assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [4, 5, 6]);
        else assert.equal((await r.json() as { id: string }[])[0].id, id);
      }
    }
  }
});

test('capturista y FEP sin casilla pueden capturar y Retomar foto con solo_foto', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  t0.mock.method(globalThis, 'fetch', async () => Response.json({ error: { message: 'IA simulada no disponible' } }, { status: 401 }));
  for (const rol of ['capturista', 'finanzas']) {
    usuario(t, `${rol}@prueba.mx`, rol); comoCaptura(t, `${rol}@prueba.mx`);
    for (const ropa of [false, true]) {
      const id = crypto.randomUUID();
      const subir = async (soloFoto = false) => {
        const body = new FormData(); body.set('id', id);
        body.set('foto', new File([soloFoto ? 'foto nueva' : 'foto inicial'], 'foto.jpg', { type: 'image/jpeg' }));
        if (ropa) { body.set('precio_ropa', '15000'); body.set('talla', 'M'); }
        if (soloFoto) { body.set('solo_foto', '1'); body.set('cantidad', '99'); body.set('talla', 'L'); }
        return worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body }) as never, t.env, t.ctx as never);
      };
      assert.equal((await subir()).status, 201);
      await t.esperar();
      const antes = fila(t, id)!;
      assert.equal(antes.propietario, rol === 'finanzas' ? 'fep' : 'dolaron');
      assert.equal((await subir(true)).status, 200);
      const despues = fila(t, id)!;
      for (const campo of ['nombre', 'marca', 'precio', 'stock', 'talla', 'codigo', 'estado_analisis', 'propietario', 'capturado_por'])
        assert.equal(despues[campo], antes[campo], campo);
      assert.equal(await new Response((await t.env.FOTOS.get(`fotos/${id}.jpg`))!.body).text(), 'foto nueva');
    }
  }
});

test('FEP: con casilla edita lo suyo, sin casilla 403, y lo ajeno es 404 con o sin ella', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  usuario(t, FEP, 'finanzas');
  const suya = pieza(t, { propietario: 'fep' }), ajena = pieza(t);
  comoCaptura(t, FEP);
  const cuerpo = { nombre: 'Bolsa', precio: 45000, destino: 'etiqueta' };
  assert.equal((await t.pedir(`/api/borradores/${suya}`, cuerpo, 'PATCH')).status, 403);
  assert.equal((await t.pedir(`/api/borradores/${ajena}`, cuerpo, 'PATCH')).status, 404);
  t.db.prepare('update usuarios set editar_inventario = 1 where correo = ?').run(FEP);
  assert.equal((await t.pedir(`/api/borradores/${suya}`, cuerpo, 'PATCH')).status, 200);
  assert.equal((await t.pedir(`/api/borradores/${ajena}`, cuerpo, 'PATCH')).status, 404);
  assert.equal((await t.pedir(`/api/borradores/${suya}`, {}, 'DELETE')).status, 200);
});

test('las correcciones de 24 h del carrusel (existencia, talla, revisión) no piden casilla', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  t.env.AMBIENTE = 'sandbox';
  usuario(t, CAP, 'capturista');
  comoCaptura(t, CAP);
  const id = crypto.randomUUID(), body = new FormData();
  body.set('id', id); body.set('precio_ropa', '15000'); body.set('talla', 'M');
  body.set('foto', new File(['foto de prueba'], 'foto.jpg', { type: 'image/jpeg' }));
  assert.equal((await worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body }) as never, t.env, t.ctx as never)).status, 201);
  const ruta = `/api/borradores/${id}`;
  assert.equal((await t.pedir(`${ruta}/existencia`, { stock: 3 }, 'PATCH')).status, 200);
  assert.equal((await t.pedir(`${ruta}/talla`, { talla: 'L' }, 'PATCH')).status, 200);
  assert.equal((await t.pedir(`${ruta}/revision`)).status, 200);
  assert.equal((await t.pedir(`${ruta}/revision`, { precio: 10000 }, 'PATCH')).status, 200);
  assert.equal((await t.pedir(`${ruta}/revision`, {}, 'DELETE')).status, 200);
  // ...y la misma persona sí necesita la casilla para el PATCH completo de /admin.
  assert.equal((await t.pedir(ruta, { nombre: 'X', precio: 10000, destino: 'etiqueta' }, 'PATCH')).status, 403);
  await t.esperar();
});

test('precio de una pieza con código: solo el dueño, con o sin casilla (#75), y la ficha manda el actual', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  usuario(t, CAP, 'capturista', 1);
  const id = pieza(t, { codigo: 'ED-002400' });
  comoCaptura(t, CAP);
  const cambio = await t.pedir(`/api/borradores/${id}`, { nombre: 'Chamarra', precio: 40000, destino: 'etiqueta' }, 'PATCH');
  assert.equal(cambio.status, 403); assert.equal(fila(t, id)!.precio, 45000);
  // Lo que arma la ficha para quien no ve el campo de precio: precio y destino actuales, sin stock.
  const { cuerpo } = cuerpoCorreccion({ precio: 45000, precio_lista: 60000, destino: 'etiqueta' },
    { nombre: 'Chamarra Levis', marca: 'Levis', talla: 'M', precio: '1', precio_lista: '2' }, false);
  assert.equal((await t.pedir(`/api/borradores/${id}`, cuerpo, 'PATCH')).status, 200);
  assert.deepEqual([fila(t, id)!.nombre, fila(t, id)!.precio, fila(t, id)!.stock], ['Chamarra Levis', 45000, 2]);
  comoCaptura(t, DUENO);
  assert.equal((await t.pedir(`/api/borradores/${id}`, { ...cuerpo, precio: 40000 }, 'PATCH')).status, 200);
  assert.equal(fila(t, id)!.precio, 40000);
});

test('/api/yo y la ficha dicen si hay casilla; puede_precio solo es del dueño', async (t0) => {
  const t = tienda(); t0.after(() => t.db.close());
  usuario(t, CAP, 'capturista', 1);
  const id = pieza(t);
  comoCaptura(t, CAP);
  assert.equal((await t.pedir('/api/yo')).cuerpo.usuario.editar_inventario, true);
  let ficha = (await t.pedir(`/api/piezas/${id}`)).cuerpo;
  assert.deepEqual([ficha.puede_editar, ficha.puede_precio], [true, false]);
  comoCaptura(t, DUENO);
  ficha = (await t.pedir(`/api/piezas/${id}`)).cuerpo;
  assert.deepEqual([ficha.puede_editar, ficha.puede_precio], [true, true]);
});

test('el cuerpo de la ficha siempre lleva precio y destino y nunca stock', () => {
  const p = { precio: 45000, precio_lista: 60000, destino: 'etiqueta', stock: 7 };
  const campos = { nombre: ' Chamarra ', marca: 'Levis', talla: 'M', precio: '400', precio_lista: '600' };
  for (const puedePrecio of [true, false]) {
    const { cuerpo } = cuerpoCorreccion(p, campos, puedePrecio);
    assert.deepEqual(Object.keys(cuerpo).sort(), ['destino', 'marca', 'nombre', 'precio', 'precio_lista', 'talla']);
    assert.ok(!('stock' in cuerpo)); assert.ok(Number.isSafeInteger(cuerpo.precio)); assert.equal(cuerpo.destino, 'etiqueta');
    assert.equal(cuerpo.nombre, 'Chamarra');
  }
  assert.equal(cuerpoCorreccion(p, campos, true).cuerpo.precio, 40000);
  assert.equal(cuerpoCorreccion(p, campos, false).cuerpo.precio, 45000);   // sin permiso se conserva el actual
  const banda = cuerpoCorreccion({ ...p, destino: 'banda_g119' }, campos, true).cuerpo;
  assert.deepEqual([banda.precio, banda.precio_lista, banda.destino], [45000, 60000, 'banda_g119']);
  for (const malo of [{ precio: '' }, { precio: 'abc' }, { precio: '-5' }, { precio: '0' }, { precio: '700' }, { precio_lista: '12x' }, { nombre: '  ' }])
    assert.ok(cuerpoCorreccion(p, { ...campos, ...malo }, true).error, JSON.stringify(malo));
  assert.equal(cuerpoCorreccion(p, { ...campos, precio_lista: '' }, true).cuerpo.precio_lista, 0);
  assert.deepEqual(['450', '450.5', '450,50', ' 12 '].map(aCentavos), [45000, 45050, 45050, 1200]);
  assert.deepEqual(['', '1e3', '4.505', '$5'].map(aCentavos), [null, null, null, null]);
});

test('confirmación: precio con etiqueta pegada, nombre y talla; reimpresión con la regla de /etiquetas', () => {
  const antes = { codigo: 'ED-002318', nombre: 'Chamarra', marca: 'Levis', talla: 'M', precio: 45000, precio_lista: 60000, destino: 'etiqueta', stock: 3 };
  const cuerpo = { nombre: 'Chamarra Levis', marca: 'Levis', talla: 'L', precio: 40000, precio_lista: 60000, destino: 'etiqueta' };
  const lineas = resumenCorreccion(antes, cuerpo, undefined);
  assert.equal(lineas[0], 'Precio $450.00 → $400.00. La etiqueta pegada dice $450.00: la caja cobrará $400.00 desde ahora.');
  assert.deepEqual(lineas.slice(1), ['Nombre «Chamarra» → «Chamarra Levis».', 'Talla «M» → «L».']);
  // Si este navegador imprimió otro precio, ese es el que dice la etiqueta pegada.
  assert.match(resumenCorreccion(antes, cuerpo, { precio: 50000, precio_lista: 60000 })[0], /pegada dice \$500\.00/);
  assert.match(resumenCorreccion({ ...antes, codigo: null }, cuerpo, undefined)[0], /^Precio \$450\.00 → \$400\.00\. La caja cobrará \$400\.00 desde ahora\.$/);
  assert.deepEqual(resumenCorreccion(antes, { ...antes, destino: 'etiqueta' }, undefined), []);
  const ahora = { ...antes, ...cuerpo };
  assert.match(avisoReimpresion(undefined, antes, ahora)!, /dice \$450\.00 y ahora cuesta \$400\.00/);
  assert.match(avisoReimpresion({ precio: 40000, precio_lista: 60000, nombre: 'Chamarra', talla: 'M' }, antes, ahora)!, /dice «Chamarra · M»/);
  assert.equal(avisoReimpresion({ precio: 40000, precio_lista: 60000, nombre: 'Chamarra Levis', talla: 'L' }, antes, ahora), null);
  assert.equal(avisoReimpresion(undefined, { ...antes, codigo: null }, ahora), null);          // aún sin etiqueta
  assert.equal(avisoReimpresion(undefined, { ...antes, destino: 'banda_g119' }, { ...ahora, destino: 'banda_g119' }), null);
  assert.match(avisoReimpresion({ precio: 40000, precio_lista: 60000, nombre: 'Chamarra Levis', talla: 'L', estado_fisico: 'nuevo' }, antes, { ...ahora, estado_fisico: 'danado' })!, /grado A · Nuevo.*ahora es B · Dañado/);
  assert.equal(avisoReimpresion({ precio: 40000, precio_lista: 60000, nombre: 'Chamarra Levis', talla: 'L' }, antes, { ...ahora, estado_fisico: 'nuevo' }), null);   // marca sin grado = A
  assert.equal(avisoReimpresion(undefined, antes, { ...ahora, stock: 0 }), null);              // sin existencia no hay etiqueta que cambiar
});

test('/admin sin casilla: fichas de solo consulta, aviso y «Guardar todo» sin efecto', async () => {
  const html = readFileSync('public/admin.html', 'utf8');
  assert.match(html, /id="aviso-edicion"[^>]*hidden/);
  assert.match(html, /usuario\?\.editar_inventario === true/);
  const fuente = html.slice(html.indexOf('function ficha('), html.indexOf('// #413:'));
  const intentos: string[] = [];
  for (const puedeEditarInventario of [false, true]) {
    const aviso = { textContent: '', style: { color: '' } };
    const controles = [{ disabled: false }, { disabled: false }];
    const nodo: Record<string, unknown> = { innerHTML: '', className: '',
      querySelector: (s: string) => s === '.aviso' ? aviso : { addEventListener() {}, value: '' },
      querySelectorAll: () => controles, addEventListener() {} };
    const ficha = runInNewContext(`${fuente}; ficha`, { puedeEditarInventario, existentes: new Map(), normalizar: (s: string) => s,
      document: { createElement: () => nodo }, opcionesCategoria: () => '', opcionesEstado: () => '', pesos: () => '', centavos: () => 0, DESTINOS: [],
      fetch: async (url: string) => { intentos.push(url); return Response.json({}); } });
    const n = ficha({ id: 'x', nombre: 'Pieza', semana_ingreso: 'S43', estado_analisis: 'listo' });
    assert.deepEqual(controles.map((c) => c.disabled), [!puedeEditarInventario, !puedeEditarInventario]);
    assert.equal(/Solo consulta/.test(aviso.textContent), !puedeEditarInventario);
    if (!puedeEditarInventario) { assert.equal(await n.guardarFicha(), false); assert.deepEqual(intentos, []); }
  }
});

test('/admin: ropa IA y recortes deshabilitan las seis acciones y muestran Solo consulta sin casilla', async () => {
  const html = readFileSync('public/admin.html', 'utf8');
  const fuentes = [
    html.slice(html.indexOf('async function cargarRopaIA()'), html.indexOf('\nawait cargarRopaIA();')),
    html.slice(html.indexOf('async function cargarRecortes()'), html.lastIndexOf('await cargarRecortes();')),
  ];
  class Nodo {
    children: Nodo[] = []; disabled = false; textContent = ''; className = ''; style = {};
    click?: () => Promise<void>;
    tag: string;
    constructor(tag: string) { this.tag = tag; }
    append(...nodos: Nodo[]) { this.children.push(...nodos); }
    replaceChildren(...nodos: Nodo[]) { this.children = nodos; }
    setAttribute() {}
    querySelectorAll(selector: string): Nodo[] {
      return this.children.flatMap((n) => [...(selector.split(',').map((s) => s.trim()).includes(n.tag) ? [n] : []), ...n.querySelectorAll(selector)]);
    }
    addEventListener(_evento: string, fn: () => Promise<void>) { this.click = fn; }
  }
  for (const puedeEditarInventario of [false, true]) {
    const raiz = new Nodo('div'), llamadas: string[] = [];
    const piezas = [
      { id: 'lista', recorte_estado: 'listo', recorte_revision: '{"problemas":["Gancho"]}' },
      { id: 'error', recorte_estado: 'error', recorte_revision: null },
    ];
    const contexto = {
      puedeEditarInventario,
      document: { getElementById: () => raiz, createElement: (tag: string) => new Nodo(tag) },
      fetch: async (ruta: string, opciones?: RequestInit) => {
        if (opciones?.method === 'POST') { llamadas.push(ruta); return Response.json({ error: 'Conflicto simulado' }, { status: 409 }); }
        return Response.json(piezas);
      },
    };
    const ropa = runInNewContext(`${fuentes[0]}; cargarRopaIA`, contexto);
    await ropa();
    const controlesRopa = raiz.querySelectorAll('input, button');
    assert.equal(controlesRopa.length, 10);
    assert.ok(controlesRopa.every((c) => c.disabled === !puedeEditarInventario));
    assert.equal(raiz.querySelectorAll('span').some((n) => /Solo consulta/.test(n.textContent)), !puedeEditarInventario);
    if (puedeEditarInventario) for (const b of raiz.querySelectorAll('button').slice(0, 3)) await b.click!();
    const recortes = runInNewContext(`${fuentes[1]}; cargarRecortes`, contexto);
    await recortes();
    const botonesRecortes = raiz.querySelectorAll('button');
    assert.equal(botonesRecortes.length, 3);
    assert.ok(botonesRecortes.every((b) => b.disabled === !puedeEditarInventario));
    assert.equal(raiz.querySelectorAll('span').some((n) => /Solo consulta/.test(n.textContent)), !puedeEditarInventario);
    if (puedeEditarInventario) for (const b of botonesRecortes) await b.click!();
    assert.deepEqual(llamadas, puedeEditarInventario ? [
      '/api/ropa-ia/lista/aceptar', '/api/ropa-ia/lista/corregir', '/api/ropa-ia/lista/descartar',
      '/api/recortes/lista/aprobar', '/api/recortes/lista/original', '/api/recortes/error/reintentar',
    ] : []);
  }
});
