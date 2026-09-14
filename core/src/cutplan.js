/**
 * Kesim plani matematigi. Tamami saf fonksiyon: I/O yok, model cagrisi yok.
 *
 * Claude'un onerdigi "atilacak araliklar" listesi buradan geciyor ve
 * guvenlik esiklerine gore budaniyor. Nihai "keeps" listesi hem Premiere
 * zaman cizgisini yeniden kurmak hem de ffmpeg ile kesmek icin kullanilir.
 */

const EPS = 1e-6;

/** Araliklari kirpar, siralar ve ust uste binenleri birlestirir. */
export function normalizeRanges(ranges, duration = Infinity) {
  const clean = [];
  for (const r of ranges || []) {
    const start = Math.max(0, Number(r.start));
    const end = Math.min(duration, Number(r.end));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end - start <= EPS) continue;
    clean.push({ ...r, start, end });
  }
  clean.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const r of clean) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + EPS) {
      last.end = Math.max(last.end, r.end);
      // Birlesen araliklarda en yuksek guven ve birlesik gerekce tutulur.
      last.confidence = Math.max(last.confidence ?? 0.5, r.confidence ?? 0.5);
      if (r.reason && last.reason && !last.reason.includes(r.reason)) {
        last.reason = `${last.reason}; ${r.reason}`;
      }
      last.reason = last.reason || r.reason;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** Verilen atilacak araliklarin tersini (tutulacak parcalari) dondurur. */
export function invertRanges(removals, duration) {
  const keeps = [];
  let cursor = 0;
  for (const r of normalizeRanges(removals, duration)) {
    if (r.start - cursor > EPS) keeps.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  }
  if (duration - cursor > EPS) keeps.push({ start: cursor, end: duration });
  return keeps;
}

/**
 * Her atilacak araligin basina/sonuna nefes payi birakir (araligi daraltir).
 * Pay sonrasi anlamsiz kalan araliklar dusurulur.
 */
export function padRemovals(removals, padHead = 0, padTail = 0, minLength = 0) {
  const out = [];
  for (const r of removals || []) {
    const start = r.start + padHead;
    const end = r.end - padTail;
    if (end - start > Math.max(minLength, EPS)) out.push({ ...r, start, end });
  }
  return out;
}

/**
 * Toplam atilan sureyi butceye sigdirir.
 * Once guveni yuksek, sonra uzun araliklar kabul edilir; butce dolunca durur.
 */
export function enforceRemovalBudget(removals, duration, maxRemovedRatio = 1) {
  const budget = duration * maxRemovedRatio;
  const ranked = [...(removals || [])].sort((a, b) => {
    const ca = a.confidence ?? 0.5;
    const cb = b.confidence ?? 0.5;
    if (cb !== ca) return cb - ca;
    return b.end - b.start - (a.end - a.start);
  });

  const accepted = [];
  const rejected = [];
  let total = 0;
  for (const r of ranked) {
    const len = r.end - r.start;
    if (total + len <= budget + EPS) {
      accepted.push(r);
      total += len;
    } else {
      rejected.push(r);
    }
  }
  accepted.sort((a, b) => a.start - b.start);
  rejected.sort((a, b) => a.start - b.start);
  return { accepted, rejected, removedSeconds: total, budget };
}

/** Araliklari birlestirir: aradaki bosluk mergeGap'ten kucukse tek parca olur. */
export function mergeCloseKeeps(keeps, mergeGap = 0) {
  const out = [];
  for (const k of keeps) {
    const last = out[out.length - 1];
    if (last && k.start - last.end < mergeGap - EPS) last.end = k.end;
    else out.push({ ...k });
  }
  return out;
}

/** minKeepSegment'ten kisa parcalari atar (aksi halde duyulur bir "tik" olur). */
export function dropTinyKeeps(keeps, minKeepSegment = 0) {
  return keeps.filter((k) => k.end - k.start >= minKeepSegment - EPS);
}

/**
 * Bir araligi en yakin kelime bosluguna oturtur; kelime ortasindan kesmeyi onler.
 * words: [{ start, end, word }] (transkriptten)
 */
export function snapRangeToWordGaps(range, words) {
  if (!words || words.length === 0) return { ...range };
  let start = range.start;
  let end = range.end;
  for (const w of words) {
    if (w.end <= start + EPS || w.start >= end - EPS) continue;
    // Kelime araligin icine tasiyorsa araligi kelimenin disina cek.
    if (w.start < start + EPS) start = Math.max(start, w.end);
    if (w.end > end - EPS) end = Math.min(end, w.start);
  }
  if (end - start <= EPS) return null;
  return { ...range, start, end };
}

/**
 * Tam kesim plani.
 * @returns {{keeps: Array, removed: Array, rejected: Array, sourceDuration: number,
 *            outputDuration: number, removedSeconds: number, removedRatio: number}}
 */
export function buildCutPlan({ duration, removals = [], words = null, options = {} }) {
  const {
    padHead = 0,
    padTail = 0,
    minSilence = 0,
    minKeepSegment = 0,
    mergeGap = 0,
    maxRemovedRatio = 1,
  } = options;

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Gecersiz kaynak suresi: ${duration}`);
  }

  let candidates = normalizeRanges(removals, duration);
  candidates = padRemovals(candidates, padHead, padTail, minSilence * 0.5);
  if (words) {
    candidates = candidates.map((r) => snapRangeToWordGaps(r, words)).filter(Boolean);
  }
  candidates = normalizeRanges(candidates, duration);

  const { accepted, rejected, budget } = enforceRemovalBudget(
    candidates,
    duration,
    maxRemovedRatio,
  );

  let keeps = invertRanges(accepted, duration);
  keeps = mergeCloseKeeps(keeps, mergeGap);
  keeps = dropTinyKeeps(keeps, minKeepSegment);

  if (keeps.length === 0) {
    // Guvenlik agi: her sey atilmis. Kaynagi oldugu gibi tut.
    keeps = [{ start: 0, end: duration }];
  }

  const outputDuration = keeps.reduce((sum, k) => sum + (k.end - k.start), 0);
  const removed = invertRanges(keeps, duration);
  const removedSeconds = duration - outputDuration;

  return {
    keeps,
    removed,
    rejected,
    budget,
    sourceDuration: duration,
    outputDuration,
    removedSeconds,
    removedRatio: removedSeconds / duration,
  };
}

/** Kaynak zamanini cikti zamanina cevirir. Atilmis bolgede ise sonraki parcaya oturur. */
export function remapTime(t, keeps) {
  let offset = 0;
  for (const k of keeps) {
    if (t < k.start) return offset; // atilan bosluktayiz -> parcanin basina otur
    if (t <= k.end + EPS) return offset + (t - k.start);
    offset += k.end - k.start;
  }
  return offset; // sonun otesi
}

/**
 * Kaynak araligini cikti zaman cizgisine tasir.
 * Aralik tamamen atilmissa null doner.
 */
export function projectRange(start, end, keeps) {
  let overlapStart = null;
  let overlapEnd = null;
  for (const k of keeps) {
    const s = Math.max(start, k.start);
    const e = Math.min(end, k.end);
    if (e - s > EPS) {
      if (overlapStart === null) overlapStart = s;
      overlapEnd = e;
    }
  }
  if (overlapStart === null) return null;
  return { start: remapTime(overlapStart, keeps), end: remapTime(overlapEnd, keeps) };
}
