import { useEffect } from "react";

/** Keep the page background and mobile browser chrome matched to `color`. */
export function useThemeColor(color: string): void {
  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", color);
    document.documentElement.style.background = color;
  }, [color]);
}
