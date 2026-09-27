/**
 * Ticket por la impresora de Windows (Issue #97, opcion B).
 *
 * La Epson TM-T20 II se queda con su controlador de Windows (Epson APD 5) para
 * que WinCaja siga imprimiendo y abriendo el cajon en la misma computadora. Por
 * WebUSB eso no se podia: WinUSB le quitaba la impresora a WinCaja. Aqui la
 * caja arma el ticket como una pagina y la imprime con window.print(); Chrome
 * abierto con --kiosk-printing la manda directo a la impresora predeterminada,
 * sin dialogo. El cajon lo abre el controlador al imprimir, no esta pagina.
 *
 * La venta ya se cobro y se guardo antes de imprimir: el ticket nunca bloquea
 * ni retrasa el cobro.
 */

/**
 * Sin acentos. Ya no hace falta para el ticket (Windows dibuja cualquier letra),
 * pero la etiquetera (TSPL por Bluetooth) si la necesita: ver etiquetera.js.
 */
export function sinAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7F]/g, '?');
}

const escapar = (texto) => String(texto ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const pesos = (centavos) => `$${(centavos / 100).toFixed(2)}`;
const dolares = (centavos) => `${(centavos / 100).toLocaleString('es-MX')} D`;
const renglon = (izquierda, derecha, clase = '') =>
  `<div class="r ${clase}"><span>${escapar(izquierda)}</span><span>${escapar(derecha)}</span></div>`;

const FORMA = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

/**
 * El ticket como pagina. 72 mm de ancho: lo que imprime la TM-T20 II en rollo
 * de 80 mm. ponytail: tamanos de letra y del logo puestos a ojo; se ajustan con
 * el primer ticket en papel.
 * @param venta {{ total: number, forma_pago: string, efectivo: number, cambio: number, creado_en: string,
 *   dolarones?: number, socio?: { numero: number, ganados: number, saldo: number } | null }}
 * @param lineas {{ nombre: string, precio: number, cantidad: number }[]}
 * @param logo URL absoluta del logo: el iframe srcdoc no resuelve rutas relativas.
 */
export function htmlTicket(venta, lineas, logo = '/logo-ticket.png') {
  const fecha = new Date(venta.creado_en).toLocaleString('es-MX', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const cuerpo = [
    `<img src="${escapar(logo)}" alt="El Dolarón">`,
    '<div class="c">Productos Americanos</div>',
    '<hr>',
    `<div>${escapar(fecha)}</div>`,
    '<hr>',
    ...lineas.map((l) => `<div class="p">${escapar(l.nombre)}</div>`
      + renglon(`${l.cantidad} x ${pesos(l.precio)}`, pesos(l.precio * l.cantidad), 'n')),
    '<hr>',
    renglon('TOTAL', pesos(venta.total), 't'),
  ];
  if (venta.dolarones > 0) {
    cuerpo.push(renglon('Dolarones', `-${pesos(venta.dolarones)}`), renglon('A pagar', pesos(venta.total - venta.dolarones)));
  }
  if (venta.forma_pago === 'efectivo') {
    cuerpo.push(renglon('Efectivo', pesos(venta.efectivo)), renglon('Cambio', pesos(venta.cambio)));
  } else {
    cuerpo.push(`<div>${escapar(FORMA[venta.forma_pago] ?? venta.forma_pago)}</div>`);
  }
  if (venta.socio) {
    cuerpo.push('<hr>', `<div>Socio #${escapar(venta.socio.numero)}</div>`);
    if (venta.socio.ganados) cuerpo.push(renglon('Ganaste (usables desde mañana)', dolares(venta.socio.ganados)));
    cuerpo.push(renglon('Saldo disponible', dolares(venta.socio.saldo)));
  }
  cuerpo.push('<hr>', '<div class="c">Gracias por su compra</div>');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Ticket</title><style>
  @page { margin: 0; }
  * { box-sizing: border-box; }
  body { width: 72mm; margin: 0; padding: 1mm 1mm 4mm; font: 10pt/1.3 Arial, Helvetica, sans-serif; color: #000; }
  img { display: block; width: 54mm; margin: 0 auto 1mm; }
  hr { border: 0; border-top: 1px dashed #000; margin: 1.5mm 0; }
  .c { text-align: center; }
  .r { display: flex; justify-content: space-between; gap: 2mm; }
  .r span:last-child { white-space: nowrap; }
  .n { padding-left: 3mm; }
  .t { font-size: 13pt; font-weight: 700; }
</style></head><body>${cuerpo.join('\n')}</body></html>`;
}

/**
 * Imprime el ticket en un iframe fuera de la vista. Resuelve true si se mando a
 * imprimir; sin --kiosk-printing Chrome muestra su dialogo y el cajero elige.
 */
export function imprimirTicket(venta, lineas) {
  return new Promise((resolver) => {
    const marco = document.createElement('iframe');
    // Sin visibility:hidden: con eso algunas versiones de Chrome imprimen en blanco.
    marco.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    marco.onload = () => {
      try {
        marco.contentWindow.focus();
        marco.contentWindow.print();   // espera a que Chrome copie la pagina
        resolver(true);
      } catch (error) {
        console.error('Ticket: no se pudo imprimir', error);
        resolver(false);
      } finally {
        setTimeout(() => marco.remove(), 1000);
      }
    };
    marco.srcdoc = htmlTicket(venta, lineas, new URL('/logo-ticket.png', location.href).href);
    document.body.append(marco);
  });
}
