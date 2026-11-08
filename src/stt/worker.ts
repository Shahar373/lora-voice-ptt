/// Whisper speech-to-text worker (transformers.js). Keeps the UI thread free.
import { ModelRegistry, env, pipeline, type ProgressInfo } from '@huggingface/transformers';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { prefetch } from './cache';
import { dtypeOption, type Dtypes, type SttDevice } from './models';
import type { LoadReport, WorkerRequest, WorkerResponse } from './protocol';

// Serve ONNX Runtime's WASM from our own origin (no CDN; works offline once cached).
env.allowLocalModels = false;
const onnxEnv = env.backends.onnx as { wasm?: { wasmPaths?: unknown } };
if (onnxEnv.wasm) onnxEnv.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href).href, wasm: new URL(ortWasmUrl, self.location.href).href };

const TASK = 'automatic-speech-recognition';
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: (Asr & { dispose?: () => Promise<void> }) | null = null;
let phase: 'check' | 'download' | 'load' | 'warmup' = 'check';

const post = (m: WorkerResponse, transfer: Transferable[] = []) => {
  if (m.type === 'phase') phase = m.phase;
  (self as unknown as Worker).postMessage(m, transfer);
};

async function dispose() {
  if (asr?.dispose) await asr.dispose();
  asr = null;
}

async function loadOn(modelId: string, device: SttDevice, dtypes: Dtypes) {
  const dtype = dtypeOption(dtypes);

  post({ type: 'phase', phase: 'check' });
  let downloadedBytes = 0;
  let totalBytes = 0;
  let downloadMs = 0;
  try {
    const files = await ModelRegistry.get_pipeline_files(TASK, modelId, { dtype, device });
    post({ type: 'phase', phase: 'download' });
    const t0 = performance.now();
    let last = 0;
    const r = await prefetch(modelId, files, (loaded, total) => {
      const now = performance.now();
      if (now - last > 100 || loaded === total) {
        last = now;
        post({ type: 'download-progress', loaded, total });
      }
    });
    downloadMs = performance.now() - t0;
    downloadedBytes = r.downloaded;
    totalBytes = r.total;
  } catch (e) {
    // Offline with everything cached: the Hub lookup fails, but pipeline() can still load from cache.
    if (navigator.onLine) throw e;
  }

  post({ type: 'phase', phase: 'load' });
  const t1 = performance.now();
  const files = new Map<string, { loaded: number; total: number }>();
  const pipe = await pipeline(TASK, modelId, {
    device,
    dtype,
    progress_callback: (p: ProgressInfo) => {
      if (p.status === 'progress') {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        post({ type: 'load-progress', loaded, total });
      }
    },
  });
  const loadMs = performance.now() - t1;
  asr = pipe as unknown as Asr;

  post({ type: 'phase', phase: 'warmup' });
  const t2 = performance.now();
  await asr(new Float32Array(16000), { language: 'he', task: 'transcribe', max_new_tokens: 2 });
  const warmupMs = performance.now() - t2;

  const report: LoadReport = {
    modelId,
    device,
    dtypes,
    downloadedBytes,
    totalBytes,
    downloadMs,
    loadMs,
    warmupMs,
    wasCached: downloadedBytes === 0,
  };
  return report;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'load') {
      await dispose();
      try {
        const report = await loadOn(msg.modelId, msg.device, msg.dtypes);
        post({ type: 'loaded', report });
      } catch (err) {
        // Only a WebGPU failure while creating sessions / running falls back;
        // a failed download would just fail again (and cost another download).
        if (msg.device !== 'webgpu' || !msg.allowFallback || (phase !== 'load' && phase !== 'warmup')) throw err;
        // WebGPU failed (unsupported op, out of memory, ...): retry on WASM with 8-bit weights.
        await dispose();
        const reason = err instanceof Error ? err.message : String(err);
        const report = await loadOn(msg.modelId, 'wasm', { encoder_model: 'q8', decoder_model_merged: 'q8' });
        post({ type: 'loaded', report: { ...report, fallbackReason: reason } });
      }
    } else if (msg.type === 'transcribe') {
      if (!asr) throw new Error('המודל לא נטען');
      const t = performance.now();
      const out = await asr(msg.audio, { language: 'he', task: 'transcribe' });
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).trim();
      post({ type: 'result', id: msg.id, text, ms: performance.now() - t });
    } else if (msg.type === 'unload') {
      await dispose();
    }
  } catch (err) {
    post({
      type: 'error',
      id: msg.type === 'transcribe' ? msg.id : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
