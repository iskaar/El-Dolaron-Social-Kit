// Lo que public/venta.js le da al cobro en duda de caja.html (#933). Las pruebas que cortan fragmentos de caja.html y los corren en un contexto
// vm lo reciben de aquí con `...PUERTA`: así un nombre nuevo se agrega en un solo lugar.
import { cobroEnDuda, cobroSinCuerpo, botonDeCobro, codigosDeCuerpo, codigosDeVenta, cuerpoSinCodigos, fotoDeVenta, ventaRecuperada } from '../public/venta.js';

export const PUERTA = { cobroEnDuda, cobroSinCuerpo, botonDeCobro, codigosDeCuerpo, codigosDeVenta, cuerpoSinCodigos, fotoDeVenta, ventaRecuperada };
