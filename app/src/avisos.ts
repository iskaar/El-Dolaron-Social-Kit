/**
 * Aviso por correo al dueno cuando llega una solicitud (Issue #75, fase 3). Los
 * destinatarios son los duenos activos de D1: el correo no va en el repositorio.
 * Sin el binding CORREO (pruebas, `wrangler dev`) no hace nada. Un correo que
 * falla no tumba la solicitud: queda en el log y la solicitud sigue en /cuentas.
 * ponytail: solo correo; el push del navegador (VAPID) si el correo llega tarde.
 */
import { leerRoles } from './cuentas.ts';

export const REMITENTE = 'avisos@eldolaron.com';

export async function enviarAviso(env: Env, request: Request, asunto: string, texto: string): Promise<void> {
  if (!env.CORREO) return;
  try {
    const { results } = await env.DB.prepare('select correo, roles from usuarios where activo = 1')
      .all<{ correo: string; roles: string }>();
    const duenos = results.filter((u) => leerRoles(u.roles).includes('dueno')).map((u) => u.correo);
    if (!duenos.length) return;
    const prueba = env.AMBIENTE === 'sandbox' ? '[Sandbox] ' : '';
    const enlace = `${new URL(request.url).origin}/cuentas`;
    await env.CORREO.send({
      from: { email: REMITENTE, name: 'El Dolarón' },
      to: duenos,
      subject: `${prueba}${asunto}`,
      text: `${texto}\n\nApruébala o recházala en ${enlace}`,
    });
  } catch (error) {
    console.error(JSON.stringify({ mensaje: 'aviso por correo fallido', asunto, error: String(error) }));
  }
}

/** Sin ctx (pruebas que llaman al handler directo) el aviso no se manda. */
export function avisarDueno(env: Env, ctx: ExecutionContext | undefined, request: Request, asunto: string, texto: string) {
  ctx?.waitUntil(enviarAviso(env, request, asunto, texto));
}
