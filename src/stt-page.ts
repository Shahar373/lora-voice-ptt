/**
 * Whisper feasibility test: download + load a model, record, transcribe, and
 * measure everything (download, load, warm-up, transcription, backend).
 */
import './style.css';
import {
  PORTNUM_TEXT_MESSAGE,
  meshPacketAirtimeMs,
  presetParams,
  type ModemPresetName,
} from './airtime';
import { unlockAudio } from './audio/engine';
import { playPcm } from './audio/player';
import type { Recording } from './audio/recorder';
import { floatToInt16, resample } from './audio/resample';
import { findSpeech } from './audio/vad';
import { MAX_TEXT_BYTES, splitText, utf8Length } from './protocol/text';
import { loadJson, saveJson } from './settings';
import { cachedModels, deleteModel } from './stt/cache';
import { SttClient } from './stt/client';
import { probeWebGpu, type GpuInfo } from './stt/device';
import {
  STT_MODELS,
  approxSizeMB,
  modelByKey,
  resolveDtypes,
  type Precision,
  type SttDevice,
  type SttModelKey,
} from './stt/models';
import type { LoadReport } from './stt/protocol';
import { hebrewVoices, speakHebrew, type HebrewVoiceInfo } from './tts';
import { PttRecorder, pttMarkup } from './ui/ptt-recorder';

const WHISPER_RATE = 16000;
const MAX_SECONDS = 15;
const COMPARE_PRESETS: ModemPresetName[] = ['LONG_FAST', 'LONG_MODERATE', 'LONG_SLOW'];

interface SttSettings {
  model: SttModelKey;
  precision: Precision;
  device: 'auto' | SttDevice;
}
const SETTINGS_KEY = 'lora-ptt.stt.v1';
const settings = loadJson<SttSettings>(SETTINGS_KEY, { model: 'he-turbo', precision: 'auto', device: 'auto' });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtS = (ms: number) => `${(ms / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ש׳`;
function fmtBytes(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(2)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${(b / 1e3).toFixed(0)} KB`;
}
const ltr = (s: string) => `<span class="ltr">${s}</span>`;

function fillKv(dl: HTMLElement, rows: [string, string][]) {
  dl.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.innerHTML = v;
      return [dt, dd];
    }),
  );
}

const status = $('status');
function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

// ---------------------------------------------------------------- environment
let gpu: GpuInfo = { available: false, f16: false };
async function renderEnv() {
  gpu = await probeWebGpu();
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  fillKv($('env'), [
    [
      'WebGPU',
      gpu.available
        ? `<span class="good">זמין</span> · ${ltr(esc([gpu.vendor, gpu.architecture].filter(Boolean).join(' / ') || '?'))}`
        : `<span class="bad">לא זמין</span>${gpu.error ? ` · ${esc(gpu.error)}` : ''}`,
    ],
    ['fp16 ב־GPU', gpu.available ? (gpu.f16 ? '<span class="good">כן</span>' : '<span class="bad">לא</span>') : '—'],
    ['באפר GPU מקסימלי', gpu.maxBufferMB ? ltr(`${gpu.maxBufferMB} MB`) : '—'],
    ['זיכרון מכשיר', mem ? `${ltr(`≥${mem} GB`)} (לפי הדפדפן)` : 'לא ידוע'],
    ['ליבות', String(navigator.hardwareConcurrency ?? '?')],
    ['WASM מרובה תהליכונים', crossOriginIsolated ? '<span class="good">כן</span>' : 'לא (GitHub Pages)'],
    ['אחסון', est ? `${ltr(fmtBytes(est.usage ?? 0))} בשימוש מתוך ${ltr(fmtBytes(est.quota ?? 0))}` : 'לא ידוע'],
    ['אחסון קבוע', persisted ? '<span class="good">כן</span>' : 'לא (יתבקש בטעינה)'],
  ]);
}

// ---------------------------------------------------------------------- model
const modelSel = $<HTMLSelectElement>('model');
const precisionSel = $<HTMLSelectElement>('precision');
const deviceSel = $<HTMLSelectElement>('device');
const loadBtn = $<HTMLButtonElement>('load');
const deleteBtn = $<HTMLButtonElement>('delete');
const modelInfo = $('model-info');
const progress = $('progress');
const progressFill = $('progress-fill');
const progressText = $('progress-text');
const metrics = $('metrics');

modelSel.replaceChildren(
  ...STT_MODELS.map((m) => {
    const o = document.createElement('option');
    o.value = m.key;
    o.textContent = m.label;
    return o;
  }),
);
modelSel.value = settings.model;
precisionSel.value = settings.precision;
deviceSel.value = settings.device;

function selection() {
  const model = modelByKey(modelSel.value as SttModelKey);
  const device: SttDevice =
    deviceSel.value === 'auto' ? (gpu.available ? 'webgpu' : 'wasm') : (deviceSel.value as SttDevice);
  const dtypes = resolveDtypes(device, precisionSel.value as Precision, gpu.f16);
  return { model, device, dtypes };
}

async function renderModelInfo() {
  const { model, device, dtypes } = selection();
  const cached = (await cachedModels()).get(model.id);
  const warn =
    device === 'webgpu' && dtypes.encoder_model === 'fp16' && !gpu.f16
      ? ' · <span class="bad">ה־GPU לא תומך ב־fp16</span>'
      : device === 'wasm' && dtypes.encoder_model === 'fp16'
        ? ' · <span class="bad">fp16 איטי מאוד ב־WASM</span>'
        : '';
  modelInfo.innerHTML =
    `${esc(model.note)} ${ltr(esc(model.id))}<br>` +
    `מנוע: ${ltr(device)} · מקודד ${ltr(dtypes.encoder_model)}, מפענח ${ltr(dtypes.decoder_model_merged)} · ` +
    `הורדה של כ־${ltr(fmtBytes(approxSizeMB(model, dtypes) * 1e6))}${warn}<br>` +
    (cached ? `במכשיר כבר: ${ltr(fmtBytes(cached.bytes))} (${cached.files} קבצים)` : 'עוד לא במכשיר');
  deleteBtn.disabled = !cached;
}

for (const el of [modelSel, precisionSel, deviceSel]) {
  el.addEventListener('change', () => {
    settings.model = modelSel.value as SttModelKey;
    settings.precision = precisionSel.value as Precision;
    settings.device = deviceSel.value as SttSettings['device'];
    saveJson(SETTINGS_KEY, settings);
    void renderModelInfo();
  });
}

const stt = new SttClient();
let loaded: LoadReport | null = null;
let phaseStart = 0;

stt.events = {
  onPhase: (p) => {
    phaseStart = performance.now();
    progress.hidden = false;
    progressFill.style.width = '0';
    progressText.textContent =
      p === 'check'
        ? 'בודק אילו קבצים צריך…'
        : p === 'download'
          ? 'מוריד…'
          : p === 'load'
            ? 'טוען לזיכרון ובונה את המודל…'
            : 'חימום (ריצה ראשונה)…';
    if (p === 'warmup') progressFill.style.width = '100%';
  },
  onDownloadProgress: (l, t) => {
    const secs = (performance.now() - phaseStart) / 1000;
    const rate = secs > 0.5 ? ` · ${ltr(`${(l / 1e6 / secs).toFixed(1)} MB/s`)}` : '';
    progressFill.style.width = `${t ? (100 * l) / t : 0}%`;
    progressText.innerHTML = `מוריד ${ltr(`${fmtBytes(l)} / ${fmtBytes(t)}`)}${rate}`;
  },
  onLoadProgress: (l, t) => {
    progressFill.style.width = `${t ? (100 * l) / t : 0}%`;
    progressText.innerHTML = `טוען לזיכרון ${ltr(`${fmtBytes(l)} / ${fmtBytes(t)}`)}`;
  },
};

loadBtn.addEventListener('click', async () => {
  const { model, device, dtypes } = selection();
  loadBtn.disabled = true;
  deleteBtn.disabled = true;
  ptt.setEnabled(false, 'טוען מודל…');
  metrics.hidden = true;
  loaded = null;
  setStatus('');
  // Ask the browser not to evict the (large) model under storage pressure.
  await navigator.storage?.persist?.().catch(() => false);
  const t0 = performance.now();
  try {
    loaded = await stt.load(model.id, device, dtypes);
    const r = loaded;
    progress.hidden = true;
    metrics.hidden = false;
    fillKv(metrics, [
      ['רץ על', r.device === 'webgpu' ? '<span class="good">WebGPU</span>' : `${ltr('WASM')} (מעבד)`],
      ...(r.fallbackReason
        ? ([['נפל ל־WASM כי', `<span class="bad">${esc(r.fallbackReason.slice(0, 300))}</span>`]] as [string, string][])
        : []),
      ['משקלים', ltr(`encoder ${r.dtypes.encoder_model} · decoder ${r.dtypes.decoder_model_merged}`)],
      ['גודל המודל', ltr(fmtBytes(r.totalBytes))],
      ['הורדה', r.wasCached ? 'לא היה צורך (כבר במכשיר)' : `${fmtS(r.downloadMs)} · ${ltr(fmtBytes(r.downloadedBytes))}`],
      ['טעינה לזיכרון', fmtS(r.loadMs)],
      ['חימום (ריצה ראשונה)', fmtS(r.warmupMs)],
      ['סה״כ עד מוכן', fmtS(performance.now() - t0)],
    ]);
    ptt.setEnabled(true);
    setStatus('המודל מוכן. החזק את הכפתור ודבר.');
  } catch (e) {
    progress.hidden = true;
    ptt.setEnabled(false, 'אין מודל');
    setStatus(`טעינה נכשלה: ${e instanceof Error ? e.message : e}`, true);
  } finally {
    loadBtn.disabled = false;
    void renderModelInfo();
    void renderEnv();
  }
});

deleteBtn.addEventListener('click', async () => {
  const { model } = selection();
  if (!confirm(`למחוק את ${model.label} מהמכשיר?`)) return;
  const n = await deleteModel(model.id);
  setStatus(`נמחקו ${n} קבצים.`);
  void renderModelInfo();
  void renderEnv();
});

// ------------------------------------------------------------------- TTS
let voices: HebrewVoiceInfo = { voices: [], best: null, supported: false };
async function renderTts() {
  voices = await hebrewVoices();
  const info = $('tts-info');
  if (!voices.supported) {
    info.innerHTML = '<span class="bad">הדפדפן לא תומך בהקראה (speechSynthesis).</span>';
  } else if (!voices.best) {
    info.innerHTML =
      '<span class="bad">לא נמצא קול עברי.</span> באנדרואיד: הגדרות ← מערכת ← שפות וקלט ← ' +
      'פלט של המרת טקסט לדיבור ← Google ← התקנת נתוני קול ← עברית. אחר כך לרענן את הדף.';
  } else {
    const offline = voices.voices.some((v) => v.localService);
    info.innerHTML =
      `נמצא: ${voices.voices.map((v) => ltr(esc(`${v.name} (${v.lang})`))).join(', ')}` +
      (offline ? ' · <span class="good">יש קול מקומי (עובד בלי אינטרנט)</span>' : ' · <span class="bad">רק קול רשת: לא יעבוד בשטח בלי אינטרנט</span>');
  }
}
$('tts-test').addEventListener('click', () => {
  unlockAudio();
  speakHebrew('בדיקה. הודעה מתחנה בית: אני בדרך, מגיע בעוד עשר דקות.', voices.best).catch((e) =>
    setStatus(`הקראה נכשלה: ${e.message}`, true),
  );
});

// ------------------------------------------------------------- recording
const results = $('results');
const pttRoot = $('ptt-root');
pttRoot.innerHTML = pttMarkup();
let counter = 0;

const ptt = new PttRecorder({
  root: pttRoot,
  maxSeconds: MAX_SECONDS,
  setStatus,
  processingLabel: 'מתמלל…',
  onRecording: async (rec: Recording) => {
    if (!loaded) throw new Error('המודל לא נטען');
    const audio = resample(rec.samples, rec.sampleRate, WHISPER_RATE);
    const rawS = audio.length / WHISPER_RATE;
    const span = findSpeech(audio, WHISPER_RATE);
    counter++;
    if (!span) {
      addResult({ n: counter, rawS, text: null, audio });
      setStatus('לא זוהה דיבור (רק שקט/רעש), לא נשלח לתמלול.');
      return;
    }
    const trimmed = audio.slice(span.start, span.end);
    setStatus('מתמלל…');
    const { text, ms } = await stt.transcribe(trimmed);
    addResult({ n: counter, rawS, text, audio: trimmed, ms, device: loaded.device });
    setStatus('');
  },
});
ptt.setEnabled(false, 'אין מודל');

interface Result {
  n: number;
  rawS: number;
  text: string | null;
  audio: Float32Array;
  ms?: number;
  device?: SttDevice;
}

function addResult(r: Result) {
  const card = document.createElement('article');
  card.className = 'card';
  const audioS = r.audio.length / WHISPER_RATE;
  const h = document.createElement('h2');
  h.textContent = `הקלטה ${r.n}`;
  const p = document.createElement('p');
  p.className = 'transcript';
  if (r.text === null || r.text === '') {
    p.classList.add('empty');
    p.textContent = r.text === null ? '(לא זוהה דיבור)' : '(תמלול ריק)';
  } else {
    p.textContent = r.text;
  }
  const dl = document.createElement('dl');
  dl.className = 'kv';
  const rows: [string, string][] = [
    ['אורך', `${fmtS(r.rawS * 1000)} הוקלט · ${fmtS(audioS * 1000)} אחרי חיתוך שקט`],
  ];
  if (r.ms !== undefined) {
    rows.push(['זמן תמלול', `${fmtS(r.ms)} על ${ltr(r.device ?? '?')} (פי ${(r.ms / 1000 / audioS).toFixed(2)} מאורך הדיבור)`]);
  }
  if (r.text) {
    const bytes = utf8Length(r.text);
    const parts = splitText(r.text);
    rows.push([
      'גודל',
      `${r.text.length} תווים · ${ltr(`${bytes} / ${MAX_TEXT_BYTES} B`)} · ${parts.length === 1 ? 'חבילה אחת' : `${parts.length} חבילות`}`,
    ]);
    const air = COMPARE_PRESETS.map((name) => {
      const ms = parts.reduce(
        (a, t) => a + meshPacketAirtimeMs(utf8Length(t), presetParams(name), PORTNUM_TEXT_MESSAGE),
        0,
      );
      return `${ltr(name)} ${fmtS(ms)}`;
    });
    rows.push(['זמן אוויר', air.join(' · ')]);
  }
  fillKv(dl, rows);
  const row = document.createElement('div');
  row.className = 'row';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play';
  play.textContent = '▶ ההקלטה';
  play.addEventListener('click', () => {
    unlockAudio();
    void playPcm(floatToInt16(r.audio), WHISPER_RATE);
  });
  row.append(play);
  if (r.text) {
    const say = document.createElement('button');
    say.type = 'button';
    say.className = 'play primary';
    say.textContent = '🔊 הקרא';
    say.addEventListener('click', () => {
      unlockAudio();
      speakHebrew(r.text!, voices.best).catch((e) => setStatus(`הקראה נכשלה: ${e.message}`, true));
    });
    row.append(say);
  }
  card.append(h, p, dl, row);
  results.prepend(card);
  while (results.children.length > 10) results.lastElementChild?.remove();
}

await renderEnv();
void renderModelInfo();
void renderTts();
