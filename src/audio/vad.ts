/**
 * Simple energy-based speech detector for trimming leading/trailing silence.
 * Whisper invents text on silence, so we only hand it the voiced span, and
 * skip transcription entirely when no speech is found.
 */

export interface VadOptions {
  frameMs?: number;
  /** Padding kept before the first and after the last speech frame. */
  padMs?: number;
  /** Speech must be this far (dB) above the estimated noise floor (10th percentile frame). */
  snrDb?: number;
  /** Absolute floor: frames quieter than this are never speech (dBFS). */
  minDb?: number;
  /** Consecutive loud frames needed to count as a speech onset (rejects clicks). */
  minRunFrames?: number;
  /** Total speech (s) required, else the clip counts as silence. */
  minSpeechS?: number;
}

export interface SpeechSpan {
  start: number; // sample index (inclusive)
  end: number; // sample index (exclusive)
  speechS: number; // seconds of frames above threshold
  thresholdDb: number;
  noiseDb: number;
}

const DEFAULTS: Required<VadOptions> = {
  frameMs: 20,
  padMs: 250,
  snrDb: 12,
  minDb: -50,
  minRunFrames: 3,
  minSpeechS: 0.25,
};

export function frameDb(samples: Float32Array, frameLen: number): Float32Array {
  const n = Math.floor(samples.length / frameLen);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let acc = 0;
    for (let i = f * frameLen; i < (f + 1) * frameLen; i++) acc += samples[i] * samples[i];
    out[f] = 10 * Math.log10(acc / frameLen + 1e-12);
  }
  return out;
}

export function findSpeech(samples: Float32Array, rate: number, opts: VadOptions = {}): SpeechSpan | null {
  const o = { ...DEFAULTS, ...opts };
  const frameLen = Math.max(1, Math.round((rate * o.frameMs) / 1000));
  const db = frameDb(samples, frameLen);
  if (db.length === 0) return null;
  const sorted = Array.from(db).sort((a, b) => a - b);
  const noiseDb = sorted[Math.floor(sorted.length * 0.1)];
  const peakDb = sorted[sorted.length - 1];
  // Stationary noise (or silence) has almost no level variation; speech does.
  if (peakDb < o.minDb || peakDb - noiseDb < o.snrDb) return null;
  // Normally noise + snr. When the "noise floor" is really quiet speech (a clip
  // that is speech nearly throughout) the dynamic range is small, so use its
  // midpoint instead so that the speech isn't cut.
  const thresholdDb = Math.max(o.minDb, Math.min(noiseDb + o.snrDb, noiseDb + 0.5 * (peakDb - noiseDb)));
  const loud = Array.from(db, (v) => v > thresholdDb && v > o.minDb);

  const runAt = (i: number, dir: 1 | -1) => {
    for (let k = 0; k < o.minRunFrames; k++) {
      const j = i + k * dir;
      if (j < 0 || j >= loud.length || !loud[j]) return false;
    }
    return true;
  };
  let first = -1;
  for (let i = 0; i < loud.length; i++) if (runAt(i, 1)) { first = i; break; }
  if (first < 0) return null;
  let last = first;
  for (let i = loud.length - 1; i >= first; i--) if (runAt(i, -1)) { last = i; break; }

  let speechFrames = 0;
  for (let i = first; i <= last; i++) if (loud[i]) speechFrames++;
  const speechS = (speechFrames * frameLen) / rate;
  if (speechS < o.minSpeechS) return null;

  const pad = Math.round((rate * o.padMs) / 1000);
  return {
    start: Math.max(0, first * frameLen - pad),
    end: Math.min(samples.length, (last + 1) * frameLen + pad),
    speechS,
    thresholdDb,
    noiseDb,
  };
}
