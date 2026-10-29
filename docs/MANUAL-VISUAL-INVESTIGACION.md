# Manual visual de la revendedora · Investigación (Issue #594, Fase 1)

Investigación previa al manual interactivo. No cambia código. Construye sobre [REVENDEDORAS-UX.md](REVENDEDORAS-UX.md) (#579): no repite sus principios P1–P10 ni la prueba de §7; los usa. Hecha el 29/10/2026 sobre `main` 2e58a37.

Convención de fuentes, igual que en #579:

- **Leído**: se abrió la página (o el PDF) y de ahí salen los datos.
- **Solo resumen de búsqueda**: lo dijo un resumen del buscador; **no está verificado**.
- **403 / sin acceso**: se intentó abrir y el sitio lo negó; el dato queda como resumen de búsqueda.
- **Criterio propio**: decisión de este documento, sin estudio detrás.

---

## 1. Resumen

1. **Formato:** una sola página, «Manual de la revendedora», con **una tarea por pantalla**. Cada tarea es una **réplica tocable de la pantalla real de `/vender`** (mismo marcado y estilos, datos de ejemplo, sin API), no capturas ni video.
2. **Cada tarjeta:** una acción, hasta 3 pasos, hasta 25 palabras, menos de 60 segundos. Un marco gris con la franja «PRÁCTICA: no se manda nada de verdad» la distingue de la app real. Se imprime como hoja de pasos fijos.
3. **Dónde vive:** dentro de la app, detrás de Access, en `/manual` (rol `revendedora`). Protege los datos de pago, reutiliza `vender.js` (los textos no se desfasan) y exige un cambio chico en el Worker.
4. **Cómo llega:** primera sesión **en persona de 15 minutos** con su teléfono (P-2 de #579); el enlace se manda por WhatsApp después. Cada tarjeta tiene su propio enlace (`/manual#vendi`) para contestar dudas con un solo toque.
5. **Cómo se sabe que sirve:** la prueba de 5 pasos de #579 §7 con una revendedora real (4 de 5 sin ayuda), y en la primera semana: primera venta, preguntas por tarjeta y si volvió a abrir `/vender`.

La evidencia sólida es de aprendizaje y de interfaces para baja alfabetización, no de revendedoras. Lo específico de **practicar en una copia de la pantalla real** viene de investigación antigua y de pruebas pequeñas (§3). Por eso la prueba con una persona real manda.

---

## 2. Cómo lo hacen las empresas

La mayoría de las empresas **no publica** sus materiales de capacitación ni sus resultados. Donde no se encontró, la tabla lo dice. Ninguna fuente de esta tabla demuestra que su formato funcione mejor que otro.

| Empresa | Formato y entrega | Duración de las piezas | Evidencia de que funciona | Fuente y estado |
| --- | --- | --- | --- | --- |
| **Avon** (México) | Academia de Representantes con contenido digital personalizado; app Avon On (pedidos, avisos de novedades, preguntas frecuentes). | No encontrada. | Ninguna. | Resumen de búsqueda (Forbes México, Direct Selling News). Sin verificar. |
| **Natura** (México) | El comunicado de 2025 habla de «oportunidades de formación» sin detallar cursos. Páginas de Chile, Colombia y Ecuador describen cursos en línea de finanzas, digitalización y emociones; no se confirmó para México. | No encontrada. | Ninguna. | Resumen de búsqueda. La página del comunicado dio 403. |
| **Betterware** | App Betterware+ para pedidos y administración de la cuenta. No se encontró academia ni videos. | No encontrada. | Ninguna. | Resumen de búsqueda (App Store, informe de sostenibilidad). |
| **Jafra, Tupperware** | Jafra: app JafraNet y TikTok con consejos. Tupperware: app «Pasaporte al Éxito» para **registrar asistencia a capacitaciones** (es decir, capacitación presencial con control). | No encontrada. | Ninguna. | Resumen de búsqueda (App Store). |
| **Andrea, Price Shoes** | No se encontró nada público. | n/d | n/d | Búsqueda sin resultados. |
| **Meesho** (India) | Dos vías: asistida (webinars de aprox. una hora y sesiones uno a uno) y autoaprendizaje (YouTube y un «Supplier Learning Hub» con infografías y videos). Contenido en hindi e inglés. | Webinar de aprox. 1 h; los videos no indican duración. | Ninguna publicada. | Resumen de búsqueda del blog de Meesho (403 al abrirlo). |
| **Elenas** | La plataforma maneja logística y pagos; la vendedora solo vende desde el celular. No se encontró academia ni formato de capacitación. | n/d | Ninguna. | [Expansión](https://expansion.mx/tecnologia/2021/10/27/elenas-app-va-por-un-mercado-de-emprendedoras-valuado-en-30-mdd): leído en #579. |
| **Uber, DiDi** | DiDi (Australia): una página del centro de ayuda pide ver un **video** de incorporación de seguridad; sin duración, examen ni prueba de que lo vio. Uber: una animación de pasos para la app de conductores, según un estudio de animación. | n/d | Ninguna. | DiDi: **leído** ([ayuda](https://web.didiglobal.com/au/help-center/driver-safety-onboarding-training/)). Uber: la página redirigió y no se pudo abrir; resumen de búsqueda. |
| **Rappi** | Portal de aprendizaje SoyRappi con cursos gratuitos de Microsoft (alfabetización digital, habilidades blandas, emprendimiento...) en nueve países, México incluido. El alta usa la app «Rappi Partner»; una capacitación en línea «si se requiere» y evaluación (sitio no oficial). | No indicada. | Ninguna. | [Enter.co](https://www.enter.co/especiales/dev/rappi-y-microsoft-lanza-cursos-en-tecnologia-para-repartidores/): **leído** (no dice cómo se entrega ni cuánto dura). Alta: resumen de búsqueda. |
| **Walmart** | Más de 45 módulos de realidad virtual (tecnología nueva, trato al cliente, cumplimiento) en más de 17 000 visores; antes, 10 tiendas de prueba. | El artículo no da la duración. El proveedor (Strivr) dice que un curso bajó de 8 h a 15 min. | **Autoinformada**: Walmart dice que las calificaciones de los exámenes subieron 10 a 15 %. Sin evaluación independiente. | [Retail Dive](https://www.retaildive.com/news/walmart-expands-vr-training-to-every-us-store/533201): **leído**. Strivr: resumen de búsqueda (marketing). |
| **OXXO** | Capacitación al ingresar y acceso a la Universidad FEMSA (cursos desde secundaria hasta habilidades de oficio). Encuestas al empleado a los **7 y 30 días** de entrar. Rotación mayor a 90 %. | No indicada. | Ninguna sobre aprendizaje. La rotación muestra que la capacitación no basta para retener. | [Expansión](https://expansion.mx/carrera/2023/10/23/oxxo-segunda-caja-cerrada): **leído**. |
| **McDonald's** | Un entrenador prepara con guías, presenta con curso en línea o ficha y **practica en la estación** con listas de observación. | n/d | Ninguna. | Solo documentos de Scribd y sitios espejo, no oficiales: **no confiable**. |
| **Starbucks** | «Barista Basics»: capacitación uno a uno con un entrenador. | n/d | Ninguna. | Agregadores, no oficial: **no confiable**. |
| **Mercado Libre** | «Central de aprendizaje» para vendedores y webinars; «Mercado Ads Academy» gratuita con certificado. Lecciones en video de **38 a 57 minutos**, según el buscador. | 38 a 57 min por lección. | Ninguna publicada. | Resumen de búsqueda; las páginas dieron 403. No se encontró nada de Mercado Pago. |

Lo que sí se puede decir:

- **El patrón visible es entrenador + práctica en el puesto + cuestionario o lista de observación** (McDonald's, Starbucks, Tupperware con asistencia), pero con fuentes débiles. Donde el contenido es de pantallas (Rappi, DiDi, Uber, Meesho) la pieza es **video o curso aparte**, no práctica dentro de la pantalla.
- **Ninguna empresa publica una réplica tocable de su propia app para entrenar.** Esa es la apuesta de El Dolarón. Se apoya en la literatura de §3, no en un caso de empresa.
- **Medir:** el único caso de medición de onboarding que se encontró es OXXO, con encuestas a los 7 y 30 días. Es la idea que se adopta (§4).
- Las lecciones largas de Mercado Libre (38 a 57 min) son el contraejemplo para esta población.

---

## 3. Qué formatos funcionan y con qué evidencia

Calidad: **A** = estudio abierto con datos; **B** = guía de un organismo o revisión; **C** = resumen de secundaria o de buscador; **D** = marketing de proveedor o dato autoinformado.

### 3.1 Tabla de evidencia

| Formato o práctica | Qué dice la evidencia | Cal. | Fuente y estado | Qué significa aquí |
| --- | --- | --- | --- | --- |
| **Interfaz gráfica, no de texto, para quien lee poco** | Banca móvil con 58 personas analfabetas o semianalfabetas, **sin capacitación**: con texto **nadie** completó la operación; con diálogo hablado 72 %; con interfaz gráfica **100 %** (más lenta y con más ayuda). | A | [Medhi et al. 2011, ACM ToCHI](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ToCHI2711_Medhi.pdf): **leído** (PDF) | Foto, ícono y botón con palabra. El manual no debe ser un muro de texto. `/vender` ya es gráfico (foto primero). |
| **Mediador humano** | Su recomendación 8: «integrar mediadores humanos» para familiarizar con escenarios e interfaces. Otras: pistas gráficas, anotación de voz, nada de menús con scroll, evitar texto no numérico. | A | Medhi 2011: **leído** | Respalda la primera sesión en persona y que cada tarjeta quepa sin desplazarse. Las personas del estudio son analfabetas; las revendedoras leen poco, no nada. Extrapolación. |
| **Pasos con medios ricos en el teléfono** | 50 trabajadores comunitarios de salud, cruzado: ayudas interactivas con texto, voz e imagen redujeron errores en **33 %** y subieron el cumplimiento del protocolo en **30 %** frente a hojas en papel (1 394 casos). | A (laboratorio, simuladores) | [Florez-Arango et al. 2011, JAMIA](https://chwcentral.org/wp-content/uploads/2013/11/Florez-Arango-Mobile-CHWs.pdf): **leído** (PDF) | Una guía paso a paso en el teléfono superó al papel, pero en un laboratorio. El papel sigue siendo respaldo, no lo principal. |
| **Video de agricultor a agricultor** | Ensayo con 420 aldeas en Bihar (India): el video no cambió la adopción de la técnica al año; con el modelo bayesiano que prefieren los autores subió el rendimiento (+228 kg/acre) y las ganancias (9 a 24 %). Costó 96 rupias por agricultora. | A (resultado mixto) | [J-PAL, Digital Green](https://www.povertyactionlab.org/evaluation/video-based-group-extension-women-farmers-india-0): **leído** | El video funciona, pero de manera modesta y en **grupo con facilitadora**. No dice cuánto debe durar. |
| **Interfaz con «ruedas de entrenamiento»** (solo pocas funciones al inicio) | Carroll: 26 % más rápido y 69 % más datos aprendidos (estudio 1); 21 % y 21 % (estudio 2). Con 12 participantes en el estudio original; resultados de hace 40 años. | A/C (antiguo, pequeño) | [NN/g, Training Wheels](https://www.nngroup.com/articles/training-wheels-user-interface/): **leído** (resumen de NN/g). Estudio original: resumen de búsqueda. | Es lo más cercano a «practicar en una copia»: una pantalla recortada y segura. NN/g **no** habla de modos de práctica; esa extensión es nuestra. |
| **Manual mínimo** (empezar a hacer, no leer) | Los que usaron el manual mínimo aprendieron más rápido y con menos errores que con el manual convencional. Una crítica señala que los investigadores diseñaron las tareas. | C | Resumen de búsqueda (Carroll et al., IBM 1986). No se abrió. | Apoya «una tarea = una pantalla con acción». Evidencia débil y antigua. |
| **Ejemplos resueltos para principiantes** | Estudiar pasos resueltos supera a resolver problemas desde cero **en principiantes**; el beneficio se invierte con la experiencia; conviene ir quitando pasos (desvanecer). | B/C | [Wikipedia, Worked-example effect](https://en.wikipedia.org/wiki/Worked-example_effect): **leído** (secundaria, resume a Sweller, Renkl, Kalyuga) | Orden de cada tarea: primero **ver** el paso resuelto, luego hacerlo tú, y la segunda vez con menos ayuda. |
| **Recuperar en vez de releer** | Estudiantes que se examinaron recordaron **más a la semana** que los que releyeron, aunque se sentían más seguros después de releer. | A | [Roediger y Karpicke 2006](https://pubmed.ncbi.nlm.nih.gov/16507066/): **leído** (resumen; el artículo no se abrió) | «Repetir» tiene que pedir hacer la tarea, no mirar otra vez. Y no medir «le gustó» sino «lo hizo». |
| **Principios multimedia** (segmentar, señalar, no repetir lo mismo en texto y voz, texto junto a la imagen) | Mayer reporta tamaños de efecto medianos: segmentar d aprox. 0.7, preentrenar aprox. 0.5 a 0.75, modalidad aprox. 0.7; señalar d = 0.38 en un metaanálisis independiente (29 estudios, 2 726 personas). Mayor efecto en quienes saben poco. | B/C | Lista de principios: [Dartmouth](https://services.dartmouth.edu/TDClient/1806/Portal/KB/PrintArticle?ID=171655): **leído** (secundaria). Cifras: resumen de búsqueda (Mayer 2014, 2017; Alpizar et al. 2020). | Un tema por tarjeta; resaltar lo que se toca; el texto pegado a lo que describe. Las cifras son de universitarios, no de esta población. |
| **Pistas una a una, cortas y que no parezcan interfaz** | Las pistas encadenadas se descartan; mejor una por acción, con imágenes y texto ultracorto; una pista demasiado pulida se confundió con botones reales. Evidencia cualitativa. | B | [NN/g, Mobile Instructional Overlay](https://www.nngroup.com/articles/mobile-instructional-overlay/): **leído** | La réplica debe verse **distinta** de la app real (marco, franja). |
| **Contenido para personas con dificultades cognitivas** | Patrones de W3C: pasos claros y separados, texto breve, rutas cortas, ayuda humana, pocos elementos, deshacer, avisos de resultado. Nota del grupo de trabajo, abril 2021, no obligatoria. | B | [W3C COGA](https://www.w3.org/TR/coga-usable/): **leído** (índice de objetivos y patrones) | Lista de verificación para cada tarjeta: 4.2.4, 4.4.5, 4.4.9, 4.6.2, 4.6.3, 4.8.1. |
| **Personas mayores** | Letra pequeña, botones chicos y texto claro cuestan más; aceptar formatos variados; errores simples y visibles. | B | [NN/g, Seniors](https://www.nngroup.com/articles/usability-for-senior-citizens/): **leído** (no trae la cifra del estudio de 2013) | Ya aplicado en `body.rev` (#579). |
| **Lectura sencilla** | GOV.UK escribe para edad lectora de 9 años, incluyendo textos para especialistas. | B/C | Resumen de búsqueda; las páginas de GOV.UK no se pudieron abrir (redirecciones) | Se mantiene el piso de #579 P4: frases de 8 palabras o menos. |
| **Curso por WhatsApp** | Un ensayo con 208 enfermeras en Pakistán, 12 semanas por WhatsApp: mejor aprendizaje en control de infecciones y comunicación que el grupo control. Muestra pequeña, durante pandemia. | C | Resumen de búsqueda (PMC dio verificación del navegador; Frontiers 404). No se abrió. | Hay señal de que WhatsApp sirve como canal, pero no hay evidencia sobre vendedoras ni sobre tareas en pantalla. |
| **Compañeras que enseñan a mayores** | Solo protocolos y resúmenes de proyecto, sin comparación controlada con aula; un ensayo en Japón mide pasos al caminar, no habilidad digital. | C | Resumen de búsqueda | No hay evidencia que decida «madrina sí o no». Se propone por criterio propio, probarla. |
| **VR de Walmart** | Subida de 10 a 15 % en calificaciones. | D | Retail Dive (leído) repite lo que dice Walmart | No se usa como evidencia. Tampoco aplica: no hay visores. |

### 3.2 Qué se concluye

1. **Hacer supera a leer, y el paso resuelto precede a la práctica.** Ejemplos resueltos para principiantes (B/C) más recuperación (A). La secuencia de cada tarjeta: ver el paso hecho, hacerlo con ayuda, repetirlo con menos ayuda.
2. **Gráfico antes que texto, y una persona antes que un documento** (Medhi, A). Ninguna fuente abierta demuestra que un manual solo, sin sesión en persona, baste para esta población.
3. **Pocas cosas por pantalla y pistas que no parezcan la interfaz** (NN/g, COGA).
4. **Video: sin evidencia de duración ideal.** El único ensayo abierto (Digital Green) usó videos con una facilitadora en grupo. Casi nada de este manual necesita video; si hay alguno, que sea un clip de menos de 15 segundos de la pantalla del navegador (instalación del ícono), que no se puede replicar. Criterio propio.
5. **Lo no demostrado:** que una réplica tocable de una app real mejore la retención de vendedoras de venta directa. Es una hipótesis razonable; la prueba con una persona real la confirma o la descarta.

---

## 4. Entrega y medición

### 4.1 Cómo llega a las personas

| Canal | Qué se sabe | Uso recomendado |
| --- | --- | --- |
| **Sesión en persona con su teléfono** | Medhi recomienda mediadores humanos; COGA 4.8.1 «Provide Human Help» (ambos leídos). Starbucks y McDonald's usan entrenador (fuentes no confiables). | **Obligatoria el primer día** (P-2 de #579): 15 minutos, ella toca, el manual abierto en su teléfono. |
| **Enlace por WhatsApp** | Es su terreno (#579 §1). Hay un ensayo de cursos por WhatsApp con enfermeras (resumen de búsqueda). | Se manda **después** de la sesión, con el enlace general y, ante dudas, el de la **tarjeta exacta**. |
| **Hoja impresa** | La ayuda en papel rindió peor que el teléfono en Florez-Arango, pero sigue valiendo sin señal ni batería. | Una hoja de 5 pasos con la pantalla final de cada tarea, que se entrega en la sesión. Es la salida del modo impresión del mismo manual. |
| **PDF** | Sin evidencia a favor. Un PDF denso se lee mal en un Android barato. | No como formato principal. Solo lo que el navegador genera al imprimir. |
| **Chatbot por WhatsApp** | Sin evidencia ni fuente abierta para esta población. Costaría un servicio nuevo. | No. |

### 4.2 Cómo se mide, sin servicios nuevos

Las empresas encontradas casi no publican medición. Solo OXXO menciona encuestas a los 7 y 30 días (leído). Se adopta eso y se agregan las medidas que la tienda ya tiene.

| Medida | Cómo se obtiene hoy | Criterio |
| --- | --- | --- |
| **Prueba de 5 pasos** (#579 §7) | En persona, con cronómetro y hoja de notas. | 4 de 5 sin ayuda; ninguna duda de «¿se guardó?» después del paso 3. Con 3 personas. |
| **Primera venta guardada** | Ya existe en D1 (`pedidos` con `vendedora`) y en `/reportes`. | Meta tentativa: antes del día 7. Criterio propio. |
| **Primera pieza compartida** | **No se registra en el servidor** (la marca «Ya la compartiste» vive en el navegador). | Preguntarle el día 1: «¿ya mandaste una pieza?». |
| **Dudas por tarjeta** | Cada duda por WhatsApp se contesta con el enlace de la tarjeta y se anota la tarjeta en una hoja. | Una tarjeta con 2 o más dudas por semana se rehace. |
| **Volvió a abrir** | `/reportes` y la hora de la última venta. | Que haya abierto `/vender` en el día 2 y en el día 7. |
| **Encuesta corta a los 7 y 30 días** (como OXXO) | Un mensaje de WhatsApp con 2 preguntas: «¿qué fue lo más difícil?» y «¿qué no entendiste?». | Texto libre; no hay una escala. |

Cuidado con lo que enseña Roediger y Karpicke (A): lo que ella diga que entendió no equivale a que lo sepa hacer. Medir con la tarea, no con la opinión.

---

## 5. Recomendación para El Dolarón

### 5.1 Formato

**Una página, una tarea por tarjeta, réplica tocable.** Cada tarjeta es una pantalla del teléfono (360 px) con:

1. Un título con verbo: «Compartir una pieza».
2. Una frase de objetivo, hasta 12 palabras: «Mándala por WhatsApp a quien quieras.»
3. **La réplica**: el mismo marcado y los mismos estilos que `vender.html`, con datos de ejemplo. Toca el botón real; pasa lo que pasaría, sin llamar a la API ni abrir WhatsApp.
4. **Un solo siguiente paso resaltado** (anillo y flecha con la palabra «Toca aquí», no solo color) y un pie con una frase de hasta 25 palabras que cambia en cada paso.
5. Dos botones: «Repetir» (reinicia la réplica) y «Siguiente tarea». Nada más.

Orden de aprendizaje de cada tarjeta, basado en §3.2: (1) **mira**: la réplica corre sola una vez, 5 segundos; (2) **tócalo tú**: con el resaltado; (3) **otra vez sin ayuda**: «Repetir» quita el resaltado.

### 5.2 Qué usar: capturas, réplica o las dos

| Opción | Pro | Contra | Decisión |
| --- | --- | --- | --- |
| **Capturas reales anotadas** | Muestran el teléfono verdadero, incluido el navegador. Fáciles de hacer. | No se tocan; se desfasan en cuanto cambia la app; pesan; las flechas ocultan datos; es imposible practicar. | Solo donde la réplica no llega: la barra del navegador (instalar el ícono). Máximo 4 imágenes WebP de hasta 20 KB. |
| **Réplica con el marcado de `vender.html`** | Se toca; copia los textos reales; se puede escribir un test que falle si cambia una etiqueta; ligera. | Es una copia de CSS (el de `vender.html` es de 140 líneas dentro de la propia página); si cambia la app y no el manual, se desfasa. | **Principal.** |
| **Las dos** | La pantalla real del teléfono más lo que se toca. | Más trabajo. | **Sí, con la réplica como base** y las capturas solo para el navegador. |

Para que la réplica no se desfase:

- Importar de `/vender.js` las funciones puras que ya existen (`estadoMia`, `agruparMias`, `textoAvisoCliente`, `textoWhatsApp`, `fechaLegible`, `pesos`): los chips, el plazo y los mensajes salen del mismo código que la app.
- Copiar el CSS de `vender.html` dentro de `manual.html` (sin tocar `vender.html` en esta unidad). Un test compara cada texto con `data-etiqueta="..."` contra `vender.html` y `vender.js`. Si alguien cambia «Ya la vendí», el test falla en el mismo PR.

### 5.3 Largo y lectura

| Dato | Valor | Fuente |
| --- | --- | --- |
| Tareas por tarjeta | 1 | NN/g, COGA 4.6.2 |
| Pasos por tarjeta | hasta 3 toques | Criterio propio |
| Palabras por pie | hasta 25; frases de 8 palabras o menos | #579 P4; criterio propio |
| Tiempo | hasta 60 s por tarjeta | Criterio propio (no hay estudio que fije un máximo) |
| Nivel | 6.º grado de primaria; «tú»; verbos de acción; nada de «cola», «tramo», «identificador» | #579 P4 |
| Tamaño de letra y toques | los de `body.rev`: 18 px y 56 px | #579 A11 |
| Prueba de lectura | Que una persona de la familia la lea en voz alta sin tropezar | Criterio propio |

### 5.4 Dónde vive

| Opción | A favor | En contra |
| --- | --- | --- |
| **Artifact** (página privada de claude.ai) | Sin cambio en el Worker; se publica en minutos. | Es un host de terceros. **No verificado** si una persona sin cuenta de Claude puede abrirlo (se prueba en un teléfono sin sesión). Copia el código, así que **se desfasa**. Los datos de pago salen del dominio de la tienda. |
| **`site/public/`** | Abre sin entrar; ya tiene dominio, HTTPS y publicación. | Es público: `robots.txt` dice `Allow: /` y el sitemap lo lista. Hay que poner `noindex` y quedaría el enlace público de todos modos. Se publica solo al hacer merge (decisión de Isaac). Otro origen (`eldolaron.com` vs `viste.com.mx`): no puede importar `vender.js`. Los datos de pago quedarían públicos. |
| **Dentro de la app, `/manual`** (**recomendada**) | Detrás de Access; los datos de pago no son públicos. Mismo origen: importa `vender.js` y `/vender.js` ya está abierto para el rol. Sin dominio ni servicio nuevos. | Requiere un cambio de Worker: una línea en `PANTALLAS` de `app/src/cuentas.ts` (`'/manual': VENDER`) y su prueba en `revendedoras.test.ts`. La revendedora debe haber entrado antes (código por correo). |

**Recomendación: `/manual` dentro de la app.** Razones:

1. El manual contiene los datos bancarios de la tienda. Detrás de Access no quedan indexables ni públicos. No se verificó cuánto riesgo hay en publicar una CLABE; el criterio es no publicarla.
2. Reutiliza `vender.js`: los textos salen del mismo código.
3. El cambio de Worker es de una línea y una prueba, y hoy las rutas `.js` ya se sirven a cualquier cuenta (`permiso()` en `cuentas.ts`).
4. El problema de «necesita entrar para ver cómo entrar» se resuelve con la sesión en persona y la hoja impresa «Entrar», que **no lleva datos de pago**. Si Isaac quiere una versión sin entrar, una página pública con solo las tarjetas T0 y T9 de la §6 (sin datos de pago, `noindex`) es una unidad aparte, no esta.

Si Isaac prefiere no tocar el Worker, el plan B es un Artifact **sin datos de pago** (los datos se dan por WhatsApp), y se acepta el desfase.

### 5.5 Primera semana

| Día | Qué pasa | Quién |
| --- | --- | --- |
| 0 | Sesión en persona de 15 min (P-2 de #579): ella entra con el código, pone el ícono, abre `/manual` y hace T1, T4, T5 en la réplica. Luego hace una venta de práctica real contra el sandbox con Isaac como cliente. Se le da la hoja impresa. | Isaac |
| 0 (tarde) | Mensaje de bienvenida (P-3 de #579) con el enlace de `/manual`. | Isaac |
| 1 | «¿Pudiste entrar?» y «¿ya mandaste una pieza?». Se anota. | Isaac |
| 2 a 3 | Cualquier duda se contesta **con el enlace de la tarjeta** (`/manual#vendi`), no con otro texto. Se anota qué tarjeta. | Isaac |
| 7 | Mensaje de 2 preguntas (§4.2). Se revisa `/reportes`: ¿primera venta? Se explica la regla del lunes (T8). | Isaac |
| 30 | Mismo mensaje. Si 2 o más personas fallaron en la misma tarjeta, se rehace. | Isaac |

### 5.6 Cómo probarlo con una revendedora real

Es la prueba de #579 §7, con un cambio: el paso 1 empieza en `/manual`, y se agrega una pregunta final.

1. Una persona de 50 años o más que use WhatsApp y no use apps. Su teléfono, con permiso para anotar.
2. **Antes de enseñarle nada**, pedirle las 5 tareas de #579 §7 en la app real del sandbox. Anotar dónde duda. (Línea base.)
3. Darle el manual y pedirle que haga solo las tarjetas T1, T4, T5 y T6.
4. Repetir las 5 tareas en la app real del sandbox, con datos nuevos. Aquí cuenta el éxito sin ayuda.
5. **A los 7 días** (Roediger y Karpicke: lo que importa es lo que recuerda después): pedirle una tarea sin avisar.

Qué anotar, además de lo de #579: qué tarjeta repite, si toca el marco de práctica pensando que es real, si intenta «Avisarle» y espera que abra WhatsApp (la réplica no lo abre), cuánto tarda en la primera tarjeta. Criterio: 4 de 5 sin ayuda y ninguna confusión entre práctica y venta real. Si falla, no se publica.

---

## 6. Especificación para la Fase 2

**Archivo:** `app/public/manual.html`, una sola página con CSS y JS dentro, sin dependencias, con un `<script type="module">` que importa de `/vender.js`. Más: una línea en `PANTALLAS` de `app/src/cuentas.ts` y una prueba nueva `app/src/manual.test.ts`. No se toca `vender.html` ni la API. Hospedaje definitivo: decisión de Isaac (§8).

### 6.1 Tarjetas

Las etiquetas son **las de la app hoy**, tomadas de `vender.html` (V) y `vender.js` (J) en `main` 2e58a37. Las que salen del código con `${...}` se llenan con datos de ejemplo.

| # | Tarjeta (id de enlace) | Etiquetas exactas en pantalla | Qué muestra | Qué debe simular la réplica |
| --- | --- | --- | --- | --- |
| T0 | **Entrar y poner el ícono** (`#entrar`) | V: «Ponla en tu pantalla de inicio». Android: «Toca los tres puntos ⋮ de arriba. Elige “Instalar app” o “Añadir a la pantalla de inicio”.» iPhone: «Toca el botón de compartir (cuadro con flecha). Elige “Añadir a pantalla de inicio”.» | Captura del navegador del teléfono con una flecha; el código por correo se explica en persona. | Nada tocable. Es la única tarjeta con capturas (hasta 4 WebP). Comprobar el menú en un teléfono real; varía por versión (#579). |
| T1 | **Compartir una pieza** (`#compartir`) | V: pestañas «Piezas», «Mis ventas», «Preguntaron»; en la tarjeta: «Compartir», «Ya la vendí», «Anotar a un cliente», «Elegir»; diálogo: «Compartir en WhatsApp», «Preparando foto 1 de 1…», «Enviar por WhatsApp», «Volver», «¿No se abrió WhatsApp?»; resultado: «✓ Listo. Compartiste 1 pieza.»; chip: «✓ Ya la compartiste». | La tarjeta de una pieza de ejemplo (foto de ejemplo, nombre, precio, código ED-…). | Toque «Compartir» → diálogo con «Preparando…» 1 s → habilita «Enviar por WhatsApp» → hoja simulada «Compartir con...» → «✓ Listo. Compartiste 1 pieza.» y aparece el chip «✓ Ya la compartiste». «Volver» cierra. «¿No se abrió WhatsApp?» se abre y muestra los dos botones. |
| T2 | **Compartir varias a la vez** (`#varias`) *(opcional)* | V: «Elegir», «Compartir 3 en WhatsApp», «Quitar elegidas», «Máximo 10 piezas a la vez.» | Tres piezas de ejemplo. | Marcar «Elegir» actualiza el contador del pie; «Quitar elegidas» limpia; la décima primera muestra el máximo. |
| T3 | **Encontrar la pieza que te piden** (`#buscar`) | V: «Me escribieron con un código», «Pega aquí el mensaje de tu cliente», «Ejemplo: la quiero ED-002335», «Buscar la pieza»; también «Buscar una pieza», «Nombre o código», «Categoría», «Solo las de hoy», «Buscar»; error: «Pega el mensaje de tu cliente. Debe traer el código, por ejemplo ED-002335.» | Un chat de ejemplo de WhatsApp con «la quiero ED-002335». | Botón «Escribir el ejemplo» llena el campo (no se puede pegar del portapapeles real); «Buscar la pieza» muestra la tarjeta. Campo vacío muestra el error de la app. |
| T4 | **Ya la vendí** (`#vendi`) | V: «Ya la vendí», «¿Quién la compró?», «WhatsApp de quien la compró», «10 números. Ejemplo: 444 123 4567», «¿Cómo la recibe?», «La recoge en la tienda», «Se la mandan a su casa (envío)», línea de envío (ver §8, decisión 3), las tres reglas («La pieza queda apartada 48 horas.», «Quien la compró paga en la tienda.», «Si no paga a tiempo, la pieza vuelve a la venta.»), «Guardar venta», «Volver». Errores: «Escribe los 10 números del WhatsApp de quien la compró.» | El formulario con la pieza arriba. | Campos con los mismos `required`; nombre y teléfono de ejemplo para llenar con un toque («Llenar con ejemplo»); al elegir envío aparece la línea; «Guardar venta» abre T5. Teléfono incompleto muestra el error. |
| T5 | **Venta guardada: avisarle al cliente** (`#avisar`) | V: «¡Venta guardada!», «Tienes hasta el {fecha} para que pague.», «El pago se hace en la tienda. Si no paga a tiempo, la pieza vuelve a la venta.», «Avisarle a {cliente} por WhatsApp», «Seguir con otras piezas». | El diálogo de éxito. La fecha sale de `fechaLegible()` con ahora + 48 h. | «Avisarle a…» **no abre WhatsApp**: muestra una burbuja con el texto de `textoAvisoCliente()`. «Seguir con otras piezas» pasa a T6. |
| T6 | **Mis ventas** (`#mis-ventas`) | V/J: «Mis ventas», «Ventas que la tienda ya cobró: $…», «{n} esperando pago», grupos «Esperando pago», «Ya pagadas», «Anteriores»; chips de `estadoMia()` (J): «⏳ Esperando pago · te quedan {n} h», «⚠ Se vence pronto · te quedan {n} h», «✓ Cobrada: la tienda ya cobró», «✕ Cancelada», «✕ Se venció · la pieza volvió a la venta»; «Recoge en la tienda» / «Envío a su casa»; «Actualizar», «Actualizado a las …». | Cuatro ventas de ejemplo que muestran cada chip. Un recuadro «Qué significa» con ícono+palabra. | Tocar un chip abre una frase de lo que significa y qué hacer; «Actualizar» cambia la hora. Los chips se calculan con `estadoMia()` y `agruparMias()`. |
| T7 | **Cancelar una venta** (`#cancelar`) | V: «Cancelar venta», «¿Cancelar la venta a {cliente}?», «La pieza vuelve a estar en venta.», «Sí, cancelar», «No, dejarla»; resultado: «✓ Venta a {cliente} cancelada. La pieza volvió a la venta.» | La venta de ejemplo con el botón. | El flujo completo; la tarjeta pasa a «✕ Cancelada» y se mueve a «Anteriores». «Entendido» cierra el aviso. |
| T8 | **Cuánto ganas y cuándo te pagan** (`#ganancia`) | Solo texto, **sin réplica**: la comisión de 10 % del precio (sin el envío) y el pago los lunes por transferencia vienen del manual de texto actual, **no de la app**. | Tres líneas y un ejemplo con números de ejemplo. | Ninguna. Aclarar que la app todavía no calcula la comisión (D4 de #579). |
| T9 | **Si algo falla** (`#ayuda`) | V: «No cargó. Revisa tu señal y toca «Actualizar».», «Parece que no hay internet. Revisa tu señal y vuelve a intentar.», «Esa pieza ya no está disponible. Puede que otra persona la apartó.», «No cargó la foto. Toca “Actualizar”.»; el número de ayuda (D9: **pendiente**). | Una lista corta, cada error con su frase y su arreglo. | Ninguna. Botón «Pedir ayuda por WhatsApp» solo cuando Isaac defina el número. Los datos de pago de la tienda van aquí o en T8, **no en HTML público**. |

Las 5 tareas de #579 §7 quedan cubiertas así: entrar → T0; compartir tres → T1 y T2; apartar → T3 y T4; plazo y aviso → T5; Mis ventas → T6. T7 a T9 son de apoyo.

«Preguntaron» y «Anotar a un cliente» (D10 de #579) **no tienen tarjeta propia**: si la prueba muestra que se usan, se agregan.

### 6.2 Interacciones y estados que debe cubrir la réplica

- Un único estado por tarjeta; «Repetir» lo reinicia por completo, también el resaltado del siguiente paso.
- Todo el texto de pantalla sale de un atributo `data-etiqueta` o de `vender.js`; nada se reescribe a mano.
- **Marco de práctica**: borde y fondo gris, esquinas de teléfono, franja fija arriba «PRÁCTICA: no se manda nada de verdad». Distinto del tono de la app real (NN/g: una pista pulida se toma por interfaz).
- Resaltado del siguiente paso: anillo grueso **y** etiqueta «Toca aquí» (no solo color; #579 P5).
- Cero llamadas de red: sin `fetch`, sin `/api/`, sin `wa.me`, sin `navigator.share`. El test lo verifica.
- Foco visible, `aria-live` para el pie de cada paso, `<dialog>` nativo como en `vender.html`.
- Si el módulo `/vender.js` no carga, mostrar los pies como texto fijo y avisar «Esta práctica no cargó. Pídele ayuda a la tienda.»

### 6.3 No funcionales

| Requisito | Meta | Verificación |
| --- | --- | --- |
| Pantalla | 360 px de ancho, sin desplazamiento horizontal; cada tarjeta cabe sin scroll vertical dentro del marco (Medhi: sin menús con scroll) | Chrome a 360 × 640 |
| Toques y letra | 56 px y 18 px (iguales a `body.rev`) | Revisión |
| Imprimir | `@media print`: cada tarjeta en su estado final, **sin interactividad**, con el pie numerado; dos tarjetas por hoja Carta; blanco y negro legible (ícono + palabra) | Imprimir a PDF |
| Sin red | Tras cargar, sigue funcionando sin red: sin fuentes ni imágenes externas; íconos como emoji o SVG en línea. Reabrir sin red **no está garantizado** (hoy `/vender` no tiene service worker): la hoja impresa es el respaldo | Modo avión después de cargar |
| Tamaño | HTML con CSS y JS hasta 120 KB sin comprimir (`vender.html` pesa 49 KB); con las capturas de T0 (hasta 4 de 20 KB) hasta 200 KB en total; cero otras imágenes | `wc -c` |
| Enlaces | Cada tarjeta con `id` y `scroll-margin`; abrir `/manual#vendi` va directo a la tarjeta | Prueba manual |
| Datos | Solo de ejemplo: «Cliente Ejemplo», teléfono ficticio, piezas inventadas con foto genérica. Ningún cliente, cuenta ni sesión reales | Revisión |
| Acceso | `/manual` solo para `revendedora`, `cajero` y `computadora` (los roles de `VENDER`); las demás cuentas, 302 a `/sin-acceso` | Prueba nueva en `revendedoras.test.ts` |

### 6.4 Pruebas de la Fase 2

1. `permiso('/manual','GET')` abre para `revendedora` y cierra para el resto, como la prueba existente de `/vender`.
2. Cada `data-etiqueta` de `manual.html` existe literalmente en `vender.html` o `vender.js`.
3. `manual.html` no contiene `fetch(`, `/api/`, `wa.me` ni `navigator.share`.
4. Los chips de T6 se obtienen de `estadoMia()`: una prueba arma las cuatro ventas de ejemplo y compara con el texto esperado.
5. Contenido: ningún dato bancario en el HTML hasta que Isaac lo defina (decisión 2).
6. Validación habitual: `npm test`, `npm run typecheck` en `app/` y `python tools/validate_assets.py` en la raíz.

Prueba física: la de §5.6 con una revendedora real en su Android.

---

## 7. Lo que no hacer

| Qué | Por qué | Fuente |
| --- | --- | --- |
| **Videos largos** como forma principal | Las lecciones de Mercado Libre de 38 a 57 min son lo opuesto a lo que se necesita. Digital Green funcionó con videos **en grupo y con facilitadora**, no solos. No se encontró estudio que fije una duración máxima; el límite de 60 s por tarjeta es criterio propio. | Resumen de búsqueda; J-PAL (leído) |
| **Tutorial en carrusel al abrir** | Las pistas encadenadas se descartan y hacen ver la app complicada; una disertación (resumen de búsqueda) halló que las pistas no funcionaron en mayores de 65. | NN/g (leído) |
| **PDF denso** | No hay estudio específico. Va contra COGA 4.6.3 «Evita demasiado contenido» y 4.4.5 «Texto breve» y contra el principio de coherencia de Mayer (quitar lo que sobra). | COGA (leído); Dartmouth (leído) |
| **Réplica que parece la app real** | Personas del estudio de NN/g tomaron una pista muy pulida por botones de verdad. Aquí se confundiría con una venta real. | NN/g (leído) |
| **Manual solo de texto** | Con texto nadie completó la tarea (Medhi); la evidencia de lectura es de personas que no leen. | Medhi (leído) |
| **Mucho en una pantalla o menús con scroll** | Recomendación de Medhi y COGA 4.6. | Medhi, COGA (leídos) |
| **Medir con «¿te gustó?»** | Quien relee se siente más seguro y recuerda menos. | Roediger y Karpicke (leído) |
| **Reglas que la app no tiene** | El Issue prohíbe inventar. Lo de comisión y pago de los lunes sale del manual de texto, no de la app: marcarlo. | Issue #594 |
| **Audio o voz inventados en la v1** | Medhi recomienda voz para analfabetas; no hay evidencia para quien sí lee. Decisión 6. | Medhi (leído) |
| **Servicios nuevos** (chatbot, plataformas de cursos, analítica) | AGENTS.md lo prohíbe y no hay evidencia a favor para esta población. | AGENTS.md |
| **Copiar datos reales** a las capturas o a los ejemplos | Límite del Issue. | Issue #594 |

---

## 8. Decisiones para Isaac

| # | Decisión | Recomendación |
| --- | --- | --- |
| 1 | **Dónde vive el manual**: Artifact, `site/public/` o `/manual` en la app. | **`/manual` en la app** (§5.4): protege los datos de pago y reutiliza `vender.js`. Exige una línea de Worker y su prueba; el deploy lo corre Isaac. |
| 2 | **¿Va la CLABE en el manual?** Los datos de pago no están definidos todavía (#575 paso 4, D3 de #579). | Sí, pero solo en `/manual` detrás de Access (tarjeta T8/T9), **nunca** en `site/public/` ni en un Artifact. Hasta que existan, la tarjeta dice «te los damos por WhatsApp». |
| 3 | **Envío: $99 o $100.** La app (`vender.html`) dice «Envío $99. Gratis si compra $1,000 o más en piezas.»; la nota de datos oficiales del 22/10 dice envío $100 + viernes. Una de las dos está mal. | Confirmar la cifra y corregir la app **antes** de escribir T4. El manual copia la app, no la memoria. |
| 4 | **Número de ayuda (D9).** La tarjeta T9 y el plan de la primera semana lo necesitan. | Un solo WhatsApp de la tienda. Sin número, no se publica T9. |
| 5 | **Comisión y pago de los lunes.** La app no los calcula (D4). El 10 % sin envío y el pago por transferencia vienen del manual de texto. | Tarjeta T8 solo de texto, marcada «la app todavía no lo calcula». Confirmar con Isaac que las cifras siguen vigentes antes de publicar. |
| 6 | **¿Audio de voz de Isaac por tarjeta?** | No en la v1. Se agrega después solo si la prueba muestra que lee con dificultad (una nota de voz de 15 s por WhatsApp por duda, sin construir nada). |
| 7 | **Sesión en persona obligatoria.** | Sí. La evidencia más sólida (Medhi) y la menos disputada es que la persona ayuda. Sin sesión, el manual solo no está respaldado. |
| 8 | **Hoja impresa.** ¿Quién imprime? | Una hoja Carta con T1, T4, T5 y T6 en su estado final, que se entrega el día 0. La produce el modo impresión del manual. |
| 9 | **Cuántas revendedoras en la prueba.** | Una primero (prueba corta, §5.6); luego tres si el resultado es dudoso. Con 3 se ven los problemas más repetidos (#579 §7). |
| 10 | **Mantenimiento.** El manual y la app se desfasan. | Un test que compara etiquetas (§6.4) en el mismo CI. Todo PR que cambie `vender.html` o `vender.js` corre ese test. Sin él, no se sube. |
| 11 | **Alcance de la Fase 2.** | Un PR: `manual.html`, la línea de Worker y las pruebas. Sin tocar `vender.html` ni la API. Aprobar Fase 1 antes de empezar. |

---

## 9. Fuentes

**Leídas** (se abrió la página o el PDF):

- [Medhi et al., «Designing Mobile Interfaces for Novice and Low-Literacy Users», ACM ToCHI 2011](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/ToCHI2711_Medhi.pdf) (PDF, texto extraído).
- [Florez-Arango et al., «Performance factors of mobile rich media job aids for community health workers», JAMIA 2011](https://chwcentral.org/wp-content/uploads/2013/11/Florez-Arango-Mobile-CHWs.pdf) (PDF).
- [J-PAL, evaluación de Digital Green en Bihar](https://www.povertyactionlab.org/evaluation/video-based-group-extension-women-farmers-india-0).
- [Roediger y Karpicke 2006, resumen en PubMed](https://pubmed.ncbi.nlm.nih.gov/16507066/) (solo el resumen).
- NN/g: [Mobile Instructional Overlay](https://www.nngroup.com/articles/mobile-instructional-overlay/), [Training Wheels](https://www.nngroup.com/articles/training-wheels-user-interface/), [Usability for Senior Citizens](https://www.nngroup.com/articles/usability-for-senior-citizens/) (esta última no trae cifras del estudio de 2013).
- [W3C, Making Content Usable for People with Cognitive and Learning Disabilities](https://www.w3.org/TR/coga-usable/) (se leyó el índice de objetivos y patrones, no los 470 000 caracteres).
- [Dartmouth, 12 principios de Mayer](https://services.dartmouth.edu/TDClient/1806/Portal/KB/PrintArticle?ID=171655) y [Wikipedia, Worked-example effect](https://en.wikipedia.org/wiki/Worked-example_effect) (secundarias).
- [Retail Dive, Walmart y la realidad virtual](https://www.retaildive.com/news/walmart-expands-vr-training-to-every-us-store/533201).
- [Expansión, OXXO](https://expansion.mx/carrera/2023/10/23/oxxo-segunda-caja-cerrada).
- [DiDi, centro de ayuda (Australia)](https://web.didiglobal.com/au/help-center/driver-safety-onboarding-training/).
- [Enter.co, Rappi y Microsoft](https://www.enter.co/especiales/dev/rappi-y-microsoft-lanza-cursos-en-tecnologia-para-repartidores/).
- Del repo: [REVENDEDORAS-UX.md](REVENDEDORAS-UX.md), `app/public/vender.html`, `app/public/vender.js`, `app/src/cuentas.ts`, `app/src/revendedoras.test.ts`, `site/public/robots.txt`.
- Leídas en #579 y citadas aquí: NN/g sobre bajo nivel de lectura, WCAG 1.4.1, GOV.UK Tag.

**Solo resumen de búsqueda** (no verificadas): Avon (Forbes México, Direct Selling News), Natura (comunicado de 2025 y páginas de registro de otros países), Betterware+ (App Store), Jafra y Tupperware (App Store), Meesho (blog `meesho.io`, 403), Uber (animación de un estudio, redirigió), Mercado Libre (Central de aprendizaje, Ads Academy, 403), Strivr/Walmart, Mayer 2014 y 2017 y Alpizar et al. 2020 (cifras), Carroll et al. (manual mínimo, IBM 1986), GOV.UK edad lectora 9 (páginas de consejos locales), ensayo de WhatsApp con enfermeras en Pakistán (PMC y Frontiers), pares y peer teaching con mayores, McDonald's y Starbucks (Scribd y espejos: no confiables), proceso de alta de Rappi (sitio no oficial).

**No se pudo verificar:**

- Si el Artifact abre en un teléfono sin cuenta de Claude.
- El contenido del manual de texto actual (Claude Docs, privado): las reglas de comisión (10 % sin envío) y pago (lunes por transferencia) vienen del encargo, no se cotejaron. La Fase 2 debe cotejarlas línea por línea.
- Cualquier cifra de eficacia de capacitación específica de Avon, Natura, Betterware, Jafra, Tupperware, Andrea, Price Shoes, Meesho, Elenas, Shopee, Uber, DiDi México, Rappi, OXXO, McDonald's, Starbucks o Mercado Libre y Mercado Pago. Shopee no se buscó.
- El riesgo real de publicar una CLABE.
