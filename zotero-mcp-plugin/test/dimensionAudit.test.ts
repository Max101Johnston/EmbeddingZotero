import { expect } from "chai";
import { VectorStore } from "../src/modules/semantic/vectorStore.ts";

describe("vector dimension audit", () => {
  it("counts every stored dimension and finds mixed items", async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const store = Object.create(VectorStore.prototype) as any;
    store.initialized = true;
    store.db = {
      queryAsync: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("GROUP BY dimensions")) {
          return [
            { dimensions: 1024, vectors: 7, items: 2 },
            { dimensions: 2048, vectors: 11, items: 3 },
          ];
        }
        return [{ item_key: "OLD1" }, { item_key: "MIXED" }];
      },
    };

    expect(await store.getDimensionCounts()).to.deep.equal([
      { dimensions: 1024, vectors: 7, items: 2 },
      { dimensions: 2048, vectors: 11, items: 3 },
    ]);
    expect(await store.getItemKeysWithOtherDimensions(2048)).to.deep.equal(["OLD1", "MIXED"]);
    expect(queries[0].sql).to.include("GROUP BY dimensions");
    expect(queries[1].params).to.deep.equal([2048]);
  });

  it("keeps an old item index when replacement fails before commit", async () => {
    let storedDimensions: number | null = 1024;
    let failInsert = true;
    const store = Object.create(VectorStore.prototype) as any;
    store.initialized = true;
    store.vectorCache = new Map([["OLD1_0", new Float32Array(1024)]]);
    store.cacheMaxSize = 100;
    store.db = {
      executeTransaction: async (operation: () => Promise<void>) => {
        const before = storedDimensions;
        try {
          await operation();
        } catch (error) {
          storedDimensions = before; // SQLite transaction rollback
          throw error;
        }
      },
      queryAsync: async (sql: string, params?: unknown[]) => {
        if (sql.startsWith("DELETE FROM embeddings")) storedDimensions = null;
        if (sql.startsWith("INSERT OR REPLACE INTO embeddings")) {
          if (failInsert) throw new Error("simulated write failure");
          storedDimensions = Number(params![4]);
        }
      },
    };
    const records = [{
      itemKey: "OLD1", chunkId: 0, vector: new Float32Array(2048).fill(0.1),
      language: "en" as const, chunkText: "example",
    }];

    let failed = false;
    try {
      await store.replaceItemVectors("OLD1", records, "hash", "now", "now");
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(storedDimensions).to.equal(1024);
    expect(store.vectorCache.get("OLD1_0").length).to.equal(1024);

    failInsert = false;
    await store.replaceItemVectors("OLD1", records, "hash", "now", "now");
    expect(storedDimensions).to.equal(2048);
    expect(store.vectorCache.get("OLD1_0").length).to.equal(2048);
  });
});
