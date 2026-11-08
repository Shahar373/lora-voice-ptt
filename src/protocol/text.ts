/**
 * Text messages (TEXT_MESSAGE_APP, portnum 1). Hebrew is 2 bytes per letter in
 * UTF-8, so the byte budget, not the character count, is what matters.
 */
import { PORTNUM_TEXT_MESSAGE, maxAppPayload } from '../airtime';

/** 232 bytes on firmware 2.7.x (see airtime.ts). */
export const MAX_TEXT_BYTES = maxAppPayload(PORTNUM_TEXT_MESSAGE);

const enc = new TextEncoder();

export function utf8Length(s: string): number {
  return enc.encode(s).length;
}

/**
 * Split text into messages of at most `maxBytes` UTF-8 bytes, on word
 * boundaries where possible. When more than one part is needed each part is
 * prefixed "k/n " so receivers (including the official app / e-ink screen)
 * can tell the order.
 */
export function splitText(text: string, maxBytes = MAX_TEXT_BYTES): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (utf8Length(clean) <= maxBytes) return [clean];
  // Reserve room for the "k/n " prefix (n <= 99 is plenty).
  for (let reserve = 4; reserve <= 6; reserve++) {
    const parts = pack(clean, maxBytes - reserve);
    const n = parts.length;
    const withPrefix = parts.map((p, i) => `${i + 1}/${n} ${p}`);
    if (withPrefix.every((p) => utf8Length(p) <= maxBytes)) return withPrefix;
  }
  throw new Error('text too long to split');
}

function pack(text: string, budget: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const candidate = cur ? `${cur} ${word}` : word;
    if (utf8Length(candidate) <= budget) {
      cur = candidate;
      continue;
    }
    if (cur) out.push(cur);
    cur = '';
    if (utf8Length(word) <= budget) {
      cur = word;
    } else {
      // A single word longer than the budget: hard-split on code points.
      let piece = '';
      for (const ch of word) {
        if (utf8Length(piece + ch) > budget) {
          out.push(piece);
          piece = '';
        }
        piece += ch;
      }
      cur = piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}
