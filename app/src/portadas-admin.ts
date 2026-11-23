/**
 * Revisión humana de portadas en /admin (#890, parte de #886). Mismo patrón que `rutaRecortesAdmin`; la lógica de R2 y de estados vive en
 * portadas.ts (`resolverPortada`, `imagenDePortada`). El worker pone antes el rol (capturista o gerencia, sin FEP ni hosts públicos) y la
 * casilla «Editar inventario» para los POST; las imágenes salen solo por aquí, nunca por el host público.
 */
import { imagenDePortada, resolverPortada, type AccionPortada, type ResultadoPortada } from './portadas.ts';

const resp = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// ponytail: tope de 30 por lista, lo más reciente primero, sin paginar ni buscar. Subirlo o paginar cuando el piloto (#889) deje más en cola.
const POR_LISTA = 30;

const MENSAJES: Record<Exclude<ResultadoPortada, 'ok'>, [number, string]> = {
  inexistente: [404, 'Pieza no encontrada.'],
  cambio: [409, 'La pieza cambió mientras la veías (otra persona o el sistema). Se actualiza la lista.'],
  manual: [409, 'Es una portada hecha a mano: no se reemplaza. Puedes rechazarla o retomar la foto.'],
};

function revision(texto: string | null) {
  if (!texto) return null;
  try { return JSON.parse(texto); } catch { return null; }
}

export async function rutaPortadasAdmin(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === '/api/portadas' && request.method === 'GET') {
    // Una sola lectura: las piezas con portada en revisión y, por estado, las POR_LISTA más recientes.
    const { results } = await env.DB.prepare(`select id, codigo, nombre, portada_estado, portada_origen, portada_fecha, portada_revision from (
      select id, codigo, nombre, portada_estado, portada_origen, portada_fecha, portada_revision,
        row_number() over (partition by portada_estado order by portada_fecha desc) n
      from productos where propietario = 'dolaron' and estado_analisis <> 'descartado' and portada_estado in ('revisar', 'retomar', 'lista', 'oficial'))
      where n <= ? order by portada_fecha desc`).bind(POR_LISTA).all<Record<string, string | null>>();
    const listas: Record<string, unknown[]> = { revisar: [], retomar: [], lista: [], oficial: [] };
    for (const f of results) {
      listas[f.portada_estado!].push({ id: f.id, codigo: f.codigo, nombre: f.nombre, estado: f.portada_estado, origen: f.portada_origen,
        fecha: f.portada_fecha, revision: revision(f.portada_revision) });
    }
    return resp(listas);
  }
  const m = pathname.match(/^\/api\/portadas\/([^/]+)\/(imagen|aprobar|rechazar|retomar|generar)$/);
  if (!m) return null;
  const [, id, accion] = m;
  if (!UUID.test(id)) return resp({ error: 'Pieza no encontrada.' }, 404);
  if (accion === 'imagen') {
    if (request.method !== 'GET') return null;
    const pieza = await env.DB.prepare("select portada_estado from productos where id = ? and propietario = 'dolaron' and estado_analisis <> 'descartado'")
      .bind(id).first<{ portada_estado: string | null }>();
    const objeto = pieza && await imagenDePortada(env, id, pieza.portada_estado);
    if (!objeto) return resp({ error: 'Portada no encontrada.' }, 404);
    return new Response(objeto.body, { headers: { 'content-type': objeto.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, no-store' } });
  }
  if (request.method !== 'POST') return null;
  // La pantalla manda lo que mostró: el cambio solo se aplica si la pieza sigue igual (y la portada es la misma).
  const cuerpo = await request.json().catch(() => null) as { estado?: unknown; fecha?: unknown } | null;
  if (typeof cuerpo?.estado !== 'string' || (cuerpo.fecha !== null && typeof cuerpo.fecha !== 'string')) return resp({ error: 'Falta el estado que mostraba la pantalla.' }, 400);
  const resultado = await resolverPortada(env, id, accion as AccionPortada, { estado: cuerpo.estado, fecha: cuerpo.fecha });
  if (resultado === 'ok') return resp({ ok: true });
  const [estado, error] = MENSAJES[resultado];
  return resp({ error }, estado);
}
