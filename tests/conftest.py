import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db(tmp_path):
    db.connect(str(tmp_path / "test.db"))
    yield


def listing(n, date_posted, price=3_000_000, rooms="3+1", m2=120, loc="Kasımpaşa Mahallesi, Menemen",
            title=None, floor="2. Kat", tags=("YENİ",), kind="Satılık Konut"):
    props = [{"@type": "PropertyValue", "name": "İlan Tipi", "value": kind},
             {"@type": "PropertyValue", "name": "Konum", "value": loc},
             {"@type": "PropertyValue", "name": "Metrekare", "value": f"{m2} m²"}]
    if rooms:
        props.append({"@type": "PropertyValue", "name": "Oda Sayısı", "value": rooms})
    if floor:
        props.append({"@type": "PropertyValue", "name": "Kat", "value": floor})
    props += [{"@type": "PropertyValue", "name": "İlan Etiketi", "value": t} for t in tags]
    url = f"https://www.emlakjet.com/ilan/menemen-ilan-{n}"
    return {"@type": "RealEstateListing", "name": title or f"Menemen ilan {n}", "url": url,
            "image": f"https://imaj.emlakjet.com/{n}.jpg", "datePosted": date_posted,
            "offers": {"@type": "Offer", "url": url, "price": price, "priceCurrency": "TRY"},
            "additionalProperty": props}


def page_html(items):
    graph = json.dumps({"@context": "https://schema.org", "@graph": items}, ensure_ascii=False)
    return ('<html><head><script id="listing-breadcrumb-schema" type="application/ld+json">{}</script>'
            f'<script id="listing-realestate-schema" type="application/ld+json">{graph}</script></head></html>')
