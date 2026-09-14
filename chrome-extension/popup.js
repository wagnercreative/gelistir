/**
 * Popup: yerel cekirdekten son tamamlanan isin metadata'sini alir,
 * aktif YouTube Studio sekmesine doldurmasi icin content script'e gonderir.
 */
const DEFAULTS = { port: 8787, token: "" };

const els = {
  status: document.getElementById("status"),
  refresh: document.getElementById("refresh"),
  fill: document.getElementById("fill"),
  copy: document.getElementById("copy"),
  meta: document.getElementById("meta"),
};

let current = null;

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function coreFetch(path) {
  const { port, token } = await settings();
  if (!token) throw new Error("Token girilmedi. Ayarlar sayfasindan ekle.");
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Cekirdek gecersiz yanit dondu");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderMeta(metadata, bundleDir) {
  const parts = [];
  parts.push(`<h2>Baslik</h2><p>${escapeHtml(metadata.title || "-")}</p>`);
  if (metadata.chapters?.length) {
    parts.push(`<h2>Bolumler (${metadata.chapters.length})</h2>`);
  }
  if (metadata.tags?.length) {
    parts.push(`<h2>Etiketler (${metadata.tags.length})</h2><p>${escapeHtml(metadata.tags.join(", "))}</p>`);
  }
  parts.push(`<h2>Aciklama</h2><pre>${escapeHtml(metadata.description || "")}</pre>`);
  if (bundleDir) parts.push(`<h2>Paket</h2><pre>${escapeHtml(bundleDir)}</pre>`);
  if (metadata.warnings?.length) {
    parts.push(
      `<div class="warn">Dikkat: ${metadata.warnings.map(escapeHtml).join(" / ")}</div>`,
    );
  }
  els.meta.innerHTML = parts.join("");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function loadLatest() {
  setStatus("Son is aliniyor...");
  els.fill.disabled = true;
  els.copy.disabled = true;
  try {
    const data = await coreFetch("/latest/metadata");
    current = data;
    setStatus(`Is #${data.jobId} hazir - ${data.metadata.durationSeconds} sn`, "ok");
    renderMeta(data.metadata, data.bundleDir);
    els.copy.disabled = false;
    await checkStudioTab();
  } catch (err) {
    current = null;
    els.meta.innerHTML = "";
    setStatus(err.message, "bad");
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function checkStudioTab() {
  const tab = await activeTab();
  if (!tab?.url?.startsWith("https://studio.youtube.com/")) {
    els.fill.disabled = true;
    setStatus(els.status.textContent + " - YouTube Studio sekmesi ac", "ok");
    return;
  }
  try {
    const probe = await chrome.tabs.sendMessage(tab.id, { type: "gelistir:probe" });
    els.fill.disabled = !(probe?.hasTitle || probe?.hasDescription);
    if (els.fill.disabled) {
      setStatus("Studio'da yukleme formu acik degil (once videoyu yukle)", "bad");
    }
  } catch {
    els.fill.disabled = true;
    setStatus("Studio sekmesi yenilenmeli (eklenti yeni kuruldu)", "bad");
  }
}

els.refresh.addEventListener("click", loadLatest);

els.fill.addEventListener("click", async () => {
  if (!current) return;
  const tab = await activeTab();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "gelistir:fill",
      metadata: current.metadata,
    });
    if (!res?.ok) throw new Error(res?.error || "Doldurulamadi");
    const { filled, skipped } = res.report;
    setStatus(
      `Dolduruldu: ${filled.join(", ") || "hicbir alan"}` +
        (skipped.length ? ` | Atlanan: ${skipped.join(", ")}` : ""),
      skipped.length ? "bad" : "ok",
    );
  } catch (err) {
    setStatus(String(err.message || err), "bad");
  }
});

els.copy.addEventListener("click", async () => {
  if (!current) return;
  const text = `${current.metadata.title}\n\n${current.metadata.description}`;
  await navigator.clipboard.writeText(text);
  setStatus("Baslik ve aciklama kopyalandi", "ok");
});

loadLatest();
