import { scoreShard, type SearchVector } from "./vectorSearchMath";
declare const self: any;

const workerScope = self as unknown as {
  addEventListener(
    type: string,
    listener: (event: { data: any }) => void,
  ): void;
  postMessage(message: unknown): void;
};

workerScope.addEventListener("message", ({ data }) => {
  const { id, rows, query, topK, minScore } = data as {
    id: number;
    rows: SearchVector[];
    query: Float32Array;
    topK: number;
    minScore: number;
  };
  try {
    workerScope.postMessage({
      id,
      results: scoreShard(rows, query, topK, minScore),
    });
  } catch (error) {
    workerScope.postMessage({ id, error: String(error) });
  }
});
