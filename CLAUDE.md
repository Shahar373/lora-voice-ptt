# LoRa Voice PTT — Project Spec

Push-to-talk messaging over a private Meshtastic LoRa mesh. Android phones and a Windows laptop are the endpoints (mic, speaker, all processing), and LilyGO T-Echo nodes are the modems, connected over Bluetooth (phones) or USB serial (laptop).

The app has **two modes**:
1. **"דיבור לטקסט" (Speech-to-Text) — primary.** The sender's device transcribes speech with Whisper running in the browser (fully offline), sends a short **text message** (usually one packet), and the receiver reads it aloud with TTS.
2. **"קול Codec2" (Codec2 voice) — secondary.** The original design: Codec2-compressed audio split into a few packets, played back on the receiver.

**Language:** talk to the user in **Hebrew** (all chat replies, milestone reports, questions). Code, comments, commit messages and this spec stay in English; UI strings are Hebrew (§7).

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
| Modem preset | **Not final.** The nodes are currently on `LONG_FAST`. Text mode makes a slow, long-range preset (`LONG_SLOW`) affordable; Codec2 voice was planned around `LONG_MODERATE`. Decide after field tests. |
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

1. **Hold a big button** to talk, release to send.
   - Speech-to-Text mode: transcribe, show the text (confirm/edit by default), send as a text message.
   - Codec2 mode: record (max 8 s), encode, send as voice chunks.
2. **Receive** messages from other nodes: text is **read aloud** (TTS, Hebrew); voice is **auto-played** when complete.
3. See link quality, connection state, and the **remaining duty-cycle budget**.

Codec2 voice has ~15–20 s end-to-end latency on `LONG_MODERATE`. Text is ~45 bytes per sentence versus ~450 bytes for 8 s of Codec2, so text mode can use the slowest, longest-range preset and still deliver in a few seconds.

---

## 3. RF budget (drives every design decision)

The preset is a **parameter**, not a constant. `src/airtime.ts` implements the standard Semtech LoRa time-on-air formula and a table of all Meshtastic presets; every airtime function takes the preset (`presetParams(name)`) explicitly. Never assume `LONG_MODERATE`, and never hard-code per-packet airtime.

Verified in firmware v2.7.26:
- Presets (`MeshRadio.h modemPresetToParams`): SHORT_TURBO SF7/500/4-5, SHORT_FAST SF7/250/4-5, SHORT_SLOW SF8/250/4-5, MEDIUM_FAST SF9/250/4-5, MEDIUM_SLOW SF10/250/4-5, LONG_TURBO SF11/500/4-8, **LONG_FAST SF11/250/4-5**, **LONG_MODERATE SF11/125/4-8**, **LONG_SLOW SF12/125/4-8**.
- Preamble **16** symbols (`RadioInterface.h`). Explicit header, CRC on.
- LDRO automatic: on when symbol time ≥ 16 ms (`RadioLibInterface.h`), i.e. LONG_MODERATE and LONG_SLOW.
- EU_868 duty cycle 10% → **360 s TX per rolling hour** (firmware enforces; the app tracks its own estimate).

Reference: LONG_MODERATE symbol 16.384 ms, a full 255 B frame ≈ 484 symbols ≈ 7.9 s. Codec2 450, 8 s message ≈ 2 packets ≈ 16 s airtime → ~22 messages/hour on LONG_MODERATE.

### Packet size limits (verified, firmware v2.7.26)
`perhapsEncode()` rejects `encoded Data protobuf + 16-byte header > 255`. The firmware always adds `Data.bitfield` (2 bytes) to packets it originates. So although `DATA_PAYLOAD_LEN` = 233:
- **Text (portnum 1): max 232 bytes** of UTF-8.
- **Codec2 voice (portnum 256): max 231 bytes** per chunk.

`maxAppPayload(portnum)` in `src/airtime.ts` derives these.

---

## 4. Speech-to-Text mode (primary)

### Requirements (most important: maximum Hebrew accuracy)
- **Whisper in the browser** via **transformers.js** (`@huggingface/transformers`, v4), **WebGPU** with **WASM fallback**. Runs in a Web Worker.
- Model ladder (user prefers quality over speed, however heavy):
  1. **`ivrit-ai/whisper-large-v3-turbo-onnx`**, ivrit.ai's own transformers.js-ready ONNX export of their Hebrew fine-tune of whisper-large-v3-turbo. No conversion needed. (VERIFIED: the repo has `onnx/encoder_model{,_fp16,_q4,_quantized,...}.onnx` + `decoder_model_merged_*`.)
  2. `Xenova/whisper-medium` (multilingual).
  3. `onnx-community/whisper-small` (multilingual).
- Always pass **`language: 'he'`, `task: 'transcribe'`**.
- Record **16 kHz mono**. **Trim leading/trailing silence** (simple energy VAD, `src/audio/vad.ts`), and skip transcription when no speech is found: Whisper invents text on silence.
- The model downloads **once** and stays on the device (**Cache API**, the same cache and keys transformers.js uses; files are streamed straight into the cache). Ask for persistent storage. Show a **download progress bar** and **how much space** the model takes. Allow deleting it.
- ONNX Runtime's WASM is served from our own origin (not a CDN) so everything works offline.

### Sender flow
1. Hold PTT and speak, release.
2. Whisper transcribes; show the text.
3. Default: a short **confirm screen with editing** before sending (STT gets names and numbers wrong). Setting: **"שליחה אוטומטית"** (auto-send).
4. Send as a regular Meshtastic text message (**TEXT_MESSAGE_APP, portnum 1**), so it also shows on the T-Echo e-ink screen and in the official Meshtastic app.
5. Length limit: **232 bytes** (Hebrew ≈ 2 bytes/letter, ~110 characters). Show a byte counter; split longer text on word boundaries into several messages prefixed `k/n ` (`src/protocol/text.ts`).

### Receiver flow
- Every incoming text message is **read aloud automatically** with `speechSynthesis` in a Hebrew voice (`he-IL`; Android may report `iw-IL`).
- Check that a Hebrew voice exists. If not, show how to install the Hebrew voice for Android's TTS (Google TTS → install voice data → Hebrew) for offline use.
- Message list with **replay** (read again).

### Measured so far (Node, onnxruntime CPU, 24 FLEURS he_il dev clips)
| Model | Weights (enc/dec) | CER | WER |
|---|---|---|---|
| ivrit.ai turbo | q8 / q8 | 8.9% | 24.3% |
| ivrit.ai turbo | q4 / q4 | 9.1% | 24.6% |
| OpenAI turbo (not Hebrew-tuned) | q4 / q4 | 9.8% | 27.2% |

q4 costs almost no accuracy and halves the download (~760 MB vs ~1.6 GB with an fp16 encoder), which matters on phones.

### Known library quirk
transformers.js 4.3.2 keys per-file dtypes inconsistently: model loading uses the file name `encoder_model`, `ModelRegistry` uses the session name `model`. Always pass both (`dtypeOption()` in `src/stt/models.ts`).

---

## 5. Architecture

```
Speech-to-Text (primary)
[mic] getUserMedia → AudioWorklet → resample → 16 kHz → VAD trim
   → Whisper (Web Worker, transformers.js, WebGPU|WASM) → text → confirm/edit
   → split ≤232 B → @meshtastic JS → [Web Bluetooth | Web Serial] → T-Echo → LoRa (TEXT_MESSAGE_APP, port 1)
LoRa → T-Echo → [BLE | USB] → text packet (port 1) → speechSynthesis (he-IL)

Codec2 voice (secondary)
[mic] getUserMedia → AudioWorklet → resample 48k→8k (with LPF) → int16 PCM
   → Codec2 (WASM) encode → bit-pack frames → split into chunks
   → @meshtastic JS → [Web Bluetooth | Web Serial] → T-Echo → LoRa (PRIVATE_APP, port 256)
LoRa → T-Echo → [BLE | USB] → onMeshPacket (port 256) → reassemble by (from, msg_id)
   → unpack → Codec2 decode → 8k PCM → resample → AudioContext playback
```

### Stack
- **Vite + TypeScript**, no UI framework (or a very light one). Multi-page build (`index.html` home, `stt.html`, `codec.html` for now).
- **Meshtastic JS client**: the official packages. Historically `@meshtastic/js`; it has been split into `@meshtastic/core` + transport packages (`@meshtastic/transport-web-bluetooth`, `@meshtastic/transport-web-serial`). **VERIFY** current package names and the event API for receiving packets on a specific portnum.
- **Transport abstraction**: everything above the transport (STT, codec, protocol, reassembly, UI) must be transport-agnostic. Pick the transport at connect time; no other code path should know which one is active.
  - Feature-detect `navigator.bluetooth` and `navigator.serial` and only show the options the browser supports (Android Chrome: Bluetooth only; desktop Chrome: both).
  - Web Serial: Meshtastic serial API on the T-Echo's USB CDC port. **VERIFY** baud rate / framing handled by the transport package. The node's `security.serial_enabled` is already true.
- **Whisper**: see §4.
- **Codec2 → WebAssembly** via Emscripten (`codec2-wasm/`), built from upstream `drowe67/codec2`, pinned to commit `9f5e2de`: mode 450 was removed upstream in `6549fa1` (2023-07-16) and this is the last commit that has it. Both 450 and 700C are built; the `.wasm` + glue are committed so CI doesn't need Emscripten.

---

## 6. Codec2 voice wire protocol (PRIVATE_APP payload, portnum 256)

Max payload per chunk is **231 bytes** (see §3). Every byte costs airtime, so keep the header tight.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `ver_mode` | high nibble = protocol version (1), low nibble = codec mode id (0 = 450, 1 = 700C) |
| 1 | 2 | `msg_id` | uint16 LE, random per message |
| 3 | 1 | `seq_total` | high nibble = seq (0-based), low nibble = total chunks (1–15) |
| 4 | 1 | `n_frames` | number of Codec2 frames in this chunk |
| 5 | … | `frames` | Codec2 frames **bit-packed tightly** (no per-frame byte padding) |

- Frames never span chunks; each chunk is independently decodable. Frames are spread evenly across the minimum number of chunks.
- `bits_per_frame` comes from the codec at runtime, not hard-coded (450: 18 bits / 40 ms; 700C: 28 bits / 40 ms).
- Unit-test pack/unpack round-trips, including odd bit counts and the last partial byte.

### Sending (both modes)
- Broadcast on channel 0 (encrypted with the channel PSK). `wantAck = false`.
- Hop limit is a **user setting**: default **0** (direct only); set to **1** when C is deployed as a relay. Each hop costs a full extra airtime on the channel.
- Send chunks back-to-back and let the firmware queue them. Show per-chunk progress.
- **Gate sending** on the app's own rolling-hour airtime estimate (for the active preset). If a message would exceed the budget, block it and show when it will be available.

### Receiving (voice)
- Reassemble keyed by `(from, msg_id)`. Timeout: **120 s** after the last chunk.
- Complete → auto-play once, then keep it in history for replay.
- Timeout with missing chunks → play what arrived with silence for the gaps, and mark the message as partial.
- Record RSSI/SNR per received chunk (and per text message) and show them on the message.

v1 has **no retransmission**. A selective "resend chunk N" request is a possible v2, but it costs scarce airtime, so it should be a deliberate later decision.

---

## 7. UI (Hebrew, RTL)

- Connection screen: two buttons, **"Bluetooth"** and **"USB"**, shown only when supported (both `requestDevice` and `requestPort` need a user gesture). Remember the last choice. Show the connected node name and a battery readout if available.
- Layout must work on both a phone (portrait, thumb-sized PTT) and a laptop. On desktop, also allow **holding the Space bar** as PTT.
- Main screen:
  - **Mode switch**: "דיבור לטקסט" (default) / "קול Codec2".
  - **Huge PTT button** (pointer events: hold = record, release = send; slide away = cancel). Countdown ring for the recording limit.
  - STT mode: transcript **confirm/edit screen** with a byte counter (unless auto-send is on).
  - Duty-cycle meter: airtime used / 360 s in the last hour, plus how many messages of the current kind are left.
  - Message list: sender, text or duration, time, RSSI/SNR, complete/partial, replay (read aloud / play).
  - Settings: mode, auto-send, Whisper model + download/delete, codec mode, hop limit, auto-play/read-aloud on/off.
- Must work **offline after first load** (service worker + manifest), including the Whisper model (Cache API) and ONNX Runtime WASM (self-hosted). Field use will often have no internet.

---

## 8. Hosting

- **GitHub Pages** via GitHub Actions (Web Bluetooth, the mic and WebGPU need HTTPS). Workflow: `.github/workflows/pages.yml`. Pages must be enabled once in the repo settings (Source: GitHub Actions).
- Single repo, `main` → deploy.
- No cross-origin isolation on Pages, so the WASM fallback runs single-threaded (a COI service worker is a possible later improvement).

---

## 9. Known constraints / gotchas

- **One client per node**: the official Meshtastic app, client.meshtastic.org, or the Python CLI must be disconnected/closed while this app is using that node (BLE or USB). Show a hint if the connection fails ("port busy" on serial is the typical symptom on Windows).
- The nodes use Bluetooth `RANDOM_PIN` pairing: the PIN appears on the T-Echo e-ink screen during pairing.
- Android may throttle background tabs. Keep the screen on while the app is active (Wake Lock API).
- AudioContext needs a user gesture to start; unlock it on the first tap.
- Do not change node config from the app (region, preset, admin). That stays with the CLI and remote admin from node A.
- Whisper models are large (≈0.4–1.6 GB). Phones may run out of memory or storage; the fallback ladder (§4) exists for that.

---

## 10. Milestones

1. ✅ **Codec loopback, no radio** (Codec2 450 + 700C in the browser). Intelligibility still to be confirmed by the user.
2. **Whisper feasibility** (before any radio work): test page that loads a model, records, and transcribes, and displays download time + model size, load-to-memory time, transcription time for a ~8 s sentence, and whether it runs on WebGPU or fell back to WASM. The user tests on the laptop and an Android phone; pick the model/precision from the results. Deploy to GitHub Pages now (phones need HTTPS).
3. **Unit tests**: airtime formula against known values (all presets), pack/unpack, text splitting, VAD.
4. **Connect**: first **USB / Web Serial on the laptop** (easiest to debug), then **BLE on a phone**. Show node info and receive a plain text message on each.
5. **Send/receive**: STT text first (laptop node A over USB ↔ phone node B over BLE, then phone ↔ phone), with confirm/edit and TTS on receive; then Codec2 voice. Keep the nodes ≥3 m apart; at 22 dBm close range saturates receivers.
6. **Budget meter + gating.**
7. **PWA offline** (service worker + manifest; model and ORT WASM cached).
8. **Field test** with the user (range per preset, partial-message behavior, relay via C), then fix the preset.

At each milestone, stop and tell the user exactly what to test on the phone.
