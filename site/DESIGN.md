# eldolaron.com — Dirección visual «El catálogo»

Rediseño del Issue #630 (30/10/2026). Sustituye a la dirección tabloide de los Issues #218 y #339 (stickers, cintas,
carteles «Se busca», cupones, marquesina y etiquetas de cartón), que leía como «oferta barata». La meta de marca sigue
siendo la misma: marcas americanas a precio de saldo. Toda sección nueva o rediseñada sigue esta guía.

## Idea

Catálogo impreso de tienda departamental (Sears Wish Book, inserto semanal) en una cuadrícula moderna. **Producto y precio
son el diseño; todo lo demás es tinta azul callada sobre papel blanco.** Lo memorable son los precios, grandes. Un solo gesto
por sección. Cero utilería, cero inclinaciones, cero texturas, cero degradados, cero sombras.

## Color

| Token | Valor | Uso |
| --- | --- | --- |
| `--ink` | `#16366B` | Texto, reglas de sección, botón principal, foco |
| `--paper` | `#FFFFFF` | Fondo de la página y de las tarjetas |
| `--price` | `#D72B32` | SOLO precios y la marca «Última pieza» (4.9:1 sobre blanco, 4.5:1 sobre `--mist`) |
| `--price-text` | `#B3141B` | Rojo para letra chica (6.9:1 sobre blanco) |
| `--sun` | `#FFD447` | SOLO el logo, la franja Dolarones y el botón «Mis Dolarones» de la cabecera |
| `--slate` | `#5A6A86` | Texto secundario, códigos `ED-…`, precio de lista tachado (5.5:1 sobre blanco, 5:1 sobre `--mist`) |
| `--mist` | `#F2F5FA` | Marcos de foto y fondo del catálogo |
| `--wa` / `--wa-ink` | `#25D366` / `#0A3B26` | Botones que abren WhatsApp (6.4:1) |
| `--hair` | azul al 16 % | Filete fino entre datos (horario, pagos) |

El rojo nunca decora: si no es un precio o «Última pieza», no es rojo. El amarillo no aparece fuera de sus tres usos.

## Tipografía (autohospedada en `assets/fonts/`, solo latin)

Dos familias, nada más (`var(--display)` y Archivo):

- **Big Shoulders Display** variable (400–900), licencia SIL Open Font License 1.1 (OFL). Cartelería americana condensada:
  `h1` (800, `clamp(52px, 7vw, 112px)`, interlineado .92), `h2` (700, `clamp(36px, 4.6vw, 64px)`), `h3`, precios (800),
  navegación (700, 24 px), pestañas (600, 18 px) y botones (700, 19 px).
- **Archivo** variable: texto corrido (17 px / 1.6, máximo 70 caracteres por línea), formularios, nombres de pieza y etiquetas.
- Nada en mayúsculas sostenidas salvo siglas. Sin cursivas en titulares. Sin etiquetas chicas encima de los títulos.
- Las tres tipografías display anteriores se retiraron del sitio en el Issue #630: `styles.css` no las declara ni se precargan. Sus woff2
  siguen en `assets/fonts/` solo porque `05-Guia-y-textos/Manual-de-marca.html` las carga; se borran cuando el manual migre.
  La app de caja conserva sus propias fuentes en `app/public/fuentes/`.

## Logo

Único logo vigente (Isaac, 7/10/2026): `assets/el-dolaron-logo.png` (horizontal, transparente con contorno blanco),
`assets/el-dolaron-logo-vertical.png` y el ícono «EL» (`assets/favicon.png`). Originales en `01-Logos/`. Sin sombras ni giros.
Variantes de una tinta, tamaños mínimos, protección y usos incorrectos: ver el [manual de marca](../05-Guia-y-textos/Manual-de-marca.html).

## Piezas

- **Regla de catálogo** (`.section-head`): cada sección abre con una regla de 3 px en tinta, el `h2` y una línea de entrada en
  `--slate` (a la derecha en escritorio). Sin «Sección X ·» ni flechas.
- **Cabecera**: logo, navegación en Big Shoulders 700 a 24 px (Catálogo, Ropa, Visítanos) y «Mis Dolarones» en `--sun`. Borde inferior de 3 px.
- **Botones** (`.button`): planos, rectos, 48 px de alto. `button-ink` (relleno azul), `button-outline` (borde azul de 2 px),
  `button-whatsapp` (verde con el logo). Al pasar el cursor oscurecen 8 % con `color-mix`; al pulsar bajan 1 px.
- **Portada** (`.hero`): titular, párrafo, línea de existencias real («2,108 piezas en tienda hoy», del `total` de la primera
  consulta sin filtros; sin API no aparece), «Ver catálogo» y «WhatsApp», horario y «Cómo llegar» como texto. La columna
  derecha es la más ancha (`1fr 1.25fr`, ~668 px a 1440). A la derecha, una
  **página de catálogo viva** (`.hero-catalog`): 6 recortes de `/api/catalogo?recorte=1` (`variadas()` en `catalogo.js`: sin
  repetir marca ni tipo de pieza) en 3×2 con su precio. La imagen del HTML es `assets/pila.webp`, que `tools/pila_stickers.py`
  genera cada semana con **la misma geometría** (lienzo cuadrado, 3×2, separación del 2 %, celdas de 384×588 en `--mist`,
  recorte contenido con 8 % de margen y precio abajo): es el LCP y el respaldo sin JS o sin API, y se cambia por la viva
  cuando sus 6 fotos cargaron, sin salto de layout. El nombre va solo en el `aria-label`; un toque abre el visor.
- **Los más buscados** (`.wanted-item`): marco 4:5 en `--mist` (recorte contenido o foto cubriendo), nombre `h3` a 2 líneas,
  precio enorme en `--price`, precio de lista tachado y «Ahorras $X», marca de texto «Última pieza» con borde rojo de 2 px sobre
  la esquina de la foto (la decide el servidor) y «Apartar por WhatsApp». Mínimo 3; en celular es una fila deslizable.
- **Tarjetas de catálogo** (`.piece`): blancas, sin borde ni sombra, sobre el fondo `--mist`; marco 4:5 en `--mist`, nombre a
  2 líneas, marca y talla, precio Big Shoulders 800 en rojo, precio de lista tachado chico y código `ED-…` en `--slate`. Sin
  botón propio: toda la tarjeta abre el visor, que trae «Preguntar por WhatsApp».
- **Pestañas de categoría** (`.chip`): texto en Big Shoulders 600, sin fondo; la activa en tinta con raya de 3 px. Una sola fila
  que se desliza si no cabe.
- **Ropa** (`.price-ladder`): escalera tipográfica $50 · $80 · $100 · $150 · $200 en numerales de hasta 128 px. Solo precios confirmados.
- **Grupos**: fondo `--ink`, dos tarjetas blancas planas con `h3`, una línea y «Unirme por WhatsApp».
- **Dolarones**: franja `--sun`, logo vertical, cifras 10 / 5 / 50 en Big Shoulders 800 sobre un filete fino, nota legal.
- **Cómo comprar**: `<ol>` con números en Big Shoulders 700 `--slate` (es la única secuencia numerada).
- **Visítanos**: dirección y horario en Big Shoulders 700, datos con filetes finos y «Cómo llegar» azul.

## Movimiento

Sin librerías. Un solo momento de carga y transiciones de navegación; nada se mueve al hacer scroll.

- **Carga**: las 6 celdas de la portada se asientan (opacidad y 8 px) escalonadas 40 ms.
- **Entre páginas**: `@view-transition`; la cabecera (`masthead`) y el logo persisten y el resto hace crossfade de 200 ms.
- **Tarjeta → visor**: la foto se transforma en la del visor (300 ms, `pieza-foto`) y vuelve al cerrar (también con Esc o el fondo).
- **Pestañas**: la raya activa se desliza a la nueva (`chip-activo`, 200 ms).
- Todo queda estático con `prefers-reduced-motion`, incluidos los pseudoelementos `::view-transition-*`.

## Reglas

- Nada inclinado, sin sombras, sin texturas, sin degradados. Si un elemento necesita separarse, usa espacio o un filete.
- Ritmo vertical: cada sección usa `--section` (o `--section-s` en las uniones entre secciones blancas); no se inventan paddings.
- Jerarquía: el `h1` manda; los `h2` quedan un paso abajo; un `h1`, `h2` por sección y `h3` dentro.
- Celular primero: sin desplazamiento horizontal de 320 a 1440 px; barra fija con WhatsApp y Catálogo (`.sticky-bar`, ≤ 760 px,
  se oculta con el visor abierto).
- Contraste AA en todo texto; foco visible de 3 px en tinta (blanco sobre el fondo azul de Grupos).
- Nombres largos: `overflow-wrap: anywhere` y corte a 2 líneas.
- No inventar precios, horarios ni promociones: solo datos ya publicados en el sitio o en las bases.
- Fotos solo de piezas reales de la tienda; nada de bodegones ilustrativos.
- Las páginas internas (`que-es-un-saldo.html`, `politica-de-privacidad.html`) usan la misma tinta, tipografía, reglas y botones.
