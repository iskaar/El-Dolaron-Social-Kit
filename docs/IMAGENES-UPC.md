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
4. Sin imagen guardada, el Worker pide un candidato al extractor Scrapling. El precio
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
La pausa de guardado automático espera mientras carga un candidato o falta confirmarlo.
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
El portal público no las sirve. El navegador no recibe el token del extractor.
Los enlaces salen del TCIN guardado en servidor; no se aceptan URLs arbitrarias del cliente.

## Preparación del extractor

Scrapling es Python y se ejecuta fuera de Workers. Esta entrega añade el servicio y su
Dockerfile, pero no crea hosting, tokens ni despliegues remotos. Requiere Python 3.10+.

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r tools/scrapling/requirements.txt
.venv\Scripts\scrapling install
.venv\Scripts\python tools/scrapling/servidor.py --check https://www.target.com/p/-/A-94882460 --barcode 8438051051054
```

Para servir: definir `SCRAPLING_TOKEN` en el entorno del proceso, mínimo 32 caracteres
aleatorios, y ejecutar `python tools/scrapling/servidor.py`. Escucha en el puerto 8000
o `PORT`; `GET /health` permite comprobarlo. En hosting usar HTTPS delante del proceso,
sin exponer directamente el puerto HTTP. El contenedor se construye con
`docker build -t viste-scrapling tools/scrapling` y recibe el token mediante el entorno.
No poner el token en código, argumentos, logs o git. Nunca pasar cookies de Access al proveedor.

El servicio solo admite URLs Target de producto y devuelve JSON pequeño. Hace una consulta
a la vez; el exceso responde 429. Renderizar JavaScript queda de respaldo cuando HTML no
alcanza, con una sola tentativa y sin resolver CAPTCHAs. La red del navegador queda
limitada a Target y su servidor de imágenes. Un bloqueo o falta de imagen deja disponible
la captura propia.

## Activación (Isaac)

1. La migración 044 y el manifiesto de #365 deben estar presentes.
2. Ejecutar la migración **045** antes del Worker, primero en sandbox y luego en producción.
   Los comandos exactos están en `app/migracion-045-imagenes-upc.sql`. Es aditiva y
   compatible con el Worker anterior.
3. Alojar el extractor y configurar `SCRAPLING_URL` (URL HTTPS completa terminada en
   `/lookup`) y `SCRAPLING_TOKEN` como secretos del Worker. El token coincide con el del
   proceso Python. Usar configuración y token separados por entorno. `wrangler secret put`
   con `--config wrangler.sandbox.jsonc` apunta al sandbox; sin esa opción, a producción.
4. Desplegar el Worker correspondiente. Sin el servicio, las fotos propias y referencias
   existentes funcionan y la búsqueda nueva explica que falta configuración.
5. Probar el ejemplo de Isaac, otro UPC con cero inicial y un enlace sin imagen. Validar
   confirmación, segundo escaneo sin llamada externa, cambio de TCIN, fallback de foto y
   recuperación sin conexión. Lector/cámara/impresora físicos siguen pendientes de prueba.

## Comprobaciones locales

Desde raíz: `python tools/validate_assets.py` y
`python -m unittest discover -s tools/scrapling -v` (con Scrapling instalado).
Desde `app/`: `npm test`, `npm run typecheck`, `npm run db:local` sobre una base nueva.
Los tests HTTP/SQLite verifican confirmación, fuente cambiada, roles/host, datos inválidos,
foto propia, código original y reintento sin reponer stock; los tests de la pantalla
verifican conservación del código, confirmación explícita y foto retenida ante fallo.
