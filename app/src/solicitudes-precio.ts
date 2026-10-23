/**
 * Solicitudes de cambio de precio (#451): quien captura señala que una pieza está muy barata o muy cara
 * y el dueño decide. El servidor autoriza: pedir es de dueño o capturista; listar, aplicar y rechazar,
 * solo del dueño. Todo en centavos MXN enteros. Una sola solicitud pendiente por pieza (índice único).
 * Aplicar reutiliza corregirBorrador (worker.ts) para no duplicar las reglas del precio.
 */
import { propietarioDe, type Usuario } from './cuentas.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAXIMO = 10_000_000;   // $100,000: mismo tope práctico que el campo de precio de la ficha
const json = (cuerpo: unknown, status = 200) => Response.json(cuerpo, { status, headers: { 'cache-control': 'no-store' } });

export interface SolicitudPrecio {
  id: string; producto_id: string; propietario: string; sentido: 'subir' | 'bajar'; precio_actual: number;
  precio_sugerido: number | null; nota: string; pedido_por: string; pedido_en: string;
  estado: 'pendiente' | 'aplicada' | 'rechazada'; resuelto_por: string; resuelto_en: string; precio_nuevo: number | null;
}
interface PiezaPrecio { id: string; precio: number; precio_lista: number; destino: string; estado_analisis: string }

const COLUMNAS = `id, producto_id, propietario, sentido, precio_actual, precio_sugerido, nota, pedido_por, pedido_en,
  estado, resuelto_por, resuelto_en, precio_nuevo`;
const PIEZA = `select id, precio, precio_lista, destino, estado_analisis from productos
  where id = ? and propietario = ? and sin_inventario = 0 and estado_analisis <> 'descartado'`;

const porId = (env: Env, id: string) => env.DB.prepare(`select ${COLUMNAS} from solicitudes_precio where id = ?`).bind(id).first<SolicitudPrecio>();
/** La solicitud pendiente de una pieza, o null: la ficha la muestra. */
export const pendienteDe = (env: Env, productoId: string) =>
  env.DB.prepare(`select ${COLUMNAS} from solicitudes_precio where producto_id = ? and estado = 'pendiente'`).bind(productoId).first<SolicitudPrecio>();

const esDueno = (u: Usuario | null) => !!u?.activo && u.roles.includes('dueno');
const puedePedir = (u: Usuario | null) => !!u?.activo && (u.roles.includes('dueno') || u.roles.includes('capturista'));

async function pedir(request: Request, env: Env, productoId: string, usuario: Usuario): Promise<Response> {
  const cuerpo = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return json({ error: 'Datos inválidos.' }, 400);
  const { id, sentido } = cuerpo;
  if (!UUID.test(productoId) || typeof id !== 'string' || !UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  if (sentido !== 'subir' && sentido !== 'bajar') return json({ error: 'Elige si está barato o caro.' }, 400);
  const sugerido = cuerpo.precio_sugerido ?? null;
  if (sugerido !== null && (typeof sugerido !== 'number' || !Number.isSafeInteger(sugerido) || sugerido <= 0 || sugerido > MAXIMO))
    return json({ error: 'El precio sugerido no es válido.' }, 400);
  if (cuerpo.nota !== undefined && typeof cuerpo.nota !== 'string') return json({ error: 'La nota no es válida.' }, 400);
  const nota = String(cuerpo.nota ?? '').replace(/\s+/g, ' ').trim();
  if (nota.length > 140) return json({ error: 'La nota admite hasta 140 caracteres.' }, 400);

  // Reintento con el mismo folio: la misma solicitud, solo si es de esta pieza y de esta persona.
  const previa = await porId(env, id);
  if (previa) return previa.producto_id === productoId && previa.pedido_por === usuario.correo ? json({ solicitud: previa })
    : json({ error: 'El folio ya pertenece a otra solicitud.' }, 409);

  const pieza = await env.DB.prepare(PIEZA).bind(productoId, propietarioDe(usuario)).first<PiezaPrecio>();
  if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
  if (pieza.destino !== 'etiqueta') return json({ error: 'Una pieza de banda tiene el precio de su banda: no se pide cambio aquí.' }, 400);
  if (pieza.estado_analisis !== 'listo' || pieza.precio <= 0) return json({ error: 'La pieza aún no tiene precio para revisar.' }, 400);
  if (sugerido !== null) {
    if (sentido === 'subir' && sugerido <= pieza.precio) return json({ error: 'Para subir, el precio sugerido debe ser mayor al actual.' }, 400);
    if (sentido === 'bajar' && sugerido >= pieza.precio) return json({ error: 'Para bajar, el precio sugerido debe ser menor al actual.' }, 400);
    if (pieza.precio_lista > 0 && sugerido > pieza.precio_lista) return json({ error: 'El precio sugerido no puede ser mayor al precio de lista.' }, 400);
  }
  const existente = async () => json({ error: 'Esta pieza ya tiene una solicitud de precio pendiente.', solicitud: await pendienteDe(env, productoId) }, 409);
  if (await pendienteDe(env, productoId)) return existente();

  // El precio se copia dentro del insert y se exige el que se validó: si cambió en medio, no se guarda.
  let cambios = 0;
  try {
    cambios = (await env.DB.prepare(`insert into solicitudes_precio
      (id, producto_id, propietario, sentido, precio_actual, precio_sugerido, nota, pedido_por, pedido_en)
      select ?, id, propietario, ?, precio, ?, ?, ?, ? from productos where id = ? and propietario = ? and precio = ?
        and destino = 'etiqueta' and sin_inventario = 0 and estado_analisis = 'listo'`)
      .bind(id, sentido, sugerido, nota, usuario.correo, new Date().toISOString(), productoId, propietarioDe(usuario), pieza.precio).run()).meta.changes;
  } catch (error) {
    // Otra persona pidió en el mismo instante: el índice único dejó pasar solo una.
    if (await pendienteDe(env, productoId)) return existente();
    throw error;
  }
  if (!cambios) return json({ error: 'El precio cambió mientras lo pedías. Abre la pieza otra vez.' }, 409);
  return json({ solicitud: await porId(env, id) }, 201);
}

async function listar(env: Env, url: URL, usuario: Usuario): Promise<Response> {
  if ((url.searchParams.get('estado') ?? 'pendiente') !== 'pendiente') return json({ error: 'Solo se listan las pendientes.' }, 400);
  const { results } = await env.DB.prepare(`select s.id, s.producto_id, s.sentido, s.precio_actual, s.precio_sugerido, s.nota,
      s.pedido_por, s.pedido_en, s.estado, p.codigo, p.nombre, p.marca, p.talla, p.precio, p.precio_lista, p.destino,
      p.foto_key <> '' as tiene_foto, p.actualizado_en
    from solicitudes_precio s join productos p on p.id = s.producto_id
    where s.estado = 'pendiente' and s.propietario = ? and p.propietario = s.propietario
    order by s.pedido_en, s.id limit 200`).bind(propietarioDe(usuario)).all();
  return json({ solicitudes: results, conteo: results.length });
}

/** Aplica con la misma lógica de servidor que la corrección de precio de la ficha (`aplicarPrecio`). */
type AplicarPrecio = (productoId: string, precio: number, esperado: number) => Promise<Response>;

async function resolver(request: Request, env: Env, id: string, usuario: Usuario, aplicarPrecio: AplicarPrecio): Promise<Response> {
  const cuerpo = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!UUID.test(id) || !cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return json({ error: 'Datos inválidos.' }, 400);
  const accion = cuerpo.accion;
  if (accion !== 'aplicar' && accion !== 'rechazar') return json({ error: 'Acción inválida.' }, 400);
  const solicitud = await porId(env, id);
  if (!solicitud || solicitud.propietario !== propietarioDe(usuario)) return json({ error: 'Solicitud no encontrada.' }, 404);
  const yaResuelta = () => json({ error: `La solicitud ya estaba ${solicitud.estado === 'pendiente' ? 'resuelta' : solicitud.estado}.`, solicitud }, 409);
  if (solicitud.estado !== 'pendiente') return yaResuelta();

  // Solo pasa de pendiente a resuelta una vez: se verifica el efecto, no se supone.
  const marcar = async (estado: 'aplicada' | 'rechazada', precioNuevo: number | null) => {
    const { meta } = await env.DB.prepare(`update solicitudes_precio set estado = ?, resuelto_por = ?, resuelto_en = ?, precio_nuevo = ?
      where id = ? and estado = 'pendiente'`).bind(estado, usuario.correo, new Date().toISOString(), precioNuevo, id).run();
    return meta.changes === 1;
  };

  if (accion === 'rechazar') {
    if (!await marcar('rechazada', null)) return json({ error: 'La solicitud ya estaba resuelta.', solicitud: await porId(env, id) }, 409);
    return json({ solicitud: await porId(env, id) });
  }

  const { precio, precio_esperado: esperado } = cuerpo;
  if (typeof precio !== 'number' || !Number.isSafeInteger(precio) || precio <= 0 || precio > MAXIMO
      || typeof esperado !== 'number' || !Number.isSafeInteger(esperado))
    return json({ error: 'Indica el precio nuevo y el precio que ves ahora, en centavos.' }, 400);
  const pieza = await env.DB.prepare(PIEZA).bind(solicitud.producto_id, solicitud.propietario).first<PiezaPrecio>();
  if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
  if (pieza.destino !== 'etiqueta') return json({ error: 'La pieza pasó a una banda: su precio es el de la banda. Deja igual la solicitud.' }, 409);
  // Si ya vale lo pedido (un reintento tras una respuesta perdida) solo falta cerrar la solicitud.
  if (pieza.precio !== precio) {
    if (pieza.precio !== esperado) return json({ error: 'El precio de la pieza cambió. Revisa el precio actual.', precio: pieza.precio }, 409);
    const r = await aplicarPrecio(pieza.id, precio, esperado);
    if (r.status !== 200) return r;
  }
  if (!await marcar('aplicada', precio)) return json({ error: 'La solicitud ya estaba resuelta.', solicitud: await porId(env, id) }, 409);
  return json({ solicitud: await porId(env, id), precio });
}

export async function rutaSolicitudesPrecio(request: Request, env: Env, url: URL, usuario: Usuario, aplicarPrecio: AplicarPrecio): Promise<Response> {
  const metodo = request.method;
  const nueva = /^\/api\/piezas\/([^/]+)\/solicitud-precio$/.exec(url.pathname);
  if (nueva) {
    if (metodo !== 'POST') return json({ error: 'Método no permitido.' }, 405);
    return puedePedir(usuario) ? pedir(request, env, nueva[1], usuario) : json({ error: 'Tu cuenta no puede pedir cambios de precio.' }, 403);
  }
  if (!esDueno(usuario)) return json({ error: 'Solo el dueño revisa las solicitudes de precio.' }, 403);
  if (url.pathname === '/api/solicitudes-precio') return metodo === 'GET' ? listar(env, url, usuario) : json({ error: 'Método no permitido.' }, 405);
  const una = /^\/api\/solicitudes-precio\/([^/]+)$/.exec(url.pathname);
  if (una) return metodo === 'POST' ? resolver(request, env, una[1], usuario, aplicarPrecio) : json({ error: 'Método no permitido.' }, 405);
  return json({ error: 'Ruta no encontrada.' }, 404);
}
