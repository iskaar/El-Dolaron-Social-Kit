# Mercado Libre: qué funciona en 2026 y qué cambiar en El Dolarón

28/10/2026 · Issue #554 · Complementa `docs/MERCADOLIBRE.md` (operación de la pantalla) y `docs/MERCADOLIBRE-API.md` (endpoints). Páginas oficiales de Mercado Libre leídas el 28/10/2026; todo dato que no venga de Mercado Libre o del SAT va marcado «sin confirmar».

## Resumen ejecutivo

1. **Umbral de precio: publicar desde $329 en Mercado Libre** (≈ $275 en tienda con la regla +20 %). El ~$350 que la app asume hoy se sostiene con los costos oficiales 2026; #522 puede fijar `ml_precio_minimo` en $329 o $349. Nunca publicar bajo $199, y evitar las «bandas muertas» $299–$318 y $499–$508, donde el salto del costo de envío deja menos neto que un precio menor.
2. **La regla +20 % no cubre los costos** (≈ 24 % proporcional + $41–$84 fijos por pieza): en el rango publicable ML deja entre 64 % y 80 % del precio de tienda. Se mantiene porque empatar exigiría +45–60 % y sacaría la pieza de mercado; ML es salida para piezas que no rotan en tienda, no un canal a la par.
3. **Lo que ML premia oficialmente y la app aún no cumple:** ≥3 fotos, foto principal cuadrada 1200×1200 sobre blanco (#523/#513 llegan a 2 fotos), ficha «requerida» completa (#555) y cero reclamos/cancelaciones por ítem.
4. **Lo que castiga:** datos de contacto, texto o precio en la foto, cambios bruscos de precio, duplicados, Nike/Adidas/Reebok sin acreditación, e ítems sin ventas (pausa preventiva).
5. **Costos 2026:** comisión Clásica 15 % en ropa, calzado y juguetes (sin confirmar; coincide con lo observado), «costo de los Envíos» oficial por peso/precio/reputación en toda venta, retención 9.05 % con RFC de persona física en productos nuevos (0 % en usados) y 31 % sin RFC.
6. **Operación:** con menos de 100 ventas, una sola cancelación o un solo reclamo rompe el verde; la pausa automática al vender en caja (ya existe) es la defensa principal; el Programa de Despegue ($850 en garantía) da reputación verde claro, Ads y Clips desde el primer día.
7. **Cambios nuevos prioritarios:** diagnóstico oficial de la foto antes de publicar, leer calidad/tags/reputación después, avisos de preguntas en `/avisos`, detector de duplicados, plantilla de descripción con medidas, y la decisión de negocio de abrir «usado» para grado B.

## 1. Qué pesa en la exposición

Mercado Libre no publica la fórmula de su buscador. Sí publica tres cosas verificables. Primero, la lista de reglas de calidad de la API `/performance` (sustituyó a `/health` el 7/02/2025), cuyo fin declarado es «mejorando la exposición del ítem»: código universal, mínimo 3 fotos, título de al menos 3 palabras, características «requeridas» completas (su ausencia es un WARNING que resta score), envío gratis, Mercado Envíos, cuotas, stock ≥2 y disponibilidad inmediata; un ejemplo oficial con score 69 ya es nivel «Profesional» [ML-dev-calidad]. Segundo, «Experiencia de compra»: un algoritmo que posiciona cada ítem según sus reclamos y cancelaciones de los últimos 180 días y lo pausa si cae a 30; se mide por ítem, así que una publicación con reclamo pierde posición aunque la cuenta siga verde [ML-dev-experiencia]. Tercero, catálogo: las páginas de producto «están posicionadas en los primeros lugares» y el ganador se decide por precio, cuotas sin interés y envío (Full, gratis, en el día), con reputación verde, verde claro o amarilla como filtro; solo admite `condition: new` [ML-dev-catalogo] [ML-ayuda-4648] [ML-dev-elegibilidad]. La ficha técnica además genera los filtros con los que la gente llega a la publicación [ML-dev-atributos].

| Factor | Qué dice Mercado Libre | Estado en la app hoy | Fuente |
|---|---|---|---|
| Código universal (GTIN) | Regla de calidad: «para estar más arriba en los resultados»; condición de catálogo | 405 de ~2,545 piezas tienen UPC; la app manda `EMPTY_GTIN_REASON` (lo trata #555) | [ML-dev-calidad] |
| ≥3 fotos | Regla «subí 3 como mínimo» | 1 foto; #523 + #513 llegan a 2 | [ML-dev-calidad] |
| Foto principal: fondo blanco digital, cuadrada, 1200×1200, pieza al 95 %, sin texto ni logos | Incumplir modera con `poor_quality_thumbnail`: «perdiendo exposición» o pausa | Foto de anaquel 576×1024 con etiquetas de precio al fondo (lo trata #523) | [ML-ayuda-805] [ML-dev-imagenes] |
| Título | ≥3 palabras; Producto + Marca + modelo + especificación; sin «nuevo/usado», sin stock, sin «envío gratis» | Título libre de 60 caracteres | [ML-dev-publica] [ML-politicas] |
| Ficha «requerida» completa | WARNING que baja el score; genera filtros | Solo BRAND y SIZE (lo trata #555) | [ML-dev-calidad] [ML-dev-atributos] |
| Envío gratis | Regla de calidad y «boost» de catálogo; obligatorio desde $299 | ML lo fuerza ≥$299 (`mandatory_free_shipping`); bajo $299 la app no lo ofrece, correcto por costo | [ML-dev-costos-envio] [ML-ayuda-3667] |
| Mercado Envíos (ME2) | Regla de calidad; jerarquía ME2 > ME1 > propio | Sí (`mode: me2`) | [ML-dev-competencia] |
| Cuotas sin interés | Regla de calidad y boost; solo Premium | Clásica. Hasta $1,000 Premium da apenas 4 MSI: no compensa en ticket bajo | [ML-ayuda-22737] |
| Stock ≥2 | Regla de calidad | Imposible en pieza única; se acepta | [ML-dev-calidad] |
| Reclamos y cancelaciones por ítem | Algoritmo «Experiencia de compra», 180 días | No se lee | [ML-dev-experiencia] |
| Tipo de publicación | Define el «nivel de exposición»; sin cifra | Clásica (`gold_special`) | [ML-dev-tipos] |
| Product Ads | «Primeros resultados de búsqueda» | No | [ML-dev-ads-intro] |
| Tiempo de respuesta, historial de ventas, señales de IA | Sin fuente oficial; sin confirmar | — | [Nubimetrics-preguntas] |

Para una pieza única, las palancas que El Dolarón controla son cuatro: tres fotos buenas, título descriptivo con marca y talla, ficha completa y cero problemas posventa. Premium no conviene: compra «exposición máxima» sin cuantificar y cuotas que no pesan bajo $1,000 [ML-ayuda-22737]. Para una cuenta nueva, lo oficial es el Programa de Despegue: congela la reputación en verde (verde claro en pantalla), da crédito en Ads, Clips y «más posibilidad de ganar en Catálogo» [ML-dev-despegue] [ML-vendedores].

## 2. Pieza única, usados y lo que ML castiga

Mercado Libre México permite usados. Para moda y deportes usados la API obliga a `available_quantity = 1` y cierra la publicación al venderse, regla explícita para México [ML-dev-publica]; los usados no entran a catálogo [ML-dev-elegibilidad]; la condición va en la ficha, no en el título; y la publicación gratuita admite hasta 20 ventas al año en usados (5 en nuevos), máximo 10 simultáneas con stock 1 [ML-ayuda-870]. La política exige describir «exactamente» estado, talla, marca y material [ML-politicas]. Hoy la app publica solo grado A como «nuevo», y grado B (devolución con uso, empaque dañado) se vende únicamente en tienda (#371): es coherente con la política, y abrir «usado» para grado B es una decisión de negocio con costo distinto (sección 3.5).

Marcas: oficialmente «en México, para Adidas, Reebok y Nike» solo Tiendas Oficiales y vendedores acreditados [ML-dev-publica]; la lista fija de la app coincide. Con las demás marcas el riesgo es la denuncia por Brand Protection: la publicación se pausa, hay 3 días (lunes a sábado) para responder, y la reincidencia puede inhabilitar la cuenta y las asociadas [ML-bpp-faq] [ML-ayuda-1083]. Los motivos típicos son usar logotipos de la marca en imágenes o descripción y la «copia ilegal de imágenes protegidas por derechos de autor (fotos de catálogo)» [ML-dev-denuncias]; esto toca a #513. En México las detecciones proactivas de propiedad intelectual pasaron de 5.5 a 21.5 millones en el primer semestre de 2026, con ropa y calzado entre lo más denunciado (sin confirmar) [ELCEO] [MarqVision].

Guía de tallas: en algunos dominios de moda es obligatoria y bloquea la publicación si falta; México admite guías de marca, estándar y personalizadas, y las de calzado aceptan talla US como principal con largo del pie en cm [ML-dev-tallas]. La app ya pide `SIZE_GRID_ID` y ya captura cm (#543/#546).

| Conducta | Qué pasa | Fuente |
|---|---|---|
| WhatsApp, dirección, «pasa a la tienda», enlaces en título, descripción, fotos o respuestas | Moderación LINKS/DP; suspensión o inhabilitación de la cuenta | [ML-politicas] |
| Palabras ajenas al artículo en el título | Prohibido: «manipular los buscadores» | [ML-politicas] |
| Portada con texto, precio en papel, logo, marca de agua o fondo no blanco | PQT / `poor_quality_thumbnail`: pierde exposición o se pausa | [ML-ayuda-805] [ML-dev-moderaciones-img] |
| Cambio inusual de precio (rebajar editando el precio) | Pausa preventiva DESC; usar promociones | [ML-dev-pausado] |
| Dos publicaciones con mismo título y fotos | Baja por DUPLIS; detección por imagen idéntica sin confirmar | [ML-dev-moderaciones] [UpSeller-dupl] |
| Sin ventas ni visitas durante largo tiempo | Pausa preventiva; hay que reactivar | [ML-dev-pausado] |
| Nuevo con UPC en dominio de catálogo obligatorio sin opt-in | `catalog_forewarning` con fecha límite → pausa OPT_OBEY | [ML-dev-catalog-required] |
| Mencionar «nuevo/usado» o stock en el título | Moderación | [ML-dev-publica] |
| Descripción que no coincide (talla, estado) → reclamo | Cuenta en reclamos aunque el vendedor tenga razón; baja la experiencia del ítem | [ML-dev-reputacion] [ML-dev-experiencia] |

## 3. Costos 2026

### 3.1 Comisión (cargo por venta)

Lo único público es el rango: Clásica 8–17 %, Premium 11–21.5 %, precio mínimo $35, sin costo por publicar; el porcentaje por categoría está detrás del login [ML-ayuda-870]. El 22/04/2026 hubo una rebaja en Premium que no cubrió ropa ni juguetes (sin confirmar) [ProfitOS-abril].

| Categoría | Clásica | Premium | Estado | Fuente |
|---|---|---|---|---|
| Todas (rango) | 8–17 % | 11–21.5 % | Oficial | [ML-ayuda-870] |
| Ropa, Bolsas y Calzado | 15 % | 19.5 % (<$999) / 18 % | Sin confirmar | [Snowball] |
| Tenis | 15 % | 18 % (desde 22/04/2026) | Sin confirmar | [ProfitOS-abril] |
| Juegos y Juguetes | 15 % | 19.5 % | Sin confirmar; coincide con Fubbles Premium observado ($39 de $200) | [Snowball] [app-estado] |
| Hogar, Deportes, Bebés, Libros | 15 % | 19.5 % (Libros 18 %) | Sin confirmar; ISB $949 observado: $142.35 = 15 % | [Snowball] [app-estado] |
| Electrónica, Audio, Cómputo, Celulares | 10 % | 12.5–14.5 % | Sin confirmar | [Snowball] |
| Herramientas | 13.5 % | 16.5 % | Sin confirmar | [ProfitOS-abril] |
| Belleza (facial / cabello) | 14 % / 14.5 % | 17 % / 17.5 % | Sin confirmar | [ProfitOS-abril] |

La app ya tiene token: `GET /sites/MLM/listing_prices` con `category_id`, `price`, `listing_type_id`, `logistic_type=drop_off` y `shipping_mode=me2` devuelve el porcentaje exacto; sin esos dos parámetros el `fixed_fee` no coincide con lo cobrado [ML-dev-costos]. No se encontró cargo de Mercado Pago separado; el costo de cuotas va dentro de la comisión Premium (`financing_add_on_fee`) [ML-dev-costos] [ML-ayuda-44007].

### 3.2 Costo de los Envíos (sustituye al cargo fijo desde abril 2026)

El cargo fijo de $25/$30/$37 ya no aparece en las páginas oficiales. Desde el 08/04/2026 (fecha de encendido para México en la API), con ME2 drop-off bajo el umbral el `fixed_fee` es 0 [ML-dev-costos], pero existe un «costo de los Envíos en Mercado Libre» que «aplica a todas las ventas, incluso si el comprador paga el envío», por unidad, según el mayor entre peso físico y volumétrico, el precio y la reputación [ML-ayuda-3667]. Envío gratis obligatorio desde $299 ($499 en Supermercado). Bajo $299 ofrecerlo es opcional y cuesta la columna «$299–498.99».

**Producto nuevo, reputación amarilla o sin reputación (40 % de descuento incluido)** [ML-ayuda-40545]:

| Peso | $0–98.99 | $99–198.99 | $199–298.99 | $299–498.99 (y envío gratis opcional <$299) | $499–998.99 | Desde $999 |
|---|---|---|---|---|---|---|
| Hasta 0.3 kg | 30 | 38.4 | 42 | 62.9 | 78.6 | 78.6 |
| 0.3–0.5 kg | 34.2 | 40.8 | 45.6 | 67.2 | 84 | 84 |
| 0.5–1 kg | 39.6 | 45.6 | 46.8 | 71.5 | 89.4 | 89.4 |
| 1–2 kg | 42 | 48 | 49.2 | 81.1 | 101.4 | 101.4 |
| 2–3 kg | 44.4 | 55.2 | 57.6 | 91.2 | 106.2 | 114 |
| 3–4 kg | 46.8 | 60 | 64.8 | 98.9 | 114.6 | 123.6 |
| 4–5 kg | 48 | 63.6 | 70.8 | 105.6 | 123 | 132 |

**Producto nuevo, reputación verde o MercadoLíder (50 % de descuento incluido)** [ML-ayuda-40538]:

| Peso | $0–98.99 | $99–198.99 | $199–298.99 | $299–498.99 | $499–998.99 | Desde $999 |
|---|---|---|---|---|---|---|
| Hasta 0.3 kg | 25 | 32 | 35 | 52.4 | 65.5 | 65.5 |
| 0.3–0.5 kg | 28.5 | 34 | 38 | 56 | 70 | 70 |
| 0.5–1 kg | 33 | 38 | 39 | 59.6 | 74.5 | 74.5 |
| 1–2 kg | 35 | 40 | 41 | 67.6 | 84.5 | 84.5 |
| 2–3 kg | 37 | 46 | 48 | 76 | 88.5 | 95 |
| 3–4 kg | 39 | 50 | 54 | 82.4 | 95.5 | 103 |
| 4–5 kg | 40 | 53 | 59 | 88 | 102.5 | 110 |

**Producto usado o publicación gratuita (sin descuento por reputación)** [ML-ayuda-49978]:

| Peso | $0–98.99 | $99–198.99 | $199–298.99 | Envío gratis opcional, cualquier precio |
|---|---|---|---|---|
| Hasta 0.3 kg | 50 | 64 | 70 | 131 |
| 0.3–0.5 kg | 57 | 68 | 76 | 140 |
| 0.5–1 kg | 66 | 76 | 78 | 149 |
| 1–2 kg | 70 | 80 | 82 | 169 |
| 2–3 kg | 74 | 92 | 96 | 190 |
| 3–4 kg | 78 | 100 | 108 | 206 |
| 4–5 kg | 80 | 106 | 118 | 220 |

La tabla de usados no tiene columnas ≥$299; la lectura probable es que en un usado de $299 o más el comprador paga el envío y el vendedor no paga costo de envíos salvo que ofrezca envío gratis opcional. Sin confirmar: verificar con una pieza real. Los $41 y $84.50 de envío observados en Seller Center el 24/10 coinciden con la tabla amarilla [app-estado].

### 3.3 Retenciones (base gravable = precio ÷ 1.16)

| Situación | IVA | ISR | Sobre el precio | Aplica a | Fuente |
|---|---|---|---|---|---|
| Persona física con RFC registrado | 8 % | 2.5 % | ≈ 9.05 % | Solo productos **nuevos** | Oficial [ML-retenciones] |
| Persona física con RFC, producto usado | 0 | 0 | 0 % | — | Oficial [ML-retenciones] |
| Sin RFC (cualquier persona) | 16 % | 20 % | ≈ 31.03 % | Nuevos, usados y reacondicionados | Oficial [ML-retenciones] [ML-ayuda-44007] |
| Persona moral con RFC (desde 1/01/2026) | 8 % | 2.5 % o 4 % | 9–10.3 % | Todos | ISR sin confirmar: fuentes discrepan [ElContribuyente] [IDC] |
| Guanajuato | +2.5 % cedular | | | Todos | Oficial; no aplica a SLP [ML-retenciones] |

El ISR subió de 1 % a 2.5 % el 1/01/2026 por la Ley de Ingresos 2026 (sin confirmar en DOF) [Heru] [Siigo]. La retención ≈ 9 % observada en la cuenta coincide con persona física con RFC [app-estado]. Los ingresos por plataformas no pueden ir a RESICO (sin confirmar) [Heru]. El dinero de un vendedor sin reputación se libera 6 días después de la entrega (2 días con reputación y producto nuevo) [ML-ayuda-275].

### 3.4 Ejemplos resueltos

Supuestos: ropa nueva en Clásica a 15 % (sin confirmar), 0.3–0.5 kg, reputación amarilla, Mercado Envíos drop-off, persona física con RFC, sin publicidad. Precio de tienda = precio ML ÷ 1.2.

| Precio ML | Comisión 15 % | Costo de envíos | Ret. IVA 8 % | Ret. ISR 2.5 % | **Neto** | Neto / precio ML | Neto / precio de tienda |
|---|---|---|---|---|---|---|---|
| $150 (comprador paga envío) | 22.50 | 40.80 | 10.34 | 3.23 | **73.12** | 49 % | 58 % de $125 |
| $299 (envío gratis obligatorio) | 44.85 | 67.20 | 20.62 | 6.44 | **159.89** | 53 % | 64 % de $249 |
| $349 | 52.35 | 67.20 | 24.07 | 7.52 | **197.86** | 57 % | 68 % de $291 |
| $500 | 75.00 | 84.00 | 34.48 | 10.78 | **295.74** | 59 % | 71 % de $417 |
| $949 | 142.35 | 84.00 | 65.45 | 20.45 | **636.75** | 67 % | 80 % de $791 |

Comprobación: la ISB a $949 recibió $636.25 en Seller Center (comisión $142.35 + envío $84.50) [app-estado]. Sin RFC el neto cae a $40.15 en $150 y $121.14 en $349. Para un **usado** con RFC (sin retención, tabla de usados): $150 con el comprador pagando envío deja $59.50; $349 deja $296.65 si no hay costo de envíos ≥$299 (sin confirmar) o $156.65 con envío gratis opcional de $140.

### 3.5 Umbral de precio

**Desde qué precio conviene publicar.** Bajo $199 el costo de envíos ($38–$41) más el 24 % proporcional dejan menos de la mitad del precio: $150 deja $73. Entre $199 y $289 el comprador paga su envío y el neto sube a 53–60 % ($105 a $174). En $299 el envío gratis obligatorio salta el costo de $45.6 a $67.2 y el neto baja a $160: **$289 deja más ($173.9) que $299 ($159.9) y lo mismo que $319 ($175.1)**; igual ocurre en $499 ($295) frente a $489 ($304) y $519 ($310). El salto existe en la tabla oficial sea cual sea el porcentaje de comisión [ML-ayuda-40545].

| Precio ML | Costo de envíos | Neto estimado | Lectura |
|---|---|---|---|
| $289 | 45.6 | 173.9 | Mejor que $299–$318 |
| $299 | 67.2 | 159.9 | Banda muerta |
| $329 | 67.2 | 182.7 | Primer X9 que supera $289 con margen |
| $489 | 67.2 | 304.2 | Mejor que $499–$508 |
| $499 | 84.0 | 295.0 | Banda muerta |
| $519 | 84.0 | 310.2 | Recupera |

Recomendación: `ml_precio_minimo` = **$329** (neto ≈ 56 %); el $349 que propone #522 es equivalente en la práctica (+$15 de neto). Si Isaac quiere probar ropa ligera, puede bajar el mínimo a $199 en la configuración y vigilar el neto que #522 mostrará; esa ventana solo vale sin envío gratis y hasta $289.

**La regla +20 % por separado.** Los costos de ML son ≈ 24 % del precio más $41–$84 fijos; con +20 % el neto es 0.91 × precio de tienda − envío, es decir, 64 % del precio de tienda en $299, 68 % en $349 y 80 % en $949. Empatar el precio de tienda exigiría +61 % en una pieza de $300 y +45 % en una de $800, fuera de lo que paga un comprador que compara en el listado. La regla se queda en +20 % como piso competitivo, con tres ajustes: el mínimo de $329, el quebrado que esquive las bandas muertas y el neto a la vista (#522). En términos de tienda: con +20 % conviene publicar piezas **desde ~$275 de precio de tienda**; la mediana del catálogo (~$100) no es publicable.

**Usados.** Abrir «usado» para grado B cambia la ecuación: sin retención con RFC (+9 puntos) pero envíos de $68–$76 bajo $299 y, probablemente, el comprador pagando el envío desde $299. Un usado a $349 podría dejar $297 (85 %) si el costo de envíos ≥$299 es cero, dato sin confirmar; la prueba es una pieza real.

## 4. Operación con una persona

La reputación se calcula con tres variables sobre 60 días si hay ≥40 ventas en ese periodo, o sobre 365 días si hay menos; los reclamos solo se calculan con más de 10 ventas y las demoras solo con 10 o más ventas enviadas por Mercado Envíos [ML-dev-reputacion]. Desde el 9/09/2026 el corte habría subido a 101 ventas en 60 días (sin confirmar; el documento oficial aún dice 40) [UpSeller-reputacion]. MercadoLíder exige 101 ventas y $80,000 en 60 días, fuera de alcance; la meta realista es verde [ML-ayuda-864].

| Variable | MercadoLíder | Verde | Amarilla | Naranja | Roja |
|---|---|---|---|---|---|
| Reclamos | 1 % | 1.5 % | 3 % | 6 % | > 6 % |
| Cancelaciones del vendedor | 0.5 % | 1 % | 2.5 % | 3 % | > 3 % |
| Despachos con demora | 8 % | 10 % | 15 % | 22 % | > 22 % |

Fuente: tabla MLM oficial [ML-dev-reputacion]. Con 20 ventas, una cancelación es 5 %: rojo. Por eso la pausa automática caja → ML que ya existe es la pieza más valiosa de la integración, y por eso un reclamo evitado con buena descripción vale más que una disputa ganada. La cancelación pedida por el comprador no cuenta (sin confirmar) [UpSeller-cancel].

Logística desde San Luis Potosí: Flex solo cubre CDMX y Mérida [ML-dev-flex]; quedan drop-off en punto de entrega o Colecta/Places, cuya activación «puede influir» según una evaluación semanal de desempeño [ML-dev-colecta]. Los puntos concretos en SLP, el empaque propio y la hora de corte no se confirmaron: se ven en «Preferencias de venta» y en cada venta. Desde el 26/09/2026 México tiene colecta en sábado y sus demoras cuentan desde el 10/10/2026 (sin confirmar) [UpSeller-sabado]. Compra Protegida da 30 días desde la entrega para devolver (página oficial vista solo en extracto; sin confirmar) [ML-beneficios].

| Momento | Acción | Regla que protege | Fuente |
|---|---|---|---|
| Al abrir, antes del corte | Revisar «Ventas» en ML, imprimir etiquetas, empacar y hacer un solo viaje al punto de entrega antes de la hora límite que muestra cada venta | Demoras ≤10 % | [ML-dev-reputacion] [UpSeller-corte] |
| Al vender en caja | Nada manual: la app pausa el ítem en ML. Si llega venta de ML (aviso en `/avisos`), apartar la pieza del anaquel al momento | Cancelaciones ≤1 % | [ML-dev-reputacion] [app-estado] |
| Cada hora con la tienda abierta | Responder preguntas con plantillas (talla, medidas, estado, envío); jamás contacto ni «ven a la tienda» | Conversión; efecto en ranking sin confirmar | [ML-politicas] [Nubimetrics-preguntas] |
| Tarde | Publicar las piezas nuevas con la rutina de 3 fotos y descripción con medidas | Calidad, menos reclamos | [ML-dev-calidad] |
| Al recibir una devolución | Fotografiar el paquete y revisar antes de reingresar; reembolso en 2 días hábiles (sin confirmar) | Reclamos ≤1.5 % | [Base-devoluciones] |
| Lunes | Revisar «Preferencias de venta»: horarios de colecta, capacidad diaria y sábado según horario real | Demoras | [ML-dev-colecta] [UpSeller-corte] |
| Inicio de mes | Descargar el certificado de retenciones (5 días tras el cierre) | Fiscal | [ML-retenciones] |

Reglas fijas: ninguna rebaja editando el precio (pausa por «cambio inusual»; usar la Central de promociones) [ML-dev-pausado]; guardar comprobantes de compra de marcas para responder una denuncia en 3 días [ML-bpp-faq]; flujo de caja con 6 días tras la entrega [ML-ayuda-275]; y, para la cuenta nueva, entrar al Programa de Despegue: 0–9 ventas en 365 días, $850 en Mercado Pago, reputación verde, Ads, catálogo, Clips y promociones por 365 días; se recupera todo con 0 ventas afectadas y nada con 5 [ML-ayuda-33285].

## 5. Cambios priorizados para El Dolarón

No se repite lo que ya cubren #522 (precio/neto), #523 (recorte sobre blanco), #513 (imagen oficial) ni #555 (atributos). Todo respeta las reglas del proyecto: sin dependencias ni servicios nuevos, sin scrapers, D1 maestro de stock, centavos enteros, migraciones aditivas.

| # | Cambio | Dónde | Impacto esperado | Esfuerzo | Fuente |
|---|---|---|---|---|---|
| **(a) App** | | | | | |
| 1 | **#564** · Diagnóstico oficial de la foto principal antes de publicar: `POST /moderations/pictures/diagnostic` con `picture_type: thumbnail` y `category_id`; mostrar el `REMEDY_SHORT` en el diálogo; no bloquear si la API falla. Verifica el resultado de #523/#513 | `app/src/mercadolibre.ts` (`preparar`), `mercadolibre.html` (diálogo) | Evita `poor_quality_thumbnail` desde la primera publicación | Bajo | [ML-dev-diagnostico] |
| 2 | **#562** · Tercera foto por pieza (etiqueta/talla o detalle) adjuntada desde el celular en el diálogo; subir con `POST /items/{id}/pictures` | `mercadolibre.ts` (`publicar`), `mercadolibre.html`, R2 | Cumple «3 como mínimo»; menos preguntas y reclamos por estado | Medio | [ML-dev-calidad] [ML-dev-imagenes] |
| 3 | **#563** · Leer `GET /item/{id}/performance` en el cron existente (404 = aún no calculado) y mostrar score, nivel y reglas pendientes en «Publicadas» | `mercadolibre.ts` (cron), `mercadolibre.html` | Ver qué falta a cada publicación con la vara oficial | Medio | [ML-dev-calidad] |
| 4 | **#563** · Leer tags y sub-status del ítem (`poor_quality_thumbnail`, `incomplete_technical_specs`, `not_market_price`, `catalog_forewarning`, pausa «sin ventas») en el cron y avisar en `/avisos` | `mercadolibre.ts` (cron), centro de avisos | Enterarse de moderaciones y pausas sin entrar a Seller Center | Bajo | [ML-dev-publica] [ML-dev-pausado] [ML-dev-catalog-required] |
| 5 | **#568** · Detector de duplicados: si ya hay publicación activa con mismo nombre + marca (y, con #513, misma imagen), avisar y sugerir talla/color en el título o variaciones | `mercadolibre.ts` (`preparar`) | Evita baja por DUPLIS | Bajo | [ML-dev-moderaciones] [UpSeller-dupl] |
| 6 | **#566** · Preguntas: fase 1, `GET /my/received_questions/search?status=UNANSWERED&api_version=4` en el cron → aviso en `/avisos` y correo; fase 2, responder desde la pantalla con `POST /answers` y plantillas | `mercadolibre.ts`, `mercadolibre.html` | No perder ventas por preguntas sin responder; efecto en ranking sin confirmar | Bajo (aviso) / Medio (responder) | [ML-dev-preguntas] [Nubimetrics-preguntas] |
| 7 | **#563** · Semáforo de reputación: `seller_reputation` de `GET /users/me` (nivel, reclamos, cancelaciones, demoras, `protection_end_date`) en la sección Conexión | `mercadolibre.ts`, `mercadolibre.html` | Ver el termómetro y la protección de Despegue en la app | Bajo | [ML-dev-reputacion] |
| 8 | **#565** · Plantilla de descripción por defecto: sustituir «nombre / Marca / Condición» por lo que no está en la ficha: medidas en cm (ya capturadas en calzado), estado de etiqueta y empaque; nunca contacto, stock ni beneficios | `mercadolibre.ts` (descripción por defecto) | Menos reclamos por talla/estado, que cuentan aunque el vendedor tenga razón | Bajo | [ML-dev-descripcion] [ML-politicas] [ML-dev-reputacion] |
| 9 | **#563** · `GET /items/{id}/price_to_win?version=v2` para las publicaciones de catálogo: estado, `reason` y `boosts` con `opportunity` en «Publicadas» | `mercadolibre.ts`, `mercadolibre.html` | Saber por qué no gana sin bajar precio a ciegas | Medio | [ML-dev-competencia] |
| 10 | Ya está: la lista Nike/Adidas/Reebok coincide con lo oficial y el error `moderations.seller.not_authorized` ya se traduce al dueño | `mercadolibre.ts` (`MARCAS_RESTRINGIDAS`, `TEXTOS`) | Sin cambio; se deja anotado | — | [ML-dev-publica] [ML-dev-validaciones] |
| 10b | `POST /items/validate` con el mismo JSON antes de crear el ítem (doc oficial vigente, 30/12/2025): devuelve las causas sin publicar; mostrarlas en el diálogo con los textos ya traducidos | `mercadolibre.ts` (`publicar`) | Menos publicaciones en estado «error» y reintentos | Bajo | [ML-dev-validador] |
| **(b) Precio** (refinamientos de #522) | | | | | |
| 11 | #522 (comentario 28/10) · Comisión real con `GET /sites/MLM/listing_prices` (categoría elegida, precio, `listing_type_id`, `logistic_type=drop_off`, `shipping_mode=me2`) al preparar; `fixed_fee` ya viene dentro de `sale_fee_amount` | `mercadolibre.ts` (`preparar`) | Resuelve el % por categoría que no es público | Bajo | [ML-dev-costos] |
| 12 | **#560** + #522 · Tabla oficial de costo de envíos (40545 / 40538 / 49978) como constante fechada, elegida por banda de precio, peso y reputación (#7); peso estimado por categoría interna en la configuración existente | `mercadolibre.ts` | Neto realista: bajo $300 el envío es la mitad del costo | Bajo–medio | [ML-ayuda-40545] [ML-ayuda-40538] [ML-ayuda-49978] |
| 13 | #522 (comentario 28/10) · Retenciones en el neto: 9.05 % con RFC de persona física en nuevo, 0 en usado con RFC, 31.03 % sin RFC; parámetro de configuración | `mercadolibre.ts` | El neto que #522 muestra coincide con Seller Center | Bajo | [ML-retenciones] |
| 14 | #522 (comentario 28/10) · `precioML`: tras +20 % y quebrado X9, esquivar bandas muertas ($299–$318 → $289 o $329; $499–$508 → $489 o $519), con prueba en `mercadolibre.test.ts` | `mercadolibre.ts` (`precioML`) | +$14 a +$23 de neto por pieza en esas bandas | Bajo | [ML-ayuda-40545] §3.5 |
| 15 | #522 + **#567** (lista ordenada por conveniencia) · `ml_precio_minimo` = $329 (o $349); el aviso «neto < precio de tienda» de #522 saltará siempre con +20 %: mostrar «neto = X % del precio de tienda» y avisar bajo 60 % | `mercadolibre.ts`, `mercadolibre.html` | Decisión clara por pieza | Bajo | §3.5 |
| **(c) Fotos** (refinamientos de #523/#513) | | | | | |
| 16 | #523 (comentario 28/10) · componer cuadrado 1200×1200, pieza centrada al 95 %, fondo #FFFFFF, sin etiqueta de precio ni marca de agua; pasar por el diagnóstico (#1) antes de subir | Dentro de #523 | Portada que no se modera y activa zoom (>800 px) | Bajo | [ML-ayuda-805] [ML-dev-imagenes] |
| 17 | #513 (comentario 28/10) · la imagen oficial (Target/Google) como principal es riesgo de denuncia por «fotos de catálogo protegidas»; usarla solo en publicaciones de catálogo (ML pone la ficha oficial) y en tradicionales dejar la propia como principal | Dentro de #513 | Evita pausa BPP y riesgo de cuenta | Bajo | [ML-dev-denuncias] [ML-bpp-faq] |
| 18 | Rutina de foto en tienda: 1) pieza sola sobre fondo liso sin precio visible; 2) etiqueta/talla/UPC; 3) detalle o defecto | Proceso | Alimenta #2 y #523 con material usable | Medio (hábito) | [ML-ayuda-805] |
| **(d) Proceso de tienda** | | | | | |
| 19 | Confirmar que la Constancia de Situación Fiscal (RFC) está registrada en ML | Cuenta ML | 9.05 % en vez de 31 % de retención | Bajo | [ML-retenciones] |
| 20 | Entrar al Programa de Despegue ($850 en garantía) | Cuenta ML | Verde claro, Ads, Clips y promociones desde el primer día; se recupera con 0 ventas afectadas | Bajo | [ML-ayuda-33285] [ML-dev-despegue] |
| 21 | **#561** · Decisión de negocio: abrir «usado» (`ITEM_CONDITION` 2230581) para grado B en ropa y calzado: cantidad 1, cierre automático, sin retención con RFC, sin catálogo, tabla de envíos de usados. Contradice #371; probar con una pieza ≥$299 para confirmar el costo de envíos | Decisión de Isaac; luego `mercadolibre.ts` + migración aditiva | Abre a ML un inventario hoy vedado | Medio | [ML-dev-publica] [ML-ayuda-49978] [ML-retenciones] |
| 22 | Configurar capacidad diaria y sábado en «Preferencias de venta» según horario real; revisarlo los lunes | Cuenta ML | Demoras ≤10 % | Bajo | [ML-dev-colecta] [UpSeller-sabado] |
| 23 | Cero cancelaciones por falta de stock: confiar en la pausa automática caja → ML y apartar al instante la pieza vendida en ML | Proceso | Verde con pocas ventas | Bajo | [ML-dev-reputacion] |
| 24 | Nunca WhatsApp, dirección ni «pasa a la tienda» en ML; conservar comprobantes de compra de marcas para responder una denuncia en 3 días | Proceso | Evita suspensión y pausas BPP | Bajo | [ML-politicas] [ML-bpp-faq] |
| 25 | Rebajas solo por Central de promociones, no editando el precio | Proceso | Evita pausa por «cambio inusual de precio» | Bajo | [ML-dev-pausado] |

### Issues abiertos desde esta investigación (28/10/2026)

- #560 cajas tipo con peso y medidas (`SELLER_PACKAGE_*`) para el costo de envíos · #561 publicar grado B como «Usado» (decisión) · #562 hasta 3 fotos · #563 lecturas de ML en el cron: calidad, catálogo, moderaciones y reputación · #564 diagnóstico oficial de la foto · #565 descripción por defecto con talla y estado · #566 preguntas en `/avisos` · #567 ordenar «Por publicar» por conveniencia · #568 detector de duplicados.
- Refinamientos dejados como comentario en #522 (costos y bandas muertas), #523 (composición y diagnóstico) y #513 (riesgo de denuncia por foto de catálogo). Nada sobre atributos: #555.
- `POST /items/validate` (10b) queda anotado sin Issue propio: se implementa junto con #564 o #563 cuando se toque `publicar`.

## 6. Lo que no se pudo confirmar

- Porcentaje exacto de comisión por categoría en MLM (la tabla y el simulador exigen login); si la comisión lleva IVA adicional. Lo resuelve el cambio #11.
- Si un usado ≥$299 paga «costo de los Envíos» cuando el comprador paga el envío; en qué banda cae un paquete de exactamente 0.5 kg.
- Cambio del termómetro a 101 ventas en 60 días (9/09/2026) y que las demoras de sábado cuenten desde el 10/10/2026: solo terceros.
- Puntos de entrega, paqueterías y requisitos de Colecta en San Luis Potosí; reglas oficiales de empaque propio; hora de corte estándar.
- Quién paga el envío de una devolución; lectura directa de los 30 días de Compra Protegida; si existe «modo vacaciones» en MLM.
- Efecto del tiempo de respuesta a preguntas, del historial de ventas o de señales de IA/Clips en el buscador: ningún texto oficial.
- Duración, dosificación de ventas y detalle del Programa de Despegue más allá de los T&C leídos.
- ISR 2026 para persona moral (2.5 % o 4 %); trato en RESICO.
- Vigencia de la prohibición de «ropa interior usada» (lista de 2012; la página MX ya no carga) y reglas de higiene para ropa usada.
- `max_pictures_per_item` = 12 solo comprobado en 7 categorías; lista de dominios MLM con catálogo obligatorio o guía de tallas obligatoria (exigen token).
- Discrepancia oficial entre «hasta 18» y «hasta 15» meses sin intereses en Premium.

## Fuentes

Oficiales de Mercado Libre (leídas 28/10/2026; fecha de «Última actualización» cuando la página la muestra):

- [ML-ayuda-870] ¿Cuánto pago por vender un producto? — https://www.mercadolibre.com.mx/ayuda/costos-de-vender-un-producto_870
- [ML-ayuda-3667] Costos de los Envíos en Mercado Libre — https://www.mercadolibre.com.mx/ayuda/costos-de-envios_3667
- [ML-ayuda-40545] Costos de los Envíos, reputación amarilla o sin reputación — https://www.mercadolibre.com.mx/ayuda/40545
- [ML-ayuda-40538] Costos de los Envíos, MercadoLíderes y reputación verde — https://www.mercadolibre.com.mx/ayuda/40538
- [ML-ayuda-49978] Costos de los Envíos para productos usados o publicación gratuita — https://www.mercadolibre.com.mx/ayuda/49978
- [ML-ayuda-275] ¿Cuánto tiempo tengo que esperar para usar el dinero? — https://www.mercadolibre.com.mx/ayuda/cuando-podre-usar-dinero_275
- [ML-ayuda-22737] Meses sin intereses en Premium — https://www.mercadolibre.com.mx/ayuda/22737
- [ML-ayuda-44007] Cómo calculamos cuánto recibes por venta — https://www.mercadolibre.com.mx/ayuda/44007
- [ML-ayuda-864] Todo sobre ser MercadoLíder — https://www.mercadolibre.com.mx/ayuda/864
- [ML-ayuda-4648] ¿Qué tengo que hacer para ganar en catálogo? — https://www.mercadolibre.com.mx/ayuda/4648
- [ML-ayuda-805] Cómo sacar buenas fotos de tus productos — https://www.mercadolibre.com.mx/ayuda/Sacar-bue-nas-fotos-productos_805
- [ML-ayuda-33285] Términos y condiciones del Programa de Despegue — https://www.mercadolibre.com.mx/ayuda/terminos-y-condiciones-programa-despegue_33285
- [ML-ayuda-1083] Protección de Propiedad Intelectual — https://www.mercadolibre.com.mx/ayuda/1083
- [ML-bpp-faq] Brand Protection Program, preguntas frecuentes — https://www.mercadolibre.com.mx/brandprotection/enforcement/faqs
- [ML-politicas] Políticas de Publicación MX — https://www.mercadolibre.com.mx/seguro_publicacion.html
- [ML-retenciones] ¿Qué son y cómo se aplican las retenciones? (Centro de vendedores) — https://vendedores.mercadolibre.com.mx/aprender/nota/que-son-y-como-se-aplican-las-retenciones
- [ML-vendedores] Landing de vendedores MX — https://vendedores.mercadolibre.com.mx/
- [ML-beneficios] Beneficios / Compra Protegida (visto en extracto) — https://www.mercadolibre.com.mx/l/beneficios
- [ML-dev-calidad] Calidad de publicaciones (/performance), 31/01/2025 — https://developers.mercadolibre.com.mx/es_ar/calidad-de-publicaciones
- [ML-dev-experiencia] Experiencia de compra, 03/02/2026 — https://developers.mercadolibre.com.mx/es_ar/experiencia-de-compra
- [ML-dev-atributos] Carga de atributos, 13/11/2023 — https://developers.mercadolibre.com.mx/es_ar/conoce-como-estan-los-vendedores-frente-la-carga-de-atributos
- [ML-dev-catalogo] Qué es catálogo, 29/12/2025 — https://developers.mercadolibre.com.mx/es_ar/que-es-catalogo
- [ML-dev-elegibilidad] Elegibilidad de catálogo, 29/12/2025 — https://developers.mercadolibre.com.mx/es_ar/elegibilidad-catalogo
- [ML-dev-competencia] Competencia en catálogo (price_to_win), 21/07/2026 — https://developers.mercadolibre.com.mx/es_ar/competencia-en-catalogo
- [ML-dev-catalog-required] Catalog required listings, 30/12/2025 — https://developers.mercadolibre.com.mx/en_us/catalog-required-listings
- [ML-dev-tipos] Tipos de publicación, 01/06/2026 — https://developers.mercadolibre.com.mx/es_ar/tipos-de-publicacion-y-actualizaciones-de-articulos
- [ML-dev-imagenes] Imágenes en publicaciones, 24/03/2026 — https://developers.mercadolibre.com.mx/es_ar/trabajar-con-imagenes
- [ML-dev-diagnostico] Diagnóstico de imágenes, 29/12/2025 — https://developers.mercadolibre.com.mx/es_ar/diagnostico-imagenes
- [ML-dev-moderaciones-img] Moderaciones de imágenes, 21/07/2025 — https://developers.mercadolibre.com.mx/es_ar/moderaciones-de-imagenes
- [ML-dev-moderaciones] Gestionar moderaciones, 08/06/2026 — https://developers.mercadolibre.com.mx/es_ar/gestionar-moderaciones
- [ML-dev-pausado] Moderaciones con pausado, 12/06/2026 — https://developers.mercadolibre.com.mx/es_ar/moderaciones-con-pausado
- [ML-dev-publica] Publicar productos, 09/01/2026 — https://developers.mercadolibre.com.mx/es_ar/publica-productos
- [ML-dev-reputacion] Reputación de vendedores, 11/08/2025 — https://developers.mercadolibre.com.mx/es_ar/reputacion-de-vendedores
- [ML-dev-despegue] Programa de Despegue y Beneficio de Reputación, 04/02/2025 — https://developers.mercadolibre.com.mx/es_ar/recuperacion-reputacion
- [ML-dev-costos] Costos por vender (listing_prices), 03/09/2026 — https://developers.mercadolibre.com.mx/es_ar/comision-por-vender
- [ML-dev-costos-envio] Costos de envío (shipping_options/free, mandatory_free_shipping), 13/02/2026 — https://developers.mercadolibre.com.mx/es_ar/costos-de-envios
- [ML-dev-dimensiones] FAQ Atributos de envío y dimensiones, 14/08/2026 — https://developers.mercadolibre.com.mx/es_ar/items-atributos-de-envio-y-dimensiones
- [ML-dev-descripcion] Descripción de productos, 13/03/2026 — https://developers.mercadolibre.com.mx/es_ar/descripcion-de-articulos
- [ML-dev-preguntas] Preguntas y Respuestas, 05/06/2025 — https://developers.mercadolibre.com.mx/es_ar/preguntas-y-respuestas
- [ML-dev-validador] Validador de publicaciones (`POST /items/validate`), 30/12/2025 — https://developers.mercadolibre.com.mx/es_ar/validador-de-publicaciones
- [ML-dev-validaciones] Validaciones, 29/12/2025 — https://developers.mercadolibre.com.mx/es_ar/validaciones
- [ML-dev-tallas] Gestionar guía de talles, 16/10/2026 — https://developers.mercadolibre.com.mx/es_ar/guias-de-talles
- [ML-dev-denuncias] Publicaciones denunciadas, 26/07/2026 — https://developers.mercadolibre.com.mx/es_ar/publicaciones-denunciadas
- [ML-dev-colecta] Envíos Colecta y Places (capacidad), 25/09/2026 — https://developers.mercadolibre.com.mx/es_ar/envios-colectas-places
- [ML-dev-flex] Envíos Flex, 15/10/2026 — https://developers.mercadolibre.com.mx/es_ar/envios-flex
- [ML-dev-ads-intro] Introducción a Mercado Ads, 05/08/2024 — https://developers.mercadolibre.com.mx/es_ar/introduccion-a-mercado-ads

Terceros (sin confirmar oficialmente):

- [Snowball] Comisiones Mercado Libre 2026 (tabla MX, «verificado marzo 2026») — https://snowballpartners.co/blogs/comisiones-mercado-libre-2026
- [ProfitOS-abril] Mercado Libre baja cargos, 22/04/2026 — https://www.profitosapp.com/blog/baja-cargos-comisiones-mercado-libre-abril-2026
- [UpSeller-reputacion] Cambios de reputación en México desde 9/09/2026, 27/08/2026 — https://www.upseller.com/es/blog-article-1007
- [UpSeller-sabado] Colecta en sábado, 14/09/2026 — https://upseller.com/es/blog-article-1026
- [UpSeller-cancel] Cancelaciones, 17/12/2025 — https://upseller.com/es/blog-article-480
- [UpSeller-corte] Horario de corte y preferencias de venta, 04/01/2026 — https://upseller.com/es/blog-article-500
- [UpSeller-dupl] Publicaciones duplicadas, 08/01/2026 — https://www.upseller.com/es/blog-article-507
- [Nubimetrics-preguntas] Respuesta a preguntas, 29/04/2025 — https://academia.nubimetrics.com/que-tan-bueno-eres-respondiendo-preguntas
- [Base-devoluciones] Devoluciones en Mercado Libre México, 03/09/2026 — https://base.com/es-MX/blog/?p=18499
- [Heru] Impuestos para vendedores de Mercado Libre, 12/10/2026 — https://www.heru.app/blog/impuestos-mercado-libre-vendedores-2025/
- [Siigo] Régimen de plataformas digitales — https://www.siigo.com/mx/blog/obligaciones-fiscales/regimen-plataformas-digitales-sat-obligaciones/
- [ElContribuyente] Nuevas retenciones 2026, 19/11/2025 — https://www.elcontribuyente.mx/2025/11/en-2026-vender-en-plataformas-digitales-sera-mas-caro-habra-nuevas-retenciones/
- [IDC] Retenciones a personas morales 2026, 10/10/2025 — https://idconline.mx/fiscal-contable/2025/10/10/retenciones-a-personas-morales-por-plataformas-digitales-2026
- [ELCEO] Detecciones proactivas de PI, 06/10/2026 — https://elceo.com/negocios/mercado-libre-halla-21-5-millones-de-detecciones-proactivas-de-propiedad-intelectual/
- [MarqVision] Enforcement de marcas en Mercado Libre, 2026 — https://www.marqvision.com/es/blog/mercadolibre-trademark-enforcement

Proyecto:

- [app-estado] Lectura del código el 28/10/2026: `app/src/mercadolibre.ts`, `app/public/mercadolibre.html`, `docs/MERCADOLIBRE.md`, `docs/MERCADOLIBRE-API.md`; costos observados en Seller Center el 24/10/2026 (Issue #522).
