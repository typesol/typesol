// Port of tokens/token-2022/nft-meta-data-pointer (anchor/programs/extension_nft) @ de09019; see test/ports/README.md.
//
// PARTIAL:
//  - builtin gaps: no Token-2022 extension or Token Metadata interface builtins, so MetadataPointer Initialize, the
//    Token Metadata Initialize / UpdateField calls and MintTo into the new mint are hand-encoded (`invoke`). The mint is
//    a keypair the instruction creates, so it stays an AccountInfo to TypeSOL. Upstream also calls System Assign on the
//    new mint, a no-op (it is already owned by Token-2022); the port leaves it out.
//  - session keys (`#[session_auth_or]` with an optional `SessionToken` of the session-keys program): the token is read
//    with loadForeign (owner and discriminator checked, like Account<SessionToken>), and its authority, session signer and
//    target program are compared with the player's authority, the signer and this program. The original re-derives the
//    token's PDA from those three values; the session program only creates tokens at that PDA from the same values, so
//    the checks agree. An invalid or expired token fails with WrongAuthority (6001): the original's
//    SessionError::InvalidToken is the session crate's error 6001 too.
//  - account sizes: `player` and `game_data` are sized to their fields (Anchor reserves `space = 1000`). PlayerData's
//    `name: String`, never set by the program, is `nameLen: u32`: the same 4 bytes as an empty Borsh string (the IDL
//    shows a u32).
//  - logs: addresses are logged on their own line (no Pubkeys in templates).
import {
  type AccountInfo,
  type AssociatedTokenProgram,
  type Ata,
  type Init,
  type InitIfNeeded,
  type Mut,
  type Pubkey,
  type Seeds,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenAccount,
  type i64,
  type u16,
  type u32,
  type u64,
  AuthorityType,
  hex,
  invoke,
  loadForeign,
  log,
  now,
  pubkey,
  readonly,
  readonlySigner,
  rentExempt,
  require,
  u8,
  writable,
} from "typesol";

const TIME_TO_REFILL_ENERGY: i64 = 60n;
const MAX_ENERGY: u64 = 100n;
const MAX_WOOD_PER_TREE: u64 = 100000n;
const U64_MAX: u64 = 18446744073709551615n;
/** declare_id! of the original. */
const PROGRAM_ID = pubkey("H31ofLpWqeAzF2Pg54HSPQGYifJad843tTJg8vCYVoh3");
const SESSION_PROGRAM = pubkey("KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5");
/** Base mint (padded to 165) + account type (1) + MetadataPointer TLV (2 + 2 + 64). */
const MINT_SIZE_METADATA_POINTER = 234n;
const META_DATA_SPACE = 250n;

export enum GameErrorCode {
  NotEnoughEnergy = "Not enough energy",
  WrongAuthority = "Wrong Authority",
  InvalidMintAccountSpace = "Invalid Mint account space",
  CantInitializeMetadataPointer = "Cant initialize metadata_pointer",
}

export interface PlayerData {
  authority: Pubkey;
  /** `name: String`, never set: the length of an empty Borsh string. */
  nameLen: u32;
  level: u8;
  xp: u64;
  wood: u64;
  energy: u64;
  lastLogin: i64;
  lastId: u16;
}

export interface GameData {
  totalWoodCollected: u64;
}

export interface NftAuthority {}

/** session-keys' SessionToken (owned by the session-keys program). */
export interface SessionToken {
  authority: Pubkey;
  targetProgram: Pubkey;
  sessionSigner: Pubkey;
  validUntil: i64;
}

export function initPlayer(
  player: Init<PlayerData>,
  gameData: InitIfNeeded<GameData>,
  signer: Mut<Signer>,
  systemProgram: SystemProgram,
  levelSeed: string,
): void {
  player.create(signer, ["player", signer.key]);
  gameData.createIfNeeded(signer, [levelSeed]);
  player.energy = MAX_ENERGY;
  player.lastLogin = now();
  player.authority = signer.key;
}

export function chopTree(
  sessionToken: AccountInfo | null,
  player: Seeds<Mut<PlayerData>, ["player", "@player.authority"]>,
  gameData: InitIfNeeded<GameData>,
  signer: Mut<Signer>,
  systemProgram: SystemProgram,
  mint: Mut<AccountInfo>,
  nftAuthority: InitIfNeeded<NftAuthority>,
  tokenProgram: Token2022Program,
  levelSeed: string,
  counter: u16,
): void {
  gameData.createIfNeeded(signer, [levelSeed]);
  nftAuthority.createIfNeeded(signer, ["nft_authority"]);
  // #[session_auth_or(player.authority == signer, WrongAuthority)]
  if (sessionToken !== null) {
    const token = loadForeign<SessionToken>(sessionToken, SESSION_PROGRAM);
    require(token.authority === player.authority &&
      token.sessionSigner === signer.key &&
      token.targetProgram === PROGRAM_ID &&
      now() < token.validUntil, GameErrorCode.WrongAuthority);
  } else {
    require(player.authority === signer.key, GameErrorCode.WrongAuthority);
  }
  const amount: u64 = 1n;

  // PlayerData::update_energy
  const current = now();
  let timePassed = current - player.lastLogin;
  let timeSpent: i64 = 0n;
  while (timePassed >= TIME_TO_REFILL_ENERGY && player.energy < MAX_ENERGY) {
    player.energy += 1n;
    timePassed -= TIME_TO_REFILL_ENERGY;
    timeSpent += TIME_TO_REFILL_ENERGY;
  }
  if (player.energy >= MAX_ENERGY) player.lastLogin = current;
  else player.lastLogin += timeSpent;
  // PlayerData::print
  log("Authority:");
  log(player.authority);
  log(`Wood: ${player.wood} Energy: ${player.energy}`);

  require(player.energy >= amount, GameErrorCode.NotEnoughEnergy);
  player.lastId = counter;
  // PlayerData::chop_tree
  if (player.wood <= U64_MAX - amount) player.wood += amount;
  else log("Total wood reached!");
  player.energy = player.energy >= amount ? player.energy - amount : 0n;
  // GameData::on_tree_chopped
  if (gameData.totalWoodCollected <= U64_MAX - amount) {
    if (gameData.totalWoodCollected >= MAX_WOOD_PER_TREE) {
      gameData.totalWoodCollected = 0n;
      log("Tree successfully chopped. New Tree coming up.");
    } else {
      gameData.totalWoodCollected += amount;
      log(`Total wood chopped: ${gameData.totalWoodCollected}`);
    }
  } else {
    log("The ever tree is completly chopped!");
  }
  log(`You chopped a tree and got 1 wood. You have ${player.wood} wood and ${player.energy} energy left.`);

  // Token Metadata UpdateField: Key("wood") = the player's wood, signed by the nft_authority PDA.
  invoke(
    tokenProgram,
    [writable(mint), readonlySigner(nftAuthority)],
    [hex("dde9312db5cadcc8"), u8(3n), "wood", `${player.wood}`],
    ["nft_authority", nftAuthority.pdaBump],
  );
}

export function mintNft(
  signer: Mut<Signer>,
  systemProgram: SystemProgram,
  tokenProgram: Token2022Program,
  tokenAccount: Ata<Init<TokenAccount>, "signer", "mint">,
  mint: Mut<Signer>,
  rent: AccountInfo,
  associatedTokenProgram: AssociatedTokenProgram,
  nftAuthority: InitIfNeeded<NftAuthority>,
): void {
  nftAuthority.createIfNeeded(signer, ["nft_authority"]);
  log("Mint nft with meta data extension and additional meta data");
  const lamportsRequired = rentExempt(MINT_SIZE_METADATA_POINTER + META_DATA_SPACE);
  log(`Create Mint and metadata account size and cost: ${MINT_SIZE_METADATA_POINTER} lamports: ${lamportsRequired}`);
  systemProgram.createAccount(signer, mint, lamportsRequired, MINT_SIZE_METADATA_POINTER, tokenProgram.key);
  // MetadataPointerExtension (39) / Initialize (0): authority nft_authority, metadata address the mint.
  invoke(tokenProgram, [writable(mint)], [u8(39n), u8(0n), nftAuthority.key, mint.key]);
  tokenProgram.initializeMint2(mint, 0n, nftAuthority.key, null);
  log("Init metadata");
  log(nftAuthority.key);
  // Token Metadata Initialize: Beaver / BVA / uri; update authority and mint authority are nft_authority.
  invoke(
    tokenProgram,
    [writable(mint), readonly(nftAuthority), readonly(mint), readonlySigner(nftAuthority)],
    [hex("d2e11ea258b84d8d"), "Beaver", "BVA", "https://arweave.net/MHK3Iopy0GgvDoM7LkkiAdg7pQqExuuWvedApCnzfj0"],
    ["nft_authority", nftAuthority.pdaBump],
  );
  // Token Metadata UpdateField: Key("level") = "1".
  invoke(
    tokenProgram,
    [writable(mint), readonlySigner(nftAuthority)],
    [hex("dde9312db5cadcc8"), u8(3n), "level", "1"],
    ["nft_authority", nftAuthority.pdaBump],
  );
  tokenAccount.create(signer);
  // MintTo (7) one token, signed by nft_authority (the mint is an AccountInfo here).
  invoke(tokenProgram, [writable(mint), writable(tokenAccount), readonlySigner(nftAuthority)], [u8(7n), 1n], ["nft_authority", nftAuthority.pdaBump]);
  tokenProgram.setAuthority(mint, nftAuthority, AuthorityType.MintTokens, null, ["nft_authority", nftAuthority.pdaBump]);
}
