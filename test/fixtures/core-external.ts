// Metaplex Core external plugin adapters: AppData written by its data authority, an Oracle, a LifecycleHook.
import { type AccountInfo, type MplCoreProgram, type Mut, type Signer, type SystemProgram, type Vec, type u8 } from "typesol";

export function withAppData(asset: Mut<Signer>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createAsset(asset, null, null, payer, null, systemProgram, "Scored", "https://example.com/s.json");
  core.addExternalPlugin(asset, null, payer, null, systemProgram, { kind: "AppData", dataAuthority: payer.key, schema: "json" });
  core.writeExternalPluginData(asset, null, payer, null, systemProgram, { kind: "AppData", dataAuthority: payer.key }, '{"score":7}');
}

export function writeBytes(asset: Mut<AccountInfo>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram, data: Vec<u8>): void {
  core.writeExternalPluginData(asset, null, payer, null, systemProgram, { kind: "AppData", dataAuthority: payer.key }, data);
}

export function withOracle(asset: Mut<Signer>, payer: Mut<Signer>, oracle: AccountInfo, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createAsset(asset, null, null, payer, null, systemProgram, "Guarded", "https://example.com/g.json");
  core.addExternalPlugin(asset, null, payer, null, systemProgram, {
    kind: "Oracle",
    baseAddress: oracle.key,
    checks: [{ event: "transfer", canReject: true }],
    resultsOffset: "anchor",
  });
}

export function dropOracle(asset: Mut<AccountInfo>, payer: Mut<Signer>, oracle: AccountInfo, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.removeExternalPlugin(asset, null, payer, null, systemProgram, { kind: "Oracle", address: oracle.key });
}

export function withHook(asset: Mut<Signer>, payer: Mut<Signer>, hook: AccountInfo, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createAsset(asset, null, null, payer, null, systemProgram, "Hooked", "https://example.com/h.json");
  core.addExternalPlugin(asset, null, payer, null, systemProgram, {
    kind: "LifecycleHook",
    hookedProgram: hook.key,
    checks: [{ event: "transfer", canListen: true }],
    extraAccounts: [{ kind: "owner" }, { kind: "address", address: payer.key, isWritable: false }],
    dataAuthority: "updateAuthority",
    schema: "binary",
  });
}

export function collectionData(collection: Mut<Signer>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createCollection(collection, null, payer, systemProgram, "Shelf", "https://example.com/c.json");
  core.addCollectionExternalPlugin(collection, payer, null, systemProgram, { kind: "AppData", dataAuthority: payer.key, schema: "binary" });
  core.writeCollectionExternalPluginData(collection, payer, null, systemProgram, { kind: "AppData", dataAuthority: payer.key }, "collection-data");
}

export function clearCollectionData(collection: Mut<AccountInfo>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.removeCollectionExternalPlugin(collection, payer, null, systemProgram, { kind: "AppData", dataAuthority: payer.key });
}
