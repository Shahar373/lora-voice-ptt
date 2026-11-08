/**
 * Codec2 (WebAssembly) wrapper. Environment-agnostic: the caller supplies the
 * module factory options (browser: wasm URL; tests: wasm bytes from disk).
 */
import createCodec2Module, {
  type Codec2ModuleOptions,
  type Codec2WasmModule,
} from './wasm/codec2.mjs';

export type CodecModeName = '450' | '700C';

export interface CodecModeInfo {
  name: CodecModeName;
  /** Mode id carried in the wire header (low nibble of ver_mode). */
  wireId: number;
  /** Codec2 CODEC2_MODE_* constant. */
  c2mode: number;
}

export const CODEC_MODES: Record<CodecModeName, CodecModeInfo> = {
  '450': { name: '450', wireId: 0, c2mode: 10 },
  '700C': { name: '700C', wireId: 1, c2mode: 8 },
};

export function modeByWireId(id: number): CodecModeInfo | undefined {
  return Object.values(CODEC_MODES).find((m) => m.wireId === id);
}

/** Codec2 operates at 8 kHz in and out for both supported modes. */
export const CODEC_SAMPLE_RATE = 8000;

let modulePromise: Promise<Codec2WasmModule> | null = null;

export function loadCodec2Module(opts?: Codec2ModuleOptions): Promise<Codec2WasmModule> {
  modulePromise ??= createCodec2Module(opts);
  return modulePromise;
}

/**
 * One Codec2 encoder/decoder state. Codec2 keeps inter-frame state, so use a
 * fresh instance per message direction (one to encode, one to decode).
 */
export class Codec2 {
  readonly mode: CodecModeInfo;
  readonly bitsPerFrame: number;
  readonly bytesPerFrame: number;
  readonly samplesPerFrame: number;
  private readonly m: Codec2WasmModule;
  private state: number;
  private readonly pcmPtr: number;
  private readonly bitsPtr: number;

  constructor(m: Codec2WasmModule, mode: CodecModeInfo) {
    this.m = m;
    this.mode = mode;
    this.state = m._c2w_create(mode.c2mode);
    if (!this.state) throw new Error(`codec2_create(${mode.name}) failed`);
    this.bitsPerFrame = m._c2w_bits_per_frame(this.state);
    this.bytesPerFrame = m._c2w_bytes_per_frame(this.state);
    this.samplesPerFrame = m._c2w_samples_per_frame(this.state);
    this.pcmPtr = m._malloc(this.samplesPerFrame * 2);
    this.bitsPtr = m._malloc(this.bytesPerFrame);
  }

  get frameDurationMs(): number {
    return (this.samplesPerFrame / CODEC_SAMPLE_RATE) * 1000;
  }

  /** Encode 8 kHz PCM. The tail is zero-padded to a whole frame. */
  encode(pcm: Int16Array): Uint8Array[] {
    this.assertAlive();
    const spf = this.samplesPerFrame;
    const nFrames = Math.ceil(pcm.length / spf);
    const frames: Uint8Array[] = [];
    const block = new Int16Array(spf);
    for (let i = 0; i < nFrames; i++) {
      block.fill(0);
      block.set(pcm.subarray(i * spf, Math.min(pcm.length, (i + 1) * spf)));
      this.m.HEAP16.set(block, this.pcmPtr >> 1);
      this.m._c2w_encode(this.state, this.bitsPtr, this.pcmPtr);
      frames.push(this.m.HEAPU8.slice(this.bitsPtr, this.bitsPtr + this.bytesPerFrame));
    }
    return frames;
  }

  /** Decode frames to 8 kHz PCM. A `null` frame is rendered as silence. */
  decode(frames: readonly (Uint8Array | null)[]): Int16Array {
    this.assertAlive();
    const spf = this.samplesPerFrame;
    const out = new Int16Array(frames.length * spf);
    frames.forEach((f, i) => {
      if (!f) return; // gap: leave zeros
      this.m.HEAPU8.fill(0, this.bitsPtr, this.bitsPtr + this.bytesPerFrame);
      this.m.HEAPU8.set(f.subarray(0, this.bytesPerFrame), this.bitsPtr);
      this.m._c2w_decode(this.state, this.pcmPtr, this.bitsPtr);
      out.set(this.m.HEAP16.subarray(this.pcmPtr >> 1, (this.pcmPtr >> 1) + spf), i * spf);
    });
    return out;
  }

  destroy(): void {
    if (!this.state) return;
    this.m._free(this.pcmPtr);
    this.m._free(this.bitsPtr);
    this.m._c2w_destroy(this.state);
    this.state = 0;
  }

  private assertAlive() {
    if (!this.state) throw new Error('Codec2 instance destroyed');
  }
}
