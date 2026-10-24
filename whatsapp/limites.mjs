// Límites de uso del asistente (Issue #503): frenos contra bucles, floods y abuso del modelo.
// Contadores en el KV de eventos con vencimiento. KV es eventual, así que los conteos son
// aproximados: sirven como freno, no como factura exacta. ponytail: Durable Object si algún día
// hace falta un contador exacto por número.
export const MAX_POR_MINUTO = 5;          // mensajes de un mismo número en un minuto; de ahí en adelante se ignoran
export const MAX_MODELO_DIA = 25;         // llamadas al modelo por número y día; después solo respuesta fija
export const MAX_MODELO_GLOBAL_DIA = 1500; // llamadas al modelo de toda la tienda por día; después solo FAQ fijo
export const MAX_CARACTERES = 600;        // lo que va al modelo; lo demás se recorta

export const SIN_CUOTA = 'Por hoy ya te ayudé con todo lo que puedo por aquí. El equipo te responde por este mismo chat en horario de 11 a. m. a 8 p. m.';

const dia = (ahora) => new Date(ahora).toISOString().slice(0, 10);
const minuto = (ahora) => Math.floor(ahora / 60000);

/** Suma uno a un contador con vencimiento y devuelve el nuevo valor. */
async function contar(kv, clave, ttl) {
  const actual = Number(await kv.get(clave)) || 0;
  const nuevo = actual + 1;
  await kv.put(clave, String(nuevo), { expirationTtl: ttl });
  return nuevo;
}

/** true si este número ya mandó demasiado en el último minuto: no se le contesta nada. */
export async function enRafaga(kv, de, ahora = Date.now()) {
  return (await contar(kv, `rafaga:${de}:${minuto(ahora)}`, 120)) > MAX_POR_MINUTO;
}

/**
 * Reserva una llamada al modelo. Devuelve null si cabe, o el motivo ('numero' | 'global') si no.
 * Se cuenta antes de llamar: una llamada que falla también gasta, para que un error repetido no sea gratis.
 */
export async function reservarModelo(kv, de, ahora = Date.now()) {
  const hoy = dia(ahora);
  if ((await contar(kv, `cuota:${hoy}:${de}`, 2 * 86400)) > MAX_MODELO_DIA) return 'numero';
  if ((await contar(kv, `cuota:${hoy}:global`, 2 * 86400)) > MAX_MODELO_GLOBAL_DIA) return 'global';
  return null;
}

/** Texto que va al modelo: sin saltos raros y con tope de caracteres. */
export const recortar = (texto) => String(texto ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CARACTERES);
