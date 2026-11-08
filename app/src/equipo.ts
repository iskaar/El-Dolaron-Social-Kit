/**
 * Equipo en /reportes (Issue #751, Fase 1 de #749): lo que hizo cada persona en el rango y el bono semanal de la tienda.
 * Bono: si las ventas netas de una semana cerrada (lunes a domingo, fecha de tienda) SUPERAN la meta, la bolsa es
 * `bono_tienda_pb` puntos base (100 = 1 %) de esas ventas y se reparte por dias trabajados de ESA semana. Sin ranking.
 * Todo en centavos enteros; el bono se paga como `nomina_movimientos` tipo 'bono' (nomina.ts).
 */
import { lineasNetas } from './netas.ts';
import { vendedoras } from './cajeros.ts';
import { delDia, hoyTienda, rangoDe } from './reportes.ts';

const json = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
});
const DIA_MS = 86_400_000;
const sumarDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
/** El lunes de la semana de `dia` (lunes a domingo). */
export const lunesDe = (dia: string) => sumarDias(dia, -((new Date(`${dia}T12:00:00Z`).getUTCDay() + 6) % 7));
/** Los lunes de las `n` semanas ya cerradas (la de hoy no), de la mas reciente a la mas vieja. */
export const semanasCerradas = (hoy: string, n = 8) =>
  Array.from({ length: n }, (_, i) => sumarDias(lunesDe(hoy), -7 * (i + 1)));
export const notaBono = (lunes: string) => `bono tienda semana ${lunes}`;

/**
 * Reparte `bolsa` centavos por dias trabajados: floor(bolsa x dias / total) a cada quien y el resto a quien mas dias tiene (empate: orden alfabetico de correo). Siempre suma exactamente `bolsa`.
 */
export function repartirBono<T extends { correo: string; dias: number }>(bolsa: number, personas: T[]) {
  const total = personas.reduce((s, p) => s + p.dias, 0);
  if (!total || bolsa <= 0) return personas.map((p) => ({ ...p, importe: 0 }));
  const partes = personas.map((p) => ({ ...p, importe: Math.floor(bolsa * p.dias / total) }));
  const primero = partes.reduce((m, p) => (p.dias > m.dias || (p.dias === m.dias && p.correo < m.correo) ? p : m));
  primero.importe += bolsa - partes.reduce((s, p) => s + p.importe, 0);
  return partes;
}

interface ConfigBono { pb: number; meta: number }
async function configBono(env: Env): Promise<ConfigBono> {
  const { results } = await env.DB.prepare(`select clave, valor from config where clave in ('bono_tienda_pb', 'bono_tienda_meta_semana')`)
    .all<{ clave: string; valor: string }>();
  const v = (clave: string, omision: number) => {
    const n = Number(results.find((f) => f.clave === clave)?.valor);
    return Number.isInteger(n) && n >= 0 ? n : omision;
  };
  return { pb: v('bono_tienda_pb', 100), meta: v('bono_tienda_meta_semana', 10_000_000) };
}

/** Para cada lunes: ventas netas (mismo neto que el Resumen), meta, bolsa y la parte de cada empleada ligada. */
export async function semanasBono(env: Env, lunes: string[]) {
  const config = await configBono(env);
  const primero = [...lunes].sort()[0];
  const ultimo = sumarDias([...lunes].sort().at(-1)!, 7);   // el lunes siguiente: limite exclusivo
  const { results: ventas } = await env.DB.prepare(
    `${lineasNetas('v.creado_en >= ? and v.creado_en < ?')}
     select date(datetime(creado_en, '-6 hours'), 'weekday 0', '-6 days') as lunes, coalesce(sum(neta), 0) as total
     from netas where propietario = 'dolaron' group by lunes`,
  ).bind(delDia(primero)[0], delDia(ultimo)[0]).all<{ lunes: string; total: number }>();
  const { results: asistencias } = await env.DB.prepare(
    `select e.id, e.nombre, e.correo, a.fecha from asistencias a join empleados e on e.id = a.empleado_id
     where e.activo = 1 and e.correo <> '' and a.fecha >= ? and a.fecha < ?`,
  ).bind(primero, ultimo).all<{ id: string; nombre: string; correo: string; fecha: string }>();
  const { results: hechos } = await env.DB.prepare(
    `select empleado_id, nota from nomina_movimientos where tipo = 'bono' and nota like 'bono tienda semana %'`,
  ).all<{ empleado_id: string; nota: string }>();
  const registrados = new Set(hechos.map((h) => `${h.nota}|${h.empleado_id}`));

  return lunes.map((dia) => {
    const total = ventas.find((v) => v.lunes === dia)?.total ?? 0;
    const alcanzada = total > config.meta;
    const bolsa = alcanzada ? Math.floor(total * config.pb / 10_000) : 0;
    const dias = new Map<string, { id: string; nombre: string; correo: string; dias: number }>();
    for (const a of asistencias) {
      if (a.fecha < dia || a.fecha > sumarDias(dia, 6)) continue;
      const p = dias.get(a.id) ?? { id: a.id, nombre: a.nombre, correo: a.correo, dias: 0 };
      p.dias++;
      dias.set(a.id, p);
    }
    const partes = repartirBono(bolsa, [...dias.values()]).map((p) => ({
      empleado_id: p.id, nombre: p.nombre, correo: p.correo, dias: p.dias, importe: p.importe,
      registrado: registrados.has(`${notaBono(dia)}|${p.id}`),
    }));
    return { lunes: dia, domingo: sumarDias(dia, 6), ventas: total, meta: config.meta, alcanzada, bolsa, partes };
  });
}

/** GET /api/reportes/equipo?dias=N: tabla por persona del rango y las ultimas 8 semanas cerradas. */
export async function reporteEquipo(url: URL, env: Env): Promise<Response> {
  const rango = rangoDe(url);
  const { desde } = rango;
  type Fila = { correo: string; [campo: string]: string | number };
  const [ventas, socios, apartados, piezas, trabajados] = await Promise.all([
    // Neto por ticket (igual que el Resumen), atribuido a quien atendio; '' = sin atribuir.
    env.DB.prepare(
      `${lineasNetas('v.creado_en >= ?')}
       select v.vendedora as correo, count(distinct n.venta) as tickets, coalesce(sum(n.neta), 0) as ventas
       from netas n join ventas v on v.id = n.venta where n.propietario = 'dolaron' group by v.vendedora`,
    ).bind(desde).all<Fila>(),
    env.DB.prepare(
      `select c.registrado_por as correo, count(*) as socios,
         coalesce(sum(exists(select 1 from ventas v where v.cliente_id = c.id and v.cancelada = 0
           and substr(datetime(v.creado_en, '-6 hours'), 1, 10) = substr(datetime(c.creado_en, '-6 hours'), 1, 10))), 0) as socios_compraron
       from clientes c where c.creado_en >= ? group by c.registrado_por`,
    ).bind(desde).all<Fila>(),
    env.DB.prepare(
      `select p.vendedora as correo, count(*) as apartados from pedidos p join ventas v on v.id = p.venta_id
       where p.estado = 'vendido' and v.cancelada = 0 and v.creado_en >= ? group by p.vendedora`,
    ).bind(desde).all<Fila>(),
    env.DB.prepare(
      `select p.capturado_por as correo, count(*) as capturadas,
         coalesce(sum(exists(select 1 from venta_lineas l join ventas v on v.id = l.venta_id
           where l.producto_id = p.id and v.cancelada = 0 and l.cantidad > l.cancelada_cantidad
             and julianday(v.creado_en) - julianday(p.creado_en) <= 14)), 0) as vendidas_14
       from productos p where p.capturado_por <> '' and p.creado_en >= ? and p.sin_inventario = 0
         and p.propietario = 'dolaron' and p.estado_analisis <> 'descartado' group by p.capturado_por`,
    ).bind(desde).all<Fila>(),
    env.DB.prepare(
      `select e.correo, count(*) as dias_trabajados from asistencias a join empleados e on e.id = a.empleado_id
       where e.correo <> '' and a.fecha >= ? and a.fecha <= ? group by e.correo`,
    ).bind(rango.dia_desde, rango.dia_hasta).all<Fila>(),
  ]);
  const { results: usuarios } = await env.DB.prepare('select correo, nombre from usuarios').all<{ correo: string; nombre: string }>();
  const nombres = new Map(usuarios.map((u) => [u.correo, u.nombre]));
  const personas = new Map<string, Record<string, unknown>>();
  const fila = (correo: string) => {
    if (!personas.has(correo)) {
      personas.set(correo, { correo, nombre: correo ? nombres.get(correo) || correo : 'Sin atribuir', ventas: 0, tickets: 0,
        socios: 0, socios_compraron: 0, apartados: 0, capturadas: 0, vendidas_14: 0, dias_trabajados: 0 });
    }
    return personas.get(correo)!;
  };
  for (const v of await vendedoras(env)) fila(v.correo);
  for (const origen of [ventas, socios, apartados, piezas, trabajados]) {
    for (const { correo, ...datos } of origen.results) Object.assign(fila(correo), datos);
  }
  return json({
    dias: rango.dias, dia_desde: rango.dia_desde, dia_hasta: rango.dia_hasta,
    personas: [...personas.values()].filter((p) => p.correo || p.tickets).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre))),
    semanas: await semanasBono(env, semanasCerradas(hoyTienda())),
    config: await configBono(env),
  });
}

/**
 * POST /api/reportes/equipo/bono { semana: 'YYYY-MM-DD' (lunes) }: asienta el bono de una semana CERRADA.
 * Un movimiento por empleada, fechado el domingo de esa semana, con id fijo y nota `bono tienda semana <lunes>`:
 * repetir la llamada (o dos a la vez) no duplica; lo que ya estaba se reporta aparte.
 */
export async function registrarBonoSemana(request: Request, env: Env, correo: string, ahora = Date.now()): Promise<Response> {
  const { semana } = await request.json().catch(() => ({})) as { semana?: unknown };
  if (typeof semana !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(semana) || lunesDe(semana) !== semana
      || Number.isNaN(Date.parse(`${semana}T12:00:00Z`))) return json({ error: 'La semana debe ser un lunes (AAAA-MM-DD).' }, 400);
  if (sumarDias(semana, 6) >= hoyTienda(ahora)) return json({ error: 'Esa semana aún no termina.' }, 400);
  const [plan] = await semanasBono(env, [semana]);
  const pendientes = plan.partes.filter((p) => p.importe > 0);
  if (!plan.bolsa) return json({ semana, bolsa: 0, alcanzada: plan.alcanzada, creados: [], ya_estaban: [] });
  const nuevos = pendientes.filter((p) => !p.registrado);
  const creado = new Date().toISOString();
  if (nuevos.length) {
    await env.DB.batch(nuevos.map((p) => env.DB.prepare(
      `insert into nomina_movimientos (id, empleado_id, fecha, tipo, importe, nota, creado_por, creado_en)
       values (?, ?, ?, 'bono', ?, ?, ?, ?) on conflict(id) do nothing`,
    ).bind(`bono-tienda:${semana}:${p.empleado_id}`, p.empleado_id, plan.domingo, p.importe, notaBono(semana), correo, creado)));
  }
  const nombre = (p: { nombre: string; importe: number }) => ({ nombre: p.nombre, importe: p.importe });
  return json({ semana, bolsa: plan.bolsa, alcanzada: true, creados: nuevos.map(nombre),
    ya_estaban: pendientes.filter((p) => p.registrado).map(nombre) }, nuevos.length ? 201 : 200);
}
