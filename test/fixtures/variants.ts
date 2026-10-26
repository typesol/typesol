import { type Account, type FixedArray, type FixedString, type i64, type Init, type Mut, type Option, type Pubkey, type Signer, type SystemProgram, type u64, emit, require } from "typesol";

/** Data-carrying enums, Option<struct>, and their storage / argument / event encodings. */
export interface Point {
  x: i64;
  y: i64;
}

export type Action =
  | { kind: "Deposit"; amount: u64 }
  | { kind: "Withdraw"; amount: u64; to: Pubkey }
  | { kind: "Move"; x: i64; y: i64 }
  | { kind: "Pause" };

export type Shape = { kind: "Circle"; center: Point; radius: u64 } | { kind: "Labeled"; at: Point; label: FixedString<8> };

export interface Queue {
  owner: Pubkey;
  last: Action;
  pending: Option<Point>;
  shape: Shape;
  balance: u64;
  paused: boolean;
  history: FixedArray<Action, 4>;
  count: u64;
}

export interface Applied {
  action: Action;
  balance: u64;
}

export function init(owner: Mut<Signer>, q: Init<Queue>, systemProgram: SystemProgram): void {
  q.create(owner, ["queue", owner.key]);
  q.owner = owner.key;
  q.last = { kind: "Pause" };
  q.shape = { kind: "Circle", center: { x: 0n, y: 0n }, radius: 1n };
}

export function submit(owner: Signer, q: Mut<Queue>, action: Action): u64 {
  require(owner.key === q.owner, "owner only");
  switch (action.kind) {
    case "Deposit":
      q.balance += action.amount;
      break;
    case "Withdraw":
      require(!q.paused, "paused");
      require(action.to === owner.key, "withdraw to yourself");
      q.balance -= action.amount;
      break;
    case "Move":
      q.pending = { x: action.x, y: action.y };
      break;
    case "Pause":
      q.paused = true;
      break;
  }
  q.last = action;
  q.history.set(q.count % 4n, action);
  q.count += 1n;
  emit<Applied>({ action, balance: q.balance });
  return q.balance;
}

/** Amount of the last Deposit or Withdraw (same field position in both variants), else 0. */
export function lastAmount(q: Account<Queue>): u64 {
  const last = q.last;
  if (last.kind === "Deposit" || last.kind === "Withdraw") {
    return last.amount;
  }
  return 0n;
}

export function pendingSum(q: Account<Queue>): i64 {
  if (q.pending !== null) {
    return q.pending.x + q.pending.y;
  }
  return -1n;
}

export function clearPending(owner: Signer, q: Mut<Queue>): void {
  require(owner.key === q.owner, "owner only");
  q.pending = null;
}

export function reshape(owner: Signer, q: Mut<Queue>, label: string): u64 {
  require(owner.key === q.owner, "owner only");
  const bonus: Action = { kind: "Deposit", amount: 5n };
  q.history.set(3n, bonus);
  if (q.shape.kind === "Circle") {
    const r = q.shape.radius;
    q.shape = { kind: "Labeled", at: q.shape.center, label };
    return r;
  }
  q.shape.at.x += 1n;
  return 0n;
}
