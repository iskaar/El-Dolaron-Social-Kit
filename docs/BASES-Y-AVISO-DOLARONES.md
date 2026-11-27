# Dolarones — bases del programa y aviso de privacidad

**Estado: bases 2026-11-v8 y aviso 2026-10-v3.** La v8 (cupones junto con una membresía, #927) la aprobó el abogado según Isaac, que lo informó el 25/11/2026; `BASES_APROBADAS_VERSION` = `2026-11-v8` (ver abajo). La v7 (punto 7 bis, promoción de noviembre) la aprobó el abogado el 2/11/2026 y se encendió ese día (variables `PROMO_META_*` en `wrangler.jsonc`; PR #686). La v5 (vales y cupones acumulables, cupones, referidos en lugar de la promoción de apertura, cancelaciones) y el aviso v3 los aprobó el abogado el 30/10/2026 (PR #355). La v6 solo cambia el punto 7 por el piloto de familia y amigos (#631); el abogado la aprobó el 30/10/2026. No es asesoría legal.

**2026-11-v8 (Issue #927), aprobación del abogado informada por Isaac el 25/11/2026.** Un cupón (el vale que la tienda entrega sin una compra: devolución o monto libre) se puede usar en el mismo ticket que una membresía: se gasta primero el cupón y, si hace falta, después los Dolarones de la cuenta, que siguen pidiendo el código del portal. Lo ganado y la promoción de noviembre cuentan solo el dinero pagado y con socio no sale vale. El vale de compra (`origen = compra`) NO se combina con una membresía. Puntos que cambian: 6 quater, 8 y 10 (cancelación completa: cada parte regresa a su origen; con vale o cupón usado el ticket se cancela completo; una pieza de un ticket con cupón se devuelve como cupón nuevo). El aviso sigue en v3. Al subir `BASES_APROBADAS_VERSION` a `2026-11-v8`, todos los socios aceptan la v8 en su siguiente entrada al portal.

**2026-11-v7 (Issue #684), aprobada el 2/11/2026.** Agrega el punto 7 bis, promoción de noviembre de 2026: cada $3,000 en dinero pagados del 1 al 30 de noviembre dan 300 Dolarones de bono, además del 10 %, sin tope; el bono se usa desde las 00:00 del día siguiente y vence el 31/12/2026. También aclara, sin cambiar reglas, los puntos 2, 6, 8 y 10 según la [auditoría del 1/11/2026](auditorias/2026-11-01-bases-dolarones.md), que además lista las decisiones pendientes para Isaac. Isaac resolvió el 1/11/2026 las cuatro que tocaban el 7 bis (retiro del bono, bonos anteriores a la publicación, vale pasado a la cuenta y devoluciones después del 30/11); el texto ya las refleja. El aviso sigue en v3: la promoción no usa datos nuevos.

- Al subir `BASES_APROBADAS_VERSION` a `2026-11-v7`, todos los socios aceptaron la v7 en su siguiente entrada al portal.
- El bono vence el 31/12/2026; la promo se apaga sola el 1/12/2026 a las 00:00 hora de la tienda (`PROMO_META_FIN`).
- El PR #661 (niveles VIP, en espera) usó «2026-10-v7» y los puntos 6 quinquies y 6 sexies; si se retoma, va después de la v8 y sube a v9.

El texto que ve el cliente vive solo en estos dos archivos de texto plano, que son la única versión vigente:

- [`app/src/legal.ts`](../app/src/legal.ts), constante `BASES`: Parte 1, bases del programa Dolarones.
- [`app/src/legal.ts`](../app/src/legal.ts), constante `AVISO`: Parte 2, aviso de privacidad integral.

Este documento ya no contiene el cuerpo del texto, para que no haya dos versiones que puedan divergir. Cualquier cambio a las bases o al aviso se hace en esos archivos, con nueva versión y revisión del abogado.

RFC del titular completado el 01/10/2026. Las reglas del sistema están en [RECOMPENSAS-DOLARONES.md](RECOMPENSAS-DOLARONES.md) y el contrato técnico en [CONTRATO-PORTAL.md](CONTRATO-PORTAL.md).
