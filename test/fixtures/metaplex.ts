// Metaplex Core assets and Bubblegum compressed NFTs through a program-owned authority PDA ["studio"].
import {
  type Account,
  type AccountInfo,
  type BubblegumProgram,
  type Init,
  type MplCoreProgram,
  type Mut,
  type Signer,
  type SystemProgram,
  type u8,
  coreAssetCollection,
  coreAssetOwner,
  require,
} from "typesol";

export interface Studio {
  bump: u8;
}

export function setup(payer: Mut<Signer>, studio: Init<Studio>, systemProgram: SystemProgram): void {
  studio.bump = studio.create(payer, ["studio"]);
}

/** A collection whose update authority is the studio PDA. */
export function makeCollection(collection: Mut<Signer>, studio: Mut<AccountInfo>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createCollection(collection, studio, payer, systemProgram, "Studio", "https://example.com/c.json");
}

/** An asset in the collection, owned by `owner`; the studio signs as the collection's authority. */
export function mintAsset(asset: Mut<Signer>, collection: Mut<AccountInfo>, studio: Account<Studio>, payer: Mut<Signer>, owner: AccountInfo, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createAsset(asset, collection, studio, payer, owner, systemProgram, "Piece #1", "https://example.com/1.json", ["studio", studio.bump]);
  require(coreAssetOwner(asset) === owner.key, "owner");
  require(coreAssetCollection(asset) === collection.key, "collection");
}

/** The current owner gives the asset away. */
export function give(asset: Mut<AccountInfo>, collection: AccountInfo, owner: Mut<Signer>, to: AccountInfo, core: MplCoreProgram): void {
  core.transferAsset(asset, collection, owner, null, to);
  require(coreAssetOwner(asset) === to.key, "moved");
}

export function burn(asset: Mut<AccountInfo>, collection: Mut<AccountInfo>, owner: Mut<Signer>, core: MplCoreProgram): void {
  core.burnAsset(asset, collection, owner, null);
}

/** A compressed-NFT tree whose creator (and so minter) is the studio PDA. */
export function makeTree(treeConfig: Mut<AccountInfo>, merkleTree: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram): void {
  bubblegum.createTree(treeConfig, merkleTree, payer, studio, logWrapper, compression, systemProgram, 3n, 8n, false, ["studio", studio.bump]);
}

export function mintCompressed(treeConfig: Mut<AccountInfo>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram): void {
  bubblegum.mint(treeConfig, owner, owner, merkleTree, payer, studio, logWrapper, compression, systemProgram, "cNFT", "CN", "https://example.com/n.json", 500n, ["studio", studio.bump]);
}


/** An asset created with plugins: royalties to the studio, attributes, and a permanent freeze the studio controls. */
export function mintWithPlugins(asset: Mut<Signer>, studio: Account<Studio>, payer: Mut<Signer>, owner: AccountInfo, core: MplCoreProgram, systemProgram: SystemProgram, level: string): void {
  core.createAsset(asset, null, null, payer, owner, systemProgram, "Plugged", "https://example.com/p.json", [
    { kind: "Royalties", basisPoints: 500n, creators: [{ address: studio.key, percentage: 100n }] },
    { kind: "Attributes", attributes: [{ key: "level", value: level }] },
    { kind: "PermanentFreezeDelegate", frozen: false, authority: studio.key },
  ]);
}

/** The studio (the permanent freeze delegate) freezes or thaws the asset. */
export function studioFreeze(asset: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, core: MplCoreProgram, systemProgram: SystemProgram, frozen: boolean): void {
  core.updatePlugin(asset, null, payer, studio, systemProgram, { kind: "PermanentFreezeDelegate", frozen }, ["studio", studio.bump]);
}

/** The owner adds a freeze delegate (frozen), thaws it and removes it again, all in one instruction when `cycle`. */
export function ownerFreeze(asset: Mut<AccountInfo>, owner: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram, cycle: boolean): void {
  core.addPlugin(asset, null, owner, null, systemProgram, { kind: "FreezeDelegate", frozen: true, authority: "owner" });
  if (cycle) {
    core.updatePlugin(asset, null, owner, null, systemProgram, { kind: "FreezeDelegate", frozen: false });
    core.removePlugin(asset, null, owner, null, systemProgram, "FreezeDelegate");
  }
}

/** A collection with royalties for every asset, then an attributes plugin added and removed by its update authority. */
export function pluginCollection(collection: Mut<Signer>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createCollection(collection, null, payer, systemProgram, "Plugged", "https://example.com/pc.json", [
    { kind: "Royalties", basisPoints: 250n, creators: [{ address: payer.key, percentage: 100n }] },
  ]);
  core.addCollectionPlugin(collection, payer, null, systemProgram, { kind: "Attributes", attributes: [{ key: "season", value: "1" }] });
  core.updateCollectionPlugin(collection, payer, null, systemProgram, { kind: "Attributes", attributes: [{ key: "season", value: "2" }] });
}

export function dropCollectionAttributes(collection: Mut<AccountInfo>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.removeCollectionPlugin(collection, payer, null, systemProgram, "Attributes");
}

export function ownerThaw(asset: Mut<AccountInfo>, owner: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.updatePlugin(asset, null, owner, null, systemProgram, { kind: "FreezeDelegate", frozen: false });
}
