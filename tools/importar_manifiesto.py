"""Carga el manifiesto del proveedor a la tabla `manifiesto` (Issue #365).

    python tools/importar_manifiesto.py sandbox
    python tools/importar_manifiesto.py produccion
    python tools/importar_manifiesto.py local          (la D1 de `wrangler dev`)
    python tools/importar_manifiesto.py --prueba        (solo la comprobacion de abajo)

Baja cada pestaña "Truck <id>" de la hoja (sin sesion: la hoja se lee con el
enlace), deja un renglon por UPC y sube SOLO lo nuevo o cambiado: la primera vez
son ~73 mil escrituras, las siguientes la diferencia (cuota diaria de D1).
Si cambia la descripcion de un UPC, su nombre traducido se borra y se vuelve a
traducir la siguiente vez que alguien lo escanee. Requiere la migracion 044.
"""

from __future__ import annotations

import csv
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

APP = Path(__file__).resolve().parent.parent / "app"
HOJA = "13vihiHG3Dp9Kbh_EPr6Ci6EmUlcsuiwmWG5GAnYjSDo"
RESUMEN = "Available Truckloads"
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


def pestaña(nombre: str) -> list[list[str]]:
    url = (f"https://docs.google.com/spreadsheets/d/{HOJA}/gviz/tq?tqx=out:csv&sheet="
           + urllib.parse.quote(nombre))
    with urllib.request.urlopen(url, timeout=120) as respuesta:
        return list(csv.reader(io.StringIO(respuesta.read().decode("utf-8"))))


def centavos(texto: str) -> int | None:
    try:
        return round(float(texto.replace("$", "").replace(",", "")) * 100)
    except ValueError:
        return None


def renglones(camion: str, filas: list[list[str]]) -> list[dict]:
    """Los productos de una pestaña. Con un nombre de pestaña que no existe, la hoja
    regresa la primera pestaña: por eso se exige que empiece con "Truck <id>"."""
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


def main(destino: str) -> None:
    base, banderas = DESTINOS[destino]
    camiones = sorted({f[0].strip() for f in pestaña(RESUMEN) if f and re.fullmatch(r"\d{8}", f[0].strip())})
    todos = []
    for camion in camiones:
        try:
            filas = renglones(camion, pestaña(f"Truck {camion}"))
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
    assert "'O''Neill'" in sql([{"upc": "1", "descripcion": "O'Neill", "departamento": "", "precio_usd": 1, "tcin": ""}], "t")
    print("ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--prueba"]:
        prueba()
    elif len(sys.argv) == 2 and sys.argv[1] in DESTINOS:
        main(sys.argv[1])
    else:
        sys.exit(__doc__)
