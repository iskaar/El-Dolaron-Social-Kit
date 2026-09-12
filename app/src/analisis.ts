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
].join(' ');

/** Debajo de esto, los ejemplos son ruido y manda el porcentaje de la configuracion. */
const EJEMPLOS_MINIMOS = 5;
const EJEMPLOS_MAXIMOS = 30;

export interface Ficha {
  nombre: string;
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
    categoria: { type: 'string', enum: [...CATEGORIAS] },
    precio_lista_mxn: { type: 'number', description: 'Precio nuevo en Mexico, en pesos. 0 si no lo reconoces.' },
    precio_venta_mxn: { type: 'number', description: 'Lo que cobraria Isaac segun sus ejemplos. 0 si no hay ejemplos parecidos.' },
    confianza: { type: 'number', description: 'De 0 a 1.' },
  },
  required: ['nombre', 'categoria', 'precio_lista_mxn', 'precio_venta_mxn', 'confianza'],
  additionalProperties: false,
} as const;

function base64(datos: ArrayBuffer): string {
  const bytes = new Uint8Array(datos);
  let binario = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binario += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binario);
}

function normalizar(cruda: Partial<Ficha>): Ficha {
  const categoria = String(cruda.categoria ?? '');
  return {
    nombre: String(cruda.nombre ?? '').slice(0, 120),
    categoria: (CATEGORIAS as readonly string[]).includes(categoria) ? categoria : 'otros',
    precio_lista_mxn: Math.max(0, Math.round(Number(cruda.precio_lista_mxn ?? 0))),
    precio_venta_mxn: Math.max(0, Math.round(Number(cruda.precio_venta_mxn ?? 0))),
    confianza: Math.min(1, Math.max(0, Number(cruda.confianza ?? 0))),
  };
}

async function conClaude(foto: string, env: Env, instruccion: string): Promise<Ficha> {
  const cliente = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const respuesta = await cliente.messages.create({
    model: MODELO_CLAUDE,
    max_tokens: 512,
    system: instruccion,
    output_config: { format: { type: 'json_schema', schema: ESQUEMA } },
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
  return normalizar(JSON.parse(texto));
}

async function conGemini(foto: string, env: Env, instruccion: string): Promise<Ficha> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${env.GEMINI_API_KEY}`;
  const respuesta = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instruccion }] },
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: foto } },
            { text: 'Identifica este articulo.' },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', responseSchema: ESQUEMA },
    }),
  });
  if (!respuesta.ok) {
    throw new Error(`Gemini ${respuesta.status}: ${(await respuesta.text()).slice(0, 200)}`);
  }
  const cuerpo = (await respuesta.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const texto = cuerpo.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
  return normalizar(JSON.parse(texto));
}

/**
 * Analiza la foto de un borrador y escribe el resultado. Nunca lanza: un fallo
 * deja la fila en `error` con su foto intacta, lista para reintentar desde el admin.
 */
export async function analizarBorrador(id: string, env: Env, modeloPedido?: Modelo): Promise<void> {
  const modelo = modeloPedido ?? modeloPorDefecto(env);
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

    const ejemplos = await ejemplosDeIsaac(env);
    const instruccion = INSTRUCCION + bloqueEjemplos(ejemplos);

    const ficha = modelo === 'gemini'
      ? await conGemini(foto, env, instruccion)
      : await conClaude(foto, env, instruccion);

    const { results } = await env.DB.prepare('select clave, valor from config').all<{ clave: string; valor: string }>();
    const config = Object.fromEntries(results.map((c) => [c.clave, c.valor]));

    const precioLista = ficha.precio_lista_mxn * 100; // pesos -> centavos

    // Con suficientes ejemplos manda el criterio de Isaac; sin ellos, el
    // porcentaje de la configuracion. El porcentaje nunca describio como cobra
    // —dos piezas de `hogar` fueron a 57 % y a 29 %— pero es un arranque honesto.
    const conEjemplos = ejemplos.length >= EJEMPLOS_MINIMOS && ficha.precio_venta_mxn > 0;
    const { precio, destino } = conEjemplos
      ? precioDesdeSugerencia({ precioLista, sugerido: ficha.precio_venta_mxn * 100, config })
      : calcularPrecio({ precioLista, categoria: ficha.categoria, estadoFisico: fila.estado_fisico, config });

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
      mensaje: 'analisis listo', id, modelo, ms: Date.now() - inicio,
      ejemplos: ejemplos.length, segun_ejemplos: conEjemplos, ficha,
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
