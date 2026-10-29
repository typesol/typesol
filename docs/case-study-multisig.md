# Case study: porting coral-xyz/multisig

This page ports a program that holds real authority on mainnet:
[coral-xyz/multisig](https://github.com/coral-xyz/multisig) (`programs/multisig/src/lib.rs`, Anchor 0.25, Apache-2.0),
deployed at `msigUdDBsR4zSUYqYEDrc1LcgtmuSDDM7KxpRUXNC6U`. The port is
[`examples/multisig.ts`](../examples/multisig.ts). Instead of a twin built for the occasion, it is checked against the
binary that runs on mainnet: [`test/examples/multisig.test.ts`](../test/examples/multisig.test.ts) runs both under the
same program id and compares every outcome and every account byte. See
[case-study-escrow.md](case-study-escrow.md) for a token program and [Migrate from Anchor](migrate-from-anchor.md) for
the general reference.

## The program

A multisig executes arbitrary instructions once `threshold` of its owners approve them. Its PDA (`[multisig]`, bump
`multisig.nonce`) signs the instruction, so it can hold anything a key can: a program's upgrade authority, a mint
authority, a treasury.

- `create_multisig(owners, threshold, nonce)` initializes an account the client allocated in the same transaction.
- `create_transaction(pid, accs, data)` stores a proposed instruction; the proposer, an owner, approves it.
- `approve()` adds an owner's approval.
- `execute_transaction()` runs the stored instruction through a CPI signed by the PDA once enough owners approved.
- `set_owners(owners)`, `change_threshold(threshold)` and `set_owners_and_change_threshold(...)` change the multisig;
  only its PDA can sign them, so they run as stored transactions the multisig executes on itself.

Upstream it is 337 lines of Rust; the port is 183 lines of TypeScript, comments included.

## What it needed

The port needed seven features TypeSOL did not have. They are general features now, each with tests of its own
(`test/language/dynamic-cpi.test.ts`, `constraint.test.ts`, `borsh-vec.test.ts`):

| Anchor | TypeSOL | |
| --- | --- | --- |
| `invoke_signed(&ix, ctx.remaining_accounts, …)` with `ix` built from account data | `invokeInstruction(programId, metas, data, remainingAccounts(), seeds)` | A CPI decided at run time. Each meta is a struct with `pubkey`, `isSigner`, `isWritable`. The runtime finds each account among the infos by key and checks privileges, as it does for Rust. |
| `#[account(zero, signer)] multisig: Box<Account<'info, Multisig>>` | `Signed<Zeroed<Multisig>>` of a `/** @layout borsh */` struct | `Zeroed` now takes Borsh structs (they start empty and are written as Borsh on return). `Signed<…>` is Anchor's `signer` constraint (2002). `Zeroed` now reports an already-set discriminator first, with Anchor's 2013. |
| `seeds = [multisig.key().as_ref()], bump = multisig.nonce` | `Seeds<Signer, ["@multisig"], "@multisig.nonce">` | A bump stored in another account. |
| `pub owners: Vec<Pubkey>` in an `#[account]` | `owners: Vec<Pubkey>` in a `/** @layout borsh */` struct | Anchor's Vec: any field, held on the heap while the instruction runs, bounded only by the account when it is written back (3004). |
| `multisig.owners = owners` | the same | A `Vec` argument copied whole into a list in account data. |
| `#[account(constraint = multisig.owner_set_seqno == transaction.owner_set_seqno)]` | `constraint(multisig, multisig.ownerSetSeqno === transaction.ownerSetSeqno)` | Runs with the account's checks, so a transaction breaking several gets Anchor's code. |
| `TransactionAccount { pubkey, is_signer, is_writable }` | `interface TransactionAccount { pubkey; isSigner; isWritable }` | `isSigner` / `isWritable` were reserved field names everywhere; now only in structs held in an account, where they would shadow `acct.isSigner`. |

## Side by side

The heart of the program, executing an approved transaction:

```rust
pub fn execute_transaction(ctx: Context<ExecuteTransaction>) -> Result<()> {
    if ctx.accounts.transaction.did_execute {
        return Err(ErrorCode::AlreadyExecuted.into());
    }
    let sig_count = ctx.accounts.transaction.signers.iter().filter(|&did_sign| *did_sign).count() as u64;
    if sig_count < ctx.accounts.multisig.threshold {
        return Err(ErrorCode::NotEnoughSigners.into());
    }
    let mut ix: Instruction = (*ctx.accounts.transaction).deref().into();
    ix.accounts = ix.accounts.iter().map(|acc| {
        let mut acc = acc.clone();
        if &acc.pubkey == ctx.accounts.multisig_signer.key {
            acc.is_signer = true;
        }
        acc
    }).collect();
    let multisig_key = ctx.accounts.multisig.key();
    let seeds = &[multisig_key.as_ref(), &[ctx.accounts.multisig.nonce]];
    let signer = &[&seeds[..]];
    let accounts = ctx.remaining_accounts;
    solana_program::program::invoke_signed(&ix, accounts, signer)?;
    ctx.accounts.transaction.did_execute = true;
    Ok(())
}
```

```ts
export function executeTransaction(
  multisig: Account<Multisig>,
  multisigSigner: Seeds<AccountInfo, ["@multisig"], "@multisig.nonce">,
  transaction: HasOne<Mut<Transaction>, "multisig">,
): void {
  constraint(multisig, multisig.ownerSetSeqno === transaction.ownerSetSeqno);
  require(!transaction.didExecute, ErrorCode.AlreadyExecuted);
  let sigCount = 0n;
  for (const didSign of transaction.signers) if (didSign) sigCount++;
  require(sigCount >= multisig.threshold, ErrorCode.NotEnoughSigners);
  const metas: FixedVec<TransactionAccount, 32> = transaction.accounts.map((acc) => ({
    pubkey: acc.pubkey,
    isSigner: acc.isSigner || acc.pubkey === multisigSigner.key,
    isWritable: acc.isWritable,
  }));
  invokeInstruction(transaction.programId, metas, transaction.data, remainingAccounts(), [multisig.key, multisig.nonce]);
  transaction.didExecute = true;
}
```

The `#[derive(Accounts)]` structs become parameter types, and Anchor's `constraint = …` becomes `constraint(…)` at
the start of the body: it runs with the multisig's checks, raising the same 2003. The error enum keeps its order and
messages, so the codes stay 6000–6008. Account and instruction names and the Borsh layout are the original's, so
existing clients and existing accounts work with the port unchanged.

## How it was checked

`test/programs/coral_multisig.so` is the program dumped from mainnet on 2026-10-29 (sha256 in
[`test/programs/SOURCES.md`](../test/programs/SOURCES.md)). The test loads it into one LiteSVM and the port into
another, both at `msigUdDB…`, then sends each transaction to both. After each one it requires the same outcome (success,
or the same error down to the code) and the same lamports, owner and data bytes for every account involved.

There are 52 transactions:

- **The upstream test suite** (`tests/multisig.js`): create a 2-of-3 multisig, propose `set_owners`, approve, and
  execute through the PDA. Then `Assert Unique Owners` (6008).
- **Every `create_multisig` refusal**: threshold 0 or above the owner count (6007), no owners, the account not signing
  (2002), not rent-exempt (2005), owned by another program (3007), too small for the empty value (3003) or for the
  owners (3004), already initialized (2013).
- **Proposals, approvals and executions**:
  - a proposer or approver outside the owner set (6000);
  - another multisig's transaction (2001);
  - too few approvals (6002);
  - a wrong PDA (2006);
  - executing twice (6006);
  - a changed owner set invalidating a proposal (2003), also when the proposal belongs to another multisig as well
    (2003 under both: the constraint on `multisig` runs before the transaction's `has_one`);
  - `set_owners` sent directly, which the PDA cannot sign (3010);
  - a Transaction passed as a Multisig (3002);
  - the target program missing from the remaining accounts (the runtime's error).
- **Self-calls through `execute_transaction`**:
  - `change_threshold`;
  - `set_owners` shrinking the owner set below the threshold, which drops the threshold;
  - `set_owners_and_change_threshold`;
  - a threshold too high, which fails inside the CPI and fails the whole execution with 6007.
- **A real payout**: the PDA sends 1.5 SOL through a System transfer. A stored meta claiming the recipient signed is
  refused by the runtime under both programs.
- **An account larger than one transaction can fill**: a multisig with 40 owners in a 2,000-byte account, as the
  original holds it after `set_owners` calls grew the set, proposed to, approved and executed under both.

## Cost

These are compute units per transaction, original versus port, from that test. Each `execute` figure includes the
instruction it runs.

| Instruction | Anchor 0.25 (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `create_multisig` | 3,591 | 560 | −84% |
| `create_transaction` | 6,591 | 1,125 | −83% |
| `approve` | 5,515 | 1,175 | −79% |
| `execute_transaction` → `set_owners` | 15,227 | 4,313 | −72% |
| `execute_transaction` → `change_threshold` | 14,723 | 3,972 | −73% |
| `execute_transaction` → `set_owners_and_change_threshold` | 15,129 | 4,273 | −72% |
| `execute_transaction` → System transfer | 9,961 | 3,358 | −66% |

Refusals cost less too. For example, an already-initialized account costs 3,378 against 160, and a missing signature
4,229 against 177. The binary is 526,688 bytes on mainnet and 29,984 bytes for the port, 18 times smaller. Deploying it
needs about 3.5 SOL less rent.

The original was built with Anchor 0.25; a rebuild with a current Anchor would cost less than the mainnet figures. The
escrow case study and the benchmarks compare against Anchor 1.x.

## Where they differ

- **Accounts per instruction.** A TypeSOL instruction takes at most 32 accounts (5113), so `execute_transaction` can
  hand a stored instruction at most 29 remaining accounts, and the port builds the signed metas in a list of 32. The
  original takes as many as the runtime allows.
- **Heap.** Both hold a Borsh account's lists on the heap (32 KiB by default) while the instruction runs. The port's
  lists grow by doubling, as Rust's do, so both run out at about the same sizes: far beyond what these accounts hold.
- **Logs.** Error messages are logged in TypeSOL's words and the original's error names are not logged; codes are the
  same.

Earlier versions of this port held its lists in `FixedVec`s with fixed capacities and checked the owner-set sequence
number in the body, after `has_one`. Both differences are gone: the lists are Anchor's `Vec`, bounded only by the account,
and `constraint(…)` runs where Anchor runs it.
