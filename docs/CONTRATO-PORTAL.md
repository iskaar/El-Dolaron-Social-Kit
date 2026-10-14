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
| `POST /api/portal/registro` | `{nombre, acepta_bases: true, declara_mayor_edad: true, bases_version}` | `{id, numero, nombre, disponible, por_liberar, regalo_disponible, premio}`. Reintento del mismo UID es idempotente; teléfono duplicado con otro UID: 409. `premio` es `null` sin cupos. |
| `GET /api/portal/yo` | — | `{id, numero, nombre, telefono: "+52...", bases_version}` del UID titular. |
| `GET /api/portal/saldo` | — | `{disponible_compras, regalo_sujeto_minimo, por_liberar, disponible_total, lotes}` con origen, restante, liberación y vencimiento. El regalo sólo se gasta en ticket de al menos $1,000 antes de D (#108). |
| `POST /api/portal/codigo` | `{maximo}` centavos enteros, entre cero y saldo disponible | `{codigo, maximo, expira_en}`; 201. Reemisión antes de cinco segundos: 429. Requiere bases vigentes. |
| `DELETE /api/portal/codigo` | — | Revoca el código del titular; `{ok:true}`. |
| `POST /api/portal/vale` | `{codigo}` del vale `DP-…`, por cuerpo | Pasa un vale completo y vigente a la cuenta con tarifa de socio (#258): 201 `{importe, disponible_desde, vence_en}`; repetido por el mismo socio: 200 `{ya_estaba:true}`; de otra cuenta, usado, vencido, cancelado o de compra pagada con D: 409; más de 2 en 7 días: 429. |
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

La base de `main` (`d864810`) ya incluye las migraciones **015-pin-cajero** y **020-devoluciones-por-pieza**, además de las anteriores. Sobre esa base, aplicar únicamente **016 → 018 → 019 → 021**, en ese orden, antes del Worker integrado. La prueba de actualización en `devoluciones.test.ts` parte de ese esquema con ventas y PIN de cajero; verifica que 020 no depende de las columnas nuevas de 016/018/019/021. Para instalación limpia, aplicar `schema.sql` y todas las `migracion-*.sql` en orden numérico.

Comandos previstos desde `app/`, **documentados, no ejecutados en remoto por A07**:

```sh
npx wrangler d1 execute el-dolaron --remote --file=migracion-016-portal.sql
npx wrangler d1 execute el-dolaron --remote --file=migracion-018-codigo-socio.sql
npx wrangler d1 execute el-dolaron --remote --file=migracion-019-vales.sql
npx wrangler d1 execute el-dolaron --remote --file=migracion-021-pedido-hash.sql
```

016 agrega identidad/aceptación y cupos; 018 elimina las cuatro columnas de PIN **de socios** y crea códigos/desafíos, conservando el PIN de cajeros de 015; 019 crea vales; 021 agrega `ventas.pedido_hash` sin cambiar los folios históricos (quedan en `NULL`). Ninguna requiere una migración 017: no existe en este clon. No repetir 015/020 ni las cuatro pendientes sobre una base que ya las tenga. Respaldar D1 y ensayar restauración antes de la ejecución autorizada. Coordinar migraciones y Worker: código anterior que use PIN de socio no funciona después de 018; la reversión necesita respaldo, no sólo desplegar el Worker viejo. Descuentos #120 siguen siendo una revisión aparte antes de producción.

### Cierre por defecto y variables de activación

`wrangler.jsonc` no define las variables siguientes. Con todas ausentes, no hay alta presencial, registro público, configuración Firebase/SMS ni emisión/acumulación nueva; sin `HOST_PORTAL` las APIs del portal responden 404. La caja monetaria conserva las ventas, existencias, bandas, cancelaciones/corte y PIN de cajero de `main`, sin necesitar Firebase.

| Variables | Puerta que controlan | Evidencia en este clon |
| --- | --- | --- |
| `BASES_APROBADAS_VERSION`, `PORTAL_BASES_TEXTO`, `PORTAL_AVISO_TEXTO` | Alta presencial y textos legales: versión no vacía que no empiece con `borrador`, bases y aviso no vacíos. | `app/src/dolarones.ts:87` y `:135` |
| `PROMOCION_INICIO` | Instante UTC válido alcanzado según el servidor: acumulación por compras, emisión de vales y apertura del registro/promoción. | `app/src/dolarones.ts:92` y `:246` |
| `PORTAL_REGISTRO_ABIERTO=si` | Registro/promoción pública, además de bases e inicio; no habilita SMS por sí sola. | `app/src/portal.ts:13` |
| `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY` | Configuración y validación de identidad del portal; proveedor Phone, dominio autorizado, cuotas y presupuesto de SMS requieren configuración externa aprobada. | `app/src/portal.ts:21` y `:203`; sin configuración, el frontend se detiene en `app/public/portal.js:206` |
| `FIREBASE_AUTH_DOMAIN` | Dominio de autenticación opcional; por defecto `<projectId>.firebaseapp.com`. | `app/src/portal.ts:206` y `app/src/worker.ts:1147` |
| `HOST_PORTAL` | Host público aislado; también necesita DNS/ruta autorizados. | `app/src/worker.ts:1135`; rutas en `app/wrangler.jsonc:43` |
| `VALES_ABIERTOS=si` | Emisión nueva de papel, además de bases e inicio. | `app/src/vales.ts:6` y `:80` |

**Matiz de canje:** sin vales emitidos, el canje falla cerrado (403 al buscar / 409 al cobrar). `VALES_ABIERTOS` controla emisión, **no bloquea vales previos válidos**, tampoco al apagar la promoción o las bases; #134 conserva su canje/reimpresión/cancelación hasta vencimiento. No interpretar estas variables como un interruptor de emergencia del saldo ya prometido. A06 debe revisar ese comportamiento; si Isaac requiere suspender también vales vigentes, debe decidirlo expresamente antes de cambiarlo.

La prueba de configuración ausente usa ventas monetarias y una base sin vales; no certifica la configuración remota. «La caja vende igual» se refiere a precios del catálogo, pago, stock, bandas, PIN y corte. La cadena cambia el transporte del cobro monetario: intenta confirmar con un timeout de cinco segundos y conserva la venta en cola si pierde la respuesta. El folio y `creado_en` se mantienen juntos al reintentar un canje, para no rechazar el mismo pedido por la huella de 021. Ensayar latencia y pérdida de respuesta en las cajas físicas antes del despliegue.

### Entrega local A07 — 01/10/2026

Estado: listo para revisión; Claude completa el merge en Git.

Hecho: merge de `origin/main` (`d864810`) sobre `99e4597`, sin rebase. Conflicto textual resuelto conservando filas que abren el desglose y colocando «Imprimir vale» en `pintarDetalle`, con avisos dentro de la ventana. Cancelar por pieza un pago con vale sigue devolviendo 409; la emisión se recalcula al devolver piezas y el crédito gastado aborta toda cancelación. Cancelación completa reconoce retiros previos de vale y socio. `registrarVenta` conserva huella y recuperación de reintento; caja conserva la fecha del pedido al reintentar para no provocar un 409 espurio.

Validación: `npm test` pasa 178/178 pruebas (8 nuevas frente a las 170 iniciales) y `npm run typecheck` pasa. Incluye Worker/SQLite de dinero, stock, saldo, reintento y carrera entre cajas; actualización desde main con 020 aplicada; configuración cerrada; detalle/impresión y respuesta perdida en caja. Sintaxis del script de caja, ausencia de marcadores y `git diff --check` correctos. Los 12 assets pasan una comprobación equivalente con Node; `python tools/validate_assets.py` no se pudo ejecutar porque no hay intérprete Python disponible en este entorno. Sin migraciones remotas ni activación de servicios.

Pendiente: por instrucción de Isaac, A07 no ejecuta git de escritura. El índice aún marca `app/public/caja.html` como conflicto aunque el archivo no tiene marcadores; Claude debe marcarlo resuelto, revisar el diff y completar el commit, por ejemplo `Integra main y corrige cancelaciones y reintentos de Dolarones`. Claude/CI debe ejecutar `python tools/validate_assets.py` con un intérprete disponible y publicar el contexto en el Issue/PR correspondiente. No hacer push/PR/despliegue en esta entrega. A06 debe revisar las restricciones SQL dentro del batch y el retiro acumulado del vale (cada pieza queda en `devoluciones`); falta ensayo autorizado en D1/sandbox y con dos cajas, lector e impresora físicos. Isaac mantiene pendiente la autorización comercial/legal y cualquier suspensión de vales vigentes.

## Configuración pendiente

1. Configurar proyecto Firebase/Identity Platform, proveedor Phone, región México, dominio autorizado, límites y presupuesto de SMS; no hay proveedor ni SMS reales activados por este PR. Definir `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY` y, si es diferente del dominio estándar, `FIREBASE_AUTH_DOMAIN`. Ensayar SDK/reCAPTCHA y CSP en el dominio aprobado con [números ficticios Firebase](https://firebase.google.com/docs/auth/web/phone-auth#test-with-fictional-phone-numbers), sin SMS pagados.
2. Definir hostname público real en `HOST_PORTAL` y agregarlo a `routes` de Wrangler tras verificar DNS y aislamiento; `workers_dev` y preview siguen apagados. No usar Access para clientes.
3. Obtener revisión legal, razón social/RFC y correo de privacidad. Publicar textos finales, sin corchetes, en `PORTAL_BASES_TEXTO` y `PORTAL_AVISO_TEXTO`; definir versión en `BASES_APROBADAS_VERSION`, instante UTC en `PROMOCION_INICIO`, y sólo al final `PORTAL_REGISTRO_ABIERTO=si`. Estos valores están ausentes en el repositorio.
4. Conciliar regalos legados, revisión cruzada de #129/#110 y ensayo con dos cajas, impresión, cancelación, red caída, código copiado/vencido y recuperación. Probar el lector físico leyendo Code 128 desde un teléfono: el código existe, pero la compatibilidad del hardware aún no está comprobada. Wallet queda pospuesto.

## Vales sin registro — decisión de Isaac, #133

Socios conservan **10 D por cada $100 completos** monetarios, liberados al día siguiente y vigentes 12 meses. Dar el teléfono sólo acumula: no autoriza gasto. Sin socio, la compra puede emitir **5 D por cada $100 completos**, en un vale impreso, sin teléfono, nombre ni alta. Ejemplo $250: 20 D para socio o 10 D en papel, nunca ambos. La parte pagada con D no genera crédito. Se conserva la aritmética por bloques aprobada; no se convierte en porcentaje proporcional sobre centavos.

La elegibilidad de compras para acumular se decide con la hora del servidor cuando acepta la venta, comparada con `PROMOCION_INICIO`. Una venta en cola desde antes del inicio que se sincroniza después sí puede ganar; una fecha futura escrita por el dispositivo no adelanta la promoción. Sin fecha válida, no se acredita compra ni se emite vale. El ticket de socio en cola muestra que sus Dolarones siguen sin confirmar.

- `DP-…` es un identificador aleatorio de 96 bits, no un monto modificable. D1 conserva el código legible **sólo para reimpresión autorizada del personal**, con venta emisora, importe, restante y vigencia. Esto difiere del código temporal del socio, del que sólo se conserva hash. No exponer códigos de papel en logs, listas de ventas, URLs, exports públicos ni portal. Quien tenga el papel o una copia puede gastar; las copias comparten saldo, no generan crédito adicional.
- Disponible desde la siguiente medianoche de la tienda, como lo ganado por compras. Vence **exactamente 30 días desde la emisión confirmada del servidor** (UTC), no al final del día 30. El ticket imprime disponibilidad y hora de vencimiento en America/Mexico_City. Gasto parcial, reimpresión o devolución no amplían el plazo. El regalo de apertura y su mínimo de $1,000 no se mezclan con estos vales ganados.
- Un vale o una membresía por ticket; combinar varios o transferir el vale a una cuenta no está implementado. «Usar máximo» aplica el menor de total, saldo elegible y máximo autorizado. Para papel, el máximo es su saldo actual; para socios respeta la autorización del portal. Elegir por teléfono no habilita ese botón ni canje.
- Emisión, canje, movimiento, venta y stock se confirman en un batch. No imprimir barcode gastable antes de respuesta confirmada; un timeout/red caída conserva el mismo ID en la cola y el ticket indica que la elegibilidad del vale aún no se conoce. Al sincronizar, la caja guarda si el servidor emitió el vale y ofrece imprimirlo por folio. «Ventas de hoy → abrir ticket → Imprimir vale» o «Reimprimir vale → folio Venta» recupera el mismo vale, incluso de otro día. Una venta rechazada no genera vale; revisar antes de devolver mercancía o dinero.
- Reimprimir devuelve saldo actual y vencimiento original, no el importe inicial gastado. Cancelar el canje restaura al mismo vale sin ampliar vida; cancelar la compra emisora retira su vale. Si aún tiene crédito gastado, responde 409 y revierte cancelación/stock/dinero: resolución presencial, no ajuste silencioso. Esto no define derechos legales de devolución; completar el procedimiento con Isaac/abogado antes de lanzar.
- Un ticket pagado con vale (`dolarones > 0`, sin socio) sigue rechazando cancelación por pieza con 409 «cancélalo completo»; sólo la cancelación completa restaura ese saldo. En una compra emisora pagada en dinero, devolver piezas recalcula lo ganado sobre el dinero que queda cobrado (5 D por bloque), retira el exceso y conserva código, importe original y vencimiento. Los retiros se acumulan en su movimiento `retiro`; `devoluciones` conserva cada pieza, autor y motivo. Si el crédito emitido sigue gastado, incluso por un canje concurrente, se aborta el batch entero. Cancelar después todo lo restante reconoce esos retiros previos sin devolver dinero/stock dos veces; la misma regla de crédito gastado se aplica a socios (#135).

### Pasar el vale a una cuenta — decisión de Isaac, #258

El QR del vale es `https://dolarones.eldolaron.com/v#<30 dígitos>`: la cámara del celular abre el portal y el código, después de `#`, no llega al servidor. El portal lo guarda en el teléfono (`localStorage`), quita el `#` de la barra y, al entrar o terminar el registro, llama `POST /api/portal/vale`. Un solo batch cierra el vale (`restante = 0`, `reclamado_por`, `reclamado_en`), asigna la venta al socio (`ventas.cliente_id`) y crea su lote de compra: 10 D por cada $100 cobrados en dinero, disponible desde la medianoche siguiente a la compra y con vencimiento a 12 meses de ella. Desde ahí, recibos, cancelación y devolución por pieza siguen las reglas de socio; `retirarVale` ignora vales reclamados. El tope (`RECLAMOS_POR_SEMANA = 2` en 7 días) y la vigencia se vuelven a comprobar dentro del batch. La caja sigue leyendo el QR: `codigoDeDigitos` quita la URL. Bases v4, punto 6 ter. Migración 032.

### API del personal, aislada del host público

| Ruta | Entrada | Resultado |
| --- | --- | --- |
| `GET /api/vales/config` | — | `{habilitado}`: `VALES_ABIERTOS=si`, bases/aviso preparados e inicio de promoción alcanzado; apagado por defecto |
| `POST /api/vales/buscar` | `{codigo}` por cuerpo, nunca URL | `{vale:true, disponible, maximo, expira_en, regalo_disponible:0, por_liberar:0}`; código aún no disponible/vencido/agotado/cancelado: 403 |
| `POST /api/ventas` | contrato anterior + `codigo_vale`, `dolarones`, sin `cliente_id` para papel | `vale_emitido` y `vale_usado` con código, importe, restante, disponibilidad y vencimiento. Reintento no emite otro vale |
| `POST /api/ventas/:id/vale` | folio de venta | Vale vigente para reimpresión, sólo personal con sesión de caja; no recupera vale vencido/agotado/cancelado |

Aplicar `migracion-019-vales.sql` después de las anteriores, con respaldo y despliegue coordinado. No activa emisión por sí sola: configurar `VALES_ABIERTOS=si` únicamente después de revisar estos términos en los textos legales finales. Cerrar emisión no cancela vales existentes. La Epson usa [Code 128 nativo ESC/POS GS k](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/gs_lk.html), sin imágenes raster; pendiente ensayo físico de impresión/corte y lector. El módulo de barra está en `MODULO_VALE`, inicialmente 2 puntos para papel de 80 mm. No requiere Firebase ni SMS para el cliente del vale.
