// Apartar una pieza desde la ficha del portal (Issue #668, B1 de #643; docs/UX-COMPRA.md §5).
//
// El navegador solo manda { id, codigo, entrega }. Precio, nombre y teléfono salen del servidor (POST /api/portal/apartar).
// venta.js no se sirve en el host del portal: envioDe se copia aquí y src/apartar.test.ts la ata a venta.js.
import { pesos, fechaLegible } from './vender.js';
import { APARTADO, ENVIO_COSTO, ENVIO_GRATIS_DESDE, viernesDeEnvio, fechaCorta, WHATSAPP, enlaceLoQuiero } from './catalogo-ficha.js';

/** Copia de envioDe (app/public/venta.js): bajo $1,000 el envío cuesta $99. */
export const envioDe = (precio) => (precio > 0 && precio < ENVIO_GRATIS_DESDE ? ENVIO_COSTO : 0);
/** Lo que se paga al apartar: $100, o la pieza completa si cuesta menos (anticipoMinimoDe de venta.js). */
export const aPagarDe = (precio) => Math.min(precio, APARTADO);

/** Qué pasa según cómo la quiere: una frase corta, con los importes que calcula el servidor al apartar. */
export function explicaEntrega(precio, entrega, ahora = Date.now()) {
  const pagar = aPagarDe(precio);
  if (entrega !== 'envio') {
    return pagar >= precio
      ? `Pagas ${pesos(precio)} por transferencia y pasas por ella a Soledad.`
      : `Pagas ${pesos(pagar)} por transferencia y el resto al recogerla. Con tu pago te la guardamos 7 días.`;
  }
  const envio = envioDe(precio);
  const resto = precio + envio - pagar;
  return `Pagas ${pesos(pagar)} ahora${resto ? ` y abonas el resto (${pesos(resto)}${envio ? `, con envío de ${pesos(envio)}` : ', el envío es gratis'}); cada abono te da 7 días más` : ''}. `
    + `Cuando el pago esté completo sale el viernes (si fuera hoy, el ${fechaCorta(viernesDeEnvio(ahora))}).`;
}

export const mensajePague = (folio) => `Pagué el apartado P-${folio}`;
export const mensajeDatos = (folio) => `Quiero pagar el apartado P-${folio}. ¿Me das los datos para transferir?`;
export const enlaceWhatsApp = (texto) => `${WHATSAPP}?text=${encodeURIComponent(texto)}`;

/** La CLABE (18 dígitos) dentro del texto de datos de pago, aunque venga con espacios o guiones; '' si no hay. */
export function clabeDe(texto) {
  const junto = String(texto ?? '').replace(/(?<=\d)[ -](?=\d)/g, '');
  return /(?<!\d)\d{18}(?!\d)/.exec(junto)?.[0] ?? '';
}

export const horasHasta = (iso, ahora = Date.now()) => Math.max(1, Math.ceil((Date.parse(iso) - ahora) / 3_600_000));

// Medición (Issue #651): solo evento, código y origen. Mismo host, sin CORS; errores en silencio.
function medir(nombre, codigo) {
  try {
    const cuerpo = JSON.stringify({ evento: nombre, codigo, origen: 'portal' });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/catalogo/evento', cuerpo))) fetch('/api/catalogo/evento', { method: 'POST', body: cuerpo, keepalive: true }).catch(() => {});
  } catch { /* medir nunca rompe el apartado */ }
}

/**
 * Arma la hoja <dialog id="apartar-dialogo"> (portal.html). `api(ruta, cuerpo)` es la del portal (token incluido),
 * `estaListo()` dice si hay un socio registrado, `irAAcceso(codigo)` lleva al registro y vuelve a la pieza al terminar,
 * `alTerminar()` se llama al cerrar la confirmación. Devuelve { abrir(pieza) }.
 */
export function iniciarApartar({ api, estaListo, irAAcceso, alTerminar }) {
  const dialogo = document.getElementById('apartar-dialogo');
  if (!dialogo) return { abrir() {} };
  const q = (sel) => dialogo.querySelector(sel);
  const titulo = q('.apartar-titulo'), nombre = q('.apartar-pieza');
  const form = q('.apartar-form'), enviar = q('.apartar-enviar'), error = q('.apartar-error'), explica = q('.apartar-explica');
  const radios = [...dialogo.querySelectorAll('input[name="apartar-entrega"]')];
  const vistas = { invitado: q('.apartar-invitado'), form, listo: q('.apartar-listo') };
  let pieza = null, intento = null, hecho = false;

  const entrega = () => radios.find((r) => r.checked)?.value === 'envio' ? 'envio' : 'tienda';
  function ver(vista, texto) {
    for (const [clave, nodo] of Object.entries(vistas)) nodo.hidden = clave !== vista;
    titulo.textContent = texto;
  }
  function pintarForm() {
    explica.textContent = explicaEntrega(pieza.precio, entrega());
    enviar.textContent = `Apartar por ${pesos(aPagarDe(pieza.precio))}`;
    q('.apartar-envio-costo').textContent = envioDe(pieza.precio) ? `Envío ${pesos(envioDe(pieza.precio))} (gratis desde ${pesos(ENVIO_GRATIS_DESDE)})` : 'Envío gratis';
  }
  for (const r of radios) r.addEventListener('change', pintarForm);

  function pintarListo(r) {
    const { pedido } = r;
    q('.apartar-folio').textContent = `Folio ${r.concepto}`;
    q('.apartar-vence').textContent = `Tienes hasta el ${fechaLegible(pedido.vence_en)} (${horasHasta(pedido.vence_en)} h) para pagar. Si no, la pieza vuelve a la venta.`;
    q('.apartar-monto').textContent = pesos(r.a_pagar);
    q('.apartar-concepto').textContent = r.concepto;
    q('.apartar-entrega-info').textContent = explicaEntrega(pedido.subtotal, pedido.entrega);
    const datos = q('.apartar-datos'), clabe = clabeDe(r.datos_pago);
    datos.textContent = r.datos_pago ?? '';
    q('.apartar-con-datos').hidden = !r.datos_pago;
    q('.apartar-copiar-clabe').hidden = !clabe;
    q('.apartar-copiar-clabe').dataset.clabe = clabe;
    q('.apartar-sin-datos').hidden = !!r.datos_pago;
    q('.apartar-pedir-datos').href = enlaceWhatsApp(mensajeDatos(pedido.folio));
    q('.apartar-pague').href = enlaceWhatsApp(mensajePague(pedido.folio));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const eleccion = entrega();
    // El mismo UUID mientras sea la misma pieza y entrega: un reintento tras perder la red no aparta dos veces.
    const clave = `${pieza.codigo}|${eleccion}`;
    if (intento?.clave !== clave) intento = { clave, id: crypto.randomUUID() };
    enviar.disabled = true; error.textContent = '';
    try {
      const r = await api('apartar', { id: intento.id, codigo: pieza.codigo, entrega: eleccion });
      intento = null; hecho = true;
      medir('apartado_portal', pieza.codigo);
      pintarListo(r);
      ver('listo', '¡Apartada!');
      titulo.focus();
    } catch (err) {
      error.textContent = err instanceof TypeError ? 'No pudimos conectar. Revisa tu red e intenta de nuevo: no se aparta dos veces.'
        : err.status === 401 ? 'Vuelve a iniciar sesión para apartar.' : err.message;
    } finally { enviar.disabled = false; }
  });

  q('.apartar-registrar').addEventListener('click', () => { const codigo = pieza.codigo; dialogo.close(); irAAcceso(codigo); });
  q('.apartar-copiar-clabe').addEventListener('click', async (e) => {
    const aviso = q('.apartar-copiado');
    try { await navigator.clipboard.writeText(e.currentTarget.dataset.clabe); aviso.textContent = 'CLABE copiada.'; }
    catch { aviso.textContent = 'No se pudo copiar: mantén presionado el número para copiarlo.'; }
  });
  for (const cerrar of dialogo.querySelectorAll('.apartar-cerrar')) cerrar.addEventListener('click', () => dialogo.close());
  dialogo.addEventListener('click', (ev) => { if (ev.target === dialogo) dialogo.close(); });
  dialogo.addEventListener('close', () => { const fue = hecho; hecho = false; if (fue) alTerminar?.(); });

  return {
    abrir(p) {
      pieza = p; hecho = false; error.textContent = ''; q('.apartar-copiado').textContent = '';
      nombre.textContent = `${p.nombre} · ${pesos(p.precio)}`;
      if (estaListo()) {
        radios[0].checked = true;
        pintarForm();
        ver('form', 'Apartar esta pieza');
      } else {
        q('.apartar-whatsapp').href = enlaceLoQuiero(p);
        ver('invitado', 'Apartar aquí');
      }
      dialogo.showModal();
      titulo.focus();
    },
  };
}
