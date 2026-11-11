import test from "node:test";
import assert from "node:assert/strict";
import {
  PerformanceAudit,
  performanceAudit,
} from "../src/player/performance-audit.ts";

test("browser profiling is absent by default and separates modes and pause intervals", () => {
  assert.equal(performanceAudit, null);
  const audit = new PerformanceAudit();
  audit.frame("normal", 0);
  audit.frame("normal", 16);
  audit.resetClock();
  audit.frame("normal", 10000);
  audit.frame("normal", 10016);
  audit.frame("techno", 10020);
  audit.frame("techno", 10040);
  const report = audit.report();
  assert.equal(report["normal.rafIntervalMs"].count, 2);
  assert.equal(report["normal.rafIntervalMs"].maximum, 16);
  assert.equal(report["techno.rafIntervalMs"].mean, 20);
});

test("long profiling sessions retain a bounded sample window and can be reset", () => {
  const audit = new PerformanceAudit();
  for (let index = 0; index < 10000; index++) audit.record("cpu", index % 10);
  for (const invalid of [NaN, Infinity, -1]) audit.record("cpu", invalid);
  const sample = audit.report().cpu;
  assert.equal(sample.count, 10000);
  assert.equal(sample.mean, 4.5);
  assert.equal(sample.maximum, 9);
  assert.equal(sample.percentileWindow, 4096);
  assert.equal(sample.p95, 9);
  audit.reset();
  assert.deepEqual(audit.report(), {});
});
