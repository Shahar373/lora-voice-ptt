/**
 * Hebrew text-to-speech via the browser's speechSynthesis (offline when the
 * device has a local Hebrew voice, e.g. Google TTS "Hebrew" downloaded on Android).
 */

export interface HebrewVoiceInfo {
  voices: SpeechSynthesisVoice[];
  /** Best pick: a local (offline-capable) Hebrew voice if there is one. */
  best: SpeechSynthesisVoice | null;
  supported: boolean;
}

const isHebrew = (v: SpeechSynthesisVoice) => /^(he|iw)([-_]|$)/i.test(v.lang);

/** Voices load asynchronously in Chrome; wait for them (briefly). */
export async function hebrewVoices(timeoutMs = 2000): Promise<HebrewVoiceInfo> {
  if (!('speechSynthesis' in window)) return { voices: [], best: null, supported: false };
  const synth = window.speechSynthesis;
  let all = synth.getVoices();
  if (all.length === 0) {
    all = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const done = () => resolve(synth.getVoices());
      synth.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, timeoutMs);
    });
  }
  const voices = all.filter(isHebrew);
  const best = voices.find((v) => v.localService) ?? voices[0] ?? null;
  return { voices, best, supported: true };
}

export function speakHebrew(text: string, voice?: SpeechSynthesisVoice | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('speechSynthesis' in window)) return reject(new Error('speechSynthesis not supported'));
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice?.lang ?? 'he-IL';
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? resolve() : reject(new Error(e.error)));
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}
