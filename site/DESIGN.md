# eldolaron.com — Dirección visual

Aprobada por Isaac (opción A, 6/10/2026) y reorientada el 15/10/2026 (Issue #339): fondo blanco y marcas
americanas a precio de saldo, no «oferta barata». Toda sección nueva o rediseñada sigue esta guía.

## Idea

Tienda de barrio con calidad americana: página blanca y limpia, tinta azul, botones y tarjetas con sombra
dura. Nada de degradados, vidrio esmerilado ni tarjetas redondeadas genéricas, y nada de utilería de papel
(cintas, carteles, cupones, marquesina, etiquetas de cartón; retiradas por Isaac el 30/10/2026, Issue #630).
El carácter lo dan la tipografía, los precios grandes, los sellos y la pila de stickers.

## Color

| Token | Valor | Uso |
| --- | --- | --- |
| `--navy` | `#16366B` | Texto, bordes, sombras duras, botón principal |
| `--red` | `#D72B32` | Acentos, precios tachados, chips activos, ícono de ubicación |
| `--red-text` | `#B3141B` | Rojo para texto chico, precios tachados y sellos |
| `--yellow` | `#FFD447` | Botón principal de acción, sombra dura de las tarjetas sobre azul, fondo de Dolarones |
| `--white` | `#FFFFFF` | Fondo de la página y de las tarjetas |
| `--mist` | `#F2F5FA` | Fondo del catálogo |

Fondo blanco; azul como tinta; amarillo y rojo como acentos. Sin tonos de papel envejecido en el sitio.

## Tipografía (autohospedada en `assets/fonts/`, solo latin)

- **Fraunces** variable (`"SOFT" 100, "WONK" 1`, peso 700–900): titulares, subtítulo de la portada, nombres de pieza, grupos, pasos.
  Cursiva para la parte roja del titular. Usar `var(--display)` y `var(--display-axes)`.
- **Anton**: precios (incluida la escalera de Ropa), sellos, chips y categorías.
- **Archivo** (variable): texto corrido, kicker de la portada, etiquetas de sección y botones.
- **Rye**: ya no se usa en el sitio (Issue #630). `rye-400.woff2` sigue en `assets/fonts/` solo para el manual de marca y `site/compartir-fuente.html`.
- Prohibido: Inter, Roboto, Arial como tipografía de diseño, Space Grotesk.

## Logo

Único logo vigente (Isaac, 7/10/2026): `assets/el-dolaron-logo.png` (horizontal, transparente con contorno
blanco), `assets/el-dolaron-logo-vertical.png` y el ícono «EL» (`assets/favicon.png`). Originales en `01-Logos/`.
El logo anterior (símbolo D con franjas) y la insignia circular están retirados.
Variantes de una tinta (negro, blanco, azul), tamaños mínimos, protección y usos incorrectos: ver el [manual de marca](../05-Guia-y-textos/Manual-de-marca.html).

## Piezas

- **Botones** (`.button`): borde azul de 2 px, sombra dura azul de 4 px que se levanta al pasar el cursor y se hunde al pulsar (`:active`, para táctil).
  Variantes: azul (acción principal), amarillo con filete punteado (`button-ticket`, WhatsApp), blanco.
- **Portada**: kicker «Calidad americana, precio mexicano.» en Archivo 700 azul, titular «Marcas americanas, *a precio de saldo.*»,
  subtítulo «Mercancía y ropa americana» en Fraunces 700 azul (ambos texto plano, rectos, sin fondo) y, al lado, una pila semanal de stickers: `assets/pila.webp`
  se genera con `tools/pila_stickers.py` (13 recortes reales del catálogo con borde troquelado blanco y sombra azul, cuadrada,
  sin huecos grandes; se regenera cada semana) y `pila.json` lista sus piezas. La pila es la imagen LCP y el respaldo sin
  JavaScript o sin API. Encima, `stickers.js` pone 5 stickers vivos en lugares fijos y girados (cajas en %, empalmadas entre sí y
  con la pila; la capa es absoluta, así que la portada no cambia de alto) con borde troquelado, sombra, dorso y aro holográfico horneados una vez en canvas (`troquelar()` en `stickers.js`, sin filtros SVG por cuadro; el aro sigue al puntero, no al dedo). Un toque abre
  el visor de la pieza; jalar una esquina la despega con un dorso doblado, soltar antes la regresa con rebote y despegarla del
  todo la manda volando y trae la siguiente del rollo (12 piezas con recorte o 6 páginas del catálogo, sin las de la pila) al
  mismo lugar. Con `prefers-reduced-motion` los stickers son planos (el toque sigue abriendo el visor). Puerta de rendimiento:
  probar en iPhone Safari (`clip-path` animado y canvas) antes de sumar más stickers.
- **Los más buscados** (`.wanted-item`): tarjeta como `.piece` pero más grande: blanca, borde azul de 2 px, sombra dura;
  foto 4:5 sobre `--mist` que abre el visor, marca o categoría, nombre en Fraunces 800 (2 líneas, mismo alto en todas),
  precio en Anton `--red` (`clamp(36px, 4vw, 56px)`), precio de lista tachado y «Ahorras $X», sello rojo inclinado
  «¡Última pieza!» sobre la foto cuando el servidor lo manda y «Apartar por WhatsApp». Aparece solo con 3 o más; tres por
  fila (dos de 761 a 1000 px) y las filas incompletas quedan centradas. En celular es una fila deslizable con la siguiente asomando.
- **Tarjetas de catálogo** (`.piece`): rectas, borde azul y sombra dura; foto 4:5, precio en Anton, precio de lista tachado.
- Las fotos con recorte transparente se contienen sobre fondo claro (`con-recorte`) en catálogo y en «Los más buscados».
- **Escalera de precios** (`.price-ladder`, sección de ropa): «$50 $80 $100 $150 $200» en Anton `--red`
  (`clamp(56px, 9vw, 128px)`), cada uno con «por prenda» («y mucho más» en el último) en Archivo 14 px; fila con `flex-wrap`.
  Solo precios confirmados.
- **Tarjetas de grupo** (`.group-card`): blancas, borde azul de 2 px y sombra dura amarilla (la azul se pierde sobre el fondo),
  nombre en Fraunces 800, una línea y «Unirme por WhatsApp». El fondo azul de Grupos conserva su textura de puntos.

## Movimiento

Sin librerías: CSS y un poco de JS. Una sola animación por gesto, la interfaz nunca pasa de 300 ms y no hay bucles.

- **Entre páginas**: transiciones de documento (`@view-transition`). La cabecera (`masthead`) y el logo de la cabecera
  persisten y el resto hace crossfade de 200 ms; el logo del pie no lleva nombre. Firefox navega normal.
- **Tarjeta → visor**: la foto de la miniatura (catálogo o «Los más buscados») se transforma en la del visor (300 ms, `pieza-foto`), y vuelve al
  cerrar, también con Esc o tocando el fondo. Sin View Transitions el visor abre de golpe.
- **Chips**: el chip activo se desliza al nuevo (`chip-activo`, 200 ms).
- **Tarjetas**: las nuevas se asientan en 320 ms, escalonadas 35 ms donde existe `sibling-index()`.
- **Revelado**: los recuadros `data-motion` se asientan con una línea de tiempo de scroll (`animation-timeline: view()`) y
  vuelven si se sube; sin ella, `motion.js` los asienta una sola vez al entrar. No se aplica dentro de `.wanted-grid`
  (scroller horizontal en celular).
- Todo se apaga con `prefers-reduced-motion`, incluidos los pseudoelementos `::view-transition-*`.

## Reglas

- Inclinaciones solo en sellos (horario de la portada con `--tilt-l`, «¡Última pieza!») y en la pila de stickers. Los párrafos
  y las tarjetas van rectos. Las sombras son duras y azules (`4px 4px 0 var(--navy)`; amarillas sobre el fondo azul de Grupos);
  las suaves con desenfoque solo en recortes y stickers.
- Ritmo vertical: cada sección usa `--section` (o `--section-s` arriba del catálogo); no se inventan paddings por sección.
- Jerarquía: el `h1` manda; los `h2` quedan un paso abajo (`clamp(36px, 4.6vw, 68px)`).
- Celular: barra fija abajo con WhatsApp y Catálogo (`.sticky-bar`, solo ≤ 760 px; se oculta con el visor abierto); el collage
  va después del titular, chico; «Cómo llegar» es enlace de texto bajo el sello.
- Logo en cabecera y pie: `assets/el-dolaron-logo.webp` (600 px); el PNG se conserva para JSON-LD y vistas previas.

- Celular primero: sin desplazamiento horizontal de la página de 320 a 1440 px.
- Contraste AA en todo texto; el rojo chico va en `--red-text`.
- Orden de títulos: un `h1`, `h2` por sección, `h3` dentro de ellas (el nombre de cada pieza y de cada grupo es `h3`).
- Nombres largos: se cortan con `overflow-wrap: anywhere` y, en «Los más buscados», a 2 líneas.
- No inventar precios, horarios ni promociones: solo datos ya publicados en el sitio o en las bases.
- Imágenes generadas solo a partir de fotos reales de la tienda; nada de bodegones ilustrativos.
- Las páginas internas (`que-es-un-saldo.html`, `politica-de-privacidad.html`) usan el mismo fondo blanco, tinta azul y sombra dura.
