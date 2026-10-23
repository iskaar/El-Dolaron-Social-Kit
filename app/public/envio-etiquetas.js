import { impresas, marcarImpresa, etiquetaVigente } from './etiquetera.js';

/** shortcut: marcas por navegador como /etiquetas hoy; sustituir aquí por D1 cuando entre #443. */
export function estadoEnvio(pieza, accion = 'consultar', hora) {
  if (accion === 'marcar') marcarImpresa(pieza.id, hora, pieza);
  const marcas = impresas();
  if (!pieza) return { marcas };
  const marca = marcas[pieza.id];
  return { marca, marcas, vigente: etiquetaVigente(marca, pieza) };
}
