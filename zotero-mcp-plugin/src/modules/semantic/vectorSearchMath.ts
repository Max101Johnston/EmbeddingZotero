/** Pure scoring code shared by the packaged worker and regression tests. */
export interface SearchVector {
  index: number;
  dimensions: number;
  int8?: string | Uint8Array;
  f32?: Uint8Array;
}

export interface ScoredVector {
  index: number;
  score: number;
}
export const compareScores = (a: ScoredVector, b: ScoredVector): number =>
  b.score - a.score || a.index - b.index;

function decodeInt8(value: string | Uint8Array, dimensions: number): Int8Array {
  if (typeof value !== "string")
    return new Int8Array(value.buffer, value.byteOffset, dimensions);
  const binary = atob(value);
  const result = new Int8Array(dimensions);
  for (let i = 0; i < dimensions && i < binary.length; i++)
    result[i] = binary.charCodeAt(i);
  return result;
}

function similarity(
  query: Int8Array | Float32Array,
  stored: Int8Array | Float32Array,
  normalized: boolean,
): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  const end = query.length - (query.length % 8);
  let i = 0;
  for (; i < end; i += 8) {
    const a0 = query[i],
      a1 = query[i + 1],
      a2 = query[i + 2],
      a3 = query[i + 3];
    const a4 = query[i + 4],
      a5 = query[i + 5],
      a6 = query[i + 6],
      a7 = query[i + 7];
    const b0 = stored[i],
      b1 = stored[i + 1],
      b2 = stored[i + 2],
      b3 = stored[i + 3];
    const b4 = stored[i + 4],
      b5 = stored[i + 5],
      b6 = stored[i + 6],
      b7 = stored[i + 7];
    dot +=
      a0 * b0 +
      a1 * b1 +
      a2 * b2 +
      a3 * b3 +
      a4 * b4 +
      a5 * b5 +
      a6 * b6 +
      a7 * b7;
    if (!normalized)
      normA +=
        a0 * a0 +
        a1 * a1 +
        a2 * a2 +
        a3 * a3 +
        a4 * a4 +
        a5 * a5 +
        a6 * a6 +
        a7 * a7;
    normB +=
      b0 * b0 +
      b1 * b1 +
      b2 * b2 +
      b3 * b3 +
      b4 * b4 +
      b5 * b5 +
      b6 * b6 +
      b7 * b7;
  }
  for (; i < query.length; i++) {
    dot += query[i] * stored[i];
    if (!normalized) normA += query[i] * query[i];
    normB += stored[i] * stored[i];
  }
  const magnitude = Math.sqrt(normalized ? normB : normA * normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}

export function scoreShard(
  rows: SearchVector[],
  query: Float32Array,
  topK: number,
  minScore: number,
): ScoredVector[] {
  if (topK <= 0) return [];
  let normSq = 0,
    maxAbs = 0;
  for (const value of query) {
    normSq += value * value;
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  const norm = Math.sqrt(normSq);
  if (!norm || !Number.isFinite(norm)) return [];
  const scale = maxAbs > 0 ? 127 / maxAbs : 1;
  const quantized = new Int8Array(query.length);
  const normalized = new Float32Array(query.length);
  for (let i = 0; i < query.length; i++) {
    quantized[i] = Math.round(query[i] * scale);
    normalized[i] = query[i] / norm;
  }
  const best: ScoredVector[] = [];
  for (const row of rows) {
    try {
      if (row.dimensions !== query.length) continue;
      let score: number;
      if (row.int8 !== undefined)
        score = similarity(
          quantized,
          decodeInt8(row.int8, row.dimensions),
          false,
        );
      else if (row.f32) {
        const aligned = new Uint8Array(row.dimensions * 4);
        aligned.set(row.f32.subarray(0, aligned.length));
        score = similarity(normalized, new Float32Array(aligned.buffer), true);
      } else continue;
      if (!Number.isFinite(score) || score < minScore) continue;
      const candidate = { index: row.index, score };
      if (best.length < topK) {
        best.push(candidate);
        best.sort(compareScores);
      } else if (compareScores(candidate, best[best.length - 1]) < 0) {
        best[best.length - 1] = candidate;
        best.sort(compareScores);
      }
    } catch {
      /* Match the existing search: skip malformed vector records. */
    }
  }
  return best;
}
