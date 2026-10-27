import {
  type Account,
  type AccountInfo,
  type AssociatedTokenProgram,
  type Init,
  type Mint,
  type Mut,
  type Pubkey,
  type Signer,
  type SystemProgram,
  type Token2022Program,
  type TokenInterface,
  type TokenMetadataProgram,
  type u8,
  associatedTokenAddress,
  metadataAddress,
  require,
} from "typesol";

/** An issuer PDA ["issuer", mint] that is the mint authority: opens ATAs and names the token. */
export interface Issuer {
  admin: Pubkey;
  mint: Pubkey;
  bump: u8;
}

export function setup(admin: Mut<Signer>, issuer: Init<Issuer>, mint: Mint, systemProgram: SystemProgram): void {
  issuer.bump = issuer.create(admin, ["issuer", mint.key]);
  issuer.admin = admin.key;
  issuer.mint = mint.key;
}

export function openAccount(
  payer: Mut<Signer>,
  owner: AccountInfo,
  ata: Mut<AccountInfo>,
  mint: Mint,
  systemProgram: SystemProgram,
  tokenProgram: TokenInterface,
  ataProgram: AssociatedTokenProgram,
): void {
  require(ata.key === associatedTokenAddress(owner.key, mint.key, tokenProgram.key), "not the associated token account");
  ataProgram.createIdempotent(payer, ata, owner, mint, systemProgram, tokenProgram);
}

export function nameToken2022(admin: Signer, issuer: Account<Issuer>, mint: Mut<Mint>, tokenProgram: Token2022Program, name: string, symbol: string, uri: string): void {
  require(admin.key === issuer.admin, "admin only");
  tokenProgram.initializeMetadata(mint, issuer, issuer, name, symbol, uri, ["issuer", issuer.mint, issuer.bump]);
}

export function nameMetaplex(
  payer: Mut<Signer>,
  issuer: Account<Issuer>,
  mint: Mint,
  metadata: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  metadataProgram: TokenMetadataProgram,
  name: string,
  symbol: string,
  uri: string,
): void {
  require(payer.key === issuer.admin, "admin only");
  require(metadata.key === metadataAddress(mint.key), "not the metadata PDA");
  metadataProgram.createV3(metadata, mint, issuer, payer, issuer, systemProgram, name, symbol, uri, 500n, true, ["issuer", issuer.mint, issuer.bump]);
}

/** Metaplex metadata with creators and a (not yet verified) collection. */
export function nameWithCreators(
  payer: Mut<Signer>,
  issuer: Account<Issuer>,
  mint: Mint,
  metadata: Mut<AccountInfo>,
  systemProgram: SystemProgram,
  metadataProgram: TokenMetadataProgram,
  artist: Pubkey,
  collectionMint: Pubkey,
): void {
  require(payer.key === issuer.admin, "admin only");
  metadataProgram.createV3(
    metadata,
    mint,
    issuer,
    payer,
    issuer,
    systemProgram,
    "TypeSOL #1",
    "TSOL",
    "https://example.com/1.json",
    250n,
    false,
    {
      creators: [
        { address: artist, verified: false, share: 70n },
        { address: payer.key, verified: false, share: 30n },
      ],
      collection: collectionMint,
    },
    ["issuer", issuer.mint, issuer.bump],
  );
}

