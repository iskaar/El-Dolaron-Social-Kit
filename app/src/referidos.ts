/**
 * Referidos Dolarones, prototipo con conocidos (Issue #489). Reglas propuestas, NO
 * aprobadas todavia por Isaac ni contempladas en las bases 2026-10-v4:
 *
 * - Quien se une al portal con el codigo de un referente recibe 50 D (30 dias).
 * - Al cobrarle una compra con al menos $150 en dinero, el nuevo y el referente
 *   reciben 25 D cada uno (12 meses, desde la medianoche siguiente).
 * - Cada referente admite hasta 10 personas (tambien en SQL: trigger referidos_tope).
 * - Abierto a todo socio del portal (Issue #597): sin REFERIDOS_ABIERTO='si' el programa
 *   esta apagado; con ella, todo socio tiene codigo. Sin requisito de compra previa.
 *
 * Centavos enteros como todo el dinero (1 D = 100). Nada aqui usa azar: el codigo
 * sale del numero de socio y los premios los fija la venta, en su mismo batch.
 */

import { disponibleDesde, sumarMeses } from './dolarones.ts';

export const D_ALTA = 50_00;
export const D_PREMIO = 25_00;
/** Dinero cobrado (total menos Dolarones usados) que libera el premio. */
export const MINIMO_COMPRA = 150_00;
/** Tambien esta en migracion-055-referidos.sql (trigger referidos_tope). */
export const MAXIMO_REFERIDOS = 10;
export const DIAS_ALTA = 30;
export const MESES_PREMIO = 12;

/* ---------- codigo del referente, puro ---------- */

// Sin I ni O para no confundirlas con 1 y 0.
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const verificador = (digitos: string) =>
  LETRAS[[...digitos].reduce((suma, d, i) => suma + Number(d) * (i + 1), 0) % LETRAS.length];

/** DOL + numero de socio + letra de verificacion. Ej.: socio 42 -> DOL42K. */
export const codigoReferido = (numero: number) => `DOL${numero}${verificador(String(numero))}`;

/** El numero de socio de un codigo bien escrito, o null. Acepta minusculas, espacios y guiones. */
export function numeroDeCodigo(texto: unknown): number | null {
  const m = /^(?:DOL)?(\d{1,7})([A-Z])$/.exec(String(texto ?? '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return m && m[1][0] !== '0' && verificador(m[1]) === m[2] ? Number(m[1]) : null;
}

/** Apagado de emergencia: quitar REFERIDOS_ABIERTO de wrangler.jsonc y desplegar. */
export const programaActivo = (env: Env) => env.REFERIDOS_ABIERTO === 'si';

/* ---------- D1 ---------- */

type Sentencia = D1PreparedStatement;

/** Registro con codigo: la fila de referidos y los 50 D, para el mismo batch que crea el socio. */
export function sentenciasDeAlta(env: Env, p: { nuevoId: string; referenteId: string; ahora: Date }): Sentencia[] {
  const iso = p.ahora.toISOString();
  const lote = crypto.randomUUID();
  return [
    env.DB.prepare(`insert into referidos (nuevo_id, referente_id, estado, creado_en) values (?, ?, 'pendiente', ?)`)
      .bind(p.nuevoId, p.referenteId, iso),
    env.DB.prepare(`insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
      values (?, ?, 'referido', null, ?, ?, ?, ?, ?)`)
      .bind(lote, p.nuevoId, D_ALTA, D_ALTA, iso, new Date(p.ahora.getTime() + DIAS_ALTA * 86_400_000).toISOString(), iso),
    env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
      values (?, ?, null, 'alta_referido', ?, 'portal', ?)`).bind(p.nuevoId, lote, D_ALTA, iso),
  ];
}

export async function pendienteDe(env: Env, nuevoId: string): Promise<string | null> {
  const fila = await env.DB.prepare(`select referente_id from referidos where nuevo_id = ? and estado = 'pendiente'`)
    .bind(nuevoId).first<{ referente_id: string }>();
  return fila?.referente_id ?? null;
}

/**
 * Los 25 + 25 D que libera esta venta, para su MISMO batch. Todo cuelga del primer
 * UPDATE: solo gana una venta, asi que un reintento o dos cajas a la vez no pagan dos veces.
 */
export function sentenciasDeLiberacion(env: Env, p: {
  ventaId: string; nuevoId: string; referenteId: string; autor: string; ahora: Date;
}): Sentencia[] {
  const iso = p.ahora.toISOString();
  const desde = disponibleDesde(p.ahora);
  const vence = sumarMeses(p.ahora, MESES_PREMIO);
  const esta = `exists (select 1 from referidos where nuevo_id = ? and venta_id = ? and estado = 'liberado')`;
  const premio = (clienteId: string, tipo: 'referido' | 'referido_nuevo') => {
    const lote = crypto.randomUUID();
    return [
      env.DB.prepare(`insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
        select ?, ?, 'referido', null, ?, ?, ?, ?, ? where ${esta}`)
        .bind(lote, clienteId, D_PREMIO, D_PREMIO, desde, vence, iso, p.nuevoId, p.ventaId),
      env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
        select ?, ?, ?, ?, ?, ?, ? where ${esta}`)
        .bind(clienteId, lote, p.ventaId, tipo, D_PREMIO, p.autor, iso, p.nuevoId, p.ventaId),
    ];
  };
  return [
    env.DB.prepare(`update referidos set estado = 'liberado', venta_id = ?, liberado_en = ? where nuevo_id = ? and estado = 'pendiente'`)
      .bind(p.ventaId, iso, p.nuevoId),
    ...premio(p.referenteId, 'referido'),
    ...premio(p.nuevoId, 'referido_nuevo'),
  ];
}

/**
 * Cancelar la venta que libero: los dos lotes se retiran y el referido vuelve a
 * pendiente. Si parte de esos 25 D ya se gasto, el lote queda en -1 y el trigger
 * lote_no_negativo aborta toda la cancelacion, igual que lo ganado por compras (#135).
 */
export function sentenciasDeReversoReferido(env: Env, ventaId: string, autor: string, ahora: string): Sentencia[] {
  const liberados = `select lote_id from dolarones_movimientos where venta_id = ? and tipo in ('referido', 'referido_nuevo')`;
  return [
    env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
      select cliente_id, id, ?, 'reverso_referido', -restante, ?, ? from dolarones_lotes
      where restante > 0 and id in (${liberados})`).bind(ventaId, autor, ahora, ventaId),
    env.DB.prepare(`update dolarones_lotes set restante = case
      when importe + coalesce((select sum(importe) from dolarones_movimientos
        where lote_id = dolarones_lotes.id and tipo = 'reverso_referido'), 0) = 0
      then 0 else -1 end where id in (${liberados})`).bind(ventaId),
    env.DB.prepare(`update referidos set estado = 'pendiente', venta_id = null, liberado_en = null where venta_id = ?`).bind(ventaId),
  ];
}

type Revision = { ok: true; referenteId: string } | { ok: false; status: number; error: string };

/** El codigo que escribio quien se registra: existe, no es suyo y no esta lleno. */
export async function revisarCodigo(env: Env, codigo: unknown, quien: { uid: string; telefono: string }): Promise<Revision> {
  if (!programaActivo(env)) return { ok: false, status: 400, error: 'Los referidos todavía no están disponibles. Quita el código para registrarte.' };
  const invalido: Revision = { ok: false, status: 400, error: 'Ese código no es válido. Revísalo o quítalo para registrarte sin él.' };
  const numero = numeroDeCodigo(codigo);
  if (!numero) return invalido;
  const referente = await env.DB.prepare('select id, telefono, auth_uid from clientes where numero = ?')
    .bind(numero).first<{ id: string; telefono: string; auth_uid: string | null }>();
  if (!referente) return invalido;
  if (referente.telefono === quien.telefono || referente.auth_uid === quien.uid)
    return { ok: false, status: 400, error: 'No puedes usar tu propio código.' };
  const { total } = (await env.DB.prepare('select count(*) as total from referidos where referente_id = ?')
    .bind(referente.id).first<{ total: number }>())!;
  if (total >= MAXIMO_REFERIDOS)
    return { ok: false, status: 409, error: 'Ese código ya llegó a su límite de referidos. Quítalo para registrarte sin él.' };
  return { ok: true, referenteId: referente.id };
}

/** Lo que muestra el portal: tu codigo, cuantos llevas y como va tu propia invitacion. */
export async function resumenReferidos(env: Env, socio: { id: string; numero: number }) {
  const puede = programaActivo(env);
  const llevas = puede ? await env.DB.prepare(
    `select count(*) as total, coalesce(sum(estado = 'liberado'), 0) as liberados from referidos where referente_id = ?`)
    .bind(socio.id).first<{ total: number; liberados: number }>() : null;
  const mio = await env.DB.prepare('select estado from referidos where nuevo_id = ?').bind(socio.id).first<{ estado: string }>();
  return {
    habilitado: programaActivo(env), puede_referir: puede,
    codigo: puede ? codigoReferido(socio.numero) : null,
    maximo: MAXIMO_REFERIDOS, referidos: llevas?.total ?? 0, liberados: llevas?.liberados ?? 0,
    pendientes: (llevas?.total ?? 0) - (llevas?.liberados ?? 0),
    premio: D_PREMIO, alta: D_ALTA, minimo_compra: MINIMO_COMPRA,
    mi_referido: mio ? { estado: mio.estado } : null,
  };
}
