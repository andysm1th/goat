import test from "node:test";
import assert from "node:assert/strict";
import { separateStripes } from "../scripts/stripe-layers.mjs";

test("registration separates the screen lines from the silhouette without losing source samples", () => {
  const width = 960,
    height = 540;
  const raw = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const silhouette = x > 250 && x < 650 && y > 150 && y < 350;
      raw[y * width + x] = silhouette || x % 7 < 3 ? 8 : 180;
    }
  const { low, carrier, detail } = separateStripes(raw);
  for (let i = 0; i < raw.length; i++) {
    assert.ok(
      Math.abs((low[i] * carrier[i] + detail[i]) * 255 - raw[i]) < 0.0001,
      "Layer separation must reconstruct the source, including dark samples",
    );
  }
  for (let x = 20; x < width - 20; x++) {
    assert.ok(
      Math.abs(low[100 * width + x] - 180 / 255) < 0.00001,
      "Fixed screen lines must not enter the moving background envelope",
    );
  }
  for (let x = 300; x < 600; x++) {
    assert.ok(
      Math.abs(low[250 * width + x] - 8 / 255) < 0.00001,
      "The moving silhouette must remain dark",
    );
    assert.ok(
      Math.abs(carrier[250 * width + x] - carrier[100 * width + x]) < 0.00001,
      "Infer the same fixed stripe phase behind the moving silhouette",
    );
  }
});
