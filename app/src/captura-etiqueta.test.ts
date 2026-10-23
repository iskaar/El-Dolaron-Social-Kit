// La etiqueta sale sola al guardar una captura con foto en el celular, como en /escanear (#464).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { corregirExistencia, etiquetasPorCorreccion } from '../public/inventario-capturar.js';
import { marcaDeLaBase } from '../public/envio-etiquetas.js';

const capturar = readFileSync('public/inventario-capturar.js', 'utf8');
const celular = readFileSync('public/inventario-celular.js', 'utf8');
const auxiliares = capturar.slice(capturar.indexOf('const CLAVE_AUTOIMPRESAS'), capturar.indexOf('/**\n * Un lector USB') >= 0 ? capturar.indexOf('/**\n * Un lector USB') : capturar.indexOf('/**\r\n * Un lector USB')).replace(/^export /gm, '');
const turno = capturar.slice(capturar.indexOf('let turnoImpresion'), capturar.indexOf('const flujo=crearCaptura'));
const etiquetar = celular.slice(celular.indexOf('const razonSinEtiqueta'), celular.indexOf('async function subir('));

/** El motor de etiquetar con sus dependencias simuladas; `imprimir` es el envío al motor de etiquetas. */
function entorno(respuestas: any[] = [], imprimirResultado: boolean | (() => boolean) = true, resumen = '') {
  const almacen = new Map<string, string>(), mensajes: [string, string][] = [], envios: any[] = [], sonidos: string[] = [], sesion = new Map<string, any>();
  let lista = true, llamadasApi = 0;
  const contexto: any = {
    localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => almacen.set(k, v) },
    mensaje: (t: string, tipo: string) => mensajes.push([t, tipo]), sonar: (t: string) => sonidos.push(t), pintar() {}, sesion,
    setTimeout: (f: () => void) => f(), Promise, Math, JSON, console,
    etiqueteraLista: () => lista, $: () => ({ textContent: resumen }),
    api: async () => { llamadasApi++; const r = respuestas.shift(); if (r instanceof Error) throw r; return r; },
    imprimir: async (id: string, n: number, opciones: unknown) => { envios.push({ id, n, opciones: { ...(opciones as object) } }); return typeof imprimirResultado === 'function' ? imprimirResultado() : imprimirResultado; },
  };
  const motor = runInNewContext(`${auxiliares}\n${turno}\n({ etiquetar: null, imprimirCaptura, capturaImpresa })`, contexto);
  const captura = { imprimirCaptura: motor.imprimirCaptura };
  contexto.captura = captura;
  runInNewContext(`${etiquetar}\nglobalThis.etiquetar = etiquetar;`, contexto);
  return { etiquetar: contexto.etiquetar as (llave: string, d: any, n: number) => Promise<void>, mensajes, envios, sonidos, sesion, almacen,
    desconectar: () => { lista = false; }, motor, llamadas: () => llamadasApi };
}
const pieza = (campos: Record<string, unknown> = {}) => ({ id: 'p1', nombre: 'Lámpara', precio: 24900, stock: 2, estado_analisis: 'listo', ...campos });

test('captura con foto lista al guardar (manifiesto): la etiqueta sale en seguida, una por unidad, con aviso y sonido de /escanear', async () => {
  const e = entorno();
  await e.etiquetar('p1', pieza(), 2);
  assert.deepEqual(e.envios, [{ id: 'p1', n: 2, opciones: {} }]);   // sin forzar: el reclamo evita que la PC la repita
  assert.deepEqual(e.mensajes.at(-1), ['Sale la etiqueta: Lámpara ×2', 'etiqueta']);
  assert.deepEqual(e.sonidos, ['etiqueta']);
});

test('captura analizada por IA: espera a que quede lista y entonces imprime; el error o la falta de precio van aparte y no imprimen', async () => {
  const e = entorno([pieza({ estado_analisis: 'pendiente' }), pieza({ estado_analisis: 'pendiente' }), pieza({ stock: 3 })]);
  await e.etiquetar('p1', pieza({ estado_analisis: 'pendiente', precio: 0, nombre: '' }), 1);
  assert.deepEqual(e.envios, [{ id: 'p1', n: 3, opciones: {} }]);   // usa la existencia vigente al quedar lista
  const f = entorno();
  f.sesion.set('p2', { estado: 'analizando' });
  await f.etiquetar('p2', pieza({ id: 'p2', estado_analisis: 'error', precio: 0, nombre: 'Algo' }), 1);
  assert.deepEqual(f.envios, []);
  assert.equal(f.sesion.get('p2').estado, 'error');
  assert.match(f.mensajes.at(-1)![0], /Aparte, sin etiqueta: Algo/);
  const g = entorno();
  await g.etiquetar('p3', pieza({ id: 'p3', precio: 0 }), 1);   // lista pero sin precio
  assert.deepEqual(g.envios, []);
  assert.deepEqual(g.sonidos, ['error']);
});

test('sin impresora conectada o con el envío fallido: dice por qué, no la da por impresa y un reintento sí imprime', async () => {
  let sale = false;
  const e = entorno([], () => sale);
  await e.etiquetar('p1', pieza(), 1);
  assert.match(e.mensajes.at(-1)![0], /Guardada · falta etiqueta: revisa la impresora/);
  e.desconectar();
  await e.etiquetar('p1', pieza(), 1);
  assert.match(e.mensajes.at(-1)![0], /conecta la impresora/);
  assert.equal(e.envios.length, 2);
  sale = true;
  await e.etiquetar('p1', pieza(), 1);
  assert.equal(e.envios.length, 3);
  assert.equal(e.motor.capturaImpresa('p1'), true);
});

test('la misma captura no imprime dos veces: ni al reintentar la subida ni tras recargar (se recuerda en el teléfono)', async () => {
  const e = entorno();
  await Promise.all([e.etiquetar('p1', pieza(), 1), e.etiquetar('p1', pieza(), 1)]);   // dos subidas casi a la vez
  assert.equal(e.envios.length, 1);
  const recargada = entorno();
  for (const [k, v] of e.almacen) recargada.almacen.set(k, v);   // mismo localStorage tras recargar
  await recargada.etiquetar('p1', pieza(), 1);
  assert.equal(recargada.envios.length, 0);
  await recargada.etiquetar('p2', pieza({ id: 'p2' }), 1);       // otra captura sí
  assert.equal(recargada.envios.length, 1);
});

test('D2: si el seguimiento del análisis da 403/404 se deja de preguntar y no dice «Ponle precio» (FEP o captura ajena)', async () => {
  const error = Object.assign(new Error('no'), { status: 404 });
  const e = entorno([error]);
  await e.etiquetar('p1', pieza({ estado_analisis: 'pendiente', precio: 0 }), 1);
  assert.equal(e.llamadas(), 1, 'una sola consulta, no 40');
  assert.deepEqual(e.envios, []);
  assert.match(e.mensajes.at(-1)![0], /No se pudo seguir el análisis/);
  assert.doesNotMatch(e.mensajes.at(-1)![0], /Ponle precio/);
});

test('D3: si el motor rechazó la pieza (vendida o cambió), el aviso dice eso y no «revisa la impresora»', async () => {
  const e = entorno([], false, '0 piezas enviadas; 1 pieza ya no se puede imprimir (vendidas o cambiaron). Si alguna no salió…');
  await e.etiquetar('p1', pieza(), 1);
  assert.match(e.mensajes.at(-1)![0], /falta etiqueta: la pieza ya no se puede imprimir \(vendida o cambió\)/);
  assert.equal(e.mensajes.some(([t]) => /Sale la etiqueta/.test(t)), false);
  assert.deepEqual(e.sonidos, []);
});

test('D1/D4: una pieza lista con UPC se corrige con el ajuste auditado (fijar_a + esperado); 409 y 403 dan mensajes claros', async () => {
  const llamadas: any[] = [];
  const api = (fallo?: number) => async (ruta: string, cuerpo: any, metodo?: string) => {
    llamadas.push({ ruta, cuerpo: { ...cuerpo }, metodo });
    if (fallo) throw Object.assign(new Error('x'), { status: fallo });
    return {};
  };
  await corregirExistencia(api(), { estado_analisis: 'listo', upc: '0191907910414', stock: 2 }, 'p1', 4, 'folio-1');
  assert.deepEqual(llamadas.at(-1), { ruta: '/api/piezas/p1/existencia', cuerpo: { id: 'folio-1', fijar_a: 4, esperado: 2, motivo: 'correccion' }, metodo: undefined });
  await assert.rejects(() => corregirExistencia(api(409), { estado_analisis: 'listo', upc: '1', stock: 2 }, 'p1', 4), /Revísala en Buscar/);
  await assert.rejects(() => corregirExistencia(api(403), { estado_analisis: 'listo', upc: '1', stock: 2 }, 'p1', 4), /quien edita el inventario/);
  // Lo que aún se identifica o es una foto sin UPC conserva la corrección de captura.
  await corregirExistencia(api(), { estado_analisis: 'pendiente', upc: '1', stock: 2 }, 'p2', 3);
  assert.deepEqual(llamadas.at(-1), { ruta: '/api/borradores/p2/existencia', cuerpo: { stock: 3, esperado: 2 }, metodo: 'PATCH' });
  // Una foto lista sin UPC conserva la ruta de captura pero manda la existencia vista; en 409 recuerda la actual (#468).
  await corregirExistencia(api(), { estado_analisis: 'listo', upc: '', stock: 2 }, 'p3', 3);
  assert.deepEqual(llamadas.at(-1), { ruta: '/api/borradores/p3/existencia', cuerpo: { stock: 3, esperado: 2 }, metodo: 'PATCH' });
  const vista = { estado_analisis: 'listo', upc: '', stock: 2 };
  const vencida = async () => { throw Object.assign(new Error('cambió'), { status: 409, datos: { stock: 1 } }); };
  await assert.rejects(() => corregirExistencia(vencida, vista, 'p3', 3), /cambió/);
  assert.equal(vista.stock, 1);
});

test('D4: las unidades que sube una corrección se etiquetan si ya salió la etiqueta anterior (marca local, adoptada o de la base), no solo la de este teléfono', () => {
  const base = { antes: 2, despues: 5, estado_analisis: 'listo' };
  assert.equal(etiquetasPorCorreccion({ ...base, marca: { hora: 'x' } }), 3);                  // la sacó la PC y este teléfono la adoptó
  assert.equal(etiquetasPorCorreccion({ ...base, etiqueta_en: '2026-10-23T10:00:00Z' }), 3);   // viene de la base
  assert.equal(etiquetasPorCorreccion({ ...base, impresa: true }), 3);                         // la sacó este teléfono
  assert.equal(etiquetasPorCorreccion({ ...base }), 0, 'sin etiqueta anterior se imprime todo junto, no solo la diferencia');
  assert.equal(etiquetasPorCorreccion({ ...base, marca: {}, despues: 1 }), 0, 'bajar no imprime');
  assert.equal(etiquetasPorCorreccion({ ...base, marca: {}, estado_analisis: 'pendiente' }), 0);
});

/** `etiquetarCorreccion` del celular con la base simulada: `lista` es lo que devuelve /api/borradores, o un Error si no hay red. */
function correccion(lista: any[] | Error, { impresa = false } = {}) {
  const mensajes: [string, string][] = [], impresiones: any[] = [], consultas: string[] = [];
  const contexto: any = {
    api: async (ruta: string) => { consultas.push(ruta); if (lista instanceof Error) throw lista; return lista; },
    mensaje: (t: string, tipo: string) => mensajes.push([t, tipo]),
    captura: { imprimirPieza: (id: string, n: number, opciones: unknown) => impresiones.push({ id, n, opciones: { ...(opciones as object) } }) },
    estadoEnvio: () => ({ marca: undefined }), capturaImpresa: () => impresa, etiquetasPorCorreccion, marcaDeLaBase, etiqueteraLista: () => true, $: () => ({}), Promise, setTimeout, console,
  };
  runInNewContext(`${etiquetar}
globalThis.etiquetarCorreccion = etiquetarCorreccion;`, contexto);
  return { corregir: contexto.etiquetarCorreccion as (id: string, datos: any, actual: any, cantidad: number) => Promise<void>, mensajes, impresiones, consultas };
}
const listo = { id: 'p1', estado_analisis: 'listo', stock: 2 };

test('#468: la PC imprimió la original después de la última carga del teléfono: subir la cantidad etiqueta las unidades agregadas', async () => {
  // El teléfono no tiene marca ni etiqueta_en en su sesión (la etiqueta salió después de cargar), pero la base ya la tiene.
  const c = correccion([{ ...listo, etiqueta_en: '2026-10-23T10:00:00Z' }, { id: 'otra', etiqueta_en: null }]);
  await c.corregir('p1', { id: 'p1' }, listo, 5);
  assert.deepEqual(c.impresiones, [{ id: 'p1', n: 3, opciones: { reimprimir: true } }]);
  assert.deepEqual(c.mensajes, []);
  assert.match(c.consultas[0], /^\/api\/borradores\?desde=/);
});

test('#468: si la base no tiene etiqueta de la pieza no se imprime la diferencia (la original sale completa por la cola) y una marca vieja ya no cuenta', async () => {
  const c = correccion([{ ...listo, etiqueta_en: null }]);
  await c.corregir('p1', { id: 'p1', etiqueta_en: '2026-10-23T09:00:00Z' }, listo, 5);   // la sesión recordaba una etiqueta que se soltó después
  assert.deepEqual(c.impresiones, []);
  assert.deepEqual(c.mensajes, []);
});

test('#468: sin poder consultar la base no se imprime a ciegas ni se calla: avisa; lo que ya se sabía localmente sigue imprimiendo', async () => {
  const sinRed = correccion(new TypeError('sin red'));
  await sinRed.corregir('p1', { id: 'p1' }, listo, 5);
  assert.deepEqual(sinRed.impresiones, []);
  assert.deepEqual(sinRed.mensajes.map(([, tipo]) => tipo), ['aviso']);
  assert.match(sinRed.mensajes[0][0], /reimprime las que faltan desde Buscar/);
  const sabida = correccion(new TypeError('sin red'), { impresa: true });   // la imprimió este teléfono
  await sabida.corregir('p1', { id: 'p1' }, listo, 5);
  assert.deepEqual(sabida.impresiones, [{ id: 'p1', n: 3, opciones: { reimprimir: true } }]);
  const baja = correccion(new TypeError('sin red'));
  await baja.corregir('p1', { id: 'p1' }, listo, 1);   // bajar no etiqueta ni avisa
  assert.deepEqual([baja.impresiones, baja.mensajes], [[], []]);
});
