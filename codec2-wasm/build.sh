#!/usr/bin/env bash
# Build Codec2 -> WebAssembly for the web app.
#
# Requirements: git, cmake, a native C compiler, and Emscripten (`emcc` on PATH,
# e.g. `source /path/to/emsdk/emsdk_env.sh`).
#
# Output (committed to the repo so CI / Pages builds don't need Emscripten):
#   src/codec/wasm/codec2.mjs   ES module glue
#   src/codec/wasm/codec2.wasm  binary
#
# Codec2 450 was removed upstream in commit 6549fa1 ("rm-ed 450 & 450WB",
# 2023-07-16). We pin to its parent, which still has both 450 and 700C.
set -euo pipefail

CODEC2_REPO="https://github.com/drowe67/codec2.git"
CODEC2_COMMIT="9f5e2deebcdf702ae9fd71785879891bc38d2f4e"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="${CODEC2_WORK_DIR:-$HERE/.build}"
OUT="$ROOT/src/codec/wasm"

command -v emcc >/dev/null || { echo "emcc not found; source emsdk_env.sh first" >&2; exit 1; }

mkdir -p "$WORK" "$OUT"
SRC="$WORK/codec2"
if [ ! -d "$SRC/.git" ]; then
  git clone "$CODEC2_REPO" "$SRC"
fi
git -C "$SRC" fetch --quiet origin "$CODEC2_COMMIT" 2>/dev/null || true
git -C "$SRC" checkout --quiet "$CODEC2_COMMIT"

# 1. Native build, only to run generate_codebook and produce version.h.
NATIVE="$WORK/native"
cmake -S "$SRC" -B "$NATIVE" -DCMAKE_BUILD_TYPE=Release -DUNITTEST=OFF >/dev/null
cmake --build "$NATIVE" --target codec2 -j"$(nproc 2>/dev/null || echo 4)" >/dev/null

# 2. Compile only the speech codec sources (no FreeDV modems) to WASM.
S="$SRC/src"
G="$NATIVE/src"
SOURCES=(
  "$S/codec2.c" "$S/codec2_fft.c" "$S/kiss_fft.c" "$S/kiss_fftr.c"
  "$S/dump.c" "$S/lpc.c" "$S/nlp.c" "$S/postfilter.c" "$S/sine.c"
  "$S/interp.c" "$S/lsp.c" "$S/mbest.c" "$S/newamp1.c" "$S/newamp2.c"
  "$S/phase.c" "$S/quantise.c" "$S/pack.c"
  "$G/codebook.c" "$G/codebookd.c" "$G/codebookjmv.c" "$G/codebookge.c"
  "$G/codebooknewamp1.c" "$G/codebooknewamp1_energy.c"
  "$G/codebooknewamp2.c" "$G/codebooknewamp2_energy.c"
)

emcc -O3 \
  -I"$S" -I"$NATIVE" -I"$NATIVE/codec2" \
  "$HERE/wrapper.c" "${SOURCES[@]}" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCodec2Module \
  -sENVIRONMENT=web,worker,node \
  -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_c2w_create,_c2w_destroy,_c2w_bits_per_frame,_c2w_bytes_per_frame,_c2w_samples_per_frame,_c2w_encode,_c2w_decode \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP16 \
  -o "$OUT/codec2.mjs"

echo "codec2 $CODEC2_COMMIT" > "$OUT/BUILD_INFO.txt"
emcc --version | head -1 >> "$OUT/BUILD_INFO.txt"
ls -l "$OUT"
