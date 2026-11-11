// One grid of block glyphs on the stage, plus the text that continues it past
// the edges of the 16:9 art when the stage is a different shape.
import {
  applyEntrance,
  applyTextFrame,
  createTextRows,
} from "./frames/frame-cache";
import type { ChunkNode, FrameCache } from "./frames/frame-cache";
import { FONT_FAMILY, FONT_SIZE } from "./frames/text-layout";
import type { prepareTextGrid } from "./frames/text-layout";

export type TextGrid = ReturnType<typeof prepareTextGrid>;
/** Uncovered stage on each side of the art, in the grid's layout units. */
export type Bleed = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** The part of the art inside the stage, as fractions of its width and height. */
export type Visible = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const ALL_VISIBLE: Visible = { left: 0, right: 1, top: 0, bottom: 1 };
// Writes to chunks that lie wholly outside the stage go here instead.
const UNSEEN: ChunkNode = { data: "" };

/** How much of the art's width at each side the animal never enters, as fractions. */
export type Clear = { left: number; right: number };

const NO_BLEED: Bleed = { left: 0, right: 0, top: 0, bottom: 0 };
/** One row of a side continuation: the same strip of text in every tile. */
type Edge = {
  nodes: Text[];
  slots: number[];
  ids: number[];
  from: number;
  to: number;
};
type Strip = { node: Text; slot: number; id: number; half: 0 | 2 };

// More tiles than any plausible banner needs; beyond this the paper shows.
const MAX_TILES = 64;

// The very top of the frame has a blank corner. The upward extension copies a
// row just below it and covers the rows above, so the lines run on unbroken.
const TOP_REFERENCE = 0.04;

export class TextLayer {
  readonly element = document.createElement("pre");
  /** Unclipped sibling holding the continuation beyond the art. */
  readonly bleed = document.createElement("pre");
  cache: FrameCache | null = null;
  private grid: TextGrid | null = null;
  private nodes: Text[] = [];
  /** `nodes`, with those that cannot be seen replaced by a sink. */
  private live: ChunkNode[] = [];
  private mask = "";
  private painted = -1;
  private entrance = -1;
  private edges: Edge[] = [];
  /** Columns of the strip repeated beyond each side, set by `place`. */
  strip = { left: 0, right: 0 };
  /** Distance between rows, and the vertical stretch that makes it a row height. */
  private pitch = 0;
  private stretch = 1;
  private strips: Strip[] = [];
  private projections = new Map<number, string>();

  constructor(name: string) {
    this.element.className = `goat-text ${name}`;
    this.bleed.className = `goat-text bleed ${name}`;
    this.element.setAttribute("aria-hidden", "true");
    this.bleed.setAttribute("aria-hidden", "true");
  }

  mount(cache: FrameCache, grid: TextGrid): void {
    this.cache = cache;
    this.grid = grid;
    this.nodes = createTextRows(this.element, cache);
    this.live = this.nodes;
    this.mask = "";
    this.projections.clear();
    this.reset();
  }

  /** Forget what is on screen so the next paint writes every changed chunk. */
  reset(): void {
    this.painted = -1;
    this.entrance = -1;
    for (const edge of this.edges) edge.ids.fill(-1);
    for (const strip of this.strips) strip.id = -1;
  }

  /**
   * The grid is laid out at the base font size, where font metrics are exact,
   * and scaled as one block. `scale` is stage pixels per layout unit.
   */
  place(
    scale: number,
    bleed: Bleed = NO_BLEED,
    clear: Clear = { left: 0, right: 0 },
    visible: Visible = ALL_VISIBLE,
  ): void {
    const grid = this.grid;
    if (!grid || !(scale > 0)) return;
    this.cull(visible);
    this.strip = {
      left: Math.max(1, Math.floor(clear.left * grid.columns)),
      right: Math.max(1, Math.floor(clear.right * grid.columns)),
    };
    // Rows sit one ink-height apart and a single transform stretches the whole
    // grid to its row height. Rows meet at fractional device pixels, where two
    // antialiased edges leave a hairline, so they sit a touch closer than that:
    // each row's ink reaches 3/4 of a device pixel under the next.
    const overlap = 1 + 0.75 / (devicePixelRatio * scale) / grid.lineHeight;
    const pitch = (this.pitch = grid.inkHeight / overlap);
    this.stretch = grid.lineHeight / pitch;
    for (const element of [this.element, this.bleed]) {
      const style = element.style;
      style.fontFamily = FONT_FAMILY;
      style.fontSize = `${FONT_SIZE}px`;
      style.lineHeight = `${grid.inkHeight}px`;
      style.wordSpacing = `${grid.wordSpacing}px`;
      style.width = `${grid.width}px`;
      style.height = `${grid.rows * pitch}px`;
      style.transform = `scale(${scale}, ${scale * this.stretch})`;
      style.setProperty("--row-height", `${pitch}px`);
      style.setProperty("--cell-width", `${grid.width / grid.columns}px`);
      style.setProperty("--ink-height", `${grid.inkHeight}px`);
      style.setProperty("--ink-offset", `${grid.inkOffset}px`);
    }
    this.buildBleed(bleed);
  }

  paint(index: number): number {
    const cache = this.cache;
    if (!cache) return 0;
    const writes = applyTextFrame(cache, index, this.painted, this.live);
    this.painted = index;
    this.entrance = -1;
    this.paintBleed(cache.frames[index]!);
    return writes;
  }

  paintEntrance(step: number): void {
    const cache = this.cache;
    if (!cache || !cache.entrance.length) return;
    applyEntrance(cache, step, this.entrance, this.live);
    this.entrance = step;
    this.painted = -1;
    // The continuation takes part in the entrance, so the stage is full from
    // the first frame instead of the art appearing alone.
    this.paintBleed(cache.entrance[step]!);
  }

  /**
   * The grid's text between two DOM boundary points, one line per row. A
   * selection runs through the chunks in reading order, but they are separate
   * positioned elements, so the browser's own copy would join every row into
   * a single line.
   */
  textBetween(
    start: Node,
    startOffset: number,
    end: Node,
    endOffset: number,
  ): string {
    const cache = this.cache;
    if (
      !cache ||
      this.painted < 0 ||
      !this.element.contains(start) ||
      !this.element.contains(end)
    )
      return "";
    const before = document.createRange(),
      after = document.createRange();
    before.setStart(start, startOffset);
    before.collapse(true);
    after.setStart(end, endOffset);
    after.collapse(true);
    // The first chunk that ends after the start, and the last that begins before the end.
    let first = 0,
      last = this.nodes.length - 1;
    while (
      first <= last &&
      before.comparePoint(this.nodes[first]!, this.nodes[first]!.length) < 0
    )
      first++;
    while (last >= first && after.comparePoint(this.nodes[last]!, 0) > 0)
      last--;
    if (first > last) return "";
    // Chunks outside the stage are never written to the DOM; read the frame itself.
    const frame = cache.frames[this.painted]!;
    let text = "";
    for (let slot = first; slot <= last; slot++) {
      const line = cache.lines[frame[slot]!]!;
      const from =
        slot === first && start === this.nodes[slot] ? startOffset : 0;
      const to =
        slot === last && end === this.nodes[slot] ? endOffset : line.length;
      text += line.slice(from, to);
      if (slot < last && (slot + 1) % cache.chunksPerRow === 0) text += "\n";
    }
    return text;
  }

  // The fill layout crops the 16:9 art to the stage, so some chunks can never
  // be seen. Their text is left alone: the browser would lay it out for nothing.
  private cull(visible: Visible): void {
    const cache = this.cache;
    if (!cache) return;
    const firstRow = Math.floor(visible.top * cache.rowCount),
      lastRow = Math.ceil(visible.bottom * cache.rowCount) - 1;
    const firstColumn = visible.left * cache.columns,
      lastColumn = visible.right * cache.columns;
    const seen = (slot: number) => {
      const row = Math.floor(slot / cache.chunksPerRow),
        column = (slot % cache.chunksPerRow) * cache.chunkSize;
      return (
        row >= firstRow &&
        row <= lastRow &&
        column < lastColumn &&
        column + cache.chunkSize > firstColumn
      );
    };
    let first = 0,
      last = cache.chunksPerRow - 1;
    while (first < last && !seen(first)) first++;
    while (last > first && !seen(last)) last--;
    const mask = `${firstRow}:${lastRow}:${first}:${last}`;
    if (mask === this.mask) return;
    this.mask = mask;
    this.live = this.nodes.map((node, slot) => (seen(slot) ? node : UNSEEN));
    // Chunks that have just come into view hold whatever they last showed.
    this.reset();
  }

  // Sides repeat the strip at the art's edge that the animal never enters,
  // alternately mirrored and plain, so lines and floor run on without a seam
  // and no part of the goat is ever repeated. Above and below, one row
  // stretches to the stage edge: the lines are vertical, so it carries them all.
  private buildBleed(bleed: Bleed): void {
    const cache = this.cache,
      grid = this.grid;
    this.edges = [];
    this.strips = [];
    if (!cache || !grid) {
      this.bleed.replaceChildren();
      return;
    }
    const fragment = document.createDocumentFragment();
    const cell = grid.width / grid.columns;
    // `top` is where the row's ink should start; the element sits higher by the
    // ink's offset within its line box (times any stretch).
    const row = (
      parent: ParentNode,
      left: number,
      top: number,
      columns: number,
      stretch = 1,
    ) => {
      const span = document.createElement("span");
      span.className = "text-row";
      span.style.left = `${left}px`;
      span.style.top = `${top - grid.inkOffset * stretch}px`;
      span.style.width = `${columns * cell}px`;
      const node = document.createTextNode("");
      span.append(node);
      parent.append(span);
      return { span, node };
    };
    for (const side of ["left", "right"] as const) {
      const columns = this.strip[side],
        width = columns * cell;
      const tiles = Math.min(MAX_TILES, Math.ceil(bleed[side] / width));
      if (!(tiles > 0)) continue;
      // The chunks the strip spans, and where it lies within their text.
      const first =
        side === "left"
          ? 0
          : Math.floor((cache.columns - columns) / cache.chunkSize);
      const last =
        side === "left"
          ? Math.floor((columns - 1) / cache.chunkSize)
          : cache.chunksPerRow - 1;
      const from =
        side === "left" ? 0 : cache.columns - columns - first * cache.chunkSize;
      for (let line = 0; line < cache.rowCount; line++) {
        const edge: Edge = {
          nodes: [],
          slots: [],
          ids: [],
          from,
          to: from + columns,
        };
        for (let chunk = first; chunk <= last; chunk++) {
          edge.slots.push(line * cache.chunksPerRow + chunk);
          edge.ids.push(-1);
        }
        for (let tile = 0; tile < tiles; tile++) {
          const left =
            side === "left" ? -(tile + 1) * width : grid.width + tile * width;
          const { span, node } = row(
            fragment,
            left,
            line * this.pitch,
            columns,
          );
          // The tile touching the art is its mirror image; they alternate outward.
          if (tile % 2 === 0) span.classList.add("flip");
          edge.nodes.push(node);
        }
        this.edges.push(edge);
      }
    }
    for (const edge of ["top", "bottom"] as const) {
      const gap = bleed[edge];
      if (!(gap > 0)) continue;
      const line =
        edge === "top"
          ? Math.round(cache.rowCount * TOP_REFERENCE)
          : cache.rowCount - 1;
      // `gap` is in horizontal layout units; vertically a unit is `stretch` times
      // taller. Reach a little into the art so no hairline shows at the join.
      const inside = edge === "top" ? line * this.pitch : this.pitch / 2;
      const height = gap / this.stretch + inside;
      for (let chunk = 0; chunk < cache.chunksPerRow; chunk++) {
        const column = chunk * cache.chunkSize,
          columns = Math.min(cache.chunkSize, cache.columns - column);
        const stretch = height / grid.inkHeight;
        const { span, node } = row(
          fragment,
          column * cell,
          edge === "top"
            ? -gap / this.stretch
            : grid.rows * this.pitch - inside,
          columns,
          stretch,
        );
        span.classList.add("stretch");
        span.style.setProperty("--stretch", String(stretch));
        this.strips.push({
          node,
          slot: line * cache.chunksPerRow + chunk,
          id: -1,
          half: edge === "top" ? 0 : 2,
        });
      }
    }
    this.bleed.replaceChildren(fragment);
    if (this.painted >= 0) this.paintBleed(cache.frames[this.painted]!);
  }

  private paintBleed(frame: Uint32Array): void {
    const lines = this.cache!.lines;
    for (const edge of this.edges) {
      let changed = false;
      for (let i = 0; i < edge.slots.length; i++) {
        const id = frame[edge.slots[i]!]!;
        if (id !== edge.ids[i]) {
          edge.ids[i] = id;
          changed = true;
        }
      }
      if (!changed) continue;
      let text = "";
      for (const id of edge.ids) text += lines[id]!;
      text = text.slice(edge.from, edge.to);
      for (const node of edge.nodes) node.data = text;
    }
    for (const strip of this.strips) {
      const id = frame[strip.slot]!;
      if (id === strip.id) continue;
      strip.id = id;
      // A stretched row must be whole blocks. Downward, keep the half of each
      // cell that touches the bottom edge; upward, any ink counts.
      const key = id * 2 + (strip.half ? 1 : 0);
      let text = this.projections.get(key);
      if (text === undefined) {
        text = "";
        for (const glyph of lines[id]!)
          text +=
            glyph === "█" ||
            (strip.half ? glyph === "▄" : glyph !== " " && glyph !== "\u00a0")
              ? "█"
              : " ";
        this.projections.set(key, text);
      }
      strip.node.data = text;
    }
  }
}
