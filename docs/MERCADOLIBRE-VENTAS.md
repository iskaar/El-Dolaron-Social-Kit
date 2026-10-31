# Mercado Libre: cómo vender más con lo que ya está publicado

31/10/2026 · Issue #636 · Investigación hecha el 30/10/2026 (Seller Center en solo lectura, búsquedas de compradores y páginas oficiales de Mercado Libre) · Complementa [docs/MERCADOLIBRE-ESTRATEGIA.md](MERCADOLIBRE-ESTRATEGIA.md) (costos, calidad, moderaciones y fotos: no se repiten aquí), `docs/MERCADOLIBRE.md` y `docs/MERCADOLIBRE-API.md`.

Etiquetas: **[OFICIAL]** = página de Mercado Libre; **[VISTO]** = Seller Center de la cuenta, 30/10; **[CÁLCULO]** = aritmética propia; **[SIN CONFIRMAR]** = prensa, terceros o inferencia.

## Resumen ejecutivo

1. **El cuello de botella es visibilidad y reputación, no el precio.** 30 visitas únicas en 7 días (23–30/10) para 35 publicaciones activas; 0 ventas desde el 20/07/2026 (102 días).
2. De 42 piezas comparadas, **18 ya están bajo el mercado y solo 7 están 15 % o más arriba**. El LEGO 76338 ($629) está bajo el ganador de catálogo ($699) y no gana la caja.
3. **El Programa de Despegue ya está activo** (228 días restantes): es la llave de Product Ads, promociones, Clips y del verde claro. Van **4 de 5 ventas afectadas** (todas de artículos viejos, jun–jul 2026): **una más y se pierde todo**. Cada afectada cuesta $170 de la garantía de $850.
4. Calidad promedio 52 (34 de 35 bajo 70); casi todas sin video; 6 piezas elegibles a catálogo sin verificar.
5. ML ya invita a dos campañas: «Lo mejor de todos los días» (hasta 12/11, 5–10 % en 6 piezas) y Buen Fin dentro de ML (12/11–1/12, 3 % en 28 piezas y 10 % en Bella Parker). El costo por pieza es pequeño: el «recibes» baja 0.76 × el descuento (Funko $359: $205.05 a $196.87).
6. Product Ads está habilitada y sin campañas. Piloto propuesto: campaña **manual**, 15–30 piezas de $359–$959, **$100/día**, ROAS objetivo ~4x, 14 días mínimo, decidir a los 30.
7. Ocho piezas están subvaluadas: subirlas suma $53 a $158 de neto por pieza [CÁLCULO]. Solo conviene bajar el colchón Ozark y el peluche Thready Bear, con la herramienta de descuento.
8. No conviene: Flex, Full/Turbo, Mi página, cupones del vendedor, Premium bajo $1,000, Excel masivo ni scrapers.
9. En la app: #637 (visitas y ventas por publicación), #638 (promociones y Product Ads en `/avisos`), #639 (Despegue y reputación).
10. **Regla número uno de cualquier empuje:** cero cancelaciones por falta de stock, cero envíos tardíos, descripciones exactas.

## 1. Diagnóstico

### 1.1 Cuenta, tráfico y ventas

| Dato | Valor | Fuente |
|---|---|---|
| Ventas en 365 días | 24, todas del 21/06 al 20/07 (Ariana Grande Body Mist x13, JBL Partybox, Castrol x3, Kraft) | [VISTO] |
| Última venta | 20/07/2026. Ninguna pieza de la campaña #628 ni de las originales (ED-002915/6, LEGO) se ha vendido | [VISTO] |
| Visitas únicas 7 días (23–30/10) | 30 (periodo anterior: 1). Intención de compra 0, ventas brutas $0, conversión 0 % | [VISTO] |
| Visitas por publicación | Fubbles 7, LEGO 3, Energizer 3, Funda iPad 2, Tablero LED 2, Letrero neón 1 (suma 18) | [VISTO] |
| Preguntas | 0 sin responder, 0 en 15 días | [VISTO] |
| Publicaciones | 50: 35 activas, 11 pausadas, 2 sin stock, Trayenta Duo (medicamentos) y Dilophosaurus (marca) inactivas | [VISTO] |
| Promociones y Product Ads | Ninguna promoción aceptada; Product Ads habilitada con 0 campañas | [VISTO] |

La mayoría de las publicaciones nacieron el 30/10: 0 visitas no prueba nada por pieza, pero no hay señal de exposición.

### 1.2 Calidad

Las 35 activas tienen calidad 42–84 (promedio 52; solo Energizer pasa de 70). Casi todas dicen «Sin video» y la «Experiencia de compra» está «Sin calcular» en todas. ML señala «Completa características» en Naturium, Tablero LED, Strivectin, Biggerfive, Letrero neón, Mario Badescu y Astro Bot (7 en el listado) [VISTO]. Seis piezas son **elegibles para catálogo** y no han verificado el producto: AEW, Kerplunk, Funko Rebel Moon, Zuru, Funko Corinthian y Funko Rosalía. ML dice que las publicaciones de catálogo «siempre aparecen primero» [OFICIAL, ver Fuentes].

### 1.3 Reputación y Programa de Despegue

- **Despegue activo, 228 días restantes.** Sin el programa, ML mostraría rojo («tendrías color rojo»); los compradores ven verde claro [VISTO].
- **Ventas afectadas 4 de 5**: 2 reclamos, 1 cancelación propia (falta de stock, 6/07, Kraft), 1 envío incorrecto. Reclamos 8.33 % (permitido 1.5 %), canceladas 4.16 % (1.5 %), envíos incorrectos 5 % (13 %) [VISTO].
- **Costo:** garantía $850; cobro por afectadas: 1 = $170, 2 = $340, 3 = $510, 4 = $680, 5 = $850. Hoy ya se cobran $680 y quedan $170 recuperables [VISTO]; una afectada más termina el programa [OFICIAL, T&C Despegue]. Tras una afectada ML puede limitar Publicidad y Catálogo hasta 5 días; una venta afectada se puede revertir hasta 10 días después del cierre [OFICIAL].
- Las afectadas son de Kraft, Castrol y Ariana Grande, no de la campaña actual. Verde claro propio exigiría 110 ventas sin reclamos [VISTO]: el Despegue es el puente. **Una cancelación por stock es inadmisible**: la pausa automática caja → ML (ya existe) es la defensa principal.

### 1.4 Precio frente al mercado

Búsqueda de comprador, una consulta por pieza, primera página, 42 piezas. Clases: **A** = ≥15 % arriba del mercado (7), **B** = en rango (9), **C** = bajo el mercado (18), **S** = sin equivalente directo (7), **N** = sin analizar (1, Srixon). En 4 de las 7 A bajar el precio dejaría el neto bajo 60 % del precio de tienda (≈ precio ML ÷ 1.2): aurora Northern Lights, velas LED, Funko Lucienne e ISB.

### 1.5 Las 35 activas, por pieza

«Propuesto» = precio sugerido por la comparación (3a adopta solo los que lista). Calidad = puntaje de ML. «Vis. 7 d» = visitas del Seller Center (0 = sin dato).

| MLM | Pieza | Precio | Calidad | Catálogo | Vis. 7 d | Clase | Propuesto |
|---|---|---:|---:|---|---:|:-:|---|
| 3704315079 | LEGO Spider-man vs Doc Ock 76338 | $629 | 57 | Compite: pierde | 3 | C | mantener |
| 6496451756 | Energizer 2032 x10 | $250 | 84 | Compite: gana | 3 | C | $329 |
| 6501490412 | WWE Curt Hennig | $419 | 50 | Compite: gana | 0 | C | mantener |
| 3689586423 | Fubbles burbujas | $200 | 49 | Compite: gana | 7 | C | $289 |
| 6501501062 | Muñeca Bella Parker | $719 | 44 | Compite: gana | 0 | C | mantener |
| 3731383115 | Gel Good Molecules | $479 | 62 | — | 0 | C | mantener |
| 3731186049 | Colchón Ozark Trail | $899 | 62 | — | 0 | A | $749 |
| 3731357253 | AEW Unmatched | $359 | 42 | Elegible | 0 | C | $549 |
| 6490831408 | Funda iPad Mini | $650 | 60 | — | 2 | S | mantener |
| 6501490960 | Chaleco Speedo | $419 | 57 | — | 0 | B | mantener |
| 3731361709 | Kerplunk | $359 | 45 | Elegible | 0 | C | $589 |
| 6501664640 | Funko Pop Rebel Moon | $359 | 52 | Elegible | 0 | C | $429 |
| 6501466046 | Ventilador Go Fan | $479 | 46 | — | 0 | S | mantener |
| 6501490542 | Máscara Venom | $419 | 52 | — | 0 | B | mantener |
| 3731185405 | Manteca Naturium | $419 | 55 | — | 0 | C | $479 |
| 6501501542 | Aceite limpiador Haruharu | $359 | 46 | — | 0 | C | $519 |
| 6501491056 | Perro inflable 6 pies | $2,159 | 52 | — | 0 | C | mantener |
| 6496540972 | Tablero LED | $599 | 65 | — | 2 | A | $489 |
| 3731384223 | Cortinas Laura Ashley | $359 | 48 | — | 0 | S | mantener |
| 3731361911 | Zuru Xshot | $539 | 54 | Elegible | 0 | S | mantener |
| 3731184977 | Lámpara Northern Lights | $839 | 52 | — | 0 | A | mantener |
| 3731185545 | Kit Facial Strivectin | $899 | 43 | — | 0 | C | mantener |
| 6501489844 | Peluche Thready Bear | $539 | 42 | — | 0 | C | $489 |
| 6501491212 | Peluche Balón FIFA | $419 | 42 | — | 0 | B | mantener |
| 3731185503 | Reloj Biggerfive | $509 | 46 | — | 0 | B | mantener |
| 3731358233 | Funko Pop Corinthian | $359 | 53 | Elegible | 0 | B | mantener |
| 6496454316 | Letrero neón LED | $269 | 42 | — | 1 | C | $449 |
| 3731361545 | Mario Badescu | $359 | 53 | — | 0 | C | $549 |
| 6501490462 | Kit Spider-man transformable | $419 | 50 | — | 0 | S | mantener |
| 6501655334 | Funko Pop Sandman | $359 | 54 | — | 0 | A | mantener |
| 6501653894 | Funko Pop Rosalía | $359 | 53 | Elegible | 0 | B | mantener |
| 6501466726 | Árbol fibra óptica | $959 | 47 | — | 0 | C | $1,049 |
| 3731360335 | Organizador Brightroom | $539 | 62 | — | 0 | A | $449 |
| 3731359803 | Lámpara Astro Bot | $359 | 53 | — | 0 | S | mantener |
| 6501500908 | Set velas LED Threshold | $419 | 46 | — | 0 | A | mantener |

Otras 7 comparadas, hoy pausadas o inactivas: SplatRBall (B, → $1,379), Mainstays (C, $389 → $599), Selkirk ($2,099), Puma ($419), Dilophosaurus ($389), ISB ($949, A) y Srixon ($1,099, sin analizar).

## 2. Qué mueve ventas en ML y qué cuesta

Citas en Fuentes. Costos en MXN solo con cifra oficial.

| Palanca | Costo y requisito | Efecto (según ML) | Cómo medir | Para nosotros |
|---|---|---|---|---|
| **Programa de Despegue** | Garantía $850 (−$170 por afectada). Ya activo | Verde claro; habilita Ads, descuentos, Clips, Central de promociones y crédito de Ads | `seller_recovery/status` (#639); Reputación | **Proteger.** Es la llave |
| **Product Ads** | Por clic (CPC no publicado); crédito de Despegue en MXN sin confirmar. Sin deudas, un artículo activo | Mejores posiciones en búsqueda y «Promocionado» en fichas ajenas | Administrador de campañas; API de lectura (#638) | **Piloto manual** (3b) |
| **Campañas de ML** (Buen Fin, «Lo mejor de todos los días») | Margen cedido 3–10 %. Reputación verde/amarilla o Despegue, producto nuevo, experiencia ≥ 50 | Exposición en el evento | Ventas y visitas por ítem; `seller-promotions` (#638) | **Aceptar casi todas** (3a) |
| **Descuento individual** | 5 % a menos de 80 %, máx. 14 días; mismos requisitos | Lugar en Ofertas (sin cifra); sustituye bajar el precio editándolo | `seller-promotions/items/{id}` | Ozark y Thready Bear |
| **Catálogo** (verificar producto) | $0; 6 piezas elegibles, solo nuevo | «Siempre aparece primero»; gana por precio, cuotas y envío | Estado gana/pierde (#563) | **Hacer ya** |
| **Videos «Crear con IA»** | $0 más tiempo; desde celular, sin requisito de reputación | ML afirma +4x ventas y +7x visitas (marketing) | Visitas antes/después (#637) | **Primero en ≥ $489** |
| **Ficha completa y precio competitivo** | $0 / neto | Filtros de búsqueda y ranking | `/item/{id}/performance` (#563) | Completar 7; subir 8, bajar 2 |
| **Premium** | ≈ +4.5 puntos de comisión (≈ $97 en $2,159; ≈ $65 en $1,439) [CÁLCULO] | MSI 8/6 de $1,000 a $1,500; 15/12 sobre $2,000; bajo $1,000 solo 4 | Visitas y ventas vs Clásica | Probar en 2 piezas |
| **Flex, Full/Turbo, Mi página, cupones** | Ver 3e | — | — | **No** |

Más hechos [OFICIAL]: Product Ads atribuye ventas 14 días tras el clic; la campaña automática elige publicaciones «con buen nivel de ventas» (las nuestras no tienen historial); ML recomienda 30 días de campaña (las dos primeras semanas son «de prueba»); las manuales sugieren 15–30 anuncios de precio parecido; ACOS = 100 / ROAS. Descuentos y Ads exigen producto **nuevo** (el grado B queda fuera).

## 3. Plan

### 3a. Esta semana: Isaac en Seller Center, sin código

**Primero subir precios, después aceptar campañas.** ML advierte que subir el precio para luego «bajarlo» se nota [OFICIAL]: dejar días entre ambos y guardar captura de cada precio con fecha.

**Paso 1 · Limpieza de riesgo (hoy, 31/10)**
- Trayenta Duo (inactivo por política de medicamentos): **cerrar la publicación y no reintentar**.
- Dilophosaurus («inactiva para revisar»): corregir la marca declarada.
- Haruharu: comisión 11 % e impuestos ≈ 2.5 % (en vez de ≈ 15 % y ≈ 9 %): confirmar si es otra categoría antes de subirla.

**Paso 2 · Subir las subvaluadas (31/10 – 1/11).** Editar el precio en ML y **actualizar el mismo precio en la app** (precio de tienda ≈ ML ÷ 1.2, para que etiqueta y D1 coincidan; implica reimprimir esas etiquetas). Los nuevos precios respetan las bandas muertas ($299–318 y $499–508).

| Pieza | MLM | Hoy → nuevo | Tienda ≈ | Neto |
|---|---|---|---|---|
| Kerplunk Mattel | 3731361709 | $359 → **$589** | $491 | $206 → $364 |
| Mainstays | 3731186273 | $389 → **$599** | $499 | $228 → $371 |
| Parches Mario Badescu | 3731361545 | $359 → **$549** | $458 | $206 → $333 |
| AEW Unmatched | 3731357253 | $359 → **$549** | $458 | $206 → $333 |
| Letrero Open | 6496454316 | $269 → **$449** | $374 | $159 → $274 |
| Haruharu | 6501501542 | $359 → **$519** | $433 | $206 → $310 |
| Fubbles | 3689586423 | $200 → **$289** | $241 | $106 → $174 |
| Funko Milius | 6501664640 | $359 → **$429** | $358 | $206 → $259 |

Neto = precio × 0.76 − envío (comparación); los «recibes» del Seller Center difieren unos pesos. Cada precio nuevo sigue bajo el mínimo de los rivales relevantes (Kerplunk ~16 % bajo $705, Mainstays 30 % bajo $852, Milius bajo $449). Si ML pausa alguna por el cambio, reactivarla y anotarlo. El Letrero pasa a envío gratis obligatorio (sobre $299); el neto ya lo descuenta.

**Paso 3 · Calidad y catálogo (31/10 – 2/11)**
- Completar características en las 7 publicaciones que ML señala (Naturium, Tablero, Strivectin, Biggerfive, Letrero, Mario Badescu, Astro Bot).
- «Verificar producto» en las 6 elegibles para catálogo: AEW, Kerplunk, Funko Rebel Moon, Zuru, Funko Corinthian, Funko Rosalía.
- Videos «Crear con IA» desde el celular, primero en las de ≥ $489: perro inflable, Árbol fibra óptica, Strivectin, Ozark, Bella Parker, LEGO, Kerplunk, Mario Badescu y AEW.

**Paso 4 · Aceptar las campañas de ML (desde el 4/11 y antes de que venzan; revisar la fecha límite de cada una)**
Antes de aceptar, reabrir la invitación (el «recibes» cambia tras la subida). Criterio: **excluir la pieza si el neto después del descuento queda bajo 60 % del precio de tienda** (≈ 50 % del precio ML vigente). El descuento baja el «recibes» en 0.76 × el descuento en pesos [CÁLCULO, verificado con Funko, LEGO y Bella Parker].

«Lo mejor de todos los días» (hasta 12/11):

| Pieza | Precio → con descuento | Recibes antes → después | Decisión |
|---|---|---|---|
| LEGO 76338 | $629 → $566.10 (−10 %) | $403.21 → $355.44 | Aceptar |
| Funda iPad Mini | $650 → $617.50 (−5 %) | $412.41 → $387.56 | Aceptar |
| Tablero LED | $599 → $569.05 (−5 %) | $370.43 → $347.69 | Aceptar |
| Letrero neón | $269 → $255.55 (−5 %) | $156.30 → $146.09 | Re-evaluar con el precio nuevo ($449) |
| Energizer 2032 | $250 → $225 (−10 %) | $111.02 → $93.15 | **Excluir** (piso ≈ $125; ya estaba debajo) |
| Fubbles | $200 → $180 (−10 %) | $101.90 → $88.61 | **Excluir** con $200 (piso ≈ $100); re-evaluar con $289 |

Buen Fin dentro de ML (12/11–1/12, 29 piezas):
- **3 % en 28 piezas**: baja el «recibes» entre ≈ $8 (Funko $359: $205.05 → $196.87) y ≈ $50 (perro inflable $2,159). Todas cumplen el piso salvo **Chaleco Speedo** (recibe $206.62 sobre un piso de ≈ $209.50 incluso antes del descuento; envío $111.60): **excluir**.
- **Bella Parker 10 %** ($719 → $647.10, recibes $457.56 → $402.96): cuesta ≈ $55 y cumple el piso. Decisión de Isaac; si permite un porcentaje menor, preferirlo [SIN CONFIRMAR].
- Curt Hennig 3 % ($419 → $406.43; recibes $250.62 → $241.08): aceptar.

**Paso 5 · Bajar con la herramienta de descuento, nunca editando el precio** (editar el precio a la baja dispara pausa preventiva, ver estrategia §2). El descuento individual dura máximo 14 días y se retira solo si el precio sube [OFICIAL]; al terminar la pieza vuelve al precio de lista y habrá que decidir si renovarlo (renovación: [SIN CONFIRMAR]).
- **Colchón Ozark Trail** $899 → $749 (−16.7 %): misma marca a $699, posición 21; neto $599 → $485 (65 % del precio de tienda).
- **Peluche Thready Bear** $539 → $489 (−9.3 %): iguala el catálogo de $499 y evita la banda $499–508; neto −$21.
- Opcionales: SplatRBall $1,439 → $1,379 (**−4.2 %, bajo el mínimo de 5 %: lo viable es $1,367**; está pausada); Brightroom $539 → $449 (−16.7 %, neto $326 → $274, al límite del piso).
- **No bajar:** aurora Northern Lights, velas LED, Funko Lucienne ni ISB (el neto quedaría bajo 60 %).
- Segunda ronda: Naturium $419 → $479, Árbol fibra óptica $959 → $1,049, Energizer $250 → $329.

Los descuentos exigen experiencia de compra ≥ 50 [OFICIAL], hoy «Sin calcular»; si ML no deja participar a una pieza, anotarlo en el Issue.

### 3b. Piloto de Product Ads

| Campo | Propuesta |
|---|---|
| Tipo | Campaña **manual**, no la automática (prioriza publicaciones con ventas; las nuestras no tienen) |
| Piezas | 15–30 de $359–$959 con ficha completa y precio ya ajustado. Candidatas (23): Kerplunk, AEW, Mario Badescu, Haruharu, Funko Rebel Moon, Corinthian y Rosalía, Go Fan, Kit Spider-man, Astro Bot, Zuru, Laura Ashley, Gel Good Molecules, Naturium, Bella Parker, Curt Hennig, Venom, Strivectin, Biggerfive, Árbol fibra óptica, LEGO, Thready Bear, Ozark. Excluir clase A con neto bajo y pausadas |
| Presupuesto | **$100/día** (regla de Isaac de $100 por red). 14 días = $1,400; 30 días = $3,000. Ver en Publicidad si el crédito de Despegue cubre parte (monto sin confirmar) |
| Objetivo | ROAS ~**4x** (ACOS 25 %) |
| Techo | El neto antes de publicidad es 57 % del precio en $349, 59 % en $500 y 67 % en $949: ese es el ACOS de equilibrio (ROAS mínimo 1.76, 1.69 y 1.49) [CÁLCULO] |
| Inicio y duración | ~4/11, para cubrir el Buen Fin; mínimo 14 días (aprendizaje); decisión a los 30 (~4/12) |
| Anotar cada semana | Impresiones, clics, costo, ventas atribuidas, ACOS, `lost_impression_share_by_budget` |
| Criterio de parada | (1) Una venta afectada más que lleve a 5 de 5, o una cancelación por stock: pausar todo y revisar. (2) A los 30 días, 0 ventas atribuidas: parar. (3) Ventas con ACOS arriba del equilibrio de la fila «Techo»: parar o subir ROAS objetivo. (4) ROAS ≥ 4x: ampliar presupuesto o piezas. Los umbrales 2–4 son criterio propio sobre los datos oficiales |

La campaña se crea a mano en la interfaz (la API de Ads documentada solo lee) [OFICIAL]. Una pieza vendida en caja se pausa sola y deja de gastar.

### 3c. Buen Fin: fechas y qué hacer

- **Fechas.** Buen Fin nacional 2026: viernes 13 al martes 17 de noviembre [SIN CONFIRMAR: Xataka, N+ y Bloomberg Línea; elbuenfin.org no abrió]. La ventana de ML en la cuenta es **12/11–1/12**; «Prepárate para Buen Fin» corre del 30/10 al 02/11 [VISTO].
- **Qué aceptar:** el Buen Fin de ML con las exclusiones de 3a. No hay página oficial con reglas distintas de la invitación [SIN CONFIRMAR].
- **Antes del 12/11:** precios estables, fichas completas, Ads corriendo y stock verificado contra D1.
- El registro de comercios del Buen Fin (hasta el 12/11, gratis, pide RFC y terminal) aplica a la tienda física, no a ML [SIN CONFIRMAR]. Decisión aparte.

### 3d. Cambios en la app (Issues; este PR no toca `app/`)

| Issue | Alcance | Notas |
|---|---|---|
| **#637** Visitas y ventas por publicación en el cron y en `/mercadolibre` | `GET /items/visits?ids=&date_from=&date_to=` diario en lotes de 20 → columnas `visitas_7d` y `visitas_actualizado_en` en `ml_publicaciones` (migración aditiva). Ventas 7 d desde `ml_ventas`. Añadir `tags,sub_status` a la consulta `/items?ids=` (`app/src/mercadolibre.ts`, ~línea 1169). «Publicadas» ordenable por visitas y ventas | La métrica para medir todo lo demás. Rango máx. 150 días; permiso sin confirmar |
| **#638** Invitaciones de promociones y resumen de Product Ads en `/avisos` (solo lectura) | `GET /seller-promotions/users/{id}?app_version=v2` (invitaciones con `deadline_date`) y `GET /advertising/MLM/advertisers/{id}/product_ads/campaigns/search` (`api-version: 2`) en el cron; aviso de invitación por vencer o campaña sin presupuesto | Antes, confirmar `GET /advertising/advertisers?product_id=PADS` (`Api-Version: 1`). Endpoints de Ads [OFICIAL] pero **no probados con el token de la app** |
| **#639** Despegue y reputación en `/mercadolibre` | `GET /users/reputation/seller_recovery/status` (ventas afectadas usadas/permitidas, días restantes, `advertising_amount`) y `seller_reputation` de `/users/me`; aviso rojo en `/avisos` al llegar a 4 de 5 | Se solapa con #563 (reputación): proponerlo como su primera rebanada |

Ya existen: #563 (performance, `price_to_win`, tags), #566 (preguntas), #522 y #567 (precio, neto y orden), #562 (3 fotos), #555 (ficha). Orden sugerido: #637, #639 antes del Buen Fin, #638.

### 3e. Lo que no conviene

- **Flex** (solo CDMX y Mérida; SLP no califica), **Full/Turbo** (premian stock repetible), **Mi página** ($437/mes tras 3 meses gratis, sin confirmar), **cupones del vendedor** (no existen en México).
- **Premium bajo $1,000**: probar solo con el perro inflable ($2,159) y SplatRBall ($1,439) si Isaac quiere cuotas.
- **Excel masivo y scrapers**; **bajar editando el precio**; bajar piezas con neto bajo 60 %; descuentos a usados (exigen producto nuevo).

## 4. Cómo medir

**Línea base 30/10/2026:** 30 visitas únicas en 7 días (18 en 6 publicaciones); 0 ventas (102 días sin venta); 4 de 5 ventas afectadas; calidad promedio 52 (34 de 35 bajo 70); 0 campañas de Product Ads; 0 promociones aceptadas; 6 piezas elegibles a catálogo sin verificar; 0 preguntas en 15 días.

| Qué | Dónde | Cuándo | Decisión |
|---|---|---|---|
| Visitas y ventas por publicación | Seller Center hoy; #637 después | Semanal (lunes) | Con visitas y sin ventas: revisar fotos, precio y ficha. Sin visitas: calidad y catálogo |
| ACOS, ROAS, ventas atribuidas, `lost_impression_share_by_budget` | Administrador de campañas; #638 | Semanal; cierres a 14 y 30 días | Criterios de 3b |
| Ventas afectadas y días de Despegue | Reputación; #639 | **Diario** durante el Buen Fin | A 4 de 5: ningún riesgo nuevo |
| Calidad y estado de catálogo | Listado de publicaciones; #563 | Semanal | Meta: ninguna bajo 70 |
| Neto real por venta | `ml_ventas` (precio, comisión y envío reales, #621) | Por venta | Contrastar con el neto estimado |

Anotar en el Issue #636, con fecha, cada cambio. Con 30 visitas por semana el ruido es grande: esperar 14 días antes de concluir.

## 5. Sin confirmar

1. Monto en MXN del crédito de Ads de Despegue y CPC típico: se ven en Publicidad o con `GET /advertising/advertisers/bonifications`.
2. Fechas del Buen Fin nacional (13–17/11): prensa. Reglas de ML para el evento: solo la invitación, sin página oficial.
3. Si Clásica y Premium tienen igual `listing_exposure` en México (`GET /sites/MLM/listing_types/gold_special` y `gold_pro`).
4. Si ML pausa por **subir** el precio; si el descuento individual se renueva a los 14 días; cómo se combina con una campaña de ML en la misma pieza; si se puede elegir un porcentaje menor al sugerido (Bella Parker).
5. Si la API de Ads permite crear campañas (la documentación leída solo lee) y los permisos exactos de visitas, preguntas y Ads para el token de la app.
6. Cifras de impacto de ML (videos, Ads): marketing, discrepan entre notas.
7. Las 12 visitas únicas (30 − 18) sin desglose por publicación; el mapeo ED-002915/6 a ítems MLM; Srixon sin analizar.
8. La comparación de mercado es una búsqueda por pieza, primera página, sin reputación de rivales; clases y precios propuestos son criterio del analista. Cyber Monday (30/11 según un blog) y Hot Sale 2027: sin anuncio oficial.

## Fuentes

Seller Center (solo lectura, 30/10/2026); comparación de mercado con sesión de comprador; código de la app y `docs/MERCADOLIBRE-API.md`; [docs/MERCADOLIBRE-ESTRATEGIA.md](MERCADOLIBRE-ESTRATEGIA.md).

Mercado Libre, leídas el 30/10/2026 (prefijos: V = vendedores.mercadolibre.com.mx, D = developers.mercadolibre.com.mx/es_ar, A = www.mercadolibre.com.mx/ayuda):

- Despegue: A/terminos-y-condiciones-programa-despegue_33285, D/recuperacion-reputacion
- Product Ads: V/aprender/nota/que-requisitos-debo-cumplir-para-usar-product-ads, V/nota/que-es-product-ads-y-como-funciona, V/nota/consejos-para-aumentar-tus-ventas-con-mercado-libre-publicidad, D/product-ads-para-catalogo-y-user-products-lectura, D/bonificaciones-para-product-ads
- Promociones: D/central-de-promociones, D/descuento-individual, D/campanas-del-vendedor, A/3666, V/aprender/nota/analiza-tu-alcance-para-las-fechas-comerciales
- Exposición y cuotas: V/aprender/nota/como-posicionar-tus-productos-en-los-listados, A/22737, V/nota/cuales-son-los-tipos-de-publicaciones-en-mercado-libre
- Logística y programas: D/envios-flex, V/nota/envios-full-seguridad-y-velocidad-en-tus-entregas, www.mercadolibre.com.mx/landing/mi-pagina
- Videos: V/nota/conoce-los-requisitos-para-que-tus-clips-sean-aprobados, V/aprender/nota/como-crear-videos-con-ayuda-de-ia
- Visitas: D/recurso-de-visitas

Buen Fin 2026 (prensa, sin confirmar): xataka.com.mx (buen-fin-2026-confirma-fecha-mexico...) y nmas.com.mx (el-buen-fin-2026-cambia-de-dias...).

