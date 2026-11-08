/** What the browser offers for running Whisper. */
export interface GpuInfo {
  available: boolean;
  f16: boolean;
  vendor?: string;
  architecture?: string;
  description?: string;
  maxBufferMB?: number;
  error?: string;
}

interface GpuAdapterLike {
  features: { has(f: string): boolean };
  limits: { maxBufferSize: number };
  info?: { vendor?: string; architecture?: string; description?: string; device?: string };
}

export async function probeWebGpu(): Promise<GpuInfo> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(o?: object): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return { available: false, f16: false, error: 'navigator.gpu חסר' };
  try {
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, f16: false, error: 'אין מתאם WebGPU' };
    return {
      available: true,
      f16: adapter.features.has('shader-f16'),
      vendor: adapter.info?.vendor,
      architecture: adapter.info?.architecture,
      description: adapter.info?.description || adapter.info?.device,
      maxBufferMB: Math.round(adapter.limits.maxBufferSize / 2 ** 20),
    };
  } catch (e) {
    return { available: false, f16: false, error: String(e) };
  }
}
