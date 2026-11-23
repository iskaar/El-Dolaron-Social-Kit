import test from 'node:test';
import assert from 'node:assert/strict';
import { tienda } from './prueba-d1.ts';
import { procesarPortadas, publicarPortada, reiniciarPortada, generarConGemini, comprobarConClaude, MODELO_IMAGEN,
  SinImagen, type Dependencias, type Veredicto } from './portadas.ts';
import { hoyTienda } from './reportes.ts';
import worker from './worker.ts';

const PRODUCTO_PRUEBA = '00000000-0000-4000-8000-0000000000aa';
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const OK: Veredicto = { ok: true, problemas: [], foto_mala: false };
const fotos = (t: ReturnType<typeof tienda>) => t.env.FOTOS as any;
const llaves = (t: ReturnType<typeof tienda>) => [...fotos(t).objetos.keys()].filter((k: string) => !k.startsWith('fotos/')).sort();
const fila = (t: ReturnType<typeof tienda>, id = uuid(0)) => t.db.prepare('select * from productos where id=?').get(id) as Record<string, any>;
const revision = (t: ReturnType<typeof tienda>, id = uuid(0)) => JSON.parse(fila(t, id).portada_revision);
const MODELO = MODELO_IMAGEN;
/** La revisión completa, con los milisegundos (que varían) comprobados como números y puestos en 0 para poder comparar todo el objeto. */
function exacta(t: ReturnType<typeof tienda>, id = uuid(0)) {
  const r = revision(t, id);
  for (const campo of ['ms_generar', 'ms_comprobar']) { assert.ok(Number.isInteger(r[campo]) && r[campo] >= 0, `${campo}: ${r[campo]}`); r[campo] = 0; }
  return r;
}
const T1 = { entrada: 1300, salida: 1120 };   // los tokens de una generación en `dependencias`

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

test('portadas: ya existe extras/01.jpg pasa a lista manual, sin generar', async () => {
  const t = await preparar(1); const { deps, llamadas } = dependencias();
  try {
    await fotos(t).put(`extras/${uuid(0)}/01.jpg`, new Uint8Array([5]));
    const antes = fotos(t).objetos.get(`extras/${uuid(0)}/01.jpg`);
    await procesarPortadas(t.env, deps);
    assert.equal(llamadas.generar.length, 0);
    assert.deepEqual([fila(t).portada_estado, fila(t).portada_origen], ['lista', 'manual']);
    assert.equal(fotos(t).objetos.get(`extras/${uuid(0)}/01.jpg`), antes);
  } finally { t.db.close(); }
});

/** Una referencia confirmada de Target para `upc` (sin ceros iniciales, como la guarda imagenes_upc). */
function referencia(t: ReturnType<typeof tienda>, upc: string, confirmada = true) {
  t.db.prepare("insert into manifiesto (upc, descripcion, precio_usd, tcin, actualizado_en) values (?, 'x', 100, 'T1', '')").run(upc);
  t.db.prepare("insert into imagenes_upc (upc, tcin, url, nombre, confirmado_por, confirmado_en) values (?, 'T1', 'https://target.scene7.com/x', 'x', 'sistema', ?)")
    .run(upc, confirmada ? '2026-11-01T00:00:00Z' : '');
}

test('portadas: original con referencia confirmada de su UPC (aunque la pieza lo traiga con ceros) pasa a oficial sin generar; sin referencia se genera', async () => {
  const t = await preparar(4); const { deps, llamadas } = dependencias();
  try {
    // 0: referencia confirmada. 1: UPC con ceros iniciales y referencia guardada sin ceros. 2: sin referencia (p. ej. el botón «original» de /admin).
    // 3: referencia sin confirmar.
    t.db.prepare("update productos set recorte_estado='original', upc=? where id=?").run('840397509904', uuid(0));
    t.db.prepare("update productos set recorte_estado='original', upc=? where id=?").run('00840397509911', uuid(1));
    t.db.prepare("update productos set recorte_estado='original', upc=? where id=?").run('840397509928', uuid(2));
    t.db.prepare("update productos set recorte_estado='original', upc=? where id=?").run('840397509935', uuid(3));
    referencia(t, '840397509904'); referencia(t, '840397509911'); referencia(t, '840397509935', false);
    await procesarPortadas(t.env, deps);
    assert.deepEqual([0, 1, 2, 3].map((i) => fila(t, uuid(i)).portada_estado), ['oficial', 'oficial', 'revisar', 'revisar']);
    assert.equal(llamadas.generar.length, 2);
  } finally { t.db.close(); }
});

test('portadas: reiniciarPortada nunca lanza (D1 sin las columnas de la 087 o R2 caído) y retomar o dar de alta una foto sigue funcionando', async () => {
  const t = tienda(); const registros: string[] = []; const error = console.error;
  console.error = (l: string) => { registros.push(l); };
  try {
    const base = t.env.DB; const r2 = t.env.FOTOS;
    // Código desplegado antes que la migración: ninguna sentencia de portadas puede ejecutarse.
    (t.env as any).DB = { ...base, prepare: (sql: string) => { if (/portada_/.test(sql)) throw new Error('no such column: portada_origen'); return base.prepare(sql); }, batch: base.batch };
    await reiniciarPortada(t.env, PRODUCTO_PRUEBA);
    assert.match(registros[0], /"mensaje":"reiniciarPortada fallido"/);
    const subir = (form: FormData) => worker.fetch!(new Request('https://caja.prueba/api/borradores', { method: 'POST', body: form }) as never, t.env, t.ctx as never);
    const foto = (id: string, extra: Record<string, string> = {}) => {
      const f = new FormData(); f.append('id', id); f.append('estado_fisico', 'nuevo');
      f.append('foto', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], `${id}.jpg`, { type: 'image/jpeg' }));
      for (const [k, v] of Object.entries(extra)) f.append(k, v);
      return f;
    };
    // Los dos sitios del Worker: pieza nueva y «Retomar foto».
    const id = crypto.randomUUID();
    assert.equal((await subir(foto(id, { cantidad: '2' }))).status, 201);
    assert.equal((await subir(foto(id, { solo_foto: '1' }))).status, 200);
    await t.esperar();
    assert.ok(registros.length >= 3);
    // R2 caído al borrar.
    (t.env as any).DB = base;
    (t.env as any).FOTOS = { ...r2, delete: async () => { throw new Error('R2 caído'); }, get: r2.get.bind(r2), put: r2.put.bind(r2), list: r2.list.bind(r2) };
    await reiniciarPortada(t.env, id);
    assert.match(registros.at(-1)!, /R2 caído/);
  } finally { console.error = error; t.db.close(); }
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
    assert.deepEqual(exacta(t), { ok: true, problemas: [], intentos: 1, tokens: T1, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
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
    assert.deepEqual(exacta(t), { ok: true, problemas: [], intentos: 1, tokens: T1, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
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
    assert.deepEqual(exacta(t), { ok: true, problemas: [], intentos: 2, tokens: { entrada: 2600, salida: 2240 }, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
    assert.equal(fila(t).portada_estado, 'revisar');
  } finally { t.db.close(); }
  t = await preparar(1); d = dependencias([malo, { ...malo, problemas: ['texto distinto'] }]);
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(d.llamadas.generar.length, 2);
    assert.deepEqual(exacta(t), { ok: false, problemas: ['texto distinto'], intentos: 2, tokens: { entrada: 2600, salida: 2240 }, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
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
    assert.deepEqual(exacta(t), { ok: false, problemas: ['etiqueta de precio sobre el producto'], intentos: 1, tokens: T1, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
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
    assert.deepEqual(exacta(t), { ok: false, problemas: ['forma distinta'], intentos: 1, tokens: T1, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
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
      assert.equal(aviso(t).id, uuid(0), mensaje);   // #898: lo que los agentes pueden leer desde D1
      assert.match(aviso(t).mensaje, new RegExp(mensaje.slice(0, 12)));
    } finally { t.db.close(); }
  }
  const t = await preparar(1); const d = dependencias([OK], async () => { throw new Error('Gemini 400: imagen inválida'); });
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(fila(t).portada_estado, 'error');
    assert.match(revision(t).problemas[0], /400/);
    assert.equal(aviso(t), null, 'un 4xx es culpa de la pieza, no del proveedor');
  } finally { t.db.close(); }
});

const aviso = (t: ReturnType<typeof tienda>) => { const f = t.db.prepare("select valor from config where clave='portadas_ultimo_aviso'").get(); return f ? JSON.parse(f.valor) : null; };
const generadas = (t: ReturnType<typeof tienda>) => t.db.prepare('select valor from config where clave=?').get(`portadas_generadas_${hoyTienda()}`)?.valor;

test('portadas: un 401/403 del generador detiene la corrida sin marcar la pieza ni gastar el tope, y deja el aviso en config (#898)', async () => {
  const HTTP = (status: number) => Object.assign(new Error(`${status} {"error":"x"}`), { status });   // como los errores del SDK de Anthropic
  for (const error of [new Error('Gemini 403: This API method requires billing to be enabled'), new Error('Gemini 401: API key not valid'), HTTP(401), HTTP(403)]) {
    const t = await preparar(3, { portadas_activo: '1' });
    t.db.prepare('insert into config (clave,valor) values (?,?)').run(`portadas_generadas_${hoyTienda()}`, '5');
    const d = dependencias([OK], async () => { throw error; });
    try {
      await procesarPortadas(t.env, d.deps);
      assert.equal(d.llamadas.generar.length, 1, 'las demás piezas no se intentan');
      assert.deepEqual([0, 1, 2].map((i) => fila(t, uuid(i)).portada_estado), [null, null, null]);
      assert.equal(generadas(t), '5', 'el lugar gastado se devolvió');
      assert.deepEqual(llaves(t), []);
      const a = aviso(t);
      assert.deepEqual(Object.keys(a).sort(), ['en', 'id', 'mensaje', 'status']);
      assert.ok(!Number.isNaN(Date.parse(a.en)));
      assert.equal(a.id, uuid(0));
      assert.equal(a.status, Number(/\d{3}/.exec(error.message)![0]));
      assert.equal(a.mensaje, error.message.slice(0, 300));
    } finally { t.db.close(); }
  }
});

test('portadas: el aviso no guarda la llave ni la URL de la petición y recorta el mensaje a 300 caracteres (#898)', async () => {
  const t = await preparar(1); const d = dependencias([OK], async () => { throw new Error(`Gemini 403: ${'x'.repeat(400)} https://aiplatform.googleapis.com/v1/x:generateContent?key=SECRETA`); });
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(aviso(t).mensaje.length, 300);
    const e = dependencias([OK], async () => { throw new Error('fetch failed https://aiplatform.googleapis.com/v1/x:generateContent?key=SECRETA&alt=json'); });
    await procesarPortadas(t.env, e.deps);
    assert.doesNotMatch(t.db.prepare("select valor from config where clave='portadas_ultimo_aviso'").get()!.valor, /SECRETA/);
  } finally { t.db.close(); }
});

test('portadas: un 403 del comprobador con la imagen ya pagada deja la pieza pendiente con la cruda, y la siguiente corrida no vuelve a generar (#898)', async () => {
  const t = await preparar(1); const d = dependencias(); let cerrado = true;
  const comprobar = d.deps.comprobar;
  d.deps.comprobar = async (...args) => { if (cerrado) throw Object.assign(new Error('403 forbidden'), { status: 403 }); return comprobar(...args); };
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(fila(t).portada_estado, null);
    assert.deepEqual(llaves(t), [`portadas/${uuid(0)}.cruda`]);
    assert.equal(generadas(t), '1', 'la imagen ya se pagó: el lugar no se devuelve');
    assert.deepEqual([aviso(t).id, aviso(t).status], [uuid(0), 403]);
    cerrado = false;
    await procesarPortadas(t.env, d.deps);
    assert.equal(d.llamadas.generar.length, 1);
    assert.equal(fila(t).portada_estado, 'revisar');
    assert.equal(generadas(t), '1');
  } finally { t.db.close(); }
});

test('portadas: la cuota de IMAGES (9422) también deja el aviso, con status null (#898)', async () => {
  const t = await preparar(1); const { deps } = dependencias();
  try {
    (t.env as any).IMAGES = imagenes(() => new Error('9422 quota exceeded'));
    await procesarPortadas(t.env, deps);
    assert.deepEqual({ ...aviso(t), en: 0 }, { en: 0, id: uuid(0), status: null, mensaje: '9422 quota exceeded' });
  } finally { t.db.close(); }
});

test('portadas: si no se puede escribir el aviso, la corrida hace lo mismo de siempre y no lanza (#898)', async () => {
  const t = await preparar(2); const d = dependencias([OK], async () => { throw new Error('Gemini 403: billing'); });
  const registros: string[] = []; const error = console.error;
  console.error = (l: string) => { registros.push(l); };
  try {
    const base = t.env.DB;
    (t.env as any).DB = { ...base, prepare: (sql: string) => { if (/portadas_ultimo_aviso/.test(sql)) throw new Error('D1 caída'); return base.prepare(sql); }, batch: base.batch };
    await procesarPortadas(t.env, d.deps);
    assert.equal(d.llamadas.generar.length, 1);
    assert.deepEqual([0, 1].map((i) => fila(t, uuid(i)).portada_estado), [null, null]);
    assert.equal(generadas(t), '0');
    assert.ok(registros.some((l) => l.includes('D1 caída')));
  } finally { console.error = error; t.db.close(); }
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
    // Retomó la imagen ya pagada: esta corrida no generó, así que no se anota costo ni tiempo de generar (#895).
    assert.deepEqual(exacta(t), { ok: true, problemas: [], intentos: 1, tokens: { entrada: 0, salida: 0 }, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
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
    assert.deepEqual({ ...revision(t), problemas: [] }, { ok: false, problemas: [], intentos: 0, tokens: { entrada: 0, salida: 0 }, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
    assert.deepEqual(llaves(t), []);
  } finally { t.db.close(); }
});

test('portadas: si comprobar falla con un 4xx después de generar, el error conserva lo gastado', async () => {
  const t = await preparar(1);
  const d = dependencias(); d.deps.comprobar = async () => { throw new Error('Gemini 400: imagen inválida'); };
  try {
    await procesarPortadas(t.env, d.deps);
    assert.equal(fila(t).portada_estado, 'error');
    assert.deepEqual({ ...exacta(t), problemas: [] }, { ok: false, problemas: [], intentos: 0, tokens: T1, ms_generar: 0, ms_comprobar: 0, modelo: MODELO });
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
