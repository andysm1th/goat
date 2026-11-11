import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { TextGoatPlayer } from "../player";
import type { TextGoatOptions } from "../player";

export type TextGoatHandlers = {
  onReady?: () => void;
  onError?: (message: string) => void;
  onPausedChange?: (paused: boolean) => void;
  onTechnoChange?: (techno: boolean) => void;
  onMutedChange?: (muted: boolean) => void;
};

/**
 * Runs a player in `host` for as long as the component is mounted, keeps it in
 * step with `options`, and reports its events to `handlers`.
 *
 * `src`, `variant`, `text` and `labels` are fixed for a player's lifetime, so
 * changing them replaces the player. `fit`, `controls`, `frameRate`, `paused`,
 * `techno` and `muted` set its starting state and are applied again whenever the prop
 * changes; between changes the visitor's clicks decide, and the handlers
 * report them.
 */
export function useTextGoat(
  host: RefObject<HTMLElement | null>,
  options: TextGoatOptions,
  handlers: TextGoatHandlers,
): void {
  const player = useRef<TextGoatPlayer | null>(null);
  // Always the latest, without re-creating the player when they change.
  const latest = useRef({ options, handlers });
  latest.current = { options, handlers };
  const {
    src,
    variant,
    text,
    fit,
    controls,
    paused,
    techno,
    muted,
    frameRate,
  } = options;
  const labels = JSON.stringify(options.labels ?? {});
  // The player takes its starting state from the options itself (and, under
  // reduced motion, starts paused whatever they say), so the effects below
  // skip the run that belongs to its creation.
  const fresh = useRef(true);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const created = (player.current = new TextGoatPlayer(
      element,
      latest.current.options,
    ));
    fresh.current = true;
    const controller = new AbortController();
    const listen = <T>(type: string, handle: (detail: T) => void) =>
      element.addEventListener(
        type,
        (event) => handle((event as CustomEvent<T>).detail),
        { signal: controller.signal },
      );
    listen("goat:ready", () => latest.current.handlers.onReady?.());
    listen<{ message: string }>("goat:error", (detail) =>
      latest.current.handlers.onError?.(detail.message),
    );
    listen("goat:play", () => latest.current.handlers.onPausedChange?.(false));
    listen("goat:pause", () => latest.current.handlers.onPausedChange?.(true));
    listen<{ techno: boolean }>("goat:mode", (detail) =>
      latest.current.handlers.onTechnoChange?.(detail.techno),
    );
    listen<{ muted: boolean }>("goat:mute", (detail) =>
      latest.current.handlers.onMutedChange?.(detail.muted),
    );
    return () => {
      controller.abort();
      created.destroy();
      player.current = null;
    };
  }, [host, src, variant, text, labels]);

  useEffect(() => {
    if (!fresh.current && player.current && fit !== undefined)
      player.current.fit = fit;
  }, [fit]);
  useEffect(() => {
    if (!fresh.current && player.current && controls !== undefined)
      player.current.controls = controls;
  }, [controls]);
  useEffect(() => {
    if (!fresh.current && player.current && paused !== undefined)
      player.current.paused = paused;
  }, [paused]);
  useEffect(() => {
    if (!fresh.current && player.current && techno !== undefined)
      player.current.techno = techno;
  }, [techno]);
  useEffect(() => {
    if (!fresh.current && player.current && muted !== undefined)
      player.current.muted = muted;
  }, [muted]);
  useEffect(() => {
    if (!fresh.current && player.current && frameRate !== undefined)
      player.current.frameRate = frameRate;
  }, [frameRate]);
  // Declared last, so it runs after the effects above on the creating render.
  useEffect(() => {
    fresh.current = false;
  });
}
