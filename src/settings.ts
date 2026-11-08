import type { ModemPresetName } from './airtime';
import type { CodecModeName } from './codec/codec2';

/** Small typed localStorage wrapper. Storage can be unavailable (private mode etc.). */
function load<T extends object>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...defaults };
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export interface Settings {
  /** Modem preset used for airtime estimates. Not final yet; the nodes are on LONG_FAST today. */
  preset: ModemPresetName;
  mode: CodecModeName;
  autoplay: boolean;
  normalize: boolean;
}

const KEY = 'lora-ptt.settings.v1';
const DEFAULTS: Settings = { preset: 'LONG_FAST', mode: '450', autoplay: true, normalize: true };

export const loadSettings = () => load(KEY, DEFAULTS);
export const saveSettings = (s: Settings) => save(KEY, s);

export { load as loadJson, save as saveJson };
