// A cell contains two monochrome samples: top and bottom. These are ordinary
// Unicode block characters, not a custom image font or a browser bitmap.
export const BLOCKS = [" ", "▀", "▄", "█"];

export function pixelsToText(pixels, columns, rows, threshold = 90) {
  if (pixels.length !== columns * rows * 2)
    throw new Error("Unexpected frame size");
  const lines = new Array(rows);
  for (let row = 0; row < rows; row++) {
    let line = "";
    const top = row * 2 * columns;
    const bottom = top + columns;
    for (let x = 0; x < columns; x++) {
      line +=
        BLOCKS[
          Number(pixels[top + x] < threshold) |
            (Number(pixels[bottom + x] < threshold) << 1)
        ];
    }
    lines[row] = line;
  }
  return lines.join("\n");
}
