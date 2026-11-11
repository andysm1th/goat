import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  cyclicPlan,
  signedDistance,
  renderFields,
  focusBox,
  extendGround,
} from "../scripts/cyclic-motion.mjs";

test("both joins approach consecutive poses from the same source branch", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/animation/manifest.json", import.meta.url),
    ),
  );
  const plan = cyclicPlan(manifest.sourceTimestamps);
  for (const end of [plan.longCount, plan.count]) {
    const after = plan.samples[end % plan.count];
    const before = plan.samples[end - 1];
    assert.equal(
      before.target + 1,
      after.source,
      "The wrap must continue genuine adjacent source motion",
    );
    assert.ok(
      before.blend > 0.9998,
      "No pose correction should still be landing at the join",
    );
    assert.equal(plan.samples[end - plan.overlap].blend, 0);
    for (let i = end - plan.overlap + 1; i < end; i++) {
      assert.equal(plan.samples[i].source, plan.samples[i - 1].source + 1);
      assert.equal(plan.samples[i].target, plan.samples[i - 1].target + 1);
      assert.ok(plan.samples[i].blend > plan.samples[i - 1].blend);
    }
  }
});

test("signed distances describe the shape contour and preserve its interior/exterior", () => {
  const mask = new Uint8Array(9 * 9);
  for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) mask[y * 9 + x] = 1;
  const field = signedDistance(mask, 9, 9);
  assert.equal(field[4 * 9 + 4], 2);
  assert.equal(field[3 * 9 + 3], 1);
  assert.equal(field[4 * 9 + 2], -1);
  assert.ok(Math.abs(field[2 * 9 + 2] + Math.SQRT2) < 1e-6);
  for (let i = 0; i < mask.length; i++)
    assert.equal(field[i] > 0, Boolean(mask[i]));
});

test("contour interpolation moves a single opaque shape rather than dissolving two silhouettes", () => {
  const width = 64,
    height = 64;
  const shape = (cx) => {
    const mask = Uint8Array.from({ length: width * height }, (_, i) =>
      ((i % width) - cx) ** 2 + (Math.floor(i / width) - 32) ** 2 <= 64 ? 1 : 0,
    );
    return {
      shape: signedDistance(mask, width, height),
      coverage: new Float32Array(width * height).fill(-100),
      geometry: { x: cx, y: 32, sx: 8, sy: 8 },
    };
  };
  const a = shape(18),
    b = shape(46),
    stripe = new Float32Array(width);
  const middle = renderFields(a, b, 0.5, stripe, width, height);
  assert.equal(middle[32 * width + 32], 8);
  assert.equal(middle[32 * width + 18], 180);
  assert.equal(middle[32 * width + 46], 180);
  let spans = 0,
    wasInside = false;
  for (let x = 0; x < width; x++) {
    const inside = middle[32 * width + x] < 90;
    if (inside && !wasInside) spans++;
    wasInside = inside;
  }
  assert.equal(spans, 1);
});

test("pose blends only in a short window at the end of each longer geometry overlap", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/animation/manifest.json", import.meta.url),
    ),
  );
  const plan = cyclicPlan(manifest.sourceTimestamps);
  assert.deepEqual(manifest.seam.poseOverlapFrames, plan.poseOverlap);
  [plan.longCount, plan.count].forEach((end, join) => {
    const window = plan.poseOverlap[join];
    assert.ok(window < plan.overlap);
    for (let i = end - plan.overlap; i < end; i++) {
      const sample = plan.samples[i],
        inWindow = end - i <= window;
      assert.equal(
        sample.pose > 0,
        inWindow && end - i < window,
        `pose weight at ${i}`,
      );
      if (inWindow && end - i < window)
        assert.ok(sample.pose > plan.samples[i - 1].pose);
      assert.ok(
        sample.pose <= sample.blend,
        "Body alignment must lead the pose change",
      );
    }
    assert.ok(plan.samples[end - 1].pose > 0.99);
  });
});

test("thin limbs in different places both survive the middle of a pose blend", () => {
  const width = 64,
    height = 64;
  // The same body with one thin leg, at x=20 in one clip and x=44 in the other.
  const pose = (leg) => {
    const mask = Uint8Array.from({ length: width * height }, (_, i) => {
      const x = i % width,
        y = Math.floor(i / width);
      return (y >= 10 && y < 26 && x >= 12 && x < 52) ||
        (y >= 26 && y < 50 && Math.abs(x - leg) <= 1)
        ? 1
        : 0;
    });
    return {
      shape: signedDistance(mask, width, height),
      coverage: new Float32Array(width * height).fill(-100),
      geometry: { x: 32, y: 18, sx: 10, sy: 5 },
    };
  };
  const a = pose(20),
    b = pose(44),
    stripe = new Float32Array(width);
  const inked = (frame, x) => frame[40 * width + x] < 90;
  const middle = renderFields(a, b, 0.5, stripe, width, height, 0.5);
  assert.ok(
    inked(middle, 20) && inked(middle, 44),
    "Averaging the contours would erase both legs",
  );
  assert.ok(!inked(middle, 32));
  const start = renderFields(a, b, 0.5, stripe, width, height, 0);
  assert.ok(
    inked(start, 20) && !inked(start, 44),
    "Before the pose window only the outgoing clip is shown",
  );
  const end = renderFields(a, b, 1, stripe, width, height, 1);
  assert.ok(!inked(end, 20) && inked(end, 44));
});

test("the focus box bounds the animal and ignores ground and stray specks", async () => {
  const columns = 40,
    rows = 20;
  const frame = (shift) =>
    Array.from({ length: rows }, (_, y) =>
      Array.from({ length: columns }, (_, x) => {
        if (y >= 18) return "█"; // ground
        if (y >= 4 && y < 16 && x >= 10 + shift && x < 24 + shift) return "█"; // animal
        if (y === 1 && x === 0) return "▀"; // a speck
        return " ";
      }).join(""),
    ).join("\n");
  const box = focusBox([frame(0), frame(2), frame(4)], columns, rows);
  assert.deepEqual(box, {
    left: 0.25,
    right: 0.7,
    top: 0.2,
    bottom: 0.965,
    centre: 0.475,
  });
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/animation/manifest.json", import.meta.url),
    ),
  );
  assert.ok(
    manifest.focus.left < manifest.focus.centre &&
      manifest.focus.centre < manifest.focus.right,
  );
  assert.ok(
    manifest.focus.right - manifest.focus.left > 0.4 &&
      manifest.focus.right - manifest.focus.left < 0.75,
  );
});

test("the floor is continued to both edges at the height it has where it stops", async () => {
  const width = 120,
    height = 100,
    paper = 180;
  // A floor 6 rows deep from x=30 to x=99, with a leg standing on it.
  const draw = () => {
    const frame = Buffer.alloc(width * height, paper);
    for (let y = height - 6; y < height; y++)
      frame.fill(8, y * width + 30, y * width + 100);
    for (let y = 40; y < height; y++)
      frame.fill(8, y * width + 60, y * width + 64);
    return frame;
  };
  const solo = draw(),
    lined = draw();
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x += 4) lined[y * width + x] = 8;
  extendGround(solo, [lined, solo], width, height);
  for (const frame of [solo, lined]) {
    for (let x = 0; x < width; x++)
      for (let y = height - 6; y < height; y++)
        assert.equal(frame[y * width + x], 8, `gap at ${x},${y}`);
  }
  assert.equal(
    solo[(height - 7) * width + 10],
    paper,
    "The continuation is no taller than the floor",
  );
  assert.equal(solo[50 * width + 10], paper);
  assert.equal(solo[50 * width + 61], 8, "The animal is untouched");
  const empty = Buffer.alloc(width * height, paper);
  extendGround(empty, [empty], width, height);
  assert.ok(
    empty.every((value) => value === paper),
    "A frame without a floor is left alone",
  );
});
