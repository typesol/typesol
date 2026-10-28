// Data enums and strings inside @layout borsh structs: argument structs as Anchor declares them (an enum carrying a
// String, a String), returned and emitted; and a data enum without strings in a Borsh account.
import { type FixedString, type Init, type Mut, type Signer, type SystemProgram, type u8, type u64, emit, log } from "typesol";

export type Field = { kind: "Name" } | { kind: "Symbol" } | { kind: "Key"; key: string };
export type Shape = { kind: "Dot" } | { kind: "Box"; w: u64; h: u64 };

/** @layout borsh */
export interface UpdateArgs {
  field: Field;
  value: string;
  weight: u8;
}

/** @layout borsh */
export interface Sketch {
  bump: u8;
  title: FixedString<16>;
  shape: Shape;
  count: u64;
}

/** Echoes the update back (as return data) after logging what it would change. */
export function update(args: UpdateArgs): UpdateArgs {
  if (args.field.kind === "Key") log(`key ${args.field.key} = ${args.value}`);
  else if (args.field.kind === "Name") log(`name = ${args.value}`);
  else log(`symbol = ${args.value}`);
  emit<UpdateArgs>({ field: args.field, value: args.value, weight: args.weight + 1n });
  return args;
}

export function draw(owner: Mut<Signer>, sketch: Init<Sketch>, systemProgram: SystemProgram, shape: Shape): void {
  sketch.bump = sketch.create(owner, ["sketch", owner.key]);
  sketch.title = "first";
  sketch.shape = shape;
  sketch.count = 1n;
}
