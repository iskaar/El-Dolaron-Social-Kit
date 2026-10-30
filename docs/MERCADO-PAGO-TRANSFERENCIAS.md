# Confirmar transferencias con Mercado Pago (Issue #593)

Investigación. No cambia código de la app, no despliega nada, no agrega dependencias y no usa credenciales: no se creó ninguna aplicación de Mercado Pago, no se inició sesión y no se llamó a ningún endpoint con token. Hecha el 29/10/2026 sobre `main` 7d21196. Continúa [CEP-BANXICO.md](CEP-BANXICO.md): Banxico exige captcha al Worker (verificado el 29/10), así que Isaac pidió probar la ruta oficial, preguntarle a **Mercado Pago**, la cuenta que recibe el dinero, si llegó la transferencia.

Marcas de las fuentes: **leído** = abrí la página y leí su contenido (la herramienta devuelve un resumen del texto de la página, no el HTML crudo); **solo resumen de búsqueda** = lo dijo un resumen de búsqueda y no abrí la fuente; **no verificado** = es mi memoria o mi inferencia, o hace falta una prueba real. Todo lo marcado «no verificado» se decide con la prueba de la sección 9.1, no con este documento.

---

## 1. Resumen

**Veredicto. No encontré ninguna API ni notificación de Mercado Pago, documentada, que confirme una transferencia SPEI concreta recibida en la CLABE de una cuenta personal, y que además entregue la clave de rastreo.** Lo documentado cubre cobros que Mercado Pago procesa (Checkout, QR, Point, cobros SPEI creados por API con una referencia propia) y el reporte «Dinero en cuenta», que sí lista movimientos del saldo pero **no tiene columna de clave de rastreo** ni de nombre del ordenante. Si un depósito a la CLABE de la cuenta aparece en `GET /v1/payments/search`, o en el webhook `payment`, **no está documentado: solo se sabe con una transferencia real**.

| Pregunta | Respuesta |
| --- | --- |
| ¿La app puede confirmar con Mercado Pago una transferencia concreta? | **No con lo documentado.** Con un reporte se podría confirmar «entró un abono de $X en esta hora desde este banco», no «entró la clave XYZ». |
| ¿Con qué campo se empareja? | **No con la clave de rastreo** (el reporte no la trae). Los campos documentados que sirven son monto, fecha y hora (`TRANSACTION_DATE`, `SETTLEMENT_DATE`) y banco de origen (`POI_BANK_NAME`): una coincidencia aproximada, ambigua si dos clientes pagan el mismo monto en la misma hora. |
| ¿Con qué latencia? | Reporte: se genera aparte y tarda «unos minutos» (reporte de liberación, leído; el de «Dinero en cuenta» no declara el plazo). No es consulta en el momento del cobro. Webhook: no hay tópico documentado para dinero recibido. |
| ¿Qué cuenta se necesita? | Una cuenta de Mercado Pago de una persona mayor de edad que cree una aplicación en «Integraciones». La documentación que leí **no exige cuenta de negocio**; el costo y la verificación de identidad no los declara (sección 4). |
| ¿Sirve la integración de Mercado Libre? | **No tal cual.** Mercado Libre exige aplicaciones separadas por unidad desde el 30/08/2026 y los hosts de OAuth son distintos. Haría falta una aplicación de Mercado Pago propia (sección 5). |
| ¿El correo «Recibiste dinero» sirve? | **Técnicamente se puede recibir** con un Email Worker, pero no encontré el texto oficial del correo (no sé si trae la clave de rastreo) y el análisis del HTML es frágil. Es respaldo, no solución (sección 6). |
| ¿Qué hago entonces? | La confirmación de **transferencia exacta** sigue necesitando el CEP de Banxico. Las vías que quedan son un script en la PC de la tienda (B) o un relevo con IP fija (A): sección 9. Antes, **una prueba de 20 minutos con una transferencia real y sin credenciales** (sección 9.1) puede mostrar que Mercado Pago sí lista el abono con su clave. |

---

## 2. APIs evaluadas

Nada de esto lo probé con una llamada autenticada. Las columnas «Muestra transferencias a la CLABE» y «Clave de rastreo» son lo que dice la documentación que leí; «sin documentar» significa que la documentación no lo afirma ni lo niega.

| API o reporte | Qué es | Muestra transferencias a la CLABE | Clave de rastreo | Latencia | Marca |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/payments/search` | Búsqueda de pagos con filtros `status`, `payment_type_id`, `operation_type`, `begin_date`/`end_date`, `range`, `external_reference`; `limit` máx. 50, `offset` máx. 10 000. Autenticada con `Authorization: Bearer <access token>`. | **Sin documentar.** La página solo dice «encontrar cualquier información sobre pagos generados con nuestras APIs». Los `operation_type` que lista son `regular_payment`, `pos_payment`, `recurring_payment`, «etc.» (sin `money_transfer`). Un resumen de búsqueda decía que la referencia de la API lista también `meli_payment`. | **No documentada.** Los campos de la respuesta que hay que mirar son `operation_type`, `transaction_details`, `payer`, `point_of_interaction` y `description`; no pude abrir la referencia de campos (las URL `/developers/*/reference/...` dan 404 desde aquí) | Inmediata (consulta directa) | Página de gestión de pagos: leído. Referencia de campos: **no pude leerla** |
| Reporte de liberación (`release_report`) | CSV de movimientos con liberación de dinero. Endpoints `POST/GET/PUT /v1/account/release_report/config`, `POST /v1/account/release_report` (202, **asíncrono**; 203 si no se pudo crear), `GET /v1/account/release_report/list`. Cuerpo: `begin_date` y `end_date` ISO 8601. Cabecera `Authorization: Bearer`. Columnas configurables (`columns`), zona horaria, envío SFTP. | Habla de «liberación de dinero de ventas». Los `DESCRIPTION` que nombra son `payout`, `reserve-…` y disputas. **No menciona transferencias recibidas.** | No documentada | «Unos minutos»; mientras tanto el estado es «En preparación» | Leído |
| Reporte «Dinero en cuenta» / «Todas las transacciones» (`settlement`) | CSV de «los movimientos que afectaron el saldo de tu dinero en Mercado Pago»; ejemplos: «ingresos de dinero, contracargos y reembolsos». Se genera en el panel: Ventas y facturación > Reportes de ventas y estado de cuenta > Dinero en cuenta > Generar reporte. | **No nombra las transferencias recibidas.** «Solo aparece una operación cuando se aprueba». Los `TRANSACTION_TYPE` documentados: `SETTLEMENT`, `REFUND`, `CHARGEBACK`, `DISPUTE`, `WITHDRAWAL`, `WITHDRAWAL_CANCEL`, `PAYOUT` (mx) y `CASHBACK` (otro país). Un depósito por CLABE no tiene un tipo propio documentado: **no sé en cuál caería**. | **No tiene columna.** De las 66 columnas, las útiles: `SOURCE_ID` (ID de la transacción en Mercado Pago), `EXTERNAL_REFERENCE` (la página dice que puede venir vacío «en pagos de factura, transferencia de dinero, etc.»), `TRANSACTION_AMOUNT`, `SETTLEMENT_NET_AMOUNT`, `TRANSACTION_DATE`, `SETTLEMENT_DATE`, `POI_BANK_NAME` (banco de origen), `PAY_BANK_TRANSFER_ID`, `AVK_ID` («CLABE interbancaria», descripción vaga), `DESCRIPTION`. **No hay nombre ni banco del ordenante** como campos propios. | Generación asíncrona. El plazo no está declarado. La API para generarlo (el equivalente de `release_report`) **no la leí**: la página de generación no cargó | Columnas y alcance: leído. API de generación: **no verificado** |
| Reporte de saldo de cuenta | Saldo por día. | No aplica a cada transferencia. | No | Asíncrono | Solo resumen de búsqueda |
| API de pagos de salida (`payouts`, `/v1/transaction-intents/process`) | Sirve para **enviar** dinero, no para consultar lo recibido. | No | No | No | Solo resumen de búsqueda |
| Cobros SPEI creados por API (Orders / Checkout API, `payment_method.id = clabe`, tipo `bank_transfer`) | **Nosotros** creamos una orden de un monto, Mercado Pago da una referencia de CLABE y un `ticket_url`, el cliente transfiere y el estado de la orden cambia (`action_required` > pagado). Notificaciones del tópico `orders`. | Sí, **pero solo las que iniciamos nosotros** con un cobro creado antes. No cubre a quien ya pagó a la CLABE fija de la cuenta. | La página no menciona clave de rastreo ni `bank_info`; solo `reference` | Con webhook, cuando Mercado Pago confirme | Leído |

**Una alternativa que sí es oficial y sí confirma el abono: cambiar el modelo de cobro.** En lugar de pedir al cliente que transfiera a la CLABE fija, la app crea un cobro SPEI por API con el monto exacto y una referencia de CLABE por pago, y escucha la confirmación. Eso confirma «este cobro se pagó» sin clave de rastreo, sin Banxico y sin captcha. Es un cambio de producto grande (el cliente paga a otra CLABE por cada ticket, la cuenta personal pasa a ser una cuenta de vendedor, Mercado Pago puede cobrar comisión por cobro). **Lo registro como opción, no la recomiendo para este Issue**: cambia el flujo de caja y no está en las decisiones del 29/10. No encontré en la página si cada cobro tiene CLABE propia ni cuál es la comisión en México (no verificado).

---

## 3. Notificaciones

Página de webhooks de Mercado Pago México (leída). Tópicos que lista: `orders`, `payment`, `subscription_authorized_payment`, `subscription_preapproval`, `subscription_preapproval_plan`, `mp-connect`, `wallet_connect`, `stop_delivery_op_wh` (alertas de fraude), `topic_claims_integration_wh`, `topic_card_id_wh`, `topic_merchant_order_wh`, `topic_chargebacks_wh`, `point_integration_wh`.

| Pregunta | Respuesta |
| --- | --- |
| ¿Hay un tópico para dinero recibido por transferencia? | **No.** La página no tiene ninguno. Los más cercanos son `payment` («creación y actualización de pagos») y `orders`. Si un depósito por CLABE dispara `payment` no está documentado. |
| ¿Qué llega? | POST JSON con `id`, `live_mode`, `type`, `date_created`, `user_id`, `api_version`, `action` (p. ej. `payment.created`) y `data.id`. **No trae el detalle**: hay que consultar `GET https://api.mercadopago.com/v1/payments/{id}` con el token. Igual que con Mercado Libre: del cuerpo no se cree nada, se vuelve a pedir el recurso. |
| ¿Cómo se autentica? | Cabecera `x-signature` con formato `ts=…,v1=…` y `x-request-id`; la clave secreta se genera por aplicación al guardar la configuración, no caduca y se puede restablecer. El algoritmo exacto (HMAC SHA-256 sobre un «manifest» con `data.id`, `x-request-id` y `ts`) **no está en el texto que leí** (la pestaña «Sin SDKs» no cargó): lo conozco de memoria, **no verificado**. |
| ¿Reintentos? | Responder 200 o 201 en 22 s; si no, reintenta cada 15 minutos. El Worker debe contestar rápido y consultar después. |

Conclusión: aunque se monte un webhook, **no hay garantía de que se dispare para un abono a la CLABE de la cuenta**. Sirve para cobros que procesa Mercado Pago, no demostrado para esto.

---

## 4. Requisitos de la cuenta

| Pregunta | Lo que dice la documentación | Marca |
| --- | --- | --- |
| ¿Una cuenta personal puede crear una aplicación? | La página de «Integraciones» solo dice que **no está disponible para menores de edad** y que las aplicaciones se vinculan a una cuenta de Mercado Pago. **No menciona cuenta de negocio.** Los términos de Developers aceptan a «personas físicas o morales, sean o no usuarios de Mercado Libre y/o Mercado Pago» (cláusula 1.5). | Leído |
| ¿Credenciales de producción para una cuenta personal? | Se activan en Integraciones > aplicación > Credenciales > Producción > «Activar ambiente de producción»: sector de actividad, sitio web del negocio, aceptar privacidad y términos. **No indica requisitos de tipo de cuenta.** Hay un sitio (eldolaron.com) que se puede poner. | Leído |
| ¿KYC o upgrade de negocio? | **No lo declara.** Si Mercado Pago pide algo más al activar producción, lo dirá la pantalla. | No verificado |
| ¿Cuesta? | La documentación leída **no menciona costo por crear la aplicación o por consultar**; los términos dicen que Mercado Pago puede limitar llamadas y, por encima del límite, **cobrar una tarifa o cortar el acceso** (cláusula 2.3). Para un uso de decenas de consultas al día no debería importar. | Leído |
| ¿Token propio o OAuth? | Para **la propia cuenta** basta el **Access Token de producción de la aplicación** (la credencial que se copia de la pantalla). OAuth *Authorization code* es para actuar a nombre de **otro** vendedor; para recursos propios existe *Client credentials*, con token de **6 horas** que hay que pedir de nuevo. Con *Authorization code*: el token vale **180 días** y se renueva con refresh token (que dura 6 meses). | Leído |
| ¿Vigencia del Access Token de producción? | La página de credenciales **no la declara** ni su renovación. No asumo que no caduque. | No verificado |
| ¿Scopes? | La documentación de OAuth menciona scopes (aparecen en la pantalla de consentimiento y viajan en el token) pero **no enumera nombres**. | Leído |
| Términos relevantes | Licencia «limitada, no exclusiva, personal, revocable, no transferible» (2.1). Prohíbe robots y scraping para obtener lo que Mercado Pago no entrega (7.2 F), cosa que aquí no se haría porque se usa la API. Las claves son confidenciales y el desarrollador responde por ellas (2.2). Al tratar datos de usuarios actúa como **encargado** y no los conserva más de lo necesario (6.1, 6.2, 6.7). Aviso de incidente de seguridad en 24 h (cláusula 10). No hay límite numérico publicado; Mercado Pago lo fija «discrecionalmente». | Leído (hasta la cláusula 15; el final del texto no lo leí) |

---

## 5. Reutilizar la integración de Mercado Libre

Código leído: `app/src/mercadolibre.ts` (1 440 líneas), ruta `/ml/callback`, secretos `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_LLAVE_TOKENS`, `ML_RUTA_NOTIFICACIONES`, `ML_REDIRECT_URI`.

| Pregunta | Respuesta |
| --- | --- |
| ¿Qué hace hoy? | OAuth *Authorization code* con PKCE contra `auth.mercadolibre.com.mx/authorization` y `api.mercadolibre.com/oauth/token`. Tokens **cifrados con AES-GCM** en la fila única `ml_cuenta` de D1. El refresh token es de un solo uso y se gasta bajo un candado en la misma fila. |
| ¿La misma aplicación puede llevar scopes de Mercado Pago? | **No.** `docs/MERCADOLIBRE-API.md` (línea 35, de la documentación de Mercado Libre): «desde el 30/08/2026 las apps deben estar separadas por unidad (una app para Mercado Libre, otra para Mercado Pago); las que tengan scopes `urn:mp:...` mezclados pierden acceso a las APIs de ML», y la recomendación del documento (línea 494) es una app solo de ML. Además, los endpoints de OAuth de Mercado Pago son otros (`auth.mercadopago.com`, `api.mercadopago.com/oauth/token`). |
| ¿Se reutiliza el token de ML? | **No.** El token de Mercado Libre no abre la API de Mercado Pago. |
| ¿Qué sí se reutiliza? | Los patrones: cifrado de secretos en D1, candado de refresh y la regla «del cuerpo de una notificación no se cree nada». **Pero si se usa el Access Token de producción de la aplicación, no hay OAuth que implementar**: es un secreto del Worker, sin refresh ni callback. Eso es lo más simple y lo que propongo. OAuth solo haría falta si la cuenta que recibe fuera de otra persona. |
| ¿Es la misma cuenta? | **Pregunta para Isaac:** la cuenta de Mercado Libre vendedor y la cuenta de Mercado Pago que recibe las transferencias, ¿son el mismo usuario (el mismo correo de inicio de sesión)? En México los dos suelen compartir identidad, pero no está confirmado aquí. Si son distintas, la aplicación de Mercado Pago tiene que crearse con la cuenta que recibe las transferencias. |

---

## 6. Correo como respaldo

Hipótesis: Mercado Pago manda un correo «Recibiste dinero» o similar cada vez que llega una transferencia, y un Email Worker lo lee.

| Aspecto | Evaluación |
| --- | --- |
| ¿Se puede recibir en Cloudflare? | Sí. Un Worker exporta `email(message, env, ctx)`; `message.from` y `message.to` son el sobre SMTP, `message.headers` es un `Headers`, `message.raw` es un flujo MIME y `rawSize` el tamaño (límite de entrada 25 MiB). Cloudflare recomienda `postal-mime` para analizarlo. La **regla catch-all y las direcciones personalizadas pueden tener la acción «Send to a Worker»** (Cloudflare, leído). Ya usamos Email Routing con catch-all en eldolaron.com (memoria del proyecto). `postal-mime` sería una dependencia nueva: requiere autorización. |
| ¿Qué campos trae? | **No encontré el texto oficial del correo** (ni en ayuda de Mercado Pago ni en la documentación). Lo que es probable en una notificación de ingreso: monto, nombre de quien envía, fecha, número de operación. Si trae la **clave de rastreo**, no lo sé. El blog de Mercado Pago dice que la clave de rastreo está en el **comprobante** de la operación (en «Actividad» > detalle > descargar comprobante) (solo resumen de búsqueda), no que esté en el correo. **Se resuelve con un correo real.** |
| Autenticación | Cloudflare exige que el mensaje entrante **pase SPF o esté firmado con DKIM** y aplica la política DMARC del remitente; si falla, se rechaza (Cloudflare, leído). Lo que **no documenta** es si el Worker puede ver el resultado (por ejemplo una cabecera `Authentication-Results`): hay que revisar las cabeceras de un correo real. Si el correo llega reenviado desde Gmail, SPF falla pero la firma DKIM de Mercado Pago se conserva si Gmail no altera el mensaje (inferencia, no verificada). Además de eso, el Worker debería comprobar que el remitente es el dominio de Mercado Pago, que el correo es de la cuenta correcta y que el `Message-ID` no se repite. |
| Fragilidad | Alta. No es un contrato: Mercado Pago cambia plantillas, idioma y estructura sin aviso; un cambio rompe el análisis en silencio. Un correo retrasado, filtrado a spam o duplicado también. Mitigación: si no se reconoce el formato, el pago queda «confirmado por cajero» y se avisa. |
| Cambio de la cuenta | Si el correo de la cuenta de Mercado Pago es de Gmail, la forma menos invasiva es **un filtro de Gmail que reenvíe solo esos correos** a una dirección de eldolaron.com que apunte al Worker (Gmail pide confirmar la dirección destino). Cambiar el correo de inicio de sesión de la cuenta de Mercado Pago no es necesario y **no lo recomiendo** (mueve el acceso a la cuenta que recibe el dinero). El filtro lo crea Isaac. |
| Privacidad | El correo trae nombre y monto de un cliente: se guarda solo lo necesario (monto, fecha, hash) y no el correo completo. |

Veredicto del respaldo: **sirve como señal adicional («llegó un abono de $X a las 12:04»), no como prueba de que la clave de rastreo X es esa**, salvo que el correo traiga la clave. Costo cero (sin servicios nuevos), mantenimiento del análisis a cargo de la app.

---

## 7. Propuesta de integración

> Propuesta. No está implementada ni autorizada. Depende de la prueba de la sección 9.1.

**Cómo encaja en `transferencias_spei`.** El paso 1 (migración 060, PR #596) guarda `clave_rastreo`, `monto`, `aplicado`, `origen`, `verificacion in ('cajero', 'banxico')`, `registrado_por`. Para Mercado Pago:

- `verificacion` ganaría el valor `'mercadopago'`. El `check` actual solo admite `'cajero'` y `'banxico'`, y SQLite no modifica un `check`: se resuelve con **una migración aditiva futura** `app/migracion-NNN-*.sql` que recrea la tabla o, más simple, **agrega una columna** (por ejemplo `mp_operacion text` y `mp_verificado_en text`) y deja `verificacion` en `'cajero'` mientras no se verifica. No se crea ahora.
- Qué se guarda: el `SOURCE_ID` (o el `id` del pago) de Mercado Pago, monto y fecha que dice Mercado Pago, y nunca nombre del ordenante ni el comprobante.
- Regla de coincidencia: **clave de rastreo si Mercado Pago la entrega; si no, monto exacto + ventana de tiempo + banco de origen, y solo si hay una única coincidencia**. Dos candidatos = no se verifica automáticamente. Las coincidencias aproximadas no deben cerrar nada solas.
- Un abono de Mercado Pago solo puede respaldar **una** transferencia registrada (índice único sobre el `SOURCE_ID`), igual que la clave.

**Dónde vive el token.** Secreto del Worker (`wrangler secret put MP_ACCESS_TOKEN`) que pone **Isaac**; nunca en el repositorio, en `wrangler.toml`, en un Issue ni en D1 sin cifrar. Un ambiente por vez (sandbox sin el token de producción, como manda `app/AGENTS.md`). Rotable desde la consola de Mercado Pago. Se declara en `env.d.ts` como opcional; sin él, la verificación no se intenta.

**Flujo.** La consulta a Mercado Pago ocurre **después** del registro del pago, fuera de cualquier transacción de D1, con tiempo límite, y nunca bloquea al cajero. Un reporte asíncrono encaja: un trabajo programado (cron, solo si Isaac lo autoriza) pide el reporte del día, lo empareja con las filas `verificacion = 'cajero'` y marca las que coinciden.

**Si falla** (sin token, Mercado Pago caído, formato desconocido, token vencido, sin coincidencia única, límite): la transferencia **sigue «confirmado por cajero»**, que es el estado de hoy. No se rechaza ni se revierte un pago por no poder verificarlo. Un reintento posterior puede marcarla.

**Qué se prueba** (si se construye): doble de la API de Mercado Pago con coincidencia única, dos candidatos, cero candidatos, error 401/429/5xx, tiempo agotado, abono reutilizado, reintento idempotente. Y una transferencia real de poco monto en sandbox.

---

## 8. Riesgos

| Riesgo | Efecto | Mitigación |
| --- | --- | --- |
| Que el depósito a la CLABE de una cuenta personal **no aparezca** en `payments/search` ni dispare `payment` (no documentado) | La integración no sirve | La prueba de la sección 9.1 lo decide antes de escribir código |
| Sin clave de rastreo, la coincidencia es aproximada | Un cliente podría «prestar» el abono de otro del mismo monto y banco | Solo se verifica con coincidencia única; no sustituye la clave única del paso 1 |
| Mercado Pago cambia reporte, correo o API sin aviso | Se rompe en silencio | Estado «sin verificar» por defecto; alerta si el formato no se reconoce |
| La aplicación o el token se cancelan, o vence el token | Se pierde la verificación | Falla suave a «confirmado por cajero»; token rotable |
| Límite de llamadas discrecional (cláusula 2.3) | Cobro o corte | Pocas consultas (una por transferencia o un reporte al día) |
| Datos de clientes en una cuenta personal y en un correo | Privacidad | No guardar nombres ni comprobantes; solo monto, fecha e ID |
| Una cuenta personal que recibe ventas | Riesgo fiscal y de Mercado Pago sobre uso comercial de la cuenta | Decisión de Isaac con su contador (ya anotada en CEP-BANXICO.md, sección 6) |
| Se confunde «Mercado Pago confirma un abono» con «la transferencia es de ese cliente» | Fraude de identidad | La confirmación prueba que **entró dinero**, no quién lo mandó; el vínculo cliente-pago sigue siendo del cajero |

---

## 9. Decisiones y pasos para Isaac

Nada de esto lo hice yo.

### 9.1 Prueba sin credenciales (recomendada primero, unos 20 minutos)

Con **una transferencia real de poco monto** a la CLABE de la tienda desde otro banco (de $1 a $10):

1. Anota la **clave de rastreo** del comprobante del banco que envió, y la hora.
2. En la app de Mercado Pago, abre **Actividad**, entra al movimiento y abre el **detalle / comprobante**. Mira si muestra la clave de rastreo y el banco de origen. Dime solo **sí/no** y qué campos salen (sin pasarme la CLABE, nombres ni capturas).
3. En el sitio de Mercado Pago, entra a **Ventas y facturación > Reportes de ventas y estado de cuenta > Dinero en cuenta > Generar reporte**, escoge el día y descarga el CSV. Revisa si el abono aparece, **con qué `TRANSACTION_TYPE` y `DESCRIPTION`**, si `POI_BANK_NAME` trae el banco y cuánto tardó en aparecer. De nuevo, dime solo eso, no el archivo.
4. Con eso se cierra la pregunta principal sin crear aplicación ni token.

### 9.2 Si el abono aparece con datos útiles (solo entonces)

5. Entra a **developers.mercadopago.com** con la cuenta que recibe las transferencias > **Integraciones > Crear aplicación**. Crea una aplicación solo de Mercado Pago, sin Mercado Libre (sección 5).
6. En la aplicación, **Credenciales > Producción > Activar ambiente de producción** (sector de actividad, sitio `eldolaron.com`, aceptar términos).
7. Copia el **Access Token de producción** y ponlo tú mismo como secreto del Worker (`wrangler secret put MP_ACCESS_TOKEN`). **No lo pegues en un Issue, en el chat ni en un archivo del repo.**
8. Pídeme una prueba mínima: una consulta de lectura a `GET /v1/payments/search` con ese token, para ver si el abono real aparece y con qué campos. Esa llamada autenticada la hace el código o tú, no la hice aquí.
9. Si hay webhook útil: en la aplicación, **Notificaciones > Webhooks**, URL de producción y tópico `payment`; la clave secreta se queda en el panel hasta que se ponga como secreto.

### 9.3 Preguntas

| # | Pregunta | Recomendación |
| --- | --- | --- |
| 1 | ¿La cuenta de Mercado Libre vendedor y la cuenta de Mercado Pago que recibe son la **misma**? | Dímelo antes del paso 5. |
| 2 | ¿Hacer la prueba 9.1? | Sí. Es gratis y evita construir sobre algo que no existe. |
| 3 | ¿Escribirle a **soporte de desarrolladores de Mercado Pago** («¿hay API o webhook para ingresos por transferencia SPEI a una cuenta personal, con clave de rastreo?»)? | Sí, una pregunta corta. Es la única forma de cerrar lo que la documentación no dice. |
| 4 | ¿Cobros SPEI por API (sección 2, último renglón) en lugar de la CLABE fija? | No por ahora: cambia el flujo de caja. |
| 5 | Si la prueba 9.1 falla (no aparece, o sin clave): ¿B o A? | Ver abajo. |

### 9.4 Si Mercado Pago no da confirmación transferencia por transferencia

La respuesta honesta es **no la da** (hasta que 9.1 diga lo contrario). La confirmación exacta sigue dependiendo del CEP de Banxico, que no contesta a un Worker. Quedan dos caminos. En ninguno se resuelve el captcha ni se rotan IP: si Banxico lo pide, la consulta se detiene y la transferencia sigue «confirmado por cajero».

| | **B. Script en la PC de la tienda (Windows)** | **A. Relevo pequeño fuera de Cloudflare con IP fija** |
| --- | --- | --- |
| Qué es | Un script como `tools/cep_probe.py` que corre en la PC de la tienda, desde su IP de casa o local (donde la sonda ya mostró que Banxico no pide captcha). Pregunta al Worker qué transferencias están «confirmado por cajero» sin verificar, consulta Banxico y devuelve el resultado. | Un servicio mínimo en un servidor con IP fija que recibe la consulta del Worker y la reenvía a Banxico. |
| Costo | $0 en servicios. La PC ya existe y tiene que estar prendida y con internet. | Un servidor pequeño: del orden de unos USD 5 al mes (**estimación mía, sin cotizar**). Y es un servicio nuevo: requiere autorización (`app/AGENTS.md`). |
| Mantenimiento | Python instalado, una tarea programada de Windows, que no se apague. Si Banxico cambia el formulario, hay que ajustar el script. Un punto de falla: la PC. | Parches del servidor, monitoreo, dominio, secretos. Más trabajo que B. |
| Latencia | Cada pocos minutos; **el cajero no espera**: el pago ya está registrado y se marca después. | Casi inmediata, si Banxico no pide captcha. |
| ¿Funciona con Banxico? | **Probado**: la sonda no recibió captcha desde un equipo normal en México. | **No sabemos.** Una IP de centro de datos puede recibir captcha igual que Cloudflare. Hay que probar antes de pagar el servidor. |
| Autenticación con el Worker | El script usa una llave propia (secreto en la PC y en el Worker), con permiso solo para leer pendientes y escribir resultados. Nunca el PIN de un cajero. | Ídem. |
| Recomendación | **B primero**, si 9.1 no basta: no agrega servicios y la prueba de campo ya existe. | A solo si B no es viable (la PC no es confiable) y después de probar que la IP no recibe captcha. |

---

## 10. Fuentes

| Fuente | Qué aporta | Marca |
| --- | --- | --- |
| https://www.mercadopago.com.mx/developers/en/docs/checkout-api-payments/additional-content/reports/released-money | Reporte de liberación: qué es, generación, «unos minutos», `Payout` | Leído |
| https://www.mercadopago.com.mx/developers/en/docs/checkout-api-payments/additional-content/reports/released-money/api | Endpoints `release_report` (config, creación asíncrona 202, listado), cabecera Bearer; **faltó el final de la página** (descarga, límites, errores) | Leído (los primeros 100 000 de 125 940 caracteres) |
| https://www.mercadopago.com.mx/developers/en/docs/checkout-api-payments/additional-content/reports/account-money/report-fields | 66 columnas y los `TRANSACTION_TYPE` del reporte Dinero en cuenta; sin clave de rastreo | Leído |
| https://www.mercadopago.com.mx/developers/en/docs/checkout-api-payments/additional-content/reports/account-money/introduction | Alcance: «movimientos que afectaron el saldo», solo operaciones aprobadas; generación en el panel | Leído |
| https://www.mercadopago.com.ar/developers/en/docs/reports/account-money/how-to-use | Uso del reporte; CSV con UTF-8; `SETTLEMENT_NET_AMOUNT` | Leído |
| https://www.mercadopago.com.mx/developers/en/docs/checkout-api-payments/additional-content/reports/account-money/generate-report y `/generate` | API para generar el reporte de Dinero en cuenta | **No cargó** (404 o solo el índice); no verificado |
| https://www.mercadopago.com.mx/developers/en/docs/subscriptions/additional-content/payment-management | `GET /v1/payments/search`: parámetros y `operation_type` (`regular_payment`, `pos_payment`, `recurring_payment`, «etc.») | Leído |
| https://app.unpkg.com/mercadopago@3.0.0/files/dist/clients/payment/search/types.d.ts | Tipos del SDK: filtros de búsqueda y `operation_type` en el resultado | Leído |
| Referencia `developers/*/reference/payments/_payments_search/get` y `_payments_id/get` | Campos de la respuesta del pago | **404 desde aquí; no leída** |
| https://www.mercadopago.com.mx/developers/es/docs/checkout-api-orders/payment-integration/spei-transfers | Cobros SPEI por API: `clabe`/`bank_transfer`, `action_required`, `reference`, tópico Order | Leído |
| https://www.mercadopago.com.mx/developers/es/docs/your-integrations/notifications/webhooks | Lista de tópicos, `x-signature`, payload, reintentos; sin tópico de dinero recibido | Leído (la pestaña «Sin SDKs» no cargó) |
| https://www.mercadopago.com.mx/developers/es/docs/your-integrations/credentials | Activar producción: sector, sitio web, términos | Leído |
| https://www.mercadopago.com.mx/developers/es/docs/your-integrations/introduction | Integraciones: no para menores; se necesita una cuenta | Leído |
| https://www.mercadopago.com.mx/developers/es/docs/security/oauth/introduction y `/creation` | Authorization code (token de 180 días, refresh de 6 meses) y client credentials (6 horas) | Leído |
| https://www.mercadopago.com.mx/developers/es/docs/resources/legal/terms-and-conditions | Términos de Developers: límites discrecionales, claves, datos | Leído (hasta cerca del 90 %) |
| https://www.xataka.com.mx/empresas-y-economia/mercado-pago-acepta-transferencias-interbancarias-mexico-todo-que-hay-que-saber-para-enviar-recibir-dinero-spei | Mercado Pago pasó de STP a SPEI directo y cambió la CLABE en 2024 | Leído (no habla de notificaciones) |
| https://www.mercadopago.com.mx/blog/como-rastrear-un-deposito-bancario | La clave de rastreo está en el comprobante; ver «Actividad» | Solo resumen de búsqueda |
| https://developers.cloudflare.com/email-routing/email-workers/ | Controlador `email()`, `ForwardableEmailMessage`, `postal-mime`, 25 MiB | Leído |
| https://developers.cloudflare.com/email-routing/postmaster/ | Requiere SPF o DKIM y aplica DMARC; rechaza si falla | Leído |
| https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/ | Catch-all y direcciones personalizadas pueden enviar a un Worker | Leído |
| `app/src/mercadolibre.ts`, `app/src/env.d.ts`, `docs/MERCADOLIBRE-API.md` (líneas 35 y 494), `app/migracion-060-transferencias-spei.sql`, `docs/CEP-BANXICO.md` | Integración de ML, separación ML/MP, tabla `transferencias_spei` | Leído |

**Lo que no pude verificar** (se cierra con 9.1, con 9.2 o con soporte de Mercado Pago): si un depósito SPEI a la CLABE de una cuenta personal aparece en `payments/search` o dispara el webhook `payment`; si el reporte de Dinero en cuenta lo incluye y con qué tipo; si la clave de rastreo está en alguna parte de la API; el texto y los campos del correo; el cálculo exacto de la firma `x-signature`; la vigencia del Access Token de producción; si activar producción exige verificación adicional o cuesta; la API de generación del reporte de Dinero en cuenta.
