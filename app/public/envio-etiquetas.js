import { esRopa } from './ropa.js';
import { impresas, marcarImpresa, etiquetaVigente, gradoImpreso, precioImpreso, textoImpreso, desmarcarDesde, olvidarMarca, adoptarMarca, adoptarMarcas, reclamarEtiquetas, soltarEtiquetas } from './etiquetera.js';

/**
 * Que etiquetas ya salieron (Issue #440). La verdad compartida esta en D1 (`etiquetas_enviadas`): la PC y el
 * celular reclaman ahi cada etiqueta antes de mandarla, asi que ninguna sale dos veces. La marca de este
 * navegador (localStorage) es la copia para pintar la lista y para seguir sin red.
 */

/** Marca local: consultar (por omision) o 'marcar'. `base` dice que la marca ya esta en D1. */
export function estadoEnvio(pieza, accion = 'consultar', hora, base = false, en) {
  if (accion === 'marcar') marcarImpresa(pieza.id, hora, pieza, base, en);
  const marcas = impresas();
  if (!pieza) return { marcas };
  const marca = marcas[pieza.id];
  return { marca, marcas, vigente: etiquetaVigente(marca, pieza) };
}

/** Lo que la base aceptaria reclamar: la pieza vendida o sin nombre, precio o etiqueta ya no tiene que imprimirse. */
const seImprime = (p) => p.stock > 0 && p.precio > 0 && p.destino === 'etiqueta' && !!p.nombre?.trim();

/** Lo que dice la etiqueta enviada segun la base, con la forma de una pieza. */
const diceLaBase = (marca) => ({ precio: marca.etiqueta_precio, precio_lista: marca.etiqueta_precio_lista, nombre: marca.etiqueta_nombre, talla: marca.etiqueta_talla });
/** Precio, tachado, nombre y talla iguales: lo unico que la base compara. */
const mismaEtiqueta = (a, b) => precioImpreso(a) === precioImpreso(b) && textoImpreso(a) === textoImpreso(b);

/**
 * Se queda con la etiqueta de esta pieza ANTES de mandarla. Devuelve:
 *  - { reclamada: true, forzada, etiqueta_en }: gano este dispositivo, se imprime. `forzada`: ya habia etiquetas pegadas
 *    (reimpresion), asi que si el envio falla NO se suelta; `etiqueta_en` es la hora de SU reclamo (`ahora` de la respuesta), para soltar solo lo propio;
 *  - { reclamada: false, cambio: false }: ya la saco otro (PC o celular), se omite y su marca se adopta aqui;
 *  - { reclamada: false, cambio: true }: la pieza cambio entre preparar y reclamar, no se imprime a ciegas;
 *  - { reclamada: false, rechazada: true }: ya no se puede imprimir (vendida, sin existencia o no lista); se salta sin avisar a la base;
 *  - { reclamada: true, sinBase: true }: no hubo red para preguntar; se imprime con la marca local y se sube
 *    despues (sincronizarMarcas). Cualquier otro fallo lanza.
 * Es reimpresion explicita (siempre sale, y actualiza el reclamo) si se pide `reimprimir` (Reimprimir de Buscar y de
 * la ficha, +1) o si el usuario eligio en la lista una fila que ya figura impresa (`deLista`): ahi la base no guarda
 * el grado y no podria distinguir un cambio de grado de un envio repetido. Tambien sale sola la pieza cuya marca de aqui
 * solo difiere en el grado (mercancia general): es la unica forma de reimprimirla. Reescanear nunca fuerza.
 */
export async function reclamarEnvio(pieza, { reimprimir = false, deLista = false } = {}) {
  if (!seImprime(pieza)) return { reclamada: false, rechazada: true };
  const marca = impresas()[pieza.id];
  const forzada = reimprimir || (!!marca && mismaEtiqueta(marca, pieza) && (deLista || (!esRopa(pieza) && gradoImpreso(marca) !== gradoImpreso(pieza))));
  try {
    const r = await reclamarEtiquetas([pieza.id], { reimprimir: forzada, version: pieza.etiqueta_version });
    if (r.reclamadas.includes(pieza.id)) return { reclamada: true, forzada, etiqueta_en: r.ahora };
    const enBase = r.marcas[pieza.id];
    if (!enBase || !mismaEtiqueta(diceLaBase(enBase), pieza)) return { reclamada: false, cambio: true };
    adoptarMarca(pieza.id, enBase, pieza);
    return { reclamada: false, cambio: false, marca: enBase };
  } catch (error) {
    if (!error.sinRed) throw error;
    return { reclamada: true, sinBase: true };
  }
}

/** "No salio": libera el reclamo de estas piezas (`en`: la hora del reclamo de cada una, ver soltarEtiquetas). true si la base quedo sin ellas; nunca lanza. */
export const liberarEnvio = (ids, en) => soltarEtiquetas(ids, en);

/**
 * «No salió desde aquí»: esa pieza y las que se mandaron despues DESDE ESTE NAVEGADOR vuelven a la lista, aqui y en la
 * base. En la base solo se suelta el reclamo propio: si otro dispositivo reclamo despues, o saco la pieza, no se toca.
 */
export async function noSalio(id) {
  const antes = impresas();
  const ids = desmarcarDesde(id);
  return ids.length === 0 || liberarEnvio(ids, Object.fromEntries(ids.map((otra) => [otra, antes[otra].en])));
}

/** «Marcar como impresas»: sin imprimir, las deja reclamadas en la base. Devuelve las que quedaron (id -> hora del reclamo); lanza si falla. */
export async function reclamarSinImprimir(ids) {
  const reclamadas = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const r = await reclamarEtiquetas(ids.slice(i, i + 100), { reimprimir: true });
    for (const id of r.reclamadas) reclamadas.set(id, r.ahora);
  }
  return reclamadas;
}

/**
 * Pone al dia las marcas de este navegador con lo que trae la lista de la base (campos etiqueta_*):
 *  - lo que salio desde otro dispositivo se adopta, y la pieza sale de la lista;
 *  - con `desde` (una carga completa, pedida a esa hora): una marca que ya estaba en la base y que ahi ya no
 *    esta, la soltaron en otro dispositivo, y se olvida;
 *  - una marca vigente que la base no conoce (de antes del registro, o hecha sin red) se sube, sin esperarla.
 */
export function sincronizarMarcas(piezas, desde = null) {
  const marcas = impresas();
  const porSubir = [], adoptadas = [];
  for (const p of piezas) {
    const marca = marcas[p.id];
    if (p.etiqueta_en) adoptadas.push([p.id, p, p]);
    else if (!marca || desde === null) continue;
    else if (marca.base) { if (Date.parse(marca.hora) < desde) olvidarMarca(p.id); }
    else if (p.stock > 0 && p.nombre?.trim() && etiquetaVigente(marca, p)) porSubir.push(p);
  }
  adoptarMarcas(adoptadas);
  return porSubir.length ? subirMarcas(porSubir, marcas) : Promise.resolve();
}

/** Registra en la base, sin forzar, las marcas que solo existian aqui. Un fallo se reintenta en la siguiente carga. */
async function subirMarcas(piezas, antes) {
  try {
    for (let i = 0; i < piezas.length; i += 100) {
      const lote = piezas.slice(i, i + 100), r = await reclamarEtiquetas(lote.map((p) => p.id));
      for (const p of lote) {
        const ahora = impresas()[p.id];
        // Si mientras tanto se volvio a imprimir o se solto, esa marca ya no es la que se subio.
        if (!ahora || ahora.hora !== antes[p.id].hora) continue;
        if (r.reclamadas.includes(p.id)) marcarImpresa(p.id, ahora.hora, ahora, true, r.ahora);
        else if (r.marcas[p.id]) adoptarMarca(p.id, r.marcas[p.id], p);
      }
    }
  } catch { /* sin red: la siguiente carga lo vuelve a intentar */ }
}
