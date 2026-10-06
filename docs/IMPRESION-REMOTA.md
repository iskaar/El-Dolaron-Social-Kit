# Impresión remota desde el piso de venta

Decisión de Isaac, 01/10/2026: cobrar con tarjeta o transferencia en el celular y
enviar el papel a la Epson conectada por WebUSB a la computadora de caja. El cajón
no se abre a distancia. El celular entra a `/caja` con permiso de cobrar; el
hostname exclusivo de captura conserva sus restricciones.

## Uso y estación de la computadora

En el celular, sin impresora conectada, marcar **Imprimir en otra caja** y elegir
**Imprimir en: Caja 1, Caja 2 o Caja 3**. Se reutilizan las opciones del selector
de caja existente. El destino se recuerda en `localStorage` (`imprimir-en`), con
`try/catch`; por defecto es Caja 1. El modo se elige explícitamente en cada carga.
Efectivo y acciones del cajón quedan deshabilitados. La venta muestra
«Ticket enviado a …»; sin red aclara que se enviará al sincronizar.
La caja contable conserva su selección/asignación existente, independiente del
destino del papel; si no hay caja asignada, elegirla arriba antes de cobrar.

La computadora usa `cajaActual()`, la misma estación de cobros y cortes: el campo
**Esta computadora es** se recuerda en `localStorage` (`caja-nombre`). Si
`/api/yo` devuelve caja asignada a `cajero ?? usuario`, esa asignación prevalece
y el selector queda bloqueado. En las rutas se aplica también `cajaDe`: la caja
asignada al cajero prevalece sobre la pedida. La asignación del cajero en turno
debe corresponder a la estación física donde está la Epson. La cuenta
`computadora` necesita el PIN del cajero, igual que para cobrar.

Con `/caja` visible y la impresora conectada, se consulta cada 4 s. Se toma cada
ticket antes de imprimir; sólo un 200 permite llamar a `imprimirTicket`, que ya
imprime el vale emitido aparte. No se abre el cajón al consumir la cola. Un fallo
de USB o una respuesta de toma perdida deja el folio visible y un botón para
abrir esa venta. También se puede abrir en **Ventas de hoy → Reimprimir ticket**.
El botón de error permite recuperar ventas cuya fecha de cobro sea de otro día.

## Contrato de las rutas

Mismos roles que `/api/ventas` (`cajero`, `computadora` con PIN, o dueño).
Importes y saldo en centavos. Los nombres de estación aceptan 1–30 caracteres,
empiezan con letra o número y permiten letras con acentos, números, espacios,
punto, guion y guion bajo. Se rechazan espacios al principio/final o repetidos.
La comparación de estación distingue mayúsculas y minúsculas.

`POST /api/ventas` conserva su cuerpo actual y agrega `imprimir_en` opcional:

```json
{
  "id": "a2222222-2222-4222-8222-222222222222",
  "lineas": [{ "producto_id": "a1111111-1111-4111-8111-111111111111", "cantidad": 1 }],
  "forma_pago": "tarjeta",
  "efectivo": 0,
  "caja": "Caja 1",
  "imprimir_en": "Caja 1"
}
```

El 201 agrega `"imprimir_en":"Caja 1"` a la respuesta existente; sin destino,
devuelve `null`. Un reintento conserva 200/`duplicada:true` y devuelve el destino
original. Si se manda el campo, debe ser texto válido (no `null` ni vacío).
Efectivo con destino devuelve 400:

```json
{ "error": "En el celular sólo tarjeta o transferencia; no se puede cobrar efectivo con impresión remota." }
```

`imprimir_en` **no entra en `pedido_hash`**: indica dónde sale el papel, no cambia
la compra. El primer registro fija el destino. Reintentar con otra estación no
da 409 ni mueve o duplica el ticket; cambiar líneas, pago u otro dato del pedido
sí conserva el conflicto existente. La caja contable sigue resolviéndose con
`cajaDe`; cambiar sólo el destino del papel no cambia la caja contable.

`GET /api/impresiones?caja=Caja%201` devuelve 200 y un array, o `[]` si no hay
pendientes. Filtra por estación efectiva, `impreso_en is null`, no canceladas y
`registrado_en` en las últimas 24 h, ordenadas por aceptación e id, hasta 50 por
consulta. Se usa la fecha del servidor para que una venta antigua sin red
entre al sincronizar. Cada objeto reutiliza el detalle de venta y agrega todo
lo necesario para el ticket:

```json
[
  {
    "id": "a2222222-2222-4222-8222-222222222222",
    "imprimir_en": "Caja 1",
    "impreso_en": null,
    "creado_en": "2026-10-01T18:00:00.000Z",
    "total": 25000,
    "dolarones": 0,
    "forma_pago": "tarjeta",
    "efectivo": 0,
    "cambio": 0,
    "lineas": [{ "nombre": "Ventilador", "precio": 25000, "cantidad": 1 }],
    "socio": { "numero": 1, "nombre": "Cliente", "ganados": 2000, "saldo": 50000 },
    "vale_emitido": null,
    "vale_usado": null
  }
]
```

El ejemplo es sintético. Incluye también campos de detalle (caja, cajero,
cancelación, devoluciones, códigos e ids de líneas). `socio` es `null` cuando no
hubo membresía; su saldo disponible se consulta al preparar el papel. Los vales
son `null` o el mismo objeto de la respuesta actual de venta:
`{id,codigo,importe,restante,disponible_desde,vence_en,creado_en}`; su restante es
el saldo actual, compartido con las copias. Esta respuesta usa `no-store`.

`POST /api/impresiones/<id>/tomar` recibe:

```json
{ "caja": "Caja 1" }
```

Un UPDATE atómico marca la fecha del servidor sólo si la venta está pendiente,
pertenece a la estación efectiva y sigue sin cancelar. 200:

```json
{ "id": "a2222222-2222-4222-8222-222222222222", "impreso_en": "2026-10-01T18:00:04.000Z" }
```

Una segunda toma, estación ajena, venta local/inexistente o cancelada devuelve
409 con `{ "error": "Ticket ya tomado, cancelado o no pendiente en esta estación." }`.
Id o estación mal formados devuelven 400; sesión y permisos conservan 401/403.
`impreso_en` significa **tomado para impresión**, no confirmación del papel.

Para recuperar el ticket, `GET /api/ventas/<id>?imprimir=1` devuelve el mismo
detalle enriquecido con socio y vales, con `no-store`. El detalle normal conserva
su contenido habitual, más `imprimir_en` e `impreso_en`. Antes de una reimpresión
manual de un remoto aún pendiente, la pantalla también exige tomarlo para que
el consumidor automático no duplique el papel.

## Migración y validación

`app/migracion-022-impresion-remota.sql` agrega las dos columnas `text` anulables
y el índice parcial `(imprimir_en, registrado_en)` sólo para remotos pendientes
no cancelados. Las ventas existentes siguen siendo locales (`null`).
`schema.sql` es el esquema base, no incluye siquiera la tabla ventas: el repo
arranca con ese archivo y luego aplica las migraciones. Se conserva ese patrón.

El operador debe correr **una vez y antes de desplegar** desde `app/`:

```sh
npx wrangler d1 execute el-dolaron --remote --file=migracion-022-impresion-remota.sql
```

No se ejecutó la migración remota ni se desplegó. En Windows con `npm.ps1`
bloqueado, los checks equivalentes son `npm.cmd test` y `npm.cmd run typecheck`.
Las pruebas usan `node:test`, el Worker y SQLite de `prueba-d1`, con todas las
migraciones, y ejecutan los bloques reales de cobro/sincronización/consumidor
con navegador e impresora simulados.

## Límites operativos

- Latencia habitual: siguiente consulta (hasta unos 4 s) más red, cola y USB;
  el papel del vale añade su pausa existente. El cobro no espera el papel.
- Con la computadora apagada, pestaña oculta, Epson desconectada, PIN vencido
  o sin red, el ticket no se imprime hasta recuperar esas condiciones.
- Tras 24 h desde su aceptación sale de la consulta automática; requiere
  recuperación manual. Una estación equivocada tampoco tiene consumidor.
- Tomar evita duplicados entre pestañas. Cerrar la pestaña, perder la respuesta
  o fallar USB tras tomar puede dejar el ticket sin papel. No hay reintento
  automático de tomados; se revisa y reimprime manualmente, pues una impresión
  parcial o una respuesta perdida podrían haber producido papel.
- Una cancelación posterior a la toma puede ocurrir mientras sale el papel.
  El ticket impreso refleja la compra original; el desglose y comprobante de
  cancelación conservan la devolución registrada.
- Socio y vales usan el saldo vigente al consultar, no una foto histórica.
  No se validó físicamente la Epson ni la conexión desde un celular real.

## Entrega A02 para Claude

Estado: listo para revisión
Hecho: migración 022, cola y toma atómica, validación de estación, cobro remoto sin efectivo, sincronización y recuperación del ticket.
Validación: npm.cmd test: 207/207, incluidas 15 nuevas; npm.cmd run typecheck: verde; validate_assets.py: 12 assets válidos; git diff --check y sintaxis del módulo de caja: correctos.
Pendiente: Claude hace commit/PR e integración con el botón de cámara; operador aplica 022 antes del despliegue; prueba física celular/Epson.

Archivos: `app/migracion-022-impresion-remota.sql`, `app/src/worker.ts`,
`app/src/cuentas.ts`, `app/src/devoluciones.ts`, `app/public/caja.html`,
`app/src/impresiones.test.ts`, `app/src/venta-servidor.test.ts` (stub del nuevo
modo para la prueba previa de reintento) y este documento. Los cambios de
`caja.html` tienen bloques de impresión remota identificados y no modifican
la entrada de códigos/cámara. No se agregan assets del kit ni dependencias.

Commit sugerido: `Permite cobrar en celular e imprimir el ticket en la caja`.
