/**
 * Tight bit-packing of Codec2 frames.
 *
 * Codec2 hands out each frame as `ceil(bits/8)` bytes, MSB first, with the
 * unused low bits of the last byte zero. On the radio every bit costs airtime,
 * so we concatenate frames bit-by-bit with no per-frame padding. Only the very
 * end of the packed buffer is padded (with zeros) to a whole byte.
 */

export function packedByteLength(nFrames: number, bitsPerFrame: number): number {
  return Math.ceil((nFrames * bitsPerFrame) / 8);
}

export function packFrames(frames: readonly Uint8Array[], bitsPerFrame: number): Uint8Array {
  if (!Number.isInteger(bitsPerFrame) || bitsPerFrame <= 0) {
    throw new RangeError(`bitsPerFrame must be a positive integer, got ${bitsPerFrame}`);
  }
  const frameBytes = Math.ceil(bitsPerFrame / 8);
  const out = new Uint8Array(packedByteLength(frames.length, bitsPerFrame));
  let pos = 0; // bit position in `out`
  for (const f of frames) {
    if (f.length < frameBytes) {
      throw new RangeError(`frame has ${f.length} bytes, need ${frameBytes}`);
    }
    for (let i = 0; i < bitsPerFrame; i++) {
      const bit = (f[i >> 3] >> (7 - (i & 7))) & 1;
      if (bit) out[pos >> 3] |= 0x80 >> (pos & 7);
      pos++;
    }
  }
  return out;
}

export function unpackFrames(data: Uint8Array, bitsPerFrame: number, nFrames: number): Uint8Array[] {
  if (!Number.isInteger(bitsPerFrame) || bitsPerFrame <= 0) {
    throw new RangeError(`bitsPerFrame must be a positive integer, got ${bitsPerFrame}`);
  }
  if (data.length < packedByteLength(nFrames, bitsPerFrame)) {
    throw new RangeError(
      `need ${packedByteLength(nFrames, bitsPerFrame)} bytes for ${nFrames} frames, got ${data.length}`,
    );
  }
  const frameBytes = Math.ceil(bitsPerFrame / 8);
  const frames: Uint8Array[] = [];
  let pos = 0;
  for (let n = 0; n < nFrames; n++) {
    const f = new Uint8Array(frameBytes);
    for (let i = 0; i < bitsPerFrame; i++) {
      const bit = (data[pos >> 3] >> (7 - (pos & 7))) & 1;
      if (bit) f[i >> 3] |= 0x80 >> (i & 7);
      pos++;
    }
    frames.push(f);
  }
  return frames;
}
