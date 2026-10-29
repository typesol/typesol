// A port of coral-xyz/multisig (programs/multisig/src/lib.rs, Anchor 0.25), Copyright the coral-xyz/multisig authors,
// licensed under the Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0). Changes: rewritten in
// TypeSOL (see docs/case-study-multisig.md).
//
// A multisig that executes arbitrary instructions once `threshold` of its owners approve. The multisig's PDA
// ([multisig.key], bump = multisig.nonce) signs them, so it can hold an upgrade authority, a mint authority, etc.
// Account data, instruction data, error codes and the IDL's names are the original's, so its clients work unchanged.
import {
  type Account,
  type AccountInfo,
  type FixedVec,
  type HasOne,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signed,
  type Signer,
  type Vec,
  type Zeroed,
  type u8,
  type u32,
  u64,
  constraint,
  invokeInstruction,
  remainingAccounts,
  require,
} from "typesol";

/** @layout borsh */
export interface Multisig {
  owners: Vec<Pubkey>;
  threshold: u64;
  nonce: u8;
  ownerSetSeqno: u32;
}

/** @layout borsh */
export interface Transaction {
  /** The multisig account this transaction belongs to. */
  multisig: Pubkey;
  /** Target program to execute against. */
  programId: Pubkey;
  /** Accounts required for the transaction. */
  accounts: Vec<TransactionAccount>;
  /** Instruction data for the transaction. */
  data: Vec<u8>;
  /** signers[index] is true iff multisig.owners[index] signed the transaction. */
  signers: Vec<boolean>;
  /** Boolean ensuring one time execution. */
  didExecute: boolean;
  /** Owner set sequence number. */
  ownerSetSeqno: u32;
}

export interface TransactionAccount {
  pubkey: Pubkey;
  isSigner: boolean;
  isWritable: boolean;
}

export enum ErrorCode {
  InvalidOwner = "The given owner is not part of this multisig.",
  InvalidOwnersLen = "Owners length must be non zero.",
  NotEnoughSigners = "Not enough owners signed this transaction.",
  TransactionAlreadySigned = "Cannot delete a transaction that has been signed by an owner.",
  Overflow = "Overflow when adding.",
  UnableToDelete = "Cannot delete a transaction the owner did not create.",
  AlreadyExecuted = "The given transaction has already been executed.",
  InvalidThreshold = "Threshold must be less than or equal to the number of owners.",
  UniqueOwners = "Owners must be unique",
}

function assertUniqueOwners(owners: Vec<Pubkey>): void {
  for (let i = 0n; i < owners.length; i++)
    for (let j = i + 1n; j < owners.length; j++) require(owners.get(i) !== owners.get(j), ErrorCode.UniqueOwners);
}

/** Initializes a new multisig account with a set of owners and a threshold. */
export function createMultisig(multisig: Signed<Zeroed<Multisig>>, owners: Vec<Pubkey>, threshold: u64, nonce: u8): void {
  assertUniqueOwners(owners);
  require(threshold > 0n && threshold <= owners.length, ErrorCode.InvalidThreshold);
  require(owners.length > 0n, ErrorCode.InvalidOwnersLen);
  multisig.owners = owners;
  multisig.threshold = threshold;
  multisig.nonce = nonce;
  multisig.ownerSetSeqno = 0n;
}

/** Creates a new transaction account, automatically signed by the creator, which must be one of the owners. */
export function createTransaction(
  multisig: Account<Multisig>,
  transaction: Signed<Zeroed<Transaction>>,
  /** One of the owners. Checked in the handler. */
  proposer: Signer,
  pid: Pubkey,
  accs: Vec<TransactionAccount>,
  data: Vec<u8>,
): void {
  const found = multisig.owners.indexOf(proposer.key);
  require(found >= 0n, ErrorCode.InvalidOwner);
  const ownerIndex = u64(found);
  transaction.programId = pid;
  transaction.accounts = accs;
  transaction.data = data;
  for (let i = 0n; i < multisig.owners.length; i++) transaction.signers.push(i === ownerIndex);
  transaction.multisig = multisig.key;
  transaction.didExecute = false;
  transaction.ownerSetSeqno = multisig.ownerSetSeqno;
}

/** Approves a transaction on behalf of an owner of the multisig. */
export function approve(
  multisig: Account<Multisig>,
  transaction: HasOne<Mut<Transaction>, "multisig">,
  /** One of the multisig owners. Checked in the handler. */
  owner: Signer,
): void {
  // The original's `#[account(constraint = multisig.owner_set_seqno == transaction.owner_set_seqno)]` on multisig.
  constraint(multisig, multisig.ownerSetSeqno === transaction.ownerSetSeqno);
  const found = multisig.owners.indexOf(owner.key);
  require(found >= 0n, ErrorCode.InvalidOwner);
  transaction.signers.set(u64(found), true);
}

function applyOwners(multisig: Mut<Multisig>, owners: Vec<Pubkey>): void {
  assertUniqueOwners(owners);
  require(owners.length > 0n, ErrorCode.InvalidOwnersLen);
  if (owners.length < multisig.threshold) multisig.threshold = owners.length;
  multisig.owners = owners;
  multisig.ownerSetSeqno += 1n;
}

function applyThreshold(multisig: Mut<Multisig>, threshold: u64): void {
  require(threshold > 0n, ErrorCode.InvalidThreshold);
  require(threshold <= multisig.owners.length, ErrorCode.InvalidThreshold);
  multisig.threshold = threshold;
}

/** Set owners and threshold at once. */
export function setOwnersAndChangeThreshold(
  multisig: Mut<Multisig>,
  multisigSigner: Seeds<Signer, ["@multisig"], "@multisig.nonce">,
  owners: Vec<Pubkey>,
  threshold: u64,
): void {
  applyOwners(multisig, owners);
  applyThreshold(multisig, threshold);
}

/** Sets the owners field on the multisig. The only way this can be invoked is via a recursive call from execute_transaction. */
export function setOwners(multisig: Mut<Multisig>, multisigSigner: Seeds<Signer, ["@multisig"], "@multisig.nonce">, owners: Vec<Pubkey>): void {
  applyOwners(multisig, owners);
}

/** Changes the execution threshold of the multisig. The only way this can be invoked is via a recursive call from execute_transaction. */
export function changeThreshold(multisig: Mut<Multisig>, multisigSigner: Seeds<Signer, ["@multisig"], "@multisig.nonce">, threshold: u64): void {
  applyThreshold(multisig, threshold);
}

/** Executes the given transaction if threshold owners have signed it. */
export function executeTransaction(
  multisig: Account<Multisig>,
  /** The multisig's PDA, which signs the instruction. */
  multisigSigner: Seeds<AccountInfo, ["@multisig"], "@multisig.nonce">,
  transaction: HasOne<Mut<Transaction>, "multisig">,
): void {
  constraint(multisig, multisig.ownerSetSeqno === transaction.ownerSetSeqno);
  // Has this been executed already?
  require(!transaction.didExecute, ErrorCode.AlreadyExecuted);
  // Do we have enough signers?
  let sigCount = 0n;
  for (const didSign of transaction.signers) if (didSign) sigCount++;
  require(sigCount >= multisig.threshold, ErrorCode.NotEnoughSigners);
  // Execute the transaction signed by the multisig.
  const metas: FixedVec<TransactionAccount, 32> = transaction.accounts.map((acc) => ({
    pubkey: acc.pubkey,
    isSigner: acc.isSigner || acc.pubkey === multisigSigner.key,
    isWritable: acc.isWritable,
  }));
  invokeInstruction(transaction.programId, metas, transaction.data, remainingAccounts(), [multisig.key, multisig.nonce]);
  // Burn the transaction to ensure one time use.
  transaction.didExecute = true;
}
