# Revendedoras · UX de `/vender` (Issue #579)

Investigación y propuesta para las revendedoras externas de #575. No cambia código: la lista **Ahora** es el brief de la Fase 2 (un PR en `app/public/vender.html` y `vender.js`, sin API ni reglas de negocio nuevas). Auditoría hecha sobre `main` ce71fa9. Números de línea de `vender.html` salvo que diga `vender.js`.

---

## 1. Usuarias y contexto

| Dato | Valor |
| --- | --- |
| Quién | Revendedoras externas en Soledad de Graciano Sánchez, S.L.P. Sin práctica con apps, leen poco, algunas mayores. |
| Equipo | Su propio teléfono, Android barato en su mayoría (pantalla de 360 px, poca RAM, señal variable). |
| Herramienta de verdad | WhatsApp. Comparten fotos a grupos y contactos y cierran por chat. |
| Rol en la app | `revendedora`: solo ve `/vender` (sin menú, sin `/pedidos`). Aparta 48 h sin anticipo; el cliente paga **a la tienda**; solo el personal registra dinero (#575). |
| Acceso | Cloudflare Access con código de un solo uso por correo. **No se puede cambiar**; sí se puede acompañar (sección 6). |

Contexto de mercado: según INEGI, en 2024 casi todas las personas usuarias de internet en México entraron desde un smartphone (97.2 %) y 9 de cada 10 usaron mensajería tipo WhatsApp (91.2 %). Cifras tomadas de un resumen de búsqueda de la ENDUTIH 2024, **no verificadas en el boletín** (el PDF no se pudo leer): [INEGI ENDUTIH 2024](https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2025/endutih/ENDUTIH_24_RR.pdf). Lo útil: el teléfono y el chat ya son su terreno; la app debe parecerse a un chat, no a un sistema.

### Lo que hacen otros (qué se aplica y qué no)

| Producto | Qué hace | Fuente y calidad | Lo aplicable |
| --- | --- | --- | --- |
| Elenas (Colombia/México) | Todo desde el celular; la plataforma maneja logística y pagos para que la vendedora no tenga que hacerlo; vende por Facebook, WhatsApp e Instagram. | [Expansión](https://expansion.mx/tecnologia/2021/10/27/elenas-app-va-por-un-mercado-de-emprendedoras-valuado-en-30-mdd) (leído). No explica comisiones ni estado de pedidos. | Igual que aquí: la revendedora no toca dinero. Lo que falta es **decirle** qué pasó con el cobro. |
| Meesho (India) | La revendedora comparte el producto por WhatsApp, pone su margen, la plataforma surte y entrega; hay calculadora de ganancia y seguimiento de ventas en la app. | Blogs de terceros vía [búsqueda](https://www.meesho.com/business-academy/faq/how-do-i-earn-with-meesho) (la FAQ oficial devolvió 403; **sin verificar**). | Mostrar «lo que vendiste y la tienda ya cobró» en una línea, sin hablar aún de porcentaje. |
| WhatsApp Business (catálogo) | Reenviar un producto a un chat o grupo; no hay interruptor de «agotado», solo ocultar. | Guías de terceros ([leadsales](https://leadsales.io/como-hacer-un-catalogo-en-whatsapp-business/)), resumen de búsqueda, **sin verificar** en la ayuda oficial de WhatsApp. | Un toque por pieza para compartir. Aquí sí hay «Ya la vendí» con existencias reales. |
| Betterware+ (México) | Asociadas hacen pedidos y administran ventas en una app. | [Whitepaper](https://www.whitepaper.mx/p/betterware-la-tapata-que-est-poniendo) vía resumen de búsqueda; sin detalle de pantallas. | Confirma que la venta directa en México ya vive en el teléfono. |

No se encontró documentación pública de cómo Facily, Yalo o Treble marcan «vendido» ni de cómo muestran plazos. Ningún ejemplo hallado muestra cuenta regresiva de apartado: esa pieza es propia y hay que probarla con gente real.

---

## 2. Principios

Cada uno con su fuente. «Leído» = se abrió la página. Los que son criterio de este documento lo dicen.

| # | Principio | Fuente |
| --- | --- | --- |
| P1 | **La foto es la interfaz; una acción principal por tarjeta; una sola columna.** Lectores de poca práctica no escanean: leen palabra por palabra, pierden el lugar al desplazarse y se saltan lo que está fuera del flujo principal. Lista vertical y lineal; lo secundario, detrás de un toque. | [NN/g, Lower-Literacy Users](https://www.nngroup.com/articles/writing-for-lower-literacy-users/) (leído); [NN/g, Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) (leído: pocas opciones primero, máximo 2 niveles). |
| P2 | **Letra grande y contraste alto.** Evitar la letra diminuta y el texto de color claro. Piso del documento: 18 px el texto base y 16 px el secundario (decisión propia; WCAG exige 4.5:1 en texto normal, 3:1 en grande). | [NN/g, Seniors](https://www.nngroup.com/articles/usability-for-senior-citizens/) (leído); [WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) (leído). Pares ya calculados: `docs/INVENTARIO-UX.md` §2.1. |
| P3 | **Toques grandes y separados.** NN/g: al menos 1 cm × 1 cm físico, más grande en acciones principales y para personas mayores. WCAG AA mínimo 24 px; Material 48 dp. Hoy los botones miden 44 px (cumplen); el principal sube a 56 px. | [NN/g, Touch Target Size](https://www.nngroup.com/articles/touch-target-size/) (leído); [WCAG 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) (leído); [Material 3](https://m3.material.io/foundations/designing/structure) (leído, una línea). |
| P4 | **Palabras de todos los días y verbos concretos.** Escribir a nivel de 6.º grado en lo principal; frases de 8 palabras o menos; nada de «identificador», «tramo», «cola». Los errores: simples, junto a lo que falló, sin culpar, con cómo arreglarlos. | [NN/g, Lower-Literacy](https://www.nngroup.com/articles/writing-for-lower-literacy-users/) (leído); [NN/g, Seniors](https://www.nngroup.com/articles/usability-for-senior-citizens/) (leído, errores). |
| P5 | **Estado = color + ícono + palabra.** Nunca solo color. Un ícono sin texto se malinterpreta. | [WCAG 1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html) (leído); [GOV.UK Tag](https://design-system.service.gov.uk/components/tag/) (leído: «no uses solo color»; nombres con adjetivos); [NN/g, Icon Usability](https://www.nngroup.com/articles/icon-usability/) (leído: la etiqueta de texto debe estar siempre visible). |
| P6 | **El resultado de una acción importante se ve en el centro y se queda hasta que se toca.** Los avisos pasivos se pierden; los que se desvanecen fallan. Hoy el aviso vive arriba, a 14 px, y se sobreescribe. | [NN/g, Indicators, Validations, Notifications](https://www.nngroup.com/articles/indicators-validations-notifications/) (leído); [WCAG 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) (leído, para lectores de pantalla); [W3C WAI, Older Users](https://www.w3.org/WAI/older-users/) (leído: avisos y retroalimentación claros). |
| P7 | **Perdonar y no perder trabajo.** Entradas flexibles (teléfono con guiones o +52), confirmar lo destructivo, reintentos sin duplicar. | [NN/g, Seniors](https://www.nngroup.com/articles/usability-for-senior-citizens/) (leído: ser indulgente con formatos y errores). La app ya tiene UUID por intento: conservar. |
| P8 | **Ayuda en el momento, no manual.** NN/g desaconseja los tutoriales en tarjetas; prefiere pistas donde se necesitan y siempre un «Saltar». Aquí: una sola tarjeta de 3 pasos que se cierra una vez, y el acompañamiento humano va por WhatsApp/presencial (sección 6). | [NN/g, Mobile App Onboarding](https://www.nngroup.com/articles/mobile-app-onboarding/) (leído). Ojo: es investigación con usuarios medios; para esta población se **prueba** (sección 7). |
| P9 | **Plazos como cuenta regresiva en horas, no fecha y hora absolutas.** «Te quedan 30 h» no exige calcular. Criterio de este documento, apoyado en que la memoria de corto plazo y la concentración disminuyen con la edad. | [W3C WAI, Older Users](https://www.w3.org/WAI/older-users/) (leído). Sin estudio específico de cuenta regresiva: probar. |
| P10 | **Sin instalar nada raro.** Android Chrome instala una web app (o deja un acceso directo); iPhone solo por Compartir → Añadir a pantalla de inicio, con `apple-touch-icon` o el ícono es una captura. Sin manifiesto, Android deja un **acceso directo**, no una app instalada. | [web.dev, Installation](https://web.dev/learn/pwa/installation) (leído); [ayuda de Chrome](https://support.google.com/chrome/answer/9658361) (leído parcial: menú ⋮ → «Instalar y crear acceso directo»). |

Corolario técnico de lo leído en MDN: `<dialog>.showModal()` ya atrapa el foco y cierra con Esc, y `navigator.share({files})` exige un gesto del usuario y `canShare` ([dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog), [share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share), leídos). `vender.html` ya cumple ambos; no tocar esa mecánica.

---

## 3. Auditoría de `/vender` como revendedora

### 3.1 Recorrido y dónde se atora

| Paso | Qué hace ella | Dónde se atora |
| --- | --- | --- |
| 1. Entrar | Abre el enlace, pide código, abre su correo, copia el código, vuelve. | Fuera de la app (sección 6). Cada 24 h si no se cambia la sesión de Access. |
| 2. Ver piezas | Baja por la lista. | Antes de la primera foto hay un formulario de código, una nota, tres pestañas, un aviso, cuatro controles de filtro y dos botones (U1, U4). |
| 3. Compartir | Marca casillas, toca «Preparar envío», espera, toca «Compartir». | «Envío» no es compartir (U2); espera sin progreso (U17); cuatro salidas (U8); mensajes largos al terminar (U18). |
| 4. Cliente dice «la quiero» | Debe volver a la app y encontrar la pieza. | Tiene que hacer scroll por 24 piezas o pegar un código (U1, U19). Lo común es que busque por la foto. |
| 5. Marcar vendida | Toca «Vendida» y llena un formulario con un párrafo de reglas. | Verbo distinto al botón (U7); el éxito se pierde (U6). |
| 6. Qué sigue | Debería avisar al cliente que pague en la tienda. | La app no se lo dice ni le da el mensaje (U20); no hay datos de pago aún (#575 paso 4). |
| 7. Mis ventas | Revisa cuáles vencen y cuáles cobró la tienda. | Texto sin color ni cuenta regresiva (U9, U16). |
| 8. Saber que la tienda cobró | Lee «Cerrada: ya se cobró». | Existe pero sin énfasis y sin importe. No hay comisión visible (proceso). |

### 3.2 Hallazgos (U1–U13 del Issue confirmados o ampliados; U14 en adelante son nuevos)

«Rompe» = principio de la sección 2.

| # | Estado | Hallazgo | Línea | Rompe |
| --- | --- | --- | --- | --- |
| U1 | Confirmado | Lo primero es «¿Ya te dijeron "la quiero"?» con campo para pegar. El placeholder dice «escanea ED-…»: ella no tiene escáner. | L71–78 (placeholder L75) | P1, P4 |
| U2 | Ampliado | Pie «0 de 10 piezas · Preparar envío · Limpiar» siempre visible aun con 0. Además el aviso de tope dice «máximo por envío» y mezcla compartir con paquetería. | L105, L172–174, L239 | P4, P1 |
| U3 | Confirmado | Cada tarjeta: casilla «Seleccionar» + «La quiere» + «Vendida». Tres verbos; «La quiere» ni aparta. | L144, L195 | P1 |
| U4 | Confirmado | Búsqueda, categoría, «Ingresadas hoy», «Buscar», «Actualizar» antes de la primera foto. | L82–89 | P1 |
| U5 | Ampliado | Etiquetas 14 px (L19), `.aviso` 14 (L34), `.nota` 13 (L37), `.cola` 13 (L46), `.marca` 13 (L47), código 14 (L44), nombre 15 (L42). Botones secundarios blancos con borde de 1 px (L22). Dos columnas a 360 px: ~170 px por tarjeta. | L19–47, L22, L38 | P2, P3 |
| U6 | **Ampliado: peor de lo dicho** | La confirmación de «Apartada P-123…» se escribe en `#aviso` (L408) y **de inmediato** `cargarPiezas()` la sobreescribe con «N piezas disponibles en esta página.» (L409 → L212). Igual con «Interesado anotado» (L286→L287) y con «cancelada» (L466→L472→L454). Además `#aviso` está arriba de los filtros (L80): con la lista desplazada, ni se ve. La revendedora nunca ve si funcionó. | L408–409, L212, L286–287, L466–472, L454, L80 | P6 |
| U7 | Confirmado | Diálogo «Vendida»: párrafo largo de reglas y precios (L124), botón «Apartar 48 horas». Opción «Recoger en tienda (cliente o tú)». | L117–128, L123–126 | P1, P4 |
| U8 | Confirmado | Cuatro salidas: «Compartir», «Descargar y abrir WhatsApp», «Cerrar» y enlace «Abrir WhatsApp». Texto de WhatsApp en un `textarea` de 6 filas que ella no necesita editar. | L133–140 | P1 |
| U9 | Ampliado | Estados como texto gris 13 px; fecha absoluta (`hora()`), sin «te quedan N h»; sin orden por urgencia (la lista sale por folio descendente); sin importe total ni de lo cobrado. | L422, L430–435, L153 | P5, P9 |
| U10 | Confirmado | «Solo los míos» sigue visible; para revendedora el servidor siempre lo fuerza. | L99 | P1 |
| U11 | Ampliado | Frases de programador: «Se conserva el mismo identificador» (L246, L382), «Sin coincidencias en este tramo» (L213), «Anotarlo no aparta ni cobra anticipo» (L250), «Reintenta: no se duplica y se conservan los datos» (L290, L412), «escanea los números de la etiqueta» (L264). En `vender.js`: «la foto o el logo» (L55), «Descargar y abrir WhatsApp» (L114). | ver tabla 4.2 | P4 |
| U12 | Confirmado | Sin primera vez: ni «cómo funciona» ni cómo ponerla en la pantalla de inicio. Sin `manifest` ni `apple-touch-icon` en las páginas de la app (solo `sw-caja.js` en caja). | L146–150, L557 | P8, P10 |
| U13 | Confirmado | Se actualiza al volver a la pestaña o con «Actualizar»; no se dice a qué hora fue. | L539–545 | P6 |
| **U14** | Nuevo | Error que manda a donde ella no puede ir: «Esa pieza no está disponible… Revisa Interesados o Pedidos.» `/pedidos` está vedada para su rol. | L268 | P4, P7 |
| **U15** | Nuevo | La tarjeta muestra la cola de interesados con nombres y hora: «1.º Alguien (otra vendedora, 28 oct 14:00)» o «Sin interesados» en cada una de 24 tarjetas. Es ruido; lo útil es saber si **otra persona la quiere**. | L193–194 | P1, P4 |
| **U16** | Nuevo | «Mis ventas» encabeza con el folio «P-123 · Ana» (el folio es del personal), sin foto, y sin botón para avisarle al cliente aunque la API ya devuelve `telefono`. Sin foto porque `lineas` no trae `producto_id` (API: «Después»). | L430–431, L435 | P1, P5 |
| **U17** | Nuevo | «Preparando fotos…» sin progreso: son hasta 10 consultas y 10 lienzos en serie en un Android barato. Parece trabado. | L488, L491–507 | P6 |
| **U18** | Nuevo | Tras compartir, el aviso es una instrucción larga: «Adjunta las imágenes descargadas en WhatsApp. Si no se abrió, usa el enlace de abajo. Texto copiado: pégalo si falta.» | L530–531 | P4 |
| **U19** | Nuevo | No hay forma de ir de «el cliente dijo la quiero» a la pieza sin buscar o pegar: la tarjeta compartida ya lleva el código en 44 px (`vender.js` L91) pero la app no ofrece «las que compartí». Hoy solo hay una marca «Compartida ✓» de 13 px. | L190; `vender.js` L91 | P1, P7 |
| **U20** | Nuevo | Después de apartar no hay «siguiente paso»: no hay mensaje listo para el cliente («tienes hasta el jueves para pagar…») ni datos de pago (#575 paso 4 sin definir). | L408 | P6, P8 |
| **U21** | Nuevo | «Descartar» un interesado actúa al primer toque, sin confirmar y sin deshacer. | L328–336 | P7 |
| **U22** | Nuevo | En «Interesados» cada fila encabeza con `cliente · disponibilidad` (p. ej. «Ana · Disponible») y repite **su propio nombre** como vendedora. | L311, L313 | P4 |
| **U23** | Nuevo | La tarjeta que comparte lleva la dirección y el horario de la tienda; el cliente puede ir directo y saltarse a quien se la ofreció. Es decisión de negocio, no de pantalla. | `vender.js` L26–28 | proceso |

### 3.3 Lo que está bien y se conserva

Botones de 44 px o más; campos de 16 px (no hacen zoom en iPhone); `label` enlazados; `<dialog>` nativo (foco y Esc); `aria-live` en avisos; UUID por intento y reintento sin duplicar; «Compartir» pasa por `navigator.share` con respaldo de descarga; tarjeta de WhatsApp con precio grande y código en 44 px (`vender.js` L61–101); tope de 10 piezas; texto del cliente tolera «ED-2335» sin ceros (`vender.js` L16–20); confirmación de cancelar con «Sí, cancelar / No, regresar» (L129–132). **Para cajeras, `/vender` cambia lo menos posible**: todo lo de abajo cuelga de `revendedora === true` (L549–553).

---

## 4. Propuesta priorizada

### 4.1 AHORA (Fase 2: solo `vender.html` y `vender.js`, sin API ni reglas de negocio)

Convención: todo cambio visual cuelga de `document.body.classList.add('rev')` en L550–553; las cajeras no ven nada de esto. Tokens (ya calculados en `INVENTARIO-UX.md` §2.1): `--azul #16366B`, `--rojo-texto #B3141B`, `--verde #1F7A4D`, `--fondo-ok #E4F3EA`, `--fondo-error #FDECEC`, `--fondo-aviso #FFF6D9`, `--aviso-texto #6B5400`, `--deshab-fondo #E9EDF4`, `--gris #5B6478`.

**A1. Confirmación que no se pierde (U6, U20). Prioridad 1.**
- Un `<dialog id="dlg-listo">` grande, que se abre al terminar «Guardar venta» y se queda hasta que ella lo cierra.
  - Ícono ✓ en círculo verde de 56 px (`--verde` fondo, blanco el ícono).
  - Título 24 px/800: «¡Venta guardada!»
  - Línea 18 px: «{código} · {nombre} para {cliente}.»
  - Línea 18 px/700: «Tienes hasta el {jueves 30 oct, 2:00 p. m.} para que pague.» (de `pedido.vence_en`; fecha con día de la semana).
  - Línea 16 px `--gris`: «El pago se hace en la tienda. Si no paga a tiempo, la pieza vuelve a la venta.»
  - Botón principal 56 px, ancho completo, `<a>` a `wa.me/52{teléfono}?text=`: **«Avisarle a {cliente} por WhatsApp»**. Texto prellenado (función nueva en `vender.js`):
    «Hola {cliente}, ya te aparté {nombre} ({código}) por {precio}. La tengo apartada hasta el {jueves 30 oct, 2:00 p. m.}. Para pagar, escríbeme y te paso los datos de la tienda.»
  - Botón secundario 56 px: **«Seguir con otras piezas»** (cierra y recarga).
- Los avisos de **resultado** («Interesado anotado», «Venta cancelada», errores) dejan de escribirse en `#aviso`: van a una franja fija `#resultado` justo debajo del encabezado (`position: sticky; top: 0`), 18 px, fondo `--fondo-ok` o `--fondo-error`, con ✓ o ⚠, **que se cierra con un botón «Entendido» y no se sobreescribe** por recargas.
- Las frases informativas de carga («N piezas disponibles en esta página.» L212, «Cola actualizada por orden de llegada.» L354, «Tus ventas, actualizadas.» L454) se eliminan o van a una región `aria-live` visualmente oculta. Se conservan solo los mensajes de lista vacía (ver A9).

**A2. Tarjeta de pieza con dos botones (U3, U5, U15, U19).**
- Para `rev` y ancho < 600 px: **una columna**; tarjeta horizontal: foto cuadrada a la izquierda (38 %), texto y botones a la derecha. Más de 600 px, igual que hoy.
- Orden y tamaños: nombre 18 px/700 (máx. 3 líneas); precio 28 px/800 `--azul`; código 16 px monoespaciado; talla 16 px.
- Botón 1 (principal, `--azul` relleno, blanco, 56 px, 18 px/700, borde 2 px): **«Compartir»** — fotografía y arma el mensaje de **esa** pieza (selección de 1 → mismo flujo de `preparar`).
- Botón 2 (secundario, blanco, borde 2 px `--azul`, 56 px): **«Ya la vendí»** (abre el diálogo de A5).
- Enlace de texto terciario, 16 px subrayado, 44 px de alto: **«Anotar a un cliente»** (era «La quiere»; la lógica no cambia).
- La casilla «Seleccionar» pasa a un interruptor 28 px con etiqueta **«Elegir varias»** debajo; sin elegir, no estorba.
- Etiqueta de estado de la tarjeta (chip, 16 px/700, borde 2 px, ícono + palabra):
  - Compartida: **«✓ Ya la compartiste»** (`--fondo-ok`, borde `--verde`).
  - Otra persona la quiere (si `p.cola.length > 0`): **«⚠ Otra persona también la quiere»** (`--fondo-aviso`, texto `--aviso-texto`). Sin interesados: no se muestra nada (adiós «Sin interesados»).
- Error de foto (L185): **«No cargó la foto. Toca “Actualizar”.»**

**A3. Pie de compartir (U2).**
- Se oculta con 0 elegidas. Con ≥ 1: botón principal 56 px **«Compartir {n} en WhatsApp»** (1 → «Compartir 1 en WhatsApp») y botón de texto 44 px **«Quitar elegidas»**. Texto de tope: **«Máximo 10 piezas a la vez.»** (reemplaza «El máximo por envío es 10 piezas.», L239).
- Eliminar «0 de 10 piezas».

**A4. Diálogo de compartir (U8, U17, U18).**
- Título **«Compartir en WhatsApp»**.
- Mientras prepara: **«Preparando foto {n} de {total}…»** (el ciclo ya tiene `envio.entries()`, L491).
- Listas: vista previa de las fotos como hoy; **un solo botón principal 56 px, ancho completo: «Enviar por WhatsApp»** (= `compartir()`).
- Texto de WhatsApp (`textarea`, L135) y botones «Descargar y abrir WhatsApp» y «Abrir WhatsApp» (L138–139) se meten en un `<details>` con resumen **«¿No se abrió WhatsApp?»**. Dentro: el `textarea`, **«Guardar las fotos y abrir WhatsApp»** y el enlace.
- «Cerrar» → botón de texto 44 px **«Volver»**.
- Mensajes finales (reemplazan L530–531): éxito con hoja nativa: **«✓ Listo. Compartiste {n} pieza(s).»**; con descarga: **«Se guardaron las fotos. Abre WhatsApp, toca el clip y elígelas.»**; si no copió texto: **«Copia el texto de abajo y pégalo con las fotos.»**
- Error de `vender.js` L114: **«No se pudo abrir WhatsApp. Abre “¿No se abrió WhatsApp?” abajo.»**

**A5. Diálogo «Ya la vendí» (U7).**
- Título **«Ya la vendí»**; pieza en 18 px: «{código} · {nombre} · {precio}».
- Etiquetas 16 px/700: **«¿Quién la compró?»** (nombre) · **«WhatsApp de quien la compró»** con ayuda 16 px `--gris`: «10 números. Ejemplo: 444 123 4567».
- **«¿Cómo la recibe?»**: opciones **«La recoge en la tienda»** / **«Se la mandan a su casa (envío)»**. Al elegir envío aparece una línea: **«Envío $99. Gratis si compra $1,000 o más en piezas.»** (reglas de L124, sin cambiarlas).
- Las reglas (L124) pasan a tres líneas cortas con ✓, 16 px:
  - «✓ La pieza queda apartada 48 horas.»
  - «✓ Quien la compró paga en la tienda.»
  - «✓ Si no paga a tiempo, la pieza vuelve a la venta.»
- Botón principal 56 px **«Guardar venta»**; secundario **«Volver»**.
- Reintento (L382): **«Tu venta anterior aún no se confirma. Toca “Guardar venta” otra vez: no se repite.»**

**A6. Mis ventas (U9, U16).**
- Orden: primero las **apartadas** por `vence_en` ascendente (la más urgente arriba), luego las cerradas por folio descendente. Encabezados de grupo 20 px/800: **«Esperando pago»**, **«Ya pagadas»**, **«Anteriores»**.
- Resumen arriba (18 px): **«Ventas que la tienda ya cobró: ${suma de subtotal de `vendido`}»** y debajo **«{n} esperando pago»**. (Es lo vendido, **no** comisión: no se habla de porcentaje hasta que Isaac lo defina.)
- Tarjeta: línea 1 (18 px/700): **cliente**; línea 2: «{nombre} · {precio}»; chip de estado (abajo); línea 4 (16 px `--gris`): «Recoge en la tienda» o «Envío a su casa»; línea 5 (14 px mínimo): «Folio P-123» (el folio queda como dato menor, no como título).
- Chips (16 px/700, borde 2 px, ícono + palabra; la hora se calcula en el teléfono, sin llamadas nuevas):
  - Apartada sin pago, más de 6 h: **«⏳ Esperando pago · te quedan 30 h»** (`--fondo-aviso`/`--aviso-texto`).
  - Apartada sin pago, 6 h o menos: **«⚠ Se vence pronto · te quedan 5 h»**; menos de 1 h: **«⚠ Se vence pronto · te queda menos de 1 h»** (`--fondo-error`/`--rojo-texto`).
  - Ya pasó `vence_en`: **«⚠ Ya venció. En unos minutos la pieza vuelve a la venta.»**
  - Apartada con pago (`saldo > 0`): **«✓ La tienda ya registró su pago»** + «Recoger antes del {fecha}» (`--fondo-ok`).
  - `vendido`: **«✓ Cobrada: la tienda ya cobró»** (`--fondo-ok`).
  - `vencido`: **«✕ Se venció · la pieza volvió a la venta»**; `cancelado`: **«✕ Cancelada»** (`--deshab-fondo`/`--gris`).
- Botones por tarjeta apartada: **«Avisarle a {cliente}»** (WhatsApp con el mismo texto de A1, 56 px, principal) y **«Cancelar venta»** (rojo, borde 2 px, 44 px). Diálogo de cancelar (L129–132): título **«¿Cancelar la venta a {cliente}?»**, cuerpo **«La pieza vuelve a estar en venta.»**, botones **«Sí, cancelar»** / **«No, dejarla»**.
- Vacío (L426): **«Aquí verás tus ventas. Cuando marques una pieza como vendida, aparece aquí.»**
- Botón «Actualizar» (L94) a 56 px con la hora: ver A10.

**A7. Orden de pantalla (U1, U4, U10).**
- Para `rev`: lo primero son las pestañas y la lista. El panel «¿Ya te dijeron…?» (L71–78) pasa a `<details>` cerrado, resumen **«Me escribieron con un código»**; adentro: etiqueta **«Pega aquí el mensaje de tu cliente»**, placeholder **«Ejemplo: la quiero ED-002335»**, botón **«Buscar la pieza»**. Sin «escanea».
- Los filtros (L82–89) pasan a `<details>` cerrado, resumen **«Buscar una pieza»**; dentro: «Nombre o código», «Categoría», «Solo las de hoy», botón **«Buscar»**. «Actualizar» sale del bloque (va en A10).
- Pestañas con ícono y palabra, 56 px: **«Piezas»**, **«Mis ventas»** y **«Preguntaron»** (era «Interesados»). «Mis ventas» sube de lugar: segunda.
- «Interesados»: oculta «Solo los míos» (L99) y quita su propio nombre de cada fila (L313). El encabezado de cada fila pasa a ser el nombre (L311, sin «· Disponible»); la disponibilidad va en un chip («✓ Disponible» / «✕ Ya la apartaron» / «✕ Ya se vendió»). Nota L100 a **«Los que preguntaron en los últimos 7 días.»**. Vacío L307: **«Nadie ha preguntado todavía.»**
- «Descartar» (U21): confirmación de dos toques en la misma fila: el botón cambia a **«¿Quitar? Toca otra vez»** durante 4 s.

**A8. Mensajes de error y de estado (U11, U14).** Tabla 4.2.

**A9. Primera vez (U12).**
- Tarjeta única (no baraja), al abrir por primera vez, 18 px, con «✕ Cerrar» visible; se guarda en `localStorage` (`vender-bienvenida:{correo}`, dentro de `try/catch` como `recordarCompartidas`) y se puede volver a abrir con un botón **«¿Cómo funciona?»** al pie de la lista.
  - Título: **«Así vendes en 3 pasos»**
  - «**1. Comparte.** Toca “Compartir” en una pieza y envíala por WhatsApp.»
  - «**2. Si te dicen “la quiero”,** toca “Ya la vendí” y escribe quién la compró.»
  - «**3. La tienda cobra.** Tú no cobras. Mira “Mis ventas” para saber cuándo pagan.»
- Si el teléfono es Android o iPhone (por `navigator.userAgent`) y la página **no** corre ya como app (`matchMedia('(display-mode: standalone)')`), segunda tarjeta, cerrable: **«Ponla en tu pantalla de inicio»**.
  - Android (Chrome): **«Toca los tres puntos ⋮ de arriba. Elige “Instalar app” o “Añadir a la pantalla de inicio”.»** (el menú varía por versión: confirmar con un teléfono real).
  - iPhone (Safari): **«Toca el botón de compartir (cuadro con flecha). Elige “Añadir a pantalla de inicio”.»**
  - Sin manifiesto Android deja un acceso directo, suficiente para abrir en un toque (P10).

**A10. «Actualizado» (U13).** Línea 16 px `--gris` encima de la lista: **«Actualizado a las 2:35 p. m.»** y el botón **«Actualizar»** (56 px) junto a ella. La hora se pone cada vez que `cargarPiezas`, `cargarMias` o `cargarInteresados` terminan bien.

**A11. Tamaños y botones solo para `rev`.** Texto base 18 px (L12), `label` 16 px/700 (L19), `.nota` 16 px, `.aviso` 18 px, h1 22 px; botones 56 px mínimo, 18 px/700, borde 2 px `--azul`, radio 10 px, separación 12 px entre botones; casillas 28 px; foco visible de 3 px (ya existe, L25). Contraste: usar solo los pares de `INVENTARIO-UX.md` §2.1. Respetar el zoom del sistema: nada de `maximum-scale`.

#### 4.2 Textos de error y de estado (reemplazo exacto)

| Línea | Hoy | Propuesta |
| --- | --- | --- |
| L157 | No se pudo consultar. Intenta actualizar. | No cargó. Revisa tu señal y toca «Actualizar». |
| L214, L355, L455, L469 | Sin conexión. Intenta actualizar / Reintenta … | Parece que no hay internet. Revisa tu señal y vuelve a intentar. |
| L213 | Sin coincidencias en este tramo. Toca «Ver más piezas» para continuar. | No encontré piezas aquí. Toca «Ver más piezas». |
| L213 | No hay más piezas con estos filtros. | No hay más piezas por ahora. |
| L239 | El máximo por envío es 10 piezas. | Máximo 10 piezas a la vez. |
| L246, L382 | Primero reintenta … Se conserva el mismo identificador. | Tu anotación anterior aún no se confirma. Toca «Guardar» otra vez: no se repite. (en «Ya la vendí», ver A5) |
| L250 | Anotarlo no aparta ni cobra anticipo. | Solo lo anotas. La pieza sigue en venta. |
| L264 | Pega una respuesta con ED-… o escanea los números de la etiqueta. | Pega el mensaje de tu cliente. Debe traer el código, por ejemplo ED-002335. |
| L268 | Esa pieza no está disponible para ofrecer. Revisa Interesados o Pedidos. | Esa pieza ya no está disponible. Puede que otra persona la apartó. |
| L278 | Escribe 10 dígitos o deja el teléfono vacío. | Escribe los 10 números del WhatsApp. Ejemplo: 444 123 4567. |
| L286 | Interesado anotado. La pieza sigue sin apartar. | ✓ Anotado. La pieza sigue en venta. |
| L290, L412 | No se pudo confirmar. Reintenta: no se duplica y se conservan los datos. | No sabemos si se guardó. Toca «Guardar» otra vez: no se repite. |
| L398 | Escribe el WhatsApp del cliente con 10 dígitos. | Escribe los 10 números del WhatsApp de quien la compró. |
| L496 | …ya no está disponible. Cierra y limpia la selección. | La pieza {código} ya no está disponible. Quítala y vuelve a intentar. |
| L557 | No se pudo iniciar. Vuelve a entrar. | No se pudo abrir. Cierra la página y vuelve a entrar. |
| `vender.js` L55 | No se pudo cargar la foto o el logo. Actualiza e intenta otra vez. | No cargó una foto. Toca «Actualizar» y vuelve a intentar. |
| `vender.js` L114 | …usa «Descargar y abrir WhatsApp». | No se pudo abrir WhatsApp. Abre «¿No se abrió WhatsApp?» abajo. |

Los mensajes que vienen del servidor (`datos.error`, p. ej. «Pieza o cantidad inválida.») no se reescriben en la pantalla: ver «Después».

### 4.3 DESPUÉS (requiere API, decisión de Isaac o más trabajo)

| # | Qué | Por qué no es «Ahora» |
| --- | --- | --- |
| D1 | **«Las que compartí»**: una pestaña o franja con las piezas compartidas (foto, código, botón «Ya la vendí»), para resolver U19 sin buscar. Versión local posible: guardar en `localStorage` `{id, código, nombre, precio, foto}` al compartir; la API valida al apartar. | Datos desfasados (precio, disponibilidad) y límites de almacenamiento; mejor pedir piezas por `ids` a la API. Decidir con la prueba (sección 7). |
| D2 | Foto de la pieza en «Mis ventas». | `lineas` no trae `producto_id` (`pedidos.ts` L318); API. |
| D3 | **Datos de pago** (CLABE/cuenta, titular, concepto «P-{folio}») dentro del diálogo «Listo» y del mensaje al cliente. | Decisión de Isaac (#575 paso 4); no se inventan. |
| D4 | ~~**Comisión visible**~~ **Hecho (#599)**: «Tu ganancia esta semana» y «Tu ganancia: $X» por venta en «Mis ventas». | Regla de Isaac (29/10): 10 % del precio de la pieza, sin envío, pago cada lunes. `/reportes` sigue mostrando el importe del ticket completo (incluye envío): 10 % de ese importe no es la ganancia. |
| D5 | Aviso a la revendedora cuando la tienda registra pago o cuando faltan 6 h (WhatsApp o notificación). | Fuera de alcance de #579 (avisos automáticos). Hoy depende de abrir «Mis ventas». |
| D6 | `manifest.webmanifest` + `apple-touch-icon` para que Android instale la web app (WebAPK) en vez de dejar un acceso directo. | Archivo estático nuevo + ruta permitida para el rol `revendedora` en el Worker (`worker.ts`); además, Cloudflare Access puede bloquear el manifiesto si el navegador lo pide sin credenciales: probar con `crossorigin="use-credentials"`. |
| D7 | **Duración de la sesión de Access** para este grupo: por defecto 24 h (máximo 1 mes). A diario el código por correo es la peor parte de la experiencia. | Es Access: lo cambia Isaac; el agente no lo toca. [Cloudflare, session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) (leído). |
| D8 | Revisar los textos de error del servidor (`pedidos.ts`, `vender.ts`) para el rol revendedora. | Cambia respuestas de la API. |
| D9 | Número de WhatsApp de ayuda y botón fijo **«¿Necesitas ayuda?»** que abre un chat con un mensaje listo. | Necesita el número de soporte que Isaac decida; es un dato, no se inventa. |
| D10 | Decidir si «Anotar a un cliente» y «Preguntaron» siguen para revendedoras. Con «Ya la vendí» (aparta 48 h) pueden sobrar. | Decisión de producto; mirar la prueba. |
| D11 | Quitar o mantener la dirección de la tienda en el mensaje que ella comparte (`vender.js` L26–28). | Decisión comercial (U23). |
| D12 | Prueba de «una mano»: barra inferior fija con las 3 pestañas (pulgar). | Cambia navegación; esperar a ver la prueba. |

### 4.4 PROCESO (no es pantalla)

**P-1. Alta (la hace Isaac, en este orden).**
1. Pedirle **el correo que usa en su celular** (el código llega ahí). Confirmar que sabe abrir su correo y volver al navegador.
2. Agregar su correo en la política de Cloudflare Access (A7 de #575).
3. Aprobarla en `/cuentas` con **solo** `revendedora` (desmarcar `cajero`; A6 de #575).
4. Decidir y tener escritas **dos cosas** antes del primer día: su comisión (porcentaje o monto) y los datos de pago que dará a sus clientes (D3, D4).
5. Decidir D7 (duración de sesión). Sin esto, ella repite el código cada día.

**P-2. Guion del primer día (15 minutos, en persona o por videollamada, con su teléfono).**
1. **(2 min) Para qué sirve.** «Con esta pantalla mandas fotos de piezas por WhatsApp. Si alguien dice “la quiero”, tú la apartas y la tienda cobra. Tú no tocas dinero.»
2. **(3 min) Entrar.** Ella escribe la dirección, pide el código, lo copia de su correo y entra. Se hace **una vez con ella**; no se explica de memoria. Verificar la carpeta de spam y anotar de qué remitente llega (confirmar en el primer alta).
3. **(2 min) Atajo.** Ponerlo en la pantalla de inicio (Android: ⋮ → «Instalar app» o «Añadir a la pantalla de inicio»; iPhone: Compartir → «Añadir a pantalla de inicio»). Comprobar que abre desde el ícono.
4. **(4 min) Compartir.** Ella comparte **una** pieza a un chat de prueba (el de Isaac), luego tres.
5. **(3 min) Vender.** Isaac, haciendo de cliente, responde «la quiero ED-…». Ella toca «Ya la vendí», llena el formulario y toca «Avisarle por WhatsApp». Mostrar «Mis ventas» y el «te quedan 48 h».
6. **(1 min) Cerrar.** «Si no sabes qué hacer, escríbeme aquí» y se le da el número de ayuda (D9). No se le entrega un manual.

**P-3. Mensaje de bienvenida por WhatsApp (enviar después de la sesión; texto exacto, sin emojis de más).**

> Hola {nombre}, bienvenida a El Dolarón. 🛍️
> Tu acceso: {dirección de /vender}. La primera vez te llega un código a tu correo.
> Así vendes:
> 1. Toca «Compartir» en una pieza y mándala por WhatsApp.
> 2. Si te dicen «la quiero», toca «Ya la vendí» y escribe quién la compró.
> 3. La tienda cobra. Tú no cobras. Mira «Mis ventas» para saber cuándo pagan.
> Tienes 48 horas desde que la apartas.
> Tu ganancia: {comisión}.
> Si algo no sale, escríbeme aquí. 💙

**P-3b. Kit de bienvenida sin sesión en persona (#594).** Mensaje y tarjeta listos en `docs/manual-revendedora/`: `bienvenida.txt` (texto para pegar) y `entrar.png` (tarjeta «Cómo entrar», fuente `entrar.html`). Después de entrar, ella practica cada tarea en el manual interactivo: [¿Cómo funciona? Ver el manual](https://eldolaron.com/revendedoras): copia pública, sin Access, del manual (`site/public/revendedoras.html` y `vender.js`, #624) para que la revendedora lo abra antes de saber entrar; su tarjeta 1 trae el botón «Abrir la tienda» hacia `viste.com.mx/vender`. Una prueba de `manual.test.ts` exige que sean idénticas a `app/public/manual.html` y `vender.js`: al cambiar el manual, vuelve a copiarlos. Dentro de la app sigue en `/manual`, detrás de Access. Los datos de pago no van en el repositorio, que es público: se mandan por WhatsApp.

**P-4. Seguimiento.** Primera semana: mensaje al día siguiente («¿pudiste entrar?»); revisar en `/reportes` que haya ventas; si lleva 3 días sin abrir, llamarla. No mandar videos largos: una captura de pantalla por duda.

**P-5. Qué sabe ella de su dinero.** Ve «Cobrada: la tienda ya cobró», «Tu ganancia: $X» en cada venta cobrada y «Tu ganancia esta semana» (10 % del precio, sin envío; D4, #599). Se la pagas cada lunes por transferencia con esa misma cuenta.

---

## 4.5 Implementado en la Fase 2 (PR de #579)

Solo `app/public/vender.html`, `vender.js` y sus pruebas; sin API ni reglas de #575. Lo que se aplicó a **todas** las cuentas (cajeras incluidas): A3 (pie «Compartir {n} en WhatsApp», oculto con 0), A4 (diálogo de compartir), A8 (tabla 4.2 completa), A10 («Actualizado a las…» y un solo «Actualizar»), la franja `#resultado` de A1 y el cambio de «Preparar envío». Lo que cuelga de `body.rev` (cuenta `revendedora`): A11 tamaños, A2 tarjeta horizontal y chips, A7 pestañas con ícono, «Preguntaron», paneles plegables y sin «Solo los míos», Descartar con dos toques, y A9 primera vez. A1 (diálogo «¡Venta guardada!»), A5 y A6 ya eran solo de revendedora.

Decisiones al implementar:
- «Me escribieron con un código» (revendedora) **busca la pieza** y la deja en la lista con sus botones («Ya la vendí»), en vez de abrir el formulario de interesados; la caja conserva «La quiere».
- Los avisos de conteo («N piezas disponibles…», «Cola actualizada…», «Tus ventas, actualizadas.») van a una región `aria-live` oculta; las recargas nunca escriben en `#resultado` (regresión U6 cubierta en `vender.test.ts`).
- En «Mis ventas» el folio sigue como dato menor junto con los códigos de las piezas (`Folio P-123 · ED-…`); «Avisarle» no aparece si el plazo ya venció por reloj.
- La casilla de selección sigue siendo `<input type="checkbox">` nativo (28 px con `rev`), con la etiqueta «Elegir».
- Pendiente de la Fase 2 sin hacer: ninguno de la lista «Ahora». Siguen en «Después» D1–D12.

---

## 4.6 Mandar el comprobante del pago (Issue #609)

La revendedora avisa que su cliente ya pagó un apartado por transferencia. **No da el pedido por pagado**: lo registra la tienda.

- **Dónde:** «Mis ventas», en el apartado sin pago: botón **«Ya me pagó: mandar comprobante»**. Abre un diálogo con **«Foto del comprobante»** (cámara o galería; la lee el mismo servicio de #603 y prellena la clave) y **«Clave de rastreo»**. Con foto, clave o las dos; al menos una. La ayuda dice que la clave viene en el comprobante y que **no** es el «número de referencia» (ese lo escoge quien paga y se repite).
- **Estados (chip):** «Pago enviado · la tienda lo revisa» · «⚠ La tienda no encontró el pago: {motivo}» (con el botón «Mandar otra vez el comprobante») · si la tienda ya registró el abono, el chip de siempre «✓ La tienda ya registró su pago».
- **Tienda (`/pedidos`):** el apartado muestra el aviso amarillo con la revendedora, clave, monto, banco y, solo al dueño, el enlace «Ver foto». **«Registrar pago»** abre el abono de siempre ya lleno (transferencia, clave, monto, banco, foto); al guardar, el reporte pasa a *aceptado* en el mismo batch y la transferencia entra a la verificación CEP de #603. **«Rechazar»** pide un motivo corto que ella ve en su chip.
- **Plazo:** con un reporte pendiente el cron no vence el apartado y ella no puede cancelarlo. Si la tienda rechaza y el plazo ya había pasado, el apartado conserva 2 horas para que mande el bueno; si no había pasado, rige el plazo original.
- **Privacidad:** la foto trae nombres y RFC de terceros. Se guarda en R2 sin ruta pública y solo la ve el dueño (`/api/pagos-reportados/:id/comprobante`); la revendedora no la vuelve a ver. El aviso al dueño dice «{nombre} mandó el pago de P-{folio}» sin clave ni datos del cliente.
- **Límites:** una clave ya registrada, o esperando en el reporte de otra venta, se rechaza («Esa clave ya se usó en otro pago»). Hasta 6 fotos leídas por venta (cada una cuesta una lectura); después solo la clave. Migración 063 (`pagos_reportados`, `comprobantes_subidos`).
- **Pendiente:** si manda solo la foto y no se pudo leer, únicamente el dueño ve la foto para registrar la clave. Prueba física con el celular y un comprobante real.

---

## 5. Orden de implementación sugerido (Fase 2)

A1 (confirmación) → A5 (diálogo «Ya la vendí») → A2/A3/A4 (tarjeta, pie, compartir) → A6 (Mis ventas) → A8/A11 (textos y tamaños) → A7, A9, A10. Cada bloque cuelga de `body.rev`; cajeras sin cambios. Validación: `npm test`, `npm run typecheck`, `python tools/validate_assets.py`. La cuenta regresiva y la franja `#resultado` necesitan prueba de regresión del fallo U6 (que la recarga no borre el resultado). Prueba física: sección 7.

## 6. Acceso con Cloudflare Access (no se cambia; se acompaña)

- Código de un solo uso por correo: ella necesita saber abrir su correo y volver al navegador. Se resuelve **acompañándola la primera vez** (P-2 paso 2).
- La sesión dura por defecto 24 h (Cloudflare, [session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/), leído); se puede subir hasta 1 mes. Es decisión de Isaac (D7).
- Si el código no llega: revisar spam y la dirección escrita; si no, que Isaac revise que el correo esté en la política (A7 de #575).
- Nada de guardar contraseñas o códigos en la app ni en este repo.

## 7. Prueba de usabilidad (5 pasos, con una persona real)

**Quién:** una revendedora real o alguien que haga de ella (50 años o más, usa WhatsApp, no usa apps). **Dónde:** su propio teléfono, en `sandbox.viste.com.mx` con 3 ventas de ejemplo preparadas (una por vencer, una pagada, una cobrada). Sin PIN ni tokens de producción. Pedir permiso para anotar; no grabar su pantalla sin consentimiento. Pedirle que piense en voz alta; no ayudar hasta que lo pida dos veces.

| Paso | Tarea (se lo dices tú, con estas palabras) | Éxito sin ayuda |
| --- | --- | --- |
| 1 | «Abre la tienda en tu teléfono, como lo harías mañana.» (desde el ícono si ya está puesto; si no, ponerlo.) | Entra y explica con sus palabras para qué sirve la pantalla. |
| 2 | «Manda estas tres piezas por WhatsApp a este grupo.» | Tres piezas llegan al grupo con foto y precio; ≤ 2 min. |
| 3 | «Una clienta te contestó “la quiero ED-…”. Aparta esa pieza.» | Encuentra la pieza, llena nombre, WhatsApp y entrega, y toca «Guardar venta». |
| 4 | «¿Hasta cuándo tiene para pagar? ¿Qué le dices?» | Lee el plazo en la pantalla «Venta guardada» y usa «Avisarle por WhatsApp». |
| 5 | En «Mis ventas»: «¿Cuál se vence primero? ¿Cuál ya cobró la tienda?» | Señala las dos correctas en < 20 s, sin leer párrafos. |

**Qué anotar:** tiempo por paso, cuántas veces duda, qué toca por error, qué palabras repite o malinterpreta («Preguntaron», «Anotar a un cliente»), si dice «no sé si funcionó» tras guardar. **Criterio:** 4 de 5 pasos sin ayuda y ninguna duda de «¿se guardó?» después del paso 3. Con 3 personas se ven los problemas más repetidos; si fallan los pasos 3 o 4, no se publica y se vuelve a A1/A5. Isaac decide con esta prueba (criterios del Issue #579). Preguntas para decidir D1, D10 y D12: ¿buscó por foto o pegó el código?, ¿usó «Preguntaron»?, ¿sostuvo el teléfono con una mano?

---

## 8. Fuentes consultadas

Leídas (se abrió la página): NN/g [Seniors](https://www.nngroup.com/articles/usability-for-senior-citizens/), [Lower-Literacy](https://www.nngroup.com/articles/writing-for-lower-literacy-users/), [Touch Target Size](https://www.nngroup.com/articles/touch-target-size/), [Indicators, Validations, Notifications](https://www.nngroup.com/articles/indicators-validations-notifications/), [Mobile App Onboarding](https://www.nngroup.com/articles/mobile-app-onboarding/), [Icon Usability](https://www.nngroup.com/articles/icon-usability/), [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [Mobile UX](https://www.nngroup.com/articles/mobile-ux/); W3C [Older Users](https://www.w3.org/WAI/older-users/), WCAG 2.2 [1.4.1](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html), [1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html), [4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html); [GOV.UK Tag](https://design-system.service.gov.uk/components/tag/); [Material 3](https://m3.material.io/foundations/designing/structure); [web.dev PWA installation](https://web.dev/learn/pwa/installation); [Chrome ayuda](https://support.google.com/chrome/answer/9658361); MDN [share](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share) y [dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/dialog); [Cloudflare Access sessions](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/); [Expansión sobre Elenas](https://expansion.mx/tecnologia/2021/10/27/elenas-app-va-por-un-mercado-de-emprendedoras-valuado-en-30-mdd).

Solo resumen de búsqueda (no verificado): INEGI ENDUTIH 2024, Meesho (la FAQ oficial devolvió 403), guías de catálogo de WhatsApp Business, Betterware+, Vercatalogo. No se usó el W3C «Web Accessibility and Older Users: A Literature Review» (2008, no se actualiza). Los pasos exactos de «Añadir a pantalla de inicio» en Chrome e iPhone varían por versión: comprobarlos en un teléfono real antes de imprimirlos.
