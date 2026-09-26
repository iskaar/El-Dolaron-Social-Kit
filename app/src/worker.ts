/**
 * Escaner de El Dolaron.
 * Paso 1: esqueleto (salud, config). Paso 2: captura desde el telefono.
 * El analisis, la cola del admin y las etiquetas llegan en los pasos siguientes
 * (docs/ARQUITECTURA-ESCANER.md).
 */

import { analizarBorrador, modeloPorDefecto, type Modelo } from './analisis.ts';
import { calcularPrecio, ajustarManual, esDestinoBanda, prefijoParaFamilia, MONTOS_BANDA, type Destino } from './precio.ts';
import { efectivoAlcanza } from '../public/venta.js';
import { semanaIngreso } from '../public/semana.js';
import {
  permiso, puede, quienEs, leerUsuario, yo, pedirAcceso, listarCuentas, guardarCuenta, resolverSolicitud,
} from './cuentas.ts';
import { registrarSocio, buscarSocio, cambiarPin, sentenciasDeVenta, sentenciasDeCancelacion, saldo } from './dolarones.ts';

interface FilaConfig {
  clave: string;
  valor: string;
}

interface FilaBorrador {
  id: string;
  nombre: string;
  categoria: string;
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

const ESTADOS_FISICOS = new Set(['nuevo', 'danado']);
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

  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
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
    `insert into productos (id, semana_ingreso, estado_fisico, stock, foto_key, capturado_por, creado_en, actualizado_en)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       estado_fisico = excluded.estado_fisico,
       stock = excluded.stock,
       foto_key = excluded.foto_key,
       estado_analisis = 'pendiente',
       actualizado_en = excluded.actualizado_en`,
  )
    .bind(id, semanaIngreso(ahora), estadoFisico, cantidad, fotoKey, capturadoPor, ahora.toISOString(), ahora.toISOString())
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
  const consulta = `select id, nombre, categoria, precio_lista, precio, estado_fisico,
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

const CATEGORIAS = new Set(['ropa', 'hogar', 'electronica', 'juguetes', 'otros']);

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
async function corregirBorrador(id: string, request: Request, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const fila = await env.DB.prepare(
    'select nombre, categoria, precio_lista, precio, estado_fisico, destino, stock from productos where id = ?',
  )
    .bind(id)
    .first<FilaBorrador>();
  if (!fila) {
    return json({ error: 'La pieza no existe.' }, 404);
  }

  const cambios = (await request.json()) as Record<string, unknown>;
  const nombre = cambios.nombre === undefined ? fila.nombre : String(cambios.nombre).slice(0, 120);
  const categoria = cambios.categoria === undefined ? fila.categoria : String(cambios.categoria);
  const estadoFisico = cambios.estado_fisico === undefined ? fila.estado_fisico : String(cambios.estado_fisico);
  const precioLista = cambios.precio_lista === undefined ? fila.precio_lista : Math.round(Number(cambios.precio_lista));
  const stock = cambios.stock === undefined ? fila.stock : Math.round(Number(cambios.stock));

  if (categoria && !CATEGORIAS.has(categoria)) {
    return json({ error: 'Categoria invalida.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
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
    `update productos set nombre = ?, categoria = ?, precio_lista = ?, precio = ?,
                          estado_fisico = ?, destino = ?, stock = ?, estado_analisis = 'listo', actualizado_en = ?
     where id = ?`,
  )
    .bind(nombre, categoria, precioLista, precio, estadoFisico, destino, stock, new Date().toISOString(), id)
    .run();

  return json({ id, nombre, categoria, precio_lista: precioLista, precio, estado_fisico: estadoFisico, destino, stock });
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
    `select id, codigo, nombre, precio, precio_lista, semana_ingreso, destino, stock
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
  if (entradas.length === 0 || entradas.length > 20) {
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
async function registrarVenta(request: Request, env: Env, correo: string): Promise<Response> {
  const venta = (await request.json()) as {
    id?: unknown; lineas?: unknown; forma_pago?: unknown;
    efectivo?: unknown; creado_en?: unknown;
    cliente_id?: unknown; dolarones?: unknown; pin?: unknown;
  };
  const id = String(venta.id ?? '');
  if (!UUID.test(id)) {
    return json({ error: 'Identificador de venta invalido.' }, 400);
  }
  if (!Array.isArray(venta.lineas) || venta.lineas.length === 0) {
    return json({ error: 'La venta no tiene piezas.' }, 400);
  }
  const formaPago = String(venta.forma_pago ?? 'efectivo');
  if (formaPago !== 'efectivo' && formaPago !== 'tarjeta') {
    return json({ error: 'Forma de pago invalida.' }, 400);
  }

  const yaExiste = await env.DB.prepare('select id from ventas where id = ?').bind(id).first();
  if (yaExiste) {
    return json({ id, duplicada: true }, 200);
  }

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

  const total = preparado.lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  const efectivo = Math.max(0, Math.round(Number(venta.efectivo ?? 0)));
  const clienteId = venta.cliente_id ? String(venta.cliente_id) : null;
  const dolarones = Number(venta.dolarones ?? 0);
  const aPagar = total - (Number.isInteger(dolarones) ? dolarones : 0);
  if (!efectivoAlcanza({ formaPago, total: aPagar, efectivo })) {
    return json({ error: 'El efectivo no alcanza para el total.' }, 400);
  }

  const momento = new Date();
  const ahora = momento.toISOString();
  const creadoEn = String(venta.creado_en ?? ahora);

  // Valida socio, PIN y saldo antes de tocar nada; sus sentencias van en el mismo batch.
  const recompensa = await sentenciasDeVenta(env, {
    ventaId: id, clienteId, dolarones, pin: String(venta.pin ?? ''), total, autor: correo, ahora: momento,
  });
  if (!recompensa.ok) {
    return json({ error: recompensa.error }, recompensa.status);
  }

  const sentencias = [
    env.DB.prepare(
      `insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en, cliente_id, dolarones)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, total, formaPago, efectivo, Math.max(0, efectivo - aPagar), creadoEn, ahora, clienteId, dolarones),
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
  ];

  // Todo junto: un ticket a medias descuadra el corte del dia, y un canje a
  // medias descuadra el saldo del cliente.
  try {
    await env.DB.batch(sentencias);
  } catch (error) {
    if (String(error).includes('stock insuficiente')) {
      return json({ error: 'No hay existencia suficiente para completar la venta.' }, 409);
    }
    if (String(error).includes('saldo insuficiente')) {
      return json({ error: 'El saldo de Dolarones cambio. Vuelve a buscar al socio.' }, 409);
    }
    throw error;
  }
  return json({
    id, total, dolarones, cambio: Math.max(0, efectivo - aPagar), ganados: recompensa.ganados,
    saldo: clienteId ? await saldo(env, clienteId, ahora) : null,
  }, 201);
}

/**
 * Cancela una venta ya cobrada: devolucion o error de la cajera.
 * La venta no se borra, se marca: el corte del dia tiene que seguir explicando
 * todo lo que paso, incluido lo que se deshizo. Las piezas vuelven al inventario.
 */
async function cancelarVenta(id: string, request: Request, env: Env, correo: string): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador de venta invalido.' }, 400);
  }
  // Con dinero real de por medio, una cancelacion sin motivo no se distingue
  // de una para quedarse el efectivo de una venta que si se cobro. El motivo
  // y quien la hizo (Cloudflare Access, igual que capturado_por en las fotos)
  // son lo minimo para poder auditar despues.
  const cuerpo = (await request.json().catch(() => ({}))) as { motivo?: unknown };
  const motivo = String(cuerpo.motivo ?? '').trim().slice(0, 200);
  if (!motivo) {
    return json({ error: 'Escribe el motivo de la cancelacion.' }, 400);
  }
  const canceladaPor = correo;

  const venta = await env.DB.prepare('select id, total, dolarones, cancelada from ventas where id = ?')
    .bind(id)
    .first<{ id: string; total: number; dolarones: number; cancelada: number }>();
  if (!venta) {
    return json({ error: 'La venta no existe.' }, 404);
  }
  if (venta.cancelada) {
    return json({ id, cancelada: true, ya_estaba: true });
  }

  const ahora = new Date().toISOString();
  const { results: lineas } = await env.DB.prepare(
    'select producto_id, cantidad from venta_lineas where venta_id = ? and producto_id is not null',
  )
    .bind(id)
    .all<{ producto_id: string; cantidad: number }>();

  // Marca, existencias y Dolarones en un solo batch. Si dos cancelaciones
  // llegan juntas, el trigger venta_cancelada_una_vez (migracion 011) aborta
  // la segunda completa: nada se devuelve dos veces.
  try {
    await env.DB.batch([
      env.DB.prepare(
        `update ventas set cancelada = 1, cancelada_en = ?, cancelada_por = ?, motivo_cancelacion = ? where id = ?`,
      ).bind(ahora, canceladaPor, motivo, id),
      ...lineas.map((l) =>
        env.DB.prepare(
          `update productos set stock = stock + ?, actualizado_en = ?
           where id = ? and sin_inventario = 0`,
        ).bind(l.cantidad, ahora, l.producto_id),
      ),
      ...(await sentenciasDeCancelacion(env, id, canceladaPor, ahora)),
    ]);
  } catch (error) {
    if (String(error).includes('venta ya cancelada')) {
      return json({ id, cancelada: true, ya_estaba: true });
    }
    throw error;
  }

  // Lo que se regresa en dinero; lo pagado con Dolarones regresa al saldo.
  return json({ id, cancelada: true, devuelto: venta.total - venta.dolarones, dolarones: venta.dolarones });
}

/** Tickets del dia para la caja: para cancelar el que se cobro mal. */
async function ventasDelDia(url: URL, env: Env): Promise<Response> {
  const dia = url.searchParams.get('dia') ?? new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `select v.id, v.total, v.forma_pago, v.cancelada, v.creado_en,
            (select group_concat(nombre, ' · ') from venta_lineas where venta_id = v.id) as piezas
     from ventas v where substr(v.creado_en, 1, 10) = ?
     order by v.creado_en desc limit 50`,
  )
    .bind(dia)
    .all();
  return json(results);
}

/** Corte del dia: lo que hay que cuadrar contra el efectivo en la caja. */
async function corte(url: URL, env: Env): Promise<Response> {
  const dia = url.searchParams.get('dia') ?? new Date().toISOString().slice(0, 10);
  // Las canceladas no cuentan: el corte es contra el efectivo que hay en el cajon.
  const { results } = await env.DB.prepare(
    `select forma_pago, count(*) as tickets, sum(total - dolarones) as total, sum(dolarones) as dolarones
     from ventas where substr(creado_en, 1, 10) = ? and cancelada = 0 group by forma_pago`,
  )
    .bind(dia)
    .all<{ forma_pago: string; tickets: number; total: number; dolarones: number }>();

  const piezas = await env.DB.prepare(
    `select coalesce(sum(l.cantidad), 0) as piezas from venta_lineas l
     join ventas v on v.id = l.venta_id
     where substr(v.creado_en, 1, 10) = ? and v.cancelada = 0`,
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
 * Reportes: todo sale de consultas contra D1 en el momento, nada se precalcula
 * ni vive en otra tabla. `dias` acota lo que tiene sentido por rango (ventas del
 * dia, categoria, top de piezas); precio sugerido y dias en venta son de
 * siempre, porque son pocos datos y la pregunta que responden no es "esta
 * semana" sino "en general".
 */
async function reportes(url: URL, env: Env): Promise<Response> {
  const dias = Math.min(365, Math.max(1, Math.round(Number(url.searchParams.get('dias') ?? 30))));
  const desde = new Date(Date.now() - dias * 86400000).toISOString();

  const resumen = await env.DB.prepare(
    `select count(*) as ventas, coalesce(sum(total), 0) as total,
       (select coalesce(sum(l.cantidad), 0) from venta_lineas l join ventas v on v.id = l.venta_id
        where v.cancelada = 0 and v.creado_en >= ?) as piezas
     from ventas where cancelada = 0 and creado_en >= ?`,
  )
    .bind(desde, desde)
    .first<{ ventas: number; total: number; piezas: number }>();

  // Lo cobrado en dinero por forma de pago, y lo pagado con Dolarones como una forma mas.
  const { results: porFormaPago } = await env.DB.prepare(
    `select forma_pago, count(*) as tickets, sum(total - dolarones) as total
     from ventas where cancelada = 0 and creado_en >= ? group by forma_pago
     union all
     select 'dolarones', count(*), sum(dolarones)
     from ventas where cancelada = 0 and creado_en >= ? and dolarones > 0`,
  )
    .bind(desde, desde)
    .all<{ forma_pago: string; tickets: number; total: number }>();

  const { results: ventasPorDia } = await env.DB.prepare(
    `select substr(creado_en, 1, 10) as dia, count(*) as tickets, sum(total) as total
     from ventas where cancelada = 0 and creado_en >= ? group by dia order by dia`,
  )
    .bind(desde)
    .all<{ dia: string; tickets: number; total: number }>();
  const { results: piezasPorDia } = await env.DB.prepare(
    `select substr(v.creado_en, 1, 10) as dia, coalesce(sum(l.cantidad), 0) as piezas
     from venta_lineas l join ventas v on v.id = l.venta_id
     where v.cancelada = 0 and v.creado_en >= ? group by dia`,
  )
    .bind(desde)
    .all<{ dia: string; piezas: number }>();
  const piezasPorDiaMapa = new Map(piezasPorDia.map((f) => [f.dia, f.piezas]));
  const porDia = ventasPorDia.map((f) => ({ ...f, piezas: piezasPorDiaMapa.get(f.dia) ?? 0 }));

  const { results: porCategoria } = await env.DB.prepare(
    `select case when p.sin_inventario = 1 then 'bandas' else coalesce(p.categoria, 'sin categoria') end as categoria,
       coalesce(sum(l.precio * l.cantidad), 0) as total, coalesce(sum(l.cantidad), 0) as piezas
     from venta_lineas l join ventas v on v.id = l.venta_id left join productos p on p.id = l.producto_id
     where v.cancelada = 0 and v.creado_en >= ?
     group by categoria order by total desc`,
  )
    .bind(desde)
    .all<{ categoria: string; total: number; piezas: number }>();

  const { results: topProductos } = await env.DB.prepare(
    `select l.codigo, l.nombre, sum(l.cantidad) as cantidad, sum(l.precio * l.cantidad) as total
     from venta_lineas l join ventas v on v.id = l.venta_id
     where v.cancelada = 0 and v.creado_en >= ? and l.producto_id is not null
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
    `select coalesce(p.categoria, 'sin categoria') as categoria,
       avg(julianday(substr(v.creado_en, 1, 10)) - julianday(substr(p.creado_en, 1, 10))) as dias_promedio,
       count(*) as n
     from venta_lineas l join ventas v on v.id = l.venta_id join productos p on p.id = l.producto_id
     where v.cancelada = 0 and p.sin_inventario = 0
     group by categoria order by dias_promedio desc`,
  ).all<{ categoria: string; dias_promedio: number; n: number }>();

  // Devoluciones: el motivo y quien cancelo son la unica huella de una
  // cancelacion que no fue legitima (cobrar de verdad y "cancelar" para
  // quedarse el efectivo). Se listan una por una, no solo el total.
  const { results: cancelaciones } = await env.DB.prepare(
    `select v.id, v.total, v.forma_pago, v.cancelada_en, v.cancelada_por, v.motivo_cancelacion,
       (select group_concat(nombre, ' · ') from venta_lineas where venta_id = v.id) as piezas
     from ventas v where v.cancelada = 1 and v.creado_en >= ?
     order by v.cancelada_en desc`,
  )
    .bind(desde)
    .all<{
      id: string; total: number; forma_pago: string; cancelada_en: string;
      cancelada_por: string; motivo_cancelacion: string; piezas: string;
    }>();

  return json({
    dias,
    resumen: {
      ventas: resumen?.ventas ?? 0,
      total: resumen?.total ?? 0,
      piezas: resumen?.piezas ?? 0,
      ticket_promedio: resumen?.ventas ? Math.round((resumen.total ?? 0) / resumen.ventas) : 0,
    },
    por_forma_pago: porFormaPago,
    por_dia: porDia,
    por_categoria: porCategoria,
    top_productos: topProductos,
    precio_sugerido: { n: precioSugerido?.n ?? 0, promedio_pct: precioSugerido?.promedio_pct ?? null },
    dias_en_venta_por_categoria: diasEnVenta,
    cancelaciones: {
      n: cancelaciones.length,
      total: cancelaciones.reduce((suma, c) => suma + c.total, 0),
      detalle: cancelaciones,
    },
  });
}

/** Una celda de CSV: entre comillas si trae coma, comilla o salto de linea. */
function celdaCsv(valor: unknown): string {
  const texto = String(valor ?? '');
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

const pesosDe = (centavos: number) => (centavos / 100).toFixed(2);

/** Un renglon por linea de venta: es el ledger completo, para lo que ningun dashboard cubre. */
async function exportarVentasCsv(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select v.creado_en, v.forma_pago, v.cancelada, v.cancelada_por, v.motivo_cancelacion,
            l.codigo, coalesce(p.categoria, '') as categoria, l.nombre, l.precio, l.cantidad
     from venta_lineas l join ventas v on v.id = l.venta_id left join productos p on p.id = l.producto_id
     order by v.creado_en`,
  ).all<{
    creado_en: string; forma_pago: string; cancelada: number; cancelada_por: string;
    motivo_cancelacion: string; codigo: string; categoria: string; nombre: string;
    precio: number; cantidad: number;
  }>();

  const filas = results.map((f) => [
    f.creado_en, f.forma_pago, f.cancelada ? 'si' : 'no', f.cancelada_por, f.motivo_cancelacion,
    f.codigo, f.categoria, f.nombre, pesosDe(f.precio), f.cantidad, pesosDe(f.precio * f.cantidad),
  ]);
  return respuestaCsv(
    'ventas.csv',
    ['fecha', 'forma_pago', 'cancelada', 'cancelada_por', 'motivo_cancelacion',
      'codigo', 'categoria', 'nombre', 'precio', 'cantidad', 'importe'],
    filas,
  );
}

async function exportarInventarioCsv(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select codigo, nombre, categoria, precio_lista, precio, precio_sugerido, estado_fisico,
            estado_analisis, destino, stock, sin_inventario, semana_ingreso, capturado_por, creado_en
     from productos order by creado_en`,
  ).all<{
    codigo: string; nombre: string; categoria: string; precio_lista: number; precio: number;
    precio_sugerido: number; estado_fisico: string; estado_analisis: string; destino: string;
    stock: number; sin_inventario: number; semana_ingreso: string; capturado_por: string; creado_en: string;
  }>();

  const filas = results.map((f) => [
    f.codigo ?? '', f.nombre, f.categoria, pesosDe(f.precio_lista), pesosDe(f.precio),
    f.precio_sugerido ? pesosDe(f.precio_sugerido) : '', f.estado_fisico, f.estado_analisis, f.destino,
    f.sin_inventario ? '' : f.stock, f.semana_ingreso, f.capturado_por, f.creado_en,
  ]);
  return respuestaCsv(
    'inventario.csv',
    ['codigo', 'nombre', 'categoria', 'precio_lista', 'precio', 'precio_sugerido', 'estado_fisico',
      'estado_analisis', 'destino', 'stock', 'semana_ingreso', 'capturado_por', 'creado_en'],
    filas,
  );
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

    try {
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
      const correo = await quienEs(request, env, url.hostname);
      if (!correo) {
        return json({ error: 'Sin sesion. Vuelve a entrar.' }, 401);
      }
      if (regla !== 'cuenta') {
        const usuario = await leerUsuario(env, correo);
        if (!puede(usuario, regla)) {
          // Una pantalla lleva a donde se pide acceso; una llamada de la API
          // recibe el error tal cual.
          if (!pathname.startsWith('/api/') && request.method === 'GET') {
            return Response.redirect(`${url.origin}/sin-acceso?desde=${encodeURIComponent(pathname)}`, 302);
          }
          return json({ error: usuario?.activo ? 'Tu cuenta no tiene permiso para esto.' : 'No tienes cuenta activa.' }, 403);
        }
      }

      if (pathname === '/api/yo') {
        return await yo(env, correo);
      }
      if (pathname === '/api/solicitudes/acceso' && request.method === 'POST') {
        return await pedirAcceso(request, env, correo);
      }
      if (pathname === '/api/cuentas') {
        if (request.method === 'GET') return await listarCuentas(env);
        if (request.method === 'PUT') return await guardarCuenta(request, env);
        return json({ error: 'Metodo no permitido.' }, 405);
      }
      const resolver = pathname.match(/^\/api\/solicitudes\/([^/]+)\/resolver$/);
      if (resolver && request.method === 'POST') {
        return await resolverSolicitud(resolver[1], request, env, correo);
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

      const foto = pathname.match(/^\/api\/foto\/([^/]+)$/);
      if (foto) {
        return await servirFoto(foto[1], env);
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

      if (pathname === '/api/ventas') {
        if (request.method === 'POST') {
          return await registrarVenta(request, env, correo);
        }
        return url.searchParams.get('lista') ? await ventasDelDia(url, env) : await corte(url, env);
      }

      if (pathname === '/api/socios') {
        if (request.method === 'POST') return await registrarSocio(request, env, correo);
        if (request.method === 'GET') return await buscarSocio(url, env);
        return json({ error: 'Metodo no permitido.' }, 405);
      }

      const nuevoPin = pathname.match(/^\/api\/socios\/(\d+)\/pin$/);
      if (nuevoPin && request.method === 'POST') {
        return await cambiarPin(Number(nuevoPin[1]), request, env);
      }

      const cancelacion = pathname.match(/^\/api\/ventas\/([^/]+)\/cancelar$/);
      if (cancelacion && request.method === 'POST') {
        return await cancelarVenta(cancelacion[1], request, env, correo);
      }

      if (pathname === '/api/reportes') {
        return await reportes(url, env);
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

      const pieza = pathname.match(/^\/api\/borradores\/([^/]+)$/);
      if (pieza) {
        if (request.method === 'PATCH') {
          return await corregirBorrador(pieza[1], request, env);
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
      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'fallo en la peticion', pathname, error: String(error) }));
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
