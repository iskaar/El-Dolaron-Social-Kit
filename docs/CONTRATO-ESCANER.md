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

Ya no hay montón de "bin a ojo": toda pieza vendible se fotografía y la IA decide el
precio. Ese precio es lo que enruta la pieza a banda o a etiqueta propia (§5), no un
juicio en el pasillo.

## 2. Bandas

Detalle completo en `docs/PLAN-ETIQUETAS-POR-BANDA.md`. Resumen:

- Catorce productos fijos en el POS — siete precios ($19/$29/$49/$79/$99/$149/$199) ×
  dos familias (ropa/general). Sus catorce códigos de barras viven en una tarjeta
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
- Interruptor **Nuevo / Dañado** junto al obturador. Conserva su estado entre disparos y también se
  puede corregir tocando la última miniatura.
- Tira de miniaturas abajo y un contador discreto: `24 fotos · 19 analizadas`. Es la única señal de
  que existe la IA.
- Una foto = una pieza.

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
| `estado_fisico` | `nuevo` \| `danado`, del interruptor |
| `estado_analisis` | `pendiente` \| `listo` \| `error` |
| `nombre`, `categoria`, `precio_lista` | IA, editable en el admin |
| `precio` | Calculado (§5), editable en el admin |
| `destino` | `etiqueta` \| `banda_r19` … `banda_r199` \| `banda_g19` … `banda_g199` |

`precio_lista` es lo que costaría **nuevo en México**, en pesos, estimado por la IA. El costo real de
la pieza es desconocido y **nunca se infiere** (issue #2). No hay precio por costo más margen.

## 5. Cálculo del precio

```
precio = precio_lista × %categoria × (estado_fisico == 'danado' ? %danado : 1)
precio = redondear hacia arriba al múltiplo de $5
si precio <= 200 → destino = banda mas chica que lo cubra (familia = ropa|general), sin etiqueta propia
si no → etiqueta individual, y el precio quiebra la decena: redondeo a $10 menos $1 ($250 → $249, $233 → $239)
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
porcentaje de dañado, límite de banda y los siete precios de banda (compartidos por ropa/general).

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

- Sin credenciales, sin servicios de pago, sin despliegue a producción, sin publicar en redes.
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
