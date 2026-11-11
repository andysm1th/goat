import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  beatsAt,
  kickAt,
  cycleRate,
  followLoop,
  DEFAULT_TEMPO,
} from "../src/player/techno/track.ts";
import { periodicLoop, findOnset } from "../scripts/audio-loop.mjs";

const read = async (name) =>
  JSON.parse(
    await readFile(new URL(`../public/animation/${name}`, import.meta.url)),
  );

test("the published loop is a whole number of bars and of goat cycles", async () => {
  const techno = await read("techno.json"),
    animation = await read("manifest.json");
  const bar = (60 / techno.bpm) * techno.beatsPerBar;
  assert.ok(Math.abs(techno.loopLength - techno.bars * bar) < 1e-9);
  assert.equal(techno.bars % 8, 0, "The recording is phrased in eight bars");
  const rate = cycleRate(animation.duration, techno);
  const cycles = (techno.loopLength * rate) / animation.duration;
  assert.ok(
    Math.abs(cycles - Math.round(cycles)) < 1e-9,
    "Picture and sound must repeat together",
  );
  assert.ok(
    Math.abs(rate - 1) < 0.03,
    "The goat may not be visibly sped up or slowed to fit",
  );
  assert.ok(cycles >= 5, "The loop should span at least five goat cycles");
  assert.deepEqual(
    {
      bpm: DEFAULT_TEMPO.bpm,
      loopLength: DEFAULT_TEMPO.loopLength,
      downbeat: DEFAULT_TEMPO.downbeat,
    },
    {
      bpm: techno.bpm,
      loopLength: techno.loopLength,
      downbeat: techno.downbeat,
    },
    "Defaults must match the shipped recording",
  );
  const bytes = await readFile(
    new URL(`../public/animation/${techno.file}`, import.meta.url),
  );
  assert.equal(bytes.length, techno.bytes);
  assert.equal(
    techno.file,
    `techno-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.mp3`,
  );
});

test("the encoded loop is periodic, so its seam is inaudible at any decoder offset", async (t) => {
  const techno = await read("techno.json");
  let raw;
  try {
    raw = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        new URL(`../public/animation/${techno.file}`, import.meta.url).pathname,
        "-ac",
        "2",
        "-ar",
        "44100",
        "-f",
        "f32le",
        "-",
      ],
      { maxBuffer: 1 << 28 },
    );
  } catch {
    t.skip("ffmpeg is not installed");
    return;
  }
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4),
    rate = 44100;
  assert.ok(
    Math.abs(
      samples.length / 2 / rate - (techno.loopLength + 2 * techno.loopStart),
    ) < 0.06,
  );
  const similarity = (a, b, frames) => {
    let ab = 0,
      aa = 0,
      bb = 0;
    for (let i = 0; i < frames * 2; i++) {
      const p = samples[a * 2 + i],
        q = samples[b * 2 + i];
      ab += p * q;
      aa += p * p;
      bb += q * q;
    }
    return ab / Math.sqrt(aa * bb);
  };
  for (const shift of [0, 0.005, 0.012, 0.026]) {
    const start = Math.round((techno.loopStart + shift) * rate),
      end = start + Math.round(techno.loopLength * rate);
    const window = Math.round(0.4 * rate);
    assert.ok(
      similarity(start - window / 2, end - window / 2, window) > 0.999,
      `The audio either side of the seam differs at ${shift}s`,
    );
    let ordinary = 0;
    for (let i = start; i < start + 4000; i++)
      ordinary = Math.max(
        ordinary,
        Math.abs(samples[i * 2] - samples[(i + 1) * 2]),
      );
    assert.ok(
      Math.abs(samples[(end - 1) * 2] - samples[start * 2]) <= ordinary,
      "The wrap must not step more than ordinary audio does",
    );
  }
});

test("beats, kick and the audio-following timeline", () => {
  const tempo = { bpm: 120, loopLength: 16, downbeat: 0.25 };
  assert.equal(beatsAt(0.25, tempo), 0);
  assert.equal(beatsAt(1.25, tempo), 2);
  assert.equal(kickAt(3), 1);
  assert.ok(kickAt(3.5) < 1e-12 && kickAt(3.25) < 1e-12);
  assert.ok(kickAt(3.05) > kickAt(3.1));
  // The timeline keeps counting through wraps and takes its phase from the audio.
  assert.equal(followLoop(33.2, 1.25, 16), 33.25);
  assert.equal(followLoop(47.99, 0.01, 16), 48.01);
  assert.ok(Math.abs(followLoop(0.02, 15.99, 16) - -0.01) < 1e-9);
  assert.equal(cycleRate(9, { bpm: 125, loopLength: 45, downbeat: 0 }), 1);
});

test("a cut loop runs straight on from its last sample into its first", () => {
  // A steady tone whose period does not divide the loop length: the raw cut clicks.
  const rate = 1000,
    channels = 1,
    source = Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i * 0.37));
  const start = 500,
    length = 1003,
    fade = 40;
  const loop = periodicLoop(source, channels, start, length, fade);
  assert.equal(loop.length, length);
  assert.deepEqual(
    [...loop.subarray(0, length - fade)],
    [...source.subarray(start, start + length - fade)],
  );
  const step = Math.abs(loop[length - 1] - loop[0]),
    raw = Math.abs(source[start + length - 1] - source[start]);
  assert.ok(
    step < 0.45 && Math.abs(loop[length - 1] - source[start - 1]) < 0.03,
    `wrap step ${step} (uncorrected ${raw})`,
  );
  assert.throws(() => periodicLoop(source, channels, 10, 100, 40));
  const clicks = new Float32Array(2000);
  for (let i = 1200; i < 2000; i++) clicks[i] = i % 2 ? 0.8 : -0.8;
  assert.ok(Math.abs(findOnset(clicks, 1, rate, 1, 1.5) - 1.2) < 0.01);
});
