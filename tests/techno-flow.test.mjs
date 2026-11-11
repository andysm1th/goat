import test from "node:test";
import assert from "node:assert/strict";
import { clearCache } from "@chenglou/pretext";
import { TechnoFlow } from "../src/player/techno/flow.ts";

// Real Pretext layout over a deterministic 6px-per-letter font.
const ADVANCE = 6;
const canvas = () => {
  globalThis.OffscreenCanvas = class {
    getContext() {
      return {
        font: "",
        measureText: (text) => ({
          width: [...text].filter((c) => c !== "​").length * ADVANCE,
        }),
      };
    }
  };
  clearCache();
};
const visible = (text) => text.replaceAll("​", "");
const PHRASE = "RUNNING GOAT";
const TAPE = `${PHRASE} `.repeat(200);

function lay(flow, length, obstacles, minSlot = ADVANCE) {
  const out = [];
  const count = flow.layout(length, obstacles, minSlot, out);
  return out
    .slice(0, count)
    .map((segment) => ({ ...segment, text: visible(segment.text) }));
}

test("a line fills right up to an obstacle and carries on with the next letter after it", () => {
  canvas();
  const flow = new TechnoFlow(PHRASE, "test", 2000);
  flow.resize(1);
  const [above, below, ...rest] = lay(flow, 600, [[120, 300]]);
  assert.equal(rest.length, 0);
  assert.equal(above.at, 0);
  assert.equal(below.at, 300);
  assert.ok(
    above.text.length * ADVANCE <= 120 &&
      (above.text.length + 1) * ADVANCE > 120 - ADVANCE,
    "The stretch above is filled to the contour",
  );
  // Nothing is hidden behind the obstacle: the two stretches read on from each other.
  const joined = above.text + below.text;
  assert.ok(
    TAPE.includes(joined) ||
      TAPE.replaceAll(" ", "").includes(joined.replaceAll(" ", "")),
    joined,
  );
  assert.ok(below.text.length * ADVANCE <= 300);
});

test("stretches shorter than the minimum stay empty and the text is not consumed by them", () => {
  canvas();
  const flow = new TechnoFlow(PHRASE, "test", 2000);
  flow.resize(1);
  const open = lay(flow, 300, [[]]);
  const pinched = lay(flow, 300, [[60, 100, 104, 200]], 12);
  assert.equal(pinched.length, 2);
  assert.ok(
    TAPE.replaceAll(" ", "").includes(
      (pinched[0].text + pinched[1].text).replaceAll(" ", ""),
    ),
  );
  assert.ok(open[0].text.startsWith(pinched[0].text.trimEnd().slice(0, 5)));
});

test("advancing slides a tape smoothly down and wraps through the phrase", () => {
  canvas();
  const flow = new TechnoFlow(PHRASE, "test", 2000);
  flow.resize(1);
  const before = lay(flow, 240, [[]])[0];
  flow.advance(2.5);
  const nudged = lay(flow, 240, [[]])[0];
  // The letter sliding in may bring the space after it along.
  assert.ok(
    nudged.at < 0 && nudged.at > -2 * ADVANCE,
    "A letter is sliding in from the top",
  );
  const letters = (text) => text.replaceAll(" ", "");
  assert.equal(
    letters(nudged.text).slice(1, 10),
    letters(before.text).slice(0, 9),
    "The text moved down by one letter",
  );
  // One whole phrase later every line shows what it showed before.
  const phraseWidth = (PHRASE.length + 1) * ADVANCE;
  flow.advance(phraseWidth / 0.7);
  flow.advance(-phraseWidth / 0.7);
  const back = lay(flow, 240, [[]])[0];
  assert.equal(back.text, nudged.text);
  assert.ok(Math.abs(back.at - nudged.at) < 1e-9);
});

test("lines start at different places and keep them when lines are added", () => {
  canvas();
  const flow = new TechnoFlow(PHRASE, "test", 2000);
  flow.resize(6);
  const six = lay(
    flow,
    300,
    Array.from({ length: 6 }, () => []),
  );
  assert.ok(new Set(six.map((segment) => segment.text)).size > 2);
  flow.resize(9);
  const nine = lay(
    flow,
    300,
    Array.from({ length: 9 }, () => []),
  );
  assert.deepEqual(nine.slice(0, 6), six);
});

test("a long line never runs out of text", () => {
  canvas();
  const flow = new TechnoFlow("GOAT", "test", 3000);
  flow.resize(1);
  const [line] = lay(flow, 3000, [[]]);
  // Full to within a letter (a trailing space is trimmed).
  assert.ok(
    line.text.length >= 3000 / ADVANCE - 1 &&
      line.text.length <= 3000 / ADVANCE,
    String(line.text.length),
  );
  assert.throws(() => new TechnoFlow("   ", "test", 100));
});
