// Errors of the priority fee distribution program (ErrorCode in jito-foundation/jito-programs mev-programs/programs/
// priority-fee-distribution/src/lib.rs), in the original's order: 6000 + the member's index.
export enum ErrorCode {
  AccountValidationFailure = "Account failed validation.",
  ArithmeticError = "Encountered an arithmetic under/overflow error.",
  ExceedsMaxClaim = "The maximum number of funds to be claimed has been exceeded.",
  ExceedsMaxNumNodes = "The maximum number of claims has been exceeded.",
  ExpiredPriorityFeeDistributionAccount = "The given PriorityFeeDistributionAccount has expired.",
  FundsAlreadyClaimed = "The funds for the given index and PriorityFeeDistributionAccount have already been claimed.",
  InvalidParameters = "Supplied invalid parameters.",
  InvalidProof = "The given proof is invalid.",
  InvalidVoteAccountData = "Failed to deserialize the supplied vote account data.",
  MaxValidatorCommissionFeeBpsExceeded = "Validator's commission basis points must be less than or equal to the Config account's max_validator_commission_bps.",
  PrematureClosePriorityFeeDistributionAccount = "The given PriorityFeeDistributionAccount is not ready to be closed.",
  PrematureCloseClaimStatus = "The given ClaimStatus account is not ready to be closed.",
  PrematureMerkleRootUpload = "Must wait till at least one epoch after the tip distribution account was created to upload the merkle root.",
  RootNotUploaded = "No merkle root has been uploaded to the given PriorityFeeDistributionAccount.",
  Unauthorized = "Unauthorized signer.",
  InvalidTdaForMigration = "TDA not valid for migration.",
}
