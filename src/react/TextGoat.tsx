// <TextGoat />: the player as a React component.
//
// Safe to import where there is no DOM (Next.js server rendering): the player
// is only created in an effect. In an App Router project, render it from a
// client component.
import { useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { TextGoatOptions } from "../player";
import { useTextGoat } from "./useTextGoat";
import type { TextGoatHandlers } from "./useTextGoat";

export type TextGoatProps = TextGoatOptions &
  TextGoatHandlers & {
    className?: string;
    style?: CSSProperties;
    /** Extra controls: give each `slot="controls"` to place it after Techno. */
    children?: ReactNode;
  };

export function TextGoat({
  className,
  style,
  children,
  onReady,
  onError,
  onPausedChange,
  onTechnoChange,
  onMutedChange,
  ...options
}: TextGoatProps) {
  const host = useRef<HTMLDivElement>(null);
  useTextGoat(host, options, {
    onReady,
    onError,
    onPausedChange,
    onTechnoChange,
    onMutedChange,
  });
  return (
    <div ref={host} className={className} style={style}>
      {children}
    </div>
  );
}
