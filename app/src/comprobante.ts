/**
 * Comprobante de transferencia (#603): en vez de teclear clave, banco y monto, el cajero puede subir la foto o la
 * captura del comprobante. Claude (el mismo binding y secreto del analisis de piezas) lee clave, banco, monto y fecha, la
 * pantalla los pone en sus campos y el cajero confirma o corrige antes de guardar. La imagen queda en R2 bajo
 * comprobantes/, sin ruta publica: solo el dueno la ve (trae nombres y RFC de terceros). Si la lectura falla, se teclea
 * a mano; nada de esto frena un cobro. Ni la imagen ni lo leido van al log.
 */
import { conClaude, base64 } from './analisis.ts';
import { BANCOS, claveRastreoDe, CLAVE_RASTREO } from '../public/venta.js';

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** El cliente la reduce a JPEG de 1600 px; 4 MB sobran. */
const MAX_BYTES = 4 * 1024 * 1024;
const CODIGOS = BANCOS.map(([codigo]) => codigo);

const ESQUEMA = {
  type: 'object', properties: {
    clave_rastreo: { type: 'string' },
    banco_emisor: { type: 'string', enum: [...CODIGOS, ''] },
    monto_mxn: { type: 'number' },
    fecha: { type: 'string' },
  }, required: ['clave_rastreo', 'banco_emisor', 'monto_mxn', 'fecha'], additionalProperties: false,
} as const;

const INSTRUCCION = [
  'Lees el comprobante de una transferencia SPEI en pesos mexicanos (captura de la app de un banco o foto del comprobante).',
  'Devuelve JSON con: clave_rastreo (la clave de rastreo tal cual, sin espacios; NO el numero de referencia ni el folio),',
  'banco_emisor (el banco de DONDE SALE el dinero, uno de estos codigos: ' + BANCOS.map(([c, n]) => `${c} = ${n}`).join('; ') + '; ',
  'cadena vacia si es otro banco o no se distingue), monto_mxn (el importe transferido, numero),',
  'fecha (la fecha que muestra el comprobante, formato AAAA-MM-DD; vacia si no se ve).',
  'Si un dato no se lee con claridad, dejalo vacio (monto 0): uno equivocado es peor que uno vacio, el cajero lo completa.',
  'No devuelvas nombres, cuentas ni RFC.',
].join(' ');

export interface Lectura { clave: string; banco_emisor: string; monto: number; fecha: string }

/** Lo que dijo el modelo, depurado con las mismas reglas que la captura a mano: lo que no pasa se deja vacio. */
export function depurarLectura(cruda: Record<string, unknown>): Lectura {
  const clave = claveRastreoDe(cruda.clave_rastreo);
  const monto = Math.round(Number(cruda.monto_mxn) * 100);
  const fecha = String(cruda.fecha ?? '');
  return {
    clave: CLAVE_RASTREO.test(clave) ? clave : '',
    banco_emisor: CODIGOS.includes(String(cruda.banco_emisor)) ? String(cruda.banco_emisor) : '',
    monto: Number.isSafeInteger(monto) && monto > 0 ? monto : 0,
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(Date.parse(fecha)) ? fecha : '',
  };
}

/** POST /api/transferencias/comprobante (caja, a nombre del cajero del PIN): guarda la imagen y devuelve su lectura. */
export async function subirComprobante(request: Request, env: Env): Promise<Response> {
  if (!/^image\/jpeg\b/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'El comprobante debe ser una imagen JPEG.' }, 415);
  const datos = await request.arrayBuffer();
  if (datos.byteLength === 0 || datos.byteLength > MAX_BYTES) return json({ error: 'La imagen del comprobante es muy grande o está vacía.' }, 413);
  const key = `comprobantes/${crypto.randomUUID()}.jpg`;
  await env.FOTOS.put(key, datos, { httpMetadata: { contentType: 'image/jpeg' } });
  let lectura: Lectura | null = null;
  try {
    if (env.ANTHROPIC_API_KEY) lectura = depurarLectura(await conClaude(base64(datos), env, INSTRUCCION, ESQUEMA, 'Lee este comprobante.') as Record<string, unknown>);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'lectura de comprobante fallida', error: String(error).slice(0, 200) }));
  }
  return json({ key, lectura });
}

/** GET /api/transferencias/:id/comprobante: la foto, solo para el dueno (la ruta es suya en cuentas.ts); nunca en cache. */
export async function verComprobante(env: Env, id: number): Promise<Response> {
  const f = await env.DB.prepare('select comprobante_key from transferencias_spei where id = ?').bind(id).first<{ comprobante_key: string | null }>();
  const objeto = f?.comprobante_key ? await env.FOTOS.get(f.comprobante_key) : null;
  if (!objeto) return json({ error: 'Esta transferencia no tiene comprobante.' }, 404);
  return new Response(objeto.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
}
