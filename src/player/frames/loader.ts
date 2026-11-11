// Browser-only loading: the manifest over fetch, the packed frames in a worker.
// The worker is inlined so the library stays a single file next to its assets.
import FramesWorker from "./frames.worker.ts?worker&inline";
import type { Manifest, Variant } from "./animation";
import type { FrameCache } from "./frame-cache";

export async function loadManifest(
  base: string,
  signal: AbortSignal,
): Promise<Manifest> {
  const response = await fetch(new URL("manifest.json", base), {
    signal,
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error("The converted animation could not be loaded.");
  const result = (await response.json()) as Manifest;
  if (result.version !== 1 || result.frameCount !== result.timestamps.length) {
    throw new Error("The animation manifest is invalid.");
  }
  return result;
}

export function loadFrames(
  base: string,
  variant: Variant,
  frameCount: number,
  signal: AbortSignal,
  options: { entrance?: boolean; runs?: boolean } = {},
): Promise<FrameCache> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new FramesWorker();
    const stop = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ cache?: FrameCache; error?: string }>,
    ) => {
      stop();
      if (event.data.cache) resolve(event.data.cache);
      else
        reject(new Error(event.data.error || "Could not prepare text frames."));
    };
    worker.onerror = () => {
      stop();
      reject(new Error("The text animation worker failed."));
    };
    // A blob worker has no useful base URL, so the frame URL must be absolute.
    worker.postMessage({
      url: new URL(variant.file, base).href,
      columns: variant.columns,
      rows: variant.rows,
      count: frameCount,
      withEntrance: options.entrance ?? false,
      withRuns: options.runs ?? false,
    });
  });
}
