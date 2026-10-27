// Port of tokens/token-2022/mint-close-authority @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gaps): TypeSOL has no Token-2022 extension initializers and its closeAccount takes a TokenAccount,
// so InitializeMintCloseAuthority and CloseAccount (of a mint) are hand-encoded (`invoke`). Anchor's
// `extensions::close_authority::authority` init/constraint become those calls plus mintCloseAuthority() checks; the
// mint is created like Anchor's `init` does (CreateAccount sized for the extension, extension, InitializeMint2).
import {
  type Mint,
  type Mut,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  invoke,
  mintCloseAuthority,
  readonlySigner,
  rentExempt,
  require,
  u8,
  writable,
} from "typesol";

/** Base mint (padded to 165) + account type + MintCloseAuthority TLV (2 + 2 + 32). */
const MINT_WITH_CLOSE_AUTHORITY = 202n;

export enum MintCloseAuthorityError {
  WrongCloseAuthority = "The mint's close authority is not the expected one",
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_WITH_CLOSE_AUTHORITY), MINT_WITH_CLOSE_AUTHORITY, tokenProgram.key);
  // InitializeMintCloseAuthority (instruction 25) with Some(payer).
  invoke(tokenProgram, [writable(mintAccount)], [u8(25n), u8(1n), payer.key]);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, null);
  require(mintCloseAuthority(mintAccount) === payer.key, MintCloseAuthorityError.WrongCloseAuthority);
}

export function close(authority: Mut<Signer>, mintAccount: Mut<Mint>, tokenProgram: Token2022Program): void {
  require(mintCloseAuthority(mintAccount) === authority.key, MintCloseAuthorityError.WrongCloseAuthority);
  // CloseAccount (instruction 9) of the mint, rent to the authority.
  invoke(tokenProgram, [writable(mintAccount), writable(authority), readonlySigner(authority)], [u8(9n)]);
}
