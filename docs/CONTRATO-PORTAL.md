# Contrato del portal Dolarones — Issues #109, #129 y #133

**Estado:** backend y pantallas preparados para revisión; registro público desactivado. Sin proveedor SMS, dominio público ni despliegue de este cambio. Los importes son centavos enteros: `100` = 1 D o $1 MXN. El recibo es comprobante de compra, no factura fiscal. La decisión de Isaac del 29/09 mantiene teléfono + SMS y elimina el PIN del socio; no modifica el PIN de cajeros.

## Puertas y autenticación

- El portal sólo responde en el hostname exacto `HOST_PORTAL`. Sin ese valor y sin ruta de Cloudflare, no hay host público. Ese host permite `/`, `/portal`, `/portal.html`, `/portal.js`, `/portal.css`, `/code128.js` (GET/HEAD) y `/api/portal/*` salvo `/api/portal/llegada`; cualquier otra pantalla, asset, `/api/socios`, `/api/ventas` y API del personal devuelve 404. El host del personal rechaza las API del cliente, salvo llegada. No publicar el cliente detrás de Access ni abrir rutas del personal para autenticarlo.
- La web obtiene un ID token tras [verificación SMS de Firebase](https://firebase.google.com/docs/auth/web/phone-auth) y lo manda en `Authorization: Bearer <ID_TOKEN>` por HTTPS, nunca en URL. El Worker comprueba proyecto, emisor, tiempos, método `phone`, teléfono E.164 `+52` + diez dígitos y UID. Consulta [accounts:lookup](https://firebase.google.com/docs/reference/rest/auth#section-get-account-info) en cada petición para validar el token ante Firebase, cuenta activa, teléfono actual y `validSince` frente a `auth_time` ([revocación](https://firebase.google.com/docs/auth/admin/manage-sessions)). No registra tokens ni teléfono.
- El UID de Firebase se guarda único en `clientes.auth_uid`; `clientes.id` sigue como llave histórica de ventas y lotes. `bases_version` y `bases_aceptadas_en` guardan aceptación vigente. El teléfono sólo se usa para contacto y búsqueda del personal. Un UID nuevo con el teléfono de un socio previo recibe 409 y requiere recuperación presencial; jamás se vincula automáticamente. Un UID existente puede actualizar su teléfono verificado si no pertenece a otro socio.
- Sin `PORTAL_REGISTRO_ABIERTO=si`, versión aprobada distinta de `borrador*`, textos no vacíos `PORTAL_BASES_TEXTO`/`PORTAL_AVISO_TEXTO`, y `PROMOCION_INICIO` UTC alcanzado, las altas y llegadas devuelven 503. Sin textos/versiones aprobados no se habilita el formulario SMS. No hay prerregistro: la vigencia de 30 días comienza al otorgarse. Fecha/hora y tratamiento de casos anteriores requieren aprobación antes de habilitarlo.
- La web usa el SDK Firebase desde su CDN oficial y [persistencia administrada](https://firebase.google.com/docs/auth/web/auth-state-persistence): local si el cliente elige conservar sesión; de sesión en caso contrario. No guarda tokens manualmente. Los textos legales se muestran antes del consentimiento y envío de SMS. La primera llegada requiere confirmación presencial explícita del personal con Access, no basta un registro web.
- El cliente genera un Code 128 `DC-…` aleatorio de 96 bits, sin teléfono, nombre ni saldo codificados. Elige un máximo autorizado; cero permite acumular sin gastar. Cinco minutos, un código activo por socio y un solo canje. Se guarda únicamente SHA-256, UID, máximo, vigencia y venta que lo consumió. Generar otro o cerrar sesión invalida el anterior; requiere conexión. Un código copiado puede gastarse durante su vigencia hasta ese máximo: no sustituye prueba física de identidad. Caja, venta, stock, saldo y consumo del código se confirman en un batch; no hay canje offline. Cancelar devuelve D conforme a las reglas existentes, pero no reactiva el código usado.
- Un socio previo sin UID obtiene un desafío temporal `DV-…` tras SMS; solo el dueño puede vincularlo presencialmente tras cotejar número de socio, teléfono y titular. Conserva `clientes.id` e historial. No se fusiona por teléfono. Recuperación de una cuenta ya vinculada o cambio de proveedor sigue requiriendo resolución de Isaac, sin endpoint automático.

## API JSON

Todas las respuestas privadas usan `Cache-Control: no-store`. No se manda teléfono, UID ni token como parámetro URL.

| Método y ruta | Cuerpo o parámetros | Respuesta principal |
| --- | --- | --- |
| `GET /api/portal/config` | público | `{firebase, registro_abierto, bases_version, bases, aviso}`. `firebase` es `null` sin proveedor/textos/versiones preparados. La API key web identifica el proyecto, no sustituye autenticación. |
| `POST /api/portal/registro` | `{nombre, acepta_bases: true, bases_version}` | `{id, numero, nombre, disponible, por_liberar, regalo_disponible, premio}`. Reintento del mismo UID es idempotente; teléfono duplicado con otro UID: 409. `premio` es `null` sin cupos. |
| `GET /api/portal/yo` | — | `{id, numero, nombre, telefono: "+52...", bases_version}` del UID titular. |
| `GET /api/portal/saldo` | — | `{disponible_compras, regalo_sujeto_minimo, por_liberar, disponible_total, lotes}` con origen, restante, liberación y vencimiento. El regalo sólo se gasta en ticket de al menos $1,000 antes de D (#108). |
| `POST /api/portal/codigo` | `{maximo}` centavos enteros, entre cero y saldo disponible | `{codigo, maximo, expira_en}`; 201. Reemisión antes de cinco segundos: 429. Requiere bases vigentes. |
| `DELETE /api/portal/codigo` | — | Revoca el código del titular; `{ok:true}`. |
| `POST /api/portal/vinculo` | — | `{codigo, expira_en}`; desafío para socio previo sin UID. |
| `POST /api/socios/codigo` **personal** | `{codigo}` | Socio, saldo, `maximo`, `expira_en`; lookup no consume ni cobra. |
| `POST /api/socios/vincular` **dueño** | `{numero, codigo, confirma:true}` | `{numero, nombre, vinculado:true}`; no vincula cuenta ya asociada. |
| `POST /api/ventas` **caja** | contrato existente + `cliente_id`, `dolarones`, `codigo_socio` | D positivos requieren código válido del socio y dentro del máximo. `pin` ya no autoriza. Canje requiere red; no se guarda el código en cola offline. |
| `GET /api/portal/recibos?limit=20&cursor=...` | `limit` 1–50; `cursor` opaco devuelto por la página anterior | `{recibos: [{id, registrado_en, creado_en, total, dolarones, forma_pago, cancelada, pago_monetario}], siguiente}`. Orden descendente estable. |
| `GET /api/portal/recibos/:id` | UUID de venta | `{id, creado_en, registrado_en, total, dolarones, forma_pago, efectivo, cambio, cancelada, cancelada_en, pago_monetario, d_usados, d_ganados, lineas: [{codigo, nombre, precio, cantidad}], tipo: "recibo_de_compra_no_factura"}`. Venta ajena o inexistente: 404. |
| `POST /api/portal/llegada` **sólo host del personal** | `{cliente_id}` | `{premio}`; primera llegada recibe 500 D, demás usan 49 cupos presenciales. Reintento devuelve el mismo premio. |

Errores: 400 entrada inválida, 401 token faltante/inválido/vencido/revocado, 404 ruta o recibo inaccesible, 409 conflicto de teléfono, autorización de gasto o reemplazo pendiente, 429 regeneración demasiado rápida, 503 portal cerrado o proveedor no disponible. No devolver detalle de cuentas ajenas.

## Premios y migración

Ejecutar `app/migracion-016-portal.sql` antes del Worker. Las filas de `premios_apertura` fijan 50 cupos online = 7,300 D y 50 en tienda = 7,700 D. Se adjudica el menor orden libre en una transacción D1; los vencidos quedan ocupados. El primer arribo queda reservado aun si su reemplazo falla. Si su premio online está intacto y vigente, una sola transacción lo revoca, libera su cupo y concede 500 D. Si tuvo canje, aun revertido, o venció, responde 409 y **no cambia el saldo**: Isaac y abogado deben fijar la resolución antes de operación real. No se asignan los 500 D a la segunda llegada.

El registro online y la acreditación de llegada responden 409 **antes de crear socio o premio** si D1 contiene regalos anteriores a esta migración sin reconciliar. Hay que revisar esos lotes y ventas antes de encenderla; no ejecutamos reasignación automática. La alta presencial ya no concede premio por número global: personal registra y confirma la llegada explícitamente en `/socios`.

Aplicar migraciones pendientes antes del Worker: `014-minimo-regalo`, `016-portal` y `018-codigo-socio`. La 018 elimina las cuatro columnas del PIN de socios y crea códigos/desafíos; **no elimina PIN de cajeros ni ventas/lotes**. Respaldar D1 y ensayar restauración antes de aplicarla remotamente. Una versión anterior del Worker con PIN no funciona sobre el esquema 018: preparar despliegue coordinado y reversión con respaldo, no desplegar sólo el código viejo. Para instalación limpia, `schema.sql` y todas las `migracion-*.sql` de esta rama en orden numérico; la prueba D1 usa esa secuencia. La migración 017 de descuentos pertenece al PR #120: integrar y verificar descuentos/recibos antes de desplegar esta rama sobre producción.

## Configuración pendiente

1. Configurar proyecto Firebase/Identity Platform, proveedor Phone, región México, dominio autorizado, límites y presupuesto de SMS; no hay proveedor ni SMS reales activados por este PR. Definir `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY` y, si es diferente del dominio estándar, `FIREBASE_AUTH_DOMAIN`. Ensayar SDK/reCAPTCHA y CSP en el dominio aprobado con [números ficticios Firebase](https://firebase.google.com/docs/auth/web/phone-auth#test-with-fictional-phone-numbers), sin SMS pagados.
2. Definir hostname público real en `HOST_PORTAL` y agregarlo a `routes` de Wrangler tras verificar DNS y aislamiento; `workers_dev` y preview siguen apagados. No usar Access para clientes.
3. Obtener revisión legal, razón social/RFC y correo de privacidad. Publicar textos finales, sin corchetes, en `PORTAL_BASES_TEXTO` y `PORTAL_AVISO_TEXTO`; definir versión en `BASES_APROBADAS_VERSION`, instante UTC en `PROMOCION_INICIO`, y sólo al final `PORTAL_REGISTRO_ABIERTO=si`. Estos valores están ausentes en el repositorio.
4. Conciliar regalos legados, revisión cruzada de #129/#110 y ensayo con dos cajas, impresión, cancelación, red caída, código copiado/vencido y recuperación. Probar el lector físico leyendo Code 128 desde un teléfono: el código existe, pero la compatibilidad del hardware aún no está comprobada. Wallet queda pospuesto.

## Vales sin registro — decisión de Isaac, #133

Socios conservan **10 D por cada $100 completos** monetarios, liberados al día siguiente y vigentes 12 meses. Dar el teléfono sólo acumula: no autoriza gasto. Sin socio, la compra puede emitir **5 D por cada $100 completos**, en un vale impreso, sin teléfono, nombre ni alta. Ejemplo $250: 20 D para socio o 10 D en papel, nunca ambos. La parte pagada con D no genera crédito. Se conserva la aritmética por bloques aprobada; no se convierte en porcentaje proporcional sobre centavos.

- `DP-…` es un identificador aleatorio de 96 bits, no un monto modificable. D1 conserva el código legible **sólo para reimpresión autorizada del personal**, con venta emisora, importe, restante y vigencia. Esto difiere del código temporal del socio, del que sólo se conserva hash. No exponer códigos de papel en logs, listas de ventas, URLs, exports públicos ni portal. Quien tenga el papel o una copia puede gastar; las copias comparten saldo, no generan crédito adicional.
- Disponible desde la siguiente medianoche de la tienda, como lo ganado por compras. Vence **exactamente 30 días desde la emisión confirmada del servidor** (UTC), no al final del día 30. El ticket imprime disponibilidad y hora de vencimiento en America/Mexico_City. Gasto parcial, reimpresión o devolución no amplían el plazo. El regalo de apertura y su mínimo de $1,000 no se mezclan con estos vales ganados.
- Un vale o una membresía por ticket; combinar varios o transferir el vale a una cuenta no está implementado. «Usar máximo» aplica el menor de total, saldo elegible y máximo autorizado. Para papel, el máximo es su saldo actual; para socios respeta la autorización del portal. Elegir por teléfono no habilita ese botón ni canje.
- Emisión, canje, movimiento, venta y stock se confirman en un batch. No imprimir barcode gastable antes de respuesta confirmada; un timeout/red caída conserva el mismo ID en la cola y el ticket dice «vale pendiente». Al sincronizar, «Ventas de hoy → Imprimir vale» o «Reimprimir vale → folio Venta» recupera el mismo vale, incluso de otro día. Una venta rechazada no genera vale; revisar antes de devolver mercancía o dinero.
- Reimprimir devuelve saldo actual y vencimiento original, no el importe inicial gastado. Cancelar el canje restaura al mismo vale sin ampliar vida; cancelar la compra emisora retira su vale. Si aún tiene crédito gastado, responde 409 y revierte cancelación/stock/dinero: resolución presencial, no ajuste silencioso. Esto no define derechos legales de devolución; completar el procedimiento con Isaac/abogado antes de lanzar.

### API del personal, aislada del host público

| Ruta | Entrada | Resultado |
| --- | --- | --- |
| `GET /api/vales/config` | — | `{habilitado}`: `VALES_ABIERTOS=si` y bases/aviso preparados; apagado por defecto |
| `POST /api/vales/buscar` | `{codigo}` por cuerpo, nunca URL | `{vale:true, disponible, maximo, expira_en, regalo_disponible:0, por_liberar:0}`; código aún no disponible/vencido/agotado/cancelado: 403 |
| `POST /api/ventas` | contrato anterior + `codigo_vale`, `dolarones`, sin `cliente_id` para papel | `vale_emitido` y `vale_usado` con código, importe, restante, disponibilidad y vencimiento. Reintento no emite otro vale |
| `POST /api/ventas/:id/vale` | folio de venta | Vale vigente para reimpresión, sólo personal con sesión de caja; no recupera vale vencido/agotado/cancelado |

Aplicar `migracion-019-vales.sql` después de las anteriores, con respaldo y despliegue coordinado. No activa emisión por sí sola: configurar `VALES_ABIERTOS=si` únicamente después de revisar estos términos en los textos legales finales. Cerrar emisión no cancela vales existentes. La Epson usa [Code 128 nativo ESC/POS GS k](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lk.html), sin imágenes raster; pendiente ensayo físico de impresión/corte y lector. El módulo de barra está en `MODULO_VALE`, inicialmente 2 puntos para papel de 80 mm. No requiere Firebase ni SMS para el cliente del vale.
