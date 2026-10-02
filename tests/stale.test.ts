import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, isStale } from "@/lib/stale";

describe("isStale", () => {
  const now = Date.parse("2026-01-01T00:10:00Z");
  it("is false for fresh rows", () => {
    expect(isStale(new Date(now - 1000).toISOString(), now)).toBe(false);
    expect(isStale(new Date(now - STALE_AFTER_MS).toISOString(), now)).toBe(false);
  });
  it("is true past the threshold", () => {
    expect(isStale(new Date(now - STALE_AFTER_MS - 1).toISOString(), now)).toBe(true);
  });
  it("is false for invalid dates", () => {
    expect(isStale("nope", now)).toBe(false);
  });
});
