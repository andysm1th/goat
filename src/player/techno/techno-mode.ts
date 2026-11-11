// Techno mode: the music, the timeline it drives, and the running text.
//
// The player owns the goat; this owns everything Techno adds to it. Each frame
// the player asks how far the goat should move (`advance`) and then hands over
// the goat's silhouette for the text to break around (`paint`).
import { performanceAudit } from "../performance-audit";
import { TechnoFlow } from "./flow";
import type { FlowSegment } from "./flow";
import { addCircle, columnObstacles } from "./silhouette";
import type { ArtBox } from "./silhouette";
import { TechnoTrack, beatsAt, cycleRate, followLoop, kickAt } from "./track";

// The lines of text: how far apart, and how fast they slide (pixels per second
// at the widest pitch). They drift steadily and surge on every beat.
const MIN_PITCH = 11,
  MAX_PITCH = 16,
  LINES_ACROSS = 90;
const DRIFT_SPEED = 22,
  BEAT_SPEED = 420;
// The music is in four-beat bars and eight-bar phrases; the visuals follow.
const BEATS_PER_BAR = 4,
  BARS_PER_PHRASE = 8;
// Longer than any line of text will be: taller than any screen.
const FLOW_REACH = 8000;

type LineElement = {
  element: HTMLSpanElement;
  node: Text;
  text: string;
  x: number;
  y: number;
  shown: boolean;
};

export class TechnoMode {
  /** The running text. It sits behind the goat, filling the stage. */
  readonly element = document.createElement("div");
  private readonly stage: HTMLElement;
  private readonly text: string;
  private readonly track: TechnoTrack;
  private width = 0;
  private height = 0;
  private pitch = MAX_PITCH;
  private flow: TechnoFlow | null = null;
  private font = "";
  private readonly segments: FlowSegment[] = [];
  private readonly obstacles: number[][] = [];
  private readonly lines: LineElement[][] = [];
  /** One container per line, in reading order, so a selection runs line by line. */
  private readonly columns: HTMLElement[] = [];

  private time = 0;
  private fromTop = true;
  private audible = false;
  private slide = 0;
  private bar = -1;
  private counterflow = false;
  private inverted = false;
  private strobe = "";
  private glow = "";

  private bounds: DOMRect | null = null;
  private readonly pointer = { x: 0, y: 0, strength: 0, target: 0 };

  constructor(
    stage: HTMLElement,
    base: string,
    text: string,
    signal: AbortSignal,
  ) {
    this.stage = stage;
    this.text = text;
    this.track = new TechnoTrack(base);
    this.element.className = "flow";
    this.element.setAttribute("aria-hidden", "true");
    // The pointer pushes the text aside.
    stage.addEventListener(
      "pointermove",
      (event) => {
        const bounds = (this.bounds ??= stage.getBoundingClientRect());
        this.pointer.x = event.clientX - bounds.left;
        this.pointer.y = event.clientY - bounds.top;
        this.pointer.target = 1;
      },
      { signal, passive: true },
    );
    stage.addEventListener(
      "pointerleave",
      () => {
        this.pointer.target = 0;
      },
      { signal },
    );
    window.addEventListener(
      "scroll",
      () => {
        this.bounds = null;
      },
      { signal, passive: true, capture: true },
    );
    // A late-loading web font changes every measurement.
    document.fonts?.addEventListener(
      "loadingdone",
      () => {
        this.font = "";
      },
      { signal },
    );
  }

  /** Fetch the track's timing. The audio itself waits for `setAudible`. */
  load(): void {
    this.track.load().catch(() => {});
  }

  /** Download and decode the music too, ahead of the first click. */
  preload(): void {
    this.track.preload();
  }

  /** Begin a new session: the timeline and the music start from the top. */
  restart(): void {
    this.time = 0;
    this.fromTop = true;
    this.bar = -1;
    this.setInverted(false);
  }

  /**
   * Start or stop the music. Call from a user gesture to start. Rejects when
   * the browser blocks audio or the track fails to load.
   */
  setAudible(audible: boolean): Promise<void> {
    if (audible === this.audible) return Promise.resolve();
    this.audible = audible;
    if (!audible) {
      this.track.stop();
      return Promise.resolve();
    }
    return this.track
      .start(() => {
        // The first time it is heard, the music starts from the top.
        if (this.fromTop) {
          this.fromTop = false;
          this.time = 0;
        }
        return this.time;
      })
      .catch((cause) => {
        if (this.audible) {
          this.audible = false;
          throw cause;
        }
      });
  }

  /** The text box is the stage turned a quarter: its x axis runs down the screen. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.bounds = null;
    this.font = "";
    this.pitch = Math.max(MIN_PITCH, Math.min(MAX_PITCH, width / LINES_ACROSS));
    const style = this.element.style;
    style.width = `${height}px`;
    style.height = `${width}px`;
    style.transform = `translateX(${width}px) rotate(90deg)`;
    style.fontSize = `${this.pitch * 0.78}px`;
    style.lineHeight = `${this.pitch}px`;
    for (
      let line = this.columns.length;
      line < Math.ceil(width / this.pitch);
      line++
    ) {
      const column = document.createElement("span");
      column.className = "flow-column";
      this.element.append(column);
      this.columns.push(column);
    }
  }

  /**
   * Move the timeline on by one frame and return how many seconds of the goat's
   * cycle that is worth. While the music is audible the timeline is read from
   * the audio clock, so goat and text follow the sound; in silence it runs on
   * frame time. A whole number of goat cycles spans the music loop, so picture
   * and sound repeat together.
   */
  advance(elapsed: number, cycleSeconds: number): number {
    const tempo = this.track.tempo,
      heard = this.audible ? this.track.position() : null;
    const expected = this.time + elapsed;
    const next =
      heard === null ? expected : followLoop(expected, heard, tempo.loopLength);
    const step = Math.max(0, Math.min(0.25, next - this.time));
    this.time = Math.max(this.time, next);
    const beats = beatsAt(this.time, tempo),
      kick = kickAt(beats);
    this.score(beats, kick);
    this.slide +=
      (step * (DRIFT_SPEED + BEAT_SPEED * kick) * this.pitch) / MAX_PITCH;
    this.pointer.strength +=
      (this.pointer.target - this.pointer.strength) *
      (1 - Math.exp(-elapsed * 8));
    return step * cycleRate(cycleSeconds, tempo);
  }

  /** Break every line of text around this frame's silhouette. */
  paint(runs: Uint16Array | undefined, art: ArtBox): void {
    const flow = this.prepare();
    if (!flow || !runs) return;
    const pitch = this.pitch,
      lineCount = Math.ceil(this.width / pitch);
    const obstacles = columnObstacles(
      runs,
      art,
      pitch,
      lineCount,
      pitch * 0.35,
      this.obstacles,
    );
    if (this.pointer.strength > 0.02) {
      const radius =
        Math.max(40, Math.min(110, Math.min(this.width, this.height) * 0.09)) *
        this.pointer.strength;
      addCircle(obstacles, pitch, this.pointer.x, this.pointer.y, radius);
    }
    flow.advance(this.slide, this.counterflow);
    this.slide = 0;
    const count = flow.layout(this.height, obstacles, pitch, this.segments);
    this.write(count);
    performanceAudit?.record("techno.flowSegments", count);
  }

  /**
   * The running text between two DOM boundary points, one line of output per
   * line on screen, top to bottom.
   */
  textBetween(
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ): string {
    if (!this.element.contains(start) || !this.element.contains(end)) return "";
    const range = document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    const output: string[] = [];
    for (const pool of this.lines) {
      const parts: string[] = [];
      for (const entry of pool ?? []) {
        if (!entry.shown || !range.intersectsNode(entry.node)) continue;
        const from = entry.node === start ? startOffset : 0,
          to = entry.node === end ? endOffset : entry.text.length;
        const text = entry.text.slice(from, to).replaceAll("\u200b", "").trim();
        if (text) parts.push(text);
      }
      if (parts.length) output.push(parts.join(" "));
    }
    return output.join("\n");
  }

  dispose(): void {
    this.track.dispose();
  }

  // Pretext must measure with exactly the font the browser paints, including
  // any family the page supplies through --goat-font-sans.
  private prepare(): TechnoFlow | null {
    // Read after a resize or a font load, not on every frame.
    if (!this.font) {
      const computed = getComputedStyle(this.element);
      this.font = `${computed.fontWeight} ${this.pitch * 0.78}px ${computed.fontFamily}`;
      try {
        this.flow = new TechnoFlow(this.text, this.font, FLOW_REACH);
      } catch {
        this.flow = null;
      }
    }
    this.flow?.resize(Math.ceil(this.width / this.pitch));
    return this.flow;
  }

  // What the picture does with the music. Every beat the lines brighten; every
  // bar they cut to somewhere new in the phrase; and the four phrases of the
  // loop each have a look: lines falling, lines running against each other,
  // the colours traded, and alternate lines strobing on the off-beats.
  private score(beats: number, kick: number): void {
    const bar = Math.floor(beats / BEATS_PER_BAR);
    const phrase = ((Math.floor(bar / BARS_PER_PHRASE) % 4) + 4) % 4;
    if (bar !== this.bar) {
      if (this.bar >= 0) this.flow?.scatter(bar);
      this.bar = bar;
      this.counterflow = phrase === 1 || phrase === 3;
      this.setInverted(phrase === 2);
    }
    const style = this.element.style;
    const glow = (0.66 + 0.34 * kick).toFixed(2);
    if (glow !== this.glow) {
      this.glow = glow;
      style.opacity = glow;
    }
    const strobe =
      phrase !== 3 ? "" : Math.floor(beats * 2) & 1 ? "odd" : "even";
    if (strobe !== this.strobe) {
      this.strobe = strobe;
      style.setProperty("--odd", strobe === "odd" ? ".3" : "1");
      style.setProperty("--even", strobe === "even" ? ".3" : "1");
    }
  }

  private setInverted(inverted: boolean): void {
    if (inverted === this.inverted) return;
    this.inverted = inverted;
    this.stage.classList.toggle("is-inverted", inverted);
  }

  // One element per stretch of text, kept per line so a line's elements stay
  // its own from frame to frame and unchanged text is not rewritten.
  private write(count: number): void {
    const pitch = this.pitch,
      used: number[] = [];
    let line = -1,
      ordinal = 0;
    for (let i = 0; i < count; i++) {
      const segment = this.segments[i]!;
      if (segment.line !== line) {
        line = segment.line;
        ordinal = 0;
      }
      const pool = (this.lines[line] ??= []);
      let entry = pool[ordinal];
      if (!entry) {
        const element = document.createElement("span");
        element.className = line & 1 ? "flow-line odd" : "flow-line even";
        const node = document.createTextNode("");
        element.append(node);
        this.columns[line]!.append(element);
        entry = pool[ordinal] = {
          element,
          node,
          text: "",
          x: NaN,
          y: NaN,
          shown: true,
        };
      }
      const y = this.width - (line + 1) * pitch;
      if (entry.text !== segment.text)
        entry.node.data = entry.text = segment.text;
      if (entry.x !== segment.at || entry.y !== y) {
        entry.x = segment.at;
        entry.y = y;
        entry.element.style.transform = `translate(${segment.at}px, ${y}px)`;
      }
      if (!entry.shown) {
        entry.shown = true;
        entry.element.style.display = "";
      }
      used[line] = ++ordinal;
    }
    for (let i = 0; i < this.lines.length; i++) {
      const pool = this.lines[i];
      if (!pool) continue;
      for (let k = used[i] ?? 0; k < pool.length; k++) {
        const entry = pool[k]!;
        if (entry.shown) {
          entry.shown = false;
          entry.element.style.display = "none";
        }
      }
    }
  }
}
