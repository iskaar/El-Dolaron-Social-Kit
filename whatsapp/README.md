# WhatsApp — callback de El Dolarón

Callback público: **https://whatsapp.eldolaron.com/webhook**. Worker `el-dolaron-whatsapp`, cuenta `3722419129a69768442e7dd737102387`. Está aislado de caja, inventario y portal; no tiene bindings de esos datos.

## Meta Developers

1. En WhatsApp → Configuration → Webhook, ingresar la URL anterior y el valor de `WHATSAPP_VERIFY_TOKEN` entregado al propietario fuera de git. Pulsar **Verify and save**.
2. En Cloudflare → Workers & Pages → `el-dolaron-whatsapp` → Settings → Variables and Secrets, agregar **META_APP_SECRET** como secreto cifrado. Su valor es el App Secret de la misma aplicación Meta (App settings → Basic); no es el access token ni el verify token. No enviarlo por chat ni guardarlo en git.
3. Suscribir el campo **messages** en Meta y enviar un mensaje de prueba. La suscripción de la aplicación al WhatsApp Business Account también debe estar activa en Meta.

La verificación GET funciona con `WHATSAPP_VERIFY_TOKEN`. POST exige la firma `x-hub-signature-256`, comprobada con `META_APP_SECRET`. Sin App Secret responde 503; no acepta ni confirma mensajes sin autenticar.

## Alcance y retención

Guarda cada evento firmado en el namespace KV privado `el-dolaron-whatsapp-events` durante **7 días** antes de responder 200. No publica números ni mensajes en logs y no tiene API pública para leerlos. Reintentos pueden dejar copias; no se ejecutan acciones de negocio. Es un buzón técnico temporal: **no responde, no envía mensajes y no ofrece bandeja de atención**. Añadir procesamiento antes de depender de él para atención a clientes. Los fallos de guardado responden 503 para permitir reintentos de Meta.

Límite de cuerpo: 1 MiB, comprobado también durante lectura de streams. Solo sirve el host indicado y `/webhook` con GET/POST. No desactivar Cloudflare Access en los hosts de empleados.

## Validar y desplegar

Desde la raíz, con Node 24 y el Wrangler existente de `app/` (sin nuevas dependencias):

```powershell
node --test whatsapp/worker.test.mjs
python tools/validate_assets.py
$wranglerWhatsApp = 'C:\Users\isaac\Claude\Projects\El-Dolaron\app\node_modules\.bin\wrangler.cmd'
& $wranglerWhatsApp deploy --dry-run --config whatsapp/wrangler.jsonc
& $wranglerWhatsApp deploy --config whatsapp/wrangler.jsonc
```

Para cargar secretos, usar la interfaz de Cloudflare o `wrangler secret put WHATSAPP_VERIFY_TOKEN --config whatsapp/wrangler.jsonc` y `wrangler secret put META_APP_SECRET --config whatsapp/wrangler.jsonc` con entrada interactiva. El archivo local `.secrets.json` está ignorado y puede usarse con `deploy --secrets-file`; jamás incluir su contenido en PRs o logs. No declarar obligatorios ambos secretos en config: se permite desplegar la verificación mientras el propietario agrega el App Secret; POST falla cerrado.

Fuentes: [verificación y firmas de Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/), [secretos de Cloudflare](https://developers.cloudflare.com/workers/configuration/secrets/), [retención de KV](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
