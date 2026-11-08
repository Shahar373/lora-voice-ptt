import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CODEC_MODES, Codec2, loadCodec2Module } from '../src/codec/codec2';
import type { Codec2WasmModule } from '../src/codec/wasm/codec2.mjs';
import { buildChunks, chunkFrames, decodeChunk } from '../src/protocol/wire';

let m: Codec2WasmModule;

beforeAll(async () => {
  const wasm = readFileSync(fileURLToPath(new URL('../src/codec/wasm/codec2.wasm', import.meta.url)));
  m = await loadCodec2Module({ wasmBinary: wasm });
});

/** Crude voiced-speech stand-in: 120 Hz pulse train through a few formant-ish sines, with AM. */
function synthVoice(seconds: number, rate = 8000): Int16Array {
  const n = Math.round(seconds * rate);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const f0 = 110 + 20 * Math.sin(2 * Math.PI * 0.7 * t);
    let s = 0;
    for (let h = 1; h <= 25; h++) {
      const f = h * f0;
      if (f > 3800) break;
      const env = Math.exp(-((f - 700) ** 2) / 2e5) + 0.6 * Math.exp(-((f - 1200) ** 2) / 3e5) + 0.3 * Math.exp(-((f - 2500) ** 2) / 4e5);
      s += env * Math.sin(2 * Math.PI * f * t);
    }
    const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    out[i] = Math.max(-32767, Math.min(32767, Math.round(6000 * am * s)));
  }
  return out;
}

function rms(a: Int16Array) {
  let s = 0;
  for (const x of a) s += x * x;
  return Math.sqrt(s / Math.max(1, a.length));
}

describe('codec2 wasm', () => {
  it('450 mode: 18 bits / 320 samples (40 ms)', () => {
    const c = new Codec2(m, CODEC_MODES['450']);
    expect(c.bitsPerFrame).toBe(18);
    expect(c.bytesPerFrame).toBe(3);
    expect(c.samplesPerFrame).toBe(320);
    c.destroy();
  });

  it('700C mode: 28 bits / 320 samples (40 ms)', () => {
    const c = new Codec2(m, CODEC_MODES['700C']);
    expect(c.bitsPerFrame).toBe(28);
    expect(c.bytesPerFrame).toBe(4);
    expect(c.samplesPerFrame).toBe(320);
    c.destroy();
  });

  for (const mode of Object.values(CODEC_MODES)) {
    it(`${mode.name}: full loopback through the wire format produces audio`, () => {
      const pcm = synthVoice(8);
      const enc = new Codec2(m, mode);
      const frames = enc.encode(pcm);
      expect(frames.length).toBe(200);
      const chunks = buildChunks(frames, enc.bitsPerFrame, mode.wireId, 1234);
      const back = chunks.flatMap((b) => chunkFrames(decodeChunk(b)!, enc.bitsPerFrame));
      expect(back).toEqual(frames);
      const dec = new Codec2(m, mode);
      const out = dec.decode(back);
      expect(out.length).toBe(200 * 320);
      // Decoded energy should be in the same ballpark as the input.
      const ratio = rms(out) / rms(pcm);
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(5);
      enc.destroy();
      dec.destroy();
    });
  }

  it('decodes null frames as silence', () => {
    const c = new Codec2(m, CODEC_MODES['700C']);
    const out = c.decode([null, null]);
    expect(out.length).toBe(640);
    expect(out.every((x) => x === 0)).toBe(true);
    c.destroy();
  });
});
