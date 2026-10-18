# Guardrails de la aplicación de tienda

Complementa [AGENTS.md raíz](../AGENTS.md). Aplica a app/ y, por referencia desde el contrato raíz, a scripts y configuración que operan la tienda. No cambia las reglas del kit de marca.

## Antes de cambiar

1. Leer README, contrato raíz, Issue y archivos afectados completos; consultar [plan](../docs/PLAN-REESTRUCTURACION.md), [arquitectura objetivo](../docs/ARQUITECTURA-OBJETIVO.md) y [operación](../docs/OPERACION-Y-ENTREGAS.md) para la unidad en curso.
2. Leer el contrato funcional del flujo: [escáner](../docs/CONTRATO-ESCANER.md), [portal](../docs/CONTRATO-PORTAL.md) o documento enlazado por su Issue. Conservar las decisiones y calibraciones de [arquitectura del escáner](../docs/ARQUITECTURA-ESCANER.md).
3. Revisar git status y rama base sin pisar cambios ajenos. Si hay trabajo concurrente, coordinar en el Issue. Reclamar Issue y usar agent/<nombre>/<issue>-<slug>.
4. Buscar todas las rutas y consumidores: frontend, tests, fixtures, SQL, bindings, exports y docs. Escribir ese alcance en el Issue/PR; no crear capas para consumidores hipotéticos.

Las instrucciones explícitas vigentes del usuario prevalecen. El plan describe un destino: no sustituye contratos confirmados ni demuestra que una fase esté implementada. Resolver contradicciones materiales en el Issue antes de cambiar comportamiento; actualizar documentos en el mismo PR cuando se apruebe una nueva regla.

## Límites obligatorios

- Mantener centavos MXN enteros, redondeo y fecha de tienda existentes. El servidor autoriza precio, descuento y rol.
- D1 es el maestro de inventario. No reescribir stock desde una prelectura, reintento de foto o snapshot de proveedor. Fusión, código, último dueño y venta deben conservar invariantes bajo concurrencia.
- No asumir que batch protege lecturas anteriores o que cero filas modificadas aborta una transacción. Probar precondiciones y efectos conjuntos contra el comportamiento real necesario.
- Preservar UUID/pedidoHash y el resultado de reintentos. Ante efectos externos, persistir intención/estado y permitir recuperación; no mantener una transacción abierta mientras se espera HTTP.
- Denegar acceso por defecto; verificar host, identidad, rol y alcance en servidor. Mantener separados usuarios, terminales, portal público y entornos.
- No leer, mostrar ni confirmar .dev.vars, .env*, credenciales o exportaciones privadas. No copiar sesiones, PINs o tokens de producción al sandbox.
- Mantener rutas, respuestas API, almacenamiento de navegador y ventas pendientes compatibles. No borrar IndexedDB/caché para ocultar una falla. Respetar instalación/actualización del service worker y uso sin red.
- Migraciones: archivo nuevo `app/migracion-NNN-*.sql`, aditivo, con la instrucción de ejecución en su encabezado; Isaac lo corre en sandbox y luego en prod ANTES del deploy. No hay tabla de registro. No editar SQL ya ejecutado ni renumerar. Las pruebas (`src/prueba-d1.ts`) y `npm run db:local` aplican schema + todas las migraciones: una base vacía debe quedar completa.
- Conservar manejo de errores, validación, accesibilidad y calibración de hardware al mover código. Reutilizar venta.js y módulos existentes.
- Un PR por arreglo o extracción coherente. No añadir dependencias, servicios, automatización de publicación ni credenciales para implementar este plan; una propuesta de capacidad no es autorización.

## Validación y decisiones

Ejecutar siempre python tools/validate_assets.py desde raíz. Para código/configuración de app, ejecutar npm test y npm run typecheck desde app/; añadir la evidencia específica de la tabla del runbook. Una regresión significativa necesita prueba del fallo; no basta probar el nuevo helper aislado. No debilitar assertions, permisos o fixtures para conseguir verde. El doble SQLite no sustituye toda la semántica de D1.

Resolver decisiones rutinarias dentro del Issue sin pedir aprobación repetida. Escalar cuando falte una decisión de negocio, se contradiga un contrato, se requiera infraestructura/costo fuera del alcance o haya una operación remota sin autorización vigente. Preparar primero diagnóstico y propuesta revisables; explicar la regla concreta que exige la decisión. No desplegar, migrar remoto, cambiar Access ni hacer force push sin instrucción explícita vigente de Isaac.

Si se acerca el límite de sesión, cerrar la unidad y dejar continuidad en GitHub siguiendo el runbook. Informar por separado lo implementado, lo probado y lo pendiente. Abrir PR enlazado al Issue; con CI verde el agente lo mergea (Isaac es el único revisor) y deja el despliegue y las migraciones remotas a Isaac. main queda publicable. No marcar realizado un paso del plan porque solo se escribió documentación.
