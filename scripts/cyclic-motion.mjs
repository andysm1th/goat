// Work in complete source strides. Each hand-off overlaps two continuously
// moving, phase-matched clips, including the clip that continues after wrap.
//
// A hand-off corrects two different things. Body scale and position drift
// slowly through the source, so that correction (`blend`) eases over the whole
// overlap. The pose itself (`pose`) blends only in a short window at the end:
// matched strides still differ in their fast, thin legs, and interpolating
// those contours for long erases them.
// The wrap returns three strides, to a less similar pose than the one-stride
// join, so its pose window is longer to keep the per-frame change ordinary.
export function cyclicPlan(times, fps = 60, poseOverlap = [14, 24]) {
  const first = Math.round(times[34] * fps);
  const last = Math.round(times[188] * fps);
  // Source frame 135 is the closest silhouette to frame 188 one stride earlier.
  const repeat = Math.round(times[135] * fps);
  const overlap = Math.round(0.75 * fps);
  const longCount = last - first,
    extraCount = last - repeat;
  const count = longCount + extraCount;
  const smoother = (x) => x ** 3 * (x * (x * 6 - 15) + 10);
  const samples = Array.from({ length: count }, (_, index) => {
    const segment = index < longCount ? 0 : 1;
    const local = segment === 0 ? index : index - longCount;
    const length = segment === 0 ? longCount : extraCount;
    const start = segment === 0 ? first : repeat;
    const beforeEnd = length - local;
    if (beforeEnd > overlap) return { source: start + local };
    const next = segment === 0 ? repeat : first;
    return {
      source: start + local,
      target: next - beforeEnd,
      blend: smoother(1 - beforeEnd / overlap),
      pose:
        beforeEnd > poseOverlap[segment]
          ? 0
          : smoother(1 - beforeEnd / poseOverlap[segment]),
      join: segment,
    };
  });
  return {
    fps,
    first,
    last,
    repeat,
    overlap,
    poseOverlap,
    longCount,
    extraCount,
    count,
    duration: 9,
    outputFps: 60,
    outputCount: 540,
    samples,
  };
}

export function stripeProfile(layers, width = 960, height = 540) {
  const profile = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const values = [];
    for (const layer of layers)
      for (let y = 16; y < height - 70; y += 9) {
        const at = y * width + x;
        if (layer.low[at] > 0.5) values.push(1 - layer.carrier[at]);
      }
    values.sort((a, b) => a - b);
    const value = values[Math.floor(values.length * 0.9)] ?? 0;
    profile[x] = value < 0.15 ? 0 : value;
  }
  return profile;
}

export function packLayers(layer, stripe, width = 960, height = 540) {
  const planeHeight = Math.ceil(height / 8) * 8;
  const output = Buffer.alloc(width * planeHeight * 2, 255);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      output[at] = Math.round(layer.low[at] * 255);
      let covered = 0,
        energy = 0;
      for (let dx = -3; dx <= 3; dx++) {
        const sx = Math.max(0, Math.min(width - 1, x + dx)),
          weight = stripe[sx];
        covered += weight * (1 - layer.carrier[y * width + sx]);
        energy += weight * weight;
      }
      output[width * planeHeight + at] = Math.round(
        Math.max(0, Math.min(1, energy > 0.001 ? covered / energy : 0)) * 255,
      );
    }
  return output;
}

export function signedDistance(mask, width, height) {
  const transform = (invert) => {
    const work = new Float64Array(width * height),
      result = new Float64Array(work.length);
    const length = Math.max(width, height),
      f = new Float64Array(length),
      d = new Float64Array(length);
    const sites = new Int32Array(length),
      boundaries = new Float64Array(length + 1);
    const line = (n) => {
      let k = 0;
      sites[0] = 0;
      boundaries[0] = -Infinity;
      boundaries[1] = Infinity;
      for (let q = 1; q < n; q++) {
        let s;
        do {
          const v = sites[k];
          s = (f[q] + q * q - f[v] - v * v) / (2 * (q - v));
          if (s <= boundaries[k]) k--;
          else break;
        } while (k >= 0);
        k++;
        sites[k] = q;
        boundaries[k] = s;
        boundaries[k + 1] = Infinity;
      }
      k = 0;
      for (let q = 0; q < n; q++) {
        while (boundaries[k + 1] < q) k++;
        d[q] = (q - sites[k]) ** 2 + f[sites[k]];
      }
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++)
        f[x] = Boolean(mask[y * width + x]) !== invert ? 0 : 1e12;
      line(width);
      work.set(d.subarray(0, width), y * width);
    }
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) f[y] = work[y * width + x];
      line(height);
      for (let y = 0; y < height; y++) result[y * width + x] = Math.sqrt(d[y]);
    }
    return result;
  };
  const inside = transform(false),
    outside = transform(true);
  return Float32Array.from(inside, (v, i) => outside[i] - v);
}

export function bodyGeometry(field, width = 960) {
  let count = 0,
    sx = 0,
    sy = 0,
    xx = 0,
    yy = 0;
  for (let y = 30; y < 350; y += 2)
    for (let x = 120; x < 760; x += 2)
      if (field[y * width + x] > 0) {
        count++;
        sx += x;
        sy += y;
        xx += x * x;
        yy += y * y;
      }
  const x = sx / count,
    y = sy / count;
  return {
    x,
    y,
    sx: Math.sqrt(xx / count - x * x),
    sy: Math.sqrt(yy / count - y * y),
  };
}

function fieldSample(field, x, y, width, height) {
  x = Math.max(0, Math.min(width - 1, x));
  y = Math.max(0, Math.min(height - 1, y));
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy;
  const right = Math.min(ix + 1, width - 1),
    bottom = Math.min(iy + 1, height - 1);
  return (
    (field[iy * width + ix] * (1 - fx) + field[iy * width + right] * fx) *
      (1 - fy) +
    (field[bottom * width + ix] * (1 - fx) +
      field[bottom * width + right] * fx) *
      fy
  );
}

// `blend` eases body scale/position and the background boundary between the two
// clips; `pose` (defaulting to the same weight) interpolates the contours.
export function renderFields(
  a,
  b,
  blend,
  stripe,
  width = 960,
  height = 540,
  pose = blend,
) {
  const output = Buffer.alloc(width * height);
  const geometry = Object.fromEntries(
    Object.keys(a.geometry).map((key) => [
      key,
      a.geometry[key] * (1 - blend) + b.geometry[key] * blend,
    ]),
  );
  const warp = (state, x, y) => {
    // Keep the ground fixed while aligning the moving animal's body scale and
    // position. Contours, not opacity, interpolate between matched gait phases.
    const ground = Math.max(0, Math.min(1, (504 - y) / 30));
    const sx =
      x +
      (((x - geometry.x) * state.geometry.sx) / geometry.sx +
        state.geometry.x -
        x) *
        ground;
    const sy =
      y +
      (((y - geometry.y) * state.geometry.sy) / geometry.sy +
        state.geometry.y -
        y) *
        ground;
    return fieldSample(state.shape, sx, sy, width, height);
  };
  // Where the aligned contours disagree (legs, horns), lean toward showing both
  // mid-blend. A plain average of two thin, non-overlapping limbs has neither.
  const lean = 4 * pose * (1 - pose);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      let shape;
      if (blend === 0) shape = a.shape[at];
      else if (pose === 0) shape = warp(a, x, y);
      else {
        const from = warp(a, x, y),
          to = warp(b, x, y),
          mixed = from * (1 - pose) + to * pose;
        shape = mixed + (Math.max(from, to) - mixed) * lean;
      }
      const coverage = a.coverage[at] * (1 - blend) + b.coverage[at] * blend;
      const ink = Math.max(0, Math.min(1, 0.5 + shape / 2));
      const covered = Math.max(0, Math.min(1, 0.5 + coverage / 2));
      output[at] = Math.round((180 - 172 * ink) * (1 - stripe[x] * covered));
    }
  return output;
}

export function distanceLayers(layer, stripe, width = 960, height = 540) {
  const packed = packLayers(layer, stripe, width, height);
  const offset = width * Math.ceil(height / 8) * 8;
  const shape = signedDistance(
    Uint8Array.from(layer.low, (v) => (v < 0.35 ? 1 : 0)),
    width,
    height,
  );
  const coverage = signedDistance(
    Uint8Array.from({ length: width * height }, (_, i) =>
      packed[offset + i] > 127 ? 1 : 0,
    ),
    width,
    height,
  );
  return { shape, coverage, geometry: bodyGeometry(shape, width) };
}

// Where the animal is within the frame, as fractions of its width and height,
// over the whole cycle. The player scales and centres on this box instead of
// the 16:9 frame, so the goat keeps a sensible size on any screen shape.
// The ground and its loose ends lie below `hooves`; the animal is measured
// above that, and the box then reaches down to keep the ground line in view.
// Columns and rows need a few inked cells to count, and the extremes of the
// cycle are trimmed, so stray specks do not stretch the box.
export function focusBox(
  frames,
  columns,
  rows,
  hooves = 0.9,
  groundLine = 0.965,
) {
  const limit = Math.floor(rows * hooves),
    lefts = [],
    rights = [],
    tops = [];
  let centre = 0;
  for (const frame of frames) {
    const lines = frame.split("\n");
    const perColumn = new Uint16Array(columns),
      perRow = new Uint16Array(limit);
    for (let row = 0; row < limit; row++) {
      const line = lines[row];
      for (let x = 0; x < columns; x++)
        if (line.charCodeAt(x) !== 32) {
          perColumn[x]++;
          perRow[row]++;
        }
    }
    const solid = Math.max(3, Math.round(rows * 0.03));
    let left = 0,
      right = columns - 1,
      top = 0;
    while (left < columns && perColumn[left] < solid) left++;
    while (right > left && perColumn[right] < solid) right--;
    while (top < limit && perRow[top] < 2) top++;
    if (left < right) {
      lefts.push(left);
      rights.push(right + 1);
      tops.push(top);
      centre += (left + right + 1) / 2;
    }
  }
  const at = (values, share) =>
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * share))
    ];
  const round = (value) => Math.round(value * 1000) / 1000;
  // The box bounds the animal's full reach; `centre` is where it usually is.
  return {
    left: round(at(lefts, 0.02) / columns),
    right: round(at(rights, 0.98) / columns),
    top: round(at(tops, 0.02) / rows),
    bottom: groundLine,
    centre: round(centre / lefts.length / columns),
  };
}

// The source's floor stops short of the frame's edges, leaving the lines to
// run down past it. Continue it to both edges at the height it has where it
// ends, so the floor is one unbroken band. `solo` (the frame without screen
// lines) shows where the floor is; every frame in `frames` is then filled.
export function extendGround(
  solo,
  frames,
  width = 960,
  height = 540,
  dark = 90,
  ink = 8,
) {
  const from = Math.floor(height * 0.9),
    depth = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    let y = height;
    while (y > from && solo[(y - 1) * width + x] < dark) y--;
    depth[x] = height - y;
  }
  const typical = [...depth].sort((a, b) => a - b)[Math.floor(width * 0.6)];
  if (typical < 2) return;
  const floor = (x) => depth[x] >= typical * 0.5;
  let left = 0,
    right = width - 1;
  while (left < width && !floor(left)) left++;
  while (right > left && !floor(right)) right--;
  if (left >= right) return;
  // The height at each end, read a little way in from the ragged tip.
  const level = (start, step) => {
    const values = [];
    for (let i = 4; i < 24; i++) {
      const x = start + i * step;
      if (x >= 0 && x < width && floor(x))
        values.push(Math.min(depth[x], typical * 2));
    }
    values.sort((a, b) => a - b);
    return values.length ? values[values.length >> 1] : typical;
  };
  const fill = (x0, x1, rows) => {
    for (const frame of frames)
      for (let y = height - rows; y < height; y++)
        frame.fill(ink, y * width + x0, y * width + x1);
  };
  if (left > 0) fill(0, left + 4, level(left, 1));
  if (right < width - 1) fill(right - 3, width, level(right, -1));
}
