import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { procesarPortadas, publicarPortada, reiniciarPortada, generarConGemini, comprobarConClaude, MODELO_IMAGEN,
  SinImagen, type Dependencias, type Veredicto } from './portadas.ts';
import { hoyTienda } from './reportes.ts';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const OK: Veredicto = { ok: true, problemas: [], foto_mala: false };
const fotos = (t: ReturnType<typeof tienda>) => t.env.FOTOS as any;
const llaves = (t: ReturnType<typeof tienda>) => [...fotos(t).objetos.keys()].filter((k: string) => !k.startsWith('fotos/')).sort();
const fila = (t: ReturnType<typeof tienda>, id = uuid(0)) => t.db.prepare('select * from productos where id=?').get(id) as Record<string, any>;
const revision = (t: ReturnType<typeof tienda>, id = uuid(0)) => JSON.parse(fila(t, id).portada_revision);

test('migración 087: portada_estado existe y rechaza un valor fuera del check', () => {
  const t = tienda();
  try {
    assert.equal(t.db.prepare("select count(*) n from pragma_table_info('productos') where name in ('portada_estado','portada_origen','portada_fecha','portada_revision')").get()?.n, 4);
    t.db.prepare("update productos set portada_estado='lista', portada_origen='ia'").run();
    assert.throws(() => t.db.prepare("update productos set portada_estado='inventado'").run(), /CHECK/);
    assert.throws(() => t.db.prepare("update productos set portada_origen='otro'").run(), /CHECK/);
  } finally { t.db.close(); }
});

/** n piezas vendibles; la i cuesta (n - i) × $100, así la 0 es la más cara. */
async function preparar(n = 1, config: Record<string, string> = { portadas_activo: '1' }) {
  const t = tienda();
  for (const [clave, valor] of Object.entries(config)) t.db.prepare('insert into config (clave,valor) values (?,?)').run(clave, valor);
  for (let i = 0; i < n; i++) {
    const id = uuid(i);
    t.db.prepare(`insert into productos (id,codigo,nombre,marca,categoria,precio,estado_fisico,estado_analisis,destino,stock,foto_key,semana_ingreso,creado_en,actualizado_en,propietario)
      values (?,?,'Jeans','Levis','ropa',?,'nuevo','listo','etiqueta',3,?,'S40','','','dolaron')`).run(id, `ED-${i + 1}`, (n - i) * 10000, `fotos/${id}.jpg`);
    await fotos(t).put(`fotos/${id}.jpg`, new Uint8Array([1, 2, 3]));
  }
  (t.env as any).IMAGES = imagenes();
  return t;
}
// Como el binding real: output() es async y ahí falla la cuota (9422).
function imagenes(falla?: () => Error | null) {
  return { input() { const c = { transform() { return c; }, async output() { const e = falla?.(); if (e) throw e; return { response: () => new Response(new Uint8Array([7, 7])) }; } }; return c; } };
}
function dependencias(veredictos: Veredicto[] = [OK], generar?: Dependencias['generar']) {
  const llamadas = { generar: [] as string[][], comprobar: 0 };
  const deps: Dependencias = {
    async generar(env, foto, problemas) {
      llamadas.generar.push(problemas);
      if (generar) return generar(env, foto, problemas);
      return { bytes: new Uint8Array([9, 9, 9]).buffer, tipo: 'image/png', tokens: { entrada: 1300, salida: 1120 } };
    },
    async comprobar() { return veredictos[Math.min(llamadas.comprobar++, veredictos.length - 1)]; },
  };
  return { deps, llamadas };
}
const generada = { bytes: new Uint8Array([9]).buffer, tipo: 'image/png', tokens: { entrada: 1, salida: 1 } };

test('portadas: apagado o en 0 no cambia nada ni llama a generar', async () => {
  for (const config of [{}, { portadas_activo: '0' }]) {
    const t = await preparar(1, config); const { deps, llamadas } = dependencias();
    try {
      await procesarPortadas(t.env, deps);
      assert.equal(llamadas.generar.length, 0);
      assert.equal(fila(t).portada_estado, null);
      assert.deepEqual(llaves(t), []);
    } finally { t.db.close(); }
  }
});

test('portadas: toma las 3 más caras de las pendientes y salta lo que no es vendible', async () => {
  const t = await preparar(5); const { deps, llamadas } = dependencias();
  try {
    t.db.prepare('update productos set stock=0 where id=?').run(uuid(0)); // la más cara ya no se vende
    await procesarPortadas(t.env, deps);
    assert.equal(llamadas.generar.length, 3);
    assert.deepEqual([1, 2, 3, 4, 0].map((i) => fila(t, uuid(i)).portada_estado), ['revisar', 'revisar', 'revisar', null, null]);
  } finally { t.db.close(); }
});

test('portadas: recorte original pasa a oficial y ya existe extras/01.jpg pasa a lista manual, sin generar', async () => {
  const t = await preparar(2); const { deps, llamadas } = dependencias();
  try {
    t.db.prepare("update productos set recorte_estado='original' where id=?").run(uuid(0));
    await fotos(t).put(`extras/${uuid(1)}/01.jpg`, new Uint8Array([5]));
    const antes = fotos(t).objetos.get(`extras/${uuid(1)}/01.jpg`);
    await procesarPortadas(t.env, deps);
    assert.equal(llamadas.generar.length, 0);
    assert.equal(fila(t, uuid(0)).portada_estado, 'oficial');
    assert.deepEqual([fila(t, uuid(1)).portada_estado, fila(t, uuid(1)).portada_origen], ['lista', 'manual']);
    assert.equal(fotos(t).objetos.get(`extras/${uuid(1)}/01.jpg`), antes);
  } finally { t.db.close(); }
});

test('portadas: con aprobación (config ausente) un veredicto ok queda en revisar y NO llega a extras', async (t0) => {
  const t = await preparar(1); const { deps } = dependencias();
  const logs: string[] = []; const log = console.log;
  console.log = (l: string) => { logs.push(l); };
  t0.after(() => { console.log = log; });
  try {
    const antes = { ...fila(t) };
    await procesarPortadas(t.env, deps);
    const f = fila(t);
    assert.equal(f.portada_estado, 'revisar');
    assert.deepEqual(revision(t), { ok: true, problemas: [], intentos: 1 });
    assert.deepEqual(llaves(t), [`portadas/${uuid(0)}.jpg`]);
    for (const c of ['foto_key', 'precio', 'stock', 'estado_analisis', 'nombre', 'marca']) assert.equal(f[c], antes[c], c);
    const registro = JSON.parse(logs.find((l) => l.includes('portada generada'))!);
    assert.deepEqual({ ...registro, ms: 0 }, { mensaje: 'portada generada', id: uuid(0), modelo: MODELO_IMAGEN, intento: 1, tokens_entrada: 1300, tokens_salida: 1120, ms: 0 });
    const comprobada = JSON.parse(logs.find((l) => l.includes('portada comprobada'))!);
    assert.deepEqual({ ...comprobada, ms: 0 }, { mensaje: 'portada comprobada', id: uuid(0), ok: true, foto_mala: false, problemas: [], ms: 0 });
  } finally { t.db.close(); }
});

test('portadas: con portadas_aprobacion en 0 un veredicto ok queda lista, ia, en extras y sin restos en portadas/', async () => {
  const t = await preparar(1, { portadas_activo: '1', portadas_aprobacion: '0' }); const { deps } = dependencias();
  try {
    await procesarPortadas(t.env, deps);
    assert.deepEqual([fila(t).portada_estado, fila(t).portada_origen], ['lista', 'ia']);
    assert.deepEqual(llaves(t), [`extras/${uuid(0)}/01.jpg`]);
    assert.deepEqual([...new Uint8Array(fotos(t).objetos.get(`extras/${uuid(0)}/01.jpg`))], [7, 7]);
  } finally { t.db.close(); }
});

test('portadas: cualquier valor de aprobación distinto de 0 sigue pidiéndola', async () => {
  const t = await preparar(1, { portadas_activo: '1', portadas_aprobacion: 'no' }); const { deps } = dependencias();
  try {
    await procesarPortadas(t.env, deps);
    assert.equal(fila(t).portada_estado, 'revisar');
  } finally { t.db.close(); }
});

test('portadas: un veredicto no ok reintenta con los problemas; el segundo ok sigue su camino y el segundo fallo va a revisar', async () => {
  const malo: Veredicto = { ok: false, problemas: ['cambió el logo'], foto_mala: false };
  let t = await preparar(1); let d = dependencias([malo, OK]);
  try {
    await procesarPortadas(t.env, d.deps);
    assert.deepEqual(d.llamadas.generar, [[], ['cambió el logo']]);
    assert.deepEqual(revision(t), { ok: true, problemas: [], intentos: 2 });
    assert.equal(fila(t).portada_estado, 'revisar');
  } finally { t.db.close(); }
  t = await preparar(1); d = dependencias([malo, { ...malo, problemas: ['texto distinto'] }]);
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(d.llamadas.generar.length, 2);
    assert.deepEqual(revision(t), { ok: false, problemas: ['texto distinto'], intentos: 2 });
    assert.equal(fila(t).portada_estado, 'revisar');
    assert.deepEqual(llaves(t), [`portadas/${uuid(0)}.jpg`]);
  } finally { t.db.close(); }
});

test('portadas: foto_mala pasa a retomar con un solo intento y no deja restos', async () => {
  const t = await preparar(1); const { deps, llamadas } = dependencias([{ ok: false, problemas: ['etiqueta de precio sobre el producto'], foto_mala: true }]);
  try {
    await procesarPortadas(t.env, deps);
    assert.equal(llamadas.generar.length, 1);
    assert.equal(fila(t).portada_estado, 'retomar');
    assert.deepEqual(revision(t).problemas, ['etiqueta de precio sobre el producto']);
    assert.deepEqual(llaves(t), []);
  } finally { t.db.close(); }
});

test('portadas: el tope diario corta (2 de 3), cuenta en el día de la tienda y un valor no numérico vale 100', async () => {
  let t = await preparar(3, { portadas_activo: '1', portadas_tope_diario: '2' }); let d = dependencias();
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(d.llamadas.generar.length, 2);
    assert.deepEqual([0, 1, 2].map((i) => fila(t, uuid(i)).portada_estado), ['revisar', 'revisar', null]);
    assert.equal(t.db.prepare('select valor from config where clave=?').get(`portadas_generadas_${hoyTienda()}`)?.valor, '2');
    await procesarPortadas(t.env, d.deps);
    assert.equal(d.llamadas.generar.length, 2);
  } finally { t.db.close(); }
  for (const valor of ['mucho', '', '-1', '2.5']) {
    t = await preparar(3, { portadas_activo: '1', portadas_tope_diario: valor }); d = dependencias();
    try {
      await procesarPortadas(t.env, d.deps);
      assert.equal(d.llamadas.generar.length, 3, valor);
    } finally { t.db.close(); }
  }
});

test('portadas: el tope también corta el reintento y la pieza queda en revisar con su veredicto', async () => {
  const t = await preparar(1, { portadas_activo: '1', portadas_tope_diario: '1' });
  const d = dependencias([{ ok: false, problemas: ['forma distinta'], foto_mala: false }]);
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(d.llamadas.generar.length, 1);
    assert.deepEqual(revision(t), { ok: false, problemas: ['forma distinta'], intentos: 1 });
  } finally { t.db.close(); }
});

test('portadas: si generar falla por el proveedor (429, 5xx, red) la pieza sigue pendiente; un 4xx la marca error', async () => {
  for (const mensaje of ['Gemini 429: cuota', 'Gemini 503: no disponible', 'The operation was aborted due to timeout']) {
    const t = await preparar(2); const d = dependencias([OK], async () => { throw new Error(mensaje); });
    try {
      await procesarPortadas(t.env, d.deps);
      assert.equal(d.llamadas.generar.length, 1, 'se detiene: el proveedor está mal');
      assert.deepEqual([0, 1].map((i) => fila(t, uuid(i)).portada_estado), [null, null]);
      assert.deepEqual(llaves(t), []);
    } finally { t.db.close(); }
  }
  const t = await preparar(1); const d = dependencias([OK], async () => { throw new Error('Gemini 400: imagen inválida'); });
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(fila(t).portada_estado, 'error');
    assert.match(revision(t).problemas[0], /400/);
  } finally { t.db.close(); }
});

test('portadas: si IMAGES falla con 9422 después de generar, lo pagado queda en cruda y la siguiente corrida no genera otra vez', async () => {
  const t = await preparar(1); const { deps, llamadas } = dependencias();
  try {
    let cuota = true;
    (t.env as any).IMAGES = imagenes(() => (cuota ? new Error('9422 quota exceeded') : null));
    await procesarPortadas(t.env, deps);
    assert.equal(fila(t).portada_estado, null);
    assert.deepEqual(llaves(t), [`portadas/${uuid(0)}.cruda`]);
    assert.equal(fotos(t).objetos.get(`portadas/${uuid(0)}.cruda`).byteLength, 3);
    cuota = false;
    await procesarPortadas(t.env, deps);
    assert.equal(llamadas.generar.length, 1);
    assert.equal(fila(t).portada_estado, 'revisar');
    assert.deepEqual(llaves(t), [`portadas/${uuid(0)}.jpg`]);
    assert.equal(t.db.prepare('select valor from config where clave=?').get(`portadas_generadas_${hoyTienda()}`)?.valor, '1');
  } finally { t.db.close(); }
});

test('portadas: una cruda de una foto anterior no se reanuda', async () => {
  const t = await preparar(1); const { deps, llamadas } = dependencias();
  try {
    await fotos(t).put(`portadas/${uuid(0)}.cruda`, new Uint8Array([4]), { customMetadata: { foto_etag: 'otra-foto' } });
    await procesarPortadas(t.env, deps);
    assert.equal(llamadas.generar.length, 1);
  } finally { t.db.close(); }
});

test('portadas: el modelo sin imagen deja la pieza en error con el motivo', async () => {
  const t = await preparar(1); const d = dependencias([OK], async () => { throw new SinImagen('El modelo respondió sin imagen: no puedo editar esto.'); });
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(fila(t).portada_estado, 'error');
    assert.match(revision(t).problemas[0], /sin imagen/);
    assert.deepEqual(llaves(t), []);
  } finally { t.db.close(); }
});

test('portadas: si la foto cambia mientras se genera, el resultado se descarta', async () => {
  const t = await preparar(1);
  const d = dependencias([OK], async (env) => {
    await (env.FOTOS as any).put(`fotos/${uuid(0)}.jpg`, new Uint8Array([8, 8]));
    return generada;
  });
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(fila(t).portada_estado, null);
    assert.deepEqual(llaves(t), []);
  } finally { t.db.close(); }
});

test('portadas: una pieza descartada mientras se genera no recibe portada ni llega a extras', async () => {
  for (const aprobacion of ['1', '0']) {
    const t = await preparar(1, { portadas_activo: '1', portadas_aprobacion: aprobacion });
    const d = dependencias([OK], async () => {
      t.db.prepare("update productos set estado_analisis='descartado' where id=?").run(uuid(0));
      return generada;
    });
    try {
      await procesarPortadas(t.env, d.deps);
      assert.equal(fila(t).portada_estado, null, aprobacion);
      assert.deepEqual(llaves(t), [], aprobacion);
    } finally { t.db.close(); }
  }
});

test('portadas: publicarPortada pasa la portada en espera a extras una sola vez y no pisa una publicada', async () => {
  const t = await preparar(1); const { deps } = dependencias();
  try {
    await procesarPortadas(t.env, deps);
    assert.equal(await publicarPortada(t.env, uuid(0)), true);
    assert.deepEqual([fila(t).portada_estado, fila(t).portada_origen], ['lista', 'ia']);
    assert.deepEqual(llaves(t), [`extras/${uuid(0)}/01.jpg`]);
    assert.equal(await publicarPortada(t.env, uuid(0)), false);
    // Ya hay una publicada (otra corrida o una persona): no se pisa y el estado no cambia.
    t.db.prepare("update productos set portada_estado='revisar', portada_origen=null where id=?").run(uuid(0));
    await fotos(t).put(`portadas/${uuid(0)}.jpg`, new Uint8Array([1]));
    const publicada = fotos(t).objetos.get(`extras/${uuid(0)}/01.jpg`);
    assert.equal(await publicarPortada(t.env, uuid(0)), false);
    assert.equal(fotos(t).objetos.get(`extras/${uuid(0)}/01.jpg`), publicada);
    assert.equal(fila(t).portada_estado, 'revisar');
    // Una pieza fuera de revisión tampoco publica ni deja huella en extras.
    t.db.prepare("update productos set portada_estado='retomar' where id=?").run(uuid(0));
    await fotos(t).delete(`extras/${uuid(0)}/01.jpg`);
    assert.equal(await publicarPortada(t.env, uuid(0)), false);
    assert.ok(!fotos(t).objetos.has(`extras/${uuid(0)}/01.jpg`));
  } finally { t.db.close(); }
});

test('portadas: reiniciarPortada borra lo de origen ia y deja null; lo manual se conserva y pasa a revisar', async () => {
  const t = await preparar(2);
  try {
    for (const [i, origen] of [[0, 'ia'], [1, 'manual']] as const) {
      await fotos(t).put(`extras/${uuid(i)}/01.jpg`, new Uint8Array([1]));
      await fotos(t).put(`portadas/${uuid(i)}.jpg`, new Uint8Array([1]));
      await fotos(t).put(`portadas/${uuid(i)}.cruda`, new Uint8Array([1]));
      t.db.prepare("update productos set portada_estado='lista', portada_origen=? where id=?").run(origen, uuid(i));
    }
    await reiniciarPortada(t.env, uuid(0));
    await reiniciarPortada(t.env, uuid(1));
    const f0 = fila(t, uuid(0));
    assert.deepEqual([f0.portada_estado, f0.portada_origen, f0.portada_revision], [null, null, null]);
    assert.deepEqual(llaves(t), [`extras/${uuid(1)}/01.jpg`]);
    assert.deepEqual([fila(t, uuid(1)).portada_estado, fila(t, uuid(1)).portada_origen], ['revisar', 'manual']);
    // Una pieza sin origen (portada en espera, error, retomar) vuelve a la cola sin tocar extras.
    await fotos(t).put(`extras/${uuid(0)}/01.jpg`, new Uint8Array([2]));
    t.db.prepare("update productos set portada_estado='error' where id=?").run(uuid(0));
    await reiniciarPortada(t.env, uuid(0));
    assert.equal(fila(t, uuid(0)).portada_estado, null);
    assert.ok(fotos(t).objetos.has(`extras/${uuid(0)}/01.jpg`));
  } finally { t.db.close(); }
});

test('generarConGemini: pide la imagen cuadrada al modelo de Vertex con la foto y los problemas, y devuelve bytes, tipo y tokens', async (t0) => {
  const t = tienda(); const original = globalThis.fetch;
  t0.after(() => { globalThis.fetch = original; });
  (t.env as any).VERTEX_API_KEY = 'llave-vertex';
  let url = ''; let cuerpo: any;
  globalThis.fetch = (async (destino: string, init: RequestInit) => {
    url = destino; cuerpo = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'listo' }, { inlineData: { mimeType: 'image/png', data: btoa('PNGDATA') } }] } }],
      usageMetadata: { promptTokenCount: 1400, candidatesTokenCount: 1120 } }));
  }) as typeof fetch;
  try {
    const r = await generarConGemini(t.env, new Uint8Array([1, 2, 3]).buffer, ['cambió el logo']);
    assert.ok(url.includes(`/models/${MODELO_IMAGEN}:generateContent?key=llave-vertex`));
    assert.equal(cuerpo.contents[0].role, 'user');
    assert.deepEqual(cuerpo.contents[0].parts[0], { inlineData: { mimeType: 'image/jpeg', data: btoa('\x01\x02\x03') } });
    assert.match(cuerpo.contents[0].parts[1].text, /cambió el logo/);
    assert.deepEqual(cuerpo.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    assert.equal(cuerpo.generationConfig.imageConfig.aspectRatio, '1:1');
    assert.equal(r.tipo, 'image/png');
    assert.equal(new TextDecoder().decode(r.bytes), 'PNGDATA');
    assert.deepEqual(r.tokens, { entrada: 1400, salida: 1120 });
    // Sin imagen en la respuesta: SinImagen con lo que dijo el modelo.
    globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'No puedo.' }] } }] }))) as typeof fetch;
    await assert.rejects(generarConGemini(t.env, new ArrayBuffer(1), []), (e: unknown) => e instanceof SinImagen && /No puedo/.test((e as Error).message));
  } finally { t.db.close(); }
});

test('comprobarConClaude: manda las dos imágenes completas y normaliza el veredicto', async () => {
  const t = tienda();
  try {
    let enviadas: string[] = [];
    const v = await comprobarConClaude(t.env, new Uint8Array([1]).buffer, new Uint8Array([2]).buffer, async (foto) => {
      enviadas = foto as string[];
      return { ok: true, problemas: ['x', 3], foto_mala: undefined };
    });
    assert.deepEqual(enviadas, [btoa('\x01'), btoa('\x02')]);
    assert.deepEqual(v, { ok: true, problemas: ['x', '3'], foto_mala: false });
    // Solo un true de verdad cuenta como ok.
    assert.equal((await comprobarConClaude(t.env, new ArrayBuffer(1), new ArrayBuffer(1), async () => ({ ok: 'si', problemas: [] }))).ok, false);
    // foto_mala gana sobre ok: una portada «fiel» a una foto mala no se publica.
    assert.deepEqual(await comprobarConClaude(t.env, new ArrayBuffer(1), new ArrayBuffer(1), async () => ({ ok: true, problemas: [], foto_mala: true })),
      { ok: false, problemas: [], foto_mala: true });
  } finally { t.db.close(); }
});
