# El Dolarón — Kit de redes

Repositorio canónico del kit visual y textual de El Dolarón. Es un paquete estático para preparar perfiles y publicaciones; no es una aplicación ni publica contenido por sí solo.

## Empezar

1. Abre [EMPIEZA-AQUI.html](EMPIEZA-AQUI.html) en un navegador.
2. Usa los archivos de `02-Perfiles-y-portadas/` para configurar las cuentas.
3. Publica únicamente las piezas listas y completa los campos entre corchetes en `05-Guia-y-textos/Textos-para-redes.txt`.
4. Ejecuta `python tools/validate_assets.py` antes de abrir un PR.

## Mapa del repositorio

| Ruta | Propósito |
| --- | --- |
| `01-Logos/` | Logo completo y símbolo D |
| `02-Perfiles-y-portadas/` | Avatar y portada |
| `03-Publicaciones/` | Plantillas 4:5 |
| `04-Historias/` | Plantillas 9:16 |
| `05-Guia-y-textos/` | Inventario, paleta y copy |
| `EMPIEZA-AQUI.html` | Preview y guía visual autocontenida |
| `tools/` | Validaciones sin dependencias externas |
| `.github/` | Flujo de Issues, PRs, ownership y CI |

## Trabajo entre agentes

GitHub es la fuente de verdad compartida para Claude, ChatGPT, Agy y cualquier otro agente:

1. Abre o toma un Issue; deja un comentario breve indicando qué vas a hacer.
2. Trabaja en `agent/<nombre>/<issue>-<slug>`; nunca escribas directamente en `main`.
3. Mantén el cambio enfocado y abre un PR enlazando el Issue.
4. El PR debe pasar `Validate kit` y describir archivos modificados, validación ejecutada y cualquier decisión pendiente.
5. El merge requiere revisión y CI verde.

El contrato completo está en [AGENTS.md](AGENTS.md) y la arquitectura en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Límites deliberados

Este repositorio no guarda contraseñas, tokens, datos de clientes ni credenciales de redes sociales. Tampoco inventa horarios, dirección, precios, disponibilidad, descuentos o políticas de entrega.
