import type { Dtypes, SttDevice } from './models';
import type { LoadReport, WorkerRequest, WorkerResponse } from './protocol';

export interface SttEvents {
  onPhase?: (phase: 'check' | 'download' | 'load' | 'warmup') => void;
  onDownloadProgress?: (loaded: number, total: number) => void;
  onLoadProgress?: (loaded: number, total: number) => void;
}

/** Promise wrapper around the Whisper worker. */
export class SttClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: { text: string; ms: number }) => void; reject: (e: Error) => void }>();
  private loading: { resolve: (r: LoadReport) => void; reject: (e: Error) => void } | null = null;
  events: SttEvents = {};

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.failAll(new Error(e.message || 'worker error'));
  }

  load(modelId: string, device: SttDevice, dtypes: Dtypes, allowFallback = true): Promise<LoadReport> {
    this.loading?.reject(new Error('superseded'));
    return new Promise((resolve, reject) => {
      this.loading = { resolve, reject };
      this.send({ type: 'load', modelId, device, dtypes, allowFallback });
    });
  }

  transcribe(audio16k: Float32Array): Promise<{ text: string; ms: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const copy = audio16k.slice();
      this.send({ type: 'transcribe', id, audio: copy }, [copy.buffer]);
    });
  }

  private send(m: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private onMessage(m: WorkerResponse) {
    switch (m.type) {
      case 'phase':
        this.events.onPhase?.(m.phase);
        break;
      case 'download-progress':
        this.events.onDownloadProgress?.(m.loaded, m.total);
        break;
      case 'load-progress':
        this.events.onLoadProgress?.(m.loaded, m.total);
        break;
      case 'loaded':
        this.loading?.resolve(m.report);
        this.loading = null;
        break;
      case 'result':
        this.pending.get(m.id)?.resolve({ text: m.text, ms: m.ms });
        this.pending.delete(m.id);
        break;
      case 'error':
        if (m.id !== undefined) {
          this.pending.get(m.id)?.reject(new Error(m.message));
          this.pending.delete(m.id);
        } else {
          this.loading?.reject(new Error(m.message));
          this.loading = null;
        }
        break;
    }
  }

  private failAll(e: Error) {
    this.loading?.reject(e);
    this.loading = null;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }
}
