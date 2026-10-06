// Desglose de un ticket ya cobrado (Issue #138), para la ventana de la caja
// (donde se cancelan piezas) y la de reportes (solo consulta). Recibe lo que
// devuelve GET /api/ventas/:id y regresa HTML; los eventos los pone cada pantalla.

// Nombres de piezas, correos y motivos los escriben otras personas: texto, nunca HTML.
export const escapar = (texto) =>
  String(texto ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
// Siempre con centavos (Issue #166): lo que se ve aqui debe coincidir con el ticket impreso y con los reportes.
const dos = (centavos) => (centavos / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pesos = (centavos) => `$${dos(centavos)}`;
const dolares = (centavos) => `${dos(centavos)} D`;
const hora = (iso) => new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
const fecha = (iso) => new Date(iso).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
const FORMAS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

/** Lo que el ticket sigue valiendo: total menos lo devuelto por piezas, en dinero y en Dolarones. */
export const vigente = (t) => (t.cancelada ? 0 : t.total - t.devuelto - t.dolarones_devueltos);

/**
 * Un renglon de la lista de tickets. `data-ticket` abre la ventana. Con `completo`
 * (reportes, donde la lista cruza dias y cajas) lleva fecha, caja, socio y Dolarones.
 */
export function renglonTicket(t, { completo = false } = {}) {
  asegurarEstilos();
  const parcial = !t.cancelada && t.cancelada_cantidad > 0;
  const estado = t.cancelada ? 'cancelado' : parcial ? `${t.cancelada_cantidad} de ${t.cantidad} devueltas` : '';
  return `
    <button type="button" class="ticket-fila ${t.cancelada ? 'cancelada' : ''}" data-ticket="${escapar(t.id)}">
      <span class="ticket-principal">
        <b>${pesos(vigente(t))}</b>${parcial ? ` <s>${pesos(t.total)}</s>` : ''}
        · ${completo ? `${fecha(t.creado_en)} ` : ''}${hora(t.creado_en)} · ${FORMAS[t.forma_pago] ?? escapar(t.forma_pago)}
        ${completo ? `· ${escapar(t.caja || 'sin caja')}${t.con_socio ? ' · socio' : ''}${t.dolarones ? ` · ${dolares(t.dolarones)}` : ''}` : ''}
        <span class="piezas">${escapar(t.piezas)}</span>
      </span>
      <span class="ticket-estado">${estado}</span>
    </button>`;
}

/**
 * El contenido de la ventana. Con `editable`, cada pieza que sigue en el
 * ticket lleva «Cancelar» y al final va «Cancelar todo lo que queda».
 */
export function pintarDetalle(t, { editable = false } = {}) {
  asegurarEstilos();
  const quedan = t.lineas.reduce((n, l) => n + l.cantidad - l.cancelada_cantidad, 0);
  const puedeCancelar = editable && !t.cancelada && quedan > 0;
  const socio = t.socio ? ` · Socio #${t.socio.numero} ${escapar(t.socio.nombre)}` : '';

  const renglones = t.lineas.map((l) => {
    const resto = l.cantidad - l.cancelada_cantidad;
    return `
      <tr class="${resto === 0 || t.cancelada ? 'devuelta' : ''}">
        <td>${escapar(l.nombre)}<div class="codigo">${escapar(l.codigo)}</div></td>
        <td class="num">${resto}${l.cancelada_cantidad ? `<div class="menos">${l.cancelada_cantidad} cancelada${l.cancelada_cantidad > 1 ? 's' : ''}</div>` : ''}</td>
        <td class="num">${pesos(l.precio)}</td>
        <td class="num">${pesos(l.precio * resto)}</td>
        <td>${puedeCancelar && resto > 0 ? `<button type="button" class="quitar" data-cancelar-linea="${l.id}" data-quedan="${resto}">Cancelar</button>` : ''}</td>
      </tr>
      <tr class="form-linea" id="form-linea-${l.id}" hidden><td colspan="5"></td></tr>`;
  }).join('');

  const cifras = [
    t.descuento ? ['Subtotal', pesos(t.total + t.descuento)] : null,
    t.descuento ? ['Descuento', `− ${pesos(t.descuento)}`] : null,
    ['Total cobrado', pesos(t.total)],
    t.dolarones ? ['Pagado con Dolarones', dolares(t.dolarones)] : null,
    t.efectivo ? ['Efectivo recibido / cambio', `${pesos(t.efectivo)} / ${pesos(t.cambio)}`] : null,
    t.devuelto ? ['Devuelto en dinero', `− ${pesos(t.devuelto)}`] : null,
    t.dolarones_devueltos ? ['Regresado al saldo', `− ${dolares(t.dolarones_devueltos)}`] : null,
    t.devuelto || t.dolarones_devueltos || t.cancelada ? ['Queda vendido', pesos(vigente(t)), 'fuerte'] : null,
  ].filter(Boolean);

  const historial = t.devoluciones.length === 0 ? '' : `
    <h3>Piezas canceladas</h3>
    <ul class="historial">${t.devoluciones.map((d, i) => `
      <li><b>${d.cantidad} × ${escapar(d.nombre)}</b> — ${pesos(d.importe)}${d.dolarones ? ` + ${dolares(d.dolarones)}` : ''}
        ${editable ? `<button type="button" class="secundario" data-imprimir-devolucion="${i}">Imprimir comprobante</button>` : ''}
        <div>${fecha(d.creado_en)} ${hora(d.creado_en)} · ${escapar(d.caja || 'sin caja')} · ${escapar(d.autor)} · «${escapar(d.motivo)}»</div></li>`).join('')}
    </ul>`;

  return `
    <h2>Ticket de las ${hora(t.creado_en)}</h2>
    <p class="nota">${fecha(t.creado_en)} · ${FORMAS[t.forma_pago] ?? escapar(t.forma_pago)} · ${escapar(t.caja || 'sin caja')}
      · cobró ${escapar(t.cajero || '—')}${socio}</p>
    ${t.cancelada ? `<p class="ticket-cancelado">Ticket cancelado completo ${fecha(t.cancelada_en)} ${hora(t.cancelada_en)}
      por ${escapar(t.cancelada_por)}: «${escapar(t.motivo_cancelacion)}»
      ${editable ? '<button type="button" class="secundario" data-imprimir-cancelacion>Imprimir comprobante</button>' : ''}</p>` : ''}
    <table class="desglose">
      <thead><tr><th>Pieza</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Importe</th><th></th></tr></thead>
      <tbody>${renglones}</tbody>
    </table>
    <table class="cifras">${cifras.map(([a, b, clase = '']) => `<tr class="${clase}"><td>${a}</td><td class="num">${b}</td></tr>`).join('')}</table>
    ${historial}
    ${editable && !t.cancelada && !t.socio ? '<button type="button" class="secundario" data-imprimir-vale>Imprimir vale</button>' : ''}
    ${puedeCancelar ? `
      <div class="cancelar-todo">
        <button type="button" class="quitar" data-cancelar-todo>Cancelar todo lo que queda (${quedan} pieza${quedan > 1 ? 's' : ''})</button>
        <div id="form-todo" hidden></div>
      </div>` : ''}`;
}

/** Lo que imprime imprimirDevolucion para la devolucion `i` del ticket (piezas sueltas). */
export function comprobanteDevolucion(t, i) {
  const d = t.devoluciones[i];
  return {
    titulo: 'DEVOLUCION DE PIEZAS', caja: d.caja, cajero: d.autor, creado_en: d.creado_en,
    ticket_creado_en: t.creado_en, forma_pago: t.forma_pago,
    piezas: [{ nombre: d.nombre, cantidad: d.cantidad, importe: d.importe + d.dolarones }],
    dinero: d.importe, dolarones: d.dolarones, motivo: d.motivo,
  };
}

/** Lo que imprime imprimirDevolucion al cancelar el ticket completo: solo lo que quedaba. */
export function comprobanteCancelacion(t) {
  return {
    titulo: 'CANCELACION DE TICKET', caja: t.cancelada_caja, cajero: t.cancelada_por, creado_en: t.cancelada_en,
    ticket_creado_en: t.creado_en, forma_pago: t.forma_pago,
    piezas: t.lineas.filter((l) => l.cantidad > l.cancelada_cantidad).map((l) => ({
      nombre: l.nombre, cantidad: l.cantidad - l.cancelada_cantidad, importe: l.precio * (l.cantidad - l.cancelada_cantidad),
    })),
    dinero: t.total - t.dolarones - t.devuelto, dolarones: t.dolarones - t.dolarones_devueltos, motivo: t.motivo_cancelacion,
  };
}

/** El formulario de una pieza: cuantas (si hay mas de una) y el motivo. */
export function formularioPieza(lineaId, quedan) {
  return `
    <div class="form-cancelar">
      ${quedan > 1 ? `<label>Cuántas <input type="number" class="cantidad-cancelar" min="1" max="${quedan}" value="1" inputmode="numeric"></label>` : ''}
      <input type="text" class="motivo-cancelar" maxlength="200" placeholder="Motivo de la cancelación">
      <div class="botones">
        <button type="button" class="secundario" data-volver>Volver</button>
        <button type="button" class="quitar" data-confirmar-linea="${lineaId}">Confirmar y devolver</button>
      </div>
    </div>`;
}

export function formularioTodo() {
  return `
    <div class="form-cancelar">
      <input type="text" class="motivo-cancelar" maxlength="200" placeholder="Motivo de la cancelación">
      <div class="botones">
        <button type="button" class="secundario" data-volver>Volver</button>
        <button type="button" class="quitar" data-confirmar-todo>Confirmar cancelación</button>
      </div>
    </div>`;
}

let estilos = false;
function asegurarEstilos() {
  if (estilos) return;
  estilos = true;
  const css = document.createElement('style');
  css.textContent = `
    .ventana-ticket h3 { font-size: 14px; color: #16366B; margin: 14px 0 6px; }
    .ventana-ticket .desglose, .ventana-ticket .cifras { width: 100%; border-collapse: collapse; font-size: 14px;
      font-variant-numeric: tabular-nums; }
    .ventana-ticket .desglose th { font-size: 12px; color: #5b6478; font-weight: 600; text-align: left; padding: 4px; }
    .ventana-ticket .desglose td { padding: 7px 4px; border-bottom: 1px solid #dfe3ea; vertical-align: top; }
    .ventana-ticket .num { text-align: right; white-space: nowrap; }
    .ventana-ticket .codigo { font-size: 11px; color: #78839a; font-family: ui-monospace, monospace; }
    .ventana-ticket .menos { font-size: 11px; color: #D72B32; }
    .ventana-ticket tr.devuelta td:not(:last-child) { color: #9aa2b1; text-decoration: line-through; }
    .ventana-ticket .cifras { margin-top: 10px; }
    .ventana-ticket .cifras td { padding: 3px 4px; }
    .ventana-ticket .cifras tr.fuerte td { font-weight: 800; }
    .ventana-ticket button.quitar { border: 1px solid #D72B32; background: #fff; color: #D72B32; border-radius: 8px;
      padding: 6px 10px; font-size: 13px; cursor: pointer; white-space: nowrap; }
    .ventana-ticket button.quitar:disabled { opacity: .5; cursor: not-allowed; }
    .ventana-ticket button.secundario { border: 1px solid #dfe3ea; background: #fff; color: #5b6478; border-radius: 8px;
      padding: 6px 10px; font-size: 13px; cursor: pointer; }
    .ventana-ticket .form-cancelar { display: grid; gap: 6px; padding: 6px 0; }
    .ventana-ticket .form-cancelar input { width: 100%; padding: 8px; font-size: 15px; border: 1px solid #dfe3ea;
      border-radius: 8px; }
    .ventana-ticket .form-cancelar label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #5b6478; margin: 0; }
    .ventana-ticket .form-cancelar label input { width: 90px; }
    .ventana-ticket .botones { display: flex; gap: 6px; justify-content: flex-end; }
    .ventana-ticket .cancelar-todo { margin-top: 14px; }
    .ventana-ticket .historial { margin: 0; padding-left: 18px; font-size: 13px; }
    .ventana-ticket .historial div { color: #5b6478; font-size: 12px; }
    .ventana-ticket .historial li { margin-bottom: 6px; }
    .ventana-ticket .historial button, .ventana-ticket .ticket-cancelado button { margin-left: 6px; padding: 3px 8px; font-size: 12px; }
    .ventana-ticket .ticket-cancelado { background: #fdecec; color: #D72B32; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
    .ticket-fila { display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%;
      padding: 8px 4px; border: 0; border-bottom: 1px solid #dfe3ea; background: none; font: inherit; font-size: 13px;
      text-align: left; cursor: pointer; color: inherit; }
    .ticket-fila:hover { background: #f4f6f9; }
    .ticket-fila .ticket-principal { min-width: 0; }
    .ticket-fila .piezas { display: block; color: #78839a; font-size: 11px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; max-width: 260px; }
    .ticket-fila s { color: #9aa2b1; font-size: 12px; }
    .ticket-fila.cancelada .ticket-principal { opacity: .5; text-decoration: line-through; }
    .ticket-fila .ticket-estado { font-size: 11px; color: #D72B32; white-space: nowrap; }`;
  document.head.append(css);
}
