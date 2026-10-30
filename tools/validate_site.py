"""Check the public storefront's content and references with the standard library."""

from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qs, unquote, urlsplit


PUBLIC = Path(__file__).resolve().parents[1] / "site" / "public"
ADDRESS = "Jardín Hidalgo 129, Zona Centro, Soledad de Graciano Sánchez, San Luis Potosí, 78430"
EXPECTED_LINKS = {
    "https://wa.me/524445437754",
    "https://eldolaron.com/ropa",
    "https://eldolaron.com/general",
    "https://dolarones.eldolaron.com/",
    "https://www.facebook.com/eldolaronmx/about",
    "https://www.instagram.com/el_dolaron/",
}


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []
        self.ids = set()
        self.h1_count = 0
        self.language = None
        self.text = []
        self.in_script = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.language = attrs.get("lang")
        self.in_script = tag == "script"
        self.in_script = tag == "script"
        if tag == "h1":
            self.h1_count += 1
        if "id" in attrs:
            self.ids.add(attrs["id"])
        for name in ("src", "href"):
            if attrs.get(name):
                self.references.append(attrs[name])

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False

    def handle_data(self, data):
        if not self.in_script:
            self.text.append(data)


def check_json_ld(html, visible, errors):
    """The Store data must parse and agree with what the page shows."""
    blocks = re.findall(r'<script type="application/ld[+]json">(.*?)</script>', html, re.S)
    if len(blocks) != 1:
        errors.append("Expected exactly one JSON-LD block")
        return
    try:
        data = json.loads(blocks[0])
    except ValueError as error:
        errors.append(f"Invalid JSON-LD: {error}")
        return
    address = data.get("address", {})
    for key in ("streetAddress", "addressLocality", "postalCode"):
        # The visible address splits the street over <h3> and <address>; compare by pieces.
        for piece in address.get(key, "").split(", "):
            if piece not in visible:
                errors.append(f"JSON-LD {key} not in visible text: {piece}")
    hours = data.get("openingHoursSpecification", [{}])[0]
    if (hours.get("opens"), hours.get("closes"), len(hours.get("dayOfWeek", []))) != ("11:00", "20:00", 7):
        errors.append("JSON-LD hours must be 11:00-20:00 every day")
    if "11:00 a. m." not in visible or "8:00 p. m." not in visible:
        errors.append("Visible hours do not match JSON-LD")
    if data.get("telephone") != "+524445437754" or "444 543 7754" not in visible:
        errors.append("JSON-LD telephone does not match the WhatsApp number")
    if data.get("paymentAccepted") not in visible:
        errors.append("JSON-LD paymentAccepted not in visible text")


def check_saldo_page(errors):
    html = (PUBLIC / "que-es-un-saldo.html").read_text(encoding="utf-8")
    page = Page()
    page.feed(html)
    if page.language not in {"es", "es-MX"} or page.h1_count != 1:
        errors.append("que-es-un-saldo: expected Spanish lang and exactly one h1")
    if 'href="https://eldolaron.com/que-es-un-saldo"' not in html:
        errors.append("que-es-un-saldo: wrong canonical")
    for reference in page.references:
        url = urlsplit(reference)
        if not url.scheme and url.path.lstrip("/") and not (PUBLIC / unquote(url.path.lstrip("/"))).is_file():
            errors.append(f"que-es-un-saldo: missing local reference {reference}")
    if "que-es-un-saldo.html" not in (PUBLIC / "index.html").read_text(encoding="utf-8"):
        errors.append("index.html does not link que-es-un-saldo.html")
    if "https://eldolaron.com/que-es-un-saldo" not in (PUBLIC / "sitemap.xml").read_text(encoding="utf-8"):
        errors.append("sitemap.xml is missing que-es-un-saldo")


def main():
    page = Page()
    page.feed((PUBLIC / "index.html").read_text(encoding="utf-8"))
    errors = []
    check_json_ld((PUBLIC / "index.html").read_text(encoding="utf-8"), "".join(page.text), errors)
    check_saldo_page(errors)
    if page.language not in {"es", "es-MX"} or page.h1_count != 1:
        errors.append("Expected Spanish lang and exactly one h1")
    if re.search(r"\[[^\]]+\]", "".join(page.text)):
        errors.append("Unfilled bracket placeholder in page text")
    for reference in page.references:
        url = urlsplit(reference)
        if not url.scheme and not url.netloc:
            path = (PUBLIC / unquote(url.path)).resolve()
            if not path.is_relative_to(PUBLIC.resolve()):
                errors.append(f"Reference escapes public directory: {reference}")
            elif url.path and not path.is_file():
                errors.append(f"Missing local reference: {reference}")
            if url.fragment and url.fragment not in page.ids:
                errors.append(f"Missing fragment: {reference}")
    for link in EXPECTED_LINKS - set(page.references):
        errors.append(f"Missing expected link: {link}")
    maps = [urlsplit(link) for link in page.references if link.startswith("https://www.google.com/maps/dir/")]
    if not maps or any(parse_qs(url.query).get("destination") != [ADDRESS] for url in maps):
        errors.append("Missing or incorrect Google Maps destination")
    html = (PUBLIC / "index.html").read_text(encoding="utf-8")
    image = re.search(r'property="og:image" content="https://eldolaron.com/([^"]+)"', html)
    if not image or not (PUBLIC / image.group(1)).is_file():
        errors.append("Missing or unpublished og:image")
    css = (PUBLIC / "styles.css").read_text(encoding="utf-8")
    for reference in re.findall(r"url\(['\"]?([^)'\"]+)", css):
        # url(#id) apunta a un filtro SVG del propio HTML, no a un archivo.
        if not urlsplit(reference).scheme and not reference.startswith("#") and not (PUBLIC / reference).is_file():
            errors.append(f"Missing CSS reference: {reference}")
    if errors:
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("Validated public storefront: Spanish content, local references and main links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
