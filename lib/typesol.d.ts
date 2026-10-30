/**
 * TypeSOL language surface.
 *
 * These declarations exist so TypeSOL sources typecheck under plain `tsc` and get
 * editor completion. They have no runtime: the TypeSOL compiler reads the source,
 * enforces the TypeSOL subset, and emits a native Solana SBF program.
 *
 * Integer types are all `bigint` to TypeScript. The compiler tracks the declared
 * width itself, rejects `number`, and checks every arithmetic operation for
 * overflow at runtime.
 *
 * Integer operators: + - * / % are checked (overflow and division by zero abort). & | ^ work on equal types;
 * << aborts when bits would be lost or the amount is not below the width; >> is arithmetic on signed types;
 * ~ flips the bits within the type's width.
 */

export type u8 = bigint;
export type u16 = bigint;
export type u32 = bigint;
export type u64 = bigint;
export type u128 = bigint;
export type i8 = bigint;
export type i16 = bigint;
export type i32 = bigint;
export type i64 = bigint;
export type i128 = bigint;

/** A 32-byte Solana address. Compare with `===`, `!==` or `.equals()`. */
export interface Pubkey {
  readonly __pubkey: unique symbol;
  equals(other: Pubkey): boolean;
  /** Rust's order on the 32 bytes (lexicographic): -1, 0 or 1. `a.compare(b) < 0n` is Rust's `a < b`. */
  compare(other: Pubkey): i64;
}

/**
 * Callback methods of Vec, FixedArray and FixedVec. Each expands into a loop over the elements (as `list.get(i)` gives
 * them: structs by reference) with the arrow written at the call; it may read and write the function's variables.
 */
export interface ListMethods<T> {
  forEach(fn: (x: T, index: u64) => void): void;
  /** Whether `fn` holds for some element (stops at the first). */
  some(fn: (x: T, index: u64) => boolean): boolean;
  /** Whether `fn` holds for every element (stops at the first that fails). */
  every(fn: (x: T, index: u64) => boolean): boolean;
  /** The first element `fn` holds for, or null (integer, boolean, Pubkey and enum elements). */
  find(fn: (x: T, index: u64) => boolean): T | null;
  /** The index of the first element `fn` holds for, or -1. */
  findIndex(fn: (x: T, index: u64) => boolean): i64;
  reduce<A>(fn: (acc: A, x: T, index: u64) => A, initial: A): A;
  /** Whether an element equals `value` (===). */
  includes(value: T): boolean;
  /** The index of the first element equal to `value`, or -1. */
  indexOf(value: T): i64;
  /**
   * The elements `fn` maps them to (integers, booleans, Pubkeys or enums). Use it right away (another list method,
   * `.length`, `for … of`: one loop, nothing stored) or store it (`const ys = xs.map(…)`: a FixedVec on the stack, as
   * big as `xs`; from a `Vec`, annotate it: `const ys: FixedVec<u64, 16> = …`). Stored with a `FixedVec<Struct, N>` or
   * `FixedVec<FixedString<N>, M>` annotation it gives structs (`(o) => ({ qty: o.qty })`) or text. A stored list holds
   * at most 2 KiB; one element more than it holds aborts (5104).
   */
  map<U>(fn: (x: T, index: u64) => U): FixedVec<U, never>;
  /** The elements `fn` holds for, used or stored like `map`'s; callbacks after it get the index among those. */
  filter(fn: (x: T, index: u64) => boolean): FixedVec<T, never>;
}

/**
 * A fixed-length array stored inline in account data, e.g. `scores: FixedArray<u64, 8>`.
 * Indexes are bounds-checked; out of range aborts the instruction.
 */
export interface FixedArray<T, N extends number> extends ListMethods<T> {
  readonly length: u64;
  get(index: bigint): T;
  set(index: bigint, value: T): void;
  readonly __length?: N;
  /** `for (const x of arr)`: each element in order, as `arr.get(i)` gives it. */
  [Symbol.iterator](): Iterator<T>;
}

/** Create a local fixed-length array filled with `fill`: `const xs = fixedArray<u64, 4>(0n)`. */
export declare function fixedArray<T, N extends number>(fill: T): FixedArray<T, N>;

/**
 * A string stored inline in account data with room for N bytes (u32 length + N bytes).
 * Read it like a string; assigning a longer string aborts the instruction.
 */
export type FixedString<N extends number> = string & { readonly __capacity?: N };

/** UTF-8 byte length of a string. (`.length` is not available: it would be a JS number.) */
export declare function byteLength(value: string): u64;

/**
 * An optional value: `best: Option<u64>` (same as `u64 | null`), also of a struct (`home: Option<Point>`). Compare with `=== null` / `!== null`;
 * TypeScript narrows it, and using an empty option where a value is needed aborts (5108).
 * In account data it takes a fixed 1 + size(T) bytes.
 */
export type Option<T> = T | null;

/**
 * A growable list. As an account struct field it is stored Borsh-style (u32 length + elements) and the account is
 * resized as it grows. An account may have any number of them, declared anywhere: they are stored after the
 * fixed-size fields, in the order declared. In a `@layout borsh` struct it is Anchor's `Vec<T>`: anywhere among the
 * fields, held on the heap while the instruction runs, and bounded only by the account when it is written back
 * (3004). As an instruction argument it is a read-only view.
 */
export interface Vec<T> extends ListMethods<T> {
  readonly length: u64;
  get(index: bigint): T;
  set(index: bigint, value: T): void;
  /**
   * Append. In account data the account grows by one element and `payer` (required there) tops up rent; in a
   * `@layout borsh` struct the list grows on the heap and takes no payer (the account must hold it when it is written
   * back: 3004, as under Anchor).
   */
  push(value: T, payer?: Mut<Signer>): void;
  /** Remove and return the last element, shrinking the account. */
  pop(): T;
  /** Remove every element, shrinking the account. */
  clear(): void;
  /** `for (const x of vec)`: each element in order, as `vec.get(i)` gives it; the length is read again every step. */
  [Symbol.iterator](): Iterator<T>;
}

/**
 * A list stored inline with room for N elements: a u32 length, then N slots (Anchor `Vec<T>` with `#[max_len(N)]`, but
 * always 4 + N × size(T) bytes). Unlike `Vec<T>` its size is fixed: it keeps its place among the fields, can be in
 * nested structs, and `push` takes no payer; `push` fails (5104) when it is full. Write a whole one with `fixedVec([a, b])`.
 */
export interface FixedVec<T, N extends number> extends ListMethods<T> {
  readonly length: u64;
  get(index: bigint): T;
  set(index: bigint, value: T): void;
  push(value: T): void;
  pop(): T;
  clear(): void;
  [Symbol.iterator](): Iterator<T>;
  readonly __capacity?: N;
}
/** A FixedVec value holding these elements (`acct.owners = fixedVec([a, b])`, `{ owners: fixedVec([]) }`). */
export declare function fixedVec<T>(items: T[]): FixedVec<T, never>;

/** One extra account passed after the declared ones. Nothing about it is checked until you check it. */
export interface RemainingAccount {
  readonly key: Pubkey;
  readonly owner: Pubkey;
  /** Writing requires the account to be writable (checked at runtime). */
  lamports: u64;
  readonly dataLen: u64;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

/**
 * The accounts a client passed beyond the instruction's declared parameters. Spread them into a CPI's account list:
 * `...remainingAccounts()` passes each with the flags it was passed with (Rust's `extend_from_slice`),
 * `...readonly(rest)` / `...writable(rest)` pass them all with that role (a cNFT proof, a harvest's sources).
 */
export interface RemainingAccounts extends Iterable<CpiAccount> {
  readonly length: u64;
  get(index: bigint): RemainingAccount;
  /** Indexes start..end (end: all) of them, only to spread into a CPI: `...readonly(rest.slice(0n, proofLength))`. */
  slice(start: bigint, end?: bigint): RemainingSlice;
}
/** Part of the remaining accounts (`rest.slice(a, b)`): spread it into a CPI's account list, directly or via readonly/writable. */
export interface RemainingSlice extends Iterable<CpiAccount> {
  readonly __remainingSlice: void;
}
export declare function remainingAccounts(): RemainingAccounts;

/**
 * Read a struct of this program from a remaining account: owner, discriminator and size are checked.
 * `loadAccountMut` also requires it to be writable, not aliased by another writable account, and not already loaded
 * with `loadAccountMut` in this instruction (2040).
 */
export declare function loadAccount<T>(account: RemainingAccount): Readonly<T>;
export declare function loadAccountMut<T>(account: RemainingAccount): T;

/** 32 bytes of hash output (sha256 / keccak256, Merkle roots). Compare with `===`. */
export interface Hash {
  readonly __hash: unique symbol;
  equals(other: Hash): boolean;
}

/** sha256 over the parts concatenated: strings (UTF-8), Pubkeys/Hashes (32 bytes), integers (LE), booleans (1 byte). */
export declare function sha256(...parts: (string | Pubkey | Hash | bigint | boolean)[]): Hash;
/** keccak256 over the parts concatenated, encoded as for sha256. */
export declare function keccak256(...parts: (string | Pubkey | Hash | bigint | boolean)[]): Hash;

/**
 * Verify a Merkle proof (keccak256, sorted pairs: the OpenZeppelin convention most airdrop tools use).
 * `proof` must be a `Vec<Hash>` instruction argument. Leaves and inner nodes hash alike: build the leaf in the program
 * as OpenZeppelin does, `keccak256(keccak256(data))`, never take it from the arguments (an inner node would pass).
 */
export declare function merkleVerify(leaf: Hash, proof: Vec<Hash>, root: Hash): boolean;

/**
 * The Instructions sysvar (Sysvar1nstructions…): every instruction of the transaction being executed. Its address is
 * checked. What it holds is the transaction author's: use it to require something of the transaction (a repay
 * instruction after a flash loan, a fee instruction before), never as proof of anything else.
 */
export interface InstructionsSysvar extends AccountMeta {
  readonly __instructions_sysvar: void;
  /** How many instructions the transaction has. */
  readonly length: u64;
  /** The index of the top-level instruction being executed (this one, or the one that CPI'd into this program). */
  currentIndex(): u64;
  /** The transaction's instruction at `index` (5104 when there is none). */
  get(index: u64): TransactionInstruction;
}
/** One instruction of the transaction, read from the Instructions sysvar. Reads past its end fail with 5104. */
export interface TransactionInstruction {
  readonly __transaction_instruction: void;
  readonly programId: Pubkey;
  readonly accountsLength: u64;
  readonly dataLength: u64;
  accountKey(i: u64): Pubkey;
  accountIsSigner(i: u64): boolean;
  accountIsWritable(i: u64): boolean;
  /** Little-endian integers and keys from the instruction data. */
  readU8(offset: u64): u8;
  readU16(offset: u64): u16;
  readU32(offset: u64): u32;
  readU64(offset: u64): u64;
  readPubkey(offset: u64): Pubkey;
  /** `program`'s instruction `name` (snake_case or camelCase): its program id and 8-byte Anchor discriminator match. */
  is(program: Pubkey, name: string): boolean;
}
/**
 * How deep in cross-program calls this program runs: 1 when the transaction calls it directly, more when another
 * program invoked it. `require(stackHeight() === 1n, …)` refuses CPI callers.
 */
export declare function stackHeight(): u64;

/**
 * True when this transaction contains an Ed25519 precompile instruction that verified `message`
 * signed by `signer` (offsets inside the precompile's own data). The client adds that instruction;
 * the runtime rejects the transaction if the signature is wrong.
 */
export declare function verifyEd25519(instructions: InstructionsSysvar, signer: Pubkey, message: string | Hash | Pubkey): boolean;

/**
 * Recover the secp256k1 signer of `hash` from (r, s, recoveryId) and compare it with an Ethereum
 * address given left-padded to 32 bytes (12 zero bytes + 20 address bytes). High-s signatures are refused.
 * `hash` must be computed in the program — `keccak256(...)` of the message or `ethMessageHash(message)` — because
 * a signature can be made up for an arbitrary hash; the compiler rejects anything else.
 */
export declare function verifySecp256k1(hash: Hash, recoveryId: u8, r: Hash, s: Hash, ethAddress: Hash): boolean;
/**
 * The hash an Ethereum wallet signs for `personal_sign` (EIP-191): keccak256("\x19Ethereum Signed Message:\n" + length + message).
 * `verifySecp256k1(ethMessageHash(message), …)` checks a MetaMask-style signature.
 */
export declare function ethMessageHash(message: string): Hash;

/**
 * A Pyth `PriceUpdateV2` account (Pyth Solana Receiver, rec5EKMG…). Owner and discriminator are checked.
 * The fields are the raw update and are NOT checked: it may be only partially verified, for another feed, or stale.
 * Use pythPrice() for a verified, fresh, feed-matched price (with `exponent` to pin the scale).
 */
export interface PythPriceUpdate extends AccountMeta {
  readonly __pyth: void;
  readonly feedId: Hash;
  readonly price: i64;
  readonly conf: u64;
  /** Price = price * 10^exponent */
  readonly exponent: i64;
  readonly publishTime: i64;
  readonly fullyVerified: boolean;
}
/**
 * Like Pyth's get_price_no_older_than: fully verified, `feedId` matches, published within `maxAgeSeconds` (5111
 * otherwise). The price is in units of 10^exponent: pass the `exponent` your arithmetic assumes and a feed whose
 * exponent differs is refused, instead of read at the wrong scale.
 */
export declare function pythPrice(update: PythPriceUpdate, feedId: Hash, maxAgeSeconds: u64, exponent?: i32): i64;

/**
 * A Switchboard On-Demand pull feed (PullFeedAccountData). Mainnet program unless `SwitchboardFeed<"devnet">`
 * (never accept the devnet program id on mainnet: anyone could deploy there).
 */
export interface SwitchboardFeed<Cluster extends "mainnet" | "devnet" = "mainnet"> extends AccountMeta {
  readonly __switchboard: Cluster;
}
/**
 * The feed's current result scaled to `decimals` (from 18), if `feed` is `expectedFeed` (anyone can create feeds),
 * it has samples and it is at most `maxStaleSlots` old.
 */
export declare function switchboardValue(
  feed: SwitchboardFeed<"mainnet" | "devnet">,
  expectedFeed: Pubkey,
  maxStaleSlots: u64,
  decimals: u8,
  /** The fewest oracle samples the result may rest on (default 1). */
  minSamples?: u8,
): i64;

/** The Associated Token Account program (ATokenGP…). Its address is checked. */
/** The SPL Memo program (v2, `MemoSq4g…`). Its address is checked. */
export interface MemoProgram extends AccountMeta {
  readonly __memo_program: void;
  /**
   * Record a UTF-8 memo in the transaction (Anchor's `spl_memo::build_memo`). Each account in `signers` must sign it:
   * a `Signer`, or a PDA of this program with `signerSeeds`.
   */
  memo(text: string, signers?: AccountMeta[], signerSeeds?: Seed[] | SignerSeeds): void;
}

/**
 * The SlotHashes sysvar (`SysvarS1otHashes…`), read as an account: it is too large for the sysvar syscalls (Anchor's
 * `Sysvar<SlotHashes>` cannot load it either). The address is checked, and that it holds an entry (5103).
 */
export interface SlotHashesSysvar extends AccountMeta {
  readonly __slot_hashes: void;
  /** How many recent slots it lists (up to 512). */
  readonly count: u64;
  /** The most recent slot it lists, and that slot's bank hash: known to everyone, so not a secret source of randomness. */
  readonly latestSlot: u64;
  readonly latestHash: Hash;
}

export interface AssociatedTokenProgram extends AccountMeta {
  readonly __ata_program: void;
  create(
    payer: Mut<Signer>,
    ata: AccountMeta,
    owner: AccountMeta,
    mint: AccountMeta,
    systemProgram: SystemProgram,
    tokenProgram: TokenProgram | Token2022Program | TokenInterface,
  ): void;
  /** Like create, but succeeds if the account already exists. */
  createIdempotent(
    payer: Mut<Signer>,
    ata: AccountMeta,
    owner: AccountMeta,
    mint: AccountMeta,
    systemProgram: SystemProgram,
    tokenProgram: TokenProgram | Token2022Program | TokenInterface,
  ): void;
}
/** The associated token account address of `owner` for `mint` under `tokenProgram`. */
export declare function associatedTokenAddress(owner: Pubkey, mint: Pubkey, tokenProgram: Pubkey): Pubkey;

/** A creator in Metaplex metadata. `verified` can only be true for the update authority when it signs. */
export interface MetadataCreator {
  address: Pubkey;
  verified: boolean;
  share: u8;
}

/** Metaplex Token Metadata (metaqbxx…). Its address is checked. */
export interface TokenMetadataProgram extends AccountMeta {
  readonly __mpl_metadata: void;
  /** CreateMetadataAccountV3 with no creators/collection/uses. Pass signerSeeds when the mint authority is a PDA of this program. */
  createV3(
    metadata: AccountMeta,
    mint: AccountMeta,
    mintAuthority: AccountMeta,
    payer: Mut<Signer>,
    updateAuthority: AccountMeta,
    systemProgram: SystemProgram,
    name: string,
    symbol: string,
    uri: string,
    sellerFeeBasisPoints: u16,
    isMutable: boolean,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /**
   * With creators (1–5, shares adding up to 100), an unverified collection mint, and/or `isCollection: true`
   * (CollectionDetails::V1: this NFT is a sized collection other NFTs are verified into).
   */
  createV3(
    metadata: AccountMeta,
    mint: AccountMeta,
    mintAuthority: AccountMeta,
    payer: Mut<Signer>,
    updateAuthority: AccountMeta,
    systemProgram: SystemProgram,
    name: string,
    symbol: string,
    uri: string,
    sellerFeeBasisPoints: u16,
    isMutable: boolean,
    extras: { creators?: MetadataCreator[]; collection?: Pubkey; isCollection?: boolean },
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /**
   * CreateMasterEditionV3: makes `mint` (supply 1, decimals 0) a master edition; the mint and freeze authorities move
   * to the edition. `maxSupply` 0n is a one of one, `null` allows unlimited prints.
   */
  createMasterEditionV3(
    edition: AccountMeta,
    mint: AccountMeta,
    updateAuthority: AccountMeta,
    mintAuthority: AccountMeta,
    payer: Mut<Signer>,
    metadata: AccountMeta,
    tokenProgram: TokenProgram,
    systemProgram: SystemProgram,
    maxSupply: u64 | null,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /**
   * Verify with CollectionV1: marks `metadata`'s collection (set with createV3's `collection`) verified. `authority` is
   * the collection's update authority; the collection is a master edition created with `isCollection: true`.
   */
  verifyCollection(
    authority: AccountMeta,
    metadata: AccountMeta,
    collectionMint: AccountMeta,
    collectionMetadata: AccountMeta,
    collectionMasterEdition: AccountMeta,
    systemProgram: SystemProgram,
    instructionsSysvar: AccountMeta,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /**
   * UpdateMetadataAccountV2 (Anchor's `update_metadata_accounts_v2`): `data` replaces the whole DataV2 (creators and
   * collection left out become none; a verified collection or creator cannot be changed this way, Metaplex refuses);
   * each `null` leaves that part as it is. The update authority signs (a PDA of this program with `signerSeeds`).
   */
  updateMetadataAccountsV2(
    metadata: AccountMeta,
    updateAuthority: AccountMeta,
    data: {
      name: string;
      symbol: string;
      uri: string;
      sellerFeeBasisPoints: u16;
      creators?: { address: Pubkey; verified: boolean; share: u8 }[];
      collection?: Pubkey;
    } | null,
    newUpdateAuthority: Pubkey | null,
    primarySaleHappened: boolean | null,
    isMutable: boolean | null,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
}
/** The Metaplex master edition address of a mint (PDA ["metadata", program, mint, "edition"]). */
export declare function masterEditionAddress(mint: Pubkey): Pubkey;
/** The canonical program address of `seeds` under `program` (Rust `Pubkey::find_program_address(seeds, program).0`). */
export declare function findProgramAddress(seeds: Seed[], program: Pubkey): Pubkey;
/** The bump of that canonical program address (`Pubkey::find_program_address(seeds, program).1`), to sign with it. */
export declare function findProgramAddressBump(seeds: Seed[], program: Pubkey): u8;
/** This program's address (`crate::ID`). */
export declare function programId(): Pubkey;
/**
 * Anchor's `AccountLoader::load_init` on an account the instruction created itself (`systemProgram.createAccount`, or
 * `allocate` + `assign` on a pre-funded address): it must be owned by this program (3007), writable (3006), hold the
 * struct (3003) and have no discriminator yet (3000). The discriminator is written and the data is returned to fill.
 * Takes a `Mut<AccountInfo>` parameter or a remaining account.
 */
export declare function initAccount<T>(account: AccountMeta | RemainingAccount): T;
/** The Metaplex metadata account address of a mint. */
export declare function metadataAddress(mint: Pubkey): Pubkey;

/**
 * Create the transfer-hook validation account (an ExtraAccountMetaList) at PDA ["extra-account-metas", mint], listing
 * the extra accounts Token-2022 passes to the hook after the standard four and this account (so the first extra account
 * has index 5). Pair it with instructions tagged `@discriminator spl-transfer-hook-interface:execute` and
 * `@discriminator spl-transfer-hook-interface:initialize-extra-account-metas`.
 *
 * Each extra account (a literal list; Rust `ExtraAccountMeta::new_with_pubkey` / `new_with_seeds` /
 * `new_external_pda_with_seeds`):
 *  - `{ address: WSOL_MINT, isSigner: false, isWritable: false }`: a fixed address;
 *  - `{ seeds: ["counter", seedAccountKey(3n)], isWritable: true }`: a PDA of this program;
 *  - `{ seeds: [...], program: 6n }`: a PDA of the program at account index 6.
 */
export declare function initExtraAccountMetas(
  payer: Mut<Signer>,
  account: AccountMeta,
  mint: AccountMeta,
  systemProgram: SystemProgram,
  extraAccounts?: ExtraAccountMeta[],
): void;
/**
 * Rewrite this program's existing ExtraAccountMetaList for `mint` (Rust `ExtraAccountMetaList::update`), resizing it to
 * the new list; `payer` tops it up to the rent of the new size when needed.
 */
export declare function updateExtraAccountMetas(
  payer: Mut<Signer>,
  account: AccountMeta,
  mint: AccountMeta,
  systemProgram: SystemProgram,
  extraAccounts?: ExtraAccountMeta[],
): void;
export type ExtraAccountMeta =
  | { address: Pubkey; isSigner?: boolean; isWritable?: boolean }
  | { seeds: (string | ExtraAccountSeed)[]; program?: bigint; isSigner?: boolean; isWritable?: boolean };
export interface ExtraAccountSeed {
  readonly __extraSeed: void;
}
/** Seed::AccountKey: the key of the account at this index of the execute instruction. */
export declare function seedAccountKey(index: bigint): ExtraAccountSeed;
/** Seed::AccountData: `length` bytes at `offset` of the data of the account at `index`. */
export declare function seedAccountData(index: bigint, offset: bigint, length: bigint): ExtraAccountSeed;
/** Seed::InstructionData: `length` bytes at `offset` of the execute instruction's data. */
export declare function seedInstructionData(offset: bigint, length: bigint): ExtraAccountSeed;

/** Fields every account parameter exposes. */
export interface AccountMeta {
  readonly key: Pubkey;
  /** Writable only on `Mut<...>` / `Init<...>` accounts. */
  lamports: u64;
  readonly dataLen: u64;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

/**
 * A 32-byte address written in base58, checked at compile time: `const ADMIN = pubkey("4Nd1…")`.
 * Works as a top-level constant and inline.
 */
export declare function pubkey(base58: string): Pubkey;

/**
 * The account must be this exact address (Anchor `address = …`, error 2012): `Address<Mut<AccountInfo>, "4Nd1…">`.
 * A third argument fails with one of your errors instead (Anchor's `address = … @ ErrorCode.X`).
 */
export type Address<A, Base58 extends string, E = never> = A & { readonly __address?: [Base58, E] };

/**
 * Token constraints, checked before your code runs:
 *  - `HasOne<TokenAccount, "mint" | "owner">`: the token account's mint / owner is the key of the parameter with that name (2014 / 2015).
 *  - `HasOne<Mint, "mintAuthority" | "freezeAuthority">`: the mint's authority is that parameter's key (2016 / 2017).
 *  - `Ata<TokenAccount, "owner", "mint">`: the account is the associated token account of those parameters (2009).
 *  - `Ata<Init<TokenAccount>, "owner", "mint">` / `Ata<InitIfNeeded<TokenAccount>, …>`: the instruction creates that
 *    account with `create(payer)` / `createIfNeeded(payer)` (needs the AssociatedTokenProgram and SystemProgram).
 */
export type Ata<A, Owner extends string, MintParam extends string> = A & { readonly __ata?: [Owner, MintParam] };

/** Token authority kinds for setAuthority (SPL Token AuthorityType). */
export declare const AuthorityType: {
  readonly MintTokens: u8;
  readonly FreezeAccount: u8;
  readonly AccountOwner: u8;
  readonly CloseAccount: u8;
};

/**
 * Resize an account of this program (Anchor `realloc`, struct accounts only): growing charges `payer` the extra rent
 * (never the account's own lamports, which may be deposits); shrinking keeps every lamport in the account — move
 * freed rent out yourself if your program allows it. At most 10 KiB of growth per instruction (3016); never below
 * the struct size. Accounts ending in a Vec size themselves through push/pop/clear.
 */
export declare function realloc(account: AccountMeta, newSize: u64, payer: Mut<Signer>): void;

/**
 * Token-2022 extensions of a mint (any account works; legacy SPL Token mints have none).
 * transferFee: the fee withheld when `amount` is sent now (TransferFeeConfig for the current epoch; 0 without it).
 */
export declare function transferFee(mint: AccountMeta | RemainingAccount, amount: u64): u64;
/**
 * The fee withheld when the recipient is to get `amountReceived` (spl-token-2022's `calculate_inverse_epoch_fee`):
 * send `amountReceived + transferFeeInverse(mint, amountReceived)`. 0 without TransferFeeConfig; fails (5100) where
 * spl-token-2022 has no answer.
 */
export declare function transferFeeInverse(mint: AccountMeta | RemainingAccount, amountReceived: u64): u64;
/** The TransferFeeConfig in force this epoch: its basis points (0 without the extension). */
export declare function transferFeeBasisPoints(mint: AccountMeta | RemainingAccount): u16;
/** The TransferFeeConfig in force this epoch: its maximum fee (0 without the extension). */
export declare function transferFeeMaximum(mint: AccountMeta | RemainingAccount): u64;
/**
 * Whether every Token-2022 extension of `account` is one of `types` (a list of u16 extension types, e.g.
 * `[1n, 18n, 19n, 10n, 25n]`): a pool that accepts only mints it knows how to handle. True for legacy SPL Token accounts.
 */
export declare function extensionsWithin(account: AccountMeta | RemainingAccount, types: u16[]): boolean;
/** The TransferHook extension's program, if any. */
export declare function transferHookProgram(mint: AccountMeta | RemainingAccount): Option<Pubkey>;
/** The TransferHook extension's authority (who may change the hook program), if any. */
export declare function transferHookAuthority(mint: AccountMeta | RemainingAccount): Option<Pubkey>;
/**
 * Whether Token-2022 is transferring from this token account right now (its TransferHookAccount `transferring` flag):
 * true inside a transfer hook called by Token-2022, false when the hook is invoked directly.
 */
export declare function isTransferring(tokenAccount: AccountMeta | RemainingAccount): boolean;
/** The PermanentDelegate extension's delegate, if any (it can move or burn anyone's tokens). */
export declare function permanentDelegate(mint: AccountMeta | RemainingAccount): Option<Pubkey>;
/** The MintCloseAuthority extension's authority, if any. */
export declare function mintCloseAuthority(mint: AccountMeta | RemainingAccount): Option<Pubkey>;
/** Whether a Token-2022 mint or token account carries extension `extensionType` (e.g. 9 NonTransferable, 7 ImmutableOwner). */
export declare function hasExtension(account: AccountMeta | RemainingAccount, extensionType: u16): boolean;

/** Rent-exempt minimum balance for an account of `space` bytes. */
export declare function rentExempt(space: u64): u64;
/** SPL Token account and mint sizes, for systemProgram.createAccount. */
export declare const TOKEN_ACCOUNT_SIZE: u64;
export declare const MINT_SIZE: u64;

/** The account must have signed the transaction. Wrap in `Mut<Signer>` to spend its lamports. */
export interface Signer extends AccountMeta {
  readonly __signer: void;
}

/** An account owned by the System Program, e.g. a wallet (Anchor `SystemAccount`; 3011 otherwise). `Mut<SystemAccount>` to change lamports. */
export interface SystemAccount extends AccountMeta {
  readonly __systemAccount?: void;
}

/** Any account, no ownership or data checks. Wrap in `Mut<AccountInfo>` to change lamports. */
export interface AccountInfo extends AccountMeta {
  readonly __info: void;
  /** The program that owns the account. */
  readonly owner: Pubkey;
  readonly executable: boolean;
}

/** A program-owned account holding struct `T`. Owner and discriminator are checked. */
export type Account<T> = Readonly<T> & AccountMeta;

/**
 * Like `Account<T>` but writable. Also usable as `Mut<Signer>`, `Mut<AccountInfo>`, `Mut<TokenAccount>`. A second
 * argument fails with one of your errors when the account is not writable (Anchor's `mut @ ErrorCode.X`; else 2000).
 */
export type Mut<T, E = never> = T & AccountMeta;

/** A PDA seed: a string, a Pubkey, an integer (at its width) or a unit enum value (one byte). */
export type Seed = string | Pubkey | bigint | number;

/**
 * The seeds (with the bump) of one PDA signature, for helpers that sign CPIs: declare a `seeds: SignerSeeds`
 * parameter, pass it where signerSeeds go, and call the helper with `signer(["vault", owner.key, bump])`
 * (or `signer([])` when nothing needs to sign).
 */
export interface SignerSeeds {
  readonly __signer_seeds: void;
}
export declare function signer(seeds: Seed[]): SignerSeeds;

/**
 * Created on first use (like Anchor `init_if_needed`): `createIfNeeded(payer, seeds)` returns true when it
 * created the account now. An existing account must be this PDA, owned by this program and of type T.
 */
export type InitIfNeeded<T> = T extends TokenAccount
  ? T & {
      /**
       * In `Ata<InitIfNeeded<TokenAccount>, "owner", "mint">` (Anchor `init_if_needed` + `associated_token`): create the
       * associated token account when it does not exist yet, with `payer` funding rent; true when it created it now.
       * An existing account must be that ATA, of that mint and owner.
       */
      createIfNeeded(payer: Mut<Signer>, tokenProgram?: TokenProgram | Token2022Program | TokenInterface): boolean;
      /**
       * Anchor `init_if_needed` + `token::…`: create it as `create(payer, seeds, mint, authority)` does unless it exists;
       * an existing one must be that PDA, a token account of `mint` owned by `authority`. True when it created it now.
       */
      createIfNeeded(
        payer: Mut<Signer>,
        seeds: Seed[] | null,
        mint: AccountMeta,
        authority: Pubkey,
        tokenProgram?: TokenProgram | Token2022Program | TokenInterface,
      ): boolean;
      readonly pdaBump: u8;
    }
  : T extends Mint
    ? T & {
        /** Anchor `init_if_needed` + `mint::…`: an existing mint must have these decimals and authorities. */
        createIfNeeded(
          payer: Mut<Signer>,
          seeds: Seed[] | null,
          decimals: u8,
          mintAuthority: Pubkey,
          freezeAuthority: Pubkey | null,
          tokenProgram?: TokenProgram | Token2022Program | TokenInterface,
        ): boolean;
        /**
         * With extensions: created with them, or an existing mint must carry them with these keys, as Anchor's
         * `extensions::…` constraints check (2024–2039). groupPointer, groupMemberPointer, metadataPointer,
         * closeAuthority, permanentDelegate and transferHook only.
         */
        createIfNeeded(
          payer: Mut<Signer>,
          seeds: Seed[] | null,
          decimals: u8,
          mintAuthority: Pubkey,
          freezeAuthority: Pubkey | null,
          extensions: MintExtensions,
          tokenProgram?: Token2022Program | TokenInterface,
        ): boolean;
        readonly pdaBump: u8;
      }
    : T &
        AccountMeta & {
          /** Like create(payer, seeds, space?), unless the account exists (then it must be this PDA and a T). */
          createIfNeeded(payer: Mut<Signer>, seeds: Seed[], space?: u64): boolean;
          /** The PDA bump, after createIfNeeded(). */
          readonly pdaBump: u8;
        };

/**
 * Declarative constraints, checked before your code runs (like Anchor's account attributes):
 *  - `HasOne<Mut<Vault>, "owner">`: vault.owner must be the key of the parameter named `owner` (union for several).
 *  - `Seeds<Mut<Vault>, ["vault", "@owner"], "bump">`: the account must be the PDA of these seeds; "@name" is an
 *    account parameter (its key) or an argument (its bytes), "@acct.field" a Pubkey, integer or unit enum field of a struct
 *    account parameter (this account's own fields too), anything else a literal string; the bump is an optional u8 field.
 *    A fourth argument derives the PDA under another program: `Seeds<AccountInfo, ["metadata", "@mint"], never, "@tokenMetadata">`
 *    ("@param" names a program parameter, or give a base58 address).
 *  - `CloseTo<Mut<Vault>, "owner">`: close the account into `owner` when the instruction succeeds.
 * They nest: `CloseTo<HasOne<Mut<Vault>, "owner">, "owner">`.
 *
 * `HasOne`, `Address`, `Owner`, `Signed` and `Mut` take one of your errors as their last argument, as Anchor's
 * `has_one = owner @ ErrorCode.NotOwner` does: `HasOne<Mut<Vault>, "owner", ErrorCode.NotOwner>` (for one field each
 * its own error, nest them: `HasOne<HasOne<Mut<Vault>, "owner", E.A>, "admin", E.B>`).
 */
export type HasOne<A, Field extends string, E = never> = A & { readonly __hasOne?: [Field, E] };
/**
 * Anchor's `token::mint = mintParam, token::authority = authorityParam, token::token_program = tokenProgramParam` on an
 * existing token account, naming the parameters (2014 / 2015 / 2021: owned by that token program); `never` leaves one out.
 */
export type TokenOf<A, MintParam extends string, AuthorityParam extends string = never, TokenProgramParam extends string = never> = A & {
  readonly __tokenOf?: [MintParam, AuthorityParam, TokenProgramParam];
};
/**
 * Anchor's `mint::authority = a, mint::freeze_authority = f, mint::token_program = tp` on an existing mint, naming the
 * parameters (2016 / 2017 / 2022: owned by that token program); `never` leaves one out.
 */
export type MintOf<A, AuthorityParam extends string, FreezeAuthorityParam extends string = never, TokenProgramParam extends string = never> = A & {
  readonly __mintOf?: [AuthorityParam, FreezeAuthorityParam, TokenProgramParam];
};
/**
 * Anchor's `dup`: this writable account may be the same account as another writable parameter (TypeSOL refuses that
 * otherwise, 2040). Both are read and written in place, so a write through one is seen through the other: read
 * what you need before writing. Not for accounts that are created, closed, a close destination or `@layout borsh`.
 */
export type Dup<A> = A & { readonly __dup?: true };
/**
 * The account must sign the transaction (Anchor's `signer` constraint on an account that is not a `Signer`; 2002), e.g.
 * `Signed<Zeroed<Multisig>>` for an account the client creates with a fresh keypair in the same transaction.
 */
export type Signed<A, E = never> = A & { readonly __signed?: E | true };
/**
 * Anchor 1.0's `Migration<From, To>`: an existing `From` account (owner, discriminator and size checked) that this
 * instruction rewrites as `To` with `acct.migrate(payer, value)`, a top-level statement every path must reach. Read
 * the old data through `acct.from` before migrating (the new value may use it: it is built in full before the account
 * is rewritten), and the new data through `acct.to` after. The account is resized to `To`: the payer tops up the rent
 * when it grows (at most 10 KiB), and shrinking keeps the lamports. `From` usually keeps the old type's discriminator
 * under a new name: `/** @discriminator account:Counter *\/ interface CounterV1 { … }`. An account already migrated
 * fails with 3002, as under Anchor.
 */
export interface Migrate<From, To> extends AccountMeta {
  readonly __migrate: [From, To];
  readonly from: Readonly<From>;
  readonly to: To;
  migrate(payer: Mut<Signer>, value: To): void;
}
export type Seeds<A, Names extends readonly string[], Bump extends string = never, ProgramId extends string = never> = A & {
  readonly __seeds?: [Names, Bump, ProgramId];
  /** The PDA's bump (Anchor `ctx.bumps.<account>`): the stored bump field when one is named, else the canonical bump found. */
  readonly pdaBump: u8;
};
/** The account's owner program must be this address (Anchor `owner = …`, 2004; a third argument: one of your errors). */
export type Owner<A, Base58 extends string, E = never> = A & { readonly __owner?: [Base58, E] };
/**
 * An optional account (Anchor `Option<Account<…>>`): the client passes this program's id in its slot to leave it out.
 * Same as `A | null`. Check `x !== null` before using it; its checks and constraints run only when it is passed.
 */
export type Optional<A> = A | null;
/** The account must be an executable program (Anchor `executable`, 2007). */
export type Executable<A> = A & { readonly __executable?: true };

/**
 * This program's ProgramData account (BPF upgradeable loader). Its address (derived from this program's id),
 * owner and state are checked. Gate admin setup on the deployer: `require(programData.upgradeAuthority === admin.key, …)`.
 */
export interface ProgramData extends AccountMeta {
  readonly __program_data: void;
  readonly upgradeAuthority: Option<Pubkey>;
  /** The slot of the last deploy or upgrade. */
  readonly deploySlot: u64;
}

/** Anchor's event authority PDA ["__event_authority"] of this program (address checked), for emitCpi. */
export interface EventAuthority extends AccountMeta {
  readonly __event_authority: void;
}
/** This program itself (its address is checked), for self-CPI. */
export interface SelfProgram extends AccountMeta {
  readonly __self_program: void;
}
/**
 * Like emit, but the event travels in the data of a CPI to this program (Anchor `emit_cpi!`): indexers read it from
 * inner instructions, and it cannot be cut off by log truncation. Take `eventAuthority: EventAuthority` and
 * `self: SelfProgram` parameters; the program then also accepts Anchor's event instruction.
 */
export declare function emitCpi<T>(event: T, eventAuthority: EventAuthority, self: SelfProgram): void;

/**
 * Who manages a Metaplex Core plugin: `"owner"`, `"updateAuthority"`, `"none"` (nobody: fixed), or an address. Left out,
 * the plugin type's default (the owner for owner-managed plugins, the update authority for the others).
 */
export type CorePluginAuthority = "none" | "owner" | "updateAuthority" | Pubkey;
/** A Metaplex Core plugin, written as an object literal (Core's Plugin enum, with its authority when it is added). */
export type CorePlugin = (
  | {
      kind: "Royalties";
      basisPoints: u16;
      creators: { address: Pubkey; percentage: u8 }[];
      /** Programs allowed (or denied) to move the asset; none by default. */
      ruleSet?: { programAllowList: Pubkey[] } | { programDenyList: Pubkey[] };
    }
  | { kind: "FreezeDelegate"; frozen: boolean }
  | { kind: "BurnDelegate" }
  | { kind: "TransferDelegate" }
  | { kind: "UpdateDelegate"; additionalDelegates?: Pubkey[] }
  | { kind: "PermanentFreezeDelegate"; frozen: boolean }
  | { kind: "Attributes"; attributes: { key: string; value: string }[] }
  | { kind: "PermanentTransferDelegate" }
  | { kind: "PermanentBurnDelegate" }
  | { kind: "Edition"; number: u32 }
  | { kind: "AddBlocker" }
  | { kind: "ImmutableMetadata" }
  /** On a collection: lets Bubblegum mint compressed NFTs into it (mintV2 with a collection). */
  | { kind: "BubblegumV2" }
  | { kind: "MasterEdition"; maxSupply?: u32 | null; name?: string | null; uri?: string | null }
  | { kind: "VerifiedCreators"; signatures: { address: Pubkey; verified: boolean }[] }
  | { kind: "Autograph"; signatures: { address: Pubkey; message: string }[] }
  | { kind: "FreezeExecute"; frozen: boolean }
  | { kind: "PermanentFreezeExecute"; frozen: boolean }
) & { authority?: CorePluginAuthority };
export type CorePluginKind = CorePlugin["kind"] | "Groups";
/** When a Core lifecycle event reaches an external plugin, and what the plugin may do about it. */
export interface CoreLifecycleCheck {
  event: "create" | "transfer" | "burn" | "update" | "execute";
  canListen?: boolean;
  canApprove?: boolean;
  canReject?: boolean;
}
/** An account Core passes to an external plugin: one it already has, or an address. */
export type CoreExtraAccount =
  | { kind: "program" | "collection" | "owner" | "recipient" | "asset"; isSigner?: boolean; isWritable?: boolean }
  | { kind: "address"; address: Pubkey; isSigner?: boolean; isWritable?: boolean };
/**
 * A Metaplex Core external plugin adapter, written as an object literal: data a third party writes (`AppData`), an
 * account that approves or rejects lifecycle events (`Oracle`), or a program called on them (`LifecycleHook`); the
 * `Linked` forms go on a collection, for each of its assets. `authority` manages the adapter itself.
 */
export type CoreExternalPlugin = (
  | { kind: "AppData" | "LinkedAppData"; dataAuthority: CorePluginAuthority; schema?: "binary" | "json" | "msgpack" }
  | {
      kind: "Oracle";
      baseAddress: Pubkey;
      checks: CoreLifecycleCheck[];
      baseAddressConfig?: CoreExtraAccount;
      resultsOffset?: "none" | "anchor" | u64;
    }
  | {
      kind: "LifecycleHook" | "LinkedLifecycleHook";
      hookedProgram: Pubkey;
      checks: CoreLifecycleCheck[];
      extraAccounts?: CoreExtraAccount[];
      dataAuthority?: CorePluginAuthority;
      schema?: "binary" | "json" | "msgpack";
    }
) & { authority?: CorePluginAuthority };
/** Which external plugin: an AppData by its data authority, an Oracle by its base address, a LifecycleHook by its program. */
export type CoreExternalPluginKey =
  { kind: "AppData" | "LinkedAppData"; dataAuthority: CorePluginAuthority } | { kind: "Oracle" | "LifecycleHook" | "LinkedLifecycleHook"; address: Pubkey };

/**
 * Metaplex Core (CoREEN…), address checked. Assets and collections, with plugins and external plugin adapters; `null`
 * leaves an optional account out. Accounts that sign (the new asset/collection, authorities) are keypair Signers, or
 * PDAs of this program covered by `signerSeeds`.
 */
export interface MplCoreProgram extends AccountMeta {
  readonly __mpl_core: void;
  /**
   * CreateV1. In a collection, `authority` is the collection's update authority; `owner` defaults to the payer.
   * `plugins` (a literal list, one of each kind) are created with the asset.
   */
  createAsset(
    asset: AccountMeta,
    collection: AccountMeta | null,
    authority: AccountMeta | null,
    payer: Mut<Signer>,
    owner: AccountMeta | null,
    systemProgram: SystemProgram,
    name: string,
    uri: string,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  createAsset(
    asset: AccountMeta,
    collection: AccountMeta | null,
    authority: AccountMeta | null,
    payer: Mut<Signer>,
    owner: AccountMeta | null,
    systemProgram: SystemProgram,
    name: string,
    uri: string,
    plugins: CorePlugin[],
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  createCollection(
    collection: AccountMeta,
    updateAuthority: AccountMeta | null,
    payer: Mut<Signer>,
    systemProgram: SystemProgram,
    name: string,
    uri: string,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** With plugins every asset of the collection inherits (Royalties, PermanentFreezeDelegate, …). */
  createCollection(
    collection: AccountMeta,
    updateAuthority: AccountMeta | null,
    payer: Mut<Signer>,
    systemProgram: SystemProgram,
    name: string,
    uri: string,
    plugins: CorePlugin[],
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** AddPluginV1, signed by `authority` (`null`: the payer): the owner for owner-managed plugins, else the update authority. */
  addPlugin(
    asset: AccountMeta,
    collection: AccountMeta | null,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    plugin: CorePlugin,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** UpdatePluginV1: new values for a plugin the asset has (no `authority`), e.g. `{ kind: "FreezeDelegate", frozen: true }`. */
  updatePlugin(
    asset: AccountMeta,
    collection: AccountMeta | null,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    plugin: CorePlugin,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  removePlugin(
    asset: AccountMeta,
    collection: AccountMeta | null,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    kind: CorePluginKind,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  addCollectionPlugin(
    collection: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    plugin: CorePlugin,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  updateCollectionPlugin(
    collection: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    plugin: CorePlugin,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  removeCollectionPlugin(
    collection: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    kind: CorePluginKind,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** AddExternalPluginAdapterV1, signed by the update authority as `authority` (`null`: the payer). */
  addExternalPlugin(
    asset: AccountMeta,
    collection: AccountMeta | null,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    plugin: CoreExternalPlugin,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  removeExternalPlugin(
    asset: AccountMeta,
    collection: AccountMeta | null,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    key: CoreExternalPluginKey,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** WriteExternalPluginAdapterDataV1, signed by the plugin's data authority: `data` replaces what it holds (`null` clears it). */
  writeExternalPluginData(
    asset: AccountMeta,
    collection: AccountMeta | null,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    key: CoreExternalPluginKey,
    data: string | Vec<u8> | null,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  addCollectionExternalPlugin(
    collection: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    plugin: CoreExternalPlugin,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  removeCollectionExternalPlugin(
    collection: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    key: CoreExternalPluginKey,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  writeCollectionExternalPluginData(
    collection: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    systemProgram: SystemProgram,
    key: CoreExternalPluginKey,
    data: string | Vec<u8> | null,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** TransferV1, signed by the owner (or a delegate) as `authority` (`null`: the payer). */
  transferAsset(
    asset: AccountMeta,
    collection: AccountMeta | null,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    newOwner: AccountMeta,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  burnAsset(asset: AccountMeta, collection: AccountMeta | null, payer: Mut<Signer>, authority: AccountMeta | null, signerSeeds?: Seed[] | SignerSeeds): void;
}
/** The owner of a Metaplex Core asset (owner program and account type checked). */
export declare function coreAssetOwner(asset: AccountMeta | RemainingAccount): Pubkey;
/** The collection a Metaplex Core asset belongs to, if any. */
export declare function coreAssetCollection(asset: AccountMeta | RemainingAccount): Option<Pubkey>;

/**
 * Metaplex Bubblegum (BGUMAp…), compressed NFTs on SPL Account Compression. The merkle tree account is allocated
 * by the client (owner: the compression program); logWrapper is the SPL Noop program.
 */
export interface BubblegumProgram extends AccountMeta {
  readonly __bubblegum: void;
  createTree(
    treeConfig: AccountMeta,
    merkleTree: AccountMeta,
    payer: Mut<Signer>,
    treeCreator: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    maxDepth: u32,
    maxBufferSize: u32,
    isPublic: boolean,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** MintV1 of a non-fungible leaf without collection, uses or creators. */
  mint(
    treeConfig: AccountMeta,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta,
    merkleTree: AccountMeta,
    payer: Signer,
    treeDelegate: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    name: string,
    symbol: string,
    uri: string,
    sellerFeeBasisPoints: u16,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /**
   * MintToCollectionV1 on a V1 tree: the leaf joins a Token Metadata collection (Bubblegum verifies it; the collection
   * authority signs, its record PDA is `null` when it is the update authority itself). Creators default to none,
   * `isMutable` to true, `editionNonce` to None.
   */
  mintToCollection(
    treeConfig: AccountMeta,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta,
    merkleTree: AccountMeta,
    payer: Signer,
    treeDelegate: AccountMeta,
    collectionAuthority: AccountMeta,
    collectionAuthorityRecordPda: AccountMeta | null,
    collectionMint: AccountMeta,
    collectionMetadata: AccountMeta,
    collectionEdition: AccountMeta,
    bubblegumSigner: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    tokenMetadataProgram: AccountMeta,
    systemProgram: SystemProgram,
    metadata: CompressedMetadata & { editionNonce?: u8 },
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /**
   * CreateTreeConfigV2: a tree on mpl-account-compression (mcmt6…, allocated by the client and owned by it) with the
   * mpl-noop log wrapper (mnoop…). `treeCreator` `null`: the payer.
   */
  createTreeV2(
    treeConfig: AccountMeta,
    merkleTree: AccountMeta,
    payer: Mut<Signer>,
    treeCreator: AccountMeta | null,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    maxDepth: u32,
    maxBufferSize: u32,
    isPublic: boolean,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** MintV2 of a leaf, optionally into a Metaplex Core collection (whose update authority signs as `authority`). */
  mintV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    treeDelegate: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    mplCoreProgram: AccountMeta,
    systemProgram: SystemProgram,
    metadata: CompressedMetadata,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  mintV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    treeDelegate: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    mplCoreProgram: AccountMeta,
    systemProgram: SystemProgram,
    metadata: CompressedMetadata,
    collection: { collection: AccountMeta; authority: AccountMeta; cpiSigner: AccountMeta },
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** TransferV2, signed by the owner or delegate as `authority` (`null`: the payer); `proof` is the leaf's Merkle proof. */
  transferV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    newLeafOwner: AccountMeta,
    merkleTree: AccountMeta,
    coreCollection: AccountMeta | null,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeaf,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  burnV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    coreCollection: AccountMeta | null,
    mplCoreCpiSigner: AccountMeta | null,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    mplCoreProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeaf,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** DelegateV2: the owner (null: the payer) sets a new leaf delegate. */
  delegateV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    leafOwner: AccountMeta | null,
    previousLeafDelegate: AccountMeta | null,
    newLeafDelegate: AccountMeta,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeaf & { collectionHash?: Hash | null },
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** FreezeV2 / ThawV2: the leaf delegate (as `authority`, null: the payer) freezes or thaws the leaf. */
  freezeV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta,
    merkleTree: AccountMeta,
    coreCollection: AccountMeta | null,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeaf,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  thawV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta,
    merkleTree: AccountMeta,
    coreCollection: AccountMeta | null,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeaf,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** SetNonTransferableV2 (soulbound), by the collection's permanent freeze delegate. */
  setNonTransferableV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    coreCollection: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeaf,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** UpdateMetadataV2: the tree creator / delegate (or the collection's update authority) changes the metadata. */
  updateMetadataV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    coreCollection: AccountMeta | null,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeafRef,
    currentMetadata: CompressedMetadataV2,
    update: CompressedMetadataUpdate,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** VerifyCreatorV2 / UnverifyCreatorV2: a creator (signing) marks itself verified or not. */
  verifyCreatorV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    creator: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeafRef,
    metadata: CompressedMetadataV2,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  unverifyCreatorV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    creator: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeafRef,
    metadata: CompressedMetadataV2,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** SetCollectionV2: move the leaf into (or out of) a Core collection. */
  setCollectionV2(
    treeConfig: AccountMeta,
    payer: Mut<Signer>,
    authority: AccountMeta | null,
    newCollectionAuthority: AccountMeta | null,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta | null,
    merkleTree: AccountMeta,
    coreCollection: AccountMeta | null,
    newCoreCollection: AccountMeta | null,
    mplCoreCpiSigner: AccountMeta | null,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    mplCoreProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeafRef,
    metadata: CompressedMetadataV2,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /**
   * V1 trees (SPL Account Compression): Transfer / Burn, signed by the leaf owner or delegate (a PDA owner signs with
   * `signerSeeds`), and Delegate by the owner.
   */
  transfer(
    treeConfig: AccountMeta,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta,
    newLeafOwner: AccountMeta,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeafV1,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  burn(
    treeConfig: AccountMeta,
    leafOwner: AccountMeta,
    leafDelegate: AccountMeta,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeafV1,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  delegate(
    treeConfig: AccountMeta,
    leafOwner: AccountMeta,
    previousLeafDelegate: AccountMeta,
    newLeafDelegate: AccountMeta,
    merkleTree: AccountMeta,
    logWrapper: AccountMeta,
    compressionProgram: AccountMeta,
    systemProgram: SystemProgram,
    leaf: CompressedLeafV1,
    proof: RemainingAccounts | RemainingSlice,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
}
/** Bubblegum V2 leaf metadata (MetadataArgsV2): non-fungible, primary sale not happened, mutable unless `isMutable: false`. */
export interface CompressedMetadata {
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: u16;
  creators?: { address: Pubkey; verified: boolean; share: u8 }[];
  isMutable?: boolean;
}
/** A leaf whose data and creator hashes the instruction computes from the metadata passed with it. */
export interface CompressedLeafRef {
  root: Hash;
  assetDataHash?: Hash | null;
  flags?: u8 | null;
  nonce: u64;
  index: u32;
}
/** A V1 tree's leaf. */
export interface CompressedLeafV1 {
  root: Hash;
  dataHash: Hash;
  creatorHash: Hash;
  nonce: u64;
  index: u32;
}
/** A leaf's full MetadataArgsV2, as it is now (with its creators' verified flags and its collection). */
export interface CompressedMetadataV2 extends CompressedMetadata {
  primarySaleHappened?: boolean;
  collection?: Pubkey | null;
}
/** UpdateArgs: what to change (left out: unchanged). */
export interface CompressedMetadataUpdate {
  name?: string;
  symbol?: string;
  uri?: string;
  creators?: { address: Pubkey; verified: boolean; share: u8 }[];
  sellerFeeBasisPoints?: u16;
  primarySaleHappened?: boolean;
  isMutable?: boolean;
}
/** The leaf a transfer or burn replaces, as an indexer (DAS getAssetProof / getAsset) reports it. */
export interface CompressedLeaf {
  root: Hash;
  dataHash: Hash;
  creatorHash: Hash;
  assetDataHash?: Hash | null;
  flags?: u8 | null;
  nonce: u64;
  index: u32;
}

/** The current slot and epoch (Clock sysvar). */
export declare function currentSlot(): u64;
export declare function currentEpoch(): u64;
export type CloseTo<A, Destination extends string> = A & { readonly __closeTo?: Destination };

/** A program-owned account that this instruction creates as a PDA. */
export type Init<T> = T extends TokenAccount
  ? T & {
      /**
       * In `Ata<Init<TokenAccount>, "owner", "mint">` (Anchor `init` + `associated_token`): create the associated token
       * account of those parameters, with `payer` funding rent. Fails if it already exists.
       */
      create(payer: Mut<Signer>, tokenProgram?: TokenProgram | Token2022Program | TokenInterface): void;
      /**
       * Anchor `init` + `token::mint` / `token::authority`: create a token account of `mint` owned by `authority`, at the
       * PDA of `seeds` (or, with `null`, a new keypair account that signs), under the instruction's token program, with
       * `payer` funding rent. Returns the bump (0 for a keypair).
       */
      create(
        payer: Mut<Signer>,
        seeds: Seed[] | null,
        mint: AccountMeta,
        authority: Pubkey,
        tokenProgram?: TokenProgram | Token2022Program | TokenInterface,
      ): u8;
      /** The PDA bump, after create(seeds, …). */
      readonly pdaBump: u8;
    }
  : T extends Mint
    ? T & {
        /**
         * Anchor `init` + `mint::decimals` / `mint::authority` / `mint::freeze_authority`: create a mint at the PDA of
         * `seeds` (or, with `null`, a new keypair account that signs) under the instruction's token program, with `payer`
         * funding rent. Returns the bump (0 for a keypair).
         */
        create(
          payer: Mut<Signer>,
          seeds: Seed[] | null,
          decimals: u8,
          mintAuthority: Pubkey,
          freezeAuthority: Pubkey | null,
          tokenProgram?: TokenProgram | Token2022Program | TokenInterface,
        ): u8;
        /** With Token-2022 extensions (Anchor's `extensions::…`): the mint is sized for them and each is initialized first. */
        create(
          payer: Mut<Signer>,
          seeds: Seed[] | null,
          decimals: u8,
          mintAuthority: Pubkey,
          freezeAuthority: Pubkey | null,
          extensions: MintExtensions,
          tokenProgram?: Token2022Program | TokenInterface,
        ): u8;
        readonly pdaBump: u8;
      }
    : T &
        AccountMeta & {
          /**
           * Derive the PDA from `seeds`, verify it matches this account, create it with
           * `payer` funding rent, and write the discriminator. Returns the bump.
           * With `null`: a new keypair account that signs the transaction (Anchor's `init` without seeds); returns 0.
           * `space` (Anchor's `space = …`, discriminator included) reserves more than 8 + the struct's size, up to 10240.
           */
          create(payer: Mut<Signer>, seeds: Seed[] | null, space?: u64): u8;
          /** The PDA bump, after create(). */
          readonly pdaBump: u8;
        };

/**
 * An account the client already allocated with System CreateAccount (any size up to 10 MiB; over 10 KiB a program
 * cannot create it itself), owned by this program and still zeroed: Anchor's `zero`. Emptiness (2013), owner, size and
 * rent exemption are checked, then the discriminator is written: from here on it is a `Mut<T>`. A `@layout borsh`
 * struct starts empty (lists and strings empty, Options None) and is written as Borsh when the instruction returns.
 */
export type Zeroed<T> = T & AccountMeta;

/** A token account of SPL Token or Token-2022 (extensions allowed). Owner program and state are checked. */
export interface TokenAccount extends AccountMeta {
  readonly mint: Pubkey;
  /** The wallet (or PDA) that owns the tokens. */
  readonly owner: Pubkey;
  readonly amount: u64;
  readonly delegate: Option<Pubkey>;
  readonly delegatedAmount: u64;
  readonly isFrozen: boolean;
  /** A wrapped-SOL account. */
  readonly isNative: boolean;
  readonly closeAuthority: Option<Pubkey>;
  /** The token program that owns this account (Tokenkeg or Token-2022). */
  readonly tokenProgram: Pubkey;
}

/** A mint of SPL Token or Token-2022. Owner program and initialization are checked. */
export interface Mint extends AccountMeta {
  readonly decimals: u8;
  readonly supply: u64;
  readonly mintAuthority: Option<Pubkey>;
  readonly freezeAuthority: Option<Pubkey>;
  /** The token program that owns this mint. */
  readonly tokenProgram: Pubkey;
}

/** The System Program. Its address is checked. */
export interface SystemProgram extends AccountMeta {
  readonly __system: void;
  /** `from` signs: a `Mut<Signer>`, or a system-owned PDA of this program (a SOL vault) with its `signerSeeds`. */
  transfer(from: AccountMeta, to: AccountMeta, lamports: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  /**
   * Create `account` with `space` bytes owned by `owner`, funded by `payer`. The new account signs: a
   * `Mut<Signer>` keypair, or a PDA of this program when you pass its `signerSeeds` (with the bump).
   */
  createAccount(payer: Mut<Signer>, account: AccountMeta, lamports: u64, space: u64, owner: Pubkey, signerSeeds?: Seed[] | SignerSeeds): void;
  /** System Allocate: give `account` `space` bytes of data. It signs: a keypair, or a PDA of this program with `signerSeeds`. */
  allocate(account: AccountMeta, space: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  /** System Assign: make `owner` the account's owner. It signs: a keypair, or a PDA of this program with `signerSeeds`. */
  assign(account: AccountMeta, owner: Pubkey, signerSeeds?: Seed[] | SignerSeeds): void;
}

/**
 * Token program operations. Pass `signerSeeds` (including the bump) when `authority` is a PDA of this program.
 * Prefer transferChecked: Token-2022 mints with extensions (transfer fees, hooks) require it.
 */
interface TokenOps {
  transfer(from: TokenAccount, to: TokenAccount, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  transferChecked(from: TokenAccount, mint: Mint, to: TokenAccount, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  /** `mint`: a Mut<Mint>, or a mint this instruction created and initialized (Mut<Signer> / Mut<AccountInfo>). */
  mintTo(mint: Mint | AccountMeta, to: TokenAccount, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  burn(from: TokenAccount, mint: Mint, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Close a token account (empty), or under Token-2022 a mint with no supply left (its MintCloseAuthority signs). */
  closeAccount(account: TokenAccount | Mint, destination: AccountMeta, authority: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Let `delegate` move up to `amount` from `source`. */
  approve(source: TokenAccount, delegate: AccountMeta, owner: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  revoke(source: TokenAccount, owner: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  /** The checked forms read the decimals from `mint`; Token-2022 mints with some extensions require them. */
  approveChecked(source: TokenAccount, mint: Mint, delegate: AccountMeta, owner: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  mintToChecked(mint: Mint, to: TokenAccount, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  burnChecked(from: TokenAccount, mint: Mint, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Change or remove (null) an authority of a mint or token account: `AuthorityType.MintTokens`, …. */
  setAuthority(target: AccountMeta, currentAuthority: AccountMeta, authorityType: u8, newAuthority: Pubkey | null, signerSeeds?: Seed[] | SignerSeeds): void;
  freezeAccount(account: TokenAccount, mint: AccountMeta, freezeAuthority: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  thawAccount(account: TokenAccount, mint: AccountMeta, freezeAuthority: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Update a wrapped-SOL account's amount after lamports were sent to it. */
  syncNative(account: TokenAccount): void;
  /** Initialize a mint created with systemProgram.createAccount (InitializeMint2: no rent sysvar needed). */
  initializeMint2(mint: AccountMeta, decimals: u8, mintAuthority: Pubkey, freezeAuthority: Pubkey | null): void;
  /** Initialize a token account created with systemProgram.createAccount (InitializeAccount3). */
  initializeAccount3(account: AccountMeta, mint: AccountMeta, owner: Pubkey): void;
}

/** Operations only Token-2022 has: on Token2022Program and TokenInterface, not on TokenProgram. */
interface Token2022Ops {
  /** Token-2022 only: write name/symbol/uri into a mint whose MetadataPointer points at itself (the mint needs lamports for the larger size). */
  initializeMetadata(
    mint: AccountMeta,
    updateAuthority: AccountMeta,
    mintAuthority: AccountMeta,
    name: string,
    symbol: string,
    uri: string,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;

  // Token-2022 extensions, set up on a mint created with room for them, before initializeMint2 (or, for the token
  // account ones, before initializeAccount3). Token-2022 only: refused at compile time on TokenProgram.
  /** TransferFeeConfig: `basisPoints` (at most 10000) of each transfer, capped at `maximumFee`. */
  initializeTransferFeeConfig(mint: AccountMeta, configAuthority: Pubkey | null, withdrawAuthority: Pubkey | null, basisPoints: u16, maximumFee: u64): void;
  /** MintCloseAuthority: who may close the mint once its supply is 0. */
  initializeMintCloseAuthority(mint: AccountMeta, closeAuthority: Pubkey | null): void;
  /** NonTransferable: tokens of this mint cannot be transferred (soul-bound). */
  initializeNonTransferableMint(mint: AccountMeta): void;
  /** PermanentDelegate: `delegate` may transfer or burn from any account of this mint. */
  initializePermanentDelegate(mint: AccountMeta, delegate: Pubkey): void;
  /** DefaultAccountState: new token accounts start frozen (true) or initialized (false). */
  initializeDefaultAccountState(mint: AccountMeta, frozen: boolean): void;
  /** MetadataPointer: where the mint's metadata lives (the mint itself for initializeMetadata). */
  initializeMetadataPointer(mint: AccountMeta, authority: Pubkey | null, metadataAddress: Pubkey | null): void;
  /** GroupPointer: where the mint's token-group data lives. */
  initializeGroupPointer(mint: AccountMeta, authority: Pubkey | null, groupAddress: Pubkey | null): void;
  /** GroupMemberPointer: where the mint's group-member data lives. */
  initializeGroupMemberPointer(mint: AccountMeta, authority: Pubkey | null, memberAddress: Pubkey | null): void;
  /**
   * The Token Group interface on Token-2022 mints (a collection of mints): make `group` (usually the mint itself, with
   * a GroupPointer to it, its space allocated) a group of at most `maxSize` members. The mint authority signs.
   */
  initializeTokenGroup(
    group: AccountMeta,
    mint: AccountMeta,
    mintAuthority: AccountMeta,
    updateAuthority: Pubkey | null,
    maxSize: u64,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** Add `memberMint` to `group` (`member` holds the membership, usually the member mint itself). Both authorities sign. */
  initializeGroupMember(
    member: AccountMeta,
    memberMint: AccountMeta,
    memberMintAuthority: AccountMeta,
    group: AccountMeta,
    groupUpdateAuthority: AccountMeta,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  updateGroupMaxSize(group: AccountMeta, updateAuthority: AccountMeta, maxSize: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  updateGroupAuthority(group: AccountMeta, updateAuthority: AccountMeta, next: Pubkey | null, signerSeeds?: Seed[] | SignerSeeds): void;
  /** TransferHook: `programId` is invoked on every transfer of this mint. */
  initializeTransferHook(mint: AccountMeta, authority: Pubkey | null, programId: Pubkey | null): void;
  /** InterestBearingConfig: `rate` in basis points per year (UI amounts only; balances do not change). */
  initializeInterestBearingMint(mint: AccountMeta, rateAuthority: Pubkey | null, rate: i16): void;
  /** ImmutableOwner on a token account (before initializeAccount3): its owner can never change. */
  initializeImmutableOwner(account: AccountMeta): void;

  // Token-2022 extension instructions on mints and accounts that have the extension.
  /** DefaultAccountState Update: new token accounts start frozen (true) or initialized (false). */
  updateDefaultAccountState(mint: AccountMeta, freezeAuthority: AccountMeta, frozen: boolean, signerSeeds?: Seed[] | SignerSeeds): void;
  /** TransferHook Update: the program invoked on every transfer (null: none). */
  updateTransferHook(mint: AccountMeta, authority: AccountMeta, programId: Pubkey | null, signerSeeds?: Seed[] | SignerSeeds): void;
  /** MemoTransfer Enable: incoming transfers to `account` need a memo instruction before them. */
  enableRequiredMemoTransfers(account: AccountMeta, owner: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  /** MemoTransfer Disable. */
  disableRequiredMemoTransfers(account: AccountMeta, owner: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  /** InterestBearingMint UpdateRate (basis points per year). */
  updateInterestRate(mint: AccountMeta, rateAuthority: AccountMeta, rate: i16, signerSeeds?: Seed[] | SignerSeeds): void;
  /** TransferFee TransferCheckedWithFee: `fee` must be the fee Token-2022 computes for `amount`; decimals are the mint's. */
  transferCheckedWithFee(
    from: TokenAccount,
    mint: Mint,
    to: TokenAccount,
    authority: AccountMeta,
    amount: u64,
    fee: u64,
    signerSeeds?: Seed[] | SignerSeeds,
  ): void;
  /** TransferFee HarvestWithheldTokensToMint: move withheld fees from the given token accounts (passed on writable as they were passed) to the mint. */
  harvestWithheldTokensToMint(mint: AccountMeta, sources: RemainingAccounts | RemainingSlice): void;
  /** TransferFee WithdrawWithheldTokensFromMint: the fees held by the mint to `destination`. */
  withdrawWithheldTokensFromMint(mint: AccountMeta, destination: TokenAccount, withdrawAuthority: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  /** TransferFee SetTransferFee: takes effect two epochs later. */
  setTransferFee(mint: AccountMeta, configAuthority: AccountMeta, basisPoints: u16, maximumFee: u64, signerSeeds?: Seed[] | SignerSeeds): void;

  // The Token Metadata interface, for metadata stored in the mint (after initializeMetadata).
  /** Set "name", "symbol" or "uri", or any other key as an additional field. */
  updateMetadataField(mint: AccountMeta, updateAuthority: AccountMeta, field: string, value: string, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Remove an additional field; with `idempotent` false a missing key fails. */
  removeMetadataKey(mint: AccountMeta, updateAuthority: AccountMeta, key: string, idempotent: boolean, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Hand the update authority to `newAuthority`, or make the metadata immutable with null. */
  updateMetadataAuthority(mint: AccountMeta, updateAuthority: AccountMeta, newAuthority: Pubkey | null, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Emit: the whole TokenMetadata as Token-2022's return data. */
  emitMetadata(mint: AccountMeta): void;
}

/**
 * Token-2022 extensions for `mint.create(…, extensions)`: Anchor's `extensions::…` constraints. `null` authorities
 * mean none; `defaultAccountState: true` starts new token accounts frozen (it needs a freeze authority).
 */
export interface MintExtensions {
  transferFee?: { configAuthority: Pubkey | null; withdrawAuthority: Pubkey | null; basisPoints: u16; maximumFee: u64 };
  closeAuthority?: Pubkey | null;
  defaultAccountState?: boolean;
  nonTransferable?: true;
  interestBearing?: { rateAuthority: Pubkey | null; rate: i16 };
  permanentDelegate?: Pubkey;
  transferHook?: { authority: Pubkey | null; programId: Pubkey | null };
  metadataPointer?: { authority: Pubkey | null; metadataAddress: Pubkey | null };
  groupPointer?: { authority: Pubkey | null; groupAddress: Pubkey | null };
  groupMemberPointer?: { authority: Pubkey | null; memberAddress: Pubkey | null };
}

/** The SPL Token program (Tokenkeg). Its address is checked. */
export interface TokenProgram extends AccountMeta, TokenOps {
  readonly __token: void;
}

/** The Token-2022 program (TokenzQdB...). Its address is checked. */
export interface Token2022Program extends AccountMeta, TokenOps, Token2022Ops {
  readonly __token2022: void;
}

/** Either token program. Token accounts and mints passed alongside must belong to the program given. */
export interface TokenInterface extends AccountMeta, TokenOps, Token2022Ops {
  readonly __token_interface: void;
}

/**
 * Another program, pinned to its address: `Program<"Tokenz...">`. The address and the
 * executable flag are checked before your code runs.
 */
export interface Program<Address extends string> extends AccountMeta {
  readonly __program: Address;
}

/** Any executable account. Only the executable flag is checked: you must verify `key` yourself. */
export interface UncheckedProgram extends AccountMeta {
  readonly __unchecked_program: void;
}

/** An account entry for `invoke`, built with readonly()/writable()/readonlySigner()/writableSigner(). */
export interface CpiAccount {
  readonly __cpi_account: void;
}
export declare function readonly(account: AccountMeta | RemainingAccount): CpiAccount;
export declare function readonly(accounts: RemainingAccounts | RemainingSlice): Iterable<CpiAccount>;
export declare function writable(account: AccountMeta | RemainingAccount): CpiAccount;
export declare function writable(accounts: RemainingAccounts | RemainingSlice): Iterable<CpiAccount>;
export declare function readonlySigner(account: AccountMeta | RemainingAccount): CpiAccount;
export declare function writableSigner(account: AccountMeta | RemainingAccount): CpiAccount;

/** Raw bytes for instruction data. */
export interface Bytes {
  readonly __bytes: void;
}
/** The 8-byte Anchor instruction discriminator for `name` (sha256("global:<snake_case name>")[..8]). */
export declare function sighash(name: string): Bytes;
/** Bytes from a hex string literal, e.g. hex("0a0b"). */
export declare function hex(literal: string): Bytes;

/**
 * Instruction data pieces, Borsh-encoded: integers little-endian at their declared width, booleans 1 byte,
 * Pubkeys/Hashes 32 bytes, strings u32 length + UTF-8, Options a tag byte + value, structs and FixedArrays
 * their fixed layout, unit enum values 1 byte, data enums as Borsh enums, Vec arguments u32 length + elements.
 * (`number` is there for unit enum values such as `Color.Red`; TypeSOL integers are bigints.)
 */
export type CpiData = bigint | boolean | Pubkey | Hash | string | null | Bytes | object | number;

/**
 * Cross-program invocation. Pass `signerSeeds` (with the bump) to sign for a PDA of this program;
 * that PDA can then be marked readonlySigner()/writableSigner().
 */
export declare function invoke(
  program: Program<string> | UncheckedProgram | SystemProgram | TokenProgram | Token2022Program | TokenInterface | RemainingAccount,
  accounts: CpiAccount[],
  data: CpiData[],
  /** One PDA's seeds (with its bump), or a list of them when several PDAs sign: `[["vault", key, b1], ["fees", b2]]`. */
  signerSeeds?: Seed[] | SignerSeeds | (Seed[] | SignerSeeds)[],
): void;

/** One account of an instruction built at run time (Rust's `AccountMeta`): any struct with these three fields. */
export interface InstructionAccountMeta {
  readonly pubkey: Pubkey;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}
/** A list read by index: a Vec or FixedVec in account data, a Vec argument, or a stored local list. */
export interface IndexedList<T> {
  readonly length: u64;
  get(index: bigint): T;
}
/**
 * A CPI decided at run time, e.g. one stored in account data (Rust's `invoke_signed(&Instruction { program_id,
 * accounts, data }, infos, seeds)`). Every account in `infos` (`remainingAccounts()` or a slice of it) is handed to the
 * runtime, which finds each meta's account there by key: one that is missing fails the CPI, as under Rust. A meta may
 * be a signer or writable only as the transaction passed that account, or as a PDA of this program `signerSeeds` sign
 * for (`signer([multisig.key, multisig.nonce])`).
 */
export declare function invokeInstruction(
  programId: Pubkey,
  accounts: IndexedList<InstructionAccountMeta>,
  data: IndexedList<u8>,
  infos: RemainingAccounts | RemainingSlice,
  signerSeeds?: Seed[] | SignerSeeds | (Seed[] | SignerSeeds)[],
): void;

/**
 * Anchor's own error codes (anchor-lang `ErrorCode`): `require(condition, AnchorError.AccountDidNotDeserialize)` fails
 * with that code, as `require!(condition, ErrorCode::AccountDidNotDeserialize)` does. Not listed in the IDL's errors.
 */
export declare enum AnchorError {
  InstructionMissing = 100,
  InstructionFallbackNotFound = 101,
  InstructionDidNotDeserialize = 102,
  InstructionDidNotSerialize = 103,
  IdlInstructionStub = 1000,
  IdlInstructionInvalidProgram = 1001,
  IdlAccountNotEmpty = 1002,
  EventInstructionStub = 1500,
  ConstraintMut = 2000,
  ConstraintHasOne = 2001,
  ConstraintSigner = 2002,
  ConstraintRaw = 2003,
  ConstraintOwner = 2004,
  ConstraintRentExempt = 2005,
  ConstraintSeeds = 2006,
  ConstraintExecutable = 2007,
  ConstraintState = 2008,
  ConstraintAssociated = 2009,
  ConstraintAssociatedInit = 2010,
  ConstraintClose = 2011,
  ConstraintAddress = 2012,
  ConstraintZero = 2013,
  ConstraintTokenMint = 2014,
  ConstraintTokenOwner = 2015,
  ConstraintMintMintAuthority = 2016,
  ConstraintMintFreezeAuthority = 2017,
  ConstraintMintDecimals = 2018,
  ConstraintSpace = 2019,
  ConstraintAccountIsNone = 2020,
  ConstraintTokenTokenProgram = 2021,
  ConstraintMintTokenProgram = 2022,
  ConstraintAssociatedTokenTokenProgram = 2023,
  ConstraintMintGroupPointerExtension = 2024,
  ConstraintMintGroupPointerExtensionAuthority = 2025,
  ConstraintMintGroupPointerExtensionGroupAddress = 2026,
  ConstraintMintGroupMemberPointerExtension = 2027,
  ConstraintMintGroupMemberPointerExtensionAuthority = 2028,
  ConstraintMintGroupMemberPointerExtensionMemberAddress = 2029,
  ConstraintMintMetadataPointerExtension = 2030,
  ConstraintMintMetadataPointerExtensionAuthority = 2031,
  ConstraintMintMetadataPointerExtensionMetadataAddress = 2032,
  ConstraintMintCloseAuthorityExtension = 2033,
  ConstraintMintCloseAuthorityExtensionAuthority = 2034,
  ConstraintMintPermanentDelegateExtension = 2035,
  ConstraintMintPermanentDelegateExtensionDelegate = 2036,
  ConstraintMintTransferHookExtension = 2037,
  ConstraintMintTransferHookExtensionAuthority = 2038,
  ConstraintMintTransferHookExtensionProgramId = 2039,
  RequireViolated = 2500,
  RequireEqViolated = 2501,
  RequireKeysEqViolated = 2502,
  RequireNeqViolated = 2503,
  RequireKeysNeqViolated = 2504,
  RequireGtViolated = 2505,
  RequireGteViolated = 2506,
  AccountDiscriminatorAlreadySet = 3000,
  AccountDiscriminatorNotFound = 3001,
  AccountDiscriminatorMismatch = 3002,
  AccountDidNotDeserialize = 3003,
  AccountDidNotSerialize = 3004,
  AccountNotEnoughKeys = 3005,
  AccountNotMutable = 3006,
  AccountOwnedByWrongProgram = 3007,
  InvalidProgramId = 3008,
  InvalidProgramExecutable = 3009,
  AccountNotSigner = 3010,
  AccountNotSystemOwned = 3011,
  AccountNotInitialized = 3012,
  AccountNotProgramData = 3013,
  AccountNotAssociatedTokenAccount = 3014,
  AccountSysvarMismatch = 3015,
  AccountReallocExceedsLimit = 3016,
  AccountDuplicateReallocs = 3017,
  DeclaredProgramIdMismatch = 4100,
  TryingToInitPayerAsProgramAccount = 4101,
  InvalidNumericConversion = 4102,
  Deprecated = 5000,
}
/**
 * Abort with the given error unless `condition` holds. The error is a member of an exported string enum, any
 * `AnchorError` member, or a string literal: each distinct literal becomes an error named `RequireFailed<N>` with code
 * 6000 + N, numbered after the program's error enums and listed in the IDL.
 */
export declare function require(condition: boolean, error: string | AnchorError): asserts condition;
/**
 * Anchor's `constraint = condition @ error` on `account`. Written at the start of an instruction's body (before any
 * other statement), it runs with that account's checks, after its has_one and before its owner check, so a transaction
 * that breaks several checks fails with the same code as under Anchor. It may read every account and argument. The
 * default error is `AnchorError.ConstraintRaw` (2003); `error` is an error-enum member, an `AnchorError` or a string.
 */
export declare function constraint(account: AccountMeta | RemainingAccount | null, condition: boolean, error?: string | AnchorError): void;

/**
 * The instruction data as sent, discriminator included: `const data = instructionData()`, then `data.length`,
 * `data.get(i)`, or pass it on to `invokeInstruction`. A `/** @fallback *\/` instruction (Anchor's fallback: no
 * parameters, run when no instruction matches) reads its input this way, and its accounts with remainingAccounts().
 */
export declare function instructionData(): IndexedList<u8>;

/** Write a string, integer or pubkey to the program log. */
export declare function log(value: string | bigint | Pubkey | Hash): void;

/**
 * Emit an Anchor-compatible event ("Program data: <base64>") built from an exported interface:
 * `emit<Deposited>({ owner: owner.key, amount })`. Event structs may contain `string` fields.
 */
export declare function emit<T>(event: T): void;

/**
 * Read the return data the last invoke() left behind, checking it came from `program`
 * and has exactly the size of T: `const n = returnData<u64>(counterProgram)`. A struct is bound to a local:
 * `const quote = returnData<Quote>(amm)`. A fixed layout of integers, booleans, Pubkeys, unit enums and arrays is its
 * own Borsh form; a struct with Options, strings or Vecs is declared `@layout borsh` and Borsh-decoded (5106 when the
 * bytes do not decode to exactly it).
 */
export declare function returnData<T extends bigint | boolean | Pubkey | Hash | object>(program: AccountMeta): T;

/**
 * Verify `account.key` is the PDA for `seeds` + `bump` under this program. Any bump that gives a PDA passes (Anchor's
 * `bump = expr`): use a stored bump, not one from the arguments, or the caller picks among up to 256 addresses.
 */
export declare function requirePda(account: AccountMeta, seeds: Seed[], bump: u8): void;

/** Close a program-owned account: move all lamports to `destination` and wipe it. */
export declare function close(account: AccountMeta, destination: AccountMeta): void;

/** Rent-exempt minimum for `account`'s current data length. */
export declare function minimumBalance(account: AccountMeta): u64;

/** Current cluster unix timestamp (Clock sysvar). */
export declare function now(): i64;

/** Checked integer conversions. Abort if the value does not fit. */
export declare function u8(value: bigint): u8;
export declare function u16(value: bigint): u16;
export declare function u32(value: bigint): u32;
export declare function u64(value: bigint): u64;
export declare function i64(value: bigint): i64;
export declare function u128(value: bigint): u128;
export declare function i8(value: bigint): i8;
export declare function i16(value: bigint): i16;
export declare function i32(value: bigint): i32;
export declare function i128(value: bigint): i128;

/** floor(a * b / c) with a double-width intermediate (all u64, or all u128); aborts if c is 0 or the result does not fit. */
export declare function mulDiv(a: u64, b: u64, c: u64): u64;
/** ceil(a * b / c), like mulDiv. */
export declare function mulDivCeil(a: u64, b: u64, c: u64): u64;
/** floor(sqrt(x)) for unsigned integers up to u128. */
export declare function isqrt<T extends bigint>(x: T): T;
export declare function min<T extends bigint>(a: T, b: T): T;
export declare function max<T extends bigint>(a: T, b: T): T;

/**
 * Read a little-endian value at `offset` in any account's data (bounds-checked, error 3003):
 * `readData<u64>(pool, 72n)`, `readData<Pubkey>(pool, 8n)`. Check the account's owner yourself first.
 */
export declare function readData<T extends bigint | boolean | Pubkey | Hash>(account: AccountMeta | RemainingAccount, offset: u64): T;

/**
 * View another program's Anchor account as a struct declared here (same field layout): the owner must be
 * `owner` (3007), the data must start with the discriminator sha256("account:<T>")[..8] (3002) and be large
 * enough (3003). Read-only. Bind it with const: `const pool = loadForeign<Pool>(account, AMM_PROGRAM)`.
 */
export declare function loadForeign<T>(account: AccountMeta | RemainingAccount, owner: Pubkey): Readonly<T>;
