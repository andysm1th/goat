// Opt-in browser diagnostics: ?profile=1. Normal playback creates no buffers,
// observers, performance marks or per-frame clocks for this instrumentation.
const CAPACITY = 4096;
type Samples = {
  values: Float64Array;
  count: number;
  total: number;
  maximum: number;
};

export class PerformanceAudit {
  private samples = new Map<string, Samples>();
  private previous = new Map<string, number>();

  record(name: string, value: number) {
    if (!Number.isFinite(value) || value < 0) return;
    let sample = this.samples.get(name);
    if (!sample) {
      sample = {
        values: new Float64Array(CAPACITY),
        count: 0,
        total: 0,
        maximum: 0,
      };
      this.samples.set(name, sample);
    }
    sample.values[sample.count % CAPACITY] = value;
    sample.count++;
    sample.total += value;
    sample.maximum = Math.max(sample.maximum, value);
  }

  frame(mode: string, now: number) {
    const previous = this.previous.get(mode);
    if (previous !== undefined)
      this.record(`${mode}.rafIntervalMs`, now - previous);
    this.previous.set(mode, now);
  }

  resetClock() {
    this.previous.clear();
  }
  reset() {
    this.samples.clear();
    this.resetClock();
  }

  report() {
    return Object.fromEntries(
      [...this.samples].map(([name, sample]) => {
        const count = Math.min(sample.count, CAPACITY);
        const sorted = sample.values.slice(0, count).sort();
        return [
          name,
          {
            count: sample.count,
            mean: sample.total / sample.count,
            p50: sorted[Math.floor(count * 0.5)],
            p95: sorted[Math.min(count - 1, Math.floor(count * 0.95))],
            maximum: sample.maximum,
            percentileWindow: count,
          },
        ];
      }),
    );
  }
}

// Development only: the check is compiled away in the site and library builds,
// so an embedding page's own query string can never switch it on.
export const performanceAudit =
  typeof window !== "undefined" &&
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).get("profile") === "1"
    ? new PerformanceAudit()
    : null;

if (performanceAudit) {
  const audit = performanceAudit;
  const observers: PerformanceObserver[] = [];
  for (const type of ["longtask", "long-animation-frame"]) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        audit.record(`${type}.durationMs`, entry.duration);
    });
    observer.observe({ type });
    observers.push(observer);
  }
  const controls = {
    reset: () => audit.reset(),
    report: () => ({
      scope:
        "Actual browser callback timing and app JS CPU. rAF intervals include scheduling delays; they are not a GPU or presented-frame measurement.",
      userAgent: navigator.userAgent,
      viewport: {
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      },
      samples: audit.report(),
      elements: document.querySelectorAll("*").length,
      memory:
        (
          performance as Performance & {
            memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
          }
        ).memory ?? null,
      supportedObservers: PerformanceObserver.supportedEntryTypes,
    }),
  };
  Object.assign(window, { goatPerformance: controls });
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      for (const observer of observers) observer.disconnect();
      Reflect.deleteProperty(window, "goatPerformance");
    });
}
