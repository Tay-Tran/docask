export type Source = { id: number; page: number; content: string };

export const SYSTEM_PROMPT = `You answer questions about a document using only the numbered passages provided.
Cite every claim with the passage number in square brackets, like [1] or [2][3].
If the passages do not contain the answer, say "I couldn't find that in this document." and do not guess.
Answer in the language of the question. Keep answers concise: a short paragraph or a few bullet points.`;

export function buildUserPrompt(question: string, sources: Source[]): string {
  const passages = sources
    .map((s, i) => `<passage index="${i + 1}" page="${s.page}">\n${s.content}\n</passage>`)
    .join("\n");
  return `<passages>\n${passages}\n</passages>\n\n<question>\n${question}\n</question>`;
}

export function citedNumbers(answer: string): number[] {
  const found = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) found.add(Number(match[1]));
  return [...found].sort((a, b) => a - b);
}

export function demoAnswer(sources: Source[], reason: "no_key" | "ai_error"): string {
  const header =
    reason === "no_key"
      ? "Demo mode – AI answers are off. Here are the most relevant passages:"
      : "AI is unavailable right now. Here are the most relevant passages:";
  const lines = sources.map((s, i) => `[${i + 1}] (page ${s.page}) ${s.content}`);
  return [header, ...lines].join("\n\n");
}
