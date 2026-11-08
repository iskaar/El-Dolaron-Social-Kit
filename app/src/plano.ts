/**
 * Plano del local (Issue #756): quien tiene a cargo cada letrero (1-36, public/plano.js).
 * Vive en `config.plano_areas` como JSON `{ "<letrero>": <id de empleado> }`: sin migracion.
 * Leer: cualquier cuenta de piso. Escribir: solo el dueno (cuentas.ts lo cierra por ruta y aqui se vuelve a verificar).
 */
import type { Usuario } from './cuentas.ts';

const LETREROS = 36;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

export async function rutaPlano(request: Request, env: Env, usuario: Usuario | null, correo: string): Promise<Response> {
  const dueno = !!usuario?.activo && usuario.roles.includes('dueno');
  if (request.method === 'PUT') {
    if (!dueno) return json({ error: 'Solo el dueño asigna áreas.' }, 403);
    const cuerpo = await request.json().catch(() => null) as { areas?: unknown } | null;
    const areas = cuerpo?.areas;
    if (!areas || typeof areas !== 'object' || Array.isArray(areas)) return json({ error: 'Faltan las áreas.' }, 400);
    const activos = new Set((await env.DB.prepare('select id from empleados where activo = 1').all<{ id: string }>()).results.map((e) => e.id));
    for (const [letrero, empleado] of Object.entries(areas)) {
      const n = Number(letrero);
      if (!Number.isInteger(n) || n < 1 || n > LETREROS || String(n) !== letrero) return json({ error: `Letrero inválido: ${letrero.slice(0, 20)}.` }, 400);
      if (typeof empleado !== 'string' || !activos.has(empleado)) return json({ error: `Empleado inválido en el letrero ${n}.` }, 400);
    }
    await env.DB.prepare(`insert into config (clave, valor) values ('plano_areas', ?)
      on conflict (clave) do update set valor = excluded.valor`).bind(JSON.stringify(areas)).run();
    return json({ areas });
  }
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
  const [fila, empleados, yo] = await Promise.all([
    env.DB.prepare(`select valor from config where clave = 'plano_areas'`).first<{ valor: string }>(),
    env.DB.prepare('select id, nombre from empleados where activo = 1 order by nombre, id').all<{ id: string; nombre: string }>(),
    env.DB.prepare(`select id from empleados where correo = ? and correo <> '' and activo = 1`).bind(correo).first<{ id: string }>(),
  ]);
  const activos = new Set(empleados.results.map((e) => e.id));
  let guardadas: Record<string, string> = {};
  try { guardadas = JSON.parse(fila?.valor ?? '{}'); } catch { /* ponytail: JSON dañado = sin asignar */ }
  // Quien se dio de baja deja sus letreros libres sin que el dueño tenga que limpiarlos.
  const areas = Object.fromEntries(Object.entries(guardadas).filter(([, id]) => activos.has(id)));
  return json({ areas, empleados: empleados.results, yo: yo?.id ?? null, puede_asignar: dueno });
}
