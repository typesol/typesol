/**
 * A deployed program read straight from a cluster, for `typesol verify --address`: its ELF bytes and who can still
 * change them. Handles the three loaders a program can live under:
 *
 * - upgradeable (loader v3, what `solana program deploy` uses): the program account points at a ProgramData account
 *   holding the deploy slot, the upgrade authority (none once frozen) and then the ELF;
 * - loader v4: one account holding the slot, the authority, the status and then the ELF;
 * - the old non-upgradeable loader (v2): the account data is the ELF itself.
 */
import type { Address, Rpc, SolanaRpcApi } from "@solana/kit";
import { getAddressDecoder } from "@solana/kit";

export const LOADER_V2 = "BPFLoader2111111111111111111111111111111111";
export const LOADER_V3 = "BPFLoaderUpgradeab1e11111111111111111111111";
export const LOADER_V4 = "LoaderV411111111111111111111111111111111111";

export interface Deployed {
  loader: "v2" | "v3" | "v4";
  /** The ELF as stored (loader v3 keeps it zero-padded to the account's allocation). */
  elf: Buffer;
  /** Who can upgrade or close it; null when the program is immutable. */
  authority: string | null;
  /** The slot of the last deploy or upgrade (v3, v4). */
  slot?: bigint;
  /** Where the bytes live (the ProgramData account for v3). */
  dataAccount: string;
}

type AccountRpc = Pick<Rpc<SolanaRpcApi>, "getAccountInfo">;

async function account(rpc: AccountRpc, address: string): Promise<{ owner: string; data: Buffer } | null> {
  const { value } = await rpc.getAccountInfo(address as Address, { encoding: "base64", commitment: "confirmed" }).send();
  if (!value) return null;
  return { owner: value.owner, data: Buffer.from(value.data[0], "base64") };
}

const key = (data: Buffer, offset: number) => getAddressDecoder().decode(data.subarray(offset, offset + 32));

/** The deployed program at `programId`, or an error that says why there is none. */
export async function fetchDeployed(rpc: AccountRpc, programId: string): Promise<Deployed> {
  const program = await account(rpc, programId);
  if (!program) throw new Error(`no account at ${programId} on this cluster`);
  if (program.owner === LOADER_V2) return { loader: "v2", elf: program.data, authority: null, dataAccount: programId };
  if (program.owner === LOADER_V4) {
    // u64 slot, authority (or next version), u64 status (0 retracted, 1 deployed, 2 finalized), then the ELF.
    if (program.data.length < 48) throw new Error(`${programId} is not a loader-v4 program`);
    const status = program.data.readBigUInt64LE(40);
    if (status === 0n) throw new Error(`${programId} is retracted (loader v4): it has no executable code`);
    return {
      loader: "v4",
      elf: program.data.subarray(48),
      authority: status === 2n ? null : key(program.data, 8),
      slot: program.data.readBigUInt64LE(0),
      dataAccount: programId,
    };
  }
  if (program.owner !== LOADER_V3) throw new Error(`${programId} is not a program (owner ${program.owner})`);
  // Program account: u32 state = 2, ProgramData address.
  if (program.data.length < 36 || program.data.readUInt32LE(0) !== 2) throw new Error(`${programId} is an upgradeable-loader account but not a program`);
  const dataAccount = key(program.data, 4);
  const pd = await account(rpc, dataAccount);
  // ProgramData: u32 state = 3, u64 slot, Option<Pubkey> authority (1 + 32 bytes), then the ELF.
  if (!pd || pd.owner !== LOADER_V3 || pd.data.length < 45 || pd.data.readUInt32LE(0) !== 3)
    throw new Error(`${programId} has no program data (closed or never deployed)`);
  return { loader: "v3", elf: pd.data.subarray(45), authority: pd.data[12] ? key(pd.data, 13) : null, slot: pd.data.readBigUInt64LE(4), dataAccount };
}

/** JSON with object keys sorted, so two IDLs compare by content and not by key order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}
