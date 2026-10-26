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

