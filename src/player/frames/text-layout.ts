import {
  prepareWithSegments,
  layoutWithLines,
  measureNaturalWidth,
} from "@chenglou/pretext";

// All four frame glyphs have the same advance in these named monospace fonts.
// A fixed grid can reuse a single prepared layout for all animation frames: changing
// a cell's glyph changes its ink, but never its line breaking or advance.
export const FONT_FAMILY =
  '"Menlo", "DejaVu Sans Mono", "Consolas", "Liberation Mono", monospace';
export const FONT_SIZE = 12;

export function prepareTextGrid(columns: number, rows: number) {
  const font = `${FONT_SIZE}px ${FONT_FAMILY}`;
  const palette = prepareWithSegments("█\n▀\n▄\n ", font, {
    whiteSpace: "pre-wrap",
  });
  const glyphs = layoutWithLines(palette, 100, FONT_SIZE);
  const advance = glyphs.lines[0]!.width;
  if (
    !(advance > 0) ||
    glyphs.lines
      .slice(0, 3)
      .some((line) => Math.abs(line.width - advance) > 0.05)
  ) {
    throw new Error(
      "This device has no font with evenly spaced Unicode block characters.",
    );
  }
  // Each character encodes two square samples. The row height is consequently
  // twice the glyph advance, independently of a platform's default line-height.
  const lineHeight = advance * 2;
  // Menlo's block ink is shorter than its line box. Measure the ink once so
  // ordinary Unicode blocks join without horizontal gaps. This canvas is only
  // a font-metrics probe: it is never attached or used to render the goat.
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = font;
  const metrics = context.measureText("█");
  // Where the platform's monospace font lacks block elements (some Android
  // builds), the blocks come from a fallback font while the space keeps the
  // primary font's advance. Word spacing pads every space back onto the grid.
  const wordSpacing = advance - context.measureText(" ").width;
  const inkHeight =
    metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
  const fontAscent =
    metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
  const fontDescent =
    metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
  const inkOffset =
    (fontAscent - fontDescent + inkHeight) / 2 -
    metrics.actualBoundingBoxAscent;
  // Every row uses this same monospace width. Preparing a full columns×rows
  // rectangle duplicates line-breaking work; measure one row, then lay out one
  // representative glyph per line with Pretext at the same line height.
  const row = prepareWithSegments("█".repeat(columns), font, {
    whiteSpace: "pre-wrap",
  });
  const width = measureNaturalWidth(row);
  const template = Array.from({ length: rows }, () => "█").join("\n");
  const prepared = prepareWithSegments(template, font, {
    whiteSpace: "pre-wrap",
  });
  const layout = layoutWithLines(prepared, width + 0.5, lineHeight);
  if (layout.lineCount !== rows)
    throw new Error("The text grid wrapped unexpectedly.");
  return {
    width,
    height: layout.height,
    lineHeight,
    font,
    rows: layout.lineCount,
    columns,
    inkHeight,
    inkOffset,
    inkScale: lineHeight / inkHeight,
    wordSpacing,
  };
}
