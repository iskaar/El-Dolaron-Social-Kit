"""Genera la «página de catálogo» de la portada (Issues #531 y #630) con recortes reales del catálogo.

Uso: python tools/pila_stickers.py [--salida site/public/assets] [--api https://dolarones.eldolaron.com] [--semana 2026-W44]
Requiere Pillow. Escribe pila.webp (1200 px), pila-640.webp y pila.json; si algo falla en la red no escribe nada.
Composición: cuadrícula 3x2 de celdas #F2F5FA con 24 px de separación; en cada una el recorte contenido (sombra suave,
sin troquel ni giro) y debajo el precio en rojo con Big Shoulders Display 800. La fuente es la misma que usa el sitio
(site/public/assets/fonts/big-shoulders-display-variable.woff2): Pillow abre el woff2 directo con FreeType, sin fontTools.
"""
import argparse
import io
import json
import random
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

LADO, PIEZAS, GAP, COLS, FILAS = 1200, 6, 24, 3, 2
FONDO_CELDA, ROJO, TAM_PRECIO, ZONA_PRECIO, MARGEN = (242, 245, 250), (215, 43, 50), 64, 112, .08
FUENTE = Path(__file__).resolve().parent.parent / "site/public/assets/fonts/big-shoulders-display-variable.woff2"
MAX_PAGINAS, MAX_CANDIDATOS, MAX_POR_CATEGORIA = 4, 60, 2


def get(url):
    pedido = urllib.request.Request(url, headers={"User-Agent": "ElDolaron-pila/1.0"})
    with urllib.request.urlopen(pedido, timeout=20) as r:
        return r.read()


def candidatos(api):
    """Recorre el catálogo con el cursor hasta 4 páginas o 60 piezas con recorte."""
    piezas, despues = [], None
    for _ in range(MAX_PAGINAS):
        params = {"recorte": "1", **({"despues": despues} if despues else {})}
        d = json.loads(get(f"{api}/api/catalogo?{urllib.parse.urlencode(params)}"))
        piezas += [p for p in d["piezas"] if str(p.get("recorte", "")).startswith("https://")]
        despues = d.get("siguiente")
        if not d.get("hay_mas") or not despues or len(piezas) >= MAX_CANDIDATOS:
            break
    return piezas[:MAX_CANDIDATOS]


def abrir(pieza):
    """Recorte recortado a su caja visible."""
    im = Image.open(io.BytesIO(get(pieza["recorte"]))).convert("RGBA")
    alfa = im.getchannel("A")
    caja = alfa.getbbox()
    if not caja:
        raise ValueError("recorte vacío")
    return im.crop(caja)


def clave(p):
    """Marca (o primeras dos palabras del nombre) en minúsculas, para no repetir producto."""
    return (p.get("marca") or " ".join(p["nombre"].split()[:2])).strip().lower()


def elegir(piezas, rng):
    """Seis piezas deterministas por semana: sin repetir marca ni primera palabra del nombre, máx. 2 por categoría."""
    piezas = sorted(piezas, key=lambda p: p["codigo"])
    rng.shuffle(piezas)
    elegidas, marcas, palabras, cuenta = [], set(), set(), Counter()
    for p in piezas:
        k, w = clave(p), p["nombre"].split()[0].lower()
        if len(elegidas) < PIEZAS and k not in marcas and w not in palabras and cuenta[p.get("categoria")] < MAX_POR_CATEGORIA:
            elegidas.append(p)
            marcas.add(k), palabras.add(w)
            cuenta[p.get("categoria")] += 1
    for p in piezas:   # si la variedad no alcanza, se completa solo sin repetir marca
        if len(elegidas) < PIEZAS and all(p is not e for e in elegidas) and clave(p) not in marcas:
            elegidas.append(p)
            marcas.add(clave(p))
    resto = [p for p in piezas if all(p is not e for e in elegidas)]
    return elegidas + resto[:PIEZAS - len(elegidas)]


def con_sombra(im, lado_max):
    """Recorte contenido en (ancho, alto) con una sombra negra muy suave debajo, para que no flote."""
    im = im.copy()
    im.thumbnail(lado_max, Image.LANCZOS)
    hoja = Image.new("RGBA", (im.width + 80, im.height + 80))
    sombra = Image.new("RGBA", im.size, (0, 0, 0, 0))
    sombra.putalpha(im.getchannel("A").point(lambda v: v * 30 // 255))   # ~12 % de opacidad
    hoja.paste(sombra, (40, 46))
    hoja = hoja.filter(ImageFilter.GaussianBlur(18))
    hoja.alpha_composite(im, (40, 40))
    return hoja, im.size


def componer(elegidas):
    """Cuadrícula 3x2 de celdas #F2F5FA con recorte contenido (8 % de margen) y precio debajo."""
    ancho, alto = (LADO - GAP * (COLS - 1)) // COLS, (LADO - GAP * (FILAS - 1)) // FILAS
    fuente = ImageFont.truetype(str(FUENTE), TAM_PRECIO)
    fuente.set_variation_by_axes([800])
    lienzo = Image.new("RGBA", (LADO, LADO), (255, 255, 255, 255))
    dib = ImageDraw.Draw(lienzo)
    cajas = []
    for i, p in enumerate(elegidas):
        x0, y0 = (ancho + GAP) * (i % COLS), (alto + GAP) * (i // COLS)
        dib.rectangle((x0, y0, x0 + ancho - 1, y0 + alto - 1), fill=FONDO_CELDA)
        m = round(ancho * MARGEN)
        zona = (ancho - 2 * m, alto - 2 * m - ZONA_PRECIO)   # el precio ocupa la franja inferior de la celda
        img, (w, h) = con_sombra(p["im"], zona)
        px, py = x0 + (ancho - w) // 2, y0 + m + (zona[1] - h) // 2
        lienzo.alpha_composite(img, (px - 40, py - 40))
        texto = "${:,}".format(round(p["precio"] / 100))
        tw = dib.textlength(texto, font=fuente)
        dib.text((x0 + (ancho - tw) / 2, y0 + alto - m - ZONA_PRECIO // 2), texto, font=fuente, fill=ROJO, anchor="lm")
        cajas.append({"codigo": p["codigo"], "nombre": p["nombre"], "precio": p["precio"], "x": round(px / LADO, 4),
                      "y": round(py / LADO, 4), "w": round(w / LADO, 4), "h": round(h / LADO, 4), "giro": 0})
    return lienzo.convert("RGB"), cajas


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--salida", default="site/public/assets")
    ap.add_argument("--api", default="https://dolarones.eldolaron.com")
    ap.add_argument("--semana", default="{}-W{:02d}".format(*datetime.now(timezone.utc).isocalendar()[:2]))
    args = ap.parse_args()
    rng = random.Random(args.semana)
    try:
        piezas = candidatos(args.api.rstrip("/"))
        buenas = []
        for p in piezas:
            try:
                p["im"] = abrir(p)
                buenas.append(p)
            except (urllib.error.URLError, OSError, ValueError, TimeoutError):
                print(f"Aviso: se omite {p['codigo']} (recorte no disponible)", file=sys.stderr)
    except (urllib.error.URLError, OSError, ValueError, KeyError, TimeoutError) as error:
        sys.exit(f"No se pudo leer el catálogo de {args.api}: {error}. No se escribió nada.")
    if len(buenas) < PIEZAS:
        sys.exit(f"Solo hay {len(buenas)} recortes utilizables; se necesitan {PIEZAS}. No se escribió nada.")
    elegidas = elegir(buenas, rng)
    pila, cajas = componer(elegidas)
    salida = Path(args.salida)
    salida.mkdir(parents=True, exist_ok=True)
    pila.save(salida / "pila.webp", quality=82, method=6)
    pila.resize((640, 640), Image.LANCZOS).save(salida / "pila-640.webp", quality=82, method=6)
    datos = {"semana": args.semana, "generado": datetime.now(timezone.utc).isoformat(timespec="seconds"), "piezas": cajas}
    (salida / "pila.json").write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Pila {args.semana}: " + ", ".join(c["codigo"] for c in cajas))


if __name__ == "__main__":
    main()
