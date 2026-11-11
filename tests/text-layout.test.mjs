import test from "node:test";
import assert from "node:assert/strict";
import {
  prepareWithSegments,
  measureNaturalWidth,
  layoutWithLines,
  clearCache,
} from "@chenglou/pretext";
import {
  prepareTextGrid,
  FONT_FAMILY,
  FONT_SIZE,
} from "../src/player/frames/text-layout.ts";

test("representative Pretext rows preserve the full-grid dimensions with fractional monospace metrics", () => {
  // Exercise real Pretext layout with a deterministic canvas-width fixture.
  // This is a layout-equivalence test, not a browser font or paint benchmark.
  let advance = 7.25;
  const context = {
    font: "",
    measureText(text) {
      return {
        width: text.length * advance,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 2,
        fontBoundingBoxAscent: 11,
        fontBoundingBoxDescent: 3,
      };
    },
  };
  globalThis.document = {
    createElement: () => ({ getContext: () => context }),
  };
  try {
    for (const measuredAdvance of [7.25, 7.12345]) {
      advance = measuredAdvance;
      clearCache();
      for (const [columns, rows] of [
        [160, 45],
        [320, 90],
        [640, 180],
        [960, 270],
      ]) {
        const font = `${FONT_SIZE}px ${FONT_FAMILY}`;
        const prepared = prepareWithSegments(
          Array.from({ length: rows }, () => "█".repeat(columns)).join("\n"),
          font,
          { whiteSpace: "pre-wrap" },
        );
        const width = measureNaturalWidth(prepared);
        const full = layoutWithLines(prepared, width + 0.5, advance * 2);
        const actual = prepareTextGrid(columns, rows);
        assert.equal(actual.width, width);
        assert.equal(actual.height, full.height);
        assert.equal(actual.rows, full.lineCount);
        assert.equal(actual.lineHeight, advance * 2);
      }
    }
  } finally {
    delete globalThis.document;
    clearCache();
  }
});
