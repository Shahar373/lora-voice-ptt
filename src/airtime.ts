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

/**
 * Meshtastic LONG_MODERATE: SF11 / BW125 / CR4/8.
 * Preamble 16 verified in firmware v2.7.26 (RadioInterface.h `preambleLength = 16`).
 * LDRO is on because Tsym (16.384 ms) > 16 ms.
 */
export const LONG_MODERATE: LoraParams = {
  sf: 11,
  bw: 125_000,
  crDenom: 8,
  preamble: 16,
  explicitHeader: true,
  crc: true,
  ldro: true,
};

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
export function timeOnAirMs(payloadBytes: number, p: LoraParams = LONG_MODERATE): number {
  const tsym = symbolTimeMs(p);
  const preamble = (p.preamble + 4.25) * tsym;
  return preamble + payloadSymbols(payloadBytes, p) * tsym;
}

// ---------------------------------------------------------------------------
// Meshtastic framing (firmware 2.7.x)
// ---------------------------------------------------------------------------

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
export function meshDataProtobufLen(appPayloadLen: number, portnum = 256): number {
  return 1 + varintLen(portnum) + 1 + varintLen(appPayloadLen) + appPayloadLen + 2;
}

/** Bytes on air for one Meshtastic packet carrying `appPayloadLen` application bytes. */
export function meshPacketOnAirBytes(appPayloadLen: number, portnum = 256): number {
  return MESHTASTIC_HEADER_LEN + meshDataProtobufLen(appPayloadLen, portnum);
}

/**
 * Largest application payload the firmware will accept on a channel packet.
 * perhapsEncode() rejects `encodedData + 16 > 255` with TOO_LARGE, so although
 * Constants.DATA_PAYLOAD_LEN is 233, the real limit for portnum 256 is 231.
 */
export function maxAppPayload(portnum = 256): number {
  let n = MAX_LORA_PAYLOAD_LEN;
  while (n > 0 && meshPacketOnAirBytes(n, portnum) > MAX_LORA_PAYLOAD_LEN) n--;
  return n;
}

/** Airtime (ms) of one Meshtastic packet with `appPayloadLen` application bytes. */
export function meshPacketAirtimeMs(
  appPayloadLen: number,
  p: LoraParams = LONG_MODERATE,
  portnum = 256,
): number {
  return timeOnAirMs(meshPacketOnAirBytes(appPayloadLen, portnum), p);
}
