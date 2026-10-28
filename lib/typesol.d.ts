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
}

/**
 * A fixed-length array stored inline in account data, e.g. `scores: FixedArray<u64, 8>`.
 * Indexes are bounds-checked; out of range aborts the instruction.
 */
export interface FixedArray<T, N extends number> {
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
 * An optional scalar: `best: Option<u64>` (same as `u64 | null`). Compare with `=== null` / `!== null`;
 * TypeScript narrows it, and using an empty option where a value is needed aborts (5108).
 * In account data it takes a fixed 1 + size(T) bytes.
 */
export type Option<T> = T | null;

/**
 * A growable list. As the last field of an account struct it is stored Borsh-style (u32 length + elements)
 * and the account is resized as it grows. As an instruction argument it is a read-only view.
 */
export interface Vec<T> {
  readonly length: u64;
  get(index: bigint): T;
  set(index: bigint, value: T): void;
  /** Append, growing the account by one element; `payer` tops up rent when needed. */
  push(value: T, payer: Mut<Signer>): void;
  /** Remove and return the last element, shrinking the account. */
  pop(): T;
  /** Remove every element, shrinking the account. */
  clear(): void;
  /** `for (const x of vec)`: each element in order, as `vec.get(i)` gives it; the length is read again every step. */
  [Symbol.iterator](): Iterator<T>;
}

/**
 * A list stored inline with room for N elements: a u32 length, then N slots (Anchor `Vec<T>` with `#[max_len(N)]`, but
 * always 4 + N × size(T) bytes). Unlike `Vec<T>` it can be any field, any number of times, and in nested structs;
 * `push` fails (5104) when it is full. Write a whole one with `fixedVec([a, b])`.
 */
export interface FixedVec<T, N extends number> {
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
 * `loadAccountMut` also requires it to be writable and not aliased by another writable account.
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
 * `proof` must be a `Vec<Hash>` instruction argument.
 */
export declare function merkleVerify(leaf: Hash, proof: Vec<Hash>, root: Hash): boolean;

/** The Instructions sysvar (Sysvar1nstructions…). Its address is checked. */
export interface InstructionsSysvar extends AccountMeta {
  readonly __instructions_sysvar: void;
}

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
 * The fields are the raw update; use pythPrice() for a verified, fresh, feed-matched price.
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
/** Like Pyth's get_price_no_older_than: fully verified, `feedId` matches, published within `maxAgeSeconds`. */
export declare function pythPrice(update: PythPriceUpdate, feedId: Hash, maxAgeSeconds: u64): i64;

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
export declare function switchboardValue(feed: SwitchboardFeed<"mainnet" | "devnet">, expectedFeed: Pubkey, maxStaleSlots: u64, decimals: u8): i64;

/** The Associated Token Account program (ATokenGP…). Its address is checked. */
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
}
/** The Metaplex master edition address of a mint (PDA ["metadata", program, mint, "edition"]). */
export declare function masterEditionAddress(mint: Pubkey): Pubkey;
/** The canonical program address of `seeds` under `program` (Rust `Pubkey::find_program_address(seeds, program).0`). */
export declare function findProgramAddress(seeds: Seed[], program: Pubkey): Pubkey;
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

/** The account must be this exact address (Anchor `address = …`, error 2012): `Address<Mut<AccountInfo>, "4Nd1…">`. */
export type Address<A, Base58 extends string> = A & { readonly __address?: Base58 };

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
/** The TransferHook extension's program, if any. */
export declare function transferHookProgram(mint: AccountMeta | RemainingAccount): Option<Pubkey>;
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

/** Like `Account<T>` but writable. Also usable as `Mut<Signer>`, `Mut<AccountInfo>`, `Mut<TokenAccount>`. */
export type Mut<T> = T & AccountMeta;

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
      createIfNeeded(payer: Mut<Signer>): boolean;
      /**
       * Anchor `init_if_needed` + `token::…`: create it as `create(payer, seeds, mint, authority)` does unless it exists;
       * an existing one must be that PDA, a token account of `mint` owned by `authority`. True when it created it now.
       */
      createIfNeeded(payer: Mut<Signer>, seeds: Seed[] | null, mint: AccountMeta, authority: Pubkey): boolean;
      readonly pdaBump: u8;
    }
  : T extends Mint
    ? T & {
        /** Anchor `init_if_needed` + `mint::…`: an existing mint must have these decimals and authorities. */
        createIfNeeded(payer: Mut<Signer>, seeds: Seed[] | null, decimals: u8, mintAuthority: Pubkey, freezeAuthority: Pubkey | null): boolean;
        readonly pdaBump: u8;
      }
    : T &
        AccountMeta & {
          createIfNeeded(payer: Mut<Signer>, seeds: Seed[]): boolean;
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
 */
export type HasOne<A, Field extends string> = A & { readonly __hasOne?: Field };
export type Seeds<A, Names extends readonly string[], Bump extends string = never, ProgramId extends string = never> = A & {
  readonly __seeds?: [Names, Bump, ProgramId];
  /** The PDA's bump (Anchor `ctx.bumps.<account>`): the stored bump field when one is named, else the canonical bump found. */
  readonly pdaBump: u8;
};
/** The account's owner program must be this address (Anchor `owner = …`, 2004). */
export type Owner<A, Base58 extends string> = A & { readonly __owner?: Base58 };
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
 * Metaplex Core (CoREEN…), address checked. Assets and collections without plugins; `null` leaves an optional
 * account out. Accounts that sign (the new asset/collection, authorities) are keypair Signers, or PDAs of this
 * program covered by `signerSeeds`.
 */
/**
 * Who manages a Metaplex Core plugin: `"owner"`, `"updateAuthority"`, `"none"` (nobody: fixed), or an address. Left out,
 * the plugin type's default (the owner for owner-managed plugins, the update authority for the others).
 */
export type CorePluginAuthority = "none" | "owner" | "updateAuthority" | Pubkey;
/** A Metaplex Core plugin, written as an object literal (Core's Plugin enum, with its authority when it is added). */
export type CorePlugin = (
  | { kind: "Royalties"; basisPoints: u16; creators: { address: Pubkey; percentage: u8 }[] }
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
) & { authority?: CorePluginAuthority };
export type CorePluginKind = CorePlugin["kind"] | "MasterEdition" | "VerifiedCreators" | "Autograph";

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
      create(payer: Mut<Signer>): void;
      /**
       * Anchor `init` + `token::mint` / `token::authority`: create a token account of `mint` owned by `authority`, at the
       * PDA of `seeds` (or, with `null`, a new keypair account that signs), under the instruction's token program, with
       * `payer` funding rent. Returns the bump (0 for a keypair).
       */
      create(payer: Mut<Signer>, seeds: Seed[] | null, mint: AccountMeta, authority: Pubkey): u8;
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
        create(payer: Mut<Signer>, seeds: Seed[] | null, decimals: u8, mintAuthority: Pubkey, freezeAuthority: Pubkey | null): u8;
        readonly pdaBump: u8;
      }
    : T &
        AccountMeta & {
          /**
           * Derive the PDA from `seeds`, verify it matches this account, create it with
           * `payer` funding rent, and write the discriminator. Returns the bump.
           */
          create(payer: Mut<Signer>, seeds: Seed[]): u8;
          /** The PDA bump, after create(). */
          readonly pdaBump: u8;
        };

/**
 * A large account (over 10 KiB, up to 10 MiB) the client already allocated with System CreateAccount,
 * owned by this program and still zeroed. Owner, size, rent exemption and emptiness are checked, then
 * the discriminator is written: from here on it is a `Mut<T>`. Same idea as Anchor's zero-copy `zero`.
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
  transfer(from: Mut<Signer>, to: AccountMeta, lamports: u64): void;
  /**
   * Create `account` with `space` bytes owned by `owner`, funded by `payer`. The new account signs: a
   * `Mut<Signer>` keypair, or a PDA of this program when you pass its `signerSeeds` (with the bump).
   */
  createAccount(payer: Mut<Signer>, account: AccountMeta, lamports: u64, space: u64, owner: Pubkey, signerSeeds?: Seed[] | SignerSeeds): void;
}

/**
 * Token program operations. Pass `signerSeeds` (including the bump) when `authority` is a PDA of this program.
 * Prefer transferChecked: Token-2022 mints with extensions (transfer fees, hooks) require it.
 */
interface TokenOps {
  transfer(from: TokenAccount, to: TokenAccount, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  transferChecked(from: TokenAccount, mint: Mint, to: TokenAccount, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  mintTo(mint: Mint, to: TokenAccount, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  burn(from: TokenAccount, mint: Mint, authority: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  closeAccount(account: TokenAccount, destination: AccountMeta, authority: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
  /** Let `delegate` move up to `amount` from `source`. */
  approve(source: TokenAccount, delegate: AccountMeta, owner: AccountMeta, amount: u64, signerSeeds?: Seed[] | SignerSeeds): void;
  revoke(source: TokenAccount, owner: AccountMeta, signerSeeds?: Seed[] | SignerSeeds): void;
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
    mint: Mint,
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
  /** TransferHook: `programId` is invoked on every transfer of this mint. */
  initializeTransferHook(mint: AccountMeta, authority: Pubkey | null, programId: Pubkey | null): void;
  /** InterestBearingConfig: `rate` in basis points per year (UI amounts only; balances do not change). */
  initializeInterestBearingMint(mint: AccountMeta, rateAuthority: Pubkey | null, rate: i16): void;
  /** ImmutableOwner on a token account (before initializeAccount3): its owner can never change. */
  initializeImmutableOwner(account: AccountMeta): void;
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
  signerSeeds?: Seed[] | SignerSeeds,
): void;

/** Abort with the given error unless `condition` holds. Use a string enum member or a string literal. */
export declare function require(condition: boolean, error: string): asserts condition;

/** Write a string, integer or pubkey to the program log. */
export declare function log(value: string | bigint | Pubkey | Hash): void;

/**
 * Emit an Anchor-compatible event ("Program data: <base64>") built from an exported interface:
 * `emit<Deposited>({ owner: owner.key, amount })`. Event structs may contain `string` fields.
 */
export declare function emit<T>(event: T): void;

/**
 * Read the return data the last invoke() left behind, checking it came from `program`
 * and has exactly the size of T: `const n = returnData<u64>(counterProgram)`.
 */
export declare function returnData<T extends bigint | boolean | Pubkey | Hash>(program: AccountMeta): T;

/** Verify `account.key` is the PDA for `seeds` + `bump` under this program. */
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

/**
 * Integer operators: + - * / % are checked (overflow and division by zero abort). & | ^ work on equal types;
 * << aborts when bits would be lost or the amount is not below the width; >> is arithmetic on signed types;
 * ~ flips the bits within the type's width.
 */
/** floor(a * b / c) with a 128-bit intermediate; aborts if c is 0 or the result does not fit in u64. */
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
