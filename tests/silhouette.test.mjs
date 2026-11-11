import test from "node:test";
import assert from "node:assert/strict";
import { packTextFrames } from "../src/player/frames/glyph-codec.ts";
import { inkRuns } from "../src/player/frames/ink-runs.ts";
import {
  columnObstacles,
  addCircle,
  mergeSpans,
} from "../src/player/techno/silhouette.ts";

test("ink runs list every stretch of ink, counting half blocks", () => {
  const frames = [
    "  ██  ▀ \n        \n▄      █",
    "████████\n        \n        ",
  ];
  const bytes = packTextFrames(frames, 8, 3);
  assert.deepEqual(
    [...inkRuns(bytes, 8, 3, 0)],
    [0, 2, 4, 0, 6, 7, 2, 0, 1, 2, 7, 8],
  );
  assert.deepEqual([...inkRuns(bytes, 8, 3, 1)], [0, 0, 8]);
});

const art = {
  left: 100,
  top: 50,
  width: 80,
  height: 60,
  columns: 8,
  rows: 6,
  gapLeft: 0,
  gapRight: 0,
  gapTop: 0,
  gapBottom: 0,
  stripLeft: 20,
  stripRight: 20,
};

test("obstacles map ink to the text lines it crosses and merge down each line", () => {
  // A 2-column, 3-row block at columns 2-3, rows 1-3: x 120-140, y 60-90.
  const runs = Uint16Array.from([1, 2, 4, 2, 2, 4, 3, 2, 4]);
  const lines = columnObstacles(runs, art, 10, 30, 0);
  assert.deepEqual(lines[12], [60, 90]);
  assert.deepEqual(lines[13], [60, 90]);
  assert.deepEqual(lines[11], []);
  assert.deepEqual(lines[14], []);
  const padded = columnObstacles(runs, art, 10, 30, 4);
  assert.deepEqual(
    padded[11],
    [56, 94],
    "The margin reaches the neighbouring line",
  );
});

test("the ground continues below and beside the art with the background", () => {
  const ground = Uint16Array.from([5, 0, 8]);
  const below = columnObstacles(ground, { ...art, gapBottom: 200 }, 10, 30, 0);
  assert.deepEqual(
    below[10],
    [100, 310],
    "The last row runs on to the stage edge",
  );
  const beside = columnObstacles(
    ground,
    { ...art, gapLeft: 30, gapRight: 30 },
    10,
    30,
    0,
  );
  assert.deepEqual(beside[8], [100, 110], "Continued to the left of the art");
  assert.deepEqual(beside[19], [100, 110], "Continued to the right of the art");
  assert.deepEqual(columnObstacles(ground, art, 10, 30, 0)[8], []);
});

test("only the edge strip is repeated beside the art, mirrored then plain", () => {
  // Ink in the left strip at x 105-110 (5-10 px from the edge), and a "goat" at
  // x 130-150, outside the 20 px strip. The gap is 70 px: four tiles.
  const runs = Uint16Array.from([2, 6, 10]);
  const narrow = { ...art, columns: 16, gapLeft: 70 };
  const speck = Uint16Array.from([2, 1, 2]);
  const lines = columnObstacles(speck, narrow, 5, 40, 0);
  const blocked = lines
    .map((spans, line) => (spans.length ? line : -1))
    .filter((line) => line >= 0);
  // Art-relative 5-10 px: itself (line 21), mirrored at 90-95 (18), plain at
  // 65-70 (13), mirrored at 50-55 (10), plain at 25-30 (5).
  assert.deepEqual(blocked, [5, 10, 13, 18, 21]);
  const goat = columnObstacles(runs, narrow, 5, 40, 0);
  assert.ok(
    goat.slice(0, 20).every((spans) => spans.length === 0),
    "Nothing outside the strip is ever repeated",
  );
});

test("the reused output is cleared between calls", () => {
  const out = [];
  columnObstacles(Uint16Array.from([0, 0, 8]), art, 10, 30, 0, out);
  columnObstacles(new Uint16Array(0), art, 10, 30, 0, out);
  assert.ok(out.every((line) => line.length === 0));
});

test("a circle is blocked out of the lines it touches, widest through its middle", () => {
  const lines = Array.from({ length: 10 }, () => []);
  addCircle(lines, 10, 50, 100, 20);
  assert.deepEqual(lines[2], []);
  assert.ok(lines[4][1] - lines[4][0] > lines[3][1] - lines[3][0]);
  assert.deepEqual(mergeSpans([30, 40, 0, 10, 8, 20, 39, 50]), [0, 20, 30, 50]);
});
