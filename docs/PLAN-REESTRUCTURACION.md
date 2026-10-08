# Plan de reestructuración de El Dolarón

Propuesta del 2026-10-08 · [Issue #235](https://github.com/iskaar/El-Dolaron-Social-Kit/issues/235).
Base revisada: main `2a1bd041837cd0404a5ede0de206b40f1ba49c1a`.

## Resultado buscado

Una herramienta de tienda que cobre, conserve inventario y se recupere de fallas de forma predecible; que otros desarrolladores y modelos puedan mantener; y que pueda crecer a más cajas, personal y tiendas con evidencia. Se conserva Workers + D1 + R2 y HTML/JS. La primera meta es integridad operativa, después separación del código y capacidad.

Este documento planifica trabajo: no declara corregidos los defectos ni autoriza cambios de producción. El estado del trabajo vive en Issues y PRs. Antes de implementar cada unidad de la tabla, crear o reutilizar un Issue con sus criterios, enlazarlo aquí y reclamarlo. Un PR por corrección o extracción coherente; no una rama larga para toda la reestructuración. No mezclar un arreglo de comportamiento con movimientos masivos de archivos.

Leer junto con [arquitectura objetivo](ARQUITECTURA-OBJETIVO.md), [operación y entregas](OPERACION-Y-ENTREGAS.md) y [guardrails de la app](../app/AGENTS.md). Los contratos funcionales y calibraciones existentes siguen vigentes.

## Evidencia y prioridad

La [auditoría del 8 de octubre, PR #234](https://github.com/iskaar/El-Dolaron-Social-Kit/pull/234) documenta 15 defectos y una brecha de protección de main. Sus números se usan abajo. Es una fotografía de esa revisión, no una garantía de cobertura completa. Confirmar cada reproducción contra el commit de implementación; conservar la regresión si el defecto ya fue corregido por otro PR.

Las pruebas existentes pasaban en la auditoría y aun así había fallas de concurrencia y configuración. La salida de una fase exige evidencia de sus casos, no solo una suite verde. Prioridad P1 de la auditoría significa arreglar antes de ampliar uso del flujo afectado; no exige bloquear correcciones independientes.

## Fases y unidades de trabajo

| Unidad / dependencia | Entrega mínima | Criterio de salida verificable | Auditoría |
| --- | --- | --- | --- |
| F0.1 · inicio | Aprovisionamiento local reproducible: esquema y migraciones aplicadas con registro, sin renumerar historia. Revisar los scripts actuales db:local/db:remote. | Una base vacía llega al esquema esperado, incluida usuarios.caja; segunda ejecución no duplica ni destruye datos. Probar también actualización de una base anterior. | 14 |
| F0.2 · inicio | Actualización segura de sandbox: transformar y validar copia antes de sustituir datos; excluir sesiones, tokens de integración y datos personales innecesarios. | Fixture con premios_apertura y cliente relacionado importa con claves foráneas activas; fallo deja sandbox recuperable; sesión de producción rechazada en sandbox y viceversa. | 9, 12 |
| F0.3 · inicio | Contrato de configuración por entorno y revisión de prestado; protección de main con revisión y checks requeridos. | Dry run y prueba HTTP local/sandbox verifican assets, /api, hosts y Access; evidencia de reglas de GitHub aplicadas por quien tenga autorización. | 11, 16 |
| F1.1 · tras F0.1 para prueba de integración | Edición de producto y reintento de foto sin sobrescribir existencias ni repetir efectos. | Venta intercalada con edición mantiene stock correcto; misma captura repetida devuelve el mismo resultado sin restaurar stock ni reiniciar análisis completado. | 1, 2 |
| F1.2 · tras F0.1 | Fusión de inventario y asignación de código atómicas. | Dos fusiones simultáneas cuentan origen una vez; dos solicitudes de etiqueta conservan un código estable; conflicto verificable sin cambio parcial. | 3, 4 |
| F1.3 · tras F0.1 | Protección atómica del último dueño. | Dos bajas/degradaciones concurrentes nunca dejan cero dueños; permisos y respuestas no revelan datos ajenos. | 5 |
| F2.1 · tras F1.1/F1.2 | Ciclo de publicación de Mercado Libre ligado a cambios de producto y pedidos; conservar vínculo hasta completar baja remota. | Producto fusionado/eliminado no deja publicación activa huérfana; notificación de ítem antes del pedido no repone la unidad vendida; duplicados/desorden no duplican movimientos. | 6, 7 |
| F2.2 · tras F2.1 | Registro durable de eventos pendientes y reconciliación con cursor/reintentos; no depender solo de pedidos creados en 24 horas. | Cancelación de pedido antiguo se aplica tras webhook fallido; caída después de guardar/antes de responder se recupera sin doble efecto; error agotado queda visible y recuperable. | 8 |
| F2.3 · tras F1.1 | Estado durable de análisis de foto, límite de tiempo y recuperación de trabajo abandonado. | Demora, timeout y terminación del Worker dejan estado consultable; reintento no altera stock ni pisa corrección humana; pendientes se recuperan con política acotada. | 10 |
| F2.4 · independiente | Corregir instalación offline de caja y canal de contacto publicado. Separar en dos Issues/PRs. | Tras primera visita completa y activación del service worker, recarga sin red abre caja; venta pendiente sobrevive actualización. Correo publicado recibe prueba real o se sustituye por canal verificado. | 13, 15 |
| F3.1 · tras F1 y correcciones F2 del módulo | Extraer de worker.ts los bloques de inventario, ventas y reportes por dominio, conservando contratos. | Cada extracción preserva rutas, permisos, códigos HTTP, dinero y respuesta; pruebas de regresión y contrato pasan; worker queda como entrada y delegación. | Prevención |
| F3.2 · tras F2.4 de caja | Separar lógica de caja del DOM reutilizando venta.js, cajero.js y módulos de hardware existentes. | Mismos flujos de efectivo/terminal, devoluciones, tickets y reconexión; revisión de accesibilidad y prueba física para impresión/lector si se tocan. | Prevención |
| F4 · tras F0–F3 | Establecer métricas, recuperación ensayada y ensayo de carga en entorno aislado. | Registrar baseline, carga objetivo, p95/errores, pendientes, costo, restauración y pruebas de aislamiento; operar un ciclo de caja y su corte sin diferencias. | Prevención |
| F5 · cuando exista necesidad y se cumpla F4 | Ampliar cajas/tiendas o infraestructura por los disparadores de arquitectura. | Issue con volumen medido, presupuesto, modelo de permisos/datos, migración y reversión; ensayo a la carga prevista y ausencia de fugas entre tiendas. | Crecimiento |

F0 puede avanzar en paralelo lógico con arreglos P1 si existe un entorno de prueba confiable. F1.3 es independiente de inventario. F2.4 no espera a Mercado Libre. Esto permite PRs independientes; no asigna agentes ni autoriza despliegues paralelos. No estimar fechas hasta conocer disponibilidad y carga real.

## Cómo cerrar cada unidad

1. Reproducir el caso en datos sintéticos; registrar base y resultado esperado. Para concurrencia, intercalar dos operaciones de forma controlada; una prueba secuencial no demuestra atomicidad.
2. Identificar rutas, consumidores, tests, fixtures, SQL, configuración y documentación afectados. Arreglar la invariante en su dueño; no copiar el arreglo en cada caller.
3. Ejecutar checks del [runbook](OPERACION-Y-ENTREGAS.md). Adjuntar evidencia del entorno real apropiado cuando el doble de pruebas no represente D1, navegador, Access o hardware.
4. Revisar y fusionar con CI verde. Si el cambio requiere entrega a un entorno, seguir la autorización y el procedimiento existentes; conservar versión anterior compatible y evidencia de migraciones.
5. Enlazar Issue, PR, commit, resultado y riesgo residual. Solo el Issue registra listo/bloqueado/terminado. No marcar una fase completa porque se movieron archivos.

## Primer paso de implementación

Abrir o reutilizar el Issue de F1.1 y el de F0.1, enlazados a #235 y #234. F1.1 debe comenzar con la intercalación venta/edición de la auditoría y un reintento de captura después de una venta. F0.1 suministra la base reproducible. Esta entrega documental no ejecuta ninguno de esos cambios.
