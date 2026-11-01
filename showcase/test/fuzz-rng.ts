// The fuzzers' random source (showcase/test/fuzz-jito.test.ts, fuzz-marginfi.test.ts): xorshift64* from a seed, so
// a run is reproduced by its seed.
export class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = (seed ^ 0x6a09e667f3bcc909n) & 0xffff_ffff_ffff_ffffn || 1n;
  }
  next(): bigint {
    let x = this.s;
    x ^= x >> 12n;
    x ^= (x << 25n) & 0xffff_ffff_ffff_ffffn;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & 0xffff_ffff_ffff_ffffn;
  }
  int(n: number): number {
    return Number(this.next() % BigInt(n));
  }
  chance(percent: number): boolean {
    return this.int(100) < percent;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }
  /** Lamport amounts across scales: dust, ordinary tips, large, and the occasional extreme. */
  lamports(): bigint {
    switch (this.int(8)) {
      case 0:
        return this.next() % 10n;
      case 1:
        return this.next() % 1_000_000n;
      case 2:
        return this.next() % 1_000_000_000_000n;
      case 3:
        return this.next() % 50_000_000_000_000_000n;
      default:
        return this.next() % 100_000_000_000n;
    }
  }
  bytes(n: number): Uint8Array {
    return Uint8Array.from({ length: n }, () => this.int(256));
  }
}
