// Port of tokens/token-2022/transfer-hook/allow-block-list-token (anchor/programs/abl-token) @ de09019; see
// test/ports/README.md.
//
// A Token-2022 mint whose transfer hook allows or blocks wallets. The mode ("AB": Allow / Block / Mixed) and the
// Mixed threshold live in the mint's Token Metadata; per-wallet entries are ["ab_wallet", wallet] PDAs, which the
// ExtraAccountMetaList derives from the source's and destination's owners (account data bytes 32..64).
// PARTIAL:
//  - InitMintArgs is a `@layout borsh` struct (Anchor's bytes and IDL); its strings hold up to 200 bytes.
//  - tx_hook reads the mint's TokenMetadata (its additional "AB" / "threshold" fields) by walking the TLV list and the
//    Borsh strings byte by byte.
//  - tx_hook decodes an ab_wallet with loadForeign (owner, discriminator and size checked), where the original's
//    try_deserialize checks the discriminator only; the ab_wallet addresses are this program's PDAs (Token-2022 checks
//    them against the list), so only this program could have written them either way. A mint that is not a mint with
//    TokenMetadata fails with InvalidMetadata (6000), where the original fails unpacking it.
import {
  type Account,
  type AccountInfo,
  type AccountMeta,
  type CloseTo,
  type FixedString,
  type HasOne,
  type Init,
  type Mint,
  type Mut,
  type Owner,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type u16,
  type u32,
  initExtraAccountMetas,
  loadForeign,
  pubkey,
  readData,
  rentExempt,
  require,
  seedAccountData,
  transferHookProgram,
  u64,
  u8,
  updateExtraAccountMetas,
} from "typesol";

const PROGRAM_ID = pubkey("3ku1ZEGvBEEfhaYsAzBZuecTPEa58ZRhoVqHVGpGxVGi");
/** Base mint (padded to 165) + account type + PermanentDelegate (4 + 32) + TransferHook (4 + 64) + MetadataPointer (4 + 64). */
const MINT_SIZE = 338n;
const TOKEN_METADATA: u16 = 19n;

export enum ABListError {
  InvalidMetadata = "Invalid metadata",
  WalletNotAllowed = "Wallet not allowed",
  AmountNotAllowed = "Amount not allowed",
  WalletBlocked = "Wallet blocked",
  MintNotUsingThisHook = "Mint is not configured to use this transfer hook program",
}

export enum Mode {
  Allow,
  Block,
  Mixed,
}

export interface ABWallet {
  wallet: Pubkey;
  allowed: boolean;
}

export interface Config {
  authority: Pubkey;
  bump: u8;
}

export interface InitWalletArgs {
  allowed: boolean;
}

export interface ChangeModeArgs {
  mode: Mode;
  threshold: u64;
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

/** The byte at `off`. */
function at(a: AccountMeta, off: u64): u64 {
  return u64(readData<u8>(a, off));
}

/** The Borsh string at `off` (u32 length, bytes) has these 2..9 ASCII bytes; `n` is how many are given. */
function strIs(a: AccountMeta, off: u64, n: u64, c0: u64, c1: u64, c2: u64, c3: u64, c4: u64, c5: u64, c6: u64, c7: u64, c8: u64): boolean {
  if (u64(readData<u32>(a, off)) !== n) return false;
  const p = off + 4n;
  return (
    at(a, p) === c0 &&
    at(a, p + 1n) === c1 &&
    (n < 3n || at(a, p + 2n) === c2) &&
    (n < 4n || at(a, p + 3n) === c3) &&
    (n < 5n || at(a, p + 4n) === c4) &&
    (n < 6n || at(a, p + 5n) === c5) &&
    (n < 7n || at(a, p + 6n) === c6) &&
    (n < 8n || at(a, p + 7n) === c7) &&
    (n < 9n || at(a, p + 8n) === c8)
  );
}

/** Offset just past the Borsh string at `off`. */
function skipStr(a: AccountMeta, off: u64): u64 {
  return off + 4n + u64(readData<u32>(a, off));
}

/** u64::from_str of the Borsh string at `off` (decimal digits only, as Rust accepts them; InvalidMetadata otherwise). */
function parseU64(a: AccountMeta, off: u64): u64 {
  const n = u64(readData<u32>(a, off));
  require(n > 0n && n <= 20n, ABListError.InvalidMetadata);
  let v: u64 = 0n;
  for (let i = 0n; i < n; i++) {
    const c = at(a, off + 4n + i);
    require(c >= 48n && c <= 57n, ABListError.InvalidMetadata);
    v = v * 10n + (c - 48n);
  }
  return v;
}

/** Offset of the first additional_metadata entry of the mint's TokenMetadata (after authority, mint, name, symbol, uri). */
function additionalMetadata(mint: AccountMeta): u64 {
  const t = extensionOffset(mint, TOKEN_METADATA);
  require(t > 0n, ABListError.InvalidMetadata);
  return skipStr(mint, skipStr(mint, skipStr(mint, t + 64n)));
}

/** Decoded mint mode: 0 Allow, 1 Block, 2 Threshold (with `threshold`), following decode_metadata's early returns. */
function mintMode(mint: AccountMeta): u64 {
  let off = additionalMetadata(mint);
  const count = u64(readData<u32>(mint, off));
  off += 4n;
  let mode: u64 = 0n;
  let threshold: u64 = 0n;
  for (let i = 0n; i < count; i++) {
    const key = off;
    const value = skipStr(mint, key);
    off = skipStr(mint, value);
    if (strIs(mint, key, 2n, 65n, 66n, 0n, 0n, 0n, 0n, 0n, 0n, 0n)) {
      // "AB"
      if (strIs(mint, value, 5n, 65n, 108n, 108n, 111n, 119n, 0n, 0n, 0n, 0n)) return 0n; // Allow
      if (strIs(mint, value, 5n, 66n, 108n, 111n, 99n, 107n, 0n, 0n, 0n, 0n)) return 1n; // Block
      require(strIs(mint, value, 5n, 77n, 105n, 120n, 101n, 100n, 0n, 0n, 0n, 0n), ABListError.InvalidMetadata); // Mixed
      mode = 2n;
      if (threshold > 0n) return 2n;
    } else if (strIs(mint, key, 9n, 116n, 104n, 114n, 101n, 115n, 104n, 111n, 108n, 100n)) {
      // "threshold"
      threshold = parseU64(mint, value);
      if (threshold > 0n) return 2n;
    }
  }
  return mode;
}

/** The Mixed threshold (0 when absent), read the same way. */
function mintThreshold(mint: AccountMeta): u64 {
  let off = additionalMetadata(mint);
  const count = u64(readData<u32>(mint, off));
  off += 4n;
  for (let i = 0n; i < count; i++) {
    const key = off;
    const value = skipStr(mint, key);
    off = skipStr(mint, value);
    if (strIs(mint, key, 9n, 116n, 104n, 114n, 101n, 115n, 104n, 111n, 108n, 100n)) return parseU64(mint, value);
  }
  return 0n;
}

/** has_threshold: whether the metadata holds a "threshold" key. */
function hasThreshold(mint: AccountMeta): boolean {
  if (extensionOffset(mint, TOKEN_METADATA) === 0n) return false;
  let off = additionalMetadata(mint);
  const count = u64(readData<u32>(mint, off));
  off += 4n;
  for (let i = 0n; i < count; i++) {
    const key = off;
    off = skipStr(mint, skipStr(mint, key));
    if (strIs(mint, key, 9n, 116n, 104n, 114n, 101n, 115n, 104n, 111n, 108n, 100n)) return true;
  }
  return false;
}

/** @layout borsh */
export interface InitMintArgs {
  decimals: u8;
  mintAuthority: Pubkey;
  freezeAuthority: Pubkey;
  permanentDelegate: Pubkey;
  transferHookAuthority: Pubkey;
  mode: Mode;
  threshold: u64;
  name: FixedString<200>;
  symbol: FixedString<200>;
  uri: FixedString<200>;
}

/** The "AB" metadata value for a mode. */
function modeName(mode: Mode): string {
  if (mode === Mode.Allow) return "Allow";
  if (mode === Mode.Block) return "Block";
  return "Mixed";
}

export function initMint(
  payer: Mut<Signer>,
  mint: Mut<Signer>,
  extraMetasAccount: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  tokenProgram: Token2022Program,
  args: InitMintArgs,
): void {
  // `init` with mint::* and extensions::*.
  systemProgram.createAccount(payer, mint, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key);
  tokenProgram.initializePermanentDelegate(mint, args.permanentDelegate);
  tokenProgram.initializeTransferHook(mint, args.transferHookAuthority, PROGRAM_ID);
  tokenProgram.initializeMetadataPointer(mint, payer.key, mint.key);
  // The payer as mint authority, a freeze authority.
  tokenProgram.initializeMint2(mint, args.decimals, payer.key, args.freezeAuthority);
  // Token Metadata (metadata = the mint), then the AB mode and, in Mixed mode, the threshold.
  tokenProgram.initializeMetadata(mint, payer, payer, args.name, args.symbol, args.uri);
  tokenProgram.updateMetadataField(mint, payer, "AB", modeName(args.mode));
  if (args.mode === Mode.Mixed) tokenProgram.updateMetadataField(mint, payer, "threshold", `${args.threshold}`);
  const minBalance = rentExempt(mint.dataLen);
  if (minBalance > mint.lamports) systemProgram.transfer(payer, mint, minBalance - mint.lamports);
  initExtraAccountMetas(payer, extraMetasAccount, mint, systemProgram, [
    { seeds: ["ab_wallet", seedAccountData(0n, 32n, 32n)], isSigner: false, isWritable: false },
    { seeds: ["ab_wallet", seedAccountData(2n, 32n, 32n)], isSigner: false, isWritable: false },
  ]);
}

export function initConfig(payer: Mut<Signer>, config: Init<Config>, systemProgram: SystemProgram): void {
  config.bump = config.create(payer, ["config"]);
  config.authority = payer.key;
}

export function attachToMint(
  payer: Mut<Signer>,
  mint: Mut<Mint>,
  extraMetasAccount: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  tokenProgram: Token2022Program,
): void {
  tokenProgram.updateTransferHook(mint, payer, PROGRAM_ID);
  initExtraAccountMetas(payer, extraMetasAccount, mint, systemProgram, [
    { seeds: ["ab_wallet", seedAccountData(0n, 32n, 32n)], isSigner: false, isWritable: false },
    { seeds: ["ab_wallet", seedAccountData(2n, 32n, 32n)], isSigner: false, isWritable: false },
  ]);
}

/** @discriminator spl-transfer-hook-interface:execute */
export function txHook(
  sourceTokenAccount: AccountInfo,
  mint: AccountInfo,
  destinationTokenAccount: AccountInfo,
  ownerDelegate: AccountInfo,
  metaList: AccountInfo,
  sourceAbWallet: AccountInfo,
  destinationAbWallet: AccountInfo,
  amount: u64,
): void {
  require(mint.dataLen > 166n && readData<u8>(mint, 165n) === 1n, ABListError.InvalidMetadata);
  const mode = mintMode(mint);
  // Wallet modes: 0 none (no entry), 1 allowed, 2 blocked.
  let source: u64 = 0n;
  if (sourceAbWallet.dataLen > 0n) {
    const w = loadForeign<ABWallet>(sourceAbWallet, PROGRAM_ID);
    source = w.allowed ? 1n : 2n;
  }
  let destination: u64 = 0n;
  if (destinationAbWallet.dataLen > 0n) {
    const w = loadForeign<ABWallet>(destinationAbWallet, PROGRAM_ID);
    destination = w.allowed ? 1n : 2n;
  }
  // decide()
  require(source !== 2n && destination !== 2n, ABListError.WalletBlocked);
  if (mode === 0n) require(destination === 1n, ABListError.WalletNotAllowed);
  else if (mode === 2n) require(!(destination === 0n && amount >= mintThreshold(mint)), ABListError.AmountNotAllowed);
}

export function initWallet(
  authority: Mut<Signer>,
  config: HasOne<Seeds<Account<Config>, ["config"], "bump">, "authority">,
  wallet: Owner<AccountInfo, "11111111111111111111111111111111">,
  abWallet: Init<ABWallet>,
  systemProgram: SystemProgram,
  args: InitWalletArgs,
): void {
  abWallet.create(authority, ["ab_wallet", wallet.key]);
  abWallet.wallet = wallet.key;
  abWallet.allowed = args.allowed;
}

export function removeWallet(
  authority: Mut<Signer>,
  config: HasOne<Seeds<Account<Config>, ["config"], "bump">, "authority">,
  wallet: Owner<AccountInfo, "11111111111111111111111111111111">,
  abWallet: CloseTo<Seeds<Mut<ABWallet>, ["ab_wallet", "@wallet"]>, "authority">,
  systemProgram: SystemProgram,
): void {}

export function changeMode(authority: Mut<Signer>, mint: Mut<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram, args: ChangeModeArgs): void {
  tokenProgram.updateMetadataField(mint, authority, "AB", modeName(args.mode));
  if (args.mode === Mode.Mixed || hasThreshold(mint)) {
    const threshold = args.mode === Mode.Mixed ? args.threshold : 0n;
    tokenProgram.updateMetadataField(mint, authority, "threshold", `${threshold}`);
  }
  const minBalance = rentExempt(mint.dataLen);
  if (minBalance > mint.lamports) systemProgram.transfer(authority, mint, minBalance - mint.lamports);
}

export function resizeMetaList(
  payer: Mut<Signer>,
  mint: Mint,
  extraMetasAccount: Seeds<Mut<AccountInfo>, ["extra-account-metas", "@mint"]>,
  systemProgram: SystemProgram,
  tokenProgram: Token2022Program,
): void {
  require(transferHookProgram(mint) === PROGRAM_ID, ABListError.MintNotUsingThisHook);
  updateExtraAccountMetas(payer, extraMetasAccount, mint, systemProgram, [
    { seeds: ["ab_wallet", seedAccountData(0n, 32n, 32n)], isSigner: false, isWritable: false },
    { seeds: ["ab_wallet", seedAccountData(2n, 32n, 32n)], isSigner: false, isWritable: false },
  ]);
}
