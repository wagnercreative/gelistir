"""Panelden düzenlenen ayarlar: varsayılanlar, doğrulama ve okuma/yazma."""

import copy
import re
import uuid

from . import db

# Emlakjet kategori yolları (URL'deki ilk parça). Panelde açılır listede gösterilir.
CATEGORIES = {
    "satilik-konut": "Satılık Konut (tümü)",
    "satilik-daire": "Satılık Daire",
    "satilik-mustakil-ev": "Satılık Müstakil Ev",
    "satilik-villa": "Satılık Villa",
    "satilik-arsa": "Satılık Arsa",
    "satilik-tarla": "Satılık Tarla",
    "satilik-is-yeri": "Satılık İş Yeri",
    "satilik-bina": "Satılık Bina",
    "kiralik-konut": "Kiralık Konut (tümü)",
    "kiralik-daire": "Kiralık Daire",
    "kiralik-arsa": "Kiralık Arsa",
    "kiralik-is-yeri": "Kiralık İş Yeri",
}

ROOM_OPTIONS = ["1+0", "1+1", "2+1", "3+1", "4+1", "5+"]

DEFAULT_FILTERS = {
    "min_price": None,
    "max_price": None,
    "min_m2": None,
    "max_m2": None,
    "max_price_per_m2": None,
    "rooms": [],               # boşsa tümü
    "include_locations": [],   # mahalle adı parçaları, boşsa tümü
    "exclude_locations": [],
    "include_keywords": [],    # başlıkta en az biri geçmeli
    "exclude_keywords": [],    # başlıkta hiçbiri geçmemeli
    "include_tags": [],        # ilan etiketlerinden en az biri (ör. SIFIR BİNA)
    "exclude_floors": [],      # ör. Bodrum, Kot
    "max_new_age_days": 7,     # yeni ilan bildirimi için ilanın en fazla kaç günlük olabileceği
}


def _search(name: str, category: str) -> dict:
    return {
        "id": category,
        "name": name,
        "enabled": True,
        "category": category,
        "location": "izmir-menemen",
        "custom_url": "",
        "filters": copy.deepcopy(DEFAULT_FILTERS),
    }


DEFAULT_SETTINGS = {
    "telegram_token": "",
    "telegram_chat_ids": "",          # virgülle ayrılmış birden fazla sohbet olabilir
    "send_photo": True,
    "scanning_enabled": True,
    "scan_interval_minutes": 30,
    "max_pages": 10,
    "request_delay_seconds": 1.5,
    "notify_on_first_scan": False,
    "daily_report_enabled": True,
    "daily_report_time": "09:00",
    "reminder_day": 30,
    "send_empty_daily_report": True,
    "daily_report_apply_filters": True,
    "searches": [
        _search("Satılık Konut", "satilik-konut"),
        _search("Kiralık Konut", "kiralik-konut"),
        _search("Satılık Arsa", "satilik-arsa"),
        _search("Satılık Tarla", "satilik-tarla"),
        _search("Satılık İş Yeri", "satilik-is-yeri"),
        _search("Kiralık İş Yeri", "kiralik-is-yeri"),
    ],
}


def load() -> dict:
    stored = db.get_setting("config", {}) or {}
    merged = copy.deepcopy(DEFAULT_SETTINGS)
    merged.update(stored)
    for s in merged["searches"]:
        f = copy.deepcopy(DEFAULT_FILTERS)
        f.update(s.get("filters") or {})
        s["filters"] = f
    return merged


class ConfigError(ValueError):
    pass


def _num(v, field, minimum=None, integer=False):
    if v in (None, ""):
        return None
    try:
        n = int(v) if integer else float(v)
    except (TypeError, ValueError):
        raise ConfigError(f"'{field}' sayı olmalı")
    if minimum is not None and n < minimum:
        raise ConfigError(f"'{field}' en az {minimum} olmalı")
    return n


def _str_list(v) -> list[str]:
    if isinstance(v, str):
        v = v.split(",")
    return [s.strip() for s in (v or []) if s and s.strip()]


def validate(data: dict) -> dict:
    cfg = copy.deepcopy(DEFAULT_SETTINGS)
    cfg.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})

    cfg["telegram_token"] = (cfg["telegram_token"] or "").strip()
    cfg["telegram_chat_ids"] = ",".join(_str_list(cfg["telegram_chat_ids"]))
    for key in ("send_photo", "scanning_enabled", "notify_on_first_scan",
                "daily_report_enabled", "send_empty_daily_report", "daily_report_apply_filters"):
        cfg[key] = bool(cfg[key])
    cfg["scan_interval_minutes"] = _num(cfg["scan_interval_minutes"], "Tarama aralığı", 5, True) or 30
    cfg["max_pages"] = _num(cfg["max_pages"], "En fazla sayfa", 1, True) or 10
    cfg["request_delay_seconds"] = _num(cfg["request_delay_seconds"], "İstek arası bekleme", 0) or 0
    cfg["reminder_day"] = _num(cfg["reminder_day"], "Hatırlatma günü", 1, True) or 30
    if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(cfg["daily_report_time"]).strip()):
        raise ConfigError("Günlük rapor saati SS:DD biçiminde olmalı (ör. 09:00)")
    cfg["daily_report_time"] = str(cfg["daily_report_time"]).strip()

    searches = []
    seen_ids = set()
    for s in cfg.get("searches") or []:
        sid = str(s.get("id") or "").strip() or uuid.uuid4().hex[:8]
        if sid in seen_ids:
            sid = uuid.uuid4().hex[:8]
        seen_ids.add(sid)
        custom_url = (s.get("custom_url") or "").strip()
        if custom_url and not re.match(r"^https://(www\.)?emlakjet\.com/", custom_url):
            raise ConfigError("Özel URL https://www.emlakjet.com/ ile başlamalı")
        category = (s.get("category") or "").strip()
        location = (s.get("location") or "").strip().strip("/")
        if not custom_url and not (category and location):
            raise ConfigError(f"'{s.get('name') or sid}' araması için kategori ve konum ya da özel URL gerekli")
        f = s.get("filters") or {}
        filters = {
            "min_price": _num(f.get("min_price"), "En düşük fiyat", 0),
            "max_price": _num(f.get("max_price"), "En yüksek fiyat", 0),
            "min_m2": _num(f.get("min_m2"), "En küçük m²", 0),
            "max_m2": _num(f.get("max_m2"), "En büyük m²", 0),
            "max_price_per_m2": _num(f.get("max_price_per_m2"), "En yüksek m² fiyatı", 0),
            "rooms": [r for r in _str_list(f.get("rooms")) if r in ROOM_OPTIONS],
            "include_locations": _str_list(f.get("include_locations")),
            "exclude_locations": _str_list(f.get("exclude_locations")),
            "include_keywords": _str_list(f.get("include_keywords")),
            "exclude_keywords": _str_list(f.get("exclude_keywords")),
            "include_tags": _str_list(f.get("include_tags")),
            "exclude_floors": _str_list(f.get("exclude_floors")),
            "max_new_age_days": _num(f.get("max_new_age_days"), "Yeni ilan en fazla yaş", 0, True),
        }
        searches.append({
            "id": sid,
            "name": (s.get("name") or "").strip() or CATEGORIES.get(category, sid),
            "enabled": bool(s.get("enabled", True)),
            "category": category,
            "location": location,
            "custom_url": custom_url,
            "filters": filters,
        })
    cfg["searches"] = searches
    return cfg


def save(data: dict) -> dict:
    cfg = validate(data)
    old_ids = {s["id"] for s in load()["searches"]}
    db.set_setting("config", cfg)
    # Yeni eklenen aramalar ilk taramada sessizce "tohumlanır"; eski durumu temizle.
    for s in cfg["searches"]:
        if s["id"] not in old_ids:
            db.reset_search_state(s["id"])
    return cfg


def chat_ids(cfg: dict) -> list[str]:
    return _str_list(cfg.get("telegram_chat_ids"))
