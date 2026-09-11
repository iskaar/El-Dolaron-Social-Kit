# Contrato del escáner — alcance de arranque (Día 1)

> Arquitectura: Claude (2026-09-11, a petición de Isaac). Implementa: Codex.
> Issue: #2. Rama: `agent/codex/2-operations-scanner-rebaseline`.
> Código y docs en español; ninguna cadena visible en inglés.

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
| Bin | Vale poco, a ojo | Bote de precio fijo: **$20 / $40 / $60** |
| Escanear | Se vendería en más de $60, o hay duda | Foto en la app |

Cualquier duda se fotografía.

## 2. Bins

- Tres productos fijos en el POS, uno por precio. Su código de barras vive en una tarjeta laminada
  junto a la caja; la cajera lo escanea una vez por pieza.
- Sin foto, sin etiqueta por pieza, **sin conteo de existencias**. El POS debe poder vender estos
  productos sin descontar stock: una bandera `sin_inventario` en el producto, no un stock negativo.
- Las ventas sí se registran, para saber cuánto aportan los bins.

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
| `destino` | `etiqueta` \| `bin_20` \| `bin_40` \| `bin_60` |

`precio_lista` es lo que costaría **nuevo en México**, en pesos, estimado por la IA. El costo real de
la pieza es desconocido y **nunca se infiere** (issue #2). No hay precio por costo más margen.

## 5. Cálculo del precio

```
precio = precio_lista × %categoria × (estado_fisico == 'danado' ? %danado : 1)
precio = redondear hacia arriba al múltiplo de $5
si precio <= 60 → destino = bin más chico que lo cubra, sin etiqueta
```

- Nunca por encima de `precio_lista`.
- Todos los porcentajes viven en la configuración del admin, ninguno en el código.
- Arranque sugerido, a confirmar por Isaac: **50 % para todas las categorías**, **60 % para dañado**,
  límite de bin **$60**. Todas las categorías empiezan igual a propósito: las diferencias se ajustan
  con ventas reales, no con suposiciones.

## 6. Admin

### Configuración
Una pantalla, una tabla: porcentaje por categoría (ropa, hogar, electrónica, juguetes, otros),
porcentaje de dañado, límite de bin y precios de los bins.

### Cola de revisión
Lo capturado, con foto y precio sugerido. Editar cualquier precio o campo, marcar a bin, descartar.
Los borradores esperan ahí el tiempo que haga falta: ese hueco **es** el búfer entre la llegada del
pallet y la salida al piso.

### Impresión de etiquetas
Por lote, desde el escritorio, para las piezas seleccionadas: nombre, precio, `precio_lista` tachado
cuando aplique, código Code128 y la **semana de ingreso** (`S37`). La semana se imprime desde el día
uno aunque todavía no se use: habilita las rebajas por antigüedad sin reetiquetar nada.

## 7. Límites de este alcance

- Sin credenciales, sin servicios de pago, sin despliegue a producción, sin publicar en redes.
- Un solo maestro de existencias. Ningún otro lugar guarda una cantidad.
- Sin segunda fórmula de redondeo ni de precio en ningún otro archivo.

## 8. Validación (con hardware real, no capturas)

1. Diez piezas fotografiadas seguidas sin que la cámara se cierre ni se bloquee.
2. Matar la red a media tanda: no se pierde ninguna foto; al volver la conexión se analizan solas.
3. Una pieza dañada y una nueva del mismo artículo dan precios distintos según la tabla del admin.
4. Una pieza que calcula $55 aparece marcada como bin y no imprime etiqueta.
5. La etiqueta impresa a tamaño real se lee con el lector de código de barras.
6. Los tres bins se cobran en el POS sin tocar existencias.

## 9. Diferido a propósito (no construir todavía)

- Niveles de demanda (alta / media / baja) y precio por tipo de artículo.
- Rebajas por semana de ingreso aplicadas en el POS.
- Reporte de días en venta por categoría, para ajustar los porcentajes con datos.
- Varias fotos por pieza, talla y color, publicación en eshop o marketplace.

Cada uno entra con su propio Issue, cuando haya ventas reales que lo justifiquen.
