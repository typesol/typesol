import { type AccountInfo, type Pubkey, type u8, type u64, findProgramAddress, requirePda } from "typesol";

/** The canonical PDA of [seedA, seedB, seedN] under `program` (TypeSOL's own derivation, compared with the syscall's). */
export function derive(seedA: string, seedB: Pubkey, seedN: u64, program: Pubkey): Pubkey {
  return findProgramAddress([seedA, seedB, seedN], program);
}

/** create_program_address([seedA, bump]) must equal `target` (any off-curve bump, as the syscall accepts). */
export function check(target: AccountInfo, seedA: string, bump: u8): void {
  requirePda(target, [seedA], bump);
}

/** 15 seeds: the most a bump search takes. */
export function mostSeeds(program: Pubkey): Pubkey {
  return findProgramAddress(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"], program);
}
