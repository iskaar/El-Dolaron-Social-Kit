/**
 * Aviso por correo al dueno cuando llega una solicitud (Issue #75, fase 3). Los
 * destinatarios son los duenos activos de D1: el correo no va en el repositorio.
 * Sin el binding CORREO (pruebas, `wrangler dev`) no hace nada. Un correo que
 * falla no tumba la solicitud: queda en el log y la solicitud sigue en /cuentas.
 * Un envio por dueno: sin el plan Workers Paid solo se puede mandar a direcciones
 * verificadas en Email Routing, y un destinatario sin verificar tumbaria el de todos.
 * El push del navegador (VAPID) vive en push.ts (Issue #600).
 */
import { leerRoles } from './cuentas.ts';

export const REMITENTE = 'avisos@eldolaron.com';

export async function enviarAviso(env: Env, request: Request, asunto: string, texto: string): Promise<void> {
  await correoADuenos(env, asunto, `${texto}\n\nApruébala o recházala en ${new URL(request.url).origin}/cuentas`);
}

/** Un correo a cada dueño activo, tal cual. Lo usa también la venta en Mercado Libre (Issue #427). */
export async function correoADuenos(env: Env, asunto: string, texto: string): Promise<void> {
  const correo = env.CORREO;
  if (!correo) return;
  const { results } = await env.DB.prepare('select correo, roles from usuarios where activo = 1')
    .all<{ correo: string; roles: string }>();
  const prueba = env.AMBIENTE === 'sandbox' ? '[Sandbox] ' : '';
  await Promise.all(results.filter((u) => leerRoles(u.roles).includes('dueno')).map((u) =>
    correo.send({
      from: { email: REMITENTE, name: 'El Dolarón' },
      to: u.correo,
      subject: `${prueba}${asunto}`,
      text: texto,
    }).catch((error) => console.error(JSON.stringify({
      mensaje: 'aviso por correo fallido', para: u.correo, asunto, codigo: error?.code ?? '', error: String(error),
    })))));
}

/** Sin ctx (pruebas que llaman al handler directo) el aviso no se manda. */
export function avisarDueno(env: Env, ctx: ExecutionContext | undefined, request: Request, asunto: string, texto: string) {
  ctx?.waitUntil(enviarAviso(env, request, asunto, texto));
}
