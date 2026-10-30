/**
 * Verificacion de las transferencias contra el CEP de Banxico (#603, fase 2 de #593).
 * Banxico exige captcha desde Cloudflare, asi que la consulta la hace tools/cep_verificar.py en la PC de la caja
 * y solo reporta aqui. Este modulo: lo que ve ese script (/api/cep/*, solo con el service token de Access),
 * el aviso al dueno cuando algo no cuadra y el «validada a mano» del dueno. Nada de esto frena un cobro:
 * la transferencia ya esta registrada «por cajero» (migracion 060) y esto solo la confirma o la marca.
 */
import { quienEsServicio } from './cuentas.ts';
import { pushADuenos } from './push.ts';
import { correoADuenos } from './avisos.ts';

const json = (cuerpo: unknown, status = 200) =>
  new Response(JSON.stringify(cuerpo), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** El dia del registro y el anterior: nunca mas consultas a Banxico por transferencia. */
const MAX_INTENTOS = 2;
/** Minutos que debe tener una transferencia, y minutos entre dos consultas de la misma: el CEP tarda en salir y nunca va en rafaga. */
const ESPERA_MIN = 10;
const POR_VALIDAR = ['no_encontrada', 'no_coincide'];

const pesos = (centavos: number) => `$${(centavos / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** /api/cep/*: solo el service token de la PC de la caja (CEP_CLIENT_ID). Cerrado por omision; una persona, ni el dueno, entra aqui. */
export async function rutaCep(request: Request, env: Env, url: URL): Promise<Response> {
  const servicio = await quienEsServicio(request, env, url.hostname);
  if (!servicio || !env.CEP_CLIENT_ID || servicio !== env.CEP_CLIENT_ID) return json({ error: 'Sin sesion.' }, 401);
  if (url.pathname === '/api/cep/pendientes' && request.method === 'GET') return pendientes(env);
  if (url.pathname === '/api/cep/resultado' && request.method === 'POST') return resultado(request, env, url.origin);
  return json({ error: 'Ruta no encontrada.' }, 404);
}

/**
 * Lo que la PC debe consultar ahora. `fecha` es la fecha de ABONO (dia de tienda, UTC-6, del registro; en la segunda
 * consulta, el dia anterior): la que pide Banxico, no la «fecha de operacion SPEI». Sin banco emisor no se puede consultar.
 * La CLABE y el banco que reciben no se guardan aqui: viven en la configuracion local de la PC.
 */
async function pendientes(env: Env): Promise<Response> {
  const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const { results } = await env.DB.prepare(
    `select id, clave_rastreo, monto, banco_emisor, cep_intentos,
       substr(datetime(registrado_en, '-6 hours', '-' || cep_intentos || ' days'), 1, 10) as fecha
     from transferencias_spei
     where cep_estado = 'pendiente' and banco_emisor is not null and cep_intentos < ?
       and registrado_en <= ? and (cep_ultimo_intento is null or cep_ultimo_intento <= ?)
     order by registrado_en limit 10`,
  ).bind(MAX_INTENTOS, hace(ESPERA_MIN), hace(ESPERA_MIN)).all<{ id: number; clave_rastreo: string; monto: number; banco_emisor: string; cep_intentos: number; fecha: string }>();
  return json({ transferencias: results.map((f) => ({
    id: f.id, clave: f.clave_rastreo, monto: f.monto, banco_emisor: f.banco_emisor, fecha: f.fecha, intento: f.cep_intentos + 1,
  })) });
}

/**
 * La PC reporta una consulta: `encontrada` (con el monto del CEP en centavos y si la cuenta beneficiaria es la de la tienda)
 * o `no_existe`. El Worker decide el estado: monto y cuenta se comparan aqui, con lo guardado. Repetir el mismo reporte
 * (o reportar uno viejo) no cambia nada y devuelve el estado actual: gana el primero.
 */
async function resultado(request: Request, env: Env, origen: string): Promise<Response> {
  const c = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const { id, intento } = c;
  if (!Number.isInteger(id) || !Number.isInteger(intento) || !['encontrada', 'no_existe'].includes(String(c.estado)))
    return json({ error: 'Reporte inválido.' }, 400);
  if (c.estado === 'encontrada' && (!Number.isSafeInteger(c.monto_cep) || typeof c.cuenta_ok !== 'boolean'))
    return json({ error: 'Falta el monto del CEP o si la cuenta coincide.' }, 400);
  const f = await env.DB.prepare('select monto, cep_estado, cep_intentos from transferencias_spei where id = ?')
    .bind(id).first<{ monto: number; cep_estado: string; cep_intentos: number }>();
  if (!f) return json({ error: 'La transferencia no existe.' }, 404);
  if (f.cep_estado !== 'pendiente' || intento !== f.cep_intentos + 1) return json({ ok: true, estado: f.cep_estado, repetido: true });

  const estado = c.estado === 'encontrada'
    ? (c.monto_cep === f.monto && c.cuenta_ok ? 'banxico_ok' : 'no_coincide')
    : (f.cep_intentos + 1 >= MAX_INTENTOS ? 'no_encontrada' : 'pendiente');
  const r = await env.DB.prepare(
    `update transferencias_spei set cep_estado = ?, cep_intentos = cep_intentos + 1, cep_ultimo_intento = ?,
       verificacion = case when ? = 'banxico_ok' then 'banxico' else verificacion end
     where id = ? and cep_estado = 'pendiente' and cep_intentos = ?`,
  ).bind(estado, new Date().toISOString(), estado, id, f.cep_intentos).run();
  if (!r.meta.changes) return json({ ok: true, estado: f.cep_estado, repetido: true });
  if (POR_VALIDAR.includes(estado)) await avisarDueno(env, origen, f.monto, estado);
  return json({ ok: true, estado });
}

/** Push al dueno (como el boton «Ayuda»); sin dispositivo que lo reciba, correo. Sin clave ni datos del cliente. Un fallo se registra y no tumba el reporte: la lista de Avisos ya la trae. */
async function avisarDueno(env: Env, origen: string, monto: number, estado: string) {
  const titulo = 'Transferencia por validar';
  const cuerpo = `${pesos(monto)}: ${estado === 'no_coincide' ? 'el CEP de Banxico no coincide con lo capturado' : 'Banxico no la encontró'}. Valídala a mano en Avisos.`;
  try {
    if (!await pushADuenos(env, titulo, cuerpo)) await correoADuenos(env, titulo, `${cuerpo}\n\n${origen}/avisos`);
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'aviso de transferencia fallido', error: String(error) }));
  }
}

/** Las que Banxico no confirmo y nadie ha validado: /api/avisos (la caja las ve como aviso; el dueno las valida). Sin quien las capturo. */
export async function transferenciasPorValidar(env: Env) {
  const { results } = await env.DB.prepare(
    `select t.id, t.clave_rastreo, t.monto, t.cep_estado, t.registrado_en, t.venta_id,
       (select folio from pedidos where id = t.pedido_id) as folio
     from transferencias_spei t where t.cep_estado in ('no_encontrada', 'no_coincide') order by t.registrado_en`,
  ).all<{ id: number; clave_rastreo: string; monto: number; cep_estado: string; registrado_en: string; venta_id: string | null; folio: number | null }>();
  return results.map((f) => ({
    id: f.id, clave: f.clave_rastreo, monto: f.monto, estado: f.cep_estado, registrado_en: f.registrado_en,
    donde: f.folio != null ? `Pedido P-${f.folio}` : `Ticket ${String(f.venta_id).slice(0, 8).toUpperCase()}`,
  }));
}

/** El dueno da por buena una transferencia marcada (la ruta es solo suya, en cuentas.ts). Dos veces seguidas = lo mismo. */
export async function validarTransferencia(env: Env, id: number, dueno: string): Promise<Response> {
  const r = await env.DB.prepare(
    `update transferencias_spei set cep_estado = 'validada_manual', validada_por = ?, validada_en = ?
     where id = ? and cep_estado in ('no_encontrada', 'no_coincide')`,
  ).bind(dueno, new Date().toISOString(), id).run();
  if (r.meta.changes) return json({ ok: true });
  const f = await env.DB.prepare('select cep_estado from transferencias_spei where id = ?').bind(id).first<{ cep_estado: string }>();
  if (!f) return json({ error: 'La transferencia no existe.' }, 404);
  return f.cep_estado === 'validada_manual' ? json({ ok: true, repetido: true })
    : json({ error: 'Esta transferencia no está marcada para validar a mano.' }, 409);
}
