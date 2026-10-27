// Port of tokens/merkle-tree-token-claimer @ de09019; see test/ports/README.md.
//
// PARTIAL (builtin gaps, same interface and account layout):
//  - the proof is a flat `hashes: Vec<u8>`. TypeSOL cannot slice bytes into a Hash (and sha256 takes at most 16
//    parts), so each 32-byte sibling is packed into four little-endian u64 words, which sha256 hashes as the same
//    32 bytes.
//  - the mint (a keypair `init`) is created in the body, where it is an AccountInfo to TypeSOL, so the vault ATA is
//    created with createIdempotent and MintTo into it is hand-encoded (`invoke`). The claimer's ATA is
//    Ata<InitIfNeeded<TokenAccount>, …>; SetAuthority and the rest are typed.
// The `[u8; 32]` root is a Hash (the same 32 bytes in the account and in instruction data).
import {
  type AccountMeta,
  type AssociatedTokenProgram,
  type Ata,
  type Hash,
  type HasOne,
  type Init,
  type InitIfNeeded,
  type Mint,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenProgram,
  type Vec,
  AuthorityType,
  MINT_SIZE,
  invoke,
  pubkey,
  readonly,
  readonlySigner,
  rentExempt,
  require,
  sha256,
  u64,
  u8,
  writable,
} from "typesol";

const DEFAULT_PUBKEY = pubkey("11111111111111111111111111111111");
const U64_MAX: u64 = 18446744073709551615n;

export interface AirdropState {
  merkleRoot: Hash;
  authority: Pubkey;
  mint: Pubkey;
  airdropAmount: u64;
  amountClaimed: u64;
  bump: u8;
}

export interface ClaimReceipt {
  airdropState: Pubkey;
  claimer: Pubkey;
  index: u64;
  amount: u64;
  bump: u8;
}

export enum ClaimError {
  InvalidProof = "Invalid Merkle proof",
  AlreadyClaimed = "This claim has already been processed",
  AmountOverflow = "Amount overflow",
  ClaimExceedsAirdrop = "The requested claim would exceed the initialized airdrop amount",
  ClaimsStarted = "The Merkle tree can only be updated before any claims are processed",
  InvalidAmount = "Claim amount must be greater than zero",
}

/** proof[o..o+8] as a little-endian u64: hashing it as a u64 part hashes exactly those 8 bytes. */
function word(proof: Vec<u8>, o: u64): u64 {
  let v = 0n;
  for (let i = 0n; i < 8n; i++) v |= u64(proof.get(o + i)) << (8n * i);
  return v;
}

/** sha256(current || proof[o..o+32]) */
function hashRight(current: Hash, proof: Vec<u8>, o: u64): Hash {
  return sha256(current, word(proof, o), word(proof, o + 8n), word(proof, o + 16n), word(proof, o + 24n));
}

/** sha256(proof[o..o+32] || current) */
function hashLeft(current: Hash, proof: Vec<u8>, o: u64): Hash {
  return sha256(word(proof, o), word(proof, o + 8n), word(proof, o + 16n), word(proof, o + 24n), current);
}

/** Walk the proof from the leaf sha256(claimer || amount) up; `index` picks the side at each level. */
function computeRoot(claimer: Pubkey, amount: u64, proof: Vec<u8>, index: u64): Hash {
  require(proof.length % 32n === 0n, ClaimError.InvalidProof);
  let current = sha256(claimer, amount);
  let idx = index;
  for (let o = 0n; o < proof.length; o += 32n) {
    current = idx % 2n === 0n ? hashRight(current, proof, o) : hashLeft(current, proof, o);
    idx /= 2n;
  }
  require(idx === 0n, ClaimError.InvalidProof);
  return current;
}

export function initializeAirdropData(
  airdropState: Init<AirdropState>,
  mint: Mut<Signer>,
  vault: Ata<Mut<AccountMeta>, "airdropState", "mint">,
  authority: Mut<Signer>,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  merkleRoot: Hash,
  amount: u64,
): void {
  airdropState.bump = airdropState.create(authority, ["merkle_tree", mint.key]);
  systemProgram.createAccount(authority, mint, rentExempt(MINT_SIZE), MINT_SIZE, tokenProgram.key);
  tokenProgram.initializeMint2(mint, 6n, authority.key, null);
  associatedTokenProgram.createIdempotent(authority, vault, airdropState, mint, systemProgram, tokenProgram);
  require(amount > 0n, ClaimError.InvalidAmount);
  airdropState.merkleRoot = merkleRoot;
  airdropState.authority = authority.key;
  airdropState.mint = mint.key;
  airdropState.airdropAmount = amount;
  airdropState.amountClaimed = 0n;
  // SPL Token MintTo (instruction 7) into the new vault, then drop the mint authority for good.
  invoke(tokenProgram, [writable(mint), writable(vault), readonlySigner(authority)], [u8(7n), amount]);
  tokenProgram.setAuthority(mint, authority, AuthorityType.MintTokens, null);
}

export function updateTree(
  airdropState: HasOne<Seeds<Mut<AirdropState>, ["merkle_tree", "@mint"], "bump">, "authority" | "mint">,
  mint: Mint,
  authority: Signer,
  newRoot: Hash,
): void {
  require(airdropState.amountClaimed === 0n, ClaimError.ClaimsStarted);
  airdropState.merkleRoot = newRoot;
}

export function claimAirdrop(
  airdropState: HasOne<Seeds<Mut<AirdropState>, ["merkle_tree", "@mint"], "bump">, "mint">,
  mint: Mint,
  vault: Ata<Mut<TokenAccount>, "airdropState", "mint">,
  claimReceipt: InitIfNeeded<ClaimReceipt>,
  signerAta: Ata<InitIfNeeded<TokenAccount>, "signer", "mint">,
  signer: Mut<Signer>,
  systemProgram: SystemProgram,
  tokenProgram: TokenProgram,
  associatedTokenProgram: AssociatedTokenProgram,
  amount: u64,
  hashes: Vec<u8>,
  index: u64,
): void {
  claimReceipt.createIfNeeded(signer, ["claim_receipt", airdropState.key, index]);
  signerAta.createIfNeeded(signer);
  require(amount > 0n, ClaimError.InvalidAmount);
  require(claimReceipt.claimer === DEFAULT_PUBKEY, ClaimError.AlreadyClaimed);
  require(computeRoot(signer.key, amount, hashes, index) === airdropState.merkleRoot, ClaimError.InvalidProof);
  require(amount <= U64_MAX - airdropState.amountClaimed, ClaimError.AmountOverflow);
  const newAmountClaimed = airdropState.amountClaimed + amount;
  require(newAmountClaimed <= airdropState.airdropAmount, ClaimError.ClaimExceedsAirdrop);
  tokenProgram.transferChecked(vault, mint, signerAta, airdropState, amount, ["merkle_tree", mint.key, airdropState.bump]);
  claimReceipt.airdropState = airdropState.key;
  claimReceipt.claimer = signer.key;
  claimReceipt.index = index;
  claimReceipt.amount = amount;
  claimReceipt.bump = claimReceipt.pdaBump;
  airdropState.amountClaimed = newAmountClaimed;
}
