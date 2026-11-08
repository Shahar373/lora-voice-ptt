/*
 * Thin C wrapper around Codec2 for the WebAssembly build.
 *
 * Frames are exchanged in Codec2's native byte-padded format
 * (codec2_bytes_per_frame bytes, MSB first). Tight bit-packing for the
 * radio happens in TypeScript (src/protocol/bitpack.ts).
 */
#include <emscripten/emscripten.h>
#include <stddef.h>

#include "codec2.h"

EMSCRIPTEN_KEEPALIVE
struct CODEC2 *c2w_create(int mode) { return codec2_create(mode); }

EMSCRIPTEN_KEEPALIVE
void c2w_destroy(struct CODEC2 *c2) {
  if (c2) codec2_destroy(c2);
}

EMSCRIPTEN_KEEPALIVE
int c2w_bits_per_frame(struct CODEC2 *c2) { return codec2_bits_per_frame(c2); }

EMSCRIPTEN_KEEPALIVE
int c2w_bytes_per_frame(struct CODEC2 *c2) { return codec2_bytes_per_frame(c2); }

EMSCRIPTEN_KEEPALIVE
int c2w_samples_per_frame(struct CODEC2 *c2) {
  return codec2_samples_per_frame(c2);
}

/* Encode one frame: samples_per_frame int16 samples -> bytes_per_frame bytes. */
EMSCRIPTEN_KEEPALIVE
void c2w_encode(struct CODEC2 *c2, unsigned char *bits_out, short *pcm_in) {
  codec2_encode(c2, bits_out, pcm_in);
}

/* Decode one frame: bytes_per_frame bytes -> samples_per_frame int16 samples. */
EMSCRIPTEN_KEEPALIVE
void c2w_decode(struct CODEC2 *c2, short *pcm_out, const unsigned char *bits_in) {
  codec2_decode(c2, pcm_out, bits_in);
}
