import xxhash from "xxhash-wasm";

type Hasher = (input: string) => bigint;

let ready: Promise<Hasher> | undefined;
let sync: Hasher | undefined;

/** xxHash64 of a string's UTF-8 bytes, as an unsigned 64-bit bigint. Loads the WASM once. */
export function loadHasher(): Promise<Hasher> {
  ready ??= xxhash().then((api) => {
    sync = (input: string) => api.h64(input);
    return sync;
  });
  return ready;
}

/** The hasher, once `loadHasher` has resolved. */
export function hasher(): Hasher {
  if (!sync) throw new Error("loadHasher() must resolve before hashing");
  return sync;
}

/** SQLite stores 64-bit integers signed; hashes go in and come out through these two. */
export const toSigned = (hash: bigint): bigint => BigInt.asIntN(64, hash);
export const toUnsigned = (hash: bigint): bigint => BigInt.asUintN(64, hash);

export const hashHex = (hash: bigint): string => toUnsigned(hash).toString(16).padStart(16, "0");
export const fromHex = (hex: string): bigint => BigInt(`0x${hex}`);
