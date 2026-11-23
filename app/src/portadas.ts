/**
 * Portadas con IA (#888, parte de #886 «Publicar solo», Proyecto 1): para cada pieza vendible con foto de anaquel, el cron genera una
 * portada de estudio (fondo blanco, 1200x1200), comprueba que es la misma pieza y la deja aprobada, en revisión o por retomar.
 * Diseño: docs/PLAN-PUBLICAR-SOLO.md. Apagado por omisión (config `portadas_activo`); perillas y SQL en migracion-087-portadas.sql.
 *
 * Solo una portada aprobada llega a R2 `extras/{id}/01.jpg`: `publicar` sube todo `extras/` sin leer estados. Lo demás vive en
 * `portadas/{id}.cruda` (lo que devolvió el modelo, ya pagado) y `portadas/{id}.jpg` (normalizada, en espera).
 * Nunca toca foto_key, precio, stock, estado_analisis, nombre ni marca.
 * `oficial` = imagen de Target ya confirmada (recorte_estado 'original' Y referencia confirmada en imagenes_upc para su UPC): no pasa por IA.
 * Un 'original' sin referencia (p. ej. el botón «original» de /admin sobre una foto de anaquel) se genera como cualquier otra.
 */
import { VENDIBLE } from './catalogo.ts';
import { base64, conClaude, consultarGemini, consultarInteraccion, sinLlave } from './analisis.ts';
import { hoyTienda } from './reportes.ts';

export interface Generada { bytes: ArrayBuffer; tipo: string; tokens: { entrada: number; salida: number } }
/** Modelo y tamaño con que se genera esta corrida (#906): salen de `transporteImagen`, ya validados. */
export interface OpcionesImagen { modelo: string; tamano: string }
export interface Veredicto { ok: boolean; problemas: string[]; foto_mala: boolean }
export interface Dependencias {
  generar(env: Env, foto: ArrayBuffer, problemas: string[], opciones?: OpcionesImagen): Promise<Generada>;
  comprobar(env: Env, original: ArrayBuffer, portada: ArrayBuffer): Promise<Veredicto>;
}
/** El modelo contestó, pero sin imagen (filtros de seguridad, o solo texto): la pieza pasa a `error` con el motivo. */
export class SinImagen extends Error {}

// Vertex, GA, endpoint global (docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-image, 22/11/2026).
// Falta probarlo con VERTEX_API_KEY real: el piloto en sandbox (#889) lo confirma; si no la acepta, cambiar solo esta constante.
export const MODELO_IMAGEN = 'gemini-3.1-flash-image';
// AI Studio (#900): lista de modelos de la API de Gemini (aistudio.google.com/docs/models, 23/11/2026): «Stable», «generación y edición de imágenes».
export const MODELO_IMAGEN_AI_STUDIO = 'gemini-3.1-flash-image';
// #906: los únicos modelos que `portadas_modelo` acepta en AI Studio y la forma de petición de cada uno. `gemini-nano-banana-2.1` solo documenta la
// API Interactions (aistudio.google.com/docs/image-generation, 22/11/2026); si resulta que también acepta generateContent, cambiar solo su valor aquí.
// ponytail: lista fija de dos; un tercer modelo = una línea aquí y su forma de petición en `generarConGemini`, sin capa de proveedores.
const MODELOS_AI_STUDIO = { [MODELO_IMAGEN_AI_STUDIO]: 'generateContent', 'gemini-nano-banana-2.1': 'interactions' } as const;
const TAMANOS = ['1K', '2K'];   // mayúscula obligatoria: la API rechaza «2k»
const conAiStudio = (env: Env) => Boolean(env.GEMINI_API_KEY || env.GEMINI2_API_KEY);
/**
 * Con una llave de AI Studio las portadas van por ahí (aunque haya VERTEX_API_KEY); sin ella, Vertex como antes.
 * #906: en AI Studio `portadas_modelo` y `portadas_tamano` eligen modelo y tamaño; ausentes valen lo de siempre (modelo de arriba, 1K). Un valor
 * fuera de la lista cae a lo de siempre y deja un aviso en `avisos`. Con Vertex las dos filas no cuentan: sigue igual que antes.
 */
const transporteImagen = (env: Env, config: Map<string, string> = new Map()) => {
  const aiStudio = conAiStudio(env);
  const avisos: string[] = [];
  let modelo = aiStudio ? MODELO_IMAGEN_AI_STUDIO : MODELO_IMAGEN, tamano = '1K';
  if (aiStudio) {
    const pedido = config.get('portadas_modelo'), tamanoPedido = config.get('portadas_tamano');
    if (pedido !== undefined) {
      if (Object.hasOwn(MODELOS_AI_STUDIO, pedido)) modelo = pedido;
      else avisos.push(`Config: portadas_modelo «${pedido.slice(0, 60)}» no es un modelo permitido (${Object.keys(MODELOS_AI_STUDIO).join(', ')}); se usa ${modelo}.`);
    }
    if (tamanoPedido !== undefined) {
      if (TAMANOS.includes(tamanoPedido)) tamano = tamanoPedido;
      else avisos.push(`Config: portadas_tamano «${tamanoPedido.slice(0, 60)}» no es un tamaño permitido (${TAMANOS.join(' o ')}); se usa ${tamano}.`);
    }
  }
  return { aiStudio, modelo, tamano, avisos };
};
// La llave viaja en la URL (`?key=`): nada que se guarde o se registre puede conservarla.
const LADO = 1200;
// ponytail: lote fijo de 3 generaciones por corrida de 15 min (≈ 300 al día como techo, el tope diario manda). Subirlo si el piloto mide holgura.
const LOTE = 3;
// Se leen más candidatas que el lote: marcar `manual` no cuesta nada y no debe gastar un lugar del lote.
const CANDIDATAS = 15;
const TOPE_POR_OMISION = 100;
const LIMITE_GENERAR_MS = 90_000;
const ahora = () => new Date().toISOString();
const llaveCruda = (id: string) => `portadas/${id}.cruda`;
const llaveEspera = (id: string) => `portadas/${id}.jpg`;
const llavePublicada = (id: string) => `extras/${id}/01.jpg`;

const INSTRUCCION_GENERAR = 'This is an edit of the attached product photo, not a new image: keep the product exactly as photographed, with the same framing of the item (same view, angle and crop), the same arrangement of its parts, and the same lettering, logos, barcode, numbers, colors, pattern, proportions and shape. Change only the background and the lighting: pure white (#FFFFFF) seamless background, square 1:1 composition, product centered and filling about 85% of the frame, soft natural shadow underneath, even lighting, sharp focus. Never add, complete, translate or guess any text, number or barcode that is not legible in the original, and never redraw or rearrange any part; if something is hidden, cut off or blurry, leave it as it appears. Remove nothing that belongs to the product (the manufacturer\'s own labels, hang tags and accessories stay), and remove everything that is not the product: hands, hooks, hangers, shelves, neighboring items, and any price tag or sticker added by the store. Return only the image.';

/** Generador real: Gemini imagen-a-imagen por AI Studio (con GEMINI_API_KEY) o por Vertex. Pide el cuadrado ya hecho para depender lo menos posible de IMAGES. */
export async function generarConGemini(env: Env, foto: ArrayBuffer, problemas: string[], opciones: OpcionesImagen = transporteImagen(env)): Promise<Generada> {
  const texto = problemas.length
    ? `${INSTRUCCION_GENERAR}\nA previous attempt had these problems, avoid them: ${problemas.join('; ')}.`
    : INSTRUCCION_GENERAR;
  const aiStudio = conAiStudio(env);
  const { modelo, tamano } = opciones;
  if (!aiStudio && !env.VERTEX_API_KEY) throw new Error('Falta GEMINI_API_KEY (AI Studio) o VERTEX_API_KEY para generar portadas.');
  const imagenEntrada = base64(foto);
  let imagen: { data?: string; mime?: string }, sinImagen = '', tokens = { entrada: 0, salida: 0 };
  if (aiStudio && MODELOS_AI_STUDIO[modelo as keyof typeof MODELOS_AI_STUDIO] === 'interactions') {
    // API Interactions (aistudio.google.com/docs/image-generation, 22/11/2026): `response_format` con `image_size` en mayúscula; la imagen
    // llega en el último bloque `image` de un paso `model_output` (los pasos `thought` traen imágenes de prueba que no son la final).
    // Tokens: usage.total_input_tokens / total_output_tokens (los de pensamiento, `total_thought_tokens`, van aparte y no se cuentan, como hoy).
    const r = await consultarInteraccion(env, {
      model: modelo,
      input: [{ type: 'text', text: texto }, { type: 'image', mime_type: 'image/jpeg', data: imagenEntrada }],
      response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: tamano },
    }, LIMITE_GENERAR_MS);
    const bloques = (r.steps ?? []).filter((p) => p.type === 'model_output').flatMap((p) => p.content ?? []);
    const ultima = bloques.filter((c) => c.type === 'image' && c.data).pop();
    imagen = { data: ultima?.data, mime: ultima?.mime_type };
    sinImagen = bloques.map((c) => c.text ?? '').join(' ').trim() || (r.status && r.status !== 'completed' ? `estado ${r.status}` : '');
    tokens = { entrada: r.usage?.total_input_tokens ?? 0, salida: r.usage?.total_output_tokens ?? 0 };
  } else {
    const r = await consultarGemini(env, {
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/jpeg', data: imagenEntrada } }, { text: texto }] }],
      // ponytail: `imageConfig` en generationConfig es lo que muestra la guía de Vertex hoy; el esquema REST lo marca deprecado a favor de
      // `responseFormat`. Si el piloto lo rechaza, cambiar solo este objeto. La referencia generateContent de AI Studio (23/11/2026) lo acepta
      // igual (aspectRatio '1:1', imageSize '1K' o '2K'; con Vertex siempre '1K').
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: tamano } },
    }, LIMITE_GENERAR_MS, modelo, aiStudio);
    const partes = r.candidates?.[0]?.content?.parts ?? [];
    const parte = partes.find((p) => p.inlineData?.data);
    imagen = { data: parte?.inlineData?.data, mime: parte?.inlineData?.mimeType };
    sinImagen = partes.map((p) => p.text ?? '').join(' ').trim();
    tokens = { entrada: r.usageMetadata?.promptTokenCount ?? 0, salida: r.usageMetadata?.candidatesTokenCount ?? 0 };
  }
  if (!imagen.data) throw new SinImagen(`El modelo respondió sin imagen: ${sinImagen.slice(0, 200) || 'respuesta vacía'}`);
  const bytes = Uint8Array.from(atob(imagen.data), (c) => c.charCodeAt(0));
  return { bytes: bytes.buffer, tipo: imagen.mime || 'image/png', tokens };
}

const ESQUEMA_COMPROBAR = { type: 'object', properties: {
  ok: { type: 'boolean' }, problemas: { type: 'array', items: { type: 'string' } }, foto_mala: { type: 'boolean' },
}, required: ['ok', 'problemas', 'foto_mala'], additionalProperties: false };
// Se afina en el piloto (#889).
const INSTRUCCION_COMPROBAR = 'Eres revisor de fidelidad de fotos de producto para una tienda. Recibes dos imágenes: la foto original del anaquel y una portada de estudio generada por IA a partir de ella. Compáralas a detalle, leyendo las letras. ok es true solo si la portada es EXACTAMENTE la misma pieza: mismo texto legible, logos, colores, estampados, proporciones y forma, sin partes inventadas, repetidas, borradas ni deformadas; con fondo blanco y sin manos, ganchos ni etiquetas de precio de la tienda. Ante la duda, ok es false. problemas: frases cortas en español de cada diferencia o defecto. foto_mala es true solo si el defecto viene de la foto original y ninguna portada fiel sería posible: pieza tapada o cortada, etiqueta de precio pegada sobre el producto, foto de otro artículo o demasiado borrosa para leerla; en ese caso ok es false.';

/** Comprobador real: Claude con las dos imágenes a resolución completa (aquí hay que leer letras). `llamar` se inyecta solo en pruebas. */
export async function comprobarConClaude(env: Env, original: ArrayBuffer, portada: ArrayBuffer, llamar: typeof conClaude = conClaude): Promise<Veredicto> {
  const r = await llamar([base64(original), base64(portada)], env, INSTRUCCION_COMPROBAR, ESQUEMA_COMPROBAR,
    'Primera imagen: foto original. Segunda imagen: portada generada. Compáralas.') as Partial<Veredicto>;
  const foto_mala = r.foto_mala === true;
  return { ok: r.ok === true && !foto_mala, problemas: (Array.isArray(r.problemas) ? r.problemas : []).map(String), foto_mala };
}

const real: Dependencias = { generar: generarConGemini, comprobar: comprobarConClaude };

/** Normaliza lo que devolvió el modelo (PNG o cualquier tamaño) a JPEG 1200×1200 con IMAGES. Puede fallar con la cuota (9422). */
async function normalizar(env: Env, cruda: ArrayBuffer): Promise<ArrayBuffer> {
  const salida = await (env.IMAGES as any).input(new Response(cruda).body).transform({ width: LADO, height: LADO, fit: 'pad', background: '#FFFFFF' })
    .output({ format: 'image/jpeg', quality: 90 });
  const cuerpo = salida instanceof Response ? salida.body : salida.response().body;
  if (!cuerpo) throw new Error('Portada vacía.');
  return new Response(cuerpo).arrayBuffer();
}

/** Estado HTTP del error: el de Anthropic (`status`) o el de consultarGemini («Gemini 429: …»). 0 = red, plazo o error nuestro. */
const estadoDe = (e: unknown) => Number((e as { status?: number })?.status ?? /^Error: Gemini (\d{3})/.exec(String(e))?.[1] ?? 0);
/** 401/403: la cuenta o la llave del proveedor (p. ej. «requires billing to be enabled», #898), nunca la pieza. */
const credencial = (e: unknown) => [401, 403].includes(estadoDe(e));
/** Cuota de IMAGES, 401/403, 429, 5xx, red o plazo: no es culpa de la pieza; se sale sin marcar y la siguiente corrida retoma. */
const pasajero = (e: unknown) => !(e instanceof SinImagen) && (/9422/.test(String(e)) || credencial(e) || estadoDe(e) === 429 || estadoDe(e) >= 500 || estadoDe(e) === 0);

/**
 * Deja en `config` el último motivo por el que el proveedor detuvo la corrida (#898): el log no lo leen los agentes. Una sola fila,
 * sobrescrita. Nunca lanza. El mensaje sale del cuerpo de la respuesta o del error, no de la petición; aun así se quita todo `key=…`
 * porque la llave de Vertex y la de AI Studio viajan en la URL.
 */
async function avisarProveedor(env: Env, id: string | null, error: unknown): Promise<void> {
  try {
    const mensaje = sinLlave(error instanceof Error ? error.message : String(error)).slice(0, 300);
    await env.DB.prepare("insert into config (clave, valor) values ('portadas_ultimo_aviso', ?) on conflict (clave) do update set valor = excluded.valor")
      .bind(JSON.stringify({ en: ahora(), id, status: estadoDe(error) || null, mensaje })).run();
  } catch (e) { console.error(JSON.stringify({ mensaje: 'portadas: no se pudo guardar el último aviso', error: String(e).slice(0, 200) })); }
}

/** Gasta una generación del día en D1 (atómico, como gastarConsultaUpcitemdb); false si el tope se agotó. */
async function gastarGeneracion(env: Env, tope: number): Promise<boolean> {
  if (tope <= 0) return false;
  const clave = `portadas_generadas_${hoyTienda()}`;
  const { meta } = await env.DB.prepare(`insert into config (clave, valor) values (?, '1')
    on conflict (clave) do update set valor = cast(cast(valor as integer) + 1 as text) where cast(valor as integer) < ?`).bind(clave, tope).run();
  if (!meta.changes) return false;
  await env.DB.prepare("delete from config where clave like 'portadas_generadas_%' and clave < ?").bind(clave).run();
  return true;
}

/** Devuelve un lugar del tope: una sola sentencia, así que dos corridas a la vez no se pisan. */
// ponytail: usa el día de ahora; si la llamada cruzó la medianoche de la tienda (límite 90 s) el lugar vuelve al día nuevo.
async function devolverGeneracion(env: Env): Promise<void> {
  await env.DB.prepare("update config set valor = cast(cast(valor as integer) - 1 as text) where clave = ? and cast(valor as integer) > 0")
    .bind(`portadas_generadas_${hoyTienda()}`).run();
}

async function borrarEspera(env: Env, id: string): Promise<void> {
  await env.FOTOS.delete(llaveEspera(id));
  await env.FOTOS.delete(llaveCruda(id));
}

async function existe(env: Env, llave: string): Promise<boolean> {
  const objeto = await env.FOTOS.get(llave);
  await objeto?.body.cancel();
  return objeto !== null;
}

/** Marca el resultado solo si la pieza sigue pendiente y no la descartaron mientras tanto. */
async function marcar(env: Env, id: string, estado: string, revision: object | null, origen: string | null = null): Promise<boolean> {
  const { meta } = await env.DB.prepare(`update productos set portada_estado = ?, portada_origen = ?, portada_fecha = ?, portada_revision = ?
    where id = ? and portada_estado is null and estado_analisis <> 'descartado'`)
    .bind(estado, origen, ahora(), revision && JSON.stringify(revision), id).run();
  return meta.changes > 0;
}

/**
 * Pasa `portadas/{id}.jpg` a `extras/{id}/01.jpg` y marca `lista` (origen `ia`, salvo que ya fuera `manual`: una portada a mano rechazada y
 * vuelta a aprobar sigue siendo a mano y una foto nueva nunca la borra). `desde` es el estado que debe tener la pieza: null desde el cron,
 * 'revisar' desde una aprobación; `fecha`, si viene, la portada que la persona vio (#890). R2 primero con put condicional (no pisa una
 * publicada) y después D1; si D1 ya no la acepta se quita lo que se acaba de poner.
 */
async function promover(env: Env, id: string, desde: 'revisar' | null, revision?: object, fecha?: string | null): Promise<boolean> {
  const espera = await env.FOTOS.get(llaveEspera(id));
  if (!espera) return false;
  const puesta = await env.FOTOS.put(llavePublicada(id), await espera.arrayBuffer(), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: espera.httpMetadata?.contentType || 'image/jpeg' } });
  if (!puesta) return false;
  const { meta } = await env.DB.prepare(`update productos set portada_estado = 'lista', portada_origen = coalesce(portada_origen, 'ia'), portada_fecha = ?, portada_revision = coalesce(?, portada_revision)
    where id = ? and portada_estado is ? and (? = 0 or portada_fecha is ?) and estado_analisis <> 'descartado'`)
    .bind(ahora(), revision ? JSON.stringify(revision) : null, id, desde, fecha === undefined ? 0 : 1, fecha ?? null).run();
  if (!meta.changes) { await env.FOTOS.delete(llavePublicada(id)); return false; }
  await borrarEspera(env, id);
  return true;
}

/**
 * Aprobar desde /admin (#890): pasa la portada en espera a `extras/` y marca `lista`. `fecha` = la portada que la persona vio.
 * false si no había portada en espera o ya hay una publicada. Una portada a mano que sigue publicada tras una foto nueva
 * (`reiniciarPortada` la deja en `revisar` con su `extras/`) no tiene nada que mover: aprobarla solo confirma que sigue valiendo.
 */
export async function publicarPortada(env: Env, id: string, fecha?: string | null): Promise<boolean> {
  if (await promover(env, id, 'revisar', undefined, fecha)) return true;
  const publicada = await env.FOTOS.get(llavePublicada(id));
  if (!publicada) return false;
  await publicada.body.cancel();
  const { meta } = await env.DB.prepare(`update productos set portada_estado = 'lista', portada_fecha = ?
    where id = ? and portada_estado = 'revisar' and portada_origen = 'manual' and (? = 0 or portada_fecha is ?) and estado_analisis <> 'descartado'`)
    .bind(ahora(), id, fecha === undefined ? 0 : 1, fecha ?? null).run();
  if (!meta.changes) return false;
  await borrarEspera(env, id);   // una copia en espera de lo que ya está publicado sobra
  return true;
}

/**
 * Foto nueva: origen `ia` → borra portada y espera, estado null. Origen `manual` → conserva `extras/` y pasa a `revisar`.
 * Nunca lanza: se espera en la captura y esta tubería no puede detenerla (columnas de la 087 aún sin migrar, R2 caído). Si falla se
 * registra y la portada vieja queda hasta que el cron o una persona la revise; la comparación de etag descarta lo que esté en vuelo.
 */
export async function reiniciarPortada(env: Env, id: string): Promise<void> {
  try {
    await reiniciar(env, id);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'reiniciarPortada fallido', id, error: String(error).slice(0, 200) }));
  }
}

async function reiniciar(env: Env, id: string): Promise<void> {
  const pieza = await env.DB.prepare('select portada_origen from productos where id = ?').bind(id).first<{ portada_origen: string | null }>();
  if (pieza?.portada_origen === 'manual') {
    // Una portada a mano rechazada en /admin (#890) vive solo en espera: no se borra. Con `extras/` presente la copia en espera sobra.
    if (await existe(env, llavePublicada(id))) await borrarEspera(env, id);
    await env.DB.prepare("update productos set portada_estado = 'revisar', portada_fecha = ?, portada_revision = ? where id = ? and portada_origen = 'manual'")
      .bind(ahora(), JSON.stringify({ ok: false, problemas: ['Llegó una foto nueva: revisa que la portada siga siendo la misma pieza.'], intentos: 0 }), id).run();
    return;
  }
  await borrarEspera(env, id);
  if (pieza?.portada_origen === 'ia') await env.FOTOS.delete(llavePublicada(id));
  await env.DB.prepare('update productos set portada_estado = null, portada_origen = null, portada_fecha = null, portada_revision = null where id = ?').bind(id).run();
}

/** La imagen que /admin muestra (#890): la que espera aprobación (o, si no hay, la publicada a mano que sigue en `extras/`), o la ya publicada. */
export async function imagenDePortada(env: Env, id: string, estado: string | null) {
  if (estado === 'lista') return env.FOTOS.get(llavePublicada(id));
  if (estado !== 'revisar') return null;
  return (await env.FOTOS.get(llaveEspera(id))) ?? env.FOTOS.get(llavePublicada(id));
}

export type AccionPortada = 'aprobar' | 'rechazar' | 'retomar' | 'generar';
/** inexistente = 404; cambio = la pieza ya no está como la pantalla la mostró (409); manual = «Generar otra» sobre una portada a mano (409). */
export type ResultadoPortada = 'ok' | 'inexistente' | 'cambio' | 'manual';
const DESDE: Record<AccionPortada, string[]> = {
  aprobar: ['revisar'], rechazar: ['lista'], retomar: ['revisar', 'lista'], generar: ['revisar', 'retomar', 'lista', 'oficial'],
};
const REVISION_HUMANA = (problema: string) => JSON.stringify({ ok: false, problemas: [problema], intentos: 0 });

/** Saca la portada de `extras/`. A mano: se conserva en espera, nunca se borra. IA: se borra con lo demás. Sin origen `extras/` no es nuestro. */
async function retirar(env: Env, id: string, origen: string | null): Promise<void> {
  if (origen === 'manual') { await moverAEspera(env, id); return; }
  if (origen === 'ia') await env.FOTOS.delete(llavePublicada(id));
  await borrarEspera(env, id);
}

/** `extras/{id}/01.jpg` → `portadas/{id}.jpg`, copiando antes de borrar. true si queda una imagen en espera. */
async function moverAEspera(env: Env, id: string): Promise<boolean> {
  const publicada = await env.FOTOS.get(llavePublicada(id));
  if (!publicada) return existe(env, llaveEspera(id));
  await env.FOTOS.put(llaveEspera(id), await publicada.arrayBuffer(), { httpMetadata: { contentType: publicada.httpMetadata?.contentType || 'image/jpeg' } });
  await env.FOTOS.delete(llavePublicada(id));
  return true;
}

/**
 * Revisión humana en /admin (#890). `visto` es el estado y la `portada_fecha` que la pantalla mostró: si ya no coinciden (otra persona, el cron)
 * no se hace nada, así nadie aprueba una portada que no vio ni aplica dos veces lo mismo.
 * - aprobar: `publicarPortada`. - rechazar: la portada publicada sale de `extras/` y vuelve a `revisar`.
 * - retomar: estado `retomar` con motivo; la portada de IA se borra, la hecha a mano se guarda en espera; `foto_key` no se toca.
 * - generar: la pieza vuelve a la cola del cron (estado null; el tope diario y las comprobaciones aplican, aquí no se llama al modelo).
 *   Una portada a mano no se reemplaza. La marca en `portada_revision` evita que la pasada de «oficial» la recoja otra vez.
 * Lo que sale de `extras/` se quita ANTES de tocar D1: si D1 pierde la carrera la pieza queda sin portada publicada, nunca con una sin aprobar.
 */
export async function resolverPortada(env: Env, id: string, accion: AccionPortada, visto: { estado: string; fecha: string | null }): Promise<ResultadoPortada> {
  const pieza = await env.DB.prepare("select portada_estado, portada_origen, portada_fecha from productos where id = ? and propietario = 'dolaron' and estado_analisis <> 'descartado'")
    .bind(id).first<{ portada_estado: string | null; portada_origen: string | null; portada_fecha: string | null }>();
  if (!pieza) return 'inexistente';
  if (!DESDE[accion].includes(visto.estado) || pieza.portada_estado !== visto.estado || pieza.portada_fecha !== visto.fecha) return 'cambio';
  if (accion === 'aprobar') return await publicarPortada(env, id, visto.fecha) ? 'ok' : 'cambio';
  if (accion === 'generar' && pieza.portada_origen === 'manual') return 'manual';
  let cambios: string, valores: (string | null)[];
  if (accion === 'rechazar') {
    if (!await moverAEspera(env, id)) return 'cambio';
    cambios = "portada_estado = 'revisar', portada_revision = ?"; valores = [REVISION_HUMANA('Una persona rechazó la portada.')];
  } else if (accion === 'retomar') {
    await retirar(env, id, pieza.portada_origen);
    cambios = "portada_estado = 'retomar', portada_origen = case when portada_origen = 'manual' then 'manual' end, portada_revision = ?";
    valores = [REVISION_HUMANA('Una persona pidió retomar la foto.')];
  } else {
    // Una «oficial» no tiene portada que borrar: lo que haya en `extras/` puede ser de #628 y el cron lo recogerá como manual.
    if (visto.estado !== 'oficial') await retirar(env, id, pieza.portada_origen);
    cambios = 'portada_estado = null, portada_origen = null, portada_revision = ?'; valores = [REVISION_HUMANA('Una persona pidió otra portada.')];
  }
  const { meta } = await env.DB.prepare(`update productos set ${cambios}, portada_fecha = ? where id = ? and portada_estado = ? and portada_fecha is ? and estado_analisis <> 'descartado'`)
    .bind(...valores, ahora(), id, visto.estado, visto.fecha).run();
  return meta.changes ? 'ok' : 'cambio';
}

interface Pieza { id: string; foto_key: string }
/** Lo que costó y tardó esta corrida con la pieza (#895): va en `portada_revision` para medir el costo real desde D1. */
interface Medidas { tokens: { entrada: number; salida: number }; ms_generar: number; ms_comprobar: number; modelo: string; tamano: string }
const medidasNuevas = ({ modelo, tamano }: OpcionesImagen): Medidas => ({ tokens: { entrada: 0, salida: 0 }, ms_generar: 0, ms_comprobar: 0, modelo, tamano });

/** Una pieza de principio a fin. 'alto' = no seguir con las demás (tope agotado o proveedor caído). */
async function trabajar(env: Env, deps: Dependencias, pieza: Pieza, tope: number, conAprobacion: boolean, medidas: Medidas): Promise<'seguir' | 'alto'> {
  const { id } = pieza;
  const foto = await env.FOTOS.get(pieza.foto_key);
  if (!foto) { await marcar(env, id, 'error', { ok: false, problemas: ['Foto no encontrada en R2.'], intentos: 0 }); return 'seguir'; }
  const etag = foto.etag;
  const original = await foto.arrayBuffer();
  let veredicto: Veredicto = { ok: false, problemas: [], foto_mala: false };
  let portada: ArrayBuffer | null = null;
  let intentos = 0;
  for (let intento = 1; intento <= 2; intento++) {
    // Reanuda lo ya pagado (cuota de IMAGES, fallo de la comprobación), pero solo si es de esta misma foto.
    const guardada = intento === 1 ? await env.FOTOS.get(llaveCruda(id)) : null;
    let cruda = guardada?.customMetadata?.foto_etag === etag ? await guardada.arrayBuffer() : null;
    if (!cruda) {
      if (!await gastarGeneracion(env, tope)) { if (intento === 1) return 'alto'; break; }
      const inicio = Date.now();
      // Un 401/403 no generó nada: el lugar del tope se devuelve (el resto de errores pasajeros conserva el comportamiento de siempre).
      const generada = await deps.generar(env, original, veredicto.problemas, { modelo: medidas.modelo, tamano: medidas.tamano }).catch(async (e) => { if (credencial(e)) await devolverGeneracion(env).catch(() => {}); throw e; });
      medidas.ms_generar += Date.now() - inicio;
      medidas.tokens.entrada += generada.tokens.entrada; medidas.tokens.salida += generada.tokens.salida;
      console.log(JSON.stringify({ mensaje: 'portada generada', id, modelo: medidas.modelo, tamano: medidas.tamano, intento, tokens_entrada: generada.tokens.entrada, tokens_salida: generada.tokens.salida, ms: Date.now() - inicio }));
      // Antes de cualquier otra cosa: una imagen pagada no se pierde por un fallo posterior.
      await env.FOTOS.put(llaveCruda(id), generada.bytes, { httpMetadata: { contentType: generada.tipo }, customMetadata: { foto_etag: etag } });
      cruda = generada.bytes;
    }
    intentos = intento;
    portada = await normalizar(env, cruda);
    const inicio = Date.now();
    veredicto = await deps.comprobar(env, original, portada);
    medidas.ms_comprobar += Date.now() - inicio;
    console.log(JSON.stringify({ mensaje: 'portada comprobada', id, ok: veredicto.ok, foto_mala: veredicto.foto_mala, problemas: veredicto.problemas, ms: Date.now() - inicio }));
    if (veredicto.ok || veredicto.foto_mala) break;
  }
  // La foto se retomó mientras se generaba (misma llave): el resultado es de la foto vieja.
  const actual = await env.FOTOS.get(pieza.foto_key);
  await actual?.body.cancel();
  if (actual?.etag !== etag) { await borrarEspera(env, id); return 'seguir'; }

  const revision = { ok: veredicto.ok, problemas: veredicto.problemas, intentos, ...medidas };
  if (veredicto.foto_mala) await marcar(env, id, 'retomar', revision);
  else {
    await env.FOTOS.put(llaveEspera(id), portada!, { httpMetadata: { contentType: 'image/jpeg' } });
    if (veredicto.ok && !conAprobacion) { if (await promover(env, id, null, revision)) return 'seguir'; }
    else if (await marcar(env, id, 'revisar', revision)) { await env.FOTOS.delete(llaveCruda(id)); return 'seguir'; }
  }
  await borrarEspera(env, id);
  return 'seguir';
}

export async function procesarPortadas(env: Env, deps: Dependencias = real): Promise<void> {
  const claves = new Map((await env.DB.prepare("select clave, valor from config where clave in ('portadas_activo','portadas_aprobacion','portadas_tope_diario','portadas_modelo','portadas_tamano')")
    .all<{ clave: string; valor: string }>()).results.map((f) => [f.clave, f.valor]));
  if (claves.get('portadas_activo') !== '1') return;
  const topeConfig = claves.get('portadas_tope_diario');
  const tope = topeConfig !== undefined && /^\d+$/.test(topeConfig) ? Number(topeConfig) : TOPE_POR_OMISION;
  const conAprobacion = claves.get('portadas_aprobacion') !== '0';
  const imagen = transporteImagen(env, claves);
  // ponytail: un solo aviso por corrida, y lo sobrescribe el del proveedor si falla algo después; si los dos hacen falta a la vez, filas separadas.
  for (const aviso of imagen.avisos) await avisarProveedor(env, null, new Error(aviso));
  // La imagen oficial de Target ya es de estudio: no pasa por IA ni gasta nada. Si una persona pidió generarla igual desde /admin (#890,
  // la marca de «oficial» puede estar mal) la pieza trae `portada_revision`, y esta pasada no la vuelve a marcar. `original` solo no basta (el botón «original» de /admin
  // también lo pone sobre una foto de anaquel): hace falta una referencia confirmada para el UPC de la pieza, unida igual que
  // guardarImagenComoFoto (imagenes_upc con su manifiesto, confirmado_en <> '') y con la misma clave sin ceros (`ltrim(upc, '0')`).
  // ponytail: sin forzar el índice, SQLite recorre todo lo de la tienda (productos_propietario_precio); con él, solo las pendientes de la cola
  // (~2,000 filas con `recorte_estado` leído de la tabla) y la referencia por llave primaria. Las `original` sin referencia (hoy ~10) se
  // reevalúan cada corrida hasta que se generan. Si pesa, sumar `recorte_estado` a un índice parcial propio.
  await env.DB.prepare(`update productos as p indexed by productos_portadas_pendientes set portada_estado = 'oficial', portada_fecha = ? where p.portada_estado is null and p.portada_revision is null and p.recorte_estado = 'original'
    and exists (select 1 from imagenes_upc i join manifiesto m on m.upc = i.upc and m.tcin = i.tcin where i.upc = ltrim(p.upc, '0') and i.confirmado_en <> '')
    and ${VENDIBLE}`).bind(ahora()).run();
  // ponytail: una pieza que falla siempre por un motivo transitorio (plazo, 5xx) encabeza la cola y frena a las demás; los 4xx y las
  // respuestas sin imagen sí la marcan `error`. Si el piloto lo muestra, contar fallos por pieza.
  const { results } = await env.DB.prepare(`select p.id, p.foto_key from productos p indexed by productos_portadas_pendientes
    where p.portada_estado is null and ${VENDIBLE} order by p.precio desc limit ${CANDIDATAS}`).all<Pieza>();
  let hechas = 0;
  for (const pieza of results) {
    if (hechas >= LOTE) return;
    const medidas = medidasNuevas(imagen);
    try {
      // Ya hay portada hecha a mano (#628): se respeta tal cual, sin gastar.
      const manual = await env.FOTOS.get(llavePublicada(pieza.id));
      if (manual) {
        await manual.body.cancel();
        if (await marcar(env, pieza.id, 'lista', null, 'manual')) await borrarEspera(env, pieza.id);
        continue;
      }
      hechas++;
      if (await trabajar(env, deps, pieza, tope, conAprobacion, medidas) === 'alto') return;
    } catch (error) {
      if (pasajero(error)) {
        console.error(JSON.stringify({ mensaje: 'portada pendiente', id: pieza.id, error: sinLlave(String(error)).slice(0, 200) }));
        await avisarProveedor(env, pieza.id, error);
        return;
      }
      const motivo = sinLlave(error instanceof Error ? error.message : String(error));
      await marcar(env, pieza.id, 'error', { ok: false, problemas: [motivo.slice(0, 200)], intentos: 0, ...medidas });
      await borrarEspera(env, pieza.id);
    }
  }
}
