# LoRa Voice PTT

Push-to-talk voice messages over a private Meshtastic LoRa mesh. A PWA for Chrome
(Android over Web Bluetooth, Windows over Web Serial/USB) that records up to 8 s,
compresses it with Codec2, and sends it as a few PRIVATE_APP packets.
See [`CLAUDE.md`](CLAUDE.md) for the full spec.

## Status

Two modes: **speech-to-text** (primary: Whisper in the browser, sends short text
messages read aloud on the receiver) and **Codec2 voice** (secondary).

* `stt.html` — **Whisper feasibility test** (current milestone). Pick a model
  (ivrit.ai Hebrew large-v3-turbo / medium / small), download it once (cached on the
  device), hold the button and speak. Shows download time and size, load-to-memory
  time, warm-up, transcription time, WebGPU vs WASM, text size in bytes and airtime per
  preset, and whether a Hebrew TTS voice is available.
* `codec.html` — Codec2 loopback (record, encode 450 / 700C, decode, play), no radio.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173 (mic works on localhost)
npm test           # unit tests (bit-pack, wire format, airtime, resampler, codec WASM)
npm run build      # production build in dist/
```

### Testing on a phone

The mic needs HTTPS. Either:

* **GitHub Pages:** pushes to `main` deploy via `.github/workflows/pages.yml`.
  Turn it on once under *Settings → Pages → Source: GitHub Actions*. Then open
  `https://<user>.github.io/lora-voice-ptt/`.
* **LAN:** `npm run dev:lan` serves self-signed HTTPS on all interfaces. Open
  `https://<laptop-ip>:5173` on the phone (same Wi-Fi) and accept the certificate warning
  (*Advanced → Proceed*).

## Layout

| Path | What |
|---|---|
| `src/airtime.ts` | LoRa time-on-air (Semtech formula), Meshtastic presets, framing overhead |
| `src/stt/` | Whisper worker (transformers.js), model catalog, Cache API download, WebGPU probe |
| `src/audio/vad.ts` | silence trimming before Whisper |
| `src/protocol/text.ts` | text message byte limit (232 B) and splitting |
| `src/tts.ts` | Hebrew speechSynthesis |
| `src/protocol/bitpack.ts` | tight bit-packing of Codec2 frames |
| `src/protocol/wire.ts` | 5-byte header, chunking, parsing (portnum 256) |
| `src/codec/` | Codec2 WASM wrapper (built by `codec2-wasm/`) |
| `src/audio/` | AudioWorklet capture, windowed-sinc resampler, playback |
| `src/pipeline.ts` | record → chunks and chunks → PCM, shared with the radio path later |
| `src/loopback.ts`, `src/stt-page.ts` | test pages |

## Verified against upstream (firmware v2.7.26)

* LoRa preamble is **16** symbols (`RadioInterface.h`).
* Modem presets (`MeshRadio.h`), with LDRO on when the symbol time is ≥ 16 ms.
* `DATA_PAYLOAD_LEN` is 233, but the usable payload is **231 bytes** for voice (portnum 256)
  and **232 bytes** for text (portnum 1). `perhapsEncode()` rejects
  `encoded Data + 16-byte header > 255`, and the firmware always adds `Data.bitfield`
  (2 bytes) to packets it originates. `src/airtime.ts` derives the limits from this.
* Codec2 450: see [`codec2-wasm/README.md`](codec2-wasm/README.md).
