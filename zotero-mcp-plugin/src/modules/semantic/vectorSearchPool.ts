import {
  SerialTaskQueue,
  TaskError,
  abortReason,
  throwIfAborted,
} from "../requestLifecycle";
import {
  compareScores,
  type SearchVector,
  type ScoredVector,
} from "./vectorSearchMath";

export interface SearchWorker {
  postMessage(message: unknown): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  terminate(): void;
}
interface WorkerSlot {
  worker: SearchWorker;
  pending?: {
    id: number;
    resolve: (value: ScoredVector[]) => void;
    reject: (error: Error) => void;
  };
}
export interface SearchLease {
  score(
    rows: SearchVector[],
    query: Float32Array,
    topK: number,
    minScore: number,
  ): Promise<ScoredVector[]>;
}

/** One bounded queue, one reusable worker group. Vector data is released after every batch. */
export class VectorSearchPool {
  private readonly queue = new SerialTaskQueue(16);
  private readonly factory: () => SearchWorker;
  private slots: WorkerSlot[] = [];
  private sequence = 0;
  private closed = false;
  private failure?: Error;
  constructor(
    factory: () => SearchWorker = () =>
      new Worker(
        "chrome://zotero-mcp-plugin/content/scripts/vector-search-worker.js",
      ),
  ) {
    this.factory = factory;
  }
  get pending(): number {
    return this.queue.size;
  }

  run<T>(
    count: number,
    signal: AbortSignal | undefined,
    operation: (lease: SearchLease) => Promise<T>,
  ): Promise<T> {
    return this.queue.run(async () => {
      if (this.closed) throw new TaskError(-32800, "Search worker pool closed");
      if (!Number.isInteger(count) || count < 1 || count > 32)
        throw new Error("Search worker count must be an integer from 1 to 32");
      if (this.slots.length !== count)
        this.stopWorkers(new Error("Search worker count changed"));
      this.failure = undefined;
      const onAbort = () => this.stopWorkers(abortReason(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        throwIfAborted(signal);
        return await operation({
          score: (rows, query, topK, minScore) =>
            this.score(rows, query, topK, minScore, count, signal),
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    }, signal);
  }

  private ensureWorkers(count: number): void {
    if (this.closed) throw new TaskError(-32800, "Search worker pool closed");
    if (this.failure) throw this.failure;
    try {
      while (this.slots.length < count) {
        const slot: WorkerSlot = { worker: this.factory() };
        this.slots.push(slot);
        slot.worker.addEventListener("message", ({ data }) => {
          if (!slot.pending || data.id !== slot.pending.id) return;
          const pending = slot.pending;
          slot.pending = undefined;
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve(data.results);
        });
        const failed = (event: any) => {
          if (this.slots.includes(slot))
            this.stopWorkers(
              new Error(
                `Vector search worker failed: ${event?.message || "message error"}`,
              ),
            );
        };
        slot.worker.addEventListener("error", failed);
        slot.worker.addEventListener("messageerror", failed);
      }
    } catch (error) {
      this.stopWorkers(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private async score(
    rows: SearchVector[],
    query: Float32Array,
    topK: number,
    minScore: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<ScoredVector[]> {
    throwIfAborted(signal);
    this.ensureWorkers(count);
    const width = Math.ceil(rows.length / count);
    try {
      const shards = this.slots.map(
        (slot, index) =>
          new Promise<ScoredVector[]>((resolve, reject) => {
            const id = ++this.sequence;
            slot.pending = { id, resolve, reject };
            slot.worker.postMessage({
              id,
              rows: rows.slice(index * width, (index + 1) * width),
              query,
              topK,
              minScore,
            });
          }),
      );
      const results = (await Promise.all(shards)).flat();
      throwIfAborted(signal);
      return results.sort(compareScores).slice(0, topK);
    } catch (error) {
      this.stopWorkers(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  private stopWorkers(error: Error): void {
    this.failure = error;
    for (const slot of this.slots.splice(0)) {
      slot.pending?.reject(error);
      slot.pending = undefined;
      try {
        slot.worker.terminate();
      } catch {
        /* Already terminated. */
      }
    }
  }

  dispose(): void {
    this.closed = true;
    this.queue.close();
    this.stopWorkers(new TaskError(-32800, "Search worker pool closed"));
  }
}
