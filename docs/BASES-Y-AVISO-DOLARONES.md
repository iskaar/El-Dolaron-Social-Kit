# Dolarones — bases del programa y aviso de privacidad (BORRADOR)

**Estado: borrador para revisión del abogado.** Redactado por Claude el 26/09/2026 con las decisiones de Isaac ([reglas](RECOMPENSAS-DOLARONES.md), sección 2; [Issue #81](https://github.com/iskaar/El-Dolaron-Social-Kit/issues/81)). No publicar ni entregar a clientes hasta que el abogado lo apruebe y se completen los `[CORCHETES]`. No es asesoría legal.

La caja y el portal registran la versión aceptada en cada alta (`BASES_APROBADAS_VERSION`, ausente hasta aprobación). Este archivo sigue siendo un borrador: el backend del portal permanece cerrado y el proveedor SMS no está configurado; no publicar hasta completar revisión legal y las notas para el abogado.

**Cómo llega este texto al cliente.** El portal muestra lo que contengan `PORTAL_BASES_TEXTO` y `PORTAL_AVISO_TEXTO`, como texto plano (sin negritas ni tablas), antes de pedir el consentimiento. Al aprobar el texto final: quitar las notas internas y los `[CORCHETES]`, copiar cada parte a esas variables, cambiar `BASES_APROBADAS_VERSION` y fijar `PROMOCION_INICIO`. Las tablas de esta versión deben pasar a lista para que se lean en texto plano. Los vales solo se emiten con `VALES_ABIERTOS=si`, y esa variable se enciende después de que este texto esté aprobado ([contrato](CONTRATO-PORTAL.md)).

---

## Parte 1. Bases del programa Dolarones

**1. Organizador.** María Teresa Ferrusca Pérez, RFC `[RFC DEL TITULAR]`, con nombre comercial El Dolarón, en Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, San Luis Potosí, C.P. 78430.

**2. Vigencia del programa.** Del 2 de octubre de 2026 hasta que El Dolarón lo termine con un aviso de 30 días en la tienda. Los Dolarones vigentes al terminar el programa se respetan hasta su vencimiento.

**3. Quién participa.** Personas físicas mayores de 18 años; al registrarse declaran serlo. Registrarse es gratuito y voluntario. Quien no es socio compra igual, a los mismos precios.

**4. Registro.** Hay un socio por persona y por teléfono. No existe PIN de socio. Hay dos formas de registrarse:

- **En línea (portal).** Con nombre y un celular mexicano de 10 dígitos que la persona controla, verificado con un código SMS de 6 dígitos. Antes de enviar el SMS y de crear la membresía se muestran estas bases y el aviso de privacidad, y se pide aceptarlos. La sesión puede conservarse en el dispositivo si la persona lo elige.
- **En la tienda.** El personal registra nombre, celular y, si la persona quiere, un correo, con las bases aceptadas. Para consultar su saldo y gastar, esa persona debe entrar después al portal con SMS y pedir en la tienda que el encargado vincule su membresía: el encargado revisa que sea el titular, su número de socio y su teléfono. Un teléfono que coincide **no** vincula la cuenta por sí solo. Mientras no esté vinculada, en caja el teléfono o número de socio solo sirven para acumular.

Si el número ya pertenece a otro socio, o cambió de dueño, no se vincula ni se registra de forma automática: se resuelve en persona con el encargado. `[ABOGADO: aprobar datos, medios de verificación, altas en tienda/portal y procedimiento ante teléfono cambiado o reasignado.]`

**5. Qué son los Dolarones.** Son un saldo de recompensa para comprar en El Dolarón. 1 Dolarón equivale a $1.00 MXN en compras en la tienda.

- Sirven para cualquier producto de la tienda.
- Se pueden usar completos o en partes. Lo que no se usa se queda en el saldo.
- No se cambian por dinero ni dan cambio. La cuenta de socio no se vende ni transfiere. `[ABOGADO: revisar tratamiento de los vales anónimos al portador, copias y pérdida del papel.]`

**6. Cómo se ganan.** Por cada $100.00 completos pagados en efectivo o con tarjeta en una misma compra, el socio gana 10 Dolarones. Ejemplos: una compra de $99 no gana; una de $250 gana 20; una de $1,999 gana 190.

- La parte pagada con Dolarones no genera Dolarones.
- El socio debe identificarse antes de pagar, con el código de su portal, su teléfono o su número de socio. Dar solo el teléfono o el número **acumula**, pero no autoriza gastar Dolarones (ver punto 8). Una compra ya cobrada no se acumula después, y las compras hechas antes del 2 de octubre de 2026 no generan Dolarones.
- Lo ganado se puede usar a partir del día siguiente a la compra.
- Cada Dolarón ganado vence 12 meses después de la compra que lo generó.

**6 bis. Sin registro ni teléfono (decisión de Isaac, #133).** Una compra sin socio genera un vale impreso con barcode por **5 Dolarones por cada $100 completos** pagados en dinero: $99 → 0 D; $250 → 10 D; $1,999 → 95 D. No se otorgan a la vez el crédito de socio y un vale por la misma compra. El vale se puede gastar desde el día siguiente y vence exactamente **30 días desde su emisión confirmada**, a la fecha/hora impresas. Puede usarse en partes; el saldo no usado mantiene ese vencimiento. No se requieren nombre, teléfono ni membresía. El vale solo se usa en la tienda y con conexión; el ticket impreso muestra su saldo, desde cuándo se puede usar y cuándo vence (hora de la tienda). Si una compra se paga en parte con un vale, la parte pagada con Dolarones no genera un vale nuevo. El código identifica un saldo en el servidor: copiarlo no aumenta el valor, pero quien tenga el código podría gastar ese saldo. Reimpresión y devolución no reinician el plazo. Sin red, no se entrega un código gastable hasta confirmar la venta; el ticket permite solicitar el vale después con su folio. `[ABOGADO/ISAAC: revisar aviso en caja, elegibilidad, pérdida/copias y procedimiento de devolución cuando ya se gastó el vale.]`

**7. Promoción de apertura.** Se entregan 100 premios, por un total de 15,000 Dolarones:

| Cupos en línea | Cantidad | Dolarones c/u | Total |
| --- | ---: | ---: | ---: |
|  | 5 | 300 | 1,500 |
|  | 6 | 200 | 1,200 |
|  | 14 | 150 | 2,100 |
|  | 25 | 100 | 2,500 |
| **Subtotal en línea** | **50** | | **7,300** |

| Cupos en tienda | Cantidad | Dolarones c/u | Total |
| --- | ---: | ---: | ---: |
| Primera llegada física | 1 | 500 | 500 |
|  | 5 | 300 | 1,500 |
|  | 7 | 200 | 1,400 |
|  | 12 | 150 | 1,800 |
|  | 25 | 100 | 2,500 |
| **Subtotal en tienda** | **50** | | **7,700** |
| **Total** | **100** | | **15,000** |

- Solo puede otorgarse un premio de apertura por persona. Los 500 D son exclusivos de la primera persona que llegue físicamente a la tienda. Si ya recibió un premio online, ese premio se sustituye por 500 D y el importe que tenía vuelve a la bolsa online; no acumula ambos premios. Si el premio online ya se usó en parte o ya venció, esa persona conserva su premio como está y pierde el derecho a los 500 D. `[ISAAC: confirmar si esos 500 D pasan a la siguiente persona presente o quedan sin entregar; hoy el sistema los deja sin asignar.]`
- No hay prerregistro. El premio en línea se otorga cuando la persona completa su registro, a partir del 2 de octubre de 2026 a las 11:00 (hora de la tienda), y sus 30 días cuentan desde ese momento. El orden lo fija el servidor, no el navegador. Los cupos en tienda se otorgan en el orden en que el personal confirma la llegada de cada persona presente. Al agotarse los cupos de un canal no se otorgan más premios en él.
- Los premios de apertura se pueden gastar en partes en tickets de $1,000 MXN o más, calculados antes de descontar Dolarones. Esta condición no aplica a D ganados por compras.
- Cada premio vence 30 días después de otorgarse. Lo no usado vence y no se reasigna.
- `[ABOGADO: completar elegibilidad, orden, cómo se acredita la primera llegada y qué premio sustituye el cupo que vuelve a la bolsa, incluida la fecha límite.]`

**8. Cómo se usan.** Al pagar, el socio inicia sesión en el portal, elige el máximo de Dolarones que autoriza y muestra su código de barras en caja. El código dura cinco minutos y permite un solo canje; generar otro invalida el anterior. Un código con máximo cero identifica al socio para acumular, sin autorizar gasto. Dar solo el teléfono o número de socio tampoco autoriza gasto. En caja se pueden usar completos o en parte, hasta el máximo autorizado, y el canje requiere conexión. Los Dolarones se descuentan primero de los que vencen antes. El resto de la compra se paga en efectivo o con tarjeta. El saldo aparece en el ticket.

El cliente sin registro presenta su vale impreso. En caja se consulta su saldo y vigencia; «Usar máximo» cubre el total de la compra o usa el saldo elegible, lo que sea menor. También se puede indicar un importe parcial. En esta versión se usa un vale o una membresía por ticket, no varios a la vez, y el vale no se traspasa al saldo de una cuenta. Un vale perdido no se repone: es al portador, como dinero de la tienda. El personal solo lo reimprime si se presenta el papel dañado, o si el ticket de la compra quedó sin vale por una falla de impresión o de conexión; para eso el ticket trae el folio de la venta. `[ABOGADO: revisar esta política.]`

**9. Seguridad del acceso.** No compartas códigos SMS, tu sesión ni el código de barras: quien copie un código vigente podría usarlo hasta el máximo autorizado. En dispositivos compartidos, no conserves la sesión y ciérrala al terminar. Generar otro código o cerrar sesión invalida el anterior (requiere conexión). El encargado revisa presencialmente la vinculación de una membresía previa; un teléfono coincidente no la vincula automáticamente. `[ABOGADO: aprobar recuperación ante pérdida de acceso o número reasignado; no hay recuperación automática de una cuenta ya vinculada.]`

**10. Devoluciones y cancelaciones.** Si se cancela o devuelve una compra, los Dolarones usados en ella regresan al saldo y los que se ganaron con ella se retiran. Los Dolarones que regresan conservan su vencimiento original: la cancelación y las reimpresiones no lo amplían. Con un vale sucede igual: lo usado regresa al mismo vale, y el vale generado por la compra se retira. Si lo que esa compra generó (Dolarones de socio o vale) ya se gastó en todo o en parte, la compra no se cancela sola; se aclara en la tienda antes de devolver dinero o mercancía. Los derechos del consumidor por ley no cambian por este programa. `[ABOGADO: confirmar redacción y qué pasa si los Dolarones devueltos ya vencieron.]`

**11. Aclaraciones.** En la tienda, de 11:00 a 20:00 todos los días, por WhatsApp al 444 543 7754 o por teléfono fijo al 444 854 5980.

---

## Parte 2. Aviso de privacidad integral — socios Dolarones

**Responsable.** María Teresa Ferrusca Pérez, RFC `[RFC DEL TITULAR]` (El Dolarón), Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, S.L.P., C.P. 78430.

**Datos que tratamos.** Nombre, teléfono celular, correo opcional en registros presenciales y el historial de compras, Dolarones ganados, usados y saldo. En tu portal ves tu saldo, sus vencimientos y un recibo de cada compra hecha como socio (piezas, importes y forma de pago); es un comprobante de compra, no una factura fiscal. Para el acceso web se conserva el identificador de tu cuenta con el proveedor SMS, la versión de bases aceptada y la fecha. No hay PIN de socio; el servidor conserva una huella del código temporal, su límite, vigencia y uso, no el código legible. No pedimos datos sensibles, domicilio, fecha de nacimiento ni identificación oficial.

**Vales sin registro.** Se conserva únicamente información de la compra y del vale: el código legible para que el personal autorizado pueda reimprimirlo, la venta que lo generó, su saldo, movimientos y vigencia; no se crea un perfil de socio ni se pide teléfono o nombre. Quien tenga el papel puede gastar su saldo. `[ABOGADO: confirmar aviso y conservación aplicables a estos registros.]`

**Verificación por SMS.** Para entrar al portal, tu número se envía a un proveedor de verificación `[Google Firebase Authentication / Identity Platform: propuesta por confirmar antes del alta real]`, que envía el código SMS, guarda el identificador de tu cuenta y tu número, y puede recibir datos técnicos de tu navegador (como la dirección IP) y de la comprobación anti-abuso reCAPTCHA. Para eso, tu navegador carga código de esos servicios y, si eliges mantener la sesión, guarda en tu dispositivo la sesión del proveedor. Sin esa verificación no se puede usar el portal; comprar y acumular en la tienda, sí. El proveedor puede estar fuera de México. `[ABOGADO: revisar proveedor, datos tratados, encargado, transferencias y conservación, así como el procedimiento ante un número reciclado o cambio de teléfono.]`

**Para qué los usamos (finalidades necesarias).** Registrarte como socio; verificar tu teléfono y darte acceso al portal; identificarte en la caja; calcular, abonar y descontar Dolarones; mostrarte tu saldo y tus recibos; asignar el regalo de apertura; evitar registros duplicados; y atender aclaraciones. No usamos tus datos para publicidad. Si en el futuro quisiéramos enviarte promociones, te pediremos un consentimiento aparte, y negarte no afectará tu participación.

**Con quién los compartimos.** No vendemos tus datos ni los usamos para publicidad de terceros. Se guardan en servicios de cómputo en la nube `[Cloudflare, Inc.]` que los procesan por cuenta de El Dolarón, y el número con el que entras al portal lo procesa el proveedor de verificación por SMS descrito arriba `[Google]`, junto con el operador que entrega el mensaje. Nadie más recibe tus datos, salvo una autoridad que los pida conforme a la ley. `[ABOGADO: confirmar la redacción sobre los encargados ubicados fuera de México.]`

**Tus derechos (ARCO) y revocación.** Puedes acceder, rectificar, cancelar u oponerte al uso de tus datos, o revocar tu consentimiento, escribiendo a privacidad@eldolaron.com, por WhatsApp al 444 543 7754 o en la tienda. Responderemos en los plazos que marca la Ley Federal de Protección de Datos Personales en Posesión de los Particulares vigente. Cancelar tus datos implica dejar el programa y perder el saldo de Dolarones. `[ABOGADO: validar esta consecuencia.]`

**Cuánto tiempo los guardamos.** Mientras seas socio y 12 meses después, por aclaraciones y obligaciones contables. Los códigos temporales del portal dejan de servir a los cinco minutos. Los registros de vales se conservan mientras tengan saldo vigente y 12 meses después, por aclaraciones.

**Cambios a este aviso.** Se publicarán en la tienda y se te informarán al usar el programa.

**Versión:** `[FECHA Y VERSIÓN FINAL]`

---

## Preguntas para el abogado

1. ¿Las bases cumplen con los artículos 46 a 48 de la LFPC para promociones: condiciones, vigencia y número de regalos publicados?
2. ¿Es válido que el regalo venza a los 30 días y que lo no usado se pierda sin reasignarse?
3. Devoluciones: ¿cómo redactar el retiro de Dolarones ya gastados y la devolución de Dolarones vencidos?
4. Edad mínima: se fijó en 18 años declarados al registrarse, sin verificación. ¿Basta? ¿Qué pasa si un menor se registra?
5. Aviso de privacidad: ¿cumple con la LFPDPPP de 2025? Revisar el encargado en la nube fuera de México, el plazo de conservación y el medio ARCO.
6. Fiscal: ¿cómo se factura una venta pagada en parte con Dolarones? ¿Cómo se registra el saldo pendiente? (Con el contador.)
7. ¿Se necesita algún aviso o registro ante Profeco o una autoridad local antes de anunciar el regalo?
8. Vales al portador (5%, 30 días): ¿es válido que el papel funcione como saldo de la tienda para quien lo tenga, que las copias compartan saldo y que la tienda no lo reponga si se pierde? ¿Cómo se redacta el aviso en caja?
9. Compra cuyos Dolarones o vale ya se gastaron: la cancelación se detiene, para socios y vales, hasta aclararlo en la tienda. ¿Puede la tienda condicionar así una devolución? ¿Cómo se redacta para no afectar los derechos del consumidor?
10. Verificación por SMS con un proveedor en el extranjero: ¿qué debe decir el aviso y hace falta consentimiento expreso para la transferencia?
11. Premio de apertura en línea ya usado o vencido cuando la persona resulta ser la primera llegada física: pierde el derecho a los 500 D. ¿Es válido publicarlo así?
