"""Emlakjet arama sayfalarını çeker ve sayfadaki schema.org (ld+json) verisinden ilanları çıkarır."""

import asyncio
import json
import logging
import re
from datetime import date
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx

log = logging.getLogger(__name__)

BASE = "https://www.emlakjet.com"
SOURCE = "emlakjet"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
}

_GRAPH_RE = re.compile(
    r'<script[^>]*id="listing-realestate-schema"[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.S
)
_ANY_LD_RE = re.compile(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', re.S)
_ID_RE = re.compile(r"-(\d+)/?$")
_NUM_RE = re.compile(r"[\d.,]+")


class ScrapeError(RuntimeError):
    pass


def search_url(search: dict, page: int = 1) -> str:
    """Arama için sayfa URL'sini üretir. Özel URL verilmişse onu kullanır (filtre parametreleri korunur)."""
    base = search.get("custom_url") or f"{BASE}/{search['category']}/{search['location']}"
    parts = urlsplit(base)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k != "sayfa"]
    if page > 1:
        query.append(("sayfa", str(page)))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ""))


def _parse_area(value: str | None) -> float | None:
    if not value:
        return None
    m = _NUM_RE.search(value)
    if not m:
        return None
    try:
        return float(m.group(0).replace(".", "").replace(",", "."))
    except ValueError:
        return None


def _graph_items(html: str) -> list[dict]:
    m = _GRAPH_RE.search(html)
    blocks = [m.group(1)] if m else _ANY_LD_RE.findall(html)
    items = []
    for block in blocks:
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        graph = data.get("@graph") if isinstance(data, dict) else None
        if isinstance(graph, list):
            items += [g for g in graph if isinstance(g, dict) and g.get("@type") == "RealEstateListing"]
    return items


def parse_listings(html: str) -> list[dict]:
    """Arama sonuç sayfasındaki ilanları sözlük listesi olarak döndürür."""
    result = []
    for g in _graph_items(html):
        url = g.get("url") or ""
        m = _ID_RE.search(url)
        if not m:
            continue
        props: dict[str, str] = {}
        tags: list[str] = []
        for p in g.get("additionalProperty") or []:
            name, value = p.get("name"), p.get("value")
            if not name or value is None:
                continue
            if name == "İlan Etiketi":
                tags.append(str(value))
            else:
                props[name] = str(value)
        offer = g.get("offers") or {}
        price = offer.get("price")
        try:
            price = float(price) if price not in (None, "") else None
        except (TypeError, ValueError):
            price = None
        date_posted = g.get("datePosted")
        try:
            date_posted = date.fromisoformat(str(date_posted)[:10]).isoformat() if date_posted else None
        except ValueError:
            date_posted = None
        result.append({
            "id": f"{SOURCE}-{m.group(1)}",
            "source": SOURCE,
            "url": url,
            "title": (g.get("name") or "").strip(),
            "image": g.get("image") if isinstance(g.get("image"), str) else None,
            "price": price,
            "currency": offer.get("priceCurrency") or "TRY",
            "listing_type": props.get("İlan Tipi"),
            "location": props.get("Konum"),
            "rooms": props.get("Oda Sayısı"),
            "area_m2": _parse_area(props.get("Metrekare")),
            "floor": props.get("Kat"),
            "tags": tags,
            "date_posted": date_posted,
        })
    return result


class Fetcher:
    """Emlakjet sayfalarını sırayla, aralarda bekleyerek çeker."""

    def __init__(self, delay: float = 1.5, client: httpx.AsyncClient | None = None):
        self.delay = delay
        self._client = client
        self._own_client = client is None

    async def __aenter__(self):
        if self._client is None:
            self._client = httpx.AsyncClient(headers=HEADERS, timeout=30, follow_redirects=True)
        return self

    async def __aexit__(self, *exc):
        if self._own_client and self._client is not None:
            await self._client.aclose()

    async def fetch_page(self, url: str) -> tuple[str, str]:
        """(son URL, HTML) döndürür. Geçici hatalarda iki kez daha dener."""
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                r = await self._client.get(url)
                if r.status_code == 404:
                    return str(r.url), ""
                if r.status_code in (403, 429):
                    raise ScrapeError(f"Emlakjet erişimi engelledi (HTTP {r.status_code})")
                r.raise_for_status()
                return str(r.url), r.text
            except (httpx.HTTPError, ScrapeError) as e:
                last_err = e
                await asyncio.sleep(3 * (attempt + 1))
        raise ScrapeError(f"{url} alınamadı: {last_err}")

    async def search(self, search: dict, max_pages: int, stop) -> list[dict]:
        """Arama sayfalarını gezer. `stop(page_items)` True dönerse durur.

        Emlakjet sonuçları ilan tarihine göre yeniden eskiye sıralar; son sayfadan sonrası
        ilk sayfaya yönlendirildiği için tekrar eden ilanlar görülünce de durulur.
        """
        seen: set[str] = set()
        items: list[dict] = []
        for page in range(1, max_pages + 1):
            if page > 1 and self.delay:
                await asyncio.sleep(self.delay)
            url = search_url(search, page)
            final_url, html = await self.fetch_page(url)
            page_items = parse_listings(html) if html else []
            if page == 1 and html and not page_items and "RealEstateListing" not in html:
                log.warning("%s sayfasında ilan verisi bulunamadı", url)
            if page > 1 and "sayfa=" not in final_url:
                break  # sayfa sınırı aşıldı, ilk sayfaya yönlendirildi
            fresh = [i for i in page_items if i["id"] not in seen]
            if not fresh:
                break
            seen.update(i["id"] for i in fresh)
            items += fresh
            if stop(fresh):
                break
        return items
