import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { type Address, address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, customError, decodeAccount, deployFile, expectOk, fundedSigner, ix, pda, send, type Deployed } from "../harness.js";

const ED25519 = address("Ed25519SigVerify111111111111111111111111111");
const IX_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
const enc = getAddressEncoder();
const keccak = (...parts: Uint8Array[]) => Buffer.from(keccak_256(Buffer.concat(parts)));
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const hashArg = (b: Uint8Array) => [...b];

/** Sorted-pair keccak Merkle tree (OpenZeppelin convention). Returns root and proof builder. */
function merkle(leaves: Buffer[]) {
  const layers: Buffer[][] = [leaves];
  while (layers.at(-1)!.length > 1) {
    const cur = layers.at(-1)!;
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 === cur.length) next.push(cur[i]);
      else {
        const [a, b] = Buffer.compare(cur[i], cur[i + 1]) <= 0 ? [cur[i], cur[i + 1]] : [cur[i + 1], cur[i]];
        next.push(keccak(a, b));
      }
    }
    layers.push(next);
  }
  const proof = (index: number) => {
    const out: Buffer[] = [];
    for (let l = 0; l < layers.length - 1; l++) {
      const sib = index ^ 1;
      if (sib < layers[l].length) out.push(layers[l][sib]);
      index >>= 1;
    }
    return out;
  };
  return { root: layers.at(-1)![0], proof };
}

/** The Ed25519 precompile instruction: one signature, pubkey/signature/message inside its own data. */
function ed25519Ix(pub: Uint8Array, sig: Uint8Array, msg: Uint8Array) {
  const header = Buffer.alloc(16);
  header[0] = 1;
  const pkOff = 16,
    sigOff = 48,
    msgOff = 112;
  [sigOff, 0xffff, pkOff, 0xffff, msgOff, msg.length, 0xffff].forEach((v, i) => header.writeUInt16LE(v, 2 + i * 2));
  return { programAddress: ED25519, accounts: [], data: new Uint8Array(Buffer.concat([header, pub, sig, msg])) };
}

describe("crypto (test/fixtures/crypto.ts)", () => {
  let d: Deployed;
  beforeAll(async () => {
    d = await deployFile(fileURLToPath(new URL("../fixtures/crypto.ts", import.meta.url)));
  });

  it("sha256 / keccak256 over mixed parts match Node and noble", async () => {
    const payer = await fundedSigner(d.svm);
    const r = expectOk(await send(d.svm, payer, [ix(d, "hashes", { text: "abc", n: new BN(42) }, [])]));
    const a = createHash("sha256")
      .update(Buffer.concat([Buffer.from("abc"), u64le(42n), Buffer.from([1])]))
      .digest();
    const want = keccak(Buffer.from("typesol"), a);
    expect(Buffer.from(r.returnData().data())).toEqual(want);
  });

  it("verifies Merkle airdrop proofs and rejects forged ones", async () => {
    const people = await Promise.all([1, 2, 3, 4, 5].map(() => fundedSigner(d.svm)));
    const amounts = [100n, 250n, 7n, 9000n, 1n];
    const leaves = people.map((p, i) => keccak(enc.encode(p.address) as Uint8Array, u64le(amounts[i])));
    const tree = merkle(leaves);
    const admin = await fundedSigner(d.svm);
    const [drop] = await pda(d.programId, ["drop", admin.address]);
    expectOk(
      await send(d.svm, admin, [
        ix(d, "setup", { root: hashArg(tree.root) }, [
          { address: admin.address, signer: admin, writable: true },
          { address: drop, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const claim = (i: number, amount: bigint, proofOf = i) =>
      ix(d, "claim", { amount: new BN(amount.toString()), proof: tree.proof(proofOf).map(hashArg) }, [
        { address: people[i].address, signer: people[i] },
        { address: drop, writable: true },
      ]);
    for (let i = 0; i < 5; i++) expectOk(await send(d.svm, people[i], [claim(i, amounts[i])]));
    expect(decodeAccount<{ claimed: BN }>(d, d.svm, "Drop", drop).claimed.toString()).toBe("9358");
    expect(customError(await send(d.svm, people[0], [claim(0, 101n)]))).toBe(6000); // wrong amount
    expect(customError(await send(d.svm, people[1], [claim(1, amounts[1], 0)]))).toBe(6000); // someone else's proof
  });

  it("accepts an off-chain Ed25519 signature checked by the precompile, rejects other keys/messages", async () => {
    const payer = await fundedSigner(d.svm);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
    const authority = getAddressDecoder().decode(pub) as Address;
    const who = (await fundedSigner(d.svm)).address;
    const act = (amount: number, signer: Address = authority) =>
      ix(
        d,
        "signed_action",
        { authority: { toBuffer: () => Buffer.from(enc.encode(signer)) }, who: { toBuffer: () => Buffer.from(enc.encode(who)) }, amount: new BN(amount) },
        [{ address: IX_SYSVAR }],
      );
    const msg = Buffer.from("allow:500");
    const sig = sign(null, msg, privateKey);
    expectOk(await send(d.svm, payer, [ed25519Ix(pub, sig, msg) as never, act(500)]));
    // Same signature, different amount: the message the program expects no longer matches.
    expect(customError(await send(d.svm, payer, [ed25519Ix(pub, sig, msg) as never, act(501)]))).toBe(6001);
    // Expecting a different signer.
    const other = (await fundedSigner(d.svm)).address;
    expect(customError(await send(d.svm, payer, [ed25519Ix(pub, sig, msg) as never, act(500, other)]))).toBe(6001);
    // No precompile instruction at all.
    expect(customError(await send(d.svm, payer, [act(500)]))).toBe(6001);
  });

  it("recovers secp256k1 (Ethereum) signers of keccak256(message) and of personal_sign messages", async () => {
    const payer = await fundedSigner(d.svm);
    const priv = secp256k1.utils.randomSecretKey();
    const uncompressed = secp256k1.getPublicKey(priv, false).slice(1);
    const eth = Buffer.concat([Buffer.alloc(12), keccak(uncompressed).subarray(12)]);
    const message = "typesol says hi";
    const sig = secp256k1.sign(keccak(Buffer.from(message)), priv, { prehash: false, format: "recovered" });
    const check = (name: string, msg: string, rec: number, r: Uint8Array, s: Uint8Array, e: Buffer) =>
      ix(d, name, { message: msg, recovery_id: rec, r: hashArg(r), s: hashArg(s), eth_address: hashArg(e) }, []);
    const result = async (msg: string, rec: number, e: Buffer, s: Uint8Array = sig.slice(33, 65), name = "eth_signed", r: Uint8Array = sig.slice(1, 33)) =>
      Buffer.from(
        expectOk(await send(d.svm, payer, [check(name, msg, rec, r, s, e)]))
          .returnData()
          .data(),
      )[0];
    expect(await result(message, sig[0], eth)).toBe(1);
    expect(await result("tampered", sig[0], eth)).toBe(0);
    expect(await result(message, sig[0] ^ 1, eth)).toBe(0);
    // The malleated twin (n - s, flipped recovery id) recovers the same signer; high-S is refused like ecrecover libraries do.
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sHigh = Buffer.from((n - BigInt("0x" + Buffer.from(sig.slice(33, 65)).toString("hex"))).toString(16).padStart(64, "0"), "hex");
    expect(await result(message, sig[0] ^ 1, eth, sHigh)).toBe(0);
    // personal_sign (EIP-191), as MetaMask signs it.
    const prefixed = keccak(Buffer.from(`\x19Ethereum Signed Message:\n${Buffer.byteLength(message)}`), Buffer.from(message));
    const ps = secp256k1.sign(prefixed, priv, { prehash: false, format: "recovered" });
    expect(await result(message, ps[0], eth, ps.slice(33, 65), "eth_personal", ps.slice(1, 33))).toBe(1);
    expect(await result(message, sig[0], eth, sig.slice(33, 65), "eth_personal")).toBe(0);
  });

  it("a signature made up for an arbitrary hash does not verify (the hash is computed from the message)", async () => {
    const payer = await fundedSigner(d.svm);
    const victimPub = secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), false); // private key discarded
    const eth = Buffer.concat([Buffer.alloc(12), keccak(victimPub.slice(1)).subarray(12)]);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const mod = (a: bigint) => ((a % n) + n) % n;
    const inv = (a: bigint) => {
      let [t, nt, r, nr] = [0n, 1n, n, mod(a)];
      while (nr) {
        const q = r / nr;
        [t, nt] = [nt, t - q * nt];
        [r, nr] = [nr, r - q * nr];
      }
      return mod(t);
    };
    const be32 = (x: bigint) => Buffer.from(x.toString(16).padStart(64, "0"), "hex");
    const rand = () => mod(BigInt("0x" + Buffer.from(secp256k1.utils.randomSecretKey()).toString("hex")));
    const Q = secp256k1.Point.fromBytes(victimPub);
    for (;;) {
      const [a, b] = [rand(), rand()];
      const R = secp256k1.Point.BASE.multiply(a).add(Q.multiply(b)).toAffine();
      if (R.x >= n) continue;
      let s = mod(R.x * inv(b));
      const h = mod(a * s);
      let rec = Number(R.y & 1n);
      if (s > n / 2n) {
        s = n - s;
        rec ^= 1;
      }
      // (h, r, s) is a valid signature by the victim's key over h — but the program hashes the message it is given,
      // and nobody can find a message whose keccak256 is h.
      const res = expectOk(
        await send(d.svm, payer, [
          ix(d, "eth_signed", { message: be32(h).toString("latin1"), recovery_id: rec, r: [...be32(R.x)], s: [...be32(s)], eth_address: [...eth] }, []),
        ]),
      );
      expect(Buffer.from(res.returnData().data())[0]).toBe(0);
      break;
    }
  });

  it("builds strings with + and templates on the heap", async () => {
    const payer = await fundedSigner(d.svm);
    const r = expectOk(await send(d.svm, payer, [ix(d, "greet", { name: "sol", n: new BN(7) }, [])]));
    expect(r.logs()).toContain("Program log: hello, sol! you are #7");
    expect(customError(await send(d.svm, payer, [ix(d, "greet", { name: "eth", n: new BN(7) }, [])]))).toBe(6002);
  });
});
