import { expect } from "chai";
import {
  DEFAULT_INDEX_CONCURRENCY,
  getIndexConcurrency,
  INDEX_CONCURRENCY_PREF,
  parseIndexConcurrency,
} from "../src/modules/semantic/indexConcurrency.ts";

describe("index concurrency preference", () => {
  const originalZotero = (globalThis as any).Zotero;

  afterEach(() => {
    (globalThis as any).Zotero = originalZotero;
  });

  it("accepts the full user-selectable range, including 1000", () => {
    expect(parseIndexConcurrency("1")).to.equal(1);
    expect(parseIndexConcurrency("1000")).to.equal(1000);
    expect(parseIndexConcurrency(1000)).to.equal(1000);
    expect(parseIndexConcurrency("1001")).to.equal(null);
    expect(parseIndexConcurrency("0")).to.equal(null);
    expect(parseIndexConcurrency("5.5")).to.equal(null);
    expect(parseIndexConcurrency("")).to.equal(null);
  });

  it("uses the saved preference and falls back to five for invalid values", () => {
    let saved: unknown = 1000;
    (globalThis as any).Zotero = {
      Prefs: {
        get: (key: string) => {
          expect(key).to.equal(INDEX_CONCURRENCY_PREF);
          return saved;
        },
      },
    };
    expect(getIndexConcurrency()).to.equal(1000);
    saved = -1;
    expect(getIndexConcurrency()).to.equal(DEFAULT_INDEX_CONCURRENCY);
  });
});
