/// AudioWorklet that copies mic samples to the main thread while recording.
// Minimal declarations for the AudioWorkletGlobalScope (not in lib.dom).
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: unknown): void;

const BLOCK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private recording = false;
  private buf = new Float32Array(BLOCK);
  private n = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'start') {
        this.n = 0;
        this.recording = true;
      } else if (e.data === 'stop') {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: 'stopped' });
      } else if (e.data === 'cancel') {
        this.n = 0;
        this.recording = false;
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (this.recording && ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, BLOCK - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === BLOCK) this.flush();
      }
    }
    return true;
  }

  private flush() {
    if (this.n === 0) return;
    const samples = this.buf.slice(0, this.n);
    this.n = 0;
    this.port.postMessage({ type: 'data', samples }, [samples.buffer]);
  }
}

registerProcessor('capture', CaptureProcessor);
