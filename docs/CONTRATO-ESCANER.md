# Contrato del escáner — alcance de arranque (Día 1)

> Arquitectura: Claude (2026-09-11, a petición de Isaac). Implementa: Codex.
> Issue: #2. Rama: `agent/codex/2-operations-scanner-rebaseline`.
> Código y docs en español; ninguna cadena visible en inglés.
>
> **Actualizado 2026-09-24 (Isaac):** los tres botes de precio fijo ($20/$40/$60)
> se reemplazaron por **bandas** — siete precios × dos familias (ropa/general),
> límite subido a $200. El detalle completo del diseño vive en
> `docs/PLAN-ETIQUETAS-POR-BANDA.md` (PR #53); este contrato se actualiza abajo
> para reflejarlo, no para llevar la historia de cómo se llegó ahí. El cambio de
> fondo: **ya no hay triage a ojo antes de fotografiar.** Toda pieza que no es
> basura se fotografía y pasa por la IA; el precio que resulta decide sola si
> lleva etiqueta propia (> $200) o banda (≤ $200). Isaac lo pidió así a
> propósito — más análisis por pieza, cero juicio de piso que entrenar.

> **Actualizado 2026-09-25 (Isaac): toda pieza fotografiada lleva su etiqueta
> individual, cueste lo que cueste.** El precio ya no manda a una banda: el análisis
> da un precio que termina en 9 (mínimo $9) y la pieza sale por `/etiquetas` como
> cualquier otra. Las **bandas** se imprimen por lote desde `/bandas` y se pegan a lo
> que se etiqueta **sin fotografiar ni analizar**; se cobran escaneando su código, y
> siguen disponibles en el admin como destino manual. Donde abajo se lea que el precio
> enruta a banda, vale esta nota.

> **Ropa, probada en sandbox el 2026-10-11 y autorizada para producción el
> 2026-10-13 (Isaac, Issues #273 y #302):** la ropa ya tiene precios
> finales de **$300, $200, $150, $120, $100, $80 y $50 MXN**. En modo Ropa se escogen precio y
> talla antes de fotografiar; la foto conserva ese precio en la cola local. El
> servidor valida la categoría de precio y deja la pieza lista, sin estimación de IA,
> porcentaje ni redondeo a 9. Cada foto lleva nombre **Ropa**, su talla y código
> individual; no se inventa un precio de lista. El árbol de decisiones por tipo de
> prenda y los nombres específicos quedan para una definición posterior de Isaac.
> La computadora con la etiquetera imprime automáticamente al quedar guardada la
> foto con nombre y precio. Esta regla rige en sandbox y producción; para otra
> mercancía siguen vigentes las reglas de análisis descritas abajo.

> **Inventario (Isaac, 22/10/2026, #446):** `/inventario` reúne Capturar, Buscar, Revisar e Imprimir (Bandas dentro de Imprimir). En `captura.viste.com.mx` se autorizan Capturar, Buscar y Revisar: consulta de precios, existencia y fotos; la edición exige la casilla «Editar inventario», y precio con etiqueta solo lo cambia el dueño. Ajustes (`/admin`) nunca se sirve en ese host. La captura propia de 24 h conserva sus permisos. `/pieza` redirige a Buscar; las cinco rutas anteriores siguen operativas hasta el visto bueno de Isaac. Sin red solo se encolan fotos: nunca cambios de existencia.

> **Tarjeta del manifiesto y reposo (Isaac, 23/10/2026, #461, PR A):** en captura PC y celular, nombre/descripción y precio aparecen precargados antes de «Guardar e imprimir». El dueño puede cambiar ambos; una cuenta con «Editar inventario» puede cambiar solo el nombre; sin casilla ambos son de solo lectura. La impresión automática al guardar y reescanear se conserva y toma los datos confirmados por D1. La solicitud de precio #451 sigue en las vistas existentes después de guardar.

`POST /api/borradores/upc` conserva `{id, upc, stock, estado_fisico}` y acepta `nombre?: string` y `precio?: number`. El nombre se decodifica con las reglas existentes de entidades, se recorta por los extremos y a 120 caracteres; vacío o tipo inválido responde 400. Precio: centavos MXN, número entero seguro mayor a cero; si existe precio de lista positivo, no puede superarlo (400). Omitir campos conserva el cálculo del servidor. Un precio diferente al calculado por el servidor sin rol dueño responde **403**; nombre diferente sin `puedeEditarInventario` responde **403**, antes de sumar o insertar. En reintentos se compara contra la ficha guardada. El UUID conserva el resultado original y no repone stock; una captura distinta que coincide en UPC/grado suma sin sobrescribir nombre/precio ya registrados (#452). D1 sigue como único maestro.

En `/inventario` móvil, Mercancía y Ropa apagan la cámara tras **60 s** sin lecturas, fotos ni interacción de captura (`INACTIVIDAD_CAMARA_MS`). Se usa el mismo apagado del interruptor «Cámara/Apagada», se detienen pistas y se muestra «Cámara en pausa · toca para encender». Tocar visor o interruptor la reanuda; el reloj no revierte la elección manual. Una hoja abierta o página oculta suspende el contador. Se conserva la liberación de cámara al salir de captura, ocultar la página o perder foco: se reanuda por gesto explícito.

> **UPC real (#452):** una pieza visible por propietario, UPC sin ceros iniciales y grado. Recapturar suma con folio idempotente y motivo `entrada`; las pendientes también cuentan. `PATCH /api/borradores/:id` acepta `upc` (vacío lo quita) con «Editar inventario»; una coincidencia responde 409 con `existente`. Se reutiliza ese PATCH para conservar los permisos y consumidores actuales. `POST /api/piezas/:id/juntar {id, destino_id}` pasa existencia entre dos piezas etiquetadas del mismo grado, con dos ajustes de `correccion`, sin borrar código ni historial de la origen: queda en cero y sin UPC. La fusión anterior conserva sus restricciones cuando falta una etiqueta. Límite conjunto: 999. Antes de desplegar, Isaac aplica la migración aditiva 053; no hay índice único ni limpieza automática de duplicados históricos.

`GET /api/piezas/repetidas?cursor=…` exige la misma casilla, limita por propietario y devuelve `grupos` y `siguiente`. Cada página inspecciona hasta 80 candidatas (81 con el testigo de continuación); agrupa sin confundir grados y propone la etiqueta ED más antigua. El cursor es opaco para el cliente. Un grupo puede continuar en la siguiente página; la UI une sus miembros por ID. Las bandas y los descartados quedan fuera. El análisis de IA no asigna UPC: sólo usa el enviado por la captura. Fotos con UPC, captura manual del escáner, PATCH y cambios de grado comparten la guarda; la captura manual general que envía UPC se valida en la corrección y rechaza coincidencias sin dejar borrador vacío. Familias de banda e importación Wincaja no fijan UPC y son `sin_inventario`.

**Imagen de Target por UPC (#413, #524):** al escanear un UPC del manifiesto se busca una vez la imagen de su página de Target. Si esa página trae un solo `primary_barcode` y coincide con el UPC leído, la imagen queda **confirmada sola** (`confirmado_por = 'sistema'`) y se guarda como foto de las piezas de ese UPC que no tienen foto; el escáner no muestra «Es esta». Si la página no trae código verificable, la imagen queda como candidata y una persona la confirma con «Es esta». El cron de relleno confirma del mismo modo las candidatas verificadas que quedaron sin tocar. Una confirmación humana previa no se pisa, y la foto propia sigue teniendo prioridad: solo se llena `foto_key = ''`.

## Decisión de fondo

El escáner **no** es la herramienta de captura del vendedor: la cámara lo es. El análisis con IA
ocurre en segundo plano y puede fallar sin detener a nadie. El precio no se decide en el pasillo,
se decide desde el admin.

La fórmula de MarKit (`retailPrice()`: precio de mercado en USD × grado de condición × tipo de
cambio, piso de USD 9) **no se reutiliza**. Se escribió para el proyecto de personal shopper, con
comps de eBay y un piso que en El Dolarón mandaría casi toda la tienda a lote. Se trabaja en pesos,
sin tipo de cambio.

---

## 1. Triage al abrir el pallet (sin software)

| Montón | Regla | Destino |
| --- | --- | --- |
| Basura | Roto o invendible | Tirar o donar |
| Escanear | Todo lo demás | Foto en la app |

Toda pieza vendible que se fotografía lleva su etiqueta individual (§5). Lo que se
quiera etiquetar sin foto, ni análisis, va con una banda (§2).

## 2. Bandas

Detalle completo en `docs/PLAN-ETIQUETAS-POR-BANDA.md`. Resumen:

- Productos fijos en el POS — nueve precios ($19/$29/$49/$79/$99/$119/$129/$149/$199, desde el 4/10) ×
  las familias de banda (hoy 18, ver `PLAN-ETIQUETAS-POR-BANDA.md`). Sus catorce códigos de barras viven en una tarjeta
  laminada junto a la caja, como respaldo si el código pegado en la pieza no escanea.
- Impresión por lote desde `/bandas`, no por pieza: se elige cuántas etiquetas de una
  banda hacen falta y sale un solo trabajo. Las piezas nunca esperan su propia etiqueta.
- Sin foto ni etiqueta por pieza en el sentido de "propia": la pieza sí se fotografía y
  analiza (§1), pero termina compartiendo el código impreso de su banda, **sin conteo de
  existencias** — una bandera `sin_inventario` en el producto de catálogo, no un stock
  negativo.
- Las ventas sí se registran, para saber cuánto aportan las bandas.

## 3. App del vendedor: una sola pantalla

- La cámara **se abre y no se cierra**. Toca para disparar, dispara otra vez de inmediato. Sin
  preview que descartar, sin spinner, sin navegación.
- Solo MG usa el interruptor de grado **A · Nuevo / B · Dañado / C · Liquidación** (como LiquiMart, Issue #371) junto al obturador.
  A se ve nueva; B tiene uso, empaque dañado o piezas faltantes; C no cumple su función. El grado se imprime solo en la etiqueta de MG (Issue #453: letra A/B/C en un recuadro junto al precio, y la palabra en el pie
  si cabe; instrucción de Isaac, revierte la regla de #371); B y C no van a Mercado Libre ni al catálogo público. Conserva su estado entre disparos y también se
  puede corregir tocando la última miniatura.
- Tira de miniaturas abajo y un contador discreto: `24 fotos · 19 analizadas`. Es la única señal de
  que existe la IA.
- Una foto = una pieza.

En sandbox y producción, tocar una miniatura permite cambiar el precio final entre
$300/$200/$150/$120/$100/$80/$50 MXN y Nuevo/Dañado con «Guardar cambios», también después
de subir, mientras la pieza no tenga etiqueta. Con etiqueta (`codigo`) solo el dueño cambia el precio
(`autorizarPrecio`, #479): la miniatura guarda lo demás, deja el precio como está y crea una solicitud de
precio (#451) con el mensaje «Se pidió el cambio de precio al dueño»; el dueño la aprueba en «Precios por
revisar». La condición no recalcula ese precio elegido. «Eliminar captura»
descarta la captura completa tras un segundo toque; requiere conexión y no
elimina piezas con venta o publicación. El servidor limita estas operaciones
a capturas propias de las últimas 24 horas. Si ya salió una etiqueta, reemplazarla
cuando cambie el precio o descartarla cuando se elimine la captura.

«Reintentar análisis» sobre una pieza ya revisada (`listo`) no la sobrescribe (#479): el análisis guarda
`precio_sugerido` y, si el precio difiere, crea una solicitud de precio (autor: quien reanalizó, o `ia` si el
resultado llegó tarde tras una corrección). Revisar responde «Sugerencia enviada para aprobación».

En el celular (Chrome de Android) la etiqueta se imprime desde /inventario (Issue #440): «Conectar impresora» en el chip,
una etiqueta por pieza en existencia al guardar, +1 imprime 1 (Sumar N imprime N), y la pestaña Imprimir y Reimprimir funcionan como en la PC.
Los capturistas también imprimen desde su celular. La PC y el celular no repiten la misma etiqueta (reclamo en D1; ver
`docs/ARQUITECTURA-ESCANER.md`). Si no sale, la pieza queda pendiente y se reimprime.

### Reglas que no se negocian

1. **La foto se guarda local antes que nada** (IndexedDB), antes de subirla o analizarla. Es lo único
   que no se puede rehacer sin volver al anaquel.
2. Se reduce a **1024 px de lado mayor, JPEG 0.8, una sola copia**. Alcanza para IA, etiqueta y
   catálogo futuro.
3. El análisis corre **de uno en uno** en segundo plano, con reintento. Nunca en ráfaga: una ráfaga
   tumba el límite de la API a media tanda.
4. Sin conexión, las fotos se acumulan. La captura nunca depende de la red.
5. Un análisis fallido deja un borrador con su foto y campos vacíos. El vendedor no ve el error.

## 4. Contrato de datos del borrador

Local, propio de este repositorio. No se copia el modelo de MarKit.

| Campo | Origen |
| --- | --- |
| `id`, `creado_en` | App |
| `foto` (1024 px) | Cámara, guardada local primero |
| `estado_fisico` | `nuevo` (A) \| `danado` (B) \| `liquidacion` (C), del interruptor de MG; Ropa envía `nuevo` silenciosamente |
| `estado_analisis` | `pendiente` \| `listo` \| `error` |
| `nombre`, `categoria`, `precio_lista` | IA, editable en el admin |
| `precio` | Calculado (§5), editable en el admin |
| `destino` | `etiqueta` \| `banda_r19` … `banda_r199` \| `banda_g19` … `banda_g199` |

`precio_lista` es lo que costaría **nuevo en México**, en pesos, estimado por la IA. El costo real de
la pieza es desconocido y **nunca se infiere** (issue #2). No hay precio por costo más margen.

## 5. Cálculo del precio

```
precio = precio_lista × %categoria × (estado_fisico == 'danado' ? %danado : 1)
         (liquidacion: precio_lista × %liquidacion, 20 % por defecto, sin %categoria ni sugerencia de IA)
precio = redondear hacia arriba al múltiplo de $5
precio = al múltiplo de $10 más cercano (de $5 en adelante sube) menos $1, mínimo $9 ($233 → $229, $235 → $239, $250 → $249, $12 → $9)
destino = etiqueta individual, siempre (las bandas ya no son destino automático)
```

- Nunca por encima de `precio_lista`.
- Todos los porcentajes viven en la configuración del admin, ninguno en el código.
- Arranque confirmado por Isaac (2026-09-11, límite de banda actualizado 2026-09-24):
  **50 % para todas las categorías**, **60 % para dañado**, límite de banda **$200**.
  Todas las categorías empiezan igual a propósito: las diferencias se ajustan con
  ventas reales, no con suposiciones. Son valores editables desde el admin, no
  constantes en el código.

## 6. Admin

### Configuración
Una pantalla, una tabla: porcentaje por categoría (ropa, hogar, electrónica, juguetes, otros),
porcentaje de dañado, límite de banda y los nueve precios de banda (compartidos por todas las familias).

### Cola de revisión
Lo capturado, con foto y precio sugerido. Editar cualquier precio o campo, marcar a una banda
específica, descartar. Los borradores esperan ahí el tiempo que haga falta: ese hueco **es** el
búfer entre la llegada del pallet y la salida al piso.

### Impresión de etiquetas
Individual, por lote desde el escritorio, solo para las piezas con `destino = etiqueta` (> $200):
nombre, precio, `precio_lista` tachado cuando aplique, código Code128 y la **semana de ingreso**
(`S37`). La semana se imprime desde el día uno aunque todavía no se use: habilita las rebajas por
antigüedad sin reetiquetar nada. Las bandas se imprimen aparte, por lote y sin pieza asociada,
desde `/bandas` (`docs/PLAN-ETIQUETAS-POR-BANDA.md`).

## 7. Límites de este alcance

- Sin credenciales, sin servicios de pago ni publicación en redes; producción requiere autorización explícita.
- Un solo maestro de existencias. Ningún otro lugar guarda una cantidad.
- Sin segunda fórmula de redondeo ni de precio en ningún otro archivo.

## 8. Validación (con hardware real, no capturas)

1. Diez piezas fotografiadas seguidas sin que la cámara se cierre ni se bloquee.
2. Matar la red a media tanda: no se pierde ninguna foto; al volver la conexión se analizan solas.
3. Una pieza dañada y una nueva del mismo artículo dan precios distintos según la tabla del admin.
4. Una pieza que calcula $55 aparece marcada con una banda y no imprime etiqueta propia.
5. La etiqueta impresa a tamaño real se lee con el lector de código de barras.
6. Las catorce bandas se cobran en el POS sin tocar existencias.

## 9. Diferido a propósito (no construir todavía)

- Niveles de demanda (alta / media / baja) y precio por tipo de artículo.
- Rebajas por semana de ingreso aplicadas en el POS.
- Reporte de días en venta por categoría, para ajustar los porcentajes con datos.
- Varias fotos por pieza, talla y color, publicación en eshop o marketplace.

Cada uno entra con su propio Issue, cuando haya ventas reales que lo justifiquen.

## Ropa sin grados (Isaac, 23/10/2026; #458/#459)

A/B/C pertenece solo a Mercancía General. Ropa se identifica por `categoria='ropa'` en las piezas del servidor y por `precio_ropa` no nulo en la cola local. Las nuevas capturas de Ropa usan el valor predeterminado `estado_fisico='nuevo'` sin mostrar A: la columna es `text not null default 'nuevo'` y la validación de servidor acepta `nuevo|danado|liquidacion`. No se agrega migración ni se normalizan datos históricos.

En `/inventario`, Ropa oculta grado en captura móvil/PC, corrección de miniatura local o subida, ficha, Revisar (filas, grupos solo de Ropa y Avanzado) y alta sin foto. Buscar conserva filas sin grado. La barra móvil queda con disparo centrado y cantidad; debe pasar QA en 360×640, 412×740 y 390×844.

Las etiquetas de Ropa no imprimen recuadro, letra ni palabra de grado, también en reimpresiones de Buscar/ficha, Imprimir y `/etiquetas`; las de MG los conservan. `/api/etiquetas` incluye `categoria`. Un estado físico histórico de Ropa no genera aviso ni reimpresión por grado; nombre, talla y precio siguen invalidando la etiqueta. Las reglas #452 por propietario + UPC normalizado + estado físico se conservan en servidor; la UI no filtra Ropa por el grado elegido para MG.
