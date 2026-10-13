"""Telegram Bot API ile mesaj gönderimi ve mesaj biçimlendirme."""

import asyncio
import html as _html
import logging

import httpx

log = logging.getLogger(__name__)


def esc(text: str) -> str:
    return _html.escape(text, quote=False)

API = "https://api.telegram.org/bot{token}/{method}"
MAX_TEXT = 4096
MAX_CAPTION = 1024


class TelegramError(RuntimeError):
    pass


def fmt_price(price, currency="TRY") -> str:
    if price is None:
        return "Fiyat belirtilmemiş"
    symbol = {"TRY": "TL", "USD": "$", "EUR": "€", "GBP": "£"}.get(currency or "TRY", currency)
    return f"{int(round(price)):,}".replace(",", ".") + f" {symbol}"


def fmt_date(iso: str | None) -> str:
    if not iso:
        return "-"
    y, m, d = iso[:10].split("-")
    return f"{d}.{m}.{y}"


def details_line(item: dict) -> str:
    parts = [f"💰 {fmt_price(item.get('price'), item.get('currency'))}"]
    if item.get("area_m2"):
        parts.append(f"📐 {int(item['area_m2'])} m²")
    if item.get("rooms"):
        parts.append(f"🛏 {esc(item['rooms'])}")
    if item.get("floor"):
        parts.append(f"🏢 {esc(item['floor'])}")
    return " | ".join(parts)


def new_listing_message(item: dict, search_name: str) -> str:
    lines = [
        f"🆕 <b>Yeni İlan</b> · {esc(search_name)}",
        f"<b>{esc(item['title'])}</b>",
        details_line(item),
    ]
    if item.get("location"):
        lines.append(f"📍 {esc(item['location'])}")
    if item.get("tags"):
        lines.append("🏷 " + ", ".join(esc(t) for t in item["tags"]))
    lines.append(f"📅 İlan tarihi: {fmt_date(item.get('date_posted'))}")
    lines.append(f"🔗 {esc(item['url'])}")
    return "\n".join(lines)


def expiring_messages(items: list[dict], day: int, today_str: str) -> list[str]:
    """30. gün raporunu Telegram'ın mesaj sınırına sığacak parçalara böler."""
    header = f"⏰ <b>{day}. gününe giren ilanlar</b> · {today_str}\nToplam: {len(items)} ilan"
    if not items:
        return [header + "\n\nBugün bu güne giren ilan yok."]
    blocks = []
    for n, item in enumerate(items, 1):
        loc = f"\n📍 {esc(item['location'])}" if item.get("location") else ""
        blocks.append(
            f"{n}. <b>{esc(item['title'])}</b>\n{details_line(item)}{loc}\n"
            f"📅 {fmt_date(item.get('date_posted'))} · {item.get('day', day)}. gün\n🔗 {esc(item['url'])}"
        )
    messages, current = [], header
    for block in blocks:
        if len(current) + 2 + len(block) > MAX_TEXT:
            messages.append(current)
            current = block
        else:
            current += "\n\n" + block
    messages.append(current)
    return messages


class Telegram:
    def __init__(self, token: str, client: httpx.AsyncClient | None = None):
        if not token:
            raise TelegramError("Telegram bot token'ı girilmemiş")
        self.token = token
        self._client = client or httpx.AsyncClient(timeout=30)
        self._own = client is None

    async def close(self):
        if self._own:
            await self._client.aclose()

    async def call(self, method: str, payload: dict) -> dict:
        for attempt in range(4):
            try:
                r = await self._client.post(API.format(token=self.token, method=method), json=payload)
                data = r.json()
            except (httpx.HTTPError, ValueError) as e:
                if attempt == 3:
                    raise TelegramError(f"Telegram'a ulaşılamadı: {e}")
                await asyncio.sleep(2 ** attempt)
                continue
            if data.get("ok"):
                await asyncio.sleep(1.1)  # sohbet başına ~1 mesaj/sn sınırı
                return data.get("result")
            retry_after = (data.get("parameters") or {}).get("retry_after")
            if r.status_code == 429 and retry_after and attempt < 3:
                await asyncio.sleep(int(retry_after) + 1)
                continue
            raise TelegramError(data.get("description") or f"HTTP {r.status_code}")
        raise TelegramError("Telegram isteği başarısız")

    async def send_text(self, chat_id: str, text: str):
        return await self.call("sendMessage", {
            "chat_id": chat_id, "text": text, "parse_mode": "HTML",
            "disable_web_page_preview": False,
        })

    async def send_listing(self, chat_id: str, text: str, image: str | None, with_photo: bool):
        if with_photo and image and len(text) <= MAX_CAPTION:
            try:
                return await self.call("sendPhoto", {
                    "chat_id": chat_id, "photo": image, "caption": text, "parse_mode": "HTML",
                })
            except TelegramError as e:
                log.warning("Fotoğraflı gönderim başarısız, metin olarak gönderiliyor: %s", e)
        return await self.send_text(chat_id, text)

    async def get_me(self) -> dict:
        return await self.call("getMe", {})

    async def recent_chats(self) -> list[dict]:
        """Bota son yazan sohbetleri listeler (sohbet kimliğini bulmak için)."""
        updates = await self.call("getUpdates", {"limit": 100})
        chats = {}
        for u in updates or []:
            msg = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
            chat = msg.get("chat")
            if chat:
                title = chat.get("title") or " ".join(
                    x for x in (chat.get("first_name"), chat.get("last_name")) if x
                ) or chat.get("username") or ""
                chats[chat["id"]] = {"id": chat["id"], "type": chat.get("type"), "title": title}
        return list(chats.values())
