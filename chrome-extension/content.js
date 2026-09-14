/**
 * YouTube Studio yukleme formunu doldurur.
 *
 * Bilerek yapmadigi sey: yayinlama. "Yayinla" / "Kaydet" dugmelerine dokunmaz.
 * Alanlari doldurur, kararı sana birakir.
 *
 * Studio'nun DOM'u sik degisir; her alan icin birkac secici deniyoruz ve
 * basarisiz olani sessizce gecmeyip popup'a bildiriyoruz.
 */

const TITLE_SELECTORS = [
  "#title-textarea #textbox",
  "ytcp-social-suggestions-textbox#title-textarea div#textbox",
  "ytcp-mention-textbox[label='Title'] div#textbox",
  "#title #textbox",
];

const DESCRIPTION_SELECTORS = [
  "#description-textarea #textbox",
  "ytcp-social-suggestions-textbox#description-textarea div#textbox",
  "ytcp-mention-textbox[label='Description'] div#textbox",
  "#description-container #textbox",
];

const TAG_SELECTORS = [
  "ytcp-form-input-container#tags-container input",
  "#tags-container input",
  "input[aria-label*='etiket' i]",
  "input[aria-label*='tag' i]",
];

function findFirst(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * contenteditable alanlara yazmanin guvenilir yolu: secip execCommand ile
 * metin eklemek. Boylece Studio'nun dinledigi input olaylari da tetiklenir.
 */
function setContentEditable(el, text) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const ok = document.execCommand("insertText", false, text);
  if (!ok) {
    // Yedek yol: dogrudan metin ata ve olayi elle tetikle.
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.textContent.trim().length > 0;
}

/** <input> alanlarina React/Polymer'in gorecegi sekilde deger yazar. */
function setInputValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  el.focus();
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value === value;
}

function fillMetadata(metadata) {
  const report = { filled: [], skipped: [] };

  const titleEl = findFirst(TITLE_SELECTORS);
  if (titleEl && metadata.title) {
    setContentEditable(titleEl, metadata.title) ? report.filled.push("baslik") : report.skipped.push("baslik yazilamadi");
  } else if (metadata.title) {
    report.skipped.push("baslik alani bulunamadi");
  }

  const descEl = findFirst(DESCRIPTION_SELECTORS);
  if (descEl && metadata.description) {
    setContentEditable(descEl, metadata.description)
      ? report.filled.push("aciklama (bolumler dahil)")
      : report.skipped.push("aciklama yazilamadi");
  } else if (metadata.description) {
    report.skipped.push("aciklama alani bulunamadi");
  }

  if (metadata.tags && metadata.tags.length) {
    const tagEl = findFirst(TAG_SELECTORS);
    if (tagEl) {
      setInputValue(tagEl, metadata.tags.join(","));
      // Studio virgulden sonra etiketi kutuya cevirir.
      tagEl.dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true }));
      report.filled.push(`${metadata.tags.length} etiket`);
    } else {
      report.skipped.push("etiket alani kapali (once 'Tumunu goster'e bas)");
    }
  }

  return report;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "gelistir:fill") {
    try {
      sendResponse({ ok: true, report: fillMetadata(message.metadata || {}) });
    } catch (err) {
      sendResponse({ ok: false, error: String(err.message || err) });
    }
    return true;
  }
  if (message?.type === "gelistir:probe") {
    sendResponse({
      ok: true,
      hasTitle: Boolean(findFirst(TITLE_SELECTORS)),
      hasDescription: Boolean(findFirst(DESCRIPTION_SELECTORS)),
      hasTags: Boolean(findFirst(TAG_SELECTORS)),
      url: location.href,
    });
    return true;
  }
  return false;
});
