// The player: a self-contained goat inside any element. Framework-free.
//
// Everything renders into the host's shadow root, so the page's styles cannot
// disturb the glyph grid and the player's styles cannot leak into the page.
// This class owns state, loading, layout and the frame loop; the control bar
// (controls.ts) and Techno (techno/techno-mode.ts) are its two collaborators.
import css from "./player.css?inline";
import { Controls } from "./controls";
import { createFrameClock, frameAtTime, loopTime } from "./frames/animation";
import type { Manifest, Variant } from "./frames/animation";
import { releaseEntrance } from "./frames/frame-cache";
import { loadFrames, loadManifest } from "./frames/loader";
import { prepareTextGrid } from "./frames/text-layout";
import { DEFAULT_LABELS, DEFAULT_TEXT } from "./options";
import type {
  TextGoatControls,
  TextGoatEventMap,
  TextGoatLabels,
  TextGoatOptions,
  TextGoatVariant,
} from "./options";
import { performanceAudit } from "./performance-audit";
import { DEFAULT_FOCUS, layoutStage } from "./stage-layout";
import type { StageFit, StageLayout } from "./stage-layout";
import { TechnoMode } from "./techno/techno-mode";
import { TextLayer } from "./text-layer";
import type { TextGrid } from "./text-layer";

// Where the frames are when no `src` is given. The standalone text-goat.js
// (vite.lib.config.ts) sits beside its animation/ folder, wherever that is
// hosted, so a page on another site needs only the script tag. The demo site
// and bundled copies serve animation/ from the site root.
//
// Not written `new URL("animation/", import.meta.url)`: Vite and webpack read
// that form as an asset import, and an app bundling this package would fail
// trying to import a directory.
const ANIMATION_DIR = "animation/";
const DEFAULT_SRC: string = import.meta.env.TEXT_GOAT_STANDALONE
  ? new URL(ANIMATION_DIR, new URL(import.meta.url)).href
  : `${import.meta.env.BASE_URL}${ANIMATION_DIR}`;

const ENTRANCE_SECONDS = 0.95;
const FILM_RATE = 60;
// Shorter than a 60 Hz or 90 Hz frame, longer than a 120 Hz one.
const FILM_STEP = 0.0095;

export class TextGoatPlayer {
  /** Resolves once the first frame is on screen; rejects if loading fails. */
  readonly ready: Promise<void>;
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly base: string;
  private readonly labels: TextGoatLabels;
  private readonly variant: TextGoatVariant;
  private readonly abort = new AbortController();
  private readonly reducedMotion = matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  private readonly stage = document.createElement("div");
  private readonly art = document.createElement("div");
  private readonly message = document.createElement("div");
  /** The film: goat, lines and floor. */
  private readonly sharp = new TextLayer("sharp");
  /** The goat and floor alone, for Techno. */
  private readonly solo = new TextLayer("solo");
  private readonly controlBar: Controls;
  private readonly technoMode: TechnoMode;
  private readonly resizeObserver: ResizeObserver;
  private readonly intersectionObserver: IntersectionObserver;
  private settle!: { resolve: () => void; reject: (cause: Error) => void };

  // Loading
  private manifest: Manifest | null = null;
  private sharpVariant: Variant | null = null;
  private soloVariant: Variant | null = null;
  private sharpGrid: TextGrid | null = null;
  private soloGrid: TextGrid | null = null;
  private soloRequested = false;
  private error = "";
  private destroyed = false;

  // State
  private playing: boolean;
  private technoOn: boolean;
  private mutedOn: boolean;
  private fitMode: StageFit;
  private controlsMode: TextGoatControls;
  private rate: number;
  private pageVisible = !document.hidden;
  private onscreen = true;

  // Playback
  private entered: boolean;
  private revealing: boolean;
  private entranceTime = 0;
  private position = 0;
  private request = 0;
  private clock = createFrameClock();
  /** Frame time not yet turned into a step of the picture. */
  private pending = 0;

  // Layout
  private width = 0;
  private height = 0;
  private layout: StageLayout | null = null;

  constructor(host: HTMLElement, options: TextGoatOptions = {}) {
    this.host = host;
    this.root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const src = options.src ?? DEFAULT_SRC;
    this.base = new URL(
      src.endsWith("/") ? src : `${src}/`,
      document.baseURI,
    ).href;
    this.labels = { ...DEFAULT_LABELS, ...options.labels };
    this.variant = options.variant ?? "auto";
    this.fitMode = options.fit ?? "fill";
    this.controlsMode = options.controls ?? "full";
    this.rate = frameRateOf(options.frameRate);
    this.technoOn = options.techno ?? false;
    this.mutedOn = options.muted ?? false;
    this.playing = !options.paused && !this.reducedMotion.matches;
    this.entered = this.reducedMotion.matches;
    this.revealing = !this.reducedMotion.matches;
    this.ready = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.ready.catch(() => {});

    const signal = this.abort.signal;
    this.controlBar = new Controls(this.labels, {
      onTechno: () => {
        this.techno = !this.technoOn;
      },
      onSound: () => {
        this.muted = !this.mutedOn;
      },
      onMotion: () => {
        this.paused = this.playing;
      },
    });
    this.technoMode = new TechnoMode(
      this.stage,
      this.base,
      options.text?.trim() || DEFAULT_TEXT,
      signal,
    );
    this.build();

    // Selecting text pauses the animation. Moving text cannot usefully be
    // selected, and rewriting text inside a live selection makes the browser
    // rebuild and repaint the highlight on every frame.
    document.addEventListener(
      "selectionchange",
      () => {
        if (this.playing && this.selectedRange()) this.paused = true;
      },
      { signal },
    );
    // Browsers differ in when a selection over changing text first registers,
    // so a drag across the stage pauses as well: it is how a selection starts.
    let pressed: { x: number; y: number } | null = null;
    this.stage.addEventListener(
      "pointerdown",
      (event) => {
        pressed =
          event.button === 0 &&
          !this.controlBar.element.contains(event.target as Node)
            ? { x: event.clientX, y: event.clientY }
            : null;
      },
      { signal },
    );
    this.stage.addEventListener(
      "pointermove",
      (event) => {
        if (
          pressed &&
          this.playing &&
          Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4
        )
          this.paused = true;
      },
      { signal },
    );
    window.addEventListener(
      "pointerup",
      () => {
        pressed = null;
      },
      { signal },
    );
    // Copying a selection gives the picture as lines of text.
    this.stage.addEventListener(
      "copy",
      (event) => {
        const range = this.selectedRange();
        // In Techno the running text is what can be selected; otherwise the film.
        const source = this.technoActive ? this.technoMode : this.sharp;
        const text =
          range &&
          source.textBetween(
            range.startContainer,
            range.startOffset,
            range.endContainer,
            range.endOffset,
          );
        if (!text || !event.clipboardData) return;
        event.clipboardData.setData("text/plain", text);
        event.preventDefault();
      },
      { signal },
    );
    // The goat can be selected and copied, but not dragged: dropping a dragged
    // selection on a page makes browsers try to open the text as an address.
    this.stage.addEventListener(
      "dragstart",
      (event) => event.preventDefault(),
      { signal },
    );

    this.resizeObserver = new ResizeObserver(([entry]) =>
      this.resize(entry!.contentRect.width, entry!.contentRect.height),
    );
    this.resizeObserver.observe(this.stage);
    // Nothing animates, and no audio plays, while the element is scrolled away.
    this.intersectionObserver = new IntersectionObserver((entries) => {
      this.onscreen = entries.at(-1)!.isIntersecting;
      this.refresh();
    });
    this.intersectionObserver.observe(host);
    document.addEventListener(
      "visibilitychange",
      () => {
        this.pageVisible = !document.hidden;
        this.refresh();
      },
      { signal },
    );
    this.reducedMotion.addEventListener(
      "change",
      () => {
        if (!this.reducedMotion.matches) return;
        this.finishEntrance();
        this.paused = true;
      },
      { signal },
    );

    loadManifest(this.base, signal)
      .then((manifest) => {
        this.manifest = manifest;
        this.begin();
      })
      .catch((cause: Error) => this.fail(cause));
    this.refresh();
  }

  get paused(): boolean {
    return !this.playing;
  }
  set paused(value: boolean) {
    if (value === !this.playing) return;
    this.playing = !value;
    // Playing again lets go of any selection, which would otherwise pause it straight away.
    if (!value && this.selectedRange())
      document.getSelection()?.removeAllRanges();
    this.emit(value ? "goat:pause" : "goat:play");
    this.refresh();
  }

  get techno(): boolean {
    return this.technoOn;
  }
  set techno(value: boolean) {
    if (value === this.technoOn) return;
    this.technoOn = value;
    if (value) this.technoMode.restart();
    this.emit("goat:mode", { techno: value });
    this.refresh();
  }

  get muted(): boolean {
    return this.mutedOn;
  }
  set muted(value: boolean) {
    if (value === this.mutedOn) return;
    this.mutedOn = value;
    this.emit("goat:mute", { muted: value });
    this.refresh();
  }

  get fit(): StageFit {
    return this.fitMode;
  }
  set fit(value: StageFit) {
    if (value === this.fitMode) return;
    this.fitMode = value;
    this.relayout();
    this.refresh();
  }

  get controls(): TextGoatControls {
    return this.controlsMode;
  }
  set controls(value: TextGoatControls) {
    if (value === this.controlsMode) return;
    this.controlsMode = value;
    this.refresh();
  }

  /** Frames painted per second, at most. Takes effect on the next frame. */
  get frameRate(): number {
    return this.rate;
  }
  set frameRate(value: number) {
    this.rate = frameRateOf(value);
  }

  play(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }

  /** Stop everything and empty the host. The host can be given a new player. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    cancelAnimationFrame(this.request);
    this.resizeObserver.disconnect();
    this.intersectionObserver.disconnect();
    this.technoMode.dispose();
    this.root.replaceChildren();
    this.settle.reject(new Error("The player was destroyed."));
  }

  // A selection inside a shadow root is hidden from `document.getSelection()`;
  // browsers expose it through one of two newer methods.
  private selectedRange(): AbstractRange | null {
    const selection = document.getSelection();
    if (selection && "getComposedRanges" in selection) {
      const [range] = selection.getComposedRanges({ shadowRoots: [this.root] });
      if (range && !range.collapsed) return range;
    }
    const scoped = (
      this.root as ShadowRoot & { getSelection?: () => Selection | null }
    ).getSelection?.();
    return scoped && scoped.rangeCount && !scoped.isCollapsed
      ? scoped.getRangeAt(0)
      : null;
  }

  private get available(): boolean {
    return this.sharp.cache !== null;
  }
  // Techno takes over once the entrance has played; until then the film shows.
  private get technoActive(): boolean {
    return this.technoOn && this.entered && this.solo.cache !== null;
  }
  private get running(): boolean {
    return this.playing && this.pageVisible && this.onscreen && this.available;
  }

  private build(): void {
    const style = document.createElement("style");
    style.textContent = css;
    this.stage.className = "stage";
    this.art.className = "art";
    this.art.append(
      this.sharp.element,
      this.sharp.bleed,
      this.solo.element,
      this.solo.bleed,
    );
    const description = document.createElement("span");
    description.className = "sr-only";
    description.textContent = this.labels.description;
    this.message.className = "message";
    this.message.setAttribute("role", "status");
    this.stage.append(
      this.technoMode.element,
      this.art,
      description,
      this.message,
      this.controlBar.element,
    );
    this.root.replaceChildren(style, this.stage);
  }

  private emit(type: keyof TextGoatEventMap, detail?: unknown): void {
    this.host.dispatchEvent(new CustomEvent(type, { detail }));
  }

  private fail(cause: unknown): void {
    if (this.destroyed || this.abort.signal.aborted) return;
    this.error =
      cause instanceof Error
        ? cause.message
        : "The animation could not be loaded.";
    this.settle.reject(new Error(this.error));
    this.emit("goat:error", { message: this.error });
    this.refresh();
  }

  // ---- Loading ------------------------------------------------------------

  // The grid density depends on the element's size, so loading starts once
  // both the manifest and a first measurement are in.
  private begin(): void {
    const manifest = this.manifest;
    if (
      !manifest ||
      this.sharpVariant ||
      this.error ||
      !(this.width > 0 && this.height > 0)
    )
      return;
    const art = layoutStage(
      this.width,
      this.height,
      manifest.width,
      manifest.height,
      manifest.focus ?? DEFAULT_FOCUS,
      this.fitMode,
    );
    // The finest grid whose cells still cover about 1.5 device pixels; finer
    // text only turns to noise.
    const dense = art.width * devicePixelRatio >= 960;
    const wanted =
      this.variant !== "auto"
        ? this.variant
        : art.width >= 1600
          ? "fine"
          : dense
            ? "standard"
            : "light";
    const find = (id: string) =>
      manifest.variants.find((variant) => variant.id === id);
    const sharp = find(wanted) ?? find("standard");
    if (!sharp) {
      this.fail(new Error("The animation manifest has no usable variant."));
      return;
    }
    this.sharpVariant = sharp;
    this.soloVariant =
      (dense ? find("solo") : find("solo-light")) ?? find("solo") ?? null;
    try {
      this.sharpGrid = prepareTextGrid(sharp.columns, sharp.rows);
      if (this.soloVariant)
        this.soloGrid = prepareTextGrid(
          this.soloVariant.columns,
          this.soloVariant.rows,
        );
    } catch (cause) {
      this.fail(cause);
      return;
    }
    const started = performanceAudit ? performance.now() : 0;
    loadFrames(this.base, sharp, manifest.frameCount, this.abort.signal, {
      entrance: !this.entered,
    })
      .then((cache) => {
        performanceAudit?.record(
          "load.sharpWorkerRoundTripMs",
          performance.now() - started,
        );
        this.sharp.mount(cache, this.sharpGrid!);
        if (!cache.entrance.length) this.finishEntrance();
        this.relayout();
        this.refresh();
        this.settle.resolve();
        this.emit("goat:ready");
        // After the entrance, so Techno's downloads never hold up the goat.
        setTimeout(
          () => this.preloadTechno(),
          this.entered ? 0 : ENTRANCE_SECONDS * 1000,
        );
      })
      .catch((cause) => this.fail(cause));
  }

  // With the goat running, fetch Techno's frames and music, so switching to it
  // is immediate and the music starts with the click. Skipped where there is
  // no Techno button, or the visitor's browser asks to save data.
  private preloadTechno(): void {
    const saveData = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection?.saveData;
    if (this.destroyed || this.controlsMode !== "full" || saveData) return;
    this.loadTechno();
    this.technoMode.preload();
  }

  // Techno's frames and track: preloaded, or else fetched when it is switched on.
  private loadTechno(): void {
    const manifest = this.manifest;
    if (this.soloRequested || !manifest || !this.soloVariant || !this.soloGrid)
      return;
    this.soloRequested = true;
    this.technoMode.load();
    loadFrames(
      this.base,
      this.soloVariant,
      manifest.frameCount,
      this.abort.signal,
      { runs: true },
    )
      .then((cache) => {
        this.solo.mount(cache, this.soloGrid!);
        this.relayout();
        this.refresh();
      })
      .catch(() => {
        // Techno is an extra. If its frames cannot load, stay with the goat and
        // let the next click try again.
        this.soloRequested = false;
        if (!this.abort.signal.aborted) this.techno = false;
      });
  }

  // ---- Layout -------------------------------------------------------------

  private resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.begin();
    this.relayout();
    this.refresh();
  }

  private relayout(): void {
    const manifest = this.manifest;
    if (!manifest || !(this.width > 0 && this.height > 0)) return;
    const layout = (this.layout = layoutStage(
      this.width,
      this.height,
      manifest.width,
      manifest.height,
      manifest.focus ?? DEFAULT_FOCUS,
      this.fitMode,
    ));
    const style = this.art.style;
    style.left = `${layout.left}px`;
    style.top = `${layout.top}px`;
    style.width = `${layout.width}px`;
    style.height = `${layout.height}px`;
    // The side continuation repeats only the part of the frame the goat never
    // enters, with a little margin.
    const focus = manifest.focus ?? DEFAULT_FOCUS;
    const clear = {
      left: Math.max(0, focus.left - 0.01),
      right: Math.max(0, 1 - focus.right - 0.01),
    };
    // The part of the art that falls inside the stage.
    const visible = {
      left: Math.max(0, -layout.left / layout.width),
      right: Math.min(1, (this.width - layout.left) / layout.width),
      top: Math.max(0, -layout.top / layout.height),
      bottom: Math.min(1, (this.height - layout.top) / layout.height),
    };
    for (const [layer, grid] of [
      [this.sharp, this.sharpGrid],
      [this.solo, this.soloGrid],
    ] as const) {
      if (!grid || !layer.cache) continue;
      const scale = layout.width / grid.width;
      layer.place(
        scale,
        {
          left: layout.gapLeft / scale,
          right: layout.gapRight / scale,
          top: layout.gapTop / scale,
          bottom: layout.gapBottom / scale,
        },
        clear,
        visible,
      );
    }
    this.technoMode.resize(this.width, this.height);
  }

  // ---- State --------------------------------------------------------------

  /** Bring the DOM, the frame loop and the audio in line with the state. */
  private refresh(): void {
    if (this.destroyed) return;
    const { stage } = this;
    stage.classList.toggle("is-techno", this.technoActive);
    this.art.classList.toggle("is-revealing", this.revealing && this.available);
    stage.setAttribute("aria-busy", String(!this.available && !this.error));
    stage.style.setProperty(
      "--motion-state",
      this.running ? "running" : "paused",
    );
    this.message.textContent = this.available
      ? ""
      : this.error || this.labels.loading;
    this.controlBar.update({
      mode: this.controlsMode,
      techno: this.technoOn,
      muted: this.mutedOn,
      playing: this.playing,
      available: this.available,
    });

    if (this.technoOn) this.loadTechno();
    this.technoMode
      .setAudible(this.technoOn && !this.mutedOn && this.running)
      .catch(() => {
        // Blocked (no user gesture yet) or failed to load: show sound as off so
        // the visitor's click on it can start the music.
        if (!this.destroyed) this.muted = true;
      });
    if (this.running && !this.request) {
      this.clock = createFrameClock();
      performanceAudit?.resetClock();
      this.request = requestAnimationFrame(this.tick);
    } else if (!this.running && this.request) {
      cancelAnimationFrame(this.request);
      this.request = 0;
    }
    if (this.available) this.paint();
  }

  // ---- Playback -----------------------------------------------------------

  private tick = (now: number): void => {
    const started = performanceAudit ? performance.now() : 0;
    const mode = this.technoActive ? "techno" : "normal";
    performanceAudit?.frame(mode, now);
    const elapsed = this.clock(now),
      duration = this.manifest!.duration;
    // Time runs on every display refresh; the picture steps at the frame rate.
    // The film is 60 frames a second, so stepping faster than that (on a 120 Hz
    // display) would only repeat work, and a lower `frameRate` skips frames.
    this.pending += elapsed;
    const step = this.rate >= FILM_RATE ? FILM_STEP : 1 / this.rate - 0.002;
    if (this.pending >= step) {
      if (this.technoActive)
        this.position = loopTime(
          this.position + this.technoMode.advance(this.pending, duration),
          duration,
        );
      else if (this.entered)
        this.position = loopTime(this.position + this.pending, duration);
      else this.entranceTime += this.pending;
      this.pending = 0;
      this.paint();
    }
    performanceAudit?.record(`${mode}.tickCpuMs`, performance.now() - started);
    this.request = requestAnimationFrame(this.tick);
  };

  private paint(): void {
    const cache = this.sharp.cache,
      manifest = this.manifest;
    if (!cache || !manifest) return;
    if (!this.entered) {
      const steps = cache.entrance.length;
      if (steps) {
        this.sharp.paintEntrance(
          Math.max(
            0,
            Math.min(
              steps - 1,
              Math.floor((this.entranceTime / ENTRANCE_SECONDS) * steps),
            ),
          ),
        );
        if (this.entranceTime < ENTRANCE_SECONDS) return;
      }
      this.finishEntrance();
      this.art.classList.remove("is-revealing");
      this.stage.classList.toggle("is-techno", this.technoActive);
    }
    const index = frameAtTime(manifest.timestamps, this.position);
    if (!this.technoActive) {
      const writes = this.sharp.paint(index);
      performanceAudit?.record("normal.sharpWrites", writes);
      return;
    }
    this.solo.paint(index);
    const layout = this.layout,
      variant = this.soloVariant;
    if (!layout || !variant) return;
    const cell = layout.width / variant.columns;
    this.technoMode.paint(this.solo.cache!.runs?.[index], {
      left: layout.left,
      top: layout.top,
      width: layout.width,
      height: layout.height,
      columns: variant.columns,
      rows: variant.rows,
      gapLeft: layout.gapLeft,
      gapRight: layout.gapRight,
      gapTop: layout.gapTop,
      gapBottom: layout.gapBottom,
      stripLeft: this.solo.strip.left * cell,
      stripRight: this.solo.strip.right * cell,
    });
  }

  private finishEntrance(): void {
    this.entered = true;
    if (!this.revealing) return;
    this.revealing = false;
    if (this.sharp.cache) releaseEntrance(this.sharp.cache);
    this.sharp.reset();
  }
}

function frameRateOf(value: number | undefined): number {
  return value !== undefined && value > 0 && Number.isFinite(value)
    ? Math.min(FILM_RATE, value)
    : FILM_RATE;
}

export function createTextGoat(
  host: HTMLElement,
  options?: TextGoatOptions,
): TextGoatPlayer {
  return new TextGoatPlayer(host, options);
}
