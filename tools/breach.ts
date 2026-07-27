/**
 * Breach rate by raid number — the early-game cliff measurement.
 *
 * `tools/balance.ts` reports per-*season* aggregates, which hide *when* a
 * season falls apart. The question that motivated traps (§5.2) was "why can I
 * never build past raid 2?", and that is a per-raid question: if raid 2 breaches
 * ten times as often as raid 1, the opening budget buys a dungeon that holds
 * exactly one party and the progression fantasy never starts.
 *
 *   npx tsx tools/breach.ts            # 750 seasons, balanced
 *   npx tsx tools/breach.ts 400 traps  # 400 seasons, trap-leaning build
 */
import { Rng } from '../src/sim/rng';
import { applyAftermath, createSeason, currentTier, startRaid } from '../src/sim/season';
import { STRATEGY_LIST, buildPhaseFor, type Strategy, type StrategyName } from './strategy';

interface RaidRow {
  played: number;
  breached: number;
  tierSum: number;
}

function measure(strat: Strategy, n: number, maxRaid = 8): {
  rows: RaidRow[];
  overrun: number;
  seasons: number;
} {
  const rows: RaidRow[] = Array.from({ length: maxRaid }, () => ({
    played: 0, breached: 0, tierSum: 0,
  }));
  let overrun = 0;

  for (let i = 0; i < n; i++) {
    const s = createSeason(i);
    const rng = new Rng(i ^ 0xc0ffee);
    while (!s.over) {
      const idx = s.raidNumber - 1;
      buildPhaseFor(s, strat, rng);
      const tier = currentTier(s).tier;
      const sim = startRaid(s);
      while (sim.status !== 'complete') {
        sim.step();
        if (sim.status === 'awaiting-taunt') sim.resolveTaunt(rng.chance(strat.tauntRate));
      }
      if (idx < rows.length) {
        const row = rows[idx]!;
        row.played++;
        row.tierSum += tier;
        if (sim.result.outcome === 'breach') row.breached++;
      }
      applyAftermath(s, sim);
    }
    if (s.ending === 'overrun') overrun++;
  }
  return { rows, overrun, seasons: n };
}

function main(): void {
  const n = Number(process.argv[2] ?? 750);
  const names = (process.argv[3] ?? 'balanced').split(',') as StrategyName[];

  for (const name of names) {
    const strat = STRATEGY_LIST[name];
    if (!strat) {
      console.log(`unknown strategy: ${name}`);
      continue;
    }
    const { rows, overrun, seasons } = measure(strat, n);
    console.log(`\n═══ ${name} — breach rate by raid (${n} seasons) ═══\n`);
    console.log('raid  played  breach%  avgTier');
    rows.forEach((r, i) => {
      if (r.played === 0) return;
      const pctB = ((r.breached / r.played) * 100).toFixed(0);
      const tier = (r.tierSum / r.played).toFixed(1);
      console.log(
        `${String(i + 1).padStart(4)}${String(r.played).padStart(8)}`
        + `${(pctB + '%').padStart(9)}${tier.padStart(9)}`,
      );
    });
    console.log(`${((overrun / seasons) * 100).toFixed(0)}% of seasons end overrun`);
  }
}

main();
