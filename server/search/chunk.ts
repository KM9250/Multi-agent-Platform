export const CHUNKER_VERSION = "paragraph-utf16-v1";
export const CHUNK_LENGTH = 768;
export const CHUNK_OVERLAP = 96;

function safeBoundary(text: string, index: number): number {
  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
    ? index - 1
    : index;
}

export interface TextRange {
  start: number;
  end: number;
}

/** Coordinates always refer to the input string, including its original line endings. */
export function* chunkRanges(
  text: string,
  memory: boolean,
): Generator<TextRange> {
  let start = 0;
  while (start < text.length) {
    let end = safeBoundary(text, Math.min(start + CHUNK_LENGTH, text.length));
    if (memory && end < text.length) {
      const window = text.slice(start, end);
      let boundary = 0;
      for (const match of window.matchAll(
        /(?:\r?\n){2,}|\r?\n(?=#{1,6}[ \t])/g,
      )) {
        boundary = match.index + match[0].length;
      }
      if (boundary > CHUNK_LENGTH / 2) end = start + boundary;
    }
    yield { start, end };
    if (end === text.length) break;
    start = safeBoundary(text, end - CHUNK_OVERLAP);
  }
}
