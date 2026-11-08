import { describe, expect, it } from 'vitest';
import { MAX_TEXT_BYTES, splitText, utf8Length } from '../src/protocol/text';

describe('text messages', () => {
  it('limit is 232 bytes on firmware 2.7.x', () => {
    expect(MAX_TEXT_BYTES).toBe(232);
  });

  it('counts Hebrew as 2 bytes per letter', () => {
    expect(utf8Length('שלום')).toBe(8);
    expect(utf8Length('שלום 123')).toBe(12);
  });

  it('keeps a short message whole and normalises whitespace', () => {
    expect(splitText('  אני   בדרך,  מגיע בעוד 10 דקות ')).toEqual(['אני בדרך, מגיע בעוד 10 דקות']);
    expect(splitText('   ')).toEqual([]);
  });

  it('splits long Hebrew text on word boundaries with k/n prefixes', () => {
    const words = Array.from({ length: 60 }, (_, i) => `מילה${i}`);
    const parts = splitText(words.join(' '));
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) => {
      expect(utf8Length(p)).toBeLessThanOrEqual(232);
      expect(p.startsWith(`${i + 1}/${parts.length} `)).toBe(true);
    });
    const rejoined = parts.map((p) => p.replace(/^\d+\/\d+ /, '')).join(' ');
    expect(rejoined).toBe(words.join(' '));
  });

  it('hard-splits a single overlong word without breaking characters', () => {
    const word = 'א'.repeat(300);
    const parts = splitText(word, 50);
    for (const p of parts) expect(utf8Length(p)).toBeLessThanOrEqual(50);
    expect(parts.map((p) => p.replace(/^\d+\/\d+ /, '')).join('')).toBe(word);
  });
});
