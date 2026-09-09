# Contribuir

## Antes de cambiar algo

Abre un Issue con el resultado esperado. Si ya existe, deja un comentario para reclamarlo. No empieces cambios silenciosos en `main`.

## Ramas y PRs

- Rama: `agent/<nombre>/<issue>-<slug>`.
- Un PR por objetivo.
- Enlaza el Issue con `Closes #<número>` cuando el cambio lo complete.
- Incluye una captura o enlace al preview cuando cambies una pieza visual o la guía HTML.

## Checklist

- [ ] El cambio respeta `AGENTS.md`.
- [ ] El inventario está sincronizado con los assets.
- [ ] No hay datos reales inventados ni secretos.
- [ ] `python tools/validate_assets.py` pasa.
- [ ] El PR explica qué sigue pendiente.
