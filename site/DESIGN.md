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

## Piezas

- **Botones** (`.button`): borde azul de 2 px, sombra dura azul de 4 px que se levanta al pasar el cursor.
  Variantes: azul (acción principal), amarillo con filete punteado (`button-ticket`, WhatsApp), blanco.
- **Cintas** (`.tape`): tira amarilla o azul con giro leve y borde dentado, solo para el kicker y el subtítulo de la portada.
- **Portada**: titular «Marcas americanas, *a precio de saldo.*» y el collage `hallazgos.webp` (recortes reales sobre transparente).
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

Mínimo: el subtítulo de la portada cae al cargar, la marquesina corre y dos recuadros se asientan al entrar en
pantalla (`motion.js`, objetivos `data-motion`). Todo se apaga con `prefers-reduced-motion`.

## Reglas

- Celular primero: sin desplazamiento horizontal de la página de 320 a 1440 px.
- Contraste AA en todo texto; el rojo grande sobre papel o cartón debe dar 3:1 (usar `--red-text`).
- Orden de títulos: un `h1`, `h2` por sección, `h3` dentro de ellas (el nombre de cada cartel es `h3`).
- Nombres largos: se cortan con `overflow-wrap: anywhere` y, en carteles, a 3 líneas.
- No inventar precios, horarios ni promociones: solo datos ya publicados en el sitio o en las bases.
- Imágenes generadas solo a partir de fotos reales de la tienda; nada de bodegones ilustrativos.
- Las páginas internas (`que-es-un-saldo.html`, `politica-de-privacidad.html`) usan el mismo fondo blanco, tinta azul y sombra dura.
