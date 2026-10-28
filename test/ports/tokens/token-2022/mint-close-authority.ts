// Port of tokens/token-2022/mint-close-authority @ de09019; see test/ports/README.md.
//
// PORTED: Anchor's `extensions::close_authority::authority` init / constraint are initializeMintCloseAuthority and
// mintCloseAuthority() checks; the mint is created as Anchor's `init` does (CreateAccount sized for the extension,
// the extension, InitializeMint2), and closeAccount closes the mint.
import { type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, mintCloseAuthority, rentExempt, require } from "typesol";

/** Base mint (padded to 165) + account type + MintCloseAuthority TLV (2 + 2 + 32). */
const MINT_WITH_CLOSE_AUTHORITY = 202n;

export enum MintCloseAuthorityError {
  WrongCloseAuthority = "The mint's close authority is not the expected one",
}

export function initialize(payer: Mut<Signer>, mintAccount: Mut<Signer>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  systemProgram.createAccount(payer, mintAccount, rentExempt(MINT_WITH_CLOSE_AUTHORITY), MINT_WITH_CLOSE_AUTHORITY, tokenProgram.key);
  tokenProgram.initializeMintCloseAuthority(mintAccount, payer.key);
  tokenProgram.initializeMint2(mintAccount, 2n, payer.key, null);
  require(mintCloseAuthority(mintAccount) === payer.key, MintCloseAuthorityError.WrongCloseAuthority);
}

export function close(authority: Mut<Signer>, mintAccount: Mut<Mint>, tokenProgram: Token2022Program): void {
  require(mintCloseAuthority(mintAccount) === authority.key, MintCloseAuthorityError.WrongCloseAuthority);
  tokenProgram.closeAccount(mintAccount, authority, authority);
}
