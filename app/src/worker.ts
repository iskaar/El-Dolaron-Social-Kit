/**
 * Escaner de El Dolaron.
 * Paso 1: esqueleto (salud, config). Paso 2: captura desde el telefono.
 * El analisis, la cola del admin y las etiquetas llegan en los pasos siguientes
 * (docs/ARQUITECTURA-ESCANER.md).
 */

interface FilaConfig {
  clave: string;
  valor: string;
}

interface FilaBorrador {
  id: string;
  nombre: string;
  categoria: string;
  precio_lista: number;
  precio: number;
  estado_fisico: string;
  estado_analisis: string;
  destino: string;
  semana_ingreso: string;
  creado_en: string;
}

const ESTADOS_FISICOS = new Set(['nuevo', 'danado']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOTO_MAX_BYTES = 6 * 1024 * 1024;

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Semana ISO de ingreso, como 'S37'. Va impresa en la etiqueta. */
export function semanaIngreso(fecha: Date): string {
  const d = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
  // Jueves de esa semana: define el año ISO al que pertenece.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const primeroDeEnero = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((d.getTime() - primeroDeEnero.getTime()) / 86400000 + 1) / 7);
  return `S${String(semana).padStart(2, '0')}`;
}

async function leerConfig(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('select clave, valor from config').all<FilaConfig>();
  return Object.fromEntries(results.map((fila) => [fila.clave, fila.valor]));
}

/**
 * Guarda la foto y el borrador. Idempotente por id: el telefono genera el id
 * antes de subir, asi que un reintento tras una red caida no duplica la pieza.
 */
async function crearBorrador(request: Request, env: Env): Promise<Response> {
  const formulario = await request.formData();
  const id = String(formulario.get('id') ?? '');
  const estadoFisico = String(formulario.get('estado_fisico') ?? 'nuevo');
  const foto = formulario.get('foto');

  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
  }
  if (!(foto instanceof File) || foto.size === 0) {
    return json({ error: 'Falta la foto.' }, 400);
  }
  if (foto.size > FOTO_MAX_BYTES) {
    return json({ error: 'La foto pesa demasiado.' }, 413);
  }

  const fotoKey = `fotos/${id}.jpg`;
  await env.FOTOS.put(fotoKey, foto.stream(), {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  const ahora = new Date();
  await env.DB.prepare(
    `insert into productos (id, semana_ingreso, estado_fisico, foto_key, creado_en, actualizado_en)
     values (?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       estado_fisico = excluded.estado_fisico,
       foto_key = excluded.foto_key,
       actualizado_en = excluded.actualizado_en`,
  )
    .bind(id, semanaIngreso(ahora), estadoFisico, fotoKey, ahora.toISOString(), ahora.toISOString())
    .run();

  return json({ id, estado_analisis: 'pendiente' }, 201);
}

async function listarBorradores(url: URL, env: Env): Promise<Response> {
  const estado = url.searchParams.get('estado');
  const consulta = `select id, nombre, categoria, precio_lista, precio, estado_fisico,
                           estado_analisis, destino, semana_ingreso, creado_en
                    from productos
                    ${estado ? 'where estado_analisis = ?' : ''}
                    order by creado_en desc limit 200`;
  const sentencia = estado
    ? env.DB.prepare(consulta).bind(estado)
    : env.DB.prepare(consulta);
  const { results } = await sentencia.all<FilaBorrador>();
  return json(results);
}

async function servirFoto(id: string, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const objeto = await env.FOTOS.get(`fotos/${id}.jpg`);
  if (!objeto) {
    return json({ error: 'Foto no encontrada.' }, 404);
  }
  return new Response(objeto.body, {
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'private, max-age=3600',
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/salud') {
        return json({ estado: 'ok' });
      }

      if (pathname === '/api/config') {
        return json(await leerConfig(env));
      }

      if (pathname === '/api/borradores') {
        if (request.method === 'POST') {
          return await crearBorrador(request, env);
        }
        if (request.method === 'GET') {
          return await listarBorradores(url, env);
        }
        return json({ error: 'Metodo no permitido.' }, 405);
      }

      const foto = pathname.match(/^\/api\/foto\/([^/]+)$/);
      if (foto) {
        return await servirFoto(foto[1], env);
      }

      return json({ error: 'Ruta no encontrada.' }, 404);
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'fallo en la peticion', pathname, error: String(error) }));
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
