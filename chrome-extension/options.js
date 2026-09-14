const DEFAULTS = { port: 8787, token: "" };

async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("port").value = stored.port ?? DEFAULTS.port;
  document.getElementById("token").value = stored.token ?? "";
}

document.getElementById("save").addEventListener("click", async () => {
  const port = Number(document.getElementById("port").value) || DEFAULTS.port;
  const token = document.getElementById("token").value.trim();
  await chrome.storage.local.set({ port, token });

  const msg = document.getElementById("msg");
  msg.textContent = "Kaydedildi, baglanti deneniyor...";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    msg.textContent = res.ok
      ? `Baglanti tamam - model ${data.model}, ffmpeg ${data.ffmpeg ? "var" : "yok"}`
      : `Cekirdek reddetti: ${data.error || res.status}`;
  } catch (err) {
    msg.textContent = `Cekirdege ulasilamadi: ${err.message}`;
  }
});

load();
