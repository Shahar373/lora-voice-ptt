import { describe, expect, it } from 'vitest';
import { floatToInt16, normalizePeak, resample } from '../src/audio/resample';

function tone(freq: number, rate: number, seconds: number, amp = 0.5) {
  const n = Math.round(rate * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return a;
}

/** RMS of the middle of the signal (ignore filter edge effects). */
function midRms(a: Float32Array) {
  const s = Math.floor(a.length * 0.2);
  const e = Math.floor(a.length * 0.8);
  let acc = 0;
  for (let i = s; i < e; i++) acc += a[i] * a[i];
  return Math.sqrt(acc / (e - s));
}

describe('resample', () => {
  for (const inRate of [48000, 44100]) {
    it(`${inRate} -> 8000 keeps the expected length`, () => {
      expect(resample(new Float32Array(inRate), inRate, 8000).length).toBe(8000);
    });

    it(`${inRate} -> 8000 passes 1 kHz with ~unity gain`, () => {
      const out = resample(tone(1000, inRate, 0.5), inRate, 8000);
      expect(midRms(out)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    });

    it(`${inRate} -> 8000 rejects 6 kHz (would alias to 2 kHz)`, () => {
      const out = resample(tone(6000, inRate, 0.5), inRate, 8000);
      expect(midRms(out)).toBeLessThan(0.005); // > 37 dB down
    });
  }

  it('8000 -> 48000 upsamples a tone cleanly', () => {
    const out = resample(tone(1000, 8000, 0.5), 8000, 48000);
    expect(out.length).toBe(24000);
    expect(midRms(out)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('identity when rates match', () => {
    const a = tone(440, 8000, 0.01);
    expect(resample(a, 8000, 8000)).toEqual(a);
  });
});

describe('level helpers', () => {
  it('normalizePeak caps gain', () => {
    const quiet = new Float32Array([0.01, -0.01]);
    expect(Math.max(...normalizePeak(quiet))).toBeCloseTo(0.08, 6);
    const loud = new Float32Array([0.5, -1]);
    expect(Math.min(...normalizePeak(loud))).toBeCloseTo(-0.7, 6);
  });

  it('floatToInt16 clips', () => {
    expect(Array.from(floatToInt16(new Float32Array([2, -2, 0])))).toEqual([32767, -32767, 0]);
  });
});
