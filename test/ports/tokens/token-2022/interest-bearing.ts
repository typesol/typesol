// Port of tokens/token-2022/interest-bearing @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - check_mint_data finds InterestBearingConfig by walking the TLV list with readData and requires its rate authority
//    to be the signer: a mismatch fails with this program's error (6000) where the original panics in `assert_eq!`.
//    The original also logs the extension with `{:?}`.
import {
  type AccountMeta,
  type Mint,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type i16,
  type u16,
  readData,
  rentExempt,
  require,
  u64,
} from "typesol";

/** Base mint (padded to 165) + account type (1) + InterestBearingConfig TLV (2 + 2 + 52). */
const MINT_SIZE_INTEREST_BEARING = 222n;
const INTEREST_BEARING_CONFIG: u16 = 10n;

export enum InterestError {
  WrongRateAuthority = "The mint's rate authority is not the signer",
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

function checkMintData(mintAccount: AccountMeta, authority: Pubkey): void {
  const at = extensionOffset(mintAccount, INTEREST_BEARING_CONFIG);
  require(at > 0n && readData<Pubkey>(mintAccount, at) === authority, InterestError.WrongRateAuthority);
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram, rate: i16): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_SIZE_INTEREST_BEARING), MINT_SIZE_INTEREST_BEARING, tokenProgram.key);
  tokenProgram.initializeInterestBearingMint(mintAccount, payer.key, rate);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, payer.key);
  checkMintData(mintAccount, payer.key);
}

export function updateRate(authority: Mut<Signer>, mintAccount: Mut<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram, rate: i16): void {
  tokenProgram.updateInterestRate(mintAccount, authority, rate);
  checkMintData(mintAccount, authority.key);
}
