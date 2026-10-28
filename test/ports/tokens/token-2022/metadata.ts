// Port of tokens/token-2022/metadata @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - `extensions::metadata_pointer::metadata_address = mint_account` on the later instructions is checked by walking
//    the TLV list (6000 here).
//  - interface: TokenMetadataArgs and UpdateFieldArgs are `@layout borsh` structs (Anchor's bytes; TokenMetadataArgs'
//    strings hold up to 200 bytes). AnchorField's `Key` is a named field where the original has a tuple (the same
//    bytes; the IDL names it). A Key named "name", "symbol" or "uri" updates that field.
//  - update_field tops the mint up to the rent of its new size. For a Key field the port funds a new entry (key and
//    value); when the key already exists that is more than the original's exact amount, by the old entry's size.
//  - logs: the original logs the field, the updated TokenMetadata and the lamports with `{:?}`; the port logs the
//    lamport lines only.
import {
  type Init,
  type AccountInfo,
  type FixedString,
  type AccountMeta,
  type Mint,
  type Pubkey,
  type Mut,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type u16,
  type u32,
  byteLength,
  log,
  readData,
  rentExempt,
  require,
  u64,
} from "typesol";

const METADATA_POINTER: u16 = 18n;
const TOKEN_METADATA: u16 = 19n;

export enum MetadataError {
  WrongMetadataPointer = "The mint's metadata pointer does not point at the mint",
}

export type AnchorField = { kind: "Name" } | { kind: "Symbol" } | { kind: "Uri" } | { kind: "Key"; key: string };

/** @layout borsh */
export interface UpdateFieldArgs {
  field: AnchorField;
  value: string;
}

/** @layout borsh */
export interface TokenMetadataArgs {
  name: FixedString<200>;
  symbol: FixedString<200>;
  uri: FixedString<200>;
}

/** Offset of the value of extension `ext` in a Token-2022 account (TLV entries after byte 166), or 0 when absent. */
function extensionOffset(account: AccountMeta, ext: u16): u64 {
  let off = 166n;
  while (off + 4n <= account.dataLen) {
    const t = readData<u16>(account, off);
    const len = readData<u16>(account, off + 2n);
    if (t === ext) return off + 4n;
    if (t === 0n) return 0n;
    off += 4n + u64(len);
  }
  return 0n;
}

/** `extensions::metadata_pointer::metadata_address = mint_account`. */
function checkPointsAtItself(mint: AccountMeta): void {
  const at = extensionOffset(mint, METADATA_POINTER);
  require(at > 0n && readData<Pubkey>(mint, at + 32n) === mint.key, MetadataError.WrongMetadataPointer);
}

export function initialize(
  payer: Mut<Signer>,
  mintAccount: Init<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  args: TokenMetadataArgs,
): void {
  const name: string = args.name;
  const symbol: string = args.symbol;
  const uri: string = args.uri;
  // `init, mint::decimals = 2, mint::authority = payer, extensions::metadata_pointer::…`
  mintAccount.create(payer, null, 2n, payer.key, null, { metadataPointer: { authority: payer.key, metadataAddress: mintAccount.key } });
  // TokenMetadata::tlv_size_of: TLV header (4) + authority (32) + mint (32) + three Borsh strings + empty Vec (4).
  const dataLen = 4n + 32n + 32n + 12n + u64(byteLength(name)) + u64(byteLength(symbol)) + u64(byteLength(uri)) + 4n;
  systemProgram.transfer(payer, mintAccount, rentExempt(dataLen));
  tokenProgram.initializeMetadata(mintAccount, payer, payer, name, symbol, uri);
}

export function updateField(
  authority: Mut<Signer>,
  mintAccount: Mut<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  args: UpdateFieldArgs,
): void {
  const field = args.field;
  const value = args.value;
  checkPointsAtItself(mintAccount);
  const at = extensionOffset(mintAccount, TOKEN_METADATA);
  const oldLen = u64(readData<u16>(mintAccount, at - 2n));
  // The TokenMetadata value after the update: a field's string is replaced, a Key entry is added.
  const nameLen = u64(readData<u32>(mintAccount, at + 64n));
  const symbolLen = u64(readData<u32>(mintAccount, at + 68n + nameLen));
  const uriLen = u64(readData<u32>(mintAccount, at + 72n + nameLen + symbolLen));
  let newLen = oldLen + u64(byteLength(value));
  let name = "name";
  if (field.kind === "Name") newLen -= nameLen;
  else if (field.kind === "Symbol") {
    newLen -= symbolLen;
    name = "symbol";
  } else if (field.kind === "Uri") {
    newLen -= uriLen;
    name = "uri";
  } else {
    newLen += 8n + u64(byteLength(field.key));
    name = field.key;
  }
  const required = rentExempt(mintAccount.dataLen - oldLen + newLen);
  log(`Required lamports: ${required}`);
  log(`Current lamports: ${mintAccount.lamports}`);
  if (required > mintAccount.lamports) {
    const difference = required - mintAccount.lamports;
    systemProgram.transfer(authority, mintAccount, difference);
    log(`Transferring ${difference} lamports to metadata account`);
  }
  tokenProgram.updateMetadataField(mintAccount, authority, name, value);
}

export function removeKey(
  updateAuthority: Mut<Signer>,
  mintAccount: Mut<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  key: string,
): void {
  checkPointsAtItself(mintAccount);
  tokenProgram.removeMetadataKey(mintAccount, updateAuthority, key, true);
}

export function emit(mintAccount: Mint, tokenProgram: Token2022Program): void {
  tokenProgram.emitMetadata(mintAccount);
}

export function updateAuthority(
  currentAuthority: Signer,
  newAuthority: AccountInfo | null,
  mintAccount: Mut<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  checkPointsAtItself(mintAccount);
  tokenProgram.updateMetadataAuthority(mintAccount, currentAuthority, newAuthority !== null ? newAuthority.key : null);
}
