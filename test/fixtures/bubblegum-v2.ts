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

/** The studio (a creator of the leaf) verifies itself: signed with its seeds. */
export function verifyStudio(treeConfig: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, nonce: u64, index: u32, name: string): void {
  bubblegum.verifyCreatorV2(treeConfig, payer, studio, owner, null, merkleTree, logWrapper, compression, systemProgram, { root, nonce, index }, {
    name,
    symbol: "CN",
    uri: "https://example.com/n.json",
    sellerFeeBasisPoints: 500n,
    creators: [{ address: studio.key, verified: false, share: 100n }],
  }, remainingAccounts(), ["studio", studio.bump]);
}

export function delegateTo(treeConfig: Mut<AccountInfo>, owner: Mut<Signer>, delegate: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, collectionHash: Hash | null, nonce: u64, index: u32): void {
  bubblegum.delegateV2(treeConfig, owner, null, null, delegate, merkleTree, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, collectionHash, nonce, index }, remainingAccounts());
}

/** The leaf delegate freezes (or thaws) the leaf. */
export function freeze(treeConfig: Mut<AccountInfo>, delegate: Mut<Signer>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, nonce: u64, index: u32, frozen: boolean, flags: u8): void {
  if (frozen) bubblegum.freezeV2(treeConfig, delegate, null, owner, delegate, merkleTree, null, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, flags, nonce, index }, remainingAccounts());
  else bubblegum.thawV2(treeConfig, delegate, null, owner, delegate, merkleTree, null, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, flags, nonce, index }, remainingAccounts());
}

/** The tree creator (the studio) renames the leaf. */
export function rename(treeConfig: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, owner: AccountInfo, delegate: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, nonce: u64, index: u32, name: string, newName: string): void {
  bubblegum.updateMetadataV2(treeConfig, payer, studio, owner, delegate, merkleTree, null, logWrapper, compression, systemProgram, { root, nonce, index }, {
    name,
    symbol: "CN",
    uri: "https://example.com/n.json",
    sellerFeeBasisPoints: 500n,
    creators: [{ address: studio.key, verified: true, share: 100n }],
  }, { name: newName }, remainingAccounts(), ["studio", studio.bump]);
}

/** V1 trees: the studio PDA (owner and delegate of the leaf) transfers it, signing with its seeds. */
export function giveV1(treeConfig: AccountInfo, studio: Account<Studio>, to: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, nonce: u64, index: u32): void {
  bubblegum.transfer(treeConfig, studio, studio, to, merkleTree, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, nonce, index }, remainingAccounts(), ["studio", studio.bump]);
}

export function delegateV1(treeConfig: AccountInfo, owner: Signer, delegate: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, nonce: u64, index: u32): void {
  bubblegum.delegate(treeConfig, owner, owner, delegate, merkleTree, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, nonce, index }, remainingAccounts());
}

/** The leaf delegate burns it. */
export function burnV1(treeConfig: AccountInfo, owner: AccountInfo, delegate: Signer, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, nonce: u64, index: u32): void {
  bubblegum.burn(treeConfig, owner, delegate, merkleTree, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, nonce, index }, remainingAccounts());
}

export function unverifyStudio(treeConfig: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, nonce: u64, index: u32, name: string): void {
  bubblegum.unverifyCreatorV2(treeConfig, payer, studio, owner, null, merkleTree, logWrapper, compression, systemProgram, { root, nonce, index }, {
    name,
    symbol: "CN",
    uri: "https://example.com/n.json",
    sellerFeeBasisPoints: 500n,
    creators: [{ address: studio.key, verified: true, share: 100n }],
  }, remainingAccounts(), ["studio", studio.bump]);
}

/** A collection the studio manages with BubblegumV2 and a permanent freeze delegate (the studio). */
export function makeSoulCollection(collection: Mut<Signer>, studio: Mut<AccountInfo>, payer: Mut<Signer>, core: MplCoreProgram, systemProgram: SystemProgram): void {
  core.createCollection(collection, studio, payer, systemProgram, "Souls", "https://example.com/s.json", [
    { kind: "BubblegumV2" },
    { kind: "PermanentFreezeDelegate", frozen: false, authority: studio.key },
  ]);
}

/** The collection's permanent freeze delegate makes the leaf soulbound. */
export function soulbind(treeConfig: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, collection: AccountInfo, logWrapper: AccountInfo, compression: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, dataHash: Hash, creatorHash: Hash, nonce: u64, index: u32): void {
  bubblegum.setNonTransferableV2(treeConfig, payer, studio, owner, null, merkleTree, collection, logWrapper, compression, systemProgram, { root, dataHash, creatorHash, nonce, index }, remainingAccounts(), ["studio", studio.bump]);
}

/** Move a leaf that has no collection into one (the studio is the tree creator and the collection's authority). */
export function moveInto(treeConfig: Mut<AccountInfo>, payer: Mut<Signer>, studio: Account<Studio>, owner: AccountInfo, merkleTree: Mut<AccountInfo>, collection: Mut<AccountInfo>, cpiSigner: AccountInfo, logWrapper: AccountInfo, compression: AccountInfo, core: AccountInfo, bubblegum: BubblegumProgram, systemProgram: SystemProgram, root: Hash, nonce: u64, index: u32, name: string): void {
  bubblegum.setCollectionV2(treeConfig, payer, studio, studio, owner, null, merkleTree, null, collection, cpiSigner, logWrapper, compression, core, systemProgram, { root, nonce, index }, {
    name,
    symbol: "CN",
    uri: "https://example.com/n.json",
    sellerFeeBasisPoints: 500n,
    creators: [{ address: studio.key, verified: false, share: 100n }],
  }, remainingAccounts(), ["studio", studio.bump]);
}
