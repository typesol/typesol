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

Upstream it is 337 lines of Rust; the port is 184 lines of TypeScript, comments included.

## What it needed

The port needed five features TypeSOL did not have. They are general features now, each with tests of its own
(`test/language/dynamic-cpi.test.ts`):

| Anchor | TypeSOL | |
| --- | --- | --- |
| `invoke_signed(&ix, ctx.remaining_accounts, …)` with `ix` built from account data | `invokeInstruction(programId, metas, data, remainingAccounts(), seeds)` | A CPI decided at run time. Each meta is a struct with `pubkey`, `isSigner`, `isWritable`. The runtime finds each account among the infos by key and checks privileges, as it does for Rust. |
| `#[account(zero, signer)] multisig: Box<Account<'info, Multisig>>` | `Signed<Zeroed<Multisig>>` of a `/** @layout borsh */` struct | `Zeroed` now takes Borsh structs (they start empty and are written as Borsh on return). `Signed<…>` is Anchor's `signer` constraint (2002). `Zeroed` now reports an already-set discriminator first, with Anchor's 2013. |
| `seeds = [multisig.key().as_ref()], bump = multisig.nonce` | `Seeds<Signer, ["@multisig"], "@multisig.nonce">` | A bump stored in another account. |
| `multisig.owners = owners` | the same, into a `FixedVec<Pubkey, 34>` | A `Vec` argument copied whole into a list in account data. |
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
  require(multisig.ownerSetSeqno === transaction.ownerSetSeqno, AnchorError.ConstraintRaw);
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

The `#[derive(Accounts)]` structs become parameter types. Anchor's `constraint = multisig.owner_set_seqno ==
transaction.owner_set_seqno` becomes the first `require`, raising the same 2003. The error enum keeps its order and
messages, so the codes stay 6000–6008. Account and instruction names and the Borsh layout are the original's, so
existing clients and existing accounts work with the port unchanged.

## How it was checked

`test/programs/coral_multisig.so` is the program dumped from mainnet on 2026-10-29 (sha256 in
[`test/programs/SOURCES.md`](../test/programs/SOURCES.md)). The test loads it into one LiteSVM and the port into
another, both at `msigUdDB…`, then sends each transaction to both. After each one it requires the same outcome (success,
or the same error down to the code) and the same lamports, owner and data bytes for every account involved.

There are 43 transactions:

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
  - a changed owner set invalidating a proposal (2003);
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

## Cost

These are compute units per transaction, original versus port, from that test. Each `execute` figure includes the
instruction it runs.

| Instruction | Anchor 0.25 (mainnet) | TypeSOL | |
| --- | ---: | ---: | ---: |
| `create_multisig` | 3,591 | 564 | −84% |
| `create_transaction` | 6,591 | 1,077 | −84% |
| `approve` | 5,515 | 1,003 | −82% |
| `execute_transaction` → `set_owners` | 15,227 | 4,133 | −73% |
| `execute_transaction` → `change_threshold` | 14,723 | 3,781 | −74% |
| `execute_transaction` → `set_owners_and_change_threshold` | 15,129 | 4,095 | −73% |
| `execute_transaction` → System transfer | 9,961 | 3,182 | −68% |

Refusals cost less too. For example, an already-initialized account costs 3,378 against 160, and a missing signature
4,229 against 177. The binary is 526,688 bytes on mainnet and 29,984 bytes for the port, 18 times smaller. Deploying it
needs about 3.5 SOL less rent.

The original was built with Anchor 0.25; a rebuild with a current Anchor would cost less than the mainnet figures. The
escrow case study and the benchmarks compare against Anchor 1.x.

## Where they differ

- **List capacities.** Anchor's `Vec` fields are bounded only by the account's size. The port's lists are `FixedVec`s:
  - 34 owners;
  - 32 accounts and 1,100 data bytes per stored instruction;
  - 34 approvals.

  A transaction (1,232 bytes) cannot carry more than these, so a client never meets them. A program calling the
  multisig through a CPI can send more (CPI data may reach 10 KiB). The original would accept that if the account were
  large enough; the port refuses with 5104. Reading an account the original wrote with more elements fails with 3003.
- **Check order on one double fault.** In `approve` and `execute_transaction` the original checks the owner-set
  sequence number (2003) with the multisig account, before the transaction's `has_one` (2001). The port checks
  `has_one` in the prologue and the sequence number first in the body. So a transaction that belongs to another
  multisig *and* has a stale sequence number gets 2001 here and 2003 there. A transaction breaking only one of the two
  gets the same code under both.
- **Logs.** Error messages are logged in TypeSOL's words and the original's error names are not logged; codes are the
  same.
