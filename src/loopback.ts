/**
 * Codec2 voice mode (secondary), loopback test without a radio.
 * record -> resample -> Codec2 encode -> bit-pack -> wire chunks
 *        -> parse chunks -> unpack -> decode -> play
 */
import {
  MAX_LORA_PAYLOAD_LEN,
  PORTNUM_PRIVATE_APP,
  meshPacketAirtimeMs,
  meshPacketOnAirBytes,
  presetParams,
  type ModemPresetName,
} from './airtime';
import { unlockAudio } from './audio/engine';
import { playPcm } from './audio/player';
import type { Recording } from './audio/recorder';
import { CODEC_MODES, CODEC_SAMPLE_RATE, type CodecModeName } from './codec/codec2';
import { loadCodec2Browser } from './codec/load-browser';
import { decodeVoice, encodeVoice, prepareVoice, type EncodedMessage } from './pipeline';
import { decodeChunk, randomMsgId } from './protocol/wire';
import { loadSettings, saveSettings } from './settings';
import { fillPresetSelect } from './ui/preset-select';
import { PttRecorder, pttMarkup } from './ui/ptt-recorder';

const MAX_SECONDS = 8;
/** EU_868 10 % duty cycle: 360 s of TX per rolling hour. */
const HOURLY_BUDGET_MS = 360_000;

interface ModeResult {
  enc: EncodedMessage;
  pcm: Int16Array;
  encodeMs: number;
  decodeMs: number;
}

interface Result {
  n: number;
  seconds: number;
  inRate: number;
  original: Int16Array;
  byMode: Record<CodecModeName, ModeResult>;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fmt(n: number, digits = 1) {
  return n.toLocaleString('he-IL', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function mountLoopback() {
  const settings = loadSettings();
  const modeSel = $<HTMLSelectElement>('mode');
  const presetSel = $<HTMLSelectElement>('preset');
  const autoplay = $<HTMLInputElement>('autoplay');
  const normalize = $<HTMLInputElement>('normalize');
  const status = $('status');
  const resultsEl = $('results');
  const pttRoot = $('ptt-root');
  pttRoot.innerHTML = pttMarkup();

  modeSel.value = settings.mode;
  fillPresetSelect(presetSel, settings.preset);
  autoplay.checked = settings.autoplay;
  normalize.checked = settings.normalize;

  const results: Result[] = [];
  const persist = () => {
    settings.mode = modeSel.value as CodecModeName;
    settings.preset = presetSel.value as ModemPresetName;
    settings.autoplay = autoplay.checked;
    settings.normalize = normalize.checked;
    saveSettings(settings);
    renderAll();
  };
  for (const el of [modeSel, presetSel, autoplay, normalize]) el.addEventListener('change', persist);

  function setStatus(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  const codecReady = loadCodec2Browser();
  codecReady.catch((e) => setStatus(`שגיאה בטעינת הקודק: ${e}`, true));

  new PttRecorder({
    root: pttRoot,
    maxSeconds: MAX_SECONDS,
    setStatus,
    onRecording: async (rec: Recording) => {
      setStatus('מקודד…');
      const m = await codecReady;
      const pcm8k = prepareVoice(rec.samples, rec.sampleRate, normalize.checked);
      const msgId = randomMsgId();
      const byMode = {} as Record<CodecModeName, ModeResult>;
      for (const mode of Object.values(CODEC_MODES)) {
        const t0 = performance.now();
        const enc = encodeVoice(m, pcm8k, mode, msgId);
        const t1 = performance.now();
        // Go through the exact bytes that would be on the radio.
        const pcm = decodeVoice(m, enc.chunks.map((b) => decodeChunk(b)));
        byMode[mode.name] = { enc, pcm, encodeMs: t1 - t0, decodeMs: performance.now() - t1 };
      }
      results.unshift({
        n: results.length + 1,
        seconds: rec.samples.length / rec.sampleRate,
        inRate: rec.sampleRate,
        original: pcm8k,
        byMode,
      });
      results.splice(5);
      renderAll();
      setStatus('מוכן. אפשר להשוות בין המצבים למטה.');
      if (autoplay.checked) void playPcm(byMode[settings.mode].pcm, CODEC_SAMPLE_RATE);
    },
  });

  function renderAll() {
    resultsEl.replaceChildren(...results.map(renderResult));
    resultsEl.hidden = results.length === 0;
  }

  function renderResult(r: Result): HTMLElement {
    const card = document.createElement('article');
    card.className = 'card';
    const h = document.createElement('h2');
    h.textContent = `הקלטה ${r.n} · ${fmt(r.seconds)} ש׳`;
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.innerHTML = `דגימה: <span class="ltr">${r.inRate} Hz → 8000 Hz</span>`;
    const orig = playButton('▶ מקור, בלי קודק (<span class="ltr">8 kHz</span>)', r.original);
    const modes = document.createElement('div');
    modes.className = 'modes';
    for (const m of Object.values(r.byMode)) modes.append(modeBox(m));
    card.append(h, meta, orig, modes);
    return card;
  }

  function modeBox(r: ModeResult): HTMLElement {
    const preset = presetParams(settings.preset);
    const airtimeMs = r.enc.chunks.reduce((a, b) => a + meshPacketAirtimeMs(b.length, preset, PORTNUM_PRIVATE_APP), 0);
    const box = document.createElement('div');
    box.className = 'mode';
    box.classList.toggle('selected', r.enc.mode.name === settings.mode);
    const title = document.createElement('strong');
    title.innerHTML = `<span class="ltr">Codec2 ${r.enc.mode.name}</span>`;
    const voiceBytes = r.enc.chunks.reduce((a, b) => a + b.length, 0);
    const sizes = r.enc.chunks.map((b) => b.length).join(' + ');
    const onAir = r.enc.chunks.map((b) => meshPacketOnAirBytes(b.length, PORTNUM_PRIVATE_APP));
    const dl = document.createElement('dl');
    const rows: [string, string][] = [
      ['פריימים', `<span class="ltr">${r.enc.nFrames} × ${r.enc.bitsPerFrame} bit</span>`],
      ['מטען', `<span class="ltr">${voiceBytes} B (${sizes})</span>`],
      ['חבילות', `${r.enc.chunks.length} · <span class="ltr">${onAir.join(' + ')} / ${MAX_LORA_PAYLOAD_LEN} B</span> באוויר`],
      ['זמן שידור', `${fmt(airtimeMs / 1000)} ש׳ (<span class="ltr">${settings.preset}</span>, ישיר)`],
      ['בתקציב שעתי', `כ־${Math.floor(HOURLY_BUDGET_MS / airtimeMs)} הודעות כאלה`],
      ['קידוד / פענוח', `<span class="ltr">${fmt(r.encodeMs, 0)} / ${fmt(r.decodeMs, 0)} ms</span>`],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.innerHTML = v;
      dl.append(dt, dd);
    }
    const btn = playButton(`▶ נגן <span class="ltr">${r.enc.mode.name}</span>`, r.pcm);
    btn.classList.add('primary');
    box.append(title, dl, btn);
    return box;
  }

  /** `html` must be trusted, app-generated markup. */
  function playButton(html: string, pcm: Int16Array): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'play';
    b.innerHTML = html;
    b.addEventListener('click', () => {
      unlockAudio();
      void playPcm(pcm, CODEC_SAMPLE_RATE);
    });
    return b;
  }
}
