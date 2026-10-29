/**
 * Compute-unit profile of a program built with `--profile`: every statement logs "ts:<file>:<line>" and the
 * remaining compute units first, so the units between two markers belong to the first one (CPIs included).
 * The two "ts:~" markers at the start of each instruction measure the marker's own cost, which is subtracted.
 *
 *   const rows = profileLogs(tx.logs, programId)   // [{ location: "vault.ts:42", calls: 3, units: 1290 }, …]
 */
export interface ProfileRow {
  location: string;
  calls: number;
  units: number;
}

interface Frame {
  program: string;
  budget?: number;
  last?: { location: string; remaining: number };
  pendingMarker?: string;
  calibration: number[];
  overhead: number;
}

export function profileLogs(logs: string[], programId?: string): ProfileRow[] {
  const rows = new Map<string, ProfileRow>();
  const stack: Frame[] = [];
  const add = (location: string, units: number) => {
    const row = rows.get(location) ?? { location, calls: 0, units: 0 };
    row.calls++;
    row.units += Math.max(0, units);
    rows.set(location, row);
  };
  const close = (f: Frame, remaining: number) => {
    if (f.last && f.last.location !== "~") add(f.last.location, f.last.remaining - remaining - f.overhead);
    f.last = undefined;
  };
  for (const line of logs) {
    let m: RegExpExecArray | null;
    if ((m = /^Program (\w+) invoke \[\d+\]$/.exec(line))) {
      stack.push({ program: m[1], calibration: [], overhead: 0 });
      continue;
    }
    const top = stack.at(-1);
    if (!top) continue;
    const mine = !programId || top.program === programId;
    if ((m = /^Program (\w+) consumed (\d+) of (\d+) compute units$/.exec(line)) && m[1] === top.program) {
      // The last statement runs until the instruction ends.
      if (mine) close(top, Number(m[3]) - Number(m[2]));
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (!mine) continue;
    if ((m = /^Program log: ts:(.+)$/.exec(line))) {
      top.pendingMarker = m[1];
      continue;
    }
    if ((m = /^Program consumption: (\d+) units remaining$/.exec(line)) && top.pendingMarker !== undefined) {
      const remaining = Number(m[1]);
      const location = top.pendingMarker;
      top.pendingMarker = undefined;
      if (location === "~") {
        top.calibration.push(remaining);
        if (top.calibration.length === 2) top.overhead = top.calibration[0] - top.calibration[1];
      } else close(top, remaining);
      top.last = { location, remaining };
    }
  }
  return [...rows.values()].sort((a, b) => b.units - a.units);
}

/** A small text table, most expensive first. */
export function formatProfile(rows: ProfileRow[]): string {
  const total = rows.reduce((s, r) => s + r.units, 0) || 1;
  const width = Math.max(8, ...rows.map((r) => r.location.length));
  return [
    `${"location".padEnd(width)}  ${"calls".padStart(6)}  ${"units".padStart(8)}  share`,
    ...rows.map(
      (r) =>
        `${r.location.padEnd(width)}  ${String(r.calls).padStart(6)}  ${String(r.units).padStart(8)}  ${((100 * r.units) / total).toFixed(1).padStart(5)}%`,
    ),
  ].join("\n");
}
