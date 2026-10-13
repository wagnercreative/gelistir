"""Zamanlanmış işler: periyodik ilan taraması ve günlük "30. gün" raporu."""

import asyncio
import logging
from datetime import date, timedelta

from . import config, db, filters
from .emlakjet import Fetcher, ScrapeError
from .telegram import Telegram, TelegramError, expiring_messages, fmt_date, new_listing_message

log = logging.getLogger(__name__)

_scan_lock = asyncio.Lock()

# Testlerde sahte nesnelerle değiştirilebilir.
fetcher_factory = lambda cfg: Fetcher(delay=cfg["request_delay_seconds"])  # noqa: E731
telegram_factory = lambda cfg: Telegram(cfg["telegram_token"])  # noqa: E731


def is_running() -> bool:
    return _scan_lock.locked()


def _new_age_ok(item: dict, f: dict, today: date) -> bool:
    limit = f.get("max_new_age_days")
    day = filters.day_number(item.get("date_posted"), today)
    return limit is None or day is None or day - 1 <= limit


async def run_scan(deep: bool = False) -> dict:
    """Etkin aramaları tarar, yeni ilanları kaydeder ve filtreye uyanları Telegram'a gönderir.

    Normal taramada bir sayfadaki ilanların tamamı zaten biliniyorsa durulur. Derin taramada
    (ve bir aramanın ilk taramasında) hatırlatma günü + 3 gün öncesine kadar tüm sayfalar gezilir;
    böylece 30. gün raporu için ilanların hâlâ yayında olduğu doğrulanır.
    """
    async with _scan_lock:
        cfg = config.load()
        run_id = db.start_run("derin tarama" if deep else "tarama")
        today = db.today()
        cutoff = (today - timedelta(days=cfg["reminder_day"] + 3)).isoformat()
        seen_at = db.now_iso()
        found = 0
        new_items: dict[str, dict] = {}
        seen_by: dict[str, list[tuple[dict, bool]]] = {}
        errors: list[str] = []

        try:
            async with fetcher_factory(cfg) as fetcher:
                for s in [s for s in cfg["searches"] if s["enabled"]]:
                    seeding = not db.search_state(s["id"])["seeded"]
                    full = deep or seeding

                    def stop(page_items, full=full):
                        dates = [i["date_posted"] for i in page_items if i.get("date_posted")]
                        if dates and min(dates) < cutoff:
                            return True
                        return not full and all(db.get_listing(i["id"]) for i in page_items)

                    try:
                        items = await fetcher.search(s, cfg["max_pages"], stop)
                    except ScrapeError as e:
                        errors.append(f"{s['name']}: {e}")
                        continue
                    found += len(items)
                    for item in items:
                        if db.upsert_listing(item, s["id"], seen_at):
                            new_items[item["id"]] = item
                        if item["id"] in new_items:
                            seen_by.setdefault(item["id"], []).append((s, seeding))
                    db.update_search_state(s["id"], True, len(items))

            to_send = []
            for lid, item in new_items.items():
                for s, seeding in seen_by.get(lid, []):
                    if seeding and not cfg["notify_on_first_scan"]:
                        continue
                    if filters.matches(item, s["filters"]) and _new_age_ok(item, s["filters"], today):
                        to_send.append((item, s))
                        break
            to_send.sort(key=lambda x: (x[0].get("date_posted") or "", x[0]["id"]))

            sent, send_errors = await _send_new(cfg, to_send)
            errors += send_errors
            status = "hata" if errors and not found else ("uyarı" if errors else "tamam")
            msg = f"{len(to_send)} ilan bildirime uygun"
            if errors:
                msg += " · " + " | ".join(errors[:5])
            db.finish_run(run_id, status, msg, found, len(new_items), sent)
            return {"found": found, "new": len(new_items), "matched": len(to_send), "sent": sent, "errors": errors}
        except Exception as e:  # beklenmeyen hatalar da kayıtlarda görünsün
            log.exception("Tarama başarısız")
            db.finish_run(run_id, "hata", str(e), found, len(new_items), 0)
            raise


async def _send_new(cfg: dict, to_send: list[tuple[dict, dict]]) -> tuple[int, list[str]]:
    if not to_send:
        return 0, []
    chats = config.chat_ids(cfg)
    if not cfg["telegram_token"] or not chats:
        return 0, ["Telegram ayarlanmadığı için bildirim gönderilmedi"]
    tg = telegram_factory(cfg)
    sent, errors = 0, []
    try:
        for item, s in to_send:
            text = new_listing_message(item, s["name"])
            ok = False
            for chat in chats:
                try:
                    await tg.send_listing(chat, text, item.get("image"), cfg["send_photo"])
                    ok = True
                except TelegramError as e:
                    errors.append(f"Telegram ({chat}): {e}")
            if ok:
                db.mark(item["id"], "notified_new")
                sent += 1
    finally:
        await tg.close()
    return sent, sorted(set(errors))


def expiring_candidates(cfg: dict, today: date) -> list[dict]:
    """Hatırlatma gününe giren (kaçırılmış günler için +2 gün tolerans), hâlâ yayında olan ve
    henüz bildirilmemiş ilanlar."""
    day = cfg["reminder_day"]
    start = (today - timedelta(days=day + 1)).isoformat()   # day+2. gün
    end = (today - timedelta(days=day - 1)).isoformat()     # day. gün
    active_since = (today - timedelta(days=1)).isoformat()
    searches = {s["id"]: s for s in cfg["searches"] if s["enabled"]}
    result = []
    for item in db.listings_posted_between(start, end):
        if item["notified_expiring"] or item["last_seen"] < active_since:
            continue
        linked = [searches[sid] for sid in db.listing_search_ids(item["id"]) if sid in searches]
        if not linked:
            continue
        if cfg["daily_report_apply_filters"] and not any(filters.matches(item, s["filters"]) for s in linked):
            continue
        item["day"] = filters.day_number(item["date_posted"], today)
        result.append(item)
    return result


async def run_daily_report(deep_scan: bool = True) -> dict:
    cfg = config.load()
    if deep_scan:
        try:
            await run_scan(deep=True)
        except Exception:
            log.exception("Rapor öncesi derin tarama başarısız; mevcut verilerle devam ediliyor")
    run_id = db.start_run("günlük rapor")
    today = db.today()
    try:
        items = expiring_candidates(cfg, today)
        if not items and not cfg["send_empty_daily_report"]:
            db.finish_run(run_id, "tamam", "Gönderilecek ilan yok", len(items))
            return {"count": 0, "sent": 0}
        chats = config.chat_ids(cfg)
        if not cfg["telegram_token"] or not chats:
            db.finish_run(run_id, "hata", f"Telegram ayarlanmadı ({len(items)} ilan bekliyor)", len(items))
            return {"count": len(items), "sent": 0, "errors": ["Telegram ayarlanmadı"]}
        messages = expiring_messages(items, cfg["reminder_day"], fmt_date(today.isoformat()))
        tg = telegram_factory(cfg)
        ok, errors = False, []
        try:
            for chat in chats:
                try:
                    for m in messages:
                        await tg.send_text(chat, m)
                    ok = True
                except TelegramError as e:
                    errors.append(f"Telegram ({chat}): {e}")
        finally:
            await tg.close()
        if ok:
            for item in items:
                db.mark(item["id"], "notified_expiring")
        status = "tamam" if ok and not errors else ("uyarı" if ok else "hata")
        db.finish_run(run_id, status, f"{len(items)} ilan, {len(messages)} mesaj" +
                      (" · " + " | ".join(errors) if errors else ""), len(items), 0, len(items) if ok else 0)
        return {"count": len(items), "sent": len(items) if ok else 0, "errors": errors}
    except Exception as e:
        log.exception("Günlük rapor başarısız")
        db.finish_run(run_id, "hata", str(e))
        raise
