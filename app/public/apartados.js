// «Mis apartados» del monedero (Issue #669, B3 de #643; docs/UX-COMPRA.md §5).
//
// GET /api/portal/apartados trae los pedidos del teléfono del socio (también los que levantó la tienda por WhatsApp):
// aquí solo se pintan. Los textos de estado salen de funciones puras (estadoApartado, detalleApartado) para poder probarlas.
import { pesos, fechaLegible, agruparMias } from './vender.js';
import { APARTADO, fechaCorta } from './catalogo-ficha.js';
import { enlaceWhatsApp, mensajePague } from './apartar.js';

const HORA = 3_600_000;

/** Chip de estado: { clase, texto }. Cuenta regresiva en horas (P9 de REVENDEDORAS-UX): más de 6 h ámbar, 6 h o menos rojo. */
export function estadoApartado(p, ahora = Date.now()) {
  if (p.estado === 'cancelado') return { clase: 'cerrada', texto: '✕ Cancelado' };
  if (p.estado === 'vencido') return { clase: 'cerrada', texto: '✕ Vencido · la pieza volvió a la venta' };
  if (p.estado === 'vendido') {
    if (p.entrega !== 'envio') return { clase: 'ok', texto: '✓ Compra completada' };
    return p.guia ? { clase: 'ok', texto: `✓ Enviado · guía ${p.guia}` }
      : { clase: 'ok', texto: `✓ Pagado · Se envía el viernes${p.viernes_envio ? ` ${fechaCorta(p.viernes_envio)}` : ''}` };
  }
  if (p.estado !== 'apartado') return { clase: 'cerrada', texto: String(p.estado) };
  const reporte = p.pago_reportado;
  if (reporte?.estado === 'pendiente') return { clase: 'aviso', texto: '⏳ Pago en revisión · la tienda lo está revisando' };
  if (p.saldo > 0) {
    return p.entrega === 'envio' ? { clase: 'aviso', texto: `✓ Abonaste ${pesos(p.saldo)} · completa el pago para el envío` }
      : { clase: 'ok', texto: '✓ Listo para recoger' };
  }
  // Un reporte rechazado no quita el plazo: el motivo va primero y la cuenta regresiva en el detalle.
  if (reporte?.estado === 'rechazado') return { clase: 'alerta', texto: `⚠ No encontramos tu pago${reporte.motivo ? `: ${reporte.motivo}` : ''}` };
  const resta = Date.parse(p.vence_en) - ahora;
  if (!(resta > 0)) return { clase: 'alerta', texto: '⚠ Ya venció · en unos minutos la pieza vuelve a la venta' };
  const horas = Math.floor(resta / HORA);
  if (horas < 1) return { clase: 'alerta', texto: '⚠ Vence en menos de 1 h' };
  return { clase: resta <= 6 * HORA ? 'alerta' : 'aviso', texto: `${resta <= 6 * HORA ? '⚠' : '⏳'} Vence en ${horas} h` };
}

/** Las líneas de abajo del chip: qué pagar y hasta cuándo. */
export function detalleApartado(p, ahora = Date.now()) {
  if (p.estado !== 'apartado') return [];
  const lineas = [];
  const total = p.subtotal + p.envio;
  if (p.saldo === 0) {
    if (p.pago_reportado?.estado === 'pendiente') return [`Ya mandaste tu pago de ${pesos(Math.min(total, APARTADO))}: te avisamos al registrarlo.`];
    lineas.push(`Para apartarla paga ${pesos(Math.min(p.subtotal, APARTADO))} por transferencia. Total ${pesos(total)}.`);
    if (p.faltante > 0) lineas.push(`Falta por pagar ${pesos(p.faltante)}.`);
    if (Date.parse(p.vence_en) > ahora) lineas.push(`Tienes hasta el ${fechaLegible(p.vence_en)}`);
    return lineas;
  }
  if (p.faltante > 0) lineas.push(`Falta por pagar ${pesos(p.faltante)}${p.entrega === 'envio' ? '.' : ' al recogerla.'}`);
  else lineas.push('Ya está pagada.');
  lineas.push(p.entrega === 'envio' ? `Completa el pago antes del ${fechaLegible(p.vence_en)}; después sale el viernes.`
    : `Recógela en Soledad antes del ${fechaLegible(p.vence_en)}`);
  return lineas;
}

/** ¿Tiene sentido «Ya pagué»? Solo sin dinero registrado y sin un pago ya en revisión. */
export const puedeAvisarPago = (p) => p.estado === 'apartado' && p.saldo === 0 && p.pago_reportado?.estado !== 'pendiente';

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Arma <section id="apartados"> (portal.html). `api(ruta, cuerpo)` es la del portal (token incluido).
 * Devuelve { cargar(), limpiar() }: cargar() vuelve a pedir la lista; limpiar() oculta todo al cerrar sesión.
 */
export function iniciarApartados({ api }) {
  const seccion = document.getElementById('apartados');
  if (!seccion) return { cargar: async () => {}, limpiar() {} };
  const q = (sel) => seccion.querySelector(sel);
  const lista = q('.apartados-lista'), previos = q('.apartados-previos'), listaPrevios = q('.apartados-previos-lista'), aviso = q('.apartados-aviso');
  const dialogo = document.getElementById('apartado-cancelar'), confirmar = dialogo?.querySelector('.cancelar-si'), pregunta = dialogo?.querySelector('.cancelar-pregunta'), falla = dialogo?.querySelector('.cancelar-error');
  let datos = [], folioACancelar = 0, generacion = 0;

  function tarjeta(p, ahora) {
    const primera = p.lineas[0];
    const chip = estadoApartado(p, ahora);
    const li = el('li', 'apartado');
    const foto = el('span', 'apartado-foto');
    if (primera) {
      const img = new Image();
      img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', () => img.remove());   // una pieza vendida ya no tiene foto pública
      img.src = `/api/catalogo/foto/${encodeURIComponent(primera.codigo)}`;
      foto.append(img);
    }
    const cuerpo = el('div', 'apartado-cuerpo');
    cuerpo.append(
      el('p', 'apartado-nombre', p.lineas.length > 1 ? `${p.lineas.length} piezas` : primera?.nombre ?? 'Pieza'),
      el('p', 'apartado-datos', `P-${p.folio} · ${pesos(p.subtotal + p.envio)} · ${p.entrega === 'envio' ? 'Envío' : 'Recoger en tienda'}`),
      el('p', `apartado-chip ${chip.clase}`, chip.texto),
      ...detalleApartado(p, ahora).map((t) => el('p', 'apartado-detalle', t)),
    );
    const acciones = el('div', 'apartado-acciones');
    if (puedeAvisarPago(p)) {
      const pague = el('a', 'boton-enlace apartado-pague', 'Ya pagué');
      pague.href = enlaceWhatsApp(mensajePague(p.folio));
      pague.target = '_blank'; pague.rel = 'noopener';
      acciones.append(pague);
    }
    if (p.cancelable) {
      const cancelar = el('button', 'secundario apartado-cancelar', 'Cancelar');
      cancelar.type = 'button';
      cancelar.addEventListener('click', () => abrirCancelar(p));
      acciones.append(cancelar);
    }
    if (acciones.children.length) cuerpo.append(acciones);
    li.append(foto, cuerpo);
    return li;
  }

  // Se repinta cada minuto: la cuenta regresiva sale del reloj, no de otra petición.
  function pintar() {
    const ahora = Date.now();
    const { esperando, pagadas, anteriores } = agruparMias(datos);
    lista.replaceChildren(...[...esperando, ...pagadas].map((p) => tarjeta(p, ahora)));
    listaPrevios.replaceChildren(...anteriores.map((p) => tarjeta(p, ahora)));
    previos.hidden = !anteriores.length;
    q('.apartados-resumen-previos').textContent = `Anteriores (${anteriores.length})`;
    seccion.hidden = !datos.length;
  }
  setInterval(() => { if (!seccion.hidden) pintar(); }, 60_000);

  async function cargar() {
    const mia = ++generacion;
    try {
      const r = await api('apartados');
      if (mia !== generacion) return;   // llegó una carga más nueva (o cerraron sesión)
      datos = r.apartados;
      pintar();
    } catch { if (mia === generacion && !datos.length) seccion.hidden = true; /* sin apartados, el monedero sigue igual */ }
  }

  function abrirCancelar(p) {
    folioACancelar = p.folio;
    pregunta.textContent = `¿Cancelar el apartado P-${p.folio}? La pieza vuelve a la venta. No se te cobra nada.`;
    falla.textContent = '';
    dialogo.showModal();
  }
  confirmar?.addEventListener('click', async () => {
    confirmar.disabled = true; falla.textContent = '';
    try {
      await api(`apartados/${folioACancelar}/cancelar`, {});
      dialogo.close();
      aviso.textContent = `Cancelaste el apartado P-${folioACancelar}.`;
      await cargar();
    } catch (e) {
      falla.textContent = e instanceof TypeError ? 'No pudimos conectar. Revisa tu red e intenta de nuevo.' : e.message;
      if (e.status === 409 || e.status === 404) await cargar();   // cambió en la tienda: se muestra como quedó
    } finally { confirmar.disabled = false; }
  });
  dialogo?.querySelector('.cancelar-no')?.addEventListener('click', () => dialogo.close());

  return {
    cargar,
    limpiar() { generacion++; datos = []; seccion.hidden = true; lista.replaceChildren(); listaPrevios.replaceChildren(); aviso.textContent = ''; },
  };
}
