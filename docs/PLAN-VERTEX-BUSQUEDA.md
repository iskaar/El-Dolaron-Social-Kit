# Plan: análisis de fotos con Gemini en Vertex (búsqueda de Google)

Issue #363. Proyecto de Google Cloud: `gen-lang-client-0344365575` (Agent Platform, antes Vertex AI).

## Por qué

- Desde el Issue #91 la tienda corre con Claude Haiku porque se acabó el crédito de
  Gemini (AI Studio). Claude estima el precio **de memoria**.
- `BUSQUEDA_WEB=si` ya está en `wrangler.jsonc`, pero solo funciona con Gemini
  (`analisis.ts`, Issue #36): hoy no hace nada.
- Vertex cobra al proyecto de Google Cloud, no a la cuota de AI Studio. Con eso vuelve
  la búsqueda real en Amazon MX, Mercado Libre, Walmart MX y Liverpool.

## Qué se entiende por "search AI agent"

**Gemini en Vertex con *Grounding with Google Search***: el mismo análisis de hoy,
mismo prompt, mismo JSON, pero el modelo busca el precio antes de responder.

No entra (y por qué):
- **Vertex AI Search (data stores)**: busca en datos propios indexados. Se reconsidera
  solo si el grounding trae precios de EE. UU. con frecuencia.
- **Agent Engine / ADK**: una llamada por foto no necesita un agente hospedado.
- **Quitar Claude**: queda como respaldo con `MODELO_ANALISIS=claude`.

## Cambio de código (PR del Issue #363)

1. `conGemini()`: si existe el secreto `VERTEX_API_KEY`, llama a
   `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent?key=…`
   (formato de API key de Agent Platform: sin proyecto ni región en la ruta). Si no,
   la URL de AI Studio de siempre.
2. Cuerpo único para las dos: `role: 'user'` (Vertex lo exige), `inlineData`/`mimeType`
   y la herramienta `googleSearch` (nombres canónicos de JSON que aceptan ambas).
3. Modelo fijo `gemini-3.8-flash` (GA 2026-09-02, retiro no antes de 2027-09-02);
   Vertex no publica alias `-latest`.
4. Con búsqueda, el log "analisis listo" trae `fuentes` (dominios de
   `groundingMetadata.groundingChunks[].web.title`, máx. 5). Sin columnas nuevas.
5. `env.d.ts`: `VERTEX_API_KEY?`.
6. Solo `wrangler.sandbox.jsonc`: `MODELO_ANALISIS: "gemini"`, `BUSQUEDA_WEB: "si"`.
   Producción no cambia en este PR.
7. Prueba en `analisis.test.ts`: con `VERTEX_API_KEY` la llamada va a Vertex con rol,
   `googleSearch` y sin esquema; la fila queda `listo` y el log trae las fuentes.

## Pasos de Isaac

1. ~~Habilitar Agent Platform API~~ (hecho).
2. ~~Crear API key de Agent Platform y cargarla en sandbox~~ (hecho).
3. Desplegar sandbox: `npx wrangler deploy --config wrangler.sandbox.jsonc` (desde `app/`).
4. Capturar 5–10 piezas reales en sandbox y revisar en los logs del Worker
   (`analisis listo`): `ms` < 22 000, `buscar: true`, `fuentes` con tiendas mexicanas.
   Si sale `Gemini 403`, la key no tiene permiso para Agent Platform API; `404`, el
   modelo no está disponible para la key.
5. Si convence: `npx wrangler secret put VERTEX_API_KEY` (producción), cambiar
   `MODELO_ANALISIS` a `"gemini"` en `wrangler.jsonc` y desplegar.

## Decisión pendiente: costo

El grounding con Google Search se cobra **por consulta aparte del modelo**. Hoy el
análisis cuesta ~$1 USD por pallet de mil piezas; con búsqueda puede subir un orden de
magnitud. Revisar la tarifa vigente antes de producción y decidir: búsqueda en todas las
piezas, o solo las que la IA estima arriba de $200 (etiqueta individual).
