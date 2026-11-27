// node --test src/caja-ventana-ticket.test.ts
// Issue #945: cerrar la ventana del ticket («Cerrar» o Esc) mientras una cancelación, una aprobación o un cupón espera al servidor no debe
// perder el final: el aviso, el comprobante o el cupón y los refrescos salen aunque la ventana ya no esté. El código REAL de public/caja.html
// (la ventana del ticket y las devoluciones) corre contra una pantalla mínima; la petición se deja a medias, se cierra la ventana y recién entonces responde.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { comprobanteCancelacion, comprobanteDevolucion } from '../public/ticket.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};

function elemento(extra: Record<string, unknown> = {}) {
  const e: any = { hidden: false, textContent: '', innerHTML: '', value: '', style: {}, dataset: {}, oyentes: {} as Record<string, (ev?: any) => any>, enfocado: 0,
    addEventListener(tipo: string, f: (ev?: any) => any) { e.oyentes[tipo] = f; },
    insertAdjacentHTML() {}, querySelector: () => null, querySelectorAll: () => [], focus() { e.enfocado++; }, ...extra };
  return e;
}

/** Una promesa que se resuelve a mano: la respuesta del servidor llega cuando la prueba lo decide. */
function diferida<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((ok) => { resolver = ok; });
  return { promesa, resolver };
}

const respuesta = (cuerpo: unknown, status = 200) => ({ ok: status < 400, status, json: async () => cuerpo });

function ticketServidor(estado: { cancelada: boolean }) {
  return {
    id: 'VENTA-0001', creado_en: '2026-11-26T10:00:00Z', forma_pago: 'efectivo', total: 5000, dolarones: 0, dolarones_devueltos: 0, devuelto: 0,
    cancelada: estado.cancelada ? 1 : 0, cancelada_caja: 'caja-1', cancelada_por: 'cajero', cancelada_en: '2026-11-26T10:05:00Z', motivo_cancelacion: 'motivo',
    lineas: [{ nombre: 'Pieza', precio: 5000, cantidad: 1, cancelada_cantidad: 0 }],
    devoluciones: [{ id: 'DEV-1', nombre: 'Pieza', cantidad: 1, importe: 5000, dolarones: 0, cupon: 0, autor: 'cajero', caja: 'caja-1', creado_en: '2026-11-26T10:05:00Z', motivo: 'motivo' }],
  };
}

function montar() {
  const els = new Map<string, any>();
  const dialogo = elemento({ open: false });
  dialogo.showModal = () => { dialogo.open = true; dialogo.showModales = (dialogo.showModales ?? 0) + 1; };
  dialogo.close = () => { if (dialogo.open) { dialogo.open = false; dialogo.oyentes.close?.(); } };
  const $ = (id: string) => {
    if (!els.has(id)) els.set(id, id === 'dialogo-ticket' ? dialogo : elemento(id === 'dialogo-devolucion' ? { open: false } : {}));
    return els.get(id);
  };
  const servidor = { cancelada: false, solicitud: diferida<any>(), peticiones: [] as string[] };
  const impresos: any[] = [];
  const vales: any[] = [];
  const contexto: Record<string, unknown> = {
    $, escapar: String, pesos: (n: number) => `$${n / 100}`, dolares: (n: number) => `D${n / 100}`, cuponPorcentaje: 10,
    cajaActual: () => 'caja-1', crypto: { randomUUID: () => 'UUID-1' }, localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 1, clearInterval() {}, document: {},
    pintarDetalle: () => '', formularioPieza: () => '', formularioTodo: () => '', formularioCorreccion: () => '',
    impresoraLista: () => true, errorImpresora: () => '', pintarImpresora() {},
    imprimirTicket: async () => true, imprimirVale: async (v: unknown) => { vales.push(v); return true; },
    imprimirDevolucion: async (d: unknown) => { impresos.push(d); return true; },
    comprobanteCancelacion, comprobanteDevolucion,
    cargarTickets: async () => {}, cargarCatalogo: async () => {}, reimprimirValeDeVenta: async () => {},
    fetch: (url: string, init?: { method?: string }) => {
      servidor.peticiones.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
      if (url.includes('devoluciones-pedidas')) return Promise.resolve(respuesta([]));
      if (!init?.method) return Promise.resolve(respuesta(ticketServidor(servidor)));
      return servidor.solicitud.promesa;   // el POST espera a que la prueba responda
    },
  };
  const rutina = runInNewContext(`${entre('let encontradas = new Map();', '/* ---------- eventos ---------- */')}
    ({ abrirTicket, esperando: () => esperando, aprobacion: () => aprobacionCancelar })`, contexto);
  const clic = (dataset: Record<string, string | undefined>, { form = {}, panel = {} } = {}) => {
    const boton = elemento({ dataset, closest: (s: string) => (s === 'button' ? boton : s === '.aprobacion' ? panelEl : formEl) });
    const campos: Record<string, any> = { '.motivo-cancelar': elemento({ value: 'motivo' }), '.motivo-pago': elemento({ value: 'motivo' }), ...form };
    const formEl = elemento({ querySelector: (s: string) => campos[s] ?? null, querySelectorAll: () => [], parentElement: elemento() });
    const camposPanel: Record<string, any> = { '.aviso-aprobacion': elemento(), '.pin-dueno': elemento({ value: '123456' }), '.aprobador': elemento({ value: 'g@x' }), ...panel };
    const panelEl = elemento({ querySelector: (s: string) => camposPanel[s] ?? null, querySelectorAll: () => [] });
    return $('ticket-contenido').oyentes.click({ target: { closest: (s: string) => (s === 'button' ? boton : null) } });
  };
  const cerrarVentana = () => dialogo.close();
  return { ...rutina, $, dialogo, servidor, impresos, vales, clic, cerrarVentana };
}

test('#945 cancelación: con la ventana cerrada a media petición el aviso y el comprobante salen y la ventana no se reabre', async () => {
  const c = montar();
  await c.abrirTicket('VENTA-0001');
  assert.equal(c.dialogo.open, true);
  const pendiente = c.clic({ confirmarTodo: '' });
  c.cerrarVentana();   // Esc o «Cerrar» mientras el servidor trabaja
  c.servidor.cancelada = true;
  c.servidor.solicitud.resolver(respuesta({ id: 'DEV-1', devuelto: 5000 }, 200));
  await pendiente;   // sin el arreglo: TypeError por ticketAbierto = null
  assert.equal(c.impresos.length, 1, 'se imprime el comprobante para firmar');
  assert.equal(c.impresos[0].titulo, 'CANCELACION DE TICKET');
  assert.match(c.$('aviso').textContent, /Ticket cancelado\. Devuelve \$50/);
  assert.match(c.$('aviso').textContent, /Comprobante impreso/);
  assert.match(c.$('aviso').textContent, /VENTA-00/, 'dice de qué ticket habla');
  assert.equal(c.dialogo.open, false, 'no se reabre la ventana que el cajero cerró');
  assert.equal(c.dialogo.showModales, 1);
});

test('#945 cancelación con la ventana abierta: todo sigue igual (aviso y comprobante en la ventana)', async () => {
  const c = montar();
  await c.abrirTicket('VENTA-0001');
  const pendiente = c.clic({ confirmarTodo: '' });
  c.servidor.cancelada = true;
  c.servidor.solicitud.resolver(respuesta({ id: 'DEV-1', devuelto: 5000 }, 200));
  await pendiente;
  assert.equal(c.impresos.length, 1);
  assert.match(c.$('ticket-aviso').textContent, /Ticket cancelado\. Devuelve \$50.*Comprobante impreso/);
  assert.equal(c.$('aviso').textContent, '', 'el aviso principal no se toca');
});

test('#945 aprobación con PIN de una pieza: con la ventana cerrada a media petición sale el aviso y el comprobante', async () => {
  const c = montar();
  await c.abrirTicket('VENTA-0001');
  // Primero el servidor pide aprobación de gerencia para devolver dinero de la pieza.
  const pide = c.clic({ confirmarLinea: '1' }, { form: { '.devolver-en': elemento({ value: 'efectivo' }) } });
  c.servidor.solicitud.resolver(respuesta({ error: 'Pide al supervisor.', requiere_aprobacion: true, duenos: [] }, 403));
  await pide;
  assert.equal(c.aprobacion().linea, '1');
  c.servidor.solicitud = diferida();
  const pendiente = c.clic({ aprobarPin: '' });
  c.cerrarVentana();
  c.servidor.solicitud.resolver(respuesta({ id: 'DEV-1', devuelto: 5000 }, 200));
  await pendiente;   // sin el arreglo: TypeError en aprobacionCancelar.cantidad
  assert.equal(c.impresos.length, 1);
  assert.equal(c.impresos[0].titulo, 'DEVOLUCION DE PIEZAS');
  assert.match(c.$('aviso').textContent, /Pieza cancelada\. Devuelve \$50/);
  assert.equal(c.dialogo.open, false);
});

test('#945 aprobación a distancia: con la ventana cerrada la solicitud queda vigilada', async () => {
  const c = montar();
  await c.abrirTicket('VENTA-0001');
  const pide = c.clic({ confirmarTodo: '' });
  c.servidor.solicitud.resolver(respuesta({ error: 'Pasaron 5 minutos.', requiere_aprobacion: true, duenos: [] }, 403));
  await pide;
  c.servidor.solicitud = diferida();
  const pendiente = c.clic({ enviarDueno: '' });
  c.cerrarVentana();
  c.servidor.solicitud.resolver(respuesta({ solicitud_id: 'SOL-1' }, 202));
  await pendiente;   // sin el arreglo: TypeError en ticketAbierto.id
  assert.equal(c.esperando().solicitudId, 'SOL-1');
  assert.equal(c.esperando().ticketId, 'VENTA-0001');
});

test('#945 cupón: con la ventana cerrada a media petición el cupón se imprime y el aviso es visible', async () => {
  const c = montar();
  await c.abrirTicket('VENTA-0001');
  const pendiente = c.clic({ cuponTodo: '' });
  c.cerrarVentana();
  c.servidor.cancelada = true;
  c.servidor.solicitud.resolver(respuesta({ cupon: { codigo: 'CUP-1', importe: 5000 }, dolarones: 0 }, 200));
  await pendiente;   // sin el arreglo: TypeError por ticketAbierto = null
  assert.deepEqual(c.vales, [{ codigo: 'CUP-1', importe: 5000 }], 'el cupón sale por la impresora');
  assert.match(c.$('aviso').textContent, /Cupón de D50 impreso/);
  assert.equal(c.dialogo.open, false, 'no se reabre la ventana');
});

test('#945 un fallo con la ventana cerrada también se ve en el aviso principal', async () => {
  const c = montar();
  await c.abrirTicket('VENTA-0001');
  const pendiente = c.clic({ cuponTodo: '' });
  c.cerrarVentana();
  c.servidor.solicitud.resolver(respuesta({ error: 'Ya no se puede.' }, 409));
  await pendiente;
  assert.match(c.$('aviso').textContent, /Ya no se puede\./);
  assert.equal(c.vales.length, 0);
});
