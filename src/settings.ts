import type { CodecModeName } from './codec/codec2';

export interface Settings {
  mode: CodecModeName;
  autoplay: boolean;
  normalize: boolean;
}

const KEY = 'lora-ptt.settings.v1';
const DEFAULTS: Settings = { mode: '450', autoplay: true, normalize: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
