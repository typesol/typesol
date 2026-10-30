/**
 * Copies of cluster accounts for tests (Anchor's `[test.validator.clone]`): `typesol clone` fetches them once and
 * writes them under `tests/accounts/`, and `testProgram` loads that directory into its LiteSVM.
 *
 *  - an account: `<address>.json` with its lamports, owner, executable flag and data (base64);
 *  - a program: `<address>.so`, its ELF (from the ProgramData account for the upgradeable loader), loaded with
 *    `addProgramFromFile`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOADERS = new Set(["BPFLoader2111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111"]);
/** ProgramData: u32 tag, u64 slot, Option<Pubkey> authority (1 + 32), then the ELF. */
const PROGRAM_DATA_HEADER = 45;

export interface ClonedAccount {
  address: string;
  lamports: string;
  owner: string;
  executable: boolean;
  data: string;
}

interface RpcAccount {
  lamports: bigint | number;
  owner: string;
  executable: boolean;
  data: [string, string];
}

/** What the clone needs of an RPC: kit's `getMultipleAccounts(…, { encoding: "base64" })`. */
export interface CloneRpc {
  getMultipleAccounts(addresses: never[], config: { encoding: "base64" }): { send(): Promise<{ value: (RpcAccount | null)[] }> };
}

async function fetchAll(rpc: CloneRpc, addresses: string[]): Promise<(RpcAccount | null)[]> {
  const out: (RpcAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const { value } = await rpc.getMultipleAccounts(addresses.slice(i, i + 100) as never[], { encoding: "base64" }).send();
    out.push(...value);
  }
  return out;
}

/** Fetch `addresses` and write them to `dir`. Returns what was written, one line per account. */
export async function cloneAccounts(rpc: CloneRpc, addresses: string[], dir: string): Promise<string[]> {
  mkdirSync(dir, { recursive: true });
  const accounts = await fetchAll(rpc, addresses);
  const missing = addresses.filter((_, i) => !accounts[i]);
  if (missing.length) throw new Error(`not found on the cluster: ${missing.join(", ")}`);
  const written: string[] = [];
  // Upgradeable programs: the ELF is in their ProgramData account (named in the program account's data).
  const programData = new Map<string, string>();
  accounts.forEach((a, i) => {
    if (a!.executable && a!.owner === UPGRADEABLE_LOADER) {
      const raw = Buffer.from(a!.data[0], "base64");
      if (raw.length < 36 || raw.readUInt32LE(0) !== 2) throw new Error(`${addresses[i]}: not an upgradeable program account`);
      programData.set(addresses[i]!, base58(raw.subarray(4, 36)));
    }
  });
  const datas = await fetchAll(rpc, [...programData.values()]);
  const elfOf = new Map([...programData.keys()].map((p, i) => [p, datas[i]] as const));
  accounts.forEach((a, i) => {
    const address = addresses[i]!;
    if (a!.executable && (a!.owner === UPGRADEABLE_LOADER || LOADERS.has(a!.owner))) {
      const pd = elfOf.get(address);
      if (a!.owner === UPGRADEABLE_LOADER && !pd) throw new Error(`${address}: its ProgramData account is gone (the program was closed)`);
      const elf = pd ? Buffer.from(pd.data[0], "base64").subarray(PROGRAM_DATA_HEADER) : Buffer.from(a!.data[0], "base64");
      writeFileSync(path.join(dir, `${address}.so`), elf);
      written.push(`${address}.so  program, ${elf.length} bytes`);
      return;
    }
    const entry: ClonedAccount = { address, lamports: String(a!.lamports), owner: a!.owner, executable: a!.executable, data: a!.data[0] };
    writeFileSync(path.join(dir, `${address}.json`), JSON.stringify(entry, null, 2) + "\n");
    written.push(`${address}.json  ${Buffer.from(a!.data[0], "base64").length} bytes, owner ${a!.owner}`);
  });
  return written;
}

/** What loading needs of a LiteSVM. */
export interface CloneSvm {
  setAccount(account: { address: never; lamports: never; programAddress: never; executable: boolean; data: Uint8Array; space: bigint }): unknown;
  addProgramFromFile(programId: never, path: string): unknown;
}

/** Load every account and program `cloneAccounts` wrote to `dir` into `svm`. Returns how many. */
export function loadClonedAccounts(svm: CloneSvm, dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir).sort()) {
    const file = path.join(dir, f);
    if (f.endsWith(".so")) {
      svm.addProgramFromFile(f.slice(0, -3) as never, file);
      n++;
    } else if (f.endsWith(".json")) {
      const a = JSON.parse(readFileSync(file, "utf8")) as ClonedAccount;
      const data = new Uint8Array(Buffer.from(a.data, "base64"));
      svm.setAccount({
        address: a.address as never,
        lamports: BigInt(a.lamports) as never,
        programAddress: a.owner as never,
        executable: a.executable,
        data,
        space: BigInt(data.length),
      });
      n++;
    }
  }
  return n;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
