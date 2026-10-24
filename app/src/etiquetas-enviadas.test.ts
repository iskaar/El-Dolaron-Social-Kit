// node --test src/etiquetas-enviadas.test.ts
// Imprimir desde el celular en /inventario (Issue #440): permisos del host del capturista, y el registro compartido
// `etiquetas_enviadas` (migración 049) con el que la PC y el celular no sacan la misma etiqueta dos veces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tienda, DUENO, PRODUCTO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { permiso, puede } from './cuentas.ts';

const CELULAR = 'captura.prueba';   // HOST_VENDEDOR; la PC entra por caja.prueba (el host de prueba.d1)
const CAPTURISTA = 'cap@prueba.mx', CAJERO = 'caja@prueba.mx', FEP = 'fep@prueba.mx';

function montar() {
  const t = tienda();
  t.env.HOST_VENDEDOR = CELULAR;
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    (?, 'Cap', 'capturista', 1, '', ''), (?, 'Caja', 'cajero', 1, '', ''), (?, 'FEP', 'finanzas', 1, '', '')`).run(CAPTURISTA, CAJERO, FEP);
  let n = 100;
  const pieza = (campos: Record<string, unknown> = {}) => {
    const fila = { id: crypto.randomUUID(), codigo: `ED-${String(++n).padStart(6, '0')}`, nombre: 'Playera azul', precio: 9900, precio_lista: 0,
      stock: 3, talla: 'M', capturado_por: CAPTURISTA, creado_en: new Date().toISOString(), estado_analisis: 'listo', ...campos };
    t.db.prepare(`insert into productos (id, codigo, nombre, categoria, precio, precio_lista, stock, talla, semana_ingreso, capturado_por, creado_en, actualizado_en, estado_analisis)
      values (?, ?, ?, 'ropa', ?, ?, ?, ?, 'S42', ?, ?, ?, ?)`)
      .run(fila.id, fila.codigo, fila.nombre, fila.precio, fila.precio_lista, fila.stock, fila.talla, fila.capturado_por, fila.creado_en, fila.creado_en, fila.estado_analisis);
    return fila.id as string;
  };
  const como = (correo: string) => { (t.env as unknown as { DEV_USUARIO: string }).DEV_USUARIO = correo; };
  /** Una petición por el host del celular (como el capturista) o por el de la PC. */
  const por = async (host: string, ruta: string, cuerpo?: unknown, metodo = 'POST') => {
    const r = await worker.fetch!(new Request(`https://${host}${ruta}`, cuerpo === undefined ? {} : {
      method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) }) as never, t.env, t.ctx as never);
    return { status: r.status, cuerpo: (await r.clone().json().catch(() => ({}))) as Record<string, any> };
  };
  const celular = (ruta: string, cuerpo?: unknown, metodo = 'POST') => por(CELULAR, ruta, cuerpo, metodo);
  /** La hora del reclamo vigente de una pieza: lo que un dispositivo manda en `etiquetas_en` para soltarlo. */
  const sello = (id: string) => (t.db.prepare('select etiqueta_en e from etiquetas_enviadas where producto_id = ?').get(id) as { e: string } | undefined)?.e as string;
  return { ...t, t, pieza, como, celular, pc: t.pedir, sello };
}

test('el host del celular sirve la pestaña Imprimir y deja pasar solo las API de etiquetas que necesita (#440)', () => {
  for (const ruta of ['/inventario-imprimir.js', '/imprimir-lote.js', '/etiquetera.js', '/impresora.js', '/code128.js', '/envio-etiquetas.js']) {
    assert.equal(permitidaParaVendedor(ruta, 'GET'), true, ruta);
    assert.equal(permitidaParaVendedor(ruta, 'POST'), false, `POST ${ruta}`);
  }
  const abiertas: [string, string][] = [['/api/calibracion', 'GET'], ['/api/etiquetas', 'POST'], ['/api/etiquetas/enviadas', 'POST'], ['/api/etiquetas/enviadas', 'DELETE']];
  for (const [ruta, metodo] of abiertas) assert.equal(permitidaParaVendedor(ruta, metodo), true, `${metodo} ${ruta}`);
  // Lo que sigue siendo de la PC: calibrar, listar, la pantalla /etiquetas, bandas, configuración.
  const cerradas: [string, string][] = [['/api/calibracion', 'PUT'], ['/api/calibracion', 'POST'], ['/api/etiquetas', 'GET'], ['/api/etiquetas', 'DELETE'],
    ['/api/etiquetas/enviadas', 'GET'], ['/api/etiquetas/enviadas', 'PUT'], ['/api/etiquetas/otra', 'POST'], ['/etiquetas', 'GET'], ['/calibrar-etiqueta', 'GET'],
    ['/prueba-codigo', 'GET'], ['/sonda-impresora', 'GET'], ['/bandas', 'GET'], ['/api/config', 'GET'], ['/api/familias', 'POST']];
  for (const [ruta, metodo] of cerradas) assert.equal(permitidaParaVendedor(ruta, metodo), false, `${metodo} ${ruta}`);
});

test('permisos por rol de las API de etiquetas: dueño, capturista y FEP sí; cajero y auxiliar no; calibrar solo quien captura', () => {
  const usuario = (rol: string) => ({ correo: 'x@y.mx', nombre: '', roles: [rol] as never, activo: true, caja: '' });
  for (const [ruta, metodo] of [['/api/etiquetas', 'POST'], ['/api/etiquetas/enviadas', 'POST'], ['/api/etiquetas/enviadas', 'DELETE'], ['/api/calibracion', 'GET']] as const) {
    for (const rol of ['dueno', 'capturista', 'finanzas']) assert.equal(puede(usuario(rol), permiso(ruta, metodo)), true, `${rol} ${metodo} ${ruta}`);
    for (const rol of ['cajero', 'auxiliar', 'computadora']) assert.equal(puede(usuario(rol), permiso(ruta, metodo)), false, `${rol} ${metodo} ${ruta}`);
  }
  assert.equal(puede(usuario('finanzas'), permiso('/api/calibracion', 'PUT')), false);
  assert.equal(puede(usuario('capturista'), permiso('/api/calibracion', 'PUT')), true);
});

test('por el host del celular: capturista y dueño imprimen, el cajero no; calibrar, listar y /etiquetas dan 404 (#440)', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    for (const quien of [CAPTURISTA, DUENO]) {
      p.como(quien);
      assert.equal((await p.celular('/api/etiquetas', { ids: [id] })).status, 200, quien);
      assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id] })).status, 200, quien);
      assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id], etiquetas_en: { [id]: p.sello(id) } }, 'DELETE')).status, 200, quien);
      assert.equal((await p.celular('/api/calibracion', undefined, 'GET')).status, 200, quien);
    }
    p.como(CAPTURISTA);
    assert.equal((await p.celular('/api/calibracion', { corrimiento: 5 }, 'PUT')).status, 404);
    assert.equal((await p.celular('/api/etiquetas', undefined, 'GET')).status, 404);
    assert.equal((await p.celular('/api/etiquetas/enviadas', undefined, 'GET')).status, 404);
    assert.equal((await p.celular('/etiquetas', undefined, 'GET')).status, 404);
    assert.equal((await p.celular('/api/config')).status, 404);
    p.como(CAJERO);
    for (const [ruta, cuerpo, metodo] of [['/api/etiquetas', { ids: [id] }, 'POST'], ['/api/etiquetas/enviadas', { ids: [id] }, 'POST'],
      ['/api/etiquetas/enviadas', { ids: [id] }, 'DELETE'], ['/api/calibracion', undefined, 'GET']] as const) {
      assert.equal((await p.celular(ruta, cuerpo, metodo)).status, 403, `cajero ${metodo} ${ruta}`);
      assert.equal((await p.pc(ruta, cuerpo, metodo)).status, 403, `cajero en la PC ${metodo} ${ruta}`);
    }
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);
  } finally { p.db.close(); }
});

test('/api/yo: el celular del capturista ofrece Imprimir; el cajero y los demás roles ninguno (#440)', async () => {
  const p = montar();
  try {
    p.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values ('aux@prueba.mx', 'Aux', 'auxiliar', 1, '', '')`).run();
    for (const [quien, modos] of [[CAPTURISTA, ['capturar', 'buscar', 'revisar', 'imprimir']], [DUENO, ['capturar', 'buscar', 'revisar', 'imprimir']],
      [FEP, ['capturar', 'buscar', 'imprimir']], [CAJERO, []], ['aux@prueba.mx', []]] as const) {
      p.como(quien);
      for (const via of [(r: string) => p.celular(r), (r: string) => p.pc(r)]) assert.deepEqual((await via('/api/yo')).cuerpo.modos_inventario, modos, quien);
    }
  } finally { p.db.close(); }
});

test('FEP imprime solo sus piezas, por la PC o por el celular; no ve, reclama ni suelta las de El Dolarón, y al revés (#440)', async () => {
  const p = montar();
  try {
    const mia = p.pieza({ capturado_por: FEP }), deLaTienda = p.pieza();
    p.db.prepare("update productos set propietario = 'fep' where id = ?").run(mia);
    p.como(FEP);
    for (const via of [p.celular, (r: string, c?: unknown, m?: string) => p.pc(r, c, m)]) {
      const preparadas = (await via('/api/etiquetas', { ids: [mia, deLaTienda] })).cuerpo as unknown as { id: string }[];
      assert.deepEqual(preparadas.map((x) => x.id), [mia]);
      const reclamo = (await via('/api/etiquetas/enviadas', { ids: [mia, deLaTienda], reimprimir: true })).cuerpo;
      assert.deepEqual(reclamo.reclamadas, [mia]);
      assert.deepEqual(Object.keys(reclamo.marcas), [mia]);
    }
    // Lo de la tienda lo marca el dueño; FEP no puede soltarlo ni verlo en la respuesta.
    p.como(DUENO);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [deLaTienda, mia] })).cuerpo.reclamadas, [deLaTienda]);
    p.como(FEP);
    assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [deLaTienda], etiquetas_en: { [deLaTienda]: p.sello(deLaTienda) } }, 'DELETE')).cuerpo.soltadas, 0);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas where producto_id = ?').get(deLaTienda)!.n, 1);
    p.como(DUENO);
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [mia], etiquetas_en: { [mia]: p.sello(mia) } }, 'DELETE')).cuerpo.soltadas, 0);   // lo de FEP tampoco
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas where producto_id = ?').get(mia)!.n, 1);
  } finally { p.db.close(); }
});

test('la calibración se lee con solo sus dos claves, también en el host del celular (la AE240 imprime con su corrimiento)', async () => {
  const p = montar();
  try {
    assert.deepEqual((await p.pc('/api/calibracion', undefined, 'GET')).cuerpo, {});   // sin calibrar: no se inventa nada
    await p.pc('/api/calibracion', { corrimiento: -12, modulo: 3 }, 'PUT');
    await p.pc('/api/config', { pct_ropa: 40 }, 'PUT');
    const esperado = { etiqueta_corrimiento: '-12', etiqueta_modulo: '3' };
    assert.deepEqual((await p.pc('/api/calibracion', undefined, 'GET')).cuerpo, esperado);
    p.como(CAPTURISTA);
    assert.deepEqual((await p.celular('/api/calibracion', undefined, 'GET')).cuerpo, esperado);
  } finally { p.db.close(); }
});

test('migración 049: ya corrió en sandbox y prod (23/10); encabezado ejecutable, una sentencia, aditiva y repetible', () => {
  const p = montar();
  try {
    const sql = readFileSync('migracion-049-etiqueta-impresa.sql', 'utf8');
    assert.match(sql, /-- npx wrangler d1 execute el-dolaron-sandbox .*--file=migracion-049-etiqueta-impresa.sql/);
    assert.match(sql, /-- npx wrangler d1 execute el-dolaron --remote --file=migracion-049-etiqueta-impresa.sql/);
    for (const linea of sql.split('\n')) if (!linea.trimStart().startsWith('--')) assert.ok(!linea.includes('--'));
    p.db.exec('drop table etiquetas_enviadas; pragma foreign_keys=on;');
    const esquema = p.db.prepare('select * from sqlite_master order by name').all();
    const datos = p.db.prepare('select * from productos order by id').all();
    p.db.exec(sql);
    p.db.prepare("insert into etiquetas_enviadas values (?, 'hoy', 9900, 0, 'Playera', 'M', 'pc')").run(p.pieza());
    const marca = p.db.prepare('select * from etiquetas_enviadas').all();
    p.db.exec(sql);
    assert.deepEqual(p.db.prepare('select * from etiquetas_enviadas').all(), marca);
    assert.deepEqual(p.db.prepare("select * from sqlite_master where name not like '%etiquetas_enviadas%' order by name").all(), esquema);
    for (const fila of datos) assert.deepEqual(p.db.prepare('select * from productos where id=?').get(fila.id!), fila);
    assert.deepEqual(p.db.prepare('pragma foreign_key_check').all(), []);
  } finally { p.db.close(); }
});

test('reclamar: gana el primero y el segundo se omite, sea PC o celular; un cambio en la etiqueta la deja pasar otra vez', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    const primero = (await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo;
    assert.deepEqual(primero.reclamadas, [id]);
    assert.equal(primero.marcas[id].etiqueta_origen, 'pc');
    p.como(CAPTURISTA);
    const segundo = (await p.celular('/api/etiquetas/enviadas', { ids: [id] })).cuerpo;
    assert.deepEqual(segundo.reclamadas, []);
    assert.equal(segundo.marcas[id].etiqueta_origen, 'pc');   // dice quién la sacó
    assert.equal(segundo.marcas[id].etiqueta_en, primero.marcas[id].etiqueta_en);
    // Lo que se ve en la etiqueta cambió: precio, precio tachado, nombre o talla -> sale otra, una sola vez.
    for (const [columna, valor] of [['precio', 8900], ['precio_lista', 20000], ['nombre', 'Playera roja'], ['talla', 'L']] as const) {
      p.db.prepare(`update productos set ${columna} = ? where id = ?`).run(valor, id);
      const celular = await p.celular('/api/etiquetas/enviadas', { ids: [id] });
      assert.deepEqual(celular.cuerpo.reclamadas, [id], columna);
      assert.equal(celular.cuerpo.marcas[id].etiqueta_origen, 'celular');
      assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, [], `${columna} otra vez`);
    }
    // Un precio de lista que no es mayor no se imprime tachado: cambiarlo no cambia la etiqueta.
    p.db.prepare('update productos set precio_lista = 100 where id = ?').run(id);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, [id]);
    p.db.prepare('update productos set precio_lista = 200 where id = ?').run(id);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, []);
    // Espacios alrededor del nombre no cuentan, como en textoImpreso.
    p.db.prepare("update productos set nombre = '  Playera roja ' where id = ?").run(id);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, []);
  } finally { p.db.close(); }
});

test('dos reclamos a la vez, uno por la PC y otro por el celular: gana uno solo y la base queda con una fila', async () => {
  const p = montar();
  try {
    p.como(CAPTURISTA);
    for (let i = 0; i < 20; i++) {
      const id = p.pieza();
      const [a, b] = await Promise.all([p.pc('/api/etiquetas/enviadas', { ids: [id] }), p.celular('/api/etiquetas/enviadas', { ids: [id] })]);
      assert.equal(a.cuerpo.reclamadas.length + b.cuerpo.reclamadas.length, 1, `ronda ${i}`);
      assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas where producto_id = ?').get(id)!.n, 1);
    }
  } finally { p.db.close(); }
});

test('en un lote, lo no reclamable no tumba lo reclamable ni deja filas: se verifica pieza por pieza (changes)', async () => {
  const p = montar();
  try {
    const buena = p.pieza(), otraBuena = p.pieza(), previa = p.pieza();
    await p.pc('/api/etiquetas/enviadas', { ids: [previa] });
    const sinCodigo = p.pieza({ codigo: null }), sinStock = p.pieza({ stock: 0 }), pendiente = p.pieza({ estado_analisis: 'pendiente' });
    const r = (await p.pc('/api/etiquetas/enviadas', { ids: [sinCodigo, buena, previa, sinStock, pendiente, otraBuena] })).cuerpo;
    assert.deepEqual(r.reclamadas, [buena, otraBuena]);
    assert.deepEqual(Object.keys(r.marcas).sort(), [buena, otraBuena, previa].sort());
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 3);
  } finally { p.db.close(); }
});

test('reimprimir actualiza el reclamo y deja salir otra vez; ids inválidos o ajenos no reclaman nada', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    const primera = (await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.marcas[id].etiqueta_en;
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id], reimprimir: 'si' })).cuerpo.reclamadas, []);   // solo true cuenta
    await new Promise((r) => setTimeout(r, 5));
    const forzada = (await p.celular('/api/etiquetas/enviadas', { ids: [id], reimprimir: true })).cuerpo;
    assert.deepEqual(forzada.reclamadas, [id]);
    assert.equal(forzada.marcas[id].etiqueta_origen, 'celular');   // el reclamo ahora es del celular
    assert.ok(forzada.marcas[id].etiqueta_en > primera);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, []);   // y la PC no la repite
    const descartada = p.pieza({ estado_analisis: 'descartado' });
    const r = (await p.pc('/api/etiquetas/enviadas', { ids: [descartada] })).cuerpo;
    assert.deepEqual([r.reclamadas, r.marcas], [[], {}]);
    for (const ids of [[], 'x', ['no-es-uuid'], Array.from({ length: 101 }, () => crypto.randomUUID())]) {
      assert.equal((await p.pc('/api/etiquetas/enviadas', { ids })).status, 400, JSON.stringify(ids).slice(0, 30));
      assert.equal((await p.pc('/api/etiquetas/enviadas', { ids }, 'DELETE')).status, 400);
    }
    assert.equal((await p.pc('/api/etiquetas/enviadas', null)).status, 400);
  } finally { p.db.close(); }
});

test('la versión del papel preparado: si la pieza cambió entre preparar y reclamar, no se reclama', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    const preparada = ((await p.pc('/api/etiquetas', { ids: [id] })).cuerpo as unknown as { etiqueta_version: string }[])[0];
    assert.ok(preparada.etiqueta_version);
    p.db.prepare('update productos set precio = 8800 where id = ?').run(id);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id], version: preparada.etiqueta_version })).cuerpo.reclamadas, []);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);
    const nueva = ((await p.pc('/api/etiquetas', { ids: [id] })).cuerpo as unknown as { etiqueta_version: string }[])[0];
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id], version: nueva.etiqueta_version })).cuerpo.reclamadas, [id]);
    // La versión solo vale para una pieza, y debe ser texto.
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id, p.pieza()], version: 'x' })).status, 400);
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id], version: 5 })).status, 400);
  } finally { p.db.close(); }
});

test('/api/etiquetas con reclamar:true prepara y reclama en una llamada; sin reclamar sigue devolviendo la lista (#492)', async () => {
  const p = montar();
  try {
    const sinCodigo = p.pieza({ stock: 2 }), conCodigo = p.pieza(), vendida = p.pieza({ stock: 0 });
    p.db.prepare("update productos set codigo = null where id = ?").run(sinCodigo);
    const sola = await p.pc('/api/etiquetas', { ids: [conCodigo] });
    assert.ok(Array.isArray(sola.cuerpo), 'sin reclamar: la lista de siempre');
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);
    const r = await p.pc('/api/etiquetas', { ids: [sinCodigo, conCodigo, vendida], reclamar: true, origen: 'celular' });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.cuerpo).sort(), ['ahora', 'marcas', 'piezas', 'reclamadas']);
    assert.deepEqual(r.cuerpo.piezas.map((x: any) => x.id), [sinCodigo, conCodigo, vendida]);
    assert.match(r.cuerpo.piezas[0].codigo, /^ED-\d{6}$/, 'el código se asigna en la misma llamada');
    assert.ok(r.cuerpo.piezas.every((x: any) => x.etiqueta_version));
    assert.deepEqual(r.cuerpo.reclamadas, [sinCodigo, conCodigo], 'la vendida no se reclama');
    assert.deepEqual(Object.keys(r.cuerpo.marcas).sort(), [sinCodigo, conCodigo].sort());
    assert.equal(p.db.prepare('select etiqueta_origen o from etiquetas_enviadas where producto_id=?').get(sinCodigo)!.o, 'celular');
    assert.equal(p.sello(sinCodigo), r.cuerpo.ahora);
    // La hora devuelta permite soltar, y soltar deja volver a reclamar.
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [sinCodigo], etiquetas_en: { [sinCodigo]: r.cuerpo.ahora } }, 'DELETE')).cuerpo.soltadas, 1);
    assert.deepEqual((await p.pc('/api/etiquetas', { ids: [sinCodigo, conCodigo], reclamar: true })).cuerpo.reclamadas, [sinCodigo]);
    // Reimprimir explícito: reclama otra vez lo que ya estaba reclamado.
    assert.deepEqual((await p.pc('/api/etiquetas', { ids: [sinCodigo], reclamar: true })).cuerpo.reclamadas, []);
    assert.deepEqual((await p.pc('/api/etiquetas', { ids: [sinCodigo], reclamar: true, reimprimir: true })).cuerpo.reclamadas, [sinCodigo]);
    // Sin piezas utilizables no falla.
    p.db.prepare("update productos set estado_analisis = 'descartado' where id = ?").run(conCodigo);
    const vacia = await p.pc('/api/etiquetas', { ids: [conCodigo], reclamar: true });
    assert.deepEqual([vacia.status, vacia.cuerpo.piezas, vacia.cuerpo.reclamadas], [200, [], []]);
  } finally { p.db.close(); }
});

test('lote de 100 con reclamar:true y dos dispositivos a la vez: cada etiqueta se reclama una sola vez (#492)', async () => {
  const p = montar();
  try {
    const ids = Array.from({ length: 100 }, () => p.pieza());
    const [pc, celular] = await Promise.all([p.pc('/api/etiquetas', { ids, reclamar: true, origen: 'pc' }), p.celular('/api/etiquetas', { ids, reclamar: true, origen: 'celular' })]);
    assert.equal(pc.cuerpo.piezas.length, 100);
    assert.equal(pc.cuerpo.reclamadas.length + celular.cuerpo.reclamadas.length, 100);
    assert.deepEqual([...pc.cuerpo.reclamadas, ...celular.cuerpo.reclamadas].sort(), [...ids].sort());
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 100);
    // Una tercera vez ya no reclama nada y devuelve la marca de quien ganó.
    const otra = await p.pc('/api/etiquetas', { ids, reclamar: true });
    assert.deepEqual(otra.cuerpo.reclamadas, []);
    assert.equal(Object.keys(otra.cuerpo.marcas).length, 100);
    assert.equal((await p.pc('/api/etiquetas', { ids: [...ids, p.pieza()], reclamar: true })).status, 400);
  } finally { p.db.close(); }
});

test('reclamar:true exige la versión del papel que acaba de leer: si la pieza cambia entre leer y reclamar, no se reclama (#492)', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    const batch = p.env.DB.batch.bind(p.env.DB);
    (p.env.DB as any).batch = async (sentencias: unknown[]) => {
      p.db.prepare('update productos set precio = 8800 where id = ?').run(id);   // una edición justo antes del reclamo
      return batch(sentencias as never);
    };
    const r = await p.pc('/api/etiquetas', { ids: [id], reclamar: true });
    assert.equal(r.cuerpo.piezas[0].precio, 9900, 'se devolvió el papel leído');
    assert.deepEqual(r.cuerpo.reclamadas, []);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);
  } finally { p.db.close(); }
});

test('soltar borra la marca para que la etiqueta pueda volver a salir, también desde el celular; solo piezas del mismo propietario', async () => {
  const p = montar();
  try {
    const id = p.pieza(), fep = p.pieza();
    p.db.prepare("update productos set propietario = 'fep' where id = ?").run(fep);
    p.db.prepare("insert into etiquetas_enviadas values (?, 'x', 1, 0, 'n', '', 'pc')").run(fep);
    await p.pc('/api/etiquetas/enviadas', { ids: [id] });
    p.como(CAPTURISTA);
    assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id, fep], etiquetas_en: { [id]: p.sello(id), [fep]: p.sello(fep) } }, 'DELETE')).cuerpo.soltadas, 1);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 1);   // la de FEP no se toca
    assert.deepEqual((await p.celular('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, [id]);
    const sello = p.sello(id);
    assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id], etiquetas_en: { [id]: sello } }, 'DELETE')).cuerpo.soltadas, 1);
    assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id], etiquetas_en: { [id]: sello } }, 'DELETE')).cuerpo.soltadas, 0);   // soltar dos veces es inofensivo
  } finally { p.db.close(); }
});

test('/api/borradores trae lo que dice la etiqueta ya enviada y quién la sacó, y null si no ha salido; funciona con la tabla vacía', async () => {
  const p = montar();
  try {
    const sale = p.pieza({ precio_lista: 19900 }), noSale = p.pieza();
    const desde = new Date(Date.now() - 60_000).toISOString();
    for (const filtro of ['', '?estado=listo', `?desde=${desde}`, `?desde=${desde}&cambios=${desde}`]) {
      const r = await p.pc(`/api/borradores${filtro}`);
      assert.equal(r.status, 200, filtro);
      assert.equal(r.cuerpo.find((x: any) => x.id === sale).etiqueta_en, null);
    }
    await p.pc('/api/etiquetas/enviadas', { ids: [sale] });
    const lista = (await p.pc('/api/borradores?estado=listo')).cuerpo as unknown as any[];
    const porId = (id: string) => lista.find((x) => x.id === id);
    assert.deepEqual([porId(sale).etiqueta_precio, porId(sale).etiqueta_precio_lista, porId(sale).etiqueta_nombre, porId(sale).etiqueta_talla, porId(sale).etiqueta_origen],
      [9900, 19900, 'Playera azul', 'M', 'pc']);
    assert.ok(porId(sale).etiqueta_en);
    assert.equal(porId(noSale).etiqueta_en, null);
    assert.equal(lista.filter((x) => x.id === sale).length, 1);   // el join no duplica filas
  } finally { p.db.close(); }
});

test('los lotes de 100 piezas respetan los 100 parámetros por sentencia de D1', async () => {
  const p = montar();
  try {
    const preparar = p.env.DB.prepare.bind(p.env.DB);
    p.env.DB.prepare = (sql: string) => {
      const s = preparar(sql), bind = s.bind.bind(s);
      s.bind = (...args: unknown[]) => { assert.ok(args.length <= 100, `${args.length} parámetros exceden el límite de D1`); return bind(...args); };
      return s;
    };
    const ids = Array.from({ length: 100 }, () => p.pieza({ codigo: null }));
    p.como(CAPTURISTA);
    const preparadas = await p.celular('/api/etiquetas', { ids });
    assert.equal(preparadas.status, 200);
    assert.equal(preparadas.cuerpo.length, 100);
    const reclamo = await p.celular('/api/etiquetas/enviadas', { ids });
    assert.equal(reclamo.status, 200);
    assert.equal(reclamo.cuerpo.reclamadas.length, 100);
    const soltadas = await p.celular('/api/etiquetas/enviadas', { ids, etiquetas_en: Object.fromEntries(ids.map((i) => [i, reclamo.cuerpo.ahora])) }, 'DELETE');
    assert.equal(soltadas.status, 200);
    assert.equal(soltadas.cuerpo.soltadas, 100);
  } finally { p.db.close(); }
});

test('soltar con etiquetas_en es condicional: borra solo si la fila sigue siendo ese reclamo, y nunca el de otra pantalla ni el de otro propietario (#464)', async () => {
  const p = montar();
  try {
    const id = p.pieza(), otra = p.pieza(), fep = p.pieza();
    p.db.prepare("update productos set propietario = 'fep' where id = ?").run(fep);
    p.db.prepare("insert into etiquetas_enviadas values (?, 'E-FEP', 1, 0, 'n', '', 'pc')").run(fep);
    const primero = (await p.pc('/api/etiquetas/enviadas', { ids: [id, otra] })).cuerpo.marcas;
    await new Promise((r) => setTimeout(r, 5));
    const segundo = (await p.celular('/api/etiquetas/enviadas', { ids: [id], reimprimir: true })).cuerpo.marcas[id].etiqueta_en;   // reclamo posterior de otra pantalla
    assert.notEqual(segundo, primero[id].etiqueta_en);
    // La pantalla que reclamó primero ya no es la dueña de la fila de `id`, pero sí la de `otra`.
    const r = await p.pc('/api/etiquetas/enviadas', { ids: [id, otra, fep], etiquetas_en: { [id]: primero[id].etiqueta_en, [otra]: primero[otra].etiqueta_en, [fep]: 'E-FEP' } }, 'DELETE');
    assert.equal(r.status, 200);
    assert.equal(r.cuerpo.soltadas, 1);
    assert.equal(p.db.prepare('select etiqueta_en e from etiquetas_enviadas where producto_id = ?').get(id)!.e, segundo);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas where producto_id = ?').get(otra)!.n, 0);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas where producto_id = ?').get(fep)!.n, 1);   // propietario ajeno
    // Sin hora para la pieza no se toca; con la hora vigente sí.
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id], etiquetas_en: {} }, 'DELETE')).cuerpo.soltadas, 0);
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id], etiquetas_en: { [id]: segundo } }, 'DELETE')).cuerpo.soltadas, 1);
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id], etiquetas_en: { [id]: segundo } }, 'DELETE')).cuerpo.soltadas, 0);
    for (const etiquetas_en of ['x', [id], { [id]: 5 }, { [id]: '' }, { [id]: 'x'.repeat(41) }]) {
      assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id], etiquetas_en }, 'DELETE')).status, 400, JSON.stringify(etiquetas_en));
    }
  } finally { p.db.close(); }
});

test('soltar exige etiquetas_en: sin él es 400 y no borra nada, aunque sea la misma pantalla (#464)', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    await p.pc('/api/etiquetas/enviadas', { ids: [id] });
    for (const cuerpo of [{ ids: [id] }, { ids: [id], etiquetas_en: null }]) {
      assert.equal((await p.pc('/api/etiquetas/enviadas', cuerpo, 'DELETE')).status, 400, JSON.stringify(cuerpo));
      assert.equal((await p.celular('/api/etiquetas/enviadas', cuerpo, 'DELETE')).status, 400);
    }
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 1);
  } finally { p.db.close(); }
});

test('el reclamo devuelve su propia hora (ahora) y no la que otra pantalla escriba entre el batch y la lectura (#464)', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    let ganadora = '';
    const preparar = p.env.DB.prepare.bind(p.env.DB);
    p.env.DB.prepare = (sql: string) => {
      if (sql.includes('select producto_id, etiqueta_en')) {   // la lectura de marcas, justo después del batch
        ganadora = p.sello(id);
        p.db.prepare("update etiquetas_enviadas set etiqueta_en = '2099-01-01T00:00:00.000Z', etiqueta_origen = 'celular'").run();   // otra pantalla reclamó de nuevo
      }
      return preparar(sql);
    };
    const r = (await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo;
    assert.deepEqual(r.reclamadas, [id]);
    assert.equal(r.ahora, ganadora, 'la hora de ESTE reclamo');
    assert.equal(r.marcas[id].etiqueta_en, '2099-01-01T00:00:00.000Z');
    // Soltar con la hora devuelta no borra el reclamo posterior de la otra pantalla.
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id], etiquetas_en: { [id]: r.ahora } }, 'DELETE')).cuerpo.soltadas, 0);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 1);
  } finally { p.db.close(); }
});

/* ---------- lista corta de Imprimir y sondeo por lote (#493) ---------- */

test('pendientes: solo lo que falta por etiquetar (sin marca, o con marca que ya no dice lo mismo), en orden de captura (#493)', async () => {
  const p = montar();
  try {
    p.db.prepare('delete from productos where id = ?').run(PRODUCTO);   // la pieza de ejemplo de la tienda de prueba
    const hora = (n: number) => `2026-10-23T10:0${n}:00.000Z`;
    const nueva = p.pieza({ creado_en: hora(1) }), impresa = p.pieza({ creado_en: hora(2) }), conPrecio = p.pieza({ creado_en: hora(3) });
    const conNombre = p.pieza({ creado_en: hora(4) }), conTalla = p.pieza({ creado_en: hora(5) }), conTachado = p.pieza({ creado_en: hora(6) });
    const vendida = p.pieza({ creado_en: hora(7), stock: 0 }), sinPrecio = p.pieza({ creado_en: hora(8), precio: 0 });
    const pendienteIA = p.pieza({ creado_en: hora(9), estado_analisis: 'pendiente' }), banda = p.pieza({ creado_en: hora(0) });
    p.db.prepare("update productos set destino = 'banda_ju49' where id = ?").run(banda);
    p.como(DUENO);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [impresa, conPrecio, conNombre, conTalla, conTachado] })).cuerpo.reclamadas.length, 5);
    p.db.prepare('update productos set precio = 11900 where id = ?').run(conPrecio);
    p.db.prepare("update productos set nombre = 'Playera roja' where id = ?").run(conNombre);
    p.db.prepare("update productos set talla = 'L' where id = ?").run(conTalla);
    p.db.prepare('update productos set precio_lista = 15000 where id = ?').run(conTachado);
    const lista = (await p.pc('/api/etiquetas/pendientes', undefined, 'GET'));
    assert.equal(lista.status, 200);
    assert.deepEqual((lista.cuerpo as unknown as { id: string }[]).map((x) => x.id), [nueva, conPrecio, conNombre, conTalla, conTachado]);
    // Misma forma que la lista completa: lo que Imprimir y sincronizarMarcas ya leen (etiqueta_* incluidos).
    const completa = (await p.pc('/api/borradores?estado=listo', undefined, 'GET')).cuerpo as unknown as Record<string, unknown>[];
    assert.deepEqual((lista.cuerpo as unknown as Record<string, unknown>[])[1], completa.find((x) => x.id === conPrecio));
    // Un reclamo nuevo de la pieza cambiada la saca de la lista; soltar la marca de la impresa la regresa.
    await p.pc('/api/etiquetas/enviadas', { ids: [conPrecio] });
    await p.pc('/api/etiquetas/enviadas', { ids: [impresa], etiquetas_en: { [impresa]: p.sello(impresa) } }, 'DELETE');
    assert.deepEqual(((await p.pc('/api/etiquetas/pendientes', undefined, 'GET')).cuerpo as unknown as { id: string }[]).map((x) => x.id), [nueva, impresa, conNombre, conTalla, conTachado]);
  } finally { p.db.close(); }
});

test('pendientes: FEP solo ve lo suyo y al revés; el celular del capturista la lee y el cajero no (#493)', async () => {
  const p = montar();
  try {
    p.db.prepare('delete from productos where id = ?').run(PRODUCTO);
    const mia = p.pieza({ capturado_por: FEP }), deLaTienda = p.pieza();
    p.db.prepare("update productos set propietario = 'fep' where id = ?").run(mia);
    const ids = async (via: typeof p.celular) => ((await via('/api/etiquetas/pendientes', undefined, 'GET')).cuerpo as unknown as { id: string }[]).map((x) => x.id);
    p.como(FEP);
    assert.deepEqual(await ids(p.celular), [mia]);
    assert.deepEqual(await ids((r, c, m) => p.pc(r, c, m)), [mia]);
    for (const quien of [DUENO, CAPTURISTA]) { p.como(quien); assert.deepEqual(await ids(p.celular), [deLaTienda], quien); }
    p.como(CAJERO);
    for (const via of [p.celular, (r: string, c?: unknown, m?: string) => p.pc(r, c, m)]) assert.ok([403, 404].includes((await via('/api/etiquetas/pendientes', undefined, 'GET')).status));
    assert.equal(permitidaParaVendedor('/api/etiquetas/pendientes', 'GET'), true);
    assert.equal(permitidaParaVendedor('/api/etiquetas/pendientes', 'POST'), false);
  } finally { p.db.close(); }
});

test('pendientes: tope de 200, las más nuevas y en orden de captura (#493)', async () => {
  const p = montar();
  try {
    p.db.prepare('delete from productos where id = ?').run(PRODUCTO);
    const todas: string[] = [];
    for (let i = 0; i < 205; i++) todas.push(p.pieza({ creado_en: `2026-10-23T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z` }));
    p.como(DUENO);
    const r = (await p.pc('/api/etiquetas/pendientes', undefined, 'GET')).cuerpo as unknown as { id: string }[];
    assert.equal(r.length, 200);
    assert.deepEqual(r.map((x) => x.id), todas.slice(5));
  } finally { p.db.close(); }
});

test('sondeo por lote: un solo GET ?cambios= trae lo que quedó listo, aunque se pida por el host del celular (#493)', async () => {
  const p = montar();
  try {
    p.db.prepare('delete from productos where id = ?').run(PRODUCTO);
    const antes = '2026-10-23T10:00:00.000Z';
    const pendientes = [1, 2, 3].map(() => p.pieza({ estado_analisis: 'pendiente', creado_en: antes }));
    p.db.prepare('update productos set actualizado_en = ?').run(antes);
    // La IA termina dos de las tres: nombre, precio y estado cambian, y actualizado_en avanza.
    for (const id of pendientes.slice(0, 2)) p.db.prepare("update productos set estado_analisis = 'listo', nombre = 'Chamarra', precio = 14900, actualizado_en = '2026-10-23T10:02:00.000Z' where id = ?").run(id);
    p.db.prepare("update productos set estado_analisis = 'pendiente' where id = ?").run(pendientes[2]);
    p.como(CAPTURISTA);
    const r = await p.celular('/api/borradores?cambios=2026-10-23T10:01:00.000Z', undefined, 'GET');
    assert.equal(r.status, 200);
    const filas = r.cuerpo as unknown as { id: string; estado_analisis: string; nombre: string; precio: number; stock: number }[];
    assert.deepEqual(filas.map((x) => x.id).sort(), pendientes.slice(0, 2).sort());
    assert.deepEqual(filas.map((x) => [x.estado_analisis, x.nombre, x.precio, x.stock]), [['listo', 'Chamarra', 14900, 3], ['listo', 'Chamarra', 14900, 3]]);
  } finally { p.db.close(); }
});
