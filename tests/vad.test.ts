import { describe, expect, it } from 'vitest';
import { findSpeech } from '../src/audio/vad';

const RATE = 16000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/** Noise of the given RMS, with a "voice" (AM tone) between startS and endS. */
function clip(totalS: number, startS: number, endS: number, noiseRms = 0.001, voiceAmp = 0.2) {
  const r = rng(42);
  const n = Math.round(totalS * RATE);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    a[i] = r() * noiseRms * Math.sqrt(3);
    if (t >= startS && t < endS) a[i] += voiceAmp * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
  }
  return a;
}

describe('findSpeech', () => {
  it('trims leading and trailing silence, keeping padding', () => {
    const span = findSpeech(clip(5, 1.5, 3.5), RATE)!;
    expect(span).not.toBeNull();
    expect(span.start / RATE).toBeCloseTo(1.25, 1);
    expect(span.end / RATE).toBeCloseTo(3.75, 1);
  });

  it('returns null for pure noise', () => {
    expect(findSpeech(clip(3, 0, 0, 0.01), RATE)).toBeNull();
  });

  it('returns null for digital silence', () => {
    expect(findSpeech(new Float32Array(RATE * 2), RATE)).toBeNull();
  });

  it('keeps an all-speech clip whole', () => {
    const span = findSpeech(clip(3, 0, 3), RATE)!;
    expect(span.start).toBe(0);
    expect(span.end).toBeGreaterThan(RATE * 2.9);
  });

  it('ignores a short click before the speech', () => {
    const a = clip(4, 2, 3);
    for (let i = 0; i < 160; i++) a[Math.round(0.5 * RATE) + i] = 0.9; // 10 ms click
    const span = findSpeech(a, RATE)!;
    expect(span.start / RATE).toBeGreaterThan(1.5);
  });

  it('works with a noisy (but quieter) background', () => {
    const span = findSpeech(clip(5, 1, 4, 0.02, 0.3), RATE)!;
    expect(span.start / RATE).toBeGreaterThan(0.65);
    expect(span.start / RATE).toBeLessThan(1.0); // speech (1.0 s) is kept
    expect(span.end / RATE).toBeGreaterThan(4.0); // speech end (4.0 s) is kept
    expect(span.end / RATE).toBeLessThan(4.35);
  });

  it('rejects very short blips', () => {
    expect(findSpeech(clip(3, 1, 1.1), RATE)).toBeNull();
  });
});
