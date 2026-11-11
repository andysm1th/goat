// The control bar: Techno, sound and play/pause, then anything the host page
// slots in.
import type { TextGoatControls, TextGoatLabels } from "./options";

const ICONS = {
  pause:
    '<svg viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M1.5 0h2a.8.8 0 0 1 .8.8v8.4a.8.8 0 0 1-.8.8h-2a.8.8 0 0 1-.8-.8V.8a.8.8 0 0 1 .8-.8Zm5 0h2a.8.8 0 0 1 .8.8v8.4a.8.8 0 0 1-.8.8h-2a.8.8 0 0 1-.8-.8V.8a.8.8 0 0 1 .8-.8Z"/></svg>',
  play: '<svg viewBox="0 0 10 10" aria-hidden="true"><path fill="currentColor" d="M1.6.3 9.2 4.4a.7.7 0 0 1 0 1.2L1.6 9.7A.7.7 0 0 1 .6 9.1V.9a.7.7 0 0 1 1-.6Z"/></svg>',
  sound:
    '<svg viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M6.6 1.6v10.8L3.3 9.6H1V4.4h2.3l3.3-2.8Z"/><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="M9 4.8a3.2 3.2 0 0 1 0 4.4M10.8 3a5.7 5.7 0 0 1 0 8"/></svg>',
  muted:
    '<svg viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M6.6 1.6v10.8L3.3 9.6H1V4.4h2.3l3.3-2.8Z"/><path fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" d="m9 5 3.6 4M12.6 5 9 9"/></svg>',
};

export type ControlsState = {
  mode: TextGoatControls;
  techno: boolean;
  muted: boolean;
  playing: boolean;
  /** False until the animation has loaded. */
  available: boolean;
};

export type ControlsHandlers = {
  onTechno: () => void;
  onSound: () => void;
  onMotion: () => void;
};

export class Controls {
  readonly element = document.createElement("div");
  private readonly techno = button("tag");
  private readonly sound = button("round sound");
  private readonly motion = button("round motion");
  private readonly labels: TextGoatLabels;

  // A click is the gesture that lets audio start, so the handlers are called
  // synchronously from it.
  constructor(labels: TextGoatLabels, handlers: ControlsHandlers) {
    this.labels = labels;
    this.element.className = "controls";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", labels.controls);
    this.techno.textContent = labels.techno;
    this.techno.addEventListener("click", handlers.onTechno);
    this.sound.addEventListener("click", handlers.onSound);
    this.motion.addEventListener("click", handlers.onMotion);
    // The host page's own links or buttons (`slot="controls"`) follow Techno.
    const extra = document.createElement("slot");
    extra.name = "controls";
    // Techno sits after the built-in buttons and sound appears at the start, so
    // switching Techno on never moves the button that was just pressed.
    this.element.append(this.sound, this.motion, this.techno, extra);
  }

  update(state: ControlsState): void {
    const { labels } = this;
    this.element.hidden = state.mode === "none";
    this.techno.hidden = state.mode !== "full";
    this.techno.setAttribute("aria-pressed", String(state.techno));
    this.sound.hidden = state.mode !== "full" || !state.techno;
    setIcon(
      this.sound,
      state.muted ? "muted" : "sound",
      state.muted ? labels.unmute : labels.mute,
    );
    setIcon(
      this.motion,
      state.playing ? "pause" : "play",
      state.playing ? labels.pause : labels.play,
    );
    this.techno.disabled = this.motion.disabled = !state.available;
  }
}

function button(className: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  return element;
}

function setIcon(
  element: HTMLButtonElement,
  icon: keyof typeof ICONS,
  label: string,
): void {
  if (element.dataset.icon !== icon) {
    element.dataset.icon = icon;
    element.innerHTML = ICONS[icon];
  }
  if (element.getAttribute("aria-label") !== label) {
    element.setAttribute("aria-label", label);
    element.title = label;
  }
}
