"""Sonda manual del CEP de Banxico (Issue #593). Solo biblioteca estandar; nadie la importa.

Hace UNA consulta a https://www.banxico.org.mx/cep/ como la hace su propia pagina y imprime un resumen
sin datos sensibles (cuentas con solo los ultimos 4 digitos, sin nombres). Una consulta, sin reintentos,
con pausa entre peticiones. Si Banxico pide la imagen de seguridad (captcha) o dice que se excedio el limite,
se detiene y lo reporta: esta herramienta no resuelve ni evade ningun captcha.

Ejemplos (los datos reales se pasan por argumentos, no se guardan en ningun archivo):
  python tools/cep_probe.py --catalogo
  python tools/cep_probe.py --fecha 2026-10-28 --clave ABC123 --emisor 40012 --receptor 40072 \
      --cuenta 012345678901234567 --monto 150.00
  python tools/cep_probe.py --autoprueba

Salida: 0 encontrada, 1 no existe o aun sin CEP, 2 error de red o respuesta desconocida, 3 captcha o limite.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import http.cookiejar
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation

BASE = "https://www.banxico.org.mx/cep"
UA = "Mozilla/5.0 (compatible; ElDolaronProbe/0.1; manual, 1 consulta)"
PAUSA = 3  # segundos entre peticiones; ponytail: fija, nunca en bucle


def mask(cuenta: str) -> str:
    return "*" * max(0, len(cuenta) - 4) + cuenta[-4:]


def clasifica(cuerpo: str) -> str:
    """Devuelve: captcha | limite | no_existe | sin_cep | encontrada | desconocida."""
    t = html.unescape(cuerpo)
    if "varHideCaptcha" in cuerpo or "imagen de seguridad" in t.lower():
        return "captcha"
    if "excedido el número máximo de consultas" in t:
        return "limite"
    if "descarga.do?formato=" in cuerpo:
        return "encontrada"
    if "Con la información proporcionada se identificó" in t and "<table" in cuerpo:
        return "sin_cep"
    if "Operación no encontrada" in t or "No se encontró ningún pago" in t:
        return "no_existe"
    return "desconocida"


def resume_xml(xml: str, monto_centavos: int | None) -> dict:
    """Campos utiles del CEP sin nombres ni cuentas completas. El monto se compara en centavos enteros."""
    raiz = ET.fromstring(xml)
    ben, ord_ = raiz.find("Beneficiario"), raiz.find("Ordenante")
    if ben is None or ord_ is None:
        raise ValueError("XML sin Beneficiario/Ordenante")
    pago = (Decimal(ben.attrib["MontoPago"]) * 100).to_integral_value()
    cadena = raiz.attrib.get("cadenaCDA", "").split("|")
    return {
        "fecha_operacion": raiz.attrib.get("FechaOperacion"),
        "hora": raiz.attrib.get("Hora"),
        "abono_ddmmyyyy_hhmmss": f"{cadena[4]} {cadena[5]}" if len(cadena) > 5 else None,
        "institucion_firmante": raiz.attrib.get("ClaveSPEI"),  # quien firma el CDA: la institucion receptora, no la emisora
        "banco_emisor": ord_.attrib.get("BancoEmisor"),
        "banco_receptor": ben.attrib.get("BancoReceptor"),
        "cuenta_ordenante": mask(ord_.attrib.get("Cuenta", "")),
        "cuenta_beneficiaria": mask(ben.attrib.get("Cuenta", "")),
        "monto_centavos": int(pago),
        "monto_coincide": None if monto_centavos is None else int(pago) == monto_centavos,
        "sello_presente": bool(raiz.attrib.get("sello")),
        "certificado": raiz.attrib.get("numeroCertificado"),
    }


class Sesion:
    def __init__(self) -> None:
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.op.addheaders = [("User-Agent", UA), ("X-Requested-With", "XMLHttpRequest"), ("Referer", BASE + "/")]

    def pide(self, ruta: str, datos: dict | None = None) -> tuple[bytes, str]:
        cuerpo = urllib.parse.urlencode(datos).encode() if datos is not None else None
        with self.op.open(urllib.request.Request(BASE + ruta, data=cuerpo), timeout=60) as r:
            return r.read(), r.headers.get("Content-Type", "")


def autoprueba() -> int:
    assert clasifica("<strong>Operación no encontrada. El SPEI no ha recibido</strong>") == "no_existe"
    assert clasifica('<input name="varHideCaptcha" value="false"/>') == "captcha"
    assert clasifica("<h1>ha excedido el n&uacute;mero m&aacute;ximo de consultas en este portal</h1>") == "limite"
    assert clasifica('<a href="descarga.do?formato=XML">XML</a>') == "encontrada"
    assert clasifica("<strong>Con la informaci&oacute;n proporcionada se identific&oacute; el siguiente pago</strong><table>") == "sin_cep"
    assert clasifica("<html>otra cosa</html>") == "desconocida"
    assert mask("012345678901234567") == "*" * 14 + "4567"
    xml = ('<SPEI_Tercero FechaOperacion="2026-01-02" Hora="10:00:00" ClaveSPEI="40012" sello="abc" numeroCertificado="1" '
           'cadenaCDA="||1|02012026|02012026|100001|40012|X"><Beneficiario BancoReceptor="B" Cuenta="012345678901234567" '
           'MontoPago="150.10"/><Ordenante BancoEmisor="A" Cuenta="999999999999999999"/></SPEI_Tercero>')
    r = resume_xml(xml, 15010)
    assert r["monto_centavos"] == 15010 and r["monto_coincide"] is True and r["cuenta_beneficiaria"].endswith("4567")
    assert r["abono_ddmmyyyy_hhmmss"] == "02012026 100001"
    print("autoprueba ok")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--autoprueba", action="store_true", help="verifica el analisis local, sin red")
    p.add_argument("--catalogo", action="store_true", help="solo imprime el catalogo de bancos de --fecha")
    p.add_argument("--fecha", default=dt.date.today().isoformat(), help="AAAA-MM-DD de la operacion (default hoy)")
    p.add_argument("--tipo", choices=["T", "R"], default="T", help="T clave de rastreo, R numero de referencia")
    p.add_argument("--clave", help="clave de rastreo o referencia")
    p.add_argument("--emisor", help="codigo Banxico del banco que envio (ver --catalogo), ej. 40012")
    p.add_argument("--receptor", help="codigo Banxico del banco que recibio, ej. 40072")
    p.add_argument("--cuenta", help="CLABE (18 digitos) de la cuenta beneficiaria")
    p.add_argument("--monto", help="monto en pesos, ej. 150.00")
    p.add_argument("--descargar", action="store_true", help="si existe, baja el XML y lo resume")
    a = p.parse_args()
    if a.autoprueba:
        return autoprueba()
    try:
        fecha = dt.date.fromisoformat(a.fecha)
    except ValueError:
        return print("--fecha debe ser AAAA-MM-DD") or 2
    ddmmyyyy = fecha.strftime("%d-%m-%Y")
    s = Sesion()
    try:
        s.pide("/")  # cookies de sesion
        time.sleep(PAUSA)
        cuerpo, _ = s.pide("/instituciones.do?" + urllib.parse.urlencode({"fecha": ddmmyyyy}))
        cat = json.loads(cuerpo)
        # overrideCaptcha: bandera que Banxico manda en el catalogo. true = esta IP no tiene que teclear la imagen;
        # false = la consulta exigira captcha. Si es false no se intenta valida.do.
        print(f"overrideCaptcha: {cat.get('overrideCaptcha')}")
        if a.catalogo:
            for codigo, nombre in cat["instituciones"]:
                print(codigo, nombre)
            return 0 if cat.get("overrideCaptcha") else 3
        if cat.get("overrideCaptcha") is False:
            print("Banxico exigira imagen de seguridad desde este origen. No se consulta ni se evade.")
            return 3
        time.sleep(PAUSA)
        if not all([a.clave, a.emisor, a.receptor, a.cuenta, a.monto]):
            return print("Faltan --clave --emisor --receptor --cuenta --monto") or 2
        if not re.fullmatch(r"\d{18}", a.cuenta) or not re.fullmatch(r"\d+(\.\d{1,2})?", a.monto):
            return print("--cuenta son 18 digitos y --monto pesos con hasta 2 decimales") or 2
        centavos = int((Decimal(a.monto) * 100).to_integral_value())
        cuerpo, _ = s.pide("/valida.do", {
            "tipoCriterio": a.tipo, "fecha": ddmmyyyy, "criterio": a.clave, "emisor": a.emisor, "receptor": a.receptor,
            "cuenta": a.cuenta, "receptorParticipante": "0", "monto": a.monto,
            # El campo ya viene relleno con "c" en la propia pagina cuando no se pide imagen; si Banxico la pide, abajo nos detenemos.
            "captcha": "c", "tipoConsulta": "1",
        })
        estado = clasifica(cuerpo.decode("utf-8", "replace"))
        print(f"estado: {estado}  (cuenta {mask(a.cuenta)}, monto {centavos} centavos, fecha {ddmmyyyy})")
        if estado in ("captcha", "limite"):
            print("Banxico pide imagen de seguridad o limito la sesion. No se reintenta ni se evade.")
            return 3
        if estado == "encontrada" and a.descargar:
            time.sleep(PAUSA)
            xml, tipo = s.pide("/descarga.do?formato=XML")
            if "xml" not in tipo.lower():
                print("descarga: Banxico no devolvio XML")
                return 2
            print(json.dumps(resume_xml(xml.decode("utf-8", "replace"), centavos), indent=2, ensure_ascii=False))
        return {"encontrada": 0, "no_existe": 1, "sin_cep": 1}.get(estado, 2)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, ET.ParseError, InvalidOperation, ValueError) as e:
        print(f"error: {type(e).__name__}: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
