/**
 * Plano del local (Issue #756): muebles, letreros 1-36 y el dibujo con pan/zoom.
 * Sale del plano del 6/11 (#737). Los numeros de NUM son los de public/letreros.js, que sigue siendo el UNICO
 * que decide a que letrero va cada pieza; aqui solo se dibujan. Si el plano cambia, se editan NUM, FX y letreros.js.
 * Geometria en metros: origen en la esquina izquierda de la fachada, y crece hacia el fondo.
 */

export const FAM = {
  ropa: { n: 'Ropa y calzado', c: '#E35A94' },
  hogar: { n: 'Hogar y blancos', c: '#3F7FD1' },
  jug: { n: 'Juguetes y papelería', c: '#F28C28' },
  limp: { n: 'Limpieza · desechables · comida', c: '#2BA39A' },
  bell: { n: 'Belleza y salud', c: '#8E5BD1' },
  tec: { n: 'Electrónico · herramienta · autos', c: '#5F6B7A' },
  masc: { n: 'Mascotas y jardinería', c: '#4CAF50' },
  acc: { n: 'Vitrinas · joyería · accesorios', c: '#D19A00' },
  muebles: { n: 'Muebles y colchones', c: '#A0714F' },
  bot: { n: 'Botadero / varios', c: '#F0B400' },
  caja: { n: 'Caja y servicio', c: '#16366B' },
};
const cat = (t, f) => ({ t, f });

/** Letrero por mueble (góndola: [cara izquierda, cara derecha]); orden de recorrido: entrada, fila 1, 2, 3, fondo. */
export const NUM = { 'vit-izq': 1, bot1: 2, 'r-dama': 3, 'r-cab': 4, 'w-maq': 5, bot2: 6, 'w-joy': 7, w1: 8, '1I': 9, '1C': [10, 11], '1D': [12, 13], wr1: 14, w2: 15, '2I': [16, 17], '2C': [18, 19], '2D': [20, 21], wr2: 22, w3: 23, '3I': [24, 25], '3C': [26, 27], '3D': [28, 29], wr3: 30, mueb: 31, colch: 32, p3a: 33, p3b: 34, p3c: 35, p3d: 36 };
export const LETREROS = 36;

const SAL_Y0 = 3.88, SAL_Y1 = 16.98, SAL_W0 = 6.42, SAL_W1 = 6.83;
const rw = (y) => SAL_W0 + (SAL_W1 - SAL_W0) * (y - SAL_Y0) / (SAL_Y1 - SAL_Y0);   // pared derecha del salón
const F1 = [5.1, 7.96], F2 = [8.6, 11.46], F3 = [12.1, 14.96];

// Muebles: x, y, w, h en metros. `faces` = góndola de dos caras. `right` = pegado a la pared derecha.
export const FX = [
  { id: 'vit-izq', zone: 'Cuarto de entrada', name: 'Vitrina mural + panel ranurado (pared izq.)', x: 0, y: 0.3, w: 0.35, h: 1.9, fam: 'acc', label: 'VITRINA + PANEL', cats: [cat('Vitrina (artículos pequeños de valor)', 'acc'), cat('Panel ranurado con ganchos', 'acc')] },
  { id: 'caja', zone: 'Cuarto de entrada', name: 'CAJA', x: 0.5, y: 2.3, w: 0.5, h: 0.8, fam: 'caja', label: 'CAJA', cats: [cat('Cobro · registro de socios Dolarones', 'caja')] },
  { id: 'bot1', zone: 'Cuarto de entrada', name: 'Botadero 1', x: 1.1, y: 0.3, w: 0.69, h: 2.86, fam: 'bot', label: 'BOTADERO 1', cats: [cat('Botadero / hallazgos', 'bot')] },
  { id: 'r-dama', zone: 'Cuarto de entrada', name: 'Rack Ropa dama', x: 2.5, y: 0.4, w: 0.6, h: 2.6, fam: 'ropa', label: 'ROPA DAMA', cats: [cat('Ropa dama', 'ropa')] },
  { id: 'r-cab', zone: 'Cuarto de entrada', name: 'Rack Ropa caballero', x: 3.8, y: 0.4, w: 0.6, h: 2.6, fam: 'ropa', label: 'ROPA CABALLERO', cats: [cat('Ropa caballero', 'ropa')] },
  { id: 'vit-der', zone: 'Acceso', name: 'Vitrina (pared derecha · por definir)', x: 6.5, y: 0.3, w: 0.36, h: 2.0, fam: 'acc', ghost: true, cats: [cat('Vitrina', 'acc')] },

  { id: 'w-maq', zone: 'Salón · frente', name: 'Pared izq. · Vitrina maquillaje', x: 0, y: 3.95, w: 0.4, h: 1.05, fam: 'bell', label: 'Vit. maquillaje', cats: [cat('Caja/vitrina maquillaje', 'bell')] },
  { id: 'bot2', zone: 'Salón · frente', name: 'Botadero 2 · Varios', x: 2.3, y: 3.98, w: 2.86, h: 0.69, fam: 'bot', label: 'BOTADERO 2 · VARIOS', cats: [cat('Botadero', 'bot'), cat('Varios', 'bot')] },
  { id: 'w-joy', zone: 'Salón · frente', name: 'Pared der. · Juguetería y joyería', x: null, y: 3.95, w: 0.4, h: 1.05, fam: 'acc', right: true, cats: [cat('Juguetería · peluches', 'jug'), cat('Joyería', 'acc')] },

  { id: 'w1', zone: 'Fila 1', name: 'Pared izq. · fila 1', x: 0, y: F1[0], w: 0.4, h: 2.86, fam: 'ropa', label: 'Ropa interior · Vitrina uñas', cats: [cat('Ropa interior', 'ropa'), cat('Caja/vitrina uñas', 'bell')] },
  { id: '1I', zone: 'Fila 1', name: '1I · Botadero corto', x: 1.2, y: F1[0], w: 0.9, h: 1.43, fam: 'bot', label: '1I', cats: [cat('Botadero', 'bot')] },
  { id: '1C', zone: 'Fila 1', name: 'Góndola 1C', x: 3.0, y: F1[0], w: 0.9, h: 2.86, fam: 'bell', label: '1C', faces: { izq: [cat('Belleza', 'bell'), cat('Salud', 'bell')], der: [cat('Trastes', 'hogar')] } },
  { id: '1D', zone: 'Fila 1', name: 'Góndola 1D', x: 4.8, y: F1[0], w: 0.9, h: 2.86, fam: 'hogar', label: '1D', faces: { izq: [cat('Decoración hogar', 'hogar')], der: [cat('Electrónico', 'tec')] } },
  { id: 'wr1', zone: 'Fila 1', name: 'Pared der. · fila 1', x: null, y: F1[0], w: 0.4, h: 2.86, fam: 'acc', right: true, cats: [cat('Lentes', 'acc'), cat('Llaveros', 'acc'), cat('Bolsas', 'acc')] },

  { id: 'w2', zone: 'Fila 2', name: 'Pared izq. · fila 2', x: 0, y: F2[0], w: 0.4, h: 2.86, fam: 'ropa', cats: [cat('Ropa dama', 'ropa'), cat('Ropa niño', 'ropa')] },
  { id: '2I', zone: 'Fila 2', name: 'Góndola 2I', x: 1.2, y: F2[0], w: 0.9, h: 2.86, fam: 'jug', label: '2I', faces: { izq: [cat('Manualidades', 'jug'), cat('Agua / burbujas', 'jug')], der: [cat('Papelería', 'jug')] } },
  { id: '2C', zone: 'Fila 2', name: 'Góndola 2C', x: 3.0, y: F2[0], w: 0.9, h: 2.86, fam: 'hogar', label: '2C', faces: { izq: [cat('Decoración fiesta', 'jug')], der: [cat('Blancos', 'hogar')] } },
  { id: '2D', zone: 'Fila 2', name: 'Góndola 2D', x: 4.8, y: F2[0], w: 0.9, h: 2.86, fam: 'limp', label: '2D', faces: { izq: [cat('Limpieza', 'limp'), cat('Almacenamiento', 'hogar')], der: [cat('Zapatería', 'ropa')] } },
  { id: 'wr2', zone: 'Fila 2', name: 'Pared der. · fila 2', x: null, y: F2[0], w: 0.4, h: 2.86, fam: 'ropa', right: true, cats: [cat('Zapatos', 'ropa'), cat('Caballero', 'ropa')] },

  { id: 'w3', zone: 'Fila 3', name: 'Pared izq. · fila 3', x: 0, y: F3[0], w: 0.4, h: 2.86, fam: 'ropa', cats: [cat('Ropa niño / niña', 'ropa')] },
  { id: '3I', zone: 'Fila 3', name: 'Góndola 3I', x: 1.2, y: F3[0], w: 0.9, h: 2.86, fam: 'jug', label: '3I', faces: { izq: [cat('Juguetes', 'jug')], der: [cat('Sobrantes varios / familia', 'bot')] } },
  { id: '3C', zone: 'Fila 3', name: 'Góndola 3C', x: 3.0, y: F3[0], w: 0.9, h: 2.86, fam: 'limp', label: '3C', faces: { izq: [cat('Comida', 'limp')], der: [cat('Desechables', 'limp')] } },
  { id: '3D', zone: 'Fila 3', name: 'Góndola 3D', x: 4.8, y: F3[0], w: 0.9, h: 2.86, fam: 'masc', label: '3D', faces: { izq: [cat('Carrito asada', 'hogar'), cat('Jardinería', 'masc')], der: [cat('Herramienta', 'tec'), cat('Autos', 'tec'), cat('Mascotas', 'masc')] } },
  { id: 'wr3', zone: 'Fila 3', name: 'Pared der. · fila 3', x: null, y: F3[0], w: 0.4, h: 2.86, fam: 'masc', right: true, cats: [cat('Jardinería', 'masc'), cat('Mascotas', 'masc')] },

  { id: 'mueb', zone: 'Fondo', name: 'Exhibición Muebles', x: 0.5, y: 15.25, w: 2.1, h: 1.2, fam: 'muebles', label: 'MUEBLES', cats: [cat('Muebles', 'muebles')] },
  { id: 'colch', zone: 'Fondo', name: 'Exhibición Colchones', x: 3.0, y: 15.25, w: 2.3, h: 1.2, fam: 'muebles', label: 'COLCHONES', cats: [cat('Colchones', 'muebles')] },
  { id: 'p3a', zone: 'Fondo', name: 'Pared fondo · tramo 1', x: 0.1, y: 16.58, w: 1.7, h: 0.4, fam: 'hogar', fs: 3.3, cats: [cat('Toallas baño', 'hogar'), cat('Cobijas', 'hogar')] },
  { id: 'p3b', zone: 'Fondo', name: 'Pared fondo · tramo 2', x: 1.85, y: 16.58, w: 1.65, h: 0.4, fam: 'hogar', fs: 3.3, cats: [cat('Almohadas', 'hogar'), cat('Fundas', 'hogar')] },
  { id: 'p3c', zone: 'Fondo', name: 'Pared fondo · tramo 3', x: 3.55, y: 16.58, w: 1.45, h: 0.4, fam: 'hogar', fs: 3.3, cats: [cat('Toallas playa', 'hogar')] },
  { id: 'p3d', zone: 'Fondo', name: 'Pared fondo · tramo 4', x: 5.05, y: 16.58, w: 1.7, h: 0.4, fam: 'tec', fs: 3.3, cats: [cat('Letreros neón', 'tec'), cat('Pizarrón', 'jug')] },
];
const COLS = [{ n: 'C2', x: 2.6, y: 4.9, w: .40, h: .44 }, { n: 'C1', x: 3.5, y: 4.9, w: .23, h: .25 }, { n: 'C3', x: 2.25, y: 8.3, w: .14, h: .44 }, { n: 'C4', x: 2.25, y: 11.8, w: .38, h: .45 }, { n: 'C5', x: 2.2, y: 15.23, w: .19, h: .18 }, { n: 'C6', x: 3.7, y: 15.23, w: .18, h: .18 }];

/** Los letreros de un mueble, en orden de cara. */
export const numerosDe = (f) => [].concat(NUM[f.id] ?? []);
/** Las categorías de un letrero del mueble (la cara `cara` si es góndola). */
export const categoriasDe = (f, cara = 0) => (f.faces ? (cara ? f.faces.der : f.faces.izq) : f.cats);
/** El mueble de un letrero y la cara que le toca. */
export const muebleDe = (n) => {
  const f = FX.find((x) => numerosDe(x).includes(n));
  return f && { f, cara: numerosDe(f).indexOf(n) };
};

const S = 20;   // unidades del svg por metro
const TOP = 19.6, LEFT = -2.4, RIGHT = 8.1, BOTTOM = -2.0;
const X = (x) => (x - LEFT) * S, Y = (y) => (TOP - y) * S;
const W = (RIGHT - LEFT) * S, H = (TOP - BOTTOM) * S;
const NS = 'http://www.w3.org/2000/svg';
const el = (t, a = {}, txt) => {
  const e = document.createElementNS(NS, t);
  for (const k in a) e.setAttribute(k, a[k]);
  if (txt != null) e.textContent = txt;
  return e;
};

/**
 * Dibuja el plano en `svg` (dentro de `escenario`, que da el tamaño) y lo deja arrastrar y acercar.
 * `alTocar(mueble, cara)` se llama al tocar un mueble sin arrastrar; `cara` es 0/1 en góndolas según el lado tocado.
 * Devuelve { resaltar(nums), colorear(n => color|null), marcar(mueble|null), enfocar(n), ajustar() }.
 */
export function crearPlano(escenario, svg, alTocar) {
  svg.replaceChildren();
  let view = { x: 0, y: 0, w: W, h: H };
  const g = el('g'); svg.appendChild(g);
  const defs = el('defs');
  const pat = el('pattern', { id: 'plano-rampa', width: 3, height: 3, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
  pat.append(el('rect', { width: 3, height: 3, fill: '#EEF2F7' }), el('line', { x1: 0, y1: 0, x2: 0, y2: 3, stroke: '#B8C3D1', 'stroke-width': .8 }));
  defs.appendChild(pat); svg.appendChild(defs);
  const piso = el('g'), fx = el('g'), cols = el('g'), lbl = el('g'), nums = el('g', { class: 'num' });
  g.append(piso, fx, cols, lbl, nums);
  const rect = (L, x, y, w, h, a = {}) => { const r = el('rect', { x: X(x), y: Y(y + h), width: w * S, height: h * S, ...a }); L.appendChild(r); return r; };
  const texto = (L, x, y, t, cls, extra = {}) => { const e = el('text', { x: X(x), y: Y(y), class: cls, ...extra }, t); L.appendChild(e); return e; };
  const vertical = (x, y) => `rotate(-90 ${X(x)} ${Y(y)})`;
  const path = (L, cls, d) => L.appendChild(el('path', { class: cls, d }));

  // Calle, cuarto de entrada, acceso, rampa y salón
  rect(piso, -2.4, -2.0, 10.5, 2.0, { fill: '#E4E8EE' }); texto(piso, 3.4, -1.75, 'BANQUETA · CALLE', 'zone');
  rect(piso, 0, 0, 4.64, 3.21, { class: 'floor' });
  rect(piso, 4.64, 0, 0.52, 3.21, { class: 'ghost' });
  rect(piso, 5.16, 0, 1.70, 2.57, { class: 'floor' }); texto(piso, 6.01, 1.3, 'ACCESO', 'zone');
  path(piso, 'ramp', `M${X(0)} ${Y(3.21)} L${X(5.16)} ${Y(3.21)} L${X(5.16)} ${Y(2.57)} L${X(6.86)} ${Y(2.57)} L${X(6.86)} ${Y(3.88)} L${X(0)} ${Y(3.88)} Z`);
  texto(piso, 2.6, 3.36, 'RAMPA · SIN MUEBLES', 'zone', { style: 'font-size:4.2px' });
  path(piso, 'floor', `M${X(0)} ${Y(SAL_Y0)} L${X(SAL_W0)} ${Y(SAL_Y0)} L${X(SAL_W1)} ${Y(SAL_Y1)} L${X(0)} ${Y(SAL_Y1)} Z`);
  rect(piso, 0, 16.98, 3.4, 2.0, { class: 'ghost' }); texto(piso, 1.7, 17.95, 'ALMACÉN', 'zone');
  rect(piso, 3.4, 16.98, 3.43, 2.0, { class: 'ghost' }); texto(piso, 5.1, 17.95, 'OFICINA', 'zone');
  rect(piso, -1.2, 9.3, 1.2, 1.3, { class: 'ghost' }); texto(piso, -0.6, 9.9, 'PROBADOR', 'zone', { style: 'font-size:4.4px' });
  piso.appendChild(el('line', { x1: X(0), y1: Y(9.45), x2: X(0), y2: Y(10.5), class: 'door' }));
  path(piso, 'wall', `M${X(0)} ${Y(0)} L${X(0)} ${Y(19.0)} L${X(SAL_W1)} ${Y(19.0)} L${X(SAL_W1)} ${Y(SAL_Y1)} L${X(SAL_W0)} ${Y(SAL_Y0)} L${X(6.86)} ${Y(3.88)} L${X(6.86)} ${Y(0)}`
    + ` M${X(0)} ${Y(SAL_Y1)} L${X(SAL_W1)} ${Y(SAL_Y1)} M${X(0)} ${Y(0)} L${X(0.4)} ${Y(0)} M${X(2.1)} ${Y(0)} L${X(2.6)} ${Y(0)} M${X(4.3)} ${Y(0)} L${X(5.16)} ${Y(0)}`);
  for (const [a, b, t] of [[0.4, 2.1, 'ENTRADA A'], [2.6, 4.3, 'ENTRADA B'], [5.16, 6.86, 'ACCESO']]) {
    piso.appendChild(el('line', { x1: X(a), y1: Y(0), x2: X(b), y2: Y(0), class: 'door' }));
    texto(piso, (a + b) / 2, -0.32, t, 'zone', { style: 'font-size:4.2px;fill:#16366B' });
  }

  // Muebles
  const nodos = {};
  for (const f of FX) {
    if (f.right) f.x = rw(f.y + f.h / 2) - f.w;
    const r = rect(fx, f.x, f.y, f.w, f.h, { class: 'fx' + (f.ghost ? ' ghost' : ''), fill: f.ghost ? 'none' : FAM[f.fam].c, rx: 0.8, 'data-id': f.id });
    nodos[f.id] = { r, extra: [] };
    const cy = f.y + f.h / 2;
    if (f.faces) {
      // Dos franjas de color, una por cara, y el texto de cada cara en vertical.
      const fw = f.w * S * 0.28;
      for (const [x0, cs, cx] of [[X(f.x), f.faces.izq, f.x + f.w * 0.14], [X(f.x + f.w) - fw, f.faces.der, f.x + f.w * 0.86]]) {
        nodos[f.id].extra.push(
          fx.appendChild(el('rect', { x: x0, y: Y(f.y + f.h), width: fw, height: f.h * S, fill: FAM[cs[0].f].c, 'pointer-events': 'none' })),
          texto(lbl, cx, cy, cs.map((c) => c.t).join(' · '), 'lbl', { transform: vertical(cx, cy), style: 'font-size:3.9px' }));
      }
      nodos[f.id].extra.push(texto(lbl, f.x + f.w / 2, cy, f.label, 'lbl dark', { transform: vertical(f.x + f.w / 2, cy), style: 'font-size:4.6px' }));
    } else {
      const cx = f.x + f.w / 2;
      const e = texto(lbl, cx, cy, f.label || f.cats.map((c) => c.t).join(' · '), 'lbl' + (f.ghost || f.fam === 'bot' || f.fam === 'acc' ? ' dark' : ''),
        { style: `font-size:${f.fs || (f.w * S < 9 ? 3.6 : 4.2)}px` });
      if (f.h > f.w * 1.4) e.setAttribute('transform', vertical(cx, cy));
      nodos[f.id].extra.push(e);
    }
  }
  // Letreros numerados, encima de todo; uno por cara.
  const insignias = {};
  const insignia = (x, y, n) => {
    const c = el('circle', { cx: X(x), cy: Y(y), r: 4.2 }), t = el('text', { x: X(x), y: Y(y) }, n);
    nums.append(c, t); insignias[n] = { c, t };
  };
  for (const f of FX) {
    const n = NUM[f.id];
    if (n == null) continue;
    const alto = f.h > f.w * 1.4;
    if (Array.isArray(n)) { insignia(f.x + f.w * 0.14, f.y + 0.3, n[0]); insignia(f.x + f.w * 0.86, f.y + 0.3, n[1]); }
    else insignia(alto ? f.x + f.w / 2 : f.x + 0.25, alto ? f.y + 0.3 : f.y + f.h / 2, n);
  }
  for (const c of COLS) { rect(cols, c.x - c.w / 2, c.y - c.h / 2, c.w, c.h, { class: 'col' }); texto(cols, c.x + c.w / 2 + 0.1, c.y - 0.1, c.n, 'coltxt'); }

  /* ---------- lo que la pantalla pide ---------- */
  const opaco = (f, on) => {
    const o = on ? '' : '.18';
    nodos[f.id].r.style.opacity = o;
    for (const e of nodos[f.id].extra) e.style.opacity = o;
  };
  const resaltar = (lista) => {
    const sel = lista && new Set(lista);
    for (const f of FX) opaco(f, !sel || numerosDe(f).some((n) => sel.has(n)));
    for (const n in insignias) {
      const on = !!sel?.has(Number(n));
      insignias[n].c.classList.toggle('hl', on);
      insignias[n].c.setAttribute('r', on ? 6 : 4.2);
    }
  };
  const colorear = (colorDe) => {
    for (const n in insignias) {
      const color = colorDe(Number(n));
      insignias[n].c.style.fill = color ?? '';
      insignias[n].t.style.fill = color ? '#fff' : '';
    }
  };
  const marcar = (f) => { for (const x of FX) nodos[x.id].r.classList.toggle('sel', x === f); };
  const ver = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  const ajustar = () => {
    const r = escenario.getBoundingClientRect(), ar = (r.width || 1) / (r.height || 1);
    let w = W, h = H;
    if (w / h < ar) w = h * ar; else h = w / ar;
    view = { x: (W - w) / 2, y: (H - h) / 2, w, h }; ver();
  };
  const acercar = (k, cx, cy) => {
    const r = svg.getBoundingClientRect();
    const px = view.x + (cx - r.left) / r.width * view.w, py = view.y + (cy - r.top) / r.height * view.h;
    const nw = Math.max(W / 8, Math.min(W * 2.5, view.w / k)), nh = nw * (view.h / view.w);
    view = { x: px - (px - view.x) * (nw / view.w), y: py - (py - view.y) * (nh / view.h), w: nw, h: nh }; ver();
  };
  const enfocar = (n) => {
    const m = muebleDe(n);
    if (!m) return;
    const r = svg.getBoundingClientRect(), w = W / 2.2, h = w * (r.height / r.width);
    view = { x: X(m.f.x + m.f.w / 2) - w / 2, y: Y(m.f.y + m.f.h / 2) - h / 2, w, h }; ver();
  };
  const centro = () => { const r = svg.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  escenario.querySelector('[data-zoom="in"]')?.addEventListener('click', () => acercar(1.3, ...centro()));
  escenario.querySelector('[data-zoom="out"]')?.addEventListener('click', () => acercar(1 / 1.3, ...centro()));
  svg.addEventListener('wheel', (e) => { e.preventDefault(); acercar(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });

  // Un dedo arrastra, dos acercan; un toque sin movimiento elige el mueble que esta debajo.
  const dedos = new Map();
  let ultimo = null, pellizco = null, movido = false;
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture(e.pointerId); dedos.set(e.pointerId, { x: e.clientX, y: e.clientY }); movido = false;
    if (dedos.size === 1) { ultimo = { x: e.clientX, y: e.clientY }; svg.classList.add('drag'); }
    if (dedos.size === 2) { const [a, b] = [...dedos.values()]; pellizco = Math.hypot(a.x - b.x, a.y - b.y); movido = true; }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!dedos.has(e.pointerId)) return;
    dedos.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (dedos.size === 1 && ultimo) {
      const r = svg.getBoundingClientRect();
      if (Math.abs(e.clientX - ultimo.x) + Math.abs(e.clientY - ultimo.y) > 4) movido = true;
      if (!movido) return;
      view.x -= (e.clientX - ultimo.x) / r.width * view.w; view.y -= (e.clientY - ultimo.y) / r.height * view.h;
      ultimo = { x: e.clientX, y: e.clientY }; ver();
    } else if (dedos.size === 2 && pellizco) {
      const [a, b] = [...dedos.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      acercar(d / pellizco, (a.x + b.x) / 2, (a.y + b.y) / 2); pellizco = d;
    }
  });
  const soltar = (e) => {
    const toque = !movido && dedos.size === 1 && dedos.has(e.pointerId) && e.type === 'pointerup';
    dedos.delete(e.pointerId);
    if (dedos.size < 2) pellizco = null;
    if (dedos.size === 0) { ultimo = null; svg.classList.remove('drag'); }
    if (!toque) return;
    const f = FX.find((x) => x.id === document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.fx')?.dataset.id);
    if (!f) return;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    alTocar(f, f.faces && p.x > X(f.x) + f.w * S / 2 ? 1 : 0);
  };
  svg.addEventListener('pointerup', soltar);
  svg.addEventListener('pointercancel', soltar);
  window.addEventListener('resize', ajustar);
  ajustar();
  return { resaltar, colorear, marcar, enfocar, ajustar };
}
