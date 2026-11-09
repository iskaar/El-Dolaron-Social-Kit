/**
 * Registro de programas y su reverso en devoluciones (Issue #765).
 *
 * Cada programa que da o gasta Dolarones, vales o bonos por una venta dice aqui que hace cuando
 * esa venta se cancela completa y cuando se devuelve una parte (bases, punto 10). Los tres caminos
 * (cancelarCore, cancelarPieza, devolverEnCupon) piden sus sentencias con sentenciasDeReverso.
 *
 * Oferta nueva (p. ej. VIP #635): agrega UNA entrada a PROGRAMAS con los `tipos`/`origenes` que
 * inserta y su accion en `completa` y `parcial`. reversos.test.ts lee el codigo y falla si algun
 * tipo u origen insertado no esta aqui, asi que olvidarla rompe el CI.
 *
 * El ORDEN de PROGRAMAS es el orden de las sentencias del batch: no lo cambies sin razon
 * (cada reverso lee la bitacora que el anterior no toca, pero el batch es todo o nada).
 */

import { sentenciasDeDevolucion, sentenciasDeCancelacion, sentenciasDeReversoPromo } from './dolarones.ts';
import { sentenciasDeReversoReferido } from './referidos.ts';
import { reponerValesUsados, retirarVale } from './vales.ts';

export interface ContextoReverso {
  ventaId: string;
  autor: string;
  /** ISO: la hora del batch. */
  ahora: string;
  /** true: cancelacion de toda la venta; false: devolucion de piezas. */
  completa: boolean;
  /** Solo en parcial: el socio de la venta, o null/omitido si es venta de vale (sin socio). */
  clienteId?: string | null;
  /** Solo en parcial: lo que sigue cobrado en dinero tras esta devolucion. */
  pagadoRestante?: number;
  /** Solo en parcial: Dolarones usados que regresan al saldo en esta devolucion. */
  dolarones?: number;
}

type Sentencias = D1PreparedStatement[] | Promise<D1PreparedStatement[]>;

/**
 * Que hace un programa: sentencias para el batch, `derivado` (nada que escribir: el programa lee la
 * venta, cancelada o devuelta, y se recalcula solo) o `nada` (a proposito, con la razon).
 */
export type Accion = ((env: Env, ctx: ContextoReverso) => Sentencias) | { derivado: string } | { nada: string };

export interface Programa {
  nombre: string;
  /** `tipo` que inserta en dolarones_movimientos. */
  tiposD?: string[];
  /** `tipo` que inserta en vales_movimientos. */
  tiposVale?: string[];
  /** `origen` de los lotes (dolarones_lotes) o vales (vales_dolarones) que crea. */
  origenes?: string[];
  completa: Accion;
  parcial: Accion;
}

export const PROGRAMAS: Programa[] = [
  {
    // Canje de lotes y lo ganado por compra (socio). Ver bases punto 10, primeras frases.
    nombre: 'dolarones-socio',
    tiposD: ['canje', 'compra', 'reverso_canje', 'reverso_compra'],
    origenes: ['compra'],
    completa: (env, c) => sentenciasDeCancelacion(env, c.ventaId, c.autor, c.ahora),
    parcial: (env, c) => c.clienteId ? sentenciasDeDevolucion(env, {
      ventaId: c.ventaId, dolarones: c.dolarones ?? 0, pagadoRestante: c.pagadoRestante ?? 0, autor: c.autor, ahora: c.ahora,
    }) : [],
  },
  {
    // Los 25 + 25 D de la primera compra del invitado (#489).
    nombre: 'referidos',
    tiposD: ['referido', 'referido_nuevo', 'reverso_referido'],
    origenes: ['referido'],
    completa: (env, c) => sentenciasDeReversoReferido(env, c.ventaId, c.autor, c.ahora),
    parcial: { nada: 'Bases punto 10: el premio solo se retira al cancelar la compra que lo liberó, no al devolver una parte.' },
  },
  {
    // Bono de la promo de noviembre (#684).
    nombre: 'promo',
    tiposD: ['promo', 'reverso_promo'],
    origenes: ['promo'],
    completa: (env, c) => sentenciasDeReversoPromo(env, c.ventaId, c.autor, c.ahora),
    parcial: { nada: 'Bases punto 7 bis: el bono ya pagado no se retira; el progreso (ventas.devuelto) se lee de la venta y resta lo devuelto, y el bloque no se vuelve a pagar.' },
  },
  {
    // Vale que emite una compra sin socio (se retira o se recalcula sobre lo que sigue pagado).
    nombre: 'vale-emitido',
    tiposVale: ['emision', 'retiro'],
    completa: (env, c) => retirarVale(env, c.ventaId, c.autor, c.ahora),   // si ya se gastó, aborta todo: no se crea dinero al cancelar
    parcial: (env, c) => c.clienteId ? [] : retirarVale(env, c.ventaId, c.autor, c.ahora, c.pagadoRestante ?? 0),
  },
  {
    // Vales y cupones con que se pago la venta; el cupón de devolución/manual se usa igual que un vale.
    nombre: 'vales-usados',
    tiposVale: ['canje', 'reverso_canje'],
    completa: (env, c) => reponerValesUsados(env, c.ventaId, c.autor, c.ahora),
    parcial: { nada: 'Bloqueado antes del batch: un ticket pagado con vale solo se cancela completo (cancelarPieza, devolverEnCupon).' },
  },
  {
    // Retos individuales (#752): el cron paga a los 8-10 dias y solo cuenta ventas sin devolucion ni cancelacion.
    nombre: 'retos',
    tiposD: ['reto'],
    origenes: ['reto'],
    completa: { derivado: 'El cron solo paga ventas con cancelada = 0 (retos.ts, VENTA_VALIDA); el lote ya pagado no se retira.' },
    parcial: { derivado: 'El cron solo paga ventas con devuelto = 0 y dolarones_devueltos = 0 (retos.ts, VENTA_VALIDA).' },
  },
  {
    // Bono semanal del equipo (#749): pesos, no Dolarones; no inserta lotes ni movimientos.
    nombre: 'bono-equipo',
    completa: { derivado: 'El bono se calcula de las ventas netas de la semana (lineasNetas, solo cancelada = 0): una cancelada ya no suma.' },
    parcial: { derivado: 'lineasNetas reparte total - devuelto - dolarones_devueltos entre las piezas que quedan: lo devuelto ya no suma.' },
  },
];

/**
 * `tipo` y `origen` que el codigo inserta pero que NO nacen de una venta, y por eso no tienen reverso
 * en una devolucion. reversos.test.ts acepta estos ademas de los de PROGRAMAS.
 */
export const SIN_VENTA: { tiposD?: string[]; origenes?: string[]; razon: string }[] = [
  { tiposD: ['alta_referido'], razon: 'Los 50 D al unirse al portal con un código (referidos.ts); no hay venta.' },
  { tiposD: ['regalo', 'reemplazo'], origenes: ['regalo'], razon: 'Premio de apertura del portal (portal.ts); no depende de una compra.' },
  { origenes: ['devolucion', 'manual'], razon: 'Cupón que nace de una devolución o lo emite la caja con un dueño; al gastarse es un canje de vale (programa vales-usados).' },
];

/**
 * Las sentencias de reverso de todos los programas, en el orden de PROGRAMAS, para el MISMO batch
 * que cancela la venta o registra la devolucion.
 */
export async function sentenciasDeReverso(env: Env, ctx: ContextoReverso): Promise<D1PreparedStatement[]> {
  const sentencias: D1PreparedStatement[] = [];
  for (const programa of PROGRAMAS) {
    const accion = ctx.completa ? programa.completa : programa.parcial;
    if (typeof accion === 'function') sentencias.push(...(await accion(env, ctx)));
  }
  return sentencias;
}
