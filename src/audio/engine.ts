/**
 * Shared AudioContext. Browsers only let it start from a user gesture, so
 * call unlockAudio() from the first pointerdown / keydown.
 */
let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

export function unlockAudio(): void {
  const c = audioContext();
  if (c.state === 'suspended') void c.resume();
}
