import { audioContext } from './engine';
import { int16ToFloat, resample } from './resample';

let current: AudioBufferSourceNode | null = null;

/** Play mono int16 PCM at `rate` (resampled to the context rate). Stops anything already playing. */
export function playPcm(pcm: Int16Array, rate: number): Promise<void> {
  const ctx = audioContext();
  stopPlayback();
  const f = resample(int16ToFloat(pcm), rate, ctx.sampleRate);
  if (f.length === 0) return Promise.resolve();
  const buf = ctx.createBuffer(1, f.length, ctx.sampleRate);
  buf.copyToChannel(f, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  current = src;
  return new Promise((resolve) => {
    src.onended = () => {
      if (current === src) current = null;
      resolve();
    };
    src.start();
  });
}

export function stopPlayback() {
  if (current) {
    try {
      current.stop();
    } catch {
      /* already stopped */
    }
    current = null;
  }
}
