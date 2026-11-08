/**
 * Whisper models for Hebrew speech-to-text, best first (fallback ladder).
 * All are transformers.js-ready ONNX repos on the Hugging Face Hub.
 */
export type SttModelKey = 'he-turbo' | 'medium' | 'small';
export type SttDevice = 'webgpu' | 'wasm';
export type Precision = 'auto' | 'fp16' | 'q4' | 'q8';
type EncDtype = 'fp16' | 'q4' | 'q8';
type DecDtype = 'q4' | 'q8';

export interface SttModel {
  key: SttModelKey;
  id: string;
  label: string;
  note: string;
  /** Approximate file sizes (MB) from the Hub listing, for the UI before download. */
  encoderMB: Record<EncDtype, number>;
  decoderMB: Record<DecDtype, number>;
}

export const STT_MODELS: SttModel[] = [
  {
    key: 'he-turbo',
    // ivrit.ai's own ONNX export of their Hebrew fine-tune of whisper-large-v3-turbo.
    id: 'ivrit-ai/whisper-large-v3-turbo-onnx',
    label: 'ivrit.ai large-v3-turbo (עברית)',
    note: 'מכוונן לעברית. הכי מדויק, הכי כבד.',
    encoderMB: { fp16: 1274, q4: 425, q8: 645 },
    decoderMB: { q4: 334, q8: 438 },
  },
  {
    key: 'medium',
    id: 'Xenova/whisper-medium',
    label: 'Whisper medium (רב־לשוני)',
    note: 'לא מכוונן לעברית.',
    encoderMB: { fp16: 615, q4: 210, q8: 314 },
    decoderMB: { q4: 470, q8: 463 },
  },
  {
    key: 'small',
    id: 'onnx-community/whisper-small',
    label: 'Whisper small (רב־לשוני)',
    note: 'קטן ומהיר, עברית חלשה.',
    encoderMB: { fp16: 177, q4: 66, q8: 92 },
    decoderMB: { q4: 233, q8: 157 },
  },
];

export const modelByKey = (k: SttModelKey) => STT_MODELS.find((m) => m.key === k) ?? STT_MODELS[0];

export interface Dtypes {
  encoder_model: EncDtype;
  decoder_model_merged: DecDtype;
}

/**
 * transformers.js 4.3.2 keys per-file dtypes inconsistently: model loading
 * (getSession) uses the file name `encoder_model`, while ModelRegistry
 * (file listing / cache checks) uses the session name `model`. Pass both.
 */
export function dtypeOption(d: Dtypes) {
  return { model: d.encoder_model, encoder_model: d.encoder_model, decoder_model_merged: d.decoder_model_merged };
}

/**
 * Pick per-file dtypes. "auto": best quality the device can run —
 * fp16 encoder on WebGPU with shader-f16, otherwise q4 on WebGPU, q8 on WASM.
 * The decoder is small relative to the encoder's effect on quality, so it is q4/q8.
 */
export function resolveDtypes(device: SttDevice, precision: Precision, hasF16: boolean): Dtypes {
  if (precision === 'auto') {
    if (device === 'wasm') return { encoder_model: 'q8', decoder_model_merged: 'q8' };
    return { encoder_model: hasF16 ? 'fp16' : 'q4', decoder_model_merged: 'q4' };
  }
  if (precision === 'fp16') return { encoder_model: 'fp16', decoder_model_merged: 'q4' };
  if (precision === 'q4') return { encoder_model: 'q4', decoder_model_merged: 'q4' };
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

export function approxSizeMB(m: SttModel, d: Dtypes): number {
  return m.encoderMB[d.encoder_model] + m.decoderMB[d.decoder_model_merged] + 6; // + tokenizer/config
}
