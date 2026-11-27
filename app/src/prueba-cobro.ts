// Corre el cobrar() REAL de public/caja.html (las tres rutas: normal, con Dolarones y con pedido) contra una pantalla mínima.
// Lo comparten caja-total-servidor.test.ts (#943) y caja-rechazo-terminal.test.ts (#944).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { totales, efectivoAlcanza, saldoCanjeable, pagoConDolarones, dolaronesGanados, anticipoDePedido, transferenciaDe, CLAVE_DESDE, debePreguntarSocio,
  descuentoDe, TOPE_DESCUENTO } from '../public/venta.js';
import { PUERTA } from './prueba-caja.ts';

export const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
export const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
export const tick = () => new Promise((r) => setTimeout(r, 0));

export const avisoFalso = () => {
  const el: any = { hijos: [] as { textContent: string }[], style: {}, nodo: null as null | { texto: string } };
  Object.defineProperty(el, 'textContent', {
    get: () => (el.nodo?.texto ?? '') + el.hijos.map((h: { textContent: string }) => h.textContent).join(''),
    set: (v) => { el.nodo = { texto: String(v) }; el.hijos = []; },
  });
  Object.defineProperty(el, 'firstChild', { get: () => el.nodo });
  el.append = (h: { textContent: string }) => el.hijos.push(h);
  return el;
};

export type Ruta = 'normal' | 'dolarones' | 'pedido';
export interface Opciones {
  ruta?: Ruta;
  forma?: string;
  respuesta?: Record<string, unknown>;       // lo que contesta /api/ventas (201)
  status?: number;
  fetch?: (ruta: string, o: any) => Promise<unknown>;
  contexto?: Record<string, unknown>;
}
export const SOCIO = { id: 's1', numero: 7, disponible: 5000, regalo_disponible: 0, maximo: 99999, expira_en: '2099-01-01T00:00:00Z', vale: false };
export const PRECIO = 30000;

/** El cobro real con una pieza; `ruta` decide por dónde va: sin nada (normal), con socio y Dolarones, o con un pedido cargado. */
export function montar(op: Opciones = {}) {
  const ruta = op.ruta ?? 'normal';
  const elementos = new Map<string, any>();
  const impresos: any[] = [];
  const guardadas: any[] = [];
  const cuerpos: string[] = [];
  const $ = (id: string) => {
    if (!elementos.has(id)) {
      elementos.set(id, id === 'aviso' ? avisoFalso() : { value: id === 'efectivo' ? '300' : '', textContent: '', style: {}, focus() {} });
    }
    return elementos.get(id);
  };
  const contexto: Record<string, unknown> = {
    crypto, Date, $, AbortSignal, Object, Math, Number, JSON, totales, efectivoAlcanza, saldoCanjeable, pagoConDolarones, dolaronesGanados, anticipoDePedido,
    transferenciaDe, CLAVE_DESDE, debePreguntarSocio, descuentoDe, TOPE_DESCUENTO, ...PUERTA, navigator: { onLine: true },
    document: { createElement: () => ({ style: {}, textContent: '' }) },
    lineas: [{ producto_id: 'p1', codigo: 'ED-000001', nombre: 'Ventilador', precio: PRECIO, cantidad: 1 }],
    errorImpresora: () => '', socio: ruta === 'dolarones' ? { ...SOCIO } : null, codigoSocio: ruta === 'dolarones' ? 'DC-x' : '', valesCargados: [],
    catalogo: new Map(), pedidoCargado: ruta === 'pedido' ? { id: 'ped-1', folio: 17, saldo: 10000 } : null,
    preguntarSocio: async () => 'cobrar', abrirAlta() {}, promoAgotada() {},
    impresionRemota: () => false, exigirCaja: () => true, cajaActual: () => 'Caja 1', dolaronesPedidos: () => (ruta === 'dolarones' ? 1000 : 0),
    descuento: null, descuentoAplicado: () => 0, revisarVencimientoDescuento: () => false, promoActual: () => 0, totalNeto: () => PRECIO, pintarDescuento() {},
    pesos: (c: number) => `$${c / 100}`, dolares: String, avisoReferido: String, quitarSocio() {}, sincronizar() {}, refrescarMeta() {}, cargarCatalogo() {}, pintarImpresora() {}, promoConfig: null,
    abrirCajon: async () => true, imprimirTicket: async (venta: unknown) => { impresos.push(venta); return true; },
    store: async (almacen: string, _m: string, fn: any) => fn({ put(v: unknown) { if (almacen === 'ventas') guardadas.push(v); } }),
    fetch: async (r: string, o: any) => {
      cuerpos.push(o.body);
      if (op.fetch) return op.fetch(r, o);
      const status = op.status ?? 201;
      return { ok: status < 400, status, json: async () => ({ id: JSON.parse(o.body).id, ganados: 0, vale_emitido: null, saldo_pedido: null, ...op.respuesta }) };
    },
    ...op.contexto,
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const cobrar = runInNewContext(`let idVenta = null, creadoEnVenta = null, cobrando = false, folioIncierto = null, cobroIncierto = null;
    function pintar() {}
    ${entre('async function cobrarConDolarones(', '/* ---------- pedidos por WhatsApp')}
    ${avisoRojo}\n${entre('function textoFalla(', '/**\n * Escribir o escanear P-17')}
    ${entre('async function cobrarConPedido(', '/* ---------- cobro: primero')}
    ${entre('function errorClave(', "for (const id of ['clave-rastreo'")}
    ${entre('async function cobrar(', 'let sincronizando = false;')}; cobrar`, contexto);
  return { cobrar: () => cobrar(op.forma ?? 'tarjeta') as Promise<unknown>, $, impresos, guardadas, cuerpos, contexto };
}
export const rojos = (c: ReturnType<typeof montar>) => c.$('aviso').hijos.map((h: any) => h.textContent as string);

export const RUTAS: Ruta[] = ['normal', 'dolarones', 'pedido'];
