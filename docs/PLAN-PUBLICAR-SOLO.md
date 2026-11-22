# Publicar solo: fotos profesionales, feed de productos y piloto automático de Mercado Libre

Issue #886 · 22/11/2026 · Estado: **diseño en espera de aprobación de Isaac**. Nada de esto está implementado.
Este documento detalla el Proyecto 1 (fotos). Los Proyectos 2 a 4 tienen aquí solo su alcance; cada uno
tendrá su propio diseño antes de construirse.

## Qué pidió Isaac y por qué

«What I need is to have a tool that lets us automatically publish our products» (22/11/2026). Quiere que las
piezas salgan a Mercado Libre y a otros canales sin que alguien arme cada publicación, con fotos que se vean
profesionales: la IA **no genera el producto**, cambia el fondo y lo deja nítido; una segunda imagen muestra
sus características principales. Aparte pidió un precio más exacto.

El porqué: hoy publicar es un trabajo a mano por pieza y la foto de anaquel no vende en línea. El 30/10 (#628)
Isaac rechazó los recortes crudos («hideous») y aprobó las portadas hechas con IA imagen-a-imagen («love it»);
aquello se hizo a mano con agentes y créditos de Higgsfield.

## Línea base (producción, solo lectura, 22/11/2026)

| Paso | Piezas |
|---|---|
| Vendibles en línea (`VENDIBLE`: Soledad o sucursal) | 2,794 |
| …con imagen oficial ya limpia (`recorte_estado = 'original'`, todas con UPC) | 790 |
| …con foto propia de anaquel | 2,004 |
| Publicables en Mercado Libre (`PUBLICABLE`: existencia en Soledad) | 2,662 |
| …precio de tienda ≥ $275 (umbral de `MERCADOLIBRE-ESTRATEGIA.md`) | 121 |
| …de esas, ya vivas en Mercado Libre | 30 |
| …de esas, con código de barras | 41 |
| …de esas, con confirmación en piso (#724: stock ≥ 3 o escaneada) | 7 |

- Mercado Libre: 61 activas, 33 pausadas, 20 en error (14 «GTIN obligatorio», 5 foto < 500 px), 4 ventas en total.
- Solo 23 piezas con existencia no tienen foto: falta calidad, no fotos.
- La app ya propone categoría, ficha, precio y diagnóstico de foto (`preparar` en `mercadolibre.ts`); una persona
  revisa y toca publicar. Volver automático ese toque publicaría entre 4 y 7 piezas con las reglas de hoy.

## Metas

1. Toda pieza vendible con foto de anaquel tiene una portada de estudio (fondo blanco, cuadrada, 1200×1200)
   sin que nadie la edite.
2. La portada es **la misma pieza**: mismo texto, logos, color y forma. Lo que no pasa la comprobación no se publica solo.
3. El costo por imagen se mide con datos reales y tiene un tope diario que Isaac controla.
4. El personal ve una lista corta de lo que necesita foto nueva, en vez de descubrirlo al publicar.

## No-metas (de este proyecto)

- Cambiar lo que muestran el sitio y el portal. Siguen con su foto o recorte; el feed (Proyecto 2) decidirá.
- Publicar en algún canal. Este proyecto solo deja la foto lista.
- Traer imágenes oficiales de otras tiendas (#513 sigue aparte) o pasar por IA las 790 que ya son oficiales.
- Subir de resolución o «mejorar» fotos que no muestran bien la pieza: esas se retoman.

## Anti-metas (sería un fracaso aunque funcione)

- Una portada que muestre algo que la pieza no es: texto inventado, partes agregadas, otro color.
- Gasto sin tope o sin registro, o una imagen ya pagada que se pierde.
- Reemplazar o borrar la foto original, o borrar sin que una persona lo decida las portadas hechas a mano en #628.
- Que una falla del proveedor de imágenes frene la captura, la caja o el inventario.

## Restricciones

- `app/AGENTS.md`: sin dependencias ni servicios nuevos; migración nueva y aditiva; D1 es el maestro; no tocar
  stock, precio ni `estado_analisis`.
- La app ya tiene `VERTEX_API_KEY`, un cliente de Gemini (`consultarGemini` en `analisis.ts`), el binding
  `IMAGES`, R2 `FOTOS` y el cron de 15 minutos. Se reutilizan.
- Un Worker no tiene canvas: no puede dibujar texto sobre una imagen sin una dependencia o un servicio nuevo.
- Mercado Libre castiga texto, precio o logos en la **portada** (`poor_quality_thumbnail`). Si admite texto en
  fotos secundarias en México no está confirmado.
- En Mercado Libre la portada solo cuenta en publicaciones tradicionales: con un producto de catálogo elegido,
  `publicar` no sube fotos propias. En #628 ninguna de las 8 piezas con UPC tuvo coincidencia real de catálogo,
  así que casi todo sale tradicional. La portada sirve además al feed.
- El deploy y las migraciones remotas las corre Isaac. El sandbox sí lo puede desplegar el agente.

## Caminos considerados

| Camino | Qué es | Alcance hoy | Por qué sí o no |
|---|---|---|---|
| A. Piloto automático de ML | La pieza se publica sola al cumplir foto, código y piso | ~90 piezas | Poco trabajo, reutiliza todo; no alcanza al 95 % barato |
| B. Feed de productos | Lista al día que leen Meta, WhatsApp y Google | ~2,800 piezas | Sin comisión ni piso de precio; pide conectar un catálogo de Meta |
| **C. Los dos** | Comparten la foto y la comprobación de «lista» | Todo | **Elegido por Isaac el 22/11** |

Orden acordado: 1 fotos, 2 feed, 3 piloto automático de ML, 4 precio.

## Proyecto 1: fotos profesionales

### Qué produce

- **Portada publicada**: `extras/{id}/01.jpg` en R2, JPEG 1200×1200, fondo blanco. Es la convención de #589:
  Mercado Libre ya sube `extras/` antes de la foto propia y usa la primera como miniatura, sin leer ningún estado.
  Por eso **solo una portada aprobada llega a `extras/`**.
- **Portada en espera**: lo que el modelo generó y todavía no está aprobado vive en otra llave
  (`portadas/{id}.jpg`), fuera de `extras/`.
- **Estado en D1** (migración aditiva, siguiente número libre), con un índice parcial para la cola como el de recortes:
  - `portada_estado`: `null` pendiente, `lista`, `revisar`, `retomar`, `oficial`, `error`.
  - `portada_origen`: `ia` o `manual`.
  - `portada_fecha` y `portada_revision` (JSON con `problemas`).
- La foto original (`foto_key`) no se toca nunca.

### Flujo (cron de 15 minutos, apagado por omisión)

1. Si `config.portadas_activo` no es `'1'` o el tope del día se agotó, salir.
2. Tomar pocas piezas `VENDIBLE` con `portada_estado is null`, **las más caras primero**. Es el mismo universo
   del feed; incluye piezas que solo están en una sucursal.
3. Sin generar ni gastar:
   - `recorte_estado = 'original'` → `oficial`. Ya es una imagen de estudio; no se pasa por IA.
   - Ya existe `extras/{id}/01.jpg` (las portadas hechas a mano en #628, unas 48) → `lista`, origen `manual`.
4. Generar: una llamada al modelo de imagen de Gemini por Vertex con la foto original y una instrucción fija:
   foto de estudio sobre blanco puro, cuadrada, mismo producto, sin cambiar texto, logos, color ni forma, sin
   inventar partes, sin manos, ganchos ni etiquetas de precio de la tienda. El resultado se guarda de inmediato
   en `portadas/{id}.jpg`: una imagen pagada no se pierde por un fallo posterior.
5. Comprobar fidelidad: una llamada a Claude con la original y la portada **a resolución completa** (no la
   miniatura de 512 px que usa la revisión de recortes: aquí hay que leer letras). Responde `ok`, `problemas`
   y si el defecto viene de la foto original (pieza tapada, etiqueta de precio pegada sobre el producto, foto
   equivocada o muy borrosa).
6. Resultado:
   - `ok` → `lista`, origen `ia`, y la imagen pasa a `extras/{id}/01.jpg` con put condicional. Mientras
     `config.portadas_aprobacion` sea `'1'` (así arranca), en vez de eso queda en `revisar` con veredicto `ok`
     para que una persona la apruebe con un toque.
   - No `ok` por la generación → un solo reintento con los problemas en la instrucción; si vuelve a fallar, `revisar`.
   - No `ok` por la foto original → `retomar`.
   - Falla del proveedor o de cuota (incluida la 9422 de `IMAGES`) → salir sin marcar; la siguiente corrida
     retoma desde lo que ya está en `portadas/`. Otro error → `error`.
7. Si la pieza recibe foto nueva: con origen `ia`, la portada se borra y `portada_estado` vuelve a `null`
   (como `reiniciarRecorte`); con origen `manual`, la portada se conserva y la pieza pasa a `revisar`.

### Por qué arranca con aprobación humana

Diez piezas de piloto no dicen cada cuánto la comprobación deja pasar una portada mala. Con
`portadas_aprobacion = '1'` cada portada que la comprobación da por buena espera un toque humano; las que la
persona rechace miden ese error. Isaac lo apaga cuando el dato le dé confianza. Es condición para el Proyecto 3,
que publicará sin que nadie mire. Si el error es alto, se cambia a un modelo más fuerte para comprobar.

### Costo y control

- Cada llamada registra en el log los tokens que devuelve el proveedor (`usageMetadata`); el costo sale de esos
  tokens por la tarifa pública. Hoy la app no registra tokens en ningún lado: es nuevo.
- Tope diario de imágenes generadas en `config` (propuesta: 100 al día), con contador atómico como el de
  UPCitemdb (`gastarConsultaUpcitemdb`).
- Encender, apagar, cambiar el tope y quitar la aprobación son filas de `config` que Isaac cambia con una línea
  de SQL documentada en la migración, igual que `recortes_activo`. Sin pantalla por ahora.
- Estimación (fuentes de terceros, sin verificar en la página de Google): US$0.03 a US$0.10 por imagen según
  modelo y tamaño; con comprobación y ~25 % de reintentos, US$0.07 a US$0.15 por portada. Las piezas caras:
  menos de US$20. Las 2,004 con foto propia: US$140 a US$300, una vez. Con tope de 100 al día, a lo más ~US$15 diarios.

### Revisión humana

En `/admin`, junto a la revisión de recortes y con el mismo patrón (`rutaRecortesAdmin`):

- **Portadas por revisar** (`revisar`): original y portada lado a lado, con el veredicto y los problemas.
  Botones: Aprobar, Generar otra, Retomar foto.
- **Fotos por retomar** (`retomar`): lista con código y motivo, para que alguien tome la foto de nuevo.
- **Portadas listas recientes** (`lista`): para quitar una que salió mal. Botones: Rechazar (sale de `extras/`
  y vuelve a `revisar`), Generar otra, Retomar foto.

Roles y host: los de la revisión de recortes (Access, dueño o capturista, solo El Dolarón).

### Segunda imagen: tarjeta de características

Pedido explícito de Isaac. Tiene dos partes y va **después** del piloto de portadas:

1. **Características**: hasta cinco datos cortos y comprobables por pieza (qué es, cantidad o medida, talla,
   edad, material), guardados en D1. Fuente: la descripción del manifiesto si hay UPC; si no, lo legible en la
   foto y el nombre. Regla de #723: la IA no escribe nada que no conste en la fuente. Es el mismo dato que #723
   quiere para la descripción; se construye una vez y sirve a la tarjeta, al feed y a Mercado Libre.
2. **Tarjeta**: `extras/{id}/02.jpg`, la portada con esos datos al lado. Como el Worker no dibuja texto, la
   genera el mismo modelo de imagen con el texto exacto, y una segunda lectura comprueba que el texto de la
   imagen es idéntico al de D1; si no coincide, la pieza se queda sin tarjeta (sigue lista con su portada).
   Nunca es la primera foto.

Condición para mandarla a Mercado Libre: leer la regla oficial vigente de moderación de imágenes y observar una
publicación real con tarjeta como foto secundaria, en una pieza de bajo riesgo que Isaac elija. El diagnóstico
de #564 no sirve para esto: solo se llama como miniatura y su respuesta nunca se confirmó con la cuenta real.
Si Mercado Libre la modera, la tarjeta queda para los canales que la acepten.

### Piloto y criterio de salida

1. Implementar el flujo de portadas apagado y desplegarlo en **sandbox**. El sandbox ya tiene los secretos
   `VERTEX_API_KEY` y `ANTHROPIC_API_KEY` (nombres verificados el 22/11) pero no las fotos: su R2 no se copia.
   El agente copia a mano 10 fotos de producto de producción al R2 del sandbox (son fotos de mercancía, sin
   datos de personas) y crea o reutiliza sus piezas ahí.
2. Diez piezas variadas: caja, juguete suelto, prenda, cosmético, una con etiqueta de precio encima del
   producto y una con texto pequeño.
3. Entregar a Isaac una hoja de contacto (original, portada, veredicto de la comprobación) y el costo real por
   imagen calculado con los tokens registrados.
4. Isaac aprueba encenderlo en producción, ajusta la instrucción o lo detiene.

Sale bien si: Isaac aprueba al menos 8 de 10 portadas que la comprobación dio por buenas, ninguna de esas
cambia texto o logos, y el costo medido cabe en la estimación.

### Medición después de encender

Por semana: portadas `lista` / `revisar` / `retomar` / `error`, costo real, y cuántas que la comprobación dio
por buenas rechazó una persona.

### Issues hijos del Proyecto 1

| # | Qué | Depende de |
|---|---|---|
| 1a | Portada con IA: migración, cron, comprobación, tope y registro de costo (apagado) | — |
| 1b | Piloto en sandbox: 10 piezas, hoja de contacto y costo real | 1a |
| 1c | `/admin`: portadas por revisar, fotos por retomar y listas recientes | 1a |
| 1d | Características por pieza (parte de #723) y tarjeta | 1b aprobado |

### Queda al constructor

- Identificador exacto del modelo de imagen en Vertex y forma de la llamada (verificar en la documentación
  vigente y en sandbox que `VERTEX_API_KEY` puede usarlo). Si no puede, detenerse y escalarlo en el Issue.
- `consultarGemini` no sirve tal cual: no se exporta, fija el modelo de texto, corta a 22 s, agrega
  `thinkingConfig` y su tipo de respuesta no trae imagen ni tokens. Hay que parametrizarlo (modelo, plazo,
  respuesta) sin cambiar el comportamiento de quienes ya lo usan.
- `conClaude` manda siempre `image/jpeg`: si el modelo devuelve PNG hay que convertirlo antes de comprobar.
- Pedir la imagen ya cuadrada para depender lo menos posible de `IMAGES`.
- Tamaño de lote por corrida y si conviene la cola existente en vez del cron.
- Texto exacto de las instrucciones de generación y de comprobación; se afinan en el piloto.
- Nombres de columnas, índice, llaves y rutas, siguiendo los de recortes.

### Decisiones de Claude (Isaac puede corregirlas)

- La portada vive en `extras/{id}/01.jpg`; las de #628 se conservan como `manual`.
- Las 790 piezas con imagen oficial no pasan por IA.
- Universo `VENDIBLE`, orden por precio, tope de 100 al día, apagado hasta que Isaac apruebe el piloto.
- Arranca con aprobación humana de cada portada; Isaac la quita cuando confíe en la comprobación.
- Un reintento automático; después decide una persona.
- Encendido y tope por SQL, sin pantalla.
- Copiar 10 fotos de producto de producción al sandbox para el piloto.
- La comprobación de «lista para publicar» de este proyecto es solo la de la foto. La lista de «qué le falta a
  cada pieza» (código, piso, precio mínimo) se construye con el piloto automático de ML, que es quien la usa.
- La tarjeta la dibuja el modelo de imagen con lectura de comprobación; cuesta más o menos lo mismo que una portada.
- Sitio y portal no cambian en este proyecto.

## Proyecto 2: feed de productos (alcance; diseño propio después)

Una ruta pública de solo lectura en el host del portal que lista lo `VENDIBLE` con título, precio, existencia,
enlace a la ficha (`?pieza=`, #590), portada y características. Los catálogos de Meta (Facebook, Instagram,
WhatsApp, anuncios de catálogo) y Google la leen por su cuenta. Antes del diseño hay que verificar los requisitos
vigentes de cada uno en México. **Conectar un catálogo de Meta o de Google requiere autorización explícita de Isaac.**

## Proyecto 3: piloto automático de Mercado Libre (alcance; diseño propio después)

`preparar` y `publicar` sin el toque humano para piezas que cumplen todo: portada `lista`, precio sobre el umbral,
código de barras cuando la categoría lo exige y confirmación en piso (#724, se conserva). El escaneo en piso se
vuelve el disparador. Lo que no cumple sale en una lista de «qué le falta». Incluye validar antes con
`POST /items/validate` (#557) y un tope de publicaciones por día. La cuenta tiene pocas ventas y cada cancelación
pesa en la reputación: publicar sin comprobaciones no es una opción.

## Proyecto 4: precio más exacto (alcance; diseño propio después)

Línea base de 30 días: del manifiesto, 4 de 1,359 piezas corregidas a mano. De UPC fuera del manifiesto, 196 de
879 sin precio de lista y 330 corregidas (272 a la baja, en promedio 0.77× lo sugerido). Solo foto: 138 de 250
sin precio de lista y 44 corregidas (0.69×). Meta propuesta: que la pieza fuera del manifiesto necesite a una
persona en mucho menos del ~60 % de los casos.

## Fuera del programa

- Facebook Marketplace desde un perfil personal: no tiene API (#726).
- Scrapling: se probó y se retiró en #367; no corre dentro del Worker.
