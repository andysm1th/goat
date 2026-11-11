// Techno mode's typography: the film's vertical lines, set as running text.
//
// Every line is a tape of the same phrase sliding down the stage. Where the
// goat (or the ground, or the pointer) is in the way the tape does not pass
// behind it: the line stops at the contour and picks up with its next letter
// on the far side, so nothing is ever hidden. The contour moves every frame,
// so every line is broken again every frame.
//
// Pretext makes that affordable. It segments and measures the text once; after
// that, "how much fits in this many pixels from here on" is arithmetic, with
// no DOM measurement and no reflow.
import { layoutNextLine, prepareWithSegments } from "@chenglou/pretext";
import type { LayoutCursor, PreparedTextWithSegments } from "@chenglou/pretext";

export type FlowSegment = {
  /** Which line, counted in the order `obstacles` was given. */
  line: number;
  /** Where the text starts along the line. Negative while a letter slides in. */
  at: number;
  text: string;
};

type Tape = { unit: number; offset: number; speed: number };

const ZERO_WIDTH_SPACE = "\u200b";
// A fixed scramble of the line number: the same line always gets the same
// start and speed, and neighbouring lines get unrelated ones.
function scramble(line: number, salt: number): number {
  let hash = Math.imul(line + salt, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}
// Lines drift at slightly different rates, like the uneven lines of the film.
const speedOf = (line: number) =>
  0.7 + ((scramble(line, 1) % 1000) / 1000) * 0.6;

export class TechnoFlow {
  private readonly prepared: PreparedTextWithSegments;
  /** Segments in one copy of the phrase. */
  private readonly period: number;
  /** Segment index where each letter of the first copy starts. */
  private readonly units: number[] = [];
  /** Width of each letter together with any space after it. */
  private readonly advances: number[] = [];
  private readonly tapes: Tape[] = [];
  private readonly cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 };

  /** `reach` is the longest line that will ever be laid out, in pixels. */
  constructor(text: string, font: string, reach: number) {
    // A break opportunity between every letter lets a line run right up to
    // the contour instead of stopping a whole word short of it.
    const phrase = text
      .trim()
      .split(/\s+/)
      .map((word) => [...word].join(ZERO_WIDTH_SPACE))
      .join(" ");
    if (!phrase) throw new Error("Techno needs some text to set.");
    const once = prepareWithSegments(`${phrase} `, font, {
      whiteSpace: "pre-wrap",
    });
    let width = 0;
    for (let i = 0; i < once.widths.length; i++) width += once.widths[i]!;
    // Enough copies that a line starting anywhere in the first never runs out.
    const copies = Math.ceil(reach / Math.max(1, width)) + 2;
    this.prepared = prepareWithSegments(`${phrase} `.repeat(copies), font, {
      whiteSpace: "pre-wrap",
    });
    const { kinds, widths } = this.prepared;
    this.period = kinds.length / copies;
    if (!Number.isInteger(this.period))
      throw new Error("The Techno text did not segment evenly.");
    for (let i = 0; i < this.period; i++) {
      if (kinds[i] === "text") {
        this.units.push(i);
        this.advances.push(0);
      }
      if (this.advances.length)
        this.advances[this.advances.length - 1]! += widths[i]!;
    }
    if (!this.units.length) throw new Error("Techno needs some text to set.");
  }

  /** Keep existing lines where they are; start new ones spread through the text. */
  resize(lineCount: number): void {
    for (let line = this.tapes.length; line < lineCount; line++) {
      this.tapes.push({
        unit: scramble(line, 7) % this.units.length,
        offset: 0,
        speed: speedOf(line),
      });
    }
    this.tapes.length = lineCount;
  }

  /**
   * Slide every tape down the stage by `pixels`, scaled by its own speed.
   * With `counter`, every other line runs up instead.
   */
  advance(pixels: number, counter = false): void {
    const count = this.units.length;
    for (let line = 0; line < this.tapes.length; line++) {
      const tape = this.tapes[line]!;
      tape.offset -= pixels * tape.speed * (counter && line & 1 ? -1 : 1);
      while (tape.offset < 0) {
        tape.unit = (tape.unit + count - 1) % count;
        tape.offset += this.advances[tape.unit]!;
      }
      while (tape.offset >= this.advances[tape.unit]!) {
        tape.offset -= this.advances[tape.unit]!;
        tape.unit = (tape.unit + 1) % count;
      }
    }
  }

  /** Jump every tape to a new place in the phrase: a cut, not a slide. */
  scatter(seed: number): void {
    for (let line = 0; line < this.tapes.length; line++) {
      const tape = this.tapes[line]!;
      tape.unit = scramble(line, seed * 31 + 7) % this.units.length;
      tape.offset = 0;
    }
  }

  /**
   * Fill the free stretches of every line. `obstacles[line]` is that line's
   * sorted, merged blocked spans. Only a line's opening letter may be partly
   * off the stage; stretches shorter than `minSlot` stay empty. Entries of
   * `out` are reused; returns how many are valid.
   */
  layout(
    length: number,
    obstacles: readonly (readonly number[])[],
    minSlot: number,
    out: FlowSegment[],
  ): number {
    let count = 0;
    for (let line = 0; line < this.tapes.length; line++) {
      const tape = this.tapes[line]!,
        blocked = obstacles[line] ?? [];
      const cursor = this.cursor;
      cursor.segmentIndex = this.units[tape.unit]!;
      cursor.graphemeIndex = 0;
      let from = 0;
      for (let i = 0; i <= blocked.length && from < length; i += 2) {
        const to = i < blocked.length ? Math.min(length, blocked[i]!) : length;
        const slot = to - from;
        if (slot >= minSlot) {
          // The tape's opening letter is already `offset` pixels past the top.
          const lead = from <= 0 ? tape.offset : 0;
          const laid = layoutNextLine(this.prepared, slot + lead, cursor);
          if (laid) {
            const text = laid.text.trimEnd();
            if (text) {
              const segment = (out[count] ??= { line: 0, at: 0, text: "" });
              segment.line = line;
              segment.at = from - lead;
              segment.text = text;
              count++;
            }
            // Carry on from the same place in the first copy.
            cursor.segmentIndex = laid.end.segmentIndex % this.period;
            cursor.graphemeIndex = laid.end.graphemeIndex;
          }
        }
        if (i < blocked.length) from = Math.max(from, blocked[i + 1]!);
      }
    }
    return count;
  }
}
