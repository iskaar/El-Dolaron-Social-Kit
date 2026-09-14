# Claude Code — El Dolarón

@AGENTS.md
@README.md

## Contexto técnico

- `app/` es la aplicación operativa: un Cloudflare Worker con D1, R2 y HTML/JS sin framework.
- `app/src/worker.ts` contiene el enrutador y los handlers.
- `app/public/caja.html` es la caja; `app/public/venta.js` contiene su aritmética comprobable.
- `docs/CONTRATO-ESCANER.md` define el alcance funcional y `docs/ARQUITECTURA-ESCANER.md` las decisiones técnicas.
- Todo el dinero se guarda como centavos MXN enteros.
- D1 es el único maestro de existencias. No crees otra fuente de stock.

## Antes de editar

1. Ejecuta `git status -sb` y `git pull --ff-only`.
2. Lee el Issue asignado y los archivos que toca de principio a fin.
3. Comenta que tomas el Issue y trabaja en `agent/claude/<issue>-<slug>`.
4. Si otra rama ya modifica los mismos archivos, coordina en el Issue antes de editar.

No trabajes directamente en `main`. No leas, muestres ni confirmes archivos de secretos como
`app/.dev.vars` o `app/.env*`. No despliegues, ejecutes migraciones remotas, cambies Cloudflare
Access ni hagas `git push --force` salvo instrucción explícita de Isaac.

## Validación

Para cambios en `app/`:

```powershell
cd app
npm test
npm run typecheck
```

Para cambios en el kit de redes, desde la raíz:

```powershell
python tools/validate_assets.py
```

Ejecuta solo las validaciones relacionadas con el cambio. En el PR deja qué cambió, qué ejecutaste
y qué requiere prueba física. La caja necesita pruebas con lector, impresora, efectivo y terminal;
una prueba del navegador no sustituye hardware real.

## Entrega entre Claude y Codex

GitHub es la memoria compartida. Antes de terminar:

- deja la rama publicada y abre un PR enlazado al Issue;
- registra decisiones, resultados y bloqueos en el Issue o PR;
- incluye el commit y los comandos de validación;
- no dependas del historial privado de Claude Code para que el siguiente agente continúe.
