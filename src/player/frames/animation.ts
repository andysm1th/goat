export type Variant = {
  id: string;
  columns: number;
  rows: number;
  file: string;
  bytes: number;
};

export type Manifest = {
  version: number;
  width: number;
  height: number;
  duration: number;
  frameCount: number;
  timestamps: number[];
  foreground: string;
  background: string;
  palette: string[];
  /** The animal's bounding box over the cycle, as fractions of the frame. */
  focus?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    centre?: number;
  };
  variants: Variant[];
};

export function frameAtTime(timestamps: number[], seconds: number): number {
  let low = 0;
  let high = timestamps.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (timestamps[mid]! <= seconds) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function loopTime(seconds: number, duration: number): number {
  return seconds % duration;
}

// Use only rAF timestamps: its first timestamp can precede performance.now()
// at registration, especially when the browser rounds clocks for privacy.
export function createFrameClock(): (timestamp: number) => number {
  let previous: number | undefined;
  return (timestamp) => {
    const current = Math.max(previous ?? timestamp, timestamp);
    const elapsed = (current - (previous ?? current)) / 1000;
    previous = current;
    return elapsed;
  };
}
