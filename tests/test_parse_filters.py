from datetime import date

from app import config, emlakjet, filters, telegram
from tests.conftest import listing, page_html


def test_parse_listings():
    html = page_html([listing(19975496, "2026-10-13", price=5250000, rooms="3+1", m2=125, tags=("YENİ", "SIFIR BİNA")),
                      listing(42, "2026-10-01", rooms=None, floor=None, kind="Satılık Arsa", m2="1.250")])
    items = emlakjet.parse_listings(html)
    assert len(items) == 2
    a, b = items
    assert a["id"] == "emlakjet-19975496"
    assert a["price"] == 5250000 and a["area_m2"] == 125 and a["rooms"] == "3+1"
    assert a["tags"] == ["YENİ", "SIFIR BİNA"] and a["date_posted"] == "2026-10-13"
    assert a["location"] == "Kasımpaşa Mahallesi, Menemen" and a["floor"] == "2. Kat"
    assert b["rooms"] is None and b["area_m2"] == 1250 and b["listing_type"] == "Satılık Arsa"


def test_parse_empty_page():
    assert emlakjet.parse_listings("<html></html>") == []


def test_search_url():
    s = {"category": "satilik-konut", "location": "izmir-menemen", "custom_url": ""}
    assert emlakjet.search_url(s) == "https://www.emlakjet.com/satilik-konut/izmir-menemen"
    assert emlakjet.search_url(s, 3) == "https://www.emlakjet.com/satilik-konut/izmir-menemen?sayfa=3"
    s["custom_url"] = "https://www.emlakjet.com/satilik-daire/izmir-menemen?min_fiyat=1&sayfa=9"
    assert emlakjet.search_url(s, 2) == "https://www.emlakjet.com/satilik-daire/izmir-menemen?min_fiyat=1&sayfa=2"


def _item(**kw):
    return emlakjet.parse_listings(page_html([listing(1, "2026-10-10", **kw)]))[0]


def f(**kw):
    out = dict(config.DEFAULT_FILTERS)
    out.update(kw)
    return out


def test_filters():
    it = _item(price=3_000_000, m2=120, rooms="3+1", loc="Ulukent Mahallesi, Menemen",
               title="Sahibinden Site İçi Daire", floor="Bodrum Kat")
    assert filters.matches(it, f())
    assert not filters.matches(it, f(min_price=3_500_000))
    assert filters.matches(it, f(max_price=3_000_000))
    assert not filters.matches(it, f(max_m2=100))
    assert filters.matches(it, f(max_price_per_m2=25_000))
    assert not filters.matches(it, f(max_price_per_m2=24_000))
    assert filters.matches(it, f(rooms=["2+1", "3+1"]))
    assert not filters.matches(it, f(rooms=["2+1"]))
    assert filters.matches(it, f(include_locations=["ulukent"]))
    assert not filters.matches(it, f(exclude_locations=["ULUKENT"]))
    assert filters.matches(it, f(include_keywords=["site ici"]))  # Türkçe karakter duyarsız
    assert not filters.matches(it, f(exclude_keywords=["SAHİBİNDEN"]))
    assert not filters.matches(it, f(exclude_floors=["bodrum"]))
    assert filters.matches(it, f(include_tags=["yeni"]))
    assert not filters.matches(it, f(include_tags=["SIFIR BİNA"]))


def test_room_filter_five_plus_and_missing():
    assert filters.matches(_item(rooms="6+2"), f(rooms=["5+"]))
    assert filters.matches(_item(rooms=None), f(rooms=["2+1"]))


def test_day_number():
    assert filters.day_number("2026-10-13", date(2026, 10, 13)) == 1
    assert filters.day_number("2026-09-14", date(2026, 10, 13)) == 30


def test_config_validation():
    cfg = config.validate({"telegram_chat_ids": " 1, 2 ,", "daily_report_time": "08:30",
                           "searches": [{"name": "x", "category": "satilik-arsa", "location": "izmir-menemen",
                                         "filters": {"min_price": "1000", "rooms": ["3+1", "bogus"],
                                                     "exclude_keywords": "hisseli, devren"}}]})
    assert cfg["telegram_chat_ids"] == "1,2"
    s = cfg["searches"][0]
    assert s["filters"]["min_price"] == 1000 and s["filters"]["rooms"] == ["3+1"]
    assert s["filters"]["exclude_keywords"] == ["hisseli", "devren"]
    for bad in ({"daily_report_time": "25:00"}, {"scan_interval_minutes": 1},
                {"searches": [{"name": "y", "custom_url": "https://evil.example/"}]}):
        try:
            config.validate(bad)
        except config.ConfigError:
            continue
        raise AssertionError(bad)


def test_expiring_messages_are_chunked():
    items = [{"title": f"İlan {n} " + "x" * 150, "url": f"https://www.emlakjet.com/ilan/{n}", "price": 1e6,
              "currency": "TRY", "location": "Menemen", "date_posted": "2026-09-14", "day": 30} for n in range(60)]
    msgs = telegram.expiring_messages(items, 30, "13.10.2026")
    assert len(msgs) > 1 and all(len(m) <= telegram.MAX_TEXT for m in msgs)
    assert sum(m.count("🔗") for m in msgs) == 60
    assert "ilan yok" in telegram.expiring_messages([], 30, "13.10.2026")[0]
