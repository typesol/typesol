// A TypeSOL port of Jito's priority fee distribution program (jito-foundation/jito-programs mev-programs/programs/
// priority-fee-distribution @ ce1dfb6, Anchor 0.31.1, Apache-2.0; mainnet Priority6weCZ5HwDn29NxLFpb7TDp2iLZ6XKc5e8d3):
// the tip distribution program for the priority fees a validator shares. The validator transfers fees into its
// PriorityFeeDistributionAccount during the epoch (`transfer_priority_fee_tips`); claims work as for tips. Names,
// argument order, errors, events, logs and account bytes are the original's. See docs/case-study-jito-mev.md.
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
  u64,
  u128,
  constraint,
  currentEpoch,
  emit,
  log,
  pubkey,
  readData,
  rentExempt,
  require,
} from "typesol";
import { claimLeaf, verifyProof } from "./merkle";
import { ErrorCode } from "./priority_fee_distribution_errors";

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
  /** Fees are only taken in from this epoch on. */
  go_live_epoch: u64;
  bump: u8;
}

/** A validator's shared priority fees of one epoch (state.rs; at ["PF_DISTRIBUTION_ACCOUNT", vote account, epoch]). */
/** @layout borsh */
export interface PriorityFeeDistributionAccount {
  validator_vote_account: Pubkey;
  /** Can upload the Merkle root. */
  merkle_root_upload_authority: Pubkey;
  merkle_root: Option<MerkleRoot>;
  epoch_created_at: u64;
  validator_commission_bps: u16;
  /** Claims are allowed up to and including this epoch. */
  expires_at: u64;
  total_lamports_transferred: u64;
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
  claim_status_payer: Pubkey;
  expires_at: u64;
}

/** Who may take over tip distribution accounts' merkle root uploads (state.rs; at ["ROOT_UPLOAD_CONFIG"]). */
export interface MerkleRootUploadConfig {
  override_authority: Pubkey;
  original_upload_authority: Pubkey;
  bump: u8;
}

export interface PriorityFeeDistributionAccountInitializedEvent {
  priority_fee_distribution_account: Pubkey;
}
export interface ConfigUpdatedEvent {
  authority: Pubkey;
}
export interface ClaimedEvent {
  priority_fee_distribution_account: Pubkey;
  payer: Pubkey;
  claimant: Pubkey;
  amount: u64;
}
export interface MerkleRootUploadedEvent {
  merkle_root_upload_authority: Pubkey;
  priority_fee_distribution_account: Pubkey;
}
export interface PriorityFeeDistributionAccountClosedEvent {
  expired_funds_account: Pubkey;
  priority_fee_distribution_account: Pubkey;
  expired_amount: u64;
}
export interface ClaimStatusClosedEvent {
  claim_status_payer: Pubkey;
  claim_status_account: Pubkey;
}

/**
 * lamports_to_sol(lamports) as `{:.5}` prints it, in units of 0.00001 SOL: the f64 nearest lamports / 1e9 (ties to
 * even), then that binary value rounded to five decimals (ties to even). In integers: the f64 is M / 2^s, M of 53 bits.
 */
function solHundredThousandths(lamports: u64): u64 {
  if (lamports === 0n) return 0n;
  let bits: u64 = 0n;
  let rest = lamports;
  while (rest > 0n) {
    rest = rest >> 1n;
    bits += 1n;
  }
  // lamports * 2^s / 1e9 in [2^52, 2^53).
  let s = 82n - bits;
  if (u128(lamports) << u128(s) < u128(4_503_599_627_370_496n) * 1_000_000_000n) s += 1n;
  const scaled = u128(lamports) << u128(s);
  let m = scaled / 1_000_000_000n;
  const r = scaled % 1_000_000_000n;
  if (r * 2n > 1_000_000_000n || (r * 2n === 1_000_000_000n && m % 2n === 1n)) m += 1n;
  const t = m * 100_000n;
  let n = t >> u128(s);
  const rem = t - (n << u128(s));
  const half = u128(1n) << u128(s - 1n);
  if (rem > half || (rem === half && n % 2n === 1n)) n += 1n;
  return u64(n);
}

/** Config::validate. */
function validConfig(authority: Pubkey, expired: Pubkey, epochsValid: u64, maxCommission: u16): void {
  require(epochsValid !== 0n && epochsValid <= 10n, ErrorCode.AccountValidationFailure);
  require(maxCommission <= 10_000n, ErrorCode.AccountValidationFailure);
  require(expired !== NO_KEY && authority !== NO_KEY, ErrorCode.AccountValidationFailure);
}

/** PriorityFeeDistributionAccount::validate. */
function validPfda(tda: Account<PriorityFeeDistributionAccount>): void {
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
  config.create(initializer, ["CONFIG_ACCOUNT"], 96n);
  config.authority = authority;
  config.expired_funds_account = expired_funds_account;
  config.num_epochs_valid = num_epochs_valid;
  config.max_validator_commission_bps = max_validator_commission_bps;
  config.go_live_epoch = 18446744073709551615n;
  config.bump = bump;
  validConfig(authority, expired_funds_account, num_epochs_valid, max_validator_commission_bps);
}

/** Open this epoch's priority fee distribution account of a validator: its vote account's node key signs. */
export function initializePriorityFeeDistributionAccount(
  config: Account<Config>,
  priority_fee_distribution_account: Init<PriorityFeeDistributionAccount>,
  validator_vote_account: AccountInfo,
  signer: Mut<Signer>,
  system_program: SystemProgram,
  merkle_root_upload_authority: Pubkey,
  validator_commission_bps: u16,
  bump: u8,
): void {
  const epoch = currentEpoch();
  priority_fee_distribution_account.create(signer, ["PF_DISTRIBUTION_ACCOUNT", validator_vote_account.key, epoch], 176n);
  require(validator_commission_bps <= config.max_validator_commission_bps, ErrorCode.MaxValidatorCommissionFeeBpsExceeded);
  // jito_programs_vote_state::VoteState::deserialize_node_pubkey: a Vote program account, its node key at bytes 4..36.
  require(validator_vote_account.owner === VOTE_PROGRAM, AnchorError.ConstraintOwner);
  require(validator_vote_account.dataLen >= 36n, AnchorError.AccountDidNotDeserialize);
  require(readData<Pubkey>(validator_vote_account, 4n) === signer.key, ErrorCode.Unauthorized);
  priority_fee_distribution_account.validator_vote_account = validator_vote_account.key;
  priority_fee_distribution_account.epoch_created_at = epoch;
  priority_fee_distribution_account.validator_commission_bps = validator_commission_bps;
  priority_fee_distribution_account.merkle_root_upload_authority = merkle_root_upload_authority;
  priority_fee_distribution_account.merkle_root = null;
  require(epoch <= U64_MAX - config.num_epochs_valid, ErrorCode.ArithmeticError);
  priority_fee_distribution_account.expires_at = epoch + config.num_epochs_valid;
  priority_fee_distribution_account.bump = bump;
  validPfda(priority_fee_distribution_account);
  emit<PriorityFeeDistributionAccountInitializedEvent>({ priority_fee_distribution_account: priority_fee_distribution_account.key });
}

/** Change the settings (the config's authority). */
export function updateConfig(config: Mut<Config>, authority: Mut<Signer>, new_config: Config): void {
  constraint(config, config.lamports >= rentExempt(config.dataLen), AnchorError.ConstraintRentExempt);
  require(config.authority === authority.key, ErrorCode.Unauthorized);
  config.authority = new_config.authority;
  config.expired_funds_account = new_config.expired_funds_account;
  config.num_epochs_valid = new_config.num_epochs_valid;
  config.max_validator_commission_bps = new_config.max_validator_commission_bps;
  config.go_live_epoch = new_config.go_live_epoch;
  validConfig(config.authority, config.expired_funds_account, config.num_epochs_valid, config.max_validator_commission_bps);
  emit<ConfigUpdatedEvent>({ authority: authority.key });
}

/** Upload (or, before anyone claimed, replace) the Merkle root of who gets what, after the account's epoch. */
export function uploadMerkleRoot(
  config: Account<Config>,
  priority_fee_distribution_account: Mut<PriorityFeeDistributionAccount>,
  merkle_root_upload_authority: Mut<Signer>,
  root: Hash,
  max_total_claim: u64,
  max_num_nodes: u64,
): void {
  constraint(priority_fee_distribution_account, priority_fee_distribution_account.lamports >= rentExempt(priority_fee_distribution_account.dataLen), AnchorError.ConstraintRentExempt);
  require(merkle_root_upload_authority.key === priority_fee_distribution_account.merkle_root_upload_authority, ErrorCode.Unauthorized);
  const epoch = currentEpoch();
  if (priority_fee_distribution_account.merkle_root !== null) require(priority_fee_distribution_account.merkle_root.num_nodes_claimed === 0n, ErrorCode.Unauthorized);
  require(epoch > priority_fee_distribution_account.epoch_created_at, ErrorCode.PrematureMerkleRootUpload);
  require(epoch <= priority_fee_distribution_account.expires_at, ErrorCode.ExpiredPriorityFeeDistributionAccount);
  priority_fee_distribution_account.merkle_root = { root, max_total_claim, max_num_nodes, total_funds_claimed: 0n, num_nodes_claimed: 0n };
  validPfda(priority_fee_distribution_account);
  emit<MerkleRootUploadedEvent>({
    merkle_root_upload_authority: merkle_root_upload_authority.key,
    priority_fee_distribution_account: priority_fee_distribution_account.key,
  });
}

/** Close a claim record once its tip distribution account has expired; its rent goes back to who paid it. */
export function closeClaimStatus(
  claim_status: CloseTo<Mut<ClaimStatus>, "claim_status_payer">,
  claim_status_payer: Mut<AccountInfo>,
): void {
  constraint(claim_status, claim_status_payer.key === claim_status.claim_status_payer);
  require(currentEpoch() > claim_status.expires_at, ErrorCode.PrematureCloseClaimStatus);
  emit<ClaimStatusClosedEvent>({ claim_status_payer: claim_status_payer.key, claim_status_account: claim_status.key });
}

/** Close an expired priority fee distribution account: what was not claimed goes to the expired funds account, its rent to the validator. */
export function closePriorityFeeDistributionAccount(
  config: Account<Config>,
  expired_funds_account: Dup<Mut<AccountInfo>>,
  priority_fee_distribution_account: Seeds<CloseTo<Mut<PriorityFeeDistributionAccount>, "validator_vote_account">, ["PF_DISTRIBUTION_ACCOUNT", "@validator_vote_account", "@_epoch"], "bump">,
  validator_vote_account: Mut<AccountInfo>,
  signer: Dup<Mut<Signer>>,
  _epoch: u64,
): void {
  require(config.expired_funds_account === expired_funds_account.key, ErrorCode.Unauthorized);
  require(currentEpoch() > priority_fee_distribution_account.expires_at, ErrorCode.PrematureClosePriorityFeeDistributionAccount);
  // claim_expired: all but the rent.
  const rent = rentExempt(priority_fee_distribution_account.dataLen);
  require(priority_fee_distribution_account.lamports >= rent, ErrorCode.ArithmeticError);
  const expired = priority_fee_distribution_account.lamports - rent;
  priority_fee_distribution_account.lamports -= expired;
  require(expired_funds_account.lamports <= U64_MAX - expired, ErrorCode.ArithmeticError);
  expired_funds_account.lamports += expired;
  validPfda(priority_fee_distribution_account);
  emit<PriorityFeeDistributionAccountClosedEvent>({
    expired_funds_account: expired_funds_account.key,
    priority_fee_distribution_account: priority_fee_distribution_account.key,
    expired_amount: expired,
  });
}

/** Claim `amount` for `claimant` with a Merkle proof; the upload authority signs, the payer funds the claim record. */
export function claim(
  config: Account<Config>,
  priority_fee_distribution_account: Mut<PriorityFeeDistributionAccount>,
  merkle_root_upload_authority: Signer,
  claim_status: Init<ClaimStatus>,
  claimant: Dup<Mut<AccountInfo>>,
  payer: Dup<Mut<Signer>>,
  system_program: SystemProgram,
  _bump: u8,
  amount: u64,
  proof: Vec<Hash>,
): void {
  constraint(priority_fee_distribution_account, priority_fee_distribution_account.lamports >= rentExempt(priority_fee_distribution_account.dataLen), AnchorError.ConstraintRentExempt);
  claim_status.create(payer, ["CLAIM_STATUS", claimant.key, priority_fee_distribution_account.key], 48n);
  require(merkle_root_upload_authority.key === priority_fee_distribution_account.merkle_root_upload_authority, ErrorCode.Unauthorized);
  require(currentEpoch() <= priority_fee_distribution_account.expires_at, ErrorCode.ExpiredPriorityFeeDistributionAccount);
  require(priority_fee_distribution_account.merkle_root !== null, ErrorCode.RootNotUploaded);
  require(verifyProof(proof, priority_fee_distribution_account.merkle_root.root, claimLeaf(claimant.key, amount)), ErrorCode.InvalidProof);
  // PriorityFeeDistributionAccount::claim: lamports straight from the account.
  require(priority_fee_distribution_account.lamports >= amount, ErrorCode.ArithmeticError);
  priority_fee_distribution_account.lamports -= amount;
  require(claimant.lamports <= U64_MAX - amount, ErrorCode.ArithmeticError);
  claimant.lamports += amount;
  claim_status.claim_status_payer = payer.key;
  claim_status.expires_at = priority_fee_distribution_account.expires_at;
  require(priority_fee_distribution_account.merkle_root.total_funds_claimed <= U64_MAX - amount, ErrorCode.ArithmeticError);
  priority_fee_distribution_account.merkle_root.total_funds_claimed += amount;
  require(priority_fee_distribution_account.merkle_root.total_funds_claimed <= priority_fee_distribution_account.merkle_root.max_total_claim, ErrorCode.ExceedsMaxClaim);
  require(priority_fee_distribution_account.merkle_root.num_nodes_claimed < U64_MAX, ErrorCode.ArithmeticError);
  priority_fee_distribution_account.merkle_root.num_nodes_claimed += 1n;
  require(priority_fee_distribution_account.merkle_root.num_nodes_claimed <= priority_fee_distribution_account.merkle_root.max_num_nodes, ErrorCode.ExceedsMaxNumNodes);
  emit<ClaimedEvent>({ priority_fee_distribution_account: priority_fee_distribution_account.key, payer: payer.key, claimant: claimant.key, amount });
  validPfda(priority_fee_distribution_account);
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
  priority_fee_distribution_account: Mut<PriorityFeeDistributionAccount>,
  merkle_root_upload_config: Seeds<Account<MerkleRootUploadConfig>, ["ROOT_UPLOAD_CONFIG"]>,
): void {
  constraint(priority_fee_distribution_account, priority_fee_distribution_account.lamports >= rentExempt(priority_fee_distribution_account.dataLen), AnchorError.ConstraintRentExempt);
  constraint(merkle_root_upload_config, merkle_root_upload_config.lamports >= rentExempt(merkle_root_upload_config.dataLen), AnchorError.ConstraintRentExempt);
  require(priority_fee_distribution_account.merkle_root === null, ErrorCode.InvalidTdaForMigration);
  require(priority_fee_distribution_account.merkle_root_upload_authority === merkle_root_upload_config.original_upload_authority, ErrorCode.InvalidTdaForMigration);
  priority_fee_distribution_account.merkle_root_upload_authority = merkle_root_upload_config.override_authority;
}

/**
 * The validator moves `lamports` of priority fees into this epoch's account (counted even before the program goes
 * live; moved only from `go_live_epoch` on).
 */
export function transferPriorityFeeTips(
  config: Account<Config>,
  priority_fee_distribution_account: Mut<PriorityFeeDistributionAccount>,
  from: Mut<Signer>,
  system_program: SystemProgram,
  lamports: u64,
): void {
  constraint(config, config.lamports >= rentExempt(config.dataLen), AnchorError.ConstraintRentExempt);
  constraint(priority_fee_distribution_account, priority_fee_distribution_account.lamports >= rentExempt(priority_fee_distribution_account.dataLen), AnchorError.ConstraintRentExempt);
  const epoch = currentEpoch();
  require(priority_fee_distribution_account.epoch_created_at === epoch, ErrorCode.AccountValidationFailure);
  require(priority_fee_distribution_account.total_lamports_transferred <= U64_MAX - lamports, ErrorCode.ArithmeticError);
  priority_fee_distribution_account.total_lamports_transferred += lamports;
  if (config.go_live_epoch > epoch) {
    const units = solHundredThousandths(lamports);
    const fraction = units % 100_000n;
    const pad = fraction < 10n ? "0000" : fraction < 100n ? "000" : fraction < 1_000n ? "00" : fraction < 10_000n ? "0" : "";
    log(`Priority fee transfer is not live yet. ${epoch}/${config.go_live_epoch} - (${units / 100_000n}.${pad}${fraction})`);
    return;
  }
  system_program.transfer(from, priority_fee_distribution_account, lamports);
}
