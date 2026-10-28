import type { FieldType, ProgramModel, StructDef } from "../model.js";

/**
 * Accounts declared `@layout borsh` are stored as Anchor stores them (Borsh: a String or Vec takes 4 + its length, an
 * empty Option one byte, and the fields after them move). An instruction unpacks such an account into the usual
 * fixed-layout struct on the heap (`ts_unpack_<S>`, checking it as Borsh deserialization would), runs on that, and
 * packs it back when it returns (`ts_pack_<S>`), so every language feature works on it unchanged.
 */

/** A field type whose Borsh bytes are its fixed-layout bytes: scalars, Pubkeys, unit enums, arrays and structs of them. */
export function borshIdentical(t: FieldType, model: Pick<ProgramModel, "structs">): boolean {
  switch (t.kind) {
    case "int":
    case "bool":
    case "pubkey":
    case "enum":
      return true;
    case "array":
      return borshIdentical(t.elem, model);
    case "struct": {
      const s = model.structs.get(t.name);
      return !!s && s.layout !== "borsh" && s.fields.every((f) => borshIdentical(f.type, model));
    }
    default:
      return false;
  }
}

/** Bytes of a Borsh-identical type. */
function fixedBytes(t: FieldType, model: Pick<ProgramModel, "structs">): number {
  switch (t.kind) {
    case "int":
      return Number(t.name.slice(1)) / 8;
    case "bool":
    case "enum":
      return 1;
    case "pubkey":
      return 32;
    case "array":
      return fixedBytes(t.elem, model) * t.len;
    case "struct":
      return model.structs.get(t.name)!.size!;
    default:
      throw new Error(`unreachable: ${t.kind} has no fixed Borsh size`);
  }
}

/** The fewest bytes a Borsh `S` can take (every String and Vec empty, every Option None). */
export function borshMinSize(s: StructDef, model: Pick<ProgramModel, "structs">): number {
  let n = 0;
  for (const f of s.fields) {
    const t = f.type;
    if (t.kind === "fstring" || t.kind === "vec" || t.kind === "string") n += 4;
    else if (t.kind === "option" || t.kind === "dataEnum") n += 1;
    else n += fixedBytes(t, model);
  }
  return n;
}

const DESER = `TS_FAIL(TS_ERR_ACCOUNT_TOO_SMALL, "TypeSOL: bytes are not a valid Borsh value")`;
const SER = `TS_FAIL(TS_ERR_DID_NOT_SERIALIZE, "TypeSOL: account data too small for the value")`;

/** C for `ts_unpack_<S>` and `ts_pack_<S>` of every `@layout borsh` struct. */
export function emitBorshCodecs(model: ProgramModel): string[] {
  const out: string[] = [];
  for (const s of model.structs.values()) {
    if (s.layout !== "borsh" || s.size === undefined) continue;
    let k = 0;
    const tmp = (p: string) => `${p}${k++}`;

    // Bools and enum tags inside a Borsh-identical value: invalid ones fail, as Borsh deserialization does.
    const validate = (t: FieldType, lv: string, pad: string): string[] => {
      switch (t.kind) {
        case "bool":
          return [`${pad}if (${lv} > 1) ${DESER};`];
        case "enum":
          return [`${pad}if (${lv} >= ${model.enums.get(t.name)!.variants.length}) ${DESER};`];
        case "array": {
          const i = tmp("i");
          const inner = validate(t.elem, `${lv}[${i}]`, `${pad}  `);
          return inner.length ? [`${pad}for (uint64_t ${i} = 0; ${i} < ${t.len}; ${i}++) {`, ...inner, `${pad}}`] : [];
        }
        case "struct":
          return model.structs.get(t.name)!.fields.flatMap((f) => validate(f.type, `${lv}.${f.name}`, pad));
        default:
          return [];
      }
    };
    // Bounds: the caller checked `len >= MIN` (the smallest Borsh form). Fixed-size pieces then always fit; only a
    // String / Vec / Option payload is checked, against what is left after the fields that follow it still need.
    const minOf = (t: FieldType) =>
      t.kind === "fstring" || t.kind === "vec" || t.kind === "string" ? 4 : t.kind === "option" || t.kind === "dataEnum" ? 1 : fixedBytes(t, model);
    const minAfter = s.fields.map((_, i) => s.fields.slice(i + 1).reduce((n, f) => n + minOf(f.type), 0));
    const need = (n: string, rest: number, pad: string) => `${pad}if (${n} > len - at - ${rest}) ${DESER};`;
    const room = (n: string, rest: number, pad: string) => `${pad}if (${n} > cap - at - ${rest}) ${SER};`;

    // A String / Vec / Option field, `rest` bytes of later fields still to come.
    const unpackVar = (t: FieldType, lv: string, rest: number, pad: string): string[] => {
      switch (t.kind) {
        case "fstring": {
          const l = tmp("n");
          // Strings were checked as UTF-8 when they came in (arguments) and are only stored whole: not checked again.
          return [
            `${pad}uint32_t ${l} = (uint32_t)ts_read_le(src + at, 4);`,
            `${pad}at += 4;`,
            `${pad}if (${l} > ${t.cap}) ${DESER};`,
            need(l, rest, pad),
            `${pad}${lv}.len = ${l};`,
            `${pad}ts_memcpy(${lv}.bytes, src + at, ${l});`,
            `${pad}at += ${l};`,
          ];
        }
        case "vec": {
          const l = tmp("n");
          const head = [
            `${pad}uint32_t ${l} = (uint32_t)ts_read_le(src + at, 4);`,
            `${pad}at += 4;`,
            `${pad}if (${l} > ${t.cap}) ${DESER};`,
            `${pad}${lv}.len = ${l};`,
          ];
          if (borshIdentical(t.elem, model)) {
            const n = fixedBytes(t.elem, model);
            const i = tmp("i");
            const check = validate(t.elem, `${lv}.items[${i}]`, `${pad}  `);
            return [
              ...head,
              need(`(uint64_t)${l} * ${n}`, rest, pad),
              `${pad}ts_memcpy(${lv}.items, src + at, (uint64_t)${l} * ${n});`,
              `${pad}at += (uint64_t)${l} * ${n};`,
              ...(check.length ? [`${pad}for (uint64_t ${i} = 0; ${i} < ${l}; ${i}++) {`, ...check, `${pad}}`] : []),
            ];
          }
          // Strings: each element's length prefix is checked as it is reached.
          const i = tmp("i");
          return [
            ...head,
            `${pad}for (uint64_t ${i} = 0; ${i} < ${l}; ${i}++) {`,
            need("4", rest, `${pad}  `),
            ...unpackVar(t.elem, `${lv}.items[${i}]`, rest, `${pad}  `),
            `${pad}}`,
          ];
        }
        case "option": {
          const tag = tmp("tag");
          const n = fixedBytes(t.inner as FieldType, model);
          return [
            `${pad}uint8_t ${tag} = src[at++];`,
            `${pad}if (${tag} > 1) ${DESER};`,
            `${pad}${lv}.some = ${tag};`,
            `${pad}if (${tag}) {`,
            need(String(n), rest, `${pad}  `),
            `${pad}  ts_memcpy(&${lv}.v, src + at, ${n});`,
            `${pad}  at += ${n};`,
            ...validate(t.inner as FieldType, `${lv}.v`, `${pad}  `),
            `${pad}}`,
          ];
        }
        case "string": {
          // A view of the bytes it was read from (arguments only), checked as UTF-8 as Borsh String deserialization does.
          const l = tmp("n");
          return [
            `${pad}uint32_t ${l} = (uint32_t)ts_read_le(src + at, 4);`,
            `${pad}at += 4;`,
            need(l, rest, pad),
            `${pad}if (!ts_utf8_valid(src + at, ${l})) ${DESER};`,
            `${pad}${lv} = ts_str(src + at, ${l});`,
            `${pad}at += ${l};`,
          ];
        }
        case "dataEnum": {
          const e = model.dataEnums.get(t.name)!;
          const tag = tmp("tag");
          const lines = [
            `${pad}uint8_t ${tag} = src[at++];`,
            `${pad}if (${tag} >= ${e.variants.length}) ${DESER};`,
            `${pad}${lv}.tag = ${tag};`,
            `${pad}switch (${tag}) {`,
          ];
          e.variants.forEach((v, i) => {
            lines.push(`${pad}case ${i}: {`);
            for (const f of v.fields) {
              const flv = `${lv}.v.${v.name}.${f.name}`;
              if (f.type.kind === "string") {
                lines.push(`${pad}  if (4 > len - at - ${rest}) ${DESER};`, ...unpackVar(f.type, flv, rest, `${pad}  `));
                continue;
              }
              const n = fixedBytes(f.type, model);
              lines.push(
                need(String(n), rest, `${pad}  `),
                `${pad}  ts_memcpy(&${flv}, src + at, ${n});`,
                `${pad}  at += ${n};`,
                ...validate(f.type, flv, `${pad}  `),
              );
            }
            lines.push(`${pad}  break;`, `${pad}}`);
          });
          lines.push(`${pad}}`);
          return lines;
        }
        default:
          throw new Error(`unreachable: ${t.kind} in a Borsh account`);
      }
    };

    const packVar = (t: FieldType, lv: string, rest: number, pad: string): string[] => {
      switch (t.kind) {
        case "fstring": {
          const l = tmp("n");
          return [
            `${pad}uint32_t ${l} = ${lv}.len > ${t.cap} ? ${t.cap} : ${lv}.len;`,
            room(`4 + (uint64_t)${l}`, rest, pad),
            `${pad}ts_write_le(dst + at, ${l}, 4);`,
            `${pad}ts_memcpy(dst + at + 4, ${lv}.bytes, ${l});`,
            `${pad}at += 4 + (uint64_t)${l};`,
          ];
        }
        case "vec": {
          const l = tmp("n");
          if (borshIdentical(t.elem, model)) {
            const n = fixedBytes(t.elem, model);
            return [
              `${pad}uint32_t ${l} = ${lv}.len > ${t.cap} ? ${t.cap} : ${lv}.len;`,
              room(`4 + (uint64_t)${l} * ${n}`, rest, pad),
              `${pad}ts_write_le(dst + at, ${l}, 4);`,
              `${pad}ts_memcpy(dst + at + 4, ${lv}.items, (uint64_t)${l} * ${n});`,
              `${pad}at += 4 + (uint64_t)${l} * ${n};`,
            ];
          }
          const i = tmp("i");
          return [
            `${pad}uint32_t ${l} = ${lv}.len > ${t.cap} ? ${t.cap} : ${lv}.len;`,
            room("4", rest, pad),
            `${pad}ts_write_le(dst + at, ${l}, 4);`,
            `${pad}at += 4;`,
            `${pad}for (uint64_t ${i} = 0; ${i} < ${l}; ${i}++) {`,
            ...packVar(t.elem, `${lv}.items[${i}]`, rest, `${pad}  `),
            `${pad}}`,
          ];
        }
        case "option": {
          const n = fixedBytes(t.inner as FieldType, model);
          return [
            room(`(uint64_t)(${lv}.some ? ${1 + n} : 1)`, rest, pad),
            `${pad}dst[at++] = ${lv}.some ? 1 : 0;`,
            `${pad}if (${lv}.some) {`,
            `${pad}  ts_memcpy(dst + at, &${lv}.v, ${n});`,
            `${pad}  at += ${n};`,
            `${pad}}`,
          ];
        }
        case "string": {
          const l = tmp("n");
          return [
            `${pad}uint32_t ${l} = (uint32_t)${lv}.len;`,
            room(`4 + (uint64_t)${l}`, rest, pad),
            `${pad}ts_write_le(dst + at, ${l}, 4);`,
            `${pad}ts_memcpy(dst + at + 4, ${lv}.ptr, ${l});`,
            `${pad}at += 4 + (uint64_t)${l};`,
          ];
        }
        case "dataEnum": {
          const e = model.dataEnums.get(t.name)!;
          const lines = [room("1", rest, pad), `${pad}dst[at++] = ${lv}.tag;`, `${pad}switch (${lv}.tag) {`];
          e.variants.forEach((v, i) => {
            lines.push(`${pad}case ${i}: {`);
            for (const f of v.fields) {
              const flv = `${lv}.v.${v.name}.${f.name}`;
              if (f.type.kind === "string") {
                lines.push(...packVar(f.type, flv, rest, `${pad}  `));
                continue;
              }
              const n = fixedBytes(f.type, model);
              lines.push(room(String(n), rest, `${pad}  `), `${pad}  ts_memcpy(dst + at, &${flv}, ${n});`, `${pad}  at += ${n};`);
            }
            lines.push(`${pad}  break;`, `${pad}}`);
          });
          lines.push(`${pad}}`);
          return lines;
        }
        default:
          throw new Error(`unreachable: ${t.kind} in a Borsh account`);
      }
    };

    // Runs of Borsh-identical fields are contiguous in both layouts: one copy each.
    const unpackLines: string[] = [];
    const packLines: string[] = [];
    for (let i = 0; i < s.fields.length;) {
      const f = s.fields[i]!;
      if (borshIdentical(f.type, model)) {
        let j = i;
        let bytes = 0;
        while (j < s.fields.length && borshIdentical(s.fields[j]!.type, model)) bytes += fixedBytes(s.fields[j++]!.type, model);
        unpackLines.push(`  ts_memcpy(&out->${f.name}, src + at, ${bytes});`, `  at += ${bytes};`);
        for (const g of s.fields.slice(i, j)) unpackLines.push(...validate(g.type, `out->${g.name}`, "  "));
        // A pack can be short of room only after a String / Vec / Option grew; the start always fits (cap >= MIN).
        packLines.push(
          ...(i > 0 ? [room(String(bytes), minAfter[j - 1]!, "  ")] : []),
          `  ts_memcpy(dst + at, &in->${f.name}, ${bytes});`,
          `  at += ${bytes};`,
        );
        i = j;
        continue;
      }
      unpackLines.push(...unpackVar(f.type, `out->${f.name}`, minAfter[i]!, "  "));
      packLines.push(...packVar(f.type, `in->${f.name}`, minAfter[i]!, "  "));
      i++;
    }
    const min = borshMinSize(s, model);

    out.push(
      `/* ${s.name} as Borsh (Anchor's account layout) <-> its fixed-layout struct. */`,
      `__attribute__((noinline)) static uint64_t ts_unpack_${s.name}(const uint8_t *src, uint64_t len, TSS_${s.name} *out, uint64_t *used) {`,
      `  if (len < ${min}) ${DESER};`,
      `  uint64_t at = 0;`,
      ...unpackLines,
      `  if (used) *used = at;`,
      `  return SUCCESS;`,
      `}`,
      `__attribute__((noinline)) static uint64_t ts_pack_${s.name}(const TSS_${s.name} *in, uint8_t *dst, uint64_t cap, uint64_t *written) {`,
      `  if (cap < ${min}) ${SER};`,
      `  uint64_t at = 0;`,
      ...packLines,
      `  if (written) *written = at;`,
      `  return SUCCESS;`,
      `}`,
      "",
    );
  }
  return out;
}
