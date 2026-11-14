/**
 * Bultos (Issue #795, R4 de #793): la mercancía se captura y etiqueta en Soledad, se arma un bulto escaneando cada etiqueta, se cierra y
 * se sella con su folio impreso; al llegar, la sucursal escribe o escanea el folio y sus piezas entran a su existencia.
 *
 * Estados: abierto → cerrado (en camino) → recibido; un bulto abierto se puede cancelar (todo vuelve al origen).
 * Cada escritura de existencia va en el mismo batch que su renglón del bulto. Lo que no se puede garantizar con filas modificadas
 * (D1 no aborta con cero filas) lo garantizan los triggers de la migración 077 y las sentencias que comparan el token de la
 * transición (`bultos.transicion`): un reintento no mueve existencia dos veces.
 */
import { TIENDAS, TIENDA_CENTRAL, esTienda, leerUsuario, type Usuario } from './cuentas.ts';
import { sentenciasMover } from './existencias.ts';
import { conciliarSeguro } from './mercadolibre.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

// Sin 0, O, 1, I: el folio se escribe a mano. Empieza con BU- para que no se confunda con un código de pieza (ED-000123, o solo dígitos),
// con un pedido (P-17) ni con un socio (DC-/DP-); si se escanea en la venta, la caja avisa que es un bulto.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PATRON_FOLIO = /^BU-[A-HJ-NP-Z2-9]{5}$/;
export const nuevoFolio = () => `BU-${[...crypto.getRandomValues(new Uint8Array(5))].map((b) => ALFABETO[b & 31]).join('')}`;
/** Lo que se escribió o escaneó, como folio: mayúsculas, con o sin guion. null si no tiene la forma. */
export function leerFolio(texto: unknown): string | null {
  const limpio = String(texto ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const folio = /^BU[A-Z0-9]{5}$/.test(limpio) ? `BU-${limpio.slice(2)}` : limpio;
  return PATRON_FOLIO.test(folio) ? folio : null;
}

interface Bulto {
  id: string; folio: string; origen: string; destino: string; estado: string; creado_por: string; creado_en: string;
  cerrado_por: string | null; cerrado_en: string | null; recibido_por: string | null; recibido_en: string | null;
  cancelado_por: string | null; cancelado_en: string | null; transicion: string;
}
const COLUMNAS = 'id, folio, origen, destino, estado, creado_por, creado_en, cerrado_por, cerrado_en, recibido_por, recibido_en, cancelado_por, cancelado_en, transicion';
const nombreTienda = (clave: string) => esTienda(clave) ? TIENDAS[clave].nombre : clave;
const porFolio = (env: Env, folio: string) => env.DB.prepare(`select ${COLUMNAS} from bultos where folio = ?`).bind(folio).first<Bulto>();

interface Linea { id: string; producto_id: string; codigo: string; nombre: string; precio: number; cantidad: number; creado_en: string }
const lineasDe = async (env: Env, bultoId: string) => (await env.DB.prepare(
  `select l.id, l.producto_id, p.codigo, p.nombre, p.precio, l.cantidad, l.creado_en from bulto_lineas l join productos p on p.id = l.producto_id
   where l.bulto_id = ? and l.quitada_en is null order by l.creado_en, l.id`).bind(bultoId).all<Linea>()).results;

/** El bulto como lo ve la pantalla: sin tokens, con nombres de tienda, piezas y valor (centavos, a precio de hoy). */
async function vista(env: Env, b: Bulto, conLineas: boolean) {
  const lineas = await lineasDe(env, b.id);
  const piezas = lineas.reduce((n, l) => n + l.cantidad, 0);
  const valor = lineas.reduce((n, l) => n + l.cantidad * l.precio, 0);
  const { transicion: _t, ...publico } = b;
  return {
    ...publico, origen_nombre: nombreTienda(b.origen), destino_nombre: nombreTienda(b.destino), piezas, valor,
    ...(conLineas ? { lineas } : {}),
    etiqueta: { folio: b.folio, destino: nombreTienda(b.destino), origen: nombreTienda(b.origen), piezas,
      fecha: new Date(b.cerrado_en ?? b.creado_en).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', year: 'numeric' }) },
  };
}

/** Piezas que salen de la existencia del origen o vuelven a ella al quitar una línea: lo que dice la línea marcada por este intento. */
const devolverLinea = (env: Env, origen: string, lineaId: string, token: string, ahora: string) => {
  const marcada = '(select cantidad from bulto_lineas where id = ?1 and quitada_intento = ?2)';
  return origen === TIENDA_CENTRAL
    ? env.DB.prepare(`update productos set stock = stock + ${marcada}, actualizado_en = ?3
        where id = (select producto_id from bulto_lineas where id = ?1 and quitada_intento = ?2)`).bind(lineaId, token, ahora)
    : env.DB.prepare(`update existencia_tienda set unidades = unidades + ${marcada}, actualizado_en = ?3
        where tienda = ?4 and producto_id = (select producto_id from bulto_lineas where id = ?1 and quitada_intento = ?2)`).bind(lineaId, token, ahora, origen);
};

/**
 * Todas las unidades activas del bulto entran a `tienda` en un solo batch, solo si ESTE intento fue el que cambió el estado del bulto
 * (token de `transicion` y estado esperado). Recibir suma al destino; cancelar regresa al origen.
 */
function entrarAlBulto(env: Env, b: Bulto, tienda: string, token: string, estado: 'recibido' | 'cancelado', ahora: string): D1PreparedStatement[] {
  const propio = `exists (select 1 from bultos where id = ?1 and transicion = ?2 and estado = '${estado}')`;
  const activas = '(select coalesce(sum(l.cantidad), 0) from bulto_lineas l where l.bulto_id = ?1 and l.producto_id = ##.producto_id and l.quitada_en is null)';
  if (tienda === TIENDA_CENTRAL) {
    return [env.DB.prepare(`update productos set stock = stock + ${activas.replace('##.producto_id', 'productos.id')}, actualizado_en = ?3
      where id in (select producto_id from bulto_lineas where bulto_id = ?1 and quitada_en is null) and ${propio}`).bind(b.id, token, ahora)];
  }
  return [
    env.DB.prepare(`insert into existencia_tienda (producto_id, tienda, unidades, actualizado_en)
      select distinct l.producto_id, ?4, 0, ?3 from bulto_lineas l where l.bulto_id = ?1 and l.quitada_en is null and ${propio}
      on conflict (producto_id, tienda) do nothing`).bind(b.id, token, ahora, tienda),
    env.DB.prepare(`update existencia_tienda set unidades = unidades + ${activas.replace('##.producto_id', 'existencia_tienda.producto_id')}, actualizado_en = ?3
      where tienda = ?4 and producto_id in (select producto_id from bulto_lineas where bulto_id = ?1 and quitada_en is null) and ${propio}`)
      .bind(b.id, token, ahora, tienda),
  ];
}

const conciliar = (env: Env, ctx: ExecutionContext, productoIds: string[], tiendas: string[]) => {
  // Solo Soledad publica en Mercado Libre: meter la última unidad a un bulto la pausa por la conciliación que ya existe.
  if (tiendas.includes(TIENDA_CENTRAL) && productoIds.length) ctx.waitUntil(conciliarSeguro(env, { productoIds: [...new Set(productoIds)] }));
};

const normalizarCodigo = (texto: unknown) => {
  const limpio = String(texto ?? '').trim().toUpperCase();
  return /^\d+$/.test(limpio) ? `ED-${limpio.padStart(6, '0')}` : limpio;
};

export async function rutaBultos(
  request: Request, env: Env, ctx: ExecutionContext, url: URL, usuario: Usuario | null, correo: string, tienda: string,
): Promise<Response> {
  const ruta = url.pathname.replace(/\/$/, '');
  const metodo = request.method;
  const cuerpo = async () => (metodo === 'GET' ? {} : await request.json().catch(() => ({}))) as Record<string, unknown>;
  const persona = await leerUsuario(env, correo);
  const esDueno = !!persona?.activo && persona.roles.includes('dueno');

  // ---- Recibir: dueño y cajero con PIN en la computadora de la sucursal (permiso CAJA) ----
  if (ruta === '/api/bultos/entrantes' && metodo === 'GET') {
    const { results } = await env.DB.prepare(`select ${COLUMNAS} from bultos where estado = 'cerrado' and destino = ? order by cerrado_en`).bind(tienda).all<Bulto>();
    return json(await Promise.all(results.map((b) => vista(env, b, false))));
  }
  if (ruta === '/api/bultos/recibir' && metodo === 'POST') {
    const folio = leerFolio((await cuerpo()).folio);
    if (!folio) return json({ error: 'Escribe el folio del bulto (BU- y cinco caracteres).' }, 400);
    const b = await porFolio(env, folio);
    if (!b) return json({ error: `No existe el bulto ${folio}. Revisa el folio.` }, 404);
    // Solo la tienda destino o el dueño; una tienda equivocada recibe un rechazo que dice a dónde va.
    if (b.destino !== tienda && !esDueno) return json({ error: `Ese bulto va a ${nombreTienda(b.destino)}, no a esta tienda.`, destino: b.destino }, 409);
    if (b.estado === 'abierto') return json({ error: 'Ese bulto todavía no está cerrado: en Soledad aún lo están armando.' }, 409);
    if (b.estado === 'cancelado') return json({ error: 'Ese bulto se canceló: sus piezas volvieron a la tienda de origen.' }, 409);
    if (b.estado === 'cerrado') {
      const token = crypto.randomUUID(), ahora = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`update bultos set estado = 'recibido', recibido_por = ?, recibido_en = ?, transicion = ? where id = ? and estado = 'cerrado'`)
          .bind(correo, ahora, token, b.id),
        ...entrarAlBulto(env, b, b.destino, token, 'recibido', ahora),
      ]);
      const despues = (await porFolio(env, folio))!;
      conciliar(env, ctx, (await lineasDe(env, b.id)).map((l) => l.producto_id), [b.destino]);
      return json({ ...(await vista(env, despues, true)), ya_estaba: despues.transicion !== token });
    }
    return json({ ...(await vista(env, b, true)), ya_estaba: true });   // recibido: mismo resultado, sin sumar otra vez
  }

  // ---- Armar: dueño y capturista (permiso CAPTURA). Sale de Soledad; el dueño puede armar desde cualquier tienda. ----
  if (!esDueno && tienda !== TIENDA_CENTRAL) return json({ error: 'Los bultos se arman en Soledad.' }, 403);

  if (ruta === '/api/bultos' && metodo === 'GET') {
    const estados = url.searchParams.get('estado') === 'recibido' ? ['recibido'] : url.searchParams.get('estado') === 'abierto' ? ['abierto'] : ['abierto', 'cerrado'];
    const { results } = await env.DB.prepare(`select ${COLUMNAS} from bultos where estado in (${estados.map(() => '?').join(',')}) order by creado_en desc limit 100`)
      .bind(...estados).all<Bulto>();
    return json(await Promise.all(results.map((b) => vista(env, b, false))));
  }

  if (ruta === '/api/bultos' && metodo === 'POST') {
    const c = await cuerpo();
    const id = String(c.id ?? '');
    if (!UUID.test(id)) return json({ error: 'Identificador inválido.' }, 400);
    const origen = c.origen === undefined ? TIENDA_CENTRAL : String(c.origen);
    const destino = String(c.destino ?? '');
    if (!esTienda(origen) || !esTienda(destino) || origen === destino) return json({ error: 'Escoge un destino distinto del origen.' }, 400);
    if (origen !== TIENDA_CENTRAL && !esDueno) return json({ error: 'Solo el dueño arma bultos desde una sucursal.' }, 403);
    const previo = await env.DB.prepare(`select ${COLUMNAS} from bultos where id = ?`).bind(id).first<Bulto>();
    if (previo) return previo.origen === origen && previo.destino === destino && previo.creado_por === correo
      ? json(await vista(env, previo, true)) : json({ error: 'Ese identificador ya es de otro bulto.' }, 409);
    for (let intento = 0; intento < 6; intento += 1) {
      const folio = nuevoFolio();
      try {
        await env.DB.prepare('insert into bultos (id, folio, origen, destino, creado_por, creado_en) values (?, ?, ?, ?, ?, ?)')
          .bind(id, folio, origen, destino, correo, new Date().toISOString()).run();
        return json(await vista(env, (await porFolio(env, folio))!, true), 201);
      } catch (error) {
        if (!/UNIQUE/i.test(String(error))) throw error;
        const ganado = await env.DB.prepare(`select ${COLUMNAS} from bultos where id = ?`).bind(id).first<Bulto>();   // dos intentos con el mismo id
        if (ganado) return json(await vista(env, ganado, true));
      }
    }
    return json({ error: 'No se pudo asignar un folio. Intenta otra vez.' }, 503);
  }

  const dentro = /^\/api\/bultos\/([^/]+)(?:\/(piezas|quitar|cerrar|cancelar))?$/.exec(ruta);
  if (!dentro) return json({ error: 'No encontrado.' }, 404);
  const folio = leerFolio(decodeURIComponent(dentro[1]));
  if (!folio) return json({ error: 'Folio inválido.' }, 400);
  const b = await porFolio(env, folio);
  if (!b) return json({ error: 'El bulto no existe.' }, 404);
  const accion = dentro[2];

  if (!accion) return metodo === 'GET' ? json(await vista(env, b, true)) : json({ error: 'Método no permitido.' }, 405);
  if (metodo !== 'POST') return json({ error: 'Método no permitido.' }, 405);
  const c = await cuerpo();
  const cerradoOCancelado = () => json({ error: b.estado === 'abierto' ? 'El bulto no está abierto.' : `El bulto ya está ${b.estado}: no se puede modificar.` }, 409);

  if (accion === 'piezas') {
    // Cada escaneo lleva su UUID: reintentar no mete dos veces. La línea y la salida de la existencia van en el mismo batch.
    const id = String(c.id ?? '');
    const cantidad = c.cantidad === undefined ? 1 : Number(c.cantidad);
    if (!UUID.test(id) || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 99) return json({ error: 'Escaneo inválido.' }, 400);
    const previa = await env.DB.prepare('select bulto_id, producto_id, cantidad from bulto_lineas where id = ?').bind(id)
      .first<{ bulto_id: string; producto_id: string; cantidad: number }>();
    if (previa) return previa.bulto_id === b.id ? json({ ...(await vista(env, b, true)), repetido: true }) : json({ error: 'Ese escaneo ya es de otro bulto.' }, 409);
    if (b.estado !== 'abierto') return cerradoOCancelado();
    const codigo = normalizarCodigo(c.codigo);
    if (leerFolio(codigo)) return json({ error: 'Eso es el folio de un bulto, no una pieza.' }, 400);
    const pieza = await env.DB.prepare(`select id, codigo, nombre, sin_inventario, propietario, estado_analisis from productos where codigo = ?`)
      .bind(codigo).first<{ id: string; codigo: string; nombre: string; sin_inventario: number; propietario: string; estado_analisis: string }>();
    if (!pieza || pieza.estado_analisis === 'descartado') return json({ error: `Código no encontrado: ${codigo}` }, 404);
    if (pieza.sin_inventario === 1) return json({ error: `${pieza.nombre || pieza.codigo} es de banda o bote: no cuenta existencia y viaja en el bulto sin escanear.` }, 409);
    // Decisión pendiente de Isaac (#793): la mercancía de FEP no viaja a sucursales hasta que la tome.
    if (pieza.propietario !== 'dolaron') return json({ error: 'La mercancía de FEP todavía no viaja a sucursales (decisión pendiente).' }, 409);
    const ahora = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare('insert into bulto_lineas (id, bulto_id, producto_id, cantidad, creado_por, creado_en) values (?, ?, ?, ?, ?, ?)')
          .bind(id, b.id, pieza.id, cantidad, correo, ahora),
        // Sale de la existencia del origen. Si no alcanza, el trigger aborta el batch completo: ni renglón ni descuento.
        ...sentenciasMover(env, b.origen, pieza.id, -cantidad, ahora),
      ]);
    } catch (error) {
      const texto = String(error);
      if (/UNIQUE|PRIMARY/i.test(texto)) {
        const ganada = await env.DB.prepare('select bulto_id from bulto_lineas where id = ?').bind(id).first<{ bulto_id: string }>();
        if (ganada?.bulto_id === b.id) return json({ ...(await vista(env, b, true)), repetido: true });
      }
      if (/stock insuficiente|existencia insuficiente/.test(texto)) return json({ error: `No hay ${cantidad > 1 ? `${cantidad} piezas` : 'existencia'} de ${pieza.nombre || pieza.codigo} en ${nombreTienda(b.origen)}.` }, 409);
      if (texto.includes('bulto no abierto')) return cerradoOCancelado();
      throw error;
    }
    conciliar(env, ctx, [pieza.id], [b.origen]);
    return json({ ...(await vista(env, b, true)), agregada: { id, codigo: pieza.codigo, nombre: pieza.nombre, cantidad } }, 201);
  }

  if (accion === 'quitar') {
    // Quitar una línea la marca y la regresa al origen; el token compara qué intento la quitó, así que un reintento no regresa dos veces.
    const lineaId = String(c.linea ?? '');
    if (!UUID.test(lineaId)) return json({ error: 'Pieza inválida.' }, 400);
    const linea = await env.DB.prepare('select bulto_id, producto_id, quitada_en from bulto_lineas where id = ?').bind(lineaId)
      .first<{ bulto_id: string; producto_id: string; quitada_en: string | null }>();
    if (!linea || linea.bulto_id !== b.id) return json({ error: 'Esa pieza no es de este bulto.' }, 404);
    if (linea.quitada_en) return json({ ...(await vista(env, b, true)), repetido: true });
    if (b.estado !== 'abierto') return cerradoOCancelado();
    const token = crypto.randomUUID(), ahora = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare('update bulto_lineas set quitada_en = ?, quitada_por = ?, quitada_intento = ? where id = ? and quitada_en is null')
          .bind(ahora, correo, token, lineaId),
        devolverLinea(env, b.origen, lineaId, token, ahora),
      ]);
    } catch (error) {
      if (String(error).includes('bulto no abierto')) return cerradoOCancelado();
      throw error;
    }
    conciliar(env, ctx, [linea.producto_id], [b.origen]);
    return json(await vista(env, (await porFolio(env, folio))!, true));
  }

  if (accion === 'cerrar') {
    if (b.estado === 'cerrado') return json({ ...(await vista(env, b, true)), ya_estaba: true });
    if (b.estado !== 'abierto') return cerradoOCancelado();
    const token = crypto.randomUUID();
    try {
      await env.DB.prepare(`update bultos set estado = 'cerrado', cerrado_por = ?, cerrado_en = ?, transicion = ? where id = ? and estado = 'abierto'`)
        .bind(correo, new Date().toISOString(), token, b.id).run();
    } catch (error) {
      if (String(error).includes('bulto vacio')) return json({ error: 'El bulto está vacío: escanea al menos una pieza.' }, 409);
      throw error;
    }
    const despues = (await porFolio(env, folio))!;
    return despues.estado === 'cerrado' ? json({ ...(await vista(env, despues, true)), ya_estaba: despues.transicion !== token }) : cerradoOCancelado();
  }

  // cancelar: solo un bulto abierto; todo vuelve al origen
  if (b.estado === 'cancelado') return json({ ...(await vista(env, b, true)), ya_estaba: true });
  if (b.estado !== 'abierto') return cerradoOCancelado();
  const token = crypto.randomUUID(), ahora = new Date().toISOString();
  const piezas = (await lineasDe(env, b.id)).map((l) => l.producto_id);
  await env.DB.batch([
    env.DB.prepare(`update bultos set estado = 'cancelado', cancelado_por = ?, cancelado_en = ?, transicion = ? where id = ? and estado = 'abierto'`)
      .bind(correo, ahora, token, b.id),
    ...entrarAlBulto(env, b, b.origen, token, 'cancelado', ahora),
  ]);
  conciliar(env, ctx, piezas, [b.origen]);
  const despues = (await porFolio(env, folio))!;
  return despues.estado === 'cancelado' ? json({ ...(await vista(env, despues, true)), ya_estaba: despues.transicion !== token }) : cerradoOCancelado();
}
