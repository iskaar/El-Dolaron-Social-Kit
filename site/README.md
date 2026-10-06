# Sitio público de El Dolarón

HTML y assets estáticos en `public/`, servidos por el Worker `el-dolaron-web` mediante [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/get-started/). Reutiliza Wrangler de `app/`; no requiere instalar dependencias ni compilar.

Para datos de contacto y condiciones vigentes, prioriza `app/src/legal.ts` sobre el plan histórico de marketing. WhatsApp: **444 543 7754**; teléfono fijo: **444 854 5980**. El monedero existente está en https://dolarones.eldolaron.com/.

## Revisar y publicar

Desde la raíz del checkout que contiene `site/`, usa el Wrangler instalado en `app/node_modules/`. Si trabajas en un worktree sin dependencias, apunta al ejecutable del checkout original:

```powershell
$wranglerSitio = 'C:\Users\isaac\Claude\Projects\El-Dolaron\app\node_modules\.bin\wrangler.cmd'
python tools/validate_assets.py
& $wranglerSitio deploy --dry-run --config site/wrangler.jsonc
```

Revisa el sitio en escritorio y móvil, sus enlaces y navegación por teclado. Antes de publicar, el PR del Issue #178 debe tener revisión y CI verde.

El propietario confirmó **eldolaron.com** para producción. `wrangler.jsonc` fija ese dominio con `custom_domain: true` y la cuenta Cloudflare verificada `3722419129a69768442e7dd737102387`. La zona está activa y no tenía otra asignación de Workers en la revisión previa. `workers_dev` y las URLs de preview están desactivados.

Con la revisión completada, CI verde y autorización de publicación, repite el dry-run y despliega únicamente este sitio:

```powershell
& $wranglerSitio deploy --config site/wrangler.jsonc
```

Verifica HTTPS, portada, assets y enlaces al WhatsApp y al monedero en el dominio publicado. La configuración del sitio no comparte rutas, bases ni permisos con la aplicación de caja.
