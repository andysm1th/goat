import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { cpus, arch, platform } from "node:os";

// Run: node --expose-gc scripts/audit-performance.mjs
// Compare an earlier implementation with the same assets:
//   node --expose-gc scripts/audit-performance.mjs --source-dir /path/to/previous/src
// Node workers approximate the structured-clone boundary, not browser costs.
// Object writes do not measure DOM layout, glyph shaping, paint or compositing.
const project = new URL("../", import.meta.url);
function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return process.argv[index + 1];
}
const source = isMainThread
  ? pathToFileURL(
      resolve(option("--source-dir", fileURLToPath(new URL("src/", project)))) +
        sep,
    ).href
  : workerData.source;
const assets = isMainThread
  ? pathToFileURL(
      resolve(
        option(
          "--assets-dir",
          fileURLToPath(new URL("public/animation/", project)),
        ),
      ) + sep,
    ).href
  : workerData.assets;
const { buildPackedFrameCache, applyTextFrame, releaseEntrance } = await import(
  new URL("player/frames/frame-cache.ts", source)
);
const mib = (bytes) => Number((bytes / 1024 ** 2).toFixed(3));
const round = (value) => Number(value.toFixed(3));
function collect() {
  if (!global.gc) throw new Error("Run this audit with node --expose-gc.");
  global.gc();
  global.gc();
}
function memory() {
  return Object.fromEntries(
    Object.entries(process.memoryUsage()).map(([key, bytes]) => [
      key,
      mib(bytes),
    ]),
  );
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p95: round(sorted[Math.floor(sorted.length * 0.95)]),
    max: round(sorted.at(-1)),
  };
}

if (!isMainThread) {
  collect();
  const baseline = memory();
  const compressed = readFileSync(new URL(workerData.variant.file, assets));
  let start = performance.now();
  const packed = gunzipSync(compressed);
  const inflateMs = performance.now() - start;
  start = performance.now();
  const cache = buildPackedFrameCache(
    packed,
    workerData.variant.columns,
    workerData.variant.rows,
    workerData.count,
  );
  const prepareMs = performance.now() - start;
  const beforeCollection = memory();
  collect();
  const afterCollection = memory();
  const sendStart = process.hrtime.bigint();
  parentPort.postMessage(
    {
      kind: "cache",
      cache,
      sendStart: String(sendStart),
      measurements: {
        baseline,
        beforeCollection,
        afterCollection,
        compressedBytes: compressed.byteLength,
        inflatedBytes: packed.byteLength,
        inflateMs: round(inflateMs),
        prepareMs: round(prepareMs),
      },
    },
    [...cache.frames, ...cache.patches, ...cache.entrance].map(
      (array) => array.buffer,
    ),
  );
  parentPort.postMessage({
    kind: "post",
    postMessageMs: round(Number(process.hrtime.bigint() - sendStart) / 1e6),
  });
  parentPort.close();
} else {
  const manifestBytes = readFileSync(new URL("manifest.json", assets));
  const manifest = JSON.parse(manifestBytes);

  async function inspect(variant) {
    collect();
    const baseline = memory();
    let cache, workerMeasurements, postMessageMs, handoffMs;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { source, assets, variant, count: manifest.frameCount },
    });
    worker.on("message", (message) => {
      if (message.kind === "cache") {
        cache = message.cache;
        workerMeasurements = message.measurements;
        handoffMs = round(
          Number(process.hrtime.bigint() - BigInt(message.sendStart)) / 1e6,
        );
      } else postMessageMs = message.postMessageMs;
    });
    await new Promise((resolve, reject) => {
      worker.on("exit", (code) =>
        code
          ? reject(new Error(`Audit worker exited with ${code}`))
          : resolve(),
      );
      worker.on("error", reject);
    });
    collect();
    const retainedWithEntrance = memory();
    let baseLineCount = 0;
    for (const frame of cache.frames)
      for (const id of frame) baseLineCount = Math.max(baseLineCount, id + 1);
    const entranceStrings = cache.lines.length - baseLineCount;
    const entranceCodeUnits = cache.lines
      .slice(baseLineCount)
      .reduce((sum, line) => sum + line.length, 0);
    const entranceArrayBytes = cache.entrance.reduce(
      (sum, array) => sum + array.byteLength,
      0,
    );
    const arrayBytes = [
      ...cache.frames,
      ...cache.patches,
      ...cache.entrance,
    ].reduce((sum, array) => sum + array.byteLength, 0);
    const allLineCount = cache.lines.length;
    const slots = cache.frames[0].length;
    let staticSlots = 0,
      staticBlankSlots = 0;
    for (let slot = 0; slot < slots; slot++) {
      if (
        cache.frames.every((frame) => frame[slot] === cache.frames[0][slot])
      ) {
        staticSlots++;
        if (!cache.lines[cache.frames[0][slot]].trim()) staticBlankSlots++;
      }
    }
    const actualChanged = [],
      rewrittenGlyphs = [];
    for (let index = 0; index < cache.frames.length; index++) {
      const previous =
        cache.frames[(index + cache.frames.length - 1) % cache.frames.length];
      const current = cache.frames[index];
      let changed = 0,
        rewritten = 0;
      for (const slot of cache.patches[index]) {
        const before = cache.lines[previous[slot]],
          after = cache.lines[current[slot]];
        rewritten += after.length;
        for (let glyph = 0; glyph < before.length; glyph++)
          changed += before[glyph] !== after[glyph];
      }
      actualChanged.push(changed);
      rewrittenGlyphs.push(rewritten);
    }
    const nodes = Array.from({ length: slots }, () => ({ data: "" }));
    const schedules = {};
    // Adjacent 60Hz playback, skipped frames, and a 10Hz cadence.
    for (const stride of [1, 2, 6]) {
      const times = [],
        writes = [];
      let previous = -1;
      for (let sample = 0; sample < manifest.frameCount * 3; sample += stride) {
        const index = sample % manifest.frameCount,
          start = performance.now();
        const count = applyTextFrame(cache, index, previous, nodes);
        const elapsed = performance.now() - start;
        if (previous >= 0) {
          times.push(elapsed);
          writes.push(count);
        }
        previous = index;
      }
      schedules[stride] = {
        mockWritesMs: stats(times),
        writesPerPaint: stats(writes),
      };
    }
    // Reproduce the safe cleanup opportunity after the entrance resolves.
    // The final entrance consists only of IDs from the ordinary frame table.
    nodes.length = 0;
    collect();
    const beforeEntranceRelease = memory();
    if (releaseEntrance) releaseEntrance(cache);
    else {
      cache.entrance = [];
      cache.lines.length = baseLineCount;
    }
    if (cache.entrance.length || cache.lines.length !== baseLineCount)
      throw new Error(
        "Entrance cleanup retained data or removed playback strings.",
      );
    collect();
    const retainedWithoutEntrance = memory();
    cache = null;
    worker.removeAllListeners();
    const bands = Math.ceil(variant.rows / Math.ceil(variant.rows / 8));
    return {
      id: variant.id,
      file: variant.file,
      frames: manifest.frameCount,
      expectedDom: {
        elements: slots * 2 + bands,
        textNodes: slots,
        totalNodes: slots * 3 + bands,
      },
      domNote:
        "Counts follow the current two-span chunk renderer; excludes the stage, controls, edge extensions and the Techno text.",
      staticSlots,
      staticBlankSlots,
      allLineCount,
      baseLineCount,
      entranceStrings,
      entranceLogicalMiB: mib(entranceCodeUnits * 2 + entranceArrayBytes),
      typedArrayMiB: mib(arrayBytes),
      entranceCleanup: releaseEntrance
        ? "production helper"
        : "simulated baseline opportunity",
      worker: workerMeasurements,
      nodeStructuredClone: { postMessageMs, handoffMs },
      parent: {
        baseline,
        retainedWithEntrance,
        beforeEntranceRelease,
        retainedWithoutEntrance,
        heapGrowthWithEntranceMiB: round(
          retainedWithEntrance.heapUsed - baseline.heapUsed,
        ),
        heapGrowthWithoutEntranceMiB: round(
          retainedWithoutEntrance.heapUsed - baseline.heapUsed,
        ),
        entranceHeapAndExternalReleasedMiB:
          entranceStrings || entranceArrayBytes
            ? round(
                beforeEntranceRelease.heapUsed +
                  beforeEntranceRelease.external -
                  retainedWithoutEntrance.heapUsed -
                  retainedWithoutEntrance.external,
              )
            : 0,
      },
      actualChangedGlyphs: stats(actualChanged),
      rewrittenGlyphs: stats(rewrittenGlyphs),
      schedules,
    };
  }

  const results = [];
  for (const id of ["light", "standard", "fine", "solo-light", "solo"]) {
    const variant = manifest.variants.find((item) => item.id === id);
    if (!variant) continue;
    const result = await inspect(variant);
    // The async inspection frame and Worker dispatch callbacks can retain
    // temporary references despite cache=null. Measure only after that frame
    // has returned and an event-loop turn has completed; otherwise V8 tiering
    // can make an entirely released cache look retained until the next variant.
    await new Promise((resolve) => setImmediate(resolve));
    collect();
    result.parent.afterCompleteRelease = memory();
    result.parent.heapResidualAfterReleaseMiB = round(
      result.parent.afterCompleteRelease.heapUsed -
        result.parent.baseline.heapUsed,
    );
    results.push(result);
  }
  const dist = new URL("dist/assets/", project);
  const builtFiles = existsSync(dist)
    ? readdirSync(dist).map((file) => {
        const stat = statSync(new URL(file, dist));
        return { file, bytes: stat.size, modified: stat.mtime.toISOString() };
      })
    : [];
  console.log(
    JSON.stringify(
      {
        scope:
          "Node worker-thread/structured-clone/GC audit. Not browser heap, DOM paint, GPU cost, or FPS.",
        memoryNotes:
          "Memory fields are MiB after forced GC where indicated. Full-release measurement occurs outside the inspection function after an event-loop turn, avoiding temporary stack/Worker callback references. RSS spans all isolates and includes allocator high-water marks; do not interpret it as retained cache size. Transferred ArrayBuffers may be accounted under external rather than arrayBuffers in the receiving isolate.",
        node: process.version,
        capturedAt: new Date().toISOString(),
        machine: {
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          arch: arch(),
          platform: platform(),
        },
        source,
        assets,
        animation: {
          frames: manifest.frameCount,
          seconds: manifest.duration,
          averageHz: manifest.frameCount / manifest.duration,
        },
        shipping: {
          manifestBytes: manifestBytes.byteLength,
          variants: manifest.variants.map((variant) => ({
            id: variant.id,
            file: variant.file,
            bytes: statSync(new URL(variant.file, assets)).size,
          })),
          builtFiles,
          buildNote:
            "These are existing dist artifacts with timestamps; rebuild first for current bundle sizes. Only the selected sharp variant and, for Techno, one goat-only variant are requested.",
        },
        results,
      },
      null,
      2,
    ),
  );
}
