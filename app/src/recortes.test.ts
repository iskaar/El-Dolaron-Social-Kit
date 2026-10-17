import test from 'node:test';
import assert from 'node:assert/strict';
import { procesarRecortes, rutaRecortesAdmin, reiniciarRecorte } from './recortes.ts';
import { tienda } from './prueba-d1.ts';

function preparar(n = 1) {
  const t = tienda();
  t.db.prepare("insert into config (clave,valor) values ('recortes_activo','1')").run();
  for (let i = 0; i < n; i++) {
    const id = `id-${i}`;
    t.db.prepare(`insert into productos (id,codigo,nombre,marca,categoria,precio,estado_fisico,estado_analisis,destino,stock,foto_key,semana_ingreso,creado_en,actualizado_en,propietario)
      values (?,?,'Jeans','Levis','ropa',25000,'nuevo','listo','etiqueta',3,?,'S40',?,?, 'dolaron')`).run(id, `ED-${i + 1}`, `fotos/${id}.jpg`, `${i}`, '');
    (t.env.FOTOS as any).objetos.set(`fotos/${id}.jpg`, Uint8Array.from([1, 2, 3]).buffer);
  }
  return t;
}
const images = (fn: () => Promise<Response> = async () => new Response(new Uint8Array([9, 8]), { headers: { 'content-type': 'image/webp' } })) => ({
  input() { return { transform() { return { output() { return { response: fn }; } }; } }; },
});

test('recortes: interruptor apagado, lote limitado a 20 y guarda WebP', async () => {
  const t = preparar(23);
  try {
    t.db.prepare("update config set valor='0' where clave='recortes_activo'").run();
    await procesarRecortes(Object.assign(t.env, { IMAGES: images() }) as Env);
    assert.equal(t.db.prepare("select count(*) n from productos where recorte_estado='listo'").get()?.n, 0);
    t.db.prepare("update config set valor='1' where clave='recortes_activo'").run();
    await procesarRecortes(Object.assign(t.env, { IMAGES: images() }) as Env);
    assert.equal(t.db.prepare("select count(*) n from productos where recorte_estado='listo'").get()?.n, 20);
    assert.ok((t.env.FOTOS as any).objetos.has('recortes/id-0.webp'));
  } finally { t.db.close(); }
});

test('recortes: cuota 9422 no marca; otro error marca error', async () => {
  for (const [error, esperado] of [['9422 quota exceeded', null], ['R2 roto', 'error']] as const) {
    const t = preparar();
    try {
      await procesarRecortes(Object.assign(t.env, { IMAGES: images(async () => { throw Error(error); }) }) as Env);
      assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get('id-0')?.recorte_estado ?? null, esperado);
    } finally { t.db.close(); }
  }
});

test('recortes: admin limita al dueño, original borra R2 y reintentar devuelve a pendiente', async () => {
  const t = preparar();
  try {
    t.db.prepare("update productos set recorte_estado='listo',recorte_fecha='2026-10-16' where id='id-0'").run();
    (t.env.FOTOS as any).objetos.set('recortes/id-0.webp', new ArrayBuffer(1));
    const listado = await rutaRecortesAdmin(new Request('https://x/api/recortes'), t.env as Env, '/api/recortes');
    assert.equal((await listado!.json() as any[]).length, 1);
    await rutaRecortesAdmin(new Request('https://x', { method: 'POST' }), t.env as Env, '/api/recortes/id-0/original');
    assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get('id-0')?.recorte_estado, 'original');
    assert.ok(!(t.env.FOTOS as any).objetos.has('recortes/id-0.webp'));
    t.db.prepare("update productos set recorte_estado='error' where id='id-0'").run();
    await rutaRecortesAdmin(new Request('https://x', { method: 'POST' }), t.env as Env, '/api/recortes/id-0/reintentar');
    assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get('id-0')?.recorte_estado, null);
    await reiniciarRecorte(t.env as Env, 'id-0');
    assert.equal(t.db.prepare('select recorte_estado from productos where id=?').get('id-0')?.recorte_estado, null);
  } finally { t.db.close(); }
});
