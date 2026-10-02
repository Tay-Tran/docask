import { describe, expect, it } from "vitest";
import { chunkPages } from "@/lib/chunking";

describe("chunkPages", () => {
  it("keeps short pages as one chunk each with 1-based page numbers", () => {
    expect(chunkPages(["Hello world.", "Second page."])).toEqual([
      { page: 1, content: "Hello world." },
      { page: 2, content: "Second page." },
    ]);
  });

  it("skips empty and whitespace-only pages and collapses whitespace", () => {
    expect(chunkPages(["  ", "a\n\n  b"])).toEqual([{ page: 2, content: "a b" }]);
  });

  it("splits long pages with overlap and never exceeds size", () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkPages([text], { size: 200, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.page).toBe(1);
      expect(c.content.length).toBeLessThanOrEqual(200);
    }
    // consecutive chunks share text (overlap)
    const tail = chunks[0].content.slice(-30);
    expect(chunks[1].content).toContain(tail.split(" ").slice(-1)[0]);
    // nothing lost: last word appears in the last chunk
    expect(chunks.at(-1)!.content).toContain("word299");
  });

  it("does not cut words in half", () => {
    const chunks = chunkPages(["alpha beta gamma delta epsilon zeta eta theta"], { size: 20, overlap: 5 });
    for (const c of chunks) {
      for (const w of c.content.split(" ")) {
        expect(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]).toContain(w);
      }
    }
  });
});
