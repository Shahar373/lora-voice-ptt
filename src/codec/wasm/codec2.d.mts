// Types for the Emscripten-generated glue (codec2-wasm/build.sh).
export interface Codec2WasmModule {
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _c2w_create(mode: number): number;
  _c2w_destroy(state: number): void;
  _c2w_bits_per_frame(state: number): number;
  _c2w_bytes_per_frame(state: number): number;
  _c2w_samples_per_frame(state: number): number;
  _c2w_encode(state: number, bitsOut: number, pcmIn: number): void;
  _c2w_decode(state: number, pcmOut: number, bitsIn: number): void;
}

export interface Codec2ModuleOptions {
  wasmBinary?: ArrayBuffer | Uint8Array;
  locateFile?: (path: string, prefix: string) => string;
}

declare function createCodec2Module(opts?: Codec2ModuleOptions): Promise<Codec2WasmModule>;
export default createCodec2Module;
