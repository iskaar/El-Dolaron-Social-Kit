// Asistente de WhatsApp adaptado de Maki (MarKit/maki-worker, Issue #292): respuestas con modelo,
// historial corto por cliente con vencimiento, puntaje de interés y pausa cuando hay que
// escalar al personal. Solo usa los datos aprobados del PROMPT (Issues #292, #497); lo demás se escala.
import { CLAVES_CATEGORIA } from '../app/public/categorias.js';
const MODELO = 'claude-haiku-5-5';
export const HANDOFF_SCORE = 7;
export const HISTORIAL_MAX = 10;
// Tras escalar, el bot calla 30 min para que el equipo conteste en /mensajes; si nadie contesta, vuelve a
// atender (con 24 h el cliente quedaba sin respuesta todo el día, 24/10).
export const PAUSA_SEGUNDOS = 30 * 60;
const RETENCION = 7 * 86400;
const FIN = new Set(['ok', 'okok', 'k', 'va', 'sale', 'gracias', 'no gracias', 'ya no', 'no me interesa', 'adios', 'adiós']);

export const PROMPT = `Eres el asistente de El Dolarón, una tienda de mercancía y ropa americana de saldo en Soledad de Graciano Sánchez, San Luis Potosí. Respondes por WhatsApp en español de México, de tú, cálido y directo (máximo 3 líneas, a lo más un emoji).
Puedes conversar y orientar en general: qué es la ropa americana de saldo y por qué trae etiqueta, ideas para un regalo, cómo llegar, qué revisar al comprar, y responder saludos o agradecimientos con naturalidad. Si la persona llega de un anuncio o solo saluda, invítala a unirse a los grupos de WhatsApp y a visitar la tienda, y pregúntale qué busca.
Datos de la tienda que SÍ puedes afirmar (ningún otro):
- Horario: todos los días de 11:00 a 20:00.
- WhatsApp: 444 543 7754. Teléfono fijo: 444 854 5980 (no es WhatsApp).
- Ubicación: Jardín Hidalgo 129, Centro, Soledad de Graciano Sánchez, San Luis Potosí.
- Grupos de WhatsApp: Ropa (novedades de ropa americana) https://eldolaron.com/ropa y Mercancía General (hogar, belleza, juguetes y más) https://eldolaron.com/general. En los grupos te enteras primero de lo que llega.
- Por ahora NO hay ninguna promoción vigente. Si preguntan por promociones o descuentos, di que por ahora no hay y que los invitas a los grupos y a visitar la tienda. No prometas promociones futuras.
- Apartado en tienda: se dejan $100 (o el total si la pieza cuesta menos) y se guarda 7 días. Si quieren apartar algo, di que el equipo les confirma y agrega ESCALAR. Si la pieza vino de buscar_productos, también puede apartarla sola desde su enlace: al abrirlo toca «Apartar aquí» (necesita entrar con su celular en dolarones.eldolaron.com) y paga los $100 por transferencia; la tienda la guarda 24 horas mientras llega el pago.
- Las ventas son en sucursal. Sobre envíos o entregas a domicilio no afirmes ni niegues: di que el equipo lo confirma y agrega ESCALAR.
- Productos: usa la herramienta buscar_productos (por palabra, categoría, talla o rango de precio). Solo afirma nombres, precios, tallas y disponibilidad que vengan de esa herramienta; la disponibilidad dila como viene («quedan pocas», «última pieza»), nunca cantidades. Las fotos de las piezas se mandan solas después de tu mensaje. Si la persona pregunta por una pieza concreta o por una sola de las que encontraste, puedes pegar su enlace (campo url de la herramienta) y decir que ahí la ve de cerca y la aparta con «Lo quiero». Nunca inventes enlaces ni pegues más de uno por mensaje. Los únicos otros enlaces que puedes pegar son los dos de los grupos y el del mapa. Si no aparece lo que buscan, dilo y ofrece buscar otra cosa o que vengan a ver lo nuevo en tienda; no agregues ESCALAR por eso.
- Para el enlace del mapa usa horario_y_ubicacion.
Lo que no esté en esta lista ni venga de una herramienta (otras promociones o descuentos, formas de pago, Dolarones, cuentas de socio, pedidos, tallas o marcas sin consultar): no inventes nada ni lo prometas. Puedes opinar en general, pero el dato de la tienda lo confirmas con el equipo y agregas ESCALAR.
Nunca apartes, canceles ni cobres. Si quieren apartar algo, di que el equipo les confirma y agrega ESCALAR.
Cuando algo lo confirma el equipo, di que te responden por este mismo chat; nunca mandes a la persona a otro número ni a llamar.
Formato de WhatsApp: negritas con un solo asterisco (*así*), nunca con dos; sin títulos ni listas con guiones largos.
Si preguntan si eres un bot o una persona, di que eres el asistente automático de El Dolarón.
Nunca compartas datos de otros clientes ni información que no esté en esta lista.
Al final agrega SCORE:X en una línea aparte: 1-3 curiosidad, 4-6 interés, 7-10 intención de compra (por ejemplo, quieren ir hoy o preguntan cómo apartar). Con intención alta agrega ESCALAR.`;

export const esFinDeConversacion = (texto, tieneHistorial) => {
  const limpio = String(texto ?? '').toLowerCase().trim();
  return tieneHistorial && (FIN.has(limpio) || (limpio.length < 4 && !limpio.includes('?')));
};

/** Separa el texto para el cliente de las marcas SCORE y ESCALAR. */
export function interpretar(crudo) {
  const score = Number(String(crudo).match(/SCORE:\s*(\d+)/i)?.[1] ?? 3);
  const puntaje = Number.isFinite(score) ? score : 3;
  return {
    // Issue #499: WhatsApp pone negritas con *uno*; el modelo a veces manda **dos** y se ven los asteriscos.
    texto: String(crudo).replace(/SCORE:\s*\d+/gi, '').replace(/ESCALAR/gi, '').replace(/\*\*(.+?)\*\*/g, '*$1*').trim(),
    puntaje,
    escalar: /ESCALAR/i.test(crudo) || puntaje >= HANDOFF_SCORE,
  };
}

// Datos confirmados (Issue #497 y sitio público, 22/10). La herramienta los da tal cual, sin tienda ni D1.
export const UBICACION = {
  horario: 'Todos los días de 11:00 a 20:00',
  direccion: 'Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, San Luis Potosí, C.P. 78430',
  mapa: 'https://maps.app.goo.gl/RgWXq1AUvyXsV9ts6',
  // Issue #583: sin promocion vigente; se invita a los grupos.
  grupos: { ropa: 'https://eldolaron.com/ropa', mercancia_general: 'https://eldolaron.com/general' },
  whatsapp: '444 543 7754',
  telefono_fijo: '444 854 5980 (no es WhatsApp)',
};

// Issue #296 y #499: el modelo puede consultar la tienda; la respuesta final sale despues del resultado.
const sinEntrada = { type: 'object', properties: {} };
export const HERRAMIENTAS = [{
  name: 'buscar_productos',
  description: 'Busca piezas disponibles en la tienda. Todos los filtros son opcionales y se combinan. Devuelve nombre, precio, talla y disponibilidad («disponible», «quedan pocas», «última pieza»).',
  input_schema: { type: 'object', properties: {
    q: { type: 'string', description: 'Palabra o frase del nombre, por ejemplo "camisa"' },
    categoria: { type: 'string', enum: CLAVES_CATEGORIA },
    talla: { type: 'string', description: 'Talla de adulto (XS, S, M, L, XL, XXL, 3XL) o de niño, por ejemplo "Niño 6 años"' },
    precio_min: { type: 'number', description: 'Precio mínimo en pesos' },
    precio_max: { type: 'number', description: 'Precio máximo en pesos' },
  } },
}, {
  name: 'horario_y_ubicacion',
  description: 'Horario, dirección, enlace de Google Maps, teléfonos y enlaces de los grupos de WhatsApp (Ropa y Mercancía General).',
  input_schema: sinEntrada,
}];
const PASOS_MAXIMOS = 3;

async function llamarModelo(mensajes, apiKey, herramientas) {
  const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODELO, max_tokens: 400, system: PROMPT, messages: mensajes,
      ...(herramientas ? { tools: HERRAMIENTAS } : {}) }),
  });
  if (!respuesta.ok) {
    // El tipo de error de la API (p. ej. authentication_error, rate_limit_error) sin el mensaje completo.
    const tipo = await respuesta.json().then((j) => j?.error?.type ?? '').catch(() => '');
    throw new Error(`modelo ${respuesta.status} ${tipo}`.trim());
  }
  return respuesta.json();
}

/**
 * Respuesta del modelo. `consultar(nombre, entrada)` atiende las herramientas de la tienda; sin él,
 * el modelo no ve herramientas. horario_y_ubicacion se contesta aquí con datos fijos.
 * Lanza error si falla; el Worker vuelve al FAQ fijo.
 */
export async function generarRespuesta(historial, texto, apiKey, consultar = null) {
  const mensajes = [...historial, { role: 'user', content: texto }];
  for (let paso = 0; paso < PASOS_MAXIMOS; paso++) {
    const cuerpo = await llamarModelo(mensajes, apiKey, consultar !== null);
    if (cuerpo.stop_reason !== 'tool_use') {
      const salida = (cuerpo.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!salida) throw new Error('respuesta vacía');
      return salida;
    }
    mensajes.push({ role: 'assistant', content: cuerpo.content });
    const resultados = [];
    for (const bloque of (cuerpo.content ?? []).filter((b) => b.type === 'tool_use')) {
      const contenido = bloque.name === 'horario_y_ubicacion' ? UBICACION
        : consultar ? await consultar(bloque.name, bloque.input ?? {}).catch(() => ({ error: 'La tienda no respondió.' }))
        : { error: 'Herramienta no disponible.' };
      resultados.push({ type: 'tool_result', tool_use_id: bloque.id, content: JSON.stringify(contenido) });
    }
    mensajes.push({ role: 'user', content: resultados });
  }
  throw new Error('demasiados pasos de herramienta');
}

// Historial y pausa viven en el mismo KV que los eventos, con prefijos propios y vencimiento.
export async function leerHistorial(kv, de) {
  return (await kv.get(`historial:${de}`, 'json')) ?? [];
}
export async function guardarTurno(kv, de, pregunta, respuesta) {
  const historial = [...await leerHistorial(kv, de), { role: 'user', content: pregunta }, { role: 'assistant', content: respuesta }];
  await kv.put(`historial:${de}`, JSON.stringify(historial.slice(-HISTORIAL_MAX)), { expirationTtl: RETENCION });
}
export const estaPausado = async (kv, de) => (await kv.get(`pausado:${de}`)) !== null;
export const pausar = (kv, de) => kv.put(`pausado:${de}`, '1', { expirationTtl: PAUSA_SEGUNDOS });
export const RETENCION_SEGUNDOS = RETENCION;
