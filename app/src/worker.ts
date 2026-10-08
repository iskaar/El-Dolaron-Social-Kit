/**
 * Escaner de El Dolaron.
 * Paso 1: esqueleto (salud, config). Paso 2: captura desde el telefono.
 * El analisis, la cola del admin y las etiquetas llegan en los pasos siguientes
 * (docs/ARQUITECTURA-ESCANER.md).
 */

import { analizarBorrador, modeloPorDefecto, type Modelo } from './analisis.ts';
import { calcularPrecio, ajustarManual, esDestinoBanda, prefijoParaFamilia, MONTOS_BANDA, type Destino } from './precio.ts';
import { efectivoAlcanza, promoInauguracion } from '../public/venta.js';

/** Ventana de la promo de inauguracion; null si no esta configurada. */
const promoDe = (env: Env) =>
  env.PROMO_DESDE && env.PROMO_HASTA && Date.parse(env.PROMO_DESDE) < Date.parse(env.PROMO_HASTA)
    ? { desde: env.PROMO_DESDE, hasta: env.PROMO_HASTA } : null;
import { semanaIngreso } from '../public/semana.js';
import { tramoDeDias, TRAMOS_ANTIGUEDAD } from '../public/graficas.js';
import { detalleVenta, cancelarPieza } from './devoluciones.ts';
import { cancelarVenta, listarCancelaciones, estadoSolicitud } from './cancelaciones.ts';
import { BASES, AVISO } from './legal.ts';
import { CLAVES_CATEGORIA } from '../public/categorias.js';
import { tallaValida } from '../public/tallas.js';
import {
  permiso, puede, quienEs, leerUsuario, yo, pedirAcceso, listarCuentas, guardarCuenta, resolverSolicitud,
  esDeCaja, soloComputadora, CAJAS,
} from './cuentas.ts';
import { cajeroEnTurno, listarCajeros, entrar, salir, ponerPin } from './cajeros.ts';
import { registrarSocio, buscarSocio, buscarPorCodigo, basesListas, sentenciasDeVenta, saldo } from './dolarones.ts';
import { registrarCorte, registrarRetiro, ultimoCorte, cajaDe } from './corte.ts';
import { portal, llegada, vincular } from './portal.ts';
import { sentenciasVale, buscarVale, valeDeVenta, valeUsadoEnVenta, reimprimirVale, valesAbiertos } from './vales.ts';
import { catalogoPublico, revisionCatalogo } from './catalogo.ts';
import { rutaML, recibirNotificacion, conciliarSeguro, sincronizar } from './mercadolibre.ts';
import { pedirDescuento, validarDescuento, listarDescuentos, listarDuenos } from './descuentos.ts';

interface FilaConfig {
  clave: string;
  valor: string;
}

interface FilaBorrador {
  id: string;
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
}

/**
 * El hostname del vendedor solo sirve la camara y la subida de fotos.
 * Cloudflare Access decide quien entra; esto decide que hay detras, y sigue
 * valiendo si algun dia la politica de Access queda mal configurada. Los precios
 * y el inventario no viven en el telefono que anda en el pasillo.
 */
const RUTAS_VENDEDOR = new Set(['/captura', '/foto.js', '/api/salud', '/sin-acceso', '/api/yo']);
const EXISTENCIA = /^\/api\/borradores\/([^/]+)\/existencia$/;

export function permitidaParaVendedor(pathname: string, metodo: string): boolean {
  if (RUTAS_VENDEDOR.has(pathname)) {
    return metodo === 'GET';
  }
  // Corregir cuantas piezas son, desde el carrusel de la camara. El handler
  // limita a lo que esa persona capturo en las ultimas 24 h.
  if (EXISTENCIA.test(pathname)) {
    return metodo === 'PATCH';
  }
  // Quien entra por la camara sin cuenta tambien tiene que poder pedirla.
  if (pathname === '/api/solicitudes/acceso') {
    return metodo === 'POST';
  }
  return pathname === '/api/borradores' && metodo === 'POST';
}

const FRANJA_SANDBOX = `<div style="background:#D72B32;color:#fff;text-align:center;font:700 14px system-ui,sans-serif;padding:6px">
  SANDBOX · solo pruebas: aquí no se cobra de verdad ni se registran socios reales</div>`;

const ESTADOS_FISICOS = new Set(['nuevo', 'danado']);
// Transferencia: confirmada por Isaac como forma de pago; sin ella se capturaba
// como efectivo o tarjeta y descuadraba el corte (Issue #93).
const FORMAS_PAGO = new Set(['efectivo', 'tarjeta', 'transferencia']);
const estacionValida = (valor: unknown): valor is string =>
  typeof valor === 'string' && CAJAS.includes(valor);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOTO_MAX_BYTES = 6 * 1024 * 1024;

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
  const talla = String(formulario.get('talla') ?? '').trim() || null;

  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
  }
  if (talla !== null && !tallaValida(talla)) {
    return json({ error: 'Talla invalida.' }, 400);
  }
  if (!(foto instanceof File) || foto.size === 0) {
    return json({ error: 'Falta la foto.' }, 400);
  }
  if (foto.size > FOTO_MAX_BYTES) {
    return json({ error: 'La foto pesa demasiado.' }, 413);
  }

  const fotoKey = `fotos/${id}.jpg`;
  await env.FOTOS.put(fotoKey, foto.stream(), {
    httpMetadata: { contentType: 'image/jpeg' },
  });

  // El correo verificado de quien sube la foto (ver cuentas.ts): de el salen
  // las sesiones de captura y la correccion de existencia desde el carrusel.
  const capturadoPor = correo;

  const ahora = new Date();
  await env.DB.prepare(
    `insert into productos (id, semana_ingreso, estado_fisico, stock, talla, foto_key, capturado_por, creado_en, actualizado_en)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       estado_fisico = excluded.estado_fisico,
       stock = excluded.stock,
       talla = excluded.talla,
       foto_key = excluded.foto_key,
       estado_analisis = 'pendiente',
       actualizado_en = excluded.actualizado_en`,
  )
    .bind(id, semanaIngreso(ahora), estadoFisico, cantidad, talla, fotoKey, capturadoPor, ahora.toISOString(), ahora.toISOString())
    .run();

  // El analisis corre despues de responder: la camara nunca espera a la IA.
  ctx.waitUntil(analizarBorrador(id, env, modeloPedido(url, env), busquedaPedida(url)));

  return json({ id, estado_analisis: 'pendiente' }, 201);
}

async function listarBorradores(url: URL, env: Env): Promise<Response> {
  const estado = url.searchParams.get('estado');
  // Los botes son productos para la caja, no piezas que revisar.
  // Orden de captura (mas vieja primero), no de llegada: las piezas se quedan
  // fisicamente donde se capturaron hasta que se les pega su etiqueta, asi que
  // el orden de la pantalla tiene que ser el mismo que el de la mesa o se
  // vuelve un rompecabezas saber que etiqueta es de que pieza.
  const consulta = `select id, nombre, categoria, marca, talla, precio_lista, precio, estado_fisico,
                           estado_analisis, destino, stock, semana_ingreso, capturado_por, creado_en
                    from productos
                    where sin_inventario = 0 ${estado ? 'and estado_analisis = ?' : ''}
                    order by creado_en asc limit 2000`;
  const sentencia = estado
    ? env.DB.prepare(consulta).bind(estado)
    : env.DB.prepare(consulta);
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
 */
async function corregirBorrador(id: string, cambios: Record<string, unknown>, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const fila = await env.DB.prepare(
    'select nombre, categoria, marca, talla, precio_lista, precio, estado_fisico, destino, stock from productos where id = ?',
  )
    .bind(id)
    .first<FilaBorrador>();
  if (!fila) {
    return json({ error: 'La pieza no existe.' }, 404);
  }

  const nombre = cambios.nombre === undefined ? fila.nombre : String(cambios.nombre).slice(0, 120);
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
  if (talla !== null && !tallaValida(talla)) {
    return json({ error: 'Talla invalida.' }, 400);
  }
  if (!Number.isFinite(precioLista) || precioLista < 0) {
    return json({ error: 'Precio de lista invalido.' }, 400);
  }
  if (!Number.isFinite(stock) || stock < 0 || stock > 999) {
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
    if (!Number.isFinite(precio) || precio < 0) {
      return json({ error: 'Precio invalido.' }, 400);
    }
    if (esDestinoBanda(destino)) {
      // Banda: manda el precio de la banda. Etiqueta: quiebra la decena (termina en 9) como el automatico.
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

  await env.DB.prepare(
    `update productos set nombre = ?, categoria = ?, marca = ?, talla = ?, precio_lista = ?, precio = ?,
                          estado_fisico = ?, destino = ?, stock = ?, estado_analisis = 'listo', actualizado_en = ?
     where id = ?`,
  )
    .bind(nombre, categoria, marca, talla, precioLista, precio, estadoFisico, destino, stock, new Date().toISOString(), id)
    .run();

  return json({ id, nombre, categoria, marca, talla, precio_lista: precioLista, precio, estado_fisico: estadoFisico, destino, stock });
}

/**
 * Captura a mano, sin foto (Issue #115; solo el dueno, ver cuentas.ts). Nace
 * como una pieza de la cola y pasa por la misma correccion: mismas
 * validaciones y mismo calculo de precio. Idempotente por id, como la foto.
 */
async function capturarManual(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!String(cuerpo.nombre ?? '').trim()) return json({ error: 'Falta el nombre.' }, 400);
  if (!(Number(cuerpo.precio_lista) > 0) && !(Number(cuerpo.precio) > 0)) {
    return json({ error: 'Escribe el precio de lista o el de venta.' }, 400);
  }
  const ahora = new Date().toISOString();
  const { meta } = await env.DB.prepare(
    `insert into productos (id, semana_ingreso, capturado_por, creado_en, actualizado_en) values (?, ?, ?, ?, ?)
     on conflict (id) do nothing`,
  )
    .bind(id, semanaIngreso(new Date()), correo, ahora, ahora)
    .run();
  const respuesta = await corregirBorrador(id, cuerpo, env);
  // Datos invalidos: no queda una pieza vacia (salvo que fuera un reintento de una ya guardada).
  if (!respuesta.ok && meta.changes > 0) await env.DB.prepare('delete from productos where id = ?').bind(id).run();
  if (!respuesta.ok) return respuesta;
  // El dueno la da de alta para venderla ya: sin codigo la caja no la recibe. Es
  // el mismo que le pondria Etiquetas, asi que la etiqueta impresa despues coincide.
  // Las de banda se cobran con el codigo de la banda.
  await env.DB.prepare(
    `update productos set codigo = 'ED-' || printf('%06d', rowid)
     where id = ? and (codigo is null or codigo = '') and destino not like 'banda%'`,
  ).bind(id).run();
  return json(await respuesta.json(), 201);
}

/** Cuanto dura abierta la correccion de existencia desde la camara. */
const VENTANA_CAPTURA_MS = 24 * 60 * 60 * 1000;

/**
 * La existencia de una pieza recien capturada, desde el carrusel de /captura.
 * Solo quien la capturo y solo en las primeras 24 h: el telefono del pasillo no
 * es la puerta para ajustar inventario viejo (eso es la cola de revision), y
 * pasado ese rato la pieza ya pudo venderse y un numero absoluto pisaria la venta.
 */
async function corregirExistencia(id: string, request: Request, env: Env, correo: string): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const { stock: crudo } = (await request.json()) as { stock?: unknown };
  const stock = Number(crudo);
  if (!Number.isInteger(stock) || stock < 1 || stock > 999) {
    return json({ error: 'Existencia invalida.' }, 400);
  }
  const quien = correo;
  const desde = new Date(Date.now() - VENTANA_CAPTURA_MS).toISOString();
  const resultado = await env.DB.prepare(
    'update productos set stock = ?, actualizado_en = ? where id = ? and capturado_por = ? and creado_en > ?',
  )
    .bind(stock, new Date().toISOString(), id, quien, desde)
    .run();
  if (resultado.meta.changes === 0) {
    return json({ error: 'Solo puedes cambiar lo que capturaste en las ultimas 24 horas.' }, 404);
  }
  return json({ id, stock });
}

/**
 * Asigna el codigo de barras a las piezas que se van a etiquetar y las devuelve.
 * El codigo se mina una sola vez: una pieza que ya trae etiqueta impresa conserva
 * el suyo, porque reimprimir con otro codigo deja el papel del anaquel huerfano.
 */
async function prepararEtiquetas(request: Request, env: Env): Promise<Response> {
  const { ids } = (await request.json()) as { ids?: unknown };
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100) {
    return json({ error: 'Selecciona entre 1 y 100 piezas.' }, 400);
  }
  const limpios = ids.map(String).filter((id) => UUID.test(id));
  if (limpios.length === 0) {
    return json({ error: 'Identificadores invalidos.' }, 400);
  }

  const huecos = limpios.map(() => '?').join(',');
  await env.DB.prepare(
    `update productos set codigo = 'ED-' || printf('%06d', rowid), actualizado_en = ?
     where id in (${huecos}) and (codigo is null or codigo = '')`,
  )
    .bind(new Date().toISOString(), ...limpios)
    .run();

  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, talla, precio, precio_lista, semana_ingreso, destino, stock
     from productos where id in (${huecos}) order by rowid`,
  )
    .bind(...limpios)
    .all();

  return json(results);
}

/**
 * Dos fotos de la misma pieza. La repetida suma su existencia a la que ya estaba
 * y desaparece; la original se queda con su codigo de barras, porque la etiqueta
 * que ya salio impresa sigue pegada en el anaquel.
 */
async function fusionarBorrador(id: string, request: Request, env: Env): Promise<Response> {
  const { destino_id } = (await request.json()) as { destino_id?: unknown };
  const destinoId = String(destino_id ?? '');
  if (!UUID.test(id) || !UUID.test(destinoId) || id === destinoId) {
    return json({ error: 'Identificador invalido.' }, 400);
  }

  const repetida = await env.DB.prepare('select stock from productos where id = ?')
    .bind(id)
    .first<{ stock: number }>();
  const original = await env.DB.prepare('select stock from productos where id = ?')
    .bind(destinoId)
    .first<{ stock: number }>();
  if (!repetida || !original) {
    return json({ error: 'La pieza no existe.' }, 404);
  }

  await env.DB.batch([
    env.DB.prepare('update productos set stock = stock + ?, actualizado_en = ? where id = ?')
      .bind(repetida.stock, new Date().toISOString(), destinoId),
    env.DB.prepare('delete from productos where id = ?').bind(id),
  ]);
  await env.FOTOS.delete(`fotos/${id}.jpg`);

  return json({ id, destino_id: destinoId, stock: original.stock + repetida.stock });
}

async function descartarBorrador(id: string, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  await env.FOTOS.delete(`fotos/${id}.jpg`);
  await env.DB.prepare('delete from productos where id = ?').bind(id).run();
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

/** Catalogo para la caja: se guarda en el navegador y se cobra sin red. */
async function catalogo(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select id, codigo, nombre, precio, sin_inventario, stock
     from productos where codigo is not null and codigo <> '' and precio > 0
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
}

interface LineaPreparada {
  producto_id: string;
  codigo: string;
  nombre: string;
  precio: number;
  cantidad: number;
  sinInventario: boolean;
}

/**
 * Del navegador solo se confia el producto y la cantidad: precio, nombre y
 * codigo salen del catalogo del servidor, nunca de lo que mande la caja. Es
 * pura a proposito, para poder probarla sin D1: worker.ts solo junta el mapa
 * de productos antes de llamarla.
 */
export function prepararLineas(
  lineasCliente: LineaVenta[],
  productos: Map<string, ProductoVenta>,
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
    lineas.push({
      producto_id: producto.id,
      codigo: producto.codigo ?? '',
      nombre: producto.nombre,
      precio: producto.precio,
      cantidad,
      sinInventario: producto.sin_inventario === 1,
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
    descuento_id?: unknown;
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
  });
  const pedidoHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pedido)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const reintento = async (): Promise<Response | null> => {
    const previo = await env.DB.prepare('select pedido_hash, imprimir_en from ventas where id = ?').bind(id)
      .first<{ pedido_hash:string | null; imprimir_en:string | null }>();
    if (!previo) return null;
    // null: venta registrada antes de la migracion 021, se acepta como antes.
    if (previo.pedido_hash !== null && previo.pedido_hash !== pedidoHash)
      return json({ error:'El folio ya pertenece a otra venta. Revisa la venta original antes de reintentar.' }, 409);
    const ganado = await env.DB.prepare(`select coalesce(sum(importe), 0) as importe from dolarones_movimientos
      where venta_id = ? and tipo = 'compra'`).bind(id).first<{ importe:number }>();
    const respuesta = json({ id, duplicada:true, imprimir_en:previo.imprimir_en, ganados:ganado?.importe ?? 0,
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
    `select id, codigo, nombre, precio, sin_inventario from productos where id in (${huecos})`,
  )
    .bind(...idsPedidos)
    .all<ProductoVenta>();
  const productos = new Map(filas.map((f) => [f.id, f]));

  const preparado = prepararLineas(venta.lineas as LineaVenta[], productos);
  if (!preparado.ok) {
    return json({ error: preparado.error }, 400);
  }

  const subtotal = preparado.lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  // Un descuento solo entra si el dueno lo aprobo para este mismo ticket (Issue #119).
  const descuentoId = venta.descuento_id ? String(venta.descuento_id) : null;
  let descuento = 0;
  if (descuentoId) {
    const valido = await validarDescuento(env, descuentoId, subtotal);
    if (!valido.ok) return json({ error: valido.error }, valido.status);
    descuento = valido.monto;
  }
  // Promo de inauguracion con la hora de la venta en la caja (una venta encolada
  // sin red conserva la promo que vio el cliente); una hora futura no se acepta.
  // Se guarda sumada en `descuento`: devoluciones la prorratea igual.
  const horaCaja = Date.parse(String(venta.creado_en ?? ''));
  descuento += promoInauguracion(subtotal, Number.isFinite(horaCaja) && horaCaja <= Date.now() + 300_000 ? horaCaja : Date.now(), promoDe(env));
  const total = subtotal - descuento;
  const efectivo = Math.max(0, Math.round(Number(venta.efectivo ?? 0)));
  const clienteId = venta.cliente_id ? String(venta.cliente_id) : null;
  const codigoVale = String(venta.codigo_vale ?? '');
  const dolarones = Number(venta.dolarones ?? 0);
  const aPagar = total - (Number.isInteger(dolarones) ? dolarones : 0);
  if (!efectivoAlcanza({ formaPago, total: aPagar, efectivo })) {
    return json({ error: 'El efectivo no alcanza para el total.' }, 400);
  }

  const momento = new Date();
  const ahora = momento.toISOString();
  const creadoEn = String(venta.creado_en ?? ahora);

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

  const sentencias = [
    env.DB.prepare(
      `insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en, cliente_id, dolarones,
                           caja, cajero, pedido_hash, imprimir_en, descuento, descuento_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, total, formaPago, efectivo, Math.max(0, efectivo - aPagar), creadoEn, ahora, clienteId, dolarones,
      // Quien cobro sale de Access; la caja es la suya (Issue #105) o la de la
      // computadora. Una venta encolada antes del corte de caja llega sin caja: ''.
      await cajaDe(env, correo, venta.caja), correo, pedidoHash, imprimirEn, descuento, descuentoId),
    ...preparado.lineas.map((l) =>
      env.DB.prepare(
        `insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad)
         values (?, ?, ?, ?, ?, ?)`,
      ).bind(id, l.producto_id, l.codigo, l.nombre, l.precio, l.cantidad),
    ),
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
    if (descuentoId && String(error).includes('descuento_id')) {
      return json({ error: 'Ese descuento ya se uso en otra venta.' }, 409);
    }
    throw error;
  }
  // Si una pieza publicada en Mercado Libre se agoto, se pausa alla (D1 manda). Despues de responder.
  ctx.waitUntil(conciliarSeguro(env, { productoIds: preparado.lineas.filter((l) => !l.sinInventario).map((l) => l.producto_id) }));
  const respuesta = json({
    id, total, descuento, dolarones, imprimir_en:imprimirEn, cambio: Math.max(0, efectivo - aPagar), ganados: recompensa.ganados,
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
const rangoDe = (url: URL) => rangoDias(Math.min(365, Math.max(1, Math.round(Number(url.searchParams.get('dias') ?? 30)))));

// Lo que lleva un renglon de la lista de tickets (ticket.js `renglonTicket`), del dia o del rango.
const COLUMNAS_TICKET = `v.id, v.total, v.forma_pago, v.cancelada, v.creado_en, v.dolarones, v.devuelto, v.dolarones_devueltos,
            v.caja, v.cajero, v.cliente_id is not null as con_socio,
            (select group_concat(nombre, ' · ') from venta_lineas where venta_id = v.id) as piezas,
            (select coalesce(sum(cantidad), 0) from venta_lineas where venta_id = v.id) as cantidad,
            (select coalesce(sum(cancelada_cantidad), 0) from venta_lineas where venta_id = v.id) as cancelada_cantidad`;

/** Tickets de un dia (hoy si no se dice): la caja cancela el que se cobro mal; reportes solo los ve. */
async function ventasDelDia(url: URL, env: Env): Promise<Response> {
  const dia = url.searchParams.get('dia') ?? hoyTienda();
  const { results } = await env.DB.prepare(
    `select ${COLUMNAS_TICKET}
     from ventas v where ${diaTienda('v.creado_en')} = ?
     order by v.creado_en desc limit 300`,
  )
    .bind(dia)
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
  // Las canceladas no cuentan: el corte es contra el efectivo que hay en el cajon.
  const { results } = await env.DB.prepare(
    `select forma_pago, count(*) as tickets, sum(total - dolarones - devuelto) as total,
            sum(dolarones - dolarones_devueltos) as dolarones
     from ventas where ${diaTienda('creado_en')} = ? and cancelada = 0 group by forma_pago`,
  )
    .bind(dia)
    .all<{ forma_pago: string; tickets: number; total: number; dolarones: number }>();

  const piezas = await env.DB.prepare(
    `select coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) as piezas from venta_lineas l
     join ventas v on v.id = l.venta_id
     where ${diaTienda('v.creado_en')} = ? and v.cancelada = 0`,
  )
    .bind(dia)
    .first<{ piezas: number }>();

  return json({
    dia,
    piezas: piezas?.piezas ?? 0,
    // Dinero que debe haber entre cajon y terminal; lo pagado con Dolarones va aparte.
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
     where sin_inventario = 0 and stock > 0 and destino = 'etiqueta' and codigo is not null and codigo != ''`,
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

  const resumen = await env.DB.prepare(
    `select count(*) as ventas, coalesce(sum(total - devuelto - dolarones_devueltos), 0) as total,
       (select coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) from venta_lineas l join ventas v on v.id = l.venta_id
        where v.cancelada = 0 and v.creado_en >= ?) as piezas
     from ventas where cancelada = 0 and creado_en >= ?`,
  )
    .bind(desde, desde)
    .first<{ ventas: number; total: number; piezas: number }>();

  // El periodo de igual largo justo antes, para las flechas de «vs periodo anterior».
  const anterior = await env.DB.prepare(
    `select count(*) as ventas, coalesce(sum(total - devuelto - dolarones_devueltos), 0) as total,
       (select coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) from venta_lineas l join ventas v on v.id = l.venta_id
        where v.cancelada = 0 and v.creado_en >= ? and v.creado_en < ?) as piezas
     from ventas where cancelada = 0 and creado_en >= ? and creado_en < ?`,
  )
    .bind(rango.anterior_desde, desde, rango.anterior_desde, desde)
    .first<{ ventas: number; total: number; piezas: number }>();

  // De bruto a vendido, sin que sobre ni falte un centavo: lo cobrado en todos los
  // tickets, menos lo devuelto por piezas, menos lo que valian los cancelados completos.
  const cuadre = await env.DB.prepare(
    `select coalesce(sum(total), 0) as bruto,
       coalesce(sum(devuelto + dolarones_devueltos), 0) as devoluciones_pieza,
       coalesce(sum(case when cancelada = 1 then total - devuelto - dolarones_devueltos end), 0) as cancelados
     from ventas where creado_en >= ?`,
  )
    .bind(desde)
    .first<{ bruto: number; devoluciones_pieza: number; cancelados: number }>();

  // Lo cobrado en dinero por forma de pago, y lo pagado con Dolarones como una forma mas.
  const { results: porFormaPago } = await env.DB.prepare(
    `select forma_pago, count(*) as tickets, sum(total - dolarones - devuelto) as total
     from ventas where cancelada = 0 and creado_en >= ? group by forma_pago
     union all
     select 'dolarones', count(*), sum(dolarones - dolarones_devueltos)
     from ventas where cancelada = 0 and creado_en >= ? and dolarones > dolarones_devueltos`,
  )
    .bind(desde, desde)
    .all<{ forma_pago: string; tickets: number; total: number }>();

  const { results: ventasPorDia } = await env.DB.prepare(
    `select ${diaTienda('creado_en')} as dia, count(*) as tickets, sum(total - devuelto - dolarones_devueltos) as total
     from ventas where cancelada = 0 and creado_en >= ? group by dia order by dia`,
  )
    .bind(desde)
    .all<{ dia: string; tickets: number; total: number }>();
  const { results: piezasPorDia } = await env.DB.prepare(
    `select ${diaTienda('v.creado_en')} as dia, coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) as piezas
     from venta_lineas l join ventas v on v.id = l.venta_id
     where v.cancelada = 0 and v.creado_en >= ? group by dia`,
  )
    .bind(desde)
    .all<{ dia: string; piezas: number }>();
  const piezasPorDiaMapa = new Map(piezasPorDia.map((f) => [f.dia, f.piezas]));
  const porDia = ventasPorDia.map((f) => ({ ...f, piezas: piezasPorDiaMapa.get(f.dia) ?? 0 }));

  // Mapa de calor de /reportes: dia de la semana (0 = domingo, como %w) y hora, ambos de la tienda (UTC-6).
  const { results: porHora } = await env.DB.prepare(
    `select cast(strftime('%w', datetime(creado_en, '-6 hours')) as integer) as dia_semana,
       cast(strftime('%H', datetime(creado_en, '-6 hours')) as integer) as hora,
       count(*) as tickets, sum(total - devuelto - dolarones_devueltos) as total
     from ventas where cancelada = 0 and creado_en >= ? group by dia_semana, hora order by dia_semana, hora`,
  )
    .bind(desde)
    .all<{ dia_semana: number; hora: number; tickets: number; total: number }>();

  // Lo vendido por categoria (las bandas juntas), del periodo y del anterior de igual largo: mismas reglas en los dos.
  const ventasPorCategoria = (anteriorAlPeriodo: boolean) => env.DB.prepare(
    `select case when p.sin_inventario = 1 then 'bandas' else coalesce(nullif(p.categoria, ''), 'sin categoria') end as categoria,
       coalesce(sum(l.precio * (l.cantidad - l.cancelada_cantidad)), 0) as total,
       coalesce(sum(l.cantidad - l.cancelada_cantidad), 0) as piezas
     from venta_lineas l join ventas v on v.id = l.venta_id left join productos p on p.id = l.producto_id
     where v.cancelada = 0 and v.creado_en >= ? ${anteriorAlPeriodo ? 'and v.creado_en < ?' : ''}
     group by categoria order by total desc`,
  )
    .bind(...(anteriorAlPeriodo ? [rango.anterior_desde, desde] : [desde]))
    .all<{ categoria: string; total: number; piezas: number }>();
  const { results: porCategoria } = await ventasPorCategoria(false);
  const { results: porCategoriaAnterior } = await ventasPorCategoria(true);

  const { results: topProductos } = await env.DB.prepare(
    `select l.codigo, l.nombre, sum(l.cantidad - l.cancelada_cantidad) as cantidad,
       sum(l.precio * (l.cantidad - l.cancelada_cantidad)) as total
     from venta_lineas l join ventas v on v.id = l.venta_id
     where v.cancelada = 0 and v.creado_en >= ? and l.producto_id is not null and l.cantidad > l.cancelada_cantidad
     group by l.codigo, l.nombre order by cantidad desc, total desc limit 10`,
  )
    .bind(desde)
    .all<{ codigo: string; nombre: string; cantidad: number; total: number }>();

  // Cuanto se aleja lo que de verdad se cobra de lo que propuso la IA: la razon
  // por la que existe precio_sugerido (migracion 002) es poder responder esto
  // con datos en vez de ajustar los porcentajes a ojo.
  const precioSugerido = await env.DB.prepare(
    `select count(*) as n, avg((precio - precio_sugerido) * 100.0 / precio_sugerido) as promedio_pct
     from productos where precio_sugerido > 0 and precio > 0`,
  ).first<{ n: number; promedio_pct: number | null }>();

  // Diferido a proposito en CONTRATO-ESCANER.md hasta que hubiera ventas reales.
  const { results: diasEnVenta } = await env.DB.prepare(
    `select coalesce(nullif(p.categoria, ''), 'sin categoria') as categoria,
       avg(julianday(substr(v.creado_en, 1, 10)) - julianday(substr(p.creado_en, 1, 10))) as dias_promedio,
       count(*) as n
     from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where v.cancelada = 0 and p.sin_inventario = 0 and l.cantidad > l.cancelada_cantidad
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
            gastos, efectivo_esperado, efectivo_contado, diferencia, tarjeta_sistema, tarjeta_terminal, transferencias,
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
      vendido: (cuadre?.bruto ?? 0) - (cuadre?.devoluciones_pieza ?? 0) - (cuadre?.cancelados ?? 0),
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
    return /[",\n]/.test(texto) ? `"'${texto.replace(/"/g, '""')}"` : `'${texto}`;
  }
  return /[",\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(dia)) { filtros.push(`${diaTienda('v.creado_en')} = ?`); datos.push(dia); }
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
    f.creado_en, f.forma_pago, f.cancelada ? 'si' : 'no', f.cancelada_por, f.motivo_cancelacion,
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
     from productos order by creado_en`,
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
  and foto_key = 'fotos/' || id || '.jpg' and estado_analisis = 'listo' and id != ?`;

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
  const objeto = await env.FOTOS.get(`fotos/${id}.jpg`);
  if (!objeto) {
    return json({ error: 'Foto no encontrada.' }, 404);
  }
  return new Response(objeto.body, {
    headers: {
      'content-type': 'image/jpeg',
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
          '/': '/portal', '/portal': '/portal', '/portal.html': '/portal',
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
        return json({ estado: 'ok' });
      }

      // Quien es (JWT de Access verificado) y si su cuenta le deja entrar aqui.
      const regla = permiso(pathname, request.method);
      const acceso = await quienEs(request, env, url.hostname);
      if (!acceso) {
        return json({ error: 'Sin sesion. Vuelve a entrar.' }, 401);
      }
      let correo = acceso;
      if (regla !== 'cuenta') {
        const usuario = await leerUsuario(env, acceso);
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
        if (esDeCaja(regla) && soloComputadora(usuario) && !pathname.startsWith('/api/cajeros')) {
          const cajero = await cajeroEnTurno(request, env);
          if (cajero) correo = cajero.correo;
          else if (pathname.startsWith('/api/')) return json({ error: 'Escribe tu PIN de cajero.', pin: true }, 401);
        }
      }

      if (pathname === '/api/yo') {
        return await yo(env, correo, soloComputadora(await leerUsuario(env, correo)) ? await cajeroEnTurno(request, env) : null);
      }
      if (pathname === '/api/cajeros' && request.method === 'GET') return await listarCajeros(env);
      if (pathname === '/api/cajeros/entrar' && request.method === 'POST') return await entrar(request, env);
      if (pathname === '/api/cajeros/salir' && request.method === 'POST') return await salir(request, env);
      if (pathname === '/api/cuentas/pin' && request.method === 'PUT') return await ponerPin(request, env);
      if (pathname === '/api/solicitudes/acceso' && request.method === 'POST') {
        return await pedirAcceso(request, env, correo);
      }
      if (pathname === '/api/cuentas') {
        if (request.method === 'GET') return await listarCuentas(env);
        if (request.method === 'PUT') return await guardarCuenta(request, env);
        return json({ error: 'Metodo no permitido.' }, 405);
      }
      if (pathname === '/api/descuentos' && request.method === 'POST') return await pedirDescuento(request, env, correo);
      if (pathname === '/api/descuentos/duenos' && request.method === 'GET') return await listarDuenos(env);
      if (pathname === '/api/solicitudes/descuentos' && request.method === 'GET') return await listarDescuentos(env);
      if (pathname === '/api/solicitudes/cancelaciones' && request.method === 'GET') return await listarCancelaciones(env);
      const solicitud = pathname.match(/^\/api\/solicitudes\/([^/]+)$/);
      if (solicitud && request.method === 'GET') return await estadoSolicitud(env, solicitud[1], correo);
      const resolver = pathname.match(/^\/api\/solicitudes\/([^/]+)\/resolver$/);
      if (resolver && request.method === 'POST') {
        return await resolverSolicitud(resolver[1], request, env, correo);
      }

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
          return await listarBorradores(url, env);
        }
        return json({ error: 'Metodo no permitido.' }, 405);
      }

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
        return await catalogo(env);
      }
      // Issue #220: piezas que no pueden salir en el sitio, para corregir en /admin. Solo el dueno (cuentas.ts).
      if (pathname === '/api/catalogo/revision' && request.method === 'GET') {
        return await revisionCatalogo(env);
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
        return json({ habilitado:valesAbiertos(env), promo:promoDe(env) });
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

      if (pathname === '/api/cajon' && request.method === 'POST') {
        return await registrarAperturaCajon(request, env, correo);
      }

      const cancelacion = pathname.match(/^\/api\/ventas\/([^/]+)\/cancelar$/);
      if (cancelacion && request.method === 'POST') {
        return await cancelarVenta(cancelacion[1], request, env, correo);
      }
      const cancelacionPieza = pathname.match(/^\/api\/ventas\/([^/]+)\/lineas\/(\d+)\/cancelar$/);
      if (cancelacionPieza && request.method === 'POST') {
        return await cancelarPieza(cancelacionPieza[1], Number(cancelacionPieza[2]), request, env, correo);
      }
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
        return await prepararEtiquetas(request, env);
      }

      if (pathname === '/api/borradores/manual' && request.method === 'POST') {
        return await capturarManual(request, env, correo);
      }

      const pieza = pathname.match(/^\/api\/borradores\/([^/]+)$/);
      if (pieza) {
        if (request.method === 'PATCH') {
          return await corregirBorrador(pieza[1], await request.json(), env);
        }
        if (request.method === 'DELETE') {
          return await descartarBorrador(pieza[1], env);
        }
        return json({ error: 'Metodo no permitido.' }, 405);
      }

      const existencia = pathname.match(EXISTENCIA);
      if (existencia && request.method === 'PATCH') {
        return await corregirExistencia(existencia[1], request, env, correo);
      }

      const fusion = pathname.match(/^\/api\/borradores\/([^/]+)\/fusionar$/);
      if (fusion && request.method === 'POST') {
        return await fusionarBorrador(fusion[1], request, env);
      }

      // Reintento manual, y la via para la prueba comparativa: ?modelo=gemini
      const reintento = pathname.match(/^\/api\/borradores\/([^/]+)\/analizar$/);
      if (reintento && request.method === 'POST') {
        if (!UUID.test(reintento[1])) {
          return json({ error: 'Identificador invalido.' }, 400);
        }
        const modelo = modeloPedido(url, env);
        ctx.waitUntil(analizarBorrador(reintento[1], env, modelo, busquedaPedida(url)));
        return json({ id: reintento[1], modelo, estado_analisis: 'pendiente' }, 202);
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
      // En el sandbox cada pantalla lo dice: ahi no se cobra de verdad.
      if (env.AMBIENTE === 'sandbox' && pantalla.headers.get('content-type')?.includes('text/html')) {
        return new HTMLRewriter()
          .on('body', { element: (e) => { e.prepend(FRANJA_SANDBOX, { html: true }); } })
          .transform(pantalla);
      }
      return pantalla;
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'fallo en la peticion', pathname, error: String(error) }));
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },

  // Cron de wrangler.jsonc, cada 15 min: ordenes de Mercado Libre perdidas y
  // conciliacion de existencias. Sin cuenta conectada no hace nada.
  async scheduled(_evento, env, ctx): Promise<void> {
    ctx.waitUntil(sincronizar(env));
  },
} satisfies ExportedHandler<Env>;
