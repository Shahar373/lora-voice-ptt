/**
 * Milestone 1: codec loopback, no radio.
 * record -> resample -> Codec2 encode -> bit-pack -> wire chunks
 *        -> parse chunks -> unpack -> decode -> play
 */
import { meshPacketAirtimeMs, MAX_LORA_PAYLOAD_LEN, meshPacketOnAirBytes } from './airtime';
import { unlockAudio } from './audio/engine';
import { playPcm, stopPlayback } from './audio/player';
import { Recorder } from './audio/recorder';
import { CODEC_MODES, CODEC_SAMPLE_RATE, type CodecModeName } from './codec/codec2';
import { loadCodec2Browser } from './codec/load-browser';
import { decodeVoice, encodeVoice, prepareVoice, type EncodedMessage } from './pipeline';
import { decodeChunk, randomMsgId } from './protocol/wire';
import { loadSettings, saveSettings } from './settings';
import { attachPtt } from './ui/ptt';

const MAX_SECONDS = 8;
const MIN_SECONDS = 0.4;
/** EU_868 10 % duty cycle: 360 s of TX per rolling hour. */
const HOURLY_BUDGET_MS = 360_000;

type State = 'idle' | 'arming' | 'recording' | 'processing';

interface ModeResult {
  enc: EncodedMessage;
  pcm: Int16Array;
  airtimeMs: number;
  encodeMs: number;
  decodeMs: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fmt(n: number, digits = 1) {
  return n.toLocaleString('he-IL', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function mountLoopback() {
  const settings = loadSettings();
  const modeSel = $<HTMLSelectElement>('mode');
  const autoplay = $<HTMLInputElement>('autoplay');
  const normalize = $<HTMLInputElement>('normalize');
  const ptt = $<HTMLButtonElement>('ptt');
  const label = $('ptt-label');
  const time = $('ptt-time');
  const ring = document.getElementById('ring') as unknown as SVGCircleElement;
  const levelBar = $('level-bar');
  const status = $('status');
  const results = $('results');

  modeSel.value = settings.mode;
  autoplay.checked = settings.autoplay;
  normalize.checked = settings.normalize;
  const persist = () => {
    settings.mode = modeSel.value as CodecModeName;
    settings.autoplay = autoplay.checked;
    settings.normalize = normalize.checked;
    saveSettings(settings);
    results.querySelectorAll<HTMLElement>('.mode').forEach((el) =>
      el.classList.toggle('selected', el.dataset.mode === settings.mode),
    );
  };
  modeSel.addEventListener('change', persist);
  autoplay.addEventListener('change', persist);
  normalize.addEventListener('change', persist);

  const codecReady = loadCodec2Browser();
  codecReady.catch((e) => setStatus(`שגיאה בטעינת הקודק: ${e}`, true));

  const recorder = new Recorder();
  let levelDecay = 0;
  recorder.onLevel = (peak) => {
    levelDecay = Math.max(peak, levelDecay * 0.7);
    levelBar.style.width = `${Math.min(100, levelDecay * 140)}%`;
  };

  const C = 2 * Math.PI * 46;
  ring.style.strokeDasharray = `${C}`;
  ring.style.strokeDashoffset = `${C}`;

  let state: State = 'idle';
  let held = false;
  let startedAt = 0;
  let raf = 0;
  let autoStop = 0;
  let counter = 0;

  function setStatus(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
  }

  function setUi(s: State) {
    state = s;
    ptt.classList.toggle('recording', s === 'recording');
    ptt.classList.toggle('busy', s === 'arming' || s === 'processing');
    if (s !== 'recording') ptt.classList.remove('cancel-armed');
    label.textContent =
      s === 'recording' ? 'מקליט… שחרר לסיום' : s === 'processing' ? 'מעבד…' : s === 'arming' ? 'רגע…' : 'החזק לדיבור';
    if (s !== 'recording') {
      cancelAnimationFrame(raf);
      ring.style.strokeDashoffset = `${C}`;
      time.textContent = '';
      levelBar.style.width = '0';
    }
  }

  function tick() {
    const elapsed = (performance.now() - startedAt) / 1000;
    const p = Math.min(1, elapsed / MAX_SECONDS);
    ring.style.strokeDashoffset = `${C * p}`;
    time.textContent = `${fmt(Math.max(0, MAX_SECONDS - elapsed))} ש׳`;
    raf = requestAnimationFrame(tick);
  }

  function micError(e: unknown) {
    const name = (e as { name?: string })?.name;
    if (!window.isSecureContext) setStatus('המיקרופון דורש HTTPS (או localhost).', true);
    else if (name === 'NotAllowedError') setStatus('אין הרשאה למיקרופון. אפשר אותה בהגדרות האתר ונסה שוב.', true);
    else if (name === 'NotFoundError') setStatus('לא נמצא מיקרופון.', true);
    else setStatus(`שגיאת מיקרופון: ${e}`, true);
  }

  async function begin() {
    held = true;
    unlockAudio();
    stopPlayback();
    if (state !== 'idle') return;
    if (!recorder.isReady) {
      setUi('arming');
      setStatus('מבקש גישה למיקרופון…');
      try {
        await recorder.ensureMic();
      } catch (e) {
        setUi('idle');
        micError(e);
        return;
      }
      if (!held) {
        // Released during the permission prompt.
        setUi('idle');
        setStatus('המיקרופון מוכן. החזק שוב כדי להקליט.');
        return;
      }
    }
    recorder.start(MAX_SECONDS);
    startedAt = performance.now();
    setUi('recording');
    setStatus('');
    raf = requestAnimationFrame(tick);
    autoStop = window.setTimeout(() => void finish(), MAX_SECONDS * 1000);
  }

  async function finish() {
    held = false;
    clearTimeout(autoStop);
    if (state !== 'recording') return;
    setUi('processing');
    try {
      const rec = await recorder.stop();
      const seconds = rec.samples.length / rec.sampleRate;
      if (seconds < MIN_SECONDS) {
        setUi('idle');
        setStatus('קצר מדי. החזק לפחות חצי שנייה.');
        return;
      }
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
        const parsed = enc.chunks.map((b) => decodeChunk(b));
        const pcm = decodeVoice(m, parsed);
        const t2 = performance.now();
        const airtimeMs = enc.chunks.reduce((a, b) => a + meshPacketAirtimeMs(b.length), 0);
        byMode[mode.name] = { enc, pcm, airtimeMs, encodeMs: t1 - t0, decodeMs: t2 - t1 };
      }
      counter++;
      renderResult(counter, seconds, rec.sampleRate, pcm8k, byMode);
      setUi('idle');
      setStatus('מוכן. אפשר להשוות בין המצבים למטה.');
      if (autoplay.checked) void playPcm(byMode[settings.mode].pcm, CODEC_SAMPLE_RATE);
    } catch (e) {
      setUi('idle');
      setStatus(`שגיאה: ${e}`, true);
    }
  }

  function cancel() {
    held = false;
    clearTimeout(autoStop);
    if (state === 'recording') {
      recorder.cancel();
      setUi('idle');
      setStatus('ההקלטה בוטלה.');
    }
  }

  attachPtt(ptt, {
    onStart: () => void begin(),
    onEnd: () => void finish(),
    onCancel: cancel,
    onCancelArmed: (armed) => {
      if (state !== 'recording') return;
      ptt.classList.toggle('cancel-armed', armed);
      label.textContent = armed ? 'שחרר כדי לבטל' : 'מקליט… שחרר לסיום';
    },
  });

  function renderResult(
    n: number,
    seconds: number,
    inRate: number,
    original: Int16Array,
    byMode: Record<CodecModeName, ModeResult>,
  ) {
    const card = document.createElement('article');
    card.className = 'card';
    const h = document.createElement('h2');
    h.textContent = `הקלטה ${n} · ${fmt(seconds)} ש׳`;
    const meta = document.createElement('p');
    meta.className = 'meta';
    meta.innerHTML = `דגימה: <span class="ltr">${inRate} Hz → 8000 Hz</span>`;
    const orig = playButton('▶ מקור, בלי קודק (<span class="ltr">8 kHz</span>)', original);
    const modes = document.createElement('div');
    modes.className = 'modes';
    for (const r of Object.values(byMode)) modes.append(modeBox(r));
    card.append(h, meta, orig, modes);
    // Newest first; keep a handful for comparison.
    results.prepend(card);
    while (results.children.length > 5) results.lastElementChild?.remove();
    results.hidden = false;
  }

  function modeBox(r: ModeResult): HTMLElement {
    const box = document.createElement('div');
    box.className = 'mode';
    box.dataset.mode = r.enc.mode.name;
    box.classList.toggle('selected', r.enc.mode.name === settings.mode);
    const title = document.createElement('strong');
    title.innerHTML = `<span class="ltr">Codec2 ${r.enc.mode.name}</span>`;
    const voiceBytes = r.enc.chunks.reduce((a, b) => a + b.length, 0);
    const sizes = r.enc.chunks.map((b) => b.length).join(' + ');
    const onAir = r.enc.chunks.map((b) => meshPacketOnAirBytes(b.length));
    const dl = document.createElement('dl');
    const rows: [string, string][] = [
      ['פריימים', `<span class="ltr">${r.enc.nFrames} × ${r.enc.bitsPerFrame} bit</span>`],
      ['מטען', `<span class="ltr">${voiceBytes} B (${sizes})</span>`],
      ['חבילות', `${r.enc.chunks.length} · <span class="ltr">${onAir.join(' + ')} / ${MAX_LORA_PAYLOAD_LEN} B</span> באוויר`],
      ['זמן שידור', `${fmt(r.airtimeMs / 1000)} ש׳ (ישיר, 0 קפיצות)`],
      ['בתקציב שעתי', `כ־${Math.floor(HOURLY_BUDGET_MS / r.airtimeMs)} הודעות כאלה`],
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

  if (!window.isSecureContext) setStatus('המיקרופון דורש HTTPS (או localhost).', true);
}
