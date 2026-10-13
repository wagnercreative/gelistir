"""Arama filtrelerinin ilanlara uygulanması."""

import re
from datetime import date

_TR_MAP = str.maketrans({
    "İ": "i", "I": "ı",
    "ç": "c", "ğ": "g", "ı": "i", "ö": "o", "ş": "s", "ü": "u",
    "Ç": "c", "Ğ": "g", "Ö": "o", "Ş": "s", "Ü": "u",
})


def norm(text: str | None) -> str:
    """Türkçe karakterlere duyarsız, küçük harfli karşılaştırma metni."""
    return (text or "").translate(_TR_MAP).lower().translate(_TR_MAP).strip()


def _contains_any(haystack: str, needles: list[str]) -> bool:
    h = norm(haystack)
    return any(norm(n) in h for n in needles if n)


def _room_matches(rooms: str | None, wanted: list[str]) -> bool:
    if not wanted or not rooms:
        return True  # oda bilgisi olmayan ilanlar (arsa vb.) bu filtreden etkilenmez
    r = rooms.replace(" ", "")
    if r in wanted:
        return True
    m = re.match(r"(\d+)", r)
    return "5+" in wanted and bool(m) and int(m.group(1)) >= 5


def day_number(date_posted: str | None, today: date | None = None) -> int | None:
    """İlanın yayında kaçıncı gününde olduğu (yayın günü 1. gün sayılır)."""
    if not date_posted:
        return None
    today = today or date.today()
    return (today - date.fromisoformat(date_posted)).days + 1


def matches(item: dict, f: dict) -> bool:
    price = item.get("price")
    area = item.get("area_m2")
    if f.get("min_price") is not None and (price is None or price < f["min_price"]):
        return False
    if f.get("max_price") is not None and (price is None or price > f["max_price"]):
        return False
    if f.get("min_m2") is not None and (area is None or area < f["min_m2"]):
        return False
    if f.get("max_m2") is not None and (area is None or area > f["max_m2"]):
        return False
    if f.get("max_price_per_m2") is not None:
        if not price or not area or price / area > f["max_price_per_m2"]:
            return False
    if not _room_matches(item.get("rooms"), f.get("rooms") or []):
        return False
    loc = item.get("location") or ""
    if f.get("include_locations") and not _contains_any(loc, f["include_locations"]):
        return False
    if f.get("exclude_locations") and _contains_any(loc, f["exclude_locations"]):
        return False
    title = item.get("title") or ""
    if f.get("include_keywords") and not _contains_any(title, f["include_keywords"]):
        return False
    if f.get("exclude_keywords") and _contains_any(title, f["exclude_keywords"]):
        return False
    if f.get("include_tags"):
        tags = [norm(t) for t in item.get("tags") or []]
        if not any(norm(t) in tags for t in f["include_tags"]):
            return False
    if f.get("exclude_floors") and item.get("floor") and _contains_any(item["floor"], f["exclude_floors"]):
        return False
    return True
