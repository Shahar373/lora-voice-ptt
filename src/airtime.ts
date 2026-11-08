/**
 * LoRa time-on-air (Semtech SX1261/2 datasheet / AN1200.13 formula) and the
 * Meshtastic framing overhead that sits around our application payload.
 *
 * Use these functions everywhere airtime matters (budget meter, send gating,
 * UI estimates). Never hard-code per-packet airtime.
 */

export interface LoraParams {
  /** Spreading factor 7..12 */
  sf: number;
  /** Bandwidth in Hz */
  bw: number;
  /** Coding rate denominator: 5..8 for 4/5..4/8 */
  crDenom: number;
  /** Preamble length in symbols (programmed value, excluding the 4.25 sync symbols) */
  preamble: number;
  /** Explicit header (true for Meshtastic) */
  explicitHeader: boolean;
  /** Payload CRC enabled */
  crc: boolean;
  /** Low data rate optimisation */
  ldro: boolean;
}

/** Meshtastic modem presets (firmware v2.7.26, MeshRadio.h modemPresetToParams). */
export type ModemPresetName =
  | 'SHORT_TURBO'
  | 'SHORT_FAST'
  | 'SHORT_SLOW'
  | 'MEDIUM_FAST'
  | 'MEDIUM_SLOW'
  | 'LONG_TURBO'
  | 'LONG_FAST'
  | 'LONG_MODERATE'
  | 'LONG_SLOW';

const PRESET_TABLE: Record<ModemPresetName, { sf: number; bwKHz: number; crDenom: number }> = {
  SHORT_TURBO: { sf: 7, bwKHz: 500, crDenom: 5 },
  SHORT_FAST: { sf: 7, bwKHz: 250, crDenom: 5 },
  SHORT_SLOW: { sf: 8, bwKHz: 250, crDenom: 5 },
  MEDIUM_FAST: { sf: 9, bwKHz: 250, crDenom: 5 },
  MEDIUM_SLOW: { sf: 10, bwKHz: 250, crDenom: 5 },
  LONG_TURBO: { sf: 11, bwKHz: 500, crDenom: 8 },
  LONG_FAST: { sf: 11, bwKHz: 250, crDenom: 5 },
  LONG_MODERATE: { sf: 11, bwKHz: 125, crDenom: 8 },
  LONG_SLOW: { sf: 12, bwKHz: 125, crDenom: 8 },
};

export const MODEM_PRESET_NAMES = Object.keys(PRESET_TABLE) as ModemPresetName[];

/** Meshtastic preamble length (RadioInterface.h `preambleLength = 16`, verified in v2.7.26). */
export const MESHTASTIC_PREAMBLE = 16;

/**
 * LoRa parameters for a Meshtastic preset. LDRO follows the firmware's auto rule
 * (RadioLibInterface.h: enabled when symbol time >= 16 ms).
 */
export function presetParams(name: ModemPresetName): LoraParams {
  const t = PRESET_TABLE[name];
  return {
    sf: t.sf,
    bw: t.bwKHz * 1000,
    crDenom: t.crDenom,
    preamble: MESHTASTIC_PREAMBLE,
    explicitHeader: true,
    crc: true,
    ldro: 2 ** t.sf / t.bwKHz >= 16,
  };
}

export function symbolTimeMs(p: LoraParams): number {
  return (2 ** p.sf / p.bw) * 1000;
}

/** Number of payload symbols (incl. the 8 fixed header symbols). */
export function payloadSymbols(payloadBytes: number, p: LoraParams): number {
  const ih = p.explicitHeader ? 0 : 1;
  const de = p.ldro ? 1 : 0;
  const crc = p.crc ? 1 : 0;
  const cr = p.crDenom - 4;
  const num = 8 * payloadBytes - 4 * p.sf + 28 + 16 * crc - 20 * ih;
  const den = 4 * (p.sf - 2 * de);
  return 8 + Math.max(Math.ceil(num / den) * (cr + 4), 0);
}

/** Total time on air in milliseconds for a LoRa frame of `payloadBytes` PHY payload bytes. */
export function timeOnAirMs(payloadBytes: number, p: LoraParams): number {
  const tsym = symbolTimeMs(p);
  const preamble = (p.preamble + 4.25) * tsym;
  return preamble + payloadSymbols(payloadBytes, p) * tsym;
}

// ---------------------------------------------------------------------------
// Meshtastic framing (firmware 2.7.x)
// ---------------------------------------------------------------------------

export const PORTNUM_TEXT_MESSAGE = 1;
export const PORTNUM_PRIVATE_APP = 256;

/** Max LoRa PHY payload (RadioInterface.h MAX_LORA_PAYLOAD_LEN). */
export const MAX_LORA_PAYLOAD_LEN = 255;
/** Unencrypted Meshtastic packet header (PacketHeader). */
export const MESHTASTIC_HEADER_LEN = 16;

function varintLen(v: number): number {
  let n = 1;
  while (v >= 0x80) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

/**
 * Encoded size of the `Data` protobuf the firmware builds for our packet:
 *   portnum (field 1, varint 256)      -> 1 + 2 bytes
 *   payload (field 2, bytes)           -> 1 + varint(len) + len
 *   bitfield (field 9, uint32, 0..3)   -> 1 + 1 bytes
 * The firmware always sets `has_bitfield` on packets it originates
 * (Router.cpp perhapsEncode), so those 2 bytes are always on air.
 * AES-CTR channel encryption does not change the length.
 */
export function meshDataProtobufLen(appPayloadLen: number, portnum: number): number {
  return 1 + varintLen(portnum) + 1 + varintLen(appPayloadLen) + appPayloadLen + 2;
}

/** Bytes on air for one Meshtastic packet carrying `appPayloadLen` application bytes. */
export function meshPacketOnAirBytes(appPayloadLen: number, portnum: number): number {
  return MESHTASTIC_HEADER_LEN + meshDataProtobufLen(appPayloadLen, portnum);
}

/**
 * Largest application payload the firmware will accept on a channel packet.
 * perhapsEncode() rejects `encodedData + 16 > 255` with TOO_LARGE, so although
 * Constants.DATA_PAYLOAD_LEN is 233, the real limit is 231 for portnum 256
 * (voice) and 232 for portnum 1 (TEXT_MESSAGE_APP).
 */
export function maxAppPayload(portnum: number): number {
  let n = MAX_LORA_PAYLOAD_LEN;
  while (n > 0 && meshPacketOnAirBytes(n, portnum) > MAX_LORA_PAYLOAD_LEN) n--;
  return n;
}

/** Airtime (ms) of one Meshtastic packet with `appPayloadLen` application bytes. */
export function meshPacketAirtimeMs(appPayloadLen: number, p: LoraParams, portnum: number): number {
  return timeOnAirMs(meshPacketOnAirBytes(appPayloadLen, portnum), p);
}
