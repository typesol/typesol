// Ports of the basics/ Anchor programs of solana-developers/program-examples: each describe runs the flows of the
// original's TypeScript tests against the TypeSOL rewrite under test/ports/basics/. Status and reasons per program:
// test/ports/README.md.
import { type Address, generateKeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { BN, SYSTEM_PROGRAM, type Meta, acct, customError, decodeAccount, expectOk, fundedSigner, ix, pda, send } from "./harness.js";
import { allocate, deployPort, fixedString, toFixedString } from "./ports-helpers.js";

const SOL = 1_000_000_000n;

describe("port: basics/hello-solana", () => {
  it("logs the greeting and the program id", async () => {
    const id = "2phbC62wekpw95XuBk4i1KX4uA8zBUWmYbiTMhicSuBV";
    const d = await deployPort("basics/hello-solana.ts", id);
    const payer = await fundedSigner(d.svm);
    const logs = expectOk(await send(d.svm, payer, [ix(d, "hello", {}, [])])).logs();
    expect(logs).toContain("Program log: Hello, Solana!");
    expect(logs).toContain(`Program log: ${id}`);
  });
});

describe("port: basics/processing-instructions", () => {
  it("greets and checks the height", async () => {
    const d = await deployPort("basics/processing-instructions.ts", "DgoL5J44aspizyUs9fcnpGEUJjWTLJRCfx8eYtUMYczf");
    const payer = await fundedSigner(d.svm);
    const tall = expectOk(await send(d.svm, payer, [ix(d, "go_to_park", { name: "Jimmy", height: 3 }, [])])).logs();
    expect(tall).toContain("Program log: Welcome to the park, Jimmy!");
    expect(tall).toContain("Program log: You are NOT tall enough to ride this ride. Sorry mate.");
    const short = expectOk(await send(d.svm, payer, [ix(d, "go_to_park", { name: "Mary", height: 10 }, [])])).logs();
    expect(short).toContain("Program log: You are tall enough to ride this ride. Congratulations.");
  });
});

describe("port: basics/counter", () => {
  it("initializes a client-allocated counter and increments it", async () => {
    const d = await deployPort("basics/counter.ts", "BmDHboaj1kBUoinJKKSRqKfMeRKJqQqEbUj1VgzeQe4A");
    const payer = await fundedSigner(d.svm);
    const counter = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        allocate(d.svm, payer, counter, 8 + 8, d.programId),
        ix(d, "initialize_counter", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: counter.address, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const count = () => decodeAccount<{ count: BN }>(d, d.svm, "Counter", counter.address).count.toString();
    expect(count()).toBe("0");
    const inc = () => send(d.svm, payer, [ix(d, "increment", {}, [{ address: counter.address, writable: true }])]);
    expectOk(await inc());
    expect(count()).toBe("1");
    expectOk(await inc());
    expect(count()).toBe("2");
    // A second initialize on the same account is refused (the discriminator is set).
    expect(
      customError(
        await send(d.svm, payer, [
          ix(d, "initialize_counter", {}, [
            { address: payer.address, signer: payer, writable: true },
            { address: counter.address, writable: true },
            { address: SYSTEM_PROGRAM },
          ]),
        ]),
      ),
    ).toBe(3000);
  });
});

describe("port: basics/account-data", () => {
  it("stores an address", async () => {
    const d = await deployPort("basics/account-data.ts", "GpVcgWdgVErgLqsn8VYUch6EqDerMgNqoLSmGyKrd6MR");
    const payer = await fundedSigner(d.svm);
    const info = await generateKeyPairSigner();
    const create = (name: string) =>
      ix(d, "create_address_info", { name, house_number: 136, street: "Mile High Dr.", city: "Solana Beach" }, [
        { address: payer.address, signer: payer, writable: true },
        { address: info.address, writable: true },
        { address: SYSTEM_PROGRAM },
      ]);
    // A name longer than #[max_len(50)] does not fit.
    expect(customError(await send(d.svm, payer, [allocate(d.svm, payer, info, 8 + 163, d.programId), create("x".repeat(51))]))).toBe(5105);
    expectOk(await send(d.svm, payer, [allocate(d.svm, payer, info, 8 + 163, d.programId), create("Joe C")]));
    const a = decodeAccount<{ name: unknown; house_number: number; street: unknown; city: unknown }>(d, d.svm, "AddressInfo", info.address);
    expect(fixedString(a.name)).toBe("Joe C");
    expect(a.house_number).toBe(136);
    expect(fixedString(a.street)).toBe("Mile High Dr.");
    expect(fixedString(a.city)).toBe("Solana Beach");
    expect(acct(d.svm, info.address).data.length).toBe(8 + 54 + 1 + 54 + 54);
  });
});

describe("port: basics/checking-accounts", () => {
  it("accepts the expected accounts and rejects a wrongly owned account, a non-signer and a wrong program", async () => {
    const d = await deployPort("basics/checking-accounts.ts", "ECWPhR3rJbaPfyNFgphnjxSEexbTArc7vxD8fnW6tgKw");
    const payer = await fundedSigner(d.svm);
    const toCreate = await generateKeyPairSigner();
    const toChange = await generateKeyPairSigner();
    expectOk(await send(d.svm, payer, [allocate(d.svm, payer, toChange, 0, d.programId)]));
    const check = (changed: Address, o: { payer?: Meta; systemProgram?: Address } = {}) =>
      ix(d, "check_accounts", {}, [
        o.payer ?? { address: payer.address, signer: payer },
        { address: toCreate.address, writable: true },
        { address: changed, writable: true },
        { address: o.systemProgram ?? SYSTEM_PROGRAM },
      ]);
    expectOk(await send(d.svm, payer, [check(toChange.address)]));
    const systemOwned = await fundedSigner(d.svm, 1n);
    expect(customError(await send(d.svm, payer, [check(systemOwned.address)]))).toBe(2004);
    // `payer: Signer`: an account that did not sign the transaction (Anchor's AccountNotSigner).
    expect(customError(await send(d.svm, payer, [check(toChange.address, { payer: { address: systemOwned.address } })]))).toBe(3010);
    // `system_program: Program<System>`: any other account (Anchor's InvalidProgramId).
    expect(customError(await send(d.svm, payer, [check(toChange.address, { systemProgram: d.programId })]))).toBe(3008);
  });
});

describe("port: basics/close-account", () => {
  it("creates and closes a user account", async () => {
    const d = await deployPort("basics/close-account.ts", "99TQtoDdQ5NS2v5Ppha93aqEmv3vV9VZVfHTP5rGST3c");
    const user = await fundedSigner(d.svm);
    const [userAccount] = await pda(d.programId, ["USER", user.address]);
    expectOk(
      await send(d.svm, user, [
        ix(d, "create_user", { name: "John Doe" }, [
          { address: user.address, signer: user, writable: true },
          { address: userAccount, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const s = decodeAccount<{ user: { toBase58(): string }; name: unknown }>(d, d.svm, "UserState", userAccount);
    expect(s.user.toBase58()).toBe(user.address);
    expect(fixedString(s.name)).toBe("John Doe");
    expect(acct(d.svm, userAccount).data.length).toBe(8 + 1 + 32 + 4 + 50);
    // Someone else cannot close it: the PDA is derived from the signer.
    const other = await fundedSigner(d.svm);
    const close = (who: typeof user) =>
      ix(d, "close_user", {}, [
        { address: who.address, signer: who, writable: true },
        { address: userAccount, writable: true },
      ]);
    expect(customError(await send(d.svm, other, [close(other)]))).toBe(2006);
    // `close = user`: the user gets back exactly the account's rent (`other` pays the fee).
    const before = d.svm.getBalance(user.address)!;
    const rent = acct(d.svm, userAccount).lamports;
    expect(rent).toBe(d.svm.minimumBalanceForRentExemption(BigInt(8 + 1 + 32 + 4 + 50)));
    expectOk(await send(d.svm, other, [close(user)]));
    expect(d.svm.getAccount(userAccount).exists).toBe(false);
    expect(d.svm.getBalance(user.address)).toBe(before + rent);
  });
});

describe("port: basics/create-account", () => {
  it("creates a system account sized to the Borsh AddressData", async () => {
    const d = await deployPort("basics/create-account.ts", "ARVNCsYKDQsCLHbwUTJLpFXVrJdjhWZStyzvxmKe2xHi");
    const payer = await fundedSigner(d.svm);
    const fresh = await generateKeyPairSigner();
    const res = expectOk(
      await send(d.svm, payer, [
        ix(d, "create_system_account", { name: "Joe C", address: "123 Main St" }, [
          { address: payer.address, signer: payer, writable: true },
          { address: fresh.address, signer: fresh, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const span = 4 + 5 + 4 + 11;
    const a = acct(d.svm, fresh.address);
    expect(a.programAddress).toBe(SYSTEM_PROGRAM);
    expect(a.data.length).toBe(span);
    expect(a.lamports).toBe(d.svm.minimumBalanceForRentExemption(BigInt(span)));
    expect(res.logs()).toContain(`Program log: Account span: ${span}`);
  });
});

describe("port: basics/cross-program-invocation", () => {
  it("pulls the lever through a CPI, twice", async () => {
    const lever = await deployPort("basics/cross-program-invocation/lever.ts", "A6GUsa5Ej8iWzMMP3B6otFVB5aaUckVm8a31Y5TMLYRV");
    const hand = await deployPort("basics/cross-program-invocation/hand.ts", "59c3ER1YrnnnezUVH7ix4WDUw9TQ9k7xH6wQyAmWvc52", { svm: lever.svm });
    const svm = lever.svm;
    const user = await fundedSigner(svm);
    const power = await generateKeyPairSigner();
    expectOk(
      await send(svm, user, [
        allocate(svm, user, power, 8 + 8, lever.programId),
        ix(lever, "initialize", {}, [
          { address: power.address, writable: true },
          { address: user.address, signer: user, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const isOn = () => decodeAccount<{ is_on: boolean }>(lever, svm, "PowerStatus", power.address).is_on;
    expect(isOn()).toBe(false);
    const pull = (name: string, target = power.address) =>
      send(svm, user, [ix(hand, "pull_lever", { name }, [{ address: target, writable: true }, { address: lever.programId }])]);
    const logs = expectOk(await pull("Chris")).logs();
    expect(logs).toContain("Program log: Chris is pulling the power switch!");
    expect(logs).toContain("Program log: The power is now on.");
    expect(isOn()).toBe(true);
    expectOk(await pull("Ashley"));
    expect(isOn()).toBe(false);
    // hand checks that `power` is a lever PowerStatus account before calling.
    const stranger = await fundedSigner(svm, 1n);
    expect(customError(await pull("Mallory", stranger.address))).toBe(3007);
  });
});

describe("port: basics/favorites", () => {
  it("writes, updates and protects a user's favorites", async () => {
    const d = await deployPort("basics/favorites.ts", "ww9C83noARSQVBnqmCUmaVdbJjmiwcV9j2LkXYMoUCV");
    const user = await fundedSigner(d.svm);
    const [favorites] = await pda(d.programId, ["favorites", user.address]);
    const set = (who: typeof user, hobbies: string[], target = favorites) =>
      send(d.svm, who, [
        ix(d, "set_favorites", { number: new BN(23), color: "purple", hobbies: hobbies.map((h) => ({ text: toFixedString(h, 50) })) }, [
          { address: who.address, signer: who, writable: true },
          { address: target, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    const read = () => {
      const f = decodeAccount<{ number: BN; color: unknown; hobby_count: number; hobbies: unknown[] }>(d, d.svm, "Favorites", favorites);
      return { number: f.number.toNumber(), color: fixedString(f.color), hobbies: f.hobbies.slice(0, f.hobby_count).map(fixedString) };
    };
    expectOk(await set(user, ["skiing", "skydiving", "biking"]));
    expect(read()).toEqual({ number: 23, color: "purple", hobbies: ["skiing", "skydiving", "biking"] });
    expect(acct(d.svm, favorites).data.length).toBe(344);
    expectOk(await set(user, ["coding", "reading", "biking", "swimming"]));
    expect(read().hobbies).toEqual(["coding", "reading", "biking", "swimming"]);
    // Another signer cannot write to this user's favorites (the PDA is derived from the signer).
    const someRandomGuy = await fundedSigner(d.svm);
    expect(customError(await set(someRandomGuy, ["coding"]))).toBe(2006);
    // More than #[max_len(5, …)] hobbies do not fit.
    expect(customError(await set(user, ["a", "b", "c", "d", "e", "f"]))).toBe(6000);
    expect(read().hobbies).toEqual(["coding", "reading", "biking", "swimming"]);
  });
});

describe("port: basics/pda-rent-payer", () => {
  it("funds a rent vault PDA and lets it pay for new accounts", async () => {
    const d = await deployPort("basics/pda-rent-payer.ts", "7Hm9nsYVuBZ9rf8z9AMUHreZRv8Q4vLhqwdVTCawRZtA");
    const payer = await fundedSigner(d.svm);
    const [vault] = await pda(d.programId, ["rent_vault"]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "init_rent_vault", { fund_lamports: new BN(SOL.toString()) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: vault, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(d.svm.getBalance(vault)).toBe(SOL);
    const fresh = await generateKeyPairSigner();
    const create = () =>
      send(d.svm, payer, [
        ix(d, "create_new_account", {}, [
          { address: fresh.address, signer: fresh, writable: true },
          { address: vault, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]);
    expectOk(await create());
    const rent = d.svm.minimumBalanceForRentExemption(0n);
    expect(d.svm.getBalance(fresh.address)).toBe(rent);
    expect(d.svm.getBalance(vault)).toBe(SOL - rent);
  });
});

describe("port: basics/program-derived-addresses", () => {
  it("creates and increments a page-visits PDA", async () => {
    const d = await deployPort("basics/program-derived-addresses.ts", "oCCQRZyAbVxujyd8m57MPmDzZDmy2FoKW4ULS7KofCE");
    const payer = await fundedSigner(d.svm);
    const [pageVisits, bump] = await pda(d.programId, ["page_visits", payer.address]);
    expectOk(
      await send(d.svm, payer, [
        ix(d, "create_page_visits", {}, [
          { address: payer.address, signer: payer, writable: true },
          { address: pageVisits, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    const visit = (user = payer.address) =>
      send(d.svm, payer, [ix(d, "increment_page_visits", {}, [{ address: user }, { address: pageVisits, writable: true }])]);
    expectOk(await visit());
    expectOk(await visit());
    const v = decodeAccount<{ page_visits: number; bump: number }>(d, d.svm, "PageVisits", pageVisits);
    expect(v).toEqual({ page_visits: 2, bump });
    // Another user's address does not derive this PDA.
    const other = await fundedSigner(d.svm, 1n);
    expect(customError(await visit(other.address))).toBe(2006);
  });
});

describe("port: basics/realloc", () => {
  it("sizes the message account to each update, charging and refunding the payer", async () => {
    const d = await deployPort("basics/realloc.ts", "Fod47xKXjdHVQDzkFPBvfdWLm8gEAV4iMSXkfUzCHiSD");
    const payer = await fundedSigner(d.svm);
    const [message] = await pda(d.programId, ["message", payer.address]);
    const accounts = [{ address: payer.address, signer: payer, writable: true }, { address: message, writable: true }, { address: SYSTEM_PROGRAM }];
    const bytes = (s: string) => Buffer.from(s, "utf8");
    const check = (s: string) => {
      const a = acct(d.svm, message);
      expect(a.data.length).toBe(8 + 4 + s.length);
      // Byte-identical to Anchor's Borsh String: u32 length + UTF-8.
      expect(Buffer.from(a.data.subarray(8)).equals(Buffer.concat([Buffer.from(new Uint32Array([s.length]).buffer), bytes(s)]))).toBe(true);
      expect(a.lamports).toBe(d.svm.minimumBalanceForRentExemption(BigInt(a.data.length)));
    };
    expectOk(await send(d.svm, payer, [ix(d, "initialize", { input: bytes("hello") }, accounts)]));
    check("hello");
    expectOk(await send(d.svm, payer, [ix(d, "update", { input: bytes("hello world") }, accounts)]));
    check("hello world");
    // Growing counts a surplus already in the account (here it covers the new bytes, so the payer only pays the fee);
    // shrinking refunds the payer down to the new minimum.
    const funded = acct(d.svm, message).lamports + 100_000n;
    d.svm.setAccount({ ...d.svm.getAccount(message), address: message, lamports: lamports(funded) } as never);
    const payerFunded = d.svm.getBalance(payer.address)!;
    expectOk(await send(d.svm, payer, [ix(d, "update", { input: bytes("hello world!") }, accounts)]));
    expect(acct(d.svm, message).lamports).toBe(funded);
    expect(d.svm.getBalance(payer.address)).toBe(payerFunded - 5_000n);
    // Shrinking refunds everything above the new minimum, the 100_000 surplus included; the payer pays the fee.
    const payerBefore = d.svm.getBalance(payer.address)!;
    expectOk(await send(d.svm, payer, [ix(d, "update", { input: bytes("hi") }, accounts)]));
    check("hi");
    const refund = funded - d.svm.minimumBalanceForRentExemption(BigInt(8 + 4 + 2));
    expect(d.svm.getBalance(payer.address)).toBe(payerBefore - 5_000n + refund);
  });
});

describe("port: basics/transfer-sol", () => {
  it("transfers with a CPI and directly from a program-owned account, and stops an attacker", async () => {
    const d = await deployPort("basics/transfer-sol.ts", "4fQVnLWKKKYxtxgGn7Haw8v2g2Hzbu8K61JvWKvqAi7W");
    const payer = await fundedSigner(d.svm);
    const recipient = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "transfer_sol_with_cpi", { amount: new BN(SOL.toString()) }, [
          { address: payer.address, signer: payer, writable: true },
          { address: recipient.address, writable: true },
          { address: SYSTEM_PROGRAM },
        ]),
      ]),
    );
    expect(d.svm.getBalance(recipient.address)).toBe(SOL);

    // A keypair account owned by the program pays directly.
    const programOwned = await generateKeyPairSigner();
    d.svm.setAccount({
      address: programOwned.address,
      data: new Uint8Array(),
      executable: false,
      lamports: lamports(2n * SOL),
      programAddress: d.programId,
      space: 0n,
    });
    const recipient2 = await generateKeyPairSigner();
    expectOk(
      await send(d.svm, payer, [
        ix(d, "transfer_sol_with_program", { amount: new BN(SOL.toString()) }, [
          { address: programOwned.address, signer: programOwned, writable: true },
          { address: recipient2.address, writable: true },
        ]),
      ]),
    );
    expect(d.svm.getBalance(recipient2.address)).toBe(SOL);
    expect(d.svm.getBalance(programOwned.address)).toBe(SOL);

    // The attacker passes the victim's program-owned account without its signature.
    const attackerRecipient = await generateKeyPairSigner();
    const res = await send(d.svm, payer, [
      ix(d, "transfer_sol_with_program", { amount: new BN(SOL.toString()) }, [
        { address: programOwned.address, writable: true },
        { address: attackerRecipient.address, writable: true },
      ]),
    ]);
    expect(customError(res)).toBe(3010);
    expect(d.svm.getBalance(programOwned.address)).toBe(SOL);
  });
});

describe("port: basics/repository-layout", () => {
  it("runs the carnival's rides, games and food stands with the original messages", async () => {
    const d = await deployPort("basics/repository-layout/lib.ts", "8t94SEJh9jVjDwV7cbiuT6BvEsHo4YHP9x9a5rYH1NpP");
    const payer = await fundedSigner(d.svm);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = expectOk(await send(d.svm, payer, [ix(d, name, args, [{ address: payer.address, signer: payer, writable: true }])]));
      return r
        .logs()
        .filter((l) => l.startsWith("Program log: "))
        .map((l) => l.slice(13));
    };
    const ride = (name: string, height: number, ticket_count: number, ride_name: string) => call("go_on_ride", { name, height, ticket_count, ride_name });
    expect(await ride("Jimmy", 36, 15, "Scrambler")).toEqual([
      "You're about to ride the Scrambler!",
      '  Sorry Jimmy, you need to be 48" tall to ride the Scrambler!',
    ]);
    expect(await ride("Mary", 52, 1, "Ferris Wheel")).toEqual([
      "You're about to ride the Ferris Wheel!",
      "  Sorry Mary, you need 5 tickets to ride the Ferris Wheel!",
    ]);
    expect(await ride("Alice", 56, 15, "Scrambler")).toEqual(["You're about to ride the Scrambler!", "  Welcome aboard the Scrambler!"]);
    expect(await ride("Bob", 61, 6, "Zero Gravity")).toEqual([
      "You're about to ride the Zero Gravity!",
      "  Welcome aboard the Zero Gravity!",
      "  Btw, this ride goes upside down. Hold on tight!",
    ]);
    const game = (name: string, ticket_count: number, game_name: string) => call("play_game", { name, ticket_count, game_name });
    expect(await game("Jimmy", 15, "I Got It!")).toEqual([
      "You're about to play I Got It!!",
      "  Let's see what you got!",
      "  You get 12 attempts and the prize is a goldfish!",
    ]);
    expect(await game("Mary", 1, "Ring Toss")).toEqual(["You're about to play Ring Toss!", "  Sorry Mary, you need 3 tickets to play Ring Toss!"]);
    const food = (name: string, ticket_count: number, food_stand_name: string) => call("eat_food", { name, ticket_count, food_stand_name });
    expect(await food("Jimmy", 15, "Taco Shack")).toEqual(["Welcome to Taco Shack! What can I get you?", "  Enjoy your taco!"]);
    expect(await food("Mary", 1, "Larry's Pizza")).toEqual(["Welcome to Larry's Pizza! What can I get you?", "  Sorry Mary, our pizza is 3 tickets!"]);
    expect(await food("Bob", 6, "Dough Boy's")).toEqual(["Welcome to Dough Boy's! What can I get you?", "  Enjoy your fried dough!"]);
    // An attraction that is not on the lists fails.
    expect(
      customError(
        await send(d.svm, payer, [
          ix(d, "go_on_ride", { name: "Zed", height: 70, ticket_count: 9, ride_name: "Loop" }, [{ address: payer.address, signer: payer, writable: true }]),
        ]),
      ),
    ).toBe(6000);
  });
});
