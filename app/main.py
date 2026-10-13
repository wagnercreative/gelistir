"""Web paneli (FastAPI) ve zamanlayıcı."""

import asyncio
import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from . import config, db, filters, jobs
from .telegram import Telegram, TelegramError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("emlak")

STATIC = os.path.join(os.path.dirname(__file__), "static")
PANEL_USER = os.environ.get("PANEL_USER", "admin")
PANEL_PASSWORD = os.environ.get("PANEL_PASSWORD", "")

scheduler = AsyncIOScheduler(timezone=db.TZ)
_background: set[asyncio.Task] = set()


async def _scan_job():
    try:
        await jobs.run_scan()
    except Exception:
        log.exception("Zamanlanmış tarama başarısız")


async def _daily_job():
    try:
        await jobs.run_daily_report()
    except Exception:
        log.exception("Günlük rapor başarısız")


def apply_schedule(cfg: dict, first_scan_delay: int | None = None) -> None:
    for job_id in ("scan", "daily"):
        if scheduler.get_job(job_id):
            scheduler.remove_job(job_id)
    if cfg["scanning_enabled"]:
        kwargs = {}
        if first_scan_delay is not None:
            kwargs["next_run_time"] = datetime.now(db.TZ) + timedelta(seconds=first_scan_delay)
        scheduler.add_job(_scan_job, IntervalTrigger(minutes=cfg["scan_interval_minutes"], timezone=db.TZ),
                          id="scan", max_instances=1, coalesce=True, **kwargs)
    if cfg["daily_report_enabled"]:
        hour, minute = map(int, cfg["daily_report_time"].split(":"))
        scheduler.add_job(_daily_job, CronTrigger(hour=hour, minute=minute, timezone=db.TZ),
                          id="daily", max_instances=1, coalesce=True, misfire_grace_time=3600)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.connect()
    scheduler.start()
    apply_schedule(config.load(), first_scan_delay=int(os.environ.get("FIRST_SCAN_DELAY", "15")))
    if not PANEL_PASSWORD:
        log.warning("PANEL_PASSWORD tanımlı değil: panel parolasız açık!")
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="Emlak Takip Paneli", lifespan=lifespan)
security = HTTPBasic(auto_error=False)


def auth(credentials: HTTPBasicCredentials | None = Depends(security)):
    if not PANEL_PASSWORD:
        return
    ok = credentials is not None and secrets.compare_digest(
        credentials.username.encode(), PANEL_USER.encode()
    ) and secrets.compare_digest(credentials.password.encode(), PANEL_PASSWORD.encode())
    if not ok:
        raise HTTPException(401, "Yetkisiz", headers={"WWW-Authenticate": 'Basic realm="Emlak Takip"'})


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _background.add(task)

    def done(t: asyncio.Task):
        _background.discard(t)
        if not t.cancelled() and t.exception():
            log.error("Arka plan işi başarısız: %s", t.exception())

    task.add_done_callback(done)


def _public_cfg(cfg: dict) -> dict:
    out = dict(cfg)
    token = cfg.get("telegram_token") or ""
    out["telegram_token"] = ""
    out["telegram_token_hint"] = (token[:6] + "…" + token[-4:]) if token else ""
    return out


@app.get("/", include_in_schema=False, dependencies=[Depends(auth)])
async def index():
    return FileResponse(os.path.join(STATIC, "index.html"))


@app.get("/api/meta", dependencies=[Depends(auth)])
async def meta():
    return {
        "categories": config.CATEGORIES,
        "room_options": config.ROOM_OPTIONS,
        "default_filters": config.DEFAULT_FILTERS,
        "auth_enabled": bool(PANEL_PASSWORD),
        "timezone": str(db.TZ),
    }


@app.get("/api/settings", dependencies=[Depends(auth)])
async def get_settings():
    return _public_cfg(config.load())


@app.put("/api/settings", dependencies=[Depends(auth)])
async def put_settings(request: Request):
    data = await request.json()
    current = config.load()
    if not (data.get("telegram_token") or "").strip() and not data.get("clear_token"):
        data["telegram_token"] = current["telegram_token"]
    try:
        cfg = config.save(data)
    except config.ConfigError as e:
        raise HTTPException(400, str(e))
    apply_schedule(cfg)
    return _public_cfg(cfg)


def _job_next(job_id: str):
    job = scheduler.get_job(job_id)
    return job.next_run_time.isoformat(timespec="seconds") if job and job.next_run_time else None


@app.get("/api/status", dependencies=[Depends(auth)])
async def status():
    cfg = config.load()
    states = {s["id"]: db.search_state(s["id"]) for s in cfg["searches"]}
    return {
        "stats": db.stats(),
        "running": jobs.is_running(),
        "next_scan": _job_next("scan"),
        "next_daily": _job_next("daily"),
        "now": db.now_iso(),
        "telegram_ready": bool(cfg["telegram_token"] and config.chat_ids(cfg)),
        "searches": [{"id": s["id"], "name": s["name"], "enabled": s["enabled"], **states[s["id"]]}
                     for s in cfg["searches"]],
        "runs": db.recent_runs(8),
        "expiring_today": len(jobs.expiring_candidates(cfg, db.today())),
    }


@app.get("/api/listings", dependencies=[Depends(auth)])
async def listings(q: str = "", limit: int = 100, offset: int = 0):
    today = db.today()
    items = db.recent_listings(min(limit, 500), offset, q.strip() or None)
    for i in items:
        i["day"] = filters.day_number(i.get("date_posted"), today)
    return items


@app.get("/api/runs", dependencies=[Depends(auth)])
async def runs(limit: int = 100):
    return db.recent_runs(min(limit, 500))


@app.post("/api/scan", dependencies=[Depends(auth)])
async def scan_now(deep: bool = False):
    if jobs.is_running():
        raise HTTPException(409, "Şu anda bir tarama sürüyor")
    _spawn(jobs.run_scan(deep=deep))
    return {"started": True}


@app.post("/api/daily-report", dependencies=[Depends(auth)])
async def daily_now():
    if jobs.is_running():
        raise HTTPException(409, "Şu anda bir tarama sürüyor")
    _spawn(jobs.run_daily_report())
    return {"started": True}


@app.post("/api/preview", dependencies=[Depends(auth)])
async def preview(request: Request):
    """Kaydedilmemiş filtreleri, bu aramanın daha önce bulduğu ilanlar üzerinde dener."""
    body = await request.json()
    try:
        search = config.validate({"searches": [body["search"]]})["searches"][0]
    except (config.ConfigError, KeyError, IndexError) as e:
        raise HTTPException(400, str(e))
    rows = db.conn().execute(
        "SELECT l.* FROM listings l JOIN listing_searches ls ON ls.listing_id = l.id "
        "WHERE ls.search_id = ? ORDER BY l.date_posted DESC LIMIT 500",
        (body["search"].get("id") or "",),
    )
    items = [db.row_to_item(r) for r in rows]
    matched = [i for i in items if filters.matches(i, search["filters"])]
    return {"total": len(items), "matched": len(matched), "sample": matched[:15]}


async def _telegram_from(request: Request) -> Telegram:
    body = await request.json() if await request.body() else {}
    token = (body.get("token") or "").strip() or config.load()["telegram_token"]
    try:
        return Telegram(token)
    except TelegramError as e:
        raise HTTPException(400, str(e))


@app.post("/api/telegram/test", dependencies=[Depends(auth)])
async def telegram_test(request: Request):
    body = await request.json() if await request.body() else {}
    cfg = config.load()
    chats = config.chat_ids({"telegram_chat_ids": body.get("chat_ids") or cfg["telegram_chat_ids"]})
    if not chats:
        raise HTTPException(400, "Sohbet kimliği (chat id) girilmemiş")
    tg = await _telegram_from(request)
    try:
        me = await tg.get_me()
        for chat in chats:
            await tg.send_text(chat, f"✅ Emlak Takip Paneli bağlantı testi başarılı.\nBot: @{me.get('username')}")
    except TelegramError as e:
        raise HTTPException(400, f"Telegram hatası: {e}")
    finally:
        await tg.close()
    return {"ok": True, "bot": me.get("username"), "chats": chats}


@app.post("/api/telegram/chats", dependencies=[Depends(auth)])
async def telegram_chats(request: Request):
    tg = await _telegram_from(request)
    try:
        return {"chats": await tg.recent_chats()}
    except TelegramError as e:
        raise HTTPException(400, f"Telegram hatası: {e}")
    finally:
        await tg.close()
