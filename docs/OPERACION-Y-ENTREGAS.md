# Operación y entregas de la tienda

Runbook objetivo del [plan](PLAN-REESTRUCTURACION.md). Los controles futuros deben implementarse en sus Issues; este documento no demuestra que ya existan ni autoriza comandos remotos. Se mantienen las restricciones de [AGENTS.md](../AGENTS.md) y [CLAUDE.md](../CLAUDE.md).

## Entornos y datos

| Entorno | Configuración versionada | Contrato que debe verificarse |
| --- | --- | --- |
| Local | app/wrangler.jsonc con ejecución local explícita | Datos sintéticos; esquema y migraciones completos. No usar db:remote para preparar desarrollo. |
| Sandbox | app/wrangler.sandbox.jsonc | D1/R2 y sesiones aislados; datos mínimos/sanitizados; integraciones externas de prueba o desactivadas. Confirmar destino antes de refrescar. |
| Prestado | app/wrangler.prestado.jsonc | Entorno temporal: verificar propósito, hosts, Access, assets y bindings. No asumir paridad ni desplegar configuración incompleta. |
| Producción | app/wrangler.jsonc | Hosts, políticas, bindings y versión comprobados contra despliegue real; no inferirlos solo del archivo. |

No guardar secretos ni exportaciones de clientes en git. Para revisar configuración bastan nombres de bindings, destinos no sensibles, presencia del secreto y versión; nunca su valor. Una copia de sandbox no debe reutilizar sesiones/PINs/tokens OAuth de producción. Aplicar mínimos datos y retención explícita de cualquier exportación temporal.

## Checks por cambio

Desde la raíz, todo PR ejecuta `python tools/validate_assets.py`. Si cambia site/public o sus validadores, también `python tools/validate_site.py`. Un PR solo de Markdown verifica además enlaces locales y consistencia con los archivos reales; no necesita inventar pruebas de lógica que no cambió.

Para cambios ejecutables de app, desde app/ con Node 24 y dependencias del lockfile:

`npm test` y `npm run typecheck`.

En un checkout limpio, `npm ci` prepara dependencias. La CI existente ejecuta ambos validadores Python y ambos checks de app. No confundir esos checks con aprobación de negocio, compatibilidad física o validación de infraestructura.

| Cambio | Evidencia adicional necesaria |
| --- | --- |
| Stock, dinero, permisos o reintentos | Regresión del fallo; dos operaciones intercaladas, repetición y fallo parcial cuando aplique; integración D1 local/sandbox si el doble SQLite no representa la conducta relevante. |
| Esquema/provisionamiento | Base vacía + actualización desde versión anterior, registro de migraciones, claves foráneas activas, datos antes/después y compatibilidad del Worker anterior. |
| Wrangler, hosts, Access o assets | Dry run de cada configuración afectada y smoke HTTP: ruta pública permitida, API protegida, identidad/rol/host incorrecto denegados. Usar recursos de prueba; no debilitar Access para conseguir verde. |
| Caja, service worker o IndexedDB | Primera instalación, recarga offline, actualización con venta pendiente y reintento tras pérdida de respuesta; sin borrar datos del navegador. |
| Impresión, lector, efectivo o terminal | Prueba física del flujo afectado y calibraciones preservadas. Si falta dispositivo, registrarlo como pendiente; no declarar validado hardware con una captura. |
| IA / Mercado Libre / cron | Timeout, duplicado, desorden, error de proveedor y recuperación tras caída; no usar una venta real para probar. |

## Secuencia de entrega

1. Issue y PR describen cambio observable, riesgo, pruebas y alcance; revisión y CI verde antes de merge. F0.3 debe hacer exigible esa protección en GitHub.
2. Antes de una entrega remota, confirmar autorización vigente para esa acción y destino. No volver a pedirla si ya existe. Documentar commit, versión actual, recursos destino, compatibilidad de datos y forma de recuperación.
3. Ensayar con datos sintéticos/sanitizados en sandbox. Para migraciones, probar avance y compatibilidad anterior; separar ampliación de esquema, transición de código y eliminación posterior cuando sea necesario. No ejecutar automáticamente todos los SQL históricos sobre una base viva.
4. Verificar respaldo/recuperación disponible y su alcance. Si hay cambio incompatible o pérdida de datos posible, resolver el plan antes de ejecutar. Programar la ventana fuera de cobro si el Issue identifica interrupción.
5. Aplicar únicamente los pasos autorizados; comprobar login, captura, lectura de stock, operación de prueba apropiada al entorno y jobs. La validación en producción debe evitar cobros o cambios de inventario reales no autorizados.
6. Observar errores, latencia y pendientes durante la ventana definida en el Issue. Registrar versión entregada, migraciones, pruebas y anomalías. Si aparece discrepancia de dinero/stock, detener ampliación del despliegue y activar recuperación del flujo afectado.

## Recuperación

Un [rollback de Worker](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) no restaura D1 ni R2. Por ello, la reversión preferida de código requiere esquema compatible; para datos, decidir reparación hacia adelante o restauración ensayada con conciliación de operaciones posteriores. Nunca prometer recuperar ventas recientes a partir de un respaldo anterior sin reconciliarlas.

F4 debe ensayar restauración en destino aislado, medir duración, verificar claves foráneas, conteos y sumas de ventas/stock, y comprobar referencias de fotos R2. Registrar qué cubre el respaldo, cuánto se pierde y quién puede ejecutar recuperación. No restaurar sobre producción como ejercicio.

## Medición y capacidad

Empezar con logs y métricas de la plataforma existente, sin comprar observabilidad. Registrar request ID, entorno, versión, tipo de operación, duración y resultado; para tareas, ID no sensible, intento, edad y último error saneado. Nunca payloads completos de clientes, fotos, PINs o tokens.

F4 medirá al menos siete días representativos: pico de cajas concurrentes y solicitudes, ventas/día, p95 y error por operación, consultas lentas/filas leídas, edad de pendientes, consumo de almacenamiento y costo. Fijar presupuesto de IA/integraciones y volumen previsto con Isaac. Probar carga únicamente en entorno aislado.

Objetivos iniciales propuestos para acordar en el Issue de F4; no son SLOs ya medidos ni garantías:

| Señal | Objetivo / acción propuesta |
| --- | --- |
| Integridad | Cero cobros/abonos duplicados, stock negativo o acceso cruzado; cualquier caso abre incidente prioritario. |
| API interactiva | p95 menor a 1 segundo, excluyendo IA/proveedor externo; error inesperado menor a 1% en ventanas pico de 15 minutos. Registrar también conteo; poco tráfico no permite concluir capacidad. |
| Trabajo externo | Antigüedad de pendiente menor a 5 minutos para sincronización/análisis ordinario; excedente visible para revisión. Proveedor caído requiere política de pausa/reintento y recuperación, no éxito ficticio. |
| Recuperación | Proponer RPO máximo 15 minutos y RTO 60 minutos; validar contra restauración real y recuperación de ventas. Si plataforma/operación no lo permite, acordar objetivo viable antes de prometerlo. |
| Capacidad | Ensayo a 2× pico observado o demanda prevista, el mayor; conservar invariantes y objetivos anteriores. Costo dentro del presupuesto acordado. |

Si un objetivo falla, abrir Issue con medición, consulta/flujo causante y opción mínima. Los umbrales del [diseño objetivo](ARQUITECTURA-OBJETIVO.md) activan evaluación; no activan servicios automáticamente.

## Continuidad entre agentes y límite de sesión

GitHub conserva el estado. Antes de agotar tiempo/contexto/presupuesto, terminar una unidad verificable o dejar borrador de PR con cambios revisables. Registrar archivo y punto de continuación, commit base, pruebas ejecutadas, resultados, pendiente y riesgos. No empezar una migración o despliegue sin margen para observar y cerrar; no informar una cantidad exacta de tokens si la herramienta no la proporciona.

Usar en el Issue o PR:

```text
Estado: listo para revisión | bloqueado
Hecho: ...
Validación: comando, resultado y entorno; lo no probado queda explícito
Pendiente: siguiente paso concreto, riesgo y decisión requerida si existe
```

Un plan, mock, dry run o suite local no acredita despliegue ni corrección en producción.
