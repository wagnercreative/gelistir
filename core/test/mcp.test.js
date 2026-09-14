import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { mcpToolList, createMcpServer, createCoreClient, STATUS_TOOL } from "../src/mcp.js";
import { TOOL_SPECS } from "../src/agent.js";

/** Cekirdek yerine: cagrilari kaydeder, senaryoya gore cevap verir. */
function stubCore(handlers = {}) {
  const calls = [];
  return {
    calls,
    hostStatus: async () => {
      calls.push({ kind: "status" });
      if (handlers.hostStatus) return handlers.hostStatus();
      return { status: { connected: true, queued: 0, running: 0, lastCommand: null } };
    },
    runTool: async (name, input) => {
      calls.push({ kind: "tool", name, input });
      if (handlers.runTool) return handlers.runTool(name, input);
      return { tool: name, result: { ok: true, name } };
    },
  };
}

/** Sunucuyu gercek bir MCP istemcisine bagla (bellek uzerinden). */
async function connect(core) {
  const server = createMcpServer({ core });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, close: () => Promise.all([client.close(), server.close()]) };
}

// ---------------------------------------------------------------- arac listesi

test("arac listesi her araci ve baglanti kontrolunu iceriyor", () => {
  const tools = mcpToolList();
  assert.equal(tools.length, TOOL_SPECS.length + 1);
  assert.equal(tools[0].name, STATUS_TOOL, "baglanti kontrolu ilk sirada");
  for (const spec of TOOL_SPECS) {
    assert.ok(tools.some((t) => t.name === spec.name), `${spec.name} listede yok`);
  }
});

test("her aracin semasi, basligi ve annotations'i var", () => {
  for (const tool of mcpToolList()) {
    assert.ok(tool.description.length > 30, tool.name);
    assert.ok(tool.title && tool.title.length > 3, `${tool.name}: baslik eksik`);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
    assert.equal(typeof tool.annotations.destructiveHint, "boolean", tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
  }
});

test("yikici araclar destructiveHint, okuma araclari readOnlyHint tasiyor", () => {
  const byName = new Map(mcpToolList().map((t) => [t.name, t]));

  for (const name of ["premiere_delete_clip", "premiere_trim_clip",
                      "premiere_export_sequence", "deliver_youtube_package"]) {
    assert.equal(byName.get(name).annotations.destructiveHint, true, name);
    assert.equal(byName.get(name).annotations.readOnlyHint, false, name);
  }
  for (const name of ["premiere_get_sequence", "premiere_get_project", "transcript_read",
                      "build_cut_plan", STATUS_TOOL]) {
    assert.equal(byName.get(name).annotations.readOnlyHint, true, name);
    assert.equal(byName.get(name).annotations.destructiveHint, false, name);
  }
});

// ---------------------------------------------------------------- istemci ile

test("MCP istemcisi araclari listeleyebiliyor", async () => {
  const { client, close } = await connect(stubCore());
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, TOOL_SPECS.length + 1);
    const sequence = tools.find((t) => t.name === "premiere_get_sequence");
    assert.ok(sequence.inputSchema.properties.sequenceName);
    assert.equal(sequence.annotations.readOnlyHint, true);
  } finally {
    await close();
  }
});

test("arac cagrisi cekirdege gidiyor, sonuc metin olarak donuyor", async () => {
  const core = stubCore({
    runTool: async () => ({ result: { ok: true, name: "Ana", duration: 40 } }),
  });
  const { client, close } = await connect(core);
  try {
    const res = await client.callTool({
      name: "premiere_get_sequence",
      arguments: { sequenceName: "Ana" },
    });
    assert.equal(res.isError, undefined);
    const payload = JSON.parse(res.content[0].text);
    assert.deepEqual(payload, { ok: true, name: "Ana", duration: 40 });
    assert.deepEqual(core.calls, [
      { kind: "tool", name: "premiere_get_sequence", input: { sequenceName: "Ana" } },
    ]);
  } finally {
    await close();
  }
});

test("panel bagli degilse hata metnine kurulum adimlari ekleniyor", async () => {
  const core = stubCore({
    runTool: async () => {
      throw new Error("Premiere paneli bagli degil.");
    },
  });
  const { client, close } = await connect(core);
  try {
    const res = await client.callTool({ name: "premiere_get_project", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /bagli degil/);
    assert.match(res.content[0].text, /Pencere > Uzantilar/);
  } finally {
    await close();
  }
});

test("cekirdek araci hatasina kurulum adimi eklenmiyor", async () => {
  const core = stubCore({
    runTool: async () => {
      throw new Error("Bu dosya icin dokum yok. Once media_transcribe cagir.");
    },
  });
  const { client, close } = await connect(core);
  try {
    const res = await client.callTool({
      name: "transcript_read",
      arguments: { path: "/v/a.mp4", startSeconds: 0, endSeconds: 10 },
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /media_transcribe/);
    assert.ok(!res.content[0].text.includes("Uzantilar"), "gereksiz kurulum metni");
  } finally {
    await close();
  }
});

test("cekirdek erisilemezse hata modele anlasilir sekilde doner", async () => {
  const core = stubCore({
    runTool: async () => {
      throw new Error("Gelistir cekirdegine ulasilamadi (http://127.0.0.1:8787).");
    },
  });
  const { client, close } = await connect(core);
  try {
    const res = await client.callTool({ name: "media_probe", arguments: { path: "/v/a.mp4" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /ulasilamadi/);
  } finally {
    await close();
  }
});

test("baglanti kontrolu bagli durumu bildiriyor", async () => {
  const { client, close } = await connect(stubCore());
  try {
    const res = await client.callTool({ name: STATUS_TOOL, arguments: {} });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.connected, true);
    assert.match(payload.message, /kullanilabilir/);
  } finally {
    await close();
  }
});

test("baglanti kontrolu bagli degilken kurulum adimlarini veriyor", async () => {
  const core = stubCore({
    hostStatus: async () => ({ status: { connected: false, queued: 0, running: 0 } }),
  });
  const { client, close } = await connect(core);
  try {
    const res = await client.callTool({ name: STATUS_TOOL, arguments: {} });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.connected, false);
    assert.match(payload.message, /Pencere > Uzantilar/);
  } finally {
    await close();
  }
});

test("bilinmeyen arac adi istisna degil, isError sonucu donduruyor", async () => {
  // MCP kurali: arac hatalari istisna degil, isError:true sonucu olarak doner.
  // Boylece model hatayi gorup duzeltebilir.
  const core = stubCore();
  const { client, close } = await connect(core);
  try {
    const res = await client.callTool({ name: "uydurma_arac", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Bilinmeyen arac: uydurma_arac/);
    assert.deepEqual(core.calls, [], "cekirdege hic gitmedi");
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------- HTTP istemcisi

test("createCoreClient token gonderiyor ve yanit ayristiriyor", async () => {
  const seen = [];
  const core = createCoreClient({
    base: "http://127.0.0.1:9999",
    token: "gizli-token",
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ tool: "x", result: { ok: true } }), { status: 200 });
    },
  });

  const out = await core.runTool("premiere_get_project", { a: 1 });
  assert.deepEqual(out.result, { ok: true });
  assert.equal(seen[0].url, "http://127.0.0.1:9999/tools/premiere_get_project");
  assert.equal(seen[0].init.headers.authorization, "Bearer gizli-token");
  assert.deepEqual(JSON.parse(seen[0].init.body), { input: { a: 1 } });
});

test("createCoreClient arac adini URL icin kodluyor", async () => {
  let seenUrl = "";
  const core = createCoreClient({
    base: "http://127.0.0.1:9999",
    token: "t",
    fetchImpl: async (url) => {
      seenUrl = url;
      return new Response("{}", { status: 200 });
    },
  });
  await core.runTool("garip ad/../yol", {});
  assert.ok(!seenUrl.includes("../"), `kodlanmamis yol: ${seenUrl}`);
  assert.ok(seenUrl.includes("garip%20ad"));
});

test("createCoreClient ag hatasini yol gosteren mesaja ceviriyor", async () => {
  const core = createCoreClient({
    base: "http://127.0.0.1:9999",
    token: "t",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(core.hostStatus(), (err) => {
    assert.match(err.message, /ulasilamadi/);
    assert.match(err.message, /gelistir serve/);
    return true;
  });
});

test("createCoreClient HTTP hatasini cekirdegin mesajiyla veriyor", async () => {
  const core = createCoreClient({
    base: "http://127.0.0.1:9999",
    token: "t",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "Acik proje yok" }), { status: 422 }),
  });
  await assert.rejects(core.runTool("premiere_get_project", {}), (err) => {
    assert.equal(err.message, "Acik proje yok");
    assert.equal(err.status, 422);
    return true;
  });
});

test("createCoreClient JSON olmayan yaniti yakaliyor", async () => {
  const core = createCoreClient({
    base: "http://127.0.0.1:9999",
    token: "t",
    fetchImpl: async () => new Response("<html>proxy hatasi</html>", { status: 200 }),
  });
  await assert.rejects(core.hostStatus(), /gecersiz yanit/);
});
