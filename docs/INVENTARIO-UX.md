# Guía UI/UX · `/inventario` (Issue #446)

Para quien implementa (Codex): esta guía es prescriptiva. Si algo no está aquí y cambia lo que se ve o cómo se toca, pregunta en el Issue antes de inventarlo. Sin dependencias nuevas, sin fuentes web, sin librerías de iconos. Un solo `inventario.css` con los tokens de la sección 2 y un solo sprite SVG inline. Todo texto de pieza entra con `textContent`.

Base leída (origin/main): `escanear.html`, `captura.html`, `admin.html`, `etiquetas.html`, `bandas.html`, `pieza.html/.js`, `camara-remota.html`, `caja.html`, `index.html`; rama 441: `ficha.js`; marca: `Paleta.json`, `site/DESIGN.md`, `VOZ.md`. Decisión vigente de Isaac (22/10 15:25): una sola pantalla que combina /admin (cola), /escanear, /etiquetas, /bandas y /captura; Ropa se funde con el flujo de /escanear.

---

## 0. Resumen de decisiones

| Tema | Decisión |
| --- | --- |
| Navegación celular | **Barra inferior** de 4 modos (64 px). Los modos no se tapan con el dedo ni con el visor; el pulgar llega. |
| Navegación PC (≥ 1000 px) | **Pestañas en la cabecera** (segmentado) con pista `Alt+1…4`. |
| Lenguaje visual | Papel de tienda de barrio: fondo niebla, bordes de 2 px azul, **sombra dura desplazada**, esquinas de 2 px, amarillo para la acción principal. Nada de tarjetas de 12 px de radio con sombra difusa. |
| Capturar | **Un solo flujo**: la cámara (celular) o la caja (PC) están siempre listas. Código → pieza/+1/etiqueta. Sin código → foto → (Ropa: prenda, marca, talla y precio en el mismo tablero) → subida/análisis. No hay «modo Ropa» aparte: es un interruptor pegajoso `Mercancía | Ropa` junto al disparo. |
| Impresora y celular | **Servicios** con chips fijos en la cabecera, no modos. |
| Lector | Un solo receptor global (`lector.js`). **El Enter del lector nunca activa un botón.** |
| Tipografía | `system-ui` (sin descargas con mala red). Precios y cantidades en 800 con `tabular-nums`; códigos en `ui-monospace`. |
| Aviso | Una sola **línea de estado** bajo la cabecera (`aria-live`), color + glifo + texto + sonido/vibración opcionales. Nada de toasts que desaparecen. |

---

## 1. Principios (6)

1. **El lector manda.** Cualquier lectura (USB, Bluetooth, cámara) llega al mismo evento sin importar dónde esté el foco. Ningún botón, campo ni modo la estorba.
2. **Una acción principal por estado.** Un solo botón amarillo con sombra por vista; lo demás es secundario o texto. Si hay dos candidatos, el estado está mal diseñado.
3. **Nunca perder trabajo.** Foto y datos se guardan localmente antes de la red; lo pendiente se ve siempre («3 sin subir»); lo destructivo pide confirmar en dos toques y dice cuánto borra; ningún error vacía lo que la persona ya capturó.
4. **De reojo y con guantes.** Todo estado se entiende a un brazo de distancia, con sol y con una mano: color **y** forma **y** texto **y** sonido (opcional). Objetivos grandes, sin precisión de puntero.
5. **Decir qué pasó y qué sigue, en pocas palabras.** Microcopy de 2–6 palabras, voz tuteada de `VOZ.md`, sin párrafos de ayuda. Si necesita un párrafo, el estado está mal.
6. **Servicios, no pantallas.** Impresora, cámara del celular y cola de red viven en la cabecera y funcionan igual en cualquier modo. El servidor decide qué puede hacer cada rol; la pantalla **oculta** lo que no existe para esa cuenta (no lo deja gris sin razón).

---

## 2. Tokens de diseño

### 2.1 Color (hex exactos de `Paleta.json` / `DESIGN.md`; extras marcados)

```css
:root {
  --azul:#16366B;          /* marca: texto, bordes, sombras duras */
  --rojo:#D72B32;          /* marca: relleno de peligro/alerta (NUNCA texto sobre niebla ni sobre azul) */
  --rojo-texto:#B3141B;    /* marca: texto rojo, bordes de error, filetes */
  --amarillo:#FFD447;      /* marca: acción principal, foco sobre azul, etiqueta/impresión */
  --blanco:#FFFFFF;        /* tarjetas, campos */
  --niebla:#F2F5FA;        /* marca: fondo de página */
  /* extras de la app (ya existen en caja/escáner o derivan de la marca) */
  --tinta:#1A1F2B;         /* texto sobre amarillo y avisos */
  --gris:#5B6478;          /* texto secundario */
  --verde:#1F7A4D;         /* éxito (ya usado en caja) */
  --azul-hondo:#0E2549;    /* fondo de chips sobre la cabecera azul */
  --verde-claro:#7BE0A6;   /* SOLO glifo de éxito sobre azul/azul-hondo */
  --fondo-ok:#E4F3EA; --fondo-error:#FDECEC; --fondo-aviso:#FFF6D9; --aviso-texto:#6B5400;
  --deshab-fondo:#E9EDF4; --deshab-borde:#B8C0CF;
  --camara:#0B1220;        /* fondo de visor y hoja sobre cámara (ya usado en camara-remota) */
  --linea:#DFE3EA;         /* SOLO separadores decorativos (1.29:1: no sirve de borde de control) */
}
```

Pares permitidos (contraste calculado WCAG; AA texto normal ≥ 4.5, texto grande/elementos ≥ 3):

| Texto / elemento | Fondo | Razón | Uso |
| --- | --- | --- | --- |
| `--azul` | `--blanco` | 11.84 | texto base, bordes |
| `--azul` | `--niebla` | 10.83 | texto sobre página |
| `--azul` | `--amarillo` | 8.32 | botón principal |
| `--tinta` | `--amarillo` | 11.58 | línea de aviso, etiqueta |
| `--blanco` | `--azul` | 11.84 | cabecera, pestaña activa, chip elegido |
| `--blanco` | `--rojo` | 4.91 | botón peligro confirmado (≥ 16 px/700) |
| `--blanco` | `--rojo-texto` | 6.92 | alerta fuerte |
| `--rojo-texto` | `--blanco` / `--niebla` / `--fondo-error` | 6.92 / 6.34 / 6.06 | texto de error |
| `--gris` | `--blanco` / `--niebla` | 5.93 / 5.43 | texto secundario |
| `--verde` | `--blanco` | 5.32 | texto/ícono de éxito |
| `--azul` | `--fondo-ok` | 10.32 | línea de éxito (texto azul, glifo verde) |
| `--aviso-texto` | `--fondo-aviso` | 6.72 | aviso suave |
| `--amarillo` / `--blanco` / `--verde-claro` | `--azul-hondo` | 10.7 / 15.2 / 9.46 | chips y glifos en cabecera |
| `--gris` | `--deshab-fondo` | 5.05 | deshabilitado |
| `--amarillo` | `--camara` | 13.16 | foco y chips sobre cámara |

**Prohibido:** `--rojo` como texto sobre niebla (4.49) o azul (2.41); amarillo como texto sobre blanco (1.4); blanco sobre amarillo; texto gris sobre cámara; bordes de campo con `#9AA4B6` (2.51, el de `pieza.html`). Todo control tiene borde de 2 px `--azul` (≥ 3:1).

**El color nunca va solo:** éxito ✓ verde, aviso ▲ amarillo, error ■ rojo (glifos distintos), más texto.

### 2.2 Tipografía (`font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`)

| Token | px (celular / PC) | Peso | Uso |
| --- | --- | --- | --- |
| `--t-chico` | 12 / 12 | 700 | insignias, `kbd`, rótulo de pestaña celular (13 si cabe) |
| `--t-sec` | 14 / 14 | 600 | texto secundario, metadatos, filas de historial |
| `--t-base` | 16 / 16 | 400–600 | cuerpo, campos (nunca < 16 en `input`: evita zoom en iOS) |
| `--t-boton` | 18 / 16 | 800 | etiqueta de botón principal; 16/700 en secundarios |
| `--t-linea` | 18 / 18 | 700 | línea de estado |
| `--t-titulo` | 22 / 24 | 800 | nombre de pieza en tarjeta/ficha |
| `--t-precio` | 28 / 32 | 800 | precio, número de existencia (`tabular-nums`) |
| `--t-cantidad` | 36 / 40 | 800 | número del stepper |
| código | 16–20 | 600 | `ui-monospace, Consolas, monospace`, `letter-spacing:.02em` |

Interlineado 1.3; títulos 1.15. Nombres largos: `overflow-wrap:anywhere`, 2 líneas en listas (`line-clamp:2`), completos en ficha. Los precios de marca en Anton/Fraunces **no** entran a la app (no se copian fuentes al Worker).

### 2.3 Espaciado, radios, bordes, capas

- Escala: `4 · 8 · 12 · 16 · 24 · 32 · 48`. Gutter: 16 px celular, 24 px PC. **Entre elementos con sombra dura: ≥ 12 px** (para que el anillo de foco quepa).
- Radios: `2px` en botones, campos, chips, tarjetas, hojas; `50%` solo en disparo y puntos de estado. Nada de 8/10/12.
- Borde de todo control y tarjeta: `2px solid var(--azul)`. Separadores decorativos de lista: `1px solid var(--linea)`.
- Capas (z): contenido 0 · barras fijas 10 · hoja 20 · diálogo 30 · «Empezar» 40.
- `padding-bottom` del área desplazable ≥ altura de la barra inferior + `env(safe-area-inset-bottom)`.
- Viewport: `width=device-width, initial-scale=1, viewport-fit=cover`. **Sin** `maximum-scale` ni `user-scalable=no` (lo tiene `captura.html`); usar `touch-action: manipulation` para evitar el doble toque.

### 2.4 Botón con sombra desplazada

Todos: borde 2 px, radio 2 px, `font-weight` 700–800, transición `translate/box-shadow 80ms ease-out` (0 con `prefers-reduced-motion`), `cursor:pointer`, `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation`.

| Variante | Fondo | Texto | Borde | Sombra | Altura mín. celular / PC |
| --- | --- | --- | --- | --- | --- |
| **Principal** | `--amarillo` | `--azul` | `--azul` | `4px 4px 0 --azul` | **56 / 48** |
| **Secundario** | `--blanco` | `--azul` | `--azul` | `3px 3px 0 --azul` | **48 / 44** |
| **Peligro** (reposo) | `--blanco` | `--rojo-texto` | `--rojo-texto` | `3px 3px 0 --rojo-texto` | 48 / 44 |
| **Peligro** (confirmando) | `--rojo` | `--blanco` | `--rojo-texto` | `3px 3px 0 --rojo-texto` | 48 / 44 |
| **Texto** (terciario) | transparente | `--azul`, subrayado 2 px | ninguno | ninguna | 48 / 44 (zona táctil, no se ve) |
| **Elegido** (chip/segmento `aria-pressed|checked|selected`) | `--azul` | `--blanco` | `--azul` | `2px 2px 0 --amarillo` | 48 / 40 |

Estados (aplican a todas las variantes con sombra):

- **Hover (solo `@media (hover:hover)`)**: `translate(-1px,-1px)` y sombra +1 px. Nunca es la única señal de nada.
- **Presionado `:active`**: `translate(var(--sombra), var(--sombra))` y `box-shadow:none` (el botón «se hunde» hasta el papel). Celular: `navigator.vibrate(10)` si Vibración está activa.
- **Foco `:focus-visible`**: `outline:3px solid var(--azul); outline-offset: calc(var(--sombra) + 1px)` (sobre fondo azul, cámara o cabecera: `outline-color: var(--amarillo)`). Cada componente declara `--sombra` (4, 3 o 2). El anillo no se recorta: nada de `overflow:hidden` en contenedores de botones sin `padding` para el anillo.
- **Deshabilitado**: `aria-disabled="true"` (no el atributo `disabled`, para que conserve foco y pueda **decir por qué**). Fondo `--deshab-fondo`, texto `--gris`, borde `--deshab-borde` punteado 2 px, **sin sombra**, `cursor:not-allowed`. Al activarlo: no hace nada y la línea de estado dice el motivo («Falta talla»). Sin `opacity:.55`.
- **Cargando**: mismo ancho (fijar `min-width` por la etiqueta más larga), etiqueta cambia al gerundio («Guardando…»), anillo CSS de 16 px a la izquierda (con `prefers-reduced-motion`: tres puntos fijos «…»), `aria-busy="true"` y `aria-disabled="true"`. Se ignoran toques mientras dura.
- **Éxito (600 ms, solo principal)**: etiqueta pasa a «✓ Hecho» y vuelve; no cambia de color.

Componentes derivados:

| Componente | Spec |
| --- | --- |
| **Chip** (talla, prenda, marca, precio, filtro) | Mismo botón elegible, `--sombra:2px`, alto 48, ancho mín. 56, `padding: 0 16px`, 16/700. En filas deslizables: `scroll-snap-type:x proximity`, el chip elegido se centra, **se ve el siguiente asomando** (≥ 24 px) y hay un degradado `--niebla`→transparente de 24 px al borde. Faltante obligatorio: borde 2 px `--rojo-texto` + glifo «?» (no solo color). |
| **Segmentado** (`Mercancía|Ropa`, `Etiquetas|Bandas`, `A|B|C`) | `role=radiogroup`/`tablist`; botones pegados sin hueco, borde exterior único de 2 px, el elegido en `--azul`/blanco. Alto 48. Flechas ←→ cambian. |
| **Stepper** `[−] 3 [+]` | Dos botones secundarios de **56×56** con `−`/`+` (SVG, 24 px) y entre ellos un `<output>` de 36/40 px (`tabular-nums`, ancho 64). El número **no** es un campo: tocarlo abre un diálogo numérico (`inputmode=numeric`). Así el lector nunca escribe dentro de una cantidad. Mantener presionado 500 ms repite cada 120 ms. Límites 1–99 (copias) / 0–999 (existencia según contrato). |
| **Interruptor** (Automática, Mostrar impresas, Sonido) | Botón de 48 de alto con casilla cuadrada 28 px a la izquierda (relleno azul + ✓ blanco al encender), etiqueta a la derecha. `role=switch`. |
| **Caja** (campo del lector) | Alto 56, borde 2 px azul, sombra `4px 4px 0 --azul`, fuente mono 20, glifo de código de barras a la izquierda, `autocomplete=off`, `enterkeyhint=search`. Con foco: sombra pasa a amarillo (`4px 4px 0 --amarillo`) + etiqueta flotante «● Lector listo». |
| **Tarjeta** (pieza actual, ficha) | `--blanco`, borde 2 px, sombra `4px 4px 0 --azul`, padding 16. Las filas de lista **no** llevan sombra (planas, separador 1 px `--linea`). Máx. una tarjeta con sombra visible por columna. |
| **Hoja** (bottom sheet, celular) / **panel** (PC) | Sube desde abajo, borde superior 2 px + `0 -4px 0 --azul`, esquinas 0, asa visual de 40×4 solo decorativa, alto máx. 85 % del visor, fondo trasero `rgb(22 54 107 / .5)`. Cierra con ✕ (48×48 arriba a la derecha), `Esc`, tocar fuera o botón atrás de Android. Foco entra al abrir y regresa al disparador al cerrar. PC ≥ 1000: mismo contenido como popover anclado de 360 px. |
| **Insignia** | Cuadrada, `--amarillo`/`--tinta`, 12/800, mín. 24×24, tope «99+». Nunca punto solo. |
| **Línea de estado** | Ver 3.4. |
| **Chip de conexión** | Ver 3.3. |

### 2.5 Iconos

SVG inline en un `<svg hidden>` con `<symbol>`; uso `<svg aria-hidden="true" focusable="false"><use href="#i-…"/></svg>`. Trazo `currentColor`, 2.5 px, `stroke-linecap:square`, `stroke-linejoin:miter`, rejilla 24×24 (ángulos rectos, a juego con la sombra dura). Sin fuentes de iconos. **Todo icono lleva texto visible al lado** salvo: `−`, `+`, `✕`, disparo, teclado (`aria-label` obligatorio). Lista cerrada de símbolos: `camara`, `codigo` (barras), `impresora`, `celular`, `red` (señal), `red-off`, `buscar`, `revisar` (casilla con ✓), `etiqueta`, `mas`, `menos`, `cerrar`, `check`, `aviso` (triángulo), `error` (cuadro con !), `teclado`, `nube-off`, `foto`, `engrane`.
Glifos de estado en texto: `●` listo, `▲` aviso, `■` error, `✓` hecho.

---

## 3. Layout y navegación

### 3.1 Estructura

- **Celular (< 1000 px)**, de arriba abajo: cabecera 56 → línea de estado (mín. 44) → **caja** (52, solo en Buscar/Revisar/Imprimir; en Capturar queda detrás de `⌨ Escribir`) → área del modo (desplazable) → **barra inferior** 64 + `safe-area`.
- **PC (≥ 1000 px)**: cabecera 64 con pestañas → línea de estado → caja 56 de ancho de columna izquierda → cuerpo en **dos columnas** (izq. 440 px lista/entrada, der. fluida pieza/vista; `max-width:1440`, centrado) → pie de 40 px «Hoy: …» solo en Capturar.
- Punto de corte único: `@media (min-width:1000px)` (el mismo de `pieza.html`). 600–999 usa la disposición de celular con columna de 640 centrada.
- Fondo `--niebla`; sin cuerpo desplazable detrás de hojas (`overscroll-behavior:contain`).

### 3.2 Selector de modos: barra inferior en celular, pestañas en PC

Decisión: **barra inferior** en celular.

- Justificación: una mano, pulgar, guantes. El visor de cámara ocupa lo alto y la información (estado, chips) se lee arriba; los controles de pulgar abajo. 4 destinos es el rango de una barra inferior (3–5). Las pestañas superiores quedan fuera de alcance en un teléfono de 6.5″ y chocan con la barra de direcciones. Costo aceptado: el teclado virtual la tapa → se oculta mientras un campo tiene foco (`visualViewport` + `focusin`).
- Cuatro botones iguales (`role=tab`, 97 px × 64): glifo 24 arriba + rótulo 13/700 abajo. Reposo: blanco, azul, borde superior 2 px azul. **Activo**: fondo azul, glifo y rótulo en amarillo, filete amarillo de 4 px arriba. Insignia en esquina: Revisar = por revisar; Imprimir = por imprimir; Capturar = fotos sin subir.
- Modos que el rol no tiene se **omiten** (no se atenúan). Con un solo modo, no hay barra.
- PC: pestañas `Capturar · Buscar · Revisar · Imprimir` en la cabecera (segmentado azul sobre azul-hondo: activa = amarilla con texto azul), cada una con `kbd` «Alt+1»…«Alt+4» a 12 px en gris claro `#C5D0E4`. Orden y atajos idénticos en celular.
- ARIA: contenedor `role=tablist` con `aria-label="Modos de inventario"`; pestañas con `aria-selected`, `aria-controls`; paneles `role=tabpanel` + `aria-labelledby`, los inactivos `hidden`. Tabulación única al grupo (roving `tabindex`), ←/→ mueven, Enter/Espacio activan, Inicio/Fin saltan.
- URL: `/inventario#capturar|buscar|revisar|imprimir` con `history.replaceState` (cambiar de modo **no** apila historial). `?pieza=ED-002318` abre Buscar con esa ficha. Atrás (Android o navegador): primero cierra hoja/ficha, luego sale.
- Recuerda `inventario-modo` por dispositivo. Primera vez en el celular: Capturar.

### 3.3 Cabecera

Fondo `--azul`, texto blanco, alto 56 (celular) / 64 (PC), `padding: 0 var(--gutter)`.

| Zona | Celular | PC |
| --- | --- | --- |
| Marca | cuadro 36×36 amarillo con borde 2 px blanco y «EL» 800 azul (CSS, sin imagen) + «Inventario» 18/800 | igual, 20/800 |
| Modos | (en barra inferior) | pestañas |
| **Chips** (derecha) | `Impresora` y `Red` | `Impresora`, `Celular`, `Red` |
| Menú `⋯` (48×48) | Sonido, Vibración, Inicio, Ajustes (solo roles con /admin) | `Ajustes` como texto-botón + `⋯` (Sonido, Vibración, Inicio) |

**Chip de conexión** (es un `<button>`, alto 44, `--azul-hondo`, borde 2 px `#6F86B5`, sin sombra, 14/700; glifo + palabra; en celular solo la palabra de estado, el nombre va en `aria-label`):

| Estado | Apariencia | Texto celular / PC |
| --- | --- | --- |
| Listo | fondo azul-hondo, glifo `●` `--verde-claro` | `Impresora · Lista` |
| Trabajando | fondo azul-hondo, glifo `●` amarillo | `Imprimiendo 3/12` · `Auto · 3 en cola` |
| Aviso | fondo `--amarillo`, texto `--tinta`, `▲` | `Sin conectar` · `Sin red · 4` |
| Error | fondo `--rojo`, texto blanco, `■` | `No responde` |
| No aplica | borde punteado, texto `#C5D0E4` | `Celular · Apagado` |

Tocar un chip abre hoja/popover con su detalle y **una** acción primaria:
- Impresora: nombre (AE240-bt), estado, `[Conectar impresora]` (primario) · `¿No aparece?` (texto) · `Detener` (peligro, solo si envía) · interruptor `Automática` con «N en cola».
- Celular (PC): «Escuchando desde hace 12 s» · `[Pedir foto de prueba]` · enlace «Abrir en el celular» (`/camara-remota`).
- Red: «Fotos sin subir: 4» · `[Subir ahora]`.
Cambio de estado se anuncia **una vez** en la línea de estado (polite), nunca desde el chip.

### 3.4 Línea de estado (un solo lugar)

Directamente bajo la cabecera, ancho completo, mín. 44 px, 18/700, máx. 2 líneas, `role="status" aria-live="polite" aria-atomic="true"`. Los errores que exigen acción usan un segundo nodo **en el mismo lugar visual**, `role="alert"`, que reemplaza a la línea mientras exista. Estructura: barra izquierda 8 px de color + glifo + texto + (opcional) una acción en texto/secundario a la derecha.

| Tipo | Fondo | Barra / glifo | Texto | Persistencia |
| --- | --- | --- | --- | --- |
| Neutro (reposo) | `--blanco` | azul / `●` | `--azul` | permanente («Escanea o escribe») |
| Éxito | `--fondo-ok` | `--verde` / `✓` | `--azul` | 5 s, luego vuelve a neutro |
| Aviso | `--fondo-aviso` | `--amarillo` / `▲` | `--aviso-texto` | hasta que la condición cambie |
| Error | `--fondo-error` | `--rojo-texto` / `■` | `--rojo-texto` | hasta resolver o `Cerrar` |
| Etiqueta enviada | `--amarillo` | `--azul` / `✓` | `--tinta` 800 | 5 s (como el amarillo de #396) |

Reglas: una sola línea para toda la página (no una por modo); el texto nuevo reemplaza al anterior sin animar; no se apilan mensajes; un error no se borra solo; la línea nunca se desplaza con el contenido (`position:sticky; top:56px/64px`).

### 3.5 Foco del lector entre modos

`lector.js` (único) escucha `keydown` en fase de captura y emite `lectura` `{codigo, origen:'usb'|'bt'|'camara'|'caja'}`.

1. **Caja única persistente** fuera de los paneles de modo (no se destruye al cambiar de modo). Su `placeholder` cambia: Capturar «UPC, ED- o nombre» · Buscar «ED-, UPC o nombre» · Revisar «Buscar en la cola» · Imprimir «Código para filtrar».
2. **Ráfaga**: ≥ 4 caracteres con hueco ≤ 50 ms y `Enter` (o hueco final > 80 ms) = lectura. Si el foco **no** está en un campo editable (`input/textarea/select/[contenteditable]`) o está en la caja, `lector.js` la toma. Con foco en otro campo editable (precio, nombre en edición) no interviene: la persona está tecleando a propósito.
3. **El Enter de una ráfaga se consume** (`preventDefault` + `stopPropagation`): jamás activa el último botón tocado (riesgo 3 del spec). Prueba obligatoria con ráfagas simuladas con foco sobre un botón.
4. **Ninguna cantidad es un campo** (steppers con `<output>`), así que una ráfaga nunca se escribe dentro de una cantidad ni de «copias».
5. Cambiar de modo: PC → foco a la caja; celular → foco al visor/lista (**sin** abrir el teclado: la caja del celular usa `inputmode="none"` hasta que se toca `⌨ Escribir`, que pasa a `inputmode="text"` y enfoca).
6. Cerrar hoja, diálogo o editor: el foco vuelve a su disparador; en PC, si no hay disparador, a la caja. Tras cualquier botón de flujo (Guardar, +1, Imprimir) en PC el foco regresa a la caja en el mismo tick.
7. PC: si el foco queda en `body` > 1.5 s y no hay editor abierto, vuelve a la caja. Indicador «● Lector listo» visible cuando el receptor está armado; si el listener no está activo (hoja abierta), la etiqueta cambia a «Lector en pausa» (aviso).
8. `Esc` limpia la caja y cierra lo más reciente (hoja > diálogo > selección).
9. Una sola cámara a la vez: al cambiar de modo, pestaña oculta (`visibilitychange`) o pérdida de foco de ventana, se liberan las pistas y se muestra «Cámara en pausa» con `[Reanudar]` al volver.

---

## 4. Modos

Convención de mockups: `[ ]` botón secundario, `[[ ]]` botón principal, `( )` chip, `(*)` elegido, `▓` cámara.

### 4.1 Capturar

Un flujo, tres puertas de entrada: **código** (lector/cámara/teclado), **disparo** (foto sin código) y **ED-/dígitos cortos** (abre la ficha, no crea). Elementos pegajosos entre piezas (se recuerdan): tipo `Mercancía|Ropa`, grado `A|B|C`, cantidad (vuelve a 1 tras guardar), y en Ropa prenda, marca, talla y precio. Grados: `A · Nuevo`, `B · Dañado`, `C · Liquidación` (rótulo corto «Liq.» solo en celular).

**Máquina de estados**

```
LISTO ──lee código──► BUSCANDO ──► NUEVA (manifiesto) ──Guardar / otro código──► GUARDADA
   │                      ├──► YA EXISTE ──[+1 e imprimir 1]──► GUARDADA
   │                      ├──► SIN REGISTRO ──Buscar en internet──► búsqueda IA ──► CONFIRMAR IMAGEN ──► NUEVA
   │                      └──► ERROR RED ──► (Reintentar | seguir con foto)
   └──disparo──► (Ropa: exige talla y precio) ──► FOTO GUARDADA EN EL TELÉFONO ──► SUBIENDO ──► ANALIZANDO ──► LISTA
                                                          └── sin red ──► EN COLA (se sube sola)
```

**Celular 390×844 — Listo** (cámara abierta, mercancía)

```
+--------------------------------------+ 0
| [EL] Inventario    (Imp Lista)(Red ●)| header 56
+--------------------------------------+
| ● Escanea o toma foto                | estado 44
+--------------------------------------+
|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|
|▓▓▓▓▓▓▓▓▓  - - - mira - - -  ▓▓▓▓▓▓▓▓|  visor 4:3 (object-fit: contain)
|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|  fondo --camara
|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|
+--------------------------------------+
| 12 hoy · 9 subidas  [m][m][m][m] →   | carrusel 24 h (72 px) + contador
+--------------------------------------+
| [Mercancía|Ropa]          [⌨ Escribir]|  fila 1 (48)
| [A Nuevo][B Dañado][C Liq.] [-] 1 [+]|  fila 2 (56)
|              ( O )                   |  disparo 84 px
+--------------------------------------+
| Capturar | Buscar | Revisar | Imprimir|  barra 64
+--------------------------------------+
```

- Visor siempre 4:3 (como la foto); zoom: deslizador **dentro de una hoja** (`Zoom` en `⋯` del visor) o pellizco; no una barra permanente tapando la imagen. Se recuerda en `captura-zoom`.
- Disparo: 84×84, círculo blanco con borde 6 px `--amarillo` y sombra dura `4px 4px 0 --azul`; presionado hunde. `aria-label="Tomar foto"`. Es el **único** elemento principal de la vista.
- Fila de grado: segmentado de 3 (3 × 52) + stepper (56+64+56=176). Caben en 358 px con 12 px de hueco: si no cabe, el stepper pasa a su propia fila.
- Carrusel 24 h: ver «Correcciones».
- `⌨ Escribir` abre la caja sobre la fila 1 con teclado numérico (`inputmode=numeric`; el botón `ABC` alterna a texto para `ED-`/nombre).

**Celular — Código leído, pieza nueva del manifiesto** (la tarjeta se acopla encima de la fila 1; el visor sigue vivo detrás)

```
| ✓ Lámpara de escritorio ×1           | estado: éxito
+--------------------------------------+
|▓▓▓▓▓▓▓▓▓▓ (visor, 40 % más bajo) ▓▓▓▓|
+--------------------------------------+
| 012345678905                         |
| Lámpara de escritorio                |
| $249 · Hogar · A Nuevo               |
| [ - ] 2 [ + ]       [[ Guardar ]]    |
+--------------------------------------+
```

- Mismo código otra vez = `+1` (el número y el stepper saltan; sonido «más»). Otro código distinto guarda la anterior y abre la nueva. La pieza permanece abierta hasta tocar `Guardar` o leer otro código; no hay guardado por tiempo.
- `−` hasta 0 cancela; en 0 el botón principal cambia a peligro «Cancelar pieza».
- Principal `Guardar` (56). Tras guardar, la línea dice «Guardada · etiqueta en camino» y la tarjeta se contrae a una fila «Lámpara ×2 · ED-002331 ✓» al carrusel.

**Celular — Ya existe**

```
| ▲ Ya existe · ×3                      | estado: aviso
+--------------------------------------+
| ED-002310  [foto 56]                 |
| Lámpara de escritorio      $249      |
| Existencia 3 · última foto: hoy 11:02|
| [[ +1 e imprimir 1 ]]  [ Foto nueva ]|
+--------------------------------------+
```

- Principal `+1 e imprimir 1` (siempre una etiqueta). Si no hay impresora: la pieza se guarda y la línea avisa «Guardada · falta etiqueta» con `[Imprimir]`.
- Si la pieza no tiene foto, `Foto nueva` pasa a principal y `+1` a secundario.

**Celular — Sin registro (UPC fuera del manifiesto)**

```
| ▲ Sin registro · 012345678905         | estado: aviso
+--------------------------------------+
| [ Buscar en internet ]             |
| [[ Tomar foto ]]   [ Sin foto ]*     |  * solo dueño
+--------------------------------------+
```
La búsqueda IA comienza solo al tocar `Buscar en internet`, nunca por tiempo ni por leer otro código. Resultado: tarjeta con imagen 120×120, nombre y `[[ Es esta ]]` / `[ No es ]`. «Sin foto» abre formulario manual (solo dueño; ver 4.3 hoja «Pieza sin foto»). Seguir escaneando no cancela: la búsqueda continúa y queda en el carrusel como «⏳ buscando».

**Celular — Sin código: Ropa** (el tablero de Ropa va **encima del visor**, scrim `rgb(11 18 32 / .85)`, y no cambia de lugar entre fotos)

```
+--------------------------------------+
| ▲ Falta talla                        |  (si se intentó disparar)
+--------------------------------------+
| (Chamarra ▾)(Levi's ▾)($300 ▾)       |  resumen 48: tocar = hoja con todas
| Talla (S)(M*)(L)(XL)(XXL)(3XL)(Niño…)|  fila deslizable, 48
|▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|
|▓▓▓▓▓▓▓▓▓ visor ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓|
+--------------------------------------+
| [Mercancía|Ropa*]         [⌨ Escribir]|
| [A][B][C]                   [-] 1 [+]|
|              ( O )                   |
```

- Orden de captura: la talla es lo que más cambia (rack de M = N disparos), por eso queda a la vista; prenda, marca y precio se eligen una vez y se muestran como tres fichas-resumen. Tocar una ficha abre una **hoja** con chips (prenda: las 16 de `ropa.js`; marca: 12 + campo `Otra marca` con sugerencias recientes; precio: 300·200·150·120·100·80·50, con el sugerido por prenda ya elegido y marcado «sugerido»).
- Obligatorios para disparar: talla y precio (como hoy). Si faltan: el disparo queda `aria-disabled`, al tocarlo se enfoca/resalta el grupo faltante con borde `--rojo-texto` y glifo «?», sonido/vibración «error», línea «Falta talla» / «Falta precio». Prenda y marca opcionales.
- Niño: el chip `Niño…` abre el **rodillo de edades de /captura tal cual** (decisión de Isaac 22/10: se queda el rodillo; misma lógica de `tallas.js`), dentro de una hoja que no compite con el scroll (la hoja no se desplaza mientras el rodillo tiene el gesto). Debajo, fila opcional XS–XL.
- Si en Ropa se lee un código de barras: se atiende como código de mercancía (la pieza con UPC no es una prenda sin código); el tipo pegajoso no cambia.
- `Quitar` solo existe dentro de las hojas de prenda y marca (texto, 48).

**Celular — Foto tomada, subiendo, analizando (mercancía)**

- Al disparar: destello blanco inset 120 ms (sin animación con movimiento reducido), vibración 30 ms, miniatura entra al carrusel con borde **punteado gris** y glifo `nube-off`/reloj = «en el teléfono». El disparo queda libre de inmediato (la cámara no espera a la red).
- Subida de una en una. Miniatura: borde sólido `--verde` + `✓` = subida; spinner = subiendo; `⏳` = analizando (mercancía); `■` rojo = falló.
- Nunca se pregunta «¿Qué es?» después de la foto: el tipo ya está elegido en el segmentado.

**Celular — Offline / en cola**

```
| ▲ Sin red · 4 fotos en el teléfono   | estado: aviso (no bloquea)
...  (Imp Lista)(▲ Sin red 4)
| 12 hoy · 8 subidas  [m✓][m✓][m☁][m☁] |  ☁ = nube tachada, borde punteado
```
- Disparo, grado, cantidad y Ropa funcionan igual. Códigos: sin red no se pueden buscar → el estado dice «Sin red · toma foto» y el botón `⌨ Escribir` queda `aria-disabled` con ese motivo.
- Al volver la red: «Subiendo 4…» → «✓ Todo subido». Mientras haya cola, el chip Red muestra el número y pasa a `Subir ahora` en su hoja.

**Celular — Correcciones de 24 h (carrusel + hoja)**

- Carrusel horizontal, miniaturas de 72×72 (zona táctil 72), hueco 12, `scroll-snap-type:x proximity`, la más reciente primero. Encabezado de una línea: «Hoy · 12 piezas · 9 subidas» a la izquierda y `Ver todas` (texto) a la derecha que abre la lista completa de 24 h en una hoja a pantalla casi completa.
- Cada miniatura: talla arriba (12/800 sobre `#000b`), badge de cantidad abajo-derecha (insignia amarilla), estado como se describió. `aria-label="Chamarra M, 2 piezas, subida"`.
- Tocar: **hoja «Corregir»** (no pantalla completa que tape todo): foto 4:3 arriba (40 % del alto), grado (segmentado), cantidad (stepper), en Ropa prenda/marca/talla/precio (mismas fichas-resumen), y abajo `[[ Guardar cambios ]]` (se habilita al haber cambios; si no, `aria-disabled` con «Sin cambios») · `Retomar foto` (secundario) · `Descartar` (peligro, dos toques: «Descartar» → «¿Descartar esta pieza?» rojo durante 4 s; la línea de estado lo anuncia).
- Si ya salió la etiqueta: nota fija de una línea «La etiqueta pegada dice $300» (aviso) antes de guardar un cambio de precio. No requiere casilla (es captura propia).
- Si aún se está subiendo: botones de la hoja `aria-disabled` con «Espera a que suba».

**PC 1280×800 — Capturar (lector USB + celular como cámara)**

```
+----------------------------------------------------------------------------------------------+
| [EL] Inventario  [Capturar*][Buscar][Revisar][Imprimir]   (Impresora ● Lista)(Celular ● Listo)(Red ●)  ⋯ |
+----------------------------------------------------------------------------------------------+
| ● Escanea o escribe                                                                          |
+---------------------------------------------+------------------------------------------------+
| [▮▮ 012345678905____________ ● Lector listo]| PIEZA ACTUAL                                   |
|                                             | +--------------------------------------------+ |
| Tipo  [Mercancía*|Ropa]                     | | 012345678905                              | |
| Grado [A Nuevo*][B Dañado][C Liquidación]   | | Lámpara de escritorio                      | |
| Cantidad [-] 1 [+]                          | | $249 · Hogar · manifiesto                  | |
|                                             | | [-] 2 [+]      [[ Guardar ×2 e imprimir ]] | |
| YA EXISTE EN EL INVENTARIO                  | |                          Enter             | |
| +-----------------------------------------+ | +--------------------------------------------+ |
| | [f] Lámpara escritorio  ×3   ED-002310  | |                                                |
| |     [[ +1 e imprimir 1 ]]  [ Foto nueva ]| | FOTO CON EL CELULAR                           |
| | [ ] Lámpara LED ×1   ED-002288 sin foto | | +-------------+                                |
| +-----------------------------------------+ | | esperando…  |  ● Esperando foto   1:48      |
|                                             | |    1:48     |  [Cancelar]                    |
| [ Producto sin código: foto con celular ]   | +-------------+                                |
+---------------------------------------------+------------------------------------------------+
| Hoy: 12 piezas · 2 sin foto · 1 analizando · Impresión automática: Activa (3 en cola)          |
+----------------------------------------------------------------------------------------------+
```

- Izquierda = entradas (caja, tipo, grado, cantidad, «Ya existe»). Derecha = **pieza actual** y **solicitud al celular**. La acción principal de la derecha es una sola: la de la tarjeta vigente.
- `Enter` con la caja vacía activa el principal visible (muestra `kbd Enter` en el botón). Una lectura nunca lo activa (regla 3.5).
- Ropa en PC: los grupos Prenda / Marca / Talla / Precio se despliegan en la columna izquierda como **cuatro filas de chips que se envuelven** (sin deslizar), con la misma lógica de obligatorios. Principal de la derecha: `[[ Pedir foto al celular ]]` (`aria-disabled` + «Falta talla» hasta completar).
- Solicitud al celular — estados de la tarjeta: **Esperando** (cuenta atrás 2:00, punto fijo; con movimiento permitido, parpadeo lento) con `Cancelar` · **Recibida** (vista previa 4:3, `[[ Usar ]]` `[ Repetir ]`) · **Guardando** · **Lista** («✓ Chamarra M · ED-002331», la tarjeta se vacía y vuelve el foco a la caja) · **No responde** (ver sección 6).
- Sin impresora: «Guardar ×N» sigue siendo principal, con etiqueta «Guardar ×N» (sin «e imprimir») y la línea avisa al guardar «Guardada · falta etiqueta».
- El pie «Hoy» es neutro 14/600 con números `tabular-nums`; el segmento «analizando» y «sin foto» son enlaces de texto que saltan a Revisar con ese filtro.

### 4.2 Buscar

Al entrar carga todo el inventario visible, más reciente primero, en páginas de 25 con cursor. Resumen: «Todo el inventario · más recientes primero». Entrada: caja (lector, teclado de texto en celular, nombre parcial), placeholder «ED-, nombre o UPC». Filtra a los 250 ms sin abrir la ficha; 1–2 letras conservan la lista completa y avisan «Escribe 3 letras o un código». Borrar o Escape restaura la lista completa. El lector y Enter consultan al instante y abren una coincidencia única sin más páginas. Carga al bajar con IntersectionObserver y mantiene `Cargar más` visible mientras haya cursor como respaldo de teclado/lector de pantalla. El resumen filtrado dice «N resultados para «x»», con «N+» mientras haya más páginas. Una lectura **exacta** (ED-, UPC) abre la ficha de inmediato; un nombre parcial lista. Cámara de etiquetas (Code128/QR) vive en `⋯` de la caja: `Leer etiqueta con la cámara` (una cámara a la vez).

**Celular — resultados y ficha**

```
+--------------------------------------+   +--------------------------------------+
| [EL] Inventario    (Imp Lista)(Red ●)|   | ← Resultados            ED-002318    |
| ● 8 resultados                       |   +--------------------------------------+
| [▮▮ chamarra levi_____________ ] [🎥]|   | [   foto cuadrada, 390×390        ]  |
+--------------------------------------+   |                                      |
| [f] ED-002318                   ×3   |   +--------------------------------------+
|     Chamarra Levi's M · $450          |   | Chamarra Levi's           $450       |
|     [ Reimprimir ]                   |   | M · Levi's · lista $600              |
| [f] ED-002319                   ×1   |   | 012345678905                         |
|     Chamarra Levi's L · $450          |   | EXISTENCIA                           |
|     [ Reimprimir ] · sin foto         |   | [ - ]   3   [ + ]    [ Fijar a… ]    |
| ...                                  |   | [[ Reimprimir etiqueta ]] [Foto nueva][Editar]|
|           [ Cargar más ]             |   | ▸ Historial (10)                     |
+--------------------------------------+   +--------------------------------------+
| Capturar | Buscar | Revisar | Imprimir |
```

- Fila de resultado: miniatura 56 (reserva el espacio si falta foto); primera línea nuestro código `ED-000123` en monoespaciada 20/800, después nombre (2 líneas), y precio · UPC (si tiene) · «sin foto». Sin código: texto secundario discreto. Existencia como insignia cuadrada. Alto mín. 72, reflujo sin recortes a 320 px. Botón de ficha con `aria-current` en la abierta. En Buscar, `Reimprimir` con icono de impresora y texto es un botón hermano (nunca anidado), ≥44×44; solo fuera del host vendedor, con código y destino etiqueta. Envía 1 copia con el motor existente, bloquea dobles toques con `aria-disabled`/`aria-busy` y anuncia «Etiqueta enviada · ED-000123».
- Ficha en celular reemplaza la lista (`← Resultados` fijo arriba, 56, con el código); en PC es la columna derecha.
- Existencia `−`/`+` registra con rastro (`#447`); pide motivo en una hoja corta de 4 chips (`Corrección · Merma · Robo · Entrada`) **solo al bajar o al fijar**; subir 1 usa «Entrada» por omisión. `Fijar a…` abre diálogo numérico. Tras cada ajuste, la línea muestra «Existencia 3 → 2» con `Deshacer` (texto, 8 s).
- **Sin casilla «Editar inventario» («Solo consulta»)**: la ficha no pinta stepper, `Fijar a…`, `Editar` ni `Foto nueva`; en su lugar el número de existencia grande y un sello `Solo consulta` (cuadro `--niebla`, borde 2 px `--azul`, 14/800) que al tocarse abre una hoja de una línea: «Tu cuenta no puede editar. Pídelo al dueño.» **No hay casillas ni controles deshabilitados.** `Reimprimir etiqueta` sí aparece (rol capturista).
- `Reimprimir etiqueta` es el principal de la ficha; `Varias copias…` abre stepper de copias en hoja.
- Precio de pieza con etiqueta: solo el dueño ve el campo; los demás ven el precio como texto.

**PC 1280×800 — Buscar**

```
+----------------------------------------------------------------------------------------------+
| [EL] Inventario  [Capturar][Buscar*][Revisar][Imprimir]   (Impresora ● Lista)(Celular ●)(Red ●)  |
+----------------------------------------------------------------------------------------------+
| ● 8 resultados                                                                               |
+------------------------------------+---------------------------------------------------------+
| [▮▮ chamarra levi________________ ] | ED-002318                                              |
| [f] ED-002318                ×3   | +------------------+  Chamarra Levi's              $450  |
|     Chamarra Levi's M · $450      | |   foto 320×320   |  M · Levi's · lista $600            |
|     [ Reimprimir ]                 | |                  |  012345678905                       |
|     ...                            | +------------------+  EXISTENCIA [-] 3 [+] [Fijar a…]    |
|           [ Cargar más ]           |  [[ Reimprimir etiqueta ]] [ Varias copias… ] [ Foto con celular ] [ Editar ] |
|                                    |  Historial de existencia                                |
|                                    |   21/10 11:02  −1 merma  4→3  (Ana)                     |
+------------------------------------+---------------------------------------------------------+
```
- `↑/↓` en la caja recorren resultados sin quitar el foco; `Enter` abre; el foco regresa a la caja al cerrar.
- En PC `Foto con celular` pide `foto_nueva` al celular (mismo componente de solicitud de 4.1).

### 4.3 Revisar

La cola que hoy vive en `/admin`. Cuenta: «Por revisar N» = pendientes + con error + sin precio.

**Filtros** (sustituyen el panel de 7 campos de /admin): fila de **chips-estado** `Por revisar N · Hoy · Con error N · Todas` (segmentado, una elección) + botón secundario `Filtros (2)` que abre hoja/popover con: día, categoría, precio desde/hasta, sesión, y `Quitar filtros`. Los filtros activos se resumen en chips quitables bajo la fila («Hoy ✕»). El tope de 2000 se dice una vez: «Mostrando las 2000 más recientes» (aviso, solo si se alcanza).

**Celular 390×844**

```
| [EL] Inventario    (Imp Lista)(Red ●)|
| ● 14 por revisar                     |
| [▮▮ buscar en la cola__________]     |
| (Por revisar 14*)(Hoy)(Error 2)(Todas)→ |
| [ Filtros (1) ]       [ ⋯ ]          |
+--------------------------------------+
| [☐] [f] Chamarra Levi's  ⏳ Analizando |
|         ED-002331 · A Nuevo · ×2     |
| [☐] [f] Jeans 501 M  ■ Con error     |
|         [ Reintentar ]               |
| [☑] [f] Lámpara  ▲ Ya existe ×3      |
|         [ Sumar a la existente ]     |
+--------------------------------------+
| 1 elegida   [[ Guardar ]] [Descartar]|  barra de acciones masivas (sobre la barra inferior)
| Capturar | Buscar | Revisar | Imprimir|
```

- Fila: casilla (zona táctil 48×48 a la izquierda; la casilla visual 28), miniatura 56, nombre, estado con glifo+texto (`⏳ Analizando`, `✓ Lista`, `■ Con error`, `▲ Ya existe`), una línea de metadatos, y **una** acción contextual en la fila (solo cuando aplica: `Reintentar`, `Sumar a la existente`). Alto mín. 80.
- Seleccionar ≥ 1 abre la **barra de acciones masivas** pegada sobre la barra inferior: «N elegidas» + principal acorde al contexto + `Descartar` (peligro, dos toques con el conteo: «¿Descartar 3?»). Acciones en `⋯`: `Reanalizar`, `Cambiar categoría`, `Cambiar destino`, `Sumar a existente`. «Elegir todas» = casilla de encabezado tri-estado «Todas (14)». `Guardar todo` queda como acción del encabezado de la lista y pide confirmar con el número («Guardar 14 piezas»).
- Tocar la fila (no la casilla) abre la **ficha** (la misma de Buscar) con un bloque `Avanzado ▸` (categoría, estado, destino, recalcular precio, reanalizar, fusionar, descartar). Precio de pieza con etiqueta: solo dueño.
- **Solo consulta** (sin casilla): sin casillas, sin barra masiva, sin `Avanzado` ni acciones de fila; el sello `Solo consulta` va a la derecha de la fila de filtros. Las filas siguen siendo tocables para ver la ficha.
- Revisar es solo-red: sin red, el modo muestra el vacío «Sin red» (sección 6) y la barra inferior conserva Capturar.

**PC 1280×800**

```
+----------------------------------------------------------------------------------------------+
| [EL] Inventario  [Capturar][Buscar][Revisar*][Imprimir]   (Impresora ●)(Celular ●)(Red ●)      |
+----------------------------------------------------------------------------------------------+
| ● 14 por revisar                                                                             |
+--------------------------------------------+-------------------------------------------------+
| [▮▮ buscar en la cola___________ ]         | ED-002331                       ⏳ Analizando   |
| (Por revisar 14*)(Hoy)(Error 2)(Todas)     | +----------+ Chamarra Levi's               $450  |
| [Filtros (1)]  Hoy ✕        [Guardar todo] | |  foto    | M · Levi's · A Nuevo                |
| [☐] Todas (14)    [Reanalizar][Descartar]  | +----------+ EXISTENCIA [-] 2 [+]                |
| [☑] [f] Chamarra Levi's  ⏳  ED-002331     | [[ Guardar ]]   [ Imprimir 1 ]                  |
| [☐] [f] Jeans 501 M     ■ Error  [Reint.]  | ▾ Avanzado                                      |
| [☐] [f] Lámpara  ▲ Ya existe  [Sumar]      |   Categoría [Hogar ▾] Estado [Listo ▾] Destino… |
+--------------------------------------------+-------------------------------------------------+
```
- Atajos: `↑/↓` fila, `Espacio` selecciona, `Enter` abre, `Ctrl+A` selecciona visibles. Una lectura salta a esa pieza en la cola (o dice «Fuera de la cola» y ofrece abrir en Buscar).

**Pieza sin foto (solo dueño)**: hoja/panel «Pieza sin foto» con campos etiquetados (Nombre, Marca, Categoría, Estado, Precio de lista, Precio de venta, Existencia, Destino), un solo principal `Guardar pieza`. Se abre desde Capturar (`⋯` del visor o desde la tarjeta «Sin registro»), no desde Revisar.

### 4.4 Imprimir

Dos sub-pestañas **dentro** del modo: `Etiquetas | Bandas` (segmentado, 48). La impresora es el servicio de la cabecera; aquí solo se opera.

**Celular — Etiquetas**

```
| [EL] Inventario    (Imp Lista)(Red ●)|
| ● 9 etiquetas por imprimir           |
| [Etiquetas*|Bandas]                  |
| [▮▮ código para filtrar_________ ]   |
| ☑ Todas (5)   ( Mostrar impresas ☐ ) |
+--------------------------------------+
| ☑ [f] Lámpara escritorio    $249     |
|   ED-002331          copias [-] 2 [+]|
| ☑ [f] Jeans 501 M           $120     |
|   ED-002335          copias [-] 1 [+]|
| ☐ [f] Chamarra Levi's  ↻ cambió $450 |
|   la pegada dice $400  copias [-]1[+]|
+--------------------------------------+
| 5 elegidas · 9 etiquetas             |
| [[ Imprimir 9 etiquetas ]]           |  barra de acción fija sobre la barra inferior
| Capturar | Buscar | Revisar | Imprimir|
```

- **Impresora desconectada**: arriba de la lista aparece una tarjeta amarilla con `[[ Conectar impresora ]]` como único principal; `Imprimir N` queda `aria-disabled` («Conecta la impresora»). Conectada: la tarjeta desaparece y el chip lo dice.
- Fila: casilla 48×48, miniatura 48, nombre, precio, código mono, stepper de copias (por omisión = existencia, 1–99), etiqueta de estado: `Nueva`, `↻ Cambió $400 → $450` (fondo aviso), `✓ Salió · celular 12:41` (fondo ok; fila atenuada solo con «Mostrar impresas»).
- Durante el envío la barra se convierte en progreso: «Enviando 4/9» + barra de 8 px + `Detener` (peligro). Pausas de la tanda: «Pausa de 30 s · sigue sola» con cuenta. Al terminar: línea amarilla «Enviadas 9 etiquetas» (honesto: enviadas ≠ impresas); las filas pasan a `✓ Salió`.
- Si se corta a media tanda: línea de error «Impresora desconectada · salieron 4 de 9» y barra con `[[ Reconectar y seguir ]]`; las 5 restantes siguen elegidas. Reanudar no repite las que ya figuran en el servidor.
- `Automática`: interruptor en la hoja del chip Impresora (no en la barra). Con otra pantalla como consumidor: el interruptor `aria-disabled` y la línea «Ya imprime otra pantalla».
- Una lectura filtra la lista; si queda una coincidencia exacta, esa fila sube con borde amarillo y botón `Reimprimir ED-002331` (secundario). **Nunca imprime sola**.
- Menú `⋯` de la barra: `Marcar como impresas`, `No salió desde aquí` (en la primera fila impresa), `Historial de envíos` (hoja con texto mono). Sin párrafos de ayuda.

**Celular — Bandas**

```
| [Etiquetas|Bandas*]                  |
| (Ropa)(Hogar)(Juguetes)(Otro)→       |  familias, chips deslizables
| Cantidad por banda   [-] 20 [+]      |
+--------------------------------------+
| +-----------+ +-----------+          |
| |   $19     | |   $29     |  ...     |  cada banda = botón 88 de alto, 2 columnas
| | BA-0019   | | BA-0029   |          |
| |  ✓ 20     | |           |          |
| +-----------+ +-----------+          |
| [ + Crear familia ]  (solo dueño)    |
```
- Tocar una banda imprime la cantidad elegida; el botón muestra «Imprimiendo…» y luego `✓ 20` (conteo de la sesión). Precio 28/800, código mono 14. Bandas se imprimen con la misma pausa/lote; mismo `Detener`. Familia elegida se recuerda (`bandas-familia`).
- Sin impresora: tarjeta amarilla `Conectar impresora` igual que arriba.

**PC 1280×800 — Imprimir**

```
+----------------------------------------------------------------------------------------------+
| [EL] Inventario  [Capturar][Buscar][Revisar][Imprimir*]   (Impresora ● Lista)(Celular ●)(Red ●)  |
+----------------------------------------------------------------------------------------------+
| ● 9 etiquetas por imprimir                                                                   |
+----------------------------------------------------------------------------------------------+
| [Etiquetas*|Bandas]  [▮▮ ED- / código para filtrar o reimprimir________]  ☐ Mostrar impresas |
| ☑ Todas (5)                                                       5 elegidas · 9 etiquetas    |
| ☑ [f] ED-002331 Lámpara escritorio          $249          copias [-] 2 [+]   Nueva           |
| ☑ [f] ED-002335 Jeans 501 M                 $120          copias [-] 1 [+]   Nueva           |
| ☐ [f] ED-002318 Chamarra Levi's   ↻ la pegada dice $400 → $450   [-] 1 [+]                   |
|                                                       [ ⋯ ]     [[ Imprimir 9 etiquetas ]]   |
+----------------------------------------------------------------------------------------------+
```
Tabla de una sola columna ancha (máx. 1100) con filas de 64; barra de acción fija abajo; `Ctrl+P` o `Enter` en la barra imprime lo elegido (no `Enter` de lectura).

---

## 5. Estados de acciones asíncronas

Plantilla para cada acción: **reposo → cargando → éxito → parcial/en cola → error con salida**. Copy máximo 6 palabras; verbos en infinitivo para botones, gerundio para progreso, pasado para resultado; tuteo implícito (sin «usted»); sin signos de exclamación (salvo «¡Última pieza!», que no va aquí).

| Acción | Reposo | Cargando | Éxito | Parcial / en cola | Error → salida |
| --- | --- | --- | --- | --- | --- |
| Leer código | «Escanea o escribe» | «Buscando…» | «Lámpara ×1» · «Lámpara ×2» (+1) | «Ya existe · ×3» (aviso) · «Sin registro · toma foto» (aviso) | «No se pudo buscar» + `[Reintentar]`; sigue disponible el disparo |
| Guardar pieza (código) | `Guardar` | «Guardando…» | «Guardada · etiqueta en camino» | «Guardada · falta etiqueta» + `[Imprimir]` | «No se guardó» + `[Reintentar]`; la tarjeta conserva datos y UUID |
| Tomar foto | disparo | «Procesando…» (≤ 1 s) | miniatura entra (vibración 30) | «En el teléfono · sin red» (miniatura punteada) | «No se pudo abrir la cámara» + `[Reintentar]` `[Subir foto]` |
| Subir fotos | «9 subidas» | «Subiendo 4…» | «✓ Todo subido» | «Sin red · 4 en el teléfono» | «No se subió · revisa tu sesión» + `[Entrar]`; la foto sigue guardada |
| Análisis IA | (sin texto) | miniatura ⏳ «Analizando…» | miniatura ✓ | — | «No se pudo analizar» → pasa a Revisar › Con error `[Reintentar]` |
| Búsqueda IA por UPC | «Sin registro» | «Buscando en internet…» + barra | «Encontrada · ¿es esta?» | «Sin resultado · toma foto» | «No se pudo buscar» + `[Tomar foto]` |
| +1 / existencia | stepper | stepper con anillo | «Existencia 3 → 4» + `Deshacer` 8 s | «Se aplicará al volver la red» (solo si el diseño de #447 lo permite; si no, bloquear con «Sin red») | «No se ajustó · alguien cambió esto» + `[Ver actual]`; nunca sobrescribe |
| Imprimir 1/N | `Imprimir 1` | «Enviando 2/9» | «Enviada a la impresora» / «Enviadas 9 etiquetas» | «Salieron 4 de 9» + `[Reconectar y seguir]` | «Impresora desconectada» + `[Conectar]`; nada se marca enviado sin respuesta |
| Conectar impresora | `Conectar impresora` | «Buscando…» | «Impresora lista» | — | «No aparece» + `[¿No aparece?]` (lista todos los Bluetooth) |
| Foto con celular (PC) | `Pedir foto al celular` | «Esperando foto… 1:48» | «Foto recibida» | «Celular sin red · reintentando» | «El celular no responde» + `[Reintentar]` `[Subir desde la PC]` |
| Guardar edición (ficha) | `Guardar cambios` | «Guardando…» | «Cambios guardados» (si había etiqueta con otro precio: «La pegada dice $400») | — | «No se guardó» + campo con error enlazado |
| Acciones masivas | `Guardar` | «Guardando 4/14…» | «Guardadas 14» | «Guardadas 12 · fallaron 2» + `[Ver las 2]` | «No se pudo» + `[Reintentar]` |
| Descartar | `Descartar` | — | «Descartada» (sin deshacer: dicho antes) | — | «No se descartó» |
| Cargar lista / buscar | (placeholder) | 4 filas esqueleto (sin brillo animado en movimiento reducido) | «8 resultados» | — | «Sin conexión» + `[Reintentar]` |

Reglas transversales: el estado vive en la línea de estado **y** en el control que lo originó; el éxito se limpia solo a los 5 s; el error no; un reintento usa el mismo identificador (idempotente, sin duplicados); cualquier mensaje de error termina en la acción que lo resuelve.

### 5.1 Sonido y vibración (opcionales)

Interruptores `Sonido` y `Vibración` en `⋯` (claves `inventario-sonido`, `inventario-vibracion`, por omisión encendidos; PC sonido encendido). `AudioContext` se crea con el primer gesto («Empezar» en celular, primera tecla o clic en PC). **Todo evento tiene también destello y texto**, así que apagarlos nunca quita información. Se conservan los tonos calibrados de `/escanear`.

| Evento | Sonido | Vibración (ms) | Destello (anillo inset 6 px, 350 ms) | Línea de estado |
| --- | --- | --- | --- | --- |
| Código leído, pieza nueva | 880 Hz · 90 ms | 40 | `--verde` | éxito |
| Mismo código (+1) | 1320 Hz · 60 ms | 40 | `--azul` | éxito |
| Ya existe | 1320 Hz · 60 ms ×2 | 40, 60, 40 | `--amarillo` | aviso |
| **No encontrado** (sigue el flujo) | 440 → 330 Hz · 120 ms c/u | 80, 60, 80 | `--amarillo` | aviso |
| **Error** (red, impresora, guardado) | 220 Hz 250 ms + 180 Hz 250 ms | 200, 100, 200 | `--rojo` | error |
| Foto tomada | sin sonido | 30 | blanco 120 ms | — |
| Etiqueta enviada | 1046 → 1568 Hz · 80/120 ms | 150, 80, 150, 80, 150 | `--amarillo` 1500 ms (toda la pantalla de captura) | etiqueta enviada |
| Falta dato (talla/precio) | igual que **Error** | igual | borde rojo en el grupo | aviso |
| Subida terminada | silencio | — | — | éxito (texto) |

Con `prefers-reduced-motion`: el destello se muestra como anillo fijo (sin transición) y no hay animación de rebote; la vibración y el sonido siguen las preferencias de los interruptores. No más de un destello por segundo. El destello es un anillo `inset` sobre el escenario, **no** un borde del `body` (sin saltos de layout).

---

## 6. Vacíos, primera vez y permisos

Patrón de vacío: glifo grande (48 px, trazo azul), **una línea** de 20/800, **una acción** (principal si hay camino; si no, texto). Sin párrafos.

| Situación | Título | Acción |
| --- | --- | --- |
| Buscar, sin consulta | «Todo el inventario · más recientes primero» | lista completa con carga al bajar |
| Buscar, sin resultados | «Sin resultados para «chamarr»» | `[[ Capturar pieza nueva ]]` (si el rol puede) |
| Revisar, todo al día | «Todo revisado» (✓ verde) | `Ver todas` (texto) |
| Revisar, error de red | «Sin conexión» | `[[ Reintentar ]]` |
| Imprimir, nada pendiente | «Nada por imprimir» | `Mostrar impresas` (texto) |
| Bandas sin familias | «Aún no hay familias» | `[[ Crear familia ]]` (dueño) / texto «Pídela al dueño» |
| Capturar, sin fotos hoy | carrusel oculto; línea «Escanea o toma foto» | — |
| Modo sin red (Buscar/Revisar/Imprimir) | «Este modo necesita red» | `Ir a Capturar` (texto) |

**Primera vez**
- Celular, Capturar: pantalla `--azul` a pantalla completa (z 40) con título «Capturar» y un único botón principal `Empezar` (activa audio y pide cámara; es el gesto necesario). Debajo, una línea: «Cámara y sonido». Sin tour ni consejos.
- PC: la caja ya enfocada con «● Lector listo». Si la impresora nunca se conectó, el chip está amarillo `Sin conectar` y la línea de estado dice «Conecta la impresora» una vez.
- Primer uso de Ropa: las fichas-resumen aparecen con «?» y borde rojo hasta elegirse.

**Permiso de cámara denegado (celular y PC)** — en el área del visor, tarjeta `--camara` con texto blanco:
```
■ Cámara bloqueada
1. Toca el candado de la barra de direcciones.
2. Permisos › Cámara › Permitir.
[[ Reintentar ]]  [ Subir foto ]  [ ⌨ Escribir código ]
```
(3 pasos o menos, numerados; los tres botones mantienen el trabajo en marcha: `Subir foto` abre `<input type=file accept=image/* capture=environment>`.) Error de hardware («otra app usa la cámara»): «Otra app usa la cámara» + `[Reintentar]`.

**Bluetooth**
- Sin Web Bluetooth (iOS/Firefox): hoja del chip: «Este navegador no imprime. Usa Chrome o Edge.» (sin acción de conectar). El chip: aviso `No disponible`.
- Permiso negado / diálogo cancelado: línea de aviso «No elegiste impresora» + `[Conectar]`.
- Lista vacía: «No aparece» → `[¿No aparece?]` muestra todos los aparatos cercanos con la nota fija «Prende la impresora y acércala».

**Impresora desconectada** (después de haber estado lista): chip → aviso `Sin conectar`; línea de error persistente «Impresora desconectada» con `[Reconectar]`; ninguna etiqueta pendiente se descarta; en Capturar las piezas siguen guardándose y la línea cambia a «Guardada · falta etiqueta» (aviso). Al reconectar, `Imprimir` ofrece las pendientes marcadas.

**Celular (cámara remota) no responde** (PC): tras 20 s sin tomar la solicitud o sin latido:
```
■ El celular no responde
Abre «Cámara para la PC» en el celular y toca Empezar.
[[ Reintentar ]]  [ Subir foto desde esta PC ]  [ Cancelar ]
```
Chip `Celular · No responde` (rojo). La solicitud caduca a los 2:00 sin crear pieza. El celular, en su pantalla, usa `/camara-remota` (sin modos): estados visibles `Escuchando`, `Piden una foto`, `Foto enviada`.

**Sesión vencida**: línea de error «Tu sesión venció» + `[Entrar]`; Capturar sigue guardando localmente.

**Host del vendedor** (`captura.viste.com.mx`): el servidor decide qué APIs responden. La pantalla pinta solo los modos que `/api/yo` indica; precios de pieza con etiqueta nunca son editables para capturistas.

---

## 7. Accesibilidad

- [ ] Todo control con nombre accesible: `label` visible (sin `placeholder` como etiqueta), `aria-label` solo en iconos (`−`, `+`, `✕`, disparo, teclado).
- [ ] `lang="es"`. Un `h1` («Inventario»), `h2` por modo/sección, `h3` dentro de tarjetas.
- [ ] Línea de estado `role=status aria-live=polite aria-atomic=true`; errores que exigen acción `role=alert` (assertive) en el mismo sitio; **no** anunciar chips ni contadores que cambian cada segundo.
- [ ] Pestañas: patrón `tablist` con roving `tabindex`, ←/→/Inicio/Fin, Alt+1…4; paneles `tabpanel`; el foco se mueve al panel/caja al activar.
- [ ] Orden de tabulación en PC: caja → controles de la columna izquierda en orden visual → columna derecha → pie; chips de la cabecera **después** de las pestañas y antes de la caja; sin `tabindex` positivos. Saltar al contenido: enlace «Ir a la caja» (visible al enfocar).
- [ ] Nada solo con hover: todo `:hover` tiene equivalente táctil y de teclado; descripciones en hoja, no en `title`.
- [ ] Foco visible en todo (2.4) con contraste ≥ 3:1 sobre cualquier fondo (azul sobre claro, amarillo sobre azul/cámara). Foco nunca atrapado: hojas y diálogos devuelven foco al disparador y se cierran con `Esc`.
- [ ] Diálogos con `<dialog>` (o `role=dialog aria-modal=true aria-labelledby`); sin `confirm()`/`alert()` nativos (`pieza.js` línea 124 usa `confirm()`: no se porta).
- [ ] Zonas táctiles ≥ 44×44 siempre; acciones principales del celular ≥ 56; hueco ≥ 12 entre controles con sombra.
- [ ] Texto ≥ 16 px en campos; reflujo a 320 px sin scroll horizontal; zoom del navegador permitido hasta 200 %.
- [ ] `prefers-reduced-motion: reduce`: sin traslaciones de botón, sin parpadeos, sin transiciones de hoja (aparecen/desaparecen), spinners → «…» estático, destello → anillo fijo.
- [ ] Estados por color + forma + texto (✓ ▲ ■); verificado en escala de grises.
- [ ] Listas largas: `content-visibility:auto` + `contain-intrinsic-size`; los resultados son `<ul>` con `<li><button>`; la fila abierta lleva `aria-current="true"`.
- [ ] Imágenes de pieza: `alt=""` en miniaturas dentro de botones que ya nombran la pieza; `alt` descriptivo en la foto de la ficha («Foto de Chamarra Levi's»).
- [ ] Cantidades: `<output>` con `aria-live="off"`; el cambio se anuncia en la línea de estado, no en el número.
- [ ] Cámara: `video` con `aria-label="Vista de la cámara"`; botón de disparo anuncia el resultado en la línea de estado («Foto 13 guardada»).
- [ ] Entrada del lector no mueve el lector de pantalla: el resultado se anuncia una sola vez en la línea.

---

## 8. No hacer (anti-patrones vistos que no se heredan)

1. **Párrafos de ayuda.** `etiquetas.html` (tres `<p class="ayuda">` de 6–9 líneas: conectar, «Mostrar impresas», historial); `bandas.html` (`.ayuda` de 6 líneas); `escanear.html` (`<p class="dato">` bajo el formulario manual y la lista vacía); `camara-remota.html`. Reemplazo: estados con 2–6 palabras y una acción.
2. **Fila de 10 botones iguales** sin jerarquía (`etiquetas.html .barra`: Conectar, Imprimir, Auto, Nueva sesión, Todas, Ninguna, Marcar, Mostrar, ¿No aparece?, Detener). Reemplazo: un principal, interruptores y un `⋯`.
3. **Enlaces con flechas como navegación** en cabeceras (`admin.html`: «Buscar pieza →», «Ir a capturar →», «Imprimir bandas →»; `etiquetas.html`; `bandas.html`). Reemplazo: modos.
4. **Objetivos de 30–40 px**: `li .corregir button` 36×36 en `escanear.html`; `#cantidad button` 30×40 y `.valor` 28 px en `captura.html` (< 600 px); `.mini` 62×62 como único acceso a corregir. Mínimo de esta guía: 48 (56 principal).
5. **`maximum-scale=1, user-scalable=no`** (`captura.html`). Prohibido: bloquea el zoom.
6. **`confirm()` nativo** (`pieza.js` 124: «¿Cambiar existencia…?»). Congela la pestaña; usar confirmación inline de dos toques o diálogo `<dialog>`.
7. **Deshabilitado con `opacity:.55`** sin explicar (`escanear.html button:disabled`, `captura.html #revisar button:disabled`). Usar `aria-disabled` + motivo en la línea.
8. **Estado solo por color**: `.mini.subida` verde vs blanco y `.mini.danado` rojo (`captura.html`); `li.fallo` solo en rojo y clicable sin ser botón (`escanear.html`); `.renglon.impresa` fondo verde pálido (`etiquetas.html`). Siempre glifo + texto.
9. **Texto de ayuda sobre el video** con `opacity:.85` y 13 px (`captura.html #ayuda`). La información va en la línea de estado, nunca sobre la imagen cambiante.
10. **Magia de posiciones**: paneles con `top: calc(280px + …)` condicionados por clases (`captura.html #talla-panel`, `body.con-precios`). Usar flujo normal con variables de altura (`--alto-cabecera`, `--alto-estado`).
11. **Rojo `#D72B32` como texto** (`escanear.html #aviso`, `li.fallo`; `admin.html .aviso`) y bordes de campo grises de 2.5:1 (`pieza.html`). Usar `--rojo-texto` y bordes azules de 2 px.
12. **Tarjetas blancas de 12 px de radio con borde gris y sombra suave** (`escanear.html .tarjeta`, `admin.html .panel`, `caja.html .panel`): se leen como plantilla. Usar bordes azules y sombra dura de 2 px de radio.
13. **Campo de existencia absoluta sin rastro** (`admin.html` `stock`) y **editar nombre/precio sin casilla**. Toda existencia usa ± con rastro; sin casilla = «Solo consulta» sin controles.
14. **Avisos mudos o duplicados**: `.aviso` sin `role` en `admin.html`; `#aviso` y `#estado-imagen` y `#resumen` en pantallas distintas con distinto estilo. Una sola línea de estado.
15. **Cantidad como `<input type=number>` junto al lector** (`escanear.html #cantidad`): una ráfaga se escribe dentro. Usar `<output>` + steppers.
16. **Modos como pantallas separadas con `body` que cambia de borde** (`escanear.html body { border:6px }`). El destello es un anillo `inset` del escenario, sin layout.
17. **Pantallas completas que tapan todo** para corregir (`captura.html #revisar` con `position:fixed; inset:0`). Usar hoja que deja ver el visor y el estado.
18. **Banners explicativos de convivencia** («También en Inventario → Imprimir») en pantallas nuevas: no se llevan al nuevo diseño; viven solo en las viejas durante la transición.
19. **Hover como única pista** (`admin.html .retomar:hover`). Siempre `:focus-visible` y `:active`.
20. **Encabezados de tarjeta con flechas y jerga** («cola de revisión», «Sesión de captura», «destino»): usar el vocabulario de `VOZ.md` y de la tienda («pieza», «etiqueta», «por revisar»).

---

## 9. Lista de QA (capturas headless)

Herramienta: Chromium headless (Playwright/Puppeteer) con rutas `/api/*` interceptadas con fixtures; `deviceScaleFactor:2`, `hasTouch` + UA Android en 390×844; ratón en 1280×800. Guardar capturas como `qa/inventario/<NN>-<estado>-<390|1280>.png`. Criterio general en **todas**: sin scroll horizontal (`document.documentElement.scrollWidth <= innerWidth`), ningún texto cortado en 320 px, sin superposición con la barra inferior, `console` sin errores.

**Estados a capturar (390×844 y 1280×800 salvo indicación)**

| # | Estado | Debe verse |
| --- | --- | --- |
| 01 | Capturar · listo | visor, línea neutra, disparo 84 px, barra con 4 modos (celular); caja con «● Lector listo» (PC) |
| 02 | Capturar · código nuevo | tarjeta con `Guardar`, sin cuenta atrás ni guardado tras 25 s, stepper, línea de éxito |
| 03 | Capturar · ya existe | `+1 e imprimir 1` principal, `Foto nueva` secundario |
| 04 | Capturar · sin registro + búsqueda IA | «Sin registro», barra de progreso, `Tomar foto` |
| 05 | Capturar · Ropa completa | tablero con prenda/marca/precio en resumen y fila de talla |
| 06 | Capturar · Ropa sin talla | disparo `aria-disabled`, grupo con borde rojo + «?», línea «Falta talla» |
| 07 | Capturar · sin red | línea de aviso, chip Red amarillo con número, miniaturas punteadas |
| 08 | Capturar · carrusel y hoja «Corregir» | miniaturas 72 px, hoja con `Guardar cambios` y `Descartar` en dos toques |
| 09 | Capturar · cámara bloqueada | tarjeta de 3 pasos y tres botones |
| 10 | Capturar PC · esperando foto del celular | cuenta atrás, `Cancelar`; y «El celular no responde» |
| 11 | Buscar · resultados y ficha | filas de 72, ficha con stepper; y variante «Solo consulta» (sin stepper ni casillas) |
| 12 | Revisar · cola con selección | barra masiva con conteo; variante «Solo consulta» sin casillas |
| 13 | Revisar · vacío «Todo revisado» y «Sin conexión» | glifo + una línea + una acción |
| 14 | Imprimir · Etiquetas con impresora desconectada | tarjeta amarilla `Conectar impresora`, `Imprimir N` `aria-disabled` |
| 15 | Imprimir · enviando y corte a media tanda | progreso, `Detener`, luego «salieron 4 de 9» + `Reconectar y seguir` |
| 16 | Imprimir · Bandas | rejilla de bandas 88 px, `✓ 20` en impresas |
| 17 | Hoja de chip Impresora y de chip Red | una acción principal cada una |
| 18 | Menú `⋯` | Sonido y Vibración con estado, Inicio, Ajustes (solo rol) |
| 19 | Buscar · lista completa | «Todo el inventario · más recientes primero», filas con código ED- visible y `Cargar más` mientras haya páginas |
| 20 | Buscar · filtro escrito | «N resultados para «x»», N+ si hay más, sin abrir la ficha automáticamente |
| 21 | Buscar · tarjeta con Reimprimir | icono y texto, botón hermano de ficha, envío único y estado con código; variantes sin foto y sin código |

**Comprobaciones automáticas (script con `getBoundingClientRect` / `getComputedStyle`)**

- [ ] Cada `button, a[href], [role=tab], summary, input, select` visible mide ≥ 44×44 CSS px en 390 px; los `.primario` ≥ 56 de alto; steppers 56×56; disparo 84×84; barra inferior 64 de alto (sin contar `safe-area`).
- [ ] Todo `input` ≥ 16 px de fuente; ninguno con borde `#9AA4B6`.
- [ ] Contraste de todos los pares de texto de la tabla 2.1 ≥ 4.5 (3 para ≥ 24 px); ningún texto `#D72B32` sobre niebla.
- [ ] `getComputedStyle(btn).boxShadow` de cada botón principal/secundario coincide con la tabla 2.4; `:active` los deja sin sombra; deshabilitados sin sombra y con `aria-disabled=true`.
- [ ] Pestañas: `role=tablist/tab/tabpanel`, un solo `tabindex=0`; Alt+1…4 cambian de modo y dejan el foco en la caja (PC).
- [ ] Prueba del lector: con foco sobre un botón, inyectar «012345678905» + Enter a 15 ms entre teclas → se emite una `lectura`, el botón **no** recibe `click`, la cantidad no cambia; con foco en la caja igual; con foco en un campo de edición **no** se intercepta.
- [ ] Al cambiar de modo, `stream.getTracks().every(t => t.readyState === 'ended')` salvo Capturar; sin tracks vivos al ocultar la pestaña.
- [ ] Línea de estado: un solo nodo `role=status`; un solo `role=alert` visible a la vez.
- [ ] Con `prefers-reduced-motion: reduce`: `transition-duration` 0 en botones y hojas; sin animaciones infinitas.
- [ ] Teclado en 1280: recorrer con `Tab` y capturar el foco visible en caja, pestañas, chips de la cabecera, principal de cada modo y una fila de lista; anillo de ≥ 3 px visible en todos.
- [ ] Teclado virtual simulado (`visualViewport` reducido a 400 px): la barra inferior se oculta y el campo enfocado queda visible.
- [ ] Rol sin casilla: sin casillas, sin stepper, sin `Editar`, con sello «Solo consulta»; rol dueño: ve `Pieza sin foto` y `Crear familia`; rol sin Imprimir-lista (host vendedor): modos omitidos, no atenuados.
- [ ] Grises (filtro `grayscale(1)`): éxito, aviso y error siguen distinguibles por glifo y texto.
- [ ] Todas las cadenas visibles: tuteo, acentos y signos completos; ninguna del tipo «Haz clic aquí»; ninguna frase de más de 6 palabras en línea de estado salvo los errores con acción (≤ 10).

**Pendiente de prueba física (no sustituible por headless)**: lector USB y Bluetooth con ráfagas reales, cámara 4:3 con zoom y `BarcodeDetector` a 120 ms, AE240 por PC y por Android, luz solar con el celular, guantes, red cortada a media tanda, vibración y volumen en el piso.

---

## 10. Solicitud de cambio de precio (#451)

El capturista señala una pieza que le parece muy barata o muy cara; el dueño decide. Una sola solicitud pendiente por pieza. Solo piezas de etiqueta individual ya listas (las de banda tienen el precio de su banda). El dueño no ve el botón: cambia el precio desde `Editar`. Cajero y FEP tampoco. El servidor autoriza; la pantalla solo oculta.

**Capturista** (ficha de Buscar y tarjeta de pieza existente en Capturar; el bloque va justo bajo el precio):

| Estado | Lo que ve | Notas |
| --- | --- | --- |
| Sin pedir | `[ Pedir cambio de precio ]` secundario | |
| Hoja `¿El precio está bien?` | Pieza, precio actual grande, `▲ Está barato / Hay que subirlo` y `▼ Está caro / Hay que bajarlo` (radios), `Precio sugerido (opcional)` con prefijo `$`, `Nota (opcional)` ≤ 140, `[[ Enviar al dueño ]]` | Enviar es `aria-disabled` con «Elige si está barato o caro» hasta elegir. El sugerido debe ir en el sentido elegido, > 0 y ≤ precio de lista; el error sale dentro de la hoja con `■`. |
| Enviada | Línea de estado `✓ Solicitud enviada al dueño`; en la ficha `▲ Pediste subir el precio · pendiente` (o `▼ … bajar`) y `Sugeriste $X` | Reemplaza al botón. Con 409 por pendiente existente se muestra ese mismo estado. Otro capturista ve `▲ Piden subir este precio · pendiente`. |

**Dueño**: en Revisar, primer filtro `Precios por revisar · N` (amarillo mientras N > 0 y no esté elegido) y, en la pestaña Revisar, insignia con el número (`aria-label` «Revisar, N precios por revisar»). Cada solicitud: foto, código `ED-` en monoespaciada, nombre, chip `▲ Barato` / `▼ Caro`, precio actual y sugerido grandes, nota, quién y cuándo (hora de tienda), `Precio nuevo` prellenado con el sugerido (o el actual), `[[ Cambiar a $X ]]` (el texto sigue al campo; `aria-disabled` con el motivo si es el mismo precio, inválido o pasa de la lista) y `[ Dejar igual ]`. Cambios de más de 50 % piden confirmar en hoja. Al cambiar: `✓ Ahora $X`, «La etiqueta pegada dice $Y: ya no es el precio» y `[[ Reimprimir etiqueta ]]` (en el host del capturista solo el aviso). Si el precio ya cambió por otro lado, el servidor responde 409, la fila muestra el precio de hoy y avisa; nada se aplica a ciegas. La misma tarjeta aparece en la ficha cuando el dueño abre una pieza con solicitud pendiente.

## 10. UPC y grados (#452)

Una captura del mismo UPC (ignorando ceros iniciales), propietario y grado suma a la pieza visible existente, incluso si sigue pendiente de análisis. Otro grado conserva su propia pieza. La línea dice «Ya existía · +N a ED-000123»; la tarjeta y las copias usan el código existente. El UUID de la captura se conserva en los reintentos y en la cola de fotos del teléfono. Una suma que supera 999 se rechaza sin efectos.

En Corregir datos, «Código del producto (UPC)» admite teclado/lector con foco y «Leer con cámara». Vacío quita el UPC; se exige «Editar inventario». Una coincidencia abre una hoja con «Juntar en…» y «Cancelar». Si falta etiqueta se usa la fusión existente, conservando la pieza etiquetada; con dos etiquetas se traspasa toda la existencia, se conservan ambos códigos y se ofrece imprimir las N etiquetas del destino. La origen queda en cero, sin UPC y sin borrar sus relaciones.

Revisar › «Repetidas · N» aparece para el dueño y quien tenga la casilla (también FEP, sólo lo suyo). Agrupa por UPC normalizado y grado, muestra foto, código y existencia, y permite escoger cuál conservar; por omisión el código ED más antiguo. Usa la misma hoja de coincidencia. La búsqueda inspecciona 80 candidatas por página mediante el índice 053: «N+» indica que falta recorrer páginas, con «Cargar más» aun cuando una página no tenga coincidencias. Nunca presenta ese conteo parcial como total.
