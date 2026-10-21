"""Carga el manifiesto del proveedor a la tabla `manifiesto` (Issue #365).

    python tools/importar_manifiesto.py sandbox [--maximo N]
    python tools/importar_manifiesto.py produccion [--maximo N]
    python tools/importar_manifiesto.py local          (la D1 de `wrangler dev`)
    python tools/importar_manifiesto.py --prueba        (solo la comprobacion de abajo)

Baja la hoja como .xlsx (sin sesion: se lee con el enlace), toma cada pestaña
"Truck <id>", deja un renglon por UPC y sube SOLO lo nuevo o cambiado.

Cuota de D1: cada UPC cuenta como 2 renglones escritos (la tabla y el indice de su
llave). La hoja completa son ~71 mil UPC = ~143 mil escrituras, mas que las 100 mil
diarias del plan gratuito de Workers, que comparten produccion y sandbox: pasarse
deja a la caja sin poder registrar ventas el resto del dia. Por eso cada corrida sube
a lo mas MAXIMO UPC (30 mil = ~60 mil escrituras); la siguiente corrida, al otro dia,
sigue donde se quedo. Con Workers Paid (50 M al mes) pasar --maximo 100000.
Si cambia la descripcion de un UPC, su nombre traducido se borra y se vuelve a
traducir la siguiente vez que alguien lo escanee. Requiere la migracion 044.
"""

from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
HOJA = "13vihiHG3Dp9Kbh_EPr6Ci6EmUlcsuiwmWG5GAnYjSDo"
DESTINOS = {
    "produccion": ("el-dolaron", ["--remote"]),
    "sandbox": ("el-dolaron-sandbox", ["--remote", "--config", "wrangler.sandbox.jsonc"]),
    "local": ("el-dolaron", ["--local"]),
}
# Columnas de cada renglon de una pestaña Truck (los encabezados de la hoja no
# coinciden con los datos, asi que van por posicion; ver validar en renglones()).
TRUCK, PALLET, DESCRIPCION, PRECIO, TCIN, UPC = 0, 1, 2, 5, 7, 9
DEPARTAMENTOS = (12, 11, 10)   # departamento; si viene vacio, division; luego grupo
SIN_DATO = {"", "not provided"}
POR_SENTENCIA = 300
MAXIMO = 30_000


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
ANCHO = 24   # columnas A..X de una pestaña Truck


def numero(valor: str) -> str:
    """Excel guarda los numeros como texto en <v>; uno grande puede venir como 1.91907910414E+11."""
    if re.fullmatch(r"-?\d+(\.\d+)?[eE][+-]?\d+", valor):
        return format(Decimal(valor), "f")
    return valor


def columna(referencia: str) -> int:
    letras = re.match(r"[A-Z]+", referencia).group()
    return sum((ord(c) - 64) * 26 ** i for i, c in enumerate(reversed(letras))) - 1


def descargar() -> bytes:
    """La hoja completa en .xlsx, una sola descarga (~40 MB). No se usa el CSV de gviz:
    adivina un tipo por columna y deja vacios los valores del otro tipo."""
    url = f"https://docs.google.com/spreadsheets/d/{HOJA}/export?format=xlsx"
    with urllib.request.urlopen(url, timeout=600) as respuesta:
        return respuesta.read()


def pestañas_truck(datos: bytes) -> dict[str, list[list[str]]]:
    """Cada pestaña "Truck <id>" como renglones de texto, columnas A..X."""
    libro = zipfile.ZipFile(io.BytesIO(datos))
    compartidos = ["".join(t.text or "" for t in si.iter(f"{NS}t"))
                   for si in ET.parse(libro.open("xl/sharedStrings.xml")).getroot()]
    rel = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    destinos = {r.get("Id"): r.get("Target") for r in ET.parse(libro.open("xl/_rels/workbook.xml.rels")).getroot()}
    pestañas = {}
    for hoja in ET.parse(libro.open("xl/workbook.xml")).getroot().iter(f"{NS}sheet"):
        camion = re.fullmatch(r"Truck (\d{8})", hoja.get("name", "").strip())
        if not camion:
            continue
        filas = []
        for fila in ET.parse(libro.open("xl/" + destinos[hoja.get(rel)].lstrip("/").removeprefix("xl/"))).getroot().iter(f"{NS}row"):
            valores = [""] * ANCHO
            for celda in fila.iter(f"{NS}c"):
                i = columna(celda.get("r"))
                if i >= ANCHO:
                    continue
                v = celda.find(f"{NS}v")
                if celda.get("t") == "s" and v is not None:
                    valores[i] = compartidos[int(v.text)]
                elif celda.get("t") == "inlineStr":
                    valores[i] = "".join(t.text or "" for t in celda.iter(f"{NS}t"))
                elif v is not None and v.text is not None:
                    valores[i] = v.text if celda.get("t") == "str" else numero(v.text)
            filas.append(valores)
        pestañas[camion.group(1)] = filas
    return pestañas


def centavos(texto: str) -> int | None:
    try:
        return round(float(texto.replace("$", "").replace(",", "")) * 100)
    except ValueError:
        return None


def renglones(camion: str, filas: list[list[str]]) -> list[dict]:
    """Los productos de una pestaña. Si la pestaña ya no empieza con "Truck <id>",
    cambio de formato y las columnas por posicion ya no son confiables."""
    if not filas or not filas[0] or not filas[0][0].startswith(f"Truck {camion}"):
        raise ValueError(f"la pestaña Truck {camion} no existe o cambio de formato")
    salida = []
    for f in filas:
        if len(f) <= max(UPC, *DEPARTAMENTOS) or f[TRUCK].strip() != camion or not f[PALLET].strip():
            continue
        upc = re.sub(r"\D", "", f[UPC]).lstrip("0")
        precio = centavos(f[PRECIO])
        if not 6 <= len(upc) <= 14 or precio is None or not f[DESCRIPCION].strip():
            continue
        departamento = next((f[i].strip() for i in DEPARTAMENTOS if f[i].strip().lower() not in SIN_DATO), "")
        salida.append({"upc": upc, "descripcion": f[DESCRIPCION].strip()[:200], "precio_usd": precio,
                       "departamento": departamento[:80], "tcin": f[TCIN].strip()})
    return salida


def un_renglon_por_upc(todos: list[dict]) -> dict[str, dict]:
    """El mismo UPC sale en varios camiones, a veces con otra descripcion o precio:
    gana la version mas repetida; si empatan, la de precio mas alto."""
    por_upc: dict[str, Counter] = defaultdict(Counter)
    for r in todos:
        por_upc[r["upc"]][(r["descripcion"], r["precio_usd"], r["departamento"], r["tcin"])] += 1
    elegidos = {}
    for upc, versiones in por_upc.items():
        (descripcion, precio, departamento, tcin), _ = max(versiones.items(), key=lambda v: (v[1], v[0][1]))
        elegidos[upc] = {"upc": upc, "descripcion": descripcion, "precio_usd": precio,
                         "departamento": departamento, "tcin": tcin}
    return elegidos


CAMPOS = ("descripcion", "precio_usd", "departamento", "tcin")


def diferencia(nuevos: dict[str, dict], actuales: dict[str, dict]) -> list[dict]:
    return [r for upc, r in nuevos.items()
            if upc not in actuales or any(str(actuales[upc][c]) != str(r[c]) for c in CAMPOS)]


def texto(valor: str) -> str:
    return "'" + valor.replace("'", "''") + "'"


def sql(cambios: list[dict], ahora: str) -> str:
    sentencias = []
    for i in range(0, len(cambios), POR_SENTENCIA):
        valores = ",\n".join(
            f"({texto(r['upc'])}, {texto(r['descripcion'])}, {texto(r['departamento'])}, {int(r['precio_usd'])}, "
            f"{texto(r['tcin'])}, {texto(ahora)})" for r in cambios[i:i + POR_SENTENCIA])
        sentencias.append(
            "insert into manifiesto (upc, descripcion, departamento, precio_usd, tcin, actualizado_en) values\n"
            f"{valores}\n"
            "on conflict (upc) do update set\n"
            "  nombre = case when manifiesto.descripcion = excluded.descripcion then manifiesto.nombre else '' end,\n"
            "  marca = case when manifiesto.descripcion = excluded.descripcion then manifiesto.marca else '' end,\n"
            "  categoria = case when manifiesto.descripcion = excluded.descripcion then manifiesto.categoria else '' end,\n"
            "  descripcion = excluded.descripcion, departamento = excluded.departamento,\n"
            "  precio_usd = excluded.precio_usd, tcin = excluded.tcin, actualizado_en = excluded.actualizado_en;\n")
    return "".join(sentencias)


def wrangler(*args: str) -> str:
    npx = shutil.which("npx") or "npx"
    resultado = subprocess.run([npx, "wrangler", *args], cwd=APP, capture_output=True, text=True, encoding="utf-8")
    if resultado.returncode != 0:
        sys.exit(f"wrangler {' '.join(args)} fallo:\n{resultado.stdout}\n{resultado.stderr}")
    return resultado.stdout


def main(destino: str, maximo: int = MAXIMO) -> None:
    base, banderas = DESTINOS[destino]
    pestañas = pestañas_truck(descargar())
    camiones = sorted(pestañas)
    todos = []
    for camion in camiones:
        try:
            filas = renglones(camion, pestañas[camion])
        except ValueError as error:
            print(f"  se omite: {error}")
            continue
        print(f"  Truck {camion}: {len(filas)} renglones")
        todos += filas
    nuevos = un_renglon_por_upc(todos)
    salida = wrangler("d1", "execute", base, *banderas, "--json", "--command",
                      "select upc, descripcion, precio_usd, departamento, tcin from manifiesto")
    actuales = {r["upc"]: r for r in json.loads(salida)[0]["results"]}
    cambios = diferencia(nuevos, actuales)
    print(f"{len(camiones)} camiones, {len(todos)} renglones, {len(nuevos)} UPC; "
          f"en la base {len(actuales)}; nuevos o cambiados: {len(cambios)}")
    if not cambios:
        return
    if len(cambios) > maximo:
        print(f"Se suben {maximo} ahora (cuota diaria de D1); faltan {len(cambios) - maximo}: correlo otra vez mañana.")
        cambios = cambios[:maximo]
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as archivo:
        archivo.write(sql(cambios, datetime.now(timezone.utc).isoformat()))
    wrangler("d1", "execute", base, *banderas, "--yes", f"--file={archivo.name}")
    Path(archivo.name).unlink()
    print("Listo.")


def prueba() -> None:
    filas = [["Truck 123 | resumen"], ["123", "S1", "GG GUMMY 7OZ", "View photos", "2", "$4.99", "$9.98", "949", "055",
             "0191907910414", "FOOD", "SNACKS", "Not provided"],
             ["123", "S2", "GG GUMMY 7OZ", "", "1", "$4.99", "", "949", "", "191907910414", "", "", "CANDY"],
             ["123", "S2", "Tee Black M", "", "1", "25.00", "", "1", "", "123456789012", "", "", "SHIRTS"],
             ["123", "S3", "Tee Black M", "", "1", "27.00", "", "1", "", "123456789012", "", "", "SHIRTS"],
             ["123", "S3", "sin upc", "", "1", "3.00", "", "1", "", "", "", "", ""]]
    r = renglones("123", filas)
    assert [x["upc"] for x in r] == ["191907910414"] * 2 + ["123456789012"] * 2, r
    assert r[0]["departamento"] == "SNACKS" and r[1]["departamento"] == "CANDY"
    try:
        renglones("999", filas)
        raise AssertionError("una pestaña ajena no debe pasar")
    except ValueError:
        pass
    elegidos = un_renglon_por_upc(r)
    assert elegidos["123456789012"]["precio_usd"] == 2700   # empate: el precio mas alto
    assert elegidos["191907910414"]["precio_usd"] == 499
    actuales = {u: dict(v) for u, v in elegidos.items()}
    assert diferencia(elegidos, actuales) == []               # segunda corrida: nada que escribir
    actuales["123456789012"]["precio_usd"] = 1
    assert [c["upc"] for c in diferencia(elegidos, actuales)] == ["123456789012"]
    assert numero("1.91907910414E+11") == "191907910414" and numero("4.99") == "4.99"
    assert columna("A7") == 0 and columna("J12") == 9 and columna("AA1") == 26
    assert "'O''Neill'" in sql([{"upc": "1", "descripcion": "O'Neill", "departamento": "", "precio_usd": 1, "tcin": ""}], "t")
    print("ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--prueba"]:
        prueba()
    elif len(sys.argv) == 2 and sys.argv[1] in DESTINOS:
        main(sys.argv[1])
    elif len(sys.argv) == 4 and sys.argv[1] in DESTINOS and sys.argv[2] == "--maximo" and sys.argv[3].isdigit():
        main(sys.argv[1], int(sys.argv[3]))
    else:
        sys.exit(__doc__)
