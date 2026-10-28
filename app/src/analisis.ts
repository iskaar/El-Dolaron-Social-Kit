/**
 * Analisis de la foto. Corre en segundo plano con ctx.waitUntil(): la captura
 * nunca lo espera y un fallo aqui no detiene al vendedor.
 *
 * Durante la prueba del paso 3 conviven dos implementaciones. Al terminar el
 * conteo de correcciones se borra la perdedora; no se construye una capa de
 * proveedores (docs/ARQUITECTURA-ESCANER.md).
 */
import Anthropic from '@anthropic-ai/sdk';
import { decodificarNombre } from './nombre.ts';
import { calcularPrecio, precioDesdeSugerencia } from './precio.ts';
import { CATEGORIAS as LISTA_CATEGORIAS, CLAVES_CATEGORIA } from '../public/categorias.js';
import { PRENDAS_ROPA } from '../public/ropa.js';
import { crearSolicitud } from './solicitudes-precio.ts';

export type Modelo = 'claude' | 'gemini';

/**
 * Punto de partida; la prueba de 20 fotos decide cual se queda.
 * Cada instancia elige el suyo con la variable MODELO_ANALISIS: la tienda corre
 * con Claude y la instancia prestada con Gemini, sobre la llave de su dueño.
 */
export function modeloPorDefecto(env: Env): Modelo {
  return env.MODELO_ANALISIS === 'gemini' ? 'gemini' : 'claude';
}

const MODELO_CLAUDE = 'claude-haiku-5-5';
const MODELO_GEMINI = 'gemini-flash-latest';
// Vertex no publica alias `-latest`: version fija (GA 2026-09-02, retiro >= 2027-09).
const MODELO_VERTEX = 'gemini-3.8-flash';

/**
 * El analisis corre en ctx.waitUntil(), que el runtime corta a los 30 s: si lo
 * matan, la fila se queda en `pendiente` para siempre. Una sola llamada al
 * modelo por analisis; el peor caso con Claude es 2 intentos x 11 s + espera
 * del reintento (~1 s) = 23 s, y Gemini (con busqueda) un intento de 22 s;
 * debajo de ~27 s queda lo demas (R2, D1). Mutable solo para las pruebas.
 */
export const LIMITES_MS = { claude: 11_000, gemini: 22_000 };

const CATEGORIAS = CLAVES_CATEGORIA;

const INSTRUCCION = [
  'Eres el inspector de una tienda de mercancia americana de liquidacion en San Luis Potosi, Mexico.',
  'Identifica el articulo de la foto y estima **cuanto costaria nuevo en Mexico**, en pesos mexicanos,',
  'no su precio en dolares ni su precio original de tienda americana.',
  'Responde solo con el JSON pedido. Si no reconoces el articulo, deja el nombre vacio y el precio en 0:',
  'inventar un precio cuesta mas que dejarlo para revision manual.',
  '\n\nCOMO SE ESCRIBE EL NOMBRE. La misma pieza fotografiada dos veces tiene que dar el mismo',
  'nombre, o el inventario se llena de duplicados que nadie puede juntar.',
  '\n- Formato: articulo + marca + detalle que lo distinga (capacidad, medida, modelo), en ese orden.',
  '\n- En espanol, maximo seis palabras, singular, sin articulos ni adjetivos de venta.',
  '\n- Nada de color, estado, cantidad ni empaque, salvo que sea lo unico que distinga la pieza.',
  '\n- Ejemplos: "Licuadora Oster 10 velocidades", "Sarten Tramontina 24 cm", "Cafetera Mr. Coffee 12 tazas".',
  '\n\nMARCA: la del fabricante tal como se escribe ("Room Essentials", "e.l.f.", "Fiskars"); vacia si no se ve.',
  '\n\nCATEGORIA: la que usaria una tienda en linea para encontrarlo. "otros" solo si no cabe en ninguna:',
  ...LISTA_CATEGORIAS.map(([clave, nombre]) => `\n- ${clave}: ${nombre}`),
].join(' ');

/** Debajo de esto, los ejemplos son ruido y manda el porcentaje de la configuracion. */
const EJEMPLOS_MINIMOS = 5;
// Debajo de esto la sugerencia por ejemplos adivina: el Gigglescape salió en $49 con 0.55 y Isaac
// lo da en $79, justo lo que da el % de la categoría (#393).
const CONFIANZA_SUGERENCIA = 0.7;
const EJEMPLOS_MAXIMOS = 30;

export interface Ficha {
  nombre: string;
  marca: string;
  categoria: string;
  precio_lista_mxn: number;
  precio_venta_mxn: number;
  confianza: number;
}

interface Ejemplo {
  nombre: string;
  categoria: string;
  precio_lista: number;
  precio: number;
}

/**
 * Las piezas donde Isaac corrigio el precio propuesto. No es una regla por
 * categoria — dos articulos de `hogar` pueden ir a 57 % y a 29 % — sino el
 * criterio con el que cobra, que ningun porcentaje alcanza a describir.
 */
async function ejemplosDeIsaac(env: Env): Promise<Ejemplo[]> {
  const { results } = await env.DB.prepare(
    `select nombre, categoria, precio_lista, precio from productos
     where precio > 0 and precio_lista > 0 and precio <> precio_sugerido and nombre <> ''
     order by actualizado_en desc limit ?`,
  )
    .bind(EJEMPLOS_MAXIMOS)
    .all<Ejemplo>();
  return results;
}

/**
 * Nombres que ya existen en el inventario. Si la pieza nueva es la misma que una
 * de estas, el modelo reutiliza el nombre exacto en lugar de inventar una
 * variante ("Licuadora Oster" vs "Licuadora Oster negra"), que es como se
 * generan los duplicados que luego nadie junta.
 */
async function nombresExistentes(env: Env): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `select distinct nombre from productos
     where nombre <> '' and sin_inventario = 0
     order by actualizado_en desc limit 80`,
  ).all<{ nombre: string }>();
  return results.map((fila) => fila.nombre);
}

function bloqueNombres(nombres: string[]): string {
  if (nombres.length === 0) {
    return '';
  }
  return [
    '\n\nNombres que ya existen en el inventario:',
    nombres.map((n) => `- ${n}`).join('\n'),
    'Si la pieza de la foto es la misma que una de esas, responde con **ese nombre exacto**,',
    'letra por letra. Solo inventa un nombre nuevo si de verdad es otro articulo.',
  ].join('\n');
}

function bloqueEjemplos(ejemplos: Ejemplo[]): string {
  if (ejemplos.length < EJEMPLOS_MINIMOS) {
    return '';
  }
  const lineas = ejemplos
    .map((e) => `${e.nombre} (${e.categoria}): nuevo en Mexico $${Math.round(e.precio_lista / 100)}, Isaac cobra $${Math.round(e.precio / 100)}`)
    .join('\n');
  return [
    '\n\nAsi cobra Isaac en su tienda. Son sus precios reales, no un porcentaje fijo:',
    lineas,
    'Propon `precio_venta_mxn` siguiendo ese criterio, no una regla por categoria.',
    'Si la pieza no se parece a ninguno de los ejemplos, deja `precio_venta_mxn` en 0.',
  ].join('\n');
}

const ESQUEMA = {
  type: 'object',
  properties: {
    nombre: { type: 'string', description: 'Nombre corto del articulo, en espanol.' },
    marca: { type: 'string', description: 'Marca del fabricante; vacia si no se ve.' },
    categoria: { type: 'string', enum: [...CATEGORIAS] },
    precio_lista_mxn: { type: 'number', description: 'Precio nuevo en Mexico, en pesos. 0 si no lo reconoces.' },
    precio_venta_mxn: { type: 'number', description: 'Lo que cobraria Isaac segun sus ejemplos. 0 si no hay ejemplos parecidos.' },
    confianza: { type: 'number', description: 'De 0 a 1.' },
  },
  required: ['nombre', 'marca', 'categoria', 'precio_lista_mxn', 'precio_venta_mxn', 'confianza'],
  additionalProperties: false,
} as const;

// Gemini acepta un subconjunto de JSON Schema y rechaza `additionalProperties`
// con un 400; Claude lo necesita para el modo estricto. Mismo esquema, esa llave
// de menos.
const { additionalProperties: _noEnGemini, ...ESQUEMA_GEMINI } = ESQUEMA;

function base64(datos: ArrayBuffer): string {
  const bytes = new Uint8Array(datos);
  let binario = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binario);
}

/**
 * La busqueda de Google no convive con `responseSchema`: la API rechaza las dos
 * juntas. Con busqueda se pide el JSON en el prompt y se extrae del texto.
 */
function extraerJson(texto: string): Partial<Ficha> {
  const limpio = texto.replace(/```json|```/g, '');
  const inicio = limpio.indexOf('{');
  const fin = limpio.lastIndexOf('}');
  if (inicio < 0 || fin <= inicio) {
    throw new Error(`Respuesta sin JSON: ${texto.slice(0, 200)}`);
  }
  return JSON.parse(limpio.slice(inicio, fin + 1)) as Partial<Ficha>;
}

const PIDE_JSON = [
  '\n\nAntes de responder, busca el precio actual de este articulo en tiendas mexicanas',
  '(Amazon Mexico, Mercado Libre, Walmart Mexico, Liverpool). Usa el precio que encuentres,',
  'no una estimacion de memoria. Si no lo encuentras, deja `precio_lista_mxn` en 0.',
  '\nResponde SOLO con este JSON, sin texto alrededor:',
  `{"nombre":"","marca":"","categoria":"${CATEGORIAS.join('|')}","precio_lista_mxn":0,"precio_venta_mxn":0,"confianza":0}`,
].join(' ');

function normalizar(cruda: Partial<Ficha>): Ficha {
  const categoria = String(cruda.categoria ?? '');
  return {
    nombre: decodificarNombre(String(cruda.nombre ?? '')).slice(0, 120),
    marca: String(cruda.marca ?? '').trim().slice(0, 60),
    categoria: CATEGORIAS.includes(categoria) ? categoria : 'otros',
    precio_lista_mxn: Math.max(0, Math.round(Number(cruda.precio_lista_mxn ?? 0))),
    precio_venta_mxn: Math.max(0, Math.round(Number(cruda.precio_venta_mxn ?? 0))),
    confianza: Math.min(1, Math.max(0, Number(cruda.confianza ?? 0))),
  };
}

export async function conClaude(foto: string | string[], env: Env, instruccion: string, esquema: any = ESQUEMA, textoUsuario = 'Identifica este articulo.'): Promise<unknown> {
  // Un reintento (no los 2 de fabrica) cubre un 429/529 en la captura por lotes.
  const cliente = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: LIMITES_MS.claude, maxRetries: 1 });
  const respuesta = await cliente.messages.create({
    model: MODELO_CLAUDE,
    // Haiku 5.5 piensa por omision y lo pensado cuenta aqui: con 512 una foto
    // dificil se quedaba sin JSON. `low` piensa poco o nada en una foto clara.
    max_tokens: 2048,
    system: instruccion,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: esquema } },
    messages: [
      {
        role: 'user',
        content: [
          ...(Array.isArray(foto) ? foto : [foto]).map((data) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data } })),
          { type: 'text', text: textoUsuario },
        ],
      },
    ],
  });
  const texto = respuesta.content.map((bloque) => (bloque.type === 'text' ? bloque.text : '')).join('');
  // Un rechazo (filtros de seguridad) o el tope de tokens llegan sin JSON: que
  // el error en la fila lo diga en vez de un "Unexpected end of JSON input".
  if (respuesta.stop_reason === 'refusal' || respuesta.stop_reason === 'max_tokens') {
    throw new Error(`Claude no respondio la ficha (${respuesta.stop_reason}).`);
  }
  return JSON.parse(texto);
}

interface RespuestaGemini {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: { groundingChunks?: Array<{ web?: { title?: string; uri?: string } }> };
  }>;
}

// #413: mismo transporte para análisis y búsqueda; las imágenes solo usan grounding.
async function consultarGemini(env: Env, cuerpo: Record<string, unknown>, limiteMs: number): Promise<RespuestaGemini> {
  // Con VERTEX_API_KEY se cobra al proyecto de Google Cloud (Issue #363), no a
  // la cuota de AI Studio que se acabo en #91. Mismo cuerpo para las dos.
  // Las dos instancias tienen secretos independientes, pero no siempre con el
  // mismo nombre: se acepta cualquiera de los dos en lugar de obligar a
  // recapturar la llave.
  const llave = env.GEMINI_API_KEY || env.GEMINI2_API_KEY;
  if (!env.VERTEX_API_KEY && !llave) {
    throw new Error('Falta la llave de Gemini (VERTEX_API_KEY, GEMINI_API_KEY o GEMINI2_API_KEY).');
  }
  const url = env.VERTEX_API_KEY
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODELO_VERTEX}:generateContent?key=${env.VERTEX_API_KEY}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${llave}`;
  const respuesta = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(limiteMs),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
  if (!respuesta.ok) {
    throw new Error(`Gemini ${respuesta.status}: ${(await respuesta.text()).slice(0, 200)}`);
  }
  return await respuesta.json() as RespuestaGemini;
}

async function conGemini(foto: string | null, env: Env, instruccion: string, buscar = false, esquema: any = ESQUEMA_GEMINI,
  textoUsuario = 'Identifica este articulo.', limiteMs = LIMITES_MS.gemini, pideJson = PIDE_JSON): Promise<unknown> {
  const cuerpo = await consultarGemini(env, {
    systemInstruction: { parts: [{ text: buscar ? instruccion + pideJson : instruccion }] },
    contents: [
      {
        // Vertex exige el rol; AI Studio lo acepta.
        role: 'user',
        // Sin foto: solo texto, como la búsqueda por código de barras (#373).
        parts: [
          ...(foto ? [{ inlineData: { mimeType: 'image/jpeg', data: foto } }] : []),
          { text: textoUsuario },
        ],
      },
    ],
    // Con busqueda, el esquema estructurado no esta permitido: van excluyentes.
    ...(buscar ? { tools: [{ googleSearch: {} }] } : {}),
    generationConfig: {
      // gemini-3.8-flash piensa en MEDIUM por omision y, con busqueda, paso
      // de los 22 s en sandbox (#363). LOW basta para leer una foto.
      ...(env.VERTEX_API_KEY ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
      ...(buscar ? {} : { responseMimeType: 'application/json', responseSchema: esquema }),
    },
  }, limiteMs);
  const texto = (cuerpo.candidates?.[0]?.content?.parts ?? [])
    .map((parte) => parte.text ?? '')
    .join('');
  if (!buscar) {
    return JSON.parse(texto || '{}');
  }
  // De donde salio el precio (el dominio de cada pagina), para el log del analisis.
  const fuentes = (cuerpo.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .map((pedazo) => pedazo.web?.title ?? '')
    .filter(Boolean)
    .slice(0, 5);
  return { ...extraerJson(texto), fuentes };
}

/** #413: una llamada por clic; nunca se leen URLs escritas en el texto del modelo. */
export async function paginasParaImagen(consulta: string, env: Env): Promise<string[]> {
  if (!env.VERTEX_API_KEY) throw new Error('Falta VERTEX_API_KEY para buscar imágenes.');
  const cuerpo = await consultarGemini(env, {
    systemInstruction: { parts: [{ text: 'Busca páginas de producto de tiendas o del fabricante para este artículo. Usa Google con la marca, el nombre y el código si lo hay.' }] },
    contents: [{ role: 'user', parts: [{ text: consulta }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' } },
  }, LIMITES_MS.gemini);
  return [...new Set((cuerpo.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
    .map((pedazo) => pedazo.web?.uri).filter((uri): uri is string => typeof uri === 'string'))].slice(0, 6);
}

const INSTRUCCION_UPC = [
  'Eres el inspector de una tienda de mercancia americana de liquidacion en San Luis Potosi, Mexico.',
  'Te dan solo un codigo de barras (UPC o EAN). Buscalo en Google como "upc <codigo>".',
  'Responde con un producto SOLO si una pagina muestra ese mismo codigo; si no, deja el nombre vacio',
  'y la confianza en 0. Un producto equivocado cuesta mas que pedir una foto.',
  'Sirve cualquier tienda o anuncio que muestre ese codigo: eBay, Amazon, Walmart, Target, tiendas de',
  'Estados Unidos o de Mexico (Issue #397). Usa el precio de esa misma pagina; si muestra MSRP o precio de',
  'lista, usa ese en lugar del precio de oferta o de reventa. En pesos va en',
  '`precio_lista_mxn`; en dolares va en `precio_usd` y deja `precio_lista_mxn` en 0. No conviertas monedas.',
  // Mismas reglas de nombre, marca y categoría que la foto: el mismo producto da el mismo nombre.
  INSTRUCCION.slice(INSTRUCCION.indexOf('COMO SE ESCRIBE')),
].join(' ');

/**
 * Identifica un UPC que no está en la hoja del proveedor, sin foto (Issue #373):
 * Gemini con búsqueda de Google. Corre en segundo plano; el capturista ya siguió.
 */
const PIDE_JSON_UPC = [
  '\n\nResponde SOLO con este JSON, sin texto alrededor:',
  `{"nombre":"","marca":"","categoria":"${CATEGORIAS.join('|')}","precio_lista_mxn":0,"precio_usd":0,"fuente":"","confianza":0}`,
].join(' ');

export type HallazgoUpc = Ficha & { precio_usd: number; fuente: string; fuentes?: string[] };

export async function identificarUpc(upc: string, env: Env, limiteMs = LIMITES_MS.gemini): Promise<HallazgoUpc> {
  const cruda = await conGemini(null, env, INSTRUCCION_UPC, true, ESQUEMA_GEMINI, `upc ${upc}`, limiteMs, PIDE_JSON_UPC) as
    Partial<Ficha> & { precio_usd?: unknown; fuente?: unknown; fuentes?: string[] };
  const usd = Number(cruda.precio_usd);
  return { ...normalizar(cruda), precio_usd: Number.isFinite(usd) && usd > 0 ? Math.round(usd * 100) / 100 : 0,
    fuente: String(cruda.fuente ?? '').slice(0, 80), fuentes: cruda.fuentes };
}

/** Pesos de lista de un hallazgo: los pesos tal cual, o los dólares por el tipo de cambio, como la hoja (#397). */
export function pesosDeLista(hallazgo: { precio_lista_mxn: number; precio_usd?: number }, config: Record<string, string>): number {
  if (hallazgo.precio_lista_mxn > 0) return hallazgo.precio_lista_mxn;
  const tipoCambio = Number.parseInt(config.tipo_cambio ?? '', 10);   // centavos MXN por dólar
  return hallazgo.precio_usd && tipoCambio > 0 ? Math.round((hallazgo.precio_usd * tipoCambio) / 100) : 0;
}

const INSTRUCCION_PRECIO = [
  'Eres el inspector de una tienda de mercancia americana de liquidacion en San Luis Potosi, Mexico.',
  'Te dan el nombre de un articulo que ya se identifico en una foto. Solo busca cuanto cuesta nuevo en Mexico;',
  'copia el nombre, la marca y la categoria tal como te los dan. Confianza baja si no hallas ese mismo articulo.',
].join(' ');
// El análisis corre en waitUntil (30 s): la búsqueda del precio usa lo que dejó Haiku, con margen
// para escribir la fila. 15 s fijos no le alcanzaron a Vertex en producción (#389).
const PRESUPUESTO_ANALISIS_MS = 27_000;
const MINIMO_PRECIO_MS = 8_000;

/**
 * Haiku nombra la pieza pero no inventa precio (#387): con nombre y sin precio, Gemini con búsqueda
 * de Google busca ese nombre en tiendas mexicanas. Lanza si no hay llave o no responde a tiempo.
 */
async function precioPorNombre(ficha: Ficha, env: Env, limiteMs: number): Promise<{ precio_lista_mxn: number; confianza: number; fuentes?: string[] }> {
  const cruda = await conGemini(null, env, INSTRUCCION_PRECIO, true, ESQUEMA_GEMINI,
    `Articulo: ${ficha.nombre}${ficha.marca ? `, marca ${ficha.marca}` : ''}. Categoria: ${ficha.categoria}.`, limiteMs,
  ) as Partial<Ficha> & { fuentes?: string[] };
  const { precio_lista_mxn, confianza } = normalizar(cruda);
  return { precio_lista_mxn, confianza, fuentes: cruda.fuentes };
}

const ESQUEMA_ROPA = {
  type: 'object', properties: {
    prenda: { type: 'string', enum: [...PRENDAS_ROPA, ''] },
    prenda_confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
    marca: { type: 'string' },
    marca_confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
    motivo: { type: 'string' },
  }, required: ['prenda', 'prenda_confianza', 'marca', 'marca_confianza', 'motivo'], additionalProperties: false,
} as const;
const ESQUEMA_ROPA_GEMINI = (({ additionalProperties: _omit, ...esquema }) => esquema)(ESQUEMA_ROPA);

export interface SugerenciaRopa { prenda: string; prenda_confianza: 'alta'|'media'|'baja'; marca: string; marca_confianza: 'alta'|'media'|'baja'; motivo: string }
export async function analizarFotoRopa(datos: ArrayBuffer, env: Env): Promise<SugerenciaRopa> {
  const instruccion = `Identifica la prenda visible y la marca solo si una etiqueta legible aparece en la foto. Devuelve JSON. Prenda debe ser exactamente una de: ${PRENDAS_ROPA.join(', ')}; si no se distingue, vacía y confianza baja. Usa confianza alta, media o baja por campo. Motivo breve y objetivo. No infieras marca por estilo ni modelo.`;
  const foto = base64(datos);
  const bruto = modeloPorDefecto(env) === 'gemini'
    ? await conGemini(foto, env, instruccion, false, ESQUEMA_ROPA_GEMINI)
    : await conClaude(foto, env, instruccion, ESQUEMA_ROPA);
  const dato = bruto as Partial<SugerenciaRopa>;
  const confianza = (x: unknown) => ['alta', 'media', 'baja'].includes(String(x)) ? x as SugerenciaRopa['prenda_confianza'] : 'baja';
  const prenda = String(dato.prenda ?? '');
  return { prenda: PRENDAS_ROPA.includes(prenda) ? prenda : '', prenda_confianza: confianza(dato.prenda_confianza),
    marca: String(dato.marca ?? '').trim().slice(0, 60), marca_confianza: confianza(dato.marca_confianza), motivo: String(dato.motivo ?? '').slice(0, 160) };
}

const INSTRUCCION_ATRIBUTOS = [
  'Eres el inspector de una tienda de mercancia americana en San Luis Potosi, Mexico.',
  'Llena la ficha de Mercado Libre de la pieza de la foto. Responde solo con el JSON pedido.',
  'Cada atributo con valores permitidos se contesta con exactamente uno de ellos.',
  'Si no se distingue en la foto o en el nombre, responde "": un dato equivocado genera reclamos y uno vacio lo completa el dueno.',
  'Color: el que predomina. Genero: para quien es la prenda segun su corte o su etiqueta, no por la marca.',
  'No des materiales que no se vean ni esten en la etiqueta.',
].join(' ');

export interface PedidoAtributo { id: string; nombre: string; valores: string[] }

/**
 * Atributos de una categoria de Mercado Libre que la pieza no trae (color, genero, material...), segun la foto
 * y el nombre (#555). Con valores permitidos elige uno de ellos (el esquema lo obliga); sin ellos escribe texto.
 * Devuelve solo los que contesto. Lanza si el modelo no responde: quien llama muestra el motivo.
 */
export async function sugerirAtributos(
  datos: ArrayBuffer, env: Env, pieza: { nombre: string; marca: string }, pedidos: PedidoAtributo[],
): Promise<Record<string, string>> {
  const esquema = {
    type: 'object',
    properties: Object.fromEntries(pedidos.map((a) => [a.id, {
      type: 'string', description: a.nombre, ...(a.valores.length ? { enum: [...a.valores, ''] } : {}),
    }])),
    required: pedidos.map((a) => a.id),
    additionalProperties: false,
  };
  const texto = `Pieza: ${pieza.nombre}${pieza.marca ? `, marca ${pieza.marca}` : ''}. Atributos: ${pedidos.map((a) => `${a.id} (${a.nombre})`).join(', ')}.`;
  const foto = base64(datos);
  const bruto = modeloPorDefecto(env) === 'gemini'
    ? await conGemini(foto, env, INSTRUCCION_ATRIBUTOS, false, (({ additionalProperties: _omit, ...e }) => e)(esquema), texto)
    : await conClaude(foto, env, INSTRUCCION_ATRIBUTOS, esquema, texto);
  const dicho = (bruto ?? {}) as Record<string, unknown>;
  return Object.fromEntries(pedidos.map((a) => [a.id, String(dicho[a.id] ?? '').trim().slice(0, 255)]).filter(([, valor]) => valor));
}

/**
 * El análisis llegó a una pieza que ya está `listo` (reanálisis explícito, o resultado tardío tras una corrección
 * humana): no escribe nada de la pieza (#479). Deja `precio_sugerido` y, si el precio sugerido difiere del actual,
 * una solicitud de precio (#451) que el dueño ve en «Precios por revisar». `pedidoPor`: quien reanalizó, o 'ia'.
 */
async function sugerirSobreListo(env: Env, id: string, nuevo: { nombre: string; precio: number; destino: string; completa: boolean }, pedidoPor: string): Promise<void> {
  if (!nuevo.completa) return;   // un análisis incompleto no sugiere nada
  const pieza = await env.DB.prepare("select nombre, precio, destino, propietario from productos where id = ? and estado_analisis = 'listo'")
    .bind(id).first<{ nombre: string; precio: number; destino: string; propietario: string }>();
  if (!pieza) return;
  await env.DB.prepare("update productos set precio_sugerido = ? where id = ? and estado_analisis = 'listo'").bind(nuevo.precio, id).run();
  if (pieza.destino !== 'etiqueta' || nuevo.destino !== 'etiqueta' || nuevo.precio === pieza.precio) return;
  // ponytail: el nombre sugerido solo viaja en la nota de la solicitud; no hay columna para él (sin migración).
  const nota = `Reanálisis${nuevo.nombre.trim() !== pieza.nombre.trim() ? `: «${nuevo.nombre.trim()}»` : ''}`.slice(0, 140);
  const respuesta = await crearSolicitud(env, id, pieza.propietario, pedidoPor,
    { id: crypto.randomUUID(), sentido: nuevo.precio > pieza.precio ? 'subir' : 'bajar', sugerido: nuevo.precio, nota });
  if (!respuesta.ok) console.warn(JSON.stringify({ mensaje: 'sugerencia de precio sin solicitud', id, status: respuesta.status }));
}

/**
 * Analiza la foto de un borrador y escribe el resultado. Nunca lanza: un fallo
 * deja la fila en `error` con su foto intacta, lista para reintentar desde el admin.
 */
export async function analizarBorrador(
  id: string,
  env: Env,
  modeloPedido?: Modelo,
  buscarPedido?: boolean,
  pedidoPor = 'ia',   // quien pidió reanalizar: figura como autor de la solicitud de precio si la pieza ya estaba `listo` (#479)
): Promise<void> {
  const modelo = modeloPedido ?? modeloPorDefecto(env);
  // Buscar el precio en la web en lugar de estimarlo de memoria. Solo Gemini por
  // ahora; el analisis corre en segundo plano, asi que la demora no la ve nadie.
  const buscar = (buscarPedido ?? env.BUSQUEDA_WEB === 'si') && modelo === 'gemini';
  const inicio = Date.now();
  try {
    const objeto = await env.FOTOS.get(`fotos/${id}.jpg`);
    if (!objeto) {
      throw new Error('La foto no esta en R2.');
    }
    const foto = base64(await objeto.arrayBuffer());

    const fila = await env.DB.prepare('select estado_fisico, upc from productos where id = ?')
      .bind(id)
      .first<{ estado_fisico: string; upc: string | null }>();
    if (!fila) {
      throw new Error('El borrador no existe.');
    }

    const [ejemplos, nombres] = await Promise.all([ejemplosDeIsaac(env), nombresExistentes(env)]);
    const instruccion = INSTRUCCION + bloqueNombres(nombres) + bloqueEjemplos(ejemplos);

    const fichaCruda = modelo === 'gemini'
      ? await conGemini(foto, env, instruccion, buscar)
      : await conClaude(foto, env, instruccion);
    const ficha = normalizar(fichaCruda as Partial<Ficha>);
    let fuentes = (fichaCruda as { fuentes?: string[] }).fuentes;
    const { results } = await env.DB.prepare('select clave, valor from config').all<{ clave: string; valor: string }>();
    const config = Object.fromEntries(results.map((c) => [c.clave, c.valor]));

    let busquedaPrecio: { precio_lista_mxn: number; precio_usd?: number; confianza: number; fuente?: string } | undefined;
    // Sin precio pero con nombre se busca (#387). Con código, el código exacto en cualquier tienda (eBay,
    // Amazon, EE.UU.; #397): un nombre genérico como "peluche gato" no encuentra el artículo. Sin código,
    // el nombre. Si no hay llave o no aparece con confianza, queda aparte.
    // Con código se espera su búsqueda aunque la foto no diera nombre: el código sí lo trae (#402).
    // Con código, la búsqueda del código va a la cola (#406): Vertex con Google tarda más que los 30 s
    // de waitUntil. Sin código, se busca el nombre aquí mismo.
    if (!buscar && !fila.upc && ficha.nombre.trim() && ficha.precio_lista_mxn <= 0) {
      const limite = Math.max(MINIMO_PRECIO_MS, PRESUPUESTO_ANALISIS_MS - (Date.now() - inicio));
      try {
        const hallado = busquedaPrecio = await precioPorNombre(ficha, env, limite);
        const pesos = pesosDeLista(hallado, config);
        if (pesos > 0 && hallado.confianza >= 0.5) {
          ficha.precio_lista_mxn = pesos;
          fuentes = hallado.fuentes;
        }
      } catch (error) {
        console.warn(JSON.stringify({ mensaje: 'busqueda de precio fallida', id, upc: fila.upc, error: String(error).slice(0, 200) }));
      }
    }

    const precioLista = ficha.precio_lista_mxn * 100; // pesos -> centavos

    // Con suficientes ejemplos manda el criterio de Isaac; sin ellos, el
    // porcentaje de la configuracion. El porcentaje nunca describio como cobra
    // —dos piezas de `hogar` fueron a 57 % y a 29 %— pero es un arranque honesto.
    // La liquidación (C) siempre va por su %: la sugerencia de la IA no conoce el grado (#371).
    const conEjemplos = ejemplos.length >= EJEMPLOS_MINIMOS && ficha.precio_venta_mxn > 0 && fila.estado_fisico !== 'liquidacion'
      && ficha.confianza >= CONFIANZA_SUGERENCIA;
    const { precio, destino } = conEjemplos
      ? precioDesdeSugerencia({ precioLista, sugerido: ficha.precio_venta_mxn * 100 })
      : calcularPrecio({ precioLista, categoria: ficha.categoria, estadoFisico: fila.estado_fisico, config });

    // `precio_sugerido` queda como testigo de lo que propuso la IA: las
    // correcciones del admin no lo tocan, y de esa diferencia sale el ajuste
    // de los porcentajes cuando haya suficientes piezas.
    // Sin nombre o con precio 0 la pieza no esta lista: queda en `error`
    // para revisarla, con lo que se encontro. Si no, la cola automatica de /etiquetas
    // se queda esperando una pieza que nadie va a completar (#335).
    const completa = ficha.nombre.trim() !== '' && precio > 0;
    // Sin precio y con código: sigue `pendiente` mientras la cola busca el código; ella la deja lista o aparte.
    const aLaCola = !completa && !buscar && !!fila.upc && !!env.BUSQUEDAS;
    const escrita = await env.DB.prepare(
      `update productos set nombre = ?, marca = ?, categoria = ?, precio_lista = ?, precio = ?,
                            precio_sugerido = ?, destino = ?, estado_analisis = ?, actualizado_en = ?, modificado_por = 'ia'
       -- Una pieza revisada (listo) manda sobre un análisis tardío o repetido (#399, #479).
       where id = ? and estado_analisis not in ('descartado', 'listo')`,
    )
      .bind(ficha.nombre, ficha.marca, ficha.categoria, precioLista, precio, precio, destino,
        completa ? 'listo' : aLaCola ? 'pendiente' : 'error', new Date().toISOString(), id)
      .run();
    if (!escrita.meta.changes) await sugerirSobreListo(env, id, { nombre: ficha.nombre, precio, destino, completa }, pedidoPor);
    else if (aLaCola) await env.BUSQUEDAS!.send({ id, upc: fila.upc! });

    console.log(JSON.stringify({
      mensaje: completa ? 'analisis listo' : 'analisis incompleto', id, modelo, buscar, ms: Date.now() - inicio, a_la_cola: aLaCola,
      ejemplos: ejemplos.length, nombres: nombres.length, segun_ejemplos: conEjemplos, ficha,
      fuentes, busqueda_precio: busquedaPrecio && { mxn: busquedaPrecio.precio_lista_mxn, usd: busquedaPrecio.precio_usd, confianza: busquedaPrecio.confianza, fuente: busquedaPrecio.fuente },
    }));
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'analisis fallido', id, modelo, error: String(error) }));
    await env.DB.prepare(
      `update productos set estado_analisis = 'error', actualizado_en = ?, modificado_por = 'ia' where id = ? and estado_analisis <> 'descartado'
        and estado_analisis <> 'listo'`,
    )
      .bind(new Date().toISOString(), id)
      .run();
  }
}
