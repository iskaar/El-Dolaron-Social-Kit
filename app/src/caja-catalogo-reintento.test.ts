// node --test src/caja-catalogo-reintento.test.ts
// Issue #946 (H7): el reintento tardío del catálogo no agrega la pieza a otro ticket, la descarga tiene límite de tiempo y candado,
// y el arranque no la espera. Trozos reales de public/caja.html en un contexto simulado (como caja-en-mano.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PUERTA } from './prueba-caja.ts';
import { agregarYMarcar, leerMultiplicador, avisoExistencia, avisoDondeHay, puedeVenderEnMano, MOTIVOS_EN_MANO, SIN_RED_EN_MANO } from '../public/venta.js';
import { codigoDeDigitos } from '../public/code128.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const pieza = (codigo: string, stock: number) => ({ codigo, nombre: `Pieza ${codigo}`, precio: 5000, stock, id: `id-${codigo}`, sin_inventario: 0 });
const cola = () => new Promise((r) => setImmediate(r));   // deja correr los .then pendientes

function elemento() {
  const e: any = { hidden: false, hijos: [] as any[], textContent: '', style: {}, value: '', addEventListener() {}, replaceChildren(...h: any[]) { e.hijos = h; }, focus() {} };
  return e;
}

/** La caja con el catálogo en memoria; `descarga` es la promesa que `cargarCatalogo()` devuelve (se resuelve a mano, cuando "llega la red"). */
function montar(piezas: any[], { existencia = null as any } = {}) {
  const els = new Map<string, any>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, elemento()); return els.get(id); };
  const catalogo = new Map(piezas.map((p) => [p.codigo, p]));
  const sonidos: string[] = [];
  let liberar!: () => void;
  const descarga = new Promise<void>((r) => { liberar = r; });
  const contexto: Record<string, unknown> = {
    $, cerrarPaneles() {}, catalogo, agregarYMarcar, leerMultiplicador, codigoDeDigitos, avisoExistencia, avisoDondeHay, puedeVenderEnMano, MOTIVOS_EN_MANO, SIN_RED_EN_MANO, Map, Date, Math, ...PUERTA,
    fetch: () => Promise.resolve({ ok: true, json: async () => existencia }),
    precioHoy: (p: any) => p.precio, navigator: { onLine: true }, cargarPedido() {}, buscarSocio() {}, cargarCatalogo: () => descarga, pintar() {},
    sonar: (t: string) => sonidos.push(t), TONO_RECHAZO: 'rechazo', TONO_PIEZA: 'pieza', ofrecerEnMano() {}, ocultarEnMano() {},
  };
  const rutina = runInNewContext(`let cobrando = false, idVenta = null, lineas = [], cobroIncierto = null;
    ${entre('/** Con el folio en duda el ticket no se toca', '// Pedido por WhatsApp cargado')}
    ${entre('function buscarPieza(', '/* ---------- busqueda a mano')}
    ${entre('/** Agrega con sonido', '// Sugerencia resaltada')}
    ({ agregarCodigo, escanear, lineas: () => lineas,
       // lo que hacen cobrar() al terminar y «Cancelar venta»: vacían el ticket con un arreglo nuevo (ver la última prueba)
       cobrado: () => { lineas = []; idVenta = null; },
       cancelado: () => cambiarTicket(() => { lineas = []; }) })`, contexto);
  return { ...rutina, $, aviso: $('aviso'), catalogo, sonidos, llega: () => liberar() };
}

/** Un escaneo que falla, el ticket que cambia como sea, y luego "llega" el catálogo con la pieza. */
const casos: [string, string, (c: ReturnType<typeof montar>) => void, (c: ReturnType<typeof montar>) => void][] = [
  ['no encontrado (agregarCodigo, sin sonido)', 'ED-000001', (c) => c.agregarCodigo('ED-000001'), (c) => c.catalogo.set('ED-000001', pieza('ED-000001', 1))],
  ['sin existencia (escanear, con sonido)', 'ED-000002', (c) => c.escanear('ED-000002'), (c) => { c.catalogo.set('ED-000002', pieza('ED-000002', 2)); }],
];
const cambios: [string, (c: ReturnType<typeof montar>) => void][] = [
  ['cobro terminado', (c) => c.cobrado()],
  ['venta cancelada', (c) => c.cancelado()],
];

for (const [ruta, codigo, escanear, llegaLaPieza] of casos) {
  const piezas = () => [pieza('ED-000002', 0)];
  test(`${ruta}: sin cambios en el ticket, el reintento sí agrega (control)`, async () => {
    const c = montar(piezas());
    escanear(c);
    llegaLaPieza(c);
    c.llega();
    await cola();
    assert.equal(c.lineas().length, 1);
    assert.equal(c.lineas()[0].codigo, codigo);
  });
  for (const [cambio, hacer] of cambios) {
    test(`${ruta}: tras ${cambio} el reintento tardío no agrega nada`, async () => {
      const c = montar(piezas());
      escanear(c);
      const sonidosAntes = c.sonidos.length;
      hacer(c);   // el cliente siguiente: aviso en blanco, ticket nuevo
      c.aviso.textContent = '';
      llegaLaPieza(c);
      c.llega();
      await cola();
      assert.equal(c.lineas().length, 0);
      assert.equal(c.sonidos.length, sonidosAntes, 'tampoco suena');
    });
    test(`${ruta}: tras ${cambio}, aunque el aviso siga igual, el reintento tardío no agrega nada`, async () => {
      const c = montar(piezas());
      escanear(c);
      const aviso = c.aviso.textContent;
      hacer(c);
      c.aviso.textContent = aviso;   // el mismo mensaje por casualidad: lo detiene el contador del ticket
      llegaLaPieza(c);
      c.llega();
      await cola();
      assert.equal(c.lineas().length, 0);
    });
  }
  test(`${ruta}: si el aviso ya no es el de ese escaneo, el reintento no agrega`, async () => {
    const c = montar(piezas());
    escanear(c);
    c.aviso.textContent = 'Otro aviso';
    llegaLaPieza(c);
    c.llega();
    await cola();
    assert.equal(c.lineas().length, 0);
  });
}

test('sin existencia: la respuesta de «dónde hay» reescribe el aviso y el reintento tardío sigue valiendo', async () => {
  const c = montar([pieza('ED-000002', 0)], { existencia: { tiendas: ['Soledad'] } });
  c.escanear('ED-000002');
  await cola();
  assert.match(c.aviso.textContent, /Hay en Soledad/, 'dondeHay reemplazó el aviso inmediato');
  c.catalogo.set('ED-000002', pieza('ED-000002', 1));
  c.llega();
  await cola();
  assert.equal(c.lineas().length, 1);
});

/* ---------- la descarga ---------- */

function montarDescarga({ falla = false } = {}) {
  const els = new Map<string, any>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, elemento()); return els.get(id); };
  const peticiones: { url: string; signal: any }[] = [];
  const pendientes: ((v: any) => void)[] = [];
  const limites: number[] = [];
  const avisos: any[] = [];
  const contexto: Record<string, unknown> = {
    $, Map, Date, Promise, Number, Math, JSON, encodeURIComponent, avisos,
    store: async () => null, pintarAvisos: (a: any) => avisos.push(a),
    AbortSignal: { timeout: (ms: number) => { limites.push(ms); const s: any = { abortado: false, oyentes: [] as any[], addEventListener(_: string, f: any) { s.oyentes.push(f); } }; s.abortar = () => { s.abortado = true; s.oyentes.forEach((f: any) => f()); }; return s; } },
    fetch: (url: string, init: any) => new Promise((resolver, rechazar) => {
      peticiones.push({ url, signal: init?.signal });
      init?.signal?.addEventListener('abort', () => rechazar(Object.assign(new Error('tiempo'), { name: 'TimeoutError' })));
      pendientes.push(resolver);
    }),
  };
  const rutina = runInNewContext(`let catalogo = new Map([['ED-000009', { codigo: 'ED-000009', stock: 1 }]]);
    ${entre('const CATALOGO_COMPLETO_MS', '/* ---------- ticket ---------- */')}
    ({ cargarCatalogo, catalogo: () => catalogo, limite: CATALOGO_LIMITE_MS })`, contexto);
  const responder = (cuerpo: any) => pendientes.shift()!({ ok: true, headers: { get: () => null }, json: async () => cuerpo });
  return { ...rutina, $, peticiones, responder, limites, avisos, falla };
}

test('dos lecturas seguidas lanzan una sola descarga; al terminar, la siguiente sí descarga', async () => {
  const c = montarDescarga();
  const a = c.cargarCatalogo();
  const b = c.cargarCatalogo();
  await cola();
  assert.equal(c.peticiones.length, 1, 'una sola petición para las dos lecturas');
  c.responder([{ codigo: 'ED-000001', precio: 100, stock: 1 }]);
  await Promise.all([a, b]);
  assert.equal(c.catalogo().size, 1);
  assert.equal(c.peticiones.length, 1);
  const d = c.cargarCatalogo();
  await cola();
  assert.equal(c.peticiones.length, 2, 'ya no hay descarga en curso: esta pide los cambios');
  assert.match(c.peticiones[1].url, /desde=/);
  c.responder({ ahora: new Date().toISOString(), piezas: [] });
  await d;
});

test('las peticiones del catálogo llevan límite de tiempo; si se agota, la caja sigue con su copia y lo dice', async () => {
  const c = montarDescarga();
  assert.ok(c.limite >= 5_000 && c.limite <= 120_000, `límite razonable para red lenta: ${c.limite}`);
  const a = c.cargarCatalogo();
  await cola();
  assert.equal(JSON.stringify(c.limites), JSON.stringify([c.limite]));
  assert.ok(c.peticiones[0].signal, 'la petición lleva señal de tiempo');
  c.peticiones[0].signal.abortar();   // la descarga no termina: se agota el tiempo
  await a;
  assert.equal(c.catalogo().size, 1, 'conserva el catálogo que tenía');
  assert.match(c.$('catalogo-info').textContent, /1 códigos · sin actualizar/);
  assert.equal(JSON.stringify(c.avisos.at(-1)), '{"catalogo":"aviso"}');
  // La descarga fallida suelta el candado: la siguiente lectura vuelve a intentar.
  const b = c.cargarCatalogo();
  await cola();
  assert.equal(c.peticiones.length, 2);
  c.peticiones[1].signal.abortar();
  await b;
});

/* ---------- el arranque y el contador ---------- */

test('el arranque no espera al catálogo: ni el ticket recuperado, ni la cola, ni la impresora', () => {
  const bloque = fuente.slice(fuente.indexOf('pintarRed();\n', fuente.lastIndexOf('/* ---------- fin de la meta semanal (#940) ---------- */')), fuente.indexOf("$('codigo').focus();\n</script>"));
  assert.match(bloque, /^pintarRed\(\);\n(?:\/\/[^\n]*\n)*cargarCatalogo\(\);/, 'se lanza sin esperar');
  assert.doesNotMatch(bloque, /await cargarCatalogo/);
  assert.match(bloque, /if \(ticketRecuperado\)[\s\S]*await sincronizar\(\);\nawait reconectarImpresora\(\);/);
});

test('el ticket de un reintento es el arreglo `lineas`: cobrar() y «Cancelar venta» lo reemplazan por uno nuevo, y cada pieza que entra también', () => {
  assert.match(fuente.slice(fuente.indexOf('async function cobrar(')), /\n    lineas = \[\];\n    idVenta = null;/);
  assert.match(entre('  cambiarTicket(() => {\n    desarmarCancelar();', '}, { aunSinCuerpo: true });'), /lineas = \[\];/);
  const antes: any[] = [];
  assert.notEqual(agregarYMarcar(antes, { codigo: 'A', nombre: 'A', precio: 100 }, 1), antes);
});
