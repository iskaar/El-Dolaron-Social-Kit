import test from 'node:test';
import assert from 'node:assert/strict';
import { procesarRecortes, revisarRecortes, ajustarRecortesViejos, rutaRecortesAdmin, reiniciarRecorte } from './recortes.ts';
import { tienda } from './prueba-d1.ts';
import { catalogoPublico } from './catalogo.ts';

// Las rutas de admin solo aceptan UUID.
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ID0 = uuid(0);
const catalogo = (env: Env, ruta = '/api/catalogo') => catalogoPublico(new Request(`https://eldolaron.com${ruta}`), env, new URL(`https://eldolaron.com${ruta}`));

function preparar(n = 1) {
  const t = tienda();
  t.db.prepare("insert into config (clave,valor) values ('recortes_activo','1')").run();
  for (let i = 0; i < n; i++) {
    const id = uuid(i);
    t.db.prepare(`insert into productos (id,codigo,nombre,marca,categoria,precio,estado_fisico,estado_analisis,destino,stock,foto_key,semana_ingreso,creado_en,actualizado_en,propietario)
      values (?,?,'Jeans','Levis','ropa',25000,'nuevo','listo','etiqueta',3,?,'S40',?,?, 'dolaron')`).run(id, `ED-${i + 1}`, `fotos/${id}.jpg`, `${i}`, '');
    (t.env.FOTOS as any).objetos.set(`fotos/${id}.jpg`, Uint8Array.from([1, 2, 3]).buffer);
  }
  return t;
}
const images = (fn: (pasos: any[]) => Promise<Response> = async () => new Response(new Uint8Array([9, 8]), { headers: { 'content-type': 'image/webp' } }), llamadas: any[][] = []) => ({
  // Como el binding real: transform() encadena, output() es async y ahí falla (9422 de cuota); response() es síncrono.
  input() {
    const pasos: any[] = []; llamadas.push(pasos);
    const cadena = { transform(o: any) { pasos.push(o); return cadena; }, async output() { const r = await fn(pasos); return { response: () => r }; } };
    return cadena;
  },
});

test('recortes: interruptor apagado, lote limitado a 20 y guarda WebP', async () => {
  const t = preparar(23);
  try {
    t.db.prepare("update config set valor='0' where clave='recortes_activo'").run();
    await procesarRecortes(Object.assign(t.env, { IMAGES: images() }) as Env);
    assert.equal(t.db.prepare("select count(*) n from productos where recorte_estado='listo'").get()?.n, 0);
    t.db.prepare("update config set valor='1' where clave='recortes_activo'").run();
    await procesarRecortes(Object.assign(t.env, { IMAGES: images() }) as Env);
    assert.equal(t.db.prepare("select count(*) n from productos where recorte_estado='listo'").get()?.n, 20);
    assert.ok((t.env.FOTOS as any).objetos.has(`recortes/${ID0}.webp`));
  } finally { t.db.close(); }
});

test('recortes: ajusta al producto y, si el ajuste falla, guarda el recorte sin ajustar (#421)', async () => {
  for (const fallaAjuste of [false, true]) {
    const t = preparar(); const llamadas: any[][] = [];
    try {
      await procesarRecortes(Object.assign(t.env, { IMAGES: images(async (pasos) => {
        if (fallaAjuste && pasos.some((p) => p.trim)) throw Error('trim no soportado');
        return new Response(new Uint8Array([9, 8]));
      }, llamadas) }) as Env);
      assert.deepEqual(llamadas[0], [{ segment: 'foreground' }, { trim: { border: { keep: 24 } } }]);
      assert.deepEqual(llamadas.slice(1), fallaAjuste ? [[{ segment: 'foreground' }]] : []);
      assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get(ID0)?.recorte_estado, 'listo');
      assert.ok((t.env.FOTOS as any).objetos.has(`recortes/${ID0}.webp`));
    } finally { t.db.close(); }
  }
});

test('recortes: cuota 9422 no marca; otro error marca error', async () => {
  for (const [error, esperado] of [['9422 quota exceeded', null], ['R2 roto', 'error']] as const) {
    const t = preparar();
    try {
      await procesarRecortes(Object.assign(t.env, { IMAGES: images(async () => { throw Error(error); }) }) as Env);
      assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get(ID0)?.recorte_estado ?? null, esperado);
    } finally { t.db.close(); }
  }
});

test('recortes: admin limita al dueño, original borra R2 y reintentar devuelve a pendiente', async () => {
  const t = preparar();
  try {
    t.db.prepare(`update productos set recorte_estado='listo',recorte_fecha='2026-10-16' where id='${ID0}'`).run();
    (t.env.FOTOS as any).objetos.set(`recortes/${ID0}.webp`, new ArrayBuffer(1));
    const listado = await rutaRecortesAdmin(new Request('https://x/api/recortes'), t.env as Env, '/api/recortes');
    assert.equal((await listado!.json() as any[]).length, 1);
    await rutaRecortesAdmin(new Request('https://x', { method: 'POST' }), t.env as Env, `/api/recortes/${ID0}/original`);
    assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get(ID0)?.recorte_estado, 'original');
    assert.ok(!(t.env.FOTOS as any).objetos.has(`recortes/${ID0}.webp`));
    t.db.prepare(`update productos set recorte_estado='error' where id='${ID0}'`).run();
    await rutaRecortesAdmin(new Request('https://x', { method: 'POST' }), t.env as Env, `/api/recortes/${ID0}/reintentar`);
    assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get(ID0)?.recorte_estado, null);
    await reiniciarRecorte(t.env as Env, ID0);
    assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get(ID0)?.recorte_estado, null);
  } finally { t.db.close(); }
});

test('revisión: aprueba y el catálogo publica recorte solo con ok', async () => {
  const x = preparar();
  (x.env as any).ANTHROPIC_API_KEY = 'prueba';
  (x.env as any).IMAGES = { input() { return { transform() { return { async output() { return { response: () => new Response(new Uint8Array([4, 5])) }; } }; } }; } };
  x.db.prepare(`update productos set recorte_estado='listo',recorte_fecha='2026-10-16' where id=?`).run(ID0);
  (x.env.FOTOS as any).objetos.set(`recortes/${ID0}.webp`, new Uint8Array([1, 2]).buffer);
  try {
    await revisarRecortes(x.env as Env, async () => ({ ok: true, problemas: [], instruccion: '' }));
    assert.equal(x.db.prepare('select recorte_revision from productos where id=?').get(ID0)?.recorte_revision, 'ok');
    const lista = await (await catalogo(x.env as Env))!.json() as any;
    assert.ok(lista.piezas.some((p: any) => p.codigo === 'ED-1' && p.recorte));
  } finally { x.db.close(); }
});

test('revisión: marca problemas, lo oculta, lo ordena y aprobar publica', async () => {
  const x = preparar(2);
  (x.env as any).ANTHROPIC_API_KEY = 'prueba';
  (x.env as any).IMAGES = { input() { return { transform() { return { async output() { return new Response(new Uint8Array([4, 5])); } }; } }; } };
  x.db.prepare("update productos set recorte_estado='listo',recorte_fecha='2026-10-16' where id=?").run(uuid(0));
  x.db.prepare("update productos set recorte_estado='listo',recorte_fecha='2026-10-15' where id=?").run(uuid(1));
  for (let i = 0; i < 2; i++) (x.env.FOTOS as any).objetos.set(`recortes/${uuid(i)}.webp`, new Uint8Array([1]).buffer);
  try {
    await revisarRecortes(x.env as Env, async () => ({ ok: false, problemas: ['gancho visible'], instruccion: 'Remove the hook.' }));
    const revision = x.db.prepare('select recorte_revision from productos where id=?').get(ID0)?.recorte_revision;
    assert.deepEqual(JSON.parse(revision), { problemas: ['gancho visible'], instruccion: 'Remove the hook.' });
    const publico = await (await catalogo(x.env as Env))!.json() as any;
    assert.ok(publico.piezas.every((p: any) => p.recorte === null));
    const listaResp = await rutaRecortesAdmin(new Request('https://x/api/recortes'), x.env as Env, '/api/recortes');
    assert.equal((await listaResp!.json() as any[])[0].id, ID0);
    assert.equal((await catalogo(x.env as Env, '/api/catalogo/recorte/ED-1'))!.status, 404);
    const admin = await rutaRecortesAdmin(new Request('https://x'), x.env as Env, `/api/recortes/${ID0}/imagen`);
    assert.equal(admin!.status, 200);
    assert.deepEqual([...new Uint8Array(await admin!.arrayBuffer())], [1]);
    assert.equal((await rutaRecortesAdmin(new Request('https://x'), x.env as Env, `/api/recortes/${uuid(9)}/imagen`))!.status, 404);
    assert.equal((await rutaRecortesAdmin(new Request('https://x', { method: 'POST' }), x.env as Env, `/api/recortes/${ID0}/aprobar`))!.status, 200);
    assert.ok(((await (await catalogo(x.env as Env))!.json() as any).piezas.find((p: any) => p.codigo === 'ED-1')).recorte);
  } finally { x.db.close(); }
});

test('revisión: error de Claude pasa a revisión manual y reintentar limpia la revisión', async () => {
  const x = preparar();
  (x.env as any).ANTHROPIC_API_KEY = 'prueba';
  (x.env as any).IMAGES = images();
  x.db.prepare("update productos set recorte_estado='listo',recorte_fecha='2026-10-16' where id=?").run(ID0);
  (x.env.FOTOS as any).objetos.set(`recortes/${ID0}.webp`, new Uint8Array([1]).buffer);
  try {
    await revisarRecortes(x.env as Env, async () => { throw new Error('Claude no disponible'); });
    assert.deepEqual(JSON.parse(x.db.prepare('select recorte_revision from productos where id=?').get(ID0)?.recorte_revision).problemas, ['No se pudo revisar automáticamente']);
    x.db.prepare("update productos set recorte_estado='error'").run();
    await rutaRecortesAdmin(new Request('https://x', { method: 'POST' }), x.env as Env, `/api/recortes/${ID0}/reintentar`);
    assert.equal(x.db.prepare('select recorte_revision from productos where id=?').get(ID0)?.recorte_revision ?? null, null);
  } finally { x.db.close(); }
});

test('un recorte listo sin revisión no se publica', async () => {
  const x = preparar();
  try {
    x.db.prepare("update productos set recorte_estado='listo',recorte_revision=null where id=?").run(ID0);
    const lista = await (await catalogo(x.env as Env))!.json() as any;
    assert.equal(lista.piezas.find((p: any) => p.codigo === 'ED-1').recorte, null);
  } finally { x.db.close(); }
});

test('ajuste de recortes viejos: solo trim, conserva la revisión, avanza el cursor y no revive uno reiniciado (#425)', async () => {
  const t = preparar(4); const llamadas: any[][] = [];
  try {
    const fotos = t.env.FOTOS as any;
    for (let i = 0; i < 3; i++) {
      await fotos.put(`recortes/${uuid(i)}.webp`, new Uint8Array([1]));
      t.db.prepare("update productos set recorte_estado='listo', recorte_revision='ok' where id=?").run(uuid(i));
    }
    t.db.prepare("update productos set recorte_estado='original' where id=?").run(uuid(3));
    let reiniciado = false;
    const env = Object.assign(t.env, { IMAGES: images(async () => {
      // Se reinicia el tercero mientras se ajusta: su put condicional no debe revivirlo.
      if (!reiniciado && llamadas.length === 3) { reiniciado = true; await reiniciarRecorte(t.env as Env, uuid(2)); }
      return new Response(new Uint8Array([7]));
    }, llamadas) }) as Env;
    await ajustarRecortesViejos(env);
    assert.deepEqual(llamadas, [[{ trim: { border: { keep: 24 } } }], [{ trim: { border: { keep: 24 } } }], [{ trim: { border: { keep: 24 } } }]]);
    for (let i = 0; i < 2; i++) assert.deepEqual([...new Uint8Array(fotos.objetos.get(`recortes/${uuid(i)}.webp`))], [7]);
    assert.equal(fotos.objetos.has(`recortes/${uuid(2)}.webp`), false);
    assert.equal(t.db.prepare('select recorte_revision from productos where id=?').get(ID0)?.recorte_revision, 'ok');
    await ajustarRecortesViejos(env);
    assert.equal(llamadas.length, 3);
  } finally { t.db.close(); }
});
