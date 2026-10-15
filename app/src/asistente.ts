// Enlace privado del asistente de WhatsApp con la tienda (Issue #296, fase 1: solo lectura).
// El Worker de WhatsApp llega aqui por service binding con un token secreto; sin token, nada.
// Solo devuelve nombre y precio de piezas nuevas listas y con existencia. Nunca datos de
// clientes, costos ni codigos internos.
const encoder = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
});

/** Compara digests de longitud fija: el tiempo no revela cuántos caracteres coinciden. */
async function tokenValido(recibido: string | null, esperado: string | undefined) {
  if (!recibido || !esperado) return false;
  const [a, b] = await Promise.all([recibido, esperado].map((t) => crypto.subtle.digest('SHA-256', encoder.encode(t))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diferencia = 0;
  for (let i = 0; i < x.length; i++) diferencia |= x[i] ^ y[i];
  return diferencia === 0;
}

const pesos = (centavos: number) => new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(centavos / 100);

/** Piezas que el cliente puede comprar hoy: nuevas, revisadas y con existencia (o bins sin inventario). */
export async function buscarProductos(db: D1Database, q: string) {
  // Los comodines del usuario se escapan: «%» busca el signo, no todo el catálogo.
  const patron = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
  const { results } = await db.prepare(`select nombre, precio from productos
    where estado_fisico = 'nuevo' and estado_analisis = 'listo' and nombre <> ''
      and nombre like ? escape '\\' and (stock > 0 or sin_inventario = 1)
    order by actualizado_en desc limit 5`).bind(patron).all<{ nombre: string; precio: number }>();
  return results.map((p) => ({ nombre: p.nombre, precio: pesos(p.precio) }));
}

export async function rutaAsistente(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ASISTENTE_TOKEN) return json({ error: 'Asistente no configurado.' }, 503);
  if (!await tokenValido(request.headers.get('x-asistente-token'), env.ASISTENTE_TOKEN))
    return json({ error: 'No autorizado.' }, 401);
  if (url.pathname === '/api/asistente/productos' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 60);
    return json({ productos: await buscarProductos(env.DB, q) });
  }
  return json({ error: 'Ruta no encontrada.' }, 404);
}
