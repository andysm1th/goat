// Headerless frame-major, row-major half-block data. Each byte holds four
// palette indices, with the earliest glyph in the lowest two bits.
export const PACKED_GLYPHS = [" ", "▀", "▄", "█"] as const;
const QUADS = Array.from(
  { length: 256 },
  (_, byte) =>
    PACKED_GLYPHS[byte & 3]! +
    PACKED_GLYPHS[(byte >> 2) & 3]! +
    PACKED_GLYPHS[(byte >> 4) & 3]! +
    PACKED_GLYPHS[byte >> 6]!,
);

function glyphCount(columns: number, rows: number, frameCount: number): number {
  if (
    ![columns, rows, frameCount].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    !Number.isSafeInteger(columns * rows * frameCount)
  ) {
    throw new Error("Invalid packed glyph dimensions.");
  }
  return columns * rows * frameCount;
}

export function packedByteLength(
  columns: number,
  rows: number,
  frameCount: number,
): number {
  return Math.ceil(glyphCount(columns, rows, frameCount) / 4);
}

export function validatePackedFrames(
  bytes: Uint8Array,
  columns: number,
  rows: number,
  frameCount: number,
): void {
  const count = glyphCount(columns, rows, frameCount);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== Math.ceil(count / 4)
  ) {
    throw new Error("The packed glyph animation has an invalid byte length.");
  }
  const used = count % 4;
  if (used && bytes[bytes.length - 1]! >> (used * 2) !== 0) {
    throw new Error("The packed glyph animation has nonzero padding.");
  }
}

export function packTextFrames(
  frames: readonly string[],
  columns: number,
  rows: number,
): Uint8Array {
  const bytes = new Uint8Array(packedByteLength(columns, rows, frames.length));
  let offset = 0;
  for (const frame of frames) {
    const lines = frame.split("\n");
    if (
      lines.length !== rows ||
      lines.some((line) => line.length !== columns)
    ) {
      throw new Error("Invalid text frame dimensions.");
    }
    for (const line of lines)
      for (let x = 0; x < columns; x++, offset++) {
        let glyph: number;
        switch (line.charCodeAt(x)) {
          case 32:
            glyph = 0;
            break;
          case 0x2580:
            glyph = 1;
            break;
          case 0x2584:
            glyph = 2;
            break;
          case 0x2588:
            glyph = 3;
            break;
          default:
            throw new Error("The text frame contains an unsupported glyph.");
        }
        const index = Math.floor(offset / 4);
        bytes[index] = bytes[index]! | (glyph << ((offset % 4) * 2));
      }
  }
  return bytes;
}

// Cache construction calls this only for small chunks. The four-glyph table
// avoids allocating a complete decoded animation or one string per glyph.
export function decodePackedGlyphs(
  bytes: Uint8Array,
  start: number,
  length: number,
): string {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start + length > bytes.length * 4
  )
    throw new Error("Invalid packed glyph range.");
  let text = "",
    offset = start;
  const end = start + length;
  while (offset < end && offset % 4) {
    text +=
      PACKED_GLYPHS[(bytes[Math.floor(offset / 4)]! >> ((offset % 4) * 2)) & 3];
    offset++;
  }
  while (offset + 4 <= end) {
    text += QUADS[bytes[offset / 4]!]!;
    offset += 4;
  }
  while (offset < end) {
    text +=
      PACKED_GLYPHS[(bytes[Math.floor(offset / 4)]! >> ((offset % 4) * 2)) & 3];
    offset++;
  }
  return text;
}

// The count is required because a headerless final byte can include padding.
export function decodePackedFrame(
  bytes: Uint8Array,
  index: number,
  columns: number,
  rows: number,
  frameCount: number,
): string {
  validatePackedFrames(bytes, columns, rows, frameCount);
  if (!Number.isInteger(index) || index < 0 || index >= frameCount)
    throw new Error("Invalid packed frame index.");
  const start = index * columns * rows;
  return Array.from({ length: rows }, (_, row) =>
    decodePackedGlyphs(bytes, start + row * columns, columns),
  ).join("\n");
}
