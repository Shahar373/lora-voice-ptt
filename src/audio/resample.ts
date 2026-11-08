/**
 * Band-limited resampler (windowed-sinc, Blackman window).
 *
 * The low-pass cutoff sits at 0.92 x the lower Nyquist, so 48 kHz -> 8 kHz
 * passes speech up to ~3.7 kHz and rejects what would otherwise alias.
 * Works for any rate pair (44.1k, 48k, ...), in either direction.
 */

const TABLE_RES = 512; // kernel samples per input sample (fractional-phase resolution)

interface Kernel {
  halfWidth: number; // in input samples
  table: Float32Array; // h(x) for x = 0 .. halfWidth (symmetric), step 1/TABLE_RES
}

const kernelCache = new Map<string, Kernel>();

function makeKernel(cutoff: number, zeroCrossings: number): Kernel {
  // cutoff: in cycles per input sample (0 < cutoff <= 0.5)
  const halfWidth = Math.ceil(zeroCrossings / (2 * cutoff));
  const n = halfWidth * TABLE_RES + 2;
  const table = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / TABLE_RES;
    if (x > halfWidth) break;
    const arg = 2 * cutoff * x;
    const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
    const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / halfWidth) + 0.08 * Math.cos((2 * Math.PI * x) / halfWidth);
    table[i] = 2 * cutoff * sinc * w;
  }
  return { halfWidth, table };
}

function kernelFor(inRate: number, outRate: number): Kernel {
  const key = `${inRate}:${outRate}`;
  let k = kernelCache.get(key);
  if (!k) {
    const cutoff = 0.5 * Math.min(1, outRate / inRate) * 0.92;
    k = makeKernel(cutoff, 12);
    kernelCache.set(key, k);
  }
  return k;
}

function h(k: Kernel, x: number): number {
  const ax = Math.abs(x) * TABLE_RES;
  const i = ax | 0;
  if (i >= k.table.length - 1) return 0;
  const f = ax - i;
  return k.table[i] + (k.table[i + 1] - k.table[i]) * f;
}

export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array<ArrayBuffer> {
  if (inRate === outRate) return input.slice();
  const k = kernelFor(inRate, outRate);
  const step = inRate / outRate; // input samples per output sample
  const outLen = Math.floor((input.length * outRate) / inRate);
  const out = new Float32Array(outLen);
  const hw = k.halfWidth;
  for (let n = 0; n < outLen; n++) {
    const t = n * step;
    const c = Math.floor(t);
    const lo = Math.max(0, c - hw + 1);
    const hi = Math.min(input.length - 1, c + hw);
    let acc = 0;
    let norm = 0;
    for (let j = lo; j <= hi; j++) {
      const w = h(k, t - j);
      acc += input[j] * w;
      norm += w;
    }
    // Normalise for unity DC gain (also handles the truncated kernel at the edges).
    out[n] = norm !== 0 ? acc / norm : 0;
  }
  return out;
}

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = Math.round(s * 32767);
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 32768;
  return out;
}

/**
 * Peak-normalise speech before encoding. Codec2's quantisers are tuned for a
 * healthy input level; a quiet phone mic otherwise wastes resolution.
 * Gain is capped so silence / noise isn't blown up.
 */
export function normalizePeak(input: Float32Array, target = 0.7, maxGain = 8): Float32Array<ArrayBuffer> {
  let peak = 0;
  for (const s of input) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) return input.slice();
  const g = Math.min(maxGain, target / peak);
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] * g;
  return out;
}
