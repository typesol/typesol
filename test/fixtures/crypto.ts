import {
  type Hash,
  type Init,
  type InstructionsSysvar,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type u8,
  type u64,
  type Vec,
  keccak256,
  log,
  merkleVerify,
  require,
  sha256,
  verifyEd25519,
  verifySecp256k1,
  ethMessageHash,
} from "typesol";

/** A Merkle airdrop claim book plus signature and hashing checks. */
export interface Drop {
  root: Hash;
  claimed: u64;
}

export function setup(payer: Mut<Signer>, drop: Init<Drop>, systemProgram: SystemProgram, root: Hash): void {
  drop.create(payer, ["drop", payer.key]);
  drop.root = root;
}

/** leaf = keccak256(claimer, amount) */
export function claim(claimer: Signer, drop: Mut<Drop>, amount: u64, proof: Vec<Hash>): void {
  const leaf = keccak256(claimer.key, amount);
  require(merkleVerify(leaf, proof, drop.root), "invalid proof");
  drop.claimed += amount;
}

export function hashes(text: string, n: u64): Hash {
  const a = sha256(text, n, true);
  log(a);
  return keccak256("typesol", a);
}

/** Accept an action only if an off-chain key signed "allow:<who>:<amount>" (checked through the Ed25519 precompile). */
export function signedAction(instructions: InstructionsSysvar, authority: Pubkey, who: Pubkey, amount: u64): void {
  const message = `allow:${amount}`;
  require(verifyEd25519(instructions, authority, message), "missing or wrong signature");
  log(message);
}

/** The signer of keccak256(message) must be `ethAddress` (the hash is computed here, never taken as input). */
export function ethSigned(message: string, recoveryId: u8, r: Hash, s: Hash, ethAddress: Hash): boolean {
  return verifySecp256k1(keccak256(message), recoveryId, r, s, ethAddress);
}

/** A MetaMask personal_sign signature over `message`. */
export function ethPersonal(message: string, recoveryId: u8, r: Hash, s: Hash, ethAddress: Hash): boolean {
  return verifySecp256k1(ethMessageHash(message), recoveryId, r, s, ethAddress);
}

export function greet(name: string, n: u64): void {
  const s = "hello, " + name + "! you are #" + `${n}`;
  log(s);
  require(s === "hello, sol! you are #7", "bad concat");
}
