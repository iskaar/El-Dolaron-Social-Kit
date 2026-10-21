# Imagen de referencia al escanear

Issue #367. Extiende la captura del manifiesto de #365. No necesita volver a descargar
la hoja de Google: `manifiesto.tcin` ya identifica el enlace
`https://www.target.com/p/-/A-<TCIN>`.

## Flujo

1. `/escanear` conserva el texto leído, incluidos ceros iniciales. Solo la clave para
   buscar en el manifiesto ignora esos ceros, porque así se importó la hoja. La nueva
   captura guarda el texto original en `productos.upc`; no se reescriben filas antiguas.
2. Busca primero una foto propia en el catálogo de El Dolarón, aunque su stock sea cero.
   No consulta fotos de FEP ni modifica existencias.
   Si un UPC ya identificado y listo no está en la hoja, su identidad y precio de lista
   salen del catálogo del servidor. Una pieza con precio manual sin precio de lista
   conserva ese precio manual. El cliente nunca autoriza su propio precio.
3. Después busca una referencia del mismo UPC y TCIN en `imagenes_upc`. Un cambio de
   TCIN en la hoja invalida la referencia anterior sin tocar la foto propia.
4. Sin imagen guardada, el Worker abre el enlace Target del TCIN y lee `og:image`,
   `og:title` y `primary_barcode` de la página. El precio
   y el nombre de etiqueta siguen saliendo del manifiesto; el nombre original del
   proveedor se muestra junto a la imagen para revisarla.
5. «Confirmar imagen» registra usuario y fecha. Antes de ese toque no se reutiliza como
   confirmada. Si la página no declara UPC, lo indica para revisión manual. Un UPC
   declarado distinto se rechaza. La confirmación no crea inventario ni cambia stock.
6. «Continuar sin imagen», «Tomar otra foto» y «Subir foto» permiten seguir. La foto
   propia se guarda primero en IndexedDB, en la cola compartida con Fotos, con el mismo
   UUID en los reintentos. El código y la cantidad acompañan la foto. Un producto ya
   identificado en el catálogo o manifiesto conserva su identidad y precio sin otro análisis; uno desconocido sigue
   el análisis habitual de Fotos. Las fotos pendientes también aparecen en `/captura`.

El contador, el lector USB/Bluetooth y los formatos de cámara de #365 se conservan.
La imagen no detiene el guardado automático (#383): se confirma mientras la pieza sigue abierta.
Guardar explícitamente o escanear otra pieza puede guardar el inventario sin confirmar
una imagen. El escáner sigue abierto durante la búsqueda; una respuesta tardía no cambia
la ficha de otra pieza.

## Almacenamiento y permisos

Las fotos propias siguen en R2. La imagen externa se conserva como **referencia URL**
en D1, con su TCIN, nombre original, UPC declarado y confirmación. Se muestra en el
escáner interno; no se convierte en `foto_key` ni se envía automáticamente al sitio
público o a Mercado Libre. El enlace externo puede caducar y las fotos propias tienen
prioridad. Las condiciones y los derechos de imágenes de Target siguen siendo aplicables.

Las rutas `/api/manifiesto/:upc/imagen` (GET/POST/PUT) y
`/api/manifiesto/:upc/imagen/catalogo` (GET) pasan por Access y el rol de captura existente.
El portal público no las sirve.
Los enlaces salen del TCIN guardado en servidor; no se aceptan URLs arbitrarias del cliente.

## Consulta a Target y verificación humana

El Worker abre `https://www.target.com/p/-/A-<TCIN>` directamente, sin navegador ni servicio
aparte (se probó desde Cloudflare: 200 con imagen y título). Se identifica con su propio
user-agent, no envía cookies ni sesiones del personal y no sigue redirecciones. Solo consulta
un UPC cuando alguien lo escanea sin imagen guardada; después queda en caché en D1.

Muestreo del 2026-10-21: 17 de 28 TCIN al azar tenían página con imagen; los demás dan 404
porque Target ya no los lista. Para esos queda tomar o subir foto.

Target usa HUMAN («mantén presionado»). **No se resuelve automáticamente**: es una barrera
deliberada del sitio. Si la respuesta es 403/429 o trae el reto, el Worker deja de consultar
Target 30 minutos (por isolate) y la pantalla pide hacerlo a mano: «Ver producto original»
abre la página en el teléfono, la persona pasa la verificación, guarda la imagen y la sube con
«Subir foto». Si el bloqueo se vuelve frecuente, guardar la pausa en D1 y revisar el volumen.

## Activación (Isaac)

1. La migración 044 y el manifiesto de #365 deben estar presentes.
2. Ejecutar la migración **045** antes del Worker, primero en sandbox y luego en producción.
   Los comandos exactos están en `app/migracion-045-imagenes-upc.sql`. Es aditiva y
   compatible con el Worker anterior.
3. Desplegar el Worker correspondiente. No hay secretos ni servicios que configurar.
4. Probar el ejemplo de Isaac, otro UPC con cero inicial y un TCIN que ya no exista. Validar
   confirmación, segundo escaneo sin llamada externa, cambio de TCIN, fallback de foto y
   recuperación sin conexión. Lector/cámara/impresora físicos siguen pendientes de prueba.

## Comprobaciones locales

Desde raíz: `python tools/validate_assets.py`.
Desde `app/`: `npm test`, `npm run typecheck`, `npm run db:local` sobre una base nueva.
Los tests HTTP/SQLite verifican confirmación, fuente cambiada, roles/host, datos inválidos,
foto propia, código original y reintento sin reponer stock; los tests de la pantalla
verifican conservación del código, confirmación explícita y foto retenida ante fallo.
