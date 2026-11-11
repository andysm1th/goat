import {
  decodePackedGlyphs,
  packedByteLength,
  validatePackedFrames,
} from "./glyph-codec.ts";

export type FrameCache = {
  columns: number;
  rowCount: number;
  chunkSize: number;
  chunksPerRow: number;
  lines: string[];
  playbackLineCount: number;
  frames: Uint32Array[];
  patches: Uint16Array[];
  entrance: Uint32Array[];
  /** Per-frame ink runs, when the loader asked for the silhouette. */
  runs?: Uint16Array[];
};

// Characters per text node. Measured in Chrome: the browser's cost per node
// outweighs the cost of re-shaping unchanged glyphs, so 128 takes about a fifth
// less main-thread time than 64, while 256 gains nothing more.
const CHUNK_SIZE = 128;

function assembleFrameCache(
  columns: number,
  rowCount: number,
  frameCount: number,
  readFrames: (
    intern: (text: string) => number,
    chunkSize: number,
    chunksPerRow: number,
  ) => Uint32Array[],
  withEntrance: boolean,
): FrameCache {
  packedByteLength(columns, rowCount, frameCount);
  const lines: string[] = [];
  const ids = new Map<string, number>();
  const chunkSize = Math.min(columns, CHUNK_SIZE);
  const chunksPerRow = Math.ceil(columns / chunkSize);
  if (chunksPerRow * rowCount > 65536)
    throw new Error("The text frame exceeds its patch budget.");
  const intern = (text: string) => {
    let id = ids.get(text);
    if (id === undefined) {
      id = lines.length;
      ids.set(text, id);
      lines.push(text);
    }
    return id;
  };
  const frames = readFrames(intern, chunkSize, chunksPerRow);
  const patches = frames.map((frame, index) => {
    const previous = frames[(index + frames.length - 1) % frames.length]!;
    const changed: number[] = [];
    for (let row = 0; row < frame.length; row++)
      if (frame[row] !== previous[row]) changed.push(row);
    return Uint16Array.from(changed);
  });
  const playbackLineCount = lines.length;
  const hash = (value: number) => {
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    return (value ^ (value >>> 16)) >>> 0;
  };
  const entrance =
    !withEntrance || columns <= 160
      ? []
      : Array.from({ length: 18 }, (_, step) => {
          const progress = step / 17;
          return Uint32Array.from(frames[0]!, (id, slot) => {
            const seed = hash(slot + 1);
            const settle = 0.22 + (seed % 700) / 1000;
            if (progress >= settle) return id;
            const goal = lines[id]!;
            const palette = progress < 0.35 ? " .+×|:* " : " ░▀▄█|+ ";
            let noise = "";
            for (let i = 0; i < goal.length; i++) {
              const random = hash(seed ^ (i * 19349663) ^ (step * 83492791));
              const resolved =
                progress > 0.35 && (random % 1000) / 1000 < progress * progress;
              noise += resolved ? goal[i] : palette[random % palette.length];
            }
            return intern(noise);
          });
        });
  return {
    columns,
    rowCount,
    chunkSize,
    chunksPerRow,
    lines,
    playbackLineCount,
    frames,
    patches,
    entrance,
  };
}

// Intern repeated text chunks once. Playback follows typed-array chunk IDs;
// there is no splitting, layout or diffing in the loop.
export function buildFrameCache(
  text: string,
  columns: number,
  rowCount: number,
  frameCount: number,
  withEntrance = true,
): FrameCache {
  return assembleFrameCache(
    columns,
    rowCount,
    frameCount,
    (intern, chunkSize, chunksPerRow) => {
      const sourceFrames = text.split("\f");
      if (sourceFrames.length !== frameCount)
        throw new Error("The text animation is incomplete.");
      return sourceFrames.map((frame) => {
        const rows = frame.split("\n");
        if (
          rows.length !== rowCount ||
          rows.some((row) => row.length !== columns)
        )
          throw new Error("Invalid text frame dimensions.");
        const chunks = new Uint32Array(chunksPerRow * rowCount);
        let slot = 0;
        for (const row of rows)
          for (let x = 0; x < columns; x += chunkSize)
            chunks[slot++] = intern(row.slice(x, x + chunkSize));
        return chunks;
      });
    },
    withEntrance,
  );
}

export function buildPackedFrameCache(
  bytes: Uint8Array,
  columns: number,
  rowCount: number,
  frameCount: number,
  withEntrance = true,
): FrameCache {
  validatePackedFrames(bytes, columns, rowCount, frameCount);
  // Hash compact words BEFORE decoding: most chunks recur across the cycle.
  // Always compare their complete bytes after a hash hit, so collisions cannot
  // change a glyph. The index exists only during worker cache construction.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heads = new Map<number, number>();
  const offsets: number[] = [],
    lengths: number[] = [],
    chunkIds: number[] = [];
  const links: (number | undefined)[] = [];
  const equal = (a: number, b: number, length: number) => {
    for (let i = 0; i < length; i += 4)
      if (view.getUint32(a + i, true) !== view.getUint32(b + i, true))
        return false;
    return true;
  };
  return assembleFrameCache(
    columns,
    rowCount,
    frameCount,
    (intern, chunkSize, chunksPerRow) =>
      Array.from({ length: frameCount }, (_, frame) => {
        const chunks = new Uint32Array(chunksPerRow * rowCount);
        let slot = 0;
        for (let row = 0; row < rowCount; row++)
          for (let x = 0; x < columns; x += chunkSize) {
            const start = (frame * rowCount + row) * columns + x;
            const length = Math.min(chunkSize, columns - x);
            // Odd dimensions and partial words retain the general codec path.
            if (start % 16 || length % 16) {
              chunks[slot++] = intern(decodePackedGlyphs(bytes, start, length));
              continue;
            }
            const offset = start / 4,
              byteLength = length / 4;
            let hash = length;
            for (let at = offset; at < offset + byteLength; at += 4)
              hash = Math.imul(hash ^ view.getUint32(at, true), 16777619);
            const head = heads.get(hash);
            let found = head;
            while (
              found !== undefined &&
              (lengths[found] !== byteLength ||
                !equal(offsets[found]!, offset, byteLength))
            )
              found = links[found];
            if (found !== undefined) chunks[slot++] = chunkIds[found]!;
            else {
              const id = intern(decodePackedGlyphs(bytes, start, length));
              heads.set(hash, offsets.length);
              offsets.push(offset);
              lengths.push(byteLength);
              links.push(head);
              chunkIds.push(id);
              chunks[slot++] = id;
            }
          }
        return chunks;
      }),
    withEntrance,
  );
}

export function releaseEntrance(cache: FrameCache): void {
  cache.entrance.length = 0;
  cache.lines.length = cache.playbackLineCount;
}

/** A DOM text node, or anything else that can hold a chunk's text. */
export type ChunkNode = { data: string };

// Each changed chunk is written whole. Editing only the changed span with
// `replaceData` was measured too: it moves the cost from layout into the call
// itself and comes out no faster.
export function applyTextFrame(
  cache: FrameCache,
  index: number,
  previous: number,
  nodes: ChunkNode[],
): number {
  if (index === previous) return 0;
  const current = cache.frames[index]!;
  let writes = 0;
  if (previous >= 0 && index === (previous + 1) % cache.frames.length) {
    for (const row of cache.patches[index]!) {
      nodes[row]!.data = cache.lines[current[row]!]!;
      writes++;
    }
  } else {
    // A slow frame, resize, or background tab can skip source frames. Compare
    // against the frame actually painted, never apply an invalid adjacent diff.
    const old = previous < 0 ? undefined : cache.frames[previous];
    for (let row = 0; row < current.length; row++) {
      if (!old || old[row] !== current[row]) {
        nodes[row]!.data = cache.lines[current[row]!]!;
        writes++;
      }
    }
  }
  return writes;
}

export function applyEntrance(
  cache: FrameCache,
  index: number,
  previous: number,
  nodes: ChunkNode[],
) {
  if (index === previous) return;
  const current = cache.entrance[index]!;
  const old = previous < 0 ? undefined : cache.entrance[previous];
  for (let slot = 0; slot < current.length; slot++) {
    if (!old || old[slot] !== current[slot])
      nodes[slot]!.data = cache.lines[current[slot]!]!;
  }
}

export function createTextRows(
  element: HTMLElement,
  cache: FrameCache,
): Text[] {
  const fragment = document.createDocumentFragment();
  const rowsPerBand = Math.ceil(cache.rowCount / 8);
  const bands = Array.from(
    { length: Math.ceil(cache.rowCount / rowsPerBand) },
    (_, index) => {
      const band = document.createElement("span");
      band.className = "text-band";
      band.style.top = `calc(var(--row-height) * ${index * rowsPerBand})`;
      band.style.height = `calc(var(--row-height) * ${Math.min(rowsPerBand, cache.rowCount - index * rowsPerBand)})`;
      band.style.setProperty("--band-index", String(index));
      fragment.append(band);
      return band;
    },
  );
  const nodes = Array.from({ length: cache.frames[0]!.length }, (_, slot) => {
    const row = Math.floor(slot / cache.chunksPerRow);
    const column = (slot % cache.chunksPerRow) * cache.chunkSize;
    const span = document.createElement("span");
    span.className = "text-row";
    // One element per chunk. Its line box is the glyph's ink height, lifted so
    // the ink itself starts on the row's top edge.
    span.style.top = `calc(var(--row-height) * ${row % rowsPerBand} - var(--ink-offset))`;
    span.style.left = `calc(var(--cell-width) * ${column})`;
    span.style.width = `calc(var(--cell-width) * ${Math.min(cache.chunkSize, cache.columns - column)})`;
    const node = document.createTextNode("");
    span.append(node);
    bands[Math.floor(row / rowsPerBand)]!.append(span);
    return node;
  });
  element.replaceChildren(fragment);
  return nodes;
}
