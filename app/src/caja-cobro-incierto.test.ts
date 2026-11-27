// node --test src/caja-cobro-incierto.test.ts
// Issue #933: con un cobro en duda (la respuesta no llegó) la caja solo deja repetir ESE cobro. Todo cambio al ticket pasa por `cambiarTicket()`
// (public/caja.html); aquí se corre su código REAL contra una pantalla mínima, una prueba por cada vía de escape conocida. Lo que se guarda
// al recargar y su validación viven en public/venta.js. El reintento tras recargar sale idéntico: caja-botones-cobro.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PUERTA } from './prueba-caja.ts';
import { cobroEnDuda, fotoDeVenta, ventaRecuperada, totales, cancelarPideConfirmar, guiaVale, maximoCanje, pagoConDolarones, conflictoSocioVale, leerMensajeAlta, agregar, descuentoDe, huellaTicket } from '../public/venta.js';
import { codigoDeDigitos } from '../public/code128.js';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const AVISO_DUDA = 'Primero termina el cobro pendiente: toca otra vez el botón «Tarjeta».';   // el nombre del botón del cobro dudoso

/* ---------- la lógica pura (venta.js) ---------- */

test('#933 cobroEnDuda: solo si el folio del ticket es el del cobro dudoso', () => {
  assert.equal(cobroEnDuda({ idVenta: 'f1', cobroIncierto: { id: 'f1' } }), true);
  assert.equal(cobroEnDuda({ idVenta: 'f2', cobroIncierto: { id: 'f1' } }), false);
  assert.equal(cobroEnDuda({ idVenta: null, cobroIncierto: { id: 'f1' } }), false);
  assert.equal(cobroEnDuda({ idVenta: 'f1', cobroIncierto: null }), false);
});

test('#933 qué se guarda del cobro en duda: socio, código, vales, Dolarones y «sin promo»; y solo se acepta si es de ese cobro', () => {
  const socio = { id: 's1', numero: 7, nombre: 'Ana', disponible: 5000, maximo: 5000, expira_en: '2099-01-01T00:00:00Z', vale: false };
  const foto = fotoDeVenta({ socio, codigoSocio: 'DC-x', valesCargados: [{ codigo: 'DP-1' }], dolarones: 50, sinPromo: true });
  assert.deepEqual(foto, { socio, codigoSocio: 'DC-x', valesCargados: [{ codigo: 'DP-1' }], dolarones: '50', sinPromo: true });
  const guardado = JSON.parse(JSON.stringify({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: foto }));
  assert.deepEqual(ventaRecuperada(guardado), foto);
  // Sin socio ni nada: una foto vacía sigue siendo válida (el reintento es «sin socio» a propósito).
  assert.deepEqual(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: fotoDeVenta({}) }),
    { socio: null, codigoSocio: '', valesCargados: [], dolarones: '', sinPromo: false });
  // Un ticket guardado por la versión anterior (sin `venta`) o con un folio que no es el del cobro dudoso no trae nada: se carga como siempre.
  assert.equal(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' } }), null);
  assert.equal(ventaRecuperada({ idVenta: 'f2', cobroIncierto: { id: 'f1' }, venta: foto }), null);
  assert.equal(ventaRecuperada({ idVenta: 'f1', cobroIncierto: null, venta: foto }), null);
  assert.equal(ventaRecuperada(null), null);
  assert.equal(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: 'basura' }), null);
  // Lo mal formado se descarta campo por campo, sin romper la carga.
  assert.deepEqual(ventaRecuperada({ idVenta: 'f1', cobroIncierto: { id: 'f1' }, venta: { socio: [1], codigoSocio: 5, valesCargados: 'x', dolarones: 3, sinPromo: 'sí' } }),
    { socio: null, codigoSocio: '', valesCargados: [], dolarones: '', sinPromo: false });
});

/* ---------- el folio y lo que define la venta solo cambian en la puerta ---------- */

/** El script de la caja con los comentarios borrados (en su lugar, para que las posiciones sigan valiendo). */
const SCRIPT = (() => {
  const t = fuente.slice(fuente.indexOf('<script type="module">'));
  const blanco = (m: string) => m.replace(/[^\n]/g, ' ');
  return t.replace(/\/\*[\s\S]*?\*\//g, blanco).replace(/(^|[^:'"`\\])(\/\/[^\n]*)/g, (_m, a, b) => a + blanco(b));
})();

/** Dónde termina el paréntesis que se abre en `abre`: salta cadenas, plantillas (con sus `${}`) y expresiones regulares. */
function cierreDeParentesis(t: string, abre: number): number {
  const salta = (i: number, fin: string): number => {                       // i: justo después de la comilla que abre
    for (; i < t.length; i++) {
      if (t[i] === '\\') { i++; continue; }
      if (t[i] === fin) return i;
      if (fin === '`' && t[i] === '$' && t[i + 1] === '{') i = codigo(i + 2, '}') ;
    }
    return i;
  };
  const codigo = (i: number, cierre: string): number => {                   // i: justo después de la apertura; devuelve donde cierra
    let prof = 0, previo = '(';
    for (; i < t.length; i++) {
      const c = t[i];
      if (c === "'" || c === '"' || c === '`') { i = salta(i + 1, c); previo = 'x'; continue; }
      if (c === '/' && '(,=:[!&|?{};'.includes(previo)) {                  // expresión regular
        let clase = false;
        for (i++; i < t.length; i++) {
          if (t[i] === '\\') { i++; continue; }
          if (t[i] === '[') clase = true; else if (t[i] === ']') clase = false; else if (t[i] === '/' && !clase) break;
        }
        previo = 'x';
        continue;
      }
      if ('([{'.includes(c)) prof++;
      else if (')]}'.includes(c)) { if (prof === 0 && c === cierre) return i; prof--; }
      if (!/\s/.test(c)) previo = c;
    }
    return i;
  };
  return codigo(abre + 1, ')');
}

const PUERTAS = [...SCRIPT.matchAll(/\bcambiarTicket\(/g)].map((m) => {
  const abre = (m.index as number) + m[0].length - 1;
  return [abre, cierreDeParentesis(SCRIPT, abre)] as const;
});
const dentroDeLaPuerta = (pos: number) => PUERTAS.some(([a, c]) => pos > a && pos < c);
/** El manejador o la función de primer nivel donde está `pos`. */
function quien(pos: number): string {
  const antes = SCRIPT.slice(0, pos);
  const arranques = [...antes.matchAll(/^(?:async function (\w+)|function (\w+)|\$\('([\w-]+)'\)\.addEventListener|(document\.addEventListener\('\w+')|addEventListener\('(\w+)'|(?:let|const) (\w+))/gm)];
  const a = arranques.at(-1);
  return a ? (a[1] ?? a[2] ?? (a[3] && `#${a[3]}`) ?? a[4] ?? (a[5] && `window:${a[5]}`) ?? a[6]) as string : '(inicio)';
}

/** Cada vez que el código cambia `variable` fuera de la puerta: «dónde». */
function fueraDeLaPuerta(patrones: RegExp[]): string[] {
  const salida: string[] = [];
  for (const patron of patrones) {
    for (const m of SCRIPT.matchAll(patron)) {
      const pos = m.index as number;
      const linea = SCRIPT.slice(SCRIPT.lastIndexOf('\n', pos) + 1, SCRIPT.indexOf('\n', pos));
      if (/^\s*(?:let|const) /.test(linea) || dentroDeLaPuerta(pos)) continue;   // la declaración y lo que corre dentro de cambiarTicket(() => …)
      salida.push(quien(pos));
    }
  }
  return salida.sort();
}

test('#933 el escáner de la prueba entiende el script: la puerta existe y sus llamadas abarcan lo esperado', () => {
  assert.ok(PUERTAS.length >= 15, `solo ${PUERTAS.length} llamadas a cambiarTicket`);
  const buscar = SCRIPT.indexOf('if (!cambiarTicket(() => {\n    if (sumar) busquedaSocio++;');
  assert.ok(buscar > 0 && dentroDeLaPuerta(SCRIPT.indexOf('else quitarSocio();', buscar)), 'buscarSocio cambia el socio dentro de la puerta');
  assert.equal(dentroDeLaPuerta(SCRIPT.indexOf('function cambiarTicket(')), false);
});

const VARIABLES: [string, RegExp[], string[], string][] = [
  ['idVenta', [/\bidVenta\s*=(?!=)/g], ['cambiarTicket', 'cobrar', 'pintar', 'revisarVencimientoDescuento', 'cobrar', 'ticketRecuperado'].sort(),
    'el folio: la puerta, el cobro (nuevo folio y venta ya cobrada), pintar() y el vencimiento (los dos nunca con duda) y la carga'],
  ['lineas', [/\blineas\s*=(?!=)/g, /\blineas\.(?:push|splice|pop|shift|unshift|sort|reverse)\(/g, /\blinea\.cantidad\s*[-+*]?=(?!=)/g], ['cobrar', 'ticketRecuperado'].sort(),
    'las piezas: solo la venta ya cobrada y la carga del ticket guardado'],
  ['socio', [/\bsocio\s*=(?!=)/g, /\bsocio\.\w+\s*=(?!=)/g, /\}\s*=\s*antes\b/g], ['buscarSocio', 'quitarSocio', 'refrescarSaldoTrasLlegada', 'ticketRecuperado'].sort(),
    'el socio: quitarSocio() (lo llaman la puerta y el cobro terminado), el rechazo de una búsqueda, el saldo tras acreditar la llegada y la carga'],
  ['codigoSocio', [/\bcodigoSocio\s*=(?!=)/g], ['quitarSocio'],
    'el código de socio: quitarSocio()'],
  ['valesCargados', [/\bvalesCargados\s*=(?!=)/g, /\bvalesCargados\.(?:push|splice|pop|shift|unshift)\(/g], ['quitarSocio'],
    'los vales: quitarSocio()'],
  ['sinPromo', [/\bsinPromo\s*=(?!=)/g], ['cobrar'],
    '«ya usó la promo»: solo la venta ya cobrada (la carga lo asigna desde la foto, abajo)'],
  ['pedidoCargado', [/\bpedidoCargado\s*=(?!=)/g], ['cobrar', 'ticketRecuperado'].sort(),
    'el pedido: la venta ya cobrada y la carga'],
  ['descuento', [/\bdescuento\s*=(?!=)/g, /\bdescuento\.\w+\s*=(?!=)/g], ['cobrar', 'pintar', 'revisarVencimientoDescuento', 'ticketRecuperado'].sort(),
    'el descuento: la venta ya cobrada, pintar() (si ya no corresponde, nunca con duda), el vencimiento y la carga'],
];

for (const [variable, patrones, permitido, porque] of VARIABLES) {
  test(`#933 «${variable}» solo cambia dentro de cambiarTicket() salvo en ${permitido.length} sitios conocidos: ${porque}`, () => {
    assert.deepEqual(fueraDeLaPuerta(patrones), permitido, `una mutación nueva de ${variable} fuera de la puerta es una vía de escape con un cobro en duda`);
  });
}

/* ---------- la pantalla: el código real de cada vía, con un cobro en duda ---------- */

function elemento(id: string, foco: string[]) {
  const e: any = { id, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, returnValue: '', style: {}, dataset: {}, contentWindow: {},
    oyentes: {} as Record<string, ((ev?: any) => unknown)[]>,
    addEventListener(t: string, f: (ev?: any) => unknown) { (e.oyentes[t] ??= []).push(f); },
    async disparar(t: string, ev: any = {}) { for (const f of e.oyentes[t] ?? []) await f(ev); },
    focus() { foco.push(id); }, click() { for (const f of e.oyentes.click ?? []) f(); }, close() { e.open = false; }, showModal() { e.open = true; }, replaceChildren() {}, append() {} };
  return e;
}
const SOCIO = { id: 's1', numero: 7, nombre: 'Ana', disponible: 50000, regalo_disponible: 0, maximo: 50000, expira_en: '2099-01-01T00:00:00Z', vale: false };
const SOCIO_NUEVO = { id: 's2', numero: 8, nombre: 'Beto', disponible: 1000, regalo_disponible: 0, maximo: 1000, expira_en: '2099-01-01T00:00:00Z', vale: false };
const PEDIDO = { pedido: { id: 'ped-1', folio: 17, cliente: 'Cli', estado: 'pagado', entrega: 'tienda', saldo: 10000, saldo_vence_en: '2099-01-01T00:00:00Z', lineas: [] } };
const DESCUENTO = { id: 'd1', monto: 1000, estado: 'aprobada', vence_en: '2099-01-01T00:00:00Z' };
const lineasDe = (n: number) => Array.from({ length: n }, (_, i) => ({ codigo: `ED-00000${i}`, nombre: `Pieza ${i}`, precio: 10000, cantidad: 1, producto_id: `p${i}` }));

function montar(op: { enDuda?: boolean; lineas?: number; cobrando?: boolean; sinCuerpo?: boolean } = {}) {
  const enDuda = op.enDuda ?? true;
  const foco: string[] = [];
  const els = new Map<string, any>();
  const $ = (id: string) => { if (!els.has(id)) els.set(id, elemento(id, foco)); return els.get(id); };
  const peticiones: string[] = [];
  let teclado: (e: any) => void = () => {};
  let mensaje: (e: any) => unknown = () => {};
  const puesto = { responder: async (ruta: string): Promise<any> => ({ ok: true, json: async () => (ruta.includes('/api/pedidos/') ? PEDIDO : ruta === '/api/descuentos' ? DESCUENTO : SOCIO_NUEVO) }) };
  let pintadas = 0;
  $('dolarones').value = '50';
  const contexto: Record<string, unknown> = {
    $, totales, cancelarPideConfirmar, codigoDeDigitos, guiaVale, maximoCanje, pagoConDolarones, conflictoSocioVale, leerMensajeAlta, ...PUERTA, agregar, descuentoDe, huellaTicket,
    dolares: String, escapar: String, pesos: String, Promise, Date, Math, Number, JSON, setTimeout, clearTimeout, Object,
    navigator: { onLine: true }, location: { origin: 'https://caja' },
    document: { addEventListener: (t: string, f: (e: any) => void) => { if (t === 'keydown') teclado = f; }, querySelector: () => null },
    addEventListener: (t: string, f: (e: any) => unknown) => { if (t === 'message') mensaje = f; },
    pintar() { pintadas++; }, cerrarPaneles: () => false, pintarDescuento() {}, quitarDescuentoEnServidor() {}, limpiarDatosTransferencia() {}, totalNeto: () => 30000, cajaActual: () => 'Caja 1',
    pasaDelTopeSinDueno: () => false, AVISO_TOPE: '', catalogo: new Map(), L: lineasDe(op.lineas ?? 3), S: SOCIO,
    fetch: async (ruta: string) => { peticiones.push(ruta); return puesto.responder(ruta); },
  };
  const avisoRojo = fuente.slice(fuente.indexOf('const avisoRojo ='), fuente.indexOf('\n', fuente.indexOf('const avisoRojo =')));
  const rutinas = runInNewContext(`let cobrando = ${!!op.cobrando}, idVenta = 'folio-1', creadoEnVenta = '2026-11-25T12:00:00.000Z',
      folioIncierto = ${enDuda ? "'folio-1'" : 'null'}, cobroIncierto = ${enDuda ? `{ id: 'folio-1', boton: 'tarjeta', efectivo: 0${op.sinCuerpo ? '' : ", cuerpo: { id: 'folio-1', promo: 0 }"} }` : 'null'},
      lineas = L, sinPromo = false, socio = S, codigoSocio = 'DC-x', codigoLlegada = '', valesCargados = [], usarTodos = false, busquedaSocio = 0,
      valesPrueba = false, descuento = null, pedidoCargado = null, cancelarArmado = null;
    ${entre('function ticketEnDuda()', '// Pedido por WhatsApp cargado')}
    ${entre("$('quitar-promo').addEventListener('click'", '\nsetInterval(cargarConfigVales')}
    ${entre('async function enviarDescuento(', "$('enviar-descuento').addEventListener")}
    ${entre('function pintarSocio()', '/**\n * Con Dolarones el cobro espera')}
    ${avisoRojo}
    ${entre('async function cargarPedido(', '/**\n * Con pedido el cobro espera')}
    ${entre('// Doble Esc borra el ticket', 'function pintarRed()')}
    ({ buscarSocio, enviarDescuento, cargarPedido, abrirAlta,
       estado: () => JSON.stringify({ idVenta, socio, codigoSocio, valesCargados, sinPromo, usarTodos, lineas, descuento, pedidoCargado }),
       dudar: (id) => { idVenta = id; folioIncierto = id; cobroIncierto = { id, boton: 'tarjeta', efectivo: 0, cuerpo: { id, promo: 0 } }; } })`, contexto);
  return {
    ...rutinas, $, peticiones, foco, puesto, pintadas: () => pintadas,
    estado: () => JSON.parse(rutinas.estado() as string),
    mensajeAlta: (numero: number) => mensaje({ origin: 'https://caja', source: $('dlg-alta-marco').contentWindow, data: { tipo: 'alta-socio', numero } }),
    escape: (marca: number) => teclado({ key: 'Escape', repeat: false, timeStamp: marca }),
  };
}
type Caja = ReturnType<typeof montar>;

/** Cada vía por la que el cajero (o el lector, o una respuesta tardía) podía cambiar el ticket o soltar el folio con el cobro en duda. */
const VIAS: [string, (c: Caja) => Promise<unknown> | unknown, number?][] = [
  ['buscar un socio escribiendo su teléfono + Enter', async (c) => { c.$('socio').value = '4491112222'; await c.$('socio').disparar('keydown', { key: 'Enter' }); }],
  ['buscar un socio con el botón «Buscar»', async (c) => { c.$('socio').value = '#8'; await c.$('buscar-socio').disparar('click'); }],
  ['cerrar la ventana de alta con un socio nuevo', async (c) => { c.abrirAlta(); c.mensajeAlta(8); await c.$('dlg-alta').disparar('close'); }],
  ['teclear en «Pagar con Dolarones»', async (c) => { c.$('dolarones').value = '10'; await c.$('dolarones').disparar('input'); }],
  ['«Usar máximo»', async (c) => { await c.$('usar-maximo').disparar('click'); }],
  ['«Usar todos» de la ventana de Dolarones', async (c) => { await c.$('dlg-todos').disparar('click'); }],
  ['«No usar» de la ventana de Dolarones', async (c) => { await c.$('dlg-no').disparar('click'); }],
  ['«Ya usó la promo»', async (c) => { await c.$('quitar-promo').disparar('click'); }],
  ['«Cancelar venta» con 1 pieza (cancela de una vez)', async (c) => { await c.$('cancelar').disparar('click'); }, 1],
  ['«Cancelar venta» con 2 piezas (cancela de una vez)', async (c) => { await c.$('cancelar').disparar('click'); }, 2],
  ['«Cancelar venta» con 3 piezas, dos toques', async (c) => { await c.$('cancelar').disparar('click'); await c.$('cancelar').disparar('click'); }, 3],
  ['doble Esc con 2 piezas (cancela de una vez)', async (c) => { c.escape(1000); c.escape(1300); }, 2],
  ['pedir un descuento', async (c) => { c.$('descuento-tipo').value = 'porcentaje'; c.$('descuento-valor').value = '10'; c.$('descuento-motivo').value = 'x'; await c.enviarDescuento(); }],
  ['escribir el folio de un pedido', async (c) => { await c.cargarPedido(17); }],
];

// Una prueba por vía: si una vuelve a quedar sin puerta, falla ella y dice cuál.
for (const [nombre, via, piezas] of VIAS) {
  test(`#933 con un cobro en duda, «${nombre}» no cambia el ticket ni suelta el folio, y dice qué hacer`, async () => {
    const c = montar({ lineas: piezas });
    const antes = c.estado();
    await via(c);
    assert.deepEqual(c.estado(), antes, 'el ticket y el folio no cambian');
    assert.equal(c.estado().idVenta, 'folio-1');
    assert.equal(c.$('aviso').textContent, AVISO_DUDA, 'dice qué hacer');
    assert.deepEqual(c.peticiones, [], 'no sale ninguna petición');
    assert.equal(c.$('dolarones').value, nombre === 'teclear en «Pagar con Dolarones»' ? '10' : '50', 'lo pedido en Dolarones queda como se mandó');
  });

  test(`#933 control: sin cobro en duda, «${nombre}» sí cambia el ticket y suelta el folio (la prueba mueve el código real)`, async () => {
    const c = montar({ enDuda: false, lineas: piezas });
    const antes = c.estado();
    await via(c);
    assert.notEqual(c.estado().idVenta, 'folio-1', 'sin duda suelta el folio');
    assert.notEqual(c.$('aviso').textContent, AVISO_DUDA);
    assert.notDeepEqual(c.estado(), antes);
  });
}

test('#933 mientras se cobra (la petición va en camino) el ticket tampoco cambia: soltar el folio ahí borraría la duda', async () => {
  const c = montar({ enDuda: false, cobrando: true });
  const antes = c.estado();
  await c.$('quitar-promo').disparar('click');
  await c.$('cancelar').disparar('click');
  c.$('dolarones').value = '10';
  await c.$('dolarones').disparar('input');
  assert.deepEqual(c.estado(), antes);
});

test('#933 una respuesta que llega tarde (socio, pedido) no cambia el ticket si mientras tanto un cobro quedó en duda', async () => {
  for (const que of ['socio', 'pedido'] as const) {
    const c = montar({ enDuda: false });
    let soltar: (r: any) => void = () => {};
    c.puesto.responder = () => new Promise((r) => { soltar = r; });
    const busqueda = que === 'socio' ? ((c.$('socio').value = '#8'), c.buscarSocio()) : c.cargarPedido(17);
    c.dudar('folio-2');
    const antes = c.estado();
    soltar({ ok: true, json: async () => (que === 'socio' ? SOCIO_NUEVO : PEDIDO) });
    await busqueda;
    assert.deepEqual(c.estado(), antes, que);
    assert.equal(c.estado().idVenta, 'folio-2', que);
    assert.deepEqual(c.estado().socio, que === 'socio' ? null : antes.socio, que);
    assert.equal(c.estado().pedidoCargado, null, que);
  }
});

/* ---------- lo que invita a cobrar de otra forma ---------- */

test('#933 ningún aviso del cobro en duda invita a cobrar de otra forma ni «de nuevo»; todos dicen dónde está «Ventas de hoy»; la recarga con duda no sugiere borrar el ticket', () => {
  assert.doesNotMatch(fuente, /cobra sin Dolarones/);
  assert.doesNotMatch(fuente, /antes de cobrar de nuevo/);
  assert.doesNotMatch(fuente, /Sin red: no se pudo cobrar con Dolarones/);
  assert.equal(fuente.match(/abre «Más opciones» y luego «Ventas de hoy» para ver si la venta ya quedó registrada/g)?.length, 4, 'tres avisos del cobro y el de la recarga');
  assert.doesNotMatch(fuente, /abre «Ventas de hoy» para ver/);
  const arranque = entre('if (ticketRecuperado) {', 'pintar();\nawait pintarRechazadas()');
  const conCuerpo = arranque.slice(arranque.indexOf('cobroIncierto?.cuerpo'), arranque.indexOf('    : cobroIncierto\n'));
  assert.match(conCuerpo, /Se recuperó un cobro que quedó en duda\. Toca el único botón de cobro que sigue activo/);
  assert.doesNotMatch(conCuerpo, /Cancelar venta|Esc/);
  const sinCuerpo = arranque.slice(arranque.indexOf('    : cobroIncierto\n'), arranque.indexOf("    : 'Se recuperó el ticket"));
  assert.match(sinCuerpo, /^\s*: cobroIncierto\n\s*\? 'Se recuperó un cobro que quedó en duda\. Es de una versión anterior/);
  assert.match(sinCuerpo, /toca «Cancelar venta» dos veces/);
  assert.doesNotMatch(sinCuerpo, /único botón/, 'no promete un botón que quizá no esté: no sabe cuál era');
});

test('#933 un cobro en duda de una versión anterior (sin cuerpo guardado) sí se puede cancelar, pidiéndolo dos veces; lo demás sigue sin puerta', async () => {
  for (const piezas of [1, 2, 3]) {
    const c = montar({ sinCuerpo: true, lineas: piezas });
    await c.$('cancelar').disparar('click');
    assert.equal(c.estado().idVenta, 'folio-1', `${piezas} pieza(s): el primer toque solo arma`);
    assert.equal(c.estado().lineas.length, piezas);
    await c.$('cancelar').disparar('click');
    assert.notEqual(c.estado().idVenta, 'folio-1', `${piezas} pieza(s): el segundo cancela`);
    assert.deepEqual(c.estado().lineas, []);
  }
  for (const [nombre, via, piezas] of VIAS.filter(([n]) => !/Cancelar|Esc/.test(n))) {
    const c = montar({ sinCuerpo: true, lineas: piezas });
    const antes = c.estado();
    await via(c);
    assert.deepEqual(c.estado(), antes, `${nombre}: con un cobro sin cuerpo guardado lo demás sigue bloqueado`);
  }
});

test('#933 «Cancelar venta» con cuerpo guardado no se arma ni con dos toques (con y sin cuerpo cambia solo eso)', async () => {
  const c = montar({ lineas: 1 });
  await c.$('cancelar').disparar('click');
  await c.$('cancelar').disparar('click');
  assert.equal(c.estado().idVenta, 'folio-1');
  assert.equal(c.estado().lineas.length, 1);
});

/* ---------- dos pestañas ---------- */

test('#933 si otra pestaña resolvió el cobro en duda, esta lo suelta recargando; si sigue igual, o no hay duda, no hace nada', () => {
  const oyentes: Record<string, (e: any) => void> = {};
  const contexto: Record<string, unknown> = { ...PUERTA, JSON, idVenta: 'f1', cobroIncierto: { id: 'f1', boton: 'tarjeta', cuerpo: {} }, recargas: 0,
    addEventListener: (t: string, f: (e: any) => void) => { oyentes[t] = f; }, location: { reload() { (contexto.recargas as number)++; } } };
  runInNewContext(`const CLAVE_TICKET = 'caja-ticket';\n${entre("addEventListener('storage'", 'const descuentoAplicado')}`, contexto);
  const evento = (valor: unknown, key = 'caja-ticket') => oyentes.storage({ key, newValue: typeof valor === 'string' || valor === null ? valor : JSON.stringify(valor) });
  evento({ idVenta: 'f1', cobroIncierto: { id: 'f1' } });
  evento({ idVenta: 'f1', cobroIncierto: { id: 'f1' } }, 'otra-clave');
  evento({ idVenta: 'f9', cobroIncierto: null }, 'otra-clave');
  assert.equal(contexto.recargas, 0, 'la otra pestaña sigue en la misma duda, o es otra clave');
  for (const resuelta of [{ idVenta: null, cobroIncierto: null, lineas: [] }, { idVenta: 'f1', cobroIncierto: null }, { idVenta: 'f2', cobroIncierto: { id: 'f2' } }, null, 'ilegible{']) {
    contexto.recargas = 0;
    evento(resuelta);
    assert.equal(contexto.recargas, 1, `otra pestaña lo resolvió: ${JSON.stringify(resuelta)}`);
  }
  contexto.cobroIncierto = null;                              // esta pestaña no tiene duda: lo que escriba la otra no le toca
  contexto.recargas = 0;
  evento({ idVenta: 'f2', cobroIncierto: null });
  assert.equal(contexto.recargas, 0);
});

test('#933 con un cobro en duda no se pregunta por el socio: el reintento va con lo que ya se mandó', () => {
  assert.match(entre('async function cobrar(', 'let sincronizando = false;'), /if \(!previo && debePreguntarSocio\(socio, navigator\.onLine\)\)/);
});
