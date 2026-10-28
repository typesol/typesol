// Port of tokens/token-2022/mint-close-authority @ de09019; see test/ports/README.md.
//
// PORTED: `init` with `extensions::close_authority::authority` is `mint.create(…, { closeAuthority })`, the constraint a
// mintCloseAuthority() check, and closeAccount closes the mint.
import { type Init, type Mint, type Mut, type Signer, type SystemProgram, type Token2022Program, mintCloseAuthority, require } from "typesol";

export enum MintCloseAuthorityError {
  WrongCloseAuthority = "The mint's close authority is not the expected one",
}

export function initialize(payer: Mut<Signer>, mintAccount: Init<Mint>, tokenProgram: Token2022Program, systemProgram: SystemProgram): void {
  mintAccount.create(payer, null, 2n, payer.key, null, { closeAuthority: payer.key });
  require(mintCloseAuthority(mintAccount) === payer.key, MintCloseAuthorityError.WrongCloseAuthority);
}

export function close(authority: Mut<Signer>, mintAccount: Mut<Mint>, tokenProgram: Token2022Program): void {
  require(mintCloseAuthority(mintAccount) === authority.key, MintCloseAuthorityError.WrongCloseAuthority);
  tokenProgram.closeAccount(mintAccount, authority, authority);
}
