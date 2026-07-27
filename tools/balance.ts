/**
 * Headless balance runner — the payoff promised by docs/DESIGN.md §13.2.
 *
 * Plays thousands of full seasons with scripted strategies and no renderer,
 * so questions like "is 25% gold-on-kill the right number?" (§11 Q7) are
 * answerable in seconds instead of a month of playtests.
 *
 *   npm run balance                 # strategy comparison at current tuning
 *   npm run balance -- sweep        # parameter sweeps
 *   npm run balance -- headtohead   # Thrill Renown vs the flat formula (§15)
 *   npm run balance -- all          # all three
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
  /** Mean Thrill per raid across the season, and its components (§15.3). */
  thrill: number;
  peril: number;
  depth: number;
  variety: number;
  comfort: number;
  tedium: number;
  /** Adventurers who retired over the season, and the Legends wall at the end (§15.5). */
  retirements: number;
  legends: number;
}

export function runSeason(seed: number, strat: Strategy): SeasonOutcome {
  const s = createSeason(seed);
  const rng = new Rng(seed ^ 0xc0ffee);

  let killed = 0, escaped = 0, breaches = 0, mobsLost = 0;
  let goldFromSales = 0, goldFromCorpses = 0;
  let retirements = 0;
  // Thrill is already a per-raid mean over survivors, so the season figure is
  // a mean of means — raids weigh equally regardless of party size.
  const thrill = { total: 0, peril: 0, depth: 0, variety: 0, comfort: 0, tedium: 0 };

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
    retirements += r.retired.length;
    thrill.total += r.thrill.total;
    thrill.peril += r.thrill.peril;
    thrill.depth += r.thrill.depth;
    thrill.variety += r.thrill.variety;
    thrill.comfort += r.thrill.comfort;
    thrill.tedium += r.thrill.tedium;
    if (r.outcome === 'breach') breaches++;
    applyAftermath(s, sim);
  }

  const raids = Math.max(1, s.log.length);

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
    thrill: thrill.total / raids,
    peril: thrill.peril / raids,
    depth: thrill.depth / raids,
    variety: thrill.variety / raids,
    comfort: thrill.comfort / raids,
    tedium: thrill.tedium / raids,
    retirements,
    legends: s.legends.length,
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
  avgThrill: number;
  avgPeril: number;
  avgDepth: number;
  avgVariety: number;
  avgComfort: number;
  avgTedium: number;
  avgRetirements: number;
  avgLegends: number;
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
    avgThrill: mean((r) => r.thrill),
    avgPeril: mean((r) => r.peril),
    avgDepth: mean((r) => r.depth),
    avgVariety: mean((r) => r.variety),
    avgComfort: mean((r) => r.comfort),
    avgTedium: mean((r) => r.tedium),
    avgRetirements: mean((r) => r.retirements),
    avgLegends: mean((r) => r.legends),
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
const f2 = (x: number) => x.toFixed(2);

function header(cols: string[]): void {
  console.log(cols.join(''));
  console.log('─'.repeat(cols.join('').length));
}

/**
 * Run `fn` with tuning overrides, then restore. Every batch starts from the
 * documented defaults so a sweep can never inherit the previous one's state.
 */
function withTuning<T>(patch: Partial<Tuning>, fn: () => T): T {
  resetTuning();
  Object.assign(TUNING, patch);
  try {
    return fn();
  } finally {
    resetTuning();
  }
}

function strategyReport(n: number): void {
  console.log(`\n═══ Strategy comparison (${n} seasons each) ═══\n`);
  const aggs = Object.values(STRATEGY_LIST).map((s) => [s, runBatch(s, n)] as const);

  header([
    'strategy'.padEnd(11), 'survive'.padStart(8), 'tier'.padStart(6),
    'renown'.padStart(8), 'gold'.padStart(7), 'souls'.padStart(7),
    'sales%'.padStart(8), 'killed'.padStart(8), 'escaped'.padStart(8),
    'breach'.padStart(8), 'mobLv'.padStart(7), 'lost'.padStart(6),
    'wipe%'.padStart(7),
  ]);
  for (const [strat, a] of aggs) {
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

  // Second table rather than 20 columns in the first — the Thrill components
  // only mean anything next to each other (§15.3).
  console.log(`\n─── Thrill breakdown (mean per raid, over survivors) ───\n`);
  header([
    'strategy'.padEnd(11), 'thrill'.padStart(8), 'peril'.padStart(7),
    'depth'.padStart(7), 'variety'.padStart(8), 'comfort'.padStart(8),
    'tedium'.padStart(8), 'renown'.padStart(8), 'retire/s'.padStart(9),
    'legends'.padStart(8),
  ]);
  for (const [strat, a] of aggs) {
    console.log([
      strat.name.padEnd(11), f1(a.avgThrill).padStart(8), f2(a.avgPeril).padStart(7),
      f2(a.avgDepth).padStart(7), f2(a.avgVariety).padStart(8),
      f2(a.avgComfort).padStart(8), f1(a.avgTedium).padStart(8),
      a.avgRenown.toFixed(0).padStart(8), f2(a.avgRetirements).padStart(9),
      f2(a.avgLegends).padStart(8),
    ].join(''));
  }
}

/**
 * The reframe's decisive test (§15.1).
 *
 * Under the flat `6 × escapees` formula the `wardens` build — strips Kit, kills
 * nobody, sends every party home untouched — earns roughly double any other
 * strategy's Renown while being the most boring dungeon it is possible to
 * build. If Thrill scoring is doing its job, wardens should fall to the bottom
 * of the Renown ranking and a peril-heavy build should rise to the top.
 *
 * Renown is not directly comparable across the two formulas (different units,
 * different scale) — what matters is the *ordering* of strategies within each
 * column, which is why both rankings are printed.
 */
function headToHeadReport(n: number): void {
  console.log(`\n═══ Head-to-head: Thrill Renown vs flat 6×escapees (${n} seasons each) ═══\n`);

  const rows = Object.values(STRATEGY_LIST).map((strat) => ({
    strat,
    flat: withTuning({ thrillRenown: false }, () => runBatch(strat, n)),
    thrill: withTuning({ thrillRenown: true }, () => runBatch(strat, n)),
  }));

  header([
    'strategy'.padEnd(11),
    'renownFLAT'.padStart(11), 'rank'.padStart(6),
    'renownTHRL'.padStart(12), 'rank'.padStart(6),
    'thrill'.padStart(8), 'peril'.padStart(7), 'escaped'.padStart(8),
    'survFLAT'.padStart(9), 'survTHRL'.padStart(9),
    'tierFLAT'.padStart(9), 'tierTHRL'.padStart(9),
  ]);

  const rankBy = (pick: (r: typeof rows[number]) => number) => {
    const sorted = [...rows].sort((a, b) => pick(b) - pick(a));
    return (r: typeof rows[number]) => sorted.indexOf(r) + 1;
  };
  const flatRank = rankBy((r) => r.flat.avgRenown);
  const thrillRank = rankBy((r) => r.thrill.avgRenown);

  for (const row of rows) {
    console.log([
      row.strat.name.padEnd(11),
      row.flat.avgRenown.toFixed(0).padStart(11), `#${flatRank(row)}`.padStart(6),
      row.thrill.avgRenown.toFixed(0).padStart(12), `#${thrillRank(row)}`.padStart(6),
      f1(row.thrill.avgThrill).padStart(8), f2(row.thrill.avgPeril).padStart(7),
      f1(row.thrill.avgEscaped).padStart(8),
      pct(row.flat.survivalRate).padStart(9), pct(row.thrill.survivalRate).padStart(9),
      f1(row.flat.avgTier).padStart(9), f1(row.thrill.avgTier).padStart(9),
    ].join(''));
  }

  const wardens = rows.find((r) => r.strat.name === 'wardens');
  if (wardens) {
    console.log(
      `\nwardens — the §15.1 degenerate case — ranks #${flatRank(wardens)} of ${rows.length} `
      + `on the flat formula and #${thrillRank(wardens)} on Thrill.`,
    );
    if (wardens.thrill.avgThrill === 0) {
      console.log(
        'NOTE: all Thrill components are 0 — the §15.3 implementation has not landed yet, '
        + 'so the THRL columns are a floor, not a measurement.',
      );
    } else if (thrillRank(wardens) === 1) {
      // The whole point of §15. If this line ever prints, the loophole is open
      // again and no other number in this file matters.
      const top = [...rows].sort((a, b) => b.thrill.avgRenown - a.thrill.avgRenown)[0]!;
      console.log(
        `FAIL: wardens still tops the Renown table (${top.thrill.avgRenown.toFixed(0)}). `
        + 'A dungeon that threatens nobody is out-earning every dungeon that does — '
        + 'check TUNING.thrillPerilGate and TUNING.thrillDepthFloors.',
      );
    } else {
      const best = [...rows].sort((a, b) => b.thrill.avgRenown - a.thrill.avgRenown)[0]!;
      console.log(
        `Verdict: the reframe demotes the boring optimum — ${best.strat.name} now leads at `
        + `${best.thrill.avgRenown.toFixed(0)} Renown (thrill ${best.thrill.avgThrill.toFixed(1)}) `
        + `against wardens' ${wardens.thrill.avgRenown.toFixed(0)} `
        + `(thrill ${wardens.thrill.avgThrill.toFixed(1)}).`,
      );
    }
  }
}

/**
 * `base` holds other knobs off their defaults for the duration of the sweep —
 * needed when a knob is downstream of one that is currently switched off, and
 * would otherwise sweep a dead branch and print a column of zeros.
 */
function sweep<K extends keyof Tuning>(
  key: K, values: number[], n: number, stratName: keyof typeof STRATEGY_LIST = 'balanced',
  base: Partial<Tuning> = {},
): void {
  const baseNote = Object.entries(base).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(
    `\n═══ Sweep: ${key} (${n} seasons per value, ${stratName} strategy`
    + `${baseNote ? `, with ${baseNote}` : ''}) ═══\n`,
  );
  header([
    String(key).padEnd(22), 'survive'.padStart(8), 'tier'.padStart(6),
    'renown'.padStart(8), 'thrill'.padStart(8), 'killed'.padStart(8),
    'escaped'.padStart(8), 'breach'.padStart(8), 'gold'.padStart(7),
    'sales%'.padStart(8), 'mobLv'.padStart(7), 'retire/s'.padStart(9),
  ]);
  for (const v of values) {
    const a = withTuning({ ...base, [key]: v } as Partial<Tuning>, () =>
      runBatch(STRATEGY_LIST[stratName], n));
    console.log([
      String(v).padEnd(22), pct(a.survivalRate).padStart(8),
      f1(a.avgTier).padStart(6), a.avgRenown.toFixed(0).padStart(8),
      f1(a.avgThrill).padStart(8), f1(a.avgKilled).padStart(8),
      f1(a.avgEscaped).padStart(8), f1(a.avgBreaches).padStart(8),
      a.avgGold.toFixed(0).padStart(7), pct(a.salesShare).padStart(8),
      f1(a.avgMaxMobLevel).padStart(7), f2(a.avgRetirements).padStart(9),
    ].join(''));
  }
}

function main(): void {
  const arg = process.argv[2] ?? 'compare';
  const known = ['compare', 'sweep', 'headtohead', 'h2h', 'all'];
  const mode = known.includes(arg) ? arg : 'compare';
  const n = Number(process.argv[3] ?? 300);
  const t0 = Date.now();
  const all = mode === 'all';

  if (mode === 'sweep' || all) {
    sweep('goldRecoveredOnKill', [0, 0.1, 0.25, 0.5, 0.75, 1.0], n, 'commerce');
    sweep('slayChance', [0.1, 0.25, 0.4, 0.6, 1.0], n);
    sweep('advDmgPerLevel', [0.6, 0.8, 1.0, 1.25, 1.5], n);
    sweep('kitHealPct', [0.15, 0.2, 0.25, 0.3], n);

    // ── Thrill knobs (§15.3, §15.5) ──
    // Peril is the story: swept against showman, the build that deliberately
    // threatens rather than kills, because that is where the weight bites.
    sweep('thrillPerilWeight', [0.2, 0.35, 0.45, 0.6, 0.8], n, 'showman');
    // The Renown exchange rate — how fast the ratchet turns (§15.6 Q1).
    // Set by matching the pre-Thrill baseline: combat should land near Tier 2.1
    // at ~50% season survival (§14.6).
    sweep('renownPerThrill', [0.1, 0.2, 0.3, 0.45, 0.6], n, 'combat');
    // The kiddie-ride gate (§15.1). Swept against wardens because wardens is
    // the build it exists to demote — but note a single-strategy sweep cannot
    // show the *ordering*, which is the actual criterion. Use
    // `npx tsx tools/sweepall.ts thrillPerilGate 0 0.3 0.6 1.0` for that.
    sweep('thrillPerilGate', [0, 0.3, 0.6, 1.0, 1.5], n, 'wardens');
    // Depth reference. At 1 this restores the old completion-ratio behaviour,
    // where a one-floor dungeon scored depth 1.00 and digging paid no Thrill.
    sweep('thrillDepthFloors', [1, 2, 3, 5], n, 'wardens');
    // Retirement threshold: too low and every regular becomes a Legend, too
    // high and the third disposition never fires at all (§15.5). Swept against
    // wardens because retirement needs 3+ delves from the *same* face, and
    // wardens is the only build that both survives the season and sends
    // everyone home to come back.
    sweep('retireThrill', [30, 40, 60, 75, 90], n, 'wardens');
    // No returning faces means no retirement at all — nobody reaches 3 delves.
    // Run with retireThrill at 40, because at the shipped 75 nothing retires in
    // an 8-raid season and the sweep would measure a branch that never runs.
    sweep('veteranReturnChance', [0, 0.2, 0.35, 0.5, 0.8], n, 'wardens', { retireThrill: 40 });
    // Swept against wardens: a drain build parks cheap mobs and leaves gaps,
    // so it is the strategy the empty-room penalty is aimed at (§15.4).
    sweep('tediumPerEmptyRoom', [0, 2, 4, 8, 16], n, 'wardens');
  }
  if (mode === 'headtohead' || mode === 'h2h' || all) {
    headToHeadReport(n);
  }
  if (mode === 'compare' || all) {
    strategyReport(n);
  }

  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Only when run as the entry point — `runSeason` is imported by other tools,
// and a module that runs a 400-season batch on import is a booby trap.
if (process.argv[1]?.endsWith('balance.ts')) main();
