/**
 * Seeded PRNG. The sim's ONLY source of randomness.
 *
 * DESIGN RULE (docs/DESIGN.md §13.2): `Math.random()` must never appear anywhere
 * under src/sim. Determinism is what buys us replays, reproducible bug reports,
 * and the headless balance runner. Breaking it breaks all three at once.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    // mulberry32 degenerates on seed 0; nudge it.
    this.s = seed >>> 0 || 0x9e3779b9;
  }

  /** Raw float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Weighted pick. Weights need not sum to 1. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [item, w] of entries) {
      roll -= w;
      if (roll <= 0) return item;
    }
    return entries[entries.length - 1]![0];
  }

  /** Fork a child stream. Lets subsystems draw without perturbing each other. */
  fork(salt: number): Rng {
    return new Rng((this.s ^ Math.imul(salt, 0x85ebca6b)) >>> 0);
  }

  /** Snapshot/restore for save games and replays. */
  getState(): number {
    return this.s;
  }

  setState(s: number): void {
    this.s = s >>> 0;
  }
}
