"""Verifica en el CEP de Banxico las transferencias que capturaron los cajeros (Issue #603, fase 2 de #593).

Corre en la PC de la caja (Windows, Programador de tareas). Solo biblioteca estandar. Banxico exige captcha desde
Cloudflare, pero no desde una IP residencial si no se encadenan consultas: por eso la consulta se hace aqui y el
resultado se reporta a la app. La app decide el estado, avisa al dueno y le deja validar a mano.

Se programa cada MINUTO (Programador de tareas), pero eso es solo preguntarle a la app si hay algo nuevo: una lectura barata
que casi siempre vuelve vacia. A Banxico solo se llama cuando alguien registro una transferencia (la app la ofrece a partir del
minuto de su registro); sin pendientes, cero llamadas a Banxico y el registro no escribe nada.

Cada corrida: pide a la app las transferencias pendientes, hace UNA consulta a Banxico por transferencia (con la fecha
de ABONO que la app indica, no la fecha de operacion SPEI), con pausa entre una y otra, y reporta. Una transferencia que no
aparece se vuelve a ofrecer UNA sola vez, 30 minutos despues y con un dia menos; despues la app la marca para el dueno. Si Banxico
pide imagen de seguridad o dice limite, se detiene SIN reportar y SIN reintentar ni evadir nada: la siguiente corrida lo vuelve a intentar.
Dos corridas no se pisan: un candado (cep.lock junto a la configuracion) hace que la segunda salga sin hacer nada.

La configuracion (URL de la app, service token de Access, CLABE y banco que reciben) vive FUERA del repositorio:
%APPDATA%\\ElDolaron\\cep.json (o la ruta de la variable ELD_CEP_CONFIG). Formato y pasos: docs/CEP-BANXICO.md.

  python -I tools/cep_verificar.py              # una corrida
  python -I tools/cep_verificar.py --catalogo   # revisa los bancos de la app contra el catalogo de Banxico (1 peticion)
  python -I tools/cep_verificar.py --autoprueba # revision local sin red ni configuracion

Salida: 0 corrida completa, 2 error (red, configuracion o respuesta desconocida), 3 captcha o limite de Banxico.
El registro (stdout) no lleva CLABE, nombres ni claves completas.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from decimal import Decimal, InvalidOperation
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # con python -I el directorio del script no entra solo
import cep_probe as sonda  # noqa: E402  (clasifica, Sesion, PAUSA, mask, BASE)

RAIZ = Path(__file__).resolve().parent.parent
PAUSA_MINIMA = 30  # segundos entre transferencias: Banxico pide captcha a consultas encadenadas
MAXIMO_POR_CORRIDA = 10


class ConfigError(Exception):
    pass


def ruta_config() -> Path:
    if os.environ.get("ELD_CEP_CONFIG"):
        return Path(os.environ["ELD_CEP_CONFIG"])
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "ElDolaron" / "cep.json"


def lee_config(ruta: Path) -> dict:
    """Lee y valida la configuracion. Nunca imprime su contenido (trae la CLABE y el secreto del service token)."""
    if RAIZ in ruta.resolve().parents:
        raise ConfigError("la configuracion debe estar FUERA del repositorio (trae la CLABE y el secreto)")
    try:
        c = json.loads(ruta.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ConfigError(f"no se pudo leer {ruta.name}: {type(e).__name__}") from None
    if not isinstance(c, dict):
        raise ConfigError("la configuracion debe ser un objeto JSON")
    c.setdefault("banco_receptor", "90722")
    c.setdefault("pausa_s", 60)
    c.setdefault("max_por_corrida", 5)
    if not str(c.get("url", "")).startswith("https://"):
        raise ConfigError("url debe ser https://...")
    c["url"] = c["url"].rstrip("/")
    if not c.get("client_id") or not c.get("client_secret"):
        raise ConfigError("faltan client_id y client_secret del service token de Access")
    if not re.fullmatch(r"\d{18}", str(c.get("clabe", ""))):
        raise ConfigError("clabe debe tener 18 digitos")
    if not re.fullmatch(r"\d{5}", str(c["banco_receptor"])):
        raise ConfigError("banco_receptor es el codigo Banxico de 5 digitos (Mercado Pago W = 90722)")
    if not isinstance(c["pausa_s"], (int, float)) or c["pausa_s"] < PAUSA_MINIMA:
        raise ConfigError(f"pausa_s no puede ser menor de {PAUSA_MINIMA} segundos")
    if not isinstance(c["max_por_corrida"], int) or not 1 <= c["max_por_corrida"] <= MAXIMO_POR_CORRIDA:
        raise ConfigError(f"max_por_corrida va de 1 a {MAXIMO_POR_CORRIDA}")
    return c


class _SinRedireccion(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):  # Access responde 302 al login si el service token no vale: se ve como error, no como HTML
        return None


class Api:
    """La app de la tienda, con el service token de Access. Solo dos llamadas: pendientes y resultado."""

    def __init__(self, cfg: dict) -> None:
        self.url = cfg["url"]
        self.op = urllib.request.build_opener(_SinRedireccion)
        self.cabeceras = {"CF-Access-Client-Id": cfg["client_id"], "CF-Access-Client-Secret": cfg["client_secret"],
                          "Content-Type": "application/json", "User-Agent": "ElDolaronCep/1.0"}

    def _pide(self, ruta: str, cuerpo: dict | None = None) -> dict:
        datos = None if cuerpo is None else json.dumps(cuerpo).encode()
        peticion = urllib.request.Request(self.url + ruta, data=datos, headers=self.cabeceras)
        try:
            with self.op.open(peticion, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"la app respondio {e.code} en {ruta.split('?')[0]}") from None

    def pendientes(self) -> list[dict]:
        return self._pide("/api/cep/pendientes")["transferencias"]

    def resultado(self, cuerpo: dict) -> dict:
        return self._pide("/api/cep/resultado", cuerpo)


def ddmmyyyy(fecha_iso: str) -> str:
    return dt.date.fromisoformat(fecha_iso).strftime("%d-%m-%Y")


def compara_xml(xml: str, clabe: str) -> tuple[int, bool]:
    """(monto del CEP en centavos enteros, si la cuenta beneficiaria es la de la tienda). La app compara el monto con lo guardado."""
    ben = ET.fromstring(xml).find("Beneficiario")
    if ben is None:
        raise ValueError("XML sin Beneficiario")
    centavos = int((Decimal(ben.attrib["MontoPago"]) * 100).to_integral_value())
    return centavos, ben.attrib.get("Cuenta") == clabe


def verifica(item: dict, cfg: dict, sesion, dormir) -> tuple:
    """UNA consulta a Banxico. ('encontrada', monto_cep, cuenta_ok) | ('no_existe',) | ('omitir', por_que) | ('parar', por_que) | ('error', por_que)."""
    fecha = ddmmyyyy(item["fecha"])
    sesion.pide("/")  # cookies de sesion
    dormir(sonda.PAUSA)
    catalogo = json.loads(sesion.pide("/instituciones.do?" + urllib.parse.urlencode({"fecha": fecha}))[0])
    if catalogo.get("overrideCaptcha") is False:
        return ("parar", "Banxico exigira imagen de seguridad desde este origen")
    codigos = {c for c, _ in catalogo["instituciones"]}
    if item["banco_emisor"] not in codigos or cfg["banco_receptor"] not in codigos:
        return ("omitir", f"el banco {item['banco_emisor']} o el receptor no estan en el catalogo de Banxico de ese dia")
    dormir(sonda.PAUSA)
    cuerpo, _ = sesion.pide("/valida.do", {
        "tipoCriterio": "T", "fecha": fecha, "criterio": item["clave"], "emisor": item["banco_emisor"],
        "receptor": cfg["banco_receptor"], "cuenta": cfg["clabe"], "receptorParticipante": "0",
        "monto": f"{item['monto'] // 100}.{item['monto'] % 100:02d}", "captcha": "c", "tipoConsulta": "1",
    })
    estado = sonda.clasifica(cuerpo.decode("utf-8", "replace"))
    if estado in ("captcha", "limite"):
        return ("parar", f"Banxico respondio {estado}")
    if estado in ("no_existe", "sin_cep"):
        return ("no_existe",)
    if estado != "encontrada":
        return ("error", "respuesta desconocida de Banxico")
    dormir(sonda.PAUSA)
    xml, tipo = sesion.pide("/descarga.do?formato=XML")
    if "xml" not in tipo.lower():
        return ("error", "Banxico no devolvio el XML")
    monto_cep, cuenta_ok = compara_xml(xml.decode("utf-8", "replace"), cfg["clabe"])
    return ("encontrada", monto_cep, cuenta_ok)


def corre(cfg: dict, api, nueva_sesion, dormir=time.sleep, log=print) -> int:
    """Una corrida: 0 completa, 2 error, 3 Banxico pidio captcha o puso limite (se detiene sin reportar esa transferencia)."""
    try:
        pendientes = api.pendientes()
    except (RuntimeError, urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
        log(f"no se pudo pedir las pendientes a la app: {e}")
        return 2
    if not pendientes:
        return 0  # callado: corre cada minuto
    codigo = 0
    for n, item in enumerate(pendientes[: cfg["max_por_corrida"]]):
        if n:
            dormir(cfg["pausa_s"])  # nunca en rafaga
        etiqueta = f"#{item['id']} (clave ...{item['clave'][-4:]}, intento {item['intento']}, fecha {item['fecha']})"
        try:
            r = verifica(item, cfg, nueva_sesion(), dormir)
            if r[0] == "parar":
                log(f"{etiqueta}: {r[1]}. Me detengo; se reintenta en la siguiente corrida.")
                return 3
            if r[0] == "error":
                log(f"{etiqueta}: {r[1]}. Me detengo.")
                return 2
            if r[0] == "omitir":
                log(f"{etiqueta}: omitida, {r[1]}.")
                continue
            reporte = {"id": item["id"], "intento": item["intento"], "estado": r[0]}
            if r[0] == "encontrada":
                reporte.update(monto_cep=r[1], cuenta_ok=r[2])
            log(f"{etiqueta}: {r[0]}" + (f", monto {'coincide' if r[1] == item['monto'] else 'distinto'}, cuenta {'ok' if r[2] else 'distinta'}" if r[0] == "encontrada" else ""))
            log(f"{etiqueta}: la app quedo en {api.resultado(reporte).get('estado')}")
        except (urllib.error.URLError, TimeoutError, RuntimeError, ET.ParseError, InvalidOperation, ValueError, KeyError, json.JSONDecodeError) as e:
            log(f"{etiqueta}: error {type(e).__name__}: {e}. Me detengo.")
            return 2
    return codigo


CANDADO_VENCE = 30 * 60  # una corrida muerta no deja la verificacion atorada


def toma_candado(ruta: Path) -> bool:
    """True si esta corrida puede seguir; False si hay otra en curso (candado de menos de 30 minutos)."""
    try:
        if time.time() - ruta.stat().st_mtime > CANDADO_VENCE:
            ruta.unlink()
    except FileNotFoundError:
        pass
    try:
        os.close(os.open(ruta, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        return True
    except FileExistsError:
        return False


def bancos_de_la_app() -> list[tuple[str, str]]:
    texto = (RAIZ / "app" / "public" / "venta.js").read_text(encoding="utf-8")
    return re.findall(r"\['(\d{5})', '([^']+)'\]", texto)


def catalogo(cfg_receptor: str) -> int:
    """Una peticion al catalogo de Banxico: dice cuales de los bancos de la app (venta.js) no reconoce."""
    s = sonda.Sesion()
    s.pide("/")
    time.sleep(sonda.PAUSA)
    hoy = dt.date.today().strftime("%d-%m-%Y")
    cat = json.loads(s.pide("/instituciones.do?" + urllib.parse.urlencode({"fecha": hoy}))[0])
    codigos = {c for c, _ in cat["instituciones"]}
    print(f"overrideCaptcha: {cat.get('overrideCaptcha')}")
    faltan = [(c, n) for c, n in bancos_de_la_app() if c not in codigos]
    for c, n in bancos_de_la_app():
        print(c, n, "OK" if c in codigos else "NO ESTA EN EL CATALOGO DE BANXICO")
    print(f"receptor {cfg_receptor}:", "OK" if cfg_receptor in codigos else "NO ESTA")
    return 2 if faltan or cfg_receptor not in codigos else 0


def autoprueba() -> int:
    import tempfile

    clabe = "012345678901234567"
    cfg = {"url": "https://tienda.ejemplo", "client_id": "id.access", "client_secret": "secreto", "clabe": clabe,
           "banco_receptor": "90722", "pausa_s": 60, "max_por_corrida": 5}
    # Configuracion: valida, y rechaza lo peligroso.
    with tempfile.TemporaryDirectory() as d:
        ruta = Path(d) / "cep.json"
        ruta.write_text(json.dumps({k: cfg[k] for k in ("url", "client_id", "client_secret", "clabe")}), encoding="utf-8")
        leida = lee_config(ruta)
        assert leida["banco_receptor"] == "90722" and leida["pausa_s"] == 60 and leida["max_por_corrida"] == 5
        for malo in ({"url": "http://x"}, {"clabe": "123"}, {"client_secret": ""}, {"pausa_s": 5}, {"max_por_corrida": 99}, {"banco_receptor": "x"}):
            ruta.write_text(json.dumps({**cfg, **malo}), encoding="utf-8")
            try:
                lee_config(ruta)
            except ConfigError:
                pass
            else:
                raise AssertionError(f"debio rechazar {malo}")
    try:
        lee_config(RAIZ / "tools" / "cep.json")
    except ConfigError as e:
        assert "FUERA" in str(e)
    else:
        raise AssertionError("debio rechazar una configuracion dentro del repositorio")

    # Candado: la segunda corrida sale; uno viejo se reemplaza.
    with tempfile.TemporaryDirectory() as d:
        candado = Path(d) / "cep.lock"
        assert toma_candado(candado) and not toma_candado(candado)
        viejo = time.time() - CANDADO_VENCE - 5
        os.utime(candado, (viejo, viejo))
        assert toma_candado(candado)

    assert ddmmyyyy("2026-10-29") == "29-10-2026"
    xml = ('<SPEI_Tercero><Beneficiario BancoReceptor="B" Cuenta="%s" MontoPago="5000.00"/><Ordenante BancoEmisor="A" Cuenta="999999999999999999"/></SPEI_Tercero>' % clabe)
    assert compara_xml(xml, clabe) == (500000, True)
    assert compara_xml(xml, "999999999999999999") == (500000, False)
    assert compara_xml(xml.replace("5000.00", "5000.10"), clabe)[0] == 500010

    # Corrida completa contra Banxico y app simulados: una consulta por transferencia, pausa entre ellas, parar en captcha.
    class SesionFalsa:
        validas: list[dict] = []

        def __init__(self, cuerpos: dict, override=True) -> None:
            self.cuerpos, self.override = cuerpos, override

        def pide(self, ruta, datos=None):
            if ruta == "/":
                return b"", ""
            if ruta.startswith("/instituciones.do"):
                return json.dumps({"overrideCaptcha": self.override, "instituciones": [["40012", "A"], ["90722", "B"]]}).encode(), ""
            if ruta == "/valida.do":
                SesionFalsa.validas.append(datos)
                return self.cuerpos[datos["criterio"]].encode(), ""
            if ruta.startswith("/descarga.do"):
                return xml.encode(), "text/xml"
            raise AssertionError(ruta)

    class ApiFalsa:
        def __init__(self, items) -> None:
            self.items, self.reportes = items, []

        def pendientes(self):
            return self.items

        def resultado(self, c):
            self.reportes.append(c)
            return {"estado": "ok"}

    def item(i, clave, banco="40012", monto=500000):
        return {"id": i, "clave": clave, "monto": monto, "banco_emisor": banco, "fecha": "2026-10-29", "intento": 1}

    cuerpos = {"CLAVEUNO1111": '<a href="descarga.do?formato=XML">x</a>', "CLAVEDOS2222": "Operación no encontrada",
               "CLAVETRES333": '<input name="varHideCaptcha"/>', "CLAVECUAT444": "Operación no encontrada"}
    pausas: list = []
    logs: list[str] = []
    api = ApiFalsa([item(1, "CLAVEUNO1111"), item(2, "CLAVEDOS2222"), item(3, "CLAVETRES333"), item(4, "CLAVECUAT444")])
    codigo = corre(cfg, api, lambda: SesionFalsa(cuerpos), pausas.append, logs.append)
    assert codigo == 3, codigo
    assert api.reportes == [{"id": 1, "intento": 1, "estado": "encontrada", "monto_cep": 500000, "cuenta_ok": True},
                            {"id": 2, "intento": 1, "estado": "no_existe"}], api.reportes   # el del captcha no se reporta, el 4 ni se consulta
    assert [v["criterio"] for v in SesionFalsa.validas] == ["CLAVEUNO1111", "CLAVEDOS2222", "CLAVETRES333"]   # UNA consulta por transferencia
    assert SesionFalsa.validas[0] == {"tipoCriterio": "T", "fecha": "29-10-2026", "criterio": "CLAVEUNO1111", "emisor": "40012", "receptor": "90722",
                                      "cuenta": clabe, "receptorParticipante": "0", "monto": "5000.00", "captcha": "c", "tipoConsulta": "1"}
    assert pausas.count(60) == 2, pausas   # pausa entre transferencias (3 entre 4, la 4 nunca llega)
    todo = "\n".join(logs)
    assert clabe not in todo and "CLAVEUNO1111" not in todo and "...1111" in todo and "secreto" not in todo, todo

    # Banxico exige imagen de seguridad desde el catalogo: ni una consulta a valida.do.
    SesionFalsa.validas.clear()
    logs.clear()
    assert corre(cfg, ApiFalsa([item(1, "CLAVEUNO1111")]), lambda: SesionFalsa(cuerpos, override=False), lambda s: None, logs.append) == 3
    assert SesionFalsa.validas == []
    # Un banco que Banxico no conoce se omite sin consultar; max_por_corrida acota.
    api = ApiFalsa([item(1, "CLAVEUNO1111", banco="99999"), item(2, "CLAVEDOS2222")])
    assert corre({**cfg, "max_por_corrida": 1}, api, lambda: SesionFalsa(cuerpos), lambda s: None, logs.append) == 0
    assert api.reportes == [] and SesionFalsa.validas == []
    assert corre(cfg, ApiFalsa([]), lambda: SesionFalsa(cuerpos), lambda s: None, logs.append) == 0
    # La app caida o una respuesta desconocida de Banxico: error, sin reportar.
    class ApiCaida(ApiFalsa):
        def pendientes(self):
            raise RuntimeError("la app respondio 503")
    assert corre(cfg, ApiCaida([]), lambda: SesionFalsa(cuerpos), lambda s: None, logs.append) == 2
    api = ApiFalsa([item(1, "CLAVEUNO1111")])
    assert corre(cfg, api, lambda: SesionFalsa({"CLAVEUNO1111": "<html>raro</html>"}), lambda s: None, logs.append) == 2
    assert api.reportes == []
    print("autoprueba ok")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--autoprueba", action="store_true", help="revision local, sin red ni configuracion")
    p.add_argument("--catalogo", action="store_true", help="compara los bancos de la app con el catalogo de Banxico (1 peticion)")
    a = p.parse_args()
    if a.autoprueba:
        return autoprueba()
    try:
        cfg = lee_config(ruta_config())
    except ConfigError as e:
        print(f"configuracion: {e}")
        return 2
    if a.catalogo:
        try:
            return catalogo(cfg["banco_receptor"])
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as e:
            print(f"error: {type(e).__name__}: {e}")
            return 2
    candado = ruta_config().with_name("cep.lock")
    if not toma_candado(candado):
        return 0  # otra corrida sigue en curso
    try:
        return corre(cfg, Api(cfg), sonda.Sesion)
    finally:
        candado.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
