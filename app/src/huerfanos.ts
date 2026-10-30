import { analizarBorrador } from './analisis.ts';

const MINUTO = 60_000;
const REINTENTO_MS = 15 * MINUTO;
// Sin contador (no hay migración): 3 corridas del cron de 15 min ≈ 1 h; pasada esa edad la pieza queda en error.
const ABANDONO_MS = 60 * MINUTO;
// ponytail: 5 por corrida (cada análisis tarda 20–40 s y la corrida de 15 min no debe encimarse); subir si se acumulan.
const LOTE_PENDIENTES = 5;

/**
 * Piezas que se quedaron en `pendiente` porque el Worker murió a media captura (#481). Las muy viejas
 * pasan a `error` (Revisar › Error); las demás se analizan otra vez, como las encola la cámara.
 * Una pieza `listo` nunca entra: las dos consultas exigen `estado_analisis = 'pendiente'`.
 */
export async function rescatarPendientes(env: Env, ahora = Date.now()): Promise<void> {
  const iso = (ms: number) => new Date(ahora - ms).toISOString();
  await env.DB.prepare(`update productos set estado_analisis = 'error', actualizado_en = ?, modificado_por = 'cron'
    where estado_analisis = 'pendiente' and foto_key <> '' and actualizado_en < ?`).bind(new Date(ahora).toISOString(), iso(ABANDONO_MS)).run();
  const { results } = await env.DB.prepare(`select id from productos
    where estado_analisis = 'pendiente' and foto_key <> '' and actualizado_en < ? order by actualizado_en limit ?`)
    .bind(iso(REINTENTO_MS), LOTE_PENDIENTES).all<{ id: string }>();
  // En serie: cada análisis llama a un modelo y la cuota de la IA es compartida con la cámara.
  for (const { id } of results) await analizarBorrador(id, env);
}

/** Lunes 09:00 UTC (03:00 en la Ciudad de México): la corrida de 15 min que cae en ese cuarto de hora. */
export function esCorridaSemanal(ms: number): boolean {
  const f = new Date(ms);
  return f.getUTCDay() === 1 && f.getUTCHours() === 9 && f.getUTCMinutes() < 15;
}

/** Llaves de `fotos/<id>.jpg` y `recortes/<id>.webp` cuya pieza ya no existe. Otras llaves se ignoran. */
export function llavesHuerfanas(llaves: string[], ids: Set<string>): string[] {
  return llaves.filter((llave) => {
    const id = llave.match(/^(?:fotos\/(.+)\.jpg|recortes\/(.+)\.webp)$/);
    return id && !ids.has(id[1] ?? id[2]);
  });
}

/** Solo informa (conteo y 20 llaves, sin contenido): borrar lo decide Isaac. */
export async function reportarHuerfanosR2(env: Env): Promise<void> {
  const llaves: string[] = [];
  // ponytail: tope de 200 páginas (200 mil objetos) por corrida; si la tienda lo supera, paginar entre corridas.
  for (const prefix of ['fotos/', 'recortes/']) {
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 200; pagina++) {
      const lote = await env.FOTOS.list({ prefix, cursor });
      llaves.push(...lote.objects.map((o) => o.key));
      if (!lote.truncated) break;
      cursor = lote.cursor;
    }
  }
  const { results } = await env.DB.prepare('select id from productos').all<{ id: string }>();
  const huerfanas = llavesHuerfanas(llaves, new Set(results.map((p) => p.id)));
  console.log(JSON.stringify({ mensaje: 'huerfanos en R2', total: llaves.length, huerfanos: huerfanas.length, primeros: huerfanas.slice(0, 20) }));
}
