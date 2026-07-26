/**
 * Headless balance runner — the payoff promised by docs/DESIGN.md §13.2.
 *
 * Plays thousands of full seasons with scripted strategies and no renderer,
 * so questions like "is 25% gold-on-kill the right number?" (§11 Q7) are
 * answerable in seconds instead of a month of playtests.
 *
 *   npm run balance            # strategy comparison at current tuning
 *   npm run balance -- sweep   # parameter sweeps
 */
import { TUNING, resetTuning, type Tuning } from '../src/sim/data';
import { Rng } from '../src/sim/rng';
import { applyAftermath, createSeason, currentTier, startRaid } from '../src/sim/season';
import { STRATEGY_LIST, buildPhaseFor, type Strategy } from './strategy';

// ─── Season runner ───────────────────────────────────────────────────────────

export interface SeasonOutcome {
  survived: boolean;
  raidsPlayed: number;
  finalTier: number;
  renown: number;
  gold: number;
  souls: number;
  goldFromSales: number;
  goldFromCorpses: number;
  killed: number;
  escaped: number;
  heartsLeft: number;
  breaches: number;
  maxMobLevel: number;
  mobsLost: number;
}

export function runSeason(seed: number, strat: Strategy): SeasonOutcome {
  const s = createSeason(seed);
  const rng = new Rng(seed ^ 0xc0ffee);

  let killed = 0, escaped = 0, breaches = 0, mobsLost = 0;
  let goldFromSales = 0, goldFromCorpses = 0;

  while (!s.over) {
    buildPhaseFor(s, strat, rng);
    const sim = startRaid(s);

    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') {
        sim.resolveTaunt(rng.chance(strat.tauntRate));
      }
    }

    const r = sim.result;
    killed += r.killed;
    escaped += r.escaped;
    mobsLost += r.mobsLost.length;
    goldFromSales += r.goldFromSales;
    goldFromCorpses += r.goldFromCorpses;
    if (r.outcome === 'breach') breaches++;
    applyAftermath(s, sim);
  }

  const maxMobLevel = s.dungeon.mobs.reduce(
    (max, m) => (m.alive && m.level > max ? m.level : max), 0,
  );

  return {
    survived: s.ending === 'survived',
    raidsPlayed: s.log.length,
    finalTier: currentTier(s).tier,
    renown: s.renown,
    gold: s.gold,
    souls: s.souls,
    goldFromSales,
    goldFromCorpses,
    killed,
    escaped,
    heartsLeft: s.dungeon.hearts,
    breaches,
    maxMobLevel,
    mobsLost,
  };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

interface Agg {
  n: number;
  survivalRate: number;
  avgRaids: number;
  avgTier: number;
  avgRenown: number;
  avgGold: number;
  avgSouls: number;
  salesShare: number;
  avgKilled: number;
  avgEscaped: number;
  avgBreaches: number;
  avgMaxMobLevel: number;
  avgMobsLost: number;
  /** Share of repelled adventurers that were killed rather than turned back. */
  wipeShare: number;
}

function aggregate(runs: SeasonOutcome[]): Agg {
  const n = runs.length;
  const mean = (f: (r: SeasonOutcome) => number) =>
    runs.reduce((s, r) => s + f(r), 0) / n;
  const sales = mean((r) => r.goldFromSales);
  const corpses = mean((r) => r.goldFromCorpses);
  return {
    n,
    survivalRate: mean((r) => (r.survived ? 1 : 0)),
    avgRaids: mean((r) => r.raidsPlayed),
    avgTier: mean((r) => r.finalTier),
    avgRenown: mean((r) => r.renown),
    avgGold: mean((r) => r.gold),
    avgSouls: mean((r) => r.souls),
    salesShare: sales + corpses > 0 ? sales / (sales + corpses) : 0,
    avgKilled: mean((r) => r.killed),
    avgEscaped: mean((r) => r.escaped),
    avgBreaches: mean((r) => r.breaches),
    avgMaxMobLevel: mean((r) => r.maxMobLevel),
    avgMobsLost: mean((r) => r.mobsLost),
    wipeShare: (() => {
      const k = mean((r) => r.killed);
      const e = mean((r) => r.escaped);
      return k + e > 0 ? k / (k + e) : 0;
    })(),
  };
}

function runBatch(strat: Strategy, n: number, seedBase = 0): Agg {
  const runs: SeasonOutcome[] = [];
  for (let i = 0; i < n; i++) runs.push(runSeason(seedBase + i, strat));
  return aggregate(runs);
}

// ─── Reporting ───────────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const f1 = (x: number) => x.toFixed(1);

function header(cols: string[]): void {
  console.log(cols.join(''));
  console.log('─'.repeat(cols.join('').length));
}

function strategyReport(n: number): void {
  console.log(`\n═══ Strategy comparison (${n} seasons each) ═══\n`);
  header([
    'strategy'.padEnd(11), 'survive'.padStart(8), 'tier'.padStart(6),
    'renown'.padStart(8), 'gold'.padStart(7), 'souls'.padStart(7),
    'sales%'.padStart(8), 'killed'.padStart(8), 'escaped'.padStart(8),
    'breach'.padStart(8), 'mobLv'.padStart(7), 'lost'.padStart(6),
    'wipe%'.padStart(7),
  ]);
  for (const strat of Object.values(STRATEGY_LIST)) {
    const a = runBatch(strat, n);
    console.log([
      strat.name.padEnd(11), pct(a.survivalRate).padStart(8),
      f1(a.avgTier).padStart(6), a.avgRenown.toFixed(0).padStart(8),
      a.avgGold.toFixed(0).padStart(7), a.avgSouls.toFixed(0).padStart(7),
      pct(a.salesShare).padStart(8), f1(a.avgKilled).padStart(8),
      f1(a.avgEscaped).padStart(8), f1(a.avgBreaches).padStart(8),
      f1(a.avgMaxMobLevel).padStart(7), f1(a.avgMobsLost).padStart(6),
      pct(a.wipeShare).padStart(7),
    ].join(''));
  }
}

function sweep<K extends keyof Tuning>(
  key: K, values: number[], n: number, stratName: keyof typeof STRATEGY_LIST = 'balanced',
): void {
  console.log(`\n═══ Sweep: ${key} (${n} seasons per value, ${stratName} strategy) ═══\n`);
  header([
    String(key).padEnd(22), 'survive'.padStart(8), 'tier'.padStart(6),
    'renown'.padStart(8), 'killed'.padStart(8), 'escaped'.padStart(8),
    'breach'.padStart(8), 'gold'.padStart(7), 'sales%'.padStart(8),
    'mobLv'.padStart(7),
  ]);
  for (const v of values) {
    resetTuning();
    (TUNING[key] as number) = v;
    const a = runBatch(STRATEGY_LIST[stratName], n);
    console.log([
      String(v).padEnd(22), pct(a.survivalRate).padStart(8),
      f1(a.avgTier).padStart(6), a.avgRenown.toFixed(0).padStart(8),
      f1(a.avgKilled).padStart(8), f1(a.avgEscaped).padStart(8),
      f1(a.avgBreaches).padStart(8), a.avgGold.toFixed(0).padStart(7),
      pct(a.salesShare).padStart(8), f1(a.avgMaxMobLevel).padStart(7),
    ].join(''));
  }
  resetTuning();
}

function main(): void {
  const mode = process.argv[2] ?? 'compare';
  const n = Number(process.argv[3] ?? 300);
  const t0 = Date.now();

  if (mode === 'sweep') {
    sweep('goldRecoveredOnKill', [0, 0.1, 0.25, 0.5, 0.75, 1.0], n, 'commerce');
    sweep('slayChance', [0.1, 0.25, 0.4, 0.6, 1.0], n);
    sweep('advDmgPerLevel', [0.6, 0.8, 1.0, 1.25, 1.5], n);
    sweep('kitHealPct', [0.15, 0.2, 0.25, 0.3], n);
  } else {
    strategyReport(n);
  }

  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
