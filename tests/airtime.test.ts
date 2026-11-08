import { describe, expect, it } from 'vitest';
import {
  LONG_MODERATE,
  maxAppPayload,
  meshDataProtobufLen,
  meshPacketOnAirBytes,
  payloadSymbols,
  symbolTimeMs,
  timeOnAirMs,
} from '../src/airtime';

// Fuller verification against reference calculators is milestone 2.
describe('airtime (LONG_MODERATE)', () => {
  it('symbol time is 16.384 ms', () => {
    expect(symbolTimeMs(LONG_MODERATE)).toBeCloseTo(16.384, 6);
  });

  it('255-byte frame is ~484 symbols / ~7.93 s', () => {
    // ceil((2040 - 44 + 28 + 16) / 36) = 57 -> 57 * 8 + 8 = 464 payload symbols
    expect(payloadSymbols(255, LONG_MODERATE)).toBe(464);
    expect(timeOnAirMs(255)).toBeCloseTo((16 + 4.25 + 464) * 16.384, 6);
    expect(timeOnAirMs(255) / 1000).toBeCloseTo(7.934, 2);
  });

  it('is monotonic in payload size', () => {
    let prev = 0;
    for (let n = 0; n <= 255; n++) {
      const t = timeOnAirMs(n);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});

describe('meshtastic framing', () => {
  it('Data protobuf overhead for portnum 256', () => {
    expect(meshDataProtobufLen(100)).toBe(3 + 2 + 100 + 2);
    expect(meshDataProtobufLen(200)).toBe(3 + 3 + 200 + 2);
  });

  it('max app payload is 231 (255 - 16 header - 8 protobuf)', () => {
    expect(maxAppPayload()).toBe(231);
    expect(meshPacketOnAirBytes(231)).toBe(255);
    expect(meshPacketOnAirBytes(232)).toBeGreaterThan(255);
  });
});
