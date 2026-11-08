import wasmUrl from './wasm/codec2.wasm?url';
import { loadCodec2Module } from './codec2';

/** Load the Codec2 WASM module in the browser (wasm served as a hashed asset). */
export function loadCodec2Browser() {
  return loadCodec2Module({ locateFile: () => wasmUrl });
}
