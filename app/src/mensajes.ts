// Mensajes de WhatsApp recibidos (Issue #287), solo lectura para el dueño.
// El Worker de WhatsApp guarda cada evento de Meta en KV con vencimiento de 7 días;
// aqui se leen esas copias y se muestran solo los mensajes de texto e imagenes entrantes.
const MAXIMO = 200;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
});

export interface Mensaje {
  id: string; de: string; nombre: string; tipo: string; texto: string; recibido: string; vence: string | null;
}

/** null = el almacen de WhatsApp no esta configurado en esta instancia (p. ej. el sandbox). */
export async function listarMensajes(env: Env): Promise<Mensaje[] | null> {
  const kv = env.WHATSAPP_EVENTOS;
  if (!kv) return null;
  // ponytail: recorre hasta MAXIMO eventos sin indice; con 7 dias de retencion el volumen es chico.
  const claves: { name: string; expiration?: number }[] = [];
  let cursor: string | undefined;
  do {
    const pagina = await kv.list({ prefix: 'event:', limit: 1000, cursor });
    claves.push(...pagina.keys);
    cursor = pagina.list_complete ? undefined : pagina.cursor;
  } while (cursor && claves.length < MAXIMO);

  const eventos = await Promise.all(claves.slice(0, MAXIMO).map(async (clave) => {
    const crudo = await kv.get(clave.name);
    let evento: any = null;
    try { evento = crudo ? JSON.parse(crudo) : null; } catch { evento = null; }
    return { clave, evento };
  }));

  const mensajes: Mensaje[] = [];
  for (const { clave, evento } of eventos) {
    for (const entrada of evento?.entry ?? []) {
      for (const cambio of entrada?.changes ?? []) {
        if (cambio?.field !== 'messages') continue;
        const nombres = new Map<string, string>((cambio.value?.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name ?? '']));
        for (const m of cambio.value?.messages ?? []) {
          const texto = m.type === 'text' ? String(m.text?.body ?? '') : `[${m.type}]`;
          mensajes.push({
            id: String(m.id ?? ''), de: String(m.from ?? ''), nombre: nombres.get(m.from) ?? '',
            tipo: String(m.type ?? ''), texto: texto.slice(0, 1000),
            recibido: new Date(Number(m.timestamp) * 1000).toISOString(),
            vence: clave.expiration ? new Date(clave.expiration * 1000).toISOString() : null,
          });
        }
      }
    }
  }
  return mensajes.sort((a, b) => b.recibido.localeCompare(a.recibido)).slice(0, MAXIMO);
}

export async function mensajesApi(env: Env): Promise<Response> {
  const mensajes = await listarMensajes(env);
  if (!mensajes) return json({ error: 'Los mensajes de WhatsApp no están conectados en esta instancia.' }, 503);
  return json({ mensajes });
}
