/**
 * Analisis de la foto. Corre en segundo plano con ctx.waitUntil(): la captura
 * nunca lo espera y un fallo aqui no detiene al vendedor.
 *
 * Durante la prueba del paso 3 conviven dos implementaciones. Al terminar el
 * conteo de correcciones se borra la perdedora; no se construye una capa de
 * proveedores (docs/ARQUITECTURA-ESCANER.md).
 */
import Anthropic from '@anthropic-ai/sdk';
import { calcularPrecio, precioDesdeSugerencia } from './precio.ts';

export type Modelo = 'claude' | 'gemini';

/**
 * Punto de partida; la prueba de 20 fotos decide cual se queda.
 * Cada instancia elige el suyo con la variable MODELO_ANALISIS: la tienda corre
 * con Claude y la instancia prestada con Gemini, sobre la llave de su dueño.
 */
export function modeloPorDefecto(env: Env): Modelo {
  return env.MODELO_ANALISIS === 'gemini' ? 'gemini' : 'claude';
}

const MODELO_CLAUDE = 'claude-haiku-4-5';
const MODELO_GEMINI = 'gemini-flash-latest';

const CATEGORIAS = ['ropa', 'hogar', 'electronica', 'juguetes', 'otros'] as const;

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
].join(' ');

/** Debajo de esto, los ejemplos son ruido y manda el porcentaje de la configuracion. */
const EJEMPLOS_MINIMOS = 5;
const EJEMPLOS_MAXIMOS = 30;

export interface Ficha {
  nombre: string;
  categoria: string;
  familia: string;   // clave de la tabla `familias`; '' si el modelo no eligio una valida
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

/**
 * Que va en cada familia de banda, con las palabras del plano de la tienda. Solo
 * lo que la IA necesita para escoger; una familia dada de alta despues desde
 * /bandas ("Otro") no tiene pista y se ofrece por su nombre.
 */
const PISTAS_FAMILIA: Record<string, string> = {
  ropa: 'ropa y accesorios para vestir',
  general: 'lo que no encaja claramente en ninguna otra familia',
  juguetes: 'juguetes',
  fiesta: 'fiesta y decoracion',
  alimentos: 'alimentos, snacks, bebidas y cafe',
  desechables: 'desechables, platos, vasos y mesa',
  asador: 'asador, exterior y articulos utilitarios',
  mascotas: 'mascotas',
  manualidades: 'manualidades, actividades y kits creativos',
  papeleria: 'papeleria y escolar',
  regalos: 'regalos, empaque y ocasion especial',
  limpieza: 'limpieza, almacenamiento y consumibles del hogar',
  calzado: 'calzado',
  'cuidado-personal': 'cuidado personal, higiene y bebe',
  cocina: 'cocina, organizacion y hogar',
  blancos: 'blancos, textiles y decoracion',
  'electronica-ligera': 'electronica ligera, iluminacion y pequenos aparatos',
};

/** El botadero es un lugar del piso, no un tipo de articulo: el modelo no lo elige, lo asigna el admin. */
const FAMILIAS_SIN_IA = new Set(['botadero']);

export interface FamiliaBanda {
  clave: string;
  nombre: string;
  prefijo: string;
}

async function familiasDeBanda(env: Env): Promise<FamiliaBanda[]> {
  const { results } = await env.DB.prepare('select clave, nombre, prefijo from familias order by rowid').all<FamiliaBanda>();
  const elegibles = results.filter((f) => !FAMILIAS_SIN_IA.has(f.clave));
  // Sin la tabla sembrada (migracion 009) quedan las dos de siempre.
  return elegibles.length > 0 ? elegibles : [{ clave: 'ropa', nombre: 'Ropa', prefijo: 'r' }, { clave: 'general', nombre: 'General', prefijo: 'g' }];
}

/** Las familias con su pista, para que la IA escoja la seccion de la tienda donde va la pieza. */
export function bloqueFamilias(familias: FamiliaBanda[]): string {
  return [
    '\n\nFAMILIA. Ademas de la categoria, escoge la familia (la seccion de la tienda) donde se acomodaria la pieza.',
    'Escoge la mas especifica; si ninguna encaja claramente, "general".',
    familias.map((f) => `- ${f.clave}: ${PISTAS_FAMILIA[f.clave] ?? f.nombre}`).join('\n'),
  ].join('\n');
}

function esquema(claves: string[]) {
  return {
    type: 'object',
    properties: {
      nombre: { type: 'string', description: 'Nombre corto del articulo, en espanol.' },
      categoria: { type: 'string', enum: [...CATEGORIAS] },
      familia: { type: 'string', enum: claves, description: 'Seccion de la tienda donde se acomoda.' },
      precio_lista_mxn: { type: 'number', description: 'Precio nuevo en Mexico, en pesos. 0 si no lo reconoces.' },
      precio_venta_mxn: { type: 'number', description: 'Lo que cobraria Isaac segun sus ejemplos. 0 si no hay ejemplos parecidos.' },
      confianza: { type: 'number', description: 'De 0 a 1.' },
    },
    required: ['nombre', 'categoria', 'familia', 'precio_lista_mxn', 'precio_venta_mxn', 'confianza'],
    additionalProperties: false,
  } as const;
}

// Gemini acepta un subconjunto de JSON Schema y rechaza `additionalProperties`
// con un 400; Claude lo necesita para el modo estricto. Mismo esquema, esa llave
// de menos.
function esquemaGemini(claves: string[]) {
  const { additionalProperties: _noEnGemini, ...resto } = esquema(claves);
  return resto;
}

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

const pideJson = (claves: string[]) => [
  '\n\nAntes de responder, busca el precio actual de este articulo en tiendas mexicanas',
  '(Amazon Mexico, Mercado Libre, Walmart Mexico, Liverpool). Usa el precio que encuentres,',
  'no una estimacion de memoria. Si no lo encuentras, deja `precio_lista_mxn` en 0.',
  '\nResponde SOLO con este JSON, sin texto alrededor:',
  `{"nombre":"","categoria":"ropa|hogar|electronica|juguetes|otros","familia":"${claves.join('|')}","precio_lista_mxn":0,"precio_venta_mxn":0,"confianza":0}`,
].join(' ');

export function normalizar(cruda: Partial<Ficha>, claves: string[]): Ficha {
  const categoria = String(cruda.categoria ?? '');
  const familia = String(cruda.familia ?? '');
  return {
    nombre: String(cruda.nombre ?? '').slice(0, 120),
    categoria: (CATEGORIAS as readonly string[]).includes(categoria) ? categoria : 'otros',
    familia: claves.includes(familia) ? familia : '',
    precio_lista_mxn: Math.max(0, Math.round(Number(cruda.precio_lista_mxn ?? 0))),
    precio_venta_mxn: Math.max(0, Math.round(Number(cruda.precio_venta_mxn ?? 0))),
    confianza: Math.min(1, Math.max(0, Number(cruda.confianza ?? 0))),
  };
}

async function conClaude(foto: string, env: Env, instruccion: string, claves: string[]): Promise<Ficha> {
  const cliente = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const respuesta = await cliente.messages.create({
    model: MODELO_CLAUDE,
    max_tokens: 512,
    system: instruccion,
    output_config: { format: { type: 'json_schema', schema: esquema(claves) } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: foto } },
          { type: 'text', text: 'Identifica este articulo.' },
        ],
      },
    ],
  });
  const texto = respuesta.content.map((bloque) => (bloque.type === 'text' ? bloque.text : '')).join('');
  return normalizar(JSON.parse(texto), claves);
}

async function conGemini(foto: string, env: Env, instruccion: string, claves: string[], buscar = false): Promise<Ficha> {
  // Las dos instancias tienen secretos independientes, pero no siempre con el
  // mismo nombre: se acepta cualquiera de los dos en lugar de obligar a
  // recapturar la llave.
  const llave = env.GEMINI_API_KEY || env.GEMINI2_API_KEY;
  if (!llave) {
    throw new Error('Falta la llave de Gemini (GEMINI_API_KEY o GEMINI2_API_KEY).');
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${llave}`;
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: buscar ? instruccion + pideJson(claves) : instruccion }] },
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: foto } },
            { text: 'Identifica este articulo.' },
          ],
        },
      ],
      // Con busqueda, el esquema estructurado no esta permitido: van excluyentes.
      ...(buscar
        ? { tools: [{ google_search: {} }] }
        : { generationConfig: { responseMimeType: 'application/json', responseSchema: esquemaGemini(claves) } }),
    }),
  });
  if (!respuesta.ok) {
    throw new Error(`Gemini ${respuesta.status}: ${(await respuesta.text()).slice(0, 200)}`);
  }
  const cuerpo = (await respuesta.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const texto = (cuerpo.candidates?.[0]?.content?.parts ?? [])
    .map((parte) => parte.text ?? '')
    .join('');
  return normalizar(buscar ? extraerJson(texto) : (JSON.parse(texto || '{}') as Partial<Ficha>), claves);
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

    const fila = await env.DB.prepare('select estado_fisico from productos where id = ?')
      .bind(id)
      .first<{ estado_fisico: string }>();
    if (!fila) {
      throw new Error('El borrador no existe.');
    }

    const [ejemplos, nombres, familias] = await Promise.all([ejemplosDeIsaac(env), nombresExistentes(env), familiasDeBanda(env)]);
    const claves = familias.map((f) => f.clave);
    const instruccion = INSTRUCCION + bloqueFamilias(familias) + bloqueNombres(nombres) + bloqueEjemplos(ejemplos);

    const ficha = modelo === 'gemini'
      ? await conGemini(foto, env, instruccion, claves, buscar)
      : await conClaude(foto, env, instruccion, claves);

    const { results } = await env.DB.prepare('select clave, valor from config').all<{ clave: string; valor: string }>();
    const config = Object.fromEntries(results.map((c) => [c.clave, c.valor]));

    const precioLista = ficha.precio_lista_mxn * 100; // pesos -> centavos
    // La familia que escogio el modelo decide la banda; sin una valida, la de siempre (ropa/general).
    const familia = familias.find((f) => f.clave === ficha.familia)?.prefijo;

    // Con suficientes ejemplos manda el criterio de Isaac; sin ellos, el
    // porcentaje de la configuracion. El porcentaje nunca describio como cobra
    // —dos piezas de `hogar` fueron a 57 % y a 29 %— pero es un arranque honesto.
    const conEjemplos = ejemplos.length >= EJEMPLOS_MINIMOS && ficha.precio_venta_mxn > 0;
    const { precio, destino } = conEjemplos
      ? precioDesdeSugerencia({ precioLista, sugerido: ficha.precio_venta_mxn * 100, categoria: ficha.categoria, familia, config })
      : calcularPrecio({ precioLista, categoria: ficha.categoria, familia, estadoFisico: fila.estado_fisico, config });

    // `precio_sugerido` queda como testigo de lo que propuso la IA: las
    // correcciones del admin no lo tocan, y de esa diferencia sale el ajuste
    // de los porcentajes cuando haya suficientes piezas.
    await env.DB.prepare(
      `update productos set nombre = ?, categoria = ?, precio_lista = ?, precio = ?,
                            precio_sugerido = ?, destino = ?, estado_analisis = 'listo', actualizado_en = ?
       where id = ?`,
    )
      .bind(ficha.nombre, ficha.categoria, precioLista, precio, precio, destino, new Date().toISOString(), id)
      .run();

    console.log(JSON.stringify({
      mensaje: 'analisis listo', id, modelo, buscar, ms: Date.now() - inicio,
      ejemplos: ejemplos.length, nombres: nombres.length, segun_ejemplos: conEjemplos, ficha,
    }));
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'analisis fallido', id, modelo, error: String(error) }));
    await env.DB.prepare(
      `update productos set estado_analisis = 'error', actualizado_en = ? where id = ?`,
    )
      .bind(new Date().toISOString(), id)
      .run();
  }
}
