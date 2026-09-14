import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Canli test: gercek gelistir-mcp surecini baslatip Claude Code'un yaptigi
 * gibi stdio uzerinden MCP konusuyoruz. Panel yerine HTTP'den yoklama yapan
 * bir taklit kullaniliyor.
 *
 * Bu test, "Claude Code Premiere'e baglanabiliyor mu" sorusunun Premiere
 * olmadan verilebilecek en yakin cevabi.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.resolve(here, "..", "bin", "gelistir-mcp.js");

function freePort() {
  // Test icin yeterince yuksek, cakisma olasiligi dusuk bir port.
  return 19000 + Math.floor(Math.random() * 4000);
}

async function startMcp() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gelistir-mcp-home-"));
  const port = freePort();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      GELISTIR_PORT: String(port),
      // Arac calistirmak icin anahtar gerekmiyor; sohbet icin gerekir.
      ANTHROPIC_API_KEY: "sk-ant-test",
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "canli-test", version: "1.0.0" });
  await client.connect(transport);

  const tokenFile = path.join(home, ".gelistir", "token");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const base = `http://127.0.0.1:${port}`;

  const api = (method, url, body) =>
    fetch(base + url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  return {
    client,
    api,
    close: async () => {
      await client.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("gelistir-mcp sureci baslar ve araclari listeler", async () => {
  const { client, close } = await startMcp();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("premiere_connection_status"));
    assert.ok(names.includes("premiere_get_sequence"));
    assert.ok(names.includes("premiere_apply_keeps"));
    assert.ok(names.includes("build_cut_plan"));
    assert.ok(names.includes("deliver_youtube_package"));
    assert.ok(tools.length >= 18, `arac sayisi ${tools.length}`);

    // Yikici araclar istemcinin gorecegi sekilde isaretli
    const del = tools.find((t) => t.name === "premiere_delete_clip");
    assert.equal(del.annotations.destructiveHint, true);
  } finally {
    await close();
  }
});

test("panel baglanmadan Premiere araci kurulum adimlarini soyluyor", async () => {
  const { client, close } = await startMcp();
  try {
    const status = await client.callTool({ name: "premiere_connection_status", arguments: {} });
    const payload = JSON.parse(status.content[0].text);
    assert.equal(payload.connected, false);
    assert.match(payload.message, /Pencere > Uzantilar/);

    const res = await client.callTool({ name: "premiere_get_project", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Premiere paneli bagli degil/);
  } finally {
    await close();
  }
});

test("taklit panel baglanip komutu calistirinca sonuc Claude Code'a doner", async () => {
  const { client, api, close } = await startMcp();
  try {
    // Panel baglanir (uzun-yoklama)
    await api("GET", "/host/poll?wait=0");

    const status = await client.callTool({ name: "premiere_connection_status", arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).connected, true);

    // Claude Code araci cagirir; panel komutu alip cevaplar
    const callPromise = client.callTool({
      name: "premiere_get_sequence",
      arguments: { sequenceName: "" },
    });

    const poll = await (await api("GET", "/host/poll?wait=8000")).json();
    assert.equal(poll.commands.length, 1);
    assert.equal(poll.commands[0].fn, "gelistirGetSequence");

    await api("POST", "/host/results", {
      results: [{
        id: poll.commands[0].id,
        content: JSON.stringify({
          ok: true,
          name: "Ana sequence",
          duration: 612.5,
          videoTracks: [{ index: 0, clipCount: 3, clips: [] }],
        }),
      }],
    });

    const res = await callPromise;
    assert.equal(res.isError, undefined);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.name, "Ana sequence");
    assert.equal(payload.duration, 612.5);
  } finally {
    await close();
  }
});

test("panelin bildirdigi Premiere hatasi modele hata olarak ulasiyor", async () => {
  const { client, api, close } = await startMcp();
  try {
    await api("GET", "/host/poll?wait=0");

    const callPromise = client.callTool({ name: "premiere_get_project", arguments: {} });
    const poll = await (await api("GET", "/host/poll?wait=8000")).json();
    await api("POST", "/host/results", {
      results: [{
        id: poll.commands[0].id,
        content: JSON.stringify({ ok: false, error: "Acik proje yok" }),
        isError: true,
      }],
    });

    const res = await callPromise;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Acik proje yok/);
  } finally {
    await close();
  }
});

test("cekirdek araci Premiere olmadan calisiyor (paylasilan durum)", async () => {
  const { client, close } = await startMcp();
  try {
    // Dokum yok: arac yol gosteren hata dondurmeli, surec dusmemeli
    const res = await client.callTool({
      name: "transcript_read",
      arguments: { path: "/videolar/yok.mp4", startSeconds: 0, endSeconds: 30 },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /media_transcribe/);

    // Surec ayakta mi?
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
  } finally {
    await close();
  }
});
