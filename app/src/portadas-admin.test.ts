// node --test src/portadas-admin.test.ts
// #890: revisión humana de portadas en /admin. Lo que importa: solo una portada aprobada está en extras/, una portada hecha a mano
// nunca se borra, y cada cambio es condicional al estado (y a la portada) que la pantalla mostró.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import worker from './worker.ts';
import { tienda } from './prueba-d1.ts';
import { procesarPortadas, type Dependencias } from './portadas.ts';

type Tienda = ReturnType<typeof tienda>;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ID = uuid(0);
const FECHA = '2026-11-22T10:00:00.000Z';
const CAP = 'cap@prueba.mx', FEP = 'fep@prueba.mx';
const fotos = (t: Tienda) => t.env.FOTOS as any;
const bytes = async (t: Tienda, llave: string) => { const o = await t.env.FOTOS.get(llave); return o ? [...new Uint8Array(await o.arrayBuffer())] : null; };
const llaves = (t: Tienda) => [...fotos(t).objetos.keys()].filter((k: string) => !k.startsWith('fotos/')).sort();
const fila = (t: Tienda, id = ID) => t.db.prepare('select * from productos where id = ?').get(id) as Record<string, any>;
const estadoDe = (t: Tienda, id = ID) => [fila(t, id).portada_estado, fila(t, id).portada_origen];
const EXTRAS = (id = ID) => `extras/${id}/01.jpg`;
const ESPERA = (id = ID) => `portadas/${id}.jpg`;

async function preparar(n = 1): Promise<Tienda> {
  const t = tienda();
  for (let i = 0; i < n; i++) {
    t.db.prepare(`insert into productos (id,codigo,nombre,marca,categoria,precio,estado_fisico,estado_analisis,destino,stock,foto_key,semana_ingreso,creado_en,actualizado_en,propietario)
      values (?,?,'Jeans','Levis','ropa',?,'nuevo','listo','etiqueta',3,?,'S40','','','dolaron')`).run(uuid(i), `ED-${i + 1}`, (n - i) * 10000, `fotos/${uuid(i)}.jpg`);
    await fotos(t).put(`fotos/${uuid(i)}.jpg`, new Uint8Array([1, 2, 3]));
  }
  return t;
}
function poner(t: Tienda, estado: string | null, origen: string | null = null, i = 0, extra: Record<string, unknown> = {}) {
  const revision = JSON.stringify({ ok: estado === 'lista', problemas: ['La etiqueta cambió'], intentos: 1 });
  t.db.prepare('update productos set portada_estado=?, portada_origen=?, portada_fecha=?, portada_revision=? where id=?')
    .run(estado, origen, extra.fecha ?? FECHA, estado ? revision : null, uuid(i));
}
const accion = (t: Tienda, nombre: string, estado: string, fecha: string | null = FECHA, id = ID) =>
  t.pedir(`/api/portadas/${id}/${nombre}`, { estado, fecha });
const usuario = (t: Tienda, correo: string, roles: string, editar = 0) => t.db.prepare(
  "insert into usuarios (correo, nombre, roles, activo, editar_inventario, creado_en, actualizado_en) values (?, ?, ?, 1, ?, '', '')").run(correo, correo, roles, editar);

test('listado: agrupa por estado, lo más reciente primero, con tope por lista y solo piezas de Dolarón vivas', async (t0) => {
  const t = await preparar(36); t0.after(() => t.db.close());
  for (let i = 0; i < 34; i++) poner(t, 'lista', 'ia', i, { fecha: `2026-11-22T10:${String(i).padStart(2, '0')}:00.000Z` });
  poner(t, 'revisar', null, 34); poner(t, 'retomar', null, 35);
  t.db.prepare("update productos set portada_estado='oficial', portada_fecha=? where id=?").run(FECHA, uuid(0));
  t.db.prepare("update productos set propietario='fep' where id=?").run(uuid(1));
  t.db.prepare("update productos set estado_analisis='descartado' where id=?").run(uuid(2));
  const r = await t.pedir('/api/portadas');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.cuerpo).sort(), ['lista', 'oficial', 'retomar', 'revisar']);
  assert.equal(r.cuerpo.lista.length, 30);
  assert.equal(r.cuerpo.lista[0].id, uuid(33));
  assert.ok(r.cuerpo.lista.every((p: any) => p.id !== uuid(1) && p.id !== uuid(2)));
  assert.deepEqual([r.cuerpo.revisar.length, r.cuerpo.retomar.length, r.cuerpo.oficial.length], [1, 1, 1]);
  const [rev] = r.cuerpo.revisar;
  assert.deepEqual([rev.id, rev.codigo, rev.nombre, rev.estado, rev.origen, rev.fecha], [uuid(34), 'ED-35', 'Jeans', 'revisar', null, FECHA]);
  assert.deepEqual(rev.revision, { ok: false, problemas: ['La etiqueta cambió'], intentos: 1 });
});

test('imagen: sirve la portada en espera o la publicada solo en su estado, sin caché, y 404 en lo demás', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  await fotos(t).put(ESPERA(), new Uint8Array([7]), { httpMetadata: { contentType: 'image/jpeg' } });
  await fotos(t).put(EXTRAS(), new Uint8Array([8]));
  const pedir = (id = ID) => t.enviar(`/api/portadas/${id}/imagen`);
  poner(t, 'revisar');
  let r = await pedir();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [7]);
  poner(t, 'lista', 'ia');
  r = await pedir();
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [8]);
  assert.equal(r.headers.get('cache-control'), 'private, no-store');
  // Una portada a mano que sigue publicada tras una foto nueva (revisar sin espera) se ve desde extras.
  await fotos(t).delete(ESPERA());
  poner(t, 'revisar', 'manual');
  assert.deepEqual([...new Uint8Array(await (await pedir()).arrayBuffer())], [8]);
  for (const estado of ['retomar', 'oficial', 'error', null]) {
    poner(t, estado);
    assert.equal((await pedir()).status, 404, String(estado));
  }
  poner(t, 'lista', 'ia');
  assert.equal((await pedir(uuid(9))).status, 404);
  assert.equal((await pedir('no-es-uuid')).status, 404);
  await fotos(t).delete(EXTRAS());
  assert.equal((await pedir()).status, 404);   // el estado dice lista pero el objeto ya no está
  t.db.prepare("update productos set estado_analisis='descartado' where id=?").run(ID);
  await fotos(t).put(EXTRAS(), new Uint8Array([8]));
  assert.equal((await pedir()).status, 404);
});

test('aprobar: pasa la portada en espera a extras como lista/ia; con otra portada o estado distinto, 409 y nada en extras', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  await fotos(t).put(ESPERA(), new Uint8Array([7]), { httpMetadata: { contentType: 'image/jpeg' } });
  poner(t, 'revisar');
  // La pantalla mostró otra portada (el cron generó una nueva después): no se aprueba la que nadie vio.
  let r = await accion(t, 'aprobar', 'revisar', '2026-11-22T09:00:00.000Z');
  assert.equal(r.status, 409);
  assert.deepEqual(llaves(t), [ESPERA()]);
  assert.deepEqual(estadoDe(t), ['revisar', null]);
  // La pantalla creía que era otro estado.
  assert.equal((await accion(t, 'aprobar', 'lista')).status, 409);
  r = await accion(t, 'aprobar', 'revisar');
  assert.equal(r.status, 200);
  assert.deepEqual(estadoDe(t), ['lista', 'ia']);
  assert.deepEqual(llaves(t), [EXTRAS()]);
  assert.deepEqual(await bytes(t, EXTRAS()), [7]);
  // Segunda persona: la misma pantalla vieja no aplica dos veces.
  assert.equal((await accion(t, 'aprobar', 'revisar')).status, 409);
  assert.equal((await accion(t, 'aprobar', 'revisar', FECHA, uuid(9))).status, 404);
});

test('aprobar una portada a mano que sigue en extras (foto nueva) solo la confirma', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  await fotos(t).put(EXTRAS(), new Uint8Array([5]));
  poner(t, 'revisar', 'manual');
  assert.equal((await accion(t, 'aprobar', 'revisar')).status, 200);
  assert.deepEqual(estadoDe(t), ['lista', 'manual']);
  assert.deepEqual(await bytes(t, EXTRAS()), [5]);
});

test('rechazar una lista de IA: sale de extras, queda en espera y vuelve a revisar; perdida la carrera, 409', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  await fotos(t).put(EXTRAS(), new Uint8Array([7]), { httpMetadata: { contentType: 'image/jpeg' } });
  poner(t, 'lista', 'ia');
  assert.equal((await accion(t, 'rechazar', 'revisar')).status, 409);
  assert.equal((await accion(t, 'rechazar', 'lista', '2026-11-22T09:00:00.000Z')).status, 409);
  assert.ok(fotos(t).objetos.has(EXTRAS()));
  const r = await accion(t, 'rechazar', 'lista');
  assert.equal(r.status, 200);
  assert.deepEqual(llaves(t), [ESPERA()]);
  assert.deepEqual(await bytes(t, ESPERA()), [7]);
  assert.deepEqual(estadoDe(t), ['revisar', 'ia']);
  assert.equal(JSON.parse(fila(t).portada_revision).ok, false);
  assert.equal((await accion(t, 'rechazar', 'lista')).status, 409);
  // Y se puede volver a aprobar la misma imagen.
  const nueva = fila(t).portada_fecha;
  assert.equal((await accion(t, 'aprobar', 'revisar', nueva)).status, 200);
  assert.deepEqual(await bytes(t, EXTRAS()), [7]);
});

test('una portada hecha a mano nunca se borra: rechazar la saca de extras, aprobar la trae de vuelta, generar se niega', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  await fotos(t).put(EXTRAS(), new Uint8Array([4, 2]), { httpMetadata: { contentType: 'image/png' } });
  poner(t, 'lista', 'manual');
  assert.equal((await accion(t, 'generar', 'lista')).status, 409);
  assert.deepEqual(await bytes(t, EXTRAS()), [4, 2]);
  assert.deepEqual(estadoDe(t), ['lista', 'manual']);
  assert.equal((await accion(t, 'rechazar', 'lista')).status, 200);
  assert.ok(!fotos(t).objetos.has(EXTRAS()));                         // nada la publica
  assert.deepEqual(await bytes(t, ESPERA()), [4, 2]);                  // y sigue recuperable
  assert.deepEqual(estadoDe(t), ['revisar', 'manual']);
  assert.equal((await t.enviar(`/api/portadas/${ID}/imagen`)).status, 200);
  // Generar otra tampoco la pisa estando rechazada.
  assert.equal((await accion(t, 'generar', 'revisar', fila(t).portada_fecha)).status, 409);
  assert.deepEqual(await bytes(t, ESPERA()), [4, 2]);
  // Una foto nueva tampoco la pierde.
  const { reiniciarPortada } = await import('./portadas.ts');
  await reiniciarPortada(t.env, ID);
  assert.deepEqual(await bytes(t, ESPERA()), [4, 2]);
  assert.deepEqual(estadoDe(t), ['revisar', 'manual']);
  assert.equal((await accion(t, 'aprobar', 'revisar', fila(t).portada_fecha)).status, 200);
  assert.deepEqual(await bytes(t, EXTRAS()), [4, 2]);
  assert.deepEqual(estadoDe(t), ['lista', 'manual']);        // sigue siendo a mano: una foto nueva no la borrará
  assert.equal((await t.env.FOTOS.get(EXTRAS()))!.httpMetadata?.contentType, 'image/png');
});

test('retomar foto: de revisar o lista deja estado retomar con motivo y sin portada publicada; la foto original no se toca', async (t0) => {
  const t = await preparar(3); t0.after(() => t.db.close());
  await fotos(t).put(ESPERA(), new Uint8Array([7]));
  await fotos(t).put(`portadas/${ID}.cruda`, new Uint8Array([6]));
  poner(t, 'revisar');
  assert.equal((await accion(t, 'retomar', 'revisar', '2026-11-22T09:00:00.000Z')).status, 409);
  assert.equal((await accion(t, 'retomar', 'revisar')).status, 200);
  assert.deepEqual(estadoDe(t), ['retomar', null]);
  assert.match(JSON.parse(fila(t).portada_revision).problemas[0], /retomar|foto/i);
  assert.deepEqual(llaves(t), []);
  assert.deepEqual(await bytes(t, `fotos/${ID}.jpg`), [1, 2, 3]);
  assert.equal((await accion(t, 'retomar', 'revisar')).status, 409);
  // Lista de IA: la portada publicada sale de extras (era de la foto mala).
  await fotos(t).put(EXTRAS(uuid(1)), new Uint8Array([7]));
  poner(t, 'lista', 'ia', 1);
  assert.equal((await accion(t, 'retomar', 'lista', FECHA, uuid(1))).status, 200);
  assert.deepEqual(llaves(t), []);
  assert.deepEqual(estadoDe(t, uuid(1)), ['retomar', null]);
  // Lista a mano: sale de extras pero se conserva, y sigue siendo a mano.
  await fotos(t).put(EXTRAS(uuid(2)), new Uint8Array([3]));
  poner(t, 'lista', 'manual', 2);
  assert.equal((await accion(t, 'retomar', 'lista', FECHA, uuid(2))).status, 200);
  assert.deepEqual(llaves(t), [ESPERA(uuid(2))]);
  assert.deepEqual(await bytes(t, ESPERA(uuid(2))), [3]);
  assert.deepEqual(estadoDe(t, uuid(2)), ['retomar', 'manual']);
});

test('generar otra / generar portada: vuelve a la cola del cron (estado null), borra lo de IA y no toca la foto', async (t0) => {
  const t = await preparar(5); t0.after(() => t.db.close());
  // 0 revisar: espera y cruda. 1 lista ia: extras. 2 retomar. 3 oficial.
  await fotos(t).put(ESPERA(), new Uint8Array([7])); await fotos(t).put(`portadas/${ID}.cruda`, new Uint8Array([6]));
  poner(t, 'revisar', null, 0);
  await fotos(t).put(EXTRAS(uuid(1)), new Uint8Array([7])); poner(t, 'lista', 'ia', 1);
  poner(t, 'retomar', null, 2);
  poner(t, 'oficial', null, 3);
  assert.equal((await accion(t, 'generar', 'revisar', '2026-11-22T09:00:00.000Z')).status, 409);
  assert.ok(fotos(t).objetos.has(ESPERA()));
  for (const [i, estado] of [[0, 'revisar'], [1, 'lista'], [2, 'retomar'], [3, 'oficial']] as const) {
    const r = await accion(t, 'generar', estado, FECHA, uuid(i));
    assert.equal(r.status, 200, estado);
    assert.deepEqual(estadoDe(t, uuid(i)), [null, null], estado);
    assert.equal((await accion(t, 'generar', estado, FECHA, uuid(i))).status, 409, `${estado} dos veces`);
  }
  assert.deepEqual(llaves(t), []);
  assert.deepEqual(await bytes(t, `fotos/${ID}.jpg`), [1, 2, 3]);
  assert.equal((await accion(t, 'generar', 'error', FECHA, uuid(4))).status, 409);   // error no se ofrece
});

test('generar otra deja la pieza donde el cron la toma, también una oficial: el cron no la vuelve a marcar oficial', async (t0) => {
  const t = await preparar(2); t0.after(() => t.db.close());
  t.db.prepare("insert into config (clave,valor) values ('portadas_activo','1')").run();
  (t.env as any).IMAGES = { input() { const c = { transform() { return c; }, async output() { return { response: () => new Response(new Uint8Array([7, 7])) }; } }; return c; } };
  const generadas: string[] = [];
  const deps: Dependencias = {
    async generar() { generadas.push('x'); return { bytes: new Uint8Array([9]).buffer, tipo: 'image/png', tokens: { entrada: 1, salida: 1 } }; },
    async comprobar() { return { ok: true, problemas: [], foto_mala: false }; },
  };
  // Una pieza con imagen de Target confirmada y una pieza que ya trae su portada de IA.
  t.db.prepare("update productos set recorte_estado='original', upc='840397509904' where id=?").run(ID);
  t.db.prepare("insert into manifiesto (upc, descripcion, precio_usd, tcin, actualizado_en) values ('840397509904', 'x', 100, 'T1', '')").run();
  t.db.prepare("insert into imagenes_upc (upc, tcin, url, nombre, confirmado_por, confirmado_en) values ('840397509904','T1','https://target.scene7.com/x','x','sistema','2026-11-01T00:00:00Z')").run();
  await procesarPortadas(t.env, deps);
  assert.deepEqual([estadoDe(t)[0], generadas.length], ['oficial', 1]);   // solo la otra pieza se generó
  assert.equal((await accion(t, 'generar', 'oficial', fila(t).portada_fecha)).status, 200);
  await procesarPortadas(t.env, deps);
  assert.equal(fila(t).portada_estado, 'revisar');
  assert.equal(generadas.length, 2);
  // Otra vez: «Generar otra» de la que ya se generó tampoco cae en oficial.
  assert.equal((await accion(t, 'generar', 'revisar', fila(t).portada_fecha)).status, 200);
  await procesarPortadas(t.env, deps);
  assert.equal(fila(t).portada_estado, 'revisar');
  assert.equal(generadas.length, 3);
});

test('carrera real: si otra persona cambia la pieza mientras se mueve R2, el cambio de D1 no se aplica (409) y nunca queda una portada sin aprobar en extras', async (t0) => {
  for (const [nombre, estado, origen] of [['rechazar', 'lista', 'ia'], ['generar', 'lista', 'ia'], ['retomar', 'lista', 'manual']] as const) {
    const t = await preparar(); t0.after(() => t.db.close());
    await fotos(t).put(EXTRAS(), new Uint8Array([7]));
    poner(t, estado, origen);
    // Entre la comprobación y el cambio, otra persona la pasa a retomar.
    const r2 = t.env.FOTOS; const poner409 = () => t.db.prepare("update productos set portada_estado='retomar', portada_fecha='otra' where id=?").run(ID);
    (t.env as any).FOTOS = new Proxy(r2, { get: (o, k) => k === 'delete' ? async (l: string) => { poner409(); return o.delete(l); } : (o as any)[k].bind?.(o) ?? (o as any)[k] });
    const r = await accion(t, nombre, estado);
    assert.equal(r.status, 409, nombre);
    assert.deepEqual(estadoDe(t), ['retomar', origen], nombre);
    assert.equal(fila(t).portada_fecha, 'otra');
    assert.ok(!(r2 as any).objetos.has(EXTRAS()), nombre);   // sin portada publicada
  }
});

test('acceso: dueño y capturista (con casilla para escribir) sí; FEP, cajero, vendedor y portal público no', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  await fotos(t).put(ESPERA(), new Uint8Array([7]));
  poner(t, 'revisar');
  usuario(t, CAP, 'capturista', 0); usuario(t, 'cap2@prueba.mx', 'capturista', 1); usuario(t, FEP, 'finanzas', 1); usuario(t, 'caja@prueba.mx', 'cajero', 1);
  const lecturas = ['/api/portadas', `/api/portadas/${ID}/imagen`];
  for (const [correo, ve] of [[CAP, true], ['cap2@prueba.mx', true], [FEP, false], ['caja@prueba.mx', false]] as const) {
    t.env.DEV_USUARIO = correo;
    for (const ruta of lecturas) assert.equal((await t.enviar(ruta)).status, ve ? 200 : 403, `${correo} ${ruta}`);
  }
  // Capturista sin casilla «Editar inventario»: solo consulta, sin escrituras.
  t.env.DEV_USUARIO = CAP;
  const antes = JSON.stringify(fila(t));
  for (const a of ['aprobar', 'rechazar', 'retomar', 'generar']) {
    const r = await accion(t, a, 'revisar');
    assert.equal(r.status, 403, a);
    assert.match(r.cuerpo.error, /editar el inventario/);
  }
  assert.equal(JSON.stringify(fila(t)), antes);
  assert.deepEqual(llaves(t), [ESPERA()]);
  t.env.DEV_USUARIO = FEP;
  for (const a of ['aprobar', 'rechazar', 'retomar', 'generar']) assert.equal((await accion(t, a, 'revisar')).status, 403, `FEP ${a}`);
  assert.equal(JSON.stringify(fila(t)), antes);
  t.env.DEV_USUARIO = 'cap2@prueba.mx';
  assert.equal((await accion(t, 'aprobar', 'revisar')).status, 200);
  assert.deepEqual(llaves(t), [EXTRAS()]);
});

test('hosts: ni el host del vendedor ni el del portal público llegan a portadas', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  await fotos(t).put(ESPERA(), new Uint8Array([7]));
  poner(t, 'revisar');
  (t.env as any).HOST_VENDEDOR = 'captura.prueba'; (t.env as any).HOST_PORTAL = 'dolarones.prueba';
  const peticiones = [['GET', '/api/portadas'], ['GET', `/api/portadas/${ID}/imagen`], ...['aprobar', 'rechazar', 'retomar', 'generar'].map((a) => ['POST', `/api/portadas/${ID}/${a}`])];
  for (const host of ['captura.prueba', 'dolarones.prueba']) {
    for (const [metodo, ruta] of peticiones) {
      const r = await worker.fetch!(new Request(`https://${host}${ruta}`, { method: metodo, headers: { 'content-type': 'application/json' },
        body: metodo === 'POST' ? JSON.stringify({ estado: 'revisar', fecha: FECHA }) : undefined }) as never, t.env, t.ctx as never);
      assert.equal(r.status, 404, `${host} ${metodo} ${ruta}`);
    }
  }
  assert.deepEqual(llaves(t), [ESPERA()]);
  assert.deepEqual(estadoDe(t), ['revisar', null]);
});

test('petición mal formada: cuerpo sin estado es 400 y no cambia nada', async (t0) => {
  const t = await preparar(); t0.after(() => t.db.close());
  poner(t, 'revisar'); await fotos(t).put(ESPERA(), new Uint8Array([7]));
  assert.equal((await t.pedir(`/api/portadas/${ID}/aprobar`, {})).status, 400);
  assert.equal((await t.pedir(`/api/portadas/${ID}/aprobar`, { estado: 3, fecha: FECHA })).status, 400);
  assert.equal((await t.pedir('/api/portadas/no-es-uuid/aprobar', { estado: 'revisar', fecha: FECHA })).status, 404);
  assert.deepEqual(llaves(t), [ESPERA()]);
});

test('/admin: la sección de portadas pinta las cuatro listas y manda estado y fecha de lo que mostró', async () => {
  const html = readFileSync('public/admin.html', 'utf8');
  const fuente = html.slice(html.indexOf('async function cargarPortadas('), html.lastIndexOf('await cargarPortadas();'));
  assert.ok(fuente.length > 100);
  class Nodo {
    children: Nodo[] = []; disabled = false; textContent = ''; className = ''; style = {}; tag: string; src = ''; alt = ''; hidden = false;
    click?: () => Promise<void>;
    constructor(tag: string) { this.tag = tag; }
    append(...n: Nodo[]) { this.children.push(...n); }
    replaceChildren(...n: Nodo[]) { this.children = n; }
    setAttribute() {}
    querySelectorAll(s: string): Nodo[] { return this.children.flatMap((n) => [...(s.split(',').map((x) => x.trim()).includes(n.tag) ? [n] : []), ...n.querySelectorAll(s)]); }
    addEventListener(_e: string, fn: () => Promise<void>) { this.click = fn; }
  }
  const datos = { revisar: [{ id: 'a', codigo: 'ED-1', nombre: 'Jeans', estado: 'revisar', origen: null, fecha: 'f1', revision: { ok: true, problemas: [], intentos: 1 } }],
    retomar: [{ id: 'b', codigo: 'ED-2', nombre: 'Tenis', estado: 'retomar', origen: null, fecha: 'f2', revision: { ok: false, problemas: ['Etiqueta tapa el logo'], intentos: 1 } }],
    lista: [{ id: 'c', codigo: 'ED-3', nombre: 'Gorra', estado: 'lista', origen: 'ia', fecha: 'f3', revision: null }],
    oficial: [{ id: 'd', codigo: 'ED-4', nombre: 'Taza', estado: 'oficial', origen: null, fecha: 'f4', revision: null }] };
  for (const puedeEditarInventario of [false, true]) {
    const raiz = new Nodo('div'), llamadas: { ruta: string; cuerpo: unknown }[] = [];
    const contexto = { puedeEditarInventario, document: { getElementById: () => raiz, createElement: (tag: string) => new Nodo(tag) },
      fetch: async (ruta: string, opciones?: RequestInit) => {
        if (opciones?.method === 'POST') { llamadas.push({ ruta, cuerpo: JSON.parse(String(opciones.body)) }); return Response.json({ error: 'Conflicto simulado' }, { status: 409 }); }
        return Response.json(datos);
      } };
    await runInNewContext(`${fuente}; cargarPortadas`, contexto)();
    const botones = raiz.querySelectorAll('button');
    // revisar: 3, retomar: 1, lista: 3, oficial: 1.
    assert.deepEqual(botones.map((b) => b.textContent), ['Aprobar', 'Generar otra', 'Retomar foto', 'Generar otra', 'Rechazar', 'Generar otra', 'Retomar foto', 'Generar portada']);
    assert.ok(botones.every((b) => b.disabled === !puedeEditarInventario));
    assert.equal(raiz.querySelectorAll('span').some((n) => /Solo consulta/.test(n.textContent)), !puedeEditarInventario);
    const imagenes = raiz.querySelectorAll('img').map((i) => i.src);
    assert.ok(imagenes.includes('/api/portadas/a/imagen') && imagenes.includes('/api/foto/a') && imagenes.includes('/api/portadas/c/imagen'));
    assert.ok(!imagenes.includes('/api/portadas/b/imagen'));
    if (puedeEditarInventario) {
      for (const b of botones) await b.click!();
      assert.deepEqual(llamadas.map((l) => l.ruta), ['a/aprobar', 'a/generar', 'a/retomar', 'b/generar', 'c/rechazar', 'c/generar', 'c/retomar', 'd/generar']
        .map((r) => `/api/portadas/${r}`));
      assert.deepEqual(llamadas[0].cuerpo, { estado: 'revisar', fecha: 'f1' });
      assert.deepEqual(llamadas[4].cuerpo, { estado: 'lista', fecha: 'f3' });
    } else assert.deepEqual(llamadas, []);
  }
});
