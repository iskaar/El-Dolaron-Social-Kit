/**
 * Issue #507: alta de coexistencia del 444 543 7754 (app WhatsApp Business + Cloud API) por el
 * registro integrado de Meta, con redirección de página completa: GET /alta da el enlace al diálogo
 * de Meta y Meta regresa a GET /alta?code=…, donde se canjea el código (vence en 30 s), se suscribe
 * la app a cada cuenta concedida y se muestran sus números.
 *
 * Primero se usó la ventana emergente del JS SDK, pero su código queda atado a un redirect_uri
 * interno de Meta y el canje fallaba siempre («redirect_uri is identical», 24/10). Con redirección
 * el redirect_uri es este mismo, registrado en Facebook Login for Business.
 *
 * Solo funciona con ALTA_CONFIG_ID (no es secreto); sin ella responde 404. `state` en cookie evita
 * que otro sitio haga canjear un código ajeno. El token se usa aquí y se descarta.
 */

export const APP_ID = '1891249878510930';
const GRAPH = 'https://graph.facebook.com/v26.0';
export const REGRESO = 'https://whatsapp.eldolaron.com/alta';

const html = (cuerpo, cabeceras = {}) => new Response(pagina(cuerpo), {
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...cabeceras },
});

export async function atenderAlta(request, env) {
  if (!/^\d+$/.test(env.ALTA_CONFIG_ID ?? '')) return new Response('Not found', { status: 404 });
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  if (!code) {
    const state = crypto.randomUUID();
    const dialogo = `https://www.facebook.com/v26.0/dialog/oauth?${new URLSearchParams({
      client_id: APP_ID, redirect_uri: REGRESO, state, config_id: env.ALTA_CONFIG_ID, response_type: 'code',
      override_default_response_type: 'true',
      extras: JSON.stringify({ setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }),
    })}`;
    const aviso = url.searchParams.has('error') ? `<pre>Meta: ${escapar(url.searchParams.get('error_description') ?? url.searchParams.get('error'))}</pre>` : '';
    return html(`${aviso}<p><a class="boton" href="${escapar(dialogo)}">Empezar alta</a></p>`,
      { 'Set-Cookie': `alta_state=${state}; Path=/alta; Max-Age=900; HttpOnly; Secure; SameSite=Lax` });
  }

  const cookie = /(?:^|;\s*)alta_state=([\w-]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
  if (!cookie || cookie !== url.searchParams.get('state')) return html('<pre>La sesión no coincide. Vuelve a empezar desde /alta.</pre>');
  if (!env.META_APP_SECRET) return html('<pre>Falta META_APP_SECRET.</pre>');
  return html(`<pre>${escapar(JSON.stringify(await canjear(env, code), null, 2))}</pre><p><a href="/alta">Otra vez</a></p>`,
    { 'Set-Cookie': 'alta_state=; Path=/alta; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
}

async function canjear(env, code) {
  const canje = await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({
    client_id: APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: REGRESO, code })}`);
  const respuesta = await canje.json().catch(() => ({}));
  const token = respuesta?.access_token;
  if (!canje.ok || !token) return { error: `canje del código: ${canje.status} ${respuesta?.error?.message ?? ''}`.trim() };
  const auth = { authorization: `Bearer ${token}` };

  // Las cuentas concedidas salen de los permisos del token: la redirección no trae el waba_id.
  const depuracion = await fetch(`${GRAPH}/debug_token?${new URLSearchParams({ input_token: token, access_token: `${APP_ID}|${env.META_APP_SECRET}` })}`);
  const alcances = (await depuracion.json().catch(() => ({})))?.data?.granular_scopes ?? [];
  const cuentas = [];
  for (const id of alcances.find((a) => a.scope === 'whatsapp_business_management')?.target_ids ?? []) {
    // Sin esta suscripción los mensajes del 444 nunca llegan al webhook.
    const suscripcion = await fetch(`${GRAPH}/${id}/subscribed_apps`, { method: 'POST', headers: auth });
    const numeros = await fetch(`${GRAPH}/${id}/phone_numbers?fields=id,display_phone_number,is_on_biz_app,platform_type`, { headers: auth });
    cuentas.push({ waba_id: id, suscrita: suscripcion.ok, numeros: numeros.ok ? (await numeros.json()).data ?? [] : [] });
  }
  return { cuentas };
}

const escapar = (texto) => String(texto).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const pagina = (cuerpo) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alta WhatsApp</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 16px; background: #fff; color: #111; }
  .boton { display: inline-block; padding: .7rem 1.2rem; border-radius: 6px; background: #1877f2; color: #fff; text-decoration: none; }
  pre { white-space: pre-wrap; background: #f3f3f3; padding: 1rem; border-radius: 6px; }
</style>
</head>
<body>
<h1>Alta del 444 543 7754 en Cloud API</h1>
<p>Ten a la mano el teléfono con WhatsApp Business. En Meta escoge el portafolio de El Dolarón,
<strong>conectar tu cuenta existente de la app WhatsApp Business</strong> y sigue el código que llega a la app.</p>
${cuerpo}
</body>
</html>`;
