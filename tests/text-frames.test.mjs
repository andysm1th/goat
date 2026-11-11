import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { pixelsToText } from "../scripts/text-frames.mjs";
import { cyclicPlan } from "../scripts/cyclic-motion.mjs";
import {
  createFrameClock,
  frameAtTime,
  loopTime,
} from "../src/player/frames/animation.ts";
import {
  buildFrameCache,
  buildPackedFrameCache,
  applyTextFrame,
  applyEntrance,
} from "../src/player/frames/frame-cache.ts";
import {
  decodePackedFrame,
  validatePackedFrames,
} from "../src/player/frames/glyph-codec.ts";

test("half-block encoding preserves the position of each dark sample", () => {
  assert.equal(
    pixelsToText(Uint8Array.from([255, 0, 255, 0, 255, 255, 0, 0]), 4, 1),
    " ▀▄█",
  );
});

test("frame selection respects irregular timestamps and holds until the next frame", () => {
  const times = [0, 0.066733, 0.116783, 0.233567];
  assert.equal(frameAtTime(times, 0), 0);
  assert.equal(frameAtTime(times, 0.1), 1);
  assert.equal(frameAtTime(times, 0.233566), 2);
  assert.equal(frameAtTime(times, 0.233567), 3);
  assert.equal(frameAtTime(times, 0.3), 3);
});

test("the animation wraps at the end and keeps elapsed time across repeated loops", () => {
  const duration = 8.1081;
  assert.equal(loopTime(duration, duration), 0);
  assert.ok(Math.abs(loopTime(duration * 50 + 0.2, duration) - 0.2) < 1e-10);
  assert.equal(
    frameAtTime([0, 0.066733, 0.116783], loopTime(duration + 0.08, duration)),
    1,
  );
});

test("the cached renderer handles consecutive frames, skipped frames, and wrapping without stale rows", () => {
  const source = ["▀▄\n██", "▀▄\n  ", "██\n  ", "▀▄\n██"];
  const cache = buildFrameCache(source.join("\f"), 2, 2, source.length);
  const nodes = [{ data: "" }, { data: "" }];
  let previous = -1;
  for (const index of [0, 1, 2, 0, 3, 0, 2, 1]) {
    applyTextFrame(cache, index, previous, nodes);
    assert.equal(nodes.map((node) => node.data).join("\n"), source[index]);
    previous = index;
  }
  assert.equal(applyTextFrame(cache, 1, 1, nodes), 0);
  applyTextFrame(cache, 3, 1, nodes);
  assert.equal(
    applyTextFrame(cache, 0, 3, nodes),
    0,
    "Identical seam frames should produce no DOM writes",
  );
  assert.ok(
    cache.lines.length < source.length * 2,
    "Repeated rows should share storage",
  );
});

test("the entrance resolves into exact source text, including partial-width chunks", () => {
  const row = "▀▄█ ".repeat(50);
  const frame = [row, [...row].reverse().join(""), row].join("\n");
  const cache = buildFrameCache(frame, 200, 3, 1);
  const nodes = Array.from({ length: cache.frames[0].length }, () => ({
    data: "",
  }));
  applyEntrance(cache, 0, -1, nodes);
  assert.notEqual(
    nodes.map((node) => node.data).join(""),
    frame.replaceAll("\n", ""),
  );
  applyEntrance(cache, cache.entrance.length - 1, 0, nodes);
  assert.equal(
    nodes.map((node) => node.data).join(""),
    frame.replaceAll("\n", ""),
  );
  // 200 columns do not divide into whole chunks: the last one is partial.
  assert.equal(cache.chunksPerRow, Math.ceil(200 / cache.chunkSize));
  const partial = 200 % cache.chunkSize;
  assert.ok(partial > 0);
  assert.equal(nodes[cache.chunksPerRow - 1].data.length, partial);
});

test("rounded or early animation timestamps never select a negative entrance frame", () => {
  const frame = "▀▄█ ".repeat(50);
  const cache = buildFrameCache(frame, 200, 1, 1);
  const nodes = Array.from({ length: cache.frames[0].length }, () => ({
    data: "",
  }));
  const elapsed = createFrameClock();
  let time = 0;
  let previous = -1;
  // rAF can start earlier than performance.now() at registration; subsequent
  // rounded timestamps may repeat or move backwards. Pause/resume starts a
  // fresh clock so time spent stopped does not advance the entrance.
  for (const timestamp of [100, 99.9, 100, 116, 116, 115.9, 350, 1050]) {
    const delta = elapsed(timestamp);
    assert.ok(delta >= 0);
    time += delta;
    const index = Math.min(
      cache.entrance.length - 1,
      Math.floor((time / 0.95) * cache.entrance.length),
    );
    applyEntrance(cache, index, previous, nodes);
    previous = index;
  }
  assert.ok(Math.abs(time - 0.95) < 1e-10);
  assert.equal(nodes.map((node) => node.data).join(""), frame);
  assert.equal(createFrameClock()(50000), 0);
});

test("the nine-second cycle follows complete forward strides and keeps the long source movement", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/animation/manifest.json", import.meta.url),
    ),
  );
  const plan = cyclicPlan(manifest.sourceTimestamps);
  assert.equal(manifest.sourceFrameCount, 191);
  assert.equal(manifest.duration, 9);
  assert.equal(manifest.seam.method, "cyclic-phase-aligned-contours");
  assert.equal(manifest.seam.completeStrides, 4);
  assert.equal(manifest.seam.samplingFrameCount, plan.count);
  assert.ok(
    plan.longCount / plan.fps > 6,
    "Do not replace the long run with a short repeated stride",
  );
  const used = manifest.sourceFrameIndices;
  assert.ok(
    manifest.sourceTimestamps[used.at(-1)] -
      manifest.sourceTimestamps[used[0]] >
      7,
  );
  assert.equal(manifest.frameCount, 540);
  for (let i = 0; i < manifest.frameCount; i++) {
    assert.ok(
      Math.abs(
        (manifest.timestamps[i + 1] ?? manifest.duration) -
          manifest.timestamps[i] -
          1 / manifest.playbackFps,
      ) < 1e-10,
    );
  }
});

test("generated text variants have valid hashed assets and keep moving across the wrap", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/animation/manifest.json", import.meta.url),
    ),
  );
  assert.equal(manifest.timestamps.length, manifest.frameCount);
  assert.equal(manifest.timestamps[0], 0);
  assert.ok(manifest.duration > manifest.timestamps.at(-1));
  for (let i = 1; i < manifest.timestamps.length; i++)
    assert.ok(manifest.timestamps[i] > manifest.timestamps[i - 1]);
  for (const variant of manifest.variants) {
    const compressed = await readFile(
      new URL(`../public/animation/${variant.file}`, import.meta.url),
    );
    assert.equal(compressed.length, variant.bytes);
    const digest = createHash("sha256")
      .update(compressed)
      .digest("hex")
      .slice(0, 12);
    assert.equal(
      variant.file,
      `${variant.id}-${digest}.glyphs.gz`,
      "New conversions must not reuse cached asset URLs",
    );
    const bytes = gunzipSync(compressed);
    validatePackedFrames(
      bytes,
      variant.columns,
      variant.rows,
      manifest.frameCount,
    );
    const cache = buildPackedFrameCache(
      bytes,
      variant.columns,
      variant.rows,
      manifest.frameCount,
      false,
    );
    const nodes = Array.from({ length: cache.frames[0].length }, () => ({
      data: "",
    }));
    const frameAt = (index) =>
      decodePackedFrame(
        bytes,
        index,
        variant.columns,
        variant.rows,
        manifest.frameCount,
      );
    const last = frameAt(manifest.frameCount - 1);
    assert.notEqual(
      last,
      frameAt(0),
      "A frozen/copied endpoint is not a continuous motion cycle",
    );
    const unique = new Set();
    const changes = [];
    let previous = last;
    for (let index = 0; index < manifest.frameCount; index++) {
      const frame = frameAt(index);
      applyTextFrame(cache, index, index - 1, nodes);
      assert.equal(
        nodes.map((node) => node.data).join(""),
        frame.replaceAll("\n", ""),
        `${variant.id}: cached text differs from packed source at frame ${index}`,
      );
      unique.add(createHash("sha256").update(frame).digest("hex"));
      const lines = frame.split("\n");
      assert.equal(lines.length, variant.rows);
      assert.ok(lines.every((line) => line.length === variant.columns));
      assert.match(frame, /^[ ▀▄█\n]+$/u);
      let changed = 0;
      for (let cell = 0; cell < frame.length; cell++)
        if (frame[cell] !== previous[cell]) changed++;
      changes.push(changed);
      previous = frame;
    }
    assert.equal(
      unique.size,
      manifest.frameCount,
      "Every frame must advance; repeated endpoint holds are not a loop fix",
    );
    assert.ok(changes.every((count) => count > 0));
    // Review complete neighbourhoods around BOTH joins, not just the last-to-
    // first pair or the single largest internal change. This remains a numeric
    // regression check; the phase/contour tests cover how the motion is built.
    const p95 = [...changes].sort((a, b) => a - b)[
      Math.floor(changes.length * 0.95)
    ];
    const internal = Math.round(
      (manifest.seam.longCount / manifest.seam.samplingFrameCount) *
        manifest.frameCount,
    );
    // The blend ends at the join; a couple of frames past it the output is the
    // unblended source again, whose own peaks are not the join's doing.
    for (const join of [0, internal])
      for (let delta = -6; delta <= 2; delta++) {
        const index = (join + delta + changes.length) % changes.length;
        assert.ok(
          changes[index] <= p95 * 1.1,
          `${variant.id}: excessive change near join at frame ${index}`,
        );
      }
  }
});

test("README renders the goat in a reasonably sized monospaced block", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const drawing = readme.match(/```text\n([ ▀▄█\n]+)\n```/u)?.[1];
  assert.ok(drawing);
  assert.ok(drawing.split("\n").every((line) => line.length <= 90));
});
