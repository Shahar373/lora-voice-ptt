import { describe, expect, it } from 'vitest';
import {
  MODEM_PRESET_NAMES,
  PORTNUM_PRIVATE_APP,
  PORTNUM_TEXT_MESSAGE,
  maxAppPayload,
  meshDataProtobufLen,
  meshPacketAirtimeMs,
  meshPacketOnAirBytes,
  payloadSymbols,
  presetParams,
  symbolTimeMs,
  timeOnAirMs,
} from '../src/airtime';

const LM = presetParams('LONG_MODERATE');

// Fuller verification against reference calculators is milestone 2.
describe('airtime (LONG_MODERATE)', () => {
  it('symbol time is 16.384 ms, LDRO on', () => {
    expect(symbolTimeMs(LM)).toBeCloseTo(16.384, 6);
    expect(LM.ldro).toBe(true);
  });

  it('255-byte frame is ~484 symbols / ~7.93 s', () => {
    // ceil((2040 - 44 + 28 + 16) / 36) = 57 -> 57 * 8 + 8 = 464 payload symbols
    expect(payloadSymbols(255, LM)).toBe(464);
    expect(timeOnAirMs(255, LM)).toBeCloseTo((16 + 4.25 + 464) * 16.384, 6);
    expect(timeOnAirMs(255, LM) / 1000).toBeCloseTo(7.934, 2);
  });

  it('is monotonic in payload size for every preset', () => {
    for (const name of MODEM_PRESET_NAMES) {
      const p = presetParams(name);
      let prev = 0;
      for (let n = 0; n <= 255; n++) {
        const t = timeOnAirMs(n, p);
        expect(t).toBeGreaterThanOrEqual(prev);
        prev = t;
      }
    }
  });
});

describe('presets (firmware v2.7.26 MeshRadio.h)', () => {
  it('LONG_FAST: SF11 / 250 kHz / 4/5, LDRO off (8.192 ms symbols)', () => {
    const p = presetParams('LONG_FAST');
    expect([p.sf, p.bw, p.crDenom, p.ldro]).toEqual([11, 250_000, 5, false]);
    expect(symbolTimeMs(p)).toBeCloseTo(8.192, 6);
  });

  it('LONG_SLOW: SF12 / 125 kHz / 4/8, LDRO on (32.768 ms symbols)', () => {
    const p = presetParams('LONG_SLOW');
    expect([p.sf, p.bw, p.crDenom, p.ldro]).toEqual([12, 125_000, 8, true]);
    expect(symbolTimeMs(p)).toBeCloseTo(32.768, 6);
  });

  it('slower presets cost more airtime for the same packet', () => {
    const t = (n: Parameters<typeof presetParams>[0]) => timeOnAirMs(60, presetParams(n));
    expect(t('SHORT_TURBO')).toBeLessThan(t('LONG_FAST'));
    expect(t('LONG_FAST')).toBeLessThan(t('LONG_MODERATE'));
    expect(t('LONG_MODERATE')).toBeLessThan(t('LONG_SLOW'));
  });
});

describe('meshtastic framing', () => {
  it('Data protobuf overhead for portnum 256', () => {
    expect(meshDataProtobufLen(100, PORTNUM_PRIVATE_APP)).toBe(3 + 2 + 100 + 2);
    expect(meshDataProtobufLen(200, PORTNUM_PRIVATE_APP)).toBe(3 + 3 + 200 + 2);
  });

  it('Data protobuf overhead for portnum 1 (text)', () => {
    expect(meshDataProtobufLen(45, PORTNUM_TEXT_MESSAGE)).toBe(2 + 2 + 45 + 2);
  });

  it('max app payload: 231 for voice (portnum 256), 232 for text (portnum 1)', () => {
    expect(maxAppPayload(PORTNUM_PRIVATE_APP)).toBe(231);
    expect(meshPacketOnAirBytes(231, PORTNUM_PRIVATE_APP)).toBe(255);
    expect(meshPacketOnAirBytes(232, PORTNUM_PRIVATE_APP)).toBeGreaterThan(255);
    expect(maxAppPayload(PORTNUM_TEXT_MESSAGE)).toBe(232);
    expect(meshPacketOnAirBytes(232, PORTNUM_TEXT_MESSAGE)).toBe(255);
  });

  it('a 45-byte text message is far cheaper than an 8 s Codec2 450 message', () => {
    for (const name of ['LONG_FAST', 'LONG_MODERATE', 'LONG_SLOW'] as const) {
      const p = presetParams(name);
      const text = meshPacketAirtimeMs(45, p, PORTNUM_TEXT_MESSAGE);
      const voice = 2 * meshPacketAirtimeMs(230, p, PORTNUM_PRIVATE_APP);
      expect(text * 3).toBeLessThan(voice);
    }
  });
});
