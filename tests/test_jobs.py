import asyncio
from datetime import date, timedelta

import pytest

from app import config, db, jobs
from app.emlakjet import Fetcher
from tests.conftest import listing, page_html

TODAY = date(2026, 10, 13)


class FakeClient:
    """Emlakjet'i taklit eder: sayfa numarasına göre HTML döndürür; son sayfadan sonra 1. sayfaya yönlendirir."""

    def __init__(self, pages):
        self.pages = pages  # {kategori: [sayfa1_items, sayfa2_items, ...]}
        self.requests = []

    async def get(self, url):
        import httpx
        self.requests.append(url)
        path, _, query = url.partition("?")
        cat = path.split("/")[3]
        page = int(query.split("sayfa=")[1]) if "sayfa=" in query else 1
        pages = self.pages.get(cat, [[]])
        if page > len(pages):
            page, url = 1, path
        return httpx.Response(200, text=page_html(pages[page - 1]), request=httpx.Request("GET", url))

    async def aclose(self):
        pass


class FakeTelegram:
    def __init__(self):
        self.sent = []

    async def send_listing(self, chat, text, image, with_photo):
        self.sent.append(("listing", chat, text))

    async def send_text(self, chat, text):
        self.sent.append(("text", chat, text))

    async def close(self):
        pass


@pytest.fixture
def env(monkeypatch):
    client = FakeClient({})
    tg = FakeTelegram()
    monkeypatch.setattr(jobs, "fetcher_factory", lambda cfg: Fetcher(delay=0, client=client))
    monkeypatch.setattr(jobs, "telegram_factory", lambda cfg: tg)
    monkeypatch.setattr(db, "today", lambda: TODAY)
    base = config.load()
    base.update(telegram_token="t", telegram_chat_ids="111")
    base["searches"] = [s for s in base["searches"] if s["id"] in ("satilik-konut", "satilik-arsa")]
    config.save(base)
    return client, tg


def d(days_ago):
    return (TODAY - timedelta(days=days_ago)).isoformat()


def run(coro):
    return asyncio.run(coro)


def test_first_scan_seeds_silently_then_notifies_new(env):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(i, d(i)) for i in range(1, 4)]]
    r = run(jobs.run_scan())
    assert r["new"] == 3 and r["sent"] == 0 and tg.sent == []

    client.pages["satilik-konut"] = [[listing(100, d(0), title="Yepyeni daire")] + [listing(i, d(i)) for i in range(1, 4)]]
    r = run(jobs.run_scan())
    assert r["new"] == 1 and r["sent"] == 1
    assert "Yepyeni daire" in tg.sent[0][2] and "emlakjet.com/ilan/menemen-ilan-100" in tg.sent[0][2]
    assert db.get_listing("emlakjet-100")["notified_new"] == 1

    r = run(jobs.run_scan())
    assert r["new"] == 0 and len(tg.sent) == 1


def test_filters_and_age_limit_applied_to_new(env):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(1, d(1))]]
    run(jobs.run_scan())
    cfg = config.load()
    cfg["searches"][0]["filters"].update(max_price=2_000_000, max_new_age_days=5)
    config.save(cfg)
    client.pages["satilik-konut"] = [[listing(2, d(0), price=1_500_000), listing(3, d(0), price=2_500_000),
                                      listing(4, d(20), price=1_000_000), listing(1, d(1))]]
    r = run(jobs.run_scan())
    assert r["new"] == 3 and r["sent"] == 1
    assert "menemen-ilan-2" in tg.sent[0][2]


def test_quick_scan_stops_on_known_page_and_deep_scan_goes_further(env):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(i, d(i // 3)) for i in range(p * 30, p * 30 + 30)] for p in range(4)]
    run(jobs.run_scan())  # ilk tarama tüm sayfaları gezer
    first = len(client.requests)
    client.requests.clear()
    run(jobs.run_scan())
    konut_reqs = [u for u in client.requests if "satilik-konut" in u]
    assert len(konut_reqs) == 1, konut_reqs  # 1. sayfa tamamen biliniyor -> dur
    client.requests.clear()
    run(jobs.run_scan(deep=True))
    assert len([u for u in client.requests if "satilik-konut" in u]) == 4
    assert first >= 4


def test_scan_stops_at_cutoff_date(env):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(p * 10 + i, d(p * 20 + i)) for i in range(10)] for p in range(5)]
    run(jobs.run_scan(deep=True))
    konut_reqs = [u for u in client.requests if "satilik-konut" in u]
    assert len(konut_reqs) == 3  # 3. sayfada (40+ gün) 33 günden eski ilan görüldü, 4-5 istenmedi


def test_daily_report_sends_day_30_once(env):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(1, d(29), title="Otuzuncu gün"), listing(2, d(28)), listing(3, d(10))]]
    client.pages["satilik-arsa"] = [[listing(9, d(29), title="Arsa otuz", rooms=None, kind="Satılık Arsa")]]
    r = run(jobs.run_daily_report())
    assert r["count"] == 2 and r["sent"] == 2
    texts = [t for kind, _, t in tg.sent if kind == "text"]
    assert len(texts) == 1 and "Otuzuncu gün" in texts[0] and "Arsa otuz" in texts[0]
    assert "30. gününe giren" in texts[0]

    tg.sent.clear()
    r = run(jobs.run_daily_report())
    assert r["count"] == 0
    assert "ilan yok" in tg.sent[0][2]


def test_daily_report_skips_removed_listings(env, monkeypatch):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(1, d(29))]]
    run(jobs.run_scan())
    with db.conn() as c:
        c.execute("UPDATE listings SET last_seen='2026-10-01T10:00:00'")
    client.pages["satilik-konut"] = [[]]
    cfg = config.load()
    assert jobs.expiring_candidates(cfg, TODAY) == []


def test_daily_report_respects_filters_toggle(env):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(1, d(29), price=9_000_000)]]
    cfg = config.load()
    cfg["searches"][0]["filters"]["max_price"] = 5_000_000
    config.save(cfg)
    run(jobs.run_scan())
    assert jobs.expiring_candidates(config.load(), TODAY) == []
    cfg = config.load()
    cfg["daily_report_apply_filters"] = False
    config.save(cfg)
    assert len(jobs.expiring_candidates(config.load(), TODAY)) == 1


def test_original_post_date_kept_when_listing_redated(env):
    client, tg = env
    client.pages["satilik-konut"] = [[listing(1, d(10))]]
    run(jobs.run_scan())
    client.pages["satilik-konut"] = [[listing(1, d(0))]]
    run(jobs.run_scan(deep=True))
    assert db.get_listing("emlakjet-1")["date_posted"] == d(10)
