import { describe, expect, it } from 'vitest';
import { packFrames, packedByteLength, unpackFrames } from '../src/protocol/bitpack';

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
}

/** Random codec-style frame: ceil(bits/8) bytes, unused trailing bits zero. */
function randomFrame(bits: number, next: () => number): Uint8Array {
  const f = new Uint8Array(Math.ceil(bits / 8));
  for (let i = 0; i < f.length; i++) f[i] = next() & 0xff;
  const spare = f.length * 8 - bits;
  if (spare) f[f.length - 1] &= (0xff << spare) & 0xff;
  return f;
}

describe('bitpack', () => {
  it('packs 18-bit frames tightly (no per-frame padding)', () => {
    // 4 frames x 18 bits = 72 bits = 9 bytes (Codec2 itself would use 12)
    expect(packedByteLength(4, 18)).toBe(9);
    const frames = [0, 1, 2, 3].map(() => new Uint8Array([0xff, 0xff, 0xc0]));
    expect(Array.from(packFrames(frames, 18))).toEqual(Array(9).fill(0xff));
  });

  it('places bits MSB-first across byte boundaries', () => {
    // Two 3-bit frames: 101, 011 -> 101011xx -> 0b10101100
    const out = packFrames([new Uint8Array([0b10100000]), new Uint8Array([0b01100000])], 3);
    expect(Array.from(out)).toEqual([0b10101100]);
  });

  it('zero-pads only the final partial byte', () => {
    // 1 frame x 18 bits of ones -> 0xff 0xff 0xc0
    const out = packFrames([new Uint8Array([0xff, 0xff, 0xc0])], 18);
    expect(Array.from(out)).toEqual([0xff, 0xff, 0xc0]);
  });

  it('ignores garbage in the unused low bits of a frame', () => {
    const out = packFrames([new Uint8Array([0xff, 0xff, 0xff])], 18);
    expect(Array.from(out)).toEqual([0xff, 0xff, 0xc0]);
  });

  for (const bits of [1, 3, 7, 8, 9, 13, 18, 28, 52, 64]) {
    it(`round-trips random ${bits}-bit frames for many frame counts`, () => {
      const next = rng(bits * 7919);
      for (let n = 0; n <= 37; n++) {
        const frames = Array.from({ length: n }, () => randomFrame(bits, next));
        const packed = packFrames(frames, bits);
        expect(packed.length).toBe(Math.ceil((n * bits) / 8));
        expect(unpackFrames(packed, bits, n)).toEqual(frames);
      }
    });
  }

  it('rejects short input', () => {
    expect(() => unpackFrames(new Uint8Array(2), 18, 1)).toThrow(RangeError);
    expect(() => packFrames([new Uint8Array(2)], 18)).toThrow(RangeError);
  });
});
