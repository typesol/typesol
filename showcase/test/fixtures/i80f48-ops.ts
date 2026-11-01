// Every I80F48 operation of showcase/mainnet/marginfi/i80f48.ts behind one instruction, for showcase/test/fuzz-i80f48.test.ts.
import { type i128, type u8, i128 as toI128, u64 } from "typesol";
import {
  fxAbs,
  fxAdd,
  fxCeil,
  fxDiv,
  fxFrac,
  fxInt,
  fxMul,
  fxRound,
  fxSaturatingAdd,
  fxSaturatingMul,
  fxSaturatingSub,
  fxSub,
  fxToF64Bits,
  fxToU64,
  fxUnsignedAbs,
} from "../../mainnet/marginfi/i80f48";

export interface Out {
  v: i128;
  u: u64;
}

export function run(op: u8, a: i128, b: i128): Out {
  let v: i128 = 0n;
  let u: u64 = 0n;
  if (op === 0n) v = fxAdd(a, b);
  else if (op === 1n) v = fxSub(a, b);
  else if (op === 2n) v = fxMul(a, b);
  else if (op === 3n) v = fxDiv(a, b);
  else if (op === 4n) v = fxSaturatingAdd(a, b);
  else if (op === 5n) v = fxSaturatingSub(a, b);
  else if (op === 6n) v = fxSaturatingMul(a, b);
  else if (op === 7n) v = fxAbs(a);
  else if (op === 8n) {
    const m = fxUnsignedAbs(a);
    // U80F48 bits as two halves: the high one in u, the low 64 bits in v.
    u = u64(m >> 64n);
    v = toI128(m & 18446744073709551615n);
  } else if (op === 9n) v = fxInt(a);
  else if (op === 10n) v = fxFrac(a);
  else if (op === 11n) v = fxCeil(a);
  else if (op === 12n) v = fxRound(a);
  else if (op === 13n) u = fxToU64(a);
  else if (op === 14n) u = fxToF64Bits(a);
  return { v, u };
}
