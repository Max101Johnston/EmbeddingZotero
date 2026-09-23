import { expect } from "chai";
import { VectorStore } from "../src/modules/semantic/vectorStore.ts";

describe("library index reconciliation", () => {
  const originalToolkit = (globalThis as any).ztoolkit;
  beforeEach(() => {
    (globalThis as any).ztoolkit = { log: () => {} };
  });
  afterEach(() => {
    (globalThis as any).ztoolkit = originalToolkit;
  });

  it("removes every stored row for trashed and merged-away items, including cache-only rows", async () => {
    const tables = new Map([
      ["embeddings", new Set(["LIVE", "TRASHED", "GONE"])],
      ["vectors_f32", new Set(["LIVE", "TRASHED", "GONE"])],
      ["index_status", new Set(["LIVE", "TRASHED", "GONE"])],
      ["content_cache", new Set(["LIVE", "TRASHED", "CACHE_ONLY"])],
    ]);
    const store = Object.create(VectorStore.prototype) as any;
    store.initialized = true;
    store.vectorCache = new Map([
      ["LIVE_0", new Float32Array([1])],
      ["TRASHED_0", new Float32Array([2])],
    ]);
    store.db = {
      queryAsync: async (sql: string, params?: string[]) => {
        if (sql.startsWith("SELECT item_key FROM embeddings UNION")) {
          return [...new Set([...tables.values()].flatMap(keys => [...keys]))]
            .map(item_key => ({ item_key }));
        }
        const table = sql.match(/^DELETE FROM (\w+) WHERE item_key IN /)?.[1];
        if (!table) throw new Error(`Unexpected SQL: ${sql}`);
        for (const key of params || []) tables.get(table)!.delete(key);
      },
      executeTransaction: async (operation: () => Promise<void>) => operation(),
    };

    const removed = await store.pruneToLiveItems(new Set(["LIVE"]));

    expect(removed).to.equal(3);
    for (const keys of tables.values()) expect([...keys]).to.deep.equal(["LIVE"]);
    expect([...store.vectorCache.keys()]).to.deep.equal(["LIVE_0"]);
  });
});
