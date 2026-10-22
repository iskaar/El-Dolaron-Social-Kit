# Voz, tono y mensajes de El Dolarón

Parte del manual de marca ([Issue #433](https://github.com/iskaar/El-Dolaron-Social-Kit/issues/433)). Solo recoge lo que ya está publicado o aprobado en el repositorio; no agrega claims nuevos. Rutas relativas a la raíz del repo.

## 1. Personalidad

Tienda de barrio con calidad americana (`site/DESIGN.md`): cercana, directa y sin ruido. Se tutea siempre al cliente.

| Rasgo | Sí decimos | No decimos | Ejemplo real |
| --- | --- | --- | --- |
| **Clara y concreta** | Precio, talla, condición, dirección, horario. | Superlativos vacíos («los más baratos», «increíble», «únicos en México»). | «Cada prenda trae su precio en etiqueta: $50, $80, $100, $150…» (`site/public/index.html`) |
| **Honesta con lo que hay** | «Lo que ves es lo que hay», «confirma disponibilidad». | Escasez, urgencia o llegadas que no se pueden comprobar. | «Casi todas son únicas, así que lo que ves es lo que hay.» (`site/public/que-es-un-saldo.html`) |
| **Cercana y de barrio** | «Nos vemos en el centro», «Pasa a la tienda», «Entérate primero». | Tono corporativo o jerga publicitaria («exclusivo», «oportunidad única»). | «¿Ya tienes algo en mente? Un mensaje antes de tu visita.» (`site/public/index.html`, sección F) |
| **Orgullosa de lo americano, sin presumir** | «Marcas americanas, a precio de saldo»; «las revisamos una por una». | «Oferta barata», «todo a un dólar», afiliación con cadenas, garantías no definidas. | «Marcas americanas, *a precio de saldo.*» (`site/DESIGN.md`: reorientado el 15/10/2026, Issue #339, «no oferta barata») |
| **Juguetona en los objetos, no en los datos** | Cupones «Vale por tu lugar en el Grupo de Ropa», carteles «Se busca», «¡Última pieza!». | Bromas con precios, condiciones, dinero o reglas. | «Vale por tu lugar en el Grupo de Ropa» (`site/public/index.html`, sección D) |

## 2. Mensajes clave (ya en uso)

0. **Calidad americana, precio mexicano.** Lema de marca (22/10/2026).
1. **Marcas americanas, a precio de saldo.** Titular de portada y descripción del sitio (`site/public/index.html`, `site/DESIGN.md`).
2. **Ropa americana y mercancía general.** Ropa; hogar, belleza, juguetes y más (`index.html`).
3. **Calidad americana, pieza por pieza.** Se revisan, fotografían y etiquetan una por una (`que-es-un-saldo.html`).
4. **Precio claro.** Ropa desde $50 por prenda; el precio va en la etiqueta; el resto, en el catálogo (`index.html`).
5. **Las piezas cambian todos los días; confirma por WhatsApp** disponibilidad, precio y condición (`index.html`).
6. **Entérate primero:** grupos de WhatsApp de Ropa y de Mercancía General (`index.html`).
7. **Compra y gana Dolarones:** 1 Dolarón = $1.00 en tienda; registrarte es gratis y compras a los mismos precios (`index.html`, `app/public/portal.html`).
8. **Compra en sucursal:** Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, S.L.P., C.P. 78430; todos los días de 11:00 a. m. a 8:00 p. m.; efectivo, transferencia y tarjeta; recogida en la sucursal (`index.html`, `que-es-un-saldo.html`).
9. **Qué es un saldo:** mercancía vendida por debajo de su precio original, de pallets de liquidación de Estados Unidos (`que-es-un-saldo.html`).

## 3. Vocabulario

| Palabra | Significado en la tienda |
| --- | --- |
| **Saldo** | Mercancía que se vende por debajo de su precio original (`que-es-un-saldo.html`). |
| **Pieza** | Cada artículo individual, con código y precio propios; casi todas son únicas. |
| **Marcas / mercancía americana** | Lo que llega de Estados Unidos en pallets de liquidación. No implica afiliación con marcas ni cadenas. |
| **Ropa americana** / **mercancía general** | Prendas / hogar, belleza, juguetes y más. |
| **Hallazgo** | Pieza que vale la pena encontrar (serie «Hallazgos de El Dolarón», `docs/MARKETING-30-DIAS.md`). |
| **Los más buscados** / **Lo nuevo en tienda** | Secciones del sitio: carteles «Se busca» y novedades diarias. |
| **Dolarón(es)** | Unidad del programa de lealtad: 1 Dolarón = $1.00 MXN en tienda. **No** significa que todo cueste un dólar (`05-Guia-y-textos/Textos-para-redes.txt`). En el ticket se abrevia «D». |
| **Socio / membresía** | Cliente registrado en Dolarones (gratis, voluntario, mayores de 18). |
| **Vale** | Papel impreso con Dolarones para quien compra sin registrarse: 5 por cada $100, vence a los 30 días (`index.html`, sección E). |
| **Cupón** | Dos usos: el cupón visual de los grupos de WhatsApp («Vale por tu lugar…») y el «cupón en Dolarones» con que caja devuelve una pieza (`app/public/ticket.js`). |
| **Apartar** | Reservar una pieza con anticipo (ver inconsistencia 4). |
| **Sucursal / recogida** | Único canal de entrega hoy: se recoge en la tienda. |
| **Preguntar / confirmar por WhatsApp** | Forma estándar de cerrar la conversación. |

**Evitar:** «súper precios» (texto viejo del kit), «oferta barata», «el más barato», «remate», «ganga»; «envío», «a domicilio», «garantía» o «devolución» sin política aprobada; «original» o «auténtico» sin comprobar; «gratis» salvo registrarse en Dolarones y unirse a los grupos; «dólar» como precio; nombrar a Target, Walmart, JCPenney o Dollar General como proveedores.

## 4. Reglas por canal

| Canal | Largo | Emojis | Llamada a la acción |
| --- | --- | --- | --- |
| **WhatsApp 1 a 1** | 1 a 3 líneas; responde al producto o código. | Pocos, solo en fichas de pieza (🛍️ nombre, 💵 precio, 🔖 código; `app/public/vender.js` en la rama `origin/agent/codex/431-vender`). | «Compártenos la foto o el nombre para revisar los detalles» (`Textos-para-redes.txt`). |
| **WhatsApp grupos** | Lista corta `código · nombre · precio` con un solo cierre al final. | Mínimos. | Pedidos por privado, no en el grupo (`docs/MARKETING-30-DIAS.md`). |
| **Facebook / Instagram** | Una pieza o cuatro novedades; nombre, precio y un detalle. | 🇺🇸 como sello de marca; etiquetas `#ElDolarón #MercancíaAmericana`. | «Escríbenos para consultar disponibilidad»; «¿Cuál te interesa?». |
| **Sitio** (`site/public/`) | Frases cortas; titular y una línea. | Ninguno. | «Ver catálogo», «Preguntar por WhatsApp», «Cómo llegar». |
| **Ticket impreso** (`app/public/impresora.js`) | Solo datos de venta y «Gracias por su compra». | Ninguno. | Ninguna. La impresora térmica imprime sin acentos («EL DOLARON»): limitación de hardware, no regla de marca. |
| **Mercado Libre** (`docs/MERCADOLIBRE.md`, `app/src/mercadolibre.ts`) | Título y descripción factuales: nombre, marca, condición. | Ninguno (el código los elimina con `sinEmojis`). | Ninguna promocional. Fotos sin logos ni textos. |

Siempre: saludo breve, tuteo, una sola pregunta o acción por mensaje, y precio con símbolo y moneda en piezas sueltas («$250 MXN»).

## 5. Reglas que no se rompen

1. **No inventar** precios, horarios, promociones, descuentos, disponibilidad, escasez, envíos, garantías ni políticas (`README.md`, `AGENTS.md`). Una plantilla con `[corchetes]` no es publicable hasta llenarla con datos confirmados.
2. **Los precios salen de la tienda.** El kit los deja vacíos a propósito; el sitio solo publica precios confirmados (`site/DESIGN.md`).
3. **Nombre: «El Dolarón»**, con tilde y «El» en mayúscula. Nunca «Dolaron», «ElDolaron» ni «Viste Boutique» (proyecto abandonado). Etiqueta: `#ElDolarón`.
4. **Acentos y ortografía completos** en todo lo que ve el cliente, con ¿ ¡. Horario: «11:00 a. m. a 8:00 p. m.».
5. **Colores y logo** según `site/DESIGN.md`: azul #16366B, rojo #D72B32, amarillo #FFD447, blanco; un solo logo vigente.
6. **No afirmar** que todo el inventario fue probado: solo que se revisan las piezas y los productos grandes (`docs/MARKETING-30-DIAS.md`).

## 6. Inconsistencias encontradas (sin corregir en archivos; las resueltas llevan marca)

1. **[Resuelta: ver decisión 2 de Isaac]** **Eslogan viejo vs vigente.** `05-Guia-y-textos/Textos-para-redes.txt` dice «Súper precios y grandes hallazgos» y «Mercancía americana a súper precios»; el sitio y `site/DESIGN.md` usan «Marcas americanas, a precio de saldo» (sin «oferta barata», #339).
2. **[Resuelta 22/10/2026: el único WhatsApp oficial es 444 543 7754]** **Dos teléfonos.** `docs/MARKETING-30-DIAS.md` da 444 854 5980 como WhatsApp comercial; el sitio, `app/public/portal.js` y `whatsapp/respuestas.mjs` usan 444 543 7754 y llaman a 854 5980 «teléfono fijo (no es WhatsApp)» (también `app/src/legal.ts`).
3. **[Resuelta 22/10/2026: «11 a. m. a 8 p. m.» y, en espacio corto, «de 11 a 8»]** **Horario escrito de cuatro formas:** «11:00 a. m. a 8:00 p. m.» (`site/public/index.html`), «de 11 a 8» (marquesina del mismo archivo), «11 am a 8 pm» (`app/public/marketplace.html`), «11:00 a 20:00» (`whatsapp/respuestas.mjs`, `app/src/legal.ts`).
4. **[Resuelta 22/10/2026: 15 % del valor por 7 días en tienda; ver Decisiones]** **Apartado:** `docs/MARKETING-30-DIAS.md` propone 30% y 15 días (pendiente de validación legal); el código usa 7 días (`app/src/pedidos.ts`, `DIAS_APARTADO`) y la rama `origin/agent/codex/431-vender` (`app/public/vender.js`) dice «Apártala con $100 por 7 días». El sitio no publica ninguna política de apartado.
5. **[Contacto resuelto 22/10/2026: dirigir a WhatsApp, no a Messenger]** **Contacto y entrega en Marketplace/ML:** `app/public/marketplace.html` termina con «Escríbenos por Messenger» (el resto de la marca dirige a WhatsApp); `app/src/mercadolibre.ts` crea artículos con `shipping.mode: 'me2'` y `local_pick_up: false`, mientras el sitio dice «recogida en sucursal».
6. **[Resuelta 22/10/2026: «Mercancía y ropa americana»]** **Descriptor del negocio:** «Productos Americanos» (`app/public/impresora.js`), «Mercancía americana» (`Textos-para-redes.txt`), «Ropa americana y mercancía general» (sitio), «Saldos americanos» (sitio y `MARKETING-30-DIAS.md`); y perfiles heredados con «Más que moda» y categoría «tienda de ropa» (`MARKETING-30-DIAS.md` §4).
7. **[Resuelta 22/10/2026: se tutea siempre, también en el ticket]** **Tú vs usted.** Todo se tutea, pero el ticket dice «Gracias por su compra» (`app/public/impresora.js`).
8. **[Resuelta 22/10/2026: «muéstralo en caja»]** **Nombre del dueño en texto de cliente:** `app/public/portal.html` dice «Muestra este código a Isaac en la tienda»; el resto de la marca no nombra personas.
9. **«Las revisamos una por una»** (`site/public/index.html`) vs la cautela de `docs/MARKETING-30-DIAS.md`: no afirmar que todo el inventario fue probado.
10. **«Vale» y «cupón» se solapan:** vale impreso de Dolarones, cupón de grupo («Vale por tu lugar…») y cupón de devolución en caja son cosas distintas con palabras cercanas.
11. **Origen de la mercancía:** el sitio dice «pallets de liquidación»; `MARKETING-30-DIAS.md` menciona B-Stock de cadenas concretas con la advertencia de no implicar afiliación. Mantener fuera del copy público.
12. **Precios de ropa:** el sitio publica «desde $50» y $50/$80/$100/$150/$200, mientras el kit dice que sus precios están vacíos «deliberadamente» (`Textos-para-redes.txt`). Confirmar que siguen vigentes antes de reutilizarlos en redes.
13. **Datos del local en el kit:** `Textos-para-redes.txt` aún pide «agregar» dirección y horario que ya están confirmados y publicados en el sitio.

## 7. Decisiones de Isaac (22/10/2026)

Reglas vigentes para el manual de marca. No se corrigieron aún los archivos del kit ni de la app que dicen otra cosa; eso va en otro Issue.

1. **Descriptor oficial:** «Mercancía y ropa americana», en ese orden. Sustituye a «Ropa americana y mercancía general» y a las demás variantes (inconsistencia 6).
2. **Lema: «Calidad americana, precio mexicano.»** (Isaac, 22/10/2026). «Marcas americanas, a precio de saldo» **no** es el lema de marca; sigue siendo el titular actual del sitio.
3. **Tuteo siempre**, también en el ticket impreso: «Gracias por tu compra» (inconsistencia 7).
4. **WhatsApp: 444 543 7754, único oficial.** El 444 854 5980 no es WhatsApp (inconsistencia 2).
5. **Dirección:** Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, S.L.P., C.P. 78430.
6. **Horario:** «11 a. m. a 8 p. m.», todos los días; en espacio corto, «de 11 a 8» (inconsistencia 3).
7. **Apartado en tienda:** 15 % del valor del producto, por 7 días (inconsistencia 4).
8. **Envío:** $100 de anticipo al apartar el primer producto, que se liquida antes de enviar. Envíos todos los viernes (corte el jueves a las 8 p. m.). Costo del envío: $99 en compras de menos de $1,000 y gratis desde $1,000.
9. **Portal Dolarones:** no nombra personas; dice «muéstralo en caja» en lugar de «Muestra este código a Isaac en la tienda» (inconsistencia 8).
10. **Marketplace y Mercado Libre:** el contacto dirige a WhatsApp, no a Messenger (inconsistencia 5).

Pendiente de corregir en archivos (otro Issue): `Textos-para-redes.txt`, `docs/MARKETING-30-DIAS.md`, `app/public/impresora.js`, `app/public/portal.html`, `app/public/marketplace.html` y los textos de la app que usen horario, teléfono, apartado o descriptor distintos.
