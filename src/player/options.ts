// The player's public options, events and defaults.
import type { StageFit } from "./stage-layout";

export type TextGoatControls = "full" | "pause" | "none";
export type TextGoatVariant = "auto" | "light" | "standard" | "fine";

export type TextGoatLabels = {
  /** Read to assistive technology in place of the animation. */
  description: string;
  techno: string;
  pause: string;
  play: string;
  mute: string;
  unmute: string;
  loading: string;
  /** Names the group of buttons. */
  controls: string;
};

export type TextGoatOptions = {
  /**
   * URL of the folder holding `manifest.json` and the frame files. Default:
   * `animation/` beside a script-tag `text-goat.js`; `/animation/` otherwise.
   */
  src?: string;
  /** `fill` (default) covers the element; `contain` letterboxes the 16:9 frame. */
  fit?: StageFit;
  /** `full` (default): pause, Techno and sound. `pause`: pause only. `none`: no buttons. */
  controls?: TextGoatControls;
  /** Grid density. `auto` (default) picks by the element's size in device pixels. */
  variant?: TextGoatVariant;
  /** Start paused. Motion also starts paused when the visitor prefers reduced motion. */
  paused?: boolean;
  /** Start in Techno mode. Sound still needs a click: browsers block it otherwise. */
  techno?: boolean;
  /** Start Techno without sound. */
  muted?: boolean;
  /**
   * Frames painted per second, at most. The film is 60; 30 roughly halves the
   * work for a slightly less fluid run. Default 60.
   */
  frameRate?: number;
  /** The word or phrase Techno mode sets along the lines. */
  text?: string;
  labels?: Partial<TextGoatLabels>;
};

export type TextGoatEventMap = {
  "goat:ready": CustomEvent<void>;
  "goat:error": CustomEvent<{ message: string }>;
  "goat:play": CustomEvent<void>;
  "goat:pause": CustomEvent<void>;
  "goat:mode": CustomEvent<{ techno: boolean }>;
  "goat:mute": CustomEvent<{ muted: boolean }>;
};

export const DEFAULT_LABELS: TextGoatLabels = {
  description:
    "A looping animation of a running goat, drawn entirely with text characters.",
  techno: "Techno",
  pause: "Pause animation",
  play: "Play animation",
  mute: "Mute music",
  unmute: "Play music",
  loading: "Loading…",
  controls: "Animation controls",
};

export const DEFAULT_TEXT = "GOAT";
