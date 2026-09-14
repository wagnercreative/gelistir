/**
 * YouTube teslim kurallari. Tamami saf fonksiyon.
 *
 * Buradaki kisitlar YouTube'un gercek kurallari:
 *  - Bolumler (chapters): ilki 0:00 olmali, en az 3 bolum, her bolum >= 10 sn.
 *  - Baslik <= 100 karakter, aciklama <= 5000 karakter.
 *  - Etiketlerin toplam uzunlugu <= 500 karakter.
 * Model bu kurallari ihlal eden bir sey uretirse burada duzeltilir.
 */

/** saniye -> "0:07" / "1:02:03" (bolum listesi bicimi) */
export function formatChapterTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** saniye -> "00:00:07,120" (SRT bicimi) */
export function formatSrtTime(seconds) {
  const clamped = Math.max(0, seconds);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const total = Math.floor(clamped);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Bolum listesini YouTube kurallarina uydurur.
 * Kurallar saglanamiyorsa bos dizi doner (bolum yok, yarim bolum listesinden iyidir).
 */
export function normalizeChapters(chapters, duration, options = {}) {
  const { minChapters = 3, minChapterLength = 10, firstTitle = "Giris" } = options;

  const sorted = (chapters || [])
    .map((c) => ({ time: Number(c.time), title: String(c.title || "").trim() }))
    .filter((c) => Number.isFinite(c.time) && c.time >= 0 && c.time < duration && c.title)
    .sort((a, b) => a.time - b.time);

  if (sorted.length === 0) return [];

  // Ilk bolum 0:00 olmak zorunda.
  if (sorted[0].time > 0) sorted.unshift({ time: 0, title: firstTitle });
  else sorted[0].time = 0;

  const accepted = [];
  for (const c of sorted) {
    const prev = accepted[accepted.length - 1];
    if (prev && c.time - prev.time < minChapterLength) continue; // cok yakin
    if (duration - c.time < minChapterLength) continue; // sona cok yakin
    accepted.push(c);
  }

  return accepted.length >= minChapters ? accepted : [];
}

export function formatChapterBlock(chapters) {
  return chapters.map((c) => `${formatChapterTime(c.time)} ${c.title}`).join("\n");
}

/** Basligi kelime sinirindan kirpar. */
export function clampTitle(title, maxLength = 100) {
  const clean = String(title || "").replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  const cut = clean.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Etiketleri temizler: tekrarlari atar, sayi ve toplam karakter butcesine sigdirir.
 * YouTube toplam etiket uzunlugunu 500 karakterle sinirlar.
 */
export function normalizeTags(tags, options = {}) {
  const { maxTags = 15, maxTotalLength = 500, maxTagLength = 100 } = options;
  const seen = new Set();
  const out = [];
  let total = 0;

  for (const raw of tags || []) {
    const tag = String(raw || "").replace(/\s+/g, " ").trim();
    if (!tag || tag.length > maxTagLength) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    const cost = tag.length + (out.length > 0 ? 1 : 0); // virgul ayiraci
    if (total + cost > maxTotalLength) continue;
    if (out.length >= maxTags) break;
    seen.add(key);
    out.push(tag);
    total += cost;
  }
  return out;
}

/** Aciklamayi birlestirir ve 5000 karaktere sigdirir (bolumler korunur). */
export function buildDescription({
  summary = "",
  chapters = [],
  extra = "",
  hashtags = [],
  maxLength = 5000,
} = {}) {
  const parts = [];
  const body = String(summary).trim();
  if (body) parts.push(body);

  const chapterBlock = chapters.length ? `Bolumler:\n${formatChapterBlock(chapters)}` : "";
  const tail = [];
  if (chapterBlock) tail.push(chapterBlock);
  if (String(extra).trim()) tail.push(String(extra).trim());
  const tagLine = (hashtags || [])
    .map((h) => (String(h).startsWith("#") ? String(h) : `#${String(h).replace(/\s+/g, "")}`))
    .filter((h) => h.length > 1)
    .slice(0, 3)
    .join(" ");
  if (tagLine) tail.push(tagLine);

  const tailText = tail.join("\n\n");
  const separator = parts.length && tailText ? "\n\n" : "";
  const reserved = tailText.length + separator.length;

  // Bolumler asla kirpilmaz; gerekirse ozet kisaltilir.
  if (reserved >= maxLength) return tailText.slice(0, maxLength);
  let head = parts.join("\n\n");
  if (head.length > maxLength - reserved) {
    head = head.slice(0, maxLength - reserved).replace(/\s+\S*$/, "").trim();
  }
  return [head, tailText].filter(Boolean).join("\n\n");
}

/** Metni en fazla maxLines satira, satir basina maxChars karaktere boler. */
export function wrapCaption(text, maxChars = 42, maxLines = 2) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= maxChars || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  // Sigmayan satirlar son satira toplanir; zaman bolmesi buildSrtCues'in isi.
  const head = lines.slice(0, maxLines - 1);
  head.push(lines.slice(maxLines - 1).join(" "));
  return head;
}

function splitSegment(segment, maxChars, maxLines, maxDuration) {
  const tooLong = segment.end - segment.start > maxDuration;
  const tooWide = segment.text.length > maxChars * maxLines;
  if (!tooLong && !tooWide) return [segment];

  const words = segment.words && segment.words.length > 1 ? segment.words : null;
  if (words) {
    const mid = segment.start + (segment.end - segment.start) / 2;
    let idx = 1;
    let best = Infinity;
    for (let i = 1; i < words.length; i++) {
      const d = Math.abs(words[i].start - mid);
      if (d < best) {
        best = d;
        idx = i;
      }
    }
    const left = words.slice(0, idx);
    const right = words.slice(idx);
    if (left.length && right.length) {
      const a = {
        start: segment.start,
        end: left[left.length - 1].end,
        text: left.map((w) => w.word).join(" ").trim(),
        words: left,
      };
      const b = {
        start: right[0].start,
        end: segment.end,
        text: right.map((w) => w.word).join(" ").trim(),
        words: right,
      };
      return [
        ...splitSegment(a, maxChars, maxLines, maxDuration),
        ...splitSegment(b, maxChars, maxLines, maxDuration),
      ];
    }
  }

  // Kelime zamani yok: metni ortadan bol, sureyi karakter oranina gore pay et.
  const text = segment.text.trim();
  if (text.length < 8) return [segment];
  const half = Math.floor(text.length / 2);
  const space = text.lastIndexOf(" ", half) > 0 ? text.lastIndexOf(" ", half) : half;
  const ratio = space / text.length;
  const cutAt = segment.start + (segment.end - segment.start) * ratio;
  const a = { start: segment.start, end: cutAt, text: text.slice(0, space).trim() };
  const b = { start: cutAt, end: segment.end, text: text.slice(space).trim() };
  return [
    ...splitSegment(a, maxChars, maxLines, maxDuration),
    ...splitSegment(b, maxChars, maxLines, maxDuration),
  ];
}

/**
 * Altyazi kuyruklarini uretir: bolme, minimum/maksimum sure, cakisma temizligi.
 * Girdi segmentleri CIKTI zaman cizgisinde olmali.
 */
export function buildSrtCues(segments, options = {}) {
  const {
    srtMaxCharsPerLine = 42,
    srtMaxLines = 2,
    srtMinDuration = 1.0,
    srtMaxDuration = 6.0,
  } = options;

  const expanded = [];
  for (const s of segments || []) {
    const text = String(s.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (!(Number.isFinite(s.start) && Number.isFinite(s.end)) || s.end <= s.start) continue;
    expanded.push(
      ...splitSegment(
        { start: s.start, end: s.end, text, words: s.words },
        srtMaxCharsPerLine,
        srtMaxLines,
        srtMaxDuration,
      ),
    );
  }
  expanded.sort((a, b) => a.start - b.start);

  const cues = [];
  for (const s of expanded) {
    const prev = cues[cues.length - 1];
    let start = s.start;
    if (prev && start < prev.end) start = prev.end;
    let end = Math.max(s.end, start + srtMinDuration);
    if (end - start > srtMaxDuration) end = start + srtMaxDuration;
    if (end <= start) continue;
    cues.push({
      index: cues.length + 1,
      start,
      end,
      lines: wrapCaption(s.text, srtMaxCharsPerLine, srtMaxLines),
    });
  }

  // Sonraki kuyruga tasan bitisleri kis.
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
  }
  return cues.filter((c) => c.end - c.start > 0.04);
}

export function formatSrt(cues) {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.lines.join("\n")}`,
      )
      .join("\n\n") + "\n"
  );
}
