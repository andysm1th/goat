// Cut a seamless, bar-aligned loop from the Techno track and publish it next
// to the animation with the timing the player needs to stay in sync.
//
//   node scripts/make-techno-loop.mjs [source.mp3]
//
// The tempo and section are specific to this recording ("Techno" by Monume):
// 125 BPM in 8-bar phrases, with its fullest 32-bar section starting at bar 32.
// 32 bars last 61.44 s, which the player matches to seven 9-second goat cycles
// by running the animation 2.5% faster while Techno plays.
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { periodicLoop, findOnset } from "./audio-loop.mjs";

const input = resolve(process.argv[2] || "monume-techno-570702.mp3");
const output = resolve("public/animation");
const RATE = 44100,
  CHANNELS = 2;
const BPM = 125,
  BEATS_PER_BAR = 4,
  FIRST_BAR = 32,
  BARS = 32;
const LEAD = 0.5; // seconds of loop audio repeated before and after it
const HEADROOM = 0.01; // cut this far ahead of the downbeat's transient
const CROSSFADE = 0.04;

const bar = (60 / BPM) * BEATS_PER_BAR;
const work = await mkdtemp(join(tmpdir(), "goat-techno-"));
try {
  const raw = execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      input,
      "-ac",
      String(CHANNELS),
      "-ar",
      String(RATE),
      "-f",
      "f32le",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  // The first downbeat sits a few milliseconds into the file. Locate it, then
  // step whole bars from there so the cut stays on the grid.
  const first = findOnset(samples, CHANNELS, RATE, 0, 0.2);
  const downbeat = findOnset(
    samples,
    CHANNELS,
    RATE,
    first + FIRST_BAR * bar - 0.03,
    first + FIRST_BAR * bar + 0.03,
  );
  const start = Math.round((downbeat - HEADROOM) * RATE),
    length = Math.round(BARS * bar * RATE);
  const loop = periodicLoop(
    samples,
    CHANNELS,
    start,
    length,
    Math.round(CROSSFADE * RATE),
  );
  const lead = Math.round(LEAD * RATE) * CHANNELS;
  // Decoders shift MP3 audio by a few milliseconds. Surrounding the loop with
  // more of itself means a shifted loop region is still the same periodic audio.
  const padded = new Float32Array(lead * 2 + loop.length);
  padded.set(loop.subarray(loop.length - lead), 0);
  padded.set(loop, lead);
  padded.set(loop.subarray(0, lead), lead + loop.length);
  const pcm = join(work, "loop.f32"),
    encoded = join(work, "loop.mp3");
  await writeFile(pcm, Buffer.from(padded.buffer));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "f32le",
    "-ar",
    String(RATE),
    "-ac",
    String(CHANNELS),
    "-i",
    pcm,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "160k",
    "-map_metadata",
    "-1",
    encoded,
  ]);
  const bytes = await readFile(encoded);
  const file = `techno-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}.mp3`;
  await mkdir(output, { recursive: true });
  for (const name of await readdir(output))
    if (/^techno-[0-9a-f]{12}\.mp3$/.test(name) && name !== file)
      await rm(join(output, name));
  await writeFile(join(work, file), bytes);
  await rename(join(work, file), join(output, file));
  const manifest = {
    version: 1,
    file,
    bytes: bytes.length,
    title: "Techno",
    artist: "Monume",
    bpm: BPM,
    beatsPerBar: BEATS_PER_BAR,
    bars: BARS,
    loopStart: LEAD,
    loopLength: length / RATE,
    downbeat: HEADROOM,
    source: { firstBar: FIRST_BAR, start: start / RATE },
  };
  await writeFile(
    join(work, "techno.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rename(join(work, "techno.json"), join(output, "techno.json"));
  console.log(
    `Techno loop: bars ${FIRST_BAR}–${FIRST_BAR + BARS - 1} from ${(start / RATE).toFixed(3)}s, ${(length / RATE).toFixed(2)}s, ${(bytes.length / 1024).toFixed(0)} KiB`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
