export type Chunk = { page: number; content: string };

/**
 * Splits each page into chunks of at most `size` characters on word boundaries,
 * overlapping consecutive chunks by about `overlap` characters. Chunks never span pages,
 * so every chunk can be cited with a single page number.
 */
export function chunkPages(pages: string[], opts: { size?: number; overlap?: number } = {}): Chunk[] {
  const size = opts.size ?? 800;
  const overlap = opts.overlap ?? 150;
  const chunks: Chunk[] = [];

  pages.forEach((raw, index) => {
    const words = raw.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    let start = 0;

    while (start < words.length) {
      let end = start;
      let length = 0;
      while (end < words.length && length + words[end].length + (end > start ? 1 : 0) <= size) {
        length += words[end].length + (end > start ? 1 : 0);
        end++;
      }
      if (end === start) end = start + 1; // a single word longer than `size`

      chunks.push({ page: index + 1, content: words.slice(start, end).join(" ").slice(0, size) });
      if (end >= words.length) break;

      // Step back so the next chunk starts ~`overlap` characters before this one ended.
      let back = end;
      let backLength = 0;
      while (back > start + 1 && backLength + words[back - 1].length + 1 <= overlap) {
        back--;
        backLength += words[back].length + 1;
      }
      start = back;
    }
  });

  return chunks;
}
