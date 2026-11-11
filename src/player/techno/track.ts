// The Techno loop: gapless Web Audio playback and the clock the visuals follow.
//
// The recording is decoded once and looped by an AudioBufferSourceNode, which
// wraps sample-accurately. (An <audio loop> element leaves an audible gap on
// MP3.) While it plays, `position()` reads the audio clock, so the animation
// follows the sound rather than drifting beside it. Where Web Audio is missing
// (iOS Lockdown Mode turns it off) an <audio> element plays instead.
export type TechnoManifest = {
  version: number;
  file: string;
  bpm: number;
  beatsPerBar: number;
  bars: number;
  /** Seconds into the file where the loop region begins. */
  loopStart: number;
  loopLength: number;
  /** Seconds into the loop of its first downbeat. */
  downbeat: number;
};

export type Tempo = Pick<TechnoManifest, "bpm" | "loopLength" | "downbeat">;

/** Used until the manifest arrives; matches the shipped recording. */
export const DEFAULT_TEMPO: Tempo = {
  bpm: 125,
  loopLength: 61.44,
  downbeat: 0.01,
};

/** Beats elapsed at `seconds` on the Techno timeline. */
export function beatsAt(seconds: number, tempo: Tempo): number {
  return ((seconds - tempo.downbeat) * tempo.bpm) / 60;
}

/** A short, smooth pulse on every beat: 1 on the beat, 0 between. */
export function kickAt(beats: number): number {
  return Math.max(0, Math.cos((beats - Math.floor(beats)) * Math.PI * 2)) ** 4;
}

/**
 * How fast the animation must run for a whole number of its cycles to span the
 * music loop exactly, so picture and sound repeat together.
 */
export function cycleRate(cycleSeconds: number, tempo: Tempo): number {
  const cycles = Math.max(1, Math.round(tempo.loopLength / cycleSeconds));
  return (cycles * cycleSeconds) / tempo.loopLength;
}

/**
 * Move a running timeline onto the audio clock. `position` is seconds into the
 * loop; the result is the timeline value nearest `expected` with that phase,
 * so the timeline keeps counting through loop wraps.
 */
export function followLoop(
  expected: number,
  position: number,
  loopLength: number,
): number {
  return position + Math.round((expected - position) / loopLength) * loopLength;
}

// Safari's Audio Session API (iOS 16.4+); not in the DOM types.
type AudioSession = { type: string };
const audioSession = (): AudioSession | undefined =>
  (navigator as Navigator & { audioSession?: AudioSession }).audioSession;

export class TechnoTrack {
  private manifest: Promise<TechnoManifest> | null = null;
  private meta: TechnoManifest | null = null;
  private context: AudioContext | null = null;
  private buffer: Promise<AudioBuffer> | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** The fallback player, once Web Audio has turned out to be unavailable. */
  private element: HTMLAudioElement | null = null;
  private origin = 0;
  private generation = 0;
  private disposed = false;
  private readonly base: string;

  constructor(base: string) {
    this.base = base;
  }

  get tempo(): Tempo {
    return this.meta ?? DEFAULT_TEMPO;
  }

  /** Fetch the timing alone. The audio itself waits for `start` or `preload`. */
  load(): Promise<TechnoManifest> {
    return (this.manifest ??= fetch(new URL("techno.json", this.base), {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("The Techno track could not be loaded.");
        const meta = (await response.json()) as TechnoManifest;
        if (meta.version !== 1 || !(meta.loopLength > 0) || !(meta.bpm > 0))
          throw new Error("The Techno track manifest is invalid.");
        return (this.meta = meta);
      })
      .catch((cause) => {
        // A failed request is not remembered: the next attempt fetches again.
        this.manifest = null;
        throw cause;
      }));
  }

  /**
   * Download and decode the music before it is asked for, so the first click
   * starts it at once. An offline context decodes without a user gesture.
   * Without Web Audio, the download alone fills the HTTP cache for <audio>.
   */
  preload(): void {
    if (this.disposed) return;
    this.load()
      .then(async (meta): Promise<unknown> => {
        if (typeof OfflineAudioContext === "function")
          return this.decode(meta, new OfflineAudioContext(1, 1, 44100));
        return (await fetch(this.url(meta))).arrayBuffer();
      })
      .catch(() => {});
  }

  /**
   * Begin audible playback. Call from a user gesture: browsers only let audio
   * start there. `position` is read at the moment sound actually begins, since
   * the first call may have to download and decode.
   */
  async start(position: () => number): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    // iOS plays Web Audio as ambient sound, which the silent switch mutes.
    // Music the visitor switched on should play like any other media.
    const session = audioSession();
    if (session) session.type = "playback";
    const context = this.element ? null : this.audioContext();
    // Must run within the click, before anything is awaited.
    if (!context) return this.startElement(position, generation);
    // Without a user gesture the browser leaves the context suspended and this
    // promise pending, so give it a moment and then report audio as blocked,
    // before downloading anything.
    await Promise.race([
      context.resume(),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    if (generation !== this.generation || this.disposed) return;
    if (context.state !== "running")
      throw new Error(
        "Audio is blocked until the visitor interacts with the page.",
      );
    const meta = await this.load();
    const buffer = await this.decode(meta, context);
    if (generation !== this.generation || this.disposed) return;
    this.source?.stop();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = meta.loopStart;
    source.loopEnd = meta.loopStart + meta.loopLength;
    source.connect(context.destination);
    const at =
      ((position() % meta.loopLength) + meta.loopLength) % meta.loopLength;
    const when = context.currentTime + 0.03;
    source.start(when, meta.loopStart + at);
    this.source = source;
    this.origin = when - at;
  }

  /** Seconds into the loop that are audible now, or null while silent. */
  position(): number | null {
    const meta = this.meta;
    if (!meta) return null;
    const element = this.element;
    if (element) {
      if (
        element.paused ||
        element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
      )
        return null;
      wrapElement(element, meta);
      const into = element.currentTime - meta.loopStart;
      return ((into % meta.loopLength) + meta.loopLength) % meta.loopLength;
    }
    const context = this.context;
    if (!context || !this.source || context.state !== "running") return null;
    const heard =
      context.currentTime -
      (context.outputLatency || context.baseLatency || 0) -
      this.origin;
    if (heard < 0) return null;
    return heard % meta.loopLength;
  }

  stop(): void {
    this.generation++;
    this.source?.stop();
    this.source?.disconnect();
    this.source = null;
    this.element?.pause();
    // Also when a resume is still pending, or it would land after this stop.
    if (this.context && this.context.state !== "closed")
      void this.context.suspend();
    // Hand the audio session back to the page.
    const session = audioSession();
    if (session?.type === "playback") session.type = "auto";
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    if (this.context) void this.context.close();
    this.context = null;
    this.buffer = null;
    if (this.element) {
      this.element.removeAttribute("src");
      this.element.load();
      this.element = null;
    }
  }

  private url(meta: TechnoManifest): URL {
    return new URL(meta.file, this.base);
  }

  /** The live context, or null where Web Audio is unavailable. */
  private audioContext(): AudioContext | null {
    if (this.context) return this.context;
    if (typeof AudioContext !== "function") return null;
    try {
      return (this.context = new AudioContext());
    } catch {
      return null;
    }
  }

  /** The decoded recording, fetched and decoded once by whichever context asks first. */
  private decode(
    meta: TechnoManifest,
    context: BaseAudioContext,
  ): Promise<AudioBuffer> {
    return (this.buffer ??= fetch(this.url(meta))
      .then((response) => {
        if (!response.ok)
          throw new Error("The Techno track could not be loaded.");
        return response.arrayBuffer();
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .catch((cause) => {
        this.buffer = null;
        throw cause;
      }));
  }

  // The fallback: an <audio> element cannot loop a region, so it is moved back
  // a loop length whenever it passes the end. The file runs on past the loop
  // with the loop's own opening, so the audio there is already the right audio
  // and each pass costs only the seek. play() has to be called within the
  // click, so this needs the timing already loaded, as preloading ensures.
  private startElement(
    position: () => number,
    generation: number,
  ): Promise<void> {
    const meta = this.meta;
    if (!meta) {
      this.load().catch(() => {});
      return Promise.reject(new Error("The Techno track is still loading."));
    }
    const element = (this.element ??= createElement(this.url(meta), meta));
    const at =
      ((position() % meta.loopLength) + meta.loopLength) % meta.loopLength;
    element.currentTime = meta.loopStart + at;
    return element.play().then(() => {
      if (generation !== this.generation || this.disposed) element.pause();
    });
  }
}

function createElement(url: URL, meta: TechnoManifest): HTMLAudioElement {
  const element = new Audio(url.href);
  element.preload = "auto";
  element.addEventListener("timeupdate", () => wrapElement(element, meta));
  // A background tab can delay the wrap until the file runs out.
  element.addEventListener("ended", () => {
    element.currentTime = meta.loopStart;
    element.play().catch(() => {});
  });
  return element;
}

function wrapElement(element: HTMLAudioElement, meta: TechnoManifest): void {
  if (element.currentTime >= meta.loopStart + meta.loopLength)
    element.currentTime -= meta.loopLength;
}
