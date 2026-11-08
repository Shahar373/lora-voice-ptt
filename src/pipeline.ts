/**
 * Voice pipeline shared by the loopback test and (later) the radio path:
 *   recording -> 8 kHz int16 -> Codec2 frames -> wire chunks
 *   wire chunks -> frames (gaps = silence) -> 8 kHz int16
 */
import { normalizePeak, floatToInt16, resample } from './audio/resample';
import { CODEC_SAMPLE_RATE, Codec2, type CodecModeInfo, modeByWireId } from './codec/codec2';
import type { Codec2WasmModule } from './codec/wasm/codec2.mjs';
import { buildChunks, chunkFrames, type Chunk } from './protocol/wire';

export function prepareVoice(samples: Float32Array, sampleRate: number, normalize: boolean): Int16Array {
  let pcm = resample(samples, sampleRate, CODEC_SAMPLE_RATE);
  if (normalize) pcm = normalizePeak(pcm);
  return floatToInt16(pcm);
}

export interface EncodedMessage {
  mode: CodecModeInfo;
  msgId: number;
  bitsPerFrame: number;
  nFrames: number;
  frameMs: number;
  /** Wire payloads, ready to hand to the radio. */
  chunks: Uint8Array[];
}

export function encodeVoice(m: Codec2WasmModule, pcm8k: Int16Array, mode: CodecModeInfo, msgId: number): EncodedMessage {
  const c = new Codec2(m, mode);
  try {
    const frames = c.encode(pcm8k);
    return {
      mode,
      msgId,
      bitsPerFrame: c.bitsPerFrame,
      nFrames: frames.length,
      frameMs: c.frameDurationMs,
      chunks: buildChunks(frames, c.bitsPerFrame, mode.wireId, msgId),
    };
  } finally {
    c.destroy();
  }
}

/**
 * Decode one message from its chunks, indexed by seq. Missing chunks (null)
 * become silence, sized like the received chunks (the sender balances them).
 */
export function decodeVoice(m: Codec2WasmModule, chunks: readonly (Chunk | null)[]): Int16Array {
  const present = chunks.filter((c): c is Chunk => c !== null);
  if (present.length === 0) return new Int16Array(0);
  const mode = modeByWireId(present[0].modeId);
  if (!mode) throw new Error(`unknown codec mode id ${present[0].modeId}`);
  const gapFrames = Math.max(...present.map((c) => c.nFrames));
  const c = new Codec2(m, mode);
  try {
    const frames: (Uint8Array | null)[] = [];
    for (const ch of chunks) {
      if (ch) frames.push(...chunkFrames(ch, c.bitsPerFrame));
      else for (let i = 0; i < gapFrames; i++) frames.push(null);
    }
    return c.decode(frames);
  } finally {
    c.destroy();
  }
}
