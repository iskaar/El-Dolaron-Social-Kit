import { propietarioDe, type Usuario } from './cuentas.ts';
import { normalizarUpc } from './manifiesto.ts';
import { SIN_CODIGO } from '../public/upc.js';
import { ESTADOS } from '../public/estados.js';

interface Solicitud {
  correo: string;
  id: string;
  tipo: 'foto_pieza' | 'pieza_nueva';
  pieza_id: string;
  params: string;
  titulo: string;
  estado: 'pendiente' | 'tomada' | 'lista' | 'cancelada';
  telefono: string;
  motivo: string;
  creado_en: string;
  vence_en: string;
  tomada_en: string;
  lista_en: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAVES = ['estado_fisico', 'cantidad', 'upc', 'talla', 'prenda', 'marca', 'precio_ropa'];
export const CONSULTA_BUZON = 'select * from camara_remota where correo = ?';
const vencida = (s: Solicitud, ahora: string) => ['pendiente', 'tomada'].includes(s.estado) && s.vence_en <= ahora;

function json(cuerpo: object, status = 200): Response {
  return Response.json({ ...cuerpo, ahora: new Date().toISOString() }, {
    status, headers: { 'cache-control': 'no-store' },
  });
}

function respuesta(s: Solicitud | null, status = 200): Response {
  const ahora = new Date().toISOString();
  return json({ solicitud: s && { ...s, params: JSON.parse(s.params), estado: vencida(s, ahora) ? 'vencida' : s.estado } }, status);
}

function paramsValidos(params: Record<string, unknown>): boolean {
  if (Object.keys(params).some((k) => !CLAVES.includes(k))) return false;
  if (params.cantidad !== undefined && (typeof params.cantidad !== 'number' || !Number.isInteger(params.cantidad) || params.cantidad < 1 || params.cantidad > 999)) return false;
  if (params.estado_fisico !== undefined && !ESTADOS.some(([e]) => e === params.estado_fisico)) return false;
  if (params.upc !== undefined && (typeof params.upc !== 'string' || (params.upc !== SIN_CODIGO && !normalizarUpc(params.upc)))) return false;
  if (['talla', 'prenda', 'marca'].some((k) => params[k] !== undefined && (typeof params[k] !== 'string' || (params[k] as string).length > 80))) return false;
  return params.precio_ropa === undefined || (typeof params.precio_ropa === 'number' && Number.isSafeInteger(params.precio_ropa) && params.precio_ropa >= 0);
}

export async function rutaCamaraRemota(request: Request, env: Env, pathname: string, usuario: Usuario): Promise<Response> {
  const correo = usuario.correo;
  const leer = () => env.DB.prepare(CONSULTA_BUZON).bind(correo).first<Solicitud>();
  if (pathname === '/api/camara/solicitud' && request.method === 'GET') return respuesta(await leer());
  const cuerpo = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) return json({ error: 'Datos inválidos.' }, 400);
  const ahora = new Date().toISOString();
  const vence = new Date(Date.parse(ahora) + 120_000).toISOString();
  const propietario = propietarioDe(usuario);

  if (pathname === '/api/camara/solicitud' && request.method === 'PUT') {
    const { id, tipo, pieza_id } = cuerpo;
    const params = cuerpo.params ?? {};
    if (typeof id !== 'string' || !UUID.test(id) || typeof pieza_id !== 'string' || !UUID.test(pieza_id)
        || typeof tipo !== 'string' || !['foto_pieza', 'pieza_nueva'].includes(tipo) || typeof params !== 'object' || Array.isArray(params)
        || !paramsValidos(params as Record<string, unknown>) || (cuerpo.titulo !== undefined && (typeof cuerpo.titulo !== 'string' || cuerpo.titulo.length > 200))) {
      return json({ error: 'Solicitud inválida.' }, 400);
    }
    const previa = await leer();
    if (previa?.id === id) return respuesta(previa);
    let titulo = String(cuerpo.titulo ?? 'Pieza nueva');
    if (tipo === 'foto_pieza') {
      const pieza = await env.DB.prepare(`select nombre, codigo from productos
        where id = ? and propietario = ? and estado_analisis <> 'descartado'`)
        .bind(pieza_id, propietario).first<{ nombre: string; codigo: string | null }>();
      if (!pieza) return json({ error: 'Pieza no encontrada.' }, 404);
      titulo = [pieza.nombre, pieza.codigo].filter(Boolean).join(' · ');
    }
    await env.DB.prepare(`insert into camara_remota (correo, id, tipo, pieza_id, params, titulo, creado_en, vence_en)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (correo) do update set id = excluded.id, tipo = excluded.tipo, pieza_id = excluded.pieza_id,
        params = excluded.params, titulo = excluded.titulo, estado = 'pendiente', telefono = '', motivo = '',
        creado_en = excluded.creado_en, vence_en = excluded.vence_en, tomada_en = '', lista_en = ''
      where camara_remota.id <> excluded.id and (camara_remota.estado <> 'tomada' or camara_remota.vence_en <= ?)`)
      .bind(correo, id, tipo, pieza_id, JSON.stringify(params), titulo, ahora, vence, ahora).run();
    const s = await leer();
    return s?.id === id ? respuesta(s) : json({ error: 'El celular está tomando otra foto. Cancela primero.' }, 409);
  }

  const ruta = /^\/api\/camara\/solicitud\/([^/]+)\/(tomar|lista|cancelar)$/.exec(pathname);
  if (!ruta || request.method !== 'POST') return json({ error: 'Ruta no encontrada.' }, 404);
  const [, id, accion] = ruta;
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  if (accion !== 'cancelar' && (typeof cuerpo.telefono !== 'string' || !UUID.test(cuerpo.telefono))) return json({ error: 'Teléfono inválido.' }, 400);
  if (accion === 'cancelar' && cuerpo.motivo !== undefined && (typeof cuerpo.motivo !== 'string' || cuerpo.motivo.length > 200)) return json({ error: 'Motivo inválido.' }, 400);
  let s = await leer();
  if (!s || s.id !== id) return json({ error: 'Solicitud no encontrada.' }, 404);

  if (accion === 'tomar') {
    // El reintento conserva las horas y el resultado de la primera toma.
    await env.DB.prepare(`update camara_remota set estado = 'tomada', telefono = ?, tomada_en = ?, vence_en = ?
      where correo = ? and id = ? and estado = 'pendiente' and vence_en > ?`)
      .bind(cuerpo.telefono, ahora, vence, correo, id, ahora).run();
    s = await leer();
    if (!s || s.id !== id) return json({ error: 'Solicitud no encontrada.' }, 404);
    if (vencida(s, ahora)) return json({ error: 'Venció.' }, 410);
    if (s.estado !== 'tomada' || s.telefono !== cuerpo.telefono) return json({ error: s.estado === 'cancelada' ? 'La PC la canceló.' : 'Otro celular la tomó.' }, 409);
  } else if (accion === 'lista') {
    if (s.telefono !== cuerpo.telefono || !['tomada', 'lista'].includes(s.estado)) return json({ error: 'La solicitud no está tomada por este celular.' }, 409);
    if (s.estado === 'lista') return respuesta(s);
    const pieza = await env.DB.prepare(`select id from productos where id = ? and propietario = ? and estado_analisis <> 'descartado'`)
      .bind(s.pieza_id, propietario).first();
    if (!pieza && s.tipo === 'foto_pieza') {
      await env.DB.prepare(`update camara_remota set estado = 'cancelada', motivo = 'La pieza ya no está disponible.'
        where correo = ? and id = ? and estado = 'tomada' and telefono = ?`).bind(correo, id, cuerpo.telefono).run();
      return json({ error: 'La pieza ya no está disponible.' }, 409);
    }
    // Comprobar el efecto dentro del UPDATE evita cerrar una pieza descartada entre lectura y escritura.
    await env.DB.prepare(`update camara_remota set estado = 'lista', lista_en = ?
      where correo = ? and id = ? and estado = 'tomada' and telefono = ?
      and exists (select 1 from productos where id = camara_remota.pieza_id and propietario = ?
        and estado_analisis <> 'descartado' and foto_key <> ''
        and ((camara_remota.tipo = 'foto_pieza' and actualizado_en >= camara_remota.tomada_en)
          or (camara_remota.tipo = 'pieza_nueva' and capturado_por = ?)))`)
      .bind(ahora, correo, id, cuerpo.telefono, propietario, correo).run();
    s = await leer();
    if (!s || s.id !== id || s.estado !== 'lista') return json({ error: 'La foto no llegó.' }, 409);
  } else {
    await env.DB.prepare(`update camara_remota set estado = 'cancelada', motivo = ?
      where correo = ? and id = ? and estado in ('pendiente', 'tomada')`)
      .bind(cuerpo.motivo ?? '', correo, id).run();
    s = await leer();
    if (!s || s.id !== id) return json({ error: 'Solicitud no encontrada.' }, 404);
  }
  return respuesta(s);
}
