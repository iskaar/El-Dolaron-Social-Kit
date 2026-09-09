# Contrato de agentes

Este archivo es la instrucción común para cualquier agente que trabaje en el repositorio.

## Fuente de verdad

- GitHub Issues describen el trabajo.
- Pull requests contienen el cambio y su revisión.
- `main` debe permanecer publicable.
- Los archivos existentes pertenecen al proyecto: no los reemplaces masivamente ni cambies formatos sin una razón visible en el Issue.

## Flujo obligatorio

1. Lee `README.md`, este archivo y el archivo que vas a modificar.
2. Reclama el Issue con un comentario y crea `agent/<nombre>/<issue>-<slug>`.
3. Haz el cambio mínimo que cumpla los criterios de aceptación.
4. Ejecuta `python tools/validate_assets.py`.
5. Abre un PR con el Issue enlazado.

## Reglas de contenido

- Conserva acentos, nombre y colores de la marca.
- No conviertas plantillas con corchetes en afirmaciones publicables sin datos confirmados.
- Si agregas, quitas o renombras un asset, actualiza `05-Guia-y-textos/Inventario-de-archivos.json` y revisa `EMPIEZA-AQUI.html`.
- No agregues dependencias, servicios, automatizaciones de publicación ni credenciales para resolver un cambio de este kit.

## Entrega del agente

El comentario final del Issue o PR debe incluir:

```text
Estado: listo para revisión | bloqueado
Hecho: ...
Validación: ...
Pendiente: ...
```

Si otro agente debe continuar, deja el contexto en el Issue o PR; no dependas de memoria privada ni de mensajes fuera de GitHub.
