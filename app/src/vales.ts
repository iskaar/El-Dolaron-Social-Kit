import { dolaronesGanados } from '../public/venta.js';
import { basesListas, codigoAleatorio, disponibleDesde, promocionIniciada, sumarMeses } from './dolarones.ts';
import { verificarPin } from './cajeros.ts';
import { leerUsuario } from './cuentas.ts';

const CODIGO = /^DP-[A-Za-z0-9_-]{16}$/;
// ponytail: vale de prueba de 6 digitos (Issue #279), solo en el sandbox; produccion acepta solo DP-.
const CODIGO_PRUEBA = /^\d{6}$/;
export const codigoValeValido = (env: Env, codigo: string) =>
  CODIGO.test(codigo) || (env.AMBIENTE === 'sandbox' && CODIGO_PRUEBA.test(codigo));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const valesAbiertos = (env: Env, ahora = new Date()) => env.VALES_ABIERTOS === 'si' && basesListas(env) && promocionIniciada(env, ahora);
type Vale = { id: string; codigo: string; importe: number; restante: number; disponible_desde: string; vence_en: string; creado_en: string };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' },
});

// ponytail: el código al portador se conserva para reimprimir desde otra caja.
// Sólo APIs del personal autorizado lo exponen, no listas, portal ni logs.
export async function valeDeVenta(env: Env, id: string): Promise<Vale | null> {
  return env.DB.prepare(`select k.id, k.codigo, k.importe, k.restante, k.disponible_desde, k.vence_en, k.creado_en
    from vales_dolarones k join ventas v on v.id = k.venta_id where v.id = ? and v.cancelada = 0`)
    .bind(id).first<Vale>();
}

/** Los vales con que se pago la venta, en el orden en que se gastaron (se pueden juntar varios, Isaac 17/10). */
export async function valesUsadosEnVenta(env: Env, id: string): Promise<Vale[]> {
  return (await env.DB.prepare(`select k.id, k.codigo, k.importe, k.restante, k.disponible_desde, k.vence_en, k.creado_en
    from vales_dolarones k join vales_movimientos m on m.vale_id = k.id
    join ventas v on v.id = m.venta_id where m.venta_id = ? and m.tipo = 'canje' and v.cancelada = 0 order by m.id`)
    .bind(id).all<Vale>()).results;
}

/** Para respuestas: `vales_usados` y, para cajas viejas, `vale_usado` (el primero). */
export async function usadosEnVenta(env: Env, id: string) {
  const vales = await valesUsadosEnVenta(env, id);
  return { vale_usado:vales[0] ?? null, vales_usados:vales };
}

// ponytail: tope de vales por ticket, para que una lista enorme no arme un batch enorme.
export const MAXIMO_VALES = 10;

export async function buscarVale(request: Request, env: Env): Promise<Response> {
  const body = await request.json().then((c) => c ?? {}, () => ({})) as { codigo?: unknown };
  const codigo = String(body.codigo ?? '');
  if (!codigoValeValido(env, codigo)) return json({ error:'Código de vale inválido.' }, 400);
  const ahora = new Date().toISOString();
  const vale = await env.DB.prepare(`select k.restante, k.vence_en from vales_dolarones k
    left join ventas v on v.id = k.venta_id where k.codigo = ? and coalesce(v.cancelada, 0) = 0
    and k.restante > 0 and k.disponible_desde <= ? and k.vence_en > ?`)
    .bind(codigo, ahora, ahora).first<{ restante: number; vence_en: string }>();
  if (!vale) return json({ error:'Vale no disponible: aún no liberado, vencido, agotado o cancelado.' }, 403);
  return json({ vale:true, disponible:vale.restante, maximo:vale.restante,
    expira_en:vale.vence_en, regalo_disponible:0, por_liberar:0 });
}

export async function reimprimirVale(env: Env, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error:'Venta inválida.' }, 400);
  const vale = await valeDeVenta(env, id);
  if (!vale || vale.restante <= 0 || vale.vence_en <= new Date().toISOString())
    return json({ error:'Esta venta no tiene vale con saldo vigente.' }, 404);
  return json(vale);
}

type Resultado = { ok:true; sentencias:D1PreparedStatement[]; emitido:Vale | null }
  | { ok:false; error:string; status:number };

/** Emisión y canje van en el mismo batch que dinero, stock y venta. */
export async function sentenciasVale(env: Env, p: {
  ventaId:string; clienteId:string | null; codigo:unknown; dolarones:number; total:number; autor:string; ahora:Date;
}): Promise<Resultado> {
  if (!Number.isSafeInteger(p.total) || p.total < 0 || !Number.isSafeInteger(p.dolarones) || p.dolarones < 0 || p.dolarones > p.total)
    return { ok:false, status:400, error:'Importe de Dolarones inválido.' };
  // Uno (texto, como siempre) o varios vales juntos (lista); nunca con membresía.
  const codigos = (Array.isArray(p.codigo) ? p.codigo : p.codigo ? [p.codigo] : []).map(String);
  if (codigos.length && (p.clienteId || codigos.some((c) => !codigoValeValido(env, c))))
    return { ok:false, status:400, error:'Usa vales o una membresía, no ambos en el mismo ticket.' };
  if (new Set(codigos).size !== codigos.length || codigos.length > MAXIMO_VALES)
    return { ok:false, status:400, error:`Cada vale una sola vez, hasta ${MAXIMO_VALES} por ticket.` };
  const ahora = p.ahora.toISOString();
  const sentencias:D1PreparedStatement[] = [];
  if (codigos.length && p.dolarones > 0) {
    const { results:vales } = await env.DB.prepare(`select k.id, k.restante from vales_dolarones k
      left join ventas v on v.id = k.venta_id
      where k.codigo in (${codigos.map(() => '?').join(',')}) and coalesce(v.cancelada, 0) = 0 and k.restante > 0
      and k.disponible_desde <= ? and k.vence_en > ? order by k.vence_en, k.id`)
      .bind(...codigos, ahora, ahora).all<{ id:string; restante:number }>();
    const saldo = vales.reduce((suma, k) => suma + k.restante, 0);
    if (vales.length !== codigos.length || saldo < p.dolarones)
      return { ok:false, status:409, error:'Vale no disponible o saldo insuficiente. Vuelve a escanearlo.' };
    // Primero se gasta el que vence antes (bases, punto 9); uno que no hace falta no se toca.
    let falta = p.dolarones;
    for (const vale of vales) {
      const usa = Math.min(vale.restante, falta);
      if (usa === 0) break;
      falta -= usa;
      sentencias.push(
        env.DB.prepare(`update vales_dolarones set restante = case
          when disponible_desde <= ? and vence_en > ? and vence_en > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          and coalesce((select cancelada from ventas where id = venta_id), 0) = 0
          then restante - ? else -1 end where id = ?`).bind(ahora, ahora, usa, vale.id),
        env.DB.prepare(`insert into vales_movimientos (vale_id, venta_id, tipo, importe, autor, creado_en)
          values (?, ?, 'canje', ?, ?, ?)`).bind(vale.id, p.ventaId, -usa, p.autor, ahora),
      );
    }
  }
  let emitido:Vale | null = null;
  const ganados = dolaronesGanados(p.total - p.dolarones, 5);
  if (!p.clienteId && valesAbiertos(env, p.ahora) && ganados > 0) {
    emitido = { id:crypto.randomUUID(), codigo:codigoAleatorio('DP'), importe:ganados, restante:ganados,
      disponible_desde:ahora, vence_en:new Date(p.ahora.getTime() + 30 * 86_400_000).toISOString(), creado_en:ahora };
    sentencias.push(
      env.DB.prepare(`insert into vales_dolarones
        (id, venta_id, codigo, importe, restante, disponible_desde, vence_en, creado_en) values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(emitido.id, p.ventaId, emitido.codigo, ganados, ganados, emitido.disponible_desde, emitido.vence_en, ahora),
      env.DB.prepare(`insert into vales_movimientos (vale_id, venta_id, tipo, importe, autor, creado_en)
        values (?, ?, 'emision', ?, ?, ?)`).bind(emitido.id, p.ventaId, ganados, p.autor, ahora),
    );
  }
  return { ok:true, sentencias, emitido };
}

/** Retira lo ganado de más; importe original y vencimiento quedan intactos. Un vale ya pasado a una
 * cuenta no se toca: su venta ya es de socio y la ajusta su lote (dolarones.ts, devoluciones.ts). */
export async function retirarVale(env: Env, ventaId:string, autor:string, ahora:string, pagadoRestante = 0): Promise<D1PreparedStatement[]> {
  const vale = await env.DB.prepare(`select k.id, k.importe,
    coalesce((select -sum(importe) from vales_movimientos where vale_id = k.id and tipo = 'retiro'), 0) as retirado
    from vales_dolarones k where k.venta_id = ? and k.reclamado_por is null`).bind(ventaId)
    .first<{ id:string; importe:number; retirado:number }>();
  if (!vale) return [];
  const retira = Math.max(0, vale.importe - vale.retirado - dolaronesGanados(pagadoRestante, 5));
  if (retira === 0) return [];
  return [
    // También se comprueba dentro del batch: un canje en otra caja aborta todo.
    env.DB.prepare(`update vales_dolarones set restante = case
      when restante = importe + coalesce((select sum(importe) from vales_movimientos
        where vale_id = vales_dolarones.id and tipo = 'retiro'), 0)
      then restante - ? else -1 end where id = ?`).bind(retira, vale.id),
    env.DB.prepare(`insert into vales_movimientos (vale_id, venta_id, tipo, importe, autor, creado_en)
      values (?, ?, 'retiro', ?, ?, ?)
      on conflict (vale_id, venta_id, tipo) do update set importe = importe + excluded.importe,
        autor = excluded.autor, creado_en = excluded.creado_en`).bind(vale.id, ventaId, -retira, autor, ahora),
  ];
}

export async function cancelarVales(env: Env, ventaId:string, autor:string, ahora:string): Promise<D1PreparedStatement[]> {
  const { results:canjes } = await env.DB.prepare(`select vale_id, -importe as importe from vales_movimientos
    where venta_id = ? and tipo = 'canje'`).bind(ventaId).all<{ vale_id:string; importe:number }>();
  return [
    // Una compra emisora con crédito aún gastado requiere resolución, no crear
    // dinero al cancelar ni retirar silenciosamente una deuda del cliente.
    ...(await retirarVale(env, ventaId, autor, ahora)),
    ...canjes.flatMap((c) => [
      env.DB.prepare('update vales_dolarones set restante = restante + ? where id = ?').bind(c.importe, c.vale_id),
      env.DB.prepare(`insert into vales_movimientos (vale_id, venta_id, tipo, importe, autor, creado_en)
        values (?, ?, 'reverso_canje', ?, ?, ?)`).bind(c.vale_id, ventaId, c.importe, autor, ahora),
    ]),
  ];
}

// Pasar el vale a la cuenta (Issue #258). Isaac: solo vales completos y vigentes,
// lo abonado sigue las reglas de cuenta y hay un tope por semana.
// ponytail: tope fijo; volverlo variable si Isaac lo cambia seguido.
export const RECLAMOS_POR_SEMANA = 2;
const SEMANA = 7 * 86_400_000;

export async function reclamarVale(env: Env, clienteId: string, codigo: string): Promise<Response> {
  if (!CODIGO.test(codigo)) return json({ error:'Código de vale inválido.' }, 400);
  const ahora = new Date();
  const iso = ahora.toISOString();
  const haceUnaSemana = new Date(ahora.getTime() - SEMANA).toISOString();
  const k = await env.DB.prepare(`select k.id, k.venta_id, k.importe, k.restante, k.vence_en, k.creado_en, k.reclamado_por, k.origen,
      v.total, v.dolarones, v.devuelto, v.cancelada, v.cliente_id
    from vales_dolarones k left join ventas v on v.id = k.venta_id where k.codigo = ?`).bind(codigo).first<{
      id:string; venta_id:string; importe:number; restante:number; vence_en:string; creado_en:string; reclamado_por:string | null;
      origen:string; total:number; dolarones:number; devuelto:number; cancelada:number; cliente_id:string | null }>();
  if (!k) return json({ error:'No encontramos ese vale.' }, 404);
  if (k.origen !== 'compra') return json({ error:'Este es un cupón: se usa directo en la caja, no se pasa a una cuenta.' }, 409);
  if (k.reclamado_por === clienteId) {
    const lote = await env.DB.prepare('select importe, disponible_desde, vence_en from dolarones_lotes where venta_id = ?')
      .bind(k.venta_id).first();
    return json({ ya_estaba:true, ...lote });
  }
  if (k.reclamado_por) return json({ error:'Este vale ya se pasó a otra cuenta.' }, 409);
  if (k.cancelada) return json({ error:'La compra de este vale se canceló.' }, 409);
  if (k.vence_en <= iso) return json({ error:'Este vale ya venció.' }, 409);
  if (k.restante !== k.importe || k.dolarones > 0 || k.cliente_id)
    return json({ error:'Solo se puede pasar un vale completo y sin usar, de una compra pagada en dinero.' }, 409);
  const usados = await env.DB.prepare('select count(*) as n from vales_dolarones where reclamado_por = ? and reclamado_en > ?')
    .bind(clienteId, haceUnaSemana).first<{ n:number }>();
  if ((usados?.n ?? 0) >= RECLAMOS_POR_SEMANA)
    return json({ error:`Puedes pasar hasta ${RECLAMOS_POR_SEMANA} vales por semana. Intenta en unos días.` }, 429);

  // Tarifa de socio sobre lo cobrado en dinero; disponible y vencimiento como cuenta, desde la compra.
  const compra = new Date(k.creado_en);
  const importe = dolaronesGanados(k.total - k.dolarones - k.devuelto);
  const lote = { id:crypto.randomUUID(), disponible_desde:disponibleDesde(compra), vence_en:sumarMeses(compra, 12) };
  try {
    await env.DB.batch([
      // Todo se vuelve a comprobar aquí (otro teléfono, la caja, el tope): -1 dispara
      // vale_saldo_valido y deshace el batch completo.
      env.DB.prepare(`update vales_dolarones set restante = case
          when restante = importe and reclamado_por is null and vence_en > ?
            and (select cancelada = 0 and cliente_id is null from ventas where id = venta_id)
            and (select count(*) from vales_dolarones where reclamado_por = ? and reclamado_en > ?) < ?
          then 0 else -1 end,
        reclamado_por = ?, reclamado_en = ? where id = ?`)
        .bind(iso, clienteId, haceUnaSemana, RECLAMOS_POR_SEMANA, clienteId, iso, k.id),
      // La venta pasa a ser del socio: recibos, cancelación y devoluciones siguen las reglas de cuenta.
      env.DB.prepare('update ventas set cliente_id = ? where id = ? and cliente_id is null').bind(clienteId, k.venta_id),
      env.DB.prepare(`insert into dolarones_lotes (id, cliente_id, origen, venta_id, importe, restante, disponible_desde, vence_en, creado_en)
        values (?, ?, 'compra', ?, ?, ?, ?, ?, ?)`)
        .bind(lote.id, clienteId, k.venta_id, importe, importe, lote.disponible_desde, lote.vence_en, iso),
      env.DB.prepare(`insert into dolarones_movimientos (cliente_id, lote_id, venta_id, tipo, importe, autor, creado_en)
        values (?, ?, ?, 'compra', ?, 'portal-vale', ?)`).bind(clienteId, lote.id, k.venta_id, importe, iso),
    ]);
  } catch (error) {
    if (String(error).includes('saldo de vale invalido') || String(error).includes('UNIQUE'))
      return json({ error:'El vale cambió mientras lo pasábamos. Vuelve a escanearlo.' }, 409);
    throw error;
  }
  return json({ importe, disponible_desde:lote.disponible_desde, vence_en:lote.vence_en }, 201);
}

/* ---------- cupones (Issue #330) ---------- */

export const VIGENCIA_CUPON = 30 * 86_400_000;
/** Lo que se regresa en cupón por cada peso devuelto; lo elige el dueño en /reportes (config `cupon_porcentaje`). */
export async function porcentajeCupon(env: Env): Promise<number> {
  const fila = await env.DB.prepare(`select valor from config where clave = 'cupon_porcentaje'`).first<{ valor:string }>();
  const n = Number(fila?.valor);
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 100;
}

export type Cupon = Vale & { origen:'devolucion' | 'manual' };

/** Un cupón nuevo: un vale sin compra, disponible ya y por 30 días. Su `id` lo pone quien lo pide (reenviar no duplica). */
export function nuevoCupon(env: Env, p: {
  id:string; origen:'devolucion' | 'manual'; importe:number; ahora:Date; ventaOrigen?:string; motivo:string; autor:string; aprobadoPor?:string;
}): { cupon:Cupon; sentencia:D1PreparedStatement } {
  const creado = p.ahora.toISOString();
  const cupon:Cupon = { id:p.id, codigo:codigoAleatorio('DP'), importe:p.importe, restante:p.importe, disponible_desde:creado,
    vence_en:new Date(p.ahora.getTime() + VIGENCIA_CUPON).toISOString(), creado_en:creado, origen:p.origen };
  return { cupon, sentencia:env.DB.prepare(`insert into vales_dolarones (id, venta_id, codigo, importe, restante, disponible_desde,
      vence_en, creado_en, origen, venta_origen, motivo, autor, aprobado_por) values (?, null, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(cupon.id, cupon.codigo, cupon.importe, cupon.importe, creado, cupon.vence_en, creado, p.origen,
      p.ventaOrigen ?? null, p.motivo, p.autor, p.aprobadoPor ?? null) };
}

export const leerCupon = (env: Env, id: string) => env.DB.prepare(`select id, codigo, importe, restante, disponible_desde,
  vence_en, creado_en, origen from vales_dolarones where id = ? and origen != 'compra'`).bind(id).first<Cupon>();

const MAXIMO_CUPON = 1_000_000;   // ponytail: $10,000 por cupón manual; subirlo si Isaac lo pide

/**
 * Cupón de monto libre (cortesía, aclaración): lo emite la caja con el PIN de un dueño,
 * o sin PIN si quien cobra es dueño. `id` de la caja: un reenvío no emite dos.
 */
export async function emitirCuponManual(request: Request, env: Env, correo: string): Promise<Response> {
  const cuerpo = await request.json().then((c) => c ?? {}, () => ({})) as Record<string, unknown>;
  const id = String(cuerpo.id ?? '');
  if (!UUID.test(id)) return json({ error:'Identificador inválido.' }, 400);
  const importe = Number(cuerpo.importe);
  if (!Number.isInteger(importe) || importe < 100 || importe > MAXIMO_CUPON)
    return json({ error:'El cupón va de 1 a 10,000 Dolarones.' }, 400);
  const motivo = String(cuerpo.motivo ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!motivo) return json({ error:'Escribe el motivo del cupón.' }, 400);
  const previo = await leerCupon(env, id);
  if (previo) return json({ cupon:previo, duplicada:true });

  let aprobo = correo;
  if (!(await leerUsuario(env, correo))?.roles.includes('dueno')) {
    aprobo = String(cuerpo.aprobador ?? '').trim().toLowerCase();
    const verificado = await verificarPin(env, aprobo, String(cuerpo.pin ?? ''), (roles) => roles.includes('dueno'));
    if ('error' in verificado) return json({ error:verificado.error }, verificado.status);
  }
  const { cupon, sentencia } = nuevoCupon(env, { id, origen:'manual', importe, ahora:new Date(), motivo, autor:correo, aprobadoPor:aprobo });
  try { await sentencia.run(); }
  catch (error) {
    const ya = await leerCupon(env, id);
    if (ya) return json({ cupon:ya, duplicada:true });
    throw error;
  }
  return json({ cupon }, 201);
}
