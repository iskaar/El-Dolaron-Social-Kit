// node --test src/etiquetas-celular.test.ts
// Imprimir la etiqueta desde el celular (Issue #440): permisos del host del escaner, el registro
// compartido que evita imprimir doble con la PC, y la cola de trabajos del telefono sin Bluetooth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tienda, DUENO } from './prueba-d1.ts';
import worker, { permitidaParaVendedor } from './worker.ts';
import { permiso, puede } from './cuentas.ts';
import { crearImpresion, motivoDeCorte } from '../public/imprimir-celular.js';

const CELULAR = 'captura.prueba';   // HOST_VENDEDOR; la PC entra por caja.prueba (el host de prueba.d1)
const CAPTURISTA = 'cap@prueba.mx';

function montar() {
  const t = tienda();
  t.env.HOST_VENDEDOR = CELULAR;
  t.db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values
    (?, 'Cap', 'capturista', 1, '', ''), ('caja@prueba.mx', 'Caja', 'cajero', 1, '', '')`).run(CAPTURISTA);
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
  /** Una peticion por el host del celular (como el capturista) o por el de la PC. */
  const por = async (host: string, ruta: string, cuerpo?: unknown, metodo = 'POST') => {
    const r = await worker.fetch!(new Request(`https://${host}${ruta}`, cuerpo === undefined ? {} : {
      method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) }) as never, t.env, t.ctx as never);
    return { status: r.status, cuerpo: (await r.clone().json().catch(() => ({}))) as Record<string, any>, respuesta: r };
  };
  const celular = (ruta: string, cuerpo?: unknown, metodo = 'POST') => por(CELULAR, ruta, cuerpo, metodo);
  return { ...t, t, pieza, como, celular, pc: t.pedir };
}

test('el host del celular suma solo lo mínimo para etiquetar; lo demás sigue cerrado (#440)', () => {
  for (const ruta of ['/imprimir-celular.js', '/etiquetera.js', '/impresora.js', '/code128.js']) assert.equal(permitidaParaVendedor(ruta, 'GET'), true, ruta);
  assert.equal(permitidaParaVendedor('/api/calibracion', 'GET'), true);
  assert.equal(permitidaParaVendedor('/api/etiquetas', 'POST'), true);
  assert.equal(permitidaParaVendedor('/api/etiquetas/enviadas', 'POST'), true);
  // Lo que antes estaba prohibido sigue prohibido: calibrar, soltar marcas, ver listas y las demás pantallas de etiquetas.
  const cerradas: [string, string][] = [['/api/calibracion', 'PUT'], ['/api/calibracion', 'POST'], ['/api/etiquetas', 'GET'], ['/api/etiquetas', 'DELETE'],
    ['/api/etiquetas/enviadas', 'DELETE'], ['/api/etiquetas/enviadas', 'GET'], ['/api/etiquetas/enviadas', 'PUT'], ['/etiquetas', 'GET'],
    ['/calibrar-etiqueta', 'GET'], ['/prueba-codigo', 'GET'], ['/sonda-impresora', 'GET'], ['/bandas', 'GET'], ['/api/config', 'GET'],
    ['/api/borradores', 'GET'], ['/api/etiquetas/otra', 'POST'], ['/imprimir-celular.js', 'POST'], ['/etiquetera.js', 'PUT']];
  for (const [ruta, metodo] of cerradas) assert.equal(permitidaParaVendedor(ruta, metodo), false, `${metodo} ${ruta}`);
});

test('escanear.html carga imprimir-celular.js y todo lo que éste importa, y el host del celular lo sirve', () => {
  const pagina = readFileSync('public/escanear.html', 'utf8');
  const dinamicos = [...pagina.matchAll(/import\('(\/[^']+\.js)'\)/g)].map((m) => m[1]);
  assert.ok(dinamicos.includes('/imprimir-celular.js') && dinamicos.includes('/etiquetera.js'));
  const vistos = new Set<string>();
  const visitar = (ruta: string) => {
    if (vistos.has(ruta)) return;
    vistos.add(ruta);
    assert.equal(permitidaParaVendedor(ruta, 'GET'), true, `${ruta} da 404 en el host del celular`);
    for (const m of readFileSync(`public${ruta}`, 'utf8').matchAll(/^import .* from '\.\/([^']+\.js)';/gm)) visitar(`/${m[1]}`);
  };
  dinamicos.forEach(visitar);
  assert.deepEqual([...vistos].sort(), ['/code128.js', '/etiquetera.js', '/impresora.js', '/imprimir-celular.js']);
});

test('por el host del celular: capturista sí, cajero no; la calibración y soltar marcas dan 404', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    p.como(CAPTURISTA);
    assert.equal((await p.celular('/api/etiquetas', { ids: [id] })).status, 200);
    assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id] })).status, 200);
    assert.equal((await p.celular('/api/calibracion', { corrimiento: 5 }, 'PUT')).status, 404);
    assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id] }, 'DELETE')).status, 404);
    assert.equal((await p.celular('/api/config')).status, 404);
    p.como('caja@prueba.mx');
    assert.equal((await p.celular('/api/etiquetas', { ids: [id] })).status, 403);
    assert.equal((await p.celular('/api/etiquetas/enviadas', { ids: [id] })).status, 403);
    assert.equal((await p.celular('/api/calibracion', undefined, 'GET')).status, 403);
  } finally { p.db.close(); }
});

test('permisos por rol del registro de etiquetas: capturista y FEP reclaman, el cajero no', () => {
  const usuario = (rol: string) => ({ correo: 'x@y.mx', nombre: '', roles: [rol] as never, activo: true, caja: '' });
  for (const [ruta, metodo] of [['/api/etiquetas/enviadas', 'POST'], ['/api/etiquetas/enviadas', 'DELETE'], ['/api/calibracion', 'GET']] as const) {
    assert.equal(puede(usuario('capturista'), permiso(ruta, metodo)), true, `${metodo} ${ruta}`);
    assert.equal(puede(usuario('finanzas'), permiso(ruta, metodo)), true);
    assert.equal(puede(usuario('cajero'), permiso(ruta, metodo)), false);
  }
  assert.equal(puede(usuario('finanzas'), permiso('/api/calibracion', 'PUT')), false);
  assert.equal(puede(usuario('capturista'), permiso('/api/calibracion', 'PUT')), true);
});

test('la calibración se lee con solo sus dos claves, también en el host del celular', async () => {
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
    assert.equal(segundo.marcas[id].etiqueta_origen, 'pc');   // dice quien la saco
    assert.equal(segundo.marcas[id].etiqueta_en, primero.marcas[id].etiqueta_en);
    // Lo que se ve en la etiqueta cambio: precio, precio tachado, nombre o talla -> sale otra.
    for (const [columna, valor] of [['precio', 8900], ['precio_lista', 20000], ['nombre', 'Playera roja'], ['talla', 'L']] as const) {
      p.db.prepare(`update productos set ${columna} = ? where id = ?`).run(valor, id);
      assert.deepEqual((await p.celular('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, [id], columna);
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

test('dos reclamos al mismo tiempo, uno por la PC y otro por el celular: gana uno solo', async () => {
  const p = montar();
  try {
    p.como(CAPTURISTA);
    for (let i = 0; i < 20; i++) {
      const id = p.pieza();
      const [a, b] = await Promise.all([p.pc('/api/etiquetas/enviadas', { ids: [id] }), p.celular('/api/etiquetas/enviadas', { ids: [id] })]);
      assert.equal(a.cuerpo.reclamadas.length + b.cuerpo.reclamadas.length, 1);
      assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas where producto_id = ?').get(id)!.n, 1);
    }
  } finally { p.db.close(); }
});

test('reimprimir reclama a la fuerza; sin código, sin existencia, descartada o ajena no se reclama; ids inválidos dan 400', async () => {
  const p = montar();
  try {
    const id = p.pieza();
    await p.pc('/api/etiquetas/enviadas', { ids: [id] });
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id], reimprimir: 'si' })).cuerpo.reclamadas, []);   // solo true cuenta
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id], reimprimir: true })).cuerpo.reclamadas, [id]);
    const sinCodigo = p.pieza({ codigo: null }), sinStock = p.pieza({ stock: 0 }), descartada = p.pieza({ estado_analisis: 'descartado' }), ajena = p.pieza();
    p.db.prepare("update productos set propietario = 'fep' where id = ?").run(ajena);
    const r = (await p.pc('/api/etiquetas/enviadas', { ids: [sinCodigo, sinStock, descartada, ajena] })).cuerpo;
    assert.deepEqual([r.reclamadas, r.marcas], [[], {}]);
    for (const ids of [[], 'x', ['no-es-uuid'], Array.from({ length: 101 }, () => crypto.randomUUID())]) {
      assert.equal((await p.pc('/api/etiquetas/enviadas', { ids })).status, 400, JSON.stringify(ids).slice(0, 30));
    }
    assert.equal((await p.pc('/api/etiquetas/enviadas', null)).status, 400);
  } finally { p.db.close(); }
});

test('el celular solo etiqueta lo que capturó en las últimas 24 h; la PC no tiene ese límite', async () => {
  const p = montar();
  try {
    p.como(CAPTURISTA);
    const mia = p.pieza(), deOtro = p.pieza({ capturado_por: 'otro@prueba.mx' });
    const vieja = p.pieza({ creado_en: new Date(Date.now() - 25 * 3600_000).toISOString() });
    const ids = [mia, deOtro, vieja];
    assert.deepEqual((await p.celular('/api/etiquetas', { ids })).cuerpo.map((x: any) => x.id), [mia]);
    assert.deepEqual((await p.celular('/api/etiquetas/enviadas', { ids })).cuerpo.reclamadas, [mia]);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 1);
    // Sin codigo, el celular tambien se lo asigna solo a lo suyo.
    const sinCodigo = p.pieza({ codigo: null }), sinCodigoOtro = p.pieza({ codigo: null, capturado_por: 'otro@prueba.mx' });
    assert.match((await p.celular('/api/etiquetas', { ids: [sinCodigo, sinCodigoOtro] })).cuerpo[0].codigo, /^ED-\d+$/);
    assert.equal(p.db.prepare('select codigo from productos where id = ?').get(sinCodigoOtro)!.codigo, null);
    p.como(DUENO);
    assert.equal((await p.pc('/api/etiquetas', { ids })).cuerpo.length, 3);
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids })).cuerpo.reclamadas, [deOtro, vieja]);
  } finally { p.db.close(); }
});

test('soltar borra la marca para que la etiqueta pueda volver a salir; solo la PC y solo piezas propias', async () => {
  const p = montar();
  try {
    const id = p.pieza(), fep = p.pieza();
    p.db.prepare("update productos set propietario = 'fep' where id = ?").run(fep);
    await p.pc('/api/etiquetas/enviadas', { ids: [id] });
    p.db.prepare("insert into etiquetas_enviadas values (?, 'x', 1, 0, 'n', '', 'pc')").run(fep);
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [id, fep] }, 'DELETE')).cuerpo.soltadas, 1);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 1);   // la de FEP no se toca
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, [id]);
    assert.equal((await p.pc('/api/etiquetas/enviadas', { ids: [] }, 'DELETE')).status, 400);
  } finally { p.db.close(); }
});

test('/api/borradores trae lo que dice la etiqueta ya enviada, y null si no ha salido', async () => {
  const p = montar();
  try {
    const sale = p.pieza({ precio_lista: 19900 }), noSale = p.pieza();
    await p.pc('/api/etiquetas/enviadas', { ids: [sale] });
    const lista = (await p.pc('/api/borradores?estado=listo')).cuerpo as unknown as any[];
    const porId = (id: string) => lista.find((x) => x.id === id);
    assert.deepEqual([porId(sale).etiqueta_precio, porId(sale).etiqueta_precio_lista, porId(sale).etiqueta_nombre, porId(sale).etiqueta_talla], [9900, 19900, 'Playera azul', 'M']);
    assert.ok(porId(sale).etiqueta_en);
    assert.equal(porId(noSale).etiqueta_en, null);
    assert.equal(lista.filter((x) => x.id === sale).length, 1);   // el join no duplica filas
  } finally { p.db.close(); }
});

/* ---------- la cola del telefono, con una impresora de mentira ---------- */

function telefono(p: ReturnType<typeof montar>) {
  p.como(CAPTURISTA);
  const e = {
    conectada: true, corta: null as number | null, error: '', enviadas: [] as { id: string; copias: number }[], reclamos: [] as boolean[], detenidos: 0,
    etiqueteraLista: () => e.conectada,
    reconectarEtiquetera: async () => e.conectada,
    envioDetenido: () => false, detenerEnvio: () => { e.detenidos += 1; }, errorEnvio: () => e.error,
    reclamarEtiquetas: async (ids: string[], op: { reimprimir?: boolean } = {}) => {
      e.reclamos.push(op.reimprimir === true);
      return (await p.celular('/api/etiquetas/enviadas', { ids, reimprimir: op.reimprimir === true })).cuerpo;
    },
    imprimirEtiquetas: async (pieza: { id: string }, copias: number, avanzar: (n: number, total: number) => void) => {
      const salen = e.corta === null ? copias : Math.min(e.corta, copias);
      for (let i = 1; i <= salen; i++) avanzar(i, copias);
      e.enviadas.push({ id: pieza.id, copias: salen });
      return salen === copias;
    },
  };
  const cambios: any[] = [];
  const impresion = crearImpresion({
    alCambiar: (t) => cambios.push(t), e: e as never,
    pedir: async (ruta: string, opciones: any) => (await p.celular(ruta, JSON.parse(opciones.body))).respuesta,
  });
  const ultimo = (id: string) => [...cambios].reverse().find((t) => t.id === id);
  const terminar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return { e, impresion, cambios, ultimo, terminar };
}

test('celular: una pieza con 3 en existencia sale como 3 copias y queda registrada para la PC', async () => {
  const p = montar();
  try {
    const id = p.pieza({ stock: 3 });
    const c = telefono(p);
    assert.equal(c.impresion.ofrecer(id, 'Playera azul', 3), true);
    assert.equal(c.impresion.ofrecer(id, 'Playera azul', 3), false);   // la misma pieza no se ofrece dos veces
    c.impresion.imprimir(id);
    await c.terminar();
    assert.deepEqual(c.e.enviadas, [{ id, copias: 3 }]);
    assert.equal(c.ultimo(id).estado, 'enviada');
    assert.equal(c.ultimo(id).ocupado, false);
    const marca = p.db.prepare('select etiqueta_origen o from etiquetas_enviadas where producto_id = ?').get(id)!;
    assert.equal(marca.o, 'celular');
    // Se asigno el codigo si faltaba: el trabajo lleva ED-.
    assert.deepEqual((await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo.reclamadas, []);   // la PC ya no la repite
  } finally { p.db.close(); }
});

test('celular: un doble toque no manda dos veces; con la impresora apagada espera y al conectar sale sola', async () => {
  const p = montar();
  try {
    const id = p.pieza({ stock: 2 });
    const c = telefono(p);
    c.e.conectada = false;
    c.impresion.ofrecer(id, 'Playera azul', 2);
    c.impresion.imprimir(id);
    await c.terminar();
    assert.equal(c.ultimo(id).estado, 'sin-impresora');
    assert.match(c.ultimo(id).mensaje, /no está conectada/);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);   // nada reclamado: la PC puede sacarla
    c.e.conectada = true;
    c.impresion.reanudar();
    c.impresion.imprimir(id);   // el segundo toque mientras corre
    await c.terminar();
    assert.deepEqual(c.e.enviadas, [{ id, copias: 2 }]);
    assert.equal(c.ultimo(id).estado, 'enviada');
  } finally { p.db.close(); }
});

test('celular: apagar la impresora a media tanda deja la marca, la PC no repite, y se retoma con las que faltan', async () => {
  const p = montar();
  try {
    const id = p.pieza({ stock: 3 });
    const c = telefono(p);
    c.e.corta = 1;
    c.e.error = 'se cayo el enlace y no se pudo reconectar (GATT Server is disconnected)';
    c.impresion.ofrecer(id, 'Playera azul', 3);
    c.impresion.imprimir(id);
    await c.terminar();
    assert.equal(c.ultimo(id).estado, 'cortada');
    assert.equal(c.ultimo(id).hechas, 1);
    assert.match(c.ultimo(id).mensaje, /salieron 1 de 3/);
    assert.match(c.ultimo(id).mensaje, /Se perdió la conexión/);
    assert.match(c.ultimo(id).mensaje, /La computadora no la repetirá/);
    // La PC (automatica o a mano) pide la etiqueta: la marca sigue puesta y la omite.
    const pc = (await p.pc('/api/etiquetas/enviadas', { ids: [id] })).cuerpo;
    assert.deepEqual(pc.reclamadas, []);
    assert.equal(pc.marcas[id].etiqueta_origen, 'celular');
    // Se prende la impresora: faltan 2, no 3.
    c.e.corta = null;
    c.impresion.imprimir(id);
    await c.terminar();
    assert.deepEqual(c.e.enviadas, [{ id, copias: 1 }, { id, copias: 2 }]);
    assert.equal(c.ultimo(id).estado, 'enviada');
    assert.equal(c.ultimo(id).hechas, 3);
    assert.deepEqual(c.e.reclamos, [false, true]);   // el reintento reclama a la fuerza
    // Y «Reimprimir» despues de completa saca todas otra vez.
    c.impresion.imprimir(id);
    await c.terminar();
    assert.deepEqual(c.e.enviadas.at(-1), { id, copias: 3 });
  } finally { p.db.close(); }
});

test('celular: si la PC ya la sacó se omite sin mandar nada, y «Reimprimir» la saca de todos modos', async () => {
  const p = montar();
  try {
    const id = p.pieza({ stock: 2 });
    await p.pc('/api/etiquetas/enviadas', { ids: [id] });
    const c = telefono(p);
    c.impresion.ofrecer(id, 'Playera azul', 2);
    c.impresion.imprimir(id);
    await c.terminar();
    assert.deepEqual(c.e.enviadas, []);
    assert.equal(c.ultimo(id).estado, 'omitida');
    assert.match(c.ultimo(id).mensaje, /Ya salió desde la computadora/);
    c.impresion.imprimir(id);
    await c.terminar();
    assert.deepEqual(c.e.enviadas, [{ id, copias: 2 }]);
  } finally { p.db.close(); }
});

test('celular: una pieza cancelada o sin red no manda nada y se puede reintentar', async () => {
  const p = montar();
  try {
    const cancelada = p.pieza({ stock: 2 }), id = p.pieza({ stock: 2 });
    const c = telefono(p);
    c.impresion.ofrecer(cancelada, 'Playera azul', 2);
    p.db.prepare('update productos set stock = 0 where id = ?').run(cancelada);
    c.impresion.imprimir(cancelada);
    await c.terminar();
    assert.equal(c.ultimo(cancelada).estado, 'error');
    assert.match(c.ultimo(cancelada).mensaje, /se canceló/);
    // Sin red: fetch lanza TypeError.
    const sinRed = crearImpresion({ alCambiar: (t) => c.cambios.push(t), e: c.e as never, pedir: async () => { throw new TypeError('fetch failed'); } });
    sinRed.ofrecer(id, 'Playera azul', 2);
    sinRed.imprimir(id);
    await c.terminar();
    assert.equal(c.ultimo(id).estado, 'error');
    assert.match(c.ultimo(id).mensaje, /Sin conexión con la tienda/);
    assert.deepEqual(c.e.enviadas, []);
    assert.equal(p.db.prepare('select count(*) n from etiquetas_enviadas').get()!.n, 0);
  } finally { p.db.close(); }
});

test('motivoDeCorte traduce lo que dice la etiquetera', () => {
  assert.match(motivoDeCorte('la impresora no esta conectada'), /no está conectada/);
  assert.match(motivoDeCorte('se cayo el enlace y no se pudo reconectar (x)'), /Se perdió la conexión/);
  assert.match(motivoDeCorte('NetworkError: GATT operation failed'), /Se perdió la conexión/);
  assert.match(motivoDeCorte('detenido a mano'), /detuvo a mano/);
  assert.match(motivoDeCorte(''), /No se pudo enviar/);
});

test('escanear.html: botones de 44 px, avisos aria-live, con los controles de la impresora', () => {
  const pagina = readFileSync('public/escanear.html', 'utf8');
  assert.match(pagina, /id="impresora-estado" role="status"/);
  assert.match(pagina, /id="etiqueta-aviso" role="status"/);
  assert.match(pagina, /#impresora button, #impresora label \{ min-height: 44px; \}/);
  assert.match(pagina, /#impresora input\[type="checkbox"\] \{ width: 24px; height: 24px; \}/);
  for (const id of ['conectar-impresora', 'otra-impresora', 'imprimir-solo', 'detener-impresion']) assert.match(pagina, new RegExp(`id="${id}"`));
  // Las cuatro formas en que una pieza queda lista (guardar, busqueda por codigo, foto, a mano) le avisan a la impresora con su id.
  assert.equal([...pagina.matchAll(/avisarEtiqueta\([^)]*,\s*\w+\.id\)/g)].length, 4);
});
