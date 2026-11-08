/**
 * Model file cache. transformers.js stores each file in the Cache API under its
 * full Hub URL; we use the same cache and keys so it finds what we download.
 * Works in both window and worker scopes.
 */
export const CACHE_NAME = 'transformers-cache'; // env.cacheKey default
const REMOTE_HOST = 'https://huggingface.co/';
const PATH_TEMPLATE = '{model}/resolve/{revision}/';

/** Same as transformers.js pathJoin(). */
function pathJoin(...parts: string[]): string {
  return parts
    .map((p, i) => {
      if (i) p = p.replace(/^\//, '');
      if (i !== parts.length - 1) p = p.replace(/\/$/, '');
      return p;
    })
    .join('/');
}

export function fileUrl(modelId: string, file: string): string {
  return pathJoin(REMOTE_HOST, PATH_TEMPLATE.replaceAll('{model}', modelId).replaceAll('{revision}', 'main'), file);
}

export interface CachedModelInfo {
  modelId: string;
  files: number;
  bytes: number;
}

/** Sizes of cached files per model (from stored Content-Length headers). */
export async function cachedModels(): Promise<Map<string, CachedModelInfo>> {
  const out = new Map<string, CachedModelInfo>();
  if (!('caches' in self)) return out;
  const cache = await caches.open(CACHE_NAME);
  for (const req of await cache.keys()) {
    const m = req.url.match(/^https:\/\/huggingface\.co\/(.+?)\/resolve\//);
    if (!m) continue;
    const res = await cache.match(req);
    const bytes = Number(res?.headers.get('content-length') ?? 0);
    const info = out.get(m[1]) ?? { modelId: m[1], files: 0, bytes: 0 };
    info.files++;
    info.bytes += bytes;
    out.set(m[1], info);
  }
  return out;
}

export async function deleteModel(modelId: string): Promise<number> {
  const cache = await caches.open(CACHE_NAME);
  let n = 0;
  for (const req of await cache.keys()) {
    if (req.url.startsWith(fileUrl(modelId, ''))) {
      await cache.delete(req);
      n++;
    }
  }
  return n;
}

/**
 * Download files that aren't cached yet, streaming each body straight into the
 * Cache API (no full copy in JS memory, which matters for a 1.3 GB encoder on a
 * phone). Returns bytes downloaded and the total size of all files.
 */
export async function prefetch(
  modelId: string,
  files: string[],
  onProgress: (loaded: number, total: number) => void,
): Promise<{ downloaded: number; total: number }> {
  const cache = await caches.open(CACHE_NAME);
  let cachedBytes = 0;
  const missing: string[] = [];
  for (const f of files) {
    const hit = await cache.match(fileUrl(modelId, f));
    if (hit) cachedBytes += Number(hit.headers.get('content-length') ?? 0);
    else missing.push(f);
  }
  if (missing.length === 0) return { downloaded: 0, total: cachedBytes };

  const responses = await Promise.all(
    missing.map(async (f) => {
      const url = fileUrl(modelId, f);
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`הורדה נכשלה (${res.status}): ${f}`);
      return { url, res, size: Number(res.headers.get('content-length') ?? 0) };
    }),
  );
  const total = responses.reduce((a, r) => a + r.size, 0);
  let loaded = 0;
  onProgress(0, total);
  await Promise.all(
    responses.map(({ url, res, size }) => {
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          loaded += chunk.byteLength;
          onProgress(loaded, total);
          ctl.enqueue(chunk);
        },
      });
      const headers = new Headers({ 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' });
      if (size) headers.set('content-length', String(size));
      return cache.put(url, new Response(res.body!.pipeThrough(counter), { headers }));
    }),
  );
  return { downloaded: loaded, total: total + cachedBytes };
}
