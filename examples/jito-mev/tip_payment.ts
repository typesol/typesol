// A TypeSOL port of Jito's tip payment program (jito-foundation/jito-programs mev-programs/programs/tip-payment @
// ce1dfb6, the "payments patch" of #143, Anchor 0.31.1, Apache-2.0; on mainnet since slot 337435036 at
// T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt). Searchers tip into eight fixed accounts; when the leader changes, the
// tips go to the tip receiver (a validator's tip distribution account) and the block builder its commission. Names,
// argument order, errors, events, logs and account bytes are the original's. See docs/case-study-jito-mev.md.
import {
  AnchorError,
  type AccountInfo,
  type Dup,
  type Init,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type u8,
  type u64,
  constraint,
  emit,
  findProgramAddressBump,
  findProgramAddress,
  initAccount,
  log,
  programId,
  pubkey,
  rentExempt,
  require,
} from "typesol";

/** No messages, as in the original (`""`: no `msg` in the IDL). */
export enum TipPaymentError {
  ArithmeticError = "",
  InvalidFee = "",
  InvalidTipReceiver = "",
  InvalidBlockBuilder = "",
}

/** The bumps of the program's PDAs, as `initialize` takes and stores them. */
export interface InitBumps {
  config: u8;
  tip_payment_account_0: u8;
  tip_payment_account_1: u8;
  tip_payment_account_2: u8;
  tip_payment_account_3: u8;
  tip_payment_account_4: u8;
  tip_payment_account_5: u8;
  tip_payment_account_6: u8;
  tip_payment_account_7: u8;
}

/** Where tips go (at ["CONFIG_ACCOUNT"]). */
export interface Config {
  tip_receiver: Pubkey;
  block_builder: Pubkey;
  block_builder_commission_pct: u64;
  bumps: InitBumps;
}

/** A tip account: no data, the lamports above rent are the tips (at ["TIP_ACCOUNT_0"] … ["TIP_ACCOUNT_7"]). */
export interface TipPaymentAccount {}

export interface TipsClaimed {
  tip_receiver: Pubkey;
  tip_receiver_amount: u64;
  block_builder: Pubkey;
  block_builder_amount: u64;
}

const U64_MAX: u64 = 18446744073709551615n;
const NO_KEY = pubkey("11111111111111111111111111111111");
const BPF_LOADER = pubkey("BPFLoader2111111111111111111111111111111111");
const BPF_LOADER_DEPRECATED = pubkey("BPFLoader1111111111111111111111111111111111");
const BPF_LOADER_UPGRADEABLE = pubkey("BPFLoaderUpgradeab1e11111111111111111111111");
const LOADER_V4 = pubkey("LoaderV411111111111111111111111111111111111");
const NATIVE_LOADER = pubkey("NativeLoader1111111111111111111111111111111");
const SECP256R1 = pubkey("Secp256r1SigVerify1111111111111111111111111");
const SYSVAR = pubkey("Sysvar1111111111111111111111111111111111111");
const CONFIG_PROGRAM = pubkey("Config1111111111111111111111111111111111111");

/**
 * TipPaymentAccount::initialize: the account created at its PDA by hand, the discriminator written. One that already
 * holds lamports is refused (the original's "simplifies the CPIs", with ConstraintSeeds).
 */
function createTipAccount(payer: Mut<Signer>, account: Mut<AccountInfo>, system_program: SystemProgram, seed: string): u8 {
  const bump = findProgramAddressBump([seed], programId());
  require(account.key === findProgramAddress([seed], programId()), AnchorError.ConstraintSeeds);
  require(account.lamports === 0n, AnchorError.ConstraintSeeds);
  system_program.createAccount(payer, account, rentExempt(8n), 8n, programId(), [seed, bump]);
  initAccount<TipPaymentAccount>(account);
  return bump;
}

/** TipPaymentAccount::drain_account: everything above rent comes out. */
function drain(account: Mut<TipPaymentAccount>): u64 {
  const rent = rentExempt(account.dataLen);
  require(account.lamports >= rent, TipPaymentError.ArithmeticError);
  const tips = account.lamports - rent;
  account.lamports -= tips;
  return tips;
}
function addTips(total: u64, tips: u64): u64 {
  require(total <= U64_MAX - tips, TipPaymentError.ArithmeticError);
  return total + tips;
}

/** is_program: owned by a loader, a loader or the secp256r1 precompile itself, or executable. */
function isProgram(account: AccountInfo): boolean {
  const o = account.owner;
  return (
    o === BPF_LOADER ||
    o === BPF_LOADER_DEPRECATED ||
    o === BPF_LOADER_UPGRADEABLE ||
    o === LOADER_V4 ||
    o === NATIVE_LOADER ||
    account.key === NATIVE_LOADER ||
    account.key === SECP256R1 ||
    account.executable
  );
}
/** Accounts that can't be a tip receiver or block builder: programs, sysvars and Config program accounts. */
function unpayable(account: AccountInfo): boolean {
  return isProgram(account) || account.owner === SYSVAR || account.owner === CONFIG_PROGRAM;
}

/**
 * transfer_or_credit_tip_pda: pay `amount` to `receiver` when it stays rent-exempt and is not a program; otherwise
 * the lamports go back into tip account 0 (they can't be left dangling). Returns what was paid.
 */
function payOrReturn(receiver: Mut<AccountInfo>, amount: u64, fallback: Mut<TipPaymentAccount>): u64 {
  require(receiver.lamports <= U64_MAX - amount, TipPaymentError.ArithmeticError);
  const after = receiver.lamports + amount;
  if (amount > 0n && after >= rentExempt(receiver.dataLen) && !isProgram(receiver)) {
    receiver.lamports = after;
    return amount;
  }
  require(fallback.lamports <= U64_MAX - amount, TipPaymentError.ArithmeticError);
  fallback.lamports += amount;
  return 0n;
}

/** handle_payments: drain the eight tip accounts; the block builder's commission (rounded down) to it, the rest to the tip receiver. */
function handlePayments(
  t0: Mut<TipPaymentAccount>,
  t1: Mut<TipPaymentAccount>,
  t2: Mut<TipPaymentAccount>,
  t3: Mut<TipPaymentAccount>,
  t4: Mut<TipPaymentAccount>,
  t5: Mut<TipPaymentAccount>,
  t6: Mut<TipPaymentAccount>,
  t7: Mut<TipPaymentAccount>,
  tip_receiver: Mut<AccountInfo>,
  block_builder: Mut<AccountInfo>,
  pct: u64,
): void {
  let total: u64 = 0n;
  total = addTips(total, drain(t0));
  total = addTips(total, drain(t1));
  total = addTips(total, drain(t2));
  total = addTips(total, drain(t3));
  total = addTips(total, drain(t4));
  total = addTips(total, drain(t5));
  total = addTips(total, drain(t6));
  total = addTips(total, drain(t7));
  require(pct === 0n || total <= U64_MAX / pct, TipPaymentError.ArithmeticError);
  const builderFee = (total * pct) / 100n;
  const receiverFee = total - builderFee;
  let toReceiver: u64 = 0n;
  if (receiverFee > 0n) {
    toReceiver = payOrReturn(tip_receiver, receiverFee, t0);
    if (toReceiver === 0n) log(`WARN: did not transfer tip receiver lamports to ${tip_receiver.key}`);
  }
  let toBuilder: u64 = 0n;
  if (builderFee > 0n) {
    toBuilder = payOrReturn(block_builder, builderFee, t0);
    if (toBuilder === 0n) log(`WARN: did not transfer block builder lamports to ${block_builder.key}`);
  }
  if (toReceiver > 0n || toBuilder > 0n)
    emit<TipsClaimed>({
      tip_receiver: toReceiver > 0n ? tip_receiver.key : NO_KEY,
      tip_receiver_amount: toReceiver,
      block_builder: toBuilder > 0n ? block_builder.key : NO_KEY,
      block_builder_amount: toBuilder,
    });
}

/** Create the config and the eight tip accounts (once); the payer starts as tip receiver and block builder. */
export function initialize(
  config: Init<Config>,
  tip_payment_account_0: Mut<AccountInfo>,
  tip_payment_account_1: Mut<AccountInfo>,
  tip_payment_account_2: Mut<AccountInfo>,
  tip_payment_account_3: Mut<AccountInfo>,
  tip_payment_account_4: Mut<AccountInfo>,
  tip_payment_account_5: Mut<AccountInfo>,
  tip_payment_account_6: Mut<AccountInfo>,
  tip_payment_account_7: Mut<AccountInfo>,
  system_program: SystemProgram,
  payer: Mut<Signer>,
  _bumps: InitBumps,
): void {
  config.bumps.config = config.create(payer, ["CONFIG_ACCOUNT"], 89n);
  config.tip_receiver = payer.key;
  config.block_builder = payer.key;
  config.bumps.tip_payment_account_0 = createTipAccount(payer, tip_payment_account_0, system_program, "TIP_ACCOUNT_0");
  config.bumps.tip_payment_account_1 = createTipAccount(payer, tip_payment_account_1, system_program, "TIP_ACCOUNT_1");
  config.bumps.tip_payment_account_2 = createTipAccount(payer, tip_payment_account_2, system_program, "TIP_ACCOUNT_2");
  config.bumps.tip_payment_account_3 = createTipAccount(payer, tip_payment_account_3, system_program, "TIP_ACCOUNT_3");
  config.bumps.tip_payment_account_4 = createTipAccount(payer, tip_payment_account_4, system_program, "TIP_ACCOUNT_4");
  config.bumps.tip_payment_account_5 = createTipAccount(payer, tip_payment_account_5, system_program, "TIP_ACCOUNT_5");
  config.bumps.tip_payment_account_6 = createTipAccount(payer, tip_payment_account_6, system_program, "TIP_ACCOUNT_6");
  config.bumps.tip_payment_account_7 = createTipAccount(payer, tip_payment_account_7, system_program, "TIP_ACCOUNT_7");
  config.block_builder_commission_pct = 0n;
}

/** Pay the tips out to the current receiver, then switch to a new one. */
export function changeTipReceiver(
  config: Mut<Config>,
  old_tip_receiver: Dup<Mut<AccountInfo>>,
  new_tip_receiver: Dup<Mut<AccountInfo>>,
  block_builder: Dup<Mut<AccountInfo>>,
  tip_payment_account_0: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_0"], "@config.bumps.tip_payment_account_0">,
  tip_payment_account_1: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_1"], "@config.bumps.tip_payment_account_1">,
  tip_payment_account_2: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_2"], "@config.bumps.tip_payment_account_2">,
  tip_payment_account_3: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_3"], "@config.bumps.tip_payment_account_3">,
  tip_payment_account_4: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_4"], "@config.bumps.tip_payment_account_4">,
  tip_payment_account_5: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_5"], "@config.bumps.tip_payment_account_5">,
  tip_payment_account_6: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_6"], "@config.bumps.tip_payment_account_6">,
  tip_payment_account_7: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_7"], "@config.bumps.tip_payment_account_7">,
  signer: Dup<Mut<Signer>>,
): void {
  constraint(old_tip_receiver, old_tip_receiver.key === config.tip_receiver);
  constraint(block_builder, block_builder.key === config.block_builder);
  constraint(tip_payment_account_0, tip_payment_account_0.lamports >= rentExempt(tip_payment_account_0.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_1, tip_payment_account_1.lamports >= rentExempt(tip_payment_account_1.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_2, tip_payment_account_2.lamports >= rentExempt(tip_payment_account_2.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_3, tip_payment_account_3.lamports >= rentExempt(tip_payment_account_3.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_4, tip_payment_account_4.lamports >= rentExempt(tip_payment_account_4.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_5, tip_payment_account_5.lamports >= rentExempt(tip_payment_account_5.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_6, tip_payment_account_6.lamports >= rentExempt(tip_payment_account_6.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_7, tip_payment_account_7.lamports >= rentExempt(tip_payment_account_7.dataLen), AnchorError.ConstraintRentExempt);
  require(!unpayable(new_tip_receiver), TipPaymentError.InvalidTipReceiver);
  handlePayments(
    tip_payment_account_0,
    tip_payment_account_1,
    tip_payment_account_2,
    tip_payment_account_3,
    tip_payment_account_4,
    tip_payment_account_5,
    tip_payment_account_6,
    tip_payment_account_7,
    old_tip_receiver,
    block_builder,
    config.block_builder_commission_pct,
  );
  config.tip_receiver = new_tip_receiver.key;
}

/** Pay the tips out under the current block builder, then switch to a new one with its commission (at most 100%). */
export function changeBlockBuilder(
  config: Mut<Config>,
  tip_receiver: Dup<Mut<AccountInfo>>,
  old_block_builder: Dup<Mut<AccountInfo>>,
  new_block_builder: Dup<Mut<AccountInfo>>,
  tip_payment_account_0: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_0"], "@config.bumps.tip_payment_account_0">,
  tip_payment_account_1: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_1"], "@config.bumps.tip_payment_account_1">,
  tip_payment_account_2: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_2"], "@config.bumps.tip_payment_account_2">,
  tip_payment_account_3: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_3"], "@config.bumps.tip_payment_account_3">,
  tip_payment_account_4: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_4"], "@config.bumps.tip_payment_account_4">,
  tip_payment_account_5: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_5"], "@config.bumps.tip_payment_account_5">,
  tip_payment_account_6: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_6"], "@config.bumps.tip_payment_account_6">,
  tip_payment_account_7: Seeds<Mut<TipPaymentAccount>, ["TIP_ACCOUNT_7"], "@config.bumps.tip_payment_account_7">,
  signer: Dup<Mut<Signer>>,
  block_builder_commission: u64,
): void {
  constraint(tip_receiver, tip_receiver.key === config.tip_receiver);
  constraint(old_block_builder, old_block_builder.key === config.block_builder);
  constraint(tip_payment_account_0, tip_payment_account_0.lamports >= rentExempt(tip_payment_account_0.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_1, tip_payment_account_1.lamports >= rentExempt(tip_payment_account_1.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_2, tip_payment_account_2.lamports >= rentExempt(tip_payment_account_2.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_3, tip_payment_account_3.lamports >= rentExempt(tip_payment_account_3.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_4, tip_payment_account_4.lamports >= rentExempt(tip_payment_account_4.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_5, tip_payment_account_5.lamports >= rentExempt(tip_payment_account_5.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_6, tip_payment_account_6.lamports >= rentExempt(tip_payment_account_6.dataLen), AnchorError.ConstraintRentExempt);
  constraint(tip_payment_account_7, tip_payment_account_7.lamports >= rentExempt(tip_payment_account_7.dataLen), AnchorError.ConstraintRentExempt);
  require(100n >= block_builder_commission, TipPaymentError.InvalidFee);
  require(!unpayable(new_block_builder), TipPaymentError.InvalidBlockBuilder);
  // The old commission, so a new block builder can't take the old one's share.
  handlePayments(
    tip_payment_account_0,
    tip_payment_account_1,
    tip_payment_account_2,
    tip_payment_account_3,
    tip_payment_account_4,
    tip_payment_account_5,
    tip_payment_account_6,
    tip_payment_account_7,
    tip_receiver,
    old_block_builder,
    config.block_builder_commission_pct,
  );
  config.block_builder = new_block_builder.key;
  config.block_builder_commission_pct = block_builder_commission;
}
