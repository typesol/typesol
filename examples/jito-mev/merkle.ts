// The Merkle proofs of Jito's distribution programs (merkle_proof.rs of jito-foundation/jito-programs): sha256, sorted
// pairs, a 0x00 prefix on leaves and 0x01 on inner nodes (so a leaf can never pass for an inner node).
import { type Hash, type Pubkey, type Vec, type u64, sha256, u8 } from "typesol";

/** A claim's leaf: sha256(0x00 || sha256(claimant || amount as u64 little-endian)). */
export function claimLeaf(claimant: Pubkey, amount: u64): Hash {
  return sha256(u8(0n), sha256(claimant, amount));
}

/** merkle_proof::verify. */
export function verifyProof(proof: Vec<Hash>, root: Hash, leaf: Hash): boolean {
  let node = leaf;
  for (let i = 0n; i < proof.length; i++) {
    const sibling = proof.get(i);
    node = node.compare(sibling) <= 0n ? sha256(u8(1n), node, sibling) : sha256(u8(1n), sibling, node);
  }
  return node.equals(root);
}
