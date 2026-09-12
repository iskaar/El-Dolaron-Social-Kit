/**
 * Escaner de El Dolaron.
 * Paso 1: esqueleto (salud, config). Paso 2: captura desde el telefono.
 * El analisis, la cola del admin y las etiquetas llegan en los pasos siguientes
 * (docs/ARQUITECTURA-ESCANER.md).
 */

import { analizarBorrador, MODELO_POR_DEFECTO, type Modelo } from './analisis.ts';
import { calcularPrecio } from './precio.ts';

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
function modeloPedido(url: URL): Modelo {
  return url.searchParams.get('modelo') === 'gemini' ? 'gemini' : MODELO_POR_DEFECTO;
}

async function crearBorrador(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
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

  // El analisis corre despues de responder: la camara nunca espera a la IA.
  ctx.waitUntil(analizarBorrador(id, env, modeloPedido(url)));

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

const CATEGORIAS = new Set(['ropa', 'hogar', 'electronica', 'juguetes', 'otros']);
const DESTINOS = new Set(['etiqueta', 'bin_20', 'bin_40', 'bin_60']);

/**
 * Correcciones del admin. Solo llegan los campos que cambiaron; si no viene un
 * precio explicito, se recalcula con la configuracion vigente.
 */
async function corregirBorrador(id: string, request: Request, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const fila = await env.DB.prepare(
    'select nombre, categoria, precio_lista, precio, estado_fisico, destino from productos where id = ?',
  )
    .bind(id)
    .first<FilaBorrador>();
  if (!fila) {
    return json({ error: 'La pieza no existe.' }, 404);
  }

  const cambios = (await request.json()) as Record<string, unknown>;
  const nombre = cambios.nombre === undefined ? fila.nombre : String(cambios.nombre).slice(0, 120);
  const categoria = cambios.categoria === undefined ? fila.categoria : String(cambios.categoria);
  const estadoFisico = cambios.estado_fisico === undefined ? fila.estado_fisico : String(cambios.estado_fisico);
  const precioLista = cambios.precio_lista === undefined ? fila.precio_lista : Math.round(Number(cambios.precio_lista));

  if (categoria && !CATEGORIAS.has(categoria)) {
    return json({ error: 'Categoria invalida.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
  }
  if (!Number.isFinite(precioLista) || precioLista < 0) {
    return json({ error: 'Precio de lista invalido.' }, 400);
  }

  const config = await leerConfig(env);
  let precio: number;
  let destino: string;

  if (cambios.precio === undefined) {
    const calculado = calcularPrecio({ precioLista, categoria, estadoFisico, config });
    precio = calculado.precio;
    destino = cambios.destino === undefined ? calculado.destino : String(cambios.destino);
  } else {
    precio = Math.round(Number(cambios.precio));
    destino = cambios.destino === undefined ? fila.destino : String(cambios.destino);
    if (!Number.isFinite(precio) || precio < 0) {
      return json({ error: 'Precio invalido.' }, 400);
    }
    // Misma regla que en el calculo automatico: el precio de venta nunca queda
    // por encima del precio de lista.
    if (precioLista > 0 && precio > precioLista) {
      return json({ error: 'El precio de venta no puede ser mayor al precio de lista.' }, 400);
    }
  }

  if (!DESTINOS.has(destino)) {
    return json({ error: 'Destino invalido.' }, 400);
  }

  await env.DB.prepare(
    `update productos set nombre = ?, categoria = ?, precio_lista = ?, precio = ?,
                          estado_fisico = ?, destino = ?, estado_analisis = 'listo', actualizado_en = ?
     where id = ?`,
  )
    .bind(nombre, categoria, precioLista, precio, estadoFisico, destino, new Date().toISOString(), id)
    .run();

  return json({ id, nombre, categoria, precio_lista: precioLista, precio, estado_fisico: estadoFisico, destino });
}

async function descartarBorrador(id: string, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  await env.FOTOS.delete(`fotos/${id}.jpg`);
  await env.DB.prepare('delete from productos where id = ?').bind(id).run();
  return json({ id, descartado: true });
}

/** Los porcentajes y limites que gobiernan el precio. Solo enteros. */
async function guardarConfig(request: Request, env: Env): Promise<Response> {
  const cambios = (await request.json()) as Record<string, unknown>;
  const entradas = Object.entries(cambios);
  if (entradas.length === 0 || entradas.length > 20) {
    return json({ error: 'Configuracion invalida.' }, 400);
  }
  for (const [clave, valor] of entradas) {
    const numero = Math.round(Number(valor));
    if (!/^[a-z_0-9]{1,40}$/.test(clave) || !Number.isFinite(numero) || numero < 0) {
      return json({ error: `Valor invalido para ${clave}.` }, 400);
    }
    await env.DB.prepare(
      `insert into config (clave, valor) values (?, ?)
       on conflict (clave) do update set valor = excluded.valor`,
    )
      .bind(clave, String(numero))
      .run();
  }
  return json(await leerConfig(env));
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
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/salud') {
        return json({ estado: 'ok' });
      }

      if (pathname === '/api/config') {
        if (request.method === 'PUT') {
          return await guardarConfig(request, env);
        }
        return json(await leerConfig(env));
      }

      if (pathname === '/api/borradores') {
        if (request.method === 'POST') {
          return await crearBorrador(request, env, ctx, url);
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

      const pieza = pathname.match(/^\/api\/borradores\/([^/]+)$/);
      if (pieza) {
        if (request.method === 'PATCH') {
          return await corregirBorrador(pieza[1], request, env);
        }
        if (request.method === 'DELETE') {
          return await descartarBorrador(pieza[1], env);
        }
        return json({ error: 'Metodo no permitido.' }, 405);
      }

      // Reintento manual, y la via para la prueba comparativa: ?modelo=gemini
      const reintento = pathname.match(/^\/api\/borradores\/([^/]+)\/analizar$/);
      if (reintento && request.method === 'POST') {
        if (!UUID.test(reintento[1])) {
          return json({ error: 'Identificador invalido.' }, 400);
        }
        const modelo = modeloPedido(url);
        ctx.waitUntil(analizarBorrador(reintento[1], env, modelo));
        return json({ id: reintento[1], modelo, estado_analisis: 'pendiente' }, 202);
      }

      return json({ error: 'Ruta no encontrada.' }, 404);
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'fallo en la peticion', pathname, error: String(error) }));
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
