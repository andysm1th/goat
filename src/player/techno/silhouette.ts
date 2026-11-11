// The silhouette as obstacles: where ink blocks each vertical line of text.
// The runs of ink come from the frame worker (frames/ink-runs.ts).

/** Placement of the art on the stage, in stage pixels. */
export type ArtBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** The background continues past these edges, so obstacles do too. */
  gapLeft: number;
  gapRight: number;
  gapTop: number;
  gapBottom: number;
  /** Width of the edge strip that is tiled beyond each side, in stage pixels. */
  stripLeft: number;
  stripRight: number;
};

/**
 * Blocked vertical spans for each line of text, where line `i` covers stage
 * x from `i * pitch` to `(i + 1) * pitch`. Each entry is a flat, sorted,
 * merged `[y0, y1, y0, y1, …]` list; `margin` keeps text clear of the ink.
 * `out` is reused between calls.
 *
 * The fill layout repeats the art's edges: its first and last rows stretch to
 * the top and bottom of the stage and a strip at each side repeats outward. Obstacles
 * follow the ground the same way, downward and sideways, so text never runs
 * over that continued ink. Nothing in the goat-only frames reaches the top.
 */
export function columnObstacles(
  runs: Uint16Array,
  art: ArtBox,
  pitch: number,
  lineCount: number,
  margin: number,
  out: number[][] = [],
): number[][] {
  for (let line = 0; line < lineCount; line++) (out[line] ??= []).length = 0;
  out.length = lineCount;
  const cell = art.width / art.columns,
    rowHeight = art.height / art.rows;
  const right = art.left + art.width;
  // Runs arrive in row order, so each line's spans arrive top to bottom and
  // merge as they are added.
  const add = (x0: number, x1: number, y0: number, y1: number) => {
    const first = Math.max(0, Math.floor((x0 - margin) / pitch));
    const last = Math.min(
      lineCount - 1,
      Math.floor((x1 + margin - 1e-6) / pitch),
    );
    for (let line = first; line <= last; line++) {
      const spans = out[line]!,
        end = spans.length - 1;
      if (end > 0 && y0 - margin <= spans[end]!)
        spans[end] = Math.max(spans[end]!, y1 + margin);
      else spans.push(y0 - margin, y1 + margin);
    }
  };
  for (let i = 0; i < runs.length; i += 3) {
    const row = runs[i]!;
    const x0 = art.left + runs[i + 1]! * cell,
      x1 = art.left + runs[i + 2]! * cell;
    const y0 = art.top + row * rowHeight;
    const y1 =
      row === art.rows - 1 && art.gapBottom > 0
        ? art.top + art.height + art.gapBottom
        : art.top + (row + 1) * rowHeight;
    add(x0, x1, y0, y1);
    // Beyond each side the edge strip repeats, mirrored then plain in turn.
    if (art.gapLeft > 0 && art.stripLeft > 0 && x0 - art.left < art.stripLeft) {
      const near = x0 - art.left,
        far = Math.min(x1 - art.left, art.stripLeft),
        strip = art.stripLeft;
      for (let tile = 0; tile * strip < art.gapLeft; tile++) {
        if (tile % 2 === 0)
          add(
            art.left - tile * strip - far,
            art.left - tile * strip - near,
            y0,
            y1,
          );
        else
          add(
            art.left - (tile + 1) * strip + near,
            art.left - (tile + 1) * strip + far,
            y0,
            y1,
          );
      }
    }
    if (art.gapRight > 0 && art.stripRight > 0 && right - x1 < art.stripRight) {
      const near = right - x1,
        far = Math.min(right - x0, art.stripRight),
        strip = art.stripRight;
      for (let tile = 0; tile * strip < art.gapRight; tile++) {
        if (tile % 2 === 0)
          add(right + tile * strip + near, right + tile * strip + far, y0, y1);
        else
          add(
            right + (tile + 1) * strip - far,
            right + (tile + 1) * strip - near,
            y0,
            y1,
          );
      }
    }
  }
  return out;
}

/** Block a circle (the pointer) out of the lines it touches. */
export function addCircle(
  obstacles: number[][],
  pitch: number,
  x: number,
  y: number,
  radius: number,
): void {
  const first = Math.max(0, Math.floor((x - radius) / pitch));
  const last = Math.min(obstacles.length - 1, Math.floor((x + radius) / pitch));
  for (let line = first; line <= last; line++) {
    const offset = (line + 0.5) * pitch - x;
    const reach = Math.sqrt(Math.max(0, radius * radius - offset * offset));
    if (reach <= 0) continue;
    const spans = obstacles[line]!;
    spans.push(y - reach, y + reach);
    obstacles[line] = mergeSpans(spans);
  }
}

/** Sort and merge overlapping `[start, end]` pairs in a flat list. */
export function mergeSpans(spans: number[]): number[] {
  if (spans.length <= 2) return spans;
  const pairs: [number, number][] = [];
  for (let i = 0; i < spans.length; i += 2)
    pairs.push([spans[i]!, spans[i + 1]!]);
  pairs.sort((a, b) => a[0] - b[0]);
  const merged: number[] = [pairs[0]![0], pairs[0]![1]];
  for (let i = 1; i < pairs.length; i++) {
    const [start, end] = pairs[i]!;
    if (start <= merged[merged.length - 1]!)
      merged[merged.length - 1] = Math.max(merged[merged.length - 1]!, end);
    else merged.push(start, end);
  }
  return merged;
}
