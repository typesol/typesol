// Port of tokens/token-2022/metadata @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - builtin gaps: no Token-2022 extension or Token Metadata interface builtins, so the mint (a keypair `init` with
//    `extensions::metadata_pointer::*`) is created in the body (CreateAccount sized for MetadataPointer, MetadataPointer
//    Initialize, InitializeMint2), and the Token Metadata interface instructions (initialize, update_field, remove_key,
//    emit, update_authority) are hand-encoded (`invoke`) with the interface's discriminators and Borsh data.
//    `extensions::metadata_pointer::metadata_address = mint_account` is checked by walking the TLV list (6000 here).
//  - interface: `initialize` takes name, symbol and uri as three arguments instead of a TokenMetadataArgs struct (same
//    instruction bytes, different IDL), since struct arguments must have a fixed layout. `update_field` takes `field: AnchorField` as a unit enum plus a `key` string used for Key, because
//    TypeSOL arguments cannot be data enums carrying strings (`AnchorField::Key(String)`): the instruction bytes differ.
//  - update_field tops the mint up to the rent of its new size. For a Key field the port funds a new entry (key and
//    value); when the key already exists that is more than the original's exact amount, by the old entry's size.
//  - logs: the original logs the field, the updated TokenMetadata and the lamports with `{:?}`; the port logs the
//    lamport lines only.
import {
  type AccountInfo,
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
  hex,
  invoke,
  log,
  pubkey,
  readData,
  readonly,
  readonlySigner,
  rentExempt,
  require,
  u64,
  u8,
  writable,
} from "typesol";

/** Base mint (padded to 165) + account type (1) + MetadataPointer TLV (2 + 2 + 64). */
const MINT_SIZE_METADATA_POINTER = 234n;
const NO_AUTHORITY = pubkey("11111111111111111111111111111111");
const METADATA_POINTER: u16 = 18n;
const TOKEN_METADATA: u16 = 19n;

export enum MetadataError {
  WrongMetadataPointer = "The mint's metadata pointer does not point at the mint",
}

export enum AnchorField {
  Name,
  Symbol,
  Uri,
  Key,
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
  mintAccount: Mut<Signer>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  name: string,
  symbol: string,
  uri: string,
): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE_METADATA_POINTER), MINT_SIZE_METADATA_POINTER, tokenProgram.key);
  // MetadataPointerExtension (39) / Initialize (0): authority, metadata address.
  invoke(tokenProgram, [writable(mintAccount)], [u8(39n), u8(0n), payer.key, mintAccount.key]);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, null);
  // TokenMetadata::tlv_size_of: TLV header (4) + authority (32) + mint (32) + three Borsh strings + empty Vec (4).
  const dataLen = 4n + 32n + 32n + 12n + u64(byteLength(name)) + u64(byteLength(symbol)) + u64(byteLength(uri)) + 4n;
  systemProgram.transfer(payer, mintAccount, rentExempt(dataLen));
  // spl-token-metadata-interface Initialize: name, symbol, uri.
  invoke(tokenProgram, [writable(mintAccount), readonly(payer), readonly(mintAccount), readonlySigner(payer)], [hex("d2e11ea258b84d8d"), name, symbol, uri]);
}

export function updateField(
  authority: Mut<Signer>,
  mintAccount: Mut<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  field: AnchorField,
  key: string,
  value: string,
): void {
  checkPointsAtItself(mintAccount);
  const at = extensionOffset(mintAccount, TOKEN_METADATA);
  const oldLen = u64(readData<u16>(mintAccount, at - 2n));
  // The TokenMetadata value after the update: a field's string is replaced, a Key entry is added.
  const nameLen = u64(readData<u32>(mintAccount, at + 64n));
  const symbolLen = u64(readData<u32>(mintAccount, at + 68n + nameLen));
  const uriLen = u64(readData<u32>(mintAccount, at + 72n + nameLen + symbolLen));
  let newLen = oldLen + u64(byteLength(value));
  if (field === AnchorField.Name) newLen -= nameLen;
  else if (field === AnchorField.Symbol) newLen -= symbolLen;
  else if (field === AnchorField.Uri) newLen -= uriLen;
  else newLen += 8n + u64(byteLength(key));
  const required = rentExempt(mintAccount.dataLen - oldLen + newLen);
  log(`Required lamports: ${required}`);
  log(`Current lamports: ${mintAccount.lamports}`);
  if (required > mintAccount.lamports) {
    const difference = required - mintAccount.lamports;
    systemProgram.transfer(authority, mintAccount, difference);
    log(`Transferring ${difference} lamports to metadata account`);
  }
  // spl-token-metadata-interface UpdateField: Field (Borsh enum), value.
  if (field === AnchorField.Key) invoke(tokenProgram, [writable(mintAccount), readonlySigner(authority)], [hex("dde9312db5cadcc8"), u8(3n), key, value]);
  else invoke(tokenProgram, [writable(mintAccount), readonlySigner(authority)], [hex("dde9312db5cadcc8"), field, value]);
}

export function removeKey(
  updateAuthority: Mut<Signer>,
  mintAccount: Mut<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
  key: string,
): void {
  checkPointsAtItself(mintAccount);
  // spl-token-metadata-interface RemoveKey: idempotent, key.
  invoke(tokenProgram, [writable(mintAccount), readonlySigner(updateAuthority)], [hex("ea122038598d25b5"), true, key]);
}

export function emit(mintAccount: Mint, tokenProgram: Token2022Program): void {
  // spl-token-metadata-interface Emit: start and end are None.
  invoke(tokenProgram, [readonly(mintAccount)], [hex("faa6b4fa0d0cb846"), u8(0n), u8(0n)]);
}

export function updateAuthority(
  currentAuthority: Signer,
  newAuthority: AccountInfo | null,
  mintAccount: Mut<Mint>,
  tokenProgram: Token2022Program,
  systemProgram: SystemProgram,
): void {
  checkPointsAtItself(mintAccount);
  // spl-token-metadata-interface UpdateAuthority: the new authority as an OptionalNonZeroPubkey (zeros: none).
  const next = newAuthority !== null ? newAuthority.key : NO_AUTHORITY;
  invoke(tokenProgram, [writable(mintAccount), readonlySigner(currentAuthority)], [hex("d7e4a6e45464567b"), next]);
}
