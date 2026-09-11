/**
 * Escaner de El Dolaron — paso 1: esqueleto desplegado.
 * Solo dos rutas. La captura, el analisis, la cola del admin y las etiquetas
 * llegan en los pasos siguientes (docs/ARQUITECTURA-ESCANER.md).
 */

interface FilaConfig {
  clave: string;
  valor: string;
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function leerConfig(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('select clave, valor from config').all<FilaConfig>();
  return Object.fromEntries(results.map((fila) => [fila.clave, fila.valor]));
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);

    try {
      if (pathname === '/api/salud') {
        return json({ estado: 'ok' });
      }

      if (pathname === '/api/config') {
        return json(await leerConfig(env));
      }

      return json({ error: 'Ruta no encontrada.' }, 404);
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'fallo en la peticion', pathname, error: String(error) }));
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
