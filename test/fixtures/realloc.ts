import { type Init, type Mut, type Signer, type SystemProgram, type u64, readData, realloc } from "typesol";

export interface Doc {
  size: u64;
}

export function make(payer: Mut<Signer>, doc: Init<Doc>, systemProgram: SystemProgram): void {
  doc.create(payer, ["doc", payer.key]);
}

/** Resize to `size` bytes, then read the last 8 bytes (zero after growing). */
export function resize(payer: Mut<Signer>, doc: Mut<Doc>, systemProgram: SystemProgram, size: u64): u64 {
  realloc(doc, size, payer);
  doc.size = doc.dataLen;
  return readData<u64>(doc, doc.dataLen - 8n);
}
