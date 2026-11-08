// Cuentas de /retos (Issue #760) sin DOM, para probarlas con node --test (src/retos-juego.test.ts).
// Todo sale de lo que ya entrega GET /api/retos/mios; nada se inventa: si un dato falta, la pieza se omite.

const DIA_MS = 86_400_000;
export const PLURAL = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
/** Pesos enteros: lo logrado se redondea hacia abajo y lo que falta o la meta hacia arriba, para no prometer de más. */
export const pesos = (centavos, redondeo = Math.ceil) => `$${redondeo(centavos / 100).toLocaleString('es-MX')}`;
/** Dolarones (1 D = 100 centavos), sin ceros de sobra. */
export const dd = (centavos) => `${(centavos / 100).toLocaleString('es-MX', { maximumFractionDigits: 2 })} D`;

/** Meta personal: promedio de 4 semanas + 10 %, redondeada hacia arriba. El promedio trae un decimal, por eso se trabaja con decimas enteras. */
export const metaPersonal = (promedio) => Math.ceil(Math.round(promedio * 10) * 11 / 100);

/** Los tres anillos de «Mi semana». `meta` es null si todavia no hay promedio (primera semana): no se inventa un porcentaje. */
export function anillos(m) {
  const { semana: s, promedio_4_semanas: p } = m;
  const uno = (clave, etiqueta, valor, promedio, texto) => {
    const meta = promedio > 0 ? metaPersonal(promedio) : null;
    return { clave, etiqueta, valor, meta, pct: meta ? Math.floor(valor * 100 / meta) : null, texto: texto(valor, meta) };
  };
  return [
    uno('ventas', 'Ventas', s.ventas, p.ventas, (v, meta) => (meta ? `${pesos(v, Math.floor)} de ${pesos(meta)}` : pesos(v, Math.floor))),
    uno('tickets', 'Tickets', s.tickets, p.tickets, (v, meta) => (meta ? `${v} de ${meta}` : String(v))),
    uno('socios', 'Socios', s.socios, p.socios, (v, meta) => (meta ? `${v} de ${meta}` : String(v))),
  ];
}

/** Donde deberia ir la tienda hoy (por ciento): dias transcurridos de la semana, hoy incluido, entre 7. */
export const ritmoPct = (dia) => Math.round(Math.min(Math.max(dia, 1), 7) * 100 / 7);

/** Cuanto de los 7 dias queda despues de hoy. */
export const diasQuedan = (dia) => 7 - Math.min(Math.max(dia, 1), 7);

/** Texto del estado de la tienda frente al ritmo; sin culpa: lo que falta se puede alcanzar. */
export function estadoTienda(m) {
  if (m.tienda_alcanzada) return { icono: '★', texto: '¡Llegamos a la meta de la semana! Hay bono.' };
  if (m.tienda_pct >= ritmoPct(m.semana.dia)) return { icono: '▲', texto: 'Vamos por delante del ritmo.' };
  return { icono: '▼', texto: 'Vamos por detrás del ritmo, todavía hay días para alcanzarlo.' };
}

/** Logros desde la ultima visita. `visto` es el id del logro mas nuevo que ya se celebro; sin el, solo los de los ultimos 7 dias. */
export function premiosNuevos(logros, visto, ahora = Date.now()) {
  const i = visto ? logros.findIndex((l) => l.id === visto) : -1;
  return i >= 0 ? logros.slice(0, i) : logros.filter((l) => ahora - Date.parse(l.fecha) < 7 * DIA_MS);
}

/** Estanteria: una casilla por regla con premio; ganada si ya la logro alguna vez, bloqueada con lo que falta si no. */
export const estanteria = (m) => m.reglas.filter((r) => r.d > 0).map((r) => ({
  logro: r.logro, etiqueta: r.etiqueta, texto: r.texto, d: r.d, veces: m.logros_por_tipo[r.logro] ?? 0, ganado: (m.logros_por_tipo[r.logro] ?? 0) > 0,
}));

/**
 * «Tu siguiente paso»: una sola accion, la mas cercana a cerrarse entre la racha y los anillos; si no hay nada a medias,
 * el primer logro que aun no ha ganado. Devuelve null solo si no queda nada que proponer.
 */
export function siguientePaso(m) {
  const candidatos = [];
  const r = m.racha;
  if (r && !(r.largo > 0 && r.cajas >= r.meta)) {
    const faltan = r.meta - r.cajas;
    let texto = null;
    if (r.hoy === 'pendiente') {
      texto = faltan === 1
        ? `Con tu primera venta de hoy completas la racha de ${r.meta} días y ganas ${r.d} D.`
        : `Haz tu primera venta de hoy: suma el día ${r.cajas + 1} de ${r.meta} de tu racha.`;
    } else if (r.cajas > 0) {
      texto = r.hoy === 'vendio'
        ? `Hoy ya cuenta para tu racha. Te ${faltan === 1 ? 'falta' : 'faltan'} ${PLURAL(faltan, 'día trabajado', 'días trabajados')} con venta para ganar ${r.d} D.`
        : `Llevas ${r.cajas} de ${r.meta} días de racha. Cada día trabajado con venta suma.`;
    }
    if (texto) candidatos.push({ tipo: 'racha', cerca: r.cajas / r.meta, texto, ancla: 'racha' });
  }
  for (const a of anillos(m)) {
    if (a.meta == null || a.valor >= a.meta) continue;
    const faltan = a.meta - a.valor;
    const que = a.clave === 'ventas' ? `${pesos(faltan)} en ventas` : a.clave === 'tickets' ? PLURAL(faltan, 'ticket', 'tickets') : PLURAL(faltan, 'socio nuevo', 'socios nuevos');
    candidatos.push({ tipo: 'anillo', cerca: a.valor / a.meta, texto: `Te ${a.clave === 'ventas' || faltan !== 1 ? 'faltan' : 'falta'} ${que} para cerrar tu anillo de ${a.etiqueta.toLowerCase()}.`, ancla: 'semana' });
  }
  // Empate: gana la racha (va primero en la lista).
  const mejor = candidatos.reduce((x, c) => (!x || c.cerca > x.cerca ? c : x), null);
  if (mejor) return { tipo: mejor.tipo, texto: mejor.texto, ancla: mejor.ancla };
  const pendiente = estanteria(m).find((e) => !e.ganado && e.logro !== 'racha');
  if (pendiente) return { tipo: 'logro', texto: `Todavía no ganas «${pendiente.etiqueta}»: ${pendiente.texto.charAt(0).toLowerCase()}${pendiente.texto.slice(1)} (+${pendiente.d} D).`, ancla: 'logros' };
  return null;
}
