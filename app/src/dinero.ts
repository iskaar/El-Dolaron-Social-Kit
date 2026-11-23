/**
 * Recolección del efectivo de los cortes por tienda (Issue #909, fase 1 de #908). Solo gerencia (cuentas.ts).
 *
 * Un corte fija cuánto se entrega (`entregado`). Gerencia recoge, cuenta y escribe el total; quien entrega firma con su PIN.
 * Cada corte entra a una sola recolección: `recolecciones_cortes.corte_id` es llave primaria (migración 089) y las marcas y la
 * recolección se escriben en un mismo batch. Lo esperado sale de lo que de verdad quedó marcado, no de lo que mandó la pantalla:
 * si otro dispositivo se adelantó con un corte, la recolección lo deja fuera y la respuesta lo dice.
 */
import { TIENDAS, tiendaDeCaja, apruebaDinero, leerRoles, esTienda, type Rol } from './cuentas.ts';
import { atiende, verificarPinAprobacion } from './cajeros.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const CLAVE_DESDE = 'recolecciones_desde';
const MAX_CORTES = 200;
const HISTORIAL = 30;

/** Quien puede entregar el efectivo de una tienda: su personal con PIN (cajero, capturista, supervisor) o gerencia. */
const puedeEntregar = (roles: Rol[]) => atiende(roles) || apruebaDinero(roles);

interface Pendiente { id: string; caja: string; cajero: string; cajero_nombre: string | null; hasta: string; entregado: number; diferencia: number }

const desdeConfig = async (env: Env) =>
  (await env.DB.prepare('select valor from config where clave = ?').bind(CLAVE_DESDE).first<{ valor: string }>())?.valor ?? null;
const SIN_MIGRAR = () => json({ error: 'Falta actualizar el sistema (migración 089): avisa a Isaac.' }, 503);

const leerRecoleccion = async (env: Env, id: string) => {
  const fila = await env.DB.prepare(
    `select r.*, (select nombre from usuarios where correo = r.recibio) as recibio_nombre,
            (select nombre from usuarios where correo = r.entrego) as entrego_nombre from recolecciones r where r.id = ?`,
  ).bind(id).first<Record<string, unknown> & { tienda: string }>();
  if (!fila) return null;
  const { results: cortes } = await env.DB.prepare(
    `select c.id, c.caja, c.hasta, c.entregado from recolecciones_cortes x join cortes c on c.id = x.corte_id
     where x.recoleccion_id = ? order by c.hasta`,
  ).bind(id).all();
  return { ...fila, tienda_nombre: esTienda(fila.tienda) ? TIENDAS[fila.tienda].nombre : fila.tienda, cortes };
};

async function listar(env: Env): Promise<Response> {
  const desde = await desdeConfig(env);
  if (desde === null) return SIN_MIGRAR();
  const { results: pendientes } = await env.DB.prepare(
    `select c.id, c.caja, c.cajero, u.nombre as cajero_nombre, c.hasta, c.entregado, c.diferencia from cortes c
       left join usuarios u on u.correo = c.cajero
      where c.entregado > 0 and c.hasta >= ? and not exists (select 1 from recolecciones_cortes x where x.corte_id = c.id)
      order by c.hasta`,
  ).bind(desde).all<Pendiente>();
  const { results: usuarios } = await env.DB.prepare(
    `select correo, nombre, roles, tienda from usuarios where activo = 1 and pin_hash != '' order by nombre`,
  ).all<{ correo: string; nombre: string; roles: string; tienda: string }>();
  const tiendas = (Object.keys(TIENDAS) as (keyof typeof TIENDAS)[]).map((clave) => {
    const cortes = pendientes.filter((c) => tiendaDeCaja(c.caja) === clave);
    return {
      clave, nombre: TIENDAS[clave].nombre, cortes, total: cortes.reduce((suma, c) => suma + c.entregado, 0),
      // Quienes pueden firmar la entrega: personal de esa tienda (sin tienda cuenta como Soledad, igual que en la caja) y gerencia.
      personal: usuarios.filter((u) => {
        const roles = leerRoles(u.roles);
        return puedeEntregar(roles) && (roles.includes('dueno') || (esTienda(u.tienda) ? u.tienda : 'soledad') === clave);
      }).map(({ correo, nombre }) => ({ correo, nombre })),
    };
  });
  const { results: ultimas } = await env.DB.prepare('select id from recolecciones order by creado_en desc, id limit ?').bind(HISTORIAL).all<{ id: string }>();
  const recolecciones = await Promise.all(ultimas.map((r) => leerRecoleccion(env, r.id)));
  return json({ desde, tiendas, recolecciones });
}

async function recoger(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  const tienda = String(cuerpo.tienda ?? '');
  const contado = Number(cuerpo.contado);
  const nota = texto(cuerpo.nota, 300);
  const pedidos = Array.isArray(cuerpo.cortes) ? [...new Set(cuerpo.cortes.map(String))] : [];
  if (!UUID.test(id)) return json({ error: 'Identificador invalido.' }, 400);
  if (!esTienda(tienda)) return json({ error: 'Tienda invalida.' }, 400);
  if (pedidos.length === 0 || pedidos.length > MAX_CORTES || !pedidos.every((c) => UUID.test(c))) return json({ error: 'Elige los cortes que recoges.' }, 400);
  if (!Number.isInteger(contado) || contado < 0 || contado > 100_000_000) return json({ error: 'Total contado invalido.' }, 400);

  const desde = await desdeConfig(env);
  if (desde === null) return SIN_MIGRAR();

  // Reenvío tras red caída: la misma recolección, sin volver a pedir el PIN ni a marcar nada.
  const previo = await leerRecoleccion(env, id);
  if (previo) return previo.tienda === tienda ? json({ ...previo, repetida: true }) : json({ error: 'Ese identificador ya se usó en otra tienda.' }, 409);

  // Firma de quien entrega: su PIN, con los 5 intentos y 15 minutos de la aprobación (cajeros.ts), contados aparte de su acceso a la caja.
  // Sin `entrego` se guarda sin firma. No se firma a uno mismo. Un PIN malo no registra nada: se verifica antes de tocar los cortes.
  let entrego = '';
  if (cuerpo.entrego) {
    entrego = String(cuerpo.entrego).trim().toLowerCase();
    if (entrego === correo) return json({ error: 'Quien recibe no puede firmar la entrega: elige a quien entrega.' }, 400);
    const firma = await verificarPinAprobacion(env, entrego, String(cuerpo.pin ?? ''), `recoleccion:${tienda}`, puedeEntregar, tienda);
    if ('error' in firma) return json({ error: firma.error }, firma.status);
    entrego = firma.fila.correo;
  }

  // Candidatos: de lo pedido, de esta tienda, aún sin recolección y desde la fecha de arranque.
  const { results: candidatos } = await env.DB.prepare(
    `select c.id, c.caja, c.entregado from cortes c
      where c.id in (select value from json_each(?)) and c.entregado > 0 and c.hasta >= ?
        and not exists (select 1 from recolecciones_cortes x where x.corte_id = c.id)`,
  ).bind(JSON.stringify(pedidos), desde).all<{ id: string; caja: string; entregado: number }>();
  const propios = candidatos.filter((c) => tiendaDeCaja(c.caja) === tienda);
  if (propios.length === 0) return json({ error: 'Esos cortes ya no están pendientes en esta tienda: abre /dinero otra vez.' }, 409);
  const previsto = propios.reduce((suma, c) => suma + c.entregado, 0);
  if (contado !== previsto && !nota) return json({ error: 'Hay diferencia entre lo esperado y lo contado: escribe una nota que la explique.' }, 400);

  // Marcar y registrar en un mismo batch. Lo esperado se calcula de lo que de verdad quedó marcado (otro dispositivo pudo adelantarse entre
  // la lectura y aquí); si no quedó marcado ninguno, no se inserta nada. Los candidatos se vuelven a filtrar en SQL.
  const ahora = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `insert into recolecciones_cortes (corte_id, recoleccion_id)
         select c.id, ?1 from cortes c
          where c.id in (select value from json_each(?2)) and c.entregado > 0 and c.hasta >= ?3
            and not exists (select 1 from recolecciones_cortes x where x.corte_id = c.id)`,
      ).bind(id, JSON.stringify(propios.map((c) => c.id)), desde),
      env.DB.prepare(
        `insert into recolecciones (id, tienda, recibio, entrego, esperado, contado, diferencia, nota, creado_en)
         select ?1, ?2, ?3, ?4, suma, ?5, ?5 - suma, ?6, ?7
           from (select coalesce(sum(c.entregado), 0) as suma, count(*) as n
                   from recolecciones_cortes x join cortes c on c.id = x.corte_id where x.recoleccion_id = ?1)
          where n > 0`,
      ).bind(id, tienda, correo, entrego, contado, nota, ahora),
    ]);
  } catch (error) {
    // Dos envíos del mismo id a la vez: el segundo choca con la llave y el primero ya quedó.
    const ya = await leerRecoleccion(env, id);
    if (ya) return json({ ...ya, repetida: true });
    // La diferencia pedía nota y lo pendiente cambió entre la lectura y el batch: el batch se deshizo entero.
    if (String(error).includes('CHECK constraint')) return json({ error: 'Lo pendiente cambió mientras contabas: abre /dinero otra vez.' }, 409);
    throw error;
  }
  const recoleccion = await leerRecoleccion(env, id);
  // Ningún corte quedó marcado (otro dispositivo se adelantó con todos): no se creó nada.
  if (!recoleccion) return json({ error: 'Esos cortes ya los recogió otro dispositivo: abre /dinero otra vez.' }, 409);
  const tomados = recoleccion.cortes.length;
  return json({ ...recoleccion, pedidos: pedidos.length, tomados, parcial: tomados < pedidos.length }, 201);
}

async function cambiarDesde(request: Request, env: Env): Promise<Response> {
  const { desde } = (await request.json().catch(() => ({}))) as { desde?: unknown };
  // Una fecha (AAAA-MM-DD) es la medianoche de la tienda (UTC-6); también se acepta un ISO completo.
  const crudo = typeof desde === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(desde) ? `${desde}T06:00:00.000Z` : desde;
  const fecha = typeof crudo === 'string' ? new Date(crudo) : null;
  if (!fecha || Number.isNaN(fecha.valueOf())) return json({ error: 'Fecha invalida.' }, 400);
  const resultado = await env.DB.prepare('update config set valor = ? where clave = ?').bind(fecha.toISOString(), CLAVE_DESDE).run();
  if (!resultado.meta.changes) return SIN_MIGRAR();
  return json({ desde: fecha.toISOString() });
}

export async function rutaDinero(request: Request, env: Env, url: URL, correo: string): Promise<Response> {
  if (url.pathname === '/api/dinero' && request.method === 'GET') return listar(env);
  if (url.pathname === '/api/dinero/recolecciones' && request.method === 'POST') return recoger(request, env, correo);
  if (url.pathname === '/api/dinero/desde' && request.method === 'PUT') return cambiarDesde(request, env);
  return json({ error: 'Metodo no permitido.' }, 405);
}
