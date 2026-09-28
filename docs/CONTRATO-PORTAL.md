# Contrato del portal Dolarones — Issue #109

**Estado:** backend preparado; registro público desactivado. Los importes son centavos enteros: `100` = 1 D o $1 MXN. El recibo es comprobante de compra, no factura fiscal.

## Puertas y autenticación

- El portal sólo responde en el hostname exacto `HOST_PORTAL`. Sin ese valor y sin ruta de Cloudflare, no hay host público. Ese host sólo permite `/api/portal/*` salvo `/api/portal/llegada`; cualquier pantalla, asset, `/api/socios`, `/api/ventas` y API del personal devuelve 404. El host del personal rechaza las rutas del cliente.
- La web obtiene un ID token tras [verificación SMS de Firebase](https://firebase.google.com/docs/auth/web/phone-auth) y lo manda en `Authorization: Bearer <ID_TOKEN>` por HTTPS, nunca en URL. El Worker comprueba proyecto, emisor, tiempos, método `phone`, teléfono E.164 `+52` + diez dígitos y UID. Consulta [accounts:lookup](https://firebase.google.com/docs/reference/rest/auth#section-get-account-info) en cada petición para validar el token ante Firebase, cuenta activa, teléfono actual y `validSince` frente a `auth_time` ([revocación](https://firebase.google.com/docs/auth/admin/manage-sessions)). No registra tokens ni teléfono.
- El UID de Firebase se guarda único en `clientes.auth_uid`; `clientes.id` sigue como llave histórica de ventas y lotes. `bases_version` y `bases_aceptadas_en` guardan aceptación vigente. El teléfono sólo se usa para contacto y búsqueda del personal. Un UID nuevo con el teléfono de un socio previo recibe 409 y requiere recuperación presencial; jamás se vincula automáticamente. Un UID existente puede actualizar su teléfono verificado si no pertenece a otro socio.
- Sin `PORTAL_REGISTRO_ABIERTO=si`, `BASES_APROBADAS_VERSION` distinta de `borrador*`, y `PROMOCION_INICIO` UTC alcanzado, las altas y llegadas devuelven 503. No hay prerregistro: el primer otorgamiento ocurre después de ese instante y su vigencia de 30 días comienza exactamente al otorgarse. La fecha/hora y el tratamiento de casos anteriores a la apertura requieren aprobación en las bases antes de habilitarlo.
- La caja conserva el PIN para canjear D. La primera llegada la acredita una persona con permiso de caja y sesión Cloudflare Access. El SMS de Firebase no autoriza canje.

## API JSON

Todas las respuestas privadas usan `Cache-Control: no-store`. No se manda teléfono, UID ni token como parámetro URL.

| Método y ruta | Cuerpo o parámetros | Respuesta principal |
| --- | --- | --- |
| `POST /api/portal/registro` | `{nombre, pin: "1234", acepta_bases: true, bases_version}` | `{id, numero, nombre, disponible, por_liberar, regalo_disponible, premio}`. Reintento del mismo UID es idempotente; teléfono duplicado con otro UID: 409. `premio` es `null` sin cupos. |
| `GET /api/portal/yo` | — | `{id, numero, nombre, telefono: "+52...", bases_version}` del UID titular. |
| `GET /api/portal/saldo` | — | `{disponible_compras, regalo_sujeto_minimo, por_liberar, disponible_total}`. El regalo sólo se gasta en ticket de al menos $1,000 antes de D (#108). |
| `GET /api/portal/recibos?limit=20&cursor=...` | `limit` 1–50; `cursor` opaco devuelto por la página anterior | `{recibos: [{id, registrado_en, creado_en, total, dolarones, forma_pago, cancelada, pago_monetario}], siguiente}`. Orden descendente estable. |
| `GET /api/portal/recibos/:id` | UUID de venta | `{id, creado_en, registrado_en, total, dolarones, forma_pago, efectivo, cambio, cancelada, cancelada_en, pago_monetario, d_usados, d_ganados, lineas: [{codigo, nombre, precio, cantidad}], tipo: "recibo_de_compra_no_factura"}`. Venta ajena o inexistente: 404. |
| `POST /api/portal/llegada` **sólo host del personal** | `{cliente_id}` | `{premio}`; primera llegada recibe 500 D, demás usan 49 cupos presenciales. Reintento devuelve el mismo premio. |

Errores: 400 entrada inválida, 401 token faltante/inválido/vencido/revocado, 404 ruta o recibo inaccesible, 409 conflicto de teléfono o reemplazo pendiente, 503 portal cerrado o proveedor no disponible. No devolver detalle de cuentas ajenas.

## Premios y migración

Ejecutar `app/migracion-015-portal.sql` antes del Worker. Las filas de `premios_apertura` fijan 50 cupos online = 7,300 D y 50 en tienda = 7,700 D. Se adjudica el menor orden libre en una transacción D1; los vencidos quedan ocupados. El primer arribo queda reservado aun si su reemplazo falla. Si su premio online está intacto y vigente, una sola transacción lo revoca, libera su cupo y concede 500 D. Si tuvo canje, aun revertido, o venció, responde 409 y **no cambia el saldo**: Isaac y abogado deben fijar la resolución antes de operación real. No se asignan los 500 D a la segunda llegada.

El registro online y la acreditación de llegada responden 409 **antes de crear socio o premio** si D1 contiene regalos anteriores a esta migración sin reconciliar. Hay que revisar esos lotes y ventas antes de encenderla; no ejecutamos migración destructiva ni reasignación automática. Para instalación limpia, aplicar `schema.sql` y después `migracion-002` a `migracion-015` en orden; la prueba D1 ejecuta exactamente esa secuencia. La alta presencial ya no concede premio por número global: personal registra la llegada explícitamente. Claude (#110) debe incorporar ese paso al flujo de caja y consumir exactamente estas rutas.

## Configuración pendiente

1. Configurar proyecto Firebase/Identity Platform, proveedor Phone, región México, dominio autorizado, límites y presupuesto de SMS; no hay proveedor ni SMS reales activados por este PR. Definir `FIREBASE_PROJECT_ID` y `FIREBASE_WEB_API_KEY` en el entorno Worker correspondiente. La web de #110 usará el SDK cliente con el mismo proyecto.
2. Definir hostname público real en `HOST_PORTAL` y agregarlo a `routes` de Wrangler tras verificar DNS y aislamiento; `workers_dev` y preview siguen apagados. No usar Access para clientes.
3. Obtener revisión legal, razón social/RFC y correo de privacidad. Publicar bases y aviso finales; definir versión aprobada en `BASES_APROBADAS_VERSION`, instante acordado en `PROMOCION_INICIO`, y sólo al final `PORTAL_REGISTRO_ABIERTO=si`. Estos valores están ausentes en el repositorio.
4. Conciliar premios legados de D1, ensayar con SMS de prueba sin costo y revisión cruzada de #110 antes de cualquier alta pública. Wallet queda pospuesto.
