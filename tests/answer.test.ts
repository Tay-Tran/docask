import { describe, expect, it } from "vitest";
import { buildUserPrompt, citedNumbers, demoAnswer, SYSTEM_PROMPT } from "@/lib/answer";

const sources = [
  { id: 11, page: 2, content: "Refunds are issued within 14 days." },
  { id: 12, page: 5, content: "Contact support by email." },
];

describe("answer helpers", () => {
  it("numbers passages and includes the question", () => {
    const p = buildUserPrompt("How long do refunds take?", sources);
    expect(p).toContain('<passage index="1" page="2">\nRefunds are issued within 14 days.\n</passage>');
    expect(p).toContain('<passage index="2" page="5">');
    expect(p).toContain("<question>\nHow long do refunds take?\n</question>");
  });

  it("system prompt requires grounding and [n] citations", () => {
    expect(SYSTEM_PROMPT).toMatch(/only/i);
    expect(SYSTEM_PROMPT).toContain("[1]");
  });

  it("extracts unique cited numbers in order", () => {
    expect(citedNumbers("Within 14 days [1]. Email us [2][1].")).toEqual([1, 2]);
    expect(citedNumbers("No citations here.")).toEqual([]);
  });

  it("builds a demo answer from passages with page numbers", () => {
    const a = demoAnswer(sources, "no_key");
    expect(a).toContain("Demo mode");
    expect(a).toContain("[1] (page 2) Refunds are issued within 14 days.");
    expect(demoAnswer(sources, "ai_error")).toContain("AI is unavailable");
  });
});
