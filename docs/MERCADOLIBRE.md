# Guía de Configuración: Vender en Mercado Libre con El Dolarón

## 1. Qué necesitas antes de empezar

- Cuenta de Mercado Libre México a tu nombre (persona moral o física) con datos fiscales completos validados.
- Acceso al DevCenter de Mercado Libre como **administrador** de la cuenta.
- Una cámara o dispositivo para fotografiar prendas con luz natural (fotos mínimo 500×500 px, recomendado 1200×1200 px).
- Acceso a la aplicación El Dolarón (página `/mercadolibre`, solo para dueño).
- PowerShell (Windows) para generar dos valores secretos.

**No:** Solicites contraseñas, no compartas tus datos de acceso al DevCenter con nadie, no publiques datos reales en pruebas.

---

## 2. Crear la app en Mercado Libre (DevCenter)

En https://developers.mercadolibre.com.mx, sección "Mis aplicaciones":

1. **Nombre único**: p. ej., "El Dolarón San Luis Potosí"
2. **Descripción** (máx. 150 caracteres, se muestra al pedir autorización): "Aplicación para sincronizar inventario entre tienda física y Mercado Libre"
3. **Logo**: carga el logo de El Dolarón (es opcional; recomendado para confianza)
4. **Redirect URI**: registra exactamente `https://escaner.viste.com.mx/ml/callback` (sin cambios)
5. **Notificaciones callbacks URL**: registra exactamente `https://dolarones.eldolaron.com/api/ml/notificaciones/<RUTA_SECRETA>`  
   Sustituye `<RUTA_SECRETA>` con un valor que generes tú en el paso 3 (no es la URL visible, tú lo defines).
6. **Scopes**: marca `read` (leer), `write` (escribir), `offline_access` (para refrescar tokens sin pedir autenticación cada 3 horas).
7. **Tópicos de notificaciones**: marca `orders_v2` (cuando se vende en ML) y `items` (cambios en tus publicaciones).
8. **PKCE**: actívalo (la app lo usa por defecto). Si lo dejas apagado y la conexión falla, avísale a Claude para poner `ML_PKCE=no`.

Guarda tu `Client ID` y `Client Secret`. **No** los compartas públicamente.

---

## 3. Generar los secretos de Cloudflare

Abre PowerShell y ejecuta estos comandos desde tu computadora (solo necesitas hacerlo una vez):

### a. Generar `ML_LLAVE_TOKENS` (32 bytes en base64):
```powershell
$bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
[Convert]::ToBase64String($bytes)
```
Copia el resultado (una cadena larga con letras y números). Este es tu `ML_LLAVE_TOKENS`.

### b. Generar `ML_RUTA_NOTIFICACIONES` (una ruta secreta aleatoria):
```powershell
-join ((0..31) | % { [char][int][Math]::Floor(Get-Random -Minimum 65 -Maximum 122) })
```
Copia el resultado. Este es tu `ML_RUTA_NOTIFICACIONES`. Anótalo **en el mismo lugar** donde ya lo registraste en la URL de notificaciones del paso 2.

---

## 4. Cargar los secretos en Cloudflare

Desde tu carpeta `app/` en terminal o PowerShell, ejecuta estos comandos (reemplaza `<valor>` con lo que tengas):

```powershell
npx wrangler secret put ML_CLIENT_ID
# Cuando pida, pega tu Client ID de Mercado Libre (paso 2)

npx wrangler secret put ML_CLIENT_SECRET
# Cuando pida, pega tu Client Secret de Mercado Libre (paso 2)

npx wrangler secret put ML_LLAVE_TOKENS
# Cuando pida, pega el resultado del paso 3.a

npx wrangler secret put ML_RUTA_NOTIFICACIONES
# Cuando pida, pega el resultado del paso 3.b
```

Cloudflare los encripta y los mantiene seguros. No los verás de nuevo.

---

## 5. Ejecutar la migración de base de datos

Antes de que El Dolarón publique, la base de datos D1 necesita una migración. **En sandbox primero**, luego en producción:

```powershell
# Desde app/:
npm run migrate -- migracion-025-mercadolibre.sql
```

Esto crea las tablas y columnas necesarias para guardar tokens, piezas publicadas y órdenes. Solo se corre una vez.

---

## 6. Conectar tu cuenta desde El Dolarón

En la app, ve a `/mercadolibre` (solo visible para dueño):

1. Haz clic en **«Conectar con Mercado Libre»**.
2. Se abre Mercado Libre; inicia sesión con tu cuenta (la del DevCenter, la principal, no un colaborador).
3. Autoriza los permisos: read, write, offline_access.
4. Vuelves a El Dolarón. El sistema guarda tu token automáticamente.

Desde ahora, El Dolarón puede leer y escribir en tu cuenta de ML. No necesitas autorizar de nuevo (el token se renueva solo).

---

## 7. Crear guías de tallas (obligatorio para moda)

En Mercado Libre, Seller Center > Configuración > **Guías de tallas**:

1. **Por dominio y género**: crea una guía para "Pantalones Mujer", otra para "Playeras Hombre", etc.
2. **Tipo de guía**: elige **«Específica»** (propia tuya; las estándares de ML no sirven para ropa americana).
3. **Medidas**: define tallas (XS, S, M, L, XL, etc.) y las medidas reales en cm (pecho, cintura, largo).
   Ejemplo para una playera mujer:
   - XS: pecho 78 cm, largo 60 cm
   - S: pecho 82 cm, largo 62 cm
   - M: pecho 86 cm, largo 64 cm
   - L: pecho 90 cm, largo 66 cm

Guarda. **Nota**: las guías creadas no se pueden eliminar, solo editar nombres y agregar filas. Hazlo con cuidado.

**NO CONFIRMADO**: la investigación no confirma si se requiere fondo blanco obligatorio en fotos de portada para moda en MLM; blogs lo afirman.

---

## 8. Publicar una pieza

En El Dolarón, `/mercadolibre`:

1. **Fotografía**: saca una foto clara de la prenda con luz natural (fondo blanco si es posible; mínimo 500×500 px, máx. 1200×1200 px). Prohibido logos, textos, marcas de agua.
2. **«Por publicar»**: selecciona las piezas sin vender de tu inventario.
3. **Completa los campos**:
   - **Marca**: p. ej., "Levi's", "Nike" (requiere acreditación si es marca restringida, ver sección 9).
   - **Modelo**: p. ej., "501", "Air Max 90" (o "N/A" si no tiene).
   - **Género**: Mujer, Hombre, Niña, Niño, Bebé.
   - **Color**: Azul, Rojo, etc.
   - **Talla**: XS, S, M, L, XL (debe coincidir con una fila de tu guía de tallas).
   - **Material principal**: Algodón, Poliéster, Mezcla, etc.
   - **Tipo de prenda**: Jeans, Playera, Sudadera, Vestido, Pantalón, etc.
4. **Foto**: la app sube sola la foto que se tomó en la captura (una por pieza; mínimo 500×500 px).
5. **Descripción** (opcional): texto libre (p. ej., "Jeans Levi's 501 nuevo con etiqueta, talla M"). Solo se publican piezas nuevas.
6. **Precio**: la app propone el precio de tienda + el % de Mercado Libre (por defecto 20%), terminado en 9 y nunca menos de $35. Puedes cambiarlo antes de publicar. La comisión la descuenta Mercado Libre al vender.
7. **Publicación**: elige **«Clásica»** (8%-17% comisión) o **«Premium»** (11%-21.5%; incluye meses sin intereses para el comprador). Recomendado: **Clásica**.
8. **Envío**: el sistema usa **Mercado Envíos, modalidad drop-off** (llevas el paquete a una sucursal de paquetería). Costo: ML te cobra por peso y distancia, no es gratis desde cierta cantidad (a confirmar en tu cuenta).
9. Haz clic en **«Publicar»**.

---

## 9. Qué pasa cuando se vende

**Venta en la tienda física (caja)**:  
Cuando alguien compra una pieza en tu tienda, la caja la marca como vendida en D1. El Dolarón **pausa automáticamente** la publicación en ML (la prenda desaparece de búsqueda, pero la publicación queda guardada).

**Venta en Mercado Libre**:  
Un cliente compra en ML. Mercado Libre te notifica por email. El Dolarón **baja automáticamente** el stock en D1 (la pieza pasa a vendida). **Tú debes**:
1. Sacar la prenda de la tienda de inmediato (pasar al almacén o empaque).
2. Empacarla (con las dimensiones y peso que definiste).
3. Llevarla a una sucursal de Mercado Envíos (correos, etc.) con la etiqueta que imprime ML.

**Riesgo de sobreventa**: si alguien compra en tienda y casi al mismo tiempo en ML, hay una ventana de segundos donde el stock no se sincroniza. Mitígalo pausando publicaciones de piezas únicas si sabes que hay tráfico en tienda.

---

## 10. Marcas restringidas en México

**Nike, Adidas y Reebok** en México solo las pueden vender:
- Tiendas Oficiales de la marca.
- Vendedores acreditados por la marca.

Si publicas sin acreditación, Mercado Libre te rechaza con error `moderations.seller.not_authorized`. **Solución**: no publiques esas marcas en ML, o solicita acreditación directamente a la marca a través del Seller Center (proceso lento, no garantizado).

---

## 11. Costos y comisiones

**Por publicar**: cero. ML no cobra por publicación (a diferencia de otras plataformas).

**Por venta**:
- **Clásica**: 8% a 17% del precio de venta, según la categoría (revisa la de cada pieza en tu cuenta).
- **Premium**: 11% a 21.5% (incluye meses sin intereses para el comprador).

**Cargo fijo** en artículos baratos (< ~$299): es variable según peso y servicio de envío (después de abril 2026, antes había montos fijos como $25-$37). **Consulta en tu cuenta** > Configuración > "Conocer mis costos" para ver el desglose exacto.

**Impuestos**: Mercado Libre retiene ISR e IVA a vendedores en México según su régimen; confirma los porcentajes con tu contador.

**Ejemplo**: vendes un jeans por $900:
- Comisión (ejemplo con 15%; la real depende de la categoría): –$135
- Cargo de envío (estimado): –$30 a –$80 (depende del destino y peso)
- Tu ingreso neto: ~$700-$735 (sin ISR)

---

## 12. Problemas comunes

| Problema | Causa | Solución |
|----------|-------|----------|
| "Seller not authorized for this brand" | Marca restringida sin acreditación | No publicar en ML, o solicitar acreditación a la marca |
| Publicación rechazada por foto | Imagen < 500×500 px, con logo/texto, o fondo no blanco | Retomar foto con luz natural, fondo blanco, sin marcas |
| No puedo cambiar el `family_name` (nombre genérico de la pieza) | Ya hay ventas de ese grupo de prendas | Crear un nuevo grupo (`family_name` distinto) para prendas futuras |
| Pieza vendida en ML pero stock no bajó en tienda | Sincronización tardía (segundos) | Verificar en D1; si falla, avisar a desarrolladores |
| Me pide guía de tallas y no tengo | Categoría de moda sin guía | Ir a Seller Center > Guías de tallas; crear una por tipo/género |
| Token expiró / "unauthorized" | 3 horas sin usar, o cambió Client Secret | Ir a `/mercadolibre` y autorizar de nuevo (botón "Conectar") |

---

## 13. Qué aún no está confirmado

- **Fondo blanco obligatorio en fotos de portada de moda en MLM**: blogs lo afirman, pero la documentación oficial de ML no lo especifica.
- **Cobertura exacta de Mercado Envíos en San Luis Potosí**: confirma en tu cuenta > Preferencias de envío qué modalidades te ofrecen (Colecta, Places, Flex).
- **Montos exactos del cargo fijo en 2026**: cambiaron en abril de 2026; consulta tu cuenta, no uses tablas estáticas.
- **Retiro en persona + Mercado Envíos Mode 2**: no está claro si se permite simultáneamente en MLM.
- **Cómo listar tus guías de tallas existentes**: solo se puede consultar una guía por ID; no hay endpoint público para listarlas todas.
- **Si tu cuenta ya tiene el tag `user_product_seller` (modelo de publicación UP)**. Se activa gradualmente desde octubre 2024; si lo tienes, no puedes usar el modelo antiguo (`title` + variaciones). El dueño o desarrollador deben verificar en `GET /users/me` una vez autorizado.

---

## 14. Próximos pasos

1. **Validar en sandbox** (si aplica): publicar una pieza de prueba en sandbox.viste.com.mx antes de producción.
2. **Primera publicación en producción**: fotografiar 5-10 prendas, completar atributos, publicar, verificar que aparecen en Mercado Libre.
3. **Confirmar envío**: hacer una compra de prueba con un usuario de test (Mercado Libre te da credenciales) para validar el flujo de notificaciones y sincronización de stock.
4. **Monitorear**: revisar Seller Center cada semana; responder preguntas de compradores, revisar moderaciones.

---

**Fecha de esta guía**: 2026-10-04  
**Basada en**: Documentación oficial de Mercado Libre México (desarrolladores.mercadolibre.com.mx), consultada el 2026-10-04.
