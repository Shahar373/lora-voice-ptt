import type { Dtypes, SttDevice } from './models';

export type WorkerRequest =
  | { type: 'load'; modelId: string; device: SttDevice; dtypes: Dtypes; allowFallback: boolean }
  | { type: 'transcribe'; id: number; audio: Float32Array }
  | { type: 'unload' };

export interface LoadReport {
  modelId: string;
  /** Device the pipeline actually runs on (may differ from requested after fallback). */
  device: SttDevice;
  dtypes: Dtypes;
  fallbackReason?: string;
  /** Bytes fetched from the network this time (0 when everything was cached). */
  downloadedBytes: number;
  /** Total size of the model files (cached + downloaded). */
  totalBytes: number;
  downloadMs: number;
  /** Reading from cache + creating the ONNX sessions. */
  loadMs: number;
  /** First inference (shader compilation on WebGPU). */
  warmupMs: number;
  wasCached: boolean;
}

export type WorkerResponse =
  | { type: 'phase'; phase: 'check' | 'download' | 'load' | 'warmup' }
  | { type: 'download-progress'; loaded: number; total: number }
  | { type: 'load-progress'; loaded: number; total: number }
  | { type: 'loaded'; report: LoadReport }
  | { type: 'result'; id: number; text: string; ms: number }
  | { type: 'error'; id?: number; message: string };
