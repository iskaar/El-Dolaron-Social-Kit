/**
 * Plano del local (Issue #756): quien tiene a cargo cada letrero (1-36, public/plano.js).
 * Vive en `config.plano_areas` como JSON `{ "<letrero>": <id de empleado> }`: sin migracion.
 * Los nombres de categoría que el dueño da a cada letrero viven en `config.plano_nombres` (`{ "<letrero>": texto }`);
 * solo cambian lo que se lee en el plano, nunca a qué letrero va una pieza (eso lo decide public/letreros.js).
 * Leer: cualquier cuenta de piso. Escribir: solo el dueno (cuentas.ts lo cierra por ruta y aqui se vuelve a verificar).
 */
import type { Usuario } from './cuentas.ts';

const LETREROS = 36;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});

const guardar = (env: Env, clave: string, valor: unknown) => env.DB.prepare(`insert into config (clave, valor) values (?, ?)
  on conflict (clave) do update set valor = excluded.valor`).bind(clave, JSON.stringify(valor));

async function leerNombres(env: Env): Promise<Record<string, string>> {
  const fila = await env.DB.prepare(`select valor from config where clave = 'plano_nombres'`).first<{ valor: string }>();
  try { const n = JSON.parse(fila?.valor ?? '{}'); return n && typeof n === 'object' && !Array.isArray(n) ? n : {}; } catch { return {}; }   // ponytail: JSON dañado = sin nombres propios
}

export async function rutaPlano(request: Request, env: Env, usuario: Usuario | null, correo: string): Promise<Response> {
  const dueno = !!usuario?.activo && usuario.roles.includes('dueno');
  if (request.method === 'PUT') {
    if (!dueno) return json({ error: 'Solo el dueño asigna áreas.' }, 403);
    const cuerpo = await request.json().catch(() => null) as { areas?: unknown; nombres?: unknown } | null;
    const { areas, nombres } = cuerpo ?? {};
    if (areas === undefined && nombres === undefined) return json({ error: 'Faltan las áreas o los nombres.' }, 400);
    const letreroValido = (letrero: string) => { const n = Number(letrero); return Number.isInteger(n) && n >= 1 && n <= LETREROS && String(n) === letrero; };
    const sentencias = [];
    if (areas !== undefined) {
      if (!areas || typeof areas !== 'object' || Array.isArray(areas)) return json({ error: 'Faltan las áreas.' }, 400);
      const activos = new Set((await env.DB.prepare('select id from empleados where activo = 1').all<{ id: string }>()).results.map((e) => e.id));
      for (const [letrero, empleado] of Object.entries(areas)) {
        if (!letreroValido(letrero)) return json({ error: `Letrero inválido: ${letrero.slice(0, 20)}.` }, 400);
        if (typeof empleado !== 'string' || !activos.has(empleado)) return json({ error: `Empleado inválido en el letrero ${letrero}.` }, 400);
      }
      sentencias.push(guardar(env, 'plano_areas', areas));
    }
    // Los nombres se mezclan con los guardados: cada letrero se cambia solo; texto vacío lo devuelve al del plano.
    let nuevos: Record<string, string> | undefined;
    if (nombres !== undefined) {
      if (!nombres || typeof nombres !== 'object' || Array.isArray(nombres)) return json({ error: 'Nombres inválidos.' }, 400);
      nuevos = await leerNombres(env);
      for (const [letrero, texto] of Object.entries(nombres)) {
        if (!letreroValido(letrero)) return json({ error: `Letrero inválido: ${letrero.slice(0, 20)}.` }, 400);
        if (typeof texto !== 'string' || texto.trim().length > 80) return json({ error: `El nombre del letrero ${letrero} debe tener de 1 a 80 caracteres.` }, 400);
        if (texto.trim()) nuevos[letrero] = texto.trim(); else delete nuevos[letrero];
      }
      sentencias.push(guardar(env, 'plano_nombres', nuevos));
    }
    await env.DB.batch(sentencias);
    return json({ ...(areas !== undefined && { areas }), ...(nuevos && { nombres: nuevos }) });
  }
  if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405);
  const [fila, empleados, yo, nombres] = await Promise.all([
    env.DB.prepare(`select valor from config where clave = 'plano_areas'`).first<{ valor: string }>(),
    env.DB.prepare('select id, nombre from empleados where activo = 1 order by nombre, id').all<{ id: string; nombre: string }>(),
    env.DB.prepare(`select id from empleados where correo = ? and correo <> '' and activo = 1`).bind(correo).first<{ id: string }>(),
    leerNombres(env),
  ]);
  const activos = new Set(empleados.results.map((e) => e.id));
  let guardadas: Record<string, string> = {};
  try { guardadas = JSON.parse(fila?.valor ?? '{}'); } catch { /* ponytail: JSON dañado = sin asignar */ }
  // Quien se dio de baja deja sus letreros libres sin que el dueño tenga que limpiarlos.
  const areas = Object.fromEntries(Object.entries(guardadas).filter(([, id]) => activos.has(id)));
  return json({ areas, nombres, empleados: empleados.results, yo: yo?.id ?? null, puede_asignar: dueno });
}
