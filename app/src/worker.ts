/**
 * Escaner de El Dolaron.
 * Paso 1: esqueleto (salud, config). Paso 2: captura desde el telefono.
 * El analisis, la cola del admin y las etiquetas llegan en los pasos siguientes
 * (docs/ARQUITECTURA-ESCANER.md).
 */

import { analizarBorrador, identificarUpc, pesosDeLista, modeloPorDefecto, type Modelo } from './analisis.ts';
import { fichaDeManifiesto, normalizarUpc, precioListaMxn, type FichaManifiesto } from './manifiesto.ts';
import { decodificarNombre } from './nombre.ts';
import { codigoLeido, SIN_CODIGO } from '../public/upc.js';
import { ESTADOS } from '../public/estados.js';
import { guardarImagenComoFoto, imagenGuardada, procesarRellenoImagenes, rutaImagenUpc, rutaImagenPieza } from './imagenes-upc.ts';
import { PRENDAS_ROPA, PRECIOS_ROPA } from '../public/ropa.js';
import { procesarColaRopa, rutaRopaAdmin } from './ropa-ia.ts';
import { calcularPrecio, ajustarManual, esDestinoBanda, prefijoParaFamilia, MONTOS_BANDA, type Destino } from './precio.ts';
import { efectivoAlcanza, promoInauguracion } from '../public/venta.js';

/** Ventana de la promo de inauguracion; null si no esta configurada. */
const promoDe = (env: Env) =>
  env.PROMO_DESDE && env.PROMO_HASTA && Date.parse(env.PROMO_DESDE) < Date.parse(env.PROMO_HASTA)
    ? { desde: env.PROMO_DESDE, hasta: env.PROMO_HASTA } : null;
/**
 * Cuantas promos quedan del cupo (Issue #250, «a las primeras 100 personas»); null sin PROMO_CUPO = sin tope.
 * Un ticket cancelado devuelve su lugar.
 */
async function promoRestantes(env: Env): Promise<number | null> {
  const cupo = Number(env.PROMO_CUPO);
  if (!env.PROMO_CUPO || !Number.isInteger(cupo) || cupo < 0) return null;
  // ponytail: recorre ventas sin indice; un indice parcial en (promo) si la tabla crece a cientos de miles.
  const fila = await env.DB.prepare('select count(*) as n from ventas where promo > 0 and cancelada = 0').first<{ n:number }>();
  return Math.max(0, cupo - (fila?.n ?? 0));
}
import { semanaIngreso } from '../public/semana.js';
import { tramoDeDias, TRAMOS_ANTIGUEDAD } from '../public/graficas.js';
import { detalleVenta, cancelarPieza, devolverEnCupon, reimprimirCupon } from './devoluciones.ts';
import { cancelarVenta, listarCancelaciones, estadoSolicitud } from './cancelaciones.ts';
import { BASES, AVISO } from './legal.ts';
import { CLAVES_CATEGORIA } from '../public/categorias.js';
import { tallaValida } from '../public/tallas.js';
import {
  permiso, puede, quienEs, leerUsuario, yo, pedirAcceso, listarCuentas, guardarCuenta, resolverSolicitud, propietarioDe,
  esDeCaja, soloComputadora, CAJAS, puedeEditarInventario,
} from './cuentas.ts';
import { cajeroEnTurno, listarCajeros, entrar, salir, ponerPin } from './cajeros.ts';
import { registrarSocio, buscarSocio, buscarPorCodigo, basesListas, sentenciasDeVenta, saldo } from './dolarones.ts';
import { registrarCorte, registrarRetiro, ultimoCorte, cajaDe } from './corte.ts';
import { rutaGastos } from './gastos.ts';
import { rutaPiezas } from './piezas.ts';
import { rutaSolicitudesPrecio } from './solicitudes-precio.ts';
import { MISMO_UPC, PIEZA_UPC, CAPTURA_SUMADA, conflictoCapturaSumada, capturaSumada, sumarCaptura, conflictoUpc, corregirUpc, upcValido, type PiezaUpc } from './upc-inventario.ts';
import { rutaCamaraRemota } from './camara-remota.ts';
import { rutaNomina } from './nomina.ts';
import { lineasNetas } from './netas.ts';
import { portal, llegada, vincular } from './portal.ts';
import { mensajesApi, responderApi } from './mensajes.ts';
import { rutaAsistente } from './asistente.ts';
import { sentenciasVale, buscarVale, valeDeVenta, valeUsadoEnVenta, reimprimirVale, valesAbiertos, emitirCuponManual, porcentajeCupon } from './vales.ts';
import { catalogoPublico, revisionCatalogo } from './catalogo.ts';
import { procesarRecortes, revisarRecortes, ajustarRecortesViejos, reiniciarRecorte, rutaRecortesAdmin } from './recortes.ts';
import { rutaML, recibirNotificacion, conciliarSeguro, sincronizar, publicacionViva } from './mercadolibre.ts';
import { pedirDescuento, validarDescuento, listarDescuentos, listarDuenos } from './descuentos.ts';
import { listarAltoValor, revisarConteo, ajustarExistencia, listarAjustes } from './conteo.ts';
import { rutaPedidos, vencerPedidos, sentenciasDePedido, saldoDe, enPedido } from './pedidos.ts';

interface FilaConfig {
  clave: string;
  valor: string;
}

interface FilaBorrador {
  id: string;
  codigo: string | null;
  nombre: string;
  categoria: string;
  marca: string;
  talla: string | null;
  precio_lista: number;
  precio: number;
  estado_fisico: string;
  estado_analisis: string;
  destino: string;
  stock: number;
  semana_ingreso: string;
  creado_en: string;
  upc?: string | null;
  foto_key: string;
  propietario: string;
}

/**
 * El host del capturista ofrece Capturar, Buscar y Revisar (#446, Isaac 22/10).
 * Access autentica; rol, propietario y casilla siguen autorizando cada operación.
 * Ajustes, configuración y la lista general de impresión no se abren aquí.
 */
const RUTAS_VENDEDOR = new Set(['/captura', '/foto.js', '/tallas.js', '/api/salud', '/sin-acceso', '/api/yo',
  // Escanear del manifiesto (Issue #365): el telefono ve nombre y precio de lo que escanea, nada mas.
  '/escanear', '/categorias.js', '/upc.js', '/cola-fotos.js', '/estados.js',
  '/inventario-celular.js', '/foto-pendiente.js', '/camara-inventario.js',
  '/inventario-revisar.js', '/inventario-precio.js', '/sesiones.js', '/precios-ml.js', '/compartir.js',
  '/inventario-capturar.js', '/inventario-ropa.js', '/envio-etiquetas.js', '/semana.js',
  '/inventario', '/inventario.css', '/inventario.js', '/inventario-ui.js', '/lector.js', '/ficha.js',
  '/venta.js', '/etiquetera.js', '/impresora.js', '/camara.js', '/vendor/html5-qrcode.min.js', '/ropa.js']);
const CORRECCION_CAPTURA = /^\/api\/borradores\/([^/]+)\/(existencia|talla|revision)$/;

export function permitidaParaVendedor(pathname: string, metodo: string): boolean {
  if (/^\/(inventario|pieza)(?:\.html)?\/?$/.test(pathname)) return metodo === 'GET';
  if (pathname === '/api/piezas' || /^\/api\/piezas\/[^/]+$/.test(pathname) || /^\/api\/foto\/[^/]+$/.test(pathname)) return metodo === 'GET';
  if (/^\/api\/piezas\/[^/]+\/(existencia|juntar|solicitud-precio)$/.test(pathname)) return metodo === 'POST';
  // Precios por revisar (#451): el servidor exige el rol de dueño para listar y resolver.
  if (pathname === '/api/solicitudes-precio') return metodo === 'GET';
  if (/^\/api\/solicitudes-precio\/[^/]+$/.test(pathname)) return metodo === 'POST';
  if (pathname === '/api/borradores' && metodo === 'GET') return true;
  if (pathname === '/api/familias' || pathname === '/api/recortes') return metodo === 'GET';
  if (/^\/api\/recortes\/[^/]+\/imagen$/.test(pathname)) return metodo === 'GET';
  if (/^\/api\/recortes\/[^/]+\/(aprobar|original|reintentar)$/.test(pathname)) return metodo === 'POST';
  if (/^\/api\/borradores\/[0-9a-f-]{36}$/.test(pathname)) return ['PATCH', 'DELETE'].includes(metodo);
  if (/^\/api\/borradores\/[^/]+\/(fusionar|analizar|imagen\/buscar)$/.test(pathname)) return metodo === 'POST';
  if (/^\/api\/borradores\/[^/]+\/imagen$/.test(pathname)) return metodo === 'PUT';
  if (pathname === '/camara-remota' || pathname === '/camara-remota.js') return metodo === 'GET';
  if (pathname === '/api/camara/solicitud') return metodo === 'GET';
  if (/^\/api\/camara\/solicitud\/[^/]+\/(tomar|lista|cancelar)$/.test(pathname)) return metodo === 'POST';
  if (RUTAS_VENDEDOR.has(pathname)) {
    return metodo === 'GET';
  }
  // Corregir cuantas piezas son o la talla, desde el carrusel de la camara. El
  // handler limita a lo que esa persona capturo en las ultimas 24 h.
  if (CORRECCION_CAPTURA.test(pathname)) {
    return metodo === 'PATCH' || (pathname.endsWith('/revision') && ['GET', 'DELETE'].includes(metodo));
  }
  // Quien entra por la camara sin cuenta tambien tiene que poder pedirla.
  if (pathname === '/api/solicitudes/acceso') {
    return metodo === 'POST';
  }
  if (/^\/api\/manifiesto\/[^/]+$/.test(pathname)) {
    return metodo === 'GET';
  }
  if (/^\/api\/manifiesto\/[^/]+\/imagen$/.test(pathname)) return ['GET', 'POST', 'PUT'].includes(metodo);
  if (/^\/api\/manifiesto\/[^/]+\/imagen\/catalogo$/.test(pathname)) return metodo === 'GET';
  // UPC desconocido (#373): buscarlo y ver cómo va.
  if (pathname === '/api/borradores/upc/manual') return ['POST', 'PATCH'].includes(metodo);
  if (/^\/api\/borradores\/upc\/[^/]+$/.test(pathname)) return pathname.endsWith('/buscar') ? metodo === 'POST' : metodo === 'GET';
  return (pathname === '/api/borradores' || pathname === '/api/borradores/upc') && metodo === 'POST';
}

const FRANJA_SANDBOX = `<div style="background:#D72B32;color:#fff;text-align:center;font:700 14px system-ui,sans-serif;padding:6px">
  SANDBOX · solo pruebas: aquí no se cobra de verdad ni se registran socios reales</div>`;

const ESTADOS_FISICOS = new Set(ESTADOS.map(([estado]) => estado));
// Transferencia: confirmada por Isaac como forma de pago; sin ella se capturaba
// como efectivo o tarjeta y descuadraba el corte (Issue #93).
const FORMAS_PAGO = new Set(['efectivo', 'tarjeta', 'transferencia']);
const estacionValida = (valor: unknown): valor is string =>
  typeof valor === 'string' && CAJAS.includes(valor);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOTO_MAX_BYTES = 6 * 1024 * 1024;
const textoCapturaRopa = (valor: unknown) => typeof valor === 'string' && valor.trim().length <= 40 && !/[\r\n]/.test(valor);
const nombreRopa = (prenda: string, marca: string) => [prenda || 'Ropa', marca].filter(Boolean).join(' ');
const prendaDeNombre = (nombre: string, marca: string) => {
  const base = marca && nombre.endsWith(` ${marca}`) ? nombre.slice(0, -(marca.length + 1)) : nombre;
  return base === 'Ropa' ? '' : base;
};
const capturaRopaDisponible = (env: Env) => !env.AMBIENTE || env.AMBIENTE === 'produccion' || env.AMBIENTE === 'sandbox';

function json(cuerpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function leerConfig(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('select clave, valor from config').all<FilaConfig>();
  return Object.fromEntries(results.map((fila) => [fila.clave, fila.valor]));
}

/** ?buscar=1 fuerza la busqueda web en una pieza; ?buscar=0 la apaga. */
function busquedaPedida(url: URL): boolean | undefined {
  const pedido = url.searchParams.get('buscar');
  return pedido === null ? undefined : pedido === '1';
}

function modeloPedido(url: URL, env: Env): Modelo {
  const pedido = url.searchParams.get('modelo');
  if (pedido === 'gemini' || pedido === 'claude') {
    return pedido;
  }
  return modeloPorDefecto(env);
}

/**
 * Guarda la foto y el borrador. Idempotente por id: el telefono genera el id
 * antes de subir, asi que un reintento tras una red caida no duplica la pieza.
 */
async function crearBorrador(request: Request, env: Env, ctx: ExecutionContext, url: URL, correo: string): Promise<Response> {
  const formulario = await request.formData();
  const id = String(formulario.get('id') ?? '');
  const estadoFisico = String(formulario.get('estado_fisico') ?? 'nuevo');
  // Muchas piezas vienen repetidas: una foto puede representar varias.
  const cantidad = Math.min(999, Math.max(1, Math.round(Number(formulario.get('cantidad') ?? 1)) || 1));
  const foto = formulario.get('foto');
  const upcCrudo = formulario.get('upc');
  const upc = !formulario.has('upc') ? null : upcCrudo === SIN_CODIGO ? SIN_CODIGO : codigoLeido(upcCrudo);
  if (formulario.has('upc') && upcCrudo !== SIN_CODIGO && !normalizarUpc(upc)) return json({ error: 'Código de barras inválido.' }, 400);
  const talla = String(formulario.get('talla') ?? '').trim() || null;
  const precioRopa = formulario.has('precio_ropa') ? Number(formulario.get('precio_ropa')) : null;
  const prendaRaw = formulario.get('prenda') ?? '';
  const marcaRaw = formulario.get('marca') ?? '';
  const prenda = typeof prendaRaw === 'string' ? prendaRaw.trim() : '\n';
  const marca = typeof marcaRaw === 'string' ? marcaRaw.trim() : '\n';

  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
  }
  if (talla !== null && !tallaValida(talla)) {
    return json({ error: 'Talla invalida.' }, 400);
  }
  if (precioRopa !== null && (!capturaRopaDisponible(env) || !PRECIOS_ROPA.includes(precioRopa))) {
    return json({ error: 'Precio de ropa invalido.' }, 400);
  }
  if (!textoCapturaRopa(prendaRaw) || (prenda && !PRENDAS_ROPA.includes(prenda)) || !textoCapturaRopa(marcaRaw)) {
    return json({ error: 'Prenda o marca invalida.' }, 400);
  }
  if (!(foto instanceof File) || foto.size === 0) {
    return json({ error: 'Falta la foto.' }, 400);
  }
  if (foto.size > FOTO_MAX_BYTES) {
    return json({ error: 'La foto pesa demasiado.' }, 413);
  }

  const propietario = propietarioDe(await leerUsuario(env, correo));
  const existente = await env.DB.prepare('select id, nombre, precio, estado_fisico, estado_analisis, stock, talla, propietario from productos where id = ?')
    .bind(id).first<{ estado_analisis: string; propietario: string }>();
  if (existente && existente.propietario !== propietario) return json({ error: 'Pieza no encontrada.' }, 404);
  if (existente?.estado_analisis === 'descartado' || (precioRopa !== null && existente && formulario.get('solo_foto') !== '1')) {
    return json(existente, 201);
  }

  if (upc && !existente) {
    const sumada = await sumarUpc(id, upc, estadoFisico, cantidad, env, correo, undefined, propietario);
    if (sumada) return sumada;
  }

  const fotoKey = `fotos/${id}.jpg`;
  await env.FOTOS.put(fotoKey, foto.stream(), {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  // Foto de respaldo del escáner: conserva identidad y precio conocidos, sin otro análisis.
  if (upc && propietario === 'dolaron' && (
    await env.DB.prepare('select upc from manifiesto where upc = ?').bind(normalizarUpc(upc)).first()
    || await env.DB.prepare(`select id from productos where ltrim(upc, '0') = ? and propietario = 'dolaron'
      and foto_key <> '' and estado_analisis = 'listo' and precio > 0 limit 1`).bind(normalizarUpc(upc)).first()
  )) {
    const respuesta = await capturarPorUpc(new Request('https://local/api/borradores/upc', {
      method: 'POST', body: JSON.stringify({ id, upc, stock: cantidad, estado_fisico: estadoFisico }),
    }), env, correo);
    if (respuesta.ok) {
      const guardada = await respuesta.clone().json() as { id: string; existente?: boolean };
      if (!guardada.existente) await env.DB.prepare('update productos set foto_key = ? where id = ?').bind(fotoKey, guardada.id).run();
    }
    return respuesta;
  }

  // "Retomar foto" del admin: solo cambia la imagen. Existencia, talla, estado y
  // lo que el dueno ya corrigio se quedan; para volver a analizar esta "Reintentar
  // analisis". La camara no manda esta marca: su reenvio si actualiza todo.
  if (formulario.get('solo_foto') === '1') {
    const { meta } = await env.DB.prepare("update productos set foto_key = ?, actualizado_en = ?, recorte_estado=case when recorte_estado='original' then 'original' else null end, recorte_fecha=null, recorte_revision=null where id = ?")
      .bind(fotoKey, new Date().toISOString(), id)
      .run();
    if (meta.changes) await reiniciarRecorte(env, id);
    if (meta.changes > 0) return json({ id });
  }

  // El correo verificado de quien sube la foto (ver cuentas.ts): de el salen
  // las sesiones de captura y la correccion de existencia desde el carrusel.
  const capturadoPor = correo;

  const ahora = new Date();
  if (precioRopa !== null) {
    // El reenvío de una foto conserva el precio revisado, el código y el stock ya vendido.
    await env.DB.prepare(
      `insert into productos (id, nombre, marca, categoria, precio, estado_analisis, destino, semana_ingreso,
                              estado_fisico, stock, talla, foto_key, capturado_por, creado_en, actualizado_en, propietario)
       values (?, ?, ?, 'ropa', ?, 'listo', 'etiqueta', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do nothing`,
    ).bind(id, nombreRopa(prenda, marca), marca, precioRopa, semanaIngreso(ahora), estadoFisico, cantidad, talla, fotoKey,
      capturadoPor, ahora.toISOString(), ahora.toISOString(), propietario).run();
    const guardada = await env.DB.prepare('select id, nombre, marca, precio, estado_fisico, estado_analisis, stock, talla, codigo from productos where id = ?')
      .bind(id).first<{ estado_analisis: string; nombre: string; marca: string; codigo: string | null }>();
    if (guardada?.estado_analisis === 'descartado' && !guardada.codigo) await env.FOTOS.delete(fotoKey);
    return json(guardada ? { ...guardada, prenda: prendaDeNombre(guardada.nombre, guardada.marca) } : guardada, 201);
  }
  const fotoGuardada = await env.DB.prepare(
    `insert into productos (id, semana_ingreso, estado_fisico, stock, talla, foto_key, capturado_por, creado_en, actualizado_en, propietario, upc)
     select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     where (? = '' or not exists (select 1 from productos where ${MISMO_UPC} and id <> ?))
       and not exists (select 1 from conteo_ajustes where id = ?)
     -- El stock no se toca: el reenvio de una foto no repone lo que la caja ya vendio (#312).
     on conflict (id) do update set
       estado_fisico = excluded.estado_fisico,
       talla = excluded.talla,
       foto_key = excluded.foto_key,
       recorte_estado = case when productos.recorte_estado='original' then 'original' else null end,
       recorte_revision = null,
       recorte_fecha = null,
       estado_analisis = 'pendiente',
       actualizado_en = excluded.actualizado_en
       where productos.estado_analisis <> 'descartado'
         and (? = '' or not exists (select 1 from productos where ${MISMO_UPC} and id <> ?))`,
  )
    .bind(id, semanaIngreso(ahora), estadoFisico, cantidad, talla, fotoKey, capturadoPor, ahora.toISOString(), ahora.toISOString(), propietario, upc,
      normalizarUpc(upc), propietario, normalizarUpc(upc), estadoFisico, id, id,
      normalizarUpc(upc), propietario, normalizarUpc(upc), estadoFisico, id)
    .run();
  if (!fotoGuardada.meta.changes && upc) {
    const sumada = await sumarUpc(id, upc, estadoFisico, cantidad, env, correo, undefined, propietario);
    if (sumada) return sumada;
    return json({ error:'Ese UPC ya existe con este grado. Revisa la pieza existente.' }, 409);
  }
  await reiniciarRecorte(env, id);

  const descartada = await env.DB.prepare("select id, estado_analisis, stock, codigo from productos where id = ? and estado_analisis = 'descartado'").bind(id).first<{ codigo: string | null }>();
  if (descartada) {
    if (!descartada.codigo) await env.FOTOS.delete(fotoKey);
    return json(descartada, 201);
  }

  // El analisis corre despues de responder: la camara nunca espera a la IA.
  ctx.waitUntil(analizarBorrador(id, env, modeloPedido(url, env), busquedaPedida(url)));

  return json({ id, estado_analisis: 'pendiente' }, 201);
}

async function listarBorradores(url: URL, env: Env, propietario: string): Promise<Response> {
  const estado = url.searchParams.get('estado');
  const desde = url.searchParams.get('desde');
  // `cambios`: solo lo modificado despues (indice de la migracion 038), con las descartadas
  // para que la pantalla las quite. Es lo que pide /etiquetas cada 30 s en automatica.
  const cambios = url.searchParams.get('cambios');
  for (const fecha of [desde, cambios]) {
    if (fecha !== null && (!Number.isFinite(Date.parse(fecha)) || new Date(fecha).toISOString() !== fecha)) {
      return json({ error: 'Fecha de captura invalida.' }, 400);
    }
  }
  // Los botes son productos para la caja, no piezas que revisar.
  // Orden de captura (mas vieja primero), no de llegada: las piezas se quedan
  // fisicamente donde se capturaron hasta que se les pega su etiqueta, asi que
  // el orden de la pantalla tiene que ser el mismo que el de la mesa o se
  // vuelve un rompecabezas saber que etiqueta es de que pieza.
  // Las 2000 mas nuevas, en orden de captura (#417): con `asc limit` se quedaban fuera las recien capturadas.
  // Empates de hora: la fila (rowid) desempata igual que antes.
  const consulta = `select id, codigo, nombre, categoria, marca, talla, precio_lista, precio, estado_fisico,
                           estado_analisis, destino, stock, semana_ingreso, capturado_por, creado_en, upc, foto_key, propietario
                    from productos where rowid in (select rowid from productos
                    where sin_inventario = 0 and propietario = ? ${cambios ? 'and actualizado_en > ?' : "and estado_analisis <> 'descartado'"}
                      ${estado ? 'and estado_analisis = ?' : ''} ${desde ? 'and creado_en >= ?' : ''}
                    order by creado_en desc, rowid desc limit 2000) order by creado_en asc, rowid asc`;
  const filtros = [propietario, ...(cambios ? [cambios] : []), ...(estado ? [estado] : []), ...(desde ? [desde] : [])];
  const sentencia = env.DB.prepare(consulta).bind(...filtros);
  const { results } = await sentencia.all<FilaBorrador>();
  return json(results);
}

const CATEGORIAS = new Set(CLAVES_CATEGORIA);

/** Etiqueta individual, o una banda de una familia que existe en la tabla `familias`. */
async function destinoValido(destino: string, env: Env): Promise<boolean> {
  if (destino === 'etiqueta') return true;
  if (!esDestinoBanda(destino)) return false;
  const prefijo = /^banda_([a-z]+)/.exec(destino)![1];
  return (await env.DB.prepare('select 1 from familias where prefijo = ?').bind(prefijo).first()) !== null;
}

/**
 * Correcciones del admin. Solo llegan los campos que cambiaron; si no viene un
 * precio explicito, se recalcula con la configuracion vigente.
 * Con etiqueta (codigo) la pieza ya esta a la venta con ese precio impreso: solo
 * el dueno lo cambia (Issue #75). Antes de etiquetar, poner precio es parte de la captura.
 */
async function corregirBorrador(id: string, cambios: Record<string, unknown>, env: Env, esDueno: boolean, captura?: { correo: string; upc: string }, precioEsperado?: number, cierraSolicitudPor?: string, solicitudId?: string): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const fila = await env.DB.prepare(
    "select nombre, categoria, marca, talla, precio_lista, precio, estado_fisico, destino, stock, codigo, upc, propietario from productos where id = ? and estado_analisis <> 'descartado'",
  )
    .bind(id)
    .first<FilaBorrador & { codigo: string | null }>();
  if (!fila) {
    return json({ error: 'La pieza no existe.' }, 404);
  }
  if (Object.keys(cambios).length === 1 && cambios.upc !== undefined) return corregirUpc(env, id, cambios.upc, fila.propietario);
  if (cambios.upc !== undefined && !upcValido(cambios.upc)) return json({ error:'Código de barras inválido.' }, 400);
  const upc = cambios.upc === undefined ? fila.upc : String(cambios.upc).trim();

  const nombre = cambios.nombre === undefined ? fila.nombre : decodificarNombre(String(cambios.nombre)).slice(0, 120);
  const categoria = cambios.categoria === undefined ? fila.categoria : String(cambios.categoria);
  const marca = cambios.marca === undefined ? fila.marca : String(cambios.marca).trim().slice(0, 60);
  const talla = cambios.talla === undefined ? fila.talla : String(cambios.talla).trim() || null;
  const estadoFisico = cambios.estado_fisico === undefined ? fila.estado_fisico : String(cambios.estado_fisico);
  const precioLista = cambios.precio_lista === undefined ? fila.precio_lista : Math.round(Number(cambios.precio_lista));
  const stock = cambios.stock === undefined ? fila.stock : Math.round(Number(cambios.stock));

  if (categoria && !CATEGORIAS.has(categoria)) {
    return json({ error: 'Categoria invalida.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
  }
  const verificarUpc = cambios.upc !== undefined || estadoFisico !== fila.estado_fisico;
  const conflicto = verificarUpc ? await conflictoUpc(env, upc || '', estadoFisico, fila.propietario, id) : null;
  if (conflicto) return conflicto;
  if (talla !== null && !tallaValida(talla)) {
    return json({ error: 'Talla invalida.' }, 400);
  }
  if (!Number.isSafeInteger(precioLista) || precioLista < 0) {
    return json({ error: 'Precio de lista invalido.' }, 400);
  }
  if (!Number.isFinite(stock) || stock < (captura ? 1 : 0) || stock > 999
      || (captura && cambios.stock !== undefined && !Number.isInteger(Number(cambios.stock)))) {
    return json({ error: 'Existencia invalida.' }, 400);
  }

  const config = await leerConfig(env);
  let precio: number;
  let destino: string;

  if (cambios.precio === undefined) {
    const calculado = calcularPrecio({ precioLista, categoria, estadoFisico, config });
    precio = calculado.precio;
    destino = cambios.destino === undefined ? calculado.destino : String(cambios.destino);
  } else {
    precio = Math.round(Number(cambios.precio));
    destino = cambios.destino === undefined ? fila.destino : String(cambios.destino);
    if (!Number.isSafeInteger(precio) || precio < 0) {
      return json({ error: 'Precio invalido.' }, 400);
    }
    if (esDestinoBanda(destino)) {
      // Banda: manda el precio de la banda. Etiqueta: el precio tecleado por el dueno se respeta tal cual.
      precio = ajustarManual({ precio, destino: destino as Destino, config });
    }
    // Misma regla que en el calculo automatico: el precio de venta nunca queda
    // por encima del precio de lista.
    if (precioLista > 0 && precio > precioLista) {
      return json({ error: 'El precio de venta no puede ser mayor al precio de lista.' }, 400);
    }
  }

  if (!await destinoValido(destino, env)) {
    return json({ error: 'Destino invalido.' }, 400);
  }
  // Guardar deja la pieza `listo`: una etiqueta sin nombre o sin precio bloquearia la cola de impresion (#335).
  if (destino === 'etiqueta' && (!nombre.trim() || precio <= 0)) {
    return json({ error: 'Una pieza con etiqueta necesita nombre y un precio mayor a cero para quedar lista.' }, 400);
  }
  if (!esDueno && fila.codigo && precio !== fila.precio) {
    return json({ error: 'Esta pieza ya tiene etiqueta: solo el dueño cambia su precio.' }, 403);
  }

  const ahora = new Date().toISOString();
  const actualizar = env.DB.prepare(
    `update productos set nombre = ?, categoria = ?, marca = ?, talla = ?, precio_lista = ?, precio = ?,
                          estado_fisico = ?, destino = ?, stock = coalesce(?, stock), estado_analisis = 'listo', actualizado_en = ?
                          , upc = ? ${captura ? `, codigo = ${CODIGO_NUEVO}` : ''}
     where id = ?
       and estado_analisis <> 'descartado'
       and (? = 0 or ? = '' or not exists (select 1 from productos where ${MISMO_UPC} and id <> ?))
       and upc is ? and estado_fisico = ?
       ${captura ? `and capturado_por = ? and upc = ? and propietario = 'dolaron'
         and estado_analisis in ('pendiente', 'error') and (codigo is null or codigo = '')
         and not exists (select 1 from venta_lineas where producto_id = productos.id)` : ''}
       ${precioEsperado === undefined ? '' : 'and precio = ?'}
       ${solicitudId ? `and destino = 'etiqueta' and sin_inventario = 0
         and exists (select 1 from solicitudes_precio where id = ? and producto_id = productos.id
           and propietario = productos.propietario and estado = 'pendiente')` : ''}
     returning stock`,
  )
    .bind(nombre, categoria, marca, talla, precioLista, precio, estadoFisico, destino,
      // Sin `stock` en el cuerpo no se toca: la caja pudo vender piezas desde que se abrio la ficha.
      cambios.stock === undefined ? null : stock, ahora, upc ?? null, id,
      verificarUpc ? 1 : 0, normalizarUpc(upc), fila.propietario, normalizarUpc(upc), estadoFisico, id,
      fila.upc ?? null, fila.estado_fisico, ...(captura ? [captura.correo, captura.upc] : []),
      ...(precioEsperado === undefined ? [] : [precioEsperado]), ...(solicitudId ? [solicitudId] : []));
  // #451: si el dueño cambia el precio por esta vía y había una solicitud pendiente, se cierra en el mismo batch,
  // solo si la pieza sigue viva y el precio de verdad cambia.
  let guardada: { stock: number } | undefined | null;
  if (cierraSolicitudPor && (solicitudId || precio !== fila.precio)) {
    const [actualizada, cerrada] = await env.DB.batch([
      actualizar,
      // Cero filas no aborta el batch: changes() impide cerrar si el UPDATE no pasó sus guardas.
      env.DB.prepare(`update solicitudes_precio set estado = 'aplicada', precio_nuevo = ?, resuelto_por = ?, resuelto_en = ?
        where producto_id = ? and estado = 'pendiente' and changes() = 1
          ${solicitudId ? 'and id = ?' : ''}
          and exists (select 1 from productos where id = ? and precio = ? and actualizado_en = ?)`)
        .bind(precio, cierraSolicitudPor, ahora, id, ...(solicitudId ? [solicitudId] : []), id, precio, ahora),
    ]);
    guardada = actualizada.results?.[0] as { stock: number } | undefined;
    if (solicitudId && cerrada.meta.changes !== 1) guardada = undefined;
  } else guardada = await actualizar.first<{ stock: number }>();

  // `precioEsperado` (#451): el precio solo cambia si sigue valiendo lo que vio quien lo cambia.
  if (!guardada) return precioEsperado !== undefined ? json({ error: 'El precio de la pieza cambió. Revisa el precio actual.' }, 409)
    : await conflictoUpc(env, upc || '', estadoFisico, fila.propietario, id) ?? json({ error: 'La pieza cambió o ya fue eliminada.' }, 409);
  return json({ id, nombre, categoria, marca, talla, upc, precio_lista: precioLista, precio, estado_fisico: estadoFisico, destino, stock: guardada.stock });
}

/**
 * Captura a mano, sin foto (Issue #115; solo el dueno, ver cuentas.ts). Nace
 * como una pieza de la cola y pasa por la misma correccion: mismas
 * validaciones y mismo calculo de precio. Idempotente por id, como la foto.
 */
async function capturarManual(request: Request, env: Env, correo: string): Promise<Response> {
  return await altaManual((await request.json().catch(() => ({}))) as Record<string, unknown>, env, correo);
}

async function altaManual(cuerpo: Record<string, unknown>, env: Env, correo: string, upc: string | null = null, esDueno = true): Promise<Response> {
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!String(cuerpo.nombre ?? '').trim()) return json({ error: 'Falta el nombre.' }, 400);
  if (!(Number(cuerpo.precio_lista) > 0) && !(Number(cuerpo.precio) > 0)) {
    return json({ error: 'Escribe el precio de lista o el de venta.' }, 400);
  }
  const grado = String(cuerpo.estado_fisico ?? 'nuevo');
  const cantidad = Number(cuerpo.stock ?? 1);
  if (!ESTADOS_FISICOS.has(grado) || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999)
    return json({ error:'Grado o cantidad inválidos.' }, 400);
  if (upc) {
    const sumada = await sumarUpc(id, upc, grado, cantidad, env, correo);
    if (sumada) return sumada;
  }
  const ahora = new Date().toISOString();
  const { meta } = await env.DB.prepare(
    `insert into productos (id, semana_ingreso, capturado_por, creado_en, actualizado_en, upc, estado_fisico)
     select ?, ?, ?, ?, ?, ?, ? where (? = '' or not exists (select 1 from productos where ${MISMO_UPC} and id <> ?))
       and not exists (select 1 from conteo_ajustes where id = ?) on conflict (id) do nothing`,
  )
    .bind(id, semanaIngreso(new Date()), correo, ahora, ahora, upc, grado,
      normalizarUpc(upc), 'dolaron', normalizarUpc(upc), grado, id, id)
    .run();
  if (!meta.changes && upc && !await env.DB.prepare('select id from productos where id = ?').bind(id).first())
    return await sumarUpc(id, upc, grado, cantidad, env, correo) ?? json({ error:'La captura cambió. Reintenta.' }, 409);
  const respuesta = await corregirBorrador(id, cuerpo, env, esDueno, upc === null ? undefined : { correo, upc });
  // Datos invalidos: no queda una pieza vacia (salvo que fuera un reintento de una ya guardada).
  if (!respuesta.ok && meta.changes > 0) await env.DB.prepare(`delete from productos where id = ?
    ${upc === null ? '' : "and estado_analisis = 'pendiente' and (codigo is null or codigo = '') and actualizado_en = ?"}`)
    .bind(id, ...(upc === null ? [] : [ahora])).run();
  if (!respuesta.ok) return respuesta;
  // El dueno la da de alta para venderla ya: sin codigo la caja no la recibe. Es
  // el mismo que le pondria Etiquetas, asi que la etiqueta impresa despues coincide.
  // Las de banda se cobran con el codigo de la banda.
  await env.DB.prepare(
    `update productos set codigo = ${CODIGO_NUEVO}, actualizado_en = ?
     where id = ? and (codigo is null or codigo = '') and destino not like 'banda%'`,
  ).bind(new Date().toISOString(), id).run();
  return json(await respuesta.json(), 201);
}

/** Sin foto desde el escáner (#399): misma corrección, identidad y precio autorizados en servidor. */
async function capturarManualEscaner(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!cuerpo || typeof cuerpo.id !== 'string' || !UUID.test(cuerpo.id)) return json({ error: 'Identificador inválido.' }, 400);
  if (request.method === 'PATCH') {
    return await corregirCaptura(cuerpo.id, 'existencia', new Request(request.url, { method: 'PATCH', body: JSON.stringify(cuerpo) }), env, correo, true);
  }
  const upc = cuerpo.upc === SIN_CODIGO ? SIN_CODIGO : codigoLeido(cuerpo.upc);
  if (cuerpo.upc !== SIN_CODIGO && !normalizarUpc(upc)) return json({ error: 'Código de barras inválido.' }, 400);
  const existente = await env.DB.prepare('select upc, capturado_por, propietario, estado_analisis, codigo from productos where id = ?')
    .bind(cuerpo.id).first<{ upc: string | null; capturado_por: string; propietario: string; estado_analisis: string; codigo: string | null }>();
  if (existente && (existente.propietario !== 'dolaron' || existente.capturado_por !== correo)) return json({ error: 'Pieza no encontrada.' }, 404);
  if (existente && existente.upc !== upc) return json({ error: 'El código no corresponde a esta pieza.' }, 409);
  if (existente?.estado_analisis === 'listo') {
    const guardada = await capturaUpcGuardada(cuerpo.id, upc, env, undefined, correo);
    if (guardada && !guardada.ok) return guardada;
    return await estadoDesconocido(cuerpo.id, env, correo, 201);
  }
  if (existente && (existente.codigo || existente.estado_analisis === 'descartado')) return json({ error: 'La pieza ya tiene etiqueta o se canceló.' }, 409);
  if (upc && await fichaDeManifiesto(normalizarUpc(upc), env)) return json({ error: 'Ese código sí está en la hoja: vuelve a escanearlo.' }, 409);
  const esDueno = !!(await leerUsuario(env, correo))?.roles.includes('dueno');
  const respuesta = await altaManual({ id: cuerpo.id, nombre: cuerpo.nombre, categoria: cuerpo.categoria,
    estado_fisico: cuerpo.estado_fisico, precio_lista: cuerpo.precio_lista, precio: cuerpo.precio,
    stock: cuerpo.stock, destino: 'etiqueta' }, env, correo, upc, esDueno);
  // Otro reintento pudo terminarla mientras se validaban los datos; nunca repone stock.
  if (respuesta.ok && (await respuesta.clone().json() as { existente?: boolean }).existente) return respuesta;
  if (!respuesta.ok) {
    const guardada = await capturaUpcGuardada(cuerpo.id, upc, env, undefined, correo);
    return guardada?.status === 201 ? await estadoDesconocido(cuerpo.id, env, correo, 201) : respuesta;
  }
  return await estadoDesconocido(cuerpo.id, env, correo, 201);
}

/**
 * Lo que el manifiesto dice de un UPC, con el precio de lista en pesos (Issue
 * #365). El precio de venta de una pieza nueva es solo para la pantalla: al
 * guardar se recalcula aqui mismo, nunca se toma del cliente.
 */
async function precioDeManifiesto(upcCrudo: string, env: Env): Promise<Response | { ficha: FichaManifiesto; precioLista: number; precioManual?: number; config: Record<string, string> }> {
  const upc = normalizarUpc(upcCrudo);
  if (!upc || upc.length > 14) return json({ error: 'Código de barras inválido.' }, 400);
  const ficha = await fichaDeManifiesto(upc, env);
  const config = await leerConfig(env);
  if (!ficha) {
    // Lo ya identificado se reutiliza con o sin foto (#402): búsqueda por código (#373) o captura a mano.
    // productos.upc guarda el código tal cual se leyó: se prueban sus variantes con ceros para usar el índice productos_upc.
    const claves = Array.from({ length: 15 - upc.length }, (_, i) => upc.padStart(upc.length + i, '0'));
    const propia = await env.DB.prepare(`select nombre, marca, categoria, precio_lista, precio from productos
      where upc in (${claves.map(() => '?').join(', ')}) and propietario = 'dolaron' and estado_analisis = 'listo'
        and precio > 0 and trim(nombre) <> '' order by actualizado_en desc limit 1`)
      .bind(...claves).first<{ nombre: string; marca: string; categoria: string; precio_lista: number; precio: number }>();
    if (!propia) return json({ error: 'Ese código no está en el catálogo ni en el manifiesto: captura la pieza con foto.' }, 404);
    return { ficha: { upc, nombre: propia.nombre, descripcion: propia.nombre, marca: propia.marca, categoria: propia.categoria,
      departamento: '', precio_usd: 0, tcin: '' }, precioLista: propia.precio_lista,
      ...(propia.precio_lista > 0 ? {} : { precioManual: propia.precio }), config };
  }
  const tipoCambio = Number.parseInt(config.tipo_cambio ?? '', 10);
  if (!(tipoCambio > 0)) return json({ error: 'Falta el tipo de cambio: ponlo en la configuración del admin.' }, 409);
  return { ficha, precioLista: precioListaMxn(ficha.precio_usd, tipoCambio), config };
}

async function buscarEnManifiesto(upcCrudo: string, env: Env): Promise<Response> {
  const resultado = await precioDeManifiesto(upcCrudo, env);
  if (resultado instanceof Response) return resultado;
  const { ficha, precioLista, precioManual, config } = resultado;
  const categoria = ficha.categoria || 'otros';
  return json({
    upc: ficha.upc, nombre: ficha.nombre || ficha.descripcion, traducido: !!ficha.nombre, descripcion: ficha.descripcion,
    marca: ficha.marca, categoria, precio_usd: ficha.precio_usd, precio_lista: precioLista,
    precio: precioManual ?? calcularPrecio({ precioLista, categoria, estadoFisico: 'nuevo', config }).precio,
    // Por grado A/B/C, para que el escáner muestre el que se va a guardar (#371).
    precios: Object.fromEntries([...ESTADOS_FISICOS].map((estado) =>
      [estado, precioManual ?? calcularPrecio({ precioLista, categoria, estadoFisico: estado, config }).precio])),
    enlace: ficha.tcin ? `https://www.target.com/p/-/A-${ficha.tcin}` : '',
    imagen: await imagenGuardada(ficha.upc, env),
  });
}

/** Alta de una pieza escaneada: todo sale del manifiesto menos la cantidad y el estado. */
async function capturaUpcGuardada(id: string, leido: string, env: Env, ctx?: ExecutionContext, correo?: string): Promise<Response | null> {
  const sumada = correo ? await capturaSumada(env, id, correo) : null;
  const existente = sumada ?? await env.DB.prepare(`select ${PIEZA_UPC} from productos where id = ?`)
    .bind(id).first<PiezaUpc>();
  if (!existente) return null;
  if (existente.propietario !== 'dolaron') return json({ error: 'Pieza no encontrada.' }, 404);
  if (normalizarUpc(existente.upc) !== normalizarUpc(leido) || existente.estado_analisis === 'descartado') return json({ error: 'La captura ya corresponde a otra pieza o está en revisión.' }, 409);
  await env.DB.prepare(`update productos set codigo = ${CODIGO_NUEVO} where id = ? and (codigo is null or codigo = '')
    and estado_analisis = 'listo' and propietario = 'dolaron' and destino not like 'banda%'`)
    .bind(existente.id).run();
  const codigo = await env.DB.prepare('select codigo from productos where id = ?').bind(existente.id).first<{ codigo: string | null }>();
  if (ctx && existente.estado_analisis === 'listo') ctx.waitUntil(guardarImagenComoFoto(leido, env));
  return json({ id:existente.id, upc:existente.upc, nombre:existente.nombre, precio:existente.precio, stock:existente.stock,
    estado_fisico:existente.estado_fisico, estado_analisis:existente.estado_analisis, codigo:codigo?.codigo,
    tiene_foto:existente.tiene_foto, creado_en:existente.creado_en,
    ...(sumada ? { existente:true, sumadas:sumada.sumadas } : {}) }, 201);
}

async function sumarUpc(id: string, upc: string, grado: string, cantidad: number, env: Env, correo: string, ctx?: ExecutionContext, propietario = 'dolaron'): Promise<Response | null> {
  try {
    const sumada = await sumarCaptura(env, id, upc, grado, cantidad, correo, propietario);
    if (!sumada) return null;
    if (sumada.propietario !== propietario) return json({ error:'Pieza no encontrada.' }, 404);
    if (propietario !== 'dolaron') {
      const { propietario: _propietario, capturado_por: _capturado, ...pieza } = sumada;
      return json({ ...pieza, existente:true }, 201);
    }
    return await capturaUpcGuardada(id, upc, env, ctx, correo);
  } catch (error) {
    if (!String(error).includes('La captura cambió')) throw error;
    return json({ error: String((error as Error).message) }, 409);
  }
}

async function capturarPorUpc(request: Request, env: Env, correo: string, ctx?: ExecutionContext): Promise<Response> {
  const cuerpo = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!cuerpo) return json({ error: 'Datos inválidos.' }, 400);
  const leido = codigoLeido(cuerpo.upc);
  if (!normalizarUpc(leido)) return json({ error: 'Código de barras inválido.' }, 400);
  if (typeof cuerpo.id !== 'string' || !UUID.test(cuerpo.id)) return json({ error: 'Identificador inválido.' }, 400);
  const existente = await capturaUpcGuardada(cuerpo.id, leido, env, ctx, correo);
  if (existente) return existente;
  const stock = Number(cuerpo.stock);
  if (!Number.isInteger(stock) || stock < 1 || stock > 999) return json({ error: 'Cantidad inválida.' }, 400);
  const estado = cuerpo.estado_fisico ?? 'nuevo';
  if (typeof estado !== 'string' || !ESTADOS_FISICOS.has(estado)) return json({ error: 'Estado físico inválido.' }, 400);
  const sumada = await sumarUpc(cuerpo.id, leido, estado, stock, env, correo, ctx);
  if (sumada) return sumada;
  const resultado = await precioDeManifiesto(leido, env);
  if (resultado instanceof Response) return resultado;
  const { ficha, precioLista, precioManual, config } = resultado;
  const nombre = decodificarNombre(ficha.nombre || ficha.descripcion).trim().slice(0, 120), categoria = ficha.categoria || 'otros';
  const precio = precioManual ?? calcularPrecio({ precioLista, categoria, estadoFisico: estado, config }).precio;
  if (!nombre || !CATEGORIAS.has(categoria) || !Number.isSafeInteger(precio) || precio <= 0 || !Number.isSafeInteger(precioLista) || precioLista < 0) {
    return json({ error: 'El producto necesita nombre, categoría y precio válidos.' }, 400);
  }
  const ahora = new Date();
  // Una sola inserción completa: dos reintentos nunca restauran stock ni ven una pieza a medio llenar.
  await env.DB.prepare(`insert into productos
    (id, upc, nombre, marca, categoria, precio_lista, precio, estado_fisico, stock, semana_ingreso,
     capturado_por, creado_en, actualizado_en, estado_analisis, destino, propietario)
    select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'listo', 'etiqueta', 'dolaron'
    where not exists (select 1 from productos where ${MISMO_UPC})
      and not exists (select 1 from conteo_ajustes where id = ?) on conflict (id) do nothing`)
    .bind(cuerpo.id, leido, nombre, ficha.marca.trim().slice(0, 60), categoria, precioLista, precio, estado, stock,
      semanaIngreso(ahora), correo, ahora.toISOString(), ahora.toISOString(), 'dolaron', normalizarUpc(leido), estado, cuerpo.id).run();
  return (await capturaUpcGuardada(cuerpo.id, leido, env, ctx, correo))
    ?? await sumarUpc(cuerpo.id, leido, estado, stock, env, correo, ctx) ?? json({ error: 'La captura cambió. Vuelve a intentarlo.' }, 409);
}

/**
 * UPC que no está en la hoja (Issue #373): la pieza nace `pendiente` con su código y cantidad,
 * se responde de inmediato y Gemini la busca por el código en segundo plano. El capturista sigue
 * escaneando; si no aparece, el escáner le pide foto para esta misma pieza (mismo id).
 */
async function capturarDesconocido(request: Request, env: Env, ctx: ExecutionContext, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!cuerpo) return json({ error: 'Datos inválidos.' }, 400);
  const leido = codigoLeido(cuerpo.upc), upc = normalizarUpc(leido);
  if (!upc) return json({ error: 'Código de barras inválido.' }, 400);
  if (typeof cuerpo.id !== 'string' || !UUID.test(cuerpo.id)) return json({ error: 'Identificador inválido.' }, 400);
  const stock = Number(cuerpo.stock);
  if (!Number.isInteger(stock) || stock < 1 || stock > 999) return json({ error: 'Cantidad inválida.' }, 400);
  const estado = cuerpo.estado_fisico ?? 'nuevo';
  if (typeof estado !== 'string' || !ESTADOS_FISICOS.has(estado)) return json({ error: 'Estado físico inválido.' }, 400);
  const guardada = await capturaUpcGuardada(cuerpo.id, leido, env, undefined, correo);
  if (guardada) return guardada;
  const sumada = await sumarUpc(cuerpo.id, leido, estado, stock, env, correo);
  if (sumada) return sumada;
  if (await fichaDeManifiesto(upc, env)) return json({ error: 'Ese código sí está en la hoja: vuelve a escanearlo.' }, 409);
  const ahora = new Date();
  const { meta } = await env.DB.prepare(`insert into productos
    (id, upc, nombre, estado_fisico, stock, semana_ingreso, capturado_por, creado_en, actualizado_en, estado_analisis, destino, propietario)
    select ?, ?, '', ?, ?, ?, ?, ?, ?, 'pendiente', 'etiqueta', 'dolaron'
    where not exists (select 1 from productos where ${MISMO_UPC})
      and not exists (select 1 from conteo_ajustes where id = ?) on conflict (id) do nothing`)
    .bind(cuerpo.id, leido, estado, stock, semanaIngreso(ahora), correo, ahora.toISOString(), ahora.toISOString(), 'dolaron', upc, estado, cuerpo.id).run();
  if (!meta.changes) return (await capturaUpcGuardada(cuerpo.id, leido, env, undefined, correo))
    ?? await sumarUpc(cuerpo.id, leido, estado, stock, env, correo) ?? json({ error:'La captura cambió. Reintenta.' }, 409);
  // Un reintento del mismo id no vuelve a buscar ni repone stock. Se busca el código tal cual se leyó:
  // sin el 0 inicial, Google no encuentra el UPC-A. Sin cola (local, pruebas), en waitUntil.
  if (meta.changes) {
    if (env.BUSQUEDAS) await env.BUSQUEDAS.send({ id: cuerpo.id, upc: leido });
    else ctx.waitUntil(identificarPieza(cuerpo.id, leido, env));
  }
  return await estadoDesconocido(cuerpo.id, env, correo, 202);
}

/** En la cola no hay tope de 30 s: Vertex con Google tarda de 20 a 40 s (#406). */
const LIMITE_COLA_MS = 60_000;

/**
 * Busca el código de una pieza que no está en la hoja (Issue #373, cola #406). La usan la captura por
 * código desconocido y el análisis de una foto con código y sin precio. Con hallazgo seguro la pieza
 * queda lista con el nombre del código, que es más fiable que el de la foto (una cobija salió «gorro»).
 * Sin hallazgo, `error`: el escáner pide foto o la pieza queda aparte. `ultimo = false` deja que la
 * cola reintente un error de red o de tiempo.
 */
export async function identificarPieza(id: string, upc: string, env: Env, ultimo = true): Promise<void> {
  const inicio = Date.now();
  let ficha: Awaited<ReturnType<typeof identificarUpc>> | null = null;
  try {
    ficha = await identificarUpc(upc, env, env.BUSQUEDAS ? LIMITE_COLA_MS : undefined);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'upc sin identificar', id, upc, ultimo, error: String(error).slice(0, 200) }));
    if (!ultimo) throw error;
  }
  const fila = await env.DB.prepare(`select estado_fisico from productos where id = ? and estado_analisis in ('pendiente', 'error')`)
    .bind(id).first<{ estado_fisico: string }>();
  if (!fila) return;   // ya está lista (captura manual o análisis) o la descartaron
  const config = await leerConfig(env);
  // Pesos de la página, o sus dólares por el tipo de cambio como la hoja (eBay, tiendas de EE.UU.; #397).
  const precioLista = ficha ? pesosDeLista(ficha, config) * 100 : 0;
  const precio = ficha ? calcularPrecio({ precioLista, categoria: ficha.categoria, estadoFisico: fila.estado_fisico, config }).precio : 0;
  // Sin nombre seguro o sin precio no se imprime: queda en `error` (con el nombre que diera la foto).
  const completa = !!ficha && ficha.nombre.trim() !== '' && ficha.confianza >= 0.5 && precio > 0;
  if (completa) {
    await env.DB.prepare(`update productos set nombre = ?, marca = ?, categoria = ?, precio_lista = ?, precio = ?, precio_sugerido = ?,
        estado_analisis = 'listo', actualizado_en = ? where id = ? and estado_analisis in ('pendiente', 'error')`)
      .bind(ficha!.nombre, ficha!.marca, ficha!.categoria, precioLista, precio, precio, new Date().toISOString(), id).run();
  } else {
    // Sin precio, pero si el código dice con seguridad qué es, ese nombre va aparte en lugar del de la
    // foto: Haiku llamó «Laptop Intel Core» a un peluche de Mickey (#409). El admin solo pone el precio.
    const nombreSeguro = ficha && ficha.nombre.trim() !== '' && ficha.confianza >= 0.7 ? 1 : 0;
    await env.DB.prepare(`update productos set estado_analisis = 'error', actualizado_en = ?,
        nombre = case when ? then ? else nombre end, marca = case when ? then ? else marca end,
        categoria = case when ? then ? else categoria end
      where id = ? and estado_analisis = 'pendiente'`)
      .bind(new Date().toISOString(), nombreSeguro, ficha?.nombre ?? '', nombreSeguro, ficha?.marca ?? '',
        nombreSeguro, ficha?.categoria ?? '', id).run();
  }
  if (completa) {
    await env.DB.prepare(`update productos set codigo = ${CODIGO_NUEVO} where id = ? and (codigo is null or codigo = '') and estado_analisis = 'listo'`)
      .bind(id).run();
  }
  console.log(JSON.stringify({ mensaje: completa ? 'upc identificado' : 'upc necesita foto', id, upc, ms: Date.now() - inicio, ficha }));
}

/** Lo que el escáner consulta mientras se busca una pieza desconocida. Solo quien la capturó. */
async function estadoDesconocido(id: string, env: Env, correo: string, status = 200): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
  const sumada = await capturaSumada(env, id, correo);
  const fila = await env.DB.prepare(`select ${PIEZA_UPC} from productos
    where id = ? and propietario = 'dolaron' ${sumada ? '' : 'and capturado_por = ?'}`)
    .bind(sumada?.id ?? id, ...(sumada ? [] : [correo])).first<PiezaUpc>();
  return fila ? json({ id:fila.id, upc:fila.upc, nombre:fila.nombre, precio:fila.precio, stock:fila.stock,
    codigo:fila.codigo, estado_fisico:fila.estado_fisico, estado_analisis:fila.estado_analisis,
    creado_en:fila.creado_en, con_foto:fila.tiene_foto,
    ...(sumada ? { existente:true, sumadas:sumada.sumadas } : {}) }, status) : json({ error: 'Pieza no encontrada.' }, 404);
}

/** Cuanto dura abierta la correccion desde la camara. */
const VENTANA_CAPTURA_MS = 24 * 60 * 60 * 1000;

/**
 * La existencia o la talla de una pieza recien capturada, desde el carrusel de
 * /captura. Solo quien la capturo y solo en las primeras 24 h: el telefono del
 * pasillo no es la puerta para ajustar inventario viejo (eso es la cola de
 * revision), y pasado ese rato la pieza ya pudo venderse y un numero absoluto
 * pisaria la venta.
 */
async function corregirCaptura(id: string, campo: string, request: Request, env: Env, correo: string, sinFoto = false): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const cuerpo = (await request.json()) as { stock?: unknown; talla?: unknown };
  let valor: number | string;
  if (campo === 'existencia') {
    valor = Number(cuerpo.stock);
    if (!Number.isInteger(valor) || valor < 0 || valor > 999) {
      return json({ error: 'Existencia invalida.' }, 400);
    }
  } else {
    valor = String(cuerpo.talla ?? '');
    if (!tallaValida(valor)) {
      return json({ error: 'Talla invalida.' }, 400);
    }
  }
  const columna = campo === 'existencia' ? 'stock' : 'talla';
  const desde = new Date(Date.now() - (sinFoto ? 5 * 60_000 : VENTANA_CAPTURA_MS)).toISOString();
  // Captura sin foto (#399): cinco minutos para cantidad; una venta o publicación cierra la corrección.
  const alcanceSinFoto = `propietario = 'dolaron' and upc is not null and foto_key = ''
    and not exists (select 1 from venta_lineas where producto_id = productos.id)
    and not exists (select 1 from ml_publicaciones where producto_id = productos.id)`;
  // Lo escaneado (con UPC) se corrige mientras está abierto en el escáner; ya guardado y `listo`,
  // /etiquetas lo imprime en seguida, así que solo se corrige lo que aún se identifica o espera foto (#381).
  // En 0 se cancela y sale de la cola (#377). Una foto se elimina desde su miniatura.
  if (valor === 0) {
    const { meta } = await env.DB.prepare(`update productos set stock = 0, estado_analisis = 'descartado', actualizado_en = ?
      where id = ? and capturado_por = ? and upc is not null and creado_en > ? and estado_analisis ${sinFoto ? "<> 'descartado'" : "not in ('listo', 'descartado')"}
        ${sinFoto ? `and ${alcanceSinFoto}` : ''}
        and not ${CAPTURA_SUMADA}
        and not exists (select 1 from venta_lineas where producto_id = productos.id)`)
      .bind(new Date().toISOString(), id, correo, desde).run();
    if (!meta.changes) return await conflictoCapturaSumada(env, id, correo)
      ?? json({ error: sinFoto ? 'Ya no se puede cancelar: pasaron 5 minutos o la pieza tiene venta, foto o publicación.' : 'Ya tiene etiqueta: corrígela en el admin.' }, 404);
    return json({ id, stock: 0, descartado: true });
  }
  const resultado = await env.DB.prepare(
    `update productos set ${columna} = ?, actualizado_en = ? where id = ? and capturado_por = ? and creado_en > ?
       and (${sinFoto ? alcanceSinFoto : "upc is null or estado_analisis <> 'listo'"}) and estado_analisis <> 'descartado'
       ${campo === 'existencia' ? `and not ${CAPTURA_SUMADA}` : ''}`,
  )
    .bind(valor, new Date().toISOString(), id, correo, desde)
    .run();
  if (resultado.meta.changes === 0) {
    if (campo === 'existencia') {
      const conflicto = await conflictoCapturaSumada(env, id, correo);
      if (conflicto) return conflicto;
    }
    return json({ error: sinFoto ? 'Ya no se puede cambiar: pasaron 5 minutos o la pieza tiene venta, foto o publicación.' : 'Ya no se puede cambiar: lo escaneado ya tiene etiqueta y las fotos se corrigen en sus primeras 24 horas.' }, 404);
  }
  return json({ id, [columna]: valor });
}

/** Corrección desde la miniatura; nunca cambia stock al editar precio/condición. */
async function revisarCaptura(id: string, request: Request, env: Env, correo: string): Promise<Response> {
  if (!capturaRopaDisponible(env)) return json({ error: 'Ruta no encontrada.' }, 404);
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  const ahora = new Date().toISOString();
  const desde = new Date(Date.now() - VENTANA_CAPTURA_MS).toISOString();
  const alcance = 'id = ? and capturado_por = ? and creado_en > ? and sin_inventario = 0';
  // Conserva el UUID incluso si aún no llegó el POST: una subida retrasada no revive la captura.
  if (request.method === 'DELETE') {
    await env.DB.prepare(`insert into productos (id, stock, estado_analisis, semana_ingreso, capturado_por, creado_en, actualizado_en)
      values (?, 0, 'descartado', ?, ?, ?, ?) on conflict(id) do nothing`)
      .bind(id, semanaIngreso(new Date()), correo, ahora, ahora).run();
  }
  const fila = await env.DB.prepare(`select id, precio, estado_fisico, estado_analisis, stock, talla, codigo, nombre, marca, categoria, upc, propietario from productos where ${alcance}`)
    .bind(id, correo, desde).first<{ id: string; nombre: string; marca: string; categoria: string; estado_analisis: string; precio: number; estado_fisico: string; stock: number; talla: string | null; codigo: string | null; upc:string | null; propietario:string }>();
  if (!fila) return json({ error: 'Solo puedes corregir lo que capturaste en las últimas 24 horas.' }, 404);
  if (request.method === 'GET') return json({ ...fila, prenda: prendaDeNombre(fila.nombre, fila.marca) });
  if (request.method === 'DELETE') {
    const resultado = await env.DB.prepare(`update productos set stock = 0, precio = 0,
        foto_key = case when coalesce(codigo, '') = '' then '' else foto_key end,
        estado_analisis = 'descartado', actualizado_en = ? where ${alcance}
        and not ${CAPTURA_SUMADA}
        and not exists (select 1 from venta_lineas where producto_id = productos.id)
        and not exists (select 1 from ml_publicaciones where producto_id = productos.id)`)
      .bind(ahora, id, correo, desde).run();
    if (!resultado.meta.changes) return await conflictoCapturaSumada(env, id, correo)
      ?? json({ error: 'Tiene una venta o publicación. Revisa la pieza en el admin; no se eliminó.' }, 409);
    const conservada = await env.DB.prepare('select codigo from productos where id = ?').bind(id).first<{ codigo: string | null }>();
    if (!conservada?.codigo) await env.FOTOS.delete(`fotos/${id}.jpg`);
    return json({ id, descartado: true });
  }
  if (request.method !== 'PATCH') return json({ error: 'Metodo no permitido.' }, 405);
  const cambios = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!cambios || Array.isArray(cambios) || typeof cambios !== 'object' || !Object.keys(cambios).length
      || Object.keys(cambios).some((k) => !['precio', 'estado_fisico', 'prenda', 'marca'].includes(k))) {
    return json({ error: 'Corrección invalida.' }, 400);
  }
  if (cambios.precio !== undefined && (typeof cambios.precio !== 'number' || !PRECIOS_ROPA.includes(cambios.precio))) {
    return json({ error: 'Escoge $200, $150, $100, $80 o $50 MXN.' }, 400);
  }
  if (cambios.estado_fisico !== undefined && (typeof cambios.estado_fisico !== 'string' || !ESTADOS_FISICOS.has(cambios.estado_fisico))) {
    return json({ error: 'Estado fisico invalido.' }, 400);
  }
  if ((cambios.prenda !== undefined && (!textoCapturaRopa(cambios.prenda) || (String(cambios.prenda).trim() !== '' && !PRENDAS_ROPA.includes(String(cambios.prenda).trim()))))
      || (cambios.marca !== undefined && !textoCapturaRopa(cambios.marca))) return json({ error: 'Prenda o marca invalida.' }, 400);
  if ((cambios.prenda !== undefined || cambios.marca !== undefined) && fila.categoria !== 'ropa') return json({ error: 'Solo se corrige prenda y marca en ropa.' }, 400);
  const prenda = cambios.prenda === undefined ? prendaDeNombre(fila.nombre, fila.marca) : cambios.prenda as string;
  const marca = cambios.marca === undefined ? fila.marca : cambios.marca as string;
  const nombre = cambios.prenda === undefined && cambios.marca === undefined ? fila.nombre : nombreRopa(prenda.trim(), marca.trim());
  const grado = String(cambios.estado_fisico ?? fila.estado_fisico);
  const conflicto = cambios.estado_fisico !== undefined ? await conflictoUpc(env, fila.upc || '', grado, fila.propietario, id) : null;
  if (conflicto) return conflicto;
  const resultado = await env.DB.prepare(`update productos set precio = coalesce(?, precio),
      estado_fisico = coalesce(?, estado_fisico), nombre = ?, marca = ?, actualizado_en = ? where ${alcance} and estado_analisis = 'listo'
      and upc is ? and estado_fisico = ?
      and (? = 0 or ? = '' or not exists (select 1 from productos where ${MISMO_UPC} and id <> ?))
      and (? is null or precio_lista = 0 or precio_lista >= ?)`)
    .bind(cambios.precio ?? null, cambios.estado_fisico ?? null, nombre, marca.trim(), ahora, id, correo, desde,
      fila.upc, fila.estado_fisico, cambios.estado_fisico === undefined ? 0 : 1, normalizarUpc(fila.upc), fila.propietario, normalizarUpc(fila.upc), grado, id,
      cambios.precio ?? null, cambios.precio ?? null).run();
  if (!resultado.meta.changes) return json({ error: 'La captura no está lista, fue eliminada o el precio supera el de lista.' }, 409);
  const guardada = await env.DB.prepare(`select id, precio, estado_fisico, estado_analisis, stock, talla, codigo, nombre, marca from productos where ${alcance}`)
    .bind(id, correo, desde).first<{ nombre: string; marca: string }>();
  return json(guardada ? { ...guardada, prenda: prendaDeNombre(guardada.nombre, guardada.marca) } : guardada);
}

/**
 * Codigo ED- nuevo: el rowid, o el siguiente al mayor que ya existe si ese rowid ya
 * se uso. SQLite reutiliza el rowid mas alto al borrar (fusionar/descartar), y una
 * fusion deja vivo el codigo de la borrada: sin esto, la siguiente pieza chocaria
 * con el indice unico o heredaria una etiqueta ya pegada.
 * ponytail: max() recorre los codigos ED-; un contador en config si el catalogo crece mucho.
 */
const CODIGO_NUEVO = `'ED-' || printf('%06d', max(rowid,
  (select coalesce(max(cast(substr(codigo, 4) as integer)), 0) + 1 from productos where codigo like 'ED-%')))`;

/**
 * Asigna el codigo de barras a las piezas que se van a etiquetar y las devuelve.
 * El codigo se mina una sola vez: una pieza que ya trae etiqueta impresa conserva
 * el suyo, porque reimprimir con otro codigo deja el papel del anaquel huerfano.
 */
async function prepararEtiquetas(request: Request, env: Env, propietario: string): Promise<Response> {
  const { ids } = (await request.json()) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return json({ error: 'Selecciona entre 1 y 100 piezas.' }, 400);
  }
  const limpios = ids.map(String).filter((id) => UUID.test(id));
  if (limpios.length === 0) {
    return json({ error: 'Identificadores invalidos.' }, 400);
  }

  const huecos = limpios.map(() => '?').join(',');
  // Una por una y en orden de captura: cada codigo nuevo ve el anterior (CODIGO_NUEVO).
  const { results: porCodificar } = await env.DB.prepare(
    `select id from productos where id in (${huecos}) and propietario = ? and estado_analisis <> 'descartado' and (codigo is null or codigo = '') order by rowid`,
  )
    .bind(...limpios, propietario)
    .all<{ id: string }>();
  const ahora = new Date().toISOString();
  if (porCodificar.length) {
    await env.DB.batch(porCodificar.map(({ id }) => env.DB.prepare(
      `update productos set codigo = ${CODIGO_NUEVO}, actualizado_en = ?
       where id = ? and estado_analisis <> 'descartado' and (codigo is null or codigo = '')`,
    ).bind(ahora, id)));
  }

  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, talla, precio, precio_lista, semana_ingreso, destino, stock, estado_fisico
     from productos where id in (${huecos}) and propietario = ? and estado_analisis <> 'descartado' order by rowid`,
  )
    .bind(...limpios, propietario)
    .all();

  return json(results);
}

/** Mismas restricciones de venta, pedido y publicación, comprobadas dentro del batch. */
const BORRADOR_RETIRABLE = `sin_inventario = 0
  and not exists (select 1 from venta_lineas where producto_id = productos.id)
  and not exists (select 1 from pedido_lineas where producto_id = productos.id)
  and not exists (select 1 from ml_publicaciones where producto_id = productos.id
    and estado not in ('cerrada', 'vendida') and (ml_item_id is not null
      or (estado = 'publicando' and actualizado_en >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 minutes'))))`;

/** Suma la repetida una sola vez y mantiene su etiqueta vendible en la original. */
async function fusionarBorrador(id: string, request: Request, env: Env, propietario: string): Promise<Response> {
  const { destino_id } = (await request.json()) as { destino_id?: unknown };
  const destinoId = String(destino_id ?? '');
  if (!UUID.test(id) || !UUID.test(destinoId) || id === destinoId) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const piezas = await env.DB.prepare(`select id, codigo, stock, estado_analisis from productos
    where id in (?, ?) and propietario = ?`).bind(id, destinoId, propietario)
    .all<{ id: string; codigo: string | null; stock: number; estado_analisis: string }>();
  if (piezas.results.length !== 2) return json({ error: 'Pieza no encontrada.' }, 404);
  const dosEtiquetas = 'Las dos piezas ya tienen etiqueta: son piezas distintas. Corrige la existencia de cada una o descarta la que no exista.';
  if (piezas.results.every((p) => p.codigo)) return json({ error: dosEtiquetas }, 409);
  const codigo = piezas.results.find((p) => p.id === id)!.codigo || '';
  if (piezas.results.some((p) => p.estado_analisis === 'descartado')) return json({ error: 'La pieza ya fue descartada.' }, 409);
  if (piezas.results.reduce((n, p) => n + p.stock, 0) > 999) {
    return json({ error: 'Con esa suma pasa de 999 piezas en existencia.' }, 409);
  }
  if (await publicacionViva(env, id)) return json({ error: 'Tiene publicación en Mercado Libre: ciérrala primero.' }, 409);
  if (await enPedido(env, id)) return json({ error: 'Está en un pedido: no se puede borrar.' }, 409);

  const ahora = new Date().toISOString();
  let borrado: D1Result;
  try {
    // Cero filas no aborta D1: cualquier precondición falsa fuerza el trigger stock_no_negativo.
    const resultados = await env.DB.batch([
      env.DB.prepare(`update productos set stock = case when
        exists (select 1 from productos where id = ?1 and propietario = ?3
          and coalesce(codigo, '') = ?4 and estado_analisis <> 'descartado' and ${BORRADOR_RETIRABLE})
        and exists (select 1 from productos where id = ?2 and propietario = ?3
          and estado_analisis <> 'descartado' and sin_inventario = 0
          and estado_fisico = (select estado_fisico from productos where id = ?1)
          and (?4 = '' or coalesce(codigo, '') = '')
          and stock + (select stock from productos where id = ?1) <= 999)
        then stock else -1 end where id in (?1, ?2)`).bind(id, destinoId, propietario, codigo),
      env.DB.prepare(`update productos set stock = stock + (select stock from productos where id = ?),
        actualizado_en = ? where id = ?`).bind(id, ahora, destinoId),
      // Liberar primero el código único: la etiqueta pegada debe resolver a la original vendible.
      env.DB.prepare('update productos set codigo = null where id = ? and codigo = ?').bind(id, codigo),
      env.DB.prepare(`update productos set codigo = ? where id = ?
        and (codigo is null or codigo = '') and ? <> ''`).bind(codigo, destinoId, codigo),
      env.DB.prepare("delete from productos where id = ? and (codigo is null or codigo = '')").bind(id),
    ]);
    borrado = resultados[4];
  } catch (error) {
    if (!String(error).includes('stock insuficiente')) throw error;
    const { results } = await env.DB.prepare('select id, codigo from productos where id in (?, ?) and propietario = ?')
      .bind(id, destinoId, propietario).all<{ id: string; codigo: string | null }>();
    return results.length !== 2 ? json({ error: 'Pieza no encontrada.' }, 404)
      : results.every((p) => p.codigo) ? json({ error: dosEtiquetas }, 409)
      : json({ error: 'La pieza cambió, tiene otro grado, fue descartada o tiene venta, pedido o publicación. Revisa y vuelve a intentar.' }, 409);
  }
  if (borrado.meta.changes) await env.FOTOS.delete(`fotos/${id}.jpg`);
  const final = await env.DB.prepare('select stock from productos where id = ?').bind(destinoId).first<{ stock: number }>();
  if (!final) return json({ error: 'Pieza no encontrada.' }, 404);
  return json({ id, destino_id: destinoId, stock: final.stock });
}

async function descartarBorrador(id: string, env: Env, propietario: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  const fila = await env.DB.prepare('select propietario, estado_analisis from productos where id = ?')
    .bind(id).first<{ propietario: string; estado_analisis: string }>();
  if (fila && fila.propietario !== propietario) return json({ error: 'Pieza no encontrada.' }, 404);
  if (!fila || fila.estado_analisis === 'descartado') return json({ id, descartado: true });
  if (await publicacionViva(env, id)) return json({ error: 'Tiene publicación en Mercado Libre: ciérrala primero.' }, 409);
  if (await enPedido(env, id)) return json({ error: 'Está en un pedido: no se puede borrar.' }, 409);
  let borrado: D1Result;
  try {
    const resultados = await env.DB.batch([
      env.DB.prepare(`update productos set stock = case when propietario = ? and ${BORRADOR_RETIRABLE}
        then stock else -1 end where id = ?`).bind(propietario, id),
      env.DB.prepare(`update productos set stock = 0, estado_analisis = 'descartado', actualizado_en = ?
        where id = ? and codigo is not null and codigo <> ''`).bind(new Date().toISOString(), id),
      env.DB.prepare(`delete from productos where id = ? and (codigo is null or codigo = '')
        and estado_analisis <> 'descartado'`).bind(id),
    ]);
    borrado = resultados[2];
  } catch (error) {
    if (!String(error).includes('stock insuficiente')) throw error;
    return json({ error: 'La pieza cambió o tiene venta, pedido o publicación. Revisa y vuelve a intentar.' }, 409);
  }
  if (borrado.meta.changes) await env.FOTOS.delete(`fotos/${id}.jpg`);
  return json({ id, descartado: true });
}

/** Los porcentajes y limites que gobiernan el precio. Solo enteros. */
async function guardarConfig(request: Request, env: Env): Promise<Response> {
  const cambios = (await request.json()) as Record<string, unknown>;
  const entradas = Object.entries(cambios);
  if (entradas.length === 0 || entradas.length > 40) {
    return json({ error: 'Configuracion invalida.' }, 400);
  }
  for (const [clave, valor] of entradas) {
    const numero = Math.round(Number(valor));
    if (!/^[a-z_0-9]{1,40}$/.test(clave) || !Number.isFinite(numero) || numero < 0) {
      return json({ error: `Valor invalido para ${clave}.` }, 400);
    }
    await env.DB.prepare(
      `insert into config (clave, valor) values (?, ?)
       on conflict (clave) do update set valor = excluded.valor`,
    )
      .bind(clave, String(numero))
      .run();
  }
  return json(await leerConfig(env));
}

const FAMILIAS_MAX = 40;

/** Las familias de banda y los siete precios que comparten, para /bandas, el admin y la tarjeta. */
/**
 * Calibracion de la etiquetera (Issue #89): la guarda quien imprime, no solo el
 * dueno, y vive en `config` para que todos los navegadores y el sandbox la
 * compartan. Corrimiento en puntos (puede ser negativo); ancho de barra 2-8.
 */
async function guardarCalibracion(request: Request, env: Env): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { corrimiento?: unknown; modulo?: unknown };
  const cambios: [string, number][] = [];
  if (cuerpo.corrimiento !== undefined) {
    const puntos = Number(cuerpo.corrimiento);
    if (!Number.isInteger(puntos) || Math.abs(puntos) > 200) return json({ error: 'Corrimiento invalido.' }, 400);
    cambios.push(['etiqueta_corrimiento', puntos]);
  }
  if (cuerpo.modulo !== undefined) {
    const puntos = Number(cuerpo.modulo);
    if (!Number.isInteger(puntos) || puntos < 2 || puntos > 8) return json({ error: 'Ancho de barra invalido.' }, 400);
    cambios.push(['etiqueta_modulo', puntos]);
  }
  if (cambios.length === 0) return json({ error: 'Nada que guardar.' }, 400);
  await env.DB.batch(cambios.map(([clave, valor]) =>
    env.DB.prepare(
      `insert into config (clave, valor) values (?, ?) on conflict (clave) do update set valor = excluded.valor`,
    ).bind(clave, String(valor))));
  const config = await leerConfig(env);
  return json({ corrimiento: Number(config.etiqueta_corrimiento ?? 0), modulo: Number(config.etiqueta_modulo ?? 0) });
}

async function listarFamilias(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare('select clave, nombre, prefijo from familias order by rowid').all();
  return json({ montos: MONTOS_BANDA, familias: results });
}

/**
 * Da de alta una familia de banda: su fila en `familias` y sus siete productos
 * de catalogo (sin existencias, como las demas bandas), en un solo batch. El
 * prefijo del codigo sale del nombre y nunca choca con uno ya usado.
 */
async function crearFamilia(request: Request, env: Env): Promise<Response> {
  const { nombre: crudo } = (await request.json()) as { nombre?: unknown };
  const nombre = String(crudo ?? '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (nombre.length < 2 || nombre.length > 24) {
    return json({ error: 'El nombre debe tener entre 2 y 24 caracteres.' }, 400);
  }
  const clave = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!clave) {
    return json({ error: 'El nombre necesita letras o numeros.' }, 400);
  }

  const { results } = await env.DB.prepare('select clave, prefijo from familias').all<{ clave: string; prefijo: string }>();
  if (results.length >= FAMILIAS_MAX) {
    return json({ error: `Ya hay ${FAMILIAS_MAX} familias.` }, 400);
  }
  if (results.some((f) => f.clave === clave)) {
    return json({ error: 'Esa familia ya existe.' }, 409);
  }
  const prefijo = prefijoParaFamilia(nombre, new Set(results.map((f) => f.prefijo)));
  if (!prefijo) {
    return json({ error: 'No se pudo armar un codigo con ese nombre.' }, 400);
  }

  const config = await leerConfig(env);
  const ahora = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('insert into familias (clave, nombre, prefijo, creado_en) values (?, ?, ?, ?)')
      .bind(clave, nombre, prefijo, ahora),
    ...MONTOS_BANDA.map((monto) => env.DB.prepare(
      `insert into productos (id, codigo, nombre, categoria, precio_lista, precio, estado_fisico,
                              estado_analisis, destino, stock, sin_inventario, semana_ingreso,
                              foto_key, creado_en, actualizado_en)
       values (?, ?, ?, 'otros', 0, ?, 'nuevo', 'listo', ?, 0, 1, 'S00', '', ?, ?)`,
    ).bind(
      crypto.randomUUID(), `${prefijo.toUpperCase()}${monto}`, `${nombre} $${monto}`,
      Number.parseInt(config[`banda_${monto}`] ?? '', 10) || monto * 100,
      `banda_${prefijo}${monto}`, ahora, ahora,
    )),
  ]);
  return json({ clave, nombre, prefijo }, 201);
}

/**
 * Catalogo para la caja: se guarda en el navegador y se cobra sin red.
 * Con `?desde=` solo lo que cambio despues (indice de la migracion 038), incluidas
 * las piezas que ya no se venden (precio 0) para que la caja las quite. Traer las
 * ~3000 piezas cada minuto agotaba la cuota diaria de lecturas de D1 (15/10).
 */
async function catalogo(env: Env, url: URL): Promise<Response> {
  const desde = url.searchParams.get('desde');
  if (desde !== null) {
    if (!Number.isFinite(Date.parse(desde))) return json({ error: 'Fecha invalida.' }, 400);
    const ahora = new Date().toISOString();
    const { results } = await env.DB.prepare(
      `select id, codigo, nombre, case when estado_analisis = 'descartado' then 0 else precio end as precio, sin_inventario, stock, propietario
       from productos where actualizado_en > ? and codigo is not null and codigo <> ''`,
    ).bind(new Date(desde).toISOString()).all();
    return json({ ahora, piezas: results });
  }
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, precio, sin_inventario, stock, propietario
     from productos where codigo is not null and codigo <> '' and precio > 0 and estado_analisis <> 'descartado'
     order by nombre`,
  ).all();
  return json(results);
}

interface LineaVenta {
  codigo?: unknown;
  nombre?: unknown;
  precio?: unknown;
  cantidad?: unknown;
  producto_id?: unknown;
}

interface ProductoVenta {
  id: string;
  codigo: string | null;
  nombre: string;
  precio: number;
  sin_inventario: number;
  propietario?: string;
  precio_anterior?: number | null;
  precio_cambiado_en?: string | null;
}

// El precio que mostro la caja gana si es el anterior y el cambio es reciente (decision 7/10).
const VENTANA_PRECIO_ANTERIOR = 10 * 60_000;

interface LineaPreparada {
  producto_id: string;
  codigo: string;
  nombre: string;
  precio: number;
  cantidad: number;
  sinInventario: boolean;
  propietario: string;
}

/**
 * Del navegador solo se confia el producto y la cantidad: precio, nombre y
 * codigo salen del catalogo del servidor. Unica excepcion: el precio de la caja
 * vale si es exactamente el precio anterior y el cambio fue hace menos de 10
 * min de la hora de la venta (la caja aun no refrescaba el catalogo). Es
 * pura a proposito, para poder probarla sin D1: worker.ts solo junta el mapa
 * de productos antes de llamarla.
 */
export function prepararLineas(
  lineasCliente: LineaVenta[],
  productos: Map<string, ProductoVenta>,
  horaVenta = Date.now(),
): { ok: true; lineas: LineaPreparada[] } | { ok: false; error: string } {
  if (lineasCliente.length === 0) {
    return { ok: false, error: 'La venta no tiene piezas.' };
  }
  const lineas: LineaPreparada[] = [];
  for (const l of lineasCliente) {
    const cantidad = Number(l.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999) {
      return { ok: false, error: 'Cantidad invalida.' };
    }
    const productoId = String(l.producto_id ?? '');
    const producto = productos.get(productoId);
    if (!producto) {
      return { ok: false, error: 'Producto inexistente.' };
    }
    const cambio = Date.parse(producto.precio_cambiado_en ?? '');
    const precioCaja = Number.isInteger(l.precio) && l.precio === producto.precio_anterior
      && horaVenta <= cambio + VENTANA_PRECIO_ANTERIOR;
    lineas.push({
      producto_id: producto.id,
      codigo: producto.codigo ?? '',
      nombre: producto.nombre,
      precio: precioCaja ? (l.precio as number) : producto.precio,
      cantidad,
      sinInventario: producto.sin_inventario === 1,
      propietario: producto.propietario ?? 'dolaron',
    });
  }
  return { ok: true, lineas };
}

/**
 * Registra una venta. Idempotente por `id`: la caja lo genera antes de cobrar,
 * asi que reenviar la cola despues de una red caida no duplica el ticket ni
 * vuelve a descontar existencias.
 */
async function registrarVenta(request: Request, env: Env, ctx: ExecutionContext, correo: string): Promise<Response> {
  const venta = (await request.json()) as {
    id?: unknown; lineas?: unknown; forma_pago?: unknown;
    efectivo?: unknown; creado_en?: unknown;
    cliente_id?: unknown; dolarones?: unknown; codigo_socio?: unknown; codigo_vale?: unknown; caja?: unknown; imprimir_en?: unknown;
    descuento_id?: unknown; promo?: unknown; sin_red?: unknown; pedido_id?: unknown; anticipo?: unknown;
  };
  const id = String(venta.id ?? '');
  if (!UUID.test(id)) {
    return json({ error: 'Identificador de venta invalido.' }, 400);
  }
  if (!Array.isArray(venta.lineas) || venta.lineas.length === 0) {
    return json({ error: 'La venta no tiene piezas.' }, 400);
  }
  if (venta.lineas.some((l) => !l || typeof l !== 'object' || Array.isArray(l))) {
    return json({ error: 'Línea de venta inválida.' }, 400);
  }
  const formaPago = String(venta.forma_pago ?? 'efectivo');
  if (!FORMAS_PAGO.has(formaPago)) {
    return json({ error: 'Forma de pago invalida.' }, 400);
  }
  const imprimirEn = venta.imprimir_en === undefined ? null : venta.imprimir_en;
  if (venta.imprimir_en !== undefined && !estacionValida(imprimirEn)) {
    return json({ error: 'Caja invalida.' }, 400);
  }
  if (imprimirEn && formaPago === 'efectivo') {
    return json({ error: 'En el celular sólo tarjeta o transferencia; no se puede cobrar efectivo con impresión remota.' }, 400);
  }

  // Se compara el pedido que mando la caja, no el catalogo actual: un precio
  // cambiado despues de una venta no debe romper un reintento legitimo.
  // imprimir_en es el destino del papel, no el pedido: el primer registro lo
  // fija; reintentar desde otra estación no mueve ni duplica el ticket.
  const pedido = JSON.stringify({
    lineas:(venta.lineas as LineaVenta[]).map((l) => [String(l.producto_id ?? ''), l.cantidad]),
    forma_pago:formaPago, efectivo:venta.efectivo ?? 0, creado_en:venta.creado_en ?? null,
    cliente_id:venta.cliente_id ?? null, dolarones:venta.dolarones ?? 0,
    codigo_socio:venta.codigo_socio ?? '', codigo_vale:venta.codigo_vale ?? '',
    caja:venta.caja ?? null,
    // Solo si lo trae: el hash de las ventas sin descuento no cambia y sus reintentos siguen valiendo.
    ...(venta.descuento_id ? { descuento_id:venta.descuento_id } : {}),
    ...(venta.promo ? { promo:venta.promo } : {}),
    ...(venta.pedido_id ? { pedido_id:venta.pedido_id, anticipo:venta.anticipo ?? 0 } : {}),
  });
  const pedidoHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pedido)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const reintento = async (): Promise<Response | null> => {
    const previo = await env.DB.prepare('select pedido_hash, imprimir_en, anticipo, pedido_id from ventas where id = ?').bind(id)
      .first<{ pedido_hash:string | null; imprimir_en:string | null; anticipo:number; pedido_id:string | null }>();
    if (!previo) return null;
    // null: venta registrada antes de la migracion 021, se acepta como antes.
    if (previo.pedido_hash !== null && previo.pedido_hash !== pedidoHash)
      return json({ error:'El folio ya pertenece a otra venta. Revisa la venta original antes de reintentar.' }, 409);
    const ganado = await env.DB.prepare(`select coalesce(sum(importe), 0) as importe from dolarones_movimientos
      where venta_id = ? and tipo = 'compra'`).bind(id).first<{ importe:number }>();
    const respuesta = json({ id, duplicada:true, imprimir_en:previo.imprimir_en, ganados:ganado?.importe ?? 0,
      anticipo:previo.anticipo, saldo_pedido:previo.pedido_id ? await saldoDe(env, previo.pedido_id) : null,
      vale_emitido:await valeDeVenta(env, id), vale_usado:await valeUsadoEnVenta(env, id) }, 200);
    respuesta.headers.set('cache-control', 'no-store');
    return respuesta;
  };
  const yaExiste = await reintento();
  if (yaExiste) return yaExiste;

  const idsPedidos = [...new Set((venta.lineas as LineaVenta[]).map((l) => String(l.producto_id ?? '')))];
  if (idsPedidos.some((pid) => !UUID.test(pid))) {
    return json({ error: 'Producto inexistente.' }, 400);
  }
  const huecos = idsPedidos.map(() => '?').join(',');
  const { results: filas } = await env.DB.prepare(
    `select id, codigo, nombre, precio, sin_inventario, propietario, precio_anterior, precio_cambiado_en from productos where id in (${huecos})`,
  )
    .bind(...idsPedidos)
    .all<ProductoVenta>();
  const productos = new Map(filas.map((f) => [f.id, f]));

  // Hora fiable de la venta (la de la caja): una hora futura no se acepta.
  const horaCaja = Date.parse(String(venta.creado_en ?? ''));
  const horaVenta = Number.isFinite(horaCaja) && horaCaja <= Date.now() + 300_000 ? horaCaja : Date.now();
  const preparado = prepararLineas(venta.lineas as LineaVenta[], productos, horaVenta);
  if (!preparado.ok) {
    return json({ error: preparado.error }, 400);
  }

  const subtotal = preparado.lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  // Un descuento solo entra si el dueno lo aprobo (Issue #119); validarDescuento dice para que ticket.
  const descuentoId = venta.descuento_id ? String(venta.descuento_id) : null;
  let descuento = 0;
  if (descuentoId) {
    const valido = await validarDescuento(env, descuentoId, subtotal);
    if (!valido.ok) return json({ error: valido.error }, valido.status);
    descuento = valido.monto;
  }
  // Promo de inauguracion con la hora de la venta en la caja (una venta encolada
  // sin red conserva la promo que vio el cliente). Se guarda sumada en
  // `descuento`: devoluciones la prorratea igual.
  // La caja manda la promo que mostro (una caja vieja no la manda: se asume la que corresponde).
  const elegible = promoInauguracion(subtotal, horaVenta, promoDe(env));
  const promo = venta.promo === undefined || Number(venta.promo) > 0 ? elegible : 0;
  // Con cupo agotado, un cobro en linea se rechaza y la caja vuelve a cobrar sin promo. Una venta
  // cobrada sin red ya se pago con la promo: se respeta aunque pase del tope (nunca se pierde).
  // ponytail: contar y luego insertar deja que dos cajas al mismo instante tomen el ultimo lugar; pasa por uno.
  if (promo && venta.sin_red !== true && await promoRestantes(env) === 0)
    return json({ error:'Ya se entregaron todos los descuentos de inauguración. Vuelve a cobrar: el ticket queda sin promo.', promo_agotada:true }, 409);
  descuento += promo;
  const total = subtotal - descuento;
  const efectivo = Math.max(0, Math.round(Number(venta.efectivo ?? 0)));
  const clienteId = venta.cliente_id ? String(venta.cliente_id) : null;
  const codigoVale = String(venta.codigo_vale ?? '');
  const dolarones = Number(venta.dolarones ?? 0);
  // Anticipo = saldo de un pedido que paga parte del ticket (Issue #269). Sin pedido no hay anticipo.
  const pedidoId = venta.pedido_id ? String(venta.pedido_id) : null;
  const anticipo = pedidoId ? Number(venta.anticipo ?? 0) : 0;
  if (pedidoId ? !UUID.test(pedidoId) || !Number.isInteger(anticipo) || anticipo < 0 : Number(venta.anticipo ?? 0) !== 0)
    return json({ error: 'Pedido o anticipo invalido.' }, 400);
  const porPagar = total - (Number.isInteger(dolarones) ? dolarones : 0);
  if (anticipo > porPagar) return json({ error: 'El anticipo no puede pasar de lo que se cobra.' }, 400);
  const aPagar = porPagar - anticipo;
  if (!efectivoAlcanza({ formaPago, total: aPagar, efectivo })) {
    return json({ error: 'El efectivo no alcanza para el total.' }, 400);
  }

  const momento = new Date();
  const ahora = momento.toISOString();
  // La misma hora fiable: una fecha ilegible o futura (reloj de la caja mal puesto) mandaria la venta a otro
  // dia y fuera de los reportes y de la ventana de cancelacion. Una venta sin red conserva su hora.
  const creadoEn = new Date(horaVenta).toISOString();

  // Valida socio, código y saldo; consumo y venta se confirman en el mismo batch.
  const recompensa = await sentenciasDeVenta(env, {
    ventaId: id, clienteId, dolarones:codigoVale ? 0 : dolarones, codigo: String(venta.codigo_socio ?? ''), total, autor: correo, ahora: momento,
  });
  if (!recompensa.ok) {
    const concurrente = await reintento();
    if (concurrente) return concurrente;
    return json({ error: recompensa.error }, recompensa.status);
  }
  const vale = await sentenciasVale(env, {
    ventaId:id, clienteId, codigo:codigoVale, dolarones, total, autor:correo, ahora:momento,
  });
  if (!vale.ok) {
    const concurrente = await reintento();
    if (concurrente) return concurrente;
    return json({ error:vale.error }, vale.status);
  }

  const conPedido = pedidoId ? await sentenciasDePedido(env, { pedidoId, ventaId: id, anticipo, ahora }) : null;
  if (conPedido && !conPedido.ok) {
    const concurrente = await reintento();
    if (concurrente) return concurrente;
    return json({ error: conPedido.error }, conPedido.status);
  }

  const sentencias = [
    env.DB.prepare(
      `insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en, cliente_id, dolarones,
                           caja, cajero, pedido_hash, imprimir_en, descuento, descuento_id, promo, anticipo, pedido_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, total, formaPago, efectivo, Math.max(0, efectivo - aPagar), creadoEn, ahora, clienteId, dolarones,
      // Quien cobro sale de Access; la caja es la suya (Issue #105) o la de la
      // computadora. Una venta encolada antes del corte de caja llega sin caja: ''.
      await cajaDe(env, correo, venta.caja), correo, pedidoHash, imprimirEn, descuento, descuentoId, promo, anticipo, pedidoId),
    ...preparado.lineas.map((l) =>
      env.DB.prepare(
        `insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad, propietario)
         values (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, l.producto_id, l.codigo, l.nombre, l.precio, l.cantidad, l.propietario),
    ),
    // Con pedido: sus piezas apartadas vuelven a la venta y se gasta el saldo ANTES de descontar las de
    // este ticket (si no, el trigger de stock aborta), pero despues del insert de la venta (FK pedidos.venta_id).
    ...(conPedido?.sentencias ?? []),
    // Los bins no descuentan: nadie cuenta cuantas piezas quedan en un bote.
    // Sin `max(0, ...)`: si dos ventas concurrentes se pelean la ultima pieza,
    // el trigger `stock_no_negativo` (migracion 006) aborta esta sentencia y
    // con ella todo el batch, en vez de dejar que ambas "ganen".
    ...preparado.lineas
      .filter((l) => !l.sinInventario)
      .map((l) =>
        env.DB.prepare(
          `update productos set stock = stock - ?, actualizado_en = ? where id = ?`,
        ).bind(l.cantidad, ahora, l.producto_id),
      ),
    ...recompensa.sentencias,
    ...vale.sentencias,
  ];

  // Todo junto: un ticket a medias descuadra el corte del dia, y un canje a
  // medias descuadra el saldo del cliente.
  try {
    await env.DB.batch(sentencias);
  } catch (error) {
    // Un segundo cajero pudo confirmar este folio despues de la lectura inicial.
    // Solo el mismo pedido obtiene respuesta idempotente; otros errores siguen visibles.
    const concurrente = await reintento();
    if (concurrente) return concurrente;
    if (String(error).includes('saldo de vale invalido'))
      return json({ error:'El vale cambió, venció o se agotó. Vuelve a escanearlo.' }, 409);
    if (String(error).includes('codigo de socio invalido')) {
      return json({ error: 'Código de socio usado, vencido o actualizado. Pide otro al cliente.' }, 409);
    }
    if (String(error).includes('stock insuficiente')) {
      return json({ error: 'No hay existencia suficiente para completar la venta.' }, 409);
    }
    if (String(error).includes('saldo insuficiente')) {
      return json({ error: 'El saldo de Dolarones cambio. Vuelve a buscar al socio.' }, 409);
    }
    // Trigger pedido_saldo_valido (migracion 033): otra venta gasto el saldo o ya vencio.
    if (pedidoId && String(error).includes('saldo de pedido invalido')) {
      return json({ error: 'El saldo del pedido cambió o venció. Vuelve a cargarlo.' }, 409);
    }
    if (descuentoId && String(error).includes('descuento_id')) {
      return json({ error: 'Ese descuento ya se uso en otra venta.' }, 409);
    }
    throw error;
  }
  // Si una pieza publicada en Mercado Libre se agoto, se pausa alla (D1 manda). Despues de responder.
  ctx.waitUntil(conciliarSeguro(env, { productoIds: preparado.lineas.filter((l) => !l.sinInventario).map((l) => l.producto_id) }));
  const respuesta = json({
    id, total, descuento, dolarones, imprimir_en:imprimirEn, cambio: Math.max(0, efectivo - aPagar), ganados: recompensa.ganados,
    anticipo, saldo_pedido: pedidoId ? await saldoDe(env, pedidoId) : null,
    saldo: clienteId ? await saldo(env, clienteId, ahora) : null,
    vale_emitido:vale.emitido,
    vale_usado:await valeUsadoEnVenta(env, id),
  }, 201);
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}

/** Últimas 3 h desde la aceptación: una venta sin red entra al sincronizar. */
async function listarImpresiones(url: URL, env: Env, correo: string): Promise<Response> {
  const pedida = url.searchParams.get('caja');
  if (!estacionValida(pedida)) return json({ error: 'Estación de impresión inválida.' }, 400);
  const caja = await cajaDe(env, correo, pedida);
  const { results } = await env.DB.prepare(`select id from ventas
    where imprimir_en = ? and impreso_en is null and cancelada = 0 and registrado_en >= ?
    order by registrado_en, id limit 10`)
    .bind(caja, new Date(Date.now() - 3 * 3600_000).toISOString()).all<{ id:string }>();
  const tickets = [];
  for (const { id } of results) tickets.push(await (await detalleVenta(id, env, true)).json());
  const respuesta = json(tickets);
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}

async function tomarImpresion(id: string, request: Request, env: Env, correo: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador de venta inválido.' }, 400);
  const cuerpo = await request.json().catch(() => ({})) as { caja?: unknown } | null;
  const pedida = cuerpo?.caja;
  if (!estacionValida(pedida))
    return json({ error: 'Estación de impresión inválida.' }, 400);
  const caja = await cajaDe(env, correo, pedida);
  const ahora = new Date().toISOString();
  // ponytail: tomar antes del USB evita duplicados; si falla o se cierra la
  // pestaña después, se reimprime manualmente desde Ventas de hoy.
  const { meta } = await env.DB.prepare(`update ventas set impreso_en = ?
    where id = ? and imprimir_en = ? and impreso_en is null and cancelada = 0`)
    .bind(ahora, id, caja).run();
  if (!meta.changes) return json({ error: 'Ticket ya tomado, cancelado o no pendiente en esta estación.' }, 409);
  return json({ id, impreso_en:ahora });
}

// La tienda esta en America/Mexico_City: UTC-6 fijo desde 2022, sin horario de
// verano. Las ventas se guardan en UTC, asi que despues de las 18:00 locales ya
// son "manana" en UTC; el dia de la tienda se saca restando 6 horas. Sin esto,
// el corte de las 20:00 solo veia lo vendido de 18:00 a 20:00 (Issue #93).
const diaTienda = (columna: string) => `substr(datetime(${columna}, '-6 hours'), 1, 10)`;
export const hoyTienda = (ahora = Date.now()) => new Date(ahora - 6 * 3_600_000).toISOString().slice(0, 10);
const DIA = /^\d{4}-\d{2}-\d{2}$/;
/**
 * [00:00, 24:00) de un dia de la tienda, en UTC. Para filtrar se compara la columna
 * tal cual: diaTienda() en el WHERE obliga a D1 a leer toda la tabla en cada
 * consulta, y la caja pide el corte del dia seguido (agoto la cuota diaria, 15/10).
 */
const delDia = (dia: string) => {
  const apertura = (d: string) => `${d}T06:00:00.000Z`;
  return [apertura(dia), apertura(new Date(Date.parse(`${dia}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10))];
};

/**
 * Los `dias` dias completos de la tienda que terminan hoy (Issue #166): el primero
 * empieza a las 00:00 de la tienda, no «hace N x 24 h», para que un dia nunca salga
 * a medias. `anterior_desde` abre el periodo de igual largo justo antes, para comparar.
 */
export function rangoDias(dias: number, ahora = Date.now()) {
  const apertura = (dia: string) => `${dia}T06:00:00.000Z`;   // 00:00 en UTC-6
  const primero = hoyTienda(ahora - (dias - 1) * 86_400_000);
  return {
    dias, dia_desde: primero, dia_hasta: hoyTienda(ahora), desde: apertura(primero),
    anterior_desde: apertura(hoyTienda(ahora - (2 * dias - 1) * 86_400_000)),
  };
}
// `dias=abc` daba NaN y tumbaba el reporte con 500: un valor que no es numero vale el de omision.
const rangoDe = (url: URL) => {
  const dias = Math.round(Number(url.searchParams.get('dias') ?? 30));
  return rangoDias(Number.isFinite(dias) ? Math.min(365, Math.max(1, dias)) : 30);
};

// Lo que lleva un renglon de la lista de tickets (ticket.js `renglonTicket`), del dia o del rango.
const COLUMNAS_TICKET = `v.id, v.total, v.forma_pago, v.cancelada, v.creado_en, v.dolarones, v.devuelto, v.dolarones_devueltos,
            v.caja, v.cajero, v.cliente_id is not null as con_socio,
            (select group_concat(nombre, ' · ') from venta_lineas where venta_id = v.id) as piezas,
            (select coalesce(sum(cantidad), 0) from venta_lineas where venta_id = v.id) as cantidad,
            (select coalesce(sum(cancelada_cantidad), 0) from venta_lineas where venta_id = v.id) as cancelada_cantidad`;

/** Tickets de un dia (hoy si no se dice): la caja cancela el que se cobro mal; reportes solo los ve. */
async function ventasDelDia(url: URL, env: Env): Promise<Response> {
  const dia = url.searchParams.get('dia') ?? hoyTienda();
  if (!DIA.test(dia)) return json({ error: 'Dia invalido.' }, 400);
  const { results } = await env.DB.prepare(
    `select ${COLUMNAS_TICKET}
     from ventas v where v.creado_en >= ? and v.creado_en < ?
     order by v.creado_en desc limit 300`,
  )
    .bind(...delDia(dia))
    .all();
  return json(results);
}

/**
 * El boton «Abrir cajon» (Issue #97): quien y cuando. El cajon ya se abrio en
 * la caja; esto solo lo registra, y puede llegar tarde si no habia red.
 * Idempotente por id, como las ventas.
 */
async function registrarAperturaCajon(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as { id?: unknown; abierto_en?: unknown; caja?: unknown };
  const id = String(cuerpo.id ?? '');
  const abiertoEn = String(cuerpo.abierto_en ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (Number.isNaN(Date.parse(abiertoEn))) return json({ error: 'Fecha invalida.' }, 400);
  await env.DB.prepare(
    `insert into cajon_aperturas (id, abierto_por, abierto_en, registrado_en, caja) values (?, ?, ?, ?, ?)
     on conflict (id) do nothing`,
  )
    .bind(id, correo, new Date(abiertoEn).toISOString(), new Date().toISOString(), await cajaDe(env, correo, cuerpo.caja))
    .run();
  return json({ id }, 201);
}

/** Corte del dia: lo que hay que cuadrar contra el efectivo en la caja. */
async function corte(url: URL, env: Env): Promise<Response> {
  const dia = url.searchParams.get('dia') ?? hoyTienda();
  if (!DIA.test(dia)) return json({ error: 'Dia invalido.' }, 400);
  const rango = delDia(dia);
  // Las canceladas no cuentan: el corte es contra el efectivo que hay en el cajon.
  const { results } = await env.DB.prepare(
    `select forma_pago, sum(tickets) as tickets, sum(total) as total, sum(dolarones) as dolarones from (
       -- Lo devuelto en cupón (Issue #330) se quedó en el cajón.
       select forma_pago, count(*) as tickets, sum(total - dolarones - anticipo - devuelto + devuelto_cupon) as total,
              sum(dolarones - dolarones_devueltos) as dolarones
       from ventas where creado_en >= ? and creado_en < ? and cancelada = 0 group by forma_pago
       union all
       select forma_pago, 0, sum(anticipo), 0 from pedidos where creado_en >= ? and creado_en < ? group by forma_pago
     ) group by forma_pago`,
  )
    .bind(...rango, ...rango)
    .all<{ forma_pago: string; tickets: number; total: number; dolarones: number }>();

  const piezas = await env.DB.prepare(
    `select coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) as piezas from venta_lineas l
     join ventas v on v.id = l.venta_id
     where v.creado_en >= ? and v.creado_en < ? and v.cancelada = 0`,
  )
    .bind(...rango)
    .first<{ piezas: number }>();

  return json({
    dia,
    piezas: piezas?.piezas ?? 0,
    // Dinero que debe haber entre cajon y terminal; lo pagado con Dolarones va aparte. Los anticipos de
    // pedidos entran el dia que se recibieron y las ventas restan el saldo que gastaron (Issue #269).
    total: results.reduce((suma, fila) => suma + (fila.total ?? 0), 0),
    dolarones: results.reduce((suma, fila) => suma + (fila.dolarones ?? 0), 0),
    por_forma_pago: results,
  });
}

/**
 * Foto de lo que hay en piso AHORA (Issue #174), sin importar el periodo del reporte: piezas individuales
 * ya etiquetadas (con codigo) y con existencia. Quedan fuera las bandas (no tienen fecha de captura propia),
 * lo agotado y lo que aun esta en la cola de revision sin etiqueta. Las danadas SI cuentan: estan en piso.
 * Antiguedad = dias de la tienda (UTC-6) desde `creado_en`, y los tramos van por semanas completas.
 * Una fecha vacia o invalida no se adivina: va aparte, en `sin_fecha`.
 */
async function inventarioEnPiso(env: Env, ahora = Date.now()) {
  // ponytail: se trae toda la lista y se suma en JS; con decenas de miles de piezas en piso conviene agrupar en SQL.
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, coalesce(nullif(categoria, ''), 'sin categoria') as categoria, precio, stock, creado_en,
       case when julianday(creado_en) is null then null
            else max(0, cast(julianday(?) - julianday(substr(datetime(creado_en, '-6 hours'), 1, 10)) as integer)) end as dias
     from productos
     where sin_inventario = 0 and stock > 0 and destino = 'etiqueta' and codigo is not null and codigo != ''
       and propietario = 'dolaron'`,
  )
    .bind(hoyTienda(ahora))
    .all<{ id: string; codigo: string; nombre: string; categoria: string; precio: number; stock: number; creado_en: string; dias: number | null }>();

  const valorDe = (f: { precio: number; stock: number }) => f.precio * f.stock;
  const tramos = new Map(TRAMOS_ANTIGUEDAD.map(([clave]) => [clave, { tramo: clave, piezas: 0, valor: 0 }]));
  const sinFecha = { piezas: 0, valor: 0 };
  const categorias = new Map<string, { categoria: string; piezas: number; valor: number; sumaDias: number; fechadas: number }>();
  for (const f of results) {
    const grupo = (f.dias === null ? sinFecha : tramos.get(tramoDeDias(f.dias)))!;
    grupo.piezas += 1;
    grupo.valor += valorDe(f);
    const c = categorias.get(f.categoria) ?? { categoria: f.categoria, piezas: 0, valor: 0, sumaDias: 0, fechadas: 0 };
    c.piezas += 1;
    c.valor += valorDe(f);
    if (f.dias !== null) { c.sumaDias += f.dias; c.fechadas += 1; }
    categorias.set(f.categoria, c);
  }
  return {
    piezas: results.length,
    unidades: results.reduce((suma, f) => suma + f.stock, 0),
    valor: results.reduce((suma, f) => suma + valorDe(f), 0),
    por_antiguedad: [...tramos.values()],
    sin_fecha: sinFecha,
    por_categoria: [...categorias.values()]
      .map(({ sumaDias, fechadas, ...c }) => ({ ...c, dias_promedio: fechadas ? sumaDias / fechadas : null }))
      .sort((a, b) => b.valor - a.valor || a.categoria.localeCompare(b.categoria)),
    mas_viejas: results.filter((f) => f.dias !== null)
      .sort((a, b) => b.dias! - a.dias! || valorDe(b) - valorDe(a) || a.codigo.localeCompare(b.codigo))
      .slice(0, 15)
      .map(({ id, codigo, nombre, categoria, precio, stock, creado_en, dias }) => ({ id, codigo, nombre, categoria, precio, stock, creado_en, dias })),
  };
}

/**
 * Reportes: todo sale de consultas contra D1 en el momento, nada se precalcula
 * ni vive en otra tabla. `dias` acota lo que tiene sentido por rango (ventas del
 * dia, categoria, top de piezas); precio sugerido y dias en venta son de
 * siempre, porque son pocos datos y la pregunta que responden no es "esta
 * semana" sino "en general". `inventario` es la foto de ahora: tampoco depende de `dias`.
 */
async function reportes(url: URL, env: Env): Promise<Response> {
  const rango = rangoDe(url);
  const { dias, desde } = rango;

  // Solo lo de la tienda (propietario 'dolaron', Issue #298): el neto de cada ticket va repartido por pieza.
  const resumen = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select count(distinct venta) as ventas, coalesce(sum(neta), 0) as total, coalesce(sum(cant), 0) as piezas
     from netas where propietario = 'dolaron'`,
  )
    .bind(desde)
    .first<{ ventas: number; total: number; piezas: number }>();

  // El periodo de igual largo justo antes, para las flechas de «vs periodo anterior».
  const anterior = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
     select count(distinct venta) as ventas, coalesce(sum(neta), 0) as total, coalesce(sum(cant), 0) as piezas
     from netas where propietario = 'dolaron'`,
  )
    .bind(rango.anterior_desde, desde)
    .first<{ ventas: number; total: number; piezas: number }>();

  // De bruto a vendido, sin que sobre ni falte un centavo: lo cobrado en todos los
  // tickets, menos lo devuelto por piezas, menos lo que valian los cancelados completos.
  const cuadre = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select (select coalesce(sum(total), 0) from ventas where creado_en >= ?) as bruto,
       (select coalesce(sum(devuelto + dolarones_devueltos), 0) from ventas where creado_en >= ?) as devoluciones_pieza,
       (select coalesce(sum(case when cancelada = 1 then total - devuelto - dolarones_devueltos end), 0) from ventas where creado_en >= ?) as cancelados,
       (select coalesce(sum(neta), 0) from netas where propietario = 'fep') as fep`,
  )
    .bind(desde, desde, desde, desde)
    .first<{ bruto: number; devoluciones_pieza: number; cancelados: number; fep: number }>();

  // Lo cobrado en dinero por forma de pago, y lo pagado con Dolarones como una forma mas.
  const { results: porFormaPago } = await env.DB.prepare(
    // Cobrado en el ticket (netas.ts ya descuenta el anticipo) mas el anticipo de los pedidos recibidos
    // en el periodo: el dinero entra el dia del apartado, no el de la venta. Los Dolarones usados
    // (neta - cobrado - anticipo) van en su propia fila.
    `${lineasNetas('v.creado_en >= ?')}
     select forma_pago, sum(tickets) as tickets, sum(total) as total from (
       select forma_pago, count(distinct venta) as tickets, coalesce(sum(cobrado), 0) as total
       from cobros where propietario = 'dolaron' group by forma_pago
       union all
       select forma_pago, 0, coalesce(sum(anticipo), 0) from pedidos where creado_en >= ? group by forma_pago
       union all
       select 'dolarones', count(distinct case when neta - cobrado - anticipo_linea <> 0 then venta end),
         coalesce(sum(neta - cobrado - anticipo_linea), 0)
       from cobros where propietario = 'dolaron'
     ) group by forma_pago`,
  )
    .bind(desde, desde)
    .all<{ forma_pago: string; tickets: number; total: number }>();

  const { results: ventasPorDia } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select ${diaTienda('creado_en')} as dia, count(distinct venta) as tickets, sum(neta) as total
     from netas where propietario = 'dolaron' group by dia order by dia`,
  )
    .bind(desde)
    .all<{ dia: string; tickets: number; total: number }>();
  const { results: piezasPorDia } = await env.DB.prepare(
    `select ${diaTienda('v.creado_en')} as dia, coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) as piezas
     from venta_lineas l join ventas v on v.id = l.venta_id
     where v.cancelada = 0 and v.creado_en >= ? and l.propietario = 'dolaron' group by dia`,
  )
    .bind(desde)
    .all<{ dia: string; piezas: number }>();
  const piezasPorDiaMapa = new Map(piezasPorDia.map((f) => [f.dia, f.piezas]));
  const porDia = ventasPorDia.map((f) => ({ ...f, piezas: piezasPorDiaMapa.get(f.dia) ?? 0 }));

  // Mapa de calor de /reportes: dia de la semana (0 = domingo, como %w) y hora, ambos de la tienda (UTC-6).
  const { results: porHora } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select cast(strftime('%w', datetime(creado_en, '-6 hours')) as integer) as dia_semana,
       cast(strftime('%H', datetime(creado_en, '-6 hours')) as integer) as hora,
       count(distinct venta) as tickets, sum(neta) as total
     from netas where propietario = 'dolaron' group by dia_semana, hora order by dia_semana, hora`,
  )
    .bind(desde)
    .all<{ dia_semana: number; hora: number; tickets: number; total: number }>();

  // Lo vendido por categoria (las bandas juntas), del periodo y del anterior de igual largo: mismas reglas en los dos.
  const ventasPorCategoria = (anteriorAlPeriodo: boolean) => env.DB.prepare(
    `${lineasNetas(`v.creado_en >= ? ${anteriorAlPeriodo ? 'and v.creado_en < ?' : ''}`)}
     select case when p.sin_inventario = 1 then 'bandas' else coalesce(nullif(p.categoria, ''), 'sin categoria') end as categoria,
       coalesce(sum(n.neta), 0) as total, coalesce(sum(n.cant), 0) as piezas
     from netas n left join productos p on p.id = n.producto_id
     where n.propietario = 'dolaron'
     group by categoria order by total desc`,
  )
    .bind(...(anteriorAlPeriodo ? [rango.anterior_desde, desde] : [desde]))
    .all<{ categoria: string; total: number; piezas: number }>();
  const { results: porCategoria } = await ventasPorCategoria(false);
  const { results: porCategoriaAnterior } = await ventasPorCategoria(true);

  const { results: topProductos } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ?')}
     select codigo, nombre, sum(cant) as cantidad, sum(neta) as total
     from netas where producto_id is not null and cant > 0 and propietario = 'dolaron'
     group by codigo, nombre order by cantidad desc, total desc limit 10`,
  )
    .bind(desde)
    .all<{ codigo: string; nombre: string; cantidad: number; total: number }>();

  // Cuanto se aleja lo que de verdad se cobra de lo que propuso la IA: la razon
  // por la que existe precio_sugerido (migracion 002) es poder responder esto
  // con datos en vez de ajustar los porcentajes a ojo.
  const precioSugerido = await env.DB.prepare(
    `select count(*) as n, avg((precio - precio_sugerido) * 100.0 / precio_sugerido) as promedio_pct
     from productos where precio_sugerido > 0 and precio > 0 and propietario = 'dolaron'`,
  ).first<{ n: number; promedio_pct: number | null }>();

  // Diferido a proposito en CONTRATO-ESCANER.md hasta que hubiera ventas reales.
  const { results: diasEnVenta } = await env.DB.prepare(
    `select coalesce(nullif(p.categoria, ''), 'sin categoria') as categoria,
       avg(julianday(substr(v.creado_en, 1, 10)) - julianday(substr(p.creado_en, 1, 10))) as dias_promedio,
       count(*) as n
     from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where v.cancelada = 0 and p.sin_inventario = 0 and l.cantidad > l.cancelada_cantidad and l.propietario = 'dolaron'
     group by categoria order by dias_promedio desc`,
  ).all<{ categoria: string; dias_promedio: number; n: number }>();

  // Devoluciones, de ticket completo o de piezas sueltas (Issue #138): el motivo y quien cancelo son la unica huella de una
  // cancelacion que no fue legitima (cobrar de verdad y "cancelar" para
  // quedarse el efectivo). Se listan una por una, no solo el total.
  const { results: cancelaciones } = await env.DB.prepare(
    `select v.id, v.total - v.dolarones - v.devuelto as total, v.dolarones - v.dolarones_devueltos as dolarones,
       v.forma_pago, v.cancelada_en, v.cancelada_por, v.motivo_cancelacion,
       (select group_concat(nombre, ' · ') from venta_lineas
        where venta_id = v.id and cantidad > cancelada_cantidad) as piezas, 'ticket' as tipo
     from ventas v where v.cancelada = 1 and v.creado_en >= ?
     union all
     select d.venta_id, d.importe, d.dolarones, d.forma_pago, d.creado_en, d.autor, d.motivo,
       d.cantidad || ' × ' || l.nombre, 'pieza'
     from devoluciones d join venta_lineas l on l.id = d.linea_id join ventas v on v.id = d.venta_id
     where v.creado_en >= ?
     order by 5 desc`,
  )
    .bind(desde, desde)
    .all<{
      id: string; total: number; dolarones: number; forma_pago: string; cancelada_en: string;
      cancelada_por: string; motivo_cancelacion: string; piezas: string; tipo: string;
    }>();

  const { results: aperturas } = await env.DB.prepare(
    `select abierto_en, abierto_por, caja from cajon_aperturas where abierto_en >= ? order by abierto_en desc`,
  )
    .bind(desde)
    .all<{ abierto_en: string; abierto_por: string; caja: string }>();

  const { results: cortes } = await env.DB.prepare(
    `select id, caja, cajero, desde, hasta, tickets, fondo_inicial, efectivo_ventas, efectivo_devoluciones, retiros,
            gastos, nomina, efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema, tarjeta_terminal, transferencias,
            dolarones, fondo_siguiente, entregado, notas
     from cortes where hasta >= ? order by hasta desc`,
  )
    .bind(desde)
    .all();

  const { results: retiros } = await env.DB.prepare(
    `select creado_en, tipo, caja, cajero, importe, motivo from retiros where creado_en >= ? order by creado_en desc`,
  )
    .bind(desde)
    .all();

  return json({
    dias, dia_desde: rango.dia_desde, dia_hasta: rango.dia_hasta,
    resumen: {
      ventas: resumen?.ventas ?? 0,
      total: resumen?.total ?? 0,
      piezas: resumen?.piezas ?? 0,
      ticket_promedio: resumen?.ventas ? Math.round((resumen.total ?? 0) / resumen.ventas) : 0,
    },
    anterior: {
      ventas: anterior?.ventas ?? 0,
      total: anterior?.total ?? 0,
      piezas: anterior?.piezas ?? 0,
      ticket_promedio: anterior?.ventas ? Math.round((anterior.total ?? 0) / anterior.ventas) : 0,
    },
    cuadre: {
      bruto: cuadre?.bruto ?? 0,
      devoluciones_pieza: cuadre?.devoluciones_pieza ?? 0,
      cancelados: cuadre?.cancelados ?? 0,
      fep: cuadre?.fep ?? 0,
      vendido: (cuadre?.bruto ?? 0) - (cuadre?.devoluciones_pieza ?? 0) - (cuadre?.cancelados ?? 0) - (cuadre?.fep ?? 0),
    },
    por_forma_pago: porFormaPago,
    por_dia: porDia,
    por_hora: porHora,
    por_categoria: porCategoria,
    por_categoria_anterior: porCategoriaAnterior,
    inventario: await inventarioEnPiso(env),
    top_productos: topProductos,
    precio_sugerido: { n: precioSugerido?.n ?? 0, promedio_pct: precioSugerido?.promedio_pct ?? null },
    dias_en_venta_por_categoria: diasEnVenta,
    cancelaciones: {
      n: cancelaciones.length,
      total: cancelaciones.reduce((suma, c) => suma + c.total, 0),
      dolarones: cancelaciones.reduce((suma, c) => suma + c.dolarones, 0),
      detalle: cancelaciones,
    },
    aperturas_cajon: aperturas,
    cortes,
    retiros,
  });
}

/** Una celda de CSV: entre comillas si trae coma, comilla o salto de linea. */
function celdaCsv(valor: unknown): string {
  const texto = String(valor ?? '');
  // Evitar inyeccion de formulas: si es texto y empieza con un caracter peligroso, prefijo con apostrofe.
  // Excepto si es un numero decimal (que puede ser negativo), que se deja tal cual.
  if (typeof valor === 'string' && /^[=+\-@\t\r]/.test(texto) && !/^-?\d+(\.\d+)?$/.test(texto)) {
    return /[",\r\n]/.test(texto) ? `"'${texto.replace(/"/g, '""')}"` : `'${texto}`;
  }
  return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function respuestaCsv(nombreArchivo: string, encabezados: string[], filas: unknown[][]): Response {
  // BOM: sin el, Excel abre los acentos rotos.
  const texto = '﻿' + [encabezados, ...filas].map((fila) => fila.map(celdaCsv).join(',')).join('\r\n');
  return new Response(texto, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${nombreArchivo}"`,
    },
  });
}

const TICKETS_POR_PAGINA = 50;

/**
 * Los filtros de la lista de tickets de /reportes, en un solo lugar: la lista y su
 * exportacion a CSV tienen que ver exactamente los mismos tickets.
 */
function filtrosTickets(url: URL) {
  const q = url.searchParams;
  const { desde } = rangoDe(url);

  const filtros = ['v.creado_en >= ?'];
  const datos: string[] = [desde];
  const forma = q.get('forma_pago') ?? '';
  if (FORMAS_PAGO.has(forma)) { filtros.push('v.forma_pago = ?'); datos.push(forma); }
  for (const campo of ['caja', 'cajero']) {
    const valor = q.get(campo);
    if (valor) { filtros.push(`v.${campo} = ?`); datos.push(valor); }
  }
  const estado = q.get('estado');
  if (estado === 'vigente') filtros.push('v.cancelada = 0');
  if (estado === 'cancelado') filtros.push('v.cancelada = 1');
  if (estado === 'devolucion') {
    filtros.push('v.cancelada = 0 and exists (select 1 from venta_lineas where venta_id = v.id and cancelada_cantidad > 0)');
  }
  const dia = q.get('dia') ?? '';
  if (DIA.test(dia)) { filtros.push('v.creado_en >= ? and v.creado_en < ?'); datos.push(...delDia(dia)); }
  if (q.get('socio') === '1') filtros.push('v.cliente_id is not null');
  if (q.get('dolarones') === '1') filtros.push('v.dolarones > 0');
  const donde = filtros.join(' and ');
  return { desde, donde, datos };
}

/**
 * Tickets del rango de /reportes (Issue #164), con filtros y paginacion. El rango
 * es el mismo de las tarjetas (`dias`), para que los totales cuadren. El detalle de
 * cada ticket es GET /api/ventas/:id. «Vendido» es lo que el ticket sigue valiendo:
 * sin los cancelados ni lo devuelto por piezas.
 */
async function ticketsDelRango(url: URL, env: Env): Promise<Response> {
  const { desde, donde, datos } = filtrosTickets(url);
  const pagina = Math.min(1000, Math.max(0, Math.floor(Number(url.searchParams.get('pagina'))) || 0));

  const resumen = await env.DB.prepare(
    `select count(*) as tickets,
            coalesce(sum(case when v.cancelada = 0 then v.total - v.devuelto - v.dolarones_devueltos end), 0) as vendido,
            coalesce(sum(case when v.cancelada = 0 then v.dolarones - v.dolarones_devueltos end), 0) as dolarones,
            coalesce(sum(case when v.cancelada = 1 then 1 end), 0) as cancelados,
            coalesce((select sum(l.cantidad - l.cancelada_cantidad) from venta_lineas l join ventas v on v.id = l.venta_id
                      where v.cancelada = 0 and ${donde}), 0) as piezas
     from ventas v where ${donde}`,
  )
    .bind(...datos, ...datos)
    .first();
  const { results } = await env.DB.prepare(
    `select ${COLUMNAS_TICKET} from ventas v where ${donde}
     order by v.creado_en desc, v.id desc limit ? offset ?`,
  )
    .bind(...datos, TICKETS_POR_PAGINA + 1, pagina * TICKETS_POR_PAGINA)
    .all();
  // Para los selectores: lo que hubo en el rango, sin importar los filtros.
  const { results: cajas } = await env.DB.prepare(
    `select distinct caja as valor from ventas where creado_en >= ? and caja != '' order by caja`,
  ).bind(desde).all<{ valor: string }>();
  const { results: cajeros } = await env.DB.prepare(
    `select distinct cajero as valor from ventas where creado_en >= ? and cajero != '' order by cajero`,
  ).bind(desde).all<{ valor: string }>();

  return json({
    resumen,
    tickets: results.slice(0, TICKETS_POR_PAGINA),
    hay_mas: results.length > TICKETS_POR_PAGINA,
    cajas: cajas.map((f) => f.valor),
    cajeros: cajeros.map((f) => f.valor),
  });
}

const pesosDe = (centavos: number) => (centavos / 100).toFixed(2);

// ponytail: tope de filas del CSV de tickets; un rango de 12 meses lo rebasaria solo con mucho volumen. Si
// pasa, hay que avisarlo en la pantalla o pasar a un export por tramos (hoy el tope ya cubre ~14 tickets al dia).
const TICKETS_CSV_MAX = 5000;

/** Los tickets de la lista de /reportes con sus mismos filtros, sin paginar, para abrirlos en una hoja de calculo. */
async function exportarTicketsCsv(url: URL, env: Env): Promise<Response> {
  const { donde, datos } = filtrosTickets(url);
  const { results } = await env.DB.prepare(
    `select ${COLUMNAS_TICKET} from ventas v where ${donde} order by v.creado_en desc, v.id desc limit ?`,
  )
    .bind(...datos, TICKETS_CSV_MAX)
    .all<{
      id: string; total: number; forma_pago: string; cancelada: number; creado_en: string; dolarones: number;
      devuelto: number; dolarones_devueltos: number; caja: string; cajero: string; con_socio: number;
      piezas: string | null; cantidad: number; cancelada_cantidad: number;
    }>();

  const filas = results.map((f) => [
    // Hora de la tienda (UTC-6), no la UTC con que se guarda: es la que el dueno reconoce.
    new Date(Date.parse(f.creado_en) - 6 * 3_600_000).toISOString().slice(0, 16).replace('T', ' '),
    f.id, f.caja, f.cajero, f.forma_pago,
    f.cancelada ? 'cancelado' : f.cancelada_cantidad > 0 ? 'con devoluciones' : 'vigente',
    f.piezas ?? '', f.cantidad, pesosDe(f.total), pesosDe(f.devuelto), pesosDe(f.dolarones), pesosDe(f.dolarones_devueltos),
    // Igual que «Vendido» en la lista: un cancelado ya no vale nada.
    pesosDe(f.cancelada ? 0 : f.total - f.devuelto - f.dolarones_devueltos),
    f.con_socio ? 'sí' : 'no',
  ]);
  return respuestaCsv(
    'tickets.csv',
    ['fecha', 'ticket', 'caja', 'cajero', 'forma_pago', 'estado', 'piezas', 'cantidad', 'total', 'devuelto',
      'dolarones', 'dolarones_devueltos', 'vendido', 'socio'],
    filas,
  );
}

/** Un renglon por linea de venta: es el ledger completo, para lo que ningun dashboard cubre. */
async function exportarVentasCsv(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select v.creado_en, v.forma_pago, v.cancelada, v.cancelada_por, v.motivo_cancelacion,
            l.codigo, coalesce(p.categoria, '') as categoria, l.nombre, l.precio, l.cantidad, l.cancelada_cantidad
     from venta_lineas l join ventas v on v.id = l.venta_id left join productos p on p.id = l.producto_id
     order by v.creado_en`,
  ).all<{
    creado_en: string; forma_pago: string; cancelada: number; cancelada_por: string;
    motivo_cancelacion: string; codigo: string; categoria: string; nombre: string;
    precio: number; cantidad: number; cancelada_cantidad: number;
  }>();

  const filas = results.map((f) => [
    // Hora de la tienda (UTC-6), como en tickets.csv: en UTC, una venta de la tarde caia al dia siguiente.
    new Date(Date.parse(f.creado_en) - 6 * 3_600_000).toISOString().slice(0, 16).replace('T', ' '),
    f.forma_pago, f.cancelada ? 'si' : 'no', f.cancelada_por, f.motivo_cancelacion,
    f.codigo, f.categoria, f.nombre, pesosDe(f.precio), f.cantidad, pesosDe(f.precio * f.cantidad),
    f.cancelada_cantidad,
  ]);
  return respuestaCsv(
    'ventas.csv',
    ['fecha', 'forma_pago', 'cancelada', 'cancelada_por', 'motivo_cancelacion',
      'codigo', 'categoria', 'nombre', 'precio', 'cantidad', 'importe', 'piezas_canceladas'],
    filas,
  );
}

async function exportarInventarioCsv(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select codigo, nombre, categoria, marca, precio_lista, precio, precio_sugerido, estado_fisico,
            estado_analisis, destino, stock, sin_inventario, semana_ingreso, capturado_por, creado_en
     from productos where propietario = 'dolaron' order by creado_en`,
  ).all<{
    codigo: string; nombre: string; categoria: string; marca: string; precio_lista: number; precio: number;
    precio_sugerido: number; estado_fisico: string; estado_analisis: string; destino: string;
    stock: number; sin_inventario: number; semana_ingreso: string; capturado_por: string; creado_en: string;
  }>();

  const filas = results.map((f) => [
    f.codigo ?? '', f.nombre, f.categoria, f.marca, pesosDe(f.precio_lista), pesosDe(f.precio),
    f.precio_sugerido ? pesosDe(f.precio_sugerido) : '', f.estado_fisico, f.estado_analisis, f.destino,
    f.sin_inventario ? '' : f.stock, f.semana_ingreso, f.capturado_por, f.creado_en,
  ]);
  return respuestaCsv(
    'inventario.csv',
    ['codigo', 'nombre', 'categoria', 'marca', 'precio_lista', 'precio', 'precio_sugerido', 'estado_fisico',
      'estado_analisis', 'destino', 'stock', 'semana_ingreso', 'capturado_por', 'creado_en'],
    filas,
  );
}

// Issue #202: esta pieza azul sigue retenida hasta corregir la identificación gato/perro.
const RETENIDO_MARKETPLACE = '87ddd327-2058-435d-98ea-651a6e54c09a';
const ELEGIBLE_MARKETPLACE = `stock >= 1 and sin_inventario = 0 and precio > 0
  and typeof(precio) = 'integer' and trim(nombre) != '' and destino = 'etiqueta'
  and foto_key = 'fotos/' || id || '.jpg' and estado_analisis = 'listo' and id != ? and propietario = 'dolaron'`;

async function marketplace(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(`select id, codigo, nombre, categoria, marca, precio,
    estado_fisico, estado_analisis, destino, stock, sin_inventario, foto_key from productos
    where ${ELEGIBLE_MARKETPLACE} order by nombre`).bind(RETENIDO_MARKETPLACE).all();
  const respuesta = json({ products: results, updated_at: new Date().toISOString() });
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}

async function fotoMarketplace(id: string, env: Env): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  const producto = await env.DB.prepare(`select id from productos where ${ELEGIBLE_MARKETPLACE} and id = ?`)
    .bind(RETENIDO_MARKETPLACE, id).first();
  if (!producto) return json({ error: 'Pieza no disponible para Marketplace.' }, 404);
  const respuesta = await servirFoto(id, env);
  respuesta.headers.set('cache-control', 'no-store');
  return respuesta;
}

async function servirFoto(id: string, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  if (await env.DB.prepare("select id from productos where id = ? and estado_analisis = 'descartado'").bind(id).first()) {
    return json({ error: 'Foto no encontrada.' }, 404);
  }
  const objeto = await env.FOTOS.get(`fotos/${id}.jpg`);
  if (!objeto) {
    return json({ error: 'Foto no encontrada.' }, 404);
  }
  return new Response(objeto.body, {
    headers: {
      'content-type': objeto.httpMetadata?.contentType || 'image/jpeg',
      'cache-control': 'private, max-age=3600',
    },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    // Los textos aprobados viven en legal.ts: una variable de Cloudflare no pasa
    // de 5 KB. Siguen cerrados hasta que exista BASES_APROBADAS_VERSION.
    env.PORTAL_BASES_TEXTO ||= BASES;
    env.PORTAL_AVISO_TEXTO ||= AVISO;

    try {
      // Mercado Libre avisa aquí, sin Access: la ruta secreta es la puerta. También
      // llega por el host público del portal (único fuera de Access), por eso va antes.
      const aviso = pathname.match(/^\/api\/ml\/notificaciones\/([^/]+)$/);
      if (aviso && request.method === 'POST') return await recibirNotificacion(aviso[1], request, env, ctx);
      // Puerta pública cerrada por defecto. Nunca comparte rutas ni assets del personal.
      if (env.HOST_PORTAL && url.hostname === env.HOST_PORTAL) {
        const archivos: Record<string, string> = {
          '/': '/portal', '/portal': '/portal', '/portal.html': '/portal', '/v': '/portal',
          '/portal.js': '/portal.js', '/portal.css': '/portal.css', '/code128.js': '/code128.js', '/vendor/qrcode-generator.js': '/vendor/qrcode-generator.js',
          '/el-dolaron-logo.png': '/el-dolaron-logo.png',
        };
        if (archivos[pathname] && (request.method === 'GET' || request.method === 'HEAD')) {
          const asset = new URL(archivos[pathname], url.origin);
          const pantalla = await env.ASSETS.fetch(new Request(asset, { method: request.method }));
          // Assets no hace redirección de HTML hacia el index del personal.
          if (pantalla.status >= 300 && pantalla.status < 400)
            return json({ error: 'Página no disponible.' }, 503);
          const respuesta = new Response(pantalla.body, pantalla);
          const authDomain = env.FIREBASE_AUTH_DOMAIN || `${env.FIREBASE_PROJECT_ID}.firebaseapp.com`;
          const frameAuth = /^[a-z0-9.-]+$/.test(authDomain) ? `https://${authDomain}` : '';
          respuesta.headers.set('content-security-policy', "default-src 'self'; script-src 'self' https://www.gstatic.com https://www.google.com https://www.recaptcha.net https://apis.google.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google.com https://www.recaptcha.net; frame-src https://www.google.com https://www.recaptcha.net " + frameAuth + "; img-src 'self' data: https://www.gstatic.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
          respuesta.headers.set('cache-control', 'no-store');
          respuesta.headers.set('referrer-policy', 'no-referrer');
          respuesta.headers.set('x-content-type-options', 'nosniff');
          return respuesta;
        }
        const publico = await catalogoPublico(request, env, url);
        if (publico) return publico;
        if (!pathname.startsWith('/api/portal/') || pathname === '/api/portal/llegada')
          return json({ error: 'Ruta no encontrada.' }, 404);
        try { return await portal(request, env, url); }
        catch { return json({ error: 'Servicio no disponible.' }, 503); }
      }
      if (pathname.startsWith('/api/portal/') && pathname !== '/api/portal/llegada')
        return json({ error: 'Ruta no encontrada.' }, 404);
      if (env.HOST_VENDEDOR && url.hostname === env.HOST_VENDEDOR) {
        if (pathname === '/') {
          return Response.redirect(`${url.origin}/captura`, 302);
        }
        if (!permitidaParaVendedor(pathname, request.method)) {
          return json({ error: 'Esta pantalla no esta disponible aqui.' }, 404);
        }
      }

      if (pathname === '/api/salud') {
        return json({ estado: 'ok', ambiente: env.AMBIENTE || 'produccion', ahora: new Date().toISOString() });
      }

      // Issue #296: el Worker de WhatsApp consulta la tienda por service binding, sin Access, con token.
      // Va antes de quienEs; cualquier otra ruta /api/asistente/* responde 404 dentro de rutaAsistente.
      if (pathname.startsWith('/api/asistente/')) return await rutaAsistente(request, env, url);

      // Quien es (JWT de Access verificado) y si su cuenta le deja entrar aqui.
      const regla = permiso(pathname, request.method);
      const acceso = await quienEs(request, env, url.hostname);
      if (!acceso) {
        return json({ error: 'Sin sesion. Vuelve a entrar.' }, 401);
      }
      let correo = acceso;
      const usuario = regla !== 'cuenta' ? await leerUsuario(env, acceso) : null;
      if (regla !== 'cuenta') {
        if (!puede(usuario, regla)) {
          // Una pantalla lleva a donde se pide acceso; una llamada de la API
          // recibe el error tal cual.
          if (!pathname.startsWith('/api/') && request.method === 'GET') {
            if (soloComputadora(usuario)) return Response.redirect(`${url.origin}/caja`, 302);
            return Response.redirect(`${url.origin}/sin-acceso?desde=${encodeURIComponent(pathname)}`, 302);
          }
          return json({ error: usuario?.activo ? 'Tu cuenta no tiene permiso para esto.' : 'No tienes cuenta activa.' }, 403);
        }
        // Issue #112: la computadora de caja no cobra sola. Lo de caja queda a
        // nombre del cajero que entro con su PIN; sin el, la API no responde.
        if (esDeCaja(regla) && soloComputadora(usuario) && !pathname.startsWith('/api/cajeros')
            && pathname !== '/api/nomina/entrada' && pathname !== '/api/nomina/checador') {
          const cajero = await cajeroEnTurno(request, env);
          if (cajero) correo = cajero.correo;
          else if (pathname.startsWith('/api/')) return json({ error: 'Escribe tu PIN de cajero.', pin: true }, 401);
        }
      }

      if (/^\/pieza(?:\.html)?\/?$/.test(pathname) && request.method === 'GET') {
        const destino = new URL('/inventario', url.origin); destino.search = url.search; destino.hash = 'buscar';
        return Response.redirect(destino.href, 302);
      }

      if (pathname === '/api/yo') {
        return await yo(env, correo, soloComputadora(await leerUsuario(env, correo)) ? await cajeroEnTurno(request, env) : null, !!env.HOST_VENDEDOR && url.hostname === env.HOST_VENDEDOR);
      }
      if (pathname === '/api/camara/solicitud' || pathname.startsWith('/api/camara/solicitud/')) {
        return await rutaCamaraRemota(request, env, pathname, usuario!);
      }
      if (pathname === '/api/solicitudes-precio' || pathname.startsWith('/api/solicitudes-precio/') || /^\/api\/piezas\/[^/]+\/solicitud-precio$/.test(pathname)) {
        // Aplicar un precio pasa por corregirBorrador: las mismas reglas que la corrección de la ficha.
        return await rutaSolicitudesPrecio(request, env, url, usuario!, (id, precio, esperado, solicitudId) => corregirBorrador(id, { precio }, env, true, undefined, esperado, correo, solicitudId));
      }
      if (pathname === '/api/piezas' || pathname.startsWith('/api/piezas/')) {
        const respuesta = await rutaPiezas(request, env, url, await leerUsuario(env, correo), ctx);
        if (respuesta) return respuesta;
      }
      // #441: revisar ropa y recortes modifica inventario; sus lecturas conservan el permiso por rol.
      if (request.method === 'POST' && /^\/api\/(ropa-ia|recortes)\//.test(pathname)
          && !puedeEditarInventario(await leerUsuario(env, correo))) {
        return json({ error: 'Tu cuenta no tiene permiso para editar el inventario.' }, 403);
      }
      const respuestaRopaIA = await rutaRopaAdmin(request, env, pathname);
      if (respuestaRopaIA) return respuestaRopaIA;
      if (request.method === 'POST' && /^\/api\/recortes\/[^/]+\/(aprobar|original|reintentar)$/.test(pathname)
          && !puedeEditarInventario(await leerUsuario(env, correo))) return json({ error: 'Tu cuenta no tiene permiso para editar el inventario.' }, 403);
      const respuestaRecortes = await rutaRecortesAdmin(request, env, pathname);
      if (respuestaRecortes) return respuestaRecortes;
      const respuestaImagen = await rutaImagenUpc(request, env, pathname, correo, ctx);
      if (respuestaImagen) return respuestaImagen;
      if (pathname === '/api/cajeros' && request.method === 'GET') return await listarCajeros(env);
      if (pathname === '/api/cajeros/entrar' && request.method === 'POST') return await entrar(request, env);
      if (pathname === '/api/cajeros/salir' && request.method === 'POST') return await salir(request, env);
      if (pathname === '/api/cuentas/pin' && request.method === 'PUT') return await ponerPin(request, env);
      if (pathname === '/api/solicitudes/acceso' && request.method === 'POST') {
        return await pedirAcceso(request, env, correo, ctx);
      }
      if (pathname === '/api/cuentas') {
        if (request.method === 'GET') return await listarCuentas(env);
        if (request.method === 'PUT') return await guardarCuenta(request, env);
        return json({ error: 'Metodo no permitido.' }, 405);
      }
      if (pathname === '/api/descuentos' && request.method === 'POST') return await pedirDescuento(request, env, correo, ctx);
      if (pathname === '/api/descuentos/duenos' && request.method === 'GET') return await listarDuenos(env);
      if (pathname === '/api/solicitudes/descuentos' && request.method === 'GET') return await listarDescuentos(env);
      if (pathname === '/api/solicitudes/cancelaciones' && request.method === 'GET') return await listarCancelaciones(env);
      const solicitud = pathname.match(/^\/api\/solicitudes\/([^/]+)$/);
      if (solicitud && request.method === 'GET') return await estadoSolicitud(env, solicitud[1], correo);
      const resolver = pathname.match(/^\/api\/solicitudes\/([^/]+)\/resolver$/);
      if (resolver && request.method === 'POST') {
        return await resolverSolicitud(resolver[1], request, env, correo);
      }

      // Conteo de piezas de alto valor (Issue #219, conteo.ts). Contar: cualquier cuenta de piso; ajustar y el rastro: dueno.
      if (pathname === '/api/conteo' && request.method === 'GET') return await listarAltoValor(env);
      if (pathname === '/api/conteo' && request.method === 'POST') return await revisarConteo(request, env);
      if (pathname === '/api/conteo/ajustes' && request.method === 'GET') return await listarAjustes(env);
      if (pathname === '/api/conteo/ajustes' && request.method === 'POST') return await ajustarExistencia(request, env, correo, ctx);

      if (pathname.startsWith('/api/ml/') || pathname === '/ml/callback') {
        const respuestaML = await rutaML(request, env, url);
        if (respuestaML) return respuestaML;
      }

      if (pathname === '/api/config') {
        if (request.method === 'PUT') {
          return await guardarConfig(request, env);
        }
        return json(await leerConfig(env));
      }

      if (pathname === '/api/borradores') {
        if (request.method === 'POST') {
          return await crearBorrador(request, env, ctx, url, correo);
        }
        if (request.method === 'GET') {
          return await listarBorradores(url, env, propietarioDe(await leerUsuario(env, correo)));
        }
        return json({ error: 'Metodo no permitido.' }, 405);
      }

      // Issue #298: una pieza de FEP no se abre ni se cambia desde la cuenta de la tienda, y al revés.
      const fusion = pathname.match(/^\/api\/borradores\/([^/]+)\/fusionar$/);
      const idPieza = pathname.match(/^\/api\/(?:borradores|foto)\/([0-9a-f-]{36})(?:\/|$)/);
      if (idPieza) {
        const ids = [idPieza[1]];
        if (fusion && request.method === 'POST') {
          const { destino_id } = await request.clone().json() as { destino_id?: unknown };
          ids.push(String(destino_id ?? ''));
        }
        const propietario = propietarioDe(await leerUsuario(env, correo));
        for (const id of ids) {
          const fila = await env.DB.prepare('select propietario from productos where id = ?').bind(id).first<{ propietario: string }>();
          if (fila && fila.propietario !== propietario) return json({ error: 'Pieza no encontrada.' }, 404);
        }
      }

      // #441 PR D: editar, fusionar, descartar, reanalizar y poner imagen exigen la casilla «Editar
      // inventario» (el dueño siempre). La corrección de captura propia de 24 h (existencia, talla y
      // revision) no pasa por aquí: es el carrusel de la cámara y no pide casilla.
      const escritura = pathname.match(/^\/api\/borradores\/[^/]+(?:\/(fusionar|analizar|imagen(?:\/buscar)?))?$/);
      if (escritura && (escritura[1] || ['PATCH', 'DELETE'].includes(request.method))
          && !puedeEditarInventario(await leerUsuario(env, correo))) {
        return json({ error: 'Tu cuenta no tiene permiso para editar el inventario.' }, 403);
      }

      const imagenPieza = await rutaImagenPieza(request, env, pathname);
      if (imagenPieza) return imagenPieza;

      const fotoMarket = pathname.match(/^\/api\/marketplace\/foto\/([^/]+)$/);
      if (pathname === '/api/marketplace' || fotoMarket) {
        if (request.method !== 'GET') return json({ error: 'Metodo no permitido.' }, 405);
        return fotoMarket ? await fotoMarketplace(fotoMarket[1], env) : await marketplace(env);
      }

      const foto = pathname.match(/^\/api\/foto\/([^/]+)$/);
      if (foto) {
        return await servirFoto(foto[1], env);
      }

      if (pathname === '/api/calibracion' && request.method === 'PUT') {
        return await guardarCalibracion(request, env);
      }

      if (pathname === '/api/familias') {
        if (request.method === 'POST') {
          return await crearFamilia(request, env);
        }
        return await listarFamilias(env);
      }

      if (pathname === '/api/catalogo') {
        return await catalogo(env, url);
      }
      // Issue #220: piezas que no pueden salir en el sitio, para corregir en /admin. Solo el dueno (cuentas.ts).
      if (pathname === '/api/catalogo/revision' && request.method === 'GET') {
        return await revisionCatalogo(env);
      }

      if (pathname.startsWith('/api/pedidos')) {
        const respuestaPedidos = await rutaPedidos(request, env, ctx, pathname, correo);
        if (respuestaPedidos) return respuestaPedidos;
      }

      if (pathname === '/api/ventas') {
        if (request.method === 'POST') {
          return await registrarVenta(request, env, ctx, correo);
        }
        return url.searchParams.get('lista') ? await ventasDelDia(url, env) : await corte(url, env);
      }

      if (pathname === '/api/impresiones' && request.method === 'GET') return await listarImpresiones(url, env, correo);
      const impresion = /^\/api\/impresiones\/([^/]+)\/tomar$/.exec(pathname);
      if (impresion && request.method === 'POST') return await tomarImpresion(impresion[1], request, env, correo);

      if (pathname === '/api/mensajes' && request.method === 'GET') return await mensajesApi(env);
      if (pathname === '/api/mensajes/responder' && request.method === 'POST') return await responderApi(request, env, correo);
      if (pathname === '/api/socios') {
        if (request.method === 'POST') return await registrarSocio(request, env, correo);
        if (request.method === 'GET') return await buscarSocio(url, env);
        return json({ error: 'Metodo no permitido.' }, 405);
      }
      if (pathname === '/api/portal/llegada' && request.method === 'POST') {
        try { return await llegada(request, env, correo); }
        catch (error) {
          if (String(error).includes('saldo insuficiente'))
            return json({ error: 'El premio cambió durante la acreditación. Requiere revisión presencial.' }, 409);
          throw error;
        }
      }
      if (pathname === '/api/vales/config' && request.method === 'GET')
      {
        const promo = promoDe(env), restantes = promo && await promoRestantes(env);
        return json({ habilitado:valesAbiertos(env), prueba:env.AMBIENTE === 'sandbox', promo:promo && (restantes === null ? promo : { ...promo, restantes }),
          cupon_porcentaje:await porcentajeCupon(env) });
      }
      if (pathname === '/api/vales/buscar' && request.method === 'POST')
        return await buscarVale(request, env);
      const valeVenta = /^\/api\/ventas\/([^/]+)\/vale$/.exec(pathname);
      if (valeVenta && request.method === 'POST') return await reimprimirVale(env, valeVenta[1]);

      if (pathname === '/api/socios/codigo' && request.method === 'POST')
        return await buscarPorCodigo(request, env);
      if (pathname === '/api/socios/legal' && request.method === 'GET')
        return json({ disponible:basesListas(env), bases:env.PORTAL_BASES_TEXTO || '', aviso:env.PORTAL_AVISO_TEXTO || '' });
      // Sin entrada en cuentas.ts: únicamente el dueño puede aprobar un vínculo.
      if (pathname === '/api/socios/vincular' && request.method === 'POST')
        return await vincular(request, env);

      if (pathname === '/api/cortes') {
        if (request.method === 'POST') return await registrarCorte(request, env, correo);
        if (request.method === 'GET') return await ultimoCorte(url, env, correo);
        return json({ error: 'Metodo no permitido.' }, 405);
      }
      if (pathname === '/api/retiros' && request.method === 'POST') {
        return await registrarRetiro(request, env, correo);
      }
      if (pathname === '/api/gastos' || pathname.startsWith('/api/gastos/')) {
        return await rutaGastos(request, env, url, correo);
      }
      if (pathname === '/api/nomina' || pathname.startsWith('/api/nomina/')) {
        return await rutaNomina(request, env, url, correo);
      }

      if (pathname === '/api/cajon' && request.method === 'POST') {
        return await registrarAperturaCajon(request, env, correo);
      }

      const cancelacion = pathname.match(/^\/api\/ventas\/([^/]+)\/cancelar$/);
      if (cancelacion && request.method === 'POST') {
        return await cancelarVenta(cancelacion[1], request, env, correo, ctx);
      }
      const cancelacionPieza = pathname.match(/^\/api\/ventas\/([^/]+)\/lineas\/(\d+)\/cancelar$/);
      if (cancelacionPieza && request.method === 'POST') {
        return await cancelarPieza(cancelacionPieza[1], Number(cancelacionPieza[2]), request, env, correo);
      }
      // Cupones en lugar de devolver dinero (Issue #330).
      const cupon = pathname.match(/^\/api\/ventas\/([^/]+)\/cupon(?:\/([^/]+))?$/);
      if (cupon && request.method === 'POST') {
        return cupon[2] ? await reimprimirCupon(cupon[1], cupon[2], env) : await devolverEnCupon(cupon[1], request, env, correo);
      }
      if (pathname === '/api/cupones' && request.method === 'POST') return await emitirCuponManual(request, env, correo);
      const ticket = pathname.match(/^\/api\/ventas\/([^/]+)$/);
      if (ticket && request.method === 'GET') {
        return await detalleVenta(ticket[1], env, url.searchParams.get('imprimir') === '1');
      }

      if (pathname === '/api/reportes') {
        return await reportes(url, env);
      }
      if (pathname === '/api/reportes/tickets') {
        return await ticketsDelRango(url, env);
      }
      if (pathname === '/api/reportes/tickets.csv') {
        return await exportarTicketsCsv(url, env);
      }
      if (pathname === '/api/reportes/ventas.csv') {
        return await exportarVentasCsv(env);
      }
      if (pathname === '/api/reportes/inventario.csv') {
        return await exportarInventarioCsv(env);
      }

      if (pathname === '/api/etiquetas' && request.method === 'POST') {
        return await prepararEtiquetas(request, env, propietarioDe(await leerUsuario(env, correo)));
      }

      if (pathname === '/api/borradores/manual' && request.method === 'POST') {
        return await capturarManual(request, env, correo);
      }
      if (pathname === '/api/borradores/upc' && request.method === 'POST') {
        return await capturarPorUpc(request, env, correo, ctx);
      }
      if (pathname === '/api/borradores/upc/buscar' && request.method === 'POST') return await capturarDesconocido(request, env, ctx, correo);
      if (pathname === '/api/borradores/upc/manual' && ['POST', 'PATCH'].includes(request.method)) return await capturarManualEscaner(request, env, correo);
      const desconocida = pathname.match(/^\/api\/borradores\/upc\/([^/]+)$/);
      if (desconocida && request.method === 'GET') return await estadoDesconocido(desconocida[1], env, correo);
      const upcBuscado = pathname.match(/^\/api\/manifiesto\/([^/]+)$/);
      if (upcBuscado && request.method === 'GET') {
        return await buscarEnManifiesto(decodeURIComponent(upcBuscado[1]), env);
      }

      const pieza = pathname.match(/^\/api\/borradores\/([^/]+)$/);
      if (pieza) {
        if (request.method === 'PATCH') {
          const esDueno = !!(await leerUsuario(env, correo))?.roles.includes('dueno');
          return await corregirBorrador(pieza[1], await request.json(), env, esDueno, undefined, undefined, esDueno ? correo : undefined);
        }
        if (request.method === 'DELETE') {
          return await descartarBorrador(pieza[1], env, propietarioDe(await leerUsuario(env, correo)));
        }
        return json({ error: 'Metodo no permitido.' }, 405);
      }

      const correccion = pathname.match(CORRECCION_CAPTURA);
      if (correccion?.[2] === 'revision') return await revisarCaptura(correccion[1], request, env, correo);
      if (correccion && request.method === 'PATCH') {
        return await corregirCaptura(correccion[1], correccion[2], request, env, correo);
      }

      if (fusion && request.method === 'POST') {
        return await fusionarBorrador(fusion[1], request, env, propietarioDe(await leerUsuario(env, correo)));
      }

      // Reintento manual, y la via para la prueba comparativa: ?modelo=gemini
      const reintento = pathname.match(/^\/api\/borradores\/([^/]+)\/analizar$/);
      if (reintento && request.method === 'POST') {
        if (!UUID.test(reintento[1])) {
          return json({ error: 'Identificador invalido.' }, 400);
        }
        const modelo = modeloPedido(url, env);
        // Reintento explícito: vuelve a abrir el análisis, a diferencia de una respuesta tardía (#399).
        await env.DB.prepare("update productos set estado_analisis = 'pendiente' where id = ? and upc is not null and estado_analisis <> 'descartado'")
          .bind(reintento[1]).run();
        ctx.waitUntil(analizarBorrador(reintento[1], env, modelo, busquedaPedida(url)));
        return json({ id: reintento[1], modelo, estado_analisis: 'pendiente' }, 202);
      }

      // Issue #281: errores de JavaScript de la caja, al mismo log que los del servidor.
      if (pathname === '/api/errores' && request.method === 'POST') {
        const cuerpo = await request.json().catch(() => ({})) as Record<string, unknown>;
        const campo = (valor: unknown, max: number) => String(valor ?? '').slice(0, max);
        console.error(JSON.stringify({ mensaje: 'error en el navegador', origen: campo(cuerpo.origen, 40),
          pantalla: campo(cuerpo.pantalla, 200), error: campo(cuerpo.error, 500), pila: campo(cuerpo.pila, 2000),
          caja: campo(cuerpo.caja, 40), correo: acceso }));
        return new Response(null, { status: 204 });
      }

      if (pathname.startsWith('/api/')) {
        return json({ error: 'Ruta no encontrada.' }, 404);
      }

      // Todo lo demas son las pantallas, servidas por el Worker para que el
      // filtro de arriba alcance tambien a los HTML.
      let pantalla = await env.ASSETS.fetch(request);
      if (/^\/marketplace(?:\.html)?\/?$/.test(pathname)) {
        pantalla = new Response(pantalla.body, pantalla);
        pantalla.headers.set('cache-control', 'no-store');
      }
      // Los precios llegan del servidor; solo sandbox lleva la franja de pruebas.
      if (pantalla.headers.get('content-type')?.includes('text/html')
          && (env.AMBIENTE === 'sandbox' || (capturaRopaDisponible(env) && /^\/captura(?:\.html)?\/?$/.test(pathname)))) {
        return new HTMLRewriter()
          .on('body', { element: (e) => {
            e.setAttribute('data-precios-ropa', JSON.stringify(PRECIOS_ROPA));
            if (env.AMBIENTE === 'sandbox') e.prepend(FRANJA_SANDBOX, { html: true });
          } })
          .transform(pantalla);
      }
      return pantalla;
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'fallo en la peticion', pathname, error: String(error),
        pila: error instanceof Error ? error.stack?.slice(0, 2000) : undefined }));
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },

  // Cron de wrangler.jsonc, cada 15 min: ordenes de Mercado Libre perdidas y
  // conciliacion de existencias. Sin cuenta conectada no hace nada.
  /** Búsquedas por código (#406): en paralelo, cada una con su reintento. */
  async queue(lote, env): Promise<void> {
    await Promise.all(lote.messages.map(async (mensaje) => {
      try {
        await identificarPieza(mensaje.body.id, mensaje.body.upc, env, mensaje.attempts >= 2);
        mensaje.ack();
      } catch {
        mensaje.retry();
      }
    }));
  },

  async scheduled(_evento, env, ctx): Promise<void> {
    ctx.waitUntil(sincronizar(env));
    // Apartados cuyo plazo llego: vuelven a la venta (Issue #269). Aparte, para que uno no frene al otro.
    ctx.waitUntil(vencerPedidos(env));
    ctx.waitUntil(procesarColaRopa(env));
    ctx.waitUntil((async () => { await procesarRecortes(env); await revisarRecortes(env); await ajustarRecortesViejos(env); })());
    ctx.waitUntil(procesarRellenoImagenes(env));
  },
} satisfies ExportedHandler<Env, BusquedaUpc>;
