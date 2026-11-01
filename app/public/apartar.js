// Resumen de un paso para apartar (Issue #668 B1 de #643; carrito y «Comprar ya» en #681; docs/UX-COMPRA.md §4.2 y §5).
//
// El mismo resumen sirve para «Comprar ya» (una pieza) y para «Apartar todo» del carrito (hasta 10): lista de piezas, cómo la recibe
// (recoger preseleccionado), lo que aparta hoy y lo que falta. El navegador solo manda { id, codigos, entrega } a
// POST /api/portal/apartar; precio, existencia, anticipo y envío los decide el servidor (las cuentas de aquí solo se muestran).
// venta.js no se sirve en el host del portal: envioDe se copia aquí y src/apartar.test.ts la ata a venta.js.
import { pesos, fechaLegible } from './vender.js';
import { APARTADO, ENVIO_COSTO, ENVIO_GRATIS_DESDE, viernesDeEnvio, fechaCorta, WHATSAPP, enlaceLoQuiero } from './catalogo-ficha.js';

/** Copia de envioDe (app/public/venta.js): bajo $1,000 el envío cuesta $99. Se calcula sobre el subtotal de TODO el pedido. */
export const envioDe = (precio) => (precio > 0 && precio < ENVIO_GRATIS_DESDE ? ENVIO_COSTO : 0);
/** Lo que se paga al apartar: $100 por todo el pedido, o el total de las piezas si cuestan menos (anticipoMinimoDe de venta.js). */
export const aPagarDe = (precio) => Math.min(precio, APARTADO);

/** Las cuentas del resumen para un subtotal y una entrega: lo mismo que calcula el servidor al crear el pedido. */
export function resumenDe(subtotal, entrega) {
  const envio = entrega === 'envio' ? envioDe(subtotal) : 0;
  const apartas = aPagarDe(subtotal);
  return { subtotal, envio, total: subtotal + envio, apartas, falta: subtotal + envio - apartas };
}

/** Qué pasa según cómo la quiere: una frase corta, con los importes que calcula el servidor al apartar. `piezas` solo cambia el plural. */
export function explicaEntrega(precio, entrega, ahora = Date.now(), piezas = 1) {
  const varias = piezas > 1;
  const pagar = aPagarDe(precio);
  if (entrega !== 'envio') {
    return pagar >= precio
      ? `Pagas ${pesos(precio)} por transferencia y pasas por ${varias ? 'ellas' : 'ella'} a Soledad.`
      : `Pagas ${pesos(pagar)} por transferencia y el resto al recoger${varias ? 'las' : 'la'}. Con tu pago te ${varias ? 'las' : 'la'} guardamos 7 días.`;
  }
  const envio = envioDe(precio);
  const resto = precio + envio - pagar;
  return `Pagas ${pesos(pagar)} ahora${resto ? ` y abonas el resto (${pesos(resto)}${envio ? `, con envío de ${pesos(envio)}` : ', el envío es gratis'}); cada abono te da 7 días más` : ''}. `
    + `Cuando el pago esté completo sale el viernes (si fuera hoy, el ${fechaCorta(viernesDeEnvio(ahora))}).`;
}

/** «$99 (gratis desde $1,000) · sale el viernes 6 de noviembre»; con subtotal desde $1,000, «Gratis · sale…». */
export const textoEnvio = (subtotal, ahora = Date.now()) =>
  `${envioDe(subtotal) ? `${pesos(ENVIO_COSTO)} (gratis desde ${pesos(ENVIO_GRATIS_DESDE)})` : 'Gratis'} · sale el viernes ${fechaCorta(viernesDeEnvio(ahora))}`;

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

const nombreDe = (lineas) => lineas.length > 1 ? `${lineas.length} piezas` : lineas[0]?.nombre ?? 'Pieza';
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Arma la hoja <dialog id="apartar-dialogo"> (portal.html). `api(ruta, cuerpo)` es la del portal (token incluido; el error trae
 * `status` y `datos`), `estaListo()` dice si hay un socio registrado, `irAAcceso(codigos)` lleva al registro y vuelve al resumen al
 * terminar, `alTerminar()` se llama al cerrar la confirmación, `alVerApartados()` si toca «Ver mis apartados» (#669), `alPagar(info)` si
 * toca «Ya pagué» (#670: abre la hoja de pago), `alApartar(codigos)` cuando el servidor creó el pedido y `alAgotarse(codigos)` cuando
 * dice que algunas ya no están (para que el carrito las quite). Devuelve { abrir(piezas, origen) }, con `origen` 'comprar_ya' o 'carrito'.
 */
export function iniciarApartar({ api, estaListo, irAAcceso, alTerminar, alVerApartados, alPagar, alApartar, alAgotarse }) {
  const dialogo = document.getElementById('apartar-dialogo');
  if (!dialogo) return { abrir() {} };
  const q = (sel) => dialogo.querySelector(sel);
  const titulo = q('.apartar-titulo'), lista = q('.apartar-piezas');
  const form = q('.apartar-form'), enviar = q('.apartar-enviar'), error = q('.apartar-error'), explica = q('.apartar-explica');
  const radios = [...dialogo.querySelectorAll('input[name="apartar-entrega"]')];
  const vistas = { invitado: q('.apartar-invitado'), form, listo: q('.apartar-listo'), vacio: q('.apartar-vacio') };
  let piezas = [], origen = 'comprar_ya', intento = null, hecho = false, pagar = null;

  const entrega = () => radios.find((r) => r.checked)?.value === 'envio' ? 'envio' : 'tienda';
  const subtotal = () => piezas.reduce((suma, p) => suma + p.precio, 0);
  function ver(vista, texto) {
    for (const [clave, nodo] of Object.entries(vistas)) nodo.hidden = clave !== vista;
    lista.hidden = vista === 'listo' || vista === 'vacio';
    titulo.textContent = texto;
  }
  function pintarLista() {
    lista.replaceChildren(...piezas.map((p) => {
      const li = el('li', 'apartar-linea');
      li.append(el('span', 'apartar-linea-nombre', p.nombre), el('b', '', pesos(p.precio)));
      return li;
    }));
  }
  function pintarForm() {
    const r = resumenDe(subtotal(), entrega());
    pintarLista();
    q('.apartar-total').textContent = `Total ${pesos(r.total)}`;
    q('.apartar-desglose').textContent = r.envio ? `Piezas ${pesos(r.subtotal)} + envío ${pesos(r.envio)}` : entrega() === 'envio' ? 'Envío gratis' : '';
    q('.apartar-apartas').textContent = `Apartas con ${pesos(r.apartas)}`;
    q('.apartar-falta').textContent = r.falta > 0 ? `Falta por pagar ${pesos(r.falta)} ${entrega() === 'envio' ? 'antes del envío' : 'al recoger'}.` : 'No falta nada: pagas todo ahora.';
    explica.textContent = explicaEntrega(r.subtotal, entrega(), Date.now(), piezas.length);
    enviar.textContent = `Apartar por ${pesos(r.apartas)}`;
    q('.apartar-envio-costo').textContent = textoEnvio(r.subtotal);
  }
  for (const r of radios) r.addEventListener('change', pintarForm);

  function pintarListo(r) {
    const { pedido } = r;
    q('.apartar-folio').textContent = `Folio ${r.concepto}`;
    q('.apartar-vence').textContent = `Tienes hasta el ${fechaLegible(pedido.vence_en)} (${horasHasta(pedido.vence_en)} h) para pagar. Si no, ${pedido.lineas.length > 1 ? 'las piezas vuelven' : 'la pieza vuelve'} a la venta.`;
    q('.apartar-monto').textContent = pesos(r.a_pagar);
    q('.apartar-concepto').textContent = r.concepto;
    q('.apartar-entrega-info').textContent = explicaEntrega(pedido.subtotal, pedido.entrega, Date.now(), pedido.lineas.length);
    const datos = q('.apartar-datos'), clabe = clabeDe(r.datos_pago);
    datos.textContent = r.datos_pago ?? '';
    q('.apartar-con-datos').hidden = !r.datos_pago;
    q('.apartar-copiar-clabe').hidden = !clabe;
    q('.apartar-copiar-clabe').dataset.clabe = clabe;
    q('.apartar-sin-datos').hidden = !!r.datos_pago;
    q('.apartar-pedir-datos').href = enlaceWhatsApp(mensajeDatos(pedido.folio));
    q('.apartar-pague-wa').href = enlaceWhatsApp(mensajePague(pedido.folio));
    pagar = { folio: pedido.folio, nombre: nombreDe(pedido.lineas), monto: r.a_pagar, concepto: r.concepto, datos_pago: r.datos_pago };
  }

  // El servidor dijo que algunas ya no están (409/404 con `no_disponibles`): se quitan del resumen y del carrito y se avisa cuáles.
  function quitarAgotadas(codigos) {
    const fuera = piezas.filter((p) => codigos.includes(p.codigo));
    piezas = piezas.filter((p) => !codigos.includes(p.codigo));
    alAgotarse?.(codigos);
    if (!piezas.length) { ver('vacio', 'Ya no están disponibles'); return; }
    pintarForm();
    error.textContent = `${fuera.length === 1 ? 'Se vendió' : 'Se vendieron'} ${fuera.map((p) => p.nombre).join(', ') || 'una pieza'} y ${fuera.length === 1 ? 'la quitamos' : 'las quitamos'} de tu pedido. Revisa el total y vuelve a apartar.`;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const eleccion = entrega();
    const codigos = piezas.map((p) => p.codigo);
    // El mismo UUID mientras sean las mismas piezas y entrega: un reintento tras perder la red no aparta dos veces.
    const clave = `${codigos.join(',')}|${eleccion}`;
    if (intento?.clave !== clave) intento = { clave, id: crypto.randomUUID() };
    enviar.disabled = true; error.textContent = '';
    try {
      const r = await api('apartar', { id: intento.id, codigos, entrega: eleccion });
      intento = null; hecho = true;
      for (const codigo of codigos) {
        medir('apartado_portal', codigo);
        if (origen === 'carrito') medir('carrito_apartar', codigo);
      }
      alApartar?.(codigos);
      pintarListo(r);
      ver('listo', codigos.length > 1 ? '¡Apartadas!' : '¡Apartada!');
      titulo.focus();
    } catch (err) {
      const fuera = err.datos?.no_disponibles;
      if (Array.isArray(fuera) && fuera.length) quitarAgotadas(fuera);
      else error.textContent = err instanceof TypeError ? 'No pudimos conectar. Revisa tu red e intenta de nuevo: no se aparta dos veces.'
        : err.status === 401 ? 'Vuelve a iniciar sesión para apartar.' : err.message;
    } finally { enviar.disabled = false; }
  });

  q('.apartar-registrar').addEventListener('click', () => { const codigos = piezas.map((p) => p.codigo); dialogo.close(); irAAcceso(codigos); });
  q('.apartar-copiar-clabe').addEventListener('click', async (e) => {
    const aviso = q('.apartar-copiado');
    try { await navigator.clipboard.writeText(e.currentTarget.dataset.clabe); aviso.textContent = 'CLABE copiada.'; }
    catch { aviso.textContent = 'No se pudo copiar: mantén presionado el número para copiarlo.'; }
  });
  q('.apartar-pague').addEventListener('click', () => { if (pagar) alPagar?.(pagar); });
  q('.apartar-ver').addEventListener('click', () => { dialogo.close(); alVerApartados?.(); });
  for (const cerrar of dialogo.querySelectorAll('.apartar-cerrar')) cerrar.addEventListener('click', () => dialogo.close());
  dialogo.addEventListener('click', (ev) => { if (ev.target === dialogo) dialogo.close(); });
  dialogo.addEventListener('close', () => { const fue = hecho; hecho = false; if (fue) alTerminar?.(); });

  return {
    abrir(elegidas, desde = 'comprar_ya') {
      if (!elegidas.length) return;
      piezas = elegidas.map(({ codigo, nombre, precio }) => ({ codigo, nombre, precio })); origen = desde; hecho = false; intento = null;
      error.textContent = ''; q('.apartar-copiado').textContent = '';
      if (estaListo()) {
        radios[0].checked = true;   // «Recoger en tienda» preseleccionada: un toque si no cambia nada
        pintarForm();
        ver('form', 'Tu pedido');
      } else {
        pintarLista();
        q('.apartar-whatsapp').href = enlaceLoQuiero(piezas);
        ver('invitado', 'Apartar aquí');
      }
      dialogo.showModal();
      titulo.focus();
    },
  };
}
