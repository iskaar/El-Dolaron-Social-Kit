# Experiencia de compra en eldolaron.com y dolarones.eldolaron.com (Issue #643)

31/10/2026 · Investigación y plan; **no cambia código**. Auditoría hecha sobre `main` 173091a. Un stakeholder le dijo a Isaac que el sitio y el portal son difíciles de navegar; el caso concreto es que en «Lo nuevo en tienda» del portal tocar la foto abre WhatsApp en vez de agrandar la foto, y que la gente busca un botón que diga **«Lo quiero»**. El objetivo del plan es uno: **que sea fácil pagarnos.**

Etiquetas de las fuentes: **[LEÍDO]** = abrí la página; **[RESUMEN]** = lo dijo un resumen de búsqueda o un proveedor y no lo verifiqué; **[OBSERVADO]** = patrón visible en la app o sitio del competidor, de conocimiento general, sin captura de hoy; **[CÓDIGO]** = leído en este repositorio, con archivo y función; **[CRITERIO]** = decisión de este documento, para probar con gente real.

Documentos hermanos: [REVENDEDORAS-UX.md](REVENDEDORAS-UX.md) (principios P1–P10 para usuarias sin práctica; aquí se reutilizan), [CONTRATO-PORTAL.md](CONTRATO-PORTAL.md) (qué puede y no puede hacer el portal), [CEP-BANXICO.md](CEP-BANXICO.md) (transferencias), [MERCADOLIBRE-VENTAS.md](MERCADOLIBRE-VENTAS.md) (lo que ML nos cobra y nos exige).

---

## Resumen ejecutivo

1. **Hoy no se puede comprar en línea: solo se puede preguntar.** Los 7 botones de acción del sitio y los 6 enlaces del portal abren WhatsApp con «¿Sigue disponible?». El cliente paga siempre en tienda o tras una conversación humana. Cada paso de la compra depende de que alguien conteste.
2. **El portal rompe la expectativa básica:** tocar la foto manda a WhatsApp sin agrandar nada y sin botón (`app/public/portal.js`, `novedades()`). El sitio sí agranda la foto, pero el visor no dice cómo comprar ni tiene un «Lo quiero».
3. **El sitio habla con duda.** «Confirma disponibilidad por WhatsApp», «pregunta si sigue disponible», «¿Sigue disponible?» aparecen cinco veces. El catálogo ya sale de D1 con caché de 5 minutos: podemos hablar con certeza («Disponible hoy · 1 pieza») y lo hacemos sonar inseguro.
4. **Lo que hacen los grandes se resume en cinco cosas:** la foto se agranda con el dedo; el precio va con el costo de entrega y la fecha; la disponibilidad está junto al botón; el botón de compra siempre está a la vista (barra fija abajo); y el camino al pago no pide hablar con nadie. Mercado Libre, Amazon y TikTok Shop coinciden en las cinco [OBSERVADO]; Baymard y NN/g lo respaldan [LEÍDO].
5. **Lo que no aplica:** carrito de varias unidades (nuestras piezas son únicas), reseñas por producto, meses sin intereses en tickets de $50–$300, «llega mañana» (enviamos los viernes) y contadores falsos de urgencia.
6. **Fase «Ahora» (una semana, sin API nueva ni migración):** una sola **ficha de pieza** compartida por sitio y portal: foto con zoom (doble toque y pellizco), precio con ahorro, «Disponible hoy», cómo se compra en una línea (apartado 15 %, recoger o envío del viernes) y un botón rojo **«Lo quiero»** de 56 px que abre WhatsApp con el mensaje ya escrito y la intención elegida (recoger / envío / solo preguntar). El portal muestra el catálogo completo sin salir y, debajo del inicio de sesión, lo nuevo sin pedir SMS.
7. **Fase «Después» (2–4 semanas):** «Apartar» de verdad desde el celular con lo que ya existe: pedidos de #269 (15 % / 7 días; envío con $100), identidad del portal (SMS), transferencia con clave de rastreo (#593) y comprobante (#609). El pago con link de Mercado Pago queda detrás de una decisión de Isaac porque requiere credenciales en el Worker.
8. **Medir desde el día uno.** Hoy no sabemos cuántas personas abren una foto ni cuántas tocan WhatsApp. Propuesta: contar eventos sin cookies ni datos personales; la herramienta exacta es la decisión D1.
9. **Probar con tres clientes reales** las cinco tareas de la sección 7 antes y después de la fase «Ahora». Una captura en el navegador no sustituye a una persona con su teléfono.
10. **Decisiones de negocio pendientes** (sección 8): texto «Lo quiero» vs «Apartar», compromiso de «lo que ves está en tienda», Mercado Pago, apartar sin ser socio, mostrar condición A/B/C, catálogo sin sesión en el portal, y cómo medir.

---

## 1. Qué tenemos hoy

### 1.1 El recorrido real de un cliente

| Paso | Qué hace | Dónde se atora |
| --- | --- | --- |
| 1. Llega | Desde un anuncio de Meta (clic a WhatsApp), un grupo de WhatsApp, un sticker compartido, el sitio o el QR de un vale. | El anuncio va al asistente de WhatsApp, no al catálogo; el asistente **no aparta ni cobra** y escala al equipo (`whatsapp/asistente.mjs`: «Nunca apartes, canceles ni cobres») [CÓDIGO]. |
| 2. Mira | Baja por «Lo nuevo en tienda» en el sitio o por 6 miniaturas en el portal. | Portal: 6 piezas, letra 14 px, dos columnas, sin filtros; «Ver todo el catálogo» lo saca a otro dominio [CÓDIGO: `portal.html` L89–94, `portal.css` L57–63]. |
| 3. Quiere ver mejor | Toca la foto. | **Portal: abre WhatsApp** [CÓDIGO: `portal.js`, `novedades()`, `a.href = 'https://wa.me/...'`]. Sitio: abre el visor, pero sin zoom con el dedo [CÓDIGO: `styles.css` L215–222, `catalogo.js` `abrirVisor`]. |
| 4. Decide | Busca el botón de comprar. | Sitio: «Preguntar por WhatsApp». Portal: ninguno. Nada dice «apartar», «recoger» ni «envío» junto al precio. |
| 5. Pregunta | Escribe por WhatsApp «¿Sigue disponible?». | Espera a una persona. Fuera de las 11–20 h, nadie contesta. El asistente responde, pero para apartar escala. |
| 6. Aparta | Si el equipo contesta, deja el 15 % (en tienda o transferencia) y el personal registra el pedido en `/pedidos`. | Todo manual; el cliente no ve su apartado en ningún lado; el portal solo muestra compras cerradas (`recibos`). |
| 7. Paga | En tienda, o transferencia antes del jueves 8 p. m. para el envío del viernes. | Sin link de pago; el comprobante va por chat. |

Conclusión: el único «botón de pagar» de El Dolarón es una persona con el teléfono en la mano. Funciona cuando hay alguien; no escala, no mide y hace esperar.

### 1.2 Hallazgos

| # | Dónde | Hallazgo | Evidencia | Rompe |
| --- | --- | --- | --- | --- |
| H1 | Portal | Tocar la foto de una novedad abre WhatsApp. No hay zoom, no hay botón, no hay nombre de la acción. | `portal.js` `novedades()`: todo el `<li>` es un `<a href="https://wa.me/...">` | P1, P4 |
| H2 | Portal | Solo 6 piezas y «Ver todo el catálogo» lleva a `eldolaron.com/#catalogo`: cambio de dominio y de diseño a mitad del recorrido. `/api/catalogo` vive en el **mismo origen** del portal: el catálogo completo podría estar ahí sin salir. | `portal.js` `fetch('/api/catalogo?pagina=1')`; `catalogo.ts` solo responde en `HOST_PORTAL` | P1, P9 |
| H3 | Portal | Sin sesión no se ve nada de la tienda: solo el formulario de SMS. Quien llega del QR de un vale (`/v#…`) o de un referido (`/?r=…`) no ve una sola pieza. | `portal.html` `#acceso`; `novedades()` solo corre dentro de `cargarCuenta()` | P1 |
| H4 | Portal | La nota dice «Pregunta por WhatsApp si sigue disponible»: traslada el trabajo al cliente. | `portal.html` L91 | P3 |
| H5 | Sitio | El visor muestra foto, precio y «Preguntar por WhatsApp». No dice cómo comprar, cuánto es el apartado, ni si hay envío. | `index.html` L113 `.piece-dialog`; `catalogo.js` `abrirVisor` | P2 |
| H6 | Sitio | Sin zoom con gestos: la foto grande cabe en 62 vh y no responde a pellizco ni doble toque (el `<dialog>` modal bloquea el zoom de página). Baymard: cuando nada pasa al pellizcar, la gente se va a buscar el producto a otro lado [LEÍDO]. | `styles.css` L221–222 | P1 |
| H7 | Sitio | Lenguaje de duda en 5 lugares: «confirma disponibilidad por WhatsApp» (L99), «¿Sigue disponible?» (`consulta()`), «pregunta por WhatsApp» (L118), «Lo que hay cambia todos los días» (L118), «Cuéntanos qué buscas… Consulta disponibilidad» (L140). | `index.html`, `catalogo.js` | P3 |
| H8 | Sitio | El costo de envío ($99; gratis desde $1,000), el apartado (15 %, 7 días) y el día de envío (viernes) **no aparecen en ninguna parte del sitio** aunque están confirmados desde el 22/10 (`app/src/legal.ts`, `venta.js` L97–103). NN/g: esconder cargos hasta el final es el error clásico [LEÍDO]. | `index.html` solo dice «envío» como nombre de grupo | P2 |
| H9 | Sitio | La tarjeta tiene dos acciones (foto → visor; botón → WhatsApp) con dos verbos distintos («Ver foto» 11 px, «Preguntar»). La barra fija de celular manda un mensaje genérico («quiero preguntar por una pieza»). | `styles.css` L201, L364; `index.html` L155 | P4, P5 |
| H10 | Sitio | «Ropa americana» como nombre de todas las prendas sin marca: tarjetas idénticas salvo la foto; no hay filtro por talla ni por precio. | `catalogo.js` `tarjeta()` (ponytail del nombre); chips solo de categoría | P1 |
| H11 | Sitio | «¡Última pieza!» solo existe en «Los más buscados»; en el catálogo general ni «Disponible» ni «última». La API lo sabe (`stock === 1`) pero solo lo manda en `destacados`. | `catalogo.ts` L63 vs L141 | P3 |
| H12 | Sitio | La condición A/B/C (#371) se cobra pero no se enseña al cliente en línea. | `aPieza()` no la incluye | P2 |
| H13 | Ambos | **No hay medición.** Ningún evento de «abrió la ficha», «tocó Lo quiero», «abrió WhatsApp». No existe `beacon`, `gtag` ni similar en `site/` ni en el portal. Las únicas cifras reales son los pedidos y ventas en D1. | búsqueda de `beacon`, `gtag`, `plausible` en `site/public` y `app/public`: nada | P6 |
| H14 | Sitio | El enlace por pieza (`?pieza=ED-…`, #590) abre el visor, pero la vista previa al compartir en WhatsApp es siempre la genérica: no se ve la pieza. El sitio es solo assets (`site/wrangler.jsonc` sin script), así que un OG por pieza necesita un Worker. | `index.html` L12–17 | P5 |
| H15 | Portal | El portal es un monedero: «Mostrar mi código para caja» es la acción principal. Está bien para socios; para alguien que quiere comprar no hay nada que hacer salvo mirar 6 fotos. | `portal.html` `#monedero` | P1 |

### 1.3 Lo que ya existe y se reutiliza (no construir dos veces)

| Pieza | Dónde | Para qué sirve en este plan |
| --- | --- | --- |
| Catálogo público con cursor, categoría, búsqueda, foto y recorte; CORS a eldolaron.com; caché 300 s | `app/src/catalogo.ts` | Misma fuente para sitio y portal. Falta exponer `ultima` en la lista (hoy solo en `destacados`) y, si se decide, `grado`. |
| Visor con morph (View Transitions), `<dialog>` accesible, enlace `?pieza=` | `site/public/catalogo.js`, `styles.css` | Base de la ficha. Se extiende, no se reemplaza. |
| Apartado 15 % redondeado al peso hacia arriba; envío $100 de anticipo; $99 / gratis desde $1,000 | `app/public/venta.js` `anticipoMinimoDe`, `envioDe`, `viernesDeEnvio` | El texto «Apártala con $23» se calcula con la misma aritmética. El sitio no importa código de `app/` (regla de `site/README.md`): se copia la constante, como ya se hace con `CATEGORIAS`. |
| Pedidos: apartar, saldo, vencimiento por cron, envío, cierre en caja | `app/src/pedidos.ts` (#269) | Fase «Después»: el apartado en línea es un pedido más, con `vendedora` = portal. |
| Identidad del cliente por SMS (Firebase), `clientes.auth_uid`, bases aceptadas | `app/src/portal.ts` | Quien aparta en línea ya está identificado; no hay que inventar otra cuenta. |
| Clave de rastreo única por transferencia; CLABE de la tienda (Mercado Pago 722…) | `app/src/transferencias.ts`, `docs/CEP-BANXICO.md` | Pagar el 15 % por SPEI sin servicio nuevo. |
| Reporte de pago con foto del comprobante, revisado por la tienda | `app/src/pagos-reportados.ts` (#609) | Hoy solo para revendedoras; el cliente del portal puede usar el mismo flujo. |
| Avisos al dueño + Web Push | `app/src/avisos.ts` (#600, #607) | «Apartado nuevo por pagar» llega al teléfono del equipo. |
| Asistente de WhatsApp con `buscar_productos` y `SCORE` de intención | `whatsapp/asistente.mjs` | Puede mandar el enlace `?pieza=` de la ficha (hoy tiene prohibido pegar enlaces de piezas: habría que cambiar esa regla). |
| Referidos con enlace `/?r=` y «Enviar por WhatsApp» | `portal.js` `referidos()` | Modelo para «Compartir esta pieza». |

---

## 2. Lo que hacen los grandes y qué nos sirve

Lo que sigue describe patrones visibles en las apps y sitios públicos de cada uno [OBSERVADO], más lo que dicen Baymard, NN/g y la documentación sobre TikTok Shop [LEÍDO]. No se copió ningún diseño; se extrae la **regla** y se dice si aplica a una tienda de saldos con piezas únicas que vende por WhatsApp en Soledad.

### 2.1 Mercado Libre (México)

| Patrón | Cómo lo hace ML | ¿Aplica? |
| --- | --- | --- |
| Galería primero, a pantalla completa, deslizar entre fotos y pellizcar para acercar | La foto ocupa el primer pantallazo; un toque la abre a pantalla completa con zoom. | **Sí.** Es exactamente lo que el stakeholder pidió. |
| Precio grande + condiciones de entrega en la misma vista | «$150» y debajo «Llega gratis mañana» o «Envío gratis», antes del botón. | **Sí, adaptado:** «Recoge hoy en Soledad» o «Envío el viernes · $99 (gratis desde $1,000)». No prometer «mañana». |
| Disponibilidad junto al botón | «¡Último disponible!» o «+10 disponibles» encima de «Comprar ahora». | **Sí.** La API ya sabe si queda una. Nunca enseñar la cantidad exacta (regla de `catalogo.ts`); «Disponible» / «¡Última pieza!». |
| Dos botones apilados: «Comprar ahora» (va directo al pago) y «Agregar al carrito» | El principal es azul lleno; el secundario es azul claro. | **Sí, con otros verbos:** «Lo quiero» (principal) y «Preguntar» (secundario). El carrito no aplica (pieza única); «apartar» hace su papel. |
| Compra Protegida, vendedor y reputación | Sello verde, termómetro, «Vendido por». | **Parcial.** Somos tienda física con dirección y horario: eso es nuestra «compra protegida». Ponerlo en la ficha: «Tienda en Jardín Hidalgo 129 · 11 a 8 todos los días». |
| Preguntas y respuestas públicas | Hilo de preguntas por producto. | **No.** Pieza única, se vende antes de que haya preguntas. WhatsApp es nuestra pregunta. |
| Meses sin intereses | Debajo del precio. | **No.** Tickets de $50–$500 y pago mayormente en efectivo/transferencia. |

### 2.2 Amazon (app móvil)

| Patrón | Cómo lo hace Amazon | ¿Aplica? |
| --- | --- | --- |
| «Comprar ahora» con un toque y datos guardados | Un botón salta carrito y formulario. | **A medias.** No tenemos pago en línea; el equivalente honesto es que «Lo quiero» mande a WhatsApp **con todo ya escrito** (pieza, código, precio, qué quiere hacer). Fase «Después»: apartar con un toque desde el portal, donde el cliente ya está identificado. |
| Fecha de entrega junto al botón («Recíbelo el martes») | Calculada, no genérica. | **Sí.** «Envío el viernes 7» calculado con `viernesDeEnvio` de `venta.js`; «Recoge hoy hasta las 8 p. m.» si es horario de tienda. |
| «Solo quedan 3» | Escasez real. | **Sí**, solo «¡Última pieza!» y solo si el servidor lo dice. |
| Barra fija inferior con precio y botón en la app | Siempre a la vista al bajar. | **Sí** en la ficha (visor) del celular: el botón no debe salir de pantalla al hacer zoom o leer. |
| Reseñas con resumen | Estrellas y resumen. | **No por producto.** Sí reseñas de la **tienda** (Google / Facebook) en «Más adelante». |
| «Comprados juntos» | Recomendaciones. | **No ahora.** NN/g advierte que las recomendaciones amontonadas tapan lo importante [LEÍDO]. |

### 2.3 TikTok Shop

| Patrón | Cómo lo hace TikTok Shop | ¿Aplica? |
| --- | --- | --- |
| Video corto primero (10–30 s), la misma pieza que te detuvo en el feed | La ficha abre con el video; la guía de Racklify lo pone como primer elemento [LEÍDO]. | **Más adelante.** Hoy hay una foto y un recorte por pieza. Para piezas de más de $300 un clip de 10 s desde la caja podría valer; decisión de costo. |
| Barra fija: Tienda · Chat · Agregar · **Comprar ahora** | Cuatro acciones, la de pago en rojo. | **Sí, reducido:** «Preguntar» (chat) y «Lo quiero» (rojo). Dos, no cuatro. |
| «X vendidos», cupón visible, cuenta regresiva de oferta | Urgencia constante. | **Solo lo honesto.** «Llegó esta semana» (la fecha es real), «¡Última pieza!». Sin contadores falsos ni cupones inventados. El precio tachado con «Ahorras $300» ya existe y es real (precio de lista). |
| Pago dentro de la app con tarjeta guardada | Cero fricción. | **Decisión de negocio** (C1). Requiere pasarela; comisión de ~3.5 % + $4 + IVA por operación en el link de pago de Mercado Pago [RESUMEN, calculadora de terceros; verificar en el panel]. En un ticket de $100 eso es ≈ $8. |
| Inventario sincronizado para no cancelar | La guía insiste: lo que se promete se debe poder cumplir. | **Ya lo tenemos:** D1 es el maestro y la caja pausa ML al vender. Es la razón para poder decir «Disponible hoy» sin miedo. |

### 2.4 Lo que dice la investigación de usabilidad

- **Zoom con gestos.** Baymard: ~40 % de los 50 sitios móviles más grandes de EE. UU. no soportan pellizco ni doble toque sobre la foto; en pruebas, la gente lo intenta igual y, cuando no pasa nada, **abandona para buscar el producto en otro sitio**. Recomiendan soportar **ambos** gestos, cargar una imagen de más resolución al acercar y mostrar una pista breve («Toca dos veces para acercar») que desaparece sola [LEÍDO](https://baymard.com/blog/mobile-image-gestures).
- **Elementos mínimos de una ficha.** NN/g: nombre descriptivo, fotos con vista ampliada, **precio con todos los cargos** (incluido envío), opciones claras, **disponibilidad antes del carrito**, acción de compra clara con confirmación, descripción breve. Errores típicos: esconder el envío hasta el final, revelar «agotado» después de agregar, llenar la página de recomendaciones [LEÍDO](https://www.nngroup.com/articles/ecommerce-product-pages/).
- **Barra fija de compra en celular.** Varios proveedores reportan mejoras de 3 % a 25 % en conversión móvil; los números no coinciden entre sí y vienen de quien vende la función [RESUMEN]. La regla que sí se sostiene: en celular la página es larga y el botón desaparece al bajar; la barra debe ser delgada, con nombre, precio y un botón, sin animaciones.
- **Lectoras con poca práctica.** Los principios P1–P10 de [REVENDEDORAS-UX.md](REVENDEDORAS-UX.md) (una acción por tarjeta, 18 px, toques de 56 px, verbos concretos, estado = color + ícono + palabra, resultado visible hasta que se toca) aplican a los clientes igual que a las revendedoras.

### 2.5 WhatsApp como canal de cierre

- En México, el carrito y el catálogo de WhatsApp Business existen desde 2019–2020: el cliente arma el carrito y lo manda como un solo mensaje; **no hay pago dentro de WhatsApp en México** (sí en Brasil e India) [LEÍDO, prensa de Meta 2020; estado 2026 sin verificar en la documentación de Meta].
- Un proveedor reporta que en México 71 % de los negocios venden por WhatsApp y que los clientes prefieren link de pago con tarjeta (31 %), SPEI (28 %) y efectivo contra entrega (15 %) [RESUMEN, Aurora Inbox, cifras de proveedor con errores de formato; no usar como dato duro]. Lo útil: **SPEI + link de pago cubren el 59 %**; ya tenemos SPEI con clave de rastreo.
- Las prácticas que se repiten en todas las guías: contestar en menos de 5 minutos en horario, mensajes con la pieza ya identificada, y seguimiento a quien preguntó y no compró [RESUMEN]. Nuestro asistente ya contesta al instante y ya marca `SCORE` de intención; lo que falta es que el cliente llegue con la pieza y la intención ya escritas (P5).

---

## 3. Principios

| # | Principio | De dónde sale |
| --- | --- | --- |
| P1 | **La foto es la puerta; el botón es la salida.** Tocar la foto siempre la agranda (nunca manda a otro lado). Un solo botón principal, rojo, 56 px, con un verbo: «Lo quiero». | Baymard, NN/g, REVENDEDORAS-UX P1/P3 |
| P2 | **Cómo se compra va junto al precio**, en una línea: apartado, dónde se recoge, cuánto y cuándo el envío. No en otra sección ni en «Cómo comprar». | NN/g (cargos ocultos); ML y Amazon ponen la entrega junto al precio |
| P3 | **Certeza, no duda.** «Disponible hoy» / «¡Última pieza!» / «Se vendió». Nada de «pregunta si sigue disponible». La caché de 5 minutos se declara una vez, chiquito: «Actualizado hace N min». | D1 es el maestro; `catalogo.ts` max-age 300 |
| P4 | **Un verbo por pantalla y palabras de todos los días.** «Lo quiero», «Preguntar», «Compartir». Nada de «consultar disponibilidad». | REVENDEDORAS-UX P4 |
| P5 | **Lo que el cliente ya decidió no se vuelve a preguntar.** El mensaje a WhatsApp lleva pieza, código, precio, talla y lo que quiere hacer (recoger / envío / solo preguntar). El equipo contesta «listo», no «¿cuál?». | Amazon un toque; guías WhatsApp |
| P6 | **Medir antes de cambiar y después.** Sin número de base, no hay forma de saber si «Lo quiero» vendió más. | H13 |
| P7 | **Nada nuevo que pague renta.** Primero lo que ya hay (pedidos, SMS, SPEI, comprobante, avisos). Pasarela, analítica de terceros o catálogo de Meta solo con decisión de Isaac. | `AGENTS.md`, `app/AGENTS.md` |
| P8 | **Urgencia honesta.** Solo lo que el servidor sabe: última pieza, fecha de llegada, ahorro real contra precio de lista. Sin relojes ni «23 personas viendo esto». | Contraste con TikTok/Temu; marca «Calidad americana, precio mexicano» |
| P9 | **El mismo diseño en sitio y portal.** Una ficha, un visor, un botón. El cliente no debe notar que cambió de dominio. | H2 |

---

## 4. Diseño objetivo: la ficha de pieza

Una sola ficha, usada en cuatro lugares: el visor del sitio, el catálogo del portal, el enlace `?pieza=` y, más adelante, la vista previa que manda el asistente de WhatsApp. En celular (360 px):

```
┌──────────────────────────────────┐
│ ◂ Cerrar                         │
│ ┌──────────────────────────────┐ │
│ │                              │ │  Foto 4:5, deslizar entre foto y recorte,
│ │        [ FOTO GRANDE ]       │ │  doble toque y pellizco para acercar.
│ │                              │ │  Pista 3 s: «Toca dos veces para acercar».
│ │ ¡Última pieza!  (si aplica)  │ │  Sello rojo, solo si el servidor lo dice.
│ └──────────────────────────────┘ │
│ NIKE · Talla M · ED-001850        │  Marca o categoría · talla · código (14 px, gris)
│ Sudadera con gorro                │  Nombre 20 px
│ $150  ~~$450~~  Ahorras $300      │  Precio Anton 36 px rojo; lista tachada; ahorro en negritas
│ ● Disponible hoy en tienda        │  Verde + punto + palabra (P5 de REVENDEDORAS)
│ Apártala con $23 por 7 días.      │  anticipoMinimoDe(precio) → 15 % redondeado al peso
│ Recoge en Soledad (11 a 8) o      │
│ te la enviamos el viernes 7       │  viernesDeEnvio(); «$99 · gratis desde $1,000»
│ ($99 · gratis desde $1,000).      │
│ Condición A · Llegó esta semana   │  (si D6 lo aprueba) · fecha real de captura
├──────────────────────────────────┤
│ ┌──────────────────────────────┐ │  Barra fija abajo mientras la ficha está abierta
│ │ $150   [    Lo quiero     ]  │ │  Botón rojo 56 px; precio a la izquierda
│ └──────────────────────────────┘ │
│   Preguntar por WhatsApp · Compartir │  Secundarios, texto 16 px, 44 px de alto
└──────────────────────────────────┘
```

**Qué pasa al tocar «Lo quiero».** Se abre una hoja con tres opciones grandes (56 px cada una), en este orden:

1. **Apartarla y recogerla en tienda** → WhatsApp con: «Hola, quiero apartar *Sudadera Nike talla M* (ED-001850) de $150. Dejo $23 de apartado y paso a recogerla a Jardín Hidalgo 129.»
2. **Apartarla con envío** → «…de $150. Dejo $100 de anticipo para el envío del viernes 7 (envío $99). ¿Me pasan los datos para transferir?»
3. **Solo preguntar algo** → «Hola, tengo una pregunta sobre *Sudadera Nike talla M* (ED-001850) de $150.»

En la fase «Ahora» las tres van a WhatsApp (sin API nueva). En la fase «Después», la 1 y la 2 **crean el apartado** en D1 desde el portal y piden el pago; WhatsApp queda para la 3 y para quien no quiera registrarse.

**Zoom.** Doble toque alterna 1× / 2.5×; pellizco escala entre 1× y 4×; arrastrar mueve la foto acercada; al cerrar vuelve a 1×. Sin librería: `pointer events` + `transform`, unas 60 líneas. Al pasar de 1×, la `<img>` cambia a la foto original (`/api/catalogo/foto/`, que ya se sirve a tamaño completo) si estaba mostrando el recorte. `touch-action: none` dentro de la foto para que el gesto no se lo quede el navegador (mismo truco que los stickers de la portada, #537).

**Tarjeta en el catálogo (lista).** Foto 4:5 con sello «¡Última pieza!» cuando aplica; nombre; talla; precio con lista tachada; una línea «● Disponible»; **un solo botón «Lo quiero»** que abre la ficha (no WhatsApp directo: la ficha es donde se decide). El chip «Ver foto» desaparece: toda la tarjeta abre la ficha.

**Catálogo en el portal.** La misma lista, con los chips de categoría, dentro del portal (`/api/catalogo` es del mismo origen). Visible **debajo del formulario de SMS** cuando no hay sesión (si D7 lo aprueba) y dentro del monedero cuando sí la hay. «Ver todo el catálogo» deja de sacar a otro dominio.

---

## 5. Plan por fases

Cada letra es un Issue hijo y un PR. Modelo: el hilo principal escribe el brief; un agente implementa; prueba en celular real antes de mergear; Isaac despliega.

### Fase «Ahora» — una semana, sin migración, un campo nuevo en una respuesta existente

| # | Qué | Archivos | Tamaño |
| --- | --- | --- | --- |
| A1 | **Ficha de pieza en el sitio:** zoom con gestos, precio + ahorro, disponibilidad, línea «cómo se compra», barra fija con «Lo quiero», hoja de tres opciones, mensajes prellenados nuevos. Copiar constantes de apartado/envío de `venta.js` como ya se copia `CATEGORIAS`. | `site/public/catalogo.js`, `styles.css`, `index.html` (dialog) | M |
| A2 | **Tarjetas del sitio:** «Lo quiero» abre la ficha; quitar «Ver foto»; sello «¡Última pieza!» en el catálogo general; línea «● Disponible». Requiere A4. | `catalogo.js` `tarjeta()`, `styles.css` | S |
| A3 | **Portal:** novedades → ficha (misma de A1, movida a un módulo compartible o copiada: decidir en el PR respetando que el sitio no importa de `app/`); catálogo completo con chips y «Ver más» dentro del portal; «Lo quiero» con las mismas tres opciones. Novedades visibles sin sesión (D7). | `app/public/portal.html`, `portal.js`, `portal.css`; permitir `/categorias.js` en el host del portal si se reutiliza | M |
| A4 | **API:** `ultima: true` cuando `stock = 1` en la lista de `/api/catalogo` (hoy solo en `destacados`); `llegado_en` (fecha de captura, solo día) para «Llegó esta semana». Sin exponer cantidades. Prueba en `catalogo.test.ts`. | `app/src/catalogo.ts` | S |
| A5 | **Textos de certeza en el sitio:** reemplazar las cinco frases de duda (H7) y poner apartado/envío en «Cómo comprar» y en la sección Ropa. Revisar con `docs/marca/VOZ.md`. | `site/public/index.html` | S |
| A6 | **Medición mínima:** eventos `ficha_abierta`, `lo_quiero`, `whatsapp_abierto`, `compartir` con código de pieza y origen (sitio/portal), sin cookies ni datos personales. La herramienta la fija D1; si se elige Workers Analytics Engine, es un binding en `wrangler.jsonc` y un `POST /api/catalogo/evento` con tope por IP. | `app/src/catalogo.ts`, `wrangler.jsonc`, `catalogo.js`, `portal.js` | S–M |

Validación de la fase: `npm test`, `npm run typecheck`, `python tools/validate_assets.py`, `python tools/validate_site.py`, `node tools/check_site_catalogo.cjs`; capturas a 360 px y 390 px; **las cinco tareas de la sección 7 con tres personas**.

### Fase «Después» — 2 a 4 semanas: apartar y pagar sin hablar con nadie

| # | Qué | Reutiliza | Decisión previa |
| --- | --- | --- | --- |
| B1 | **Apartar desde el portal.** `POST /api/portal/apartar {codigo, entrega}` crea un pedido de #269 (15 % o $100 de envío, 7 días, `vendedora` = «portal», `cliente_id` del socio) y baja la existencia en el mismo batch. Responde el importe a pagar, la CLABE y la clave que debe traer la transferencia. | `pedidos.ts`, `portal.ts`, `transferencias.ts` | D5 (¿solo socios?) |
| B2 | **Pagar el apartado:** el cliente transfiere y sube el comprobante o la clave de rastreo desde el portal; la tienda lo acepta en `/pedidos` como hoy con las revendedoras. Aviso push al equipo. | `pagos-reportados.ts` (#609), `avisos.ts` | Ninguna |
| B3 | **«Mis apartados» en el portal:** vence en N días (cuenta regresiva, P9 de REVENDEDORAS), cuánto falta por pagar, «listo para recoger», envío del viernes con guía. | `pedidos.ts` lectura filtrada por `cliente_id` | Ninguna |
| B4 | **Link de pago de Mercado Pago por pedido** (tarjeta, SPEI, efectivo en OXXO): el Worker crea el link y la notificación de pago cierra el anticipo solo. | Credenciales nuevas en el Worker, webhook | **D4** (servicio y credenciales) |
| B5 | **Vista previa por pieza al compartir** (`og:image` con la foto, título con nombre y precio): requiere que `eldolaron.com/?pieza=` pase por un Worker que sirva el HTML con las etiquetas correctas. «Compartir» en la ficha con `navigator.share`. | `site/wrangler.jsonc` + script nuevo | Cambio estructural del sitio: anotar en Issue |
| B6 | **Filtros que sirven:** talla (ropa y calzado) y bandas de precio ($50 / $80 / $100 / $150 / $200+); «Llegó hoy». | `catalogo.ts` ya filtra por `q` y categoría | Ninguna |
| B7 | **El asistente manda la ficha:** permitirle pegar `https://eldolaron.com/?pieza=ED-…` cuando el cliente pregunta por una pieza concreta, y ofrecer «Lo quiero» desde ahí. | `whatsapp/asistente.mjs` (regla de enlaces) | Revisar con #499 |

### Fase «Más adelante» — decisiones de negocio, no de diseño

| # | Qué | Por qué espera |
| --- | --- | --- |
| C1 | Pago con tarjeta directo en la ficha (Checkout Pro o similar) | Comisión ≈ 3.5 % + $4 + IVA por operación en tickets de $50–$300; conciliación con corte de caja. |
| C2 | Apartar varias piezas en un pedido (los pedidos ya tienen líneas) | Primero medir si alguien quiere dos a la vez. |
| C3 | Reseñas de la tienda (Google) y foto del local en la ficha | Necesita reseñas reales acumuladas. |
| C4 | Entrega local el mismo día en Soledad («Llega hoy») | Costo y logística; hoy envíos solo los viernes. |
| C5 | Catálogo oficial de WhatsApp (Commerce Manager) sincronizado desde D1 | Integración nueva con Meta; duplicaría la fuente visible de stock. |
| C6 | Video de 10 s por pieza de más de $300 | Costo de captura por pieza; probar con 10 piezas. |

---

## 6. Qué medir

| Paso del embudo | Cómo se cuenta | Base hoy | Meta a 30 días [CRITERIO] |
| --- | --- | --- | --- |
| Catálogo visto (sitio o portal) | evento `catalogo` (A6) | Desconocida | — |
| Ficha abierta | `ficha_abierta` + código | Desconocida | ≥ 25 % de quienes ven el catálogo |
| «Lo quiero» tocado | `lo_quiero` + opción | Desconocida | ≥ 10 % de las fichas abiertas |
| WhatsApp abierto con pieza | `whatsapp_abierto` | Desconocida | — |
| Apartado registrado | `pedidos` en D1 (ya existe) | Se puede sacar hoy de `/pedidos` | ≥ 30 % de los «Lo quiero» con apartar |
| Venta cerrada con pedido | `ventas.pedido_id` (ya existe) | Se puede sacar hoy | ≥ 70 % de los apartados (el resto vence) |

Las dos últimas filas ya se pueden medir **hoy**, antes de tocar nada: cuántos pedidos por semana nacen de WhatsApp y cuántos se cierran. Ese es el número de base del plan. Lo demás requiere A6.

---

## 7. Prueba con personas reales (antes y después de «Ahora»)

Tres clientes (no personal, no familia que ya conoce la app), cada una con su propio teléfono, en la tienda o por videollamada. Se cronometra y se anota dónde dudan. Cinco tareas:

| # | Tarea | Éxito |
| --- | --- | --- |
| T1 | «Encuentra una prenda de tu talla que cueste menos de $150.» | La encuentra en menos de 2 minutos sin ayuda. |
| T2 | «Mira la foto de cerca para ver si tiene detalles.» | Usa doble toque o pellizco y lo logra al primer intento. |
| T3 | «Apártala.» | Llega al mensaje de WhatsApp con la pieza y el importe del apartado sin escribir nada. |
| T4 | «¿Cuánto te costaría que te la mandaran y cuándo llegaría?» | Lo dice sin salir de la ficha. |
| T5 | «Mándasela a una amiga.» | Comparte un enlace que abre esa pieza (B5 para que la vista previa muestre la foto). |

Resultado esperado tras «Ahora»: T1–T4 en 3 de 3; T5 depende de B5.

---

## 8. Decisiones para Isaac (en el Issue #643)

| # | Decisión | Recomendación de este documento |
| --- | --- | --- |
| D1 | **Cómo medir.** (a) Workers Analytics Engine: binding en la misma cuenta de Cloudflare, sin cookies, consulta por SQL; (b) Cloudflare Web Analytics: un script de terceros en la página; (c) tabla en D1: escrituras públicas, hay que limitarlas; (d) no medir. | (a). Es la misma cuenta, no agrega proveedor, y cuenta eventos por pieza. Requiere tu autorización por ser un binding nuevo. |
| D2 | **Verbo del botón:** «Lo quiero» (lo pidió el stakeholder) o «Apartar». | «Lo quiero» en la tarjeta y la ficha; «Apartarla» dentro de la hoja de opciones. Probar en T3. |
| D3 | **Compromiso de certeza:** decir «Disponible hoy» con caché de 5 minutos. Riesgo: una pieza vendida hace 4 minutos todavía se ve. | Sí, con «Actualizado hace N min» chiquito; la caja ya pausa ML al vender. Si se vende, el equipo lo dice por WhatsApp como hoy. |
| D4 | **Mercado Pago:** autorizar credenciales en el Worker para links de pago (B4), o empezar solo con transferencia + comprobante (B2). | Empezar con B2 (cero servicios nuevos); decidir B4 con el número de apartados del primer mes. |
| D5 | **Apartar en línea sin ser socio.** ¿Basta el teléfono por SMS (ya es el registro del portal) o se exige aceptar las bases? | Exigir el registro del portal: ya existe, identifica al cliente y da Dolarones. El que no quiera, usa WhatsApp. |
| D6 | **Mostrar condición A/B/C** al público en la ficha. | Sí: es honesto y explica el precio. Texto: «Condición A: como nueva», «B: con detalle», «C: liquidación». |
| D7 | **Catálogo visible sin sesión en el portal.** | Sí. Quien llega del QR del vale o de un referido ve la tienda antes de dar su teléfono. |
| D8 | **Publicar envío $99 / gratis desde $1,000 y apartado 15 % en el sitio.** Confirmados el 22/10 pero nunca publicados. | Sí, en la ficha y en «Cómo comprar». |

---

## 9. Fuentes

- Baymard Institute, *Mobile image gestures* [LEÍDO]: https://baymard.com/blog/mobile-image-gestures
- Baymard, guideline #779 *Zoomed image quality* (solo título, de pago) [RESUMEN]: https://baymard.com/guidelines/779-zoomed-image-quality-in-product-page-image-gallery
- Nielsen Norman Group, *E-commerce product pages* [LEÍDO]: https://www.nngroup.com/articles/ecommerce-product-pages/
- Racklify, *What is a TikTok Shop product detail page* [LEÍDO, glosario de tercero]: https://racklify.com/encyclopedia/what-is-a-tiktok-shop-product-detail-page/
- Meta, carritos en WhatsApp (2020) [LEÍDO, prensa]: https://about.fb.com/es/news/2020/12/facilitamos-la-experiencia-de-compra-en-whatsapp-con-la-implementacion-de-carritos
- Expansión, catálogo de WhatsApp Business en México (2019) [RESUMEN]: https://expansion.mx/tecnologia/2019/11/08/whatsapp-ahora-te-permitira-vender-por-catalogo
- Mercado Pago, link de pago y Checkout Pro [LEÍDO parcial, oficial]: https://www.mercadopago.com.mx/blog/hot-sale-integra-mercado-pago · comisión 3.49 % + $4 + IVA [RESUMEN, calculadora de terceros, verificar en el panel]: https://calcforlife.com/es/calculadora-mercado-pago-comisiones/
- Aurora Inbox, estadísticas de e-commerce por WhatsApp en Latinoamérica 2026 [LEÍDO, proveedor, cifras con errores]: https://www.aurorainbox.com/en/2026/03/04/estadisticas-ecommerce-whatsapp-latam/
- Guías de barra fija de compra (proveedores, cifras dispares) [RESUMEN]: https://gempages.net/blogs/shopify/sticky-add-to-cart · https://cartylabs.com/blog/shopify-sticky-add-to-cart-bar
- Patrones de Mercado Libre, Amazon y TikTok Shop [OBSERVADO]: apps y sitios públicos; sin captura de esta fecha. Si hace falta evidencia, un agente con navegador puede documentarlos con capturas en el Issue.
- Repositorio [CÓDIGO]: `app/public/portal.js`, `portal.html`, `portal.css`; `site/public/catalogo.js`, `index.html`, `styles.css`; `app/src/catalogo.ts`, `pedidos.ts`, `pagos-reportados.ts`, `portal.ts`; `app/public/venta.js`; `whatsapp/asistente.mjs`; `docs/REVENDEDORAS-UX.md`, `CONTRATO-PORTAL.md`, `CEP-BANXICO.md`.
