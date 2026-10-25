"""Genera la pila semanal de stickers de la portada (Issue #531) con recortes reales del catálogo.

Uso: python tools/pila_stickers.py [--salida site/public/assets] [--api https://dolarones.eldolaron.com] [--semana 2026-W44]
Requiere Pillow. Escribe pila.webp (1200 px), pila-640.webp y pila.json; si algo falla en la red no escribe nada.
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

from PIL import Image, ImageFilter

LADO, PIEZAS, MARGEN = 1200, 13, 26
GIROS = (-14, -8, 6, 12)
MAX_PAGINAS, MAX_CANDIDATOS, MAX_POR_CATEGORIA = 4, 60, 3


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
    """Recorte recortado a su caja y su proporción de relleno (1 = rectángulo lleno)."""
    im = Image.open(io.BytesIO(get(pieza["recorte"]))).convert("RGBA")
    alfa = im.getchannel("A")
    caja = alfa.getbbox()
    if not caja:
        raise ValueError("recorte vacío")
    im, alfa = im.crop(caja), alfa.crop(caja)
    lleno = sum(alfa.histogram()[129:]) / (im.width * im.height)
    return im, lleno


def elegir(piezas, rng):
    """Prefiere siluetas irregulares y variedad de categoría (máx. 3 por categoría)."""
    piezas = sorted(piezas, key=lambda p: p["codigo"])
    rng.shuffle(piezas)
    piezas.sort(key=lambda p: p["lleno"] >= .8)   # estable: irregulares primero, azar dentro de cada grupo
    elegidas, cuenta = [], Counter()
    for p in piezas:
        if len(elegidas) < PIEZAS and cuenta[p.get("categoria")] < MAX_POR_CATEGORIA:
            elegidas.append(p)
            cuenta[p.get("categoria")] += 1
    resto = [p for p in piezas if all(p is not e for e in elegidas)]   # si la variedad no alcanza, se completa sin tope
    elegidas += resto[:PIEZAS - len(elegidas)]
    return elegidas


def pegatina(im, lado, giro):
    """Miniatura con borde blanco troquelado, girada y con sombra azul desplazada."""
    im = im.copy()
    im.thumbnail((lado, lado), Image.LANCZOS)
    hoja = Image.new("RGBA", (im.width + 2 * MARGEN, im.height + 2 * MARGEN))
    hoja.paste(im, (MARGEN, MARGEN))
    borde = hoja.getchannel("A").filter(ImageFilter.MaxFilter(17))
    blanco = Image.new("RGBA", hoja.size, (255, 255, 255, 0))
    blanco.putalpha(borde)
    blanco.alpha_composite(hoja)
    blanco = blanco.rotate(giro, resample=Image.BICUBIC, expand=True)
    extra = 40   # lugar para la sombra desenfocada y desplazada
    lienzo = Image.new("RGBA", (blanco.width + extra, blanco.height + extra))
    sombra = Image.new("RGBA", blanco.size, (22, 54, 107, 0))
    sombra.putalpha(blanco.getchannel("A").point(lambda v: v * 120 // 255))
    lienzo.paste(sombra, (12, 16))
    lienzo = lienzo.filter(ImageFilter.GaussianBlur(8))
    lienzo.alpha_composite(blanco)
    return lienzo, blanco.size


def componer(elegidas, rng):
    """Rejilla 3x3 con ±30 px de azar y cuatro piezas más chicas en los cruces interiores."""
    paso = LADO // 3
    sitios = [(paso * (i % 3) + paso // 2, paso * (i // 3) + paso // 2, 400) for i in range(9)]
    sitios += [(paso * i, paso * j, 360) for j in (1, 2) for i in (1, 2)]
    lienzo = Image.new("RGBA", (LADO, LADO), (255, 255, 255, 255))
    cajas = []
    for p, (cx, cy, lado) in zip(elegidas, sitios):
        giro = rng.choice(GIROS) if lado == 400 else rng.choice((-10, 10))
        img, (w, h) = pegatina(p["im"], lado, giro)
        cx, cy = cx + rng.randint(-30, 30), cy + rng.randint(-30, 30)
        x, y = cx - img.width // 2, cy - img.height // 2
        lienzo.alpha_composite(img, (max(x, 0), max(y, 0)), (max(-x, 0), max(-y, 0)))
        # Caja de la pegatina (sin la sombra), en fracciones del cuadrado.
        bx, by = cx - w // 2, cy - h // 2
        cajas.append({"codigo": p["codigo"], "nombre": p["nombre"], "precio": p["precio"], "x": round(bx / LADO, 4),
                      "y": round(by / LADO, 4), "w": round(w / LADO, 4), "h": round(h / LADO, 4), "giro": giro})
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
                p["im"], p["lleno"] = abrir(p)
                buenas.append(p)
            except (urllib.error.URLError, OSError, ValueError, TimeoutError):
                print(f"Aviso: se omite {p['codigo']} (recorte no disponible)", file=sys.stderr)
    except (urllib.error.URLError, OSError, ValueError, KeyError, TimeoutError) as error:
        sys.exit(f"No se pudo leer el catálogo de {args.api}: {error}. No se escribió nada.")
    if len(buenas) < PIEZAS:
        sys.exit(f"Solo hay {len(buenas)} recortes utilizables; se necesitan {PIEZAS}. No se escribió nada.")
    elegidas = elegir(buenas, rng)
    pila, cajas = componer(elegidas, rng)
    salida = Path(args.salida)
    salida.mkdir(parents=True, exist_ok=True)
    pila.save(salida / "pila.webp", quality=82, method=6)
    pila.resize((640, 640), Image.LANCZOS).save(salida / "pila-640.webp", quality=82, method=6)
    datos = {"semana": args.semana, "generado": datetime.now(timezone.utc).isoformat(timespec="seconds"), "piezas": cajas}
    (salida / "pila.json").write_text(json.dumps(datos, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Pila {args.semana}: " + ", ".join(c["codigo"] for c in cajas))


if __name__ == "__main__":
    main()
