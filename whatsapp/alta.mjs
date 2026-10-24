/**
 * Issue #507: alta de coexistencia del 444 543 7754 (app WhatsApp Business + Cloud API) por el
 * registro integrado de Meta. GET /alta sirve la página; POST /alta canjea el código de un solo uso
 * (vence en 30 s), suscribe la app a la cuenta nueva y devuelve los IDs de los números. Si el
 * aviso de la ventana de Meta (waba_id) no llegó, las cuentas salen de los permisos del token.
 *
 * Solo funciona con ALTA_CONFIG_ID (configuración de Facebook Login for Business, no es secreto);
 * sin ella responde 404, así que se apaga quitando la variable. El código solo lo emite Meta a un
 * usuario con rol en la app, y canjearlo exige META_APP_SECRET: la página sola no da acceso a nada.
 * El token del canje se usa aquí y se descarta; no se guarda ni sale a logs.
 */

export const APP_ID = '1891249878510930';
const GRAPH = 'https://graph.facebook.com/v26.0';

const json = (datos, status = 200) => new Response(JSON.stringify(datos), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export async function atenderAlta(request, env) {
  if (!/^\d+$/.test(env.ALTA_CONFIG_ID ?? '')) return new Response('Not found', { status: 404 });
  if (request.method === 'GET') {
    return new Response(pagina(env.ALTA_CONFIG_ID), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
  if (!env.META_APP_SECRET) return json({ error: 'sin META_APP_SECRET' }, 503);

  const { code, waba_id: waba } = await request.json().catch(() => ({}));
  if (typeof code !== 'string' || !code || (waba != null && !/^\d+$/.test(String(waba)))) return json({ error: 'falta code' }, 400);

  const canje = await fetch(`${GRAPH}/oauth/access_token?${new URLSearchParams({ client_id: APP_ID, client_secret: env.META_APP_SECRET, code })}`);
  const respuesta = await canje.json().catch(() => ({}));
  const token = respuesta?.access_token;
  if (!canje.ok || !token) return json({ error: `canje del código: ${canje.status} ${respuesta?.error?.message ?? ''}`.trim() }, 502);
  const auth = { authorization: `Bearer ${token}` };

  let wabas = waba ? [String(waba)] : [];
  if (!wabas.length) {
    // Issue #507: el 24/10 la ventana devolvió el código sin el aviso WA_EMBEDDED_SIGNUP.
    const depuracion = await fetch(`${GRAPH}/debug_token?${new URLSearchParams({ input_token: token, access_token: `${APP_ID}|${env.META_APP_SECRET}` })}`);
    const alcances = (await depuracion.json().catch(() => ({})))?.data?.granular_scopes ?? [];
    wabas = alcances.find((a) => a.scope === 'whatsapp_business_management')?.target_ids ?? [];
  }
  const cuentas = [];
  for (const id of wabas) {
    // Sin esta suscripción los mensajes del 444 nunca llegan al webhook.
    const suscripcion = await fetch(`${GRAPH}/${id}/subscribed_apps`, { method: 'POST', headers: auth });
    const numeros = await fetch(`${GRAPH}/${id}/phone_numbers?fields=id,display_phone_number,is_on_biz_app,platform_type`, { headers: auth });
    cuentas.push({ waba_id: id, suscrita: suscripcion.ok, numeros: numeros.ok ? (await numeros.json()).data ?? [] : [] });
  }
  return json({ cuentas });
}

const pagina = (configId) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alta WhatsApp</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 2rem auto; padding: 0 16px; background: #fff; color: #111; }
  button { font: inherit; padding: .7rem 1.2rem; border: 0; border-radius: 6px; background: #1877f2; color: #fff; cursor: pointer; }
  pre { white-space: pre-wrap; background: #f3f3f3; padding: 1rem; border-radius: 6px; }
</style>
</head>
<body>
<h1>Alta del 444 543 7754 en Cloud API</h1>
<p>Ten a la mano el teléfono con WhatsApp Business. En la ventana de Meta escoge el portafolio de El Dolarón,
<strong>conectar tu cuenta existente de la app WhatsApp Business</strong> y sigue el código que llega a la app.</p>
<button id="alta" type="button">Empezar alta</button>
<pre id="estado" aria-live="polite">Esperando.</pre>
<script>
  const estado = document.getElementById('estado');
  const di = (texto) => { estado.textContent = texto; };
  let codigo = null;
  let waba = null;
  async function canjear() {
    if (!codigo) return;
    di('Conectando con el servidor…');
    const r = await fetch('/alta', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codigo, waba_id: waba }) });
    di(JSON.stringify(await r.json(), null, 2));
    codigo = null;
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://www.facebook.com' && e.origin !== 'https://web.facebook.com') return;
    let datos;
    try { datos = JSON.parse(e.data); } catch { return; }
    if (datos?.type !== 'WA_EMBEDDED_SIGNUP') return;
    if (String(datos.event).startsWith('FINISH') && datos.data?.waba_id) waba = datos.data.waba_id;
    else di('Meta: ' + JSON.stringify(datos, null, 2));
  });
  window.fbAsyncInit = () => FB.init({ appId: '${APP_ID}', autoLogAppEvents: true, xfbml: false, version: 'v26.0' });
  document.getElementById('alta').addEventListener('click', () => {
    di('Ventana de Meta abierta…');
    FB.login((respuesta) => {
      if (!respuesta.authResponse?.code) return di('Se cerró la ventana sin terminar.');
      codigo = respuesta.authResponse.code;
      // El aviso con waba_id suele llegar antes; si no llega, el servidor lo saca del token.
      setTimeout(canjear, 1500);
    }, { config_id: '${configId}', response_type: 'code', override_default_response_type: true,
      extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' } });
  });
</script>
<script async defer crossorigin="anonymous" src="https://connect.facebook.net/es_LA/sdk.js"></script>
</body>
</html>`;
