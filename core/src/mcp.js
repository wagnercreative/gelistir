/**
 * MCP sunucusu: Premiere Pro'yu Claude Code'a (veya baska bir MCP
 * istemcisine) baglar.
 *
 *   Claude Code ──stdio──► gelistir-mcp ──HTTP──► gelistir cekirdegi
 *                                                       │
 *                                          uzun-yoklama │
 *                                                       ▼
 *                                            Premiere paneli (CEP)
 *                                            ExtendScript calistirir
 *
 * Arac listesi yerelden (TOOL_SPECS) uretilir; boylece cekirdek henuz
 * ayakta olmasa bile istemci araclari gorebilir. Calistirma ise cekirdege
 * HTTP ile gider.
 *
 * Onay: bu yolda onay kapisi cekirdekte UYGULANMAZ. Surucu Claude Code
 * oldugu icin izin sorusunu o soruyor; yikici araclar annotations ile
 * isaretlenir (destructiveHint) ki istemci dogru sekilde sorsun.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { TOOL_SPECS, toolSpec } from "./agent.js";

export const STATUS_TOOL = "premiere_connection_status";

/** Istemci arayuzunde gorunecek kisa Turkce basliklar. */
const TITLES = {
  premiere_get_project: "Projeyi oku",
  premiere_get_sequence: "Zaman cizgisini oku",
  premiere_get_primary_source: "Kaynak dosyayi bul",
  premiere_apply_keeps: "Kesim planini uygula (yeni sequence)",
  premiere_set_clip_enabled: "Klibi devre disi birak / ac",
  premiere_delete_clip: "Klip sil",
  premiere_trim_clip: "Klibi kirp",
  premiere_set_clip_gain: "Ses kazancini ayarla",
  premiere_add_markers: "Marker koy",
  premiere_set_playhead: "Oynatma kafasini tasi",
  premiere_export_sequence: "Media Encoder'a gonder",
  media_probe: "Medyayi incele",
  media_transcribe: "Konusmayi yaziya cevir",
  media_detect_silence: "Sessizlikleri bul",
  transcript_read: "Dokumu oku",
  build_cut_plan: "Kesim planini kur",
  deliver_youtube_package: "YouTube paketini yaz",
};

const SETUP_HINT =
  "Kurulum: (1) Premiere Pro acik olmali, (2) Pencere > Uzantilar > Gelistir " +
  "panelini ac, (3) panelde 'Premiere bagli' yazmali. Panel cekirdege " +
  "baglanmadan Premiere araclari calismaz.";

export function mcpToolList() {
  const tools = TOOL_SPECS.map((spec) => ({
    name: spec.name,
    title: TITLES[spec.name] || spec.name,
    description: spec.description,
    inputSchema: spec.input_schema,
    annotations: {
      title: TITLES[spec.name] || spec.name,
      readOnlyHint: Boolean(spec.readOnly),
      destructiveHint: Boolean(spec.approval),
      idempotentHint: Boolean(spec.readOnly),
      openWorldHint: false,
    },
  }));

  tools.unshift({
    name: STATUS_TOOL,
    title: "Premiere baglantisini kontrol et",
    description:
      "Premiere panelinin cekirdege bagli olup olmadigini ve bekleyen komut " +
      "sayisini dondurur. Premiere araclari 'bagli degil' hatasi verirse " +
      "once bunu cagir; kurulum adimlarini da dondurur.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: {
      title: "Premiere baglantisini kontrol et",
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  });

  return tools;
}

/** Cekirdege HTTP istemcisi. */
export function createCoreClient({ base, token, fetchImpl = fetch }) {
  async function request(method, path, body) {
    const init = { method, headers: { authorization: `Bearer ${token}` } };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetchImpl(base + path, init);
    } catch (err) {
      throw new Error(
        `Gelistir cekirdegine ulasilamadi (${base}). Terminalde \`gelistir serve\` ` +
          `calisiyor mu? (${err.message})`,
      );
    }

    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Cekirdek gecersiz yanit dondu: ${text.slice(0, 200)}`);
      }
    }
    if (!res.ok) {
      const detail = data.error || `HTTP ${res.status}`;
      const err = new Error(detail);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    request,
    hostStatus: () => request("GET", "/host/status"),
    runTool: (name, input) => request("POST", `/tools/${encodeURIComponent(name)}`, { input }),
  };
}

export function createMcpServer({ core, name = "gelistir", version = "0.1.0" }) {
  const server = new Server(
    { name, version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolList() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    const asText = (payload) => ({
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    });
    const asError = (message) => ({
      content: [{ type: "text", text: String(message) }],
      isError: true,
    });

    if (toolName === STATUS_TOOL) {
      try {
        const { status } = await core.hostStatus();
        return asText({
          ...status,
          message: status.connected
            ? "Premiere paneli bagli; araclar kullanilabilir."
            : `Premiere paneli bagli degil. ${SETUP_HINT}`,
        });
      } catch (err) {
        return asError(`${err.message}\n\n${SETUP_HINT}`);
      }
    }

    const spec = toolSpec(toolName);
    if (!spec) return asError(`Bilinmeyen arac: ${toolName}`);

    try {
      const { result } = await core.runTool(toolName, args);
      return asText(result);
    } catch (err) {
      // Hatayi modele metin olarak veriyoruz; boylece duzeltip devam edebilir.
      const needsPanel = spec.executor === "host" && /bagli degil|koprusu/i.test(err.message);
      return asError(needsPanel ? `${err.message}\n\n${SETUP_HINT}` : err.message);
    }
  });

  return server;
}
