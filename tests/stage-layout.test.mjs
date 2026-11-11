import test from "node:test";
import assert from "node:assert/strict";
import { layoutStage, DEFAULT_FOCUS } from "../src/player/stage-layout.ts";

const ART = [1920, 1080];
const goat = (layout, focus = DEFAULT_FOCUS) => ({
  left: layout.left + focus.left * layout.width,
  right: layout.left + focus.right * layout.width,
  top: layout.top + focus.top * layout.height,
  bottom: layout.top + focus.bottom * layout.height,
  centre: layout.left + focus.centre * layout.width,
});
const SCREENS = [
  [1440, 900],
  [1920, 1080],
  [390, 844],
  [844, 390],
  [2560, 1080],
  [768, 1024],
  [1024, 768],
  [320, 568],
  [3840, 1600],
];

test("fill keeps the whole goat on screen, centred, on every screen shape", () => {
  for (const [width, height] of SCREENS) {
    const layout = layoutStage(width, height, ...ART);
    const box = goat(layout);
    assert.ok(
      Math.abs(box.centre - width / 2) < 1e-6,
      `${width}×${height}: goat is not centred`,
    );
    assert.ok(
      box.right - box.left <= width * 0.9 + 1e-6,
      `${width}×${height}: goat is too wide`,
    );
    assert.ok(
      box.top >= -1e-6 && box.bottom <= height + 1e-6,
      `${width}×${height}: goat is cut off vertically`,
    );
    assert.ok(
      box.right - box.left >= width * 0.35 ||
        box.bottom - box.top >= height * 0.5,
      `${width}×${height}: goat is too small`,
    );
  }
});

test("fill never leaves a gap it does not report", () => {
  for (const [width, height] of SCREENS) {
    const layout = layoutStage(width, height, ...ART);
    assert.equal(layout.gapLeft, Math.max(0, layout.left));
    assert.equal(layout.gapTop, Math.max(0, layout.top));
    assert.ok(
      Math.abs(
        layout.gapRight - Math.max(0, width - layout.left - layout.width),
      ) < 1e-9,
    );
    assert.ok(
      Math.abs(
        layout.gapBottom - Math.max(0, height - layout.top - layout.height),
      ) < 1e-9,
    );
    // Art taller than the stage stays edge to edge, so the ground cannot float.
    if (layout.height >= height)
      assert.equal(layout.gapTop + layout.gapBottom, 0);
  }
});

test("a 16:9 stage shows the frame at its natural size", () => {
  const layout = layoutStage(1920, 1080, ...ART);
  assert.equal(layout.scale, 1);
  assert.equal(layout.top, 0);
});

test("contain letterboxes the whole frame and reports no gaps to extend into", () => {
  const layout = layoutStage(390, 844, ...ART, DEFAULT_FOCUS, "contain");
  assert.equal(layout.width, 390);
  assert.ok(Math.abs(layout.top - (844 - layout.height) / 2) < 1e-9);
  assert.deepEqual(
    [layout.gapLeft, layout.gapRight, layout.gapTop, layout.gapBottom],
    [0, 0, 0, 0],
  );
});

test("an unmeasured stage yields an empty layout instead of NaN", () => {
  assert.equal(layoutStage(0, 0, ...ART).scale, 0);
});
