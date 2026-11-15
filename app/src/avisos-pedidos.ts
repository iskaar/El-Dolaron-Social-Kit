/**
 * Avisos a la tienda por un apartado (Issue #800, R7 de #793). En línea se vende la mercancía de cualquier tienda y el cliente recoge donde
 * elija: cuando alguien que no es el mostrador de la tienda donde está la pieza la aparta, esa tienda lo ve en /avisos y en el contador de
 * su caja. Las cuatro listas salen del estado de los renglones (`pedido_lineas`), sin tabla de avisos aparte:
 *   por separar  → la pieza está en esta tienda, apartada por otro, y nadie la ha apartado físicamente;
 *   por mandar   → separada, con dinero registrado, y esta tienda no es donde se recoge;
 *   por llegar   → otra tienda ya la mandó hacia esta;
 *   por regresar → el pedido se canceló o venció con la pieza ya separada: falta devolverla al piso.
 * Cada lista se cierra con un toque a nombre de quien lo hace; la transición se condiciona en SQL, así que dos toques a la vez cuentan uno.
 */
import { TIENDAS, esTienda } from './cuentas.ts';
import { pushATienda } from './push.ts';

export const nombreTienda = (clave: string) => esTienda(clave) ? TIENDAS[clave].nombre : clave;

/** Pedido que todavía tiene piezas por entregar: un apartado, o un envío ya liquidado al que aún no se le pone guía. */
export const ACTIVO = `(p.estado = 'apartado' or (p.estado = 'vendido' and p.entrega = 'envio' and p.guia = ''))`;
/** El pedido tiene dinero registrado (anticipo o abono): solo entonces se manda una pieza a otra tienda. */
export const CON_DINERO = `(p.anticipo > 0 or p.saldo > 0 or p.liquidado_en is not null)`;

const DIAS_REGRESAR = 60;
const LISTAS = {
  por_separar: `${ACTIVO} and l.separada_en is null`,
  por_mandar: `${ACTIVO} and l.separada_en is not null and l.enviada_en is null and l.tienda <> p.recoge_en and ${CON_DINERO}`,
  por_llegar: `l.enviada_en is not null and l.llego_en is null`,
  // ponytail: solo los de los últimos 60 días; un apartado cancelado hace más ya no se atiende desde aquí. Mejora: índice por tienda y estado.
  por_regresar: `p.estado in ('cancelado', 'vencido') and p.actualizado_en >= ? and l.separada_en is not null and l.regresada_en is null
    and (l.enviada_en is null or l.llego_en is not null)`,
} as const;

interface FilaAviso {
  folio: number; cliente: string; recoge_en: string; vendedora: string; canal: string | null; producto_id: string; cantidad: number;
  tienda: string; enviada_desde: string | null; codigo: string; nombre: string;
}

/** Las cuatro listas de las tiendas dadas (claves de TIENDAS: seguras para el SQL). */
export async function avisosDePedidos(env: Env, tiendas: readonly string[]) {
  const donde = `l.tienda in (${tiendas.filter(esTienda).map((t) => `'${t}'`).join(', ') || "''"})`;
  const desde = new Date(Date.now() - DIAS_REGRESAR * 86_400_000).toISOString();
  const leer = async (condicion: string) => (await env.DB.prepare(
    `select p.folio, p.cliente, p.recoge_en, p.vendedora, u.nombre as canal, l.producto_id, l.cantidad, l.tienda, l.enviada_desde, pr.codigo, pr.nombre
     from pedido_lineas l join pedidos p on p.id = l.pedido_id join productos pr on pr.id = l.producto_id
       left join usuarios u on u.correo = p.vendedora
     where ${donde} and ${condicion} order by p.folio, pr.nombre limit 100`,
  ).bind(...(condicion.includes('?') ? [desde] : [])).all<FilaAviso>()).results.map((f) => ({
    folio: f.folio, producto_id: f.producto_id, codigo: f.codigo, nombre: f.nombre, cantidad: f.cantidad, cliente: f.cliente,
    canal: f.vendedora === 'portal' ? 'Portal' : f.canal || 'Tienda',
    tienda: f.tienda, tienda_nombre: nombreTienda(f.tienda), recoge_en: f.recoge_en, recoge_en_nombre: nombreTienda(f.recoge_en),
    desde: f.enviada_desde, desde_nombre: f.enviada_desde ? nombreTienda(f.enviada_desde) : null,
  }));
  const [por_separar, por_mandar, por_llegar, por_regresar] = await Promise.all(Object.values(LISTAS).map(leer));
  return { por_separar, por_mandar, por_llegar, por_regresar };
}

export type Accion = 'separar' | 'mandar' | 'llego' | 'regreso';
export const ACCIONES: readonly string[] = ['separar', 'mandar', 'llego', 'regreso'];

/**
 * Cierra un aviso con un toque. `tienda` = la de la terminal ('' = el dueño, que puede marcar en cualquier tienda). El renglón se
 * identifica por folio y pieza. Devuelve: 'ok', 'no_existe' o 'ya' (otra persona lo marcó antes, o ya no aplica).
 */
export async function marcarRenglon(env: Env, folio: number, productoId: string, accion: Accion, quien: string, tienda: string, ahora = new Date().toISOString()):
  Promise<'ok' | 'no_existe' | 'ya'> {
  const renglon = await env.DB.prepare('select l.pedido_id from pedido_lineas l join pedidos p on p.id = l.pedido_id where p.folio = ? and l.producto_id = ?')
    .bind(folio, productoId).first<{ pedido_id: string }>();
  if (!renglon) return 'no_existe';
  // ?1 pedido, ?2 pieza, ?3 hora, ?4 tienda de la terminal ('' = cualquiera), ?5 quien. La condición es la misma para la sentencia
  // que marca y para la que sube `revision`, y se evalúa en SQL dentro del batch: no depende de lo leído antes.
  const enTienda = `(?4 = '' or l.tienda = ?4)`;
  const condicion = {
    separar: `${ACTIVO} and l.separada_en is null and ${enTienda}`,
    mandar: `${ACTIVO} and l.separada_en is not null and l.enviada_en is null and l.tienda <> p.recoge_en and ${CON_DINERO} and ${enTienda}`,
    llego: `l.enviada_en is not null and l.llego_en is null and ${enTienda}`,
    regreso: `p.estado in ('cancelado', 'vencido') and l.separada_en is not null and l.regresada_en is null
      and (l.enviada_en is null or l.llego_en is not null) and ${enTienda}`,
  }[accion];
  const aplica = `exists (select 1 from pedido_lineas l join pedidos p on p.id = l.pedido_id where l.pedido_id = ?1 and l.producto_id = ?2 and ${condicion})`;
  const poner = {
    separar: 'separada_en = ?3, separada_por = ?5',
    // La pieza pasa a pertenecer a la tienda destino: si el pedido se cancela en el camino, la unidad regresa a su existencia.
    mandar: 'enviada_en = ?3, enviada_por = ?5, enviada_desde = tienda, tienda = (select recoge_en from pedidos where id = pedido_lineas.pedido_id)',
    llego: 'llego_en = ?3, llego_por = ?5',
    regreso: 'regresada_en = ?3, regresada_por = ?5',
  }[accion];
  const marca = env.DB.prepare(`update pedido_lineas set ${poner} where pedido_id = ?1 and producto_id = ?2 and ${aplica}`)
    .bind(renglon.pedido_id, productoId, ahora, tienda, quien);
  // Mandar cambia `revision`: un cobro que ya leyó el pedido (y creyó la pieza en la tienda) aborta en lugar de entregar lo que viaja.
  const sentencias = accion === 'mandar'
    ? [env.DB.prepare(`update pedidos set revision = revision + 1 where id = ?1 and ${aplica}`).bind(renglon.pedido_id, productoId, ahora, tienda), marca]
    : [marca];
  const resultados = await env.DB.batch(sentencias);
  return resultados.at(-1)!.meta.changes ? 'ok' : 'ya';
}

/** Un push a cada tienda con piezas por separar (a sus cuentas con notificaciones y a los dueños). Un fallo se registra y nada más. */
export async function avisarTiendas(env: Env, avisos: { tienda: string; titulo: string; cuerpo: string }[]): Promise<void> {
  try {
    // Un push por tienda y pedido, aunque sean varias piezas.
    const unicos = new Map(avisos.map((a) => [`${a.tienda}|${a.cuerpo}`, a]));
    await Promise.all([...unicos.values()].map((a) => pushATienda(env, a.tienda, a.titulo, a.cuerpo)));
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'aviso a la tienda fallido', error: String(error) }));
  }
}

