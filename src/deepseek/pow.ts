export interface PowChallenge {
  challenge: string;
  salt: string;
  expire_at: number;
  difficulty: number;
}

/** Thrown when the wasm solver exhausts the difficulty range without a match. */
export class PowError extends Error {
  constructor(message = "DeepSeekHashV1 solver did not find an answer") {
    super(message);
    this.name = "PowError";
  }
}

interface Sha3WasmExports {
  readonly memory: WebAssembly.Memory;
  wasm_solve(
    retptr: number,
    challengePtr: number,
    challengeLen: number,
    prefixPtr: number,
    prefixLen: number,
    difficulty: number,
  ): void;
  __wbindgen_add_to_stack_pointer(delta: number): number;
  __wbindgen_export_0(size: number, align: number): number;
}

const wasmUrl = new URL("../../vendor/sha3_wasm_bg.wasm", import.meta.url);
const { instance } = await WebAssembly.instantiate(await Bun.file(wasmUrl).arrayBuffer(), {});
const wasm = instance.exports as unknown as Sha3WasmExports;
const encoder = new TextEncoder();

function allocString(value: string): [ptr: number, len: number] {
  const bytes = encoder.encode(value);
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
  return [ptr, bytes.length];
}

/**
 * Solves the DeepSeekHashV1 proof of work.
 *
 * The vendored wasm-bindgen module expects a 16-byte return area carved out of
 * its own stack: `retptr + 0` is the status (0 = no answer) and `retptr + 8`
 * holds the winning nonce as an f64.
 */
export function solvePow({ challenge, salt, expire_at, difficulty }: PowChallenge): number {
  const retptr = wasm.__wbindgen_add_to_stack_pointer(-16) >>> 0;
  try {
    const [challengePtr, challengeLen] = allocString(challenge);
    const [prefixPtr, prefixLen] = allocString(`${salt}_${expire_at}_`);

    wasm.wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty);

    // wasm_solve may grow memory, so read through a view created after the call.
    const view = new DataView(wasm.memory.buffer);
    const status = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    if (status === 0) {
      throw new PowError();
    }
    return answer;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}
