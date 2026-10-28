// Metaplex Core plugin values added after #48: royalty rule sets, MasterEdition, VerifiedCreators, Autograph,
// FreezeExecute / PermanentFreezeExecute.
import { type MplCoreProgram, type Mut, type Signer, type SystemProgram } from "typesol";

export function ruled(asset: Mut<Signer>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createAsset(asset, null, null, payer, null, systemProgram, "Ruled", "https://example.com/r.json", [
    { kind: "Royalties", basisPoints: 300n, creators: [{ address: payer.key, percentage: 100n }], ruleSet: { programDenyList: [core.key] } },
    { kind: "VerifiedCreators", signatures: [{ address: payer.key, verified: true }] },
    { kind: "Autograph", signatures: [{ address: payer.key, message: "first!" }] },
  ]);
}

export function edition(collection: Mut<Signer>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createCollection(collection, null, payer, systemProgram, "Gen", "https://example.com/g.json", [
    { kind: "MasterEdition", maxSupply: 10n, name: "Genesis", uri: null },
  ]);
}

export function execFrozen(asset: Mut<Signer>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createAsset(asset, null, null, payer, null, systemProgram, "Locked", "https://example.com/l.json", [{ kind: "PermanentFreezeExecute", frozen: true }]);
}
