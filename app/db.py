"""SQLite veri katmanı: ayarlar, ilanlar, arama-ilan ilişkileri ve tarama kayıtları."""

import json
import os
import sqlite3
import threading
from datetime import date, datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo(os.environ.get("APP_TZ", "Europe/Istanbul"))
DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "..", "data", "emlak.db"))

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS listings (
    id                 TEXT PRIMARY KEY,
    source             TEXT NOT NULL,
    url                TEXT NOT NULL,
    title              TEXT NOT NULL,
    image              TEXT,
    price              REAL,
    currency           TEXT,
    listing_type       TEXT,
    location           TEXT,
    rooms              TEXT,
    area_m2            REAL,
    floor              TEXT,
    tags               TEXT,
    date_posted        TEXT,
    first_seen         TEXT NOT NULL,
    last_seen          TEXT NOT NULL,
    notified_new       INTEGER NOT NULL DEFAULT 0,
    notified_expiring  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_listings_date ON listings(date_posted);
CREATE TABLE IF NOT EXISTS listing_searches (
    listing_id TEXT NOT NULL,
    search_id  TEXT NOT NULL,
    PRIMARY KEY (listing_id, search_id)
);
CREATE TABLE IF NOT EXISTS search_state (
    search_id     TEXT PRIMARY KEY,
    seeded        INTEGER NOT NULL DEFAULT 0,
    last_scan     TEXT,
    last_count    INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    found       INTEGER DEFAULT 0,
    new_count   INTEGER DEFAULT 0,
    sent        INTEGER DEFAULT 0,
    status      TEXT,
    message     TEXT
);
"""


def connect(path: str | None = None) -> sqlite3.Connection:
    """Bağlantıyı açar (yoksa) ve şemayı oluşturur. Testlerde farklı yol verilebilir."""
    global _conn
    with _lock:
        if path is not None or _conn is None:
            p = path or DB_PATH
            if p != ":memory:":
                os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
            _conn = sqlite3.connect(p, check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.executescript(SCHEMA)
            _conn.commit()
        return _conn


def conn() -> sqlite3.Connection:
    return _conn or connect()


def local_now() -> datetime:
    return datetime.now(TZ).replace(tzinfo=None)


def today() -> date:
    return local_now().date()


def now_iso() -> str:
    return local_now().isoformat(timespec="seconds")


# --- ayarlar -----------------------------------------------------------------

def get_setting(key: str, default=None):
    row = conn().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value) -> None:
    with _lock:
        conn().execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )
        conn().commit()


# --- ilanlar -----------------------------------------------------------------

def get_listing(listing_id: str):
    return conn().execute("SELECT * FROM listings WHERE id=?", (listing_id,)).fetchone()


def upsert_listing(item: dict, search_id: str, seen_at: str) -> bool:
    """İlanı kaydeder/günceller ve aramaya bağlar. İlan ilk kez görülüyorsa True döner."""
    with _lock:
        c = conn()
        existing = c.execute("SELECT date_posted FROM listings WHERE id=?", (item["id"],)).fetchone()
        tags = json.dumps(item.get("tags") or [], ensure_ascii=False)
        if existing is None:
            c.execute(
                """INSERT INTO listings(id, source, url, title, image, price, currency, listing_type,
                       location, rooms, area_m2, floor, tags, date_posted, first_seen, last_seen)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (item["id"], item["source"], item["url"], item["title"], item.get("image"),
                 item.get("price"), item.get("currency"), item.get("listing_type"),
                 item.get("location"), item.get("rooms"), item.get("area_m2"), item.get("floor"),
                 tags, item.get("date_posted"), seen_at, seen_at),
            )
            is_new = True
        else:
            # İlan tarihi güncellenirse (ilan yenilenirse) ilk görülen yayın tarihini koruyoruz.
            date_posted = existing["date_posted"]
            if item.get("date_posted") and (not date_posted or item["date_posted"] < date_posted):
                date_posted = item["date_posted"]
            c.execute(
                """UPDATE listings SET url=?, title=?, image=?, price=?, currency=?, listing_type=?,
                       location=?, rooms=?, area_m2=?, floor=?, tags=?, date_posted=?, last_seen=?
                   WHERE id=?""",
                (item["url"], item["title"], item.get("image"), item.get("price"), item.get("currency"),
                 item.get("listing_type"), item.get("location"), item.get("rooms"), item.get("area_m2"),
                 item.get("floor"), tags, date_posted, seen_at, item["id"]),
            )
            is_new = False
        c.execute(
            "INSERT OR IGNORE INTO listing_searches(listing_id, search_id) VALUES(?, ?)",
            (item["id"], search_id),
        )
        c.commit()
        return is_new


def listing_search_ids(listing_id: str) -> list[str]:
    rows = conn().execute("SELECT search_id FROM listing_searches WHERE listing_id=?", (listing_id,))
    return [r["search_id"] for r in rows]


def mark(listing_id: str, column: str) -> None:
    assert column in ("notified_new", "notified_expiring")
    with _lock:
        conn().execute(f"UPDATE listings SET {column}=1 WHERE id=?", (listing_id,))
        conn().commit()


def row_to_item(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["tags"] = json.loads(d.get("tags") or "[]")
    return d


def listings_posted_between(start_date: str, end_date: str) -> list[dict]:
    rows = conn().execute(
        "SELECT * FROM listings WHERE date_posted BETWEEN ? AND ? ORDER BY date_posted, id",
        (start_date, end_date),
    )
    return [row_to_item(r) for r in rows]


def recent_listings(limit: int = 200, offset: int = 0, q: str | None = None) -> list[dict]:
    sql = "SELECT * FROM listings"
    params: list = []
    if q:
        sql += " WHERE title LIKE ? OR location LIKE ? OR id = ?"
        params += [f"%{q}%", f"%{q}%", q]
    sql += " ORDER BY date_posted DESC, first_seen DESC LIMIT ? OFFSET ?"
    params += [limit, offset]
    return [row_to_item(r) for r in conn().execute(sql, params)]


# --- arama durumu ------------------------------------------------------------

def search_state(search_id: str) -> dict:
    row = conn().execute("SELECT * FROM search_state WHERE search_id=?", (search_id,)).fetchone()
    return dict(row) if row else {"search_id": search_id, "seeded": 0, "last_scan": None, "last_count": None}


def update_search_state(search_id: str, seeded: bool, count: int) -> None:
    with _lock:
        conn().execute(
            """INSERT INTO search_state(search_id, seeded, last_scan, last_count) VALUES(?,?,?,?)
               ON CONFLICT(search_id) DO UPDATE SET seeded=excluded.seeded,
                   last_scan=excluded.last_scan, last_count=excluded.last_count""",
            (search_id, int(seeded), now_iso(), count),
        )
        conn().commit()


def reset_search_state(search_id: str) -> None:
    with _lock:
        conn().execute("DELETE FROM search_state WHERE search_id=?", (search_id,))
        conn().commit()


# --- çalıştırma kayıtları ----------------------------------------------------

def start_run(kind: str) -> int:
    with _lock:
        cur = conn().execute("INSERT INTO runs(kind, started_at, status) VALUES(?, ?, 'running')", (kind, now_iso()))
        conn().commit()
        return cur.lastrowid


def finish_run(run_id: int, status: str, message: str = "", found: int = 0, new_count: int = 0, sent: int = 0):
    with _lock:
        conn().execute(
            "UPDATE runs SET finished_at=?, status=?, message=?, found=?, new_count=?, sent=? WHERE id=?",
            (now_iso(), status, message, found, new_count, sent, run_id),
        )
        conn().commit()


def recent_runs(limit: int = 50) -> list[dict]:
    return [dict(r) for r in conn().execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,))]


def stats() -> dict:
    c = conn()
    today_str = today().isoformat()
    return {
        "total": c.execute("SELECT COUNT(*) FROM listings").fetchone()[0],
        "seen_today": c.execute("SELECT COUNT(*) FROM listings WHERE first_seen >= ?", (today_str,)).fetchone()[0],
        "notified_new": c.execute("SELECT COUNT(*) FROM listings WHERE notified_new=1").fetchone()[0],
        "notified_expiring": c.execute("SELECT COUNT(*) FROM listings WHERE notified_expiring=1").fetchone()[0],
    }
