# Arquitectura objetivo de la tienda

Propuesta ligada al [plan de reestructuración](PLAN-REESTRUCTURACION.md). Describe el destino y sus reglas; las rutas y módulos actuales siguen siendo la verdad ejecutable hasta que un PR complete su extracción.

## Forma del sistema

Mantener un monolito modular: un Worker, D1 como maestro de datos operativos y R2 privado para fotografías. El kit de marca y site/public conservan sus límites. No crear microservicios, un framework de frontend, ORM, repositorio genérico ni una segunda fuente de inventario para ordenar archivos.

`Navegadores → Worker (host, identidad, rutas) → módulos de negocio → D1 / R2 / API externa`

`Eventos externos y tareas programadas → registro durable → mismo módulo de negocio`

La segunda línea es un objetivo de F2; el registro durable no se presume implementado. No confirmar una tarea al usuario o al proveedor antes de guardar lo necesario para recuperarla. R2, D1 y una API externa no comparten una transacción: modelar estados intermedios y reparación, no simular éxito conjunto.

## Dueño de cada regla

Los nombres nuevos son destinos propuestos, no carpetas vacías que deban crearse hoy. Mantener los módulos que ya existen y extraer solo cuando la unidad del plan lo requiera.

| Responsabilidad | Ubicación actual → destino | Regla y límite |
| --- | --- | --- |
| Entrada HTTP, hosts, autenticación y cron | src/worker.ts → mismo archivo | Resolver identidad y delegar; conservar allowlists de hosts, rutas públicas explícitas y denegación por defecto. No acumular SQL de nuevos dominios. |
| Productos, existencias, fusión y códigos | bloques de worker.ts → src/inventario.ts | Dueño de cambios de stock y de sus precondiciones. Otros dominios usan operaciones explícitas; ventas agrupa sus efectos en la misma transacción, sin una segunda escritura independiente. |
| Ventas y comprobantes | bloques de worker.ts → src/ventas.ts; conservar cancelaciones.ts, devoluciones.ts, vales.ts, descuentos.ts | Pedido e idempotencia, stock, dinero y efectos asociados se confirman de forma coherente. Cancelación/devolución conserva trazabilidad y no repite abonos. |
| Reportes y corte | bloques de worker.ts → src/reportes.ts; conservar corte.ts | Consultas por rango/fecha/actor; lectura de datos confirmados, sin modificar inventario para generar un reporte. |
| Identidad y permisos | cuentas.ts, cajeros.ts | Rol autorizado en servidor, al menos un dueño y sesiones ligadas al entorno; distinguir terminal y persona que ejecuta operación. |
| Socios, Dolarones y portal | dolarones.ts, portal.ts | Mantener contrato de portal, privacidad, saldo y aislamiento entre acceso público y acceso de empleados. |
| IA y fotografía | analisis.ts + captura en worker.ts | Resultado sugerido y recuperable; no sobreescribir decisiones humanas ni stock al reintentar. R2 conserva política privada. |
| Integraciones | mercadolibre.ts | API externa, credenciales y reconciliación en un límite reconocible; no decidir stock desde una copia externa. Separar transporte y procesamiento solo cuando facilite una corrección o prueba concreta. |
| Caja y dispositivos | public/caja.html, venta.js, cajero.js, impresora.js, etiquetera.js | Extraer orquestación de DOM a public/caja.js cuando F3.2 lo necesite. Reutilizar aritmética y módulos físicos; conservar calibraciones, offline e IndexedDB. |

Los paths de la tabla son relativos a app/. Las pruebas del dominio permanecen junto a su código. Evitar ciclos: worker importa módulos; módulos no importan worker. Compartir una función pequeña cuando tiene varios consumidores reales; no una capa universal para todas las tablas. Si se necesitan sentencias de varios dominios en un batch, exponer constructores de sentencias específicos y mantener un único punto de confirmación.

## Invariantes que deben sobrevivir a toda extracción

- Dinero: centavos MXN enteros, precio/descuento autorizado por servidor y reglas existentes de redondeo; fecha de tienda en America/Mexico_City.
- Inventario: sin stock negativo ni resurrección por datos antiguos; modificación condicionada a estado vigente. Código de barras asignado una vez y estable.
- Atomicidad: una lectura previa en JavaScript no protege la escritura posterior. Usar SQL condicionado, constraints o una operación transaccional apropiada; comprobar conflictos. Un UPDATE con cero filas no es un error SQL: diseñar cómo evita o revierte los demás efectos del batch. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) revierte el conjunto ante fallo SQL; no convierte prelecturas externas en transacciones.
- Reintentos: UUID de venta y pedidoHash mantienen semántica; mismo ID con otro contenido se rechaza. Eventos externos duplicados/desordenados y resultados inciertos tienen recuperación explícita.
- Acceso: verificar identidad, rol, host y propiedad en servidor. No confiar en botones ocultos ni aceptar tokens/sesiones de otro entorno. No registrar PINs, JWTs, tokens ni datos personales en telemetría.
- Navegador: preservar URLs, formatos API, caché, claves de IndexedDB y ventas pendientes durante coexistencia de clientes viejos/nuevos. Un refactor no borra almacenamiento del usuario.
- Datos: migraciones nuevas y compatibles; no editar migraciones ya ejecutadas ni renumerar huecos históricos. Kit, portal, caja e integraciones mantienen sus contratos particulares.

## Trabajo durable con el mínimo de infraestructura

Primero evaluar persistir estado e intentos en D1 y recuperarlos con el cron existente, con presupuesto por ejecución, reintento acotado, operación idempotente y fallos visibles. Un trabajo no puede quedarse para siempre como procesando: necesita plazo de posesión, recuperación y protección frente a dos procesadores. Este diseño debe validarse contra duración y carga reales antes de implementarse.

No usar solo waitUntil para trabajos cuya pérdida importa: tras responder, el tiempo está limitado por el [ciclo de vida de Workers](https://developers.cloudflare.com/workers/runtime-apis/context/). Si el trabajo excede el presupuesto, necesita ejecución adecuada además de persistencia. Considerar Queues únicamente mediante Issue aprobado; su entrega [al menos una vez](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) sigue exigiendo idempotencia.

## Crecer cuando exista evidencia

Los siguientes son disparadores de evaluación, no promesas de capacidad ni compras autorizadas. Primero medir según el [runbook](OPERACION-Y-ENTREGAS.md), optimizar consultas y probar el caso real. Para cambiar un servicio/dependencia o alcance de negocio, aplicar AGENTS.md y autorización vigente de Isaac.

| Necesidad / disparador | Primera respuesta | Cuándo revisar una arquitectura mayor |
| --- | --- | --- |
| Más cajas/personal | Probar 2× pico observado y carga prevista, sesiones separadas y ventas concurrentes. | Tras optimizar, latencia/errores incumplen objetivos en tres ventanas pico; identificar recurso saturado antes de cambiarlo. |
| Más inventario/reportes | Medir filas leídas, índices, paginación y consulta más costosa. | Proyección a 90 días supera 70% de un límite contratado verificado, o costo excede presupuesto aprobado; evaluar alternativas con cifras actuales. |
| Más trabajos externos | Pendientes durables, reintentos acotados, visibilidad de edad/errores. | El consumidor no reduce backlog o cumple el objetivo de antigüedad bajo carga prevista: evaluar Queues y presupuesto; no duplicar procesamiento sin deduplicación. |
| Segunda tienda | Issue de reglas: pertenencia de stock/venta/usuario, transferencias, códigos, cortes y devoluciones entre sucursales. | Elegir explícitamente esquema compartido con tienda_id o aislamiento de bases, con pruebas de separación y migración. No añadir tienda_id parcialmente ni inferir que varias cajas son varias tiendas. |
| Coordinación que SQL no resuelve | Demostrar la carrera y probar una solución transaccional en D1. | Evaluar Durable Objects solo si existe coordinación por entidad que lo justifique; conservar D1 como maestro y especificar recuperación entre ambos. |
| Más desarrolladores/modelos | Dueños de dominio, contratos y PRs pequeños. | Dividir un módulo cuando mezcla reglas independientes y dificulta pruebas; cantidad de líneas sola no justifica un servicio nuevo. |

Registrar una decisión arquitectónica en el Issue: contexto, opciones, evidencia, decisión, costo, impacto de datos, reversión y contratos afectados. Si cambia una regla duradera, actualizar este documento en el mismo PR. No crear un sistema de decisiones separado que compita con GitHub.
