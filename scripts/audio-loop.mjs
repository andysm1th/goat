// Sample-level helpers for cutting a loop. Interleaved Float32 PCM throughout.

// The sharpest rise in loudness between two times (seconds): a kick's attack.
export function findOnset(samples, channels, rate, from, to) {
  const window = Math.round(rate * 0.004);
  const level = (at) => {
    let total = 0;
    for (
      let i = Math.max(0, at) * channels;
      i < (at + window) * channels && i < samples.length;
      i++
    )
      total += samples[i] * samples[i];
    return Math.sqrt(total / (window * channels));
  };
  let best = Math.round(from * rate),
    rise = -Infinity;
  for (
    let at = Math.max(window, Math.round(from * rate));
    at < Math.round(to * rate);
    at += 8
  ) {
    const change = level(at) - level(at - window);
    if (change > rise) {
      rise = change;
      best = at;
    }
  }
  return best / rate;
}

// `length` frames from `start`, made periodic: the final `fade` frames blend
// into the audio that originally led up to `start`, so the last sample runs
// straight on into the first, tails included.
export function periodicLoop(samples, channels, start, length, fade) {
  if (start - fade < 0 || (start + length) * channels > samples.length)
    throw new Error("The loop lies outside the recording.");
  const loop = samples.slice(start * channels, (start + length) * channels);
  for (let i = 0; i < fade; i++) {
    const mix = (i + 1) / (fade + 1);
    for (let channel = 0; channel < channels; channel++) {
      const at = (length - fade + i) * channels + channel;
      loop[at] =
        loop[at] * (1 - mix) +
        samples[(start - fade + i) * channels + channel] * mix;
    }
  }
  return loop;
}
