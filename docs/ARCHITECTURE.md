# Arquitectura del proyecto

## Propósito

El Dolarón es un kit social estático. La arquitectura optimiza tres cosas: que una persona pueda usar el kit sin instalar nada, que los assets tengan una fuente de verdad clara y que varios agentes puedan colaborar sin pisarse.

## Capas

```text
Assets de marca       01-Logos/ 02-Perfiles-y-portadas/
        +
Piezas reutilizables  03-Publicaciones/ 04-Historias/
        +
Datos de publicación  05-Guia-y-textos/
        +
Presentación          EMPIEZA-AQUI.html
        +
Calidad y coordinación tools/ + .github/ + AGENTS.md
```

### 1. Assets de marca

Los PNG y el SVG son los entregables visuales. Se conservan como archivos planos para que puedan usarse desde cualquier red social o editor básico.

### 2. Datos y copy

`Inventario-de-archivos.json` describe los archivos y sus dimensiones. `Paleta.json` contiene los colores objetivo. `Textos-para-redes.txt` contiene copy listo y plantillas que requieren datos reales.

### 3. Preview

`EMPIEZA-AQUI.html` es una guía autocontenida para revisión humana. No depende de un servidor ni de un framework.

### 4. Calidad

`tools/validate_assets.py` comprueba que el inventario sea JSON válido, que cada asset exista y que las dimensiones PNG documentadas coincidan. GitHub Actions lo ejecuta en cada push y pull request.

### 5. Coordinación

GitHub Issues son la cola de trabajo; ramas y PRs son el registro de cambios; `AGENTS.md` es el contrato común. Esto permite que agentes de proveedores distintos intercambien contexto dentro del repositorio, sin una capa de orquestación propia.

## Ownership por cambio

| Cambio | Archivos que normalmente toca | Requisito |
| --- | --- | --- |
| Logo o pieza visual | carpeta de asset + inventario | revisar preview y dimensiones |
| Copy | `Textos-para-redes.txt` | confirmar que los datos no sean inventados |
| Metadatos | JSON correspondiente | ejecutar validador |
| Guía visual | `EMPIEZA-AQUI.html` | comprobar enlaces y preview |
| Flujo de colaboración | `AGENTS.md` o `.github/` | explicar el motivo en el PR |

## Fuera de alcance de v1

- Aplicación web o panel administrativo.
- Base de datos o catálogo de inventario.
- Publicación automática en Instagram, Facebook, TikTok o WhatsApp.
- Almacenamiento de credenciales, datos personales o secretos.
- Sistema de diseño por capas o fuentes propietarias no entregadas.
