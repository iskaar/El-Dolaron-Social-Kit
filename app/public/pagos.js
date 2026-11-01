// «Ya pagué»: el socio manda el comprobante de su transferencia desde el portal (Issue #670, B2 de #643).
//
// El reporte NO da el pedido por pagado: la tienda lo acepta registrando el abono en /pedidos o lo rechaza con motivo
// (POST /api/portal/apartados/:folio/comprobante y /pago; mismo servicio de lectura que la caja). Patrón de «Mis ventas» (vender.html).
// venta.js no se sirve en el host del portal: BANCOS se copia aquí y src/pagos.test.ts la ata a venta.js.
import { pesos } from './vender.js';
import { clabeDe, enlaceWhatsApp, mensajePague } from './apartar.js';

// Copia de app/public/venta.js (BANCOS).
export const BANCOS = [
  ['40012', 'BBVA México'], ['40014', 'Santander'], ['40072', 'Banorte'], ['40002', 'Citibanamex'], ['40021', 'HSBC'],
  ['40044', 'Scotiabank'], ['40036', 'Inbursa'], ['40058', 'Banregio'], ['40062', 'Afirme'], ['40030', 'BanBajío'],
  ['40127', 'Azteca'], ['40137', 'BanCoppel'], ['40167', 'Hey Banco'], ['40042', 'Mifel'],
  ['90638', 'Nu México'], ['90722', 'Mercado Pago'], ['90646', 'STP'], ['90661', 'Klar'], ['90728', 'Spin by OXXO'],
];

/** «250» o «250.50» → centavos enteros; '' → undefined (el monto es opcional); lo demás → null (inválido). */
export function centavosDe(texto) {
  const limpio = String(texto ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (!limpio) return undefined;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(limpio)) return null;
  const centavos = Math.round(Number(limpio) * 100);
  return centavos > 0 ? centavos : null;
}

const TEXTO_FOTO = {
  leido: (lista) => lista.includes('clave de rastreo') ? 'Leí la clave de rastreo de tu comprobante. Compárala y corrígela si hace falta.'
    : 'La foto se guardó. Si ves la clave de rastreo en el comprobante, escríbela.',
  noLeyo: 'La foto se guardó, pero no pude leerla. Si ves la clave de rastreo en el comprobante, escríbela.',
  sinRed: 'No se pudo subir la foto (¿sin red?). Escribe la clave de rastreo o vuelve a elegir la foto.',
};

/**
 * Arma <dialog id="pago-dialogo"> (portal.html). `api(ruta, cuerpo)` es la del portal, `token()` da el ID token para subir la foto
 * (no es JSON), `alReportar()` se llama tras mandar el pago. Devuelve { abrir({ folio, nombre, monto, concepto, datos_pago, rechazado? }) }.
 */
export function iniciarPagos({ api, token, alReportar }) {
  const dialogo = document.getElementById('pago-dialogo');
  if (!dialogo) return { abrir() {} };
  const q = (sel) => dialogo.querySelector(sel);
  const $ = (id) => document.getElementById(id);
  const form = q('.pago-form'), foto = $('pago-foto'), aviso = q('.pago-aviso'), enviar = q('.pago-enviar'), cerrar = q('.pago-cerrar');
  const banco = $('pago-banco');
  for (const [codigo, nombre] of BANCOS) banco.append(new Option(nombre, codigo));
  let pedido = null, intento = null, enviando = false;
  const bloquear = (b) => { for (const campo of [foto, $('pago-clave'), banco, $('pago-monto'), enviar, cerrar]) campo.disabled = b; };

  const decir = (nodo, texto, error = false) => { nodo.textContent = texto; nodo.classList.toggle('error', error); };

  dialogo.addEventListener('cancel', (e) => { if (enviando) e.preventDefault(); });
  cerrar.addEventListener('click', () => dialogo.close());
  q('.pago-copiar-clabe').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(e.currentTarget.dataset.clabe); decir(q('.pago-copiado'), 'CLABE copiada.'); }
    catch { decir(q('.pago-copiado'), 'No se pudo copiar: mantén presionado el número para copiarlo.'); }
  });

  foto.addEventListener('change', async () => {
    enviar.disabled = true;
    try {
      await (await import('/comprobante.js')).adjuntar(foto, {
        clave: 'pago-clave', monto: 'pago-monto', banco: 'pago-banco', aviso: 'pago-foto-aviso',
        ruta: `/api/portal/apartados/${pedido.folio}/comprobante`,
        cabeceras: async () => ({ authorization: `Bearer ${await token()}` }),
        texto: TEXTO_FOTO,
      }, $);
    } catch { decir($('pago-foto-aviso'), TEXTO_FOTO.sinRed, true); }
    finally { enviar.disabled = false; }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (enviando) return;
    const clave = $('pago-clave').value.trim(), llave = foto.dataset.key || '';
    const monto = centavosDe($('pago-monto').value);
    if (!clave && !llave) return decir(aviso, 'Sube la foto del comprobante o escribe la clave de rastreo.', true);
    if (monto === null) return decir(aviso, 'Escribe el monto en pesos, por ejemplo 100 o 100.50.', true);
    // Un solo id por intento: si se pierde la respuesta, reintentar no manda el pago dos veces.
    intento ??= { id: crypto.randomUUID(), clave_rastreo: clave, comprobante_key: llave || undefined, fecha_comprobante: foto.dataset.fecha || undefined,
      monto, banco_emisor: banco.value || undefined };
    enviando = true; bloquear(true); decir(aviso, '');
    try {
      await api(`apartados/${pedido.folio}/pago`, intento);
      intento = null;
      dialogo.close();
      alReportar?.(pedido);
    } catch (err) {
      if (err.status && err.status < 500) intento = null;
      decir(aviso, intento ? 'No sabemos si se mandó. Toca «Mandar mi pago» otra vez: no se repite.'
        : err instanceof TypeError ? 'No pudimos conectar. Revisa tu red e intenta de nuevo.' : err.message, true);
    } finally {
      enviando = false; bloquear(false);
      for (const campo of [foto, $('pago-clave'), banco, $('pago-monto')]) campo.disabled = !!intento;
    }
  });

  return {
    abrir(p) {
      pedido = p; intento = null;
      form.reset();
      foto.dataset.key = ''; foto.dataset.fecha = '';
      for (const nodo of [aviso, $('pago-foto-aviso'), q('.pago-copiado')]) decir(nodo, '');
      bloquear(false);
      q('.pago-resumen').textContent = `P-${p.folio} · ${p.nombre}`;
      q('.pago-monto-texto').textContent = pesos(p.monto);
      q('.pago-concepto').textContent = p.concepto;
      q('.pago-datos').textContent = p.datos_pago ?? '';
      q('.pago-con-datos').hidden = !p.datos_pago;
      const clabe = clabeDe(p.datos_pago);
      q('.pago-copiar-clabe').hidden = !clabe;
      q('.pago-copiar-clabe').dataset.clabe = clabe;
      q('.pago-rechazado').hidden = !p.rechazado;
      q('.pago-rechazado').textContent = p.rechazado ?? '';
      q('.pago-whatsapp').href = enlaceWhatsApp(mensajePague(p.folio));
      dialogo.showModal();
      q('.pago-titulo').focus();
    },
  };
}
