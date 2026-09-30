// Tienda de prueba para node --test: SQLite real (node:sqlite) con schema.sql
// y TODAS las migraciones, detras del fetch del Worker. El shim de D1 es lo
// minimo que usa la app: prepare/bind/first/all/run y batch transaccional.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.ts';

export const DUENO = 'dueno@prueba.mx';
export const PRODUCTO = 'a1111111-1111-4111-8111-111111111111';

/** Autorización sintética; las pruebas de portal ejercitan la emisión real. */
export async function codigoPrueba(db: DatabaseSync, clienteId: string, maximo = 1_000_000): Promise<string> {
  const codigo = 'DC-' + Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codigo))).toString('hex');
  db.prepare('update clientes set auth_uid = coalesce(auth_uid, ?) where id = ?').run('prueba-' + clienteId, clienteId);
  const uid = db.prepare('select auth_uid from clientes where id = ?').get(clienteId)!.auth_uid;
  db.prepare(`insert into codigos_cliente (cliente_id, token_hash, auth_uid, maximo, creado_en, expira_en, venta_id)
    values (?, ?, ?, ?, ?, ?, '') on conflict(cliente_id) do update set token_hash=excluded.token_hash,
    maximo=excluded.maximo, creado_en=excluded.creado_en, expira_en=excluded.expira_en, venta_id=''`)
    .run(clienteId, hash, uid, maximo, new Date().toISOString(), new Date(Date.now() + 300_000).toISOString());
  return codigo;
}

function d1(db: DatabaseSync) {
  const preparar = (sql: string) => {
    let args: unknown[] = [];
    const s = {
      bind(...a: unknown[]) { args = a.map((x) => (x === undefined ? null : x)); return s; },
      async first() { return db.prepare(sql).get(...(args as never[])) ?? null; },
      async all() { return { results: db.prepare(sql).all(...(args as never[])) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }; },
      ejecutar() { return db.prepare(sql).run(...(args as never[])); },
    };
    return s;
  };
  return {
    prepare: preparar,
    // D1: el batch entero se confirma o se deshace.
    async batch(sentencias: ReturnType<typeof preparar>[]) {
      db.exec('begin');
      try {
        const salida = sentencias.map((s) => s.ejecutar());
        db.exec('commit');
        return salida;
      } catch (error) {
        db.exec('rollback');
        throw error;
      }
    },
  };
}

export function tienda() {
  const db = new DatabaseSync(':memory:');
  const archivos = ['schema.sql', ...readdirSync('.').filter((f) => /^migracion-\d+/.test(f)).sort()];
  for (const f of archivos) db.exec(readFileSync(f, 'utf8'));
  db.prepare(`insert into usuarios (correo, nombre, roles, activo, creado_en, actualizado_en) values (?, 'Isaac', 'dueno', 1, '', '')`).run(DUENO);
  db.prepare(`insert into productos (id, codigo, nombre, precio, stock, semana_ingreso, creado_en, actualizado_en)
              values (?, 'ED-000001', 'Ventilador', 25000, 50, 'S40', '', '')`).run(PRODUCTO);
  const env = { DB: d1(db), ACCESS_EQUIPO: 'local', DEV_USUARIO: DUENO,
    BASES_APROBADAS_VERSION: 'prueba-1', PORTAL_REGISTRO_ABIERTO: 'si', PROMOCION_INICIO: '2020-01-01T00:00:00Z',
    PORTAL_BASES_TEXTO: 'Bases sintéticas de prueba.', PORTAL_AVISO_TEXTO: 'Aviso sintético de prueba.',
  } as unknown as Env;
  const pedir = async (ruta: string, cuerpo?: unknown, metodo = 'POST', encabezados: Record<string, string> = {}) => {
    const r = await worker.fetch!(
      new Request(`https://caja.prueba${ruta}`, cuerpo === undefined ? { headers: encabezados } : {
        method: metodo, headers: { 'content-type': 'application/json', ...encabezados }, body: JSON.stringify(cuerpo),
      }) as never,
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    return { status: r.status, cuerpo: (await r.json()) as Record<string, any> };
  };
  return { db, env, pedir };
}
