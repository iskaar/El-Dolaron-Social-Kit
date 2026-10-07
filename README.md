# El Dolarón — Kit de redes

Repositorio canónico del kit visual y textual de El Dolarón y de la aplicación de tienda en `app/`. El kit es estático y no publica contenido por sí solo. El portal móvil Dolarones, su aislamiento y los requisitos antes de habilitarlo están en [docs/CONTRATO-PORTAL.md](docs/CONTRATO-PORTAL.md).

## Empezar

1. Abre [EMPIEZA-AQUI.html](EMPIEZA-AQUI.html) en un navegador.
2. Usa los archivos de `02-Perfiles-y-portadas/` para configurar las cuentas.
3. Publica únicamente las piezas listas y completa los campos entre corchetes en `05-Guia-y-textos/Textos-para-redes.txt`.
4. Ejecuta `python tools/validate_assets.py` antes de abrir un PR.

## Estrategia de marketing

Consulta [el contexto, investigación y plan de 30 días](docs/MARKETING-30-DIAS.md) antes de continuar el marketing de El Dolarón. Incluye datos confirmados, calendario, presupuesto, fuentes y pendientes de apertura. Seguimiento: [Issue #28](https://github.com/iskaar/El-Dolaron-Social-Kit/issues/28).

## Mapa del repositorio

| Ruta | Propósito |
| --- | --- |
| `01-Logos/` | Logo oficial (horizontal, vertical e ícono «EL»); el logo anterior con símbolo D está retirado |
| `02-Perfiles-y-portadas/` | Avatar y portada |
| `03-Publicaciones/` | Plantillas 4:5 |
| `04-Historias/` | Plantillas 9:16 |
| `05-Guia-y-textos/` | Inventario, paleta y copy |
| `EMPIEZA-AQUI.html` | Preview y guía visual autocontenida |
| `tools/` | Validaciones sin dependencias externas |
| `app/` | Caja, inventario y portal Dolarones (Worker + D1) |
| `site/public/` | Sitio público de la tienda, contacto y ubicación |
| `.github/` | Flujo de Issues, PRs, ownership y CI |

## Trabajo entre agentes

GitHub es la fuente de verdad compartida para Claude, ChatGPT, Agy y cualquier otro agente:

1. Abre o toma un Issue; deja un comentario breve indicando qué vas a hacer.
2. Trabaja en `agent/<nombre>/<issue>-<slug>`; nunca escribas directamente en `main`.
3. Mantén el cambio enfocado y abre un PR enlazando el Issue.
4. El PR debe pasar `Validate kit` y describir archivos modificados, validación ejecutada y cualquier decisión pendiente.
5. El merge requiere revisión y CI verde.

El contrato completo está en [AGENTS.md](AGENTS.md) y la arquitectura en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Sitio público

Abre `site/public/index.html` para revisar el sitio de El Dolarón. Es una página estática con assets locales, sin dependencias ni compilación. Para servirla localmente ejecuta `python -m http.server 8080 --directory site/public` y visita `http://localhost:8080`. Antes de publicar cambios ejecuta `python tools/validate_assets.py` y `python tools/validate_site.py`.

### Claude Code

Claude Code ya puede trabajar desde la raíz del repositorio y carga `CLAUDE.md` automáticamente:

```powershell
cd "C:\Users\isaac\Claude\Projects\El-Dolaron"
git pull --ff-only
claude
```

Empieza con: `Lee el Issue #<número>, comenta que lo tomas y crea la rama agent/claude/<número>-<slug>.`
Claude y Codex se coordinan únicamente mediante Issues, ramas y PRs publicados en GitHub.

## Límites deliberados

Este repositorio no guarda contraseñas, tokens, datos de clientes ni credenciales de redes sociales. Tampoco inventa horarios, dirección, precios, disponibilidad, descuentos o políticas de entrega.
