# LoRa Voice PTT — Project Spec

Voice-message "walkie-talkie" over a private Meshtastic LoRa mesh. Android phones and a Windows laptop are the audio endpoints, and LilyGO T-Echo nodes are the modems, connected over Bluetooth (phones) or USB serial (laptop).

This document captures decisions already made with the user. Do not re-litigate them; where something below is marked **VERIFY**, check it against current upstream docs/code before relying on it.

---

## 1. Context

### Hardware
- 3× LilyGO **T-Echo** (nRF52840 + SX1262, **868 MHz** hardware variant), stock antennas.
- Firmware: Meshtastic **2.7.26** (`t-echo-inkhud` build). Bootloader: Meshtastic nRF52 Bootloader 2.6.0 (S140 6.1.1).
- T-Echo has **no audio hardware** (no mic, speaker, or I2S codec). All audio work happens on the phone or computer.
- Endpoints:
  - **Android phones, Chrome**, connected to a T-Echo over **Web Bluetooth**.
  - **Windows laptop, Chrome (desktop)**, connected to a T-Echo over **USB via Web Serial** (preferred: more stable than BLE, no pairing) or over Web Bluetooth as a fallback. The laptop typically hosts node A as the home "base station".
  - No iPhone support needed.

### Mesh configuration (already applied to all 3 nodes)
| Setting | Value |
|---|---|
| Region | `EU_868` (10% duty cycle enforced by firmware) |
| Modem preset | `LONG_MODERATE` (SF11, BW 125 kHz, CR 4/8, ~340 bps) |
| TX power | 22 dBm |
| Primary channel | `SHMESH`, private random PSK |
| Hop limit | 3 (device default) |

### Nodes
| Label | Node ID | Role |
|---|---|---|
| A | `!74412a6e` | Admin / home base (remote-admins B and C via PKI `admin_key`) |
| B | `!516e0640` | Field unit |
| C | `!65d836d6` | Field unit / candidate relay (may become `ROUTER` on a high point) |

**Secrets:** never commit the channel URL, PSK, or any private keys. Node IDs and public keys are fine.

---

## 2. Goal

A single web app (PWA) that runs in Chrome on Android **and** on a Windows laptop, connects to a T-Echo over **Web Bluetooth or Web Serial (USB)**, and lets the user:

1. **Hold a big button** to record (max 8 s), release to send.
2. **Receive** voice messages from other nodes and **auto-play** them when complete.
3. See link quality, connection state, and the **remaining duty-cycle budget**.

This is explicitly **voice messages with ~15–20 s end-to-end latency**, not real-time streaming PTT. The user accepted this trade-off in exchange for range.

---

## 3. RF budget (drives every design decision)

LongModerate: SF11, BW125, CR4/8, Low Data Rate Optimize ON, explicit header, CRC on, preamble 16 symbols (**VERIFY** Meshtastic preamble length).

- Symbol time: 2^11 / 125000 = **16.384 ms**
- Full packet (≈255 B on air) ≈ **484 symbols ≈ 7.9 s airtime**
- EU_868 duty cycle 10% → **360 s TX per rolling hour** (firmware enforces; app must track its own estimate)

Implement the standard Semtech LoRa time-on-air formula in `src/airtime.ts` and use it everywhere (budget meter, send gating, UI estimates). Do not hard-code the 7.9 s figure.

With Codec2 450 and tight bit-packing, an 8 s message ≈ 450 B ≈ 2 packets ≈ ~16 s airtime → ~22 messages/hour.

---

## 4. Architecture

```
[mic] getUserMedia → AudioWorklet → resample 48k→8k (with LPF) → int16 PCM
   → Codec2 (WASM) encode → bit-pack frames → split into chunks
   → @meshtastic JS → [Web Bluetooth | Web Serial] → T-Echo → LoRa (PRIVATE_APP, port 256)

LoRa → T-Echo → [BLE | USB] → onMeshPacket (port 256) → reassemble by (from, msg_id)
   → unpack → Codec2 decode → 8k PCM → resample → AudioContext playback
```

### Stack
- **Vite + TypeScript**, no UI framework (or a very light one). Keep the bundle small.
- **Meshtastic JS client**: the official packages. Historically `@meshtastic/js`; it has been split into `@meshtastic/core` + transport packages (`@meshtastic/transport-web-bluetooth`, `@meshtastic/transport-web-serial`). **VERIFY** current package names and the event API for receiving packets on a specific portnum.
- **Transport abstraction**: everything above the transport (codec, protocol, reassembly, UI) must be transport-agnostic. Pick the transport at connect time; no other code path should know which one is active.
  - Feature-detect `navigator.bluetooth` and `navigator.serial` and only show the options the browser supports (Android Chrome: Bluetooth only; desktop Chrome: both).
  - Web Serial: Meshtastic serial API on the T-Echo's USB CDC port. **VERIFY** baud rate / framing handled by the transport package. The node's `security.serial_enabled` is already true.
- **Codec2 → WebAssembly** via Emscripten, built from the upstream `drowe67/codec2` source. Expose a thin C wrapper (`create(mode)`, `encode`, `decode`, `bits_per_frame`, `samples_per_frame`, `destroy`).
  - Preferred mode: **`CODEC2_MODE_450`** (8 kHz in/out). **VERIFY** it exists and works in the upstream version you build; fall back to **`700C`** if not.
  - Commit the built `.wasm` + glue so the Pages build doesn't need Emscripten in CI (or build it in a separate CI job — your call, document it).

---

## 5. Wire protocol (PRIVATE_APP payload, portnum 256)

Meshtastic max data payload is **233 bytes** (**VERIFY** `DATA_PAYLOAD_LEN` for 2.7.x). Every byte costs ~31 ms of airtime here, so keep the header tight.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `ver_mode` | high nibble = protocol version (1), low nibble = codec mode id (0 = 450, 1 = 700C) |
| 1 | 2 | `msg_id` | uint16 LE, random per message |
| 3 | 1 | `seq_total` | high nibble = seq (0-based), low nibble = total chunks (1–15) |
| 4 | 1 | `n_frames` | number of Codec2 frames in this chunk |
| 5 | … | `frames` | Codec2 frames **bit-packed tightly** (no per-frame byte padding) |

- Frames never span chunks; each chunk is independently decodable.
- `bits_per_frame` comes from the codec at runtime, not hard-coded.
- Unit-test pack/unpack round-trips, including odd bit counts and the last partial byte.

### Sending
- Broadcast on channel 0 (encrypted with the channel PSK). `wantAck = false`.
- Hop limit is a **user setting**: default **0** (direct only); set to **1** when C is deployed as a relay. Each hop costs a full extra airtime on the channel.
- Send chunks back-to-back and let the firmware queue them. Show per-chunk progress.
- **Gate sending** on the app's own rolling-hour airtime estimate. If a message would exceed the budget, block it and show when it will be available.

### Receiving
- Reassemble keyed by `(from, msg_id)`. Timeout: **120 s** after the last chunk.
- Complete → auto-play once, then keep it in history for replay.
- Timeout with missing chunks → play what arrived with silence for the gaps, and mark the message as partial.
- Record RSSI/SNR per received chunk and show them on the message.

v1 has **no retransmission**. A selective "resend chunk N" request is a possible v2, but it costs scarce airtime, so it should be a deliberate later decision.

---

## 6. UI (Hebrew, RTL)

- Connection screen: two buttons, **"Bluetooth"** and **"USB"**, shown only when supported (both `requestDevice` and `requestPort` need a user gesture). Remember the last choice. Show the connected node name and a battery readout if available.
- Layout must work on both a phone (portrait, thumb-sized PTT) and a laptop. On desktop, also allow **holding the Space bar** as PTT.
- Main screen:
  - **Huge PTT button** (pointer events: hold = record, release = send; slide away = cancel). Countdown ring for the 8 s limit.
  - Duty-cycle meter: airtime used / 360 s in the last hour, plus the number of 8 s messages left.
  - Message list: sender, duration, time, RSSI/SNR, complete/partial, replay.
  - Settings: codec mode, hop limit, auto-play on/off.
- Must work **offline after first load** (service worker + manifest). Field use will often have no internet.

---

## 7. Hosting

- **GitHub Pages** via GitHub Actions (Web Bluetooth requires HTTPS).
- Single repo, `main` → deploy.

---

## 8. Known constraints / gotchas

- **One client per node**: the official Meshtastic app, client.meshtastic.org, or the Python CLI must be disconnected/closed while this app is using that node (BLE or USB). Show a hint if the connection fails ("port busy" on serial is the typical symptom on Windows).
- The nodes use Bluetooth `RANDOM_PIN` pairing: the PIN appears on the T-Echo e-ink screen during pairing.
- Android may throttle background tabs. Keep the screen on while the app is active (Wake Lock API).
- AudioContext needs a user gesture to start; unlock it on the first tap.
- Do not change node config from the app (region, preset, admin). That stays with the CLI and remote admin from node A.

---

## 9. Milestones

1. **Codec loopback, no radio**: record → encode → pack → unpack → decode → play in the browser. Confirm intelligibility at 450 and 700C.
2. **Unit tests**: airtime formula against known values, and pack/unpack.
3. **Connect**: first **USB / Web Serial on the laptop** (easiest to debug), then **BLE on a phone**. Show node info and receive a plain text message on each.
4. **Send/receive voice**: laptop (node A over USB) ↔ phone (node B over BLE), then phone ↔ phone. Keep the nodes ≥3 m apart; at 22 dBm close range saturates receivers.
5. **Budget meter + gating.**
6. **PWA offline + Pages deploy.**
7. **Field test** with the user (range, partial-message behavior, relay via C).

At each milestone, stop and tell the user exactly what to test on the phone.
