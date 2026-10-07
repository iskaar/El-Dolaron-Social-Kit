# eldolaron.com — Dirección visual «Tabloide de ofertas»

Aprobada por Isaac el 6/10/2026 (opción A). Toda sección nueva o rediseñada del sitio sigue esta guía.
Referencia: el collage de la campaña «Ya abrimos» y `assets/el-dolaron-compartir.jpg`.

## Idea

El sitio es la página de ofertas de un periódico de barrio, hecha a mano: papel de periódico, letras
recortadas, cinta, etiquetas de precio y productos reales recortados. Ruidoso pero con orden de
lectura claro. Nunca «startup»: nada de degradados, vidrio esmerilado ni tarjetas redondeadas genéricas.

## Color (solo la marca)

| Token | Valor | Uso |
| --- | --- | --- |
| `--paper` | `#EDE6D3` | Fondo de papel periódico (con textura de columnas) |
| `--ink` / `--navy` | `#16366B` | Texto, cintas oscuras, sellos |
| `--red` | `#D72B32` | Acentos, sellos, precios tachados, «¡nuevo!» |
| `--yellow` | `#FFD447` | Etiquetas de precio, tiras de papel, botón principal |
| `--white` | `#FFFFFF` | Recortes de papel y bordes de sticker |

Dominante papel + tinta azul; rojo y amarillo como acentos fuertes, nunca repartidos por igual.

## Tipografía (autohospedada en `assets/fonts/`, solo latin) — combinación C, elegida por Isaac el 6/10

- **Fraunces** variable (`"SOFT" 100, "WONK" 1`, peso 800–900, en altas y bajas): titulares, cintas, nombres de cupón,
  pasos y dirección. Cursiva solo para el «Vale por…» de los cupones. Usar `var(--display)` y `var(--display-axes)`.
- **Anton**: precios, sellos, marquesina, categorías y botones de sello (lo que en un tabloide va estampado).
- **Archivo** (variable 400–800): texto corrido, etiquetas de sección y botones.
- **Abril Fatface**, **Alfa Slab One**, Anton y Archivo 900: solo en las letras recortadas del título.
- Prohibido: Inter, Roboto, Arial como tipografía de diseño, Space Grotesk.

## Recursos

- Papel: CSS (`.paper`) con líneas finas horizontales y medianiles de columna; sin imágenes.
- Letras recortadas: cada letra es un `span` con fuente, color, giro y borde rasgado (`clip-path`) distintos.
  El texto real va en un `.sr-only`; las letras decorativas llevan `aria-hidden`.
- Cinta (`.tape`): tira de color con giro leve y bordes dentados.
- Etiqueta de precio (`.price-tag`): amarilla, con perforación y giro. Solo precios confirmados.
- Productos: fotos reales recortadas sobre blanco, mostradas con `mix-blend-mode: multiply` sobre el papel
  (nunca dentro de un elemento girado: el giro aísla la mezcla y aparece el fondo blanco).
- Etiquetas vintage (`assets/etiqueta-*.webp`): solo el precio, generadas a partir de una misma referencia.
- Cupones (`.group-card`): talón perforado, bordes dentados con `mask`, doble filete y sello de acción.
- Marquesina (`.ticker`): cinta azul que corre sobre una cinta de advertencia cruzada; se detiene con movimiento reducido.

## Movimiento

Una sola coreografía por pantalla: las letras del título «caen» y se asientan en cascada al cargar.
Todo con CSS, desactivado con `prefers-reduced-motion`.

## Reglas

- Celular primero: probar a 375 px y 1280 px sin desplazamiento horizontal.
- Contraste AA en todo texto; nada de texto sobre la foto de productos.
- No inventar precios, horarios ni promociones: solo datos ya publicados en el sitio o en las bases.
- Imágenes generadas solo a partir de fotos reales de la tienda; nada de bodegones ilustrativos.
