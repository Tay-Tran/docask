import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, checkPages, checkQuestion, checkUpload } from "@/lib/plans";

describe("plans", () => {
  it("free limits match the spec", () => {
    expect(PLAN_LIMITS.free).toEqual({ maxDocuments: 3, maxFileBytes: 5 * 1024 * 1024, maxPages: 50, questionsPerDay: 20 });
  });

  it("blocks a 4th free document", () => {
    const r = checkUpload("free", { documentCount: 3, fileBytes: 1000 });
    expect(r).toEqual({ ok: false, reason: "The Free plan allows up to 3 documents. Delete one to upload another." });
  });

  it("blocks files over the size limit", () => {
    const r = checkUpload("free", { documentCount: 0, fileBytes: 5 * 1024 * 1024 + 1 });
    expect(r.ok).toBe(false);
  });

  it("allows a valid upload", () => {
    expect(checkUpload("free", { documentCount: 2, fileBytes: 1024 })).toEqual({ ok: true });
  });

  it("blocks too many pages and too many questions", () => {
    expect(checkPages("free", 51).ok).toBe(false);
    expect(checkPages("free", 50).ok).toBe(true);
    expect(checkQuestion("free", 20)).toEqual({ ok: false, reason: "You've used all 20 questions for today. Try again tomorrow." });
    expect(checkQuestion("pro", 20)).toEqual({ ok: true });
  });
});
