# Captura por UPC desde el manifiesto del proveedor

Issue #365. Estado: implementado en la rama `agent/claude/365-manifiesto-upc`; falta correr
la migración 044 y la primera carga en sandbox y producción.

## Qué pidió Isaac (2026-10-20)

El manifiesto del único proveedor (Liquidation Pros, hoja de Google "Target Truckloads
Available") es la **fuente de verdad** del producto: escanear el código de barras, poner
la cantidad e imprimir las etiquetas. La foto + IA queda solo para lo que no esté en el
manifiesto. Isaac va a la bodega y se lleva lo que haya disponible, así que no se sabe de
antemano de qué camión sale cada pieza: se busca contra **todos** los camiones.
Más adelante: quitar la etiqueta física y cobrar con lectores y teléfonos (fuera de este Issue).

## Lo que hay en la hoja (revisado 2026-10-20)

- 34 pestañas `Truck <id>`, ~215 mil renglones, ~530 mil piezas, **73,441 UPC únicos**.
  La pestaña "Full Manifest" es una vista filtrada: no sirve como fuente.
- Por renglón: descripción corta de Target ("GG GUMMY FOOD TRUCK 7OZ"), cantidad, precio
  de lista de Target en **USD**, TCIN, DPCI, UPC, grupo/división/departamento (150
  departamentos; ~17 % vacíos o "Not provided"), clase de ropa.
- "View photos" = `https://www.target.com/p/-/A-<TCIN>` (la página del producto en Target).
- Marca vacía en toda la hoja: viene abreviada dentro de la descripción.
- ~10 mil UPC aparecen con descripción o precio distinto entre camiones.
- Se descarga como CSV sin iniciar sesión (cualquiera con el enlace puede leerla).

## Cómo funciona

Extensión de imágenes de referencia: [Issue #367 y preparación](IMAGENES-UPC.md).
La clave histórica del manifiesto sigue normalizada; las nuevas capturas conservan
el código completo leído, con sus ceros iniciales, en `productos.upc`.

1. **Carga** — `python tools/importar_manifiesto.py sandbox|produccion|local`. Baja cada
   pestaña `Truck <id>` listada en "Available Truckloads", deja un renglón por UPC (gana la
   versión más repetida; empate → precio más alto) y escribe en `manifiesto` **solo lo nuevo
   o cambiado**: la primera vez son ~73 mil escrituras, después la diferencia. Se corre a mano
   cuando la hoja cambie. `--prueba` corre su comprobación.
2. **`/escanear`** — el lector (USB/Bluetooth teclea el número y Enter) o la cámara del
   teléfono (Chrome de Android) lee el código. `GET /api/manifiesto/<upc>` regresa nombre,
   categoría, precio de Target, precio de lista, precio de venta y el enlace a Target.
3. **Guardar** — `POST /api/borradores/upc {id, upc, stock, estado_fisico}`. Pasa por el
   mismo camino que la captura sin foto (Issue #115): pieza `listo`, código `ED-`, y sale en
   `/etiquetas` con una etiqueta por pieza. **El precio sale del manifiesto en el servidor**;
   el cliente solo manda cantidad y estado.
4. **Sin match** — 404 "captura la pieza con foto".
   Desde el Issue #373 el escáner no detiene al capturista: al pasar a la siguiente pieza (o a los
   10 s) manda `POST /api/borradores/upc/buscar {id, upc, stock, estado_fisico}`. La pieza nace
   `pendiente` con su código y cantidad y el Worker, en `waitUntil`, le pregunta a Gemini por Vertex
   con búsqueda de Google **solo el código** (sin foto). Con nombre seguro (confianza ≥ 0.5) y
   precio queda `listo` con código `ED-` y la impresión automática la toma en seguida.
   Si no, queda `error`: el escáner (que consulta `GET /api/borradores/upc/:id` cada 4 s) pone la
   fila en rojo y al tocarla abre la foto de esa misma pieza; la foto pasa por el análisis normal
   y nunca duplica ni repone stock. Mientras esa pieza espera, la cola automática se detiene en
   ella para no cambiar el orden de la mesa.

Cada escaneo guardado es una pieza nueva, aunque el UPC ya exista: `/etiquetas` imprime
`stock` etiquetas al aparecer la pieza, y subirle el stock a una ya impresa no imprime las
nuevas. Las repetidas se juntan con la fusión de siempre si hace falta.

**Impresión automática y corrección (Issues #369, #375, #377, #381).** La impresión automática de
`/etiquetas` también toma lo escaneado (`productos.upc` con código, o vacío si se dio de alta solo con
foto, #379). La cantidad se cierra en el escáner: la pieza abierta se guarda a los 25 s sin escanear, al
escanear otro código o con «Guardar»; mientras está abierta se corrige y en 0 se cancela. Ya guardada y
`listo`, sale en la siguiente consulta (cada 3 s, #383) y el servidor ya no acepta cambios desde el escáner. Lo
que aún se identifica o espera foto conserva − y + (en 0 se cancela) y no detiene la cola.

## Decisiones

1. **Nombre (Isaac, 2026-10-20): traducido con IA** al formato de la tienda
   ("Gomitas Good & Gather Food Truck 198 g"), una vez por UPC. Se traduce la **primera vez
   que se escanea** (no los 73 mil al cargar): mismo resultado, solo se paga lo que entra a
   la tienda y el importador no necesita llave de IA. La traducción también pone marca y
   categoría. Si falla, la pantalla usa la descripción de Target y el siguiente escaneo
   reintenta. Usa Claude (`conClaude`); el sandbox no tiene llave de Claude, así que ahí los
   nombres salen en inglés.
2. **Quién captura (Isaac, 2026-10-20):** el capturista también. FEP (finanzas) no: el
   manifiesto es de El Dolarón.
3. **Precio (Isaac, 2026-10-20):** `precio_lista = precio Target USD × tipo_cambio`
   (`config.tipo_cambio`, centavos MXN por dólar, editable en el admin; sin él la captura
   por UPC responde 409). De ahí, las reglas de siempre (`calcularPrecio`). El precio
   investigado en México (búsqueda web, una vez por UPC) lo reemplaza cuando Vertex responda
   a tiempo (Issue #363). Costo estimado: $14 USD por 1,000 búsquedas después de 5,000
   gratis al mes, 1–3 búsquedas por UPC.

## Fuera de alcance

- Cobrar en caja con el UPC de fábrica (hoy la caja lee `ED-`/bandas). Es lo que permite
  medir qué se vende y, después, quitar la etiqueta física.
- "Calor" del producto (velocidad de venta) y rebajas por antigüedad.
- Bajar fotos de Target para Mercado Libre (son imágenes de Target).
- Tallas desde la descripción ("Black 46C", "XL").
