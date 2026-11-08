/**
 * Push-to-talk input: hold the button (pointer) or the Space bar.
 * Sliding the pointer away from the button arms cancel; releasing there cancels.
 */
export interface PttHandlers {
  onStart(): void;
  onEnd(): void;
  onCancel(): void;
  onCancelArmed?(armed: boolean): void;
}

const CANCEL_MARGIN_PX = 48;

export function attachPtt(button: HTMLElement, h: PttHandlers): () => void {
  let active: 'pointer' | 'key' | null = null;
  let pointerId = -1;
  let armed = false;

  const setArmed = (v: boolean) => {
    if (v !== armed) {
      armed = v;
      h.onCancelArmed?.(v);
    }
  };

  const finish = (cancel: boolean) => {
    if (!active) return;
    active = null;
    setArmed(false);
    if (cancel) h.onCancel();
    else h.onEnd();
  };

  const outside = (e: PointerEvent) => {
    const r = button.getBoundingClientRect();
    return (
      e.clientX < r.left - CANCEL_MARGIN_PX ||
      e.clientX > r.right + CANCEL_MARGIN_PX ||
      e.clientY < r.top - CANCEL_MARGIN_PX ||
      e.clientY > r.bottom + CANCEL_MARGIN_PX
    );
  };

  const onDown = (e: PointerEvent) => {
    if (active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    active = 'pointer';
    pointerId = e.pointerId;
    button.setPointerCapture(e.pointerId);
    h.onStart();
  };
  const onMove = (e: PointerEvent) => {
    if (active === 'pointer' && e.pointerId === pointerId) setArmed(outside(e));
  };
  const onUp = (e: PointerEvent) => {
    if (active === 'pointer' && e.pointerId === pointerId) finish(outside(e));
  };
  const onPointerCancel = (e: PointerEvent) => {
    if (active === 'pointer' && e.pointerId === pointerId) finish(true);
  };

  const isTyping = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !isTyping(e.target)) {
      e.preventDefault();
      if (e.repeat || active) return;
      active = 'key';
      h.onStart();
    } else if (e.code === 'Escape' && active) {
      e.preventDefault();
      finish(true);
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space' && active === 'key') {
      e.preventDefault();
      finish(false);
    }
  };
  const onBlur = () => finish(true);
  const noMenu = (e: Event) => e.preventDefault();

  button.addEventListener('pointerdown', onDown);
  button.addEventListener('pointermove', onMove);
  button.addEventListener('pointerup', onUp);
  button.addEventListener('pointercancel', onPointerCancel);
  button.addEventListener('contextmenu', noMenu);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return () => {
    button.removeEventListener('pointerdown', onDown);
    button.removeEventListener('pointermove', onMove);
    button.removeEventListener('pointerup', onUp);
    button.removeEventListener('pointercancel', onPointerCancel);
    button.removeEventListener('contextmenu', noMenu);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
