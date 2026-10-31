# Sitio público de El Dolarón

HTML y assets estáticos en `public/`, servidos por el Worker `el-dolaron-web` mediante [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/get-started/). Reutiliza Wrangler de `app/`; no requiere instalar dependencias ni compilar.

Para datos de contacto y condiciones vigentes, prioriza `app/src/legal.ts` sobre el plan histórico de marketing. WhatsApp: **444 543 7754**; teléfono fijo: **444 854 5980**. El monedero existente está en https://dolarones.eldolaron.com/.

## Secciones

- **Lo nuevo en tienda** (`#catalogo`, `catalogo.js`): consume `GET https://dolarones.eldolaron.com/api/catalogo?categoria=<clave>&q=<texto>&despues=<cursor>` (precios en centavos; CORS permite https://eldolaron.com), permite buscar en todo el catálogo vendible y abrir cada foto completa en un diálogo accesible. Las categorías son una copia de `app/public/categorias.js`; si cambian allá, actualiza la constante en `catalogo.js`. Si la API falla o aún no está desplegada, la sección muestra un aviso con enlaces a los grupos y al WhatsApp. Para probar en local con otra API: `?api=http://127.0.0.1:8787` (solo acepta http(s) hacia localhost, 127.0.0.1 o [::1]). Prueba de la lógica: `node tools/check_site_catalogo.cjs`.
- **Los más buscados** (`#buscados`, `catalogo.js`): tarjetas grandes (`.wanted-item`) con lo de mayor precio que sigue a la venta (`GET /api/catalogo/destacados?orden=precio`). Se oculta si la API falla o trae menos de 3 piezas con foto; `¡Última pieza!` lo decide el servidor. En celular es una fila deslizable.
- **Ropa americana** (`#ropa`): escalera de precios en Anton ($50, $80, $100, $150 y $200 «y mucho más»). Si cambian, edita `index.html`.
- **Grupos de WhatsApp** (`#grupos`): enlaces a `https://eldolaron.com/ropa` y `https://eldolaron.com/general`, redirecciones existentes a las invitaciones.
- **Vista previa al compartir**: etiquetas Open Graph y Twitter en `index.html`; imagen 1200×630 en `assets/el-dolaron-compartir-v2.jpg`, hecha con `site/compartir-fuente.html` (captura de Chrome a 1200×630; lleva su propia cinta y la fuente Rye, y por eso se conservan `assets/cartel-se-busca.webp` y `assets/fonts/rye-400.woff2` aunque el sitio ya no los use). Si cambia la imagen, cambia también el nombre del archivo: WhatsApp y Facebook guardan la vista previa por URL. Tras publicar, refresca la caché con el depurador de enlaces de Facebook. También incluye `assets/apple-touch-icon.png`.
- **Privacidad del agente de WhatsApp**: `politica-de-privacidad.html`, URL canónica `https://eldolaron.com/politica-de-privacidad`. Todo el texto está en HTML sin JavaScript ni sesión. La sección `#eliminacion-de-datos` explica solicitudes manuales por correo o WhatsApp; no es un callback de borrado automático. Conserva el aviso aprobado de Dolarones en `app/src/legal.ts` como documento separado. Antes de publicar, confirmar el proveedor de IA y las prácticas de conservación del agente. Después del deploy, comprobar que Meta puede leer la URL pública sin login ni challenge y registrar la URL en su panel; este cambio no verifica el dominio ni el negocio.

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

### Deploy automático

Desde el Issue #531, cada push a `main` que toque `site/**` (y cada lunes, para rotar la pila) publica el sitio solo con `.github/workflows/deploy-sitio.yml` (`wrangler deploy --config site/wrangler.jsonc`, con el Wrangler del lockfile de `app/`). También se lanza a mano con `gh workflow run deploy-sitio.yml`. El comando manual de arriba queda como respaldo. Si falta el secreto, el workflow falla con un mensaje claro.

## Pila semanal

`tools/pila_stickers.py` genera la pila de stickers de la portada (`public/assets/pila.webp`, `pila-640.webp` y `pila.json`) a partir de los recortes del catálogo público; la misma semana ISO produce la misma pila. `deploy-sitio.yml` la regenera en el runner en cada deploy: **cada lunes a las 06:00 UTC**, en cada push a `main` bajo `site/**` y en cada ejecución manual. Luego valida (`validate_assets.py` y `validate_site.py`) y despliega. Los archivos generados no se commitean ni abren PRs: la pila que está en el repo es solo la base y el respaldo (si el script falla, el workflow avisa con un `::warning::` y publica esa), y el sitio en vivo siempre lleva la pila de la semana ISO actual. Como el script es determinista por semana, un deploy a mitad de semana reproduce la pila del lunes.

Para refrescar la pila a mano:

```powershell
gh workflow run deploy-sitio.yml
```

Para actualizar la base commiteada, corre `python tools/pila_stickers.py` en local y abre un PR normal.

### Token de Cloudflare (lo hace Isaac, una sola vez)

1. Cloudflare dashboard → My Profile → API Tokens → Create Token → plantilla **Edit Cloudflare Workers**, limitada a la cuenta de El Dolarón (Cloudflare no permite limitarlo a un solo Worker).
2. GitHub → repo → Settings → Secrets and variables → Actions → New repository secret: nombre `CLOUDFLARE_API_TOKEN`, valor el token.
El repo nunca guarda el token: vive solo como secreto de GitHub. `deploy-sitio.yml` es la única automatización de publicación autorizada; ampliarla requiere permiso nuevo de Isaac.
