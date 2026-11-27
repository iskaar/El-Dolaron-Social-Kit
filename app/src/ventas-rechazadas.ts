/**
 * Ventas cobradas sin red que el servidor rechazó al sincronizar (Issue #819, tabla de la migración 079).
 * La caja reporta cada una aquí, idempotente por el folio de la venta; el dueño las ve y las marca resueltas en /avisos.
 * Sin acción automática: no mueve existencias ni dinero. Guarda lo que el ticket ya contiene, sin datos del cliente.
 * Tienda y cajero salen de la sesión del servidor, nunca del cuerpo. Reportar es de caja; listar y resolver, del dueño (permiso()).
 */
import { avisarDueno } from './avisos.ts';
import { cajaDe } from './corte.ts';
import { TIENDAS, esTienda } from './cuentas.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMAS = ['efectivo', 'tarjeta', 'transferencia', 'mixto'];
const MAX_LINEAS = 100;

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const texto = (valor: unknown, max: number) => String(valor ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const entero = (valor: unknown, max: number) => Number.isInteger(valor) && (valor as number) >= 0 && (valor as number) <= max ? valor as number : null;
const pesos = (centavos: number) => `$${(centavos / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** POST /api/ventas/:id/rechazo — la caja avisa que el servidor rechazó una venta que ya cobró. */
export async function reportarRechazo(id: string, request: Request, env: Env, ctx: ExecutionContext, correo: string, tienda: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: 'Identificador de venta invalido.' }, 400);
  const cuerpo = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const crudas = Array.isArray(cuerpo.lineas) ? cuerpo.lineas as Record<string, unknown>[] : [];
  const lineas = crudas.map((l) => ({
    codigo: texto(l?.codigo, 40), nombre: texto(l?.nombre, 120), cantidad: entero(l?.cantidad, 999), precio: entero(l?.precio, 10_000_000),
  }));
  const formaPago = String(cuerpo.forma_pago ?? '');
  const motivo = texto(cuerpo.motivo, 300);
  if (!lineas.length || lineas.length > MAX_LINEAS || lineas.some((l) => !l.cantidad || l.precio === null)
    || !FORMAS.includes(formaPago) || !motivo) return json({ error: 'Reporte de venta rechazada invalido.' }, 400);
  // Si el folio ya es una venta registrada (el reintento sí pasó), no hay nada que reportar.
  if (await env.DB.prepare('select 1 as x from ventas where id = ?').bind(id).first()) return json({ ok: true, registrada: true });

  const piezas = lineas.reduce((n, l) => n + l.cantidad!, 0);
  const total = lineas.reduce((n, l) => n + l.precio! * l.cantidad!, 0);
  const hora = Date.parse(String(cuerpo.creado_en ?? ''));
  const ahora = new Date().toISOString();
  const caja = await cajaDe(env, correo, cuerpo.caja, tienda).catch(() => '');
  const { meta } = await env.DB.prepare(
    `insert into ventas_rechazadas (id, tienda, caja, cajero, creado_en, reportada_en, forma_pago, efectivo, total, piezas, lineas, motivo)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
  ).bind(id, tienda, caja, correo, Number.isFinite(hora) && hora <= Date.now() + 300_000 ? new Date(hora).toISOString() : ahora, ahora, formaPago,
    entero(cuerpo.efectivo, 100_000_000) ?? 0, total, piezas, JSON.stringify(lineas), motivo).run();
  // Solo la primera vez avisa: un reintento del reporte no vuelve a molestar al dueño.
  if (meta.changes) {
    const donde = [caja, esTienda(tienda) ? TIENDAS[tienda].nombre : ''].filter(Boolean).join(', ');
    avisarDueno(env, ctx, request, 'Venta rechazada', `Una venta de ${pesos(total)} (${formaPago}) ya cobrada${donde ? ` en ${donde}` : ''} fue rechazada al sincronizar: ${motivo}`,
      { frase: 'Revísala en', ruta: '/avisos' });
  }
  return json({ ok: true, registrada: false }, meta.changes ? 201 : 200);
}

interface Fila { id: string; tienda: string; caja: string; cajero: string; creado_en: string; reportada_en: string; forma_pago: string;
  efectivo: number; total: number; piezas: number; lineas: string; motivo: string; registrada: number }

/** GET /api/ventas-rechazadas — las pendientes, para /avisos (solo el dueño). `registrada`: el reintento sí entró, ya no hay dinero sin venta. */
export async function listarRechazadas(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `select r.id, r.tienda, r.caja, r.cajero, r.creado_en, r.reportada_en, r.forma_pago, r.efectivo, r.total, r.piezas, r.lineas, r.motivo,
       exists (select 1 from ventas v where v.id = r.id) as registrada
     from ventas_rechazadas r where r.estado = 'pendiente' order by r.reportada_en`,
  ).all<Fila>();
  return json(results.map((f) => ({ ...f, lineas: JSON.parse(f.lineas), registrada: f.registrada === 1,
    tienda_nombre: esTienda(f.tienda) ? TIENDAS[f.tienda].nombre : f.tienda })));
}

/** POST /api/ventas-rechazadas/:id/resolver { nota } — el dueño la da por atendida. Solo marca: no toca existencias ni dinero. */
export async function resolverRechazada(id: string, request: Request, env: Env, dueno: string): Promise<Response> {
  const nota = texto(((await request.json().catch(() => ({}))) as Record<string, unknown>).nota, 300);
  if (!nota) return json({ error: 'Escribe una nota de cómo se resolvió.' }, 400);
  const { meta } = await env.DB.prepare(
    `update ventas_rechazadas set estado = 'resuelta', nota = ?, resuelta_en = ?, resuelta_por = ? where id = ? and estado = 'pendiente'`,
  ).bind(nota, new Date().toISOString(), dueno, id).run();
  if (meta.changes) return json({ ok: true });
  const existe = await env.DB.prepare('select 1 as x from ventas_rechazadas where id = ?').bind(id).first();
  return existe ? json({ error: 'Otra persona ya la resolvió.' }, 409) : json({ error: 'La venta rechazada no existe.' }, 404);
}
