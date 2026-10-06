"""Check the public storefront's content and references with the standard library."""

from html.parser import HTMLParser
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

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "html":
            self.language = attrs.get("lang")
        if tag == "h1":
            self.h1_count += 1
        if "id" in attrs:
            self.ids.add(attrs["id"])
        for name in ("src", "href"):
            if attrs.get(name):
                self.references.append(attrs[name])

    def handle_data(self, data):
        self.text.append(data)


def main():
    page = Page()
    page.feed((PUBLIC / "index.html").read_text(encoding="utf-8"))
    errors = []
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
        if not urlsplit(reference).scheme and not (PUBLIC / reference).is_file():
            errors.append(f"Missing CSS reference: {reference}")
    if errors:
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("Validated public storefront: Spanish content, local references and main links")
    return 0


if __name__ == "__main__":
    sys.exit(main())
