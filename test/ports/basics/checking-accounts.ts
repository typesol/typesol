// Port of basics/checking-accounts @ de09019; see test/ports/README.md.
//
// PORTED. All the checks are declared on the parameters, as in the Anchor accounts struct.
import { type AccountInfo, type Mut, type Owner, type Signer, type SystemProgram } from "typesol";

export function checkAccounts(
  payer: Signer,
  accountToCreate: Mut<AccountInfo>,
  /** `owner = id()`: this program's declared address. */
  accountToChange: Owner<Mut<AccountInfo>, "ECWPhR3rJbaPfyNFgphnjxSEexbTArc7vxD8fnW6tgKw">,
  systemProgram: SystemProgram,
): void {}
