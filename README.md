# LoRa Voice PTT

Push-to-talk voice messages over a private Meshtastic LoRa mesh. A PWA for Chrome
(Android over Web Bluetooth, Windows over Web Serial/USB) that records up to 8 s,
compresses it with Codec2, and sends it as a few PRIVATE_APP packets.
See [`CLAUDE.md`](CLAUDE.md) for the full spec.

## Status

**Milestone 1: codec loopback (no radio).** Hold the button (or Space on a laptop),
speak, release. The recording goes through the full pipeline (resample to 8 kHz,
Codec2 encode, tight bit-pack, wire chunks, parse, unpack, decode) and you can play the
original, **450** and **700C** side by side, with the real packet sizes and airtime.

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
| `src/airtime.ts` | LoRa time-on-air (Semtech formula) + Meshtastic framing overhead |
| `src/protocol/bitpack.ts` | tight bit-packing of Codec2 frames |
| `src/protocol/wire.ts` | 5-byte header, chunking, parsing (portnum 256) |
| `src/codec/` | Codec2 WASM wrapper (built by `codec2-wasm/`) |
| `src/audio/` | AudioWorklet capture, windowed-sinc resampler, playback |
| `src/pipeline.ts` | record → chunks and chunks → PCM, shared with the radio path later |
| `src/loopback.ts` | milestone 1 UI |

## Verified against upstream (firmware v2.7.26)

* LoRa preamble is **16** symbols (`RadioInterface.h`).
* `DATA_PAYLOAD_LEN` is 233, but the usable payload for our packets is **231 bytes**.
  `perhapsEncode()` rejects `encoded Data + 16-byte header > 255`. Our `Data` protobuf
  adds 8 bytes: portnum (3), payload tag+length (3), and the `bitfield` the firmware always
  sets on packets it originates (2). `src/airtime.ts` derives the limit from this.
* Codec2 450: see [`codec2-wasm/README.md`](codec2-wasm/README.md).
