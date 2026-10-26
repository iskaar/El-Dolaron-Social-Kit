# eldolaron.com — Dirección visual

Aprobada por Isaac (opción A, 6/10/2026) y reorientada el 15/10/2026 (Issue #339): fondo blanco y marcas
americanas a precio de saldo, no «oferta barata». Toda sección nueva o rediseñada sigue esta guía.

## Idea

Tienda de barrio con calidad americana: página blanca y limpia, tinta azul, botones y tarjetas con sombra
dura, y dos «objetos» de papel con carácter: los carteles «Se busca» y las etiquetas de cartón. Nada de
degradados, vidrio esmerilado ni tarjetas redondeadas genéricas. Tampoco ruido de periódico: el papel viejo
vive solo dentro de esos dos objetos.

## Color

| Token | Valor | Uso |
| --- | --- | --- |
| `--navy` | `#16366B` | Texto, bordes, sombras duras, botón principal |
| `--red` | `#D72B32` | Acentos, precios tachados, chips activos, ícono de ubicación |
| `--red-text` | `#B3141B` | Rojo para texto chico y para precios sobre papel o cartón (3:1 o más) |
| `--yellow` | `#FFD447` | Botón principal de acción, cintas, etiquetas, fondo de Dolarones |
| `--white` | `#FFFFFF` | Fondo de la página y de las tarjetas |
| `--mist` | `#F2F5FA` | Fondo del catálogo |

Fondo blanco; azul como tinta; amarillo y rojo como acentos. Los tonos de papel envejecido salen solo de
las imágenes `cartel-se-busca.webp` y `etiqueta-vacia.webp`. Sobre ellas, el rojo `--red` no llega a 3:1:
usar `--red-text`, o tinta `#2B2116` para texto.

## Tipografía (autohospedada en `assets/fonts/`, solo latin)

- **Fraunces** variable (`"SOFT" 100, "WONK" 1`, peso 800–900): titulares, nombres de pieza, cupones, pasos.
  Cursiva para la parte roja del titular y el «Vale por…». Usar `var(--display)` y `var(--display-axes)`.
- **Anton**: precios, sellos, marquesina, chips y categorías.
- **Archivo** (variable): texto corrido, etiquetas de sección y botones.
- **Rye**: únicamente el «Se busca» de los carteles. No usarla en ningún otro lado.
- Prohibido: Inter, Roboto, Arial como tipografía de diseño, Space Grotesk.

## Logo

Único logo vigente (Isaac, 7/10/2026): `assets/el-dolaron-logo.png` (horizontal, transparente con contorno
blanco), `assets/el-dolaron-logo-vertical.png` y el ícono «EL» (`assets/favicon.png`). Originales en `01-Logos/`.
El logo anterior (símbolo D con franjas) y la insignia circular están retirados.
Variantes de una tinta (negro, blanco, azul), tamaños mínimos, protección y usos incorrectos: ver el [manual de marca](../05-Guia-y-textos/Manual-de-marca.html).

## Piezas

- **Botones** (`.button`): borde azul de 2 px, sombra dura azul de 4 px que se levanta al pasar el cursor y se hunde al pulsar (`:active`, para táctil).
  Variantes: azul (acción principal), amarillo con filete punteado (`button-ticket`, WhatsApp), blanco.
- **Cintas** (`.tape`): tira amarilla o azul con giro leve y borde dentado, solo para el kicker y el subtítulo de la portada.
- **Portada**: titular «Marcas americanas, *a precio de saldo.*» y, al lado, una pila semanal de stickers: `assets/pila.webp`
  se genera con `tools/pila_stickers.py` (13 recortes reales del catálogo con borde troquelado blanco y sombra azul, cuadrada,
  sin huecos grandes; se regenera cada semana) y `pila.json` lista sus piezas. La pila es la imagen LCP y el respaldo sin
  JavaScript o sin API. Encima, `stickers.js` pone 5 stickers vivos en lugares fijos y girados (cajas en %, empalmadas entre sí y
  con la pila; la capa es absoluta, así que la portada no cambia de alto) con borde troquelado, sombra, dorso y aro holográfico horneados una vez en canvas (`troquelar()` en `stickers.js`, sin filtros SVG por cuadro; el aro sigue al puntero, no al dedo). Un toque abre
  el visor de la pieza; jalar una esquina la despega con un dorso doblado, soltar antes la regresa con rebote y despegarla del
  todo la manda volando y trae la siguiente del rollo (12 piezas con recorte o 6 páginas del catálogo, sin las de la pila) al
  mismo lugar. Con `prefers-reduced-motion` los stickers son planos (el toque sigue abriendo el visor). Puerta de rendimiento:
  probar en iPhone Safari (`clip-path` animado y canvas) antes de sumar más stickers.
- **Carteles «Se busca»** (`.poster`, sección «Los más buscados»): papel generado (`cartel-se-busca.webp`), nombre arriba,
  foto cuadrada que abre el visor, precio en Anton rojo, «Ahorras $X», sello «¡Última pieza!» cuando el servidor lo manda
  y «Apartar por WhatsApp». Aparece solo con 3 o más; con 3 a 5 las filas quedan centradas. En celular es una fila
  deslizable con el siguiente cartel asomando. El foco de teclado sobre el cartel es azul.
- **Tarjetas de catálogo** (`.piece`): rectas, borde azul y sombra dura; foto 4:5, precio en Anton, precio de lista tachado.
- Las fotos con recorte transparente se contienen sobre fondo claro en catálogo y se imprimen sin marco sobre el papel de los carteles.
- **Etiquetas de cartón** (`.tag`, sección de ropa): imagen en blanco (`etiqueta-vacia.webp`) y el precio como texto rojo,
  así sirve para cualquier monto. Solo precios confirmados.
- **Cupones** (`.group-card`): talón perforado, bordes dentados con `mask` y doble filete, sobre fondo azul.
- **Marquesina** (`.ticker`): cinta azul que corre sobre una cinta de advertencia; botón de pausa y se detiene con movimiento reducido.

## Movimiento

Sin librerías: CSS y un poco de JS. Una sola animación por gesto, la interfaz nunca pasa de 300 ms y no hay bucles nuevos
(solo la marquesina, con botón de pausa).

- **Entre páginas**: transiciones de documento (`@view-transition`). La cabecera (`masthead`) y el logo de la cabecera
  persisten y el resto hace crossfade de 200 ms; el logo del pie no lleva nombre. Firefox navega normal.
- **Tarjeta → visor**: la foto de la miniatura o del cartel se transforma en la del visor (300 ms, `pieza-foto`), y vuelve al
  cerrar, también con Esc o tocando el fondo. Sin View Transitions el visor abre de golpe.
- **Chips**: el chip activo se desliza al nuevo (`chip-activo`, 200 ms).
- **Tarjetas**: las nuevas se asientan en 320 ms, escalonadas 35 ms donde existe `sibling-index()`.
- **Revelado**: los recuadros `data-motion` se asientan con una línea de tiempo de scroll (`animation-timeline: view()`) y
  vuelven si se sube; sin ella, `motion.js` los asienta una sola vez al entrar. No se aplica dentro de `.wanted-grid`
  (scroller horizontal en celular).
- El subtítulo de la portada cae al cargar y la marquesina corre.
- Todo se apaga con `prefers-reduced-motion`, incluidos los pseudoelementos `::view-transition-*`.

## Reglas

- Inclinaciones solo en objetos pegados: sellos, cintas, etiquetas y cupones (`--tilt-s/m/l`: 1°, 2°, 3°). Los párrafos y las
  tarjetas con texto corrido van rectos. Las sombras son duras y azules (`4px 4px 0 var(--navy)`); las suaves con desenfoque
  solo en carteles y etiquetas.
- Ritmo vertical: cada sección usa `--section` (o `--section-s` arriba del catálogo); no se inventan paddings por sección.
- Jerarquía: el `h1` manda; los `h2` quedan un paso abajo (`clamp(36px, 4.6vw, 68px)`).
- Celular: barra fija abajo con WhatsApp y Catálogo (`.sticky-bar`, solo ≤ 760 px; se oculta con el visor abierto); el collage
  va después del titular, chico; «Cómo llegar» es enlace de texto bajo el sello.
- Logo en cabecera y pie: `assets/el-dolaron-logo.webp` (600 px); el PNG se conserva para JSON-LD y vistas previas.

- Celular primero: sin desplazamiento horizontal de la página de 320 a 1440 px.
- Contraste AA en todo texto; el rojo grande sobre papel o cartón debe dar 3:1 (usar `--red-text`).
- Orden de títulos: un `h1`, `h2` por sección, `h3` dentro de ellas (el nombre de cada cartel es `h3`).
- Nombres largos: se cortan con `overflow-wrap: anywhere` y, en carteles, a 3 líneas.
- No inventar precios, horarios ni promociones: solo datos ya publicados en el sitio o en las bases.
- Imágenes generadas solo a partir de fotos reales de la tienda; nada de bodegones ilustrativos.
- Las páginas internas (`que-es-un-saldo.html`, `politica-de-privacidad.html`) usan el mismo fondo blanco, tinta azul y sombra dura.
