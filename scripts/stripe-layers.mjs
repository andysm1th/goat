// Offline separation of the moving silhouette and stationary screen-line texture.
const WIDTH = 960,
  HEIGHT = 540;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function separateStripes(raw) {
  const image = Float32Array.from(raw, (value) => value / 255);
  const expanded = new Float32Array(image.length),
    low = new Float32Array(image.length);
  // Horizontal closing removes the narrow dark screen lines while preserving
  // the larger silhouette. A simple blur leaves periodic detail in the image,
  // which becomes diagonal moiré when the anatomical map moves it.
  const radius = 3;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      let value = 0;
      for (let dx = -radius; dx <= radius; dx++)
        value = Math.max(value, image[y * WIDTH + clamp(x + dx, 0, WIDTH - 1)]);
      expanded[y * WIDTH + x] = value;
    }
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      let value = 1;
      for (let dx = -radius; dx <= radius; dx++)
        value = Math.min(
          value,
          expanded[y * WIDTH + clamp(x + dx, 0, WIDTH - 1)],
        );
      low[y * WIDTH + x] = value;
    }
  const carrier = new Float32Array(image.length),
    detail = new Float32Array(image.length);
  // Infer the screen texture through the occluding goat using the visible
  // samples above/below it. Keep this two-dimensional carrier in screen space:
  // the original circular boundary is also part of that texture.
  for (let x = 0; x < WIDTH; x++) {
    let next = 0,
      previous = -1;
    while (next < HEIGHT && low[next * WIDTH + x] < 0.3) next++;
    for (let y = 0; y < HEIGHT; y++) {
      const index = y * WIDTH + x;
      if (low[index] >= 0.3) {
        carrier[index] = image[index] / low[index];
        previous = y;
      } else {
        if (next <= y) {
          next = y + 1;
          while (next < HEIGHT && low[next * WIDTH + x] < 0.3) next++;
        }
        const before = previous < 0 ? next : previous;
        const after = next >= HEIGHT ? previous : next;
        if (before < 0 || before >= HEIGHT || after < 0 || after >= HEIGHT)
          carrier[index] = 1;
        else {
          const a = image[before * WIDTH + x] / low[before * WIDTH + x];
          const b = image[after * WIDTH + x] / low[after * WIDTH + x];
          const blend = after === before ? 0 : (y - before) / (after - before);
          carrier[index] = a * (1 - blend) + b * blend;
        }
      }
      detail[index] = image[index] - low[index] * carrier[index];
    }
  }
  return { low, carrier, detail };
}
