// A TypeSOL port of Jito's tip distribution program (jito-foundation/jito-programs mev-programs/programs/
// tip-distribution @ ce1dfb6, Apache-2.0; mainnet 4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7). Each epoch a
// validator opens a TipDistributionAccount, the tips its leader slots earned are paid into it, and after the epoch an
// uploaded Merkle root says who may claim how much. Names, argument order, errors, events and account bytes are the
// original's. See docs/case-study-jito-mev.md.
import {
  AnchorError,
  type AccountInfo,
  type Account,
  type CloseTo,
  type Dup,
  type Hash,
  type Init,
  type Mut,
  type Option,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Vec,
  type u8,
  type u16,
  type u64,
  constraint,
  currentEpoch,
  currentSlot,
  emit,
  pubkey,
  readData,
  rentExempt,
  require,
} from "typesol";
import { claimLeaf, verifyProof } from "./merkle";
import { ErrorCode } from "./tip_distribution_errors";

const VOTE_PROGRAM = pubkey("Vote111111111111111111111111111111111111111");
const NO_KEY = pubkey("11111111111111111111111111111111");
const U64_MAX: u64 = 18446744073709551615n;

/** The program's settings (state.rs; at ["CONFIG_ACCOUNT"]). */
export interface Config {
  /** Can update this config, and set up the merkle root upload config. */
  authority: Pubkey;
  /** Where the lamports of expired tip distribution accounts go. */
  expired_funds_account: Pubkey;
  /** Epochs a tip distribution account can be claimed from. */
  num_epochs_valid: u64;
  max_validator_commission_bps: u16;
  bump: u8;
}

/** A validator's tips of one epoch (state.rs; at ["TIP_DISTRIBUTION_ACCOUNT", vote account, epoch]). */
/** @layout borsh */
export interface TipDistributionAccount {
  validator_vote_account: Pubkey;
  /** Can upload the Merkle root. */
  merkle_root_upload_authority: Pubkey;
  merkle_root: Option<MerkleRoot>;
  epoch_created_at: u64;
  validator_commission_bps: u16;
  /** Claims are allowed up to and including this epoch. */
  expires_at: u64;
  bump: u8;
}

export interface MerkleRoot {
  root: Hash;
  max_total_claim: u64;
  max_num_nodes: u64;
  total_funds_claimed: u64;
  num_nodes_claimed: u64;
}

/** One claim, made (state.rs; at ["CLAIM_STATUS", claimant, tip distribution account]). */
export interface ClaimStatus {
  is_claimed: boolean;
  claimant: Pubkey;
  claim_status_payer: Pubkey;
  slot_claimed_at: u64;
  amount: u64;
  expires_at: u64;
  bump: u8;
}

/** Who may take over tip distribution accounts' merkle root uploads (state.rs; at ["ROOT_UPLOAD_CONFIG"]). */
export interface MerkleRootUploadConfig {
  override_authority: Pubkey;
  original_upload_authority: Pubkey;
  bump: u8;
}

export interface TipDistributionAccountInitializedEvent {
  tip_distribution_account: Pubkey;
}
export interface ConfigUpdatedEvent {
  authority: Pubkey;
}
export interface ClaimedEvent {
  tip_distribution_account: Pubkey;
  payer: Pubkey;
  claimant: Pubkey;
  amount: u64;
}
export interface MerkleRootUploadedEvent {
  merkle_root_upload_authority: Pubkey;
  tip_distribution_account: Pubkey;
}
export interface TipDistributionAccountClosedEvent {
  expired_funds_account: Pubkey;
  tip_distribution_account: Pubkey;
  expired_amount: u64;
}
export interface ClaimStatusClosedEvent {
  claim_status_payer: Pubkey;
  claim_status_account: Pubkey;
}

/** Config::validate. */
function validConfig(authority: Pubkey, expired: Pubkey, epochsValid: u64, maxCommission: u16): void {
  require(epochsValid !== 0n && epochsValid <= 10n, ErrorCode.AccountValidationFailure);
  require(maxCommission <= 10_000n, ErrorCode.AccountValidationFailure);
  require(expired !== NO_KEY && authority !== NO_KEY, ErrorCode.AccountValidationFailure);
}

/** TipDistributionAccount::validate. */
function validTda(tda: Account<TipDistributionAccount>): void {
  require(tda.validator_vote_account !== NO_KEY && tda.merkle_root_upload_authority !== NO_KEY, ErrorCode.AccountValidationFailure);
}

/** Set up the program (once). */
export function initialize(
  config: Init<Config>,
  system_program: SystemProgram,
  initializer: Mut<Signer>,
  authority: Pubkey,
  expired_funds_account: Pubkey,
  num_epochs_valid: u64,
  max_validator_commission_bps: u16,
  bump: u8,
): void {
  // Space as the original reserves it: the struct's in-memory size (with Rust's padding) after the discriminator.
  config.create(initializer, ["CONFIG_ACCOUNT"], 88n);
  config.authority = authority;
  config.expired_funds_account = expired_funds_account;
  config.num_epochs_valid = num_epochs_valid;
  config.max_validator_commission_bps = max_validator_commission_bps;
  config.bump = bump;
  validConfig(authority, expired_funds_account, num_epochs_valid, max_validator_commission_bps);
}

/** Open this epoch's tip distribution account of a validator: its vote account's node key signs. */
export function initializeTipDistributionAccount(
  config: Account<Config>,
  tip_distribution_account: Init<TipDistributionAccount>,
  validator_vote_account: AccountInfo,
  signer: Mut<Signer>,
  system_program: SystemProgram,
  merkle_root_upload_authority: Pubkey,
  validator_commission_bps: u16,
  bump: u8,
): void {
  const epoch = currentEpoch();
  tip_distribution_account.create(signer, ["TIP_DISTRIBUTION_ACCOUNT", validator_vote_account.key, epoch], 168n);
  require(validator_commission_bps <= config.max_validator_commission_bps, ErrorCode.MaxValidatorCommissionFeeBpsExceeded);
  // jito_programs_vote_state::VoteState::deserialize_node_pubkey: a Vote program account, its node key at bytes 4..36.
  require(validator_vote_account.owner === VOTE_PROGRAM, AnchorError.ConstraintOwner);
  require(validator_vote_account.dataLen >= 36n, AnchorError.AccountDidNotDeserialize);
  require(readData<Pubkey>(validator_vote_account, 4n) === signer.key, ErrorCode.Unauthorized);
  tip_distribution_account.validator_vote_account = validator_vote_account.key;
  tip_distribution_account.epoch_created_at = epoch;
  tip_distribution_account.validator_commission_bps = validator_commission_bps;
  tip_distribution_account.merkle_root_upload_authority = merkle_root_upload_authority;
  tip_distribution_account.merkle_root = null;
  require(epoch <= U64_MAX - config.num_epochs_valid, ErrorCode.ArithmeticError);
  tip_distribution_account.expires_at = epoch + config.num_epochs_valid;
  tip_distribution_account.bump = bump;
  validTda(tip_distribution_account);
  emit<TipDistributionAccountInitializedEvent>({ tip_distribution_account: tip_distribution_account.key });
}

/** Change the settings (the config's authority). */
export function updateConfig(config: Mut<Config>, authority: Mut<Signer>, new_config: Config): void {
  constraint(config, config.lamports >= rentExempt(config.dataLen), AnchorError.ConstraintRentExempt);
  require(config.authority === authority.key, ErrorCode.Unauthorized);
  config.authority = new_config.authority;
  config.expired_funds_account = new_config.expired_funds_account;
  config.num_epochs_valid = new_config.num_epochs_valid;
  config.max_validator_commission_bps = new_config.max_validator_commission_bps;
  validConfig(config.authority, config.expired_funds_account, config.num_epochs_valid, config.max_validator_commission_bps);
  emit<ConfigUpdatedEvent>({ authority: authority.key });
}

/** Upload (or, before anyone claimed, replace) the Merkle root of who gets what, after the account's epoch. */
export function uploadMerkleRoot(
  config: Account<Config>,
  tip_distribution_account: Mut<TipDistributionAccount>,
  merkle_root_upload_authority: Mut<Signer>,
  root: Hash,
  max_total_claim: u64,
  max_num_nodes: u64,
): void {
  constraint(tip_distribution_account, tip_distribution_account.lamports >= rentExempt(tip_distribution_account.dataLen), AnchorError.ConstraintRentExempt);
  require(merkle_root_upload_authority.key === tip_distribution_account.merkle_root_upload_authority, ErrorCode.Unauthorized);
  const epoch = currentEpoch();
  if (tip_distribution_account.merkle_root !== null) require(tip_distribution_account.merkle_root.num_nodes_claimed === 0n, ErrorCode.Unauthorized);
  require(epoch > tip_distribution_account.epoch_created_at, ErrorCode.PrematureMerkleRootUpload);
  require(epoch <= tip_distribution_account.expires_at, ErrorCode.ExpiredTipDistributionAccount);
  tip_distribution_account.merkle_root = { root, max_total_claim, max_num_nodes, total_funds_claimed: 0n, num_nodes_claimed: 0n };
  validTda(tip_distribution_account);
  emit<MerkleRootUploadedEvent>({
    merkle_root_upload_authority: merkle_root_upload_authority.key,
    tip_distribution_account: tip_distribution_account.key,
  });
}

/** Close a claim record once its tip distribution account has expired; its rent goes back to who paid it. */
export function closeClaimStatus(
  config: Seeds<Account<Config>, ["CONFIG_ACCOUNT"]>,
  claim_status: CloseTo<Mut<ClaimStatus>, "claim_status_payer">,
  claim_status_payer: Mut<AccountInfo>,
): void {
  constraint(claim_status, claim_status_payer.key === claim_status.claim_status_payer);
  require(currentEpoch() > claim_status.expires_at, ErrorCode.PrematureCloseClaimStatus);
  emit<ClaimStatusClosedEvent>({ claim_status_payer: claim_status_payer.key, claim_status_account: claim_status.key });
}

/** Close an expired tip distribution account: what was not claimed goes to the expired funds account, its rent to the validator. */
export function closeTipDistributionAccount(
  config: Account<Config>,
  expired_funds_account: Dup<Mut<AccountInfo>>,
  tip_distribution_account: Seeds<CloseTo<Mut<TipDistributionAccount>, "validator_vote_account">, ["TIP_DISTRIBUTION_ACCOUNT", "@validator_vote_account", "@_epoch"], "bump">,
  validator_vote_account: Mut<AccountInfo>,
  signer: Dup<Mut<Signer>>,
  _epoch: u64,
): void {
  require(config.expired_funds_account === expired_funds_account.key, ErrorCode.Unauthorized);
  require(currentEpoch() > tip_distribution_account.expires_at, ErrorCode.PrematureCloseTipDistributionAccount);
  // claim_expired: all but the rent.
  const rent = rentExempt(tip_distribution_account.dataLen);
  require(tip_distribution_account.lamports >= rent, ErrorCode.ArithmeticError);
  const expired = tip_distribution_account.lamports - rent;
  tip_distribution_account.lamports -= expired;
  require(expired_funds_account.lamports <= U64_MAX - expired, ErrorCode.ArithmeticError);
  expired_funds_account.lamports += expired;
  validTda(tip_distribution_account);
  emit<TipDistributionAccountClosedEvent>({
    expired_funds_account: expired_funds_account.key,
    tip_distribution_account: tip_distribution_account.key,
    expired_amount: expired,
  });
}

/** Claim `amount` for `claimant` with a Merkle proof; the upload authority signs, the payer funds the claim record. */
export function claim(
  config: Account<Config>,
  tip_distribution_account: Mut<TipDistributionAccount>,
  merkle_root_upload_authority: Signer,
  claim_status: Init<ClaimStatus>,
  claimant: Dup<Mut<AccountInfo>>,
  payer: Dup<Mut<Signer>>,
  system_program: SystemProgram,
  bump: u8,
  amount: u64,
  proof: Vec<Hash>,
): void {
  constraint(tip_distribution_account, tip_distribution_account.lamports >= rentExempt(tip_distribution_account.dataLen), AnchorError.ConstraintRentExempt);
  claim_status.create(payer, ["CLAIM_STATUS", claimant.key, tip_distribution_account.key], 104n);
  require(merkle_root_upload_authority.key === tip_distribution_account.merkle_root_upload_authority, ErrorCode.Unauthorized);
  claim_status.bump = bump;
  require(currentEpoch() <= tip_distribution_account.expires_at, ErrorCode.ExpiredTipDistributionAccount);
  require(!claim_status.is_claimed, ErrorCode.FundsAlreadyClaimed);
  require(tip_distribution_account.merkle_root !== null, ErrorCode.RootNotUploaded);
  require(verifyProof(proof, tip_distribution_account.merkle_root.root, claimLeaf(claimant.key, amount)), ErrorCode.InvalidProof);
  // TipDistributionAccount::claim: lamports straight from the account.
  require(tip_distribution_account.lamports >= amount, ErrorCode.ArithmeticError);
  tip_distribution_account.lamports -= amount;
  require(claimant.lamports <= U64_MAX - amount, ErrorCode.ArithmeticError);
  claimant.lamports += amount;
  claim_status.amount = amount;
  claim_status.is_claimed = true;
  claim_status.slot_claimed_at = currentSlot();
  claim_status.claimant = claimant.key;
  claim_status.claim_status_payer = payer.key;
  claim_status.expires_at = tip_distribution_account.expires_at;
  require(tip_distribution_account.merkle_root.total_funds_claimed <= U64_MAX - amount, ErrorCode.ArithmeticError);
  tip_distribution_account.merkle_root.total_funds_claimed += amount;
  require(tip_distribution_account.merkle_root.total_funds_claimed <= tip_distribution_account.merkle_root.max_total_claim, ErrorCode.ExceedsMaxClaim);
  require(tip_distribution_account.merkle_root.num_nodes_claimed < U64_MAX, ErrorCode.ArithmeticError);
  tip_distribution_account.merkle_root.num_nodes_claimed += 1n;
  require(tip_distribution_account.merkle_root.num_nodes_claimed <= tip_distribution_account.merkle_root.max_num_nodes, ErrorCode.ExceedsMaxNumNodes);
  emit<ClaimedEvent>({ tip_distribution_account: tip_distribution_account.key, payer: payer.key, claimant: claimant.key, amount });
  validTda(tip_distribution_account);
}

/** Set up who may take over merkle root uploads (the config's authority). */
export function initializeMerkleRootUploadConfig(
  config: Mut<Config>,
  merkle_root_upload_config: Init<MerkleRootUploadConfig>,
  authority: Signer,
  payer: Mut<Signer>,
  system_program: SystemProgram,
  authority_: Pubkey,
  original_authority: Pubkey,
): void {
  constraint(config, config.lamports >= rentExempt(config.dataLen), AnchorError.ConstraintRentExempt);
  const bump = merkle_root_upload_config.create(payer, ["ROOT_UPLOAD_CONFIG"], 73n);
  require(config.authority === authority.key, ErrorCode.Unauthorized);
  merkle_root_upload_config.override_authority = authority_;
  merkle_root_upload_config.original_upload_authority = original_authority;
  merkle_root_upload_config.bump = bump;
}

/** Change it (the config's authority). */
export function updateMerkleRootUploadConfig(
  config: Account<Config>,
  merkle_root_upload_config: Seeds<Mut<MerkleRootUploadConfig>, ["ROOT_UPLOAD_CONFIG"]>,
  authority: Signer,
  system_program: SystemProgram,
  authority_: Pubkey,
  original_authority: Pubkey,
): void {
  constraint(config, config.lamports >= rentExempt(config.dataLen), AnchorError.ConstraintRentExempt);
  constraint(merkle_root_upload_config, merkle_root_upload_config.lamports >= rentExempt(merkle_root_upload_config.dataLen), AnchorError.ConstraintRentExempt);
  require(config.authority === authority.key, ErrorCode.Unauthorized);
  merkle_root_upload_config.override_authority = authority_;
  merkle_root_upload_config.original_upload_authority = original_authority;
}

/** Hand an account's merkle root uploads, still with the original authority and no root, to the override authority. */
export function migrateTdaMerkleRootUploadAuthority(
  tip_distribution_account: Mut<TipDistributionAccount>,
  merkle_root_upload_config: Seeds<Account<MerkleRootUploadConfig>, ["ROOT_UPLOAD_CONFIG"]>,
): void {
  constraint(tip_distribution_account, tip_distribution_account.lamports >= rentExempt(tip_distribution_account.dataLen), AnchorError.ConstraintRentExempt);
  constraint(merkle_root_upload_config, merkle_root_upload_config.lamports >= rentExempt(merkle_root_upload_config.dataLen), AnchorError.ConstraintRentExempt);
  require(tip_distribution_account.merkle_root === null, ErrorCode.InvalidTdaForMigration);
  require(tip_distribution_account.merkle_root_upload_authority === merkle_root_upload_config.original_upload_authority, ErrorCode.InvalidTdaForMigration);
  tip_distribution_account.merkle_root_upload_authority = merkle_root_upload_config.override_authority;
}
