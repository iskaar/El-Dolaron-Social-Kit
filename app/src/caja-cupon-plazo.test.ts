// node --test src/caja-cupon-plazo.test.ts
// #948: cuando el servidor pide aprobación para dar un cupón de una compra de más de 7 días, la caja ofrece el PIN del supervisor o de gerencia en el mismo
// formulario de la pieza y reenvía el mismo pedido con el PIN. Trozos reales de public/caja.html en un contexto simulado.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const fuente = readFileSync('public/caja.html', 'utf8').replace(/\r\n/g, '\n');
const entre = (desde: string, hasta: string) => {
  const i = fuente.indexOf(desde);
  assert.ok(i >= 0, `no está: ${desde}`);
  const j = fuente.indexOf(hasta, i + desde.length);
  assert.ok(j > i, `no está: ${hasta}`);
  return fuente.slice(i, j);
};
const manejador = entre('  // Devolver en cupón (Issue #330)', '  if (d.confirmarLinea || d.confirmarTodo !== undefined) {');

/** Un formulario de pieza mínimo: lo que busca el código de la caja son clases, así que basta con encontrarlas en el HTML puesto. */
function formulario() {
  const hijos: any[] = [];
  const nodo = (clase: string, extra: Record<string, unknown> = {}) => ({ clase, value: '', enfocado: 0, focus() { this.enfocado++; }, ...extra });
  const botonCupon = { before(b: any) { hijos.push(b); } };
  const form: any = {
    hijos,
    querySelector(sel: string): any {
      if (sel === '.cupon') return botonCupon;
      for (const b of hijos) { const e = b.querySelector(sel); if (e) return e; }
      return null;
    },
  };
  const documento = {
    createElement() {
      const b: any = {
        className: '', innerHTML: '', pedazos: new Map<string, any>(),
        remove() { const i = hijos.indexOf(b); if (i >= 0) hijos.splice(i, 1); },
        querySelector(sel: string) {
          const clase = sel.slice(1);
          if (clase === b.className) return b;
          if (!b.innerHTML.includes(`class="${clase}"`)) return null;
          if (!b.pedazos.has(clase)) b.pedazos.set(clase, nodo(clase));
          return b.pedazos.get(clase);
        },
      };
      return b;
    },
  };
  return { form, documento };
}

const contexto = (documento: unknown) => runInNewContext(
  `${entre('function pedirAprobacionCupon(', '/** Pregunta cada 5 s')}
   ({ pedirAprobacionCupon, aprobacionCupon })`,
  { document: documento, escapar: (t: string) => String(t).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`) },
) as { pedirAprobacionCupon: (f: any, c: any) => void; aprobacionCupon: (f: any) => Record<string, string> };

test('sin aprobación pedida el cupón se manda exactamente como antes: sin aprobador ni PIN', () => {
  const { form, documento } = formulario();
  assert.deepEqual({ ...contexto(documento).aprobacionCupon(form) }, {});
});

test('el servidor pide aprobación: salen quién aprueba y el PIN con el aviso, el PIN toma el foco y el reenvío los lleva', () => {
  const { form, documento } = formulario();
  const { pedirAprobacionCupon, aprobacionCupon } = contexto(documento);
  pedirAprobacionCupon(form, {
    error: 'Esta compra tiene más de 7 días: devolverla en cupón necesita la aprobación del supervisor o de gerencia.',
    duenos: [{ correo: 'sup@prueba.mx', nombre: 'Sara' }, { correo: 'otro@prueba.mx', nombre: '' }],
  });
  assert.equal(form.hijos.length, 1);
  const html = form.hijos[0].innerHTML;
  assert.match(html, /más de 7 días/);
  assert.match(html, /<option value="sup@prueba.mx">Sara<\/option>/);
  assert.match(html, /<option value="otro@prueba.mx">otro@prueba.mx<\/option>/);
  assert.match(html, /type="password"[^>]*maxlength="6"|maxlength="6"[^>]*type="password"/);
  assert.match(html, /toca «Devolver en cupón» otra vez/);
  assert.equal(form.querySelector('.pin-cupon').enfocado, 1);
  form.querySelector('.pin-cupon').value = '735190';
  form.querySelector('.aprobador-cupon').value = 'sup@prueba.mx';
  assert.deepEqual({ ...aprobacionCupon(form) }, { aprobador: 'sup@prueba.mx', pin: '735190' });
  // Un segundo rechazo reemplaza el bloque, no lo duplica.
  pedirAprobacionCupon(form, { error: 'x', duenos: [{ correo: 'sup@prueba.mx', nombre: 'Sara' }] });
  assert.equal(form.hijos.length, 1);
});

test('sin nadie con PIN lo dice y no ofrece campos que no sirven; el error del servidor sale escapado', () => {
  const { form, documento } = formulario();
  const { pedirAprobacionCupon, aprobacionCupon } = contexto(documento);
  pedirAprobacionCupon(form, { error: '<b>x</b>', duenos: [] });
  const html = form.hijos[0].innerHTML;
  assert.match(html, /Nadie con permiso tiene PIN/);
  assert.doesNotMatch(html, /<b>x/);
  assert.equal(form.querySelector('.pin-cupon'), null);
  assert.deepEqual({ ...aprobacionCupon(form) }, {});
});

test('el manejador del cupón: manda el aprobador y el PIN con el MISMO id, atiende el 403 sin cerrar el formulario y no toca el ticket', () => {
  assert.match(manejador, /\.\.\.aprobacionCupon\(form\) \}\),/);
  assert.match(manejador, /body: JSON\.stringify\(\{ id: idCancelacion,/);
  const desde = manejador.indexOf('r.status === 403 && cuerpo.requiere_aprobacion');
  assert.ok(desde > 0, 'falta el caso 403 en el manejador del cupón');
  const caso403 = manejador.slice(desde, manejador.indexOf('    if (!r.ok) {', desde));
  assert.match(caso403, /pedirAprobacionCupon\(form, cuerpo\);\s+return;/);
  assert.match(caso403, /b\.disabled = false/);                                   // los botones se liberan para tocar «Devolver en cupón» otra vez
  assert.doesNotMatch(caso403, /idCancelacion = null|abrirTicket|cambiarTicket/);   // el id sigue vivo: el reintento es el mismo cupón
  // El PIN equivocado se borra y el campo vuelve a tener el foco.
  const fallo = manejador.slice(manejador.indexOf('    if (!r.ok) {', desde));
  assert.match(fallo.slice(0, fallo.indexOf('return;')), /pin-cupon'\)\.value = ''/);
  // Ningún botón nuevo: el Enter del lector no puede disparar nada.
  assert.doesNotMatch(entre('function pedirAprobacionCupon(', '/** Pregunta cada 5 s'), /<button/);
});
