import { runWithClientDeadline } from "./clientDeadline";
import { expect } from "chai";
import { Worker as NodeWorker } from "node:worker_threads";
import { buildSync } from "esbuild";
import { resolve } from "node:path";
import {
  VectorSearchPool,
  type SearchWorker,
} from "../src/modules/semantic/vectorSearchPool";
import {
  scoreShard,
  type SearchVector,
} from "../src/modules/semantic/vectorSearchMath";
import {
  getSearchWorkers,
  parseSearchWorkers,
} from "../src/modules/executionPreferences";
import { RequestTaskManager, TaskError } from "../src/modules/requestLifecycle";
import { VectorStore } from "../src/modules/semantic/vectorStore";

function fixture(count = 101): SearchVector[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    dimensions: 3,
    int8: Buffer.from(
      new Int8Array([(index % 13) - 6, (index % 7) - 3, 2]).buffer,
    ).toString("base64"),
  }));
}

describe("parallel vector search", function () {
  this.timeout(10000);
  const pools: VectorSearchPool[] = [];
  let workerCode: string;
  before(() => {
    const bundle = buildSync({
      entryPoints: [resolve("src/modules/semantic/vectorSearchWorker.ts")],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "firefox115",
    });
    workerCode =
      `const { parentPort } = require('node:worker_threads');
      globalThis.self = {
        addEventListener: (_type, fn) => parentPort.on('message', data => fn({data})),
        postMessage: data => parentPort.postMessage(data)
      };\n` + bundle.outputFiles[0].text;
  });
  afterEach(() => {
    for (const pool of pools.splice(0)) pool.dispose();
  });

  function realPool() {
    const ids: number[] = [];
    const pool = new VectorSearchPool(() => {
      const worker = new NodeWorker(workerCode, { eval: true });
      ids.push(worker.threadId);
      return {
        postMessage: (message: any) => worker.postMessage(message),
        addEventListener: (type: string, listener: any) => {
          worker.on(
            type,
            type === "message" ? (data: any) => listener({ data }) : listener,
          );
        },
        terminate: () => {
          void worker.terminate();
        },
      } as SearchWorker;
    });
    pools.push(pool);
    return { pool, ids };
  }

  it("splits a query across four real worker threads and preserves ranking and scores", async () => {
    const { pool, ids } = realPool();
    const rows = fixture();
    const query = new Float32Array([0.4, -0.7, 0.1]);
    const expected = scoreShard(rows, query, 9, -1);
    const actual = await pool.run(4, undefined, (lease) =>
      lease.score(rows, query, 9, -1),
    );
    expect(new Set(ids).size).to.equal(4);
    expect(actual).to.deep.equal(expected);
    await pool.run(4, undefined, (lease) => lease.score(rows, query, 9, -1));
    expect(ids.length).to.equal(4); // worker reuse, without retaining vector data
  });

  it("applies a changed worker count to the next query", async () => {
    const { pool, ids } = realPool();
    await pool.run(4, undefined, (lease) =>
      lease.score(fixture(), new Float32Array([1, 0, 0]), 3, -1),
    );
    await pool.run(2, undefined, (lease) =>
      lease.score(fixture(), new Float32Array([1, 0, 0]), 3, -1),
    );
    expect(ids.length).to.equal(6);
  });

  it("terminates busy workers on timeout and removes an expired query from the queue", async () => {
    let terminated = 0;
    const pool = new VectorSearchPool(() => ({
      postMessage: () => {},
      addEventListener: () => {},
      terminate: () => {
        terminated++;
      },
    }));
    pools.push(pool);
    const manager = new RequestTaskManager();
    const first = runWithClientDeadline(manager, "a", 1, 40, (signal) =>
      pool.run(4, signal, (lease) =>
        lease.score(fixture(), new Float32Array([1, 0, 0]), 3, -1),
      ),
    ).catch((e) => e);
    let queuedRan = false;
    const second = runWithClientDeadline(manager, "a", 2, 10, (signal) =>
      pool.run(4, signal, async () => {
        queuedRan = true;
      }),
    ).catch((e) => e);
    expect((await second).code).to.equal(-32001);
    expect((await first).code).to.equal(-32001);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminated).to.equal(4);
    expect(queuedRan).to.equal(false);
    expect(manager.getStatus()).to.deep.equal({
      active: 0,
      draining: 0,
      limit: 32,
    });
    expect(pool.pending).to.equal(0);
    expect(await pool.run(1, undefined, async () => "next query")).to.equal(
      "next query",
    );
  });

  it("runs the real VectorStore path and preserves Int8 scores and Float32 fallback", async () => {
    const original = (globalThis as any).Zotero;
    const toolkit = (globalThis as any).ztoolkit;
    (globalThis as any).Zotero = { Prefs: { get: () => 4 } };
    (globalThis as any).ztoolkit = { log: () => {} };
    const { pool, ids } = realPool();
    const store = Object.create(VectorStore.prototype) as any;
    const source = fixture().map((vector, index) => ({
      item_key: `ITEM${index}`,
      chunk_id: index,
      vector_int8: vector.int8,
      vector_norm: index % 20 === 0 ? 0 : 1,
      dimensions: 3,
      language: "en",
      chunk_text: `text ${index}`,
    }));
    const f32 = new Float32Array([0.1, 0.5, -0.4]);
    const query = new Float32Array([0.4, -0.7, 0.1]);
    store.initialized = true;
    store.searchPool = pool;
    store.db = {
      valueQueryAsync: async () => source.length,
      queryAsync: async (sql: string) =>
        sql.includes("vectors_f32")
          ? [{ vector: new Uint8Array(f32.buffer) }]
          : source,
    };
    try {
      const quantized = store.quantizeWithNorm(query);
      const normalized = store.prepareQueryVector(query).normalized;
      const expected = source
        .map((row, index) => ({
          index,
          score: row.vector_norm
            ? store.cosineSimilarityInt8WithNorm(
                quantized.int8Data,
                quantized.norm,
                store.bufferToInt8Array(row.vector_int8, 3),
                row.vector_norm,
              )
            : store.cosineSimilarityWithNormalizedQuery(normalized, f32),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, 7);
      const actual = await store.search(query, { topK: 7, minScore: -1 });
      expect(ids.length).to.equal(4);
      expect(actual.map((row: any) => row.itemKey)).to.deep.equal(
        expected.map((row) => `ITEM${row.index}`),
      );
      expect(actual.map((row: any) => row.score)).to.deep.equal(
        expected.map((row) => row.score),
      );
      expect(actual[0].chunkText).to.equal(`text ${expected[0].index}`);
    } finally {
      (globalThis as any).Zotero = original;
      (globalThis as any).ztoolkit = toolkit;
    }
  });

  it("drains an in-flight database query after timeout without issuing later SQL", async () => {
    const original = (globalThis as any).Zotero;
    const toolkit = (globalThis as any).ztoolkit;
    (globalThis as any).Zotero = { Prefs: { get: () => 4 } };
    (globalThis as any).ztoolkit = { log: () => {} };
    const { pool } = realPool();
    const store = Object.create(VectorStore.prototype) as any;
    store.initialized = true;
    store.searchPool = pool;
    let release!: (count: number) => void;
    let calls = 0;
    store.db = {
      valueQueryAsync: () => {
        calls++;
        return new Promise<number>((resolve) => {
          release = resolve;
        });
      },
    };
    const manager = new RequestTaskManager();
    try {
      const first = runWithClientDeadline(manager, "a", 1, 25, (signal) =>
        store.search(new Float32Array([1, 0, 0]), { signal }),
      ).catch((e) => e);
      const second = runWithClientDeadline(manager, "a", 2, 10, (signal) =>
        store.search(new Float32Array([1, 0, 0]), { signal }),
      ).catch((e) => e);
      expect((await second).code).to.equal(-32001);
      expect((await first).code).to.equal(-32001);
      expect(calls).to.equal(1);
      expect(manager.getStatus().draining).to.equal(1);
      release(100);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).to.equal(1);
      expect(pool.pending).to.equal(0);
      expect(manager.getStatus().draining).to.equal(0);
    } finally {
      (globalThis as any).Zotero = original;
      (globalThis as any).ztoolkit = toolkit;
    }
  });

  it("uses four by default and validates worker counts", () => {
    const original = (globalThis as any).Zotero;
    try {
      (globalThis as any).Zotero = { Prefs: { get: () => undefined } };
      expect(getSearchWorkers()).to.equal(4);
      expect(parseSearchWorkers("1")).to.equal(1);
      expect(parseSearchWorkers("32")).to.equal(32);
      for (const invalid of ["", "0", "33", "1.5", "4x", NaN])
        expect(parseSearchWorkers(invalid)).to.equal(null);
    } finally {
      (globalThis as any).Zotero = original;
    }
  });
});
