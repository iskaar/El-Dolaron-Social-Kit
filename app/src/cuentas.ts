import { resolverCancelacion } from './cancelaciones.ts';
import { resolverDevolucion } from './devoluciones.ts';
import { resolverDescuento, limiteVigencia, AVISO_QUITADA } from './descuentos.ts';
import { avisarDueno } from './avisos.ts';

/**
 * Centro de cuentas (Issue #75). Cloudflare Access (con Google) dice QUIEN es
 * la persona; la tabla `usuarios` dice si entra y QUE puede hacer.
 *
 * Antes el Worker leia el correo del encabezado `cf-access-authenticated-user-email`
 * y le creia. Con roles de por medio eso no alcanza: aqui se verifica la firma
 * del JWT que Access le pega a cada peticion, contra las llaves publicas del
 * equipo de Zero Trust.
 */

// `computadora`: la cuenta de la tienda con la que entra la computadora de caja;
// sola no cobra, cada cajero entra con su PIN (Issue #112, cajeros.ts).
// `finanzas`: FEP. Toma fotos y ve solo sus piezas (propietario 'fep'); ver propietarioDe.
// `auxiliar`: lleva gastos y nomina (Issue #326); no ve reportes, cuentas ni lo demas del dueno.
// `revendedora`: externa (Issue #575). Solo /vender: aparta 48 h sin anticipo y ve lo suyo; nunca la caja.
// `supervisor`: lo asigna el dueño (#837) a cuentas que ya tienen otro rol (casi siempre cajero). Aprueba con su PIN, en la caja, devolver dinero y cancelar un ticket pasados 5 minutos; y si es quien cobra, lo hace directo.
//   Descuentos, cupones y cambios de precio siguen siendo solo del dueño. No abre pantallas por si solo.
// `inversionista`: socio capitalista (Issue #610). Solo ve /tablero y GET /api/tablero (agregados, sin personas). No es `socio`: esa palabra es el cliente Dolarones.
export type Rol = 'dueno' | 'cajero' | 'capturista' | 'computadora' | 'finanzas' | 'auxiliar' | 'revendedora' | 'inversionista' | 'supervisor';
export const ROLES: readonly Rol[] = ['dueno', 'cajero', 'capturista', 'computadora', 'finanzas', 'auxiliar', 'revendedora', 'inversionista', 'supervisor'];
/** Quien autoriza que salga dinero de vuelta al cliente (devolver dinero de una pieza, cancelar pasados 5 minutos): el dueño o un supervisor (#837). */
export const apruebaDinero = (roles: readonly Rol[]): boolean => roles.includes('dueno') || roles.includes('supervisor');
/** Lo que recibe alguien al aprobarle el acceso si no se escoge otra cosa. */
export const ROL_POR_OMISION: Rol = 'cajero';

export interface Usuario {
  correo: string;
  nombre: string;
  roles: Rol[];
  activo: boolean;
  caja: string;   // la caja del cajero (Issue #105); '' = la de la computadora
  tienda: string;   // clave de TIENDAS (#793); '' = sin tienda (cuenta como Soledad, salvo la computadora de caja: esa no cobra)
  editar_inventario: boolean;
}

interface FilaUsuario {
  correo: string;
  nombre: string;
  roles: string;
  activo: number;
  caja: string;
  tienda: string;
  editar_inventario: number;
}

/**
 * Las tiendas y sus cajas (#793). Constantes: tres tiendas no justifican una pantalla. El nombre de caja es la llave de
 * ventas, retiros, cortes y cajon, y es unico entre tiendas: por eso los cortes quedan separados sin tocar corte.ts.
 */
export const TIENDAS = {
  soledad: { nombre: 'Soledad', cajas: ['Caja 1', 'Caja 2', 'Caja 3'] },
  salk: { nombre: 'Avenida Salk', cajas: ['Salk 1', 'Salk 2'] },
  romero: { nombre: 'Coronel Romero', cajas: ['Romero 1', 'Romero 2'] },
} as const;
export type Tienda = keyof typeof TIENDAS;
/** Soledad es bodega central y tienda: la de lo que no dice otra cosa. */
export const TIENDA_CENTRAL: Tienda = 'soledad';
export const esTienda = (valor: unknown): valor is Tienda => typeof valor === 'string' && Object.hasOwn(TIENDAS, valor);
/** Las cajas de una tienda; [] si la clave no existe (no se cobra en una tienda desconocida). */
export const cajasDe = (tienda: string): readonly string[] => esTienda(tienda) ? TIENDAS[tienda].cajas : [];
/** La tienda a la que pertenece una caja (los nombres son únicos entre tiendas); Soledad si no es de ninguna (ventas viejas, caja vacía). */
export const tiendaDeCaja = (caja: unknown): Tienda =>
  (Object.keys(TIENDAS) as Tienda[]).find((t) => (TIENDAS[t].cajas as readonly string[]).includes(String(caja ?? ''))) ?? TIENDA_CENTRAL;
/** Todas las cajas que se pueden asignar, de cualquier tienda. */
export const CAJAS: string[] = Object.values(TIENDAS).flatMap((t) => [...t.cajas]);

/* ---------- permisos por ruta ---------- */

/**
 * 'libre': sin sesion (la sonda de salud). 'cuenta': cualquiera que ya paso
 * por Access, tenga cuenta o no (la pantalla para pedir acceso). Una lista:
 * esos roles. El dueno entra a todo, asi que nunca hace falta listarlo; una
 * lista vacia es "solo el dueno".
 *
 * Lo que no esta aqui es solo del dueno: una pantalla nueva nace cerrada.
 */
export type Regla = 'libre' | 'cuenta' | Rol[];

const CAPTURA: Rol[] = ['capturista'];
const CAPTURA_FEP: Rol[] = ['capturista', 'finanzas'];
const CAJA: Rol[] = ['cajero', 'computadora'];
// /vender y sus API: la caja y la revendedora. Va aparte de CAJA a proposito: esDeCaja compara por identidad
// y la computadora sigue necesitando el PIN aqui (si fuera [...CAJA, 'revendedora'] el PIN desapareceria).
const VENDER: Rol[] = [...CAJA, 'revendedora'];
// /retos (#752): lo propio de cada empleada. Como CAJA (la computadora entra con el PIN del cajero) mas capturista, que tambien figura como quien atendio.
const RETOS: Rol[] = [...CAJA, 'capturista'];
const TODOS: Rol[] = ['cajero', 'capturista'];
const DUENO: Rol[] = [];
const AUXILIAR: Rol[] = ['auxiliar'];
const INVERSIONISTA: Rol[] = ['inversionista'];

const PANTALLAS: Record<string, Rol[]> = {
  '/': TODOS,
  '/index': TODOS,
  '/captura': CAPTURA_FEP,
  '/camara-remota': CAPTURA,
  '/escanear': CAPTURA,
  '/admin': CAPTURA,
  '/marketplace': CAPTURA,
  '/etiquetas': CAPTURA_FEP,
  '/pieza': CAPTURA_FEP,
  '/inventario': CAPTURA_FEP,
  '/bandas': CAPTURA,
  '/calibrar-etiqueta': CAPTURA,
  '/prueba-codigo': CAPTURA,
  '/sonda-impresora': CAPTURA,
  '/caja': CAJA,
  '/socios': CAJA,
  '/pedidos': CAJA,
  '/bultos': [...CAPTURA, ...CAJA],   // #795: arman dueño y capturista; reciben dueño y cajero (la API distingue; la computadora pide PIN para recibir)
  '/vender': VENDER,
  '/manual': VENDER,   // manual interactivo de la revendedora (#594): practica con datos de ejemplo, sin API
  '/ayuda': RETOS,   // guía «¿Cómo se hace?» de la caja (#818): sin API, solo texto; RETOS = caja, computadora (sin PIN: la página no llama a /api) y capturista
  '/retos': RETOS,   // Mis retos (Issue #752)
  '/plano': RETOS,   // Plano del local (Issue #756): se lee en piso; asignar áreas lo cierra la API a gerencia
  '/avisos': CAJA,   // ventas de Mercado Libre por atender (Issue #429)
  '/tarjeta-bandas': TODOS,
  '/reportes': DUENO,
  '/tablero': INVERSIONISTA,   // #610: solo lectura, agregados
  '/mercadolibre': DUENO,
  '/cuentas': DUENO,
  '/conteo': TODOS,
  // Issue #287: mensajes de clientes por WhatsApp; datos personales, solo el dueño.
  '/mensajes': DUENO,
  '/gastos': AUXILIAR,
  '/nomina': AUXILIAR,
};

export function permiso(pathname: string, metodo: string): Regla {
  const ruta = pathname.replace(/\.html$/, '').replace(/(.)\/$/, '$1');

  if (ruta === '/api/salud') return 'libre';
  // Lo llama Mercado Libre, sin sesion: lo protege la ruta secreta (mercadolibre.ts).
  if (metodo === 'POST' && /^\/api\/ml\/notificaciones\/[^/]+$/.test(ruta)) return 'libre';
  if (ruta === '/sin-acceso' || ruta === '/api/yo') return 'cuenta';
  if (ruta === '/api/solicitudes/acceso' && metodo === 'POST') return 'cuenta';
  // Issue #281: cualquier cuenta que entro puede reportar un error de su pantalla, tambien la caja sin PIN.
  if (ruta === '/api/errores' && metodo === 'POST') return 'cuenta';
  if (ruta === '/marketplace-redes.png') return CAPTURA;
  if (ruta === '/vender.js') return VENDER;
  // Codigo de las pantallas, sin datos: el permiso se cobra en la pantalla y en la API.
  if (!ruta.startsWith('/api/') && /\.(js|css|png|svg|ico|webmanifest|woff2)$/.test(ruta)) return 'cuenta';

  if (ruta in PANTALLAS) return PANTALLAS[ruta];

  if ((ruta === '/api/camara/solicitud' && ['GET', 'PUT'].includes(metodo))
      || (metodo === 'POST' && /^\/api\/camara\/solicitud\/[^/]+\/(tomar|lista|cancelar)$/.test(ruta))) return CAPTURA;

  // Espejo de captura (#775): quien puede abrir Capturar en /inventario; el servidor lo ata a la cuenta propia.
  if (ruta === '/api/captura/espejo' && ['GET', 'PUT'].includes(metodo)) return CAPTURA_FEP;

  if (ruta === '/api/tablero') return metodo === 'GET' ? INVERSIONISTA : DUENO;
  if (ruta === '/api/mensajes' || ruta === '/api/mensajes/responder') return DUENO;
  if (ruta === '/api/gastos' || /^\/api\/gastos\/[^/]+(\/comprobante)?$/.test(ruta)) return AUXILIAR;
  if (ruta === '/api/nomina/entrada' || ruta === '/api/nomina/checador') return CAJA;
  if (ruta === '/api/nomina' || ruta.startsWith('/api/nomina/')) return AUXILIAR;
  if (ruta === '/api/config') return metodo === 'GET' ? CAPTURA_FEP : DUENO;
  // Ropa de El Dolarón: FEP (finanzas) no ve ni renombra piezas ajenas (Issue #318).
  if (ruta === '/api/ropa-ia' || ruta.startsWith('/api/ropa-ia/')) return CAPTURA;
  if (metodo === 'GET' && /^\/api\/recortes\/[^/]+\/imagen$/.test(ruta)) return [...CAPTURA, ...VENDER];
  if (ruta === '/api/recortes' || ruta.startsWith('/api/recortes/')) return CAPTURA;
  // Revisión de portadas con IA (#890): como los recortes, solo El Dolarón y sin vendedor (sus imágenes sin aprobar no salen del personal).
  if (ruta === '/api/portadas' || ruta.startsWith('/api/portadas/')) return CAPTURA;
  if (ruta === '/api/familias') return metodo === 'GET' ? [...TODOS, 'finanzas'] : ['finanzas'];   // #694: FEP tiene sus propias familias
  if (ruta === '/api/borradores/manual') return DUENO;   // captura sin foto (Issue #115)
  // Captura por UPC (Issue #365): el precio sale del manifiesto, no de quien captura.
  // Solo El Dolarón: FEP (finanzas) no tiene manifiesto.
  if (ruta === '/api/borradores/upc' || ruta.startsWith('/api/borradores/upc/') || ruta.startsWith('/api/manifiesto/')) return CAPTURA;
  // #413: buscar/confirmar imagen en /admin, sin acceso de FEP.
  if (/^\/api\/borradores\/[^/]+\/imagen(?:\/buscar)?$/.test(ruta)) return CAPTURA;
  if (ruta === '/api/borradores' || ruta.startsWith('/api/borradores/')) return CAPTURA_FEP;
  // La caja muestra la foto de cada pieza escaneada para detectar etiquetas cambiadas (Issue #358).
  if (ruta.startsWith('/api/foto/')) return metodo === 'GET' ? [...CAPTURA_FEP, ...VENDER] : [...CAPTURA_FEP, ...CAJA];
  // Etiquetas y su registro de enviadas (#440): lo usan la PC y el celular; el cajero no imprime.
  if (ruta === '/api/etiquetas' || ruta === '/api/etiquetas/enviadas' || ruta === '/api/etiquetas/pendientes' || ruta === '/api/etiquetas/deudas') return CAPTURA_FEP;
  // Leer la calibracion lo hacen tambien FEP y el celular; cambiarla, solo quien captura.
  if (ruta === '/api/calibracion') return metodo === 'GET' ? CAPTURA_FEP : CAPTURA;
  if (metodo === 'GET' && (ruta === '/api/piezas' || /^\/api\/piezas\/[^/]+$/.test(ruta))) return CAPTURA_FEP;
  if (metodo === 'POST' && /^\/api\/piezas\/[^/]+\/(existencia|juntar)$/.test(ruta)) return CAPTURA_FEP;
  // Pedir un cambio de precio (#451): capturista o dueño. Listar y resolver (/api/solicitudes-precio) son del dueño, por omisión.
  if (metodo === 'POST' && /^\/api\/piezas\/[^/]+\/solicitud-precio$/.test(ruta)) return CAPTURA;
  if (ruta === '/api/marketplace' || /^\/api\/marketplace\/foto\/[^/]+$/.test(ruta)) return CAPTURA;
  if (ruta === '/api/catalogo') return CAJA;
  if (ruta === '/api/existencia' && metodo === 'GET') return CAJA; // #884: en qué tienda sí hay la pieza que aquí no hay
  // Bultos (#795): recibir y ver lo que viene en camino lo hace la caja de la sucursal (la computadora con PIN); armar, cerrar y cancelar, dueño y capturista.
  if ((ruta === '/api/bultos/entrantes' && metodo === 'GET') || (ruta === '/api/bultos/recibir' && metodo === 'POST')) return CAJA;
  if (ruta === '/api/bultos' || ruta.startsWith('/api/bultos/')) return CAPTURA;
  if (ruta === '/api/vender' || ruta === '/api/interesados' || ruta.startsWith('/api/interesados/')) return VENDER;
  // Revendedora (#575): apartar 48 h sin anticipo, ver y cancelar lo suyo. vender.ts exige ademas que no sea personal de caja.
  // #609: ademas, mandar el pago (foto del comprobante y clave) de uno suyo; ver la foto despues es solo del dueño (/api/pagos-reportados/:id/comprobante, por omisión).
  if (ruta === '/api/vender/apartar' || ruta === '/api/vender/mios' || /^\/api\/vender\/apartados\/\d+\/(cancelar|pago|comprobante)$/.test(ruta)) return VENDER;
  if (ruta === '/api/socios') return CAJA;
  if (ruta === '/api/vales/config' && metodo === 'GET') return CAJA;
  if (ruta === '/api/vales/buscar' && metodo === 'POST') return CAJA;
  // Cupón de monto libre (Issue #330): la caja lo emite con el PIN de un dueño (vales.ts).
  if (ruta === '/api/cupones' && metodo === 'POST') return CAJA;
  if (ruta === '/api/socios/codigo' && metodo === 'POST') return CAJA;
  if (ruta === '/api/socios/legal' && metodo === 'GET') return CAJA;
  if (ruta === '/api/portal/llegada' && metodo === 'POST') return CAJA;
  if (ruta === '/api/cajon') return CAJA;
  if (ruta === '/api/cortes' || ruta === '/api/retiros') return CAJA;
  if (ruta === '/api/vendedoras') return CAJA;
  if (ruta === '/api/cajeros' || ruta === '/api/cajeros/entrar' || ruta === '/api/cajeros/salir') return CAJA;
  // Contar piezas de alto valor (Issue #219): cualquier cuenta de piso. Ajustar y ver el rastro es del dueno (default).
  if (ruta === '/api/conteo') return TODOS;
  if (ruta === '/api/descuentos' || ruta === '/api/descuentos/duenos' || (metodo === 'POST' && /^\/api\/descuentos\/[^/]+\/quitar$/.test(ruta))) return CAJA;   // pedir un descuento (Issue #119, descuentos.ts)
  // Cancelar una venta completa: el cajero solo en los primeros minutos; despues
  // pide aprobacion del dueno (Issue #200, cancelaciones.ts).
  if (ruta === '/api/solicitudes/cancelaciones' || ruta === '/api/solicitudes/descuentos') return DUENO;
  if (/^\/api\/solicitudes\/[^/]+$/.test(ruta) && metodo === 'GET') return CAJA;   // la caja ve como va la suya
  if (ruta === '/api/ventas' || ruta.startsWith('/api/ventas/')) return CAJA;
  if (ruta === '/api/pedidos' || ruta.startsWith('/api/pedidos/')) return CAJA;   // pedidos por WhatsApp (Issue #269, pedidos.ts)
  // Subir el comprobante de una transferencia para leerlo (#603): lo hace quien cobra. Verlo (/api/transferencias/:id/comprobante) es solo del dueño, por omisión.
  if (ruta === '/api/transferencias/comprobante' && metodo === 'POST') return CAJA;
  // Dar por buena a mano una transferencia que Banxico no confirmo (#603): solo el dueño, aunque el resto de avisos sea de caja.
  if (/^\/api\/avisos\/transferencias\/\d+\/validar$/.test(ruta)) return DUENO;
  if (ruta === '/api/avisos' || ruta.startsWith('/api/avisos/')) return CAJA;   // centro de avisos (Issue #429)
  if (ruta === '/api/plano') return metodo === 'GET' ? RETOS : DUENO;   // Issue #756
  if (ruta === '/api/retos/mios') return RETOS;   // solo lo propio de quien pregunta (Issue #752)
  if (ruta === '/api/ayuda') return CAJA;   // botón «Ayuda» (Issue #600)
  // #800: las cuentas de una tienda activan notificaciones para recibir los avisos de apartados; el resto de /api/push/* sigue siendo del dueño.
  if (ruta === '/api/push/clave' || ruta === '/api/push/suscripcion') return CAJA;
  if (ruta === '/api/impresiones' || ruta.startsWith('/api/impresiones/')) return CAJA;

  return DUENO;
}

/** Lo de caja: lo unico que abre el PIN del cajero. */
export const esDeCaja = (regla: Regla) => regla === CAJA || regla === VENDER || regla === RETOS;

/** La cuenta de la computadora de caja: para cobrar necesita el PIN de un cajero. */
export const soloComputadora = (usuario: Usuario | null) =>
  !!usuario?.roles.includes('computadora') && !usuario.roles.includes('cajero') && !usuario.roles.includes('dueno');

/**
 * La tienda de lo que se cobra (R1 de #793): la de la cuenta de Access que entra, la computadora de caja o la persona misma
 * (la computadora es la unica cuenta que se sustituye por el cajero del PIN, asi que el cajero nunca decide la tienda).
 * Sin tienda cuenta como Soledad, salvo la computadora de caja (R2): '' = no cobra. Nunca viene del navegador.
 */
export const tiendaDe = (cuenta: Usuario | null): string =>
  cuenta?.tienda || (soloComputadora(cuenta) ? '' : TIENDA_CENTRAL);

/**
 * Revendedora externa (#575): tiene el rol y ninguno de caja o dueno. Solo ella usa el apartado sin anticipo,
 * y a ella se le acota lo que ve de las demas. Quien ademas es cajero o dueno conserva el flujo de la tienda.
 */
export const esRevendedora = (usuario: Usuario | null) =>
  !!usuario?.activo && usuario.roles.includes('revendedora')
  && !usuario.roles.some((rol) => rol === 'dueno' || rol === 'cajero' || rol === 'computadora');

/** Inversionista (#610): su unica pantalla es /tablero; el menu de la tienda no es para el. */
export const esInversionista = (usuario: Usuario | null) => !!usuario?.activo && usuario.roles.includes('inversionista');

/**
 * De quien son las piezas que esta persona captura y ve (Issue #298). FEP solo
 * ve y captura lo suyo; el resto de la tienda, lo de El Dolaron. El corte y la
 * caja no cambian: el cobro es de la tienda, lo de FEP se le debe aparte.
 */
export const propietarioDe = (usuario: Usuario | null): 'dolaron' | 'fep' =>
  usuario?.roles.includes('finanzas') ? 'fep' : 'dolaron';

export function puede(usuario: Usuario | null, regla: Regla): boolean {
  if (regla === 'libre' || regla === 'cuenta') return true;
  if (!usuario?.activo) return false;
  return usuario.roles.includes('dueno') || regla.some((rol) => usuario.roles.includes(rol));
}

/** #441: el rol habilita la ruta; la casilla autoriza cada escritura de inventario. */
export const puedeEditarInventario = (usuario: Usuario | null): boolean => !!usuario?.activo && (
  usuario.roles.includes('dueno') || (usuario.editar_inventario === true
    && usuario.roles.some((rol) => rol === 'capturista' || rol === 'finanzas'))
);

/* ---------- quien es ---------- */

const decodificar = (b64url: string): Uint8Array => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};
const comoJson = (b64url: string): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(decodificar(b64url)));

/**
 * La carga de un JWT de Access, o null si no es valido: firma RS256 de una llave
 * del equipo, para ESTA aplicacion (aud), del equipo correcto (iss) y vigente.
 */
async function verificarCarga(
  token: string,
  aud: string,
  emisor: string,
  llave: (kid: string) => Promise<CryptoKey | undefined>,
  ahora: number,
): Promise<Record<string, unknown> | null> {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  let cabecera: Record<string, unknown>;
  let carga: Record<string, unknown>;
  try {
    cabecera = comoJson(partes[0]);
    carga = comoJson(partes[1]);
  } catch {
    return null;
  }
  if (cabecera.alg !== 'RS256' || typeof cabecera.kid !== 'string') return null;
  const clave = await llave(cabecera.kid);
  if (!clave) return null;
  const firmada = new TextEncoder().encode(`${partes[0]}.${partes[1]}`);
  let valida = false;
  try {
    valida = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', clave, decodificar(partes[2]), firmada);
  } catch {
    return null;
  }
  if (!valida) return null;

  const auds = Array.isArray(carga.aud) ? carga.aud : [carga.aud];
  if (!auds.includes(aud) || carga.iss !== emisor) return null;
  if (typeof carga.exp !== 'number' || carga.exp < ahora) return null;
  if (typeof carga.nbf === 'number' && carga.nbf > ahora + 60) return null;
  return carga;
}

/** El correo dentro de un JWT de Access de una persona, o null. Exportada para probarla con llaves generadas en la prueba. */
export async function verificarJwt(
  token: string,
  aud: string,
  emisor: string,
  llave: (kid: string) => Promise<CryptoKey | undefined>,
  ahora = Date.now() / 1000,
): Promise<string | null> {
  const carga = await verificarCarga(token, aud, emisor, llave, ahora);
  if (!carga || typeof carga.email !== 'string' || !carga.email) return null;
  return carga.email.toLowerCase();
}

/**
 * El Client ID (common_name) de un JWT de Access de un service token, o null. Un token de persona (con correo)
 * no es un servicio, y un service token nunca pasa por verificarJwt: no lleva correo, asi que no entra a ninguna pantalla.
 */
export async function verificarJwtServicio(
  token: string,
  aud: string,
  emisor: string,
  llave: (kid: string) => Promise<CryptoKey | undefined>,
  ahora = Date.now() / 1000,
): Promise<string | null> {
  const carga = await verificarCarga(token, aud, emisor, llave, ahora);
  if (!carga || (typeof carga.email === 'string' && carga.email)) return null;
  return typeof carga.common_name === 'string' && carga.common_name ? carga.common_name : null;
}

// Las llaves publicas de Access rotan de vez en cuando: se guardan una hora, y
// un kid desconocido las vuelve a pedir (como mucho cada 5 minutos, para que un
// token inventado no ponga a pedir llaves en cada peticion).
let llaves: { pedidas: number; porKid: Map<string, CryptoKey> } | null = null;

async function llaveDeAccess(equipo: string, kid: string): Promise<CryptoKey | undefined> {
  const edad = llaves ? Date.now() - llaves.pedidas : Infinity;
  if (edad > 3600_000 || (!llaves?.porKid.has(kid) && edad > 300_000)) {
    const respuesta = await fetch(`https://${equipo}/cdn-cgi/access/certs`);
    if (!respuesta.ok) return llaves?.porKid.get(kid);
    const { keys } = (await respuesta.json()) as { keys: (JsonWebKey & { kid: string })[] };
    const porKid = new Map<string, CryptoKey>();
    for (const jwk of keys) {
      porKid.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
      ));
    }
    llaves = { pedidas: Date.now(), porKid };
  }
  return llaves?.porKid.get(kid);
}

/**
 * El correo verificado de quien hace la peticion, o null.
 *
 * Con ACCESS_EQUIPO = "local" (solo `wrangler dev --var ACCESS_EQUIPO:local
 * --var DEV_USUARIO:<correo>`) se entra como DEV_USUARIO, sin Access. En
 * produccion ACCESS_EQUIPO es el equipo real de wrangler.jsonc; y si faltara,
 * nadie entra: cerrado por omision.
 */
export async function quienEs(request: Request, env: Env, hostname: string): Promise<string | null> {
  const equipo: string | undefined = env.ACCESS_EQUIPO;
  if (equipo === 'local') return env.DEV_USUARIO?.toLowerCase() || null;
  const aud = (env.ACCESS_AUD as Record<string, string> | undefined)?.[hostname];
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!equipo || !aud || !token) return null;
  return verificarJwt(token, aud, `https://${equipo}`, (kid) => llaveDeAccess(equipo, kid));
}

/**
 * El Client ID verificado del service token que hace la peticion, o null (misma verificacion que quienEs).
 * Solo lo usa /api/cep/* (cep.ts). Con ACCESS_EQUIPO = "local" entra DEV_SERVICIO, sin Access.
 */
export async function quienEsServicio(request: Request, env: Env, hostname: string): Promise<string | null> {
  const equipo: string | undefined = env.ACCESS_EQUIPO;
  if (equipo === 'local') return env.DEV_SERVICIO || null;
  const aud = (env.ACCESS_AUD as Record<string, string> | undefined)?.[hostname];
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!equipo || !aud || !token) return null;
  return verificarJwtServicio(token, aud, `https://${equipo}`, (kid) => llaveDeAccess(equipo, kid));
}

/* ---------- usuarios ---------- */

export const leerRoles = (texto: string): Rol[] =>
  texto.split(',').map((r) => r.trim()).filter((r): r is Rol => (ROLES as string[]).includes(r));

export async function leerUsuario(env: Env, correo: string): Promise<Usuario | null> {
  const fila = await env.DB.prepare('select correo, nombre, roles, activo, caja, tienda, editar_inventario from usuarios where correo = ?')
    .bind(correo)
    .first<FilaUsuario>();
  return fila
    ? { correo: fila.correo, nombre: fila.nombre, roles: leerRoles(fila.roles), activo: fila.activo === 1, caja: fila.caja,
      tienda: fila.tienda, editar_inventario: fila.editar_inventario === 1 }
    : null;
}

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Quien soy y que puedo hacer: para la pantalla de sin acceso y para esconder lo que no toca. */
export async function yo(env: Env, correo: string, cajero: Usuario | null = null, vendedor = false): Promise<Response> {
  const usuario = await leerUsuario(env, correo);
  const solicitud = await env.DB.prepare(
    `select estado, creado_en from solicitudes where tipo = 'acceso' and correo = ?
     order by creado_en desc limit 1`,
  )
    .bind(correo)
    .first<{ estado: string; creado_en: string }>();
  const modos = usuario?.activo && (usuario.roles.includes('dueno') || usuario.roles.includes('capturista'))
    ? ['capturar', 'buscar', 'revisar', 'imprimir']
    : usuario?.activo && usuario.roles.includes('finanzas') ? ['capturar', 'buscar', ...(puedeEditarInventario(usuario) ? ['revisar'] : []), 'imprimir'] : [];
  // Tienda y cajas de esta terminal (#793); la caja asignada al cajero solo vale si es de esta tienda.
  const tienda = tiendaDe(usuario);
  const cajas = cajasDe(tienda);
  return json({ correo, usuario, solicitud, vendedor, revendedora: esRevendedora(usuario), modos_inventario: modos,
    tienda, tienda_nombre: esTienda(tienda) ? TIENDAS[tienda].nombre : '', cajas,
    // #800: dónde puede recoger un cliente; #863: sus cajas, para el fondo de cada una en /reportes.
    tiendas: (Object.keys(TIENDAS) as Tienda[]).map((clave) => ({ clave, nombre: TIENDAS[clave].nombre, cajas: [...TIENDAS[clave].cajas] })),
    // es_dueno: el dueño con su PIN en la computadora de la caja no tiene el tope de 10 % de un cajero (#845); el servidor lo decide igual.
    cajero: cajero && { correo: cajero.correo, nombre: cajero.nombre, caja: cajas.includes(cajero.caja) ? cajero.caja : '', es_dueno: cajero.roles.includes('dueno') } });
}

/** Alguien sin cuenta pide entrar. Una sola pendiente por persona: pedir otra vez la actualiza. */
export async function pedirAcceso(request: Request, env: Env, correo: string, ctx?: ExecutionContext): Promise<Response> {
  const usuario = await leerUsuario(env, correo);
  if (usuario?.activo) return json({ error: 'Ya tienes cuenta.' }, 409);
  const cuerpo = (await request.json().then((c) => c ?? {}, () => ({}))) as { nombre?: unknown; justificacion?: unknown };
  const nombre = texto(cuerpo.nombre, 80);
  const justificacion = texto(cuerpo.justificacion, 500);
  if (!nombre || !justificacion) {
    return json({ error: 'Escribe tu nombre y para que necesitas entrar.' }, 400);
  }
  const ahora = new Date().toISOString();
  const pendiente = await env.DB.prepare(
    `select id from solicitudes where tipo = 'acceso' and correo = ? and estado = 'pendiente'`,
  )
    .bind(correo)
    .first<{ id: string }>();
  if (pendiente) {
    await env.DB.prepare('update solicitudes set nombre = ?, justificacion = ?, creado_en = ? where id = ?')
      .bind(nombre, justificacion, ahora, pendiente.id)
      .run();
    return json({ id: pendiente.id, estado: 'pendiente' });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into solicitudes (id, tipo, correo, nombre, justificacion, creado_en) values (?, 'acceso', ?, ?, ?, ?)`,
  )
    .bind(id, correo, nombre, justificacion, ahora)
    .run();
  avisarDueno(env, ctx, request, `Solicitud de acceso: ${nombre}`, `${nombre} (${correo}) pide entrar.\nPara qué: ${justificacion}`);
  return json({ id, estado: 'pendiente' }, 201);
}

/** Para /cuentas: todos los usuarios y lo que esta esperando respuesta. */
export async function listarCuentas(env: Env): Promise<Response> {
  const { results: filas } = await env.DB.prepare(
    `select correo, nombre, roles, activo, caja, tienda, editar_inventario, pin_hash != '' as tiene_pin, creado_en from usuarios
     order by activo desc, nombre`,
  ).all<FilaUsuario & { creado_en: string; tiene_pin: number }>();
  const { results: solicitudes } = await env.DB.prepare(
    `select id, tipo, correo, nombre, justificacion, datos, creado_en from solicitudes
     where estado = 'pendiente' and not (tipo = 'descuento' and creado_en < ?) order by creado_en`,   // un descuento pendiente vence a los 30 minutos (#845)
  ).bind(limiteVigencia()).all();
  const usuarios = filas.map((f) => ({ ...f, roles: leerRoles(f.roles), activo: f.activo === 1,
    editar_inventario: f.editar_inventario === 1, tiene_pin: f.tiene_pin === 1 }));
  const tiendas = Object.entries(TIENDAS).map(([clave, { nombre, cajas }]) => ({ clave, nombre, cajas }));
  return json({ usuarios, solicitudes, roles: ROLES, cajas: CAJAS, tiendas });
}

/**
 * Nunca se queda la tienda sin dueno activo: quitarse el rol o desactivarse a
 * uno mismo siendo el ultimo dejaria a todos sin poder aprobar a nadie. Lo
 * cuida el trigger `siempre_un_dueno` (migracion 031) dentro de la escritura,
 * asi dos cambios a la vez no pasan los dos (Issue #253); aqui solo se traduce.
 */
function sinDueno(error: unknown): Response {
  if (String(error).includes('sin_dueno')) return json({ error: 'Tiene que quedar al menos una cuenta de gerencia activa.' }, 400);
  throw error;
}

function validarRoles(crudo: unknown): Rol[] | null {
  if (!Array.isArray(crudo)) return null;
  const roles = [...new Set(crudo.map(String))];
  if (roles.length === 0 || !roles.every((r) => (ROLES as string[]).includes(r))) return null;
  return roles as Rol[];
}

/** Alta o cambio de una cuenta desde /cuentas. */
export async function guardarCuenta(request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().then((c) => c ?? {}, () => ({}))) as Record<string, unknown>;
  const correo = texto(cuerpo.correo, 200).toLowerCase();
  const nombre = texto(cuerpo.nombre, 80);
  const roles = validarRoles(cuerpo.roles);
  const activo = cuerpo.activo !== false;
  // Sin `caja` en el cuerpo (el alta, o una version vieja de /cuentas) no se toca la que tenga.
  const caja = cuerpo.caja === undefined ? null : String(cuerpo.caja);
  // Igual con `tienda` (#793): '' = sin tienda.
  const tienda = cuerpo.tienda === undefined ? null : String(cuerpo.tienda);
  if (cuerpo.editar_inventario !== undefined && typeof cuerpo.editar_inventario !== 'boolean')
    return json({ error: 'Permiso de inventario inválido.' }, 400);
  const editar = cuerpo.editar_inventario === undefined ? null : cuerpo.editar_inventario ? 1 : 0;
  if (caja !== null && caja !== '' && !CAJAS.includes(caja)) return json({ error: 'Caja invalida.' }, 400);
  if (tienda !== null && tienda !== '' && !esTienda(tienda)) return json({ error: 'Tienda invalida.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ error: 'Correo invalido.' }, 400);
  if (!roles) return json({ error: 'Escoge al menos un rol.' }, 400);
  // Lo que quedaria guardado: R2 (la computadora de caja necesita tienda) y la caja del cajero debe ser de su tienda.
  const previa = await leerUsuario(env, correo);
  const queda = { roles, tienda: tienda ?? previa?.tienda ?? '' } as Usuario;
  const cajaQueda = caja ?? previa?.caja ?? '';
  if (activo && !tiendaDe(queda)) return json({ error: 'La computadora de caja necesita su tienda.' }, 400);
  if (cajaQueda && !cajasDe(tiendaDe(queda)).includes(cajaQueda)) return json({ error: 'Esa caja no es de la tienda de la cuenta.' }, 400);
  const ahora = new Date().toISOString();
  // Sin cuenta activa o sin rol de caja, su sesion de PIN muere con el cambio: reactivarla despues no la revive.
  const cobra = activo && (roles.includes('cajero') || roles.includes('dueno'));
  // #850: cambiarle la tienda a una cuenta cierra sus sesiones de PIN (su token dejaria de valer en la caja de antes de todos modos).
  const cambioTienda = !!previa && tiendaDe(previa) !== tiendaDe(queda);
  const fallo = await env.DB.batch([
    env.DB.prepare(
      `insert into usuarios (correo, nombre, roles, activo, caja, tienda, editar_inventario, creado_en, actualizado_en)
       values (?, ?, ?, ?, coalesce(?, ''), coalesce(?, ''), coalesce(?, 0), ?, ?)
       on conflict (correo) do update set nombre = excluded.nombre, roles = excluded.roles,
         activo = excluded.activo, caja = coalesce(?, usuarios.caja), tienda = coalesce(?, usuarios.tienda),
         editar_inventario = coalesce(?, usuarios.editar_inventario), actualizado_en = excluded.actualizado_en`,
    ).bind(correo, nombre, roles.join(','), activo ? 1 : 0, caja, tienda, editar, ahora, ahora, caja, tienda, editar),
    ...(cobra && !cambioTienda ? [] : [env.DB.prepare('delete from sesiones_cajero where correo = ?').bind(correo)]),
  ]).then(() => null, sinDueno);
  if (fallo) return fallo;
  const guardado = await leerUsuario(env, correo);
  return json({ correo, nombre, roles, activo, caja: guardado?.caja ?? '', tienda: guardado?.tienda ?? '', editar_inventario: guardado?.editar_inventario ?? false });
}

/** Aprobar o rechazar una solicitud: de acceso (Issue #75), de cancelacion (Issue #200), de devolucion de dinero (#837) o de descuento (Issue #119). */
export async function resolverSolicitud(id: string, request: Request, env: Env, dueno: string): Promise<Response> {
  const cuerpo = (await request.json().then((c) => c ?? {}, () => ({}))) as { aprobar?: unknown; roles?: unknown };
  const solicitud = await env.DB.prepare(
    `select id, tipo, correo, nombre, estado, resuelto_por from solicitudes where id = ?`,
  )
    .bind(id)
    .first<{ id: string; tipo: string; correo: string; nombre: string; estado: string; resuelto_por: string | null }>();
  if (!solicitud) return json({ error: 'La solicitud no existe.' }, 404);
  if (solicitud.tipo === 'descuento' && solicitud.resuelto_por === 'quitada') return json({ error: AVISO_QUITADA }, 409);
  if (solicitud.estado !== 'pendiente') return json({ error: `Ya estaba ${solicitud.estado}.` }, 409);
  if (solicitud.tipo === 'cancelacion') return resolverCancelacion(env, id, cuerpo.aprobar === true, dueno);
  if (solicitud.tipo === 'devolucion') return resolverDevolucion(env, id, cuerpo.aprobar === true, dueno);
  if (solicitud.tipo === 'descuento') return resolverDescuento(env, id, cuerpo.aprobar === true, dueno);
  if (solicitud.tipo !== 'acceso') return json({ error: 'Tipo de solicitud desconocido.' }, 400);

  const aprobar = cuerpo.aprobar === true;
  const ahora = new Date().toISOString();
  const marcar = env.DB.prepare(
    `update solicitudes set estado = ?, resuelto_en = ?, resuelto_por = ? where id = ? and estado = 'pendiente'`,
  ).bind(aprobar ? 'aprobada' : 'rechazada', ahora, dueno, id);

  if (!aprobar) {
    await marcar.run();
    return json({ id, estado: 'rechazada' });
  }
  const roles = cuerpo.roles === undefined ? [ROL_POR_OMISION] : validarRoles(cuerpo.roles);
  if (!roles) return json({ error: 'Escoge al menos un rol.' }, 400);
  // La cuenta pudo darse de alta por otra via despues de la solicitud: aprobar la reemplazaria.
  const fallo = await env.DB.batch([
    marcar,
    env.DB.prepare(
      `insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, ?, ?, 1, ?, ?)
       on conflict (correo) do update set roles = excluded.roles, activo = 1, actualizado_en = excluded.actualizado_en`,
    ).bind(solicitud.correo, solicitud.nombre, roles.join(','), ahora, ahora),
  ]).then(() => null, sinDueno);
  if (fallo) return fallo;
  return json({ id, estado: 'aprobada', correo: solicitud.correo, roles });
}
