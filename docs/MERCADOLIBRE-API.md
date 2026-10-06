# API de Mercado Libre (MLM, México): investigación para integrar El Dolarón

Fecha de la investigación: 2026-10-04. Fuente principal: documentación oficial `developers.mercadolibre.com.mx/es_ar/<slug>` (cada página trae su fecha de "Última actualización"). Para consultas de datos reales se usaron endpoints públicos de `api.mercadolibre.com` sin token. No se creó cuenta, app ni se usaron credenciales.

Convenciones de confianza:
- **[OFICIAL]** leído en doc oficial o en respuesta real de la API.
- **[3ROS]** solo lo dicen blogs/terceros; verificar antes de decidir.
- **[NO CONFIRMADO]** no se encontró en fuentes oficiales o la doc se contradice.

Nota de acceso: `WebFetch` recibe 403 de `developers.mercadolibre.*`; con `curl`/Python y un User-Agent de navegador responde 200 (es HTML renderizado en servidor).

---

## 0. Resumen ejecutivo para el ingeniero

1. Flujo OAuth 2.0 Authorization Code (servidor), `offline_access` para refresh token. El refresh token es **de un solo uso**: hay que guardarlo de forma atómica en D1 y serializar los refresh (si se pierde uno, el dueño debe reautorizar).
2. Modelo de publicación: Mercado Libre migró a **User Products (UP)**. Cuando el vendedor tiene el tag `user_product_seller` el `POST /items` ya **no lleva `title` ni `variations`**; lleva `family_name` y ML construye el título. Hay que leer el tag del vendedor con `GET /users/me` y soportar ese camino como principal.
3. Moda: **`SIZE_GRID_ID` + `SIZE_GRID_ROW_ID` (guía de tallas) es obligatoria** en dominios de moda. Para prendas superiores/inferiores (TOPS and BOTTOMS) solo sirven guías propias del vendedor (tipo `SPECIFIC`). Conviene que el dueño cree unas pocas guías genéricas una vez.
4. Fotos: se pueden subir con `POST /pictures/items/upload` (multipart) desde el Worker leyendo de R2; **no hace falta URL pública**.
5. Notificaciones: POST a un callback público; hay que responder 200 en menos de 500 ms. **No hay firma/HMAC documentada**, así que la validación es: lista de IPs de ML + re-consultar el recurso con el token + path secreto.
6. No existe sandbox: se prueba en producción con usuarios de test (máx. 10, solo entre ellos).
7. Comisión oficial en MX: Clásica 8%-17%, Premium 11%-21.5%, más cargo fijo en artículos baratos (ver sección 8). Precio mínimo por publicación: 35 MXN.
8. Riesgo grande para el giro: marcas de publicación limitada (Nike, Adidas, Reebok en México) solo se pueden vender como Tienda Oficial o vendedor acreditado.

---

## 1. App y OAuth 2.0

### Crear la app [OFICIAL]
Fuente: https://developers.mercadolibre.com.mx/es_ar/crea-una-aplicacion-en-mercado-libre-es (act. 06/08/2026), https://developers.mercadolibre.com.mx/es_ar/permisos-funcionales

- Se crea en el DevCenter ("Mis aplicaciones" de México), con la cuenta del **propietario de la solución**; recomiendan que la cuenta esté bajo una entidad legal. Entrega `Client ID` (APP ID) y `Client Secret`.
- En México (también AR, BR, CL) solo se puede crear la app tras incluir y validar los datos del titular de la cuenta, que deben coincidir exactamente con los de la cuenta.
- Campos: nombre único, descripción (150 caracteres, se muestra al pedir autorización), logo, URIs de redirect, PKCE (opcional, recomendado), Device Grant, scopes, tópicos y "Notificaciones callbacks URL".
- **Aviso con fecha vencida**: desde el 30/08/2026 las apps deben estar separadas por unidad (una app para Mercado Libre, otra para Mercado Pago); las que tengan scopes `urn:mp:...` mezclados pierden acceso a las APIs de ML. Crear la app solo con scopes de ML. Verificable con `GET /applications/$APP_ID`.
- Client Secret: se puede renovar "ahora" o programado (hasta 7 días, conviven dos secretos). **Renovarlo invalida los access tokens existentes.**

### Redirect URI [OFICIAL salvo localhost]
- **HTTPS es obligatorio** al crear la app.
- Debe coincidir **exactamente** con el registrado y **no puede llevar información variable** (usar el parámetro `state` para datos dinámicos). Se registra "la raíz del dominio"; en la práctica usar una ruta fija, p. ej. `https://<host>/api/ml/callback`.
- `localhost` / `http://`: **[NO CONFIRMADO]** la doc no lo menciona; por la regla HTTPS asumir que no. Para desarrollo usar el dominio de sandbox (`sandbox.viste.com.mx`) o un túnel HTTPS.

### Flujo [OFICIAL]
Fuente: https://developers.mercadolibre.com.mx/es_ar/autenticacion-y-autorizacion (act. 15/07/2026)

1. Redirigir al vendedor a (dominio de México):
   `https://auth.mercadolibre.com.mx/authorization?response_type=code&client_id=$APP_ID&redirect_uri=$URI&state=$STATE` (+ `code_challenge` y `code_challenge_method=S256` si la app tiene PKCE).
   La doc muestra el dominio `.com.ar` y dice cambiar al del país; `.com.mx` es el de México.
2. El usuario debe iniciar sesión como **administrador/cuenta principal**; un operador/colaborador da `invalid_operator_user_id`.
3. Vuelve a `redirect_uri?code=...&state=...`. Validar `state`.
4. `POST https://api.mercadolibre.com/oauth/token` con `Content-Type: application/x-www-form-urlencoded` (la doc usa form body, no JSON).

### Token y refresh [OFICIAL con una contradicción]
- Access token: respuesta trae `"expires_in": 10800` (3 horas), pero el texto de la misma página dice "6 horas". **Contradicción; usar `expires_in` de la respuesta y renovar con margen.**
- Refresh token: **un solo uso**, solo se acepta el último emitido, y solo para el `client_id` que lo generó. Vigencia **6 meses**.
- Un access token puede invalidarse antes: cambio de contraseña del usuario, renovar Client Secret, usuario revoca permisos, **o 4 meses sin usar la app** contra `api.mercadolibre.com`.
- Recomendación de ML: renovar solo cuando el token pierda validez.
- Errores: `invalid_grant` (code/refresh inválido, usado, expirado o `redirect_uri` distinto), `invalid_client`, `invalid_scope`, `invalid_request`, `unauthorized_client`, `unauthorized_application`, `forbidden` 403, `local_rate_limited` 429.
- Implicación para Workers/D1: guardar `access_token`, `refresh_token`, `expires_at` en una fila; refrescar bajo bloqueo (UPDATE condicional por versión o un Durable Object) para que dos requests concurrentes no quemen el mismo refresh token.

### PKCE [OFICIAL]
Es **opcional por app** (casilla "Use PKCE"). Si está activada, `code_challenge` y `code_verifier` pasan a ser obligatorios. Métodos: `S256` (recomendado) y `plain`.

### Scopes [OFICIAL]
`read` (GET), `write` (PUT/POST/DELETE) y `offline_access` (entrega refresh token). Se configuran en la app (la URL de autorización de la doc no lleva parámetro `scope`). La respuesta devuelve `"scope": "offline_access read write"`. Valores permitidos en `invalid_scope`: `offline_access`, `write`, `read`.

### user_id del vendedor [OFICIAL]
Viene en la respuesta del token (`user_id`) y también en `GET /users/me`. Ese mismo `GET /users/me` trae `tags`; buscar `user_product_seller`.

Enviar el token en header: `Authorization: Bearer <access_token>`.

---

## 2. Publicar un artículo

Fuentes: https://developers.mercadolibre.com.mx/es_ar/publica-productos (act. 09/01/2026), https://developers.mercadolibre.com.mx/es_ar/precio-variacion (act. 13/08/2026), https://developers.mercadolibre.com.mx/es_ar/user-products (act. 17/06/2026).

### Campos de `POST /items` [OFICIAL]
| Campo | Notas |
|---|---|
| `family_name` | **Modelo UP**: obligatorio; descripción genérica del grupo, longitud <= `max_title_length` del dominio (60 en las categorías de MLM revisadas). |
| `title` | **Solo modelo legacy.** Con UP "no debe ser enviado", ML lo genera con dominio, atributos y `family_name`. Máx. 60 caracteres (`settings.max_title_length` de la categoría). Sin signos de puntuación, sin mencionar stock, envío, estado ni color si hay variantes. |
| `category_id` | De `domain_discovery` (sección 3). |
| `price` | Número en **pesos** (p. ej. `899.00`), no centavos. Convertir desde centavos de D1. Mínimo 35 MXN (`minimum_price`). |
| `currency_id` | `MXN` (la categoría acepta `MXN` y `USD`). |
| `available_quantity` | Stock. Con 0 el ítem queda `paused` / `out_of_stock`. |
| `buying_mode` | `buy_it_now`. |
| `condition` | `new` / `used` / `not_specified`. **Deprecándose**: la doc pide usar el atributo `ITEM_CONDITION` (`2230284` Nuevo, `2230581` Usado; en esa categoría solo esos dos). Enviar ambos mientras `condition` siga vigente. |
| `listing_type_id` | Ver abajo. |
| `pictures` | `[{ "source": "https://..." }]` o `[{ "id": "<picture_id>" }]` tras subir por multipart. |
| `attributes` | Array `{id, value_id?, value_name}`. N/A: `value_id: "-1"`, `value_name: null` (no permitido en atributos `allow_variations`). |
| `sale_terms` | Garantía: `WARRANTY_TYPE` ("Garantía del vendedor", id `2230280`) y `WARRANTY_TIME` ("90 días"). Obligatoria para "reacondicionado" (>= 90 días); para nuevo/usado en ropa no se vio como requerida. |
| `shipping` | `mode`, `local_pick_up`, `free_shipping`, `dimensions` (solo ME1). Ver sección 7. |
| `catalog_listing` | `false` salvo publicación de catálogo. |
| `channels` | Reemplaza a `exclusive_channel` (eliminado; mandar `exclusive_channel` da error). |
| `description` | Aceptado en el POST como `{ "plain_text": "..." }` en ejemplos de la doc, pero la guía de descripciones recomienda crearla después con su endpoint. Ver abajo. |

### listing_type_id en MLM
- Tipos genéricos que ML documenta para marketplace: `free`, `gold_special`, `gold_pro` ("puede variar según el sitio"). En la doc, `gold_special` = **Clásica**, `gold_pro` = **Premium** (la renomenclatura en front es solo para Argentina).
- Consultar los realmente disponibles: `GET /users/$USER_ID/available_listing_types?category_id=$CAT` (requiere token). `GET /sites/MLM/listing_types` devolvió 403 sin token. **[NO CONFIRMADO]** la lista exacta de MLM.
- `free` (gratuita): según la ayuda oficial de México (https://www.mercadolibre.com.mx/ayuda/costos-de-vender-un-producto_870, leída 2026-10-04): dura 60 días, exposición baja, sin meses sin intereses, máx. 10 publicaciones gratuitas simultáneas con stock máx. 1, hasta 5 ventas al año de producto nuevo (20 si usado). No se puede hacer downgrade a `free`.
- `gold_special` y `gold_pro` duran de forma ilimitada y se pueden cambiar entre sí sin cargo (`POST /items/$ID/listing_type {"id":"gold_special"}`). Las pruebas no deben usar `gold` ni `gold_premium`.
- Mercado Pago es obligatorio para productos nuevos en MLM (`immediate_payment` `required` en las categorías revisadas).

### User Products (UP) y qué significa para un vendedor simple [OFICIAL]
- Un **ítem** es la publicación; un **User Product** es el producto físico específico (a nivel de variante); una **familia** agrupa UPs que comparten `family_name`, dominio, vendedor y atributos `PARENT_PK`.
- Activación gradual desde oct. 2024 hasta 100% de vendedores en 2025; vendedores activados tienen el tag **`user_product_seller`** en `/users`. Tras activarse, publicar con el modelo anterior (`title` + `variations`) da **error 400**.
- Con UP: `title` y `variations` desaparecen; no se pueden crear variaciones por POST/PUT. Cada color/talla es un ítem distinto con el mismo `family_name`; ML crea `user_product_id` y `family_id` solos. Máx. 30 condiciones de venta (ítems) por UP.
- Edición de campos de UP (`title`, `family_name`, `attributes`, `pictures`, `domain_id`, `condition`, `available_quantity`...) en un ítem se **replica asíncronamente** a todos los ítems del mismo UP.
- `family_name` solo se puede cambiar si ninguna condición de venta del UP tiene ventas.
- Para una tienda de piezas únicas (stock 1, una foto por pieza) esto es simple: **un POST por pieza**, con `family_name` y atributos `COLOR`/`SIZE` propios; ML decide si agrupa. No hace falta modelar variaciones. `[NO CONFIRMADO]` si MLM del dueño ya tiene el tag; leerlo en `GET /users/me` y tener ambos caminos, o solo el UP si ya está activo (la doc dice que ya no se puede publicar legacy tras activarse).
- Probar UP en usuarios de test requiere pedir "ambientación" por formulario de ML (se activa cada 7 días).

### Descripción [OFICIAL]
Fuente: https://developers.mercadolibre.com.mx/es_ar/descripcion-de-articulos (act. 13/03/2026)
- Primero crear el ítem con atributos completos; luego `POST /items/$ITEM_ID/description` con `{"plain_text":"..."}`. **Solo texto plano**; saltos de línea con `\n`; sin HTML, emojis ni `<`/`>` (error `item.description.type.invalid`, con `api_version=2` en PUT devuelve la posición del carácter).
- Si ya existe descripción, el POST da bad request: usar `PUT /items/$ITEM_ID/description?api_version=2`.
- Máx. 50,000 caracteres (`max_description_length`, visto en categoría "Otros" de la doc).

### Validar antes de publicar [OFICIAL]
`POST /items/validate` con el mismo JSON: devuelve errores de forma/atributos sin crear el ítem. Úsalo antes de cada alta nueva (https://developers.mercadolibre.com.mx/es_ar/validador-de-publicaciones).

---

## 3. Categorías, predicción y atributos requeridos

### Predictor [OFICIAL + probado]
`GET https://api.mercadolibre.com/sites/MLM/domain_discovery/search?q=<título>&limit=3` (doc: `limit` por defecto 4, máx. 8; `q` en español). **Funciona sin token** (probado). Devuelve lista ordenada con `domain_id`, `category_id`, `category_name`, `attributes[]` (BRAND/MODEL cuando los detecta). Ejemplos reales obtenidos:

| Consulta | domain_id | category_id (1ra) |
|---|---|---|
| jeans levis hombre 501 | MLM-PANTS | MLM194175 Pantalones |
| vestido mujer verano | MLM-DRESSES | MLM112156 Vestidos |
| sudadera hoodie nike | MLM-SWEATSHIRTS_AND_HOODIES | MLM115350 Sudaderas y Hoodies |
| licuadora oster | MLM-BLENDERS | MLM21171 Licuadoras |
| juguete lego set | MLM-TOY_BUILDING_SETS | MLM191712 Bloques y Figuras para Armar |
| funda iphone 15 | MLM-CELLPHONE_CASES_AND_COVERS | MLM167442 Fundas y Carcasas |
| sarten antiadherente | MLM-FRYING_PANS_WOKS_GRIDDLES_AND_GRILL_PANS | MLM118812 Sartenes |

Observaciones: una misma `domain_id` puede traer varias `category_id`; ML advierte que elegir una categoría distinta a la recomendada puede causar moderación. Recomendación práctica: mapear una vez cada una de las ~12 categorías internas del negocio a una categoría hoja de ML y usar el predictor solo como sugerencia/validación.

### Atributos requeridos [OFICIAL + probado]
`GET /categories/{id}/attributes` (**funciona sin token**, probado). Tags relevantes (doc: https://developers.mercadolibre.com.mx/es_ar/atributos, act. 08/06/2026):
- `required`: obligatorio para publicar.
- `catalog_required`: obligatorio para publicación de catálogo/ficha (en la práctica ML lo marca junto con `required` en estas categorías).
- `new_required`: obligatorio si la condición es nueva.
- `conditional_required`: depende del ítem; consultar con `POST /categories/{id}/attributes/conditional` enviando el ítem completo (solo AR, BR, MX). Respuesta `{required_attributes: []}`.
- `allow_variations`, `variation_attribute`, `defines_picture`, `hidden`, `read_only` (no editable), `fixed` (valor fijo que ML completa), `multivalued`.
- Atributos nuevos en `technical_specs/input` marcados `required` solo afectan exposición (tag `incomplete_technical_specs`), no bloquean la publicación.

### Qué piden las categorías de ropa de MLM (datos reales, 2026-10-04)
| Atributo | Playeras MLM194178 | Pantalones MLM194175 | Sudaderas MLM115350 |
|---|---|---|---|
| BRAND | required | required | required |
| MODEL | required | required | required |
| GENDER | required, `grid_template_required` | idem | idem |
| COLOR | required, allow_variations | idem | idem |
| SIZE | required, allow_variations | idem | idem |
| GARMENT_TYPE | required | - | required |
| MAIN_MATERIAL | - | required | required |
| PANT_TYPE | - | required | - |
| IS_SPORTIVE | - | - | required |
| GTIN | conditional_required | - | conditional_required |
| EMPTY_GTIN_REASON | conditional_required | conditional_required | conditional_required |
| SIZE_GRID_ID | (ver abajo) | idem | idem |

Los valores de `GENDER`: Mujer `339665`, Hombre `339666`, Niñas `339668`, Niños `339667`, Bebés `371795`, Sin género `110461`, Sin género infantil `19159491`. El título no debe contradecir el género (validación que bloquea).
`EMPTY_GTIN_REASON` (cuando no hay código de barras): `17055158` pieza artesanal, `17055159` kit/pack, `17055160` "El producto no tiene código registrado", `17055161` otra razón. Para ropa americana nueva sin GTIN usar `17055160`; **[NO CONFIRMADO]** que ML lo acepte para todas las marcas.
Categorías no moda (hogar, juguetes, accesorios): requieren `BRAND`, `MODEL` y un atributo específico (p. ej. `PRODUCT_TYPE` en sartenes); `COLOR` opcional.
`MODEL` es obligatorio: si una prenda de marca no tiene modelo, la doc permite N/A (`value_id:"-1"`, `value_name:null`) en atributos que no sean `allow_variations`. **[NO CONFIRMADO]** que `MODEL` acepte N/A en ropa.

Ajustes de categoría (`GET /categories/{id}`, también público): `max_title_length` 60, `max_pictures_per_item` 12, `max_pictures_per_item_var` 10, `minimum_price` 35 MXN, `item_conditions` `new/used/not_specified`, `buying_modes` `buy_it_now/auction`, `immediate_payment` `required`, `max_variations_allowed` 100 (legacy).

### Guías de tallas (size charts) [OFICIAL]
Fuentes: https://developers.mercadolibre.com.mx/es_ar/guias-de-talles (act. 09/07/2026), https://developers.mercadolibre.com.mx/es_ar/validacion-de-guia-de-talles
- **Obligatoria en dominios de moda**: "Ítems de moda siempre deben ser publicados con la guía de talles asociada" (buenas prácticas) y la doc de validación: "Para algunos dominios de la vertical de Fashion, es obligatorio asociar una guía". La señal en la API es el tag `grid_template_required` en `GENDER` (presente en las 3 categorías de ropa revisadas).
- Se asocia por atributos del ítem: `SIZE_GRID_ID` = id de la guía; `SIZE_GRID_ROW_ID` = id de la fila (formato `<id_guía>:<n>`, p. ej. `26008:1`); `SIZE` debe coincidir con el talle de esa fila.
- Errores bloqueantes si falta/está mal: `missing.fashion_grid.grid_id.values` (2610), `...grid_row_id.values` (2611), `...size.values` (2612), `invalid.fashion_grid.grid_id.values` (2613, p. ej. guía de otra categoría), `invalid...grid_row_id` (2614), guía ajena al vendedor (2617). Avisos: `SIZE` o `GENDER` no coherentes con la guía (2615, 2616).
- Tipos de guía: `BRAND` (de marca), `STANDARD` (estándar ML), `SPECIFIC` (propia del vendedor). **En dominios TOPS and BOTTOMS (pantalones, camisas, vestidos, etc.) solo se puede usar `SPECIFIC`**. Calzado puede usar las tres.
- Crear: `POST /catalog/charts` (token del mismo site; `domain_id` **sin prefijo de sitio**, p. ej. `SHIRTS`, no `MLM-SHIRTS`; `names` máx. 60 caracteres sin `,` ni `-`; `GENDER` y `BRAND` van a nivel de guía, no por fila; cada fila necesita el atributo principal (`main_attribute_candidate`) y sus `required`). Para atributos tipo `number_unit` incluir `struct`. Primero consultar la ficha técnica de grids: `GET /domains/$DOMAIN/technical_specs?section=grids`.
- Una guía creada **no se puede borrar**; solo se edita el nombre y se pueden añadir filas (no editar el talle principal ni las filas existentes salvo datos extra). Si hay error en talle principal o género, hay que crear otra.
- Consultar: `GET /catalog/charts/$CHART_ID`. **[NO CONFIRMADO]** endpoint para listar/buscar guías del vendedor (no aparece en las páginas leídas; revisar la doc antes de asumir). Guardar en D1 el `chart_id` por (dominio, género).
- Implicación: el dueño debe definir la guía (tallas y medidas) por tipo de prenda y género, o aceptar guías mínimas. Para pieza única con stock 1, la talla de la pieza se mapea a la fila de la guía.

---

## 4. Fotos

Fuentes: https://developers.mercadolibre.com.mx/es_ar/trabajar-con-imagenes (act. 24/03/2026), https://developers.mercadolibre.com.mx/es_ar/diagnostico-imagenes (act. 29/12/2025), https://developers.mercadolibre.com.mx/es_ar/moderaciones-de-imagenes.

- Formatos JPG/JPEG/PNG; hasta 10 MB; recomendado 1200x1200 px; **mínimo 500x500 px** (error `cause_id 509`: "below the minimum allowed size"); máx. 1920x1920 (se reduce). Más de 800 px de ancho activa zoom (recomendado para moda). RGB mejor que CMYK; el producto debe ocupar ~95% del encuadre.
- Máx. por publicación: `max_pictures_per_item` = 12 (10 por variante en legacy) en las categorías revisadas. La doc de publicar dice "hasta seis"; prevalece el valor por categoría.
- Fondo blanco: la API de diagnóstico de imágenes valida `white_background`, `minimum_size`, `text_logo` y `watermark` "según corresponda por categoría", con el mensaje "El fondo de tu foto debe ser blanco digitalizado". **[NO CONFIRMADO]** si la foto de portada de moda en MLM exige fondo blanco (blogs lo afirman: [3ROS]). Usar `POST /moderations/pictures/diagnostic` (acepta URL, base64 o picture_id, con `category_id` en `context`) antes de asociar. Sin logos, textos ni marcas de agua.
- Una sola foto por pieza es técnicamente válida (mínimo de la doc: al menos una imagen para `gold_special/gold_pro`: `requires_picture: true`; desde 12/03/2026 las actualizaciones sin imágenes se rechazan con 400).

### Cómo subirlas desde un Worker [OFICIAL]
1. **Por URL (`pictures:[{"source":"https://..."}]`)**: ML descarga la imagen. Requisitos: URL pública, **sin redirecciones**, certificado válido (si falla, sugieren HTTP), content-type correcto, servidor rápido. Si el host filtra por IP, permitir las IPs de ML: `216.33.196.4`, `216.33.196.25`, `54.88.218.97`, `18.215.140.160`, `18.213.114.129`, `18.206.34.84`. No sirve con R2 detrás de auth.
2. **Multipart `POST https://api.mercadolibre.com/pictures/items/upload`** con `Authorization` y campo `file`. "El endpoint solo soporta subidas multipart (data directa) y para ítem." Devuelve `id` (p. ej. `123-MLA456_112021`) y variantes de tamaño; después se usa `pictures:[{"id":"<id>"}]` en el POST de `/items` (o `POST /items/$ITEM/pictures {"id":...}`). **Esta es la opción para el Worker**: leer el objeto de R2 y enviarlo como `FormData` con un `Blob`, sin exponer URL pública. Validar con el diagnóstico (base64 también vale) antes.
3. Reemplazar fotos: usar un `source` nuevo (otro nombre); reutilizar la misma URL con otro contenido no actualiza. Para conservar existentes, mandar sus `id` más las nuevas.
- Diagnóstico de errores de descarga: `GET /pictures/$PICTURE_ID/errors`.
- Límite de RPM por `app_id` en el recurso de imágenes (error 400 "Superaste tu cuota asignada"); no hay cifra publicada.

---

## 5. Actualizar, pausar y cerrar

Fuente: https://developers.mercadolibre.com.mx/es_ar/producto-sincroniza-modifica-publicaciones (act. 24/03/2026). Nota: la página `actualiza-tus-publicaciones` es de Inmuebles, no aplica.

- `PUT /items/$ID` con solo los campos a cambiar. Con ítem activo se pueden editar: `available_quantity`, precio, video, imágenes, descripción, envío.
- Con ventas (`sold_quantity > 0`) **no se puede cambiar** título, modo de compra ni métodos de pago distintos de Mercado Pago. Con `sold_quantity = 0` sí el título. El tipo de publicación solo se puede modificar una vez (lo dice esta página; la de tipos de publicación dice que Clásica/Premium se cambian sin cargo "cada vez que lo desees": **contradicción**, no depender de ello).
- Estado: `{"status":"paused"}`, `{"status":"active"}`, `{"status":"closed"}` (minúsculas). `closed` es final (se puede republicar como ítem nuevo). Borrado: primero `closed`, luego `{"deleted":true}`; si responde 409 "optimistic locking", reintentar tras unos segundos.
- Stock: `available_quantity: 0` pausa con `sub_status: out_of_stock` **solo para `condition: new` y listing no `free`**; luego `> 0` reactiva sola. Si el vendedor pausó a mano (`paused_by_seller`), la reposición no reactiva. Con UP, el cambio de `available_quantity` se replica entre ítems del mismo UP (sin multi-origen).
- **Precio**: aviso oficial: "Desde el 18/03/2026 las solicitudes que actualicen **solo** `price` son rechazadas con 400 si la publicación tiene automatización de precios activa; con otros campos, el `price` se ignora con warning". El texto está ambiguo; **probar `PUT {"price":...}` con un usuario de test y manejar el 400**. ML migra gradualmente la lectura de precios a `GET /items/$ID/prices` y `/sale_price` (`api-de-precios`); `price` en `/items` se eliminará progresivamente.
- Usados con límite 1 en MLM: solo `MLM1456` (Accesorios de Moda - Lentes), `MLM5529` (Accesorios de Moda - Otros) y `MLM438426` (Esquí/Snowboard accesorios) según la lista de la doc. En moda/deportes con `condition: used` solo `available_quantity = 1` y al vender pasa a `closed` (aplica MX).
- Estados con moderación: `under_review` (`warning`, `waiting_for_patch`, `held`, `pending_documentation`, `forbidden`), `inactive`. Un ítem recién creado puede pasar a `closed` a los minutos si ML lo detecta duplicado o falla la descarga de imagen: consultar el estado con retardo, no asumir `active`.

---

## 6. Notificaciones y órdenes

Fuente: https://developers.mercadolibre.com.mx/es_ar/productos-recibe-notificaciones (act. 14/09/2026)

### Configuración
En el DevCenter: "Notificaciones callbacks URL" y tópicos. Tópicos pertinentes: `orders_v2` (recomendado; se emite al crear y al modificar ventas confirmadas), `items` (cambios en tus ítems, incluidas moderaciones y pausas), `questions`, `shipments`. También existen `payments`, `messages`, `user_products`, `stock-location`, `catalog_*`, `public_offers`. Zona horaria UTC.

### Entrega y reintentos
- ML hace **POST** a la URL; hay que responder **HTTP 200 en <= 500 ms** o el tópico puede ser **desactivado** por fallback (y hay que volver a suscribirse; lo perdido no queda en "my feeds").
- Reintentos durante **1 hora**. **Contradicción**: el cuerpo de la doc dice 8 intentos; el aviso de 03/01/2024 dice que se redujeron de 8 a 5. No asumir número exacto: tratar la entrega como "al menos una vez" y deduplicar.
- Notificaciones perdidas: `GET /missed_feeds?app_id=$APP_ID[&topic=...&offset=..&limit=..]` (por defecto 10). Útil como reconciliación.
- Recomiendan responder de inmediato y procesar en cola. En Workers: `return new Response("ok")` y mandar el trabajo a `ctx.waitUntil` o Cloudflare Queues; el handler no debe llamar a ML antes de responder.
- Requisitos de URL: pública, accesible, que reciba POST. La doc de ejemplo usa `http://`, pero la app exige HTTPS para redirect; usar HTTPS. **[NO CONFIRMADO]** si la callback URL exige HTTPS.

### Verificación y seguridad [NO CONFIRMADO / diseño propio]
No se encontró firma, HMAC ni secret compartido en la doc de notificaciones. Medidas defendibles:
1. Aceptar solo el POST desde las IPs que publica ML en esa misma página (lista de IPs; ejemplos: `50.16.251.125`, `98.82.195.215`, `13.223.236.125`, `100.24.130.185`, `35.172.55.95`, `52.7.171.45`, `52.200.170.172`, `54.88.119.105`, `52.200.84.58`, `35.221.39.135`; revisar la lista completa y vigente en la doc). En Cloudflare se lee `CF-Connecting-IP`.
2. Tratar el cuerpo como **pista, nunca como verdad**: comprobar que `application_id` es el de la app y que `user_id` es el del vendedor, y **siempre** hacer `GET` del `resource` con el token del vendedor antes de actuar (así un POST falso no mueve stock).
3. Path secreto no adivinable en la callback (la URL es estática, p. ej. `/api/ml/notify/<random>`); rotar si se filtra. (La regla "sin información variable" es del `redirect_uri` de OAuth, no se documenta para la callback.)
4. Idempotencia en D1: una orden dispara varias notificaciones (creada, pagada, enviada, cancelada). Tabla de eventos procesados por `(order_id, status, fecha)`.

### Cómo leer la orden [OFICIAL]
Fuente: https://developers.mercadolibre.com.mx/es_ar/gestiona-ventas (act. 21/09/2026)
`GET https://api.mercadolibre.com/orders/$ORDER_ID` con el token del vendedor. Campos útiles: `status` (`paid` cuando hay pago acreditado; también `confirmed`, `cancelled`, `partially_refunded`...), `date_closed` (primera vez que pasa a confirmed/paid; "se descuenta el stock del ítem"), `order_items[].item.id`, `order_items[].quantity`, `unit_price`, `sale_fee`, `total_amount`, `buyer.id`, `shipping.id`, `pack_id`, `payments[]`, `tags`.
- `orders_v2` solo se emite para ventas confirmadas; con `buy_it_now` la orden aparece cuando el pago está aprobado.
- **Compras de carrito**: varias órdenes comparten `pack_id`; el detalle del carrito está en `/packs`. Una orden puede contener varias unidades del mismo ítem.
- Una orden `cancelled` (por falta de pago, ítem pausado durante aprobación, etc.) debe **reponer** el stock en D1 si ya se descontó. `confirmed` por API puede significar "no concretada" por front (ver doc).
- Listado de reconciliación: `GET /orders/search?seller=$SELLER_ID&order.status=paid&sort=date_desc`.
- Regla de stock para esta tienda: D1 es el maestro. Al venderse una pieza (en caja o en ML), D1 decide y empuja a ML `available_quantity: 0` (pausa) o `closed`. Cuando ML vende, el webhook baja D1; hay una ventana de sobreventa (pieza vendida en tienda mientras sigue activa en ML), que se mitiga con pausar de inmediato y cancelar orden si ocurre.

---

## 7. Envíos en MLM

Fuentes: https://developers.mercadolibre.com.mx/es_ar/mercado-envios (act. 23/04/2026), `mercadoenvios-modo-2`, `mercadoenvios-modo-1`, `envios-colectas-places`, `envios-flex`, `envios-personalizados`, `me1-me2-y-envio-gratis`, `items-atributos-de-envio-y-dimensiones`.

### Modalidades [OFICIAL]
- **ME2** (Mercado Envíos 2): logística gestionada por ML, con tipos: `drop_off` (el vendedor lleva el paquete a una sucursal de paquetería), `cross_docking` (Colecta: un transportista recoge en el domicilio), `xd_drop_off` (Places: punto de despacho), `self_service` (**Flex**: el vendedor entrega), `turbo`, `fulfillment` (**Full**: stock en bodegas de ML). Disponibilidad en MX de Colecta/Places según doc: "disponible en México"; evaluación semanal de desempeño puede quitarla. **Flex en México solo cubre CDMX (ZMVM) y Mérida** (no San Luis Potosí). **[NO CONFIRMADO]** cobertura de Colecta/Places en San Luis Potosí; sale en Configuración > Preferencias de venta del vendedor.
- **ME1**: logística propia o de terceros; pensada para productos pesados/voluminosos no elegibles para ME2; requiere activación vía asesor/KAM y **que ME2 esté activo**; si un ítem es elegible para ME2 no puede publicarse en ME1. Límite ME1: dimensiones 500 cm y 500 kg máx. No práctico para ropa.
- **custom**: el vendedor carga una tabla de precios por región y hace la logística. **not_specified**: sin costo definido, el comprador contacta al vendedor (sin `shipment_id`). La doc dice que **todos los vendedores tienen `custom` y `not_specified` habilitados por defecto**.

### Qué obtiene un vendedor nuevo [NO CONFIRMADO]
La doc no describe la configuración inicial por país. Datos oficiales: `GET /users/$USER_ID/shipping_preferences` muestra `modes`, `option` (`in`/`out`/`trial`/`null`) y `logistics`; el aviso de validación `shipping.me2_adoption_mandatory` ("ME2 adoption is mandatory for the user") y el tag `adoption_required` (ítem `not_specified` que aún no adoptó ME2, "el recomendado") indican que ML empuja ME2 y puede exigirlo. Consultar con el token del dueño antes de decidir.

### Retiro en persona
`shipping.local_pick_up` (booleano) existe en el modelo del ítem y en `shipping_preferences`. En los ejemplos de ME2 se envía `false`; en ME1 aparece `true`. **[NO CONFIRMADO]** si se permite retiro con ME2 activo en MLM. Verificar con `POST /items/validate`.

### Envío gratis
En México es obligatorio a partir de **$299 MXN** según blogs [3ROS] y el tag oficial `mandatory_free_shipping` ("ítem superó el límite de precio"); el umbral oficial está en la página de "Costos por ofrecer envíos gratis en México" (no accesible sin sesión). No se puede forzar envío gratis nacional por API: depende de ME2 y precio.

### Dimensiones y peso [OFICIAL]
- ME2: las dimensiones del paquete las define ML por categoría (`GET /categories/$ID/shipping_preferences` devuelve `dimensions` base; requiere token). Además el vendedor debe enviar los atributos `SELLER_PACKAGE_HEIGHT`, `SELLER_PACKAGE_LENGTH`, `SELLER_PACKAGE_WIDTH` (cm) y `SELLER_PACKAGE_WEIGHT` (gramos, entero), **obligatorios para vendedores ME2 en `cross_docking` y `xd_drop_off`** aunque no vengan marcados `required`. Formato: **strings numéricos puros**, p. ej. `"30"` y no `"30 cm"`; dimensiones del embalaje real (la API rechaza medidas "irreales" muy pequeñas).
- FAQ oficial: `MANUFACTURING_TIME` en `sale_terms` no puede ser null ni faltar, debe ser un entero (0 es válido si hay disponibilidad inmediata); omitirlo bloquea la publicación aun con dimensiones correctas. **[NO CONFIRMADO]** que aplique a todas las categorías de ropa.
- ME1 / publicación manual: `shipping.dimensions` con formato `"AxBxC,peso"` (cm y gramos).
- Etiqueta en MX: 20 cm alto x 10 cm ancho (PDF en A4); no está permitido modificar la plantilla de etiquetas.
- Para ropa: definir 2-3 "cajas tipo" (bolsa/sobre pequeño, mediano, grande) con dimensiones y peso por tipo de prenda y guardarlas en D1.

---

## 8. Comisiones y costos

### Comisión por venta (oficial, México)
Fuente: https://www.mercadolibre.com.mx/ayuda/costos-de-vender-un-producto_870, leída el **2026-10-04** (página dinámica; se leyó con navegador):
- Publicar no tiene costo. Cargo por venta: **Clásica entre 8% y 17%**, **Premium entre 11% y 21.5%** (el porcentaje exacto depende de la categoría; la página dice "Entre 8% y 20.5%" en el encabezado y 21.5% en la tabla: pequeña inconsistencia en la misma página). Premium ofrece hasta 18 meses sin intereses; Clásica no.
- **Precio mínimo 35 MXN** "para cubrir las tarifas"; vender menor valor con packs.
- Supermercado paga otros costos.
- Cifras de blogs 2026 [3ROS], que difieren del oficial (8%-16% y 12.5%-20.5%): usar la API de costos, no estos números. Para Ropa, Bolsas y Calzado: 15% Clásica, 19.5% Premium (<$999) o 18% (>$1,000) [3ROS].

### Cargo fijo en artículos baratos
- Oficial (docs de desarrollador, https://developers.mercadolibre.com.mx/es_ar/comision-por-vender, act. 03/09/2026): nueva estructura **encendida en México el 08/04/2026**. Para MX/BR/CL/CO: si `precio < TH` (umbral de envío gratis obligatorio por sitio) y logística ME2, **solo Flex (`self_service`) cobra costo fijo**; con ME1, `custom` o `not_specified` **siempre** se cobra costo fijo si precio < TH; con `precio >= TH` no hay costo fijo. El `sale_fee_details.fixed_fee` ya está incluido en `sale_fee_amount` (no sumar de nuevo).
- Montos [3ROS] (antes de abril 2026): $25 (< $99), $30 ($99-149), $37 ($149-299), $0 desde $299. Otro blog [3ROS] dice que desde el 6 de abril el fijo se sustituyó por un costo variable de servicio de envío según peso y precio (en Full). **Los montos actuales no están confirmados en fuente oficial.**
- **Calcular en código**, no con tabla fija: `GET /sites/MLM/listing_prices?price=..&category_id=..&listing_type_id=gold_special&logistic_type=drop_off&shipping_mode=me2` (requiere token; sin token 403). La doc advierte que sin `logistic_type`/`shipping_mode` el `fixed_fee` no coincide con lo cobrado.
- Retención de ISR 2.5% a vendedores de plataformas [3ROS]; consultar con contador. IVA no se detalla aquí.
- Ejemplo de la estructura de respuesta de `listing_prices` (valores ilustrativos de la doc, en ARS): `sale_fee_amount`, `sale_fee_details.{percentage_fee, fixed_fee, gross_amount}`.

---

## 9. Pruebas

Fuente: https://developers.mercadolibre.com.mx/es_ar/realiza-pruebas (act. 30/12/2025)
- **No hay sandbox**: se prueba en producción con **usuarios de test**.
- `POST https://api.mercadolibre.com/users/test_user` con `{"site_id":"MLM"}` y token de una cuenta real; responde `id`, `nickname`, `password`, `site_status`. Guardar la contraseña (no hay endpoint para recuperarla).
- Máx. **10** usuarios de test por cuenta; caducan, y se eliminan tras **60 días** sin actividad. El código de verificación de email de un test user son los últimos 4 o 6 dígitos de su `user_id`.
- Los test users solo compran, venden y preguntan en publicaciones de **otros test users**. Para simular compras: tarjetas de prueba de Mercado Pago (poner `APRO APRO` como nombre del titular para pago aprobado).
- Convenciones: título "Item de Prueba - Por favor, NO OFERTAR", categoría "Otros" cuando se pueda, nunca `gold`/`gold_premium`.
- Cuentas personales o familiares no deben tener anuncios de prueba.
- Para probar UP, Colecta o Flex con test users hay formularios de activación de ML por país.
- Publicar sin ventas reales: `POST /items/validate` valida sin crear. Para publicar de verdad usar un test user y ciclo completo (publicar, comprar con otro test user, orden, notificación).

---

## 10. Rate limits, errores y buenas prácticas

### Rate limits [OFICIAL parcial]
Fuente: https://developers.mercadolibre.com.mx/es_ar/rate-limit-error-429 (act. 05/05/2026)
- Límite principal **por Client ID** y por endpoint; no cuenta el tamaño del payload. **No hay cifra publicada** en las páginas leídas ([NO CONFIRMADO] el RPM). Aumento: contactar a integraciones comerciales con evidencia de uso.
- 429 (`too_many_requests` / `local_rate_limited`): backoff exponencial con jitter, menor concurrencia, agrupar llamadas; el `scroll_id` caduca y no se mezcla con `offset/limit`. `items/visits` solo acepta un id.
- Imágenes: límite de RPM por `app_id` aparte.
- Recomendación de ML: limitar las IPs que usan el token de la app (hay "Gestionar IPs de una aplicación" en el DevCenter). Cloudflare Workers sale por IPs variables; **[NO CONFIRMADO]** cómo encaja con esa opción; no activarla sin probar.

### Errores frecuentes
Formato: `{message, error, status, cause:[{department, cause_id, type, code, references, message}]}`; `type: warning` no bloquea, `type: error` sí.
- `body.invalid_fields`, `item.category_id.invalid`, `seller.unable_to_list` (cuenta con datos pendientes; hacer primera publicación manual desde la web).
- Atributos: `error.item.attribute.business_conditional.value_name` ("Attribute [GENDER] is not valid"), `value_is_not_in_the_list` (en listas mandar `id`, no solo `name`), `missing.fashion_grid.*` (2610-2612) e `invalid.fashion_grid.*` (2613-2617).
- Marcas restringidas: `moderations.seller.not_authorized` (3250): "Seller is not authorized for this brand and category".
- Imágenes: `cause_id 508` (imagen con status ERROR), `509` (tamaño mínimo), 301 redirect, 403/404 al descargar, "Slow_domain".
- Envío: `item.attribute.invalid.seller.package.dimensions` (valores con unidad en vez de número), `shipping.me2_adoption_mandatory`.
- Descripción: `item.description.type.invalid` (caracteres no permitidos).
- Precio: 400 al hacer PUT solo de `price` en ciertos casos (sección 5).
- HTTP 206 en `/items`: faltan `location`, `geolocation` o `seller_address` (ver header `X-Content-Missing`).
- 409 `item optimistic locking error`: reintentar tras unos segundos.
- 401/403 genéricos: token inválido/expirado/IP o scope faltante.

### Buenas prácticas oficiales
Fuente: https://developers.mercadolibre.com.mx/es_ar/buenas-practicas-para-uso-de-la-plataforma
- No hacer web scraping; usar la API.
- No enviar mensajes automáticos/repetitivos a compradores (se bloquean y pueden sancionar la cuenta).
- No clonar publicaciones ni imágenes (moderación por duplicados).
- Moda siempre con guía de tallas; ítems elegibles para catálogo deben publicarse en catálogo.
- No modificar la plantilla de etiquetas.
- Renovar el access token solo cuando expire; guardar siempre el refresh token nuevo.

---

## Payloads de ejemplo

Valores de las IDs/atributos son los observados en la API real el 2026-10-04 o de la doc; los marcados `<...>` son placeholders.

### Intercambio de código por token
`POST https://api.mercadolibre.com/oauth/token`, `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`:
```
grant_type=authorization_code
client_id=<APP_ID>
client_secret=<CLIENT_SECRET>
code=<CODE_DE_LA_REDIRECCION>
redirect_uri=<REDIRECT_URI_EXACTO>
code_verifier=<SOLO_SI_PKCE_ACTIVADO>
```
Respuesta:
```json
{
  "access_token": "APP_USR-123456-090515-8cc4448aac10d5105474e1351-1234567",
  "token_type": "bearer",
  "expires_in": 10800,
  "scope": "offline_access read write",
  "user_id": 1234567,
  "refresh_token": "TG-5b9032b4e23464aed1f959f-1234567"
}
```

### Refresh
Mismo endpoint y content-type:
```
grant_type=refresh_token
client_id=<APP_ID>
client_secret=<CLIENT_SECRET>
refresh_token=<ULTIMO_REFRESH_TOKEN>
```
Respuesta (misma forma; **guardar el `refresh_token` nuevo**, el anterior queda inválido):
```json
{
  "access_token": "APP_USR-12345657984-090515-b0ad156bce70050973466faa15-1234567",
  "token_type": "bearer",
  "expires_in": 10800,
  "scope": "offline_access read write",
  "user_id": 1234567,
  "refresh_token": "TG-5b9032b4e4b0714aed1f959f-1234567"
}
```

### Crear ítem de ropa (modelo UP, `user_product_seller`; sin `title`)
`POST https://api.mercadolibre.com/items`, `Authorization: Bearer <token>`. Ejemplo: jeans de hombre usado/nuevo (categoría Pantalones `MLM194175`); la guía `<CHART_ID>` y la fila deben existir (sección 3).
```json
{
  "family_name": "Jeans Levis 501 Original Hombre",
  "category_id": "MLM194175",
  "price": 899.00,
  "currency_id": "MXN",
  "available_quantity": 1,
  "buying_mode": "buy_it_now",
  "condition": "new",
  "listing_type_id": "gold_special",
  "pictures": [{ "id": "<PICTURE_ID_DEL_UPLOAD>" }],
  "sale_terms": [
    { "id": "WARRANTY_TYPE", "value_name": "Garantía del vendedor" },
    { "id": "WARRANTY_TIME", "value_name": "30 días" },
    { "id": "MANUFACTURING_TIME", "value_name": "0" }
  ],
  "attributes": [
    { "id": "ITEM_CONDITION", "value_id": "2230284", "value_name": "Nuevo" },
    { "id": "BRAND", "value_name": "Levi's" },
    { "id": "MODEL", "value_name": "501" },
    { "id": "GENDER", "value_id": "339666", "value_name": "Hombre" },
    { "id": "COLOR", "value_name": "Azul" },
    { "id": "SIZE", "value_name": "32" },
    { "id": "MAIN_MATERIAL", "value_name": "Algodón" },
    { "id": "PANT_TYPE", "value_name": "Jeans" },
    { "id": "EMPTY_GTIN_REASON", "value_id": "17055160", "value_name": "El producto no tiene código registrado" },
    { "id": "SIZE_GRID_ID", "value_name": "<CHART_ID>" },
    { "id": "SIZE_GRID_ROW_ID", "value_name": "<CHART_ID>:<N>" },
    { "id": "SELLER_PACKAGE_HEIGHT", "value_name": "5" },
    { "id": "SELLER_PACKAGE_LENGTH", "value_name": "35" },
    { "id": "SELLER_PACKAGE_WIDTH", "value_name": "25" },
    { "id": "SELLER_PACKAGE_WEIGHT", "value_name": "650" }
  ],
  "shipping": { "mode": "me2", "local_pick_up": false, "free_shipping": false }
}
```
Notas: el `MANUFACTURING_TIME`, los `SELLER_PACKAGE_*` y el uso de `value_name` en atributos lista (`MAIN_MATERIAL`, `PANT_TYPE`, `COLOR`) **no se verificaron contra el POST real**; confirmar con `POST /items/validate` y un test user. Para el modelo legacy añadir `"title": "..."` (<= 60) y quitar `family_name`. `price` en pesos con decimales (no centavos).
La respuesta incluye `id` (`MLM...`), `user_product_id`, `family_name`, `title` generado, `status`, `sub_status`, `tags`, `permalink`.

### Crear descripción
`POST https://api.mercadolibre.com/items/MLM2061397137/description`
```json
{ "plain_text": "Jeans Levi's 501 nuevo con etiquetas, talla 32.\nPieza única.\nFotos reales del producto." }
```
(Si ya existe: `PUT .../description?api_version=2` con el mismo cuerpo.)

### Pausar ítem
`PUT https://api.mercadolibre.com/items/MLM2061397137`
```json
{ "status": "paused" }
```
Reactivar: `{"status":"active"}`. Marcar agotado por stock: `{"available_quantity":0}` (solo condición `new` y no `free`). Cerrar: `{"status":"closed"}`.

### Notificación `orders_v2` (POST que recibe el callback)
```json
{
  "resource": "/orders/2195160686",
  "user_id": 468424240,
  "topic": "orders_v2",
  "application_id": 5503910054141466,
  "attempts": 1,
  "sent": "2019-10-30T16:19:20.129Z",
  "received": "2019-10-30T16:19:20.106Z"
}
```
Luego `GET https://api.mercadolibre.com/orders/2195160686` y leer `order_items[0].item.id`, `order_items[0].quantity`. Forma resumida de la orden (doc oficial):
```json
{
  "id": 2195160686,
  "status": "paid",
  "date_closed": "2026-10-04T10:04:07.000-04:00",
  "order_items": [{
    "item": { "id": "MLM2061397137", "title": "...", "variation_id": null },
    "quantity": 1,
    "unit_price": 899,
    "currency_id": "MXN"
  }],
  "total_amount": 899,
  "currency_id": "MXN",
  "buyer": { "id": "123456789" },
  "seller": { "id": "123456789" },
  "payments": [{ "id": "596707837", "status": "approved" }],
  "shipping": { "id": 20676482441 },
  "pack_id": null,
  "tags": ["paid"]
}
```
Para notificaciones de otros tópicos (`items`, `shipments`, `questions`) la forma es la misma: `resource`, `user_id`, `topic`, `application_id`, `attempts`, `sent`, `received` (algunos incluyen `_id` y `actions`).

---

## Riesgos y decisiones para el dueño

Cosas que solo el dueño puede hacer o decidir:

1. **Cuenta y app**: crear/validar la cuenta de vendedor con datos fiscales completos (en MX la app solo se crea tras validar los datos del titular) y crear la app en el DevCenter con la **misma cuenta propietaria** (si es persona moral, mejor a nombre de la entidad). Hacerlo él mismo; el ingeniero no debe recibir contraseñas, solo el `Client ID`, `Client Secret` y autorizar vía el flujo OAuth con la cuenta **principal**, no un colaborador.
2. **Una sola app solo para Mercado Libre** (la separación ML/Mercado Pago ya venció el 30/08/2026).
3. **Marcas restringidas**: Nike, Adidas y Reebok en México solo las venden Tiendas Oficiales y vendedores acreditados; publicar sin acreditación puede dar `moderations.seller.not_authorized` o bajas. Revisar qué marcas americanas del inventario caen en esto (Brand Protection Program de ML).
4. **Piezas "dañadas"**: ML solo maneja `Nuevo`, `Usado` y `Reacondicionado`; no hay "dañado". Decidir si esas piezas se publican como usadas con descripción honesta, o no se publican. Reacondicionado exige garantía >= 90 días.
5. **Modo de envío**: elegir ME2 `drop_off` (llevar a sucursal) como base realista en San Luis Potosí; confirmar en su cuenta si le ofrecen Colecta/Places. Flex no cubre SLP. Decidir si acepta que el envío gratis sea obligatorio sobre ~$299 (a validar) y quién absorbe ese costo. Retiro en persona y `custom`/`not_specified` requieren verificación con la cuenta real.
6. **Precios y comisiones**: Clásica 8%-17% o Premium 11%-21.5% (+ cargo fijo/costo de envío en piezas baratas, + retención de ISR). Definir si sube el precio en ML respecto a la tienda física, y qué piso de precio acepta (mínimo 35 MXN). Revisar sus costos reales con "Conocer todos mis costos" en su cuenta (la sección de costos requiere sesión).
7. **Guías de tallas**: aprobar y alimentar las medidas por tipo de prenda y género (obligatorias en moda; no se pueden borrar). Alguien debe medir/definir una guía base por categoría de ropa.
8. **Fotos**: una sola foto por pieza es lo mínimo. Si la categoría exige fondo blanco, las fotos actuales (con fondo de tienda) podrían ser moderadas; decidir si se retoman o se aceptan con menos exposición. Prohibidos logos, textos y marcas de agua.
9. **Atributos que no se tienen**: `MODEL` y `GTIN` en ropa americana nueva; decidir los valores por defecto (N/A, "No tiene código registrado") y quién captura `MAIN_MATERIAL`, `GARMENT_TYPE`, `PANT_TYPE`, `COLOR`, `SIZE` por pieza (hoy el sistema interno no los guarda según el contexto; hay que decidir si se agregan a la captura).
10. **Responsabilidad de stock**: D1 sigue siendo maestro; con piezas únicas conviene que cualquier venta en tienda pause en ML al instante. Aceptar el riesgo de sobreventa residual (ML puede cancelar y dañar reputación).
11. **Reputación y mensajería**: no se pueden mandar mensajes automáticos a compradores; atender preguntas, devoluciones y reclamos desde la cuenta tendrá carga operativa nueva.
12. **Pruebas**: crear usuarios de test requiere el token real del dueño; el ciclo completo se prueba en producción solo entre test users. Contactar a ML (formulario) para ambientar UP en test users.

## Fuentes

Documentación oficial (todas bajo `https://developers.mercadolibre.com.mx/es_ar/`; la fecha es la de "Última actualización" de cada página):
- `autenticacion-y-autorizacion` (15/07/2026)
- `crea-una-aplicacion-en-mercado-libre-es` (06/08/2026)
- `permisos-funcionales` (04/03/2026)
- `publica-productos` (09/01/2026)
- `user-products` (17/06/2026)
- `precio-variacion` (13/08/2026)
- `descripcion-de-articulos` (13/03/2026)
- `categoriza-productos` (30/12/2025)
- `atributos` (08/06/2026)
- `guias-de-talles` (09/07/2026) y `validacion-de-guia-de-talles`
- `trabajar-con-imagenes` (24/03/2026), `diagnostico-imagenes` (29/12/2025), `moderaciones-de-imagenes` (21/07/2025)
- `tipos-de-publicacion-y-actualizaciones-de-articulos` (01/06/2026)
- `producto-sincroniza-modifica-publicaciones` (24/03/2026) y `api-de-precios`
- `stock-distribuido` (20/04/2026)
- `validaciones` (29/12/2025), `validador-de-publicaciones` (30/12/2025)
- `productos-recibe-notificaciones` (14/09/2026)
- `gestiona-ventas` (21/09/2026)
- `mercado-envios` (23/04/2026), `mercadoenvios-modo-1` (06/02/2026), `mercadoenvios-modo-2` (06/07/2026), `envios-colectas-places` (25/09/2026), `envios-flex`, `envios-personalizados` (13/03/2026), `me1-me2-y-envio-gratis` (14/08/2026), `items-atributos-de-envio-y-dimensiones` (14/08/2026), `costos-de-envios`
- `comision-por-vender` (03/09/2026)
- `realiza-pruebas` (30/12/2025)
- `rate-limit-error-429` (05/05/2026), `buenas-practicas-para-uso-de-la-plataforma` (30/12/2025), `errores` (10/02/2025)

Datos reales de la API pública de Mercado Libre (sin token), consultados el 2026-10-04:
- `https://api.mercadolibre.com/sites/MLM/domain_discovery/search?q=...`
- `https://api.mercadolibre.com/categories/MLM194178`, `/MLM194175`, `/MLM115350`, `/MLM118812`, `/MLM1084` y sus `/attributes`
- (403 sin token: `/sites/MLM`, `/sites/MLM/listing_types`, `/sites/MLM/listing_prices`, `/categories/{id}/shipping_preferences`, `/categories/{id}/sale_terms`, `technical_specs`)

Ayuda oficial de Mercado Libre México:
- https://www.mercadolibre.com.mx/ayuda/costos-de-vender-un-producto_870 (leída 2026-10-04)
- https://www.mercadolibre.com.mx/landing/costos-de-venta (requiere iniciar sesión; no leída)
- https://vendedores.mercadolibre.com.mx/nota/novedades-en-los-cargos-por-venta-y-en-tus-publicaciones-de-full (devuelve "Algo salió mal"; no leída)

Terceros (usar solo como referencia, no como fuente de decisión):
- https://www.upseller.com/es/blog-article-515, https://www.tiendanube.com/blog/comision-mercado-libre-mexico/, https://www.profitosapp.com/blog/cambios-mercado-envios-full-mexico-abril-2026 (comisiones y cargo fijo)
- https://base.com/es-MX/blog/como-vender-en-mercado-libre-mexico/ (envío gratis obligatorio desde $299)
- https://base.com/es-MX/blog/?p=18472, https://jaguarsheet.com/es/blog/calidad-imagenes-mercado-libre (requisitos de foto)

## Lo que no se pudo confirmar o parece desactualizado
- Vigencia de `expires_in` (10800 s = 3 h) frente al texto "6 horas" de la misma página.
- Número de reintentos de notificación (8 en el cuerpo vs 5 en el aviso de 2024).
- Si un `localhost`/`http` se acepta como redirect URI (la doc solo dice HTTPS).
- Si la callback de notificaciones debe ser HTTPS; no hay firma/HMAC documentada.
- Montos vigentes del cargo fijo y el umbral de envío gratis en MX tras abril de 2026.
- Lista exacta de `listing_type_id` de MLM y cuál es la configuración de envío por defecto de un vendedor nuevo.
- Cobertura de Colecta/Places en San Luis Potosí; si se permite `local_pick_up` con ME2.
- Regla de foto de portada con fondo blanco específica para moda en MLM.
- Cómo buscar o listar guías de tallas existentes del vendedor (solo se confirmó `GET /catalog/charts/$ID`).
- Si `MODEL`/`GTIN` aceptan N/A o la razón de GTIN vacío en todas las marcas de ropa.
- Si el vendedor del dueño ya tiene el tag `user_product_seller`.
- Rate limit numérico (no se publica).
- Comportamiento exacto del 400 al actualizar solo `price` (ambiguo en la doc).
