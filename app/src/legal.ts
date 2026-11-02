// Bases y aviso de privacidad de Dolarones que ve el cliente en el portal.
// Version 2026-10-v2, 1 de octubre de 2026: Isaac autoriza el vale desde la
// siguiente compra. Version 2026-10-v3, 2 de octubre de 2026: con visto bueno
// del abogado, los premios de apertura vencen en 24 horas y el cliente ya no
// elige un maximo en el portal; en caja se le pregunta si usa sus Dolarones.
// Version 2026-10-v4, 8 de octubre de 2026 (Issue #258): el vale de papel se puede
// pasar a una cuenta con la tarifa de socio (punto 6 ter). PENDIENTE: visto bueno del abogado.
// Version 2026-10-v5, 30 de octubre de 2026 (Issues #354, #489, #597, #611). Aprobada por el
// abogado el 30 de octubre de 2026 (tambien cubre v4). Cambios respecto a v4: vales y cupones se juntan en un ticket, hasta
// 10 (punto 8); cupones (punto 6 quater); el punto 7 pasa de la promocion de apertura, ya terminada,
// al programa de referidos; la cancelacion cubre vales juntos y premios de referidos (punto 10).
// El aviso sube a 2026-10-v3 (referidos y cupones).
// Version 2026-10-v6, 30 de octubre de 2026 (Issue #631): v5 no se desplego; solo cambia el punto 7.
// Piloto familia y amigos: un codigo de la tienda con 50 registros que da solo los 50 D al unirse,
// y solo esas cuentas tienen codigo DOL. Aprobada por el abogado el 30 de octubre de 2026. El aviso sigue en v3.
// Version 2026-11-v7, 1 de noviembre de 2026 (Issue #684). Aprobada por el abogado el 2 de noviembre de 2026.
// Cambios respecto a v6: punto 7 bis nuevo, promocion de noviembre (cada $3,000 en dinero dan 300 D de bono,
// vencen el 31/12/2026; decisiones de Isaac del 1/11 sobre retiro, rezago, vale y devoluciones tardias). Aclaraciones sin cambiar reglas (auditoria docs/auditorias/2026-11-01-bases-dolarones.md):
// hora de la tienda (punto 2); «dinero» incluye transferencia y lo ganado se usa desde las 00:00 del dia siguiente
// (punto 6, como ya hace el codigo); excepcion del vale pasado a cuenta (punto 6); devolucion parcial «dinero
// primero» (punto 10, regla de Isaac del 30/09). El aviso sigue en v3. El PR #661 (VIP, en espera) uso
// «2026-10-v7» y los puntos 6 quinquies y 6 sexies: si se retoma, va despues de esta y sube a v8.
// OJO: el Worker sirve este texto aunque BASES_APROBADAS_VERSION no cambie (worker.ts: PORTAL_BASES_TEXTO ||= BASES).
// Esta version se mergea junto con el PR que sube BASES_APROBADAS_VERSION, nunca antes.
// Viven aqui y no en variables porque Cloudflare limita cada
// variable a 5 KB. Cambiar este texto exige subir BASES_APROBADAS_VERSION.

export const BASES = `BASES DEL PROGRAMA DOLARONES
Versión 2026-11-v7, 1 de noviembre de 2026

1. Organizador
María Teresa Ferrusca Pérez, RFC FEPT660329TH4, con nombre comercial El Dolarón, en Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, San Luis Potosí, C.P. 78430.

2. Vigencia del programa
Del 2 de octubre de 2026 hasta que El Dolarón lo termine con un aviso de 30 días en la tienda. Los Dolarones vigentes al terminar el programa se respetan hasta su vencimiento.
Todas las fechas y horas de estas bases son hora de la tienda (hora del centro de México, UTC-6).

3. Quién participa
Personas físicas mayores de 18 años; al registrarse declaran serlo. Registrarse es gratuito y voluntario. Quien no es socio compra igual, a los mismos precios.

4. Registro
Hay un socio por persona y por teléfono. No existe PIN de socio. Hay dos formas de registrarse:
- En línea (portal). Con nombre y un celular mexicano de 10 dígitos que la persona controla, verificado con un código SMS de 6 dígitos. Antes de enviar el SMS y de crear la membresía se muestran estas bases y el aviso de privacidad, y se pide aceptarlos. La sesión puede conservarse en el dispositivo si la persona lo elige.
- En la tienda. El personal registra nombre, celular y, si la persona quiere, un correo, con las bases aceptadas. Para consultar su saldo y gastar, esa persona debe entrar después al portal con SMS y pedir en la tienda que el encargado vincule su membresía. El encargado revisa que sea el titular, su número de socio y su teléfono. Un teléfono que coincide no vincula la cuenta por sí solo. Mientras no esté vinculada, en caja el teléfono o el número de socio solo sirven para acumular.
Si el número ya pertenece a otro socio, o cambió de dueño, no se vincula ni se registra de forma automática: se resuelve en persona con el encargado.

5. Qué son los Dolarones
Son un saldo de recompensa para comprar en El Dolarón. 1 Dolarón equivale a $1.00 MXN en compras en la tienda.
- Sirven para cualquier producto de la tienda.
- Se pueden usar completos o en partes. Lo que no se usa se queda en el saldo.
- No se cambian por dinero ni dan cambio. La cuenta de socio no se vende ni se transfiere.

6. Cómo se ganan
Por cada $100.00 completos pagados en dinero (efectivo, tarjeta o transferencia) en una misma compra, el socio gana 10 Dolarones. Ejemplos: una compra de $99 no gana; una de $250 gana 20; una de $1,999 gana 190.
- La parte pagada con Dolarones no genera Dolarones.
- El socio debe identificarse antes de pagar, con el código de su portal, su teléfono o su número de socio. Dar solo el teléfono o el número acumula, pero no autoriza gastar Dolarones (ver punto 8).
- Una compra ya cobrada no se acumula después, salvo cuando se pasa un vale a la cuenta (punto 6 ter). Las compras hechas antes del 2 de octubre de 2026 no generan Dolarones.
- Lo ganado se puede usar a partir de las 00:00 del día siguiente a la compra.
- Cada Dolarón ganado vence 12 meses después de la compra que lo generó.

6 bis. Compras sin registro ni teléfono (vale impreso)
Una compra sin socio genera un vale impreso con código de barras por 5 Dolarones por cada $100 completos pagados en dinero: $99 dan 0; $250 dan 10; $1,999 dan 95.
- No se otorgan a la vez el crédito de socio y un vale por la misma compra.
- No se requieren nombre, teléfono ni membresía.
- El vale se puede gastar a partir de tu siguiente compra (no en la compra que lo generó) y vence exactamente 30 días después de su emisión confirmada, a la fecha y hora impresas. Puede usarse en partes; el saldo no usado mantiene ese vencimiento. La reimpresión y la devolución no reinician el plazo.
- El vale solo se usa en la tienda y con conexión. El ticket impreso muestra su saldo, desde cuándo se puede usar y cuándo vence (hora de la tienda).
- Si una compra se paga en parte con un vale, la parte pagada con Dolarones no genera un vale nuevo.
- El código identifica un saldo en el servidor: copiarlo no aumenta el valor, pero quien tenga el código podría gastar ese saldo.
- Sin red, no se entrega un código gastable hasta confirmar la venta; el ticket permite solicitar el vale después con su folio.

6 ter. Pasar un vale a tu cuenta
El vale impreso trae un código QR. Al escanearlo con el celular se abre el portal. Si la persona entra o se registra, el vale se cierra y su compra se abona a la cuenta con la tarifa de socio: 10 Dolarones por cada $100 completos pagados en dinero, en lugar de 5. Ejemplo: un vale de 10 Dolarones por una compra de $250 se vuelve 20 Dolarones en la cuenta.
- Solo se puede pasar un vale completo, sin usar, dentro de sus 30 días de vigencia, y de una compra que no se haya pagado en parte con Dolarones.
- Lo abonado sigue las reglas del punto 6: se usa a partir del día siguiente a la compra y vence 12 meses después de ella. El vale impreso deja de servir.
- Cada cuenta puede pasar hasta 2 vales en un periodo de 7 días.
- El vale es al portador: si otra persona pasa el código a su cuenta primero, el vale ya no se puede usar ni pasar.
- Si después se cancela la compra o se devuelve una parte, lo abonado se ajusta igual que en una compra de socio.

6 quater. Cupones
Un cupón es un vale impreso que la tienda entrega sin que lo genere una compra. Hay dos casos:
- Cupón por una devolución. Al devolver una compra o una pieza pagada en dinero, la tienda puede dar el valor en un cupón. Es una opción: el cliente puede rechazarla, y el cupón no sustituye ni limita los derechos del consumidor por ley (punto 10). El importe es el que muestra el cupón impreso y se calcula sobre el dinero que se devuelve; lo que se pagó con Dolarones regresa a su saldo (punto 10).
- Cupón de la tienda. La tienda puede emitir un cupón por un monto que ella decide, por ejemplo como cortesía o por una aclaración.
Reglas del cupón:
- Se puede usar desde que se entrega y vence exactamente 30 días después de su emisión, a la fecha y hora impresas. Puede usarse en partes; el saldo no usado mantiene ese vencimiento. La reimpresión no reinicia el plazo.
- Se gasta como un vale (punto 8): es al portador, solo se usa en la tienda y con conexión, se puede juntar con otros vales y cupones en un mismo ticket y no se combina con una membresía. Un cupón perdido no se repone.
- No se puede pasar a una cuenta (punto 6 ter).
- La parte de una compra pagada con un cupón no genera Dolarones ni un vale nuevo (punto 6 bis). Si se cancela esa compra, lo usado regresa al mismo cupón (punto 10).

7. Invita a alguien (referidos)
Mientras dure el piloto con familia y amigos, solo algunos socios pueden invitar a otras personas a unirse a Dolarones. Si se cumplen las condiciones de este punto, las dos personas reciben Dolarones.
- Código de familia y amigos. El Dolarón comparte un código propio que admite hasta 50 registros en total. Quien se une con él recibe los 50 Dolarones de «Al unirse», pero no el premio por su compra, y nadie recibe premio por esa invitación. Si el código ya llegó a su límite, quien lo recibió puede registrarse sin él.
- Código de invitación. Solo quien se unió con el código de familia y amigos tiene en su portal un código de invitación: las letras DOL, su número de socio y una letra de verificación. Ejemplo: DOL42K. Quien se une con un código de invitación, o sin código, no recibe uno.
- Quién lo puede usar. Solo una persona que crea su membresía nueva en el portal y escribe el código al registrarse. Quien ya es socio no recibe nada por usar un código, y nadie puede usar el suyo. Cada persona se une con un código una sola vez.
- Al unirse. La persona nueva recibe 50 Dolarones. Se pueden usar desde ese momento, vencen 30 días después y se gastan como los ganados por compras, sin mínimo de ticket.
- Premio por su compra. Cuando la persona invitada, identificada como socia, hace una compra en la que paga $150.00 o más en dinero, se liberan 25 Dolarones para ella y 25 para quien la invitó. Lo pagado con Dolarones no cuenta para ese mínimo. Si la compra es de menos, no se libera nada y el premio queda pendiente para la primera compra que sí cumpla. Cada invitación libera su premio una sola vez.
- Esos 25 Dolarones se pueden usar a partir del día siguiente a la compra, vencen 12 meses después de ella y se gastan como los ganados por compras.
- Límite. Cada código de invitación admite hasta 10 personas. Si un código ya llegó a su límite, quien lo recibió puede registrarse sin él.
- Si se cancela la compra que liberó un premio, ver el punto 10.
- El Dolarón puede terminar el programa de referidos. Desde ese momento no se aceptan códigos nuevos. A quien ya se unió con un código se le respetan sus 50 Dolarones y el premio de su primera compra que cumpla.
La promoción de apertura, con premios de Dolarones para las primeras personas en registrarse o llegar a la tienda, ya terminó. Los premios ya otorgados se respetan hasta su vencimiento, 24 horas después de otorgados, y se siguen gastando en tickets de $1,000 MXN o más, calculados antes de descontar Dolarones.

7 bis. Promoción de noviembre de 2026
Del 1 de noviembre de 2026 a las 00:00 al 30 de noviembre de 2026 a las 23:59:59, cada vez que el dinero que un socio paga en sus compras junta $3,000.00, recibe un bono de 300 Dolarones, además de los Dolarones que gana con cada compra (punto 6). Participan todos los socios, sin inscribirse.
- Qué cuenta. El dinero (efectivo, tarjeta o transferencia) de las compras cobradas en la tienda a la cuenta del socio, incluidos los pedidos del portal o de WhatsApp que se cobran en la tienda. También cuenta una compra de noviembre que el socio pasa a su cuenta desde un vale (punto 6 ter). Lo pagado con Dolarones no cuenta. Tampoco cuentan las compras en Mercado Libre.
- Cuándo. Cuenta la fecha y hora de la compra. Cuentan las compras desde el 1 de noviembre de 2026, aunque esta versión de las bases se publique después.
- Sin tope. 300 Dolarones al juntar $3,000.00, otros 300 al juntar $6,000.00, otros 300 al juntar $9,000.00, y así sucesivamente. Ejemplo: quien paga $1,800.00 el 3 de noviembre y $1,500.00 el 10 de noviembre junta $3,300.00; con la compra del 10 recibe el bono de 300 Dolarones, y los $300.00 que sobran cuentan para los siguientes $3,000.00. Por esas dos compras gana además 180 y 150 Dolarones (punto 6). En una compra de $2,000.00 pagada con 500 Dolarones y $1,500.00 en efectivo, cuentan $1,500.00.
- Al cerrar el mes. Lo que no complete un bloque de $3,000.00 al terminar el 30 de noviembre no da bono ni pasa a otro mes.
- Uso y vencimiento. El bono se puede usar a partir de las 00:00 del día siguiente a la compra con la que se completó el bloque, sin mínimo de compra, y vence el 31 de diciembre de 2026 a las 23:59:59. Se gasta como los Dolarones ganados por compras (punto 8).
- Bloques completados antes de publicarse esta versión, o al pasar un vale a la cuenta. Ese bono se abona con la siguiente compra del socio en noviembre en la que pague algo en dinero, sea del monto que sea, y se puede usar desde las 00:00 del día siguiente a esa compra. Si el socio no vuelve a comprar en noviembre, ese bono no se abona.
- Cancelaciones y devoluciones. Lo cancelado o devuelto se resta del dinero juntado, aunque la cancelación o devolución sea después del 30 de noviembre, así que hará falta más dinero para completar el siguiente bloque. Un bono ya abonado solo se retira si se cancela completa la compra con la que se completó su bloque; si ese bono ya se gastó en todo o en parte, esa cancelación no procede sola: se aclara en la tienda (punto 10). Las demás cancelaciones y devoluciones no retiran bonos ya abonados.
- Esta promoción no se combina con otros niveles o promociones de Dolarones que se publiquen después, salvo que sus bases digan otra cosa.

8. Cómo se usan
Al pagar, el socio inicia sesión en el portal y muestra su código en caja. Ahí se le pregunta si quiere usar sus Dolarones: todos los que apliquen a la compra, una parte o ninguno. El código dura cinco minutos y permite un solo canje; generar otro invalida el anterior. Dar solo el teléfono o número de socio no autoriza gasto. El canje requiere conexión. Los Dolarones se descuentan primero de los que vencen antes. El resto de la compra se paga en efectivo, con tarjeta o por transferencia. El saldo aparece en el ticket.

El cliente sin registro presenta su vale o cupón impreso. En caja se consulta su saldo y vigencia; «Usar máximo» cubre el total de la compra o usa el saldo elegible, lo que sea menor. También se puede indicar un importe parcial. En un mismo ticket se pueden juntar hasta 10 vales o cupones, escaneándolos uno por uno. Se gasta primero el que vence antes, sin importar el orden en que se presenten, y el que no hace falta no se toca. Los vales y cupones no se combinan con una membresía en el mismo ticket. Para pasar un vale al saldo de una cuenta, ver el punto 6 ter. Un vale o cupón perdido no se repone: es al portador, como dinero de la tienda. El personal solo lo reimprime si se presenta el papel dañado, o si el ticket de la compra quedó sin vale por una falla de impresión o de conexión; para eso el ticket trae el folio de la venta.

9. Seguridad del acceso
No compartas códigos SMS, tu sesión ni el código de barras: quien copie un código vigente podría gastar tu saldo disponible. En dispositivos compartidos, no conserves la sesión y ciérrala al terminar. Generar otro código o cerrar sesión invalida el anterior (requiere conexión). El encargado revisa presencialmente la vinculación de una membresía previa; un teléfono coincidente no la vincula automáticamente. No hay recuperación automática de una cuenta ya vinculada.

10. Devoluciones y cancelaciones
Si se cancela o devuelve una compra, los Dolarones usados en ella regresan al saldo y los que se ganaron con ella se retiran. Los Dolarones que regresan conservan su vencimiento original: la cancelación y las reimpresiones no lo amplían. Con vales y cupones sucede igual: lo usado regresa al vale o cupón del que salió y conserva su vencimiento; si se juntaron varios, cada parte regresa al suyo. El vale generado por la compra se retira. Si se devuelve solo una parte de la compra, primero se regresa el dinero, hasta lo que se pagó en dinero; solo lo que pase de eso regresa como Dolarones al saldo. Los Dolarones ganados con la compra se vuelven a calcular sobre el dinero que sigue pagado y se retira la diferencia. Si la compra liberó un premio de referidos (punto 7), se retiran los 25 Dolarones de cada una de las dos personas y la invitación queda pendiente hasta una nueva compra que cumpla la condición. Si la compra contó para la promoción de noviembre (punto 7 bis), lo cancelado o devuelto se resta del dinero juntado y el bono se retira cuando corresponde, como dice ese punto. Si lo que esa compra generó (Dolarones de socio, vale, premio de referidos o bono de la promoción de noviembre) ya se gastó en todo o en parte, la compra no se cancela sola; se aclara en la tienda antes de devolver dinero o mercancía. Si la tienda ofrece un cupón en lugar de dinero (punto 6 quater), el cliente puede rechazarlo. Los derechos del consumidor por ley no cambian por este programa.

11. Aclaraciones
En la tienda, de 11:00 a 20:00 todos los días, por WhatsApp al 444 543 7754 o por teléfono fijo al 444 854 5980.`;

export const AVISO = `AVISO DE PRIVACIDAD INTEGRAL - SOCIOS DOLARONES
Versión 2026-10-v3, 30 de octubre de 2026

Responsable
María Teresa Ferrusca Pérez, RFC FEPT660329TH4 (El Dolarón), Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, S.L.P., C.P. 78430.

Datos que tratamos
Nombre, teléfono celular, correo opcional en registros presenciales y el historial de compras, Dolarones ganados, usados y saldo. Si te uniste con un código de invitación, quién te invitó y si ya se liberó el premio; si invitas a otras personas, cuántas se unieron con tu código y si se liberó su premio (ves solo esas cifras, no sus datos). En tu portal ves tu saldo, sus vencimientos y un recibo de cada compra hecha como socio (piezas, importes y forma de pago); es un comprobante de compra, no una factura fiscal. Para el acceso web se conserva el identificador de tu cuenta con el proveedor SMS, la versión de bases aceptada y la fecha. No hay PIN de socio; el servidor conserva una huella del código temporal, su límite, vigencia y uso, no el código legible. No pedimos datos sensibles, domicilio, fecha de nacimiento ni identificación oficial.

Vales sin registro
Se conserva únicamente información de la compra y del vale: el código legible, para que el personal autorizado pueda reimprimirlo, la venta que lo generó, su saldo, movimientos y vigencia. Los cupones se guardan igual; el de una devolución conserva además la venta de origen, y el que emite la tienda, su motivo y quién lo autorizó. No se crea un perfil de socio ni se pide teléfono o nombre. Quien tenga el papel puede gastar su saldo.

Verificación por SMS
Para entrar al portal, tu número se envía a un proveedor de verificación, Google Firebase Authentication. Este proveedor envía el código SMS, guarda el identificador de tu cuenta y tu número, y puede recibir datos técnicos de tu navegador (como la dirección IP) y de la comprobación anti-abuso reCAPTCHA. Para eso, tu navegador carga código de esos servicios y, si eliges mantener la sesión, guarda en tu dispositivo la sesión del proveedor. Sin esa verificación no se puede usar el portal; comprar y acumular en la tienda, sí. El proveedor puede estar fuera de México.

Para qué los usamos (finalidades necesarias)
Registrarte como socio; verificar tu teléfono y darte acceso al portal; identificarte en la caja; calcular, abonar y descontar Dolarones; mostrarte tu saldo y tus recibos; registrar quién invitó a quién y si se liberó el premio de referidos; evitar registros duplicados; y atender aclaraciones. No usamos tus datos para publicidad. Si en el futuro quisiéramos enviarte promociones, te pediremos un consentimiento aparte, y negarte no afectará tu participación.

Con quién los compartimos
No vendemos tus datos ni los usamos para publicidad de terceros. Se guardan en servicios de cómputo en la nube (Cloudflare, Inc.) que los procesan por cuenta de El Dolarón. El número con el que entras al portal lo procesa el proveedor de verificación por SMS descrito arriba (Google), junto con el operador que entrega el mensaje. Nadie más recibe tus datos, salvo una autoridad que los pida conforme a la ley.

Tus derechos (ARCO) y revocación
Puedes acceder, rectificar, cancelar u oponerte al uso de tus datos, o revocar tu consentimiento, escribiendo a privacidad@eldolaron.com, por WhatsApp al 444 543 7754 o en la tienda. Responderemos en los plazos que marca la Ley Federal de Protección de Datos Personales en Posesión de los Particulares vigente. Cancelar tus datos implica dejar el programa y perder el saldo de Dolarones.

Cuánto tiempo los guardamos
Mientras seas socio y 12 meses después, por aclaraciones y obligaciones contables. Los códigos temporales del portal dejan de servir a los cinco minutos. Los registros de vales se conservan mientras tengan saldo vigente y 12 meses después, por aclaraciones.

Cambios a este aviso
Se publicarán en la tienda y se te informarán al usar el programa.

Versión 2026-10-v3, 30 de octubre de 2026`;
