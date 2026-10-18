// Conversaciones de WhatsApp (Issue #287 y #290). El Worker de WhatsApp guarda cada
// mensaje entrante en KV (`event:*`, 7 días). Las respuestas del personal se guardan
// aqui mismo como `saliente:*` (7 días), con quien las envió.
// Meta solo deja escribir libremente dentro de 24 h del último mensaje del cliente.
const VENTANA_MS = 24 * 60 * 60 * 1000;
const RETENCION = 7 * 86400;
const MAXIMO = 200;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
});

export interface Mensaje {
  id: string; sentido: 'entrante' | 'saliente'; de: string; texto: string; tipo: string;
  hora: string; nombre: string; enviado_por: string;
}
export interface Conversacion {
  de: string; nombre: string; ultimo: string; puede_responder: boolean; mensajes: Mensaje[];
}

const claves = async (kv: KVNamespace, prefijo: string) => {
  const lista: { name: string; expiration?: number }[] = [];
  let cursor: string | undefined;
  do {
    const pagina = await kv.list({ prefix: prefijo, limit: 1000, cursor });
    lista.push(...pagina.keys);
    cursor = pagina.list_complete ? undefined : pagina.cursor;
  } while (cursor && lista.length < MAXIMO);
  return lista.slice(0, MAXIMO);
};

const leer = async (kv: KVNamespace, clave: string): Promise<any> => {
  try { const crudo = await kv.get(clave); return crudo ? JSON.parse(crudo) : null; } catch { return null; }
};

/** Todas las conversaciones, de la más reciente a la más antigua. null = sin almacén (sandbox). */
export async function conversaciones(env: Env, ahora = Date.now()): Promise<Conversacion[] | null> {
  const kv = env.WHATSAPP_EVENTOS;
  if (!kv) return null;
  const mensajes: Mensaje[] = [];
  for (const clave of await claves(kv, 'event:')) {
    const evento = await leer(kv, clave.name);
    for (const entrada of evento?.entry ?? []) for (const cambio of entrada?.changes ?? []) {
      if (cambio?.field !== 'messages') continue;
      const nombres = new Map<string, string>((cambio.value?.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? '']));
      for (const m of cambio.value?.messages ?? []) {
        mensajes.push({ id: String(m.id ?? ''), sentido: 'entrante', de: String(m.from ?? ''), tipo: String(m.type ?? ''),
          texto: m.type === 'text' ? String(m.text?.body ?? '').slice(0, 1000) : `[${m.type}]`,
          hora: new Date(Number(m.timestamp) * 1000).toISOString(), nombre: nombres.get(m.from) ?? '', enviado_por: '' });
      }
    }
  }
  for (const clave of await claves(kv, 'saliente:')) {
    const r = await leer(kv, clave.name);
    if (r?.id && r?.para) mensajes.push({ id: String(r.id), sentido: 'saliente', de: String(r.para), tipo: 'text',
      texto: String(r.texto ?? ''), hora: String(r.creado ?? ''), nombre: '', enviado_por: String(r.enviado_por ?? '') });
  }
  const porCliente = new Map<string, Mensaje[]>();
  for (const m of mensajes) porCliente.set(m.de, [...(porCliente.get(m.de) ?? []), m]);
  return [...porCliente.entries()].map(([de, lista]) => {
    lista.sort((a, b) => a.hora.localeCompare(b.hora));
    const ultimoEntrante = [...lista].reverse().find((m) => m.sentido === 'entrante');
    return {
      de,
      nombre: lista.map((m) => m.nombre).find(Boolean) ?? '',
      ultimo: lista[lista.length - 1].hora,
      puede_responder: !!ultimoEntrante && ahora - Date.parse(ultimoEntrante.hora) < VENTANA_MS,
      mensajes: lista,
    };
  }).sort((a, b) => b.ultimo.localeCompare(a.ultimo));
}

export async function mensajesApi(env: Env): Promise<Response> {
  const lista = await conversaciones(env);
  if (!lista) return json({ error: 'Los mensajes de WhatsApp no están conectados en esta instancia.' }, 503);
  return json({ conversaciones: lista });
}

/** Responde a un cliente dentro de la ventana de 24 h. Nunca registra el texto en logs. */
export async function responderApi(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = await request.json().catch(() => ({})) as { de?: unknown; texto?: unknown };
  const de = String(cuerpo.de ?? '');
  const texto = String(cuerpo.texto ?? '').trim();
  if (!/^\d{8,15}$/.test(de)) return json({ error: 'Número de cliente inválido.' }, 400);
  if (!texto || texto.length > 1000) return json({ error: 'El mensaje debe tener entre 1 y 1000 caracteres.' }, 400);
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_EVENTOS)
    return json({ error: 'El envío de WhatsApp no está configurado en esta instancia.' }, 503);

  const lista = await conversaciones(env);
  const conversacion = lista?.find((c) => c.de === de);
  if (!conversacion?.puede_responder)
    return json({ error: 'Fuera de la ventana de 24 h: el cliente tiene que escribir primero.' }, 409);

  const envio = await fetch(`https://graph.facebook.com/v26.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: de, type: 'text', text: { body: texto } }),
  });
  if (!envio.ok) {
    console.error(JSON.stringify({ event: 'whatsapp_envio_personal_fallo', status: envio.status }));
    return json({ error: 'No se pudo enviar el mensaje. Intenta de nuevo.' }, 502);
  }
  const id = String((await envio.json().catch(() => ({})) as any)?.messages?.[0]?.id ?? crypto.randomUUID());
  await env.WHATSAPP_EVENTOS.put(`saliente:${id}`,
    JSON.stringify({ id, para: de, texto, enviado_por: correo, creado: new Date().toISOString() }),
    { expirationTtl: RETENCION });
  return json({ id }, 201);
}
