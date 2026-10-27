// Bubblegum V2 compressed NFTs through a program-owned authority PDA ["studio"]: a tree, mints (plain and into a
// Metaplex Core collection), and transfers / burns that pass the leaf and its Merkle proof through.
import {
  type Account,
  type AccountInfo,
  type BubblegumProgram,
  type Hash,
  type Init,
  type MplCoreProgram,
  type Mut,
  type Signer,
  type SystemProgram,
  type u8,
  type u32,
  type u64,
  remainingAccounts,
} from "typesol";

export interface Studio {
  bump: u8;
}

export function setup(payer: Mut<Signer>, studio: Init<Studio>, systemProgram: SystemProgram): void {
  studio.bump = studio.create(payer, ["studio"]);
}

export function makeTree(treeConfig: Mut<AccountInfo>, merkleTree: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram): void {
  bubblegum.createTreeV2(treeConfig, merkleTree, payer, studio, logWrapper, compression, systemProgram, 3n, 8n, false, ["studio", studio.bump]);
}

export function mint(treeConfig: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, core: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, name: string): void {
  bubblegum.mintV2(treeConfig, payer, studio, owner, null, merkleTree, logWrapper, compression, core, systemProgram, {
    name,
    symbol: "CN",
    uri: "https://example.com/n.json",
    sellerFeeBasisPoints: 500n,
    creators: [{ address: studio.key, verified: false, share: 100n }],
  }, ["studio", studio.bump]);
}

/** A Core collection the studio manages, with the BubblegumV2 plugin so compressed NFTs can join it. */
export function makeCollection(collection: Mut<Signer>, studio: Mut<AccountInfo>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createCollection(collection, studio, payer, systemProgram, "cNFTs", "https://example.com/c.json", [{ kind: "BubblegumV2" }]);
}

export function mintIntoCollection(treeConfig: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, collection: Mut<AccountInfo>, cpiSigner: AccountInfo, logWrapper: AccountInfo, compression: AccountInfo, core: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram): void {
  bubblegum.mintV2(treeConfig, payer, studio, owner, null, merkleTree, logWrapper, compression, core, systemProgram, {
    name: "Member",
    symbol: "CN",
    uri: "https://example.com/m.json",
    sellerFeeBasisPoints: 0n,
  }, { collection, authority: studio, cpiSigner }, ["studio", studio.bump]);
}

/** The owner moves a leaf; the proof is every remaining account. */
export function give(treeConfig: Mut<AccountInfo>, owner: Mut<Signer>, to: AccountInfo, merkleTree: Mut<AccountInfo>, collection: AccountInfo | null, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, assetDataHash: Hash | null, nonce: u64, index: u32): void {
  bubblegum.transferV2(treeConfig, owner, null, owner, null, to, merkleTree, collection, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, assetDataHash, nonce, index }, remainingAccounts());
}

export function burn(treeConfig: Mut<AccountInfo>, owner: Mut<Signer>, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, core: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, nonce: u64, index: u32): void {
  const proof = remainingAccounts();
  bubblegum.burnV2(treeConfig, owner, null, owner, null, merkleTree, null, null, logWrapper, compression, core, systemProgram, { root, dataHash, creatorHash, nonce, index, flags: 0n }, proof.slice(0n));
}
