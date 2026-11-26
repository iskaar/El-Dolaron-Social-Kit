// node --test src/descuento-vence-caja.test.ts
// Issue #845, la caja y el vencimiento del descuento: se prueba el código real de caja.html (como caja-avisos.test.ts), no una copia.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, huellaTicket } from '../public/venta.js';
import { PUERTA } from './prueba-caja.ts';

const html = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = html.indexOf(desde);
  const j = html.indexOf(hasta, i + desde.length);
  assert.ok(i >= 0 && j > i, `no se encontró «${desde}» … «${hasta}» en caja.html`);
  return html.slice(i, j);
};

const MIN = 60_000;
const iso = (desfaseMin: number) => new Date(Date.now() + desfaseMin * MIN).toISOString();

/** El estado de la caja (descuento, folio, cobro en duda) con el código real de «descuentoVencido», «revisar…» y «pintarDescuento». */
function montar(estado: Record<string, any>) {
  const textos = { descuento: '', aviso: '', colorAviso: '' };
  const elemento = (id: string) => ({
    set textContent(v: string) { if (id === 'descuento-estado') textos.descuento = v; if (id === 'aviso') textos.aviso = v; },
    get textContent() { return id === 'aviso' ? textos.aviso : textos.descuento; },
    style: {}, hidden: false, focus() {},
  });
  const cache = new Map<string, any>();
  const $ = (id: string) => (cache.has(id) ? cache.get(id) : (cache.set(id, elemento(id)), cache.get(id)));
  const llamadas = { pintar: 0, temporizadores: [] as number[] };
  const codigo = `let descuento = E.descuento, idVenta = E.idVenta, creadoEnVenta = E.creadoEnVenta, cobroIncierto = E.cobroIncierto ?? null, folioIncierto = E.folioIncierto ?? null,
      sondeoDescuento = null, vencimientoDescuento = null, cobrando = false;
    ${entre('const descuentoAplicado', '/** «Quitar descuento» cierra')}
    ${entre('function pintarDescuento(', 'async function consultarDescuento')}
    ${entre('async function cobrar(forma) {', "  // El foco sale del botón desde el primer instante")}
    }
    ({ descuentoVencido, revisarVencimientoDescuento, descuentoAplicado, cobrar, pintarDescuento,
       estado: () => ({ descuento, idVenta }) })`;
  const rutinas = runInNewContext(codigo, {
    E: estado, $, pesos: (c: number) => `$${(c / 100).toFixed(2)}`, Date, clearInterval() {}, clearTimeout() {},
    setInterval: () => 1, setTimeout: (_f: unknown, ms: number) => { llamadas.temporizadores.push(ms); return 1; },
    pintar: () => { llamadas.pintar++; }, consultarDescuento() {},
  });
  return { ...rutinas, textos, llamadas };
}

const aprobado = (venceEnMin: number, extra: Record<string, unknown> = {}) =>
  ({ id: 'd1', estado: 'aprobada', tipo: 'porcentaje', valor: 10, monto: 2500, subtotal: 25000, vence_en: iso(venceEnMin), ...extra });

test('#845 un descuento aprobado vencido deja de contar: el total vuelve completo y la caja lo dice', () => {
  const c = montar({ descuento: aprobado(-1), idVenta: null });
  assert.equal(c.descuentoAplicado(), 2500);
  assert.equal(c.revisarVencimientoDescuento(), true);
  assert.equal(c.descuentoAplicado(), 0);
  assert.equal(c.estado().descuento.estado, 'vencida');
  assert.equal(c.textos.descuento, 'El descuento venció: pide otro.');
  assert.equal(totales([{ precio: 25000, cantidad: 1 }], 0, 0, c.descuentoAplicado()).total, 25000);
  assert.equal(c.revisarVencimientoDescuento(), false);                       // ya cerrado: no vuelve a avisar
});

test('#845 vigente se queda; muestra «vence HH:MM» (hora de la tienda) y programa soltarlo a la hora', () => {
  const c = montar({ descuento: aprobado(10, { vence_en: '2026-11-16T18:30:00.000Z' }), idVenta: null });
  c.pintarDescuento();
  assert.match(c.textos.descuento, /^Descuento aprobado: −\$25\.00 · vence 12:30/);   // 18:30 UTC = 12:30 en la Ciudad de México
  const vigente = montar({ descuento: aprobado(10), idVenta: null });
  assert.equal(vigente.revisarVencimientoDescuento(), false);
  vigente.pintarDescuento();
  assert.ok(vigente.llamadas.temporizadores.at(-1)! > 9 * MIN && vigente.llamadas.temporizadores.at(-1)! < 11 * MIN);
});

test('#845 con folio se mide a la hora de su primer intento, y con un cobro en duda no se suelta nunca', () => {
  // El folio nació al minuto 29 (vence en 1 min): el reintento a las 31 sigue valiendo en la caja, el servidor mide igual.
  const reintento = montar({ descuento: aprobado(-1), idVenta: 'f1', creadoEnVenta: iso(-2) });
  assert.equal(reintento.revisarVencimientoDescuento(), false);
  // Un folio que nació después de vencer sí está vencido.
  const tarde = montar({ descuento: aprobado(-5), idVenta: 'f1', creadoEnVenta: iso(-1) });
  assert.equal(tarde.revisarVencimientoDescuento(), true);
  assert.equal(tarde.estado().idVenta, null);
  // Con el cobro en duda ya pudo estar pagado: no se toca.
  for (const duda of [{ cobroIncierto: { id: 'f1' } }, { folioIncierto: 'f1' }]) {
    const c = montar({ descuento: aprobado(-60), idVenta: 'f1', creadoEnVenta: iso(-1), ...duda });
    assert.equal(c.revisarVencimientoDescuento(), false);
    assert.equal(c.descuentoAplicado(), 2500);
  }
});

test('#845 cobrar() revisa el vencimiento antes que nada: no sigue al cobro, repinta y avisa', async () => {
  const c = montar({ descuento: aprobado(-1), idVenta: null });
  await c.cobrar('tarjeta');
  assert.equal(c.textos.aviso, 'El descuento venció: pide otro.');
  assert.equal(c.llamadas.pintar, 1);
  assert.equal(c.descuentoAplicado(), 0);
  assert.match(html, /async function cobrar\(forma\) \{\n  if \(cobrando\) return;[^\n]*\n[^\n]*\n  if \(revisarVencimientoDescuento\(\)\)/);   // primera instrucción tras la guarda del doble clic
});

test('#845 pintar() no suelta el descuento ni el folio mientras un cobro está en duda; sin duda sí', () => {
  const bloque = entre('  const subtotal = totales(lineas).subtotal;\n  revisarVencimientoDescuento();', "  $('pedir-descuento').hidden");
  const correr = (cobroIncierto: unknown) => {
    const e: Record<string, any> = { descuento: { id: 'd1', estado: 'aprobada', huella: 'otra|1' }, idVenta: 'f1', cobroIncierto };
    const lineas = [{ producto_id: 'p1', cantidad: 2, precio: 25000 }];
    const contexto: Record<string, unknown> = { totales, huellaTicket, ...PUERTA, lineas, revisarVencimientoDescuento() {}, quitarDescuentoEnServidor() {}, pintarDescuento() {}, descuentoCerrado: () => false };
    for (const k of ['descuento', 'idVenta', 'cobroIncierto']) Object.defineProperty(contexto, k, { get: () => e[k], set: (v) => { e[k] = v; }, enumerable: true });
    runInNewContext(bloque, contexto);
    return e;
  };
  const enDuda = correr({ id: 'f1' });
  assert.equal(enDuda.descuento.id, 'd1');
  assert.equal(enDuda.idVenta, 'f1');
  const sinDuda = correr(null);
  assert.equal(sinDuda.descuento, null);
  assert.equal(sinDuda.idVenta, null);
});

test('#845 gerencia con su PIN en la computadora de la caja no tiene el tope del cajero', () => {
  const tope = entre('  // El dueño con su PIN en la computadora', '  pintarTopeDescuento();');
  const correr = (yo: { usuario?: unknown; cajero?: unknown }) => {
    const c: { esDuenoEnCaja: boolean } = { esDuenoEnCaja: false };
    runInNewContext(tope.replace('esDuenoEnCaja =', 'c.esDuenoEnCaja ='), { c, usuario: undefined, cajero: undefined, ...yo });
    return c.esDuenoEnCaja;
  };
  assert.equal(correr({ cajero: { es_dueno: true }, usuario: { roles: ['computadora'] } }), true);    // su PIN en la computadora de la tienda
  assert.equal(correr({ cajero: { es_dueno: false }, usuario: { roles: ['computadora'] } }), false);
  assert.equal(correr({ usuario: { roles: ['dueno'] } }), true);                                      // su sesión de Access
  assert.equal(correr({ usuario: { roles: ['cajero'] } }), false);
});
