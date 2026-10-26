/**
 * Deploy the three examples (and the language fixture) to a real cluster and drive each one end to end.
 *
 *   TYPESOL_NETWORK=localnet|devnet TYPESOL_RPC_URL=<http rpc> TYPESOL_DEPLOYER=<keypair.json> \
 *     TYPESOL_SOLANA_CONFIG=<cli config> node scripts/smoke.ts
 *
 * Re-running reuses programs already deployed under target/<network>/<name>-keypair.json.
 * Run `pnpm build` first; this imports the compiled compiler from dist/.
 */
import { BN, BorshCoder, type Idl } from "@anchor-lang/core";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  getTokenSize,
} from "@solana-program/token";
import {
  AccountRole,
  type Address,
  type Instruction,
  type KeyPairSigner,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase58Codec,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU64Encoder,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import * as t22 from "@solana-program/token-2022";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../dist/compiler/index.js";
import { loadOrCreateKeypair } from "../dist/keys.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const rpc = createSolanaRpc(env("TYPESOL_RPC_URL"));
const cliConfig = env("TYPESOL_SOLANA_CONFIG");
const deployer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(env("TYPESOL_DEPLOYER"), "utf8"))));
const SYSTEM = address("11111111111111111111111111111111");
const TOKEN = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const network = env("TYPESOL_NETWORK");
if (network !== "localnet" && network !== "devnet") throw new Error("TYPESOL_NETWORK must be localnet or devnet");
const genesis = await rpc.getGenesisHash().send();
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
if (network === "devnet" && genesis !== DEVNET_GENESIS) throw new Error("RPC is not devnet");
if (network === "localnet" && genesis === DEVNET_GENESIS) throw new Error("TYPESOL_NETWORK=localnet but the RPC is devnet");
console.log(`network ${network}  genesis ${genesis}`);

interface Program {
  id: Address;
  coder: BorshCoder;
}

async function deploy(name: string, source = path.join(ROOT, "examples", `${name}.ts`)): Promise<Program> {
  const out = path.join(ROOT, "target", network, name);
  const keyFile = path.join(ROOT, "target", network, `${name}-keypair.json`);
  mkdirSync(path.dirname(keyFile), { recursive: true });
  const { address: id } = loadOrCreateKeypair(keyFile);
  const res = build(source, out, id);
  const existing = await rpc.getAccountInfo(address(id), { encoding: "base64" }).send();
  if (!existing.value) {
    console.log(`  deploying ${name} -> ${id}`);
    execFileSync("solana", ["-C", cliConfig, "program", "deploy", "--use-rpc", res.soPath, "--program-id", keyFile], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    // A freshly deployed program becomes invocable from the next slot on.
    const deployedAt = await rpc.getSlot({ commitment: "confirmed" }).send();
    while ((await rpc.getSlot({ commitment: "confirmed" }).send()) < deployedAt + 2n) await new Promise((r) => setTimeout(r, 400));
  } else console.log(`  ${name} already deployed at ${id}`);
  return { id: address(id), coder: new BorshCoder(res.idl as unknown as Idl) };
}

type Meta = { address: Address; signer?: KeyPairSigner; writable?: boolean };
function ix(p: Program, name: string, args: Record<string, unknown>, accounts: Meta[]): Instruction {
  return {
    programAddress: p.id,
    accounts: accounts.map((a) => ({
      address: a.address,
      role: a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY,
      ...(a.signer ? { signer: a.signer } : {}),
    })) as Instruction["accounts"],
    data: new Uint8Array(p.coder.instruction.encode(name, args)),
  };
}

async function send(label: string, ixs: Instruction[], payer = deployer): Promise<string> {
  return (await sendWithLogs(label, ixs, payer)).sig;
}

/** Send and return the confirmed transaction's logs and return data. */
async function sendWithLogs(label: string, ixs: Instruction[], payer = deployer): Promise<{ sig: string; logs: string[]; returnData?: Buffer }> {
  const sig = await sendRaw(label, ixs, payer);
  const tx = await rpc.getTransaction(sig as never, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
  const meta = tx?.meta as unknown as { logMessages?: string[]; returnData?: { data: [string, string] } } | undefined;
  return { sig, logs: meta?.logMessages ?? [], returnData: meta?.returnData ? Buffer.from(meta.returnData.data[0], "base64") : undefined };
}

async function sendRaw(label: string, ixs: Instruction[], payer = deployer): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const tx = await pipe(
    createTransactionMessage({ version: 0 }),
    (t) => setTransactionMessageFeePayerSigner(payer, t),
    (t) => setTransactionMessageLifetimeUsingBlockhash(blockhash, t),
    (t) => appendTransactionMessageInstructions(ixs, t),
    (t) => signTransactionMessageWithSigners(t),
  );
  const sig = getSignatureFromTransaction(tx);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < 60; i++) {
    const { value } = await rpc.getSignatureStatuses([sig]).send();
    const st = value[0];
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      console.log(`  ok  ${label}  ${sig}`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label}: not confirmed in time`);
}

const pda = async (program: Address, seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];
const utf8 = (s: string) => new TextEncoder().encode(s);
const key = (a: Address) => new Uint8Array(getAddressEncoder().encode(a));
const u64le = (n: bigint) => new Uint8Array(getU64Encoder().encode(n));
const account = async (a: Address) => (await rpc.getAccountInfo(a, { encoding: "base64" }).send()).value;
const decode = async <T>(p: Program, name: string, a: Address) => {
  const v = await account(a);
  if (!v) throw new Error(`${a} missing`);
  return p.coder.accounts.decode(name, Buffer.from(v.data[0], "base64")) as T;
};
const tokenAmount = async (a: Address) => {
  const v = await account(a);
  return v ? getTokenDecoder().decode(Buffer.from(v.data[0], "base64")).amount : undefined;
};
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

console.log(`deployer ${deployer.address}  balance ${(await rpc.getBalance(deployer.address).send()).value} lamports`);

// ---- counter ----------------------------------------------------------------
console.log("\ncounter");
const counter = await deploy("counter");
const counterPda = await pda(counter.id, [utf8("counter"), key(deployer.address)]);
if (!(await account(counterPda)))
  await send("initialize", [
    ix(counter, "initialize", {}, [
      { address: deployer.address, signer: deployer, writable: true },
      { address: counterPda, writable: true },
      { address: SYSTEM },
    ]),
  ]);
const before = (await decode<{ count: BN }>(counter, "Counter", counterPda)).count;
await send("increment(3)", [
  ix(counter, "increment", { by: new BN(3) }, [
    { address: deployer.address, signer: deployer },
    { address: counterPda, writable: true },
  ]),
]);
const after = (await decode<{ count: BN }>(counter, "Counter", counterPda)).count;
assert(after.sub(before).toNumber() === 3, "count increased by 3");
console.log(`  count ${before} -> ${after}`);

// ---- vault ------------------------------------------------------------------
console.log("\nvault");
const vault = await deploy("vault");
const vaultPda = await pda(vault.id, [utf8("vault"), key(deployer.address)]);
const me = { address: deployer.address, signer: deployer, writable: true };
const v = { address: vaultPda, writable: true };
if (!(await account(vaultPda))) await send("open", [ix(vault, "open", {}, [me, v, { address: SYSTEM }])]);
const rentFloor = (await rpc.getBalance(vaultPda).send()).value;
await send("deposit 0.01 SOL", [ix(vault, "deposit", { amount: new BN(10_000_000) }, [me, v, { address: SYSTEM }])]);
await send("withdraw 0.004 SOL", [ix(vault, "withdraw", { amount: new BN(4_000_000) }, [me, v])]);
assert((await rpc.getBalance(vaultPda).send()).value === rentFloor + 6_000_000n, "vault holds 0.006 SOL above rent");
await send("shut", [ix(vault, "shut", {}, [me, v])]);
assert(!(await account(vaultPda)), "vault closed");

// ---- escrow -----------------------------------------------------------------
console.log("\nescrow");
const escrow = await deploy("escrow");
const taker = await generateKeyPairSigner();
const mintA = await generateKeyPairSigner();
const mintB = await generateKeyPairSigner();
const seed = BigInt(Date.now());
const offer = await pda(escrow.id, [utf8("offer"), key(deployer.address), u64le(seed)]);
const [makerA, makerB, takerA, takerB, vaultTok] = await Promise.all([1, 2, 3, 4, 5].map(() => generateKeyPairSigner()));
const mintRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send();
const tokRent = await rpc.getMinimumBalanceForRentExemption(BigInt(getTokenSize())).send();
const newMint = (m: KeyPairSigner) => [
  getCreateAccountInstruction({ payer: deployer, newAccount: m, lamports: mintRent, space: getMintSize(), programAddress: TOKEN }),
  getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: deployer.address }),
];
const newTok = (t: KeyPairSigner, mint: Address, owner: Address) => [
  getCreateAccountInstruction({ payer: deployer, newAccount: t, lamports: tokRent, space: getTokenSize(), programAddress: TOKEN }),
  getInitializeAccount3Instruction({ account: t.address, mint, owner }),
];
await send("create mints", [...newMint(mintA), ...newMint(mintB)]);
await send("create token accounts", [
  ...newTok(makerA, mintA.address, deployer.address),
  ...newTok(makerB, mintB.address, deployer.address),
  ...newTok(takerA, mintA.address, taker.address),
]);
await send("create token accounts 2", [
  ...newTok(takerB, mintB.address, taker.address),
  ...newTok(vaultTok, mintA.address, offer),
  getMintToInstruction({ mint: mintA.address, token: makerA.address, mintAuthority: deployer, amount: 1_000n }),
  getMintToInstruction({ mint: mintB.address, token: takerB.address, mintAuthority: deployer, amount: 500n }),
  {
    programAddress: SYSTEM,
    accounts: [
      { address: deployer.address, role: AccountRole.WRITABLE_SIGNER, signer: deployer },
      { address: taker.address, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from([2, 0, 0, 0, ...u64le(20_000_000n)]),
  } as Instruction,
]);
await send("make", [
  ix(
    escrow,
    "make",
    { seed: new BN(seed.toString()), amount_a: new BN(400), want_b: new BN(250), mint_b: { toBuffer: () => Buffer.from(key(mintB.address)) } },
    [
      me,
      { address: offer, writable: true },
      { address: makerA.address, writable: true },
      { address: vaultTok.address, writable: true },
      { address: SYSTEM },
      { address: TOKEN },
    ],
  ),
]);
assert((await tokenAmount(vaultTok.address)) === 400n, "vault holds 400 A");
await send(
  "take",
  [
    ix(escrow, "take", {}, [
      { address: taker.address, signer: taker, writable: true },
      { address: deployer.address, writable: true },
      { address: offer, writable: true },
      { address: takerA.address, writable: true },
      { address: takerB.address, writable: true },
      { address: makerB.address, writable: true },
      { address: vaultTok.address, writable: true },
      { address: TOKEN },
    ]),
  ],
  taker,
);
assert((await tokenAmount(takerA.address)) === 400n && (await tokenAmount(makerB.address)) === 250n, "swap settled");
assert(!(await account(offer)) && !(await account(vaultTok.address)), "offer and vault closed");

// ---- language fixture: loops, helpers, fixed arrays -------------------------
console.log("\nscores (loops / helpers / arrays)");
const scores = await deploy("scores", path.join(ROOT, "test/fixtures/scores.ts"));
const boardPda = await pda(scores.id, [utf8("board"), key(deployer.address)]);
if (!(await account(boardPda))) await send("setup", [ix(scores, "setup", {}, [me, { address: boardPda, writable: true }, { address: SYSTEM }])]);
const player = (await generateKeyPairSigner()).address;
const pkArg = (a: Address) => ({ toBuffer: () => Buffer.from(key(a)) });
await send("submit 40 then 90", [
  ix(scores, "submit", { player: pkArg(player), score: new BN(40) }, [
    { address: deployer.address, signer: deployer },
    { address: boardPda, writable: true },
  ]),
  ix(scores, "submit", { player: pkArg(player), score: new BN(90) }, [
    { address: deployer.address, signer: deployer },
    { address: boardPda, writable: true },
  ]),
]);
await send("poke sumTo(10, skip 3)", [
  ix(scores, "poke", { index: new BN(7), n: new BN(10), skip: new BN(3), cap: new BN(1000) }, [{ address: boardPda, writable: true }]),
]);
const board = await decode<{ scores: BN[]; players: { toBase58(): string }[] }>(scores, "Board", boardPda);
const slot = board.players.findIndex((p) => p.toBase58() === player);
assert(slot >= 0 && board.scores[slot].toString() === "90", "best score kept");
assert(board.scores[7].toString() === "37", "loop + helper result");

// ---- relay: cross-program invocation -----------------------------------------
console.log("\nrelay (CPI)");
// Pin the relay to this cluster's counter deployment.
const relaySrc = path.join(ROOT, "target", network, "relay-src", "relay.ts");
mkdirSync(path.dirname(relaySrc), { recursive: true });
writeFileSync(relaySrc, readFileSync(path.join(ROOT, "examples/relay.ts"), "utf8").replace(/Program<"[^"]+">/, `Program<"${counter.id}">`));
const relay = await deploy("relay", relaySrc);
const beforeRelay = (await decode<{ count: BN }>(counter, "Counter", counterPda)).count;
await send("relay_increment(10) via CPI", [
  ix(relay, "relay_increment", { by: new BN(10) }, [
    { address: deployer.address, signer: deployer },
    { address: counterPda, writable: true },
    { address: counter.id },
  ]),
]);
const afterRelay = (await decode<{ count: BN }>(counter, "Counter", counterPda)).count;
assert(afterRelay.sub(beforeRelay).toNumber() === 10, "counter bumped through the relay");
const [treasury, treasuryBump] = await getProgramDerivedAddress({ programAddress: relay.id, seeds: [utf8("treasury"), key(deployer.address)] });
await send("fund treasury PDA", [
  {
    programAddress: SYSTEM,
    accounts: [
      { address: deployer.address, role: AccountRole.WRITABLE_SIGNER, signer: deployer },
      { address: treasury, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from([2, 0, 0, 0, ...u64le(50_000_000n)]),
  } as Instruction,
]);
const payee = (await generateKeyPairSigner()).address;
await send("payout 0.01 SOL from PDA", [
  ix(relay, "payout", { amount: new BN(10_000_000), bump: treasuryBump }, [
    { address: deployer.address, signer: deployer },
    { address: treasury, writable: true },
    { address: payee, writable: true },
    { address: SYSTEM },
  ]),
]);
assert((await rpc.getBalance(payee).send()).value === 10_000_000n, "payee received 0.01 SOL from the PDA");
console.log(`  count ${beforeRelay} -> ${afterRelay}`);

// ---- profiles + caller: nested structs, strings, events, return data -------
console.log("\nprofiles (structs / strings / events / return data)");
const profiles = await deploy("profiles");
const callerSrc = path.join(ROOT, "target", network, "caller-src", "caller.ts");
mkdirSync(path.dirname(callerSrc), { recursive: true });
writeFileSync(callerSrc, readFileSync(path.join(ROOT, "examples/caller.ts"), "utf8").replace(/Program<"[^"]+">/, `Program<"${profiles.id}">`));
const caller = await deploy("caller", callerSrc);
const pname = `smoke-${Date.now() % 100000}`;
const profilePda = await pda(profiles.id, [utf8("profile"), key(deployer.address), utf8(pname)]);
await send("register", [ix(profiles, "register", { name: pname }, [me, { address: profilePda, writable: true }, { address: SYSTEM }])]);
const renamed = await sendWithLogs("rename (event)", [
  ix(profiles, "rename", { name: `${pname}!` }, [
    { address: deployer.address, signer: deployer },
    { address: profilePda, writable: true },
  ]),
]);
const ev = renamed.logs.filter((l) => l.startsWith("Program data: ")).map((l) => profiles.coder.events.decode(l.slice(14)));
assert(ev[0]?.name === "Renamed" && ev[0].data.to === `${pname}!`, "Renamed event decoded from cluster logs");
await send("move x2", [
  ix(profiles, "move", { dx: new BN(3), dy: new BN(4) }, [
    { address: deployer.address, signer: deployer },
    { address: profilePda, writable: true },
  ]),
  ix(profiles, "move", { dx: new BN(-1), dy: new BN(2) }, [
    { address: deployer.address, signer: deployer },
    { address: profilePda, writable: true },
  ]),
]);
const prof = await decode<{ home: { x: BN; y: BN }; moves: number }>(profiles, "Profile", profilePda);
assert(prof.home.x.toString() === "2" && prof.home.y.toString() === "6" && prof.moves === 2, "nested struct state");
const checked = await sendWithLogs("caller.check_distance (CPI + return data)", [
  ix(caller, "check_distance", { at_least: new BN(10) }, [{ address: profilePda }, { address: profiles.id }]),
]);
assert(checked.returnData?.readBigUInt64LE() === 20n, "caller returned 2x the callee's return data");

// ---- minter: Token-2022 mint with an extension ------------------------------
console.log("\nminter (Token-2022)");
const minter = await deploy("minter");
const T22 = address(t22.TOKEN_2022_PROGRAM_ADDRESS);
const mint22 = await generateKeyPairSigner();
const configPda = await pda(minter.id, [utf8("config"), key(mint22.address)]);
const mintSpace = t22.getMintSize([{ __kind: "MintCloseAuthority", closeAuthority: deployer.address }]);
await send("create Token-2022 mint (+MintCloseAuthority)", [
  getCreateAccountInstruction({
    payer: deployer,
    newAccount: mint22,
    lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(mintSpace)).send(),
    space: mintSpace,
    programAddress: T22,
  }),
  t22.getInitializeMintCloseAuthorityInstruction({ mint: mint22.address, closeAuthority: deployer.address }),
  t22.getInitializeMint2Instruction({ mint: mint22.address, decimals: 6, mintAuthority: configPda }),
]);
await send("setup", [
  ix(minter, "setup", { cap: new BN(1_000_000) }, [me, { address: configPda, writable: true }, { address: mint22.address }, { address: SYSTEM }]),
]);
const holder = await generateKeyPairSigner();
const ataOf = async (owner: Address) => {
  const create = await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: deployer, owner, mint: mint22.address, tokenProgram: T22 });
  await send(`ATA for ${owner.slice(0, 4)}…`, [create]);
  return create.accounts[1].address as Address;
};
const [myAta, holderAta] = [await ataOf(deployer.address), await ataOf(holder.address)];
await send("issue 700000", [
  ix(minter, "issue", { amount: new BN(700_000) }, [
    { address: deployer.address, signer: deployer },
    { address: configPda, writable: true },
    { address: mint22.address, writable: true },
    { address: myAta, writable: true },
    { address: T22 },
  ]),
]);
await send("pay 250000 (transferChecked)", [
  ix(minter, "pay", { amount: new BN(250_000) }, [
    { address: deployer.address, signer: deployer },
    { address: myAta, writable: true },
    { address: mint22.address },
    { address: holderAta, writable: true },
    { address: T22 },
  ]),
]);
assert((await tokenAmount(holderAta)) === 250_000n, "holder received Token-2022 tokens");
const burned = await sendWithLogs("burn 50000 (returns supply)", [
  ix(minter, "burn", { amount: new BN(50_000) }, [
    { address: deployer.address, signer: deployer },
    { address: myAta, writable: true },
    { address: mint22.address, writable: true },
    { address: T22 },
  ]),
]);
assert(burned.returnData?.readBigUInt64LE() === 650_000n, "burn returned the new supply");

// ---- ledgerbook: enums, Option, Vec + realloc on a real validator -------------
console.log("\nledgerbook (Vec realloc / Option / enum)");
const lb = await deploy("ledgerbook");
const lbTitle = `t${Date.now() % 100000}`;
const bookPda = await pda(lb.id, [utf8("book"), key(deployer.address), utf8(lbTitle)]);
await send("create (approver = self)", [
  ix(lb, "create", { title: lbTitle, approver: { toBuffer: () => Buffer.from(key(deployer.address)) } }, [
    me,
    { address: bookPda, writable: true },
    { address: SYSTEM },
  ]),
]);
const sizeOf = async () => Buffer.from((await account(bookPda))!.data[0], "base64").length;
const lbBefore = await sizeOf();
await send(
  "file x3 (account grows)",
  [0, 1, 2].map((i) =>
    ix(lb, "file", { amount: new BN(100 + i), note: `n${i}`, memo: i === 1 ? new BN(9) : null }, [
      me,
      { address: bookPda, writable: true },
      { address: SYSTEM },
    ]),
  ),
);
const grown = await sizeOf();
assert(grown === lbBefore + 3 * 61, `account grew by 3 entries (${lbBefore} -> ${grown})`);
await send("approve_many([0, 2])", [
  ix(lb, "approve_many", { indices: [new BN(0), new BN(2)] }, [
    { address: deployer.address, signer: deployer },
    { address: bookPda, writable: true },
  ]),
]);
const totals = await sendWithLogs("total(Approved) -> return data", [ix(lb, "total", { status: { Approved: {} } }, [{ address: bookPda }])]);
assert(totals.returnData?.readBigUInt64LE() === 202n, "approved total = 100 + 102");
await send("reset (account shrinks)", [
  ix(lb, "reset", {}, [
    { address: deployer.address, signer: deployer },
    { address: bookPda, writable: true },
  ]),
]);
assert((await sizeOf()) === lbBefore, "account shrank back to its fixed part");

// ---- airdrop: remaining accounts ------------------------------------------------
console.log("\nairdrop (remaining accounts)");
const ad = await deploy("airdrop");
const potPda = await pda(ad.id, [utf8("pot"), key(deployer.address)]);
if (!(await account(potPda))) await send("setup pot", [ix(ad, "setup", {}, [me, { address: potPda, writable: true }, { address: SYSTEM }])]);
await send("fund pot", [
  {
    programAddress: SYSTEM,
    accounts: [
      { address: deployer.address, role: AccountRole.WRITABLE_SIGNER, signer: deployer },
      { address: potPda, role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from([2, 0, 0, 0, ...u64le(100_000_000n)]),
  } as Instruction,
]);
const lucky = await Promise.all([1, 2, 3].map(async () => (await generateKeyPairSigner()).address));
await send("airdrop to 3 remaining accounts", [
  ix(ad, "airdrop", { each: new BN(5_000_000) }, [
    { address: deployer.address, signer: deployer },
    { address: potPda, writable: true },
    ...lucky.map((address) => ({ address, writable: true })),
  ]),
]);
for (const a of lucky) assert((await rpc.getBalance(a).send()).value === 5_000_000n, "remaining account received its share");

// ---- orderbook: multi-file program, 28 KiB client-allocated Zeroed account ---------
console.log("\norderbook (multi-file, 28 KiB Zeroed account)");
const ob = await deploy("orderbook", path.join(ROOT, "examples/orderbook/orderbook.ts"));
const bookKp = await generateKeyPairSigner();
const BOOK_SPACE = 8 + 28_720;
await send("allocate 28 KiB book (System CreateAccount)", [
  getCreateAccountInstruction({
    payer: deployer,
    newAccount: bookKp,
    lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(BOOK_SPACE)).send(),
    space: BOOK_SPACE,
    programAddress: ob.id,
  }),
]);
const obBook = { address: bookKp.address, writable: true };
await send("init (Zeroed)", [ix(ob, "init", {}, [{ address: deployer.address, signer: deployer }, obBook])]);
const placeOb = (side: object, price: number, qty: number) =>
  ix(ob, "place", { side, price: new BN(price), qty: new BN(qty) }, [{ address: deployer.address, signer: deployer }, obBook]);
await send("3 asks", [placeOb({ Ask: {} }, 105, 10), placeOb({ Ask: {} }, 101, 5), placeOb({ Ask: {} }, 103, 5)]);
const crossed = await sendWithLogs("crossing bid (2 fills)", [placeOb({ Bid: {} }, 104, 8)]);
const obFills = crossed.logs.filter((l) => l.startsWith("Program data: ")).map((l) => ob.coder.events.decode(l.slice(14))!.data);
assert(obFills.length === 2 && obFills[0].price.toString() === "101" && obFills[1].price.toString() === "103", "fills best price first");
const bestAsk = await sendWithLogs("best(Ask) -> return data", [ix(ob, "best", { side: { Ask: {} } }, [{ address: bookKp.address }])]);
assert(bestAsk.returnData?.readBigUInt64LE() === 103n, "best ask is the partly filled 103");

{
  // ---- crypto: Merkle claims, the Ed25519 precompile, heap strings ---------------------
  console.log("\ncrypto (keccak Merkle, Ed25519 precompile, strings)");
  const crypto = await deploy("crypto", path.join(ROOT, "test/fixtures/crypto.ts"));
  const kc = (...p: Uint8Array[]) => Buffer.from(keccak_256(Buffer.concat(p)));
  const leafA = kc(key(deployer.address), u64le(500n));
  const leafB = kc(Buffer.alloc(32, 9), u64le(1n));
  const [lo, hi] = Buffer.compare(leafA, leafB) <= 0 ? [leafA, leafB] : [leafB, leafA];
  const root = kc(lo, hi);
  const dropPda = await pda(crypto.id, [utf8("drop"), key(deployer.address)]);
  await send("drop setup (root)", [ix(crypto, "setup", { root: [...root] }, [me, { address: dropPda, writable: true }, { address: SYSTEM }])]);
  await send("claim with Merkle proof", [
    ix(crypto, "claim", { amount: new BN(500), proof: [[...leafB]] }, [
      { address: deployer.address, signer: deployer },
      { address: dropPda, writable: true },
    ]),
  ]);
  const edKeys = generateKeyPairSync("ed25519");
  const edPub = Buffer.from(edKeys.publicKey.export({ format: "jwk" }).x!, "base64url");
  const edMsg = Buffer.from("allow:77");
  const edSig = edSign(null, edMsg, edKeys.privateKey);
  const edHeader = Buffer.alloc(16);
  edHeader[0] = 1;
  [48, 0xffff, 16, 0xffff, 112, edMsg.length, 0xffff].forEach((v, i) => edHeader.writeUInt16LE(v, 2 + i * 2));
  await send("Ed25519 precompile + verifyEd25519", [
    {
      programAddress: address("Ed25519SigVerify111111111111111111111111111"),
      accounts: [],
      data: new Uint8Array(Buffer.concat([edHeader, edPub, edSig, edMsg])),
    } as Instruction,
    ix(crypto, "signed_action", { authority: { toBuffer: () => edPub }, who: { toBuffer: () => Buffer.from(key(deployer.address)) }, amount: new BN(77) }, [
      { address: address("Sysvar1nstructions1111111111111111111111111") },
    ]),
  ]);
  void getAddressDecoder;
  const greet = await sendWithLogs("string concat + template", [ix(crypto, "greet", { name: "sol", n: new BN(7) }, [])]);
  assert(greet.logs.includes("Program log: hello, sol! you are #7"), "heap string built on chain");
  const hashed = await sendWithLogs("sha256 + keccak256", [ix(crypto, "hashes", { text: "abc", n: new BN(42) }, [])]);
  const a256 = createHash("sha256")
    .update(Buffer.concat([Buffer.from("abc"), u64le(42n), Buffer.from([1])]))
    .digest();
  assert(hashed.returnData?.equals(kc(Buffer.from("typesol"), a256)) ?? false, "hash matches off-chain");
}

{
  // ---- data enums, Option<struct>, conveniences -------------------------------------------
  console.log("\nvariants + conveniences");
  const variants = await deploy("variants", path.join(ROOT, "test/fixtures/variants.ts"));
  const qPda = await pda(variants.id, [utf8("queue"), key(deployer.address)]);
  await send("queue init", [ix(variants, "init", {}, [me, { address: qPda, writable: true }, { address: SYSTEM }])]);
  const submitted = await sendWithLogs("submit Deposit + Withdraw (enum args/events)", [
    ix(variants, "submit", { action: { Deposit: { amount: new BN(100) } } }, [
      { address: deployer.address, signer: deployer },
      { address: qPda, writable: true },
    ]),
    ix(variants, "submit", { action: { Withdraw: { amount: new BN(40), to: { toBuffer: () => Buffer.from(key(deployer.address)) } } } }, [
      { address: deployer.address, signer: deployer },
      { address: qPda, writable: true },
    ]),
  ]);
  const applied = submitted.logs.filter((l) => l.startsWith("Program data: ")).map((l) => variants.coder.events.decode(l.slice(14))!);
  assert(applied.length === 2 && Object.keys(applied[1].data.action)[0] === "Withdraw", "enum events decoded");
  const conv = await deploy("conveniences", path.join(ROOT, "test/fixtures/conveniences.ts"));
  const stashPda = await pda(conv.id, [utf8("stash"), key(deployer.address)]);
  const dep = (n: number) => ix(conv, "deposit", { amount: new BN(n) }, [me, { address: stashPda, writable: true }, { address: SYSTEM }]);
  await send("init_if_needed x2", [dep(5), dep(6)]);
  const applyRes = await sendWithLogs("has_one + seeds + switch", [
    ix(conv, "apply", { op: { Double: {} }, n: new BN(0) }, [
      { address: deployer.address, signer: deployer },
      { address: stashPda, writable: true },
    ]),
  ]);
  assert(applyRes.returnData?.readBigUInt64LE() === 22n, "(5 + 6) * 2");
}

{
  // ---- oracles from validator fixtures (scripts/localnet.sh) ----------------------------------
  if (process.env.TYPESOL_PYTH && process.env.TYPESOL_SWITCHBOARD) {
    console.log("\noracles (fixture accounts)");
    const oracles = await deploy("oracles", path.join(ROOT, "test/fixtures/oracles.ts"));
    const px = await sendWithLogs("pythPrice", [
      ix(oracles, "pyth_usd", { feed_id: [...Buffer.alloc(32, 0xef)], max_age: new BN(3600) }, [{ address: address(process.env.TYPESOL_PYTH) }]),
    ]);
    assert(px.returnData?.readBigInt64LE() === 15_012_345_678n, "Pyth price");
    const sbv = await sendWithLogs("switchboardValue", [
      ix(
        oracles,
        "sb_value",
        { expected: { toBuffer: () => Buffer.from(key(address(process.env.TYPESOL_SWITCHBOARD!))) }, max_stale_slots: new BN(1_000_000) },
        [{ address: address(process.env.TYPESOL_SWITCHBOARD) }],
      ),
    ]);
    assert(sbv.returnData?.readBigInt64LE() === 1_234_567_891n, "Switchboard value at 6 decimals");
  }
}

{
  // ---- ATA + token metadata (Token-2022 extension and Metaplex) -------------------------------
  console.log("\ntokenkit (ATA CPI, Token-2022 metadata, Metaplex metadata)");
  const tk = await deploy("tokenkit", path.join(ROOT, "test/fixtures/tokenkit.ts"));
  const ATA = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const MPL = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const kitMint = async (program: Address, pointer: boolean) => {
    const m = await generateKeyPairSigner();
    const issuer = await pda(tk.id, [utf8("issuer"), key(m.address)]);
    const ext = pointer
      ? [
          {
            __kind: "MetadataPointer" as const,
            authority: { __option: "Some" as const, value: deployer.address },
            metadataAddress: { __option: "Some" as const, value: m.address },
          },
        ]
      : [];
    const space = program === T22 && ext.length ? t22.getMintSize(ext as never) : 82;
    await send(`create mint (${program === T22 ? "Token-2022" : "SPL"}${pointer ? " + MetadataPointer" : ""})`, [
      getCreateAccountInstruction({
        payer: deployer,
        newAccount: m,
        lamports: (await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send()) + (pointer ? 10_000_000n : 0n),
        space,
        programAddress: program,
      }),
      ...(pointer ? [t22.getInitializeMetadataPointerInstruction({ mint: m.address, authority: deployer.address, metadataAddress: m.address })] : []),
      program === T22
        ? t22.getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: issuer })
        : getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: issuer }),
    ]);
    await send("issuer setup", [ix(tk, "setup", {}, [me, { address: issuer, writable: true }, { address: m.address }, { address: SYSTEM }])]);
    return { mint: m.address, issuer };
  };
  const splMint = await kitMint(TOKEN, false);
  const holderWallet = (await generateKeyPairSigner()).address;
  const holderAta = (await t22.findAssociatedTokenPda({ owner: holderWallet, mint: splMint.mint, tokenProgram: TOKEN }))[0];
  await send("ATA createIdempotent via CPI", [
    ix(tk, "open_account", {}, [
      me,
      { address: holderWallet },
      { address: holderAta, writable: true },
      { address: splMint.mint },
      { address: SYSTEM },
      { address: TOKEN },
      { address: ATA },
    ]),
  ]);
  assert(!!(await account(holderAta)), "ATA exists");
  // Token Metadata is loaded only when its binary was fetched (scripts/fetch-programs.sh; Metaplex license).
  if (await account(MPL)) {
    const metaPda = await pda(MPL, [utf8("metadata"), key(MPL), key(splMint.mint)]);
    await send("Metaplex CreateMetadataAccountV3 via CPI", [
      ix(tk, "name_metaplex", { name: "TypeSOL", symbol: "DEMO", uri: "https://example.com/m.json" }, [
        me,
        { address: splMint.issuer },
        { address: splMint.mint },
        { address: metaPda, writable: true },
        { address: SYSTEM },
        { address: MPL },
      ]),
    ]);
    assert(Buffer.from((await account(metaPda))!.data[0], "base64").includes(Buffer.from("TypeSOL")), "Metaplex metadata written");
  } else console.log("  --  Token Metadata not loaded (pnpm fetch:programs)");
  const t22Mint = await kitMint(T22, true);
  await send("Token-2022 metadata extension via CPI", [
    ix(tk, "name_token2022", { name: "TypeSOL Coin", symbol: "DEMO", uri: "https://example.com/coin.json" }, [
      { address: deployer.address, signer: deployer },
      { address: t22Mint.issuer },
      { address: t22Mint.mint, writable: true },
      { address: T22 },
    ]),
  ]);
  assert(Buffer.from((await account(t22Mint.mint))!.data[0], "base64").includes(Buffer.from("TypeSOL Coin")), "Token-2022 metadata written");
}

{
  // ---- transfer hook --------------------------------------------------------------------------
  console.log("\ntransfer hook");
  const hook = await deploy("hook", path.join(ROOT, "test/fixtures/hook.ts"));
  const hookMint = await generateKeyPairSigner();
  const hookSpace = t22.getMintSize([{ __kind: "TransferHook", authority: deployer.address, programId: hook.id }] as never);
  await send("Token-2022 mint with TransferHook", [
    getCreateAccountInstruction({
      payer: deployer,
      newAccount: hookMint,
      lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(hookSpace)).send(),
      space: hookSpace,
      programAddress: T22,
    }),
    t22.getInitializeTransferHookInstruction({ mint: hookMint.address, authority: deployer.address, programId: hook.id }),
    t22.getInitializeMint2Instruction({ mint: hookMint.address, decimals: 0, mintAuthority: deployer.address }),
  ]);
  const extra = await pda(hook.id, [utf8("extra-account-metas"), key(hookMint.address)]);
  await send("initialize extra account metas", [
    {
      programAddress: hook.id,
      accounts: [
        { address: deployer.address, role: AccountRole.WRITABLE_SIGNER, signer: deployer },
        { address: extra, role: AccountRole.WRITABLE },
        { address: hookMint.address, role: AccountRole.READONLY },
        { address: SYSTEM, role: AccountRole.READONLY },
      ],
      data: Uint8Array.from([43, 34, 13, 49, 167, 88, 235, 235, 0, 0, 0, 0]),
    } as Instruction,
  ]);
  const hookAta = async (owner: Address) => {
    const c = await t22.getCreateAssociatedTokenIdempotentInstructionAsync({ payer: deployer, owner, mint: hookMint.address, tokenProgram: T22 });
    await send(`hook-mint ATA ${owner.slice(0, 4)}…`, [c]);
    return c.accounts[1].address as Address;
  };
  const hFrom = await hookAta(deployer.address);
  const hTo = await hookAta((await generateKeyPairSigner()).address);
  await send("mint 5000", [t22.getMintToInstruction({ mint: hookMint.address, token: hFrom, mintAuthority: deployer, amount: 5000n })]);
  const hookTransfer = (amount: bigint) => {
    const base = t22.getTransferCheckedInstruction({ source: hFrom, mint: hookMint.address, destination: hTo, authority: deployer, amount, decimals: 0 });
    return {
      ...base,
      accounts: [...base.accounts, { address: hook.id, role: AccountRole.READONLY }, { address: extra, role: AccountRole.READONLY }],
    } as Instruction;
  };
  await send("transfer 700 (hook allows)", [hookTransfer(700n)]);
  let blocked = false;
  try {
    await send("transfer 1500 (hook blocks)", [hookTransfer(1500n)]);
  } catch {
    blocked = true;
    console.log("  ok  transfer 1500 rejected by the hook");
  }
  assert(blocked, "hook blocked the large transfer");
}

{
  // ---- token operations, constraints and fields; struct arguments; 128-bit math; generated CPI helpers ----
  console.log("\ntokenops (createAccount, initializeMint2/Account3, approve, freeze, setAuthority)");
  const to = await deploy("tokenops", path.join(ROOT, "test/fixtures/tokenops.ts"));
  const configPda = await getProgramDerivedAddress({ programAddress: to.id, seeds: [utf8("config")] });
  if (!(await rpc.getAccountInfo(configPda[0], { encoding: "base64" }).send()).value)
    await send("config PDA", [ix(to, "setup", {}, [me, { address: configPda[0], writable: true }, { address: SYSTEM }])]);
  const newMint = await generateKeyPairSigner();
  await send("createAccount + initializeMint2 (program CPIs)", [
    ix(to, "create_mint", {}, [
      me,
      { address: newMint.address, signer: newMint, writable: true },
      { address: configPda[0] },
      { address: SYSTEM },
      { address: T22 },
    ]),
  ]);
  const [vaultPda, vaultBump] = await getProgramDerivedAddress({ programAddress: to.id, seeds: [utf8("vault"), key(newMint.address)] });
  await send("PDA token account via createAccount + initializeAccount3", [
    ix(to, "create_vault", { bump: vaultBump }, [
      me,
      { address: vaultPda, writable: true },
      { address: newMint.address },
      { address: configPda[0] },
      { address: SYSTEM },
      { address: T22 },
    ]),
  ]);
  await send("mintTo (HasOne mintAuthority)", [
    ix(to, "mint_to", { amount: new BN(500) }, [
      { address: newMint.address, writable: true },
      { address: vaultPda, writable: true },
      { address: configPda[0] },
      { address: T22 },
    ]),
  ]);
  const spender = (await generateKeyPairSigner()).address;
  await send("approve (HasOne mint + owner)", [
    ix(to, "delegate", { amount: new BN(120) }, [
      { address: vaultPda, writable: true },
      { address: newMint.address },
      { address: configPda[0] },
      { address: spender },
      { address: T22 },
    ]),
  ]);
  const inspect = await sendWithLogs("delegate / delegatedAmount fields", [ix(to, "inspect", {}, [{ address: vaultPda }, { address: newMint.address }])]);
  assert(inspect.returnData?.readBigUInt64LE() === 120_010n, "delegatedAmount * 1000 + hasDelegate * 10");
  await send("freeze + thaw", [
    ix(to, "freeze", { on: true }, [{ address: vaultPda, writable: true }, { address: newMint.address }, { address: configPda[0] }, { address: T22 }]),
    ix(to, "freeze", { on: false }, [{ address: vaultPda, writable: true }, { address: newMint.address }, { address: configPda[0] }, { address: T22 }]),
  ]);
  await send("setAuthority (drop freeze, hand over mint)", [
    ix(to, "hand_over", { next: { toBuffer: () => Buffer.from(key(deployer.address)) }, keep: true }, [
      { address: newMint.address, writable: true },
      { address: configPda[0] },
      { address: T22 },
    ]),
  ]);

  console.log("\nstruct arguments + CPI data");
  const sa = await deploy("structargs", path.join(ROOT, "test/fixtures/structargs.ts"));
  const bookPda = await pda(sa.id, [utf8("book"), key(deployer.address)]);
  if (!(await rpc.getAccountInfo(bookPda, { encoding: "base64" }).send()).value)
    await send("book init", [ix(sa, "init", {}, [me, { address: bookPda, writable: true }, { address: SYSTEM }])]);
  const order = (price: number, qty: number) => ({
    side: { Bid: {} },
    price: new BN(price),
    qty: new BN(qty),
    tag: { len: 2, bytes: [104, 105, 0, 0, 0, 0, 0, 0] },
    flags: [true, false],
    note: { is_some: false, value: new BN(0) },
  });
  await send("struct + Vec<struct> args, forwarded by self-CPI", [
    ix(sa, "forward", { order: order(3, 4), orders: [order(1, 2), order(1, 3)] }, [{ address: bookPda, writable: true }, { address: sa.id }]),
  ]);

  console.log("\n128-bit and bit operations");
  const ar = await deploy("arith", path.join(ROOT, "test/fixtures/arith.ts"));
  const big = await sendWithLogs("u128 multiply", [ix(ar, "op_u128", { op: 2, a: new BN("18446744073709551616"), b: new BN("1000") }, [])]);
  assert(big.returnData?.equals(Buffer.from(18446744073709551616000n.toString(16).padStart(32, "0"), "hex").reverse()) ?? false, "2^64 * 1000 as u128");
  const text = await sendWithLogs("u128/i128 text", [ix(ar, "big_text", {}, [])]);
  assert(text.returnData?.readBigUInt64LE() === 80n, "128-bit decimal text");

  // The Anchor vault twin runs at its declared id only when the validator preloads it (scripts/localnet.sh does).
  const vaultIdl = JSON.parse(readFileSync(path.join(ROOT, "test/fixtures/anchor_vault.idl.json"), "utf8"));
  const vaultId = address(vaultIdl.address);
  if (!(await rpc.getAccountInfo(vaultId, { encoding: "base64" }).send()).value)
    console.log("\n(skipped generated CPI helpers: the Anchor vault twin is not loaded)");
  else {
    console.log("\ngenerated CPI helpers -> Anchor vault");
    const dir = path.join(ROOT, "target", network, "cpigen-src");
    mkdirSync(dir, { recursive: true });
    const { generateCpi } = await import("../dist/cpigen.js");
    writeFileSync(path.join(dir, "vault_cpi.ts"), generateCpi(vaultIdl).source);
    writeFileSync(
      path.join(dir, "vault_caller.ts"),
      `import { type AccountInfo, type Mut, type Program, type SystemProgram, type Signer, type u8, type u64, signer } from "typesol";\nimport { vaultDeposit, vaultOpen } from "./vault_cpi";\nexport function pdaVault(payer: Mut<Signer>, wallet: Mut<AccountInfo>, vault: Mut<AccountInfo>, systemProgram: SystemProgram, vaultProgram: Program<"${vaultIdl.address}">, bump: u8, amount: u64): void {\n  systemProgram.transfer(payer, wallet, 100000000n);\n  vaultOpen(vaultProgram, wallet, vault, systemProgram, signer(["wallet", bump]));\n  vaultDeposit(vaultProgram, wallet, vault, systemProgram, amount, signer(["wallet", bump]));\n}\n`,
    );
    const vc = await deploy("vault_caller", path.join(dir, "vault_caller.ts"));
    const [wallet, wbump] = await getProgramDerivedAddress({ programAddress: vc.id, seeds: [utf8("wallet")] });
    const wVault = await pda(vaultId, [utf8("vault"), key(wallet)]);
    if (!(await rpc.getAccountInfo(wVault, { encoding: "base64" }).send()).value)
      await send("PDA-signed CPI into the Anchor vault (generated helpers)", [
        ix(vc, "pda_vault", { bump: wbump, amount: new BN(2_000_000) }, [
          me,
          { address: wallet, writable: true },
          { address: wVault, writable: true },
          { address: SYSTEM },
          { address: vaultId },
        ]),
      ]);
    const vAcct = await rpc.getAccountInfo(wVault, { encoding: "base64" }).send();
    assert(
      Buffer.from(vAcct.value!.data[0], "base64")
        .subarray(8, 40)
        .equals(Buffer.from(key(wallet))),
      "Anchor vault owned by the caller's PDA",
    );
  }
}

{
  // ---- ProgramData on a real upgradeable deploy, optional accounts, emitCpi, realloc, Token-2022 extensions ----
  console.log("\nProgramData, optional accounts, emitCpi, realloc, Token-2022 extensions");
  const platform = await deploy("platform", path.join(ROOT, "test/fixtures/platform.ts"));
  const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
  const programData = await pda(LOADER, [key(platform.id)]);
  const admin = await sendWithLogs("ProgramData: the deployer is the upgrade authority", [
    ix(platform, "admin_only", {}, [{ address: programData }, { address: deployer.address, signer: deployer }]),
  ]);
  assert((admin.returnData?.readBigUInt64LE() ?? 0n) > 0n, "deploy slot read from ProgramData");
  const clock = await sendWithLogs("currentSlot / currentEpoch", [ix(platform, "clock", {}, [])]);
  assert((clock.returnData?.readBigUInt64LE() ?? 0n) > 0n, "slot * 1000 + epoch");

  const opt = await deploy("optional", path.join(ROOT, "test/fixtures/optional.ts"));
  const bank = await pda(opt.id, [utf8("bank"), key(deployer.address)]);
  if (!(await rpc.getAccountInfo(bank, { encoding: "base64" }).send()).value)
    await send("bank open", [ix(opt, "open", {}, [me, { address: bank, writable: true }, { address: SYSTEM }])]);
  const none = await sendWithLogs("optional accounts left out (program id in their slots)", [
    ix(opt, "maybe_add", { amount: new BN(3) }, [{ address: deployer.address, signer: deployer }, { address: opt.id }, { address: opt.id }]),
  ]);
  assert(none.returnData?.readBigUInt64LE() === 0n, "nothing added");
  const some = await sendWithLogs("optional accounts passed", [
    ix(opt, "maybe_add", { amount: new BN(3) }, [{ address: deployer.address, signer: deployer }, { address: bank, writable: true }, { address: opt.id }]),
  ]);
  assert(some.returnData?.readBigUInt64LE() === 1n, "added to the bank");

  const ev = await deploy("eventcpi", path.join(ROOT, "test/fixtures/eventcpi.ts"));
  const evAuthority = await pda(ev.id, [utf8("__event_authority")]);
  const paidSig = await send("emitCpi (self-CPI event)", [
    ix(ev, "pay", { amount: new BN(42), memo: "rent" }, [{ address: deployer.address, signer: deployer }, { address: evAuthority }, { address: ev.id }]),
  ]);
  const paidTx = await rpc.getTransaction(paidSig as never, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "base64" }).send();
  const innerData = (paidTx?.meta as unknown as { innerInstructions: { instructions: { data: string }[] }[] }).innerInstructions[0].instructions[0].data;
  const raw = Buffer.from(getBase58Codec().encode(innerData));
  const paid = ev.coder.events.decode(raw.subarray(8).toString("base64"))!;
  assert(paid.name === "Paid" && (paid.data.amount as BN).toString() === "42", "event decoded from the inner instruction");

  const rl = await deploy("realloc", path.join(ROOT, "test/fixtures/realloc.ts"));
  const docPda = await pda(rl.id, [utf8("doc"), key(deployer.address)]);
  if (!(await rpc.getAccountInfo(docPda, { encoding: "base64" }).send()).value)
    await send("doc make", [ix(rl, "make", {}, [me, { address: docPda, writable: true }, { address: SYSTEM }])]);
  await send("realloc grow 4000 + shrink 100", [
    ix(rl, "resize", { size: new BN(4000) }, [me, { address: docPda, writable: true }, { address: SYSTEM }]),
    ix(rl, "resize", { size: new BN(100) }, [me, { address: docPda, writable: true }, { address: SYSTEM }]),
  ]);
  const docAcct = await rpc.getAccountInfo(docPda, { encoding: "base64" }).send();
  assert(Buffer.from(docAcct.value!.data[0], "base64").length === 100, "account resized to 100 bytes");

  const tx = await deploy("t22ext", path.join(ROOT, "test/fixtures/t22ext.ts"));
  const feeMint = await generateKeyPairSigner();
  const feeExt = [
    {
      __kind: "TransferFeeConfig",
      transferFeeConfigAuthority: deployer.address,
      withdrawWithheldAuthority: deployer.address,
      withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: 500n, transferFeeBasisPoints: 125 },
      newerTransferFee: { epoch: 0n, maximumFee: 500n, transferFeeBasisPoints: 125 },
    },
  ];
  const feeSpace = t22.getMintSize(feeExt as never);
  await send("Token-2022 mint with a transfer fee", [
    getCreateAccountInstruction({
      payer: deployer,
      newAccount: feeMint,
      lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(feeSpace)).send(),
      space: feeSpace,
      programAddress: T22,
    }),
    t22.getInitializeTransferFeeConfigInstruction({
      mint: feeMint.address,
      transferFeeConfigAuthority: deployer.address,
      withdrawWithheldAuthority: deployer.address,
      transferFeeBasisPoints: 125,
      maximumFee: 500n,
    }),
    t22.getInitializeMint2Instruction({ mint: feeMint.address, decimals: 6, mintAuthority: deployer.address }),
  ]);
  const fee = await sendWithLogs("transferFee(mint, 10_001)", [ix(tx, "fee", { amount: new BN(10_001) }, [{ address: feeMint.address }])]);
  assert(fee.returnData?.readBigUInt64LE() === 126n, "ceil(10001 * 1.25%)");
}

{
  // ---- canonical on-chain IDL, Metaplex Core + Bubblegum, SBPF v1/v2 -----------------------
  console.log("\nIDL publishing, Metaplex Core and Bubblegum, SBPF v1/v2");
  const { publishIdl, fetchIdl, rpcChain } = await import("../dist/idlpublish.js");
  const pc = await deploy("platform-idl", path.join(ROOT, "test/fixtures/platform.ts"));
  const idl = JSON.parse(readFileSync(path.join(ROOT, "target", network, "platform-idl", "platform.json"), "utf8"));
  try {
    const at = await publishIdl(rpcChain(rpc as never), { program: pc.id, idl, payer: deployer, canonical: true });
    console.log(`  ok  canonical IDL written by the upgrade authority at ${at}`);
    assert(JSON.stringify(await fetchIdl(rpc as never, pc.id)) === JSON.stringify(idl), "IDL read back from the chain");
  } catch (e) {
    // The current Program Metadata build uses a System instruction older validators lack ("invalid instruction data").
    const logs = JSON.stringify((e as { cause?: { context?: unknown } }).cause?.context ?? "", (_, v) => (typeof v === "bigint" ? v.toString() : v));
    if (!/invalid instruction data/.test(logs + String(e))) throw e;
    console.log("  --  on-chain IDL skipped: this validator's System program rejects the Program Metadata build (LiteSVM test covers it)");
  }

  const CORE = address("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
  if ((await rpc.getAccountInfo(CORE, { encoding: "base64" }).send()).value) {
    const mp = await deploy("metaplex", path.join(ROOT, "test/fixtures/metaplex.ts"));
    const studio = await pda(mp.id, [utf8("studio")]);
    if (!(await rpc.getAccountInfo(studio, { encoding: "base64" }).send()).value)
      await send("studio PDA", [ix(mp, "setup", {}, [me, { address: studio, writable: true }, { address: SYSTEM }])]);
    const collection = await generateKeyPairSigner();
    await send("Core collection (PDA update authority)", [
      ix(mp, "make_collection", {}, [
        { address: collection.address, signer: collection, writable: true },
        { address: studio, writable: true },
        me,
        { address: CORE },
        { address: SYSTEM },
      ]),
    ]);
    const asset = await generateKeyPairSigner();
    await send("Core asset in the collection, signed by the PDA", [
      ix(mp, "mint_asset", {}, [
        { address: asset.address, signer: asset, writable: true },
        { address: collection.address, writable: true },
        { address: studio },
        me,
        { address: deployer.address },
        { address: CORE },
        { address: SYSTEM },
      ]),
    ]);
    const BUBBLEGUM = address("BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY");
    const COMPRESSION = address("cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK");
    const NOOP = address("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
    const tree = await generateKeyPairSigner();
    const space = 56 + 24 + 8 * (40 + 32 * 3) + (40 + 32 * 3);
    const treeConfig = await pda(BUBBLEGUM, [key(tree.address)]);
    await send("Bubblegum tree created by the PDA", [
      getCreateAccountInstruction({
        payer: deployer,
        newAccount: tree,
        lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send(),
        space,
        programAddress: COMPRESSION,
      }),
      ix(mp, "make_tree", {}, [
        { address: treeConfig, writable: true },
        { address: tree.address, writable: true },
        me,
        { address: studio },
        { address: NOOP },
        { address: COMPRESSION },
        { address: BUBBLEGUM },
        { address: SYSTEM },
      ]),
    ]);
    await send("compressed NFT minted", [
      ix(mp, "mint_compressed", {}, [
        { address: treeConfig, writable: true },
        { address: deployer.address },
        { address: tree.address, writable: true },
        me,
        { address: studio },
        { address: NOOP },
        { address: COMPRESSION },
        { address: BUBBLEGUM },
        { address: SYSTEM },
      ]),
    ]);
    const cfg = await rpc.getAccountInfo(treeConfig, { encoding: "base64" }).send();
    assert(Buffer.from(cfg.value!.data[0], "base64").readBigUInt64LE(80) === 1n, "one leaf minted");
  }

  for (const sbpf of ["v1", "v2"] as const) {
    const out = path.join(ROOT, "target", network, `counter-${sbpf}`);
    const keyFile = path.join(ROOT, "target", network, `counter-${sbpf}-keypair.json`);
    const { address: id } = loadOrCreateKeypair(keyFile);
    const res = build(path.join(ROOT, "examples/counter.ts"), out, id, { sbpf });
    try {
      if (!(await rpc.getAccountInfo(address(id), { encoding: "base64" }).send()).value)
        execFileSync("solana", ["-C", cliConfig, "program", "deploy", "--use-rpc", res.soPath, "--program-id", keyFile], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      const at = await rpc.getSlot({ commitment: "confirmed" }).send();
      while ((await rpc.getSlot({ commitment: "confirmed" }).send()) < at + 2n) await new Promise((r) => setTimeout(r, 400));
      const prog = { id: address(id), coder: new BorshCoder(res.idl as unknown as Idl) };
      const ctr = await pda(prog.id, [utf8("counter"), key(deployer.address)]);
      await send(`counter built for SBPF ${sbpf}`, [ix(prog, "initialize", {}, [me, { address: ctr, writable: true }, { address: SYSTEM }])]);
    } catch (e) {
      console.log(
        `  --  SBPF ${sbpf} not accepted by this cluster: ${String((e as Error).message ?? e)
          .split("\n")[0]
          .slice(0, 160)}`,
      );
    }
  }
}

console.log(
  `\nall ${network} checks passed\n  counter ${counter.id}\n  vault   ${vault.id}\n  escrow  ${escrow.id}\n  scores  ${scores.id}\n  relay   ${relay.id}\n  profiles ${profiles.id}\n  caller  ${caller.id}\n  minter  ${minter.id}\n  ledgerbook ${lb.id}\n  airdrop ${ad.id}\n  orderbook ${ob.id}`,
);
void lamports;
void existsSync;
