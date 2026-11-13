import type { Usuario } from './cuentas.ts';

/** Espejo de captura (Issue #775): la tarjeta actual de Capturar, una fila por cuenta. Solo es un puntero: nunca escribe inventario. */
export const LIMITE_ESTADO = 8192;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CONSULTA_ESPEJO = 'select version, estado, dispositivo, actualizado_en from espejo_captura where correo = ?';
interface Fila { version: number; estado: string; dispositivo: string; actualizado_en: string }

const json = (cuerpo: object, status = 200) => Response.json({ ...cuerpo, ahora: new Date().toISOString() }, { status, headers: { 'cache-control': 'no-store' } });
const salida = (f: Fila | null) => f ? { ...f, estado: JSON.parse(f.estado) } : { version: 0, estado: {}, dispositivo: '', actualizado_en: '' };

export async function rutaEspejoCaptura(request: Request, env: Env, usuario: Usuario): Promise<Response> {
  const correo = usuario.correo;
  const leer = () => env.DB.prepare(CONSULTA_ESPEJO).bind(correo).first<Fila>();
  if (request.method === 'GET') return json(salida(await leer()));
  if (request.method !== 'PUT') return json({ error: 'Ruta no encontrada.' }, 404);
  const cuerpo = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return json({ error: 'Datos inválidos.' }, 400);
  const { version_esperada: esperada, estado, dispositivo } = cuerpo;
  if (typeof esperada !== 'number' || !Number.isSafeInteger(esperada) || esperada < 0
      || typeof dispositivo !== 'string' || !ID.test(dispositivo)
      || !estado || typeof estado !== 'object' || Array.isArray(estado)) return json({ error: 'Datos inválidos.' }, 400);
  const texto = JSON.stringify(estado);
  if (new TextEncoder().encode(texto).length > LIMITE_ESTADO) return json({ error: 'La tarjeta es demasiado grande.' }, 400);
  const ahora = new Date().toISOString();
  // Comparar y escribir en una sola sentencia: la fila cambia solo si su versión es la esperada (esperada 0 = aún no hay fila).
  // `changes` de ESTA sentencia dice si escribió; no se infiere de comparar la fila después (otro aparato pudo escribir igual).
  const { meta } = await env.DB.prepare(`insert into espejo_captura (correo, version, estado, dispositivo, actualizado_en)
    select ?, 1, ?, ?, ? where ? = 0 or exists (select 1 from espejo_captura where correo = ? and version = ?)
    on conflict (correo) do update set version = espejo_captura.version + 1, estado = excluded.estado,
      dispositivo = excluded.dispositivo, actualizado_en = excluded.actualizado_en
    where espejo_captura.version = ?`).bind(correo, texto, dispositivo, ahora, esperada, correo, esperada, esperada).run();
  const f = await leer();
  return meta.changes ? json(salida(f)) : json({ error: 'La tarjeta cambió en otro aparato.', vigente: salida(f) }, 409);
}
