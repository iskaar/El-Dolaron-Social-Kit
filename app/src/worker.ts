/**
 * Escaner de El Dolaron.
 * Paso 1: esqueleto (salud, config). Paso 2: captura desde el telefono.
 * El analisis, la cola del admin y las etiquetas llegan en los pasos siguientes
 * (docs/ARQUITECTURA-ESCANER.md).
 */

import { analizarBorrador, modeloPorDefecto, type Modelo } from './analisis.ts';
import { calcularPrecio, ajustarManual, type Destino } from './precio.ts';

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
  semana_ingreso: string;
  creado_en: string;
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

/** Semana ISO de ingreso, como 'S37'. Va impresa en la etiqueta. */
export function semanaIngreso(fecha: Date): string {
  const d = new Date(Date.UTC(fecha.getUTCFullYear(), fecha.getUTCMonth(), fecha.getUTCDate()));
  // Jueves de esa semana: define el año ISO al que pertenece.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const primeroDeEnero = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const semana = Math.ceil(((d.getTime() - primeroDeEnero.getTime()) / 86400000 + 1) / 7);
  return `S${String(semana).padStart(2, '0')}`;
}

async function leerConfig(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('select clave, valor from config').all<FilaConfig>();
  return Object.fromEntries(results.map((fila) => [fila.clave, fila.valor]));
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
async function crearBorrador(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const formulario = await request.formData();
  const id = String(formulario.get('id') ?? '');
  const estadoFisico = String(formulario.get('estado_fisico') ?? 'nuevo');
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

  const ahora = new Date();
  await env.DB.prepare(
    `insert into productos (id, semana_ingreso, estado_fisico, foto_key, creado_en, actualizado_en)
     values (?, ?, ?, ?, ?, ?)
     on conflict (id) do update set
       estado_fisico = excluded.estado_fisico,
       foto_key = excluded.foto_key,
       estado_analisis = 'pendiente',
       actualizado_en = excluded.actualizado_en`,
  )
    .bind(id, semanaIngreso(ahora), estadoFisico, fotoKey, ahora.toISOString(), ahora.toISOString())
    .run();

  // El analisis corre despues de responder: la camara nunca espera a la IA.
  ctx.waitUntil(analizarBorrador(id, env, modeloPedido(url, env)));

  return json({ id, estado_analisis: 'pendiente' }, 201);
}

async function listarBorradores(url: URL, env: Env): Promise<Response> {
  const estado = url.searchParams.get('estado');
  const consulta = `select id, nombre, categoria, precio_lista, precio, estado_fisico,
                           estado_analisis, destino, semana_ingreso, creado_en
                    from productos
                    ${estado ? 'where estado_analisis = ?' : ''}
                    order by creado_en desc limit 200`;
  const sentencia = estado
    ? env.DB.prepare(consulta).bind(estado)
    : env.DB.prepare(consulta);
  const { results } = await sentencia.all<FilaBorrador>();
  return json(results);
}

const CATEGORIAS = new Set(['ropa', 'hogar', 'electronica', 'juguetes', 'otros']);
const DESTINOS = new Set(['etiqueta', 'bin_20', 'bin_40', 'bin_60']);

/**
 * Correcciones del admin. Solo llegan los campos que cambiaron; si no viene un
 * precio explicito, se recalcula con la configuracion vigente.
 */
async function corregirBorrador(id: string, request: Request, env: Env): Promise<Response> {
  if (!UUID.test(id)) {
    return json({ error: 'Identificador invalido.' }, 400);
  }
  const fila = await env.DB.prepare(
    'select nombre, categoria, precio_lista, precio, estado_fisico, destino from productos where id = ?',
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

  if (categoria && !CATEGORIAS.has(categoria)) {
    return json({ error: 'Categoria invalida.' }, 400);
  }
  if (!ESTADOS_FISICOS.has(estadoFisico)) {
    return json({ error: 'Estado fisico invalido.' }, 400);
  }
  if (!Number.isFinite(precioLista) || precioLista < 0) {
    return json({ error: 'Precio de lista invalido.' }, 400);
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
    if (DESTINOS.has(destino)) {
      // Bin: manda el precio del bote. Etiqueta: se redondea a $5 como el automatico.
      precio = ajustarManual({ precio, destino: destino as Destino, config });
    }
    // Misma regla que en el calculo automatico: el precio de venta nunca queda
    // por encima del precio de lista.
    if (precioLista > 0 && precio > precioLista) {
      return json({ error: 'El precio de venta no puede ser mayor al precio de lista.' }, 400);
    }
  }

  if (!DESTINOS.has(destino)) {
    return json({ error: 'Destino invalido.' }, 400);
  }

  await env.DB.prepare(
    `update productos set nombre = ?, categoria = ?, precio_lista = ?, precio = ?,
                          estado_fisico = ?, destino = ?, estado_analisis = 'listo', actualizado_en = ?
     where id = ?`,
  )
    .bind(nombre, categoria, precioLista, precio, estadoFisico, destino, new Date().toISOString(), id)
    .run();

  return json({ id, nombre, categoria, precio_lista: precioLista, precio, estado_fisico: estadoFisico, destino });
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
    `select id, codigo, nombre, precio, precio_lista, semana_ingreso, destino
     from productos where id in (${huecos}) order by rowid`,
  )
    .bind(...limpios)
    .all();

  return json(results);
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

/**
 * Registra una venta. Idempotente por `id`: la caja lo genera antes de cobrar,
 * asi que reenviar la cola despues de una red caida no duplica el ticket ni
 * vuelve a descontar existencias.
 */
async function registrarVenta(request: Request, env: Env): Promise<Response> {
  const venta = (await request.json()) as {
    id?: unknown; lineas?: unknown; forma_pago?: unknown;
    efectivo?: unknown; creado_en?: unknown;
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

  const lineas = (venta.lineas as LineaVenta[]).map((l) => ({
    producto_id: l.producto_id === undefined || l.producto_id === null ? null : String(l.producto_id),
    codigo: String(l.codigo ?? ''),
    nombre: String(l.nombre ?? '').slice(0, 120),
    precio: Math.max(0, Math.round(Number(l.precio ?? 0))),
    cantidad: Math.max(1, Math.round(Number(l.cantidad ?? 1))),
  }));
  const total = lineas.reduce((suma, l) => suma + l.precio * l.cantidad, 0);
  const efectivo = Math.max(0, Math.round(Number(venta.efectivo ?? 0)));
  const ahora = new Date().toISOString();
  const creadoEn = String(venta.creado_en ?? ahora);

  const sentencias = [
    env.DB.prepare(
      `insert into ventas (id, total, forma_pago, efectivo, cambio, creado_en, registrado_en)
       values (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, total, formaPago, efectivo, Math.max(0, efectivo - total), creadoEn, ahora),
    ...lineas.map((l) =>
      env.DB.prepare(
        `insert into venta_lineas (venta_id, producto_id, codigo, nombre, precio, cantidad)
         values (?, ?, ?, ?, ?, ?)`,
      ).bind(id, l.producto_id, l.codigo, l.nombre, l.precio, l.cantidad),
    ),
    // Los bins no descuentan: nadie cuenta cuantas piezas quedan en un bote.
    ...lineas
      .filter((l) => l.producto_id)
      .map((l) =>
        env.DB.prepare(
          `update productos set stock = stock - ?, actualizado_en = ?
           where id = ? and sin_inventario = 0`,
        ).bind(l.cantidad, ahora, l.producto_id),
      ),
  ];

  // Todo junto: un ticket a medias descuadra el corte del dia.
  await env.DB.batch(sentencias);
  return json({ id, total, cambio: Math.max(0, efectivo - total) }, 201);
}

/** Corte del dia: lo que hay que cuadrar contra el efectivo en la caja. */
async function corte(url: URL, env: Env): Promise<Response> {
  const dia = url.searchParams.get('dia') ?? new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `select forma_pago, count(*) as tickets, sum(total) as total
     from ventas where substr(creado_en, 1, 10) = ? group by forma_pago`,
  )
    .bind(dia)
    .all<{ forma_pago: string; tickets: number; total: number }>();

  const piezas = await env.DB.prepare(
    `select coalesce(sum(l.cantidad), 0) as piezas from venta_lineas l
     join ventas v on v.id = l.venta_id where substr(v.creado_en, 1, 10) = ?`,
  )
    .bind(dia)
    .first<{ piezas: number }>();

  return json({
    dia,
    piezas: piezas?.piezas ?? 0,
    total: results.reduce((suma, fila) => suma + (fila.total ?? 0), 0),
    por_forma_pago: results,
  });
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
      if (pathname === '/api/salud') {
        return json({ estado: 'ok' });
      }

      if (pathname === '/api/config') {
        if (request.method === 'PUT') {
          return await guardarConfig(request, env);
        }
        return json(await leerConfig(env));
      }

      if (pathname === '/api/borradores') {
        if (request.method === 'POST') {
          return await crearBorrador(request, env, ctx, url);
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

      if (pathname === '/api/catalogo') {
        return await catalogo(env);
      }

      if (pathname === '/api/ventas') {
        if (request.method === 'POST') {
          return await registrarVenta(request, env);
        }
        return await corte(url, env);
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

      // Reintento manual, y la via para la prueba comparativa: ?modelo=gemini
      const reintento = pathname.match(/^\/api\/borradores\/([^/]+)\/analizar$/);
      if (reintento && request.method === 'POST') {
        if (!UUID.test(reintento[1])) {
          return json({ error: 'Identificador invalido.' }, 400);
        }
        const modelo = modeloPedido(url, env);
        ctx.waitUntil(analizarBorrador(reintento[1], env, modelo));
        return json({ id: reintento[1], modelo, estado_analisis: 'pendiente' }, 202);
      }

      return json({ error: 'Ruta no encontrada.' }, 404);
    } catch (error) {
      console.error(JSON.stringify({ mensaje: 'fallo en la peticion', pathname, error: String(error) }));
      return json({ error: 'Error interno. Intenta de nuevo.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
