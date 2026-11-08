import { describe, expect, it } from 'vitest';
import {
  HEADER_LEN,
  MAX_PAYLOAD,
  buildChunks,
  chunkFrames,
  decodeChunk,
  encodeChunk,
  framesPerChunk,
} from '../src/protocol/wire';

function frames(n: number, bits: number): Uint8Array[] {
  const bytes = Math.ceil(bits / 8);
  const spare = bytes * 8 - bits;
  return Array.from({ length: n }, (_, i) => {
    const f = new Uint8Array(bytes);
    for (let j = 0; j < bytes; j++) f[j] = (i * 31 + j * 17 + 5) & 0xff;
    if (spare) f[bytes - 1] &= (0xff << spare) & 0xff;
    return f;
  });
}

describe('wire header', () => {
  it('encodes fields at the documented offsets', () => {
    const buf = encodeChunk({
      version: 1,
      modeId: 1,
      msgId: 0xbeef,
      seq: 2,
      total: 3,
      nFrames: 7,
      data: new Uint8Array([0xaa]),
    });
    expect(Array.from(buf)).toEqual([0x11, 0xef, 0xbe, 0x23, 7, 0xaa]);
  });

  it('round-trips through decodeChunk', () => {
    const c = { version: 1, modeId: 0, msgId: 0x1234, seq: 14, total: 15, nFrames: 255, data: new Uint8Array(3) };
    const d = decodeChunk(encodeChunk(c))!;
    expect({ ...d, data: Array.from(d.data) }).toEqual({ ...c, data: [0, 0, 0] });
  });

  it('rejects other protocol versions and bad seq/total', () => {
    expect(decodeChunk(new Uint8Array([0x20, 0, 0, 0x01, 0]))).toBeNull();
    expect(decodeChunk(new Uint8Array([0x10, 0, 0, 0x22, 0]))).toBeNull(); // seq 2 of 2
    expect(decodeChunk(new Uint8Array([0x10, 0, 0, 0x00, 0]))).toBeNull(); // total 0
    expect(decodeChunk(new Uint8Array([0x10, 0, 0]))).toBeNull();
  });
});

describe('chunking', () => {
  it('uses the firmware payload limit for portnum 256', () => {
    expect(MAX_PAYLOAD).toBe(231);
  });

  it('fits an 8 s Codec2 450 message (200 x 18 bit) in 2 chunks', () => {
    expect(framesPerChunk(18)).toBe(break_even(18));
    const chunks = buildChunks(frames(200, 18), 18, 0, 42);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.length).toBe(HEADER_LEN + 225);
      expect(c.length).toBeLessThanOrEqual(MAX_PAYLOAD);
    }
  });

  it('splits an 8 s 700C message (200 x 28 bit) into 4 balanced chunks', () => {
    const chunks = buildChunks(frames(200, 28), 28, 1, 7).map((b) => decodeChunk(b)!);
    expect(chunks.map((c) => c.nFrames)).toEqual([50, 50, 50, 50]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2, 3]);
    expect(chunks.every((c) => c.total === 4 && c.msgId === 7 && c.modeId === 1)).toBe(true);
  });

  for (const [n, bits] of [
    [0, 18],
    [1, 18],
    [101, 18],
    [102, 18],
    [199, 28],
    [333, 13],
  ] as const) {
    it(`reassembles ${n} x ${bits}-bit frames exactly`, () => {
      const src = frames(n, bits);
      const chunks = buildChunks(src, bits, 0, 1);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(MAX_PAYLOAD);
      const back = chunks.flatMap((b) => chunkFrames(decodeChunk(b)!, bits));
      expect(back).toEqual(src);
    });
  }

  it('refuses messages needing more than 15 chunks', () => {
    expect(() => buildChunks(frames(16 * framesPerChunk(18), 18), 18, 0, 1)).toThrow(RangeError);
  });
});

function break_even(bits: number) {
  return Math.floor(((MAX_PAYLOAD - HEADER_LEN) * 8) / bits);
}
