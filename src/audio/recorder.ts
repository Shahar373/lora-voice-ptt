import { audioContext } from './engine';
import workletUrl from './capture-worklet.ts?worker&url';

export interface Recording {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Mic capture via AudioWorklet. The mic stream is opened once (first use) and
 * kept open so later presses start recording instantly.
 */
export class Recorder {
  onLevel?: (peak: number) => void;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private chunks: Float32Array[] = [];
  private total = 0;
  private maxSamples = Infinity;
  private stopResolve: (() => void) | null = null;
  private ready: Promise<void> | null = null;

  get isReady(): boolean {
    return this.node !== null;
  }

  /** Ask for the mic and build the audio graph. Must follow a user gesture the first time. */
  ensureMic(): Promise<void> {
    this.ready ??= this.setup().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async setup() {
    const ctx = audioContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(ctx, 'capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    node.port.onmessage = (e) => this.onMessage(e.data);
    src.connect(node);
    // Keep the node pulled by the graph; its output is silent.
    node.connect(ctx.destination);
    this.node = node;
  }

  get sampleRate(): number {
    return audioContext().sampleRate;
  }

  start(maxSeconds: number) {
    if (!this.node) throw new Error('mic not ready');
    this.chunks = [];
    this.total = 0;
    this.maxSamples = Math.round(maxSeconds * this.sampleRate);
    this.node.port.postMessage('start');
  }

  async stop(): Promise<Recording> {
    if (!this.node) throw new Error('mic not ready');
    const done = new Promise<void>((r) => (this.stopResolve = r));
    this.node.port.postMessage('stop');
    await done;
    const out = new Float32Array(this.total);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    this.chunks = [];
    return { samples: out, sampleRate: this.sampleRate };
  }

  cancel() {
    this.node?.port.postMessage('cancel');
    this.chunks = [];
    this.total = 0;
  }

  private onMessage(msg: { type: string; samples?: Float32Array }) {
    if (msg.type === 'data' && msg.samples) {
      const room = this.maxSamples - this.total;
      const s = room < msg.samples.length ? msg.samples.subarray(0, Math.max(0, room)) : msg.samples;
      if (s.length) {
        this.chunks.push(s);
        this.total += s.length;
      }
      let peak = 0;
      for (const x of msg.samples) peak = Math.max(peak, Math.abs(x));
      this.onLevel?.(peak);
    } else if (msg.type === 'stopped') {
      this.stopResolve?.();
      this.stopResolve = null;
    }
  }
}
