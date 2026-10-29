# Validar transferencias con el CEP de Banxico (Issue #593)

Investigación de la fase 1. No cambia código de la app, no despliega nada y no agrega dependencias. Hecha el 29/10/2026 sobre `main` 2e58a37.

Marcas de las fuentes: **verificado** = lo comprobé con una petición real; **leído (código)** = lo leí en JavaScript/Python publicado y no lo probé en vivo; **leído (página)** = texto de una página oficial o del proveedor; **solo resumen** = lo dijo un resumen de búsqueda y no abrí la fuente.

---

## 1. Resumen

| Pregunta | Respuesta |
| --- | --- |
| ¿Se puede consultar el CEP con una petición automática? | **Sí, desde una IP normal.** Desde mi equipo en México, sin captcha: la consulta de una transferencia inexistente respondió «Operación no encontrada» (verificado). |
| ¿Se puede desde un Worker de Cloudflare? | **No hoy. Verificado 3 de 3 veces:** desde el borde de Cloudflare (`wrangler dev --remote`, centro DFW) Banxico contestó «La imagen de seguridad no fue ingresada correctamente» y activó el captcha. La misma consulta, con los mismos datos, desde mi IP no lo pidió. **Aquí me detuve:** no se resuelve ni se evade. |
| ¿Hay captcha? | Sí, pero **condicional**: la página trae el campo oculto y el servidor lo exige según el origen. Y Banxico **avisa antes**: el catálogo (`instituciones.do`) trae `overrideCaptcha`, que fue `true` desde mi IP y `false` desde Cloudflare (verificado). Basta leer ese campo para saber si un origen puede consultar. |
| ¿Sirve para la cuenta de la tienda (Mercado Pago, CLABE 722…)? | **Probablemente sí, sin verificar.** «Mercado Pago W» está en el catálogo como emisor y receptor con el código **90722** (verificado) y Banxico acepta consultas hacia él (la consulta sintética respondió «no existe», no «institución inválida»). No hay ninguna transferencia real hacia Mercado Pago probada. Sección 6. |
| ¿Hay API oficial? | No. Hay un formulario web, un servicio por lotes (archivo TXT, resultados por correo) y un validador de XML. Ninguno es una API. |
| ¿Qué falta? | Una transferencia real para ver la respuesta «encontrada» de punta a punta, el tiempo que tarda en aparecer el CEP, y la CLABE y banco de la tienda. Sin eso, esa parte está **leída (código)**, no verificada. |

**Veredicto.** Banxico responde, pero no a un Worker: el camino «Worker → Banxico» está bloqueado por captcha. Sí es técnicamente posible verificar con un tercero que consulte desde una IP que Banxico acepta (Tlaloc, apiCEP) o con un relevo propio en una IP de México. Cualquiera de los dos es un servicio nuevo y necesita autorización de Isaac (`app/AGENTS.md`). Mientras tanto, lo que ya se puede hacer sin servicio nuevo es **impedir que una misma clave de rastreo cuente dos veces** (sección 7).

---

## 2. Cómo funciona la consulta

Base: `https://www.banxico.org.mx/cep/`. Es una aplicación Java (cookies `JSESSIONID`, `Hex…`, `TS…`) con un front de jQuery. Todo sale de `cep-min.js` y de la página (verificados al descargarlos) y de cep-python (leído, código).

| # | Petición | Campos | Para qué | Estado |
| --- | --- | --- | --- | --- |
| 1 | `GET /cep/` | — | Abre la sesión. Devuelve las cookies. | Verificado, 200 |
| 2 | `GET /cep/instituciones.do?fecha=DD-MM-AAAA` | `fecha` | Catálogo de bancos de ese día. JSON `{"instituciones":[[código, nombre],…], "institucionesMISPEI":[…], "overrideCaptcha":true}`. `overrideCaptcha` no lo usa el JavaScript de la página; lo observé: `true` desde mi IP y `false` desde Cloudflare, justo donde después se pidió el captcha. | Verificado, 97 instituciones |
| 3 | `POST /cep/valida.do` (formulario `x-www-form-urlencoded`) | ver abajo | Busca el pago. Devuelve un fragmento HTML. | Verificado solo «no existe» |
| 4 | `GET /cep/descarga.do?formato=XML` (o `PDF`, `ZIP`) | — | Baja el CEP. **Depende de la cookie de la petición 3.** | Leído (código) |
| 5 | `GET /cep/stickyImg?b_capt=…` | — | Imagen del captcha (PNG). Existe; la pedí una vez para confirmarlo y no la usé. | Verificado |
| 6 | `GET /cep/obligaciones.do` | — | Texto de obligaciones de las instituciones. | Verificado |

Campos de `valida.do` (nombres exactos del formulario):

| Campo | Valor | Notas |
| --- | --- | --- |
| `fecha` | `DD-MM-AAAA` | Fecha de la operación. Mínimo 24/02/2012 (`minDate` de la página); no puede ser futura. |
| `tipoCriterio` | `T` clave de rastreo, `R` número de referencia | `T`: hasta 30 caracteres ASCII. `R`: hasta 7 dígitos. |
| `criterio` | la clave o la referencia | |
| `emisor` | código Banxico del banco que envió | Del catálogo (petición 2), p. ej. `40012` BBVA. |
| `receptor` | código Banxico del banco que recibió | Debe ser distinto de `emisor` (la página lo valida: solo hay CEP entre instituciones distintas). |
| `cuenta` | CLABE de 18 dígitos (o tarjeta 16, celular 10) de quien recibe | Con `monto` hace que la búsqueda sea exacta. |
| `monto` | pesos con punto y hasta 2 decimales, sin comas | **Cadena decimal, no float**: en la app se pasa de centavos enteros a texto. |
| `receptorParticipante` | `0` | `1` solo si el beneficiario es el propio banco («Pago a banco»). |
| `tipoConsulta` | `1` = descargar CEP (pide `cuenta` y `monto`); `0` = solo estado del pago | `0` no exige cuenta ni monto y devuelve el estado (p. ej. «Liquidado»). |
| `captcha` | `c` | La página trae el campo rellenado con `c` y solo pide teclear la imagen cuando el servidor lo exige. |

**Observación útil.** El código de banco de Banxico se deduce de los 3 primeros dígitos de la CLABE: Mercado Pago `722`→`90722`, BBVA `012`→`40012`, Banorte `072`→`40072`, Banamex `002`→`40002`, Santander `014`→`40014`, Scotiabank `044`→`40044`, HSBC `021`→`40021`, Inbursa `036`→`40036`, STP `646`→`90646`, Cuenca `723`→`90723`, albo `721`→`90721`. Verificado contra el catálogo de hoy en esos once casos. El `receptor` de la tienda se puede calcular de su CLABE; el cajero solo escoge el banco del **cliente**.

**Cuándo aparece el CEP y por cuánto tiempo.** Las reglas SPEI dicen que el banco receptor abona en máximo 30 segundos (`obligaciones.do`, leído). Aun así, el CEP tarda en salir: cep-python tiene un caso real en que el pago aparece «Liquidado» pero «no es posible generar el CEP» todavía (leído, código). Tlaloc dice que un «no existe» reciente suele ser que «the issuing bank has not yet reported the payment to SPEI (can take up to a few hours)» (leído, página). Un resumen de búsqueda habla de hasta 30 minutos (solo resumen). **Sin verificar con una transferencia real.** El diseño tiene que tratar «aún no» como un estado normal.

**Rango histórico.** Desde 2012 en el formulario; el validador de XML y el servicio por lotes solo cubren CEP emitidos desde el 16/03/2018 (leído, página). Para nosotros solo importan hoy y ayer.

**Horario.** La página muestra «El horario de consulta es de 09:30-23:00 hrs de Lunes a Domingo» solo para fechas anteriores al 22/06/2021 (leído, código). Para fechas recientes no hay horario declarado; **no probé de noche**.

**Límite.** Existe una respuesta «Lo sentimos, pero ha excedido el número máximo de consultas en este portal. Favor de intentar nuevamente más tarde.» (leído, código y cassette de cep-python; no la provoqué). No documenta el umbral.

---

## 3. Respuestas

Todas con datos inventados. `valida.do` siempre contesta 200, incluso en error: hay que leer el contenido.

| Caso | Cómo se reconoce | Verificado |
| --- | --- | --- |
| **No existe** o datos que no coinciden | HTML con `Información del estado del pago` y «Lo sentimos, por el momento no es posible generar el CEP. **Operación no encontrada.** El SPEI no ha recibido una orden de pago que cumpla con el criterio de búsqueda especificado.» | Sí, desde IP normal |
| **Captcha exigido** | HTML con `Error` y «La imagen de seguridad no fue ingresada correctamente. Favor de validar.» más `<input type="hidden" name="varHideCaptcha" value="false"/>` | Sí, desde Cloudflare (3 de 3) |
| **Encontrada, CEP disponible** | HTML «Descargar CEP» con enlaces `descarga.do?formato=PDF`, `…XML`, `…ZIP`. Después, `descarga.do?formato=XML` devuelve `application/xml` con `Content-Disposition: attachment; filename=CEP-AAAAMMDD-<clave>.xml` | Leído (código) |
| **Encontrada, sin CEP todavía** | Tabla «Con la información proporcionada se identificó el siguiente pago» con número de referencia, clave de rastreo, bancos, **Estado del pago en Banxico** («Liquidado»…), fecha y hora de recepción y procesamiento, cuenta y monto. Sin XML. | Leído (código) |
| **Límite de consultas** | `<h1>Lo sentimos, pero ha excedido el número máximo de consultas…</h1>` | Leído (código) |
| **Banxico caído** | HTTP 5xx en `valida.do` o `descarga.do` | Leído (código) |

Forma del XML (valores inventados; los atributos son los que lee cep-python, leído):

```xml
<SPEI_Tercero FechaOperacion="2026-10-28" Hora="10:53:36" ClaveSPEI="40012"
              sello="…base64…" numeroCertificado="0000010000010001XXXX"
              cadenaCDA="||1|28102026|28102026|105336|40012|BBVA MEXICO|<ordenante>|…|<cuenta>|…|<monto>|…|numeroCertificado||sello"
              claveRastreo="XXXXXXXXXXXXXXXX">
  <Beneficiario BancoReceptor="BANORTE" Nombre="…" TipoCuenta="40" Cuenta="0123…4567"
                RFC="…" Concepto="…" IVA="0.00" MontoPago="150.10"/>
  <Ordenante BancoEmisor="BBVA MEXICO" Nombre="…" TipoCuenta="40" Cuenta="…" RFC="…"/>
</SPEI_Tercero>
```

Dos detalles que importan: (1) la **fecha y hora del abono** no es un atributo; sale de la `cadenaCDA` (campos 4 y 5, `DDMMAAAA` y `HHMMSS`); (2) `MontoPago` es texto decimal: se convierte a centavos enteros por texto, nunca con `float`.

**Sello digital.** El XML trae `sello` y `numeroCertificado`. No encontré documentación pública del algoritmo ni de dónde bajar el certificado; la página del validador de Banxico (`/validador-cep-spei/`, leída) solo recibe archivos XML y no explica el método. **No verificado y no lo necesitamos:** si el XML lo baja nuestro propio servidor de `banxico.org.mx` por TLS, la autenticidad viene del canal. El sello solo importaría si aceptáramos un XML que sube el cliente; en ese caso se usa el validador manual de Banxico.

---

## 4. Captcha, límites y términos

**Captcha (se documenta y se detiene).** La página lleva un bloque de imagen de seguridad oculto (`#captchaImage`, clase `oculta`) y `CEP.muestraCaptcha()` lo muestra cuando la respuesta trae `varHideCaptcha=false` (leído, código). Desde mi IP la consulta no lo pidió; desde Cloudflare sí, tres veces. No intenté resolverlo, no probé otras IP ni otros encabezados para saltarlo. La sonda `tools/cep_probe.py` se detiene con salida 3 si lo ve.

**Condiciones de uso.** No encontré unas «condiciones de uso» de `www.banxico.org.mx` que mencionen consultas automáticas (las rutas de aviso legal redirigen a `anterior.banxico.org.mx` y dan 404). Lo que sí leí:

- Página del CEP, exención de responsabilidad (leída): «Los Comprobantes Electrónicos de Pago se generan con base en la información proporcionada por las entidades receptoras de los pagos […] bajo su responsabilidad exclusiva; se emiten con fines informativos». Y: «el usuario deberá proporcionar información confidencial cuyo acceso y uso fueron previamente pactados» entre el usuario y su banco. **El CEP es informativo y los datos son de cada banco, no de Banxico.**
- Servicio por lotes (leído, página): «El número máximo de transferencias a consultar por archivo es de 500»; no habla de automatización ni de API.
- `robots.txt`: `www.banxico.org.mx/robots.txt` redirige a `anterior.banxico.org.mx/robots.txt`, que bloquea `/dyn` y `/ALEPH`, no `/cep` (verificado; es del sitio anterior, así que vale poco).
- Términos de otros sitios de Banxico (Educa, CMCM): si detecta accesos irregulares, puede restringir o bloquear el origen (solo resumen).

**Conclusión honesta.** No hay permiso ni prohibición escrita para consultas automáticas a este formulario. El riesgo real no es legal sino operativo: Banxico ya limita por origen. Si Isaac quiere certeza, la forma es preguntar a Banxico (decisión 7).

**Mi tráfico.** En total, unas 30 peticiones espaciadas (varias son las de bajar la página y sus JS): 3 consultas `valida.do` con datos sintéticos desde el borde de Cloudflare, 3 desde mi equipo (una hacia el receptor 90722), todas con ≥3 s de pausa y sin reintentos. Usé un `User-Agent` honesto (`ElDolaronProbe`). cep-python, en cambio, se hace pasar por Chrome: no lo copiamos.

---

## 5. Desde Cloudflare Workers

**Prueba (verificada).** Un Worker desechable en mi carpeta temporal (fuera del repo, no desplegado) corrido con `wrangler dev --remote`, que ejecuta en el borde de Cloudflare (centro DFW). Hizo `GET /cep/`, `GET instituciones.do` y `POST valida.do` con datos sintéticos, con pausas de 3 s:

| Paso | Desde el Worker (Cloudflare) | Desde mi equipo |
| --- | --- | --- |
| `GET /cep/` | 200, cookies normales | 200 |
| `instituciones.do` | 200, JSON | 200, JSON |
| `valida.do` | 200 con **captcha exigido** (`varHideCaptcha=false`) | 200 «Operación no encontrada» |

No hubo bloqueo de WAF (ni 403 ni página de rechazo): Banxico atiende a Cloudflare, pero le exige la imagen. Eso mata el flujo automático.

**Detalle de la bandera.** Una cuarta corrida en Cloudflare, solo del catálogo (sin `valida.do`), devolvió `overrideCaptcha: false`; la misma llamada desde mi equipo, `true`. La sonda (`tools/cep_probe.py`) la lee primero y, si es `false`, no consulta.

**Lo que no sé.**

- Si el Worker **desplegado** sale por las mismas IP que la vista previa remota. Lo normal es que sean del mismo rango, pero no lo probé.
- Si el criterio es la IP, el rango de Cloudflare, el país o la frecuencia. Con tres corridas no se distingue.
- Si Smart Placement u otra región cambia algo. No lo probé ni lo voy a explorar: sería buscar un origen que el captcha no detecte.

**Cómo puede repetirlo Isaac.** (a) En su PC: `python tools/cep_probe.py --fecha … --clave … --emisor … --receptor … --cuenta … --monto … --descargar` (la sonda funciona desde una IP normal). (b) Prueba del Worker real: una ruta temporal en el sandbox (`sandbox.viste.com.mx`) que haga solo `GET /cep/` y `GET instituciones.do` y devuelva `overrideCaptcha` (no hace falta consultar ningún pago); se borra después. Eso lo despliega Isaac; yo no.

---

## 6. La cuenta de la tienda: Mercado Pago (CLABE 722…)

Dato de Isaac: las transferencias llegan a una cuenta de Mercado Pago, personal, a nombre del dueño. La CLABE completa y el nombre no van al repo; aquí solo «CLABE 722…».

| Pregunta | Respuesta | Marca |
| --- | --- | --- |
| ¿Aparece en la lista de Banxico? | Sí: **`90722` «Mercado Pago W»**, en la lista de receptores y en la de emisores, el 28/10/2026. | Verificado |
| ¿Cómo se calcula el receptor? | Los 3 primeros dígitos de la CLABE (`722`) dan el código (`90722`). Mismo patrón que Cuenca y albo. | Verificado (11 casos) |
| ¿Banxico acepta una consulta hacia ese receptor? | Sí: con `receptor=90722` y datos sintéticos contestó «Operación no encontrada», no un error de institución. | Verificado |
| ¿Salen CEP de pagos a Mercado Pago? | **Sin probar.** Los casos reales de cep-python ya incluyen instituciones no bancarias (códigos `90…`): Cuenca `90723` como receptor y STP/Compropago como emisor, y BaBien `37166`. Ninguno es Mercado Pago. Por la regla general (el CEP se genera con la confirmación de abono que manda la institución receptora) debería salir, pero **solo una transferencia real lo confirma**. | Leído (código); inferencia |
| ¿Tarda distinto? | **No sé.** No hay datos por institución. Tlaloc habla de «hasta unas horas» en general. | Sin verificar |
| ¿Qué nombre muestra el CEP como beneficiario? | El que Mercado Pago reporte a Banxico en su confirmación de abono: la exención de responsabilidad de Banxico dice que los datos vienen de la institución receptora «bajo su responsabilidad exclusiva». Lo esperable en una cuenta personal es el nombre y RFC/CURP del titular, **pero no he visto un CEP de Mercado Pago**. | Leído (página); inferencia |

**Consecuencias para el diseño.**

1. **No se valida por nombre.** El nombre del beneficiario cambia según lo que reporte cada institución; la regla es **CLABE completa + monto + fecha + clave única**.
2. **No se guarda el XML**, solo su hash: para una cuenta personal trae el nombre y el RFC del dueño, y con un proveedor ese dato pasaría por un tercero (sección 8, fila de privacidad).
3. **Cuenta personal recibiendo ventas.** Es una decisión de Isaac y su contador, no del código, pero conviene saber que el CEP deja constancia a nombre del titular. Si algún día cambia a una cuenta de empresa, solo cambia la CLABE de configuración.
4. **Prueba con la cuenta real.** Isaac corre `python tools/cep_probe.py --fecha … --clave … --emisor <banco del que mandó> --receptor 90722 --cuenta <CLABE completa> --monto … --descargar`. La salida muestra la CLABE con 4 dígitos y no imprime nombres; **le pido que me diga solo** si salió `encontrada`, el tiempo entre la transferencia y la primera vez que apareció, y si `monto_coincide` fue `true`. Con un solo pago de prueba se cierran las tres dudas de esta tabla.

---

## 7. Propuesta de integración

> Es una propuesta para la fase 2. Nada de esto está implementado ni autorizado. Con el captcha, la verificación automática necesita primero la decisión 1.

### 7.1 Dónde y qué captura el cajero

Mínimo para personal sin experiencia técnica: **tres datos que ya están en el comprobante del cliente**.

| Dato | Cómo se captura |
| --- | --- |
| Banco del cliente | Lista de bancos (el catálogo del día, con los más comunes arriba). |
| Clave de rastreo | Un campo de texto; se pone en mayúsculas y se quitan espacios. Ayuda: «Aparece en el comprobante del banco». |
| Fecha | «Hoy» por defecto, con «Ayer» a un toque. Fecha de tienda (zona `America/Mexico_City`), como el resto. |

Lo demás sale del sistema: monto = lo que se cobra (centavos enteros), CLABE y banco receptor = configuración de la tienda (Mercado Pago, receptor `90722`; falta cargar la CLABE completa, fuera del repo), `tipoCriterio=T`.

Puntos de entrada, todos con el mismo bloque:

- `/pedidos`: abono de un paquete de envío y anticipo de un apartado, hoy con el selector de forma de pago «Transferencia» (`pedidos.html`, `mover-forma` y `forma`). Si la forma es transferencia, aparece el bloque «Verificar transferencia».
- `/caja`: cobro con forma «Transferencia» (`caja.html`, botón de cobro).
- Revendedora (#575): la tienda registra el pago (`pedidos.ts`, ruta de abono con `sinAnticipo`); mismo bloque en `/pedidos`.

### 7.2 Qué se valida (en el servidor)

| Regla | Detalle |
| --- | --- |
| Cuenta beneficiaria | El XML trae `Beneficiario/@Cuenta` igual a la CLABE de la tienda (completa). |
| Monto | `MontoPago` convertido a centavos enteros por texto, **≥** el importe a registrar. Si es mayor, se registra el importe y la diferencia queda anotada. Nunca se acredita más de lo cobrado sin decisión (decisión 6). |
| Fecha | `FechaOperacion` es hoy o ayer en hora de tienda (o la ventana que se decida). |
| Banco emisor | `ClaveSPEI`/`BancoEmisor` coincide con lo que capturó el cajero. |
| Clave de rastreo única | Una clave (con su emisor y fecha) solo puede respaldar **un** pago. Lo garantiza un **índice único**, no el código de aplicación. |
| Autoridad | El servidor decide; el navegador solo manda `clave`, `emisor`, `fecha` e `id`. Nunca manda «verificado». |

### 7.3 Qué se guarda (boceto, solo idea)

Futura migración aditiva `app/migracion-NNN-pagos-spei.sql` (la última existente es 059; se numera en su momento; no se crea ahora). Boceto:

```sql
-- Idea, no es el archivo final. Dinero en centavos enteros.
create table pagos_spei (
  id text primary key,                -- UUID del navegador: un reintento no duplica
  clave_rastreo text not null,
  emisor text not null,               -- código Banxico
  fecha_operacion text not null,      -- AAAA-MM-DD, fecha de tienda
  monto integer not null,             -- centavos que se quiere respaldar
  monto_cep integer,                  -- centavos que dice Banxico (null si no se verificó)
  cuenta_ult4 text,                   -- solo los últimos 4 dígitos
  estado text not null check (estado in ('pendiente','verificado','sin_verificar','rechazado')),
  motivo text not null default '',
  verificado_por text not null default 'banxico',  -- 'banxico' | 'proveedor' | 'manual'
  sello_hash text,                    -- hash del XML, no el XML (trae nombres y RFC)
  pedido_id text, venta_id text,      -- a qué se aplicó, una sola vez
  autor text not null, creado_en text not null, verificado_en text
);
create unique index pagos_spei_clave on pagos_spei (emisor, fecha_operacion, clave_rastreo);
```

El índice único es lo que impide reutilizar una clave: un choque aborta el lote de forma fiable (a diferencia de un `update` que modifica cero filas, `app/AGENTS.md`). Se guarda el estado y los campos mínimos; **no** se guarda el XML completo (nombres, RFC y cuentas de terceros), solo su hash. Si Isaac quiere el XML, iría a R2 con acceso restringido.

### 7.4 Flujo y fallas (respeta `app/AGENTS.md`)

1. **Intención primero.** `POST /api/pagos-spei` con `id`, `clave`, `emisor`, `fecha`, `monto`. El servidor inserta la fila en `pendiente` y cierra esa escritura. Si la clave ya existe con otro `id` → 409 «Esta transferencia ya se usó».
2. **Consulta fuera de cualquier transacción.** Después, con tiempo límite (p. ej. 15 s), una llamada a Banxico (o al proveedor, decisión 1). Nada de D1 abierto mientras se espera HTTP.
3. **Resultado.** Una escritura con `where id = ? and estado = 'pendiente'`: `verificado`, `rechazado` (no existe o no coincide) o `sin_verificar` (captcha, límite, 5xx, tiempo agotado, «aún no hay CEP»).
4. **Aplicar el pago.** El abono o cobro lleva `pago_spei_id`. Dentro del mismo lote que registra el abono, una condición exige `estado = 'verificado'`, `monto_cep >= importe` y `pedido_id is null and venta_id is null`; si falla, el lote se aborta con el patrón de trigger que ya usa el stock. Mismo `id`, mismo resultado en un reintento (como `pedido_movimientos`). En `/caja`, el campo nuevo entra al `pedidoHash` **solo si viene** (como `descuento_id`) para no invalidar reintentos viejos.
5. **Modo «sin verificar».** Si Banxico o el proveedor no responden, el cajero ve «No se pudo verificar. Reintenta en unos minutos» y, si el cliente espera, puede **registrar igual** marcándolo «sin verificar» (permiso a decidir, decisión 5). Esos pagos aparecen aparte en el corte y en `/reportes` hasta que se verifiquen. Un reintento posterior (botón, o un cron si Isaac lo autoriza) los pasa a `verificado` o `rechazado`.
6. **Corte.** `corte.ts` ya suma «Transferencias». Se añade una línea «de las cuales sin verificar» para que el cierre muestre cuánto dinero depende de una captura. No cambia la aritmética.

### 7.5 Qué se prueba

Pruebas del servidor con un doble de Banxico: encontrada, no existe, captcha, límite, 5xx, tiempo agotado, clave repetida, monto menor, cuenta distinta, reintento con el mismo `id`, dos cobros simultáneos con la misma clave (solo uno gana). Prueba física: una transferencia real de poco monto en el sandbox.

---

## 8. Directo vs. proveedor

Isaac pidió comparar. No me registré, no pedí llaves ni llamé a ningún endpoint de pago: solo leí documentación pública.

| Criterio | Directo a Banxico | Tlaloc (`api.tlaloc.sh/mx`) | apiCEP (`apicep.cloud`) |
| --- | --- | --- | --- |
| **Qué es** | El formulario del CEP | API de pago por uso. `GET /v1/cep` (datos + XML), `/v1/cep_query` (solo existencia y estado), `/v1/cep/instituciones` | `POST /validate-transfer`, también hace OCR del comprobante. Solo vi una página de venta |
| **Costo a nuestro volumen** (supuesto: **300 transferencias al mes**, 1 a 3 consultas por pago por los «aún no») | $0 | $0.10 MXN por consulta (IVA incluido): **$30 a $90 al mes**. Cupón de bienvenida de $10 (leído, página). Sin mínimo de recarga. Saldo no reembolsable y caduca a los 12 meses (términos) | Planes: $100 por 200 consultas, $200 por 800, vigencia 30 días; 50 gratis al registrarse. **$200 al mes** cubriría los 300 pagos |
| **¿Resuelve el captcha / IP de Cloudflare?** | **No**: verificado, Cloudflare recibe captcha | **No lo dice.** El Worker no sale de Cloudflare, sino de sus servidores; ellos declaran servidores propios «bare-metal» en México (política de privacidad). Que por eso Banxico no les pida imagen es **mi inferencia, no probada** | **No lo dice** |
| **¿Sigo teniendo el XML oficial?** | Sí | Sí: `xml_content` en `/v1/cep`; la FAQ dice que es el XML oficial de Banxico (leído, página). `/v1/cep_query` no lo da | Dice «CEP XML/PDF download»; sin detalle |
| **Errores que distingue** | Hay que leer el HTML | 404 no existe, 409 criterios ambiguos, 502 Banxico no entrega, 504 tiempo agotado (OpenAPI, leído). **Cobra «solo por operación exitosa»**; no dice si un 404 cuenta | Sin documentación pública |
| **Disponibilidad y dependencia** | La de Banxico | «Esfuerzos comercialmente razonables; 100 % de disponibilidad no está garantizado»; responsabilidad limitada a lo pagado en 12 meses; copyright 2025; sin SLA ni página de estado vista. Un proveedor pequeño: dependencia nueva | Página de estado enlazada; empresa de una persona; sin términos leídos |
| **Privacidad** | La consulta va a Banxico, que ya es quien tiene el dato. Banxico no es nuestro encargado | Salen a un tercero: clave de rastreo, banco, fecha, monto y la CLABE de la tienda; la respuesta trae nombre y RFC de **ordenante** y beneficiario. Retiene datos de la petición **hasta 30 días**, en México; transfiere a OpenAI/Anthropic/OpenRouter solo su asistente de IA (política, leída). ARCO por correo. **Hay que reflejarlo en el aviso de privacidad** | Sin datos (la política enlazada es de otro sitio) |
| **Llave** | No aplica | Bearer `tlmx_…` como **secreto del Worker** (`wrangler secret put`), que pone Isaac; nunca en el repo, en `wrangler.toml` ni en el Issue. Rotable desde su consola | Igual |
| **Reglas de validación** | Todas | Las mismas, porque el parseo y la comparación son nuestros: CLABE, centavos, fecha, índice único de clave. **No se delega** la decisión de «pagado»; el proveedor solo aporta el XML | Igual, pero sin XML confiable no sirve |
| **Condiciones de uso** | Sin prohibición ni permiso escrito | §5.2 prohíbe carga excesiva y reventa; nuestro uso (una consulta por pago) cabe | No leí |

**Lectura.** Banxico directo es gratis y es la fuente, pero **hoy no es utilizable desde el Worker**. Tlaloc es el único proveedor con documentación pública completa (OpenAPI, precios, términos, privacidad, errores). Su costo es trivial, su punto débil es la dependencia y la privacidad. apiCEP no tiene documentación suficiente para evaluarlo. Una tercera opción, un relevo propio (un script en una PC de la tienda con IP de México, expuesto con un túnel), evita al tercero pero es infraestructura nueva y un punto de falla que alguien tiene que mantener: no la recomiendo para empezar.

---

## 9. Riesgos

| Riesgo | Efecto | Mitigación |
| --- | --- | --- |
| Captcha para el Worker (verificado) | No hay verificación automática | Decisión 1; modo «sin verificar» |
| Banxico cambia el formulario (no hay contrato; ya existe un `cep-beta` y versiones, hoy 3.8.6) | La integración directa se rompe sin aviso | Pruebas con respuestas guardadas; alerta si `desconocida`; proveedor como segunda vía |
| El CEP tarda en aparecer | Rechazo injusto a un pago real | «Aún no» ≠ rechazado; reintento; el cliente no pierde su pieza |
| Dependencia de un proveedor pequeño | Caída o cierre | Modo «sin verificar»; llave rotable; no guardar nada que solo el proveedor pueda leer |
| Privacidad de transferencias | Datos de clientes en un tercero | Solo datos necesarios; aviso de privacidad; no guardar nombres; retención corta |
| Fraude que el CEP no cubre | Una transferencia real hecha por otra persona | El CEP prueba que **hubo un pago**, no que sea de ese cliente. La clave única impide cobrar dos veces; el vínculo cliente-pago sigue siendo del cajero |
| Cajero marca «sin verificar» por costumbre | Se vuelve a aceptar capturas | Permiso restringido, reporte aparte, tope por día |
| Datos de demostración en el repo | Fuga de datos reales | Solo claves y cuentas sintéticas; la sonda enmascara y no registra |
| Revisión de cumplimiento de tarifas a proveedor | Costo no previsto | Saldo prepagado, sin suscripción |

---

## 10. Decisiones para Isaac

| # | Decisión | Mi recomendación |
| --- | --- | --- |
| 1 | **Cómo verificar**: (A) directo desde el Worker, (B) proveedor tipo Tlaloc, (C) relevo propio con IP de México, (D) solo asistida, sin servicio | **A está descartada** hoy (verificado). Empezar por **D** (sin servicio nuevo): índice único de clave de rastreo y marca «confirmada por cajero». Probar **B con Tlaloc** como siguiente paso, porque es la única vía automática documentada. No C. |
| 2 | **Probar a Tlaloc**: crearías tú la cuenta (cupón de $10 = unas 100 consultas) y probarías con una transferencia real y una sintética; yo no tengo ni usaré llave | Sí, con la prueba mínima de la sección 5 y una sola transferencia real. Si 404/502 frecuentes o responde captcha, se descarta. |
| 3 | **Prueba del Worker real en sandbox** (ruta temporal que lee `overrideCaptcha` de `instituciones.do`, sin consultar ningún pago) | Sí, 10 minutos. Si el Worker desplegado recibe `true`, vuelve la opción A y no hace falta proveedor. Si recibe `false`, queda B. |
| 4 | **Cuenta que recibe**: es Mercado Pago (CLABE 722…, receptor `90722`), personal. Falta cargar la CLABE completa en configuración (también la necesita el manual de revendedoras D3) | Configuración fuera del repo. Antes de construir nada, **una transferencia real de prueba** con la sonda para confirmar que sale CEP, cuánto tarda y qué nombre trae (sección 6). Valorar con tu contador si seguir cobrando ventas en una cuenta personal. |
| 5 | **Quién puede registrar «sin verificar»** y con qué tope | Solo `cajero` encargado (no revendedora), tope diario, y siempre visible en el corte. |
| 6 | **Montos distintos**: si el cliente mandó más, o menos, de lo cobrado | Menos: no se acepta (se pide el resto). Más: se registra lo cobrado y se anota la diferencia; no se genera saldo automático. |
| 7 | **Preguntar a Banxico** si el uso automático de bajo volumen es aceptable | Sí, un correo corto. No bloquea el desarrollo de la opción D. |
| 8 | **Aviso de privacidad** si se usa proveedor (datos de transferencias salen a un tercero) | Actualizarlo antes de activar B; `docs/BASES-Y-AVISO-DOLARONES.md` ya trata el aviso de Dolarones. |
| 9 | **Cuándo exigir verificación**: todas las transferencias, o solo desde un monto | Todas las de apartado/envío/revendedora. En caja, desde $300, para no frenar compras chicas. |

---

## 11. Fuentes

| Fuente | Qué aporta | Marca |
| --- | --- | --- |
| https://www.banxico.org.mx/cep/ y `js/cep-min.js`, `js/validations/*.js` | Formulario, campos, captcha condicional, rangos de fecha, catálogos | Verificado (descargados) |
| `https://www.banxico.org.mx/cep/instituciones.do?fecha=` | Catálogo de bancos | Verificado |
| `https://www.banxico.org.mx/cep/valida.do` | «No existe» y captcha | Verificado |
| `https://www.banxico.org.mx/cep/obligaciones.do` | Plazos SPEI de 30 s y 1 min | Leído (página) |
| https://www.banxico.org.mx/validador-cep-spei/ | Solo valida XML emitidos desde 16/03/2018 | Leído (página) |
| https://www.banxico.org.mx/cep-scl/ | Lotes: 2 a 500 transferencias, resultados 9 días | Leído (página) |
| https://github.com/cuenca-mx/cep-python (MIT, última versión 1.0.1, 22/09/2026) | Endpoints, campos, errores, XML y casos reales en `tests/cassettes` | Leído (código). No se agrega como dependencia |
| https://github.com/MetoLabs/banxico-cep (MIT) y `@digittmx/cepmx` | Otros clientes del mismo formulario | Solo resumen |
| https://www.tlaloc.sh/en/services/cep.html, https://api.tlaloc.sh/mx/openapi.json, `/en/pricing.html`, `/en/legal/terms.html`, `/en/legal/privacy.html` | Endpoints, errores, precio, términos y privacidad | Leído (página/OpenAPI) |
| https://apicep.cloud | Planes y un endpoint | Leído (página) |
| https://educa.banxico.org.mx/terminos-uso.html, http://cmcm.banxico.org.mx/disclaimer.html | Cláusula de bloqueo por accesos irregulares | Solo resumen |
| Noticias (Xataka, UnoTV, Expansión…) | «Hasta 30 minutos» para el CEP | Solo resumen |
| `app/src/pedidos.ts`, `app/src/worker.ts`, `app/src/corte.ts`, `app/public/pedidos.html`, `app/public/caja.html`, `docs/REVENDEDORAS-UX.md` | Dónde entra la transferencia hoy | Leído |

**Reproducir.** `python tools/cep_probe.py --autoprueba` (sin red) y `python tools/cep_probe.py --fecha 2026-10-28 --clave ZZSINTETICO000003 --emisor 40012 --receptor 40072 --cuenta 012345678901234567 --monto 1.00` (una consulta; debe decir `no_existe`). Para una transferencia real, Isaac agrega sus datos como argumentos y `--descargar`; la sonda imprime cuentas con los últimos 4 dígitos y no imprime nombres.
