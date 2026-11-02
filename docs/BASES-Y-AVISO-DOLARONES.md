# Dolarones — bases del programa y aviso de privacidad

**Estado: bases 2026-10-v6 y aviso 2026-10-v3.** La v5 (vales y cupones acumulables, cupones, referidos en lugar de la promoción de apertura, cancelaciones) y el aviso v3 los aprobó el abogado el 30/10/2026 (PR #355). La v6 solo cambia el punto 7 por el piloto de familia y amigos (#631); el abogado la aprobó el 30/10/2026. No es asesoría legal.

**Borrador 2026-11-v7 (Issue #684), pendiente del abogado.** Agrega el punto 7 bis, promoción de noviembre de 2026: cada $3,000 en dinero pagados del 1 al 30 de noviembre dan 300 Dolarones de bono, además del 10 %, sin tope; el bono se usa desde las 00:00 del día siguiente y vence el 31/01/2027. También aclara, sin cambiar reglas, los puntos 2, 6, 8 y 10 según la [auditoría del 1/11/2026](auditorias/2026-11-01-bases-dolarones.md), que además lista las decisiones pendientes para Isaac. Isaac resolvió el 1/11/2026 las cuatro que tocaban el 7 bis (retiro del bono, bonos anteriores a la publicación, vale pasado a la cuenta y devoluciones después del 30/11); el texto ya las refleja. El aviso sigue en v3: la promoción no usa datos nuevos.

- La promoción no se anuncia hasta que el abogado apruebe la v7.
- `BASES_APROBADAS_VERSION` sigue en `2026-10-v6`: la sube el PR de código de #684 cuando haya aprobación, y obliga a todos los socios a aceptar la v7 en el portal.
- El Worker sirve el texto de `legal.ts` aunque esa variable no cambie, así que esta versión se mergea junto con ese PR, nunca antes.
- El PR #661 (niveles VIP, en espera) usó «2026-10-v7» y los puntos 6 quinquies y 6 sexies; si se retoma, va después de esta versión y sube a v8.

El texto que ve el cliente vive solo en estos dos archivos de texto plano, que son la única versión vigente:

- [`app/src/legal.ts`](../app/src/legal.ts), constante `BASES`: Parte 1, bases del programa Dolarones.
- [`app/src/legal.ts`](../app/src/legal.ts), constante `AVISO`: Parte 2, aviso de privacidad integral.

Este documento ya no contiene el cuerpo del texto, para que no haya dos versiones que puedan divergir. Cualquier cambio a las bases o al aviso se hace en esos archivos, con nueva versión y revisión del abogado.

RFC del titular completado el 01/10/2026. Las reglas del sistema están en [RECOMPENSAS-DOLARONES.md](RECOMPENSAS-DOLARONES.md) y el contrato técnico en [CONTRATO-PORTAL.md](CONTRATO-PORTAL.md).
