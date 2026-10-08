import { dolaronesGanados } from '../public/venta.js';
import { basesListas, codigoAleatorio, promocionIniciada } from './dolarones.ts';

const CODIGO = /^DP-[A-Za-z0-9_-]{16}$/;
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

export async function valeUsadoEnVenta(env: Env, id: string): Promise<Vale | null> {
  return env.DB.prepare(`select k.id, k.codigo, k.importe, k.restante, k.disponible_desde, k.vence_en, k.creado_en
    from vales_dolarones k join vales_movimientos m on m.vale_id = k.id
    join ventas v on v.id = m.venta_id where m.venta_id = ? and m.tipo = 'canje' and v.cancelada = 0`)
    .bind(id).first<Vale>();
}

export async function buscarVale(request: Request, env: Env): Promise<Response> {
  const body = await request.json().then((c) => c ?? {}, () => ({})) as { codigo?: unknown };
  const codigo = String(body.codigo ?? '');
  if (!CODIGO.test(codigo)) return json({ error:'Código de vale inválido.' }, 400);
  const ahora = new Date().toISOString();
  const vale = await env.DB.prepare(`select k.restante, k.vence_en from vales_dolarones k
    join ventas v on v.id = k.venta_id where k.codigo = ? and v.cancelada = 0
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
  ventaId:string; clienteId:string | null; codigo:string; dolarones:number; total:number; autor:string; ahora:Date;
}): Promise<Resultado> {
  if (!Number.isSafeInteger(p.total) || p.total < 0 || !Number.isSafeInteger(p.dolarones) || p.dolarones < 0 || p.dolarones > p.total)
    return { ok:false, status:400, error:'Importe de Dolarones inválido.' };
  // ponytail: un vale por ticket; combinar varios sólo cuando se solicite.
  if (p.codigo && (!CODIGO.test(p.codigo) || p.clienteId))
    return { ok:false, status:400, error:'Usa un vale o una membresía, no ambos en el mismo ticket.' };
  const ahora = p.ahora.toISOString();
  const sentencias:D1PreparedStatement[] = [];
  if (p.codigo && p.dolarones > 0) {
    const vale = await env.DB.prepare(`select k.id from vales_dolarones k join ventas v on v.id = k.venta_id
      where k.codigo = ? and v.cancelada = 0 and k.restante >= ?
      and k.disponible_desde <= ? and k.vence_en > ?`)
      .bind(p.codigo, p.dolarones, ahora, ahora).first<{ id:string }>();
    if (!vale) return { ok:false, status:409, error:'Vale no disponible o saldo insuficiente. Vuelve a escanearlo.' };
    sentencias.push(
      env.DB.prepare(`update vales_dolarones set restante = case
        when disponible_desde <= ? and vence_en > ? and vence_en > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        and (select cancelada from ventas where id = venta_id) = 0
        then restante - ? else -1 end where id = ?`).bind(ahora, ahora, p.dolarones, vale.id),
      env.DB.prepare(`insert into vales_movimientos (vale_id, venta_id, tipo, importe, autor, creado_en)
        values (?, ?, 'canje', ?, ?, ?)`).bind(vale.id, p.ventaId, -p.dolarones, p.autor, ahora),
    );
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

/** Retira lo ganado de más; importe original y vencimiento quedan intactos. */
export async function retirarVale(env: Env, ventaId:string, autor:string, ahora:string, pagadoRestante = 0): Promise<D1PreparedStatement[]> {
  const vale = await env.DB.prepare(`select k.id, k.importe,
    coalesce((select -sum(importe) from vales_movimientos where vale_id = k.id and tipo = 'retiro'), 0) as retirado
    from vales_dolarones k where k.venta_id = ?`).bind(ventaId)
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
