// <text-goat>: the player as a custom element, for any page or framework.
//
//   <script type="module" src="https://…/text-goat.js"></script>
//   <text-goat style="height: 100vh"></text-goat>
//
// Loaded by a script tag, it finds its frames in animation/ beside the script.
// Attributes: src, fit ("fill" | "contain"), controls ("full" | "pause" |
// "none"), variant, text, label, frame-rate, paused, techno, muted. The last three are
// also properties, alongside play() and pause(). Events: goat:ready,
// goat:error, goat:play, goat:pause, goat:mode, goat:mute. Children with
// slot="controls" join the control bar after Techno.

import { TextGoatPlayer } from "../player";
import type {
  StageFit,
  TextGoatControls,
  TextGoatOptions,
  TextGoatVariant,
} from "../player";

export * from "../player";

/** Register the element. Safe to call more than once, and on a server. */
export function defineTextGoat(tag = "text-goat"): void {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;

  class TextGoatElement extends HTMLElement {
    static observedAttributes = [
      "src",
      "fit",
      "controls",
      "variant",
      "text",
      "label",
      "paused",
      "techno",
      "muted",
      "frame-rate",
    ];
    private player: TextGoatPlayer | null = null;

    connectedCallback() {
      this.mount();
    }
    disconnectedCallback() {
      this.player?.destroy();
      this.player = null;
    }

    attributeChangedCallback(
      name: string,
      _old: string | null,
      value: string | null,
    ) {
      const player = this.player;
      if (!player) return;
      if (name === "paused") player.paused = value !== null;
      else if (name === "techno") player.techno = value !== null;
      else if (name === "muted") player.muted = value !== null;
      else if (name === "fit")
        player.fit = (value as StageFit | null) ?? "fill";
      else if (name === "controls")
        player.controls = (value as TextGoatControls | null) ?? "full";
      else if (name === "frame-rate") player.frameRate = Number(value);
      // Source, density and text are fixed for a player's lifetime.
      else {
        player.destroy();
        this.mount();
      }
    }

    get paused() {
      return this.player?.paused ?? this.hasAttribute("paused");
    }
    set paused(value: boolean) {
      if (this.player) this.player.paused = value;
      else this.toggleAttribute("paused", value);
    }
    get techno() {
      return this.player?.techno ?? this.hasAttribute("techno");
    }
    set techno(value: boolean) {
      if (this.player) this.player.techno = value;
      else this.toggleAttribute("techno", value);
    }
    get muted() {
      return this.player?.muted ?? this.hasAttribute("muted");
    }
    set muted(value: boolean) {
      if (this.player) this.player.muted = value;
      else this.toggleAttribute("muted", value);
    }
    play() {
      this.paused = false;
    }
    pause() {
      this.paused = true;
    }

    private mount() {
      const attribute = (name: string) => this.getAttribute(name) ?? undefined;
      const label = attribute("label");
      const options: TextGoatOptions = {
        src: attribute("src"),
        fit: attribute("fit") as StageFit | undefined,
        controls: attribute("controls") as TextGoatControls | undefined,
        variant: attribute("variant") as TextGoatVariant | undefined,
        text: attribute("text"),
        frameRate: this.hasAttribute("frame-rate")
          ? Number(attribute("frame-rate"))
          : undefined,
        paused: this.hasAttribute("paused"),
        techno: this.hasAttribute("techno"),
        muted: this.hasAttribute("muted"),
        labels: label ? { description: label } : undefined,
      };
      this.player = new TextGoatPlayer(this, options);
    }
  }

  customElements.define(tag, TextGoatElement);
}

defineTextGoat();
