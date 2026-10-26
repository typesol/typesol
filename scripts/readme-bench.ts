/**
 * Refresh the README numbers from a four-way benchmark run (the benchmarks repository's results.json):
 * the summary chart (assets/readme/benchmarks-{dark,light}.svg) and the table between the bench markers in README.md.
 *
 *   node scripts/readme-bench.ts ../benchmarks/results.json
 *
 * Run it in the same change as anything that moves the numbers, so the README never shows stale figures.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Results {
  generated: string;
  rounds: number;
  programs: Record<string, { cu: Record<string, Record<Impl, number>>; binaryKb: Record<Impl, number> }>;
}
type Impl = "typesol" | "pinocchio" | "native" | "anchor";

const IMPLS: { key: Impl; name: string; column: string }[] = [
  { key: "typesol", name: "TypeSOL", column: "TypeSOL" },
  { key: "pinocchio", name: "Pinocchio", column: "Pinocchio 0.10" },
  { key: "native", name: "Native Rust", column: "Native Rust" },
  { key: "anchor", name: "Anchor", column: "Anchor 1.0.2" },
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/readme-bench.ts <results.json>");
const r = JSON.parse(readFileSync(file, "utf8")) as Results;
const rows = Object.entries(r.programs).flatMap(([program, p]) => Object.entries(p.cu).map(([ix, cu]) => ({ name: `${program}.${ix}`, cu })));
const programs = Object.keys(r.programs);

// Compute units as a share of Anchor's, geometric mean over every instruction; binary size summed over the programs.
const share = (impl: Impl) => Math.exp(rows.reduce((s, row) => s + Math.log(row.cu[impl] / row.cu.anchor), 0) / rows.length) * 100;
const kb = (impl: Impl) => programs.reduce((s, p) => s + r.programs[p]!.binaryKb[impl], 0);
const wins = rows.filter((row) => row.cu.typesol < row.cu.pinocchio).length;
const fmt = (n: number) => n.toLocaleString("en-US");

const THEMES = {
  dark: { fg: "#e6edf3", muted: "#9198a1", track: "#21262d", other: "#6e7681" },
  light: { fg: "#1f2328", muted: "#59636e", track: "#eff2f5", other: "#8c959f" },
};

function svg(theme: keyof typeof THEMES): string {
  const t = THEMES[theme];
  const W = 900;
  const panel = (x: number, title: string, note: string, values: { name: string; v: number; label: string; ours: boolean }[]) => {
    const max = Math.max(...values.map((v) => v.v));
    const bar = 220;
    const out = [`<text x="${x}" y="28" class="title">${title}</text>`, `<text x="${x}" y="48" class="note">${note}</text>`];
    values.forEach((v, i) => {
      const y = 78 + i * 34;
      const w = Math.max(3, (v.v / max) * bar);
      out.push(
        `<text x="${x}" y="${y + 13}" class="${v.ours ? "name ours" : "name"}">${v.name}</text>`,
        `<rect x="${x + 104}" y="${y}" width="${bar}" height="18" rx="4" fill="${t.track}"/>`,
        `<rect x="${x + 104}" y="${y}" width="${w.toFixed(1)}" height="18" rx="4" fill="${v.ours ? "url(#brand)" : t.other}"/>`,
        `<text x="${x + 104 + bar + 12}" y="${y + 13}" class="${v.ours ? "num ours" : "num"}">${v.label}</text>`,
      );
    });
    return out.join("\n  ");
  };
  const cu = IMPLS.map((i) => ({ name: i.name, v: share(i.key), label: `${share(i.key).toFixed(0)}%`, ours: i.key === "typesol" }));
  const size = IMPLS.map((i) => ({ name: i.name, v: kb(i.key), label: `${kb(i.key).toFixed(1)} KB`, ours: i.key === "typesol" }));
  const caption = `${programs.join(", ")} · ${rows.length} instructions · fewer compute units than Pinocchio on ${wins} of ${rows.length}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="250" viewBox="0 0 ${W} 250" role="img" aria-label="TypeSOL benchmark summary: ${caption}">
  <title>TypeSOL benchmark summary</title>
  <defs>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#3178C6"/><stop offset="0.55" stop-color="#9945FF"/><stop offset="1" stop-color="#14F195"/>
    </linearGradient>
    <style>
      text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; fill: ${t.muted}; font-size: 13px; }
      .title { fill: ${t.fg}; font-size: 15px; font-weight: 600; }
      .note { font-size: 12px; }
      .name.ours, .num.ours { fill: ${t.fg}; font-weight: 600; }
      .num { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
      .caption { font-size: 12px; }
    </style>
  </defs>
  ${panel(0, "Compute units", "share of Anchor's, geometric mean · lower is better", cu)}
  ${panel(456, "Binary size", `${programs.map((p) => `${p}.so`).join(" + ")} · smaller is better`, size)}
  <text x="0" y="238" class="caption">${caption}</text>
</svg>
`;
}

function table(): string {
  const head = `| Instruction | ${IMPLS.map((i) => i.column).join(" | ")} |\n| --- |${IMPLS.map(() => " ---: |").join("")}`;
  const body = rows.map((row) => `| ${row.name} | ${IMPLS.map((i) => (i.key === "typesol" ? `**${fmt(row.cu[i.key])}**` : fmt(row.cu[i.key]))).join(" | ")} |`);
  const size = `| binary, ${programs.join(" / ")} | ${IMPLS.map((i) => `${programs.map((p) => r.programs[p]!.binaryKb[i.key].toFixed(1)).join(" / ")} KB`).join(" | ")} |`;
  return [head, ...body, size].join("\n");
}

for (const theme of ["dark", "light"] as const) writeFileSync(path.join(root, `assets/readme/benchmarks-${theme}.svg`), svg(theme));
const readme = path.join(root, "README.md");
const text = readFileSync(readme, "utf8");
const start = "<!-- bench:table -->";
const end = "<!-- /bench:table -->";
const a = text.indexOf(start);
const b = text.indexOf(end);
if (a < 0 || b < a) throw new Error(`README.md needs ${start} … ${end}`);
writeFileSync(readme, text.slice(0, a + start.length) + "\n" + table() + "\n" + text.slice(b));
console.log(`README numbers from ${r.generated}: ${rows.length} instructions, TypeSOL below Pinocchio on ${wins}`);
