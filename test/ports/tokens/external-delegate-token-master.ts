// Port of tokens/external-delegate-token-master @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - account layout / interface: there is no conversion between byte arrays and the 32-byte Hash that
//    verifySecp256k1 compares, so `ethereum_address` is stored (and passed to `set_ethereum_address`) as a Hash
//    holding the 20-byte address left-padded with 12 zero bytes, instead of `[u8; 20]`.
//    `signature: [u8; 65]` is taken as `r: Hash, s: Hash, recovery_id: u8` (the same 65 bytes on the wire).
//  - TypeSOL refuses high-s secp256k1 signatures (stricter than the raw secp256k1_recover syscall).
import {
  type AccountInfo,
  type Account,
  type Hash,
  type HasOne,
  type Init,
  type Mut,
  type Owner,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type TokenAccount,
  type TokenProgram,
  type u8,
  type u64,
  keccak256,
  pubkey,
  require,
  verifySecp256k1,
} from "typesol";

const PROGRAM_ID = pubkey("FYPkt5VWMvtyWZDMGCwoKFkE3wXTzphicTpnNGuHWVbD");
const TRANSFER_DOMAIN = "external-delegate-token-master:transfer_tokens:v1";
const U64_MAX: u64 = 18446744073709551615n;

export interface UserAccount {
  authority: Pubkey;
  /** The Ethereum address, left-padded to 32 bytes. */
  ethereumAddress: Hash;
  nonce: u64;
}

export enum ErrorCode {
  InvalidSignature = "Invalid Ethereum signature",
  NonceOverflow = "Nonce overflow",
}

export function initialize(userAccount: Init<UserAccount>, authority: Mut<Signer>, systemProgram: SystemProgram): void {
  userAccount.create(authority, null);
  userAccount.authority = authority.key;
  userAccount.nonce = 0n;
}

export function setEthereumAddress(userAccount: HasOne<Mut<UserAccount>, "authority">, authority: Signer, ethereumAddress: Hash): void {
  userAccount.ethereumAddress = ethereumAddress;
}

/** Moves tokens out of the PDA-owned account when the registered Ethereum key signed this exact transfer. */
export function transferTokens(
  userAccount: HasOne<Mut<UserAccount>, "authority">,
  authority: Signer,
  userTokenAccount: Mut<TokenAccount>,
  recipientTokenAccount: Mut<TokenAccount>,
  userPda: Seeds<Owner<AccountInfo, "11111111111111111111111111111111">, ["@userAccount"]>,
  tokenProgram: TokenProgram,
  amount: u64,
  r: Hash,
  s: Hash,
  recoveryId: u8,
): void {
  // The digest binds the program, the accounts, the amount and the nonce, so a signature cannot be replayed.
  require(verifySecp256k1(
    keccak256(TRANSFER_DOMAIN, PROGRAM_ID, userAccount.key, userTokenAccount.key, recipientTokenAccount.key, amount, userAccount.nonce),
    recoveryId,
    r,
    s,
    userAccount.ethereumAddress,
  ), ErrorCode.InvalidSignature);
  require(userAccount.nonce < U64_MAX, ErrorCode.NonceOverflow);
  userAccount.nonce += 1n;
  tokenProgram.transfer(userTokenAccount, recipientTokenAccount, userPda, amount, [userAccount.key, userPda.pdaBump]);
}

export function authorityTransfer(
  userAccount: HasOne<Account<UserAccount>, "authority">,
  authority: Signer,
  userTokenAccount: Mut<TokenAccount>,
  recipientTokenAccount: Mut<TokenAccount>,
  userPda: Seeds<Owner<AccountInfo, "11111111111111111111111111111111">, ["@userAccount"]>,
  tokenProgram: TokenProgram,
  amount: u64,
): void {
  tokenProgram.transfer(userTokenAccount, recipientTokenAccount, userPda, amount, [userAccount.key, userPda.pdaBump]);
}
