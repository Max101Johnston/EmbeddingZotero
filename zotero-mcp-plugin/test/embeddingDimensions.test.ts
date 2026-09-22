import { expect } from "chai";
import { EmbeddingService } from "../src/modules/semantic/embeddingService.ts";

const prefix = "extensions.zotero.zotero-mcp-plugin.embedding.";

describe("embedding dimensions", () => {
  const originalZotero = (globalThis as any).Zotero;
  const originalToolkit = (globalThis as any).ztoolkit;

  afterEach(() => {
    (globalThis as any).Zotero = originalZotero;
    (globalThis as any).ztoolkit = originalToolkit;
  });

  function mockZotero(detectedDimensions?: number, responseDimensions?: number) {
    const prefs = new Map<string, any>([
      [`${prefix}apiBase`, "https://dashscope.aliyuncs.com/compatible-mode/v1"],
      [`${prefix}apiKey`, "test-key"],
      [`${prefix}model`, "qwen3.7-text-embedding"],
      [`${prefix}dimensions`, 2048],
    ]);
    if (detectedDimensions) {
      prefs.set(`${prefix}detectedDimensions`, detectedDimensions);
    }
    const requests: any[] = [];
    (globalThis as any).ztoolkit = { log: () => {} };
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => prefs.get(key),
        set: (key: string, value: any) => prefs.set(key, value),
        clear: (key: string) => prefs.delete(key),
      },
      HTTP: {
        request: async (_method: string, _url: string, options: any) => {
          const body = JSON.parse(options.body);
          requests.push(body);
          // DashScope returns its default 1024 dimensions if omitted.
          const dimensions = responseDimensions || body.dimensions || 1024;
          return {
            status: 200,
            response: { data: [{ index: 0, embedding: Array(dimensions).fill(0.1) }] },
          };
        },
      },
    };
    return { prefs, requests };
  }

  it("sends the configured 2048 dimensions for qwen3.7-text-embedding", async () => {
    const { requests } = mockZotero();
    const service = new EmbeddingService();

    const result = await service.embed("test", "en");

    expect(requests[0].dimensions).to.equal(2048);
    expect(result.dimensions).to.equal(2048);
    expect(service.getActualDimensions()).to.equal(2048);
  });

  it("ignores a detected dimension cached under an unknown old configuration", async () => {
    mockZotero(1024);
    const service = new EmbeddingService();
    await service.initialize();

    expect(service.getActualDimensions()).to.equal(2048);
  });

  it("uses the response dimensions when an endpoint ignores the requested size", async () => {
    const { prefs } = mockZotero(undefined, 1024);
    const service = new EmbeddingService();
    await service.embed("test", "en");

    expect(service.getActualDimensions()).to.equal(1024);
    expect(prefs.get(`${prefix}detectedConfig`)).to.be.a("string");

    // The observation remains valid on restart, but a changed setting clears it.
    const restarted = new EmbeddingService();
    await restarted.initialize();
    expect(restarted.getActualDimensions()).to.equal(1024);
    restarted.updateConfig({ dimensions: 1536 });
    expect(restarted.getActualDimensions()).to.equal(1536);
    expect(prefs.has(`${prefix}detectedDimensions`)).to.equal(false);
  });
});
