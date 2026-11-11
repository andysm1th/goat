// Which columns of each row of a packed frame hold ink.

/**
 * Ink runs of one packed frame as `[row, start, end)` triples in row order.
 * A cell counts as ink when either of its two half-block samples is set.
 */
export function inkRuns(
  bytes: Uint8Array,
  columns: number,
  rows: number,
  frame: number,
): Uint16Array {
  const runs: number[] = [];
  let offset = frame * columns * rows;
  for (let row = 0; row < rows; row++) {
    let start = -1;
    for (let x = 0; x < columns; x++, offset++) {
      const ink = (bytes[offset >> 2]! >> ((offset & 3) * 2)) & 3;
      if (ink && start < 0) start = x;
      else if (!ink && start >= 0) {
        runs.push(row, start, x);
        start = -1;
      }
    }
    if (start >= 0) runs.push(row, start, columns);
  }
  return Uint16Array.from(runs);
}
