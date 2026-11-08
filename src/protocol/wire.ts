/**
 * Voice-message wire protocol (PRIVATE_APP payload, portnum 256).
 *
 * | off | size | field     | notes                                             |
 * |-----|------|-----------|---------------------------------------------------|
 * | 0   | 1    | ver_mode  | hi nibble = protocol version, lo = codec mode id  |
 * | 1   | 2    | msg_id    | uint16 LE, random per message                     |
 * | 3   | 1    | seq_total | hi nibble = seq (0-based), lo = total (1..15)     |
 * | 4   | 1    | n_frames  | Codec2 frames in this chunk                       |
 * | 5   | ...  | frames    | tightly bit-packed Codec2 frames                  |
 *
 * Frames never span chunks, so each chunk decodes on its own.
 */
import { maxAppPayload } from '../airtime';
import { packFrames, packedByteLength, unpackFrames } from './bitpack';

export const PROTOCOL_VERSION = 1;
export const HEADER_LEN = 5;
export const MAX_CHUNKS = 15;
export const MAX_FRAMES_PER_CHUNK = 255;
/** Meshtastic portnum for PRIVATE_APP. */
export const PORTNUM = 256;
/** Largest payload the firmware accepts for our portnum (231 on 2.7.x). */
export const MAX_PAYLOAD = maxAppPayload(PORTNUM);

export interface ChunkHeader {
  version: number;
  modeId: number;
  msgId: number;
  seq: number;
  total: number;
  nFrames: number;
}

export interface Chunk extends ChunkHeader {
  /** Bit-packed frames (exactly packedByteLength(nFrames, bpf) bytes when encoded). */
  data: Uint8Array;
}

export function framesPerChunk(bitsPerFrame: number, maxPayload = MAX_PAYLOAD): number {
  return Math.min(MAX_FRAMES_PER_CHUNK, Math.floor(((maxPayload - HEADER_LEN) * 8) / bitsPerFrame));
}

/** Largest message (in frames) that fits in MAX_CHUNKS chunks. */
export function maxFramesPerMessage(bitsPerFrame: number, maxPayload = MAX_PAYLOAD): number {
  return framesPerChunk(bitsPerFrame, maxPayload) * MAX_CHUNKS;
}

export function encodeChunk(c: Chunk): Uint8Array {
  if (c.version < 0 || c.version > 15) throw new RangeError('version out of range');
  if (c.modeId < 0 || c.modeId > 15) throw new RangeError('modeId out of range');
  if (c.total < 1 || c.total > MAX_CHUNKS) throw new RangeError('total out of range');
  if (c.seq < 0 || c.seq >= c.total) throw new RangeError('seq out of range');
  if (c.nFrames < 0 || c.nFrames > MAX_FRAMES_PER_CHUNK) throw new RangeError('nFrames out of range');
  const out = new Uint8Array(HEADER_LEN + c.data.length);
  out[0] = (c.version << 4) | c.modeId;
  out[1] = c.msgId & 0xff;
  out[2] = (c.msgId >> 8) & 0xff;
  out[3] = (c.seq << 4) | c.total;
  out[4] = c.nFrames;
  out.set(c.data, HEADER_LEN);
  return out;
}

/** Parse a received payload. Returns null for anything that isn't a valid v1 chunk. */
export function decodeChunk(buf: Uint8Array): Chunk | null {
  if (buf.length < HEADER_LEN) return null;
  const version = buf[0] >> 4;
  const modeId = buf[0] & 0x0f;
  const msgId = buf[1] | (buf[2] << 8);
  const seq = buf[3] >> 4;
  const total = buf[3] & 0x0f;
  const nFrames = buf[4];
  if (version !== PROTOCOL_VERSION) return null;
  if (total < 1 || seq >= total) return null;
  return { version, modeId, msgId, seq, total, nFrames, data: buf.subarray(HEADER_LEN) };
}

/**
 * Split codec frames into wire chunks. Frames are spread evenly across the
 * minimum number of chunks so a lost chunk costs as little audio as possible.
 */
export function buildChunks(
  frames: readonly Uint8Array[],
  bitsPerFrame: number,
  modeId: number,
  msgId: number,
  maxPayload = MAX_PAYLOAD,
): Uint8Array[] {
  const perChunk = framesPerChunk(bitsPerFrame, maxPayload);
  if (perChunk < 1) throw new RangeError('payload too small for one frame');
  const total = Math.max(1, Math.ceil(frames.length / perChunk));
  if (total > MAX_CHUNKS) {
    throw new RangeError(`message needs ${total} chunks, max is ${MAX_CHUNKS}`);
  }
  const base = Math.floor(frames.length / total);
  const extra = frames.length % total;
  const chunks: Uint8Array[] = [];
  let at = 0;
  for (let seq = 0; seq < total; seq++) {
    const n = base + (seq < extra ? 1 : 0);
    const slice = frames.slice(at, at + n);
    at += n;
    chunks.push(
      encodeChunk({
        version: PROTOCOL_VERSION,
        modeId,
        msgId,
        seq,
        total,
        nFrames: n,
        data: packFrames(slice, bitsPerFrame),
      }),
    );
  }
  return chunks;
}

/** Extract the codec frames carried by a chunk. */
export function chunkFrames(c: Chunk, bitsPerFrame: number): Uint8Array[] {
  if (c.data.length < packedByteLength(c.nFrames, bitsPerFrame)) {
    throw new RangeError('chunk truncated');
  }
  return unpackFrames(c.data, bitsPerFrame, c.nFrames);
}

export function randomMsgId(): number {
  const a = new Uint16Array(1);
  crypto.getRandomValues(a);
  return a[0];
}
