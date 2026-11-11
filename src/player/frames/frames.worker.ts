import { buildFrameCache, buildPackedFrameCache } from "./frame-cache";
import { inkRuns } from "./ink-runs";

self.onmessage = async (
  event: MessageEvent<{
    url: string;
    columns: number;
    rows: number;
    count: number;
    withEntrance: boolean;
    withRuns: boolean;
  }>,
) => {
  try {
    const { url, columns, rows, count, withEntrance, withRuns } = event.data;
    const response = await fetch(url);
    if (!response.ok) throw new Error("The text frames could not be loaded.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const inflated =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? new Uint8Array(
            await new Response(
              new Blob([bytes])
                .stream()
                .pipeThrough(new DecompressionStream("gzip")),
            ).arrayBuffer(),
          )
        : bytes;
    const packed = /\.glyphs(?:\.gz)?$/i.test(
      new URL(url, self.location.href).pathname,
    );
    const cache = packed
      ? buildPackedFrameCache(inflated, columns, rows, count, withEntrance)
      : buildFrameCache(
          new TextDecoder().decode(inflated),
          columns,
          rows,
          count,
          withEntrance,
        );
    if (withRuns && packed)
      cache.runs = Array.from({ length: count }, (_, frame) =>
        inkRuns(inflated, columns, rows, frame),
      );
    self.postMessage(
      { cache },
      {
        transfer: [
          ...cache.frames,
          ...cache.patches,
          ...cache.entrance,
          ...(cache.runs ?? []),
        ].map((array) => array.buffer as ArrayBuffer),
      },
    );
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error
          ? error.message
          : "The text animation could not be prepared.",
    });
  }
};
