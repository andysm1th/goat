import { spawn, execFileSync } from "node:child_process";
import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  mkdtemp,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pixelsToText } from "./text-frames.mjs";
import { packTextFrames } from "../src/player/frames/glyph-codec.ts";
import { separateStripes } from "./stripe-layers.mjs";
import {
  cyclicPlan,
  stripeProfile,
  distanceLayers,
  renderFields,
  focusBox,
  extendGround,
} from "./cyclic-motion.mjs";

// The source video is not kept in the project: pass its path.
if (!process.argv[2]) {
  console.error(
    "Usage: pnpm convert <video>\n\nConverts the source video to the text frames in public/animation/.",
  );
  process.exit(1);
}
const input = resolve(process.argv[2]);
const output = resolve("public/animation");
const probe = JSON.parse(
  execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_streams",
      "-show_frames",
      "-show_entries",
      "stream=width,height,duration:frame=best_effort_timestamp_time",
      "-of",
      "json",
      input,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  ),
);
const stream = probe.streams[0];
const times = probe.frames.map((frame) =>
  Number(frame.best_effort_timestamp_time),
);
const plan = cyclicPlan(times);
const width = 960,
  height = 540,
  pixels = width * height;
const work = await mkdtemp(join(tmpdir(), "goat-periodic-"));
const master = join(work, "master.nut"),
  soloMaster = join(work, "solo.nut");
const ffmpeg = (args) =>
  execFileSync("ffmpeg", ["-v", "error", ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });
const motion =
  "mi_mode=mci:mc_mode=aobmc:me_mode=bidir:me=epzs:mb_size=8:search_param=32:vsbmc=1:scd=none";
try {
  await mkdir(output, { recursive: true });
  const sourcePath = join(work, "source.gray");
  console.log("Sampling the complete source motion at 60 fps");
  ffmpeg([
    "-i",
    input,
    "-vf",
    `scale=${width}:${height}:flags=area,format=gray,tpad=stop_mode=clone:stop_duration=0.2,minterpolate=fps=60:${motion},trim=duration=${stream.duration}`,
    "-an",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    sourcePath,
  ]);
  let source = await readFile(sourcePath);
  const rawAt = (index) =>
    source.subarray(index * pixels, (index + 1) * pixels);
  if (source.length < (plan.last + 1) * pixels)
    throw new Error("The sampled source is incomplete.");
  const stripe = stripeProfile(
    [60, 120, 180, 240, 300, 360, 420, 470].map((index) =>
      separateStripes(rawAt(index)),
    ),
  );
  const needed = [
    ...new Set(
      plan.samples.flatMap((sample) =>
        [sample.source, sample.target].filter(Number.isInteger),
      ),
    ),
  ].sort((a, b) => a - b);
  const fieldFile = await open(join(work, "fields.bin"), "w+");
  const geometry = new Map();
  const fieldBytes = pixels * 4;
  try {
    for (let index = 0; index < needed.length; index++) {
      const at = needed[index],
        field = distanceLayers(separateStripes(rawAt(at)), stripe);
      const packed = new Int16Array(pixels * 2);
      for (let i = 0; i < pixels; i++) {
        packed[i] = Math.max(
          -32767,
          Math.min(32767, Math.round(field.shape[i] * 16)),
        );
        packed[pixels + i] = Math.max(
          -32767,
          Math.min(32767, Math.round(field.coverage[i] * 16)),
        );
      }
      await fieldFile.write(
        Buffer.from(packed.buffer),
        0,
        fieldBytes,
        at * fieldBytes,
      );
      geometry.set(at, field.geometry);
      if ((index + 1) % 60 === 0)
        console.log(
          `Prepared ${index + 1}/${needed.length} source contour fields`,
        );
    }
    source = null;
    const cache = new Map();
    const fieldAt = async (index) => {
      if (cache.has(index)) return cache.get(index);
      const buffer = Buffer.alloc(fieldBytes);
      const { bytesRead } = await fieldFile.read(
        buffer,
        0,
        fieldBytes,
        index * fieldBytes,
      );
      if (bytesRead !== fieldBytes)
        throw new Error("The contour cache is incomplete.");
      const packed = new Int16Array(
        buffer.buffer,
        buffer.byteOffset,
        pixels * 2,
      );
      const field = {
        shape: Float32Array.from(
          packed.subarray(0, pixels),
          (value) => value / 16,
        ),
        coverage: Float32Array.from(
          packed.subarray(pixels),
          (value) => value / 16,
        ),
        geometry: geometry.get(index),
      };
      cache.set(index, field);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
      return field;
    };
    // The same cycle twice: with the screen lines, and the silhouette alone.
    // The second lets the player flow other text around the animal.
    const cyclePath = join(work, "cycle.gray"),
      soloPath = join(work, "solo.gray");
    const cycle = await open(cyclePath, "w"),
      solo = await open(soloPath, "w");
    const noStripe = new Float32Array(stripe.length);
    try {
      for (let i = 0; i < plan.count; i++) {
        const sample = plan.samples[i],
          a = await fieldAt(sample.source);
        const b = sample.blend > 0 ? await fieldAt(sample.target) : a;
        const lined = renderFields(
          a,
          b,
          sample.blend ?? 0,
          stripe,
          width,
          height,
          sample.pose ?? 0,
        );
        const alone = renderFields(
          a,
          b,
          sample.blend ?? 0,
          noStripe,
          width,
          height,
          sample.pose ?? 0,
        );
        extendGround(alone, [lined, alone], width, height);
        await cycle.writeFile(lined);
        await solo.writeFile(alone);
      }
    } finally {
      await cycle.close();
      await solo.close();
    }
    console.log(
      `Built four complete forward strides with ${plan.overlap}-frame contour overlaps`,
    );
    // Render the middle repetition so interpolation has real cyclic neighbours
    // on BOTH sides. The last sample is followed by the next source pose.
    for (const [from, to] of [
      [cyclePath, master],
      [soloPath, soloMaster],
    ]) {
      ffmpeg([
        "-stream_loop",
        "2",
        "-f",
        "rawvideo",
        "-pixel_format",
        "gray",
        "-video_size",
        `${width}x${height}`,
        "-framerate",
        `${plan.count}/${plan.duration}`,
        "-i",
        from,
        "-vf",
        `minterpolate=fps=${plan.outputFps}:${motion},trim=start_frame=${plan.outputCount}:end_frame=${plan.outputCount * 2},setpts=PTS-STARTPTS`,
        "-an",
        "-c:v",
        "ffv1",
        to,
      ]);
    }
  } finally {
    await fieldFile.close();
  }
  async function readTextFrames(file, columns, rows, threshold) {
    const frameSize = columns * rows * 2;
    const frames = [];
    let pending = Buffer.alloc(0);
    let stderr = "";
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-vf",
        `scale=${columns}:${rows * 2}:flags=area,format=gray`,
        "-fps_mode",
        "passthrough",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const completed = new Promise((resolveProcess, reject) => {
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) =>
        code === 0
          ? resolveProcess()
          : reject(new Error(stderr || `FFmpeg exited ${code}`)),
      );
    });
    for await (const chunk of ffmpeg.stdout) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameSize) {
        frames.push(
          pixelsToText(
            pending.subarray(0, frameSize),
            columns,
            rows,
            threshold,
          ),
        );
        pending = pending.subarray(frameSize);
      }
    }
    await completed;
    if (pending.length) throw new Error("Incomplete decoded frame.");
    return frames;
  }

  const variants = [];
  let focus;
  for (const [id, columns, source] of [
    ["light", 320, master],
    ["standard", 640, master],
    ["fine", 960, master],
    ["solo-light", 320, soloMaster],
    ["solo", 640, soloMaster],
  ]) {
    const rows = Math.round((columns * stream.height) / stream.width / 2);
    const frames = await readTextFrames(source, columns, rows, 90);
    if (id === "solo") focus = focusBox(frames, columns, rows);
    if (frames.length !== plan.outputCount) {
      throw new Error(
        `Decoded ${frames.length} frames; expected ${plan.outputCount}.`,
      );
    }
    const compressed = gzipSync(packTextFrames(frames, columns, rows), {
      level: 9,
    });
    const digest = createHash("sha256")
      .update(compressed)
      .digest("hex")
      .slice(0, 12);
    const file = `${id}-${digest}.glyphs.gz`;
    await writeFile(join(work, file), compressed);
    variants.push({ id, columns, rows, file, bytes: compressed.length });
    console.log(
      `${id}: ${columns} × ${rows} characters, ${frames.length} continuous motion frames, ${(compressed.length / 1024).toFixed(0)} KiB`,
    );
  }
  const sourceHash = createHash("sha256")
    .update(await readFile(input))
    .digest("hex");
  const usedStart = Math.min(...needed) / plan.fps,
    usedEnd = plan.last / plan.fps;
  const firstUsed = Math.max(
    0,
    times.findIndex((time) => time > usedStart) - 1,
  );
  const lastUsed = times.findIndex((time) => time >= usedEnd);
  const sourceFrameIndices = Array.from(
    { length: lastUsed - firstUsed + 1 },
    (_, i) => firstUsed + i,
  );
  const manifest = {
    version: 1,
    sourceSha256: sourceHash,
    width: stream.width,
    height: stream.height,
    duration: plan.duration,
    sourceDuration: Number(stream.duration),
    sourceFrameCount: times.length,
    sourceTimestamps: times,
    retainedSourceFrameCount: sourceFrameIndices.length,
    sourceFrameIndices,
    playbackFps: plan.outputFps,
    frameCount: plan.outputCount,
    timestamps: Array.from(
      { length: plan.outputCount },
      (_, i) => i / plan.outputFps,
    ),
    seam: {
      method: "cyclic-phase-aligned-contours",
      completeStrides: 4,
      sourceFps: plan.fps,
      first: plan.first,
      last: plan.last,
      repeat: plan.repeat,
      overlapFrames: plan.overlap,
      poseOverlapFrames: plan.poseOverlap,
      samplingFrameCount: plan.count,
      longCount: plan.longCount,
      extraCount: plan.extraCount,
      interpolation: "signed-distance-shape-and-background",
      easing: "quintic",
      preservesSourceTiming: false,
      timeScale: (plan.duration * plan.fps) / plan.count,
    },
    foreground: "#050706",
    background: "#bdc0bd",
    palette: [" ", "▀", "▄", "█"],
    focus,
    variants,
  };
  await writeFile(
    join(work, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  for (const { file } of variants)
    await rename(join(work, file), resolve(output, file));
  await rename(join(work, "manifest.json"), resolve(output, "manifest.json"));
  // Superseded conversions would otherwise ship with every build.
  const current = new Set(variants.map((variant) => variant.file));
  for (const name of await readdir(output))
    if (name.endsWith(".glyphs.gz") && !current.has(name))
      await rm(join(output, name));
  console.log(
    `Periodic cycle: ${plan.duration}s, ${plan.outputCount} text frames at ${plan.outputFps} fps.`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
