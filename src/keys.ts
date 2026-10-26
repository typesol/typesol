import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** Decode a base58 Solana address to its 32 bytes, or undefined if it is not one. */
export function decodeAddress(text: string): Uint8Array | undefined {
  let n = 0n;
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return undefined;
    n = n * 58n + BigInt(v);
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) return undefined;
  return base58(out) === text ? out : undefined;
}

/** The 64 bytes of a Solana CLI keypair file (a JSON array), with errors that name the file. */
export function readKeypair(file: string): Uint8Array {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not a Solana keypair file (expected a JSON array of 64 numbers)`);
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((b) => Number.isInteger(b) && b >= 0 && b < 256))
    throw new Error(`${file} is not a 64-byte Solana keypair`);
  return Uint8Array.from(raw as number[]);
}

/** Read a Solana CLI keypair file, or create one, and return its base58 address. */
export function loadOrCreateKeypair(file: string): { address: string; created: boolean } {
  if (existsSync(file)) {
    const bytes = readKeypair(file);
    return { address: base58(bytes.subarray(32)), created: false };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const secret = Buffer.from(jwk.d!, "base64url");
  const pub = Buffer.from(jwk.x!, "base64url");
  writeFileSync(file, JSON.stringify([...secret, ...pub]) + "\n", { mode: 0o600 });
  return { address: base58(pub), created: true };
}
