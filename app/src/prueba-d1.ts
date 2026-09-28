// Tienda de prueba para node --test: SQLite real (node:sqlite) con schema.sql
// y TODAS las migraciones, detras del fetch del Worker. El shim de D1 es lo
// minimo que usa la app: prepare/bind/first/all/run y batch transaccional.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.ts';

export const DUENO = 'dueno@prueba.mx';
export const PRODUCTO = 'a1111111-1111-4111-8111-111111111111';

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
  } as unknown as Env;
  const pedir = async (ruta: string, cuerpo?: unknown, metodo = 'POST') => {
    const r = await worker.fetch!(
      new Request(`https://caja.prueba${ruta}`, cuerpo === undefined ? {} : {
        method: metodo, headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo),
      }) as never,
      env,
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    return { status: r.status, cuerpo: (await r.json()) as Record<string, any> };
  };
  return { db, env, pedir };
}
