/**
 * Push-to-talk recording controller shared by every page: mic acquisition,
 * hold-to-record (pointer or Space), countdown ring, slide-away / Esc cancel,
 * max-duration auto-stop. Hands the finished recording to `onRecording`.
 */
import { unlockAudio } from '../audio/engine';
import { stopPlayback } from '../audio/player';
import { Recorder, type Recording } from '../audio/recorder';
import { attachPtt } from './ptt';

export type PttState = 'idle' | 'arming' | 'recording' | 'processing' | 'disabled';

export interface PttRecorderOptions {
  root: HTMLElement; // container holding the elements below (by class)
  maxSeconds: number;
  minSeconds?: number;
  setStatus: (text: string, error?: boolean) => void;
  onRecording: (rec: Recording) => Promise<void>;
  idleLabel?: string;
  processingLabel?: string;
}

const RING_R = 46;

export function pttMarkup(idleLabel = 'החזק לדיבור'): string {
  return `
    <button class="ptt" type="button" aria-label="החזק כדי להקליט">
      <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="ring-bg" cx="50" cy="50" r="${RING_R}" />
        <circle class="ring-fg" cx="50" cy="50" r="${RING_R}" />
      </svg>
      <span class="ptt-label">${idleLabel}</span>
      <span class="ptt-time"></span>
    </button>
    <div class="level" aria-hidden="true"><div class="level-bar"></div></div>`;
}

export class PttRecorder {
  private readonly o: Required<Omit<PttRecorderOptions, 'root'>> & { root: HTMLElement };
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLElement;
  private readonly time: HTMLElement;
  private readonly ring: SVGCircleElement;
  private readonly levelBar: HTMLElement;
  private readonly recorder = new Recorder();
  private readonly C = 2 * Math.PI * RING_R;
  private state: PttState = 'idle';
  private held = false;
  private startedAt = 0;
  private raf = 0;
  private autoStop = 0;
  private levelDecay = 0;

  constructor(opts: PttRecorderOptions) {
    this.o = {
      minSeconds: 0.4,
      idleLabel: 'החזק לדיבור',
      processingLabel: 'מעבד…',
      ...opts,
    };
    const q = <T extends Element>(sel: string) => {
      const el = opts.root.querySelector<T>(sel);
      if (!el) throw new Error(`missing ${sel}`);
      return el;
    };
    this.button = q<HTMLButtonElement>('.ptt');
    this.label = q<HTMLElement>('.ptt-label');
    this.time = q<HTMLElement>('.ptt-time');
    this.ring = q<SVGCircleElement>('.ring-fg');
    this.levelBar = q<HTMLElement>('.level-bar');
    this.ring.style.strokeDasharray = `${this.C}`;
    this.ring.style.strokeDashoffset = `${this.C}`;
    this.recorder.onLevel = (peak) => {
      this.levelDecay = Math.max(peak, this.levelDecay * 0.7);
      this.levelBar.style.width = `${Math.min(100, this.levelDecay * 140)}%`;
    };
    attachPtt(this.button, {
      onStart: () => void this.begin(),
      onEnd: () => void this.finish(),
      onCancel: () => this.cancel(),
      onCancelArmed: (armed) => {
        if (this.state !== 'recording') return;
        this.button.classList.toggle('cancel-armed', armed);
        this.label.textContent = armed ? 'שחרר כדי לבטל' : 'מקליט… שחרר לסיום';
      },
    });
    if (!window.isSecureContext) this.o.setStatus('המיקרופון דורש HTTPS (או localhost).', true);
  }

  /** Disable while e.g. no model is loaded. */
  setEnabled(enabled: boolean, label?: string) {
    if (!enabled) {
      if (this.state === 'recording') this.cancel();
      this.setUi('disabled');
      if (label) this.label.textContent = label;
    } else if (this.state === 'disabled') {
      this.setUi('idle');
    }
  }

  private setUi(s: PttState) {
    this.state = s;
    const b = this.button;
    b.classList.toggle('recording', s === 'recording');
    b.classList.toggle('busy', s === 'arming' || s === 'processing' || s === 'disabled');
    b.setAttribute('aria-disabled', String(s === 'disabled'));
    if (s !== 'recording') b.classList.remove('cancel-armed');
    this.label.textContent =
      s === 'recording'
        ? 'מקליט… שחרר לסיום'
        : s === 'processing'
          ? this.o.processingLabel
          : s === 'arming'
            ? 'רגע…'
            : this.o.idleLabel;
    if (s !== 'recording') {
      cancelAnimationFrame(this.raf);
      this.ring.style.strokeDashoffset = `${this.C}`;
      this.time.textContent = '';
      this.levelBar.style.width = '0';
    }
  }

  private tick = () => {
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const p = Math.min(1, elapsed / this.o.maxSeconds);
    this.ring.style.strokeDashoffset = `${this.C * p}`;
    this.time.textContent = `${Math.max(0, this.o.maxSeconds - elapsed).toFixed(1)} ש׳`;
    this.raf = requestAnimationFrame(this.tick);
  };

  private micError(e: unknown) {
    const name = (e as { name?: string })?.name;
    if (!window.isSecureContext) this.o.setStatus('המיקרופון דורש HTTPS (או localhost).', true);
    else if (name === 'NotAllowedError') this.o.setStatus('אין הרשאה למיקרופון. אפשר אותה בהגדרות האתר ונסה שוב.', true);
    else if (name === 'NotFoundError') this.o.setStatus('לא נמצא מיקרופון.', true);
    else this.o.setStatus(`שגיאת מיקרופון: ${e}`, true);
  }

  private async begin() {
    this.held = true;
    unlockAudio();
    stopPlayback();
    if (this.state !== 'idle') return;
    if (!this.recorder.isReady) {
      this.setUi('arming');
      this.o.setStatus('מבקש גישה למיקרופון…');
      try {
        await this.recorder.ensureMic();
      } catch (e) {
        this.setUi('idle');
        this.micError(e);
        return;
      }
      if (!this.held) {
        this.setUi('idle');
        this.o.setStatus('המיקרופון מוכן. החזק שוב כדי להקליט.');
        return;
      }
    }
    this.recorder.start(this.o.maxSeconds);
    this.startedAt = performance.now();
    this.setUi('recording');
    this.o.setStatus('');
    this.raf = requestAnimationFrame(this.tick);
    this.autoStop = window.setTimeout(() => void this.finish(), this.o.maxSeconds * 1000);
  }

  private async finish() {
    this.held = false;
    clearTimeout(this.autoStop);
    if (this.state !== 'recording') return;
    this.setUi('processing');
    try {
      const rec = await this.recorder.stop();
      if (rec.samples.length / rec.sampleRate < this.o.minSeconds) {
        this.o.setStatus('קצר מדי. החזק לפחות חצי שנייה.');
        return;
      }
      await this.o.onRecording(rec);
    } catch (e) {
      this.o.setStatus(`שגיאה: ${e instanceof Error ? e.message : e}`, true);
    } finally {
      if ((this.state as PttState) === 'processing') this.setUi('idle');
    }
  }

  private cancel() {
    this.held = false;
    clearTimeout(this.autoStop);
    if (this.state === 'recording') {
      this.recorder.cancel();
      this.setUi('idle');
      this.o.setStatus('ההקלטה בוטלה.');
    }
  }
}
