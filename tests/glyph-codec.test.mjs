import test from "node:test";
import assert from "node:assert/strict";
import {
  PACKED_GLYPHS,
  packedByteLength,
  validatePackedFrames,
  packTextFrames,
  decodePackedGlyphs,
  decodePackedFrame,
} from "../src/player/frames/glyph-codec.ts";
import {
  buildFrameCache,
  buildPackedFrameCache,
  applyTextFrame,
  applyEntrance,
  releaseEntrance,
} from "../src/player/frames/frame-cache.ts";

function fixture(columns, rows, count) {
  return Array.from({ length: count }, (_, frame) =>
    Array.from({ length: rows }, (_, row) =>
      Array.from(
        { length: columns },
        (_, x) => PACKED_GLYPHS[(x * 3 + row + frame * (row + 1)) % 4],
      ).join(""),
    ).join("\n"),
  );
}

test("all 256 bytes preserve the palette and low-pair-first ordering", () => {
  assert.deepEqual([...packTextFrames([" ▀▄█"], 4, 1)], [0xe4]);
  for (let byte = 0; byte < 256; byte++) {
    const bytes = Uint8Array.of(byte);
    const expected = Array.from(
      { length: 4 },
      (_, x) => PACKED_GLYPHS[(byte >> (x * 2)) & 3],
    ).join("");
    assert.equal(decodePackedFrame(bytes, 0, 4, 1, 1), expected);
    assert.deepEqual(packTextFrames([expected], 4, 1), bytes);
  }
});

test("packing is continuous across rows and frames, including sub-byte boundaries", () => {
  for (const columns of [1, 2, 3, 4, 5, 63, 64, 65, 200]) {
    for (const count of [1, 2, 3, 5]) {
      const rows = 3,
        frames = fixture(columns, rows, count);
      const packed = packTextFrames(frames, columns, rows);
      assert.equal(packed.byteLength, Math.ceil((columns * rows * count) / 4));
      validatePackedFrames(packed, columns, rows, count);
      for (let frame = 0; frame < count; frame++) {
        assert.equal(
          decodePackedFrame(packed, frame, columns, rows, count),
          frames[frame],
        );
      }
      const continuous = frames.join("").replaceAll("\n", "");
      for (let offset = 0; offset < Math.min(continuous.length, 9); offset++) {
        const length = Math.min(67, continuous.length - offset);
        assert.equal(
          decodePackedGlyphs(packed, offset, length),
          continuous.slice(offset, offset + length),
        );
      }
    }
  }
  // A Uint8Array view must not expose bytes outside its own range.
  const view = Uint8Array.from([255, 0xe4, 255]).subarray(1, 2);
  assert.equal(decodePackedFrame(view, 0, 4, 1, 1), " ▀▄█");
});

test("packed and text cache builders produce identical playback, patch and entrance data", () => {
  for (const columns of [1, 3, 63, 64, 65, 200]) {
    const rows = 3,
      frames = fixture(columns, rows, 5);
    frames[4] = frames[0];
    const textCache = buildFrameCache(
      frames.join("\f"),
      columns,
      rows,
      frames.length,
    );
    const packedCache = buildPackedFrameCache(
      packTextFrames(frames, columns, rows),
      columns,
      rows,
      frames.length,
    );
    assert.deepEqual(packedCache, textCache);
    const nodes = Array.from({ length: packedCache.frames[0].length }, () => ({
      data: "",
    }));
    let previous = -1;
    for (const index of [0, 1, 2, 0, 4, 0, 3, 2]) {
      applyTextFrame(packedCache, index, previous, nodes);
      assert.equal(
        nodes.map((node) => node.data).join(""),
        frames[index].replaceAll("\n", ""),
      );
      previous = index;
    }
    assert.equal(applyTextFrame(packedCache, previous, previous, nodes), 0);
    if (packedCache.entrance.length) {
      applyEntrance(packedCache, packedCache.entrance.length - 1, -1, nodes);
      assert.equal(
        nodes.map((node) => node.data).join(""),
        frames[0].replaceAll("\n", ""),
      );
    }
  }
});

test("truncated, surplus and nonzero padding bytes are rejected before cache construction", () => {
  const valid = packTextFrames(["▀▄█"], 3, 1);
  for (const bytes of [
    new Uint8Array(),
    Uint8Array.of(valid[0], 0),
    Uint8Array.of(valid[0] | 0x40),
  ]) {
    assert.throws(() => validatePackedFrames(bytes, 3, 1, 1));
    assert.throws(() => buildPackedFrameCache(bytes, 3, 1, 1));
    assert.throws(() => decodePackedFrame(bytes, 0, 3, 1, 1));
  }
  for (const count of [1, 2, 3]) {
    const bytes = packTextFrames(["█".repeat(count)], count, 1);
    assert.equal(bytes[0] >> (count * 2), 0);
  }
  assert.throws(() => validatePackedFrames([0], 4, 1, 1));
});

test("different packed chunks with the same numeric hash retain different text", () => {
  // Deliberately collide the two-word hash: this must exercise full-byte
  // verification, not rely on a statistically unlikely random collision.
  const a = 0x12345678,
    b = 0x87654321,
    c = 0x9abcdef0;
  const d = Math.imul(32 ^ a, 16777619) ^ Math.imul(32 ^ c, 16777619) ^ b;
  const bytes = new Uint8Array(16),
    view = new DataView(bytes.buffer);
  [a, b, c, d].forEach((word, i) => view.setUint32(i * 4, word, true));
  const source = [0, 1].map((index) =>
    decodePackedFrame(bytes, index, 32, 1, 2),
  );
  assert.notEqual(source[0], source[1]);
  const cache = buildPackedFrameCache(bytes, 32, 1, 2);
  assert.deepEqual(cache, buildFrameCache(source.join("\f"), 32, 1, 2));
});

test("releasing entrance storage preserves consecutive, skipped and wrapped playback", () => {
  const frames = fixture(208, 3, 5),
    bytes = packTextFrames(frames, 208, 3);
  const cache = buildPackedFrameCache(bytes, 208, 3, frames.length);
  const withoutEntrance = buildPackedFrameCache(
    bytes,
    208,
    3,
    frames.length,
    false,
  );
  assert.ok(cache.lines.length > cache.playbackLineCount);
  assert.equal(withoutEntrance.entrance.length, 0);
  releaseEntrance(cache);
  releaseEntrance(cache);
  assert.deepEqual(cache, withoutEntrance);
  const nodes = Array.from({ length: cache.frames[0].length }, () => ({
    data: "",
  }));
  let previous = -1;
  for (const index of [0, 1, 4, 0, 2, 3]) {
    applyTextFrame(cache, index, previous, nodes);
    assert.equal(
      nodes.map((node) => node.data).join(""),
      frames[index].replaceAll("\n", ""),
    );
    previous = index;
  }
});

test("invalid geometry, frame indices, glyphs and row shapes fail explicitly", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const dimensions of [
      [bad, 1, 1],
      [1, bad, 1],
      [1, 1, bad],
    ]) {
      assert.throws(() => packedByteLength(...dimensions));
      assert.throws(() =>
        validatePackedFrames(Uint8Array.of(0), ...dimensions),
      );
    }
  }
  assert.throws(() => packedByteLength(Number.MAX_SAFE_INTEGER, 2, 1));
  assert.throws(() => packTextFrames([], 4, 1));
  for (const frame of ["xxx", "▀▄", "▀▄██", "▀▄█\n▀▄█", "▀▄\r"]) {
    assert.throws(() => packTextFrames([frame], 3, 1));
  }
  for (const index of [-1, 1, 1.5, NaN, Infinity]) {
    assert.throws(() => decodePackedFrame(Uint8Array.of(0), index, 4, 1, 1));
  }
  for (const range of [
    [-1, 1],
    [0, -1],
    [0, 5],
    [1.5, 1],
    [0, NaN],
    [Infinity, 0],
  ]) {
    assert.throws(() => decodePackedGlyphs(Uint8Array.of(0), ...range));
  }
});
