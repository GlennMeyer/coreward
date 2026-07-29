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
import { MAX_FLOORS, TUNING, resetTuning, type Tuning } from '../src/sim/data';
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

  // ── Recurring characters (§9.3, §9.4) ──
  /** Roster members who reached each threshold at any point in the season. */
  nemeses: number;
  patrons: number;
  /**
   * §9.4's last paragraph: the same face on BOTH tracks — more profitable and
   * more dangerous at once. If this column is 0 the design's central knot is
   * not actually being tied, whatever the code says.
   */
  dualTrack: number;
  /** Highest Rank any adventurer reached, and total traits learned. */
  maxRank: number;
  traitsLearned: number;
  /** Nemeses and Patrons killed — the payout side of both tracks. */
  nemesesKilled: number;
  patronsKilled: number;

  // ── Formation (§7.2) ──
  /**
   * Raids fought against a coordinated party rather than a queue.
   *
   * The escalation beat only means something if seasons actually reach it, so
   * this is the "does the milestone happen?" column — the same question the
   * rivalry report asks of the Nemesis and Patron tracks. Zero everywhere would
   * mean the second half of the formation axis is decoration.
   */
  partyRaids: number;
  /** Seasons that met a coordinated party at least once. */
  metParty: boolean;

  // ── Excavation (§5.1, §16) ──
  /**
   * How deep the dungeon got, and how deep anyone actually went.
   *
   * These are two different questions and only the second one is about the
   * game. `floorsBuilt` says the dig button was affordable; the reached figures
   * say a party walked down there. A floor that is dug and never reached is
   * decoration the player paid for — the same "implemented vs happens"
   * distinction `partyRaids` draws for formation.
   *
   * Nothing reported depth before this. `depth` in the Thrill table is the
   * §15.3 *component* — a 0–1 ratio of how far down the party got relative to
   * the dungeon — which by construction cannot distinguish a party walking the
   * whole of a two-floor dungeon from one walking the whole of a nine-floor
   * one. It reads as a depth readout and answers a different question.
   */
  floorsBuilt: number;
  /**
   * Per raid, deliberately — not a season maximum. Comparing two season maxima
   * carries almost no information: over a dozen raids somebody nearly always
   * reaches the bottom once, so max-built and max-reached coincide and the pair
   * always reads as equal. The mean says whether the lower floors are on the
   * path of a typical delve or storage the player paid for.
   */
  reachedMean: number;
  reachedMax: number;
  /** Deepest floor dug at any point, in case a breach cost them one later. */
  maxFloorsBuilt: number;
  /**
   * Rooms actually widened, and rooms in total (§16.3, §16.11).
   *
   * The column §16.11 asks for by name: "an AI that never widens a room, or
   * widens rooms at random, will report that this system does nothing." Without
   * this, a flat survival number after adding purchased capacity is
   * uninterpretable — it cannot distinguish "widening does not matter" from
   * "the AI never widened anything".
   */
  widenedRooms: number;
  totalRooms: number;
}

export function runSeason(seed: number, strat: Strategy): SeasonOutcome {
  const s = createSeason(seed, true);
  const rng = new Rng(seed ^ 0xc0ffee);

  let killed = 0, escaped = 0, breaches = 0, mobsLost = 0;
  let partyRaids = 0;
  let reachedMax = 0, reachedSum = 0, maxFloorsBuilt = 1;
  let goldFromSales = 0, goldFromCorpses = 0;
  let retirements = 0;
  let nemesesKilled = 0, patronsKilled = 0;
  // Thrill is already a per-raid mean over survivors, so the season figure is
  // a mean of means — raids weigh equally regardless of party size.
  const thrill = { total: 0, peril: 0, depth: 0, variety: 0, comfort: 0, tedium: 0 };

  while (!s.over) {
    buildPhaseFor(s, strat, rng);
    // After the build phase, before the raid — this is the moment the dungeon
    // is as deep as the strategy chose to make it.
    maxFloorsBuilt = Math.max(maxFloorsBuilt, s.dungeon.floors.length);
    const sim = startRaid(s);

    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') {
        sim.resolveTaunt(rng.chance(strat.tauntRate));
      }
    }

    const r = sim.result;
    if (r.formation === 'party') partyRaids++;
    // Already 1-indexed: raid.ts sets it to `floor + 1` as each floor clears,
    // so it is a count of floors gone through, not an index. No adjustment.
    reachedMax = Math.max(reachedMax, r.deepestFloorReached);
    reachedSum += r.deepestFloorReached;
    killed += r.killed;
    escaped += r.escaped;
    mobsLost += r.mobsLost.length;
    goldFromSales += r.goldFromSales;
    goldFromCorpses += r.goldFromCorpses;
    retirements += r.retired.length;
    for (const rival of r.rivals) {
      if (!rival.survived && rival.wasNemesis) nemesesKilled++;
      if (!rival.survived && rival.wasPatron) patronsKilled++;
    }
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
    // Counted off the end-of-season roster, so the dead are included: a Nemesis
    // you killed still happened.
    nemeses: s.veterans.filter((v) => (v.escapes ?? 0) >= TUNING.nemesisEscapes).length,
    patrons: s.veterans.filter((v) => (v.bigSpends ?? 0) >= TUNING.patronSpends).length,
    dualTrack: s.veterans.filter(
      (v) => (v.escapes ?? 0) >= TUNING.nemesisEscapes
        && (v.bigSpends ?? 0) >= TUNING.patronSpends,
    ).length,
    maxRank: s.veterans.reduce((m, v) => Math.max(m, v.escapes ?? 0), 0),
    traitsLearned: s.veterans.reduce((m, v) => m + (v.traits?.length ?? 0), 0),
    nemesesKilled,
    patronsKilled,
    partyRaids,
    metParty: partyRaids > 0,
    floorsBuilt: s.dungeon.floors.length,
    widenedRooms: s.dungeon.floors.reduce(
      (n, f) => n + f.rooms.filter((r) => r.capacityTier === 'widened').length, 0,
    ),
    totalRooms: s.dungeon.floors.reduce((n, f) => n + f.rooms.length, 0),
    reachedMean: reachedSum / raids,
    reachedMax,
    maxFloorsBuilt,
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
  avgNemeses: number;
  avgPatrons: number;
  avgDualTrack: number;
  avgMaxRank: number;
  avgTraits: number;
  /** Excavation (§5.1, §16) — see the SeasonOutcome fields for why two depths. */
  avgFloorsBuilt: number;
  avgReachedMean: number;
  avgReachedMax: number;
  /** Share of seasons that dug at all, got past the DIG_COST_TABLE knee, capped. */
  avgWidened: number;
  widenedShare: number;
  dugRate: number;
  deepRate: number;
  capRate: number;
  avgNemesesKilled: number;
  avgPatronsKilled: number;
  avgPartyRaids: number;
  metPartyRate: number;
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
    avgNemeses: mean((r) => r.nemeses),
    avgPatrons: mean((r) => r.patrons),
    avgDualTrack: mean((r) => r.dualTrack),
    avgMaxRank: mean((r) => r.maxRank),
    avgTraits: mean((r) => r.traitsLearned),
    avgFloorsBuilt: mean((r) => r.maxFloorsBuilt),
    avgReachedMean: mean((r) => r.reachedMean),
    avgReachedMax: mean((r) => r.reachedMax),
    avgWidened: mean((r) => r.widenedRooms),
    widenedShare: (() => {
      const w = mean((r) => r.widenedRooms);
      const t = mean((r) => r.totalRooms);
      return t > 0 ? w / t : 0;
    })(),
    dugRate: mean((r) => (r.maxFloorsBuilt > 1 ? 1 : 0)),
    // 4 is where DIG_COST_TABLE turns steep (180 -> 270) and where the rooms
    // table widens to 4 — the first floor that is a real commitment.
    deepRate: mean((r) => (r.maxFloorsBuilt >= 4 ? 1 : 0)),
    capRate: mean((r) => (r.maxFloorsBuilt >= MAX_FLOORS ? 1 : 0)),
    avgNemesesKilled: mean((r) => r.nemesesKilled),
    avgPatronsKilled: mean((r) => r.patronsKilled),
    avgPartyRaids: mean((r) => r.partyRaids),
    metPartyRate: mean((r) => (r.metParty ? 1 : 0)),
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
    'strategy'.padEnd(11), 'raids'.padStart(7), 'tier'.padStart(6),
    'renown'.padStart(8), 'gold'.padStart(7), 'souls'.padStart(7),
    'sales%'.padStart(8), 'killed'.padStart(8), 'escaped'.padStart(8),
    'breach'.padStart(8), 'mobLv'.padStart(7), 'lost'.padStart(6),
    'wipe%'.padStart(7),
  ]);
  for (const [strat, a] of aggs) {
    console.log([
      strat.name.padEnd(11), f1(a.avgRaids).padStart(7),
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

  formationReport(aggs);
  excavationReport(aggs);
  rivalryReport(aggs);
}

/**
 * Formation (§7.2) — does the escalation beat actually land?
 *
 * The Threat Tier table flips from single-file to coordinated parties at Tier
 * 4, and that flip is supposed to be the moment a dungeon finds out whether it
 * was any good. If no strategy ever reaches it the flip is a comment; if every
 * strategy reaches it on raid 2 it is not an escalation, it is the game.
 */
function formationReport(aggs: readonly (readonly [Strategy, Agg])[]): void {
  console.log(`\n─── Formation (§7.2) ───\n`);
  header([
    'strategy'.padEnd(11), 'raids'.padStart(8), 'partyRaids'.padStart(12),
    'party%'.padStart(9), 'seasonsMet'.padStart(12), 'tier'.padStart(7),
  ]);
  for (const [strat, a] of aggs) {
    console.log([
      strat.name.padEnd(11), f1(a.avgRaids).padStart(8),
      f2(a.avgPartyRaids).padStart(12),
      pct(a.avgPartyRaids / Math.max(1, a.avgRaids)).padStart(9),
      pct(a.metPartyRate).padStart(12), f1(a.avgTier).padStart(7),
    ].join(''));
  }
  const met = aggs.reduce((m, [, a]) => Math.max(m, a.metPartyRate), 0);
  if (met <= 0) {
    console.log(
      '\nFAIL: no season ever faced a coordinated party. The formation flip on '
      + 'the tier table is unreachable content — check TIERS and the tier cap.',
    );
  }
}

/**
 * Excavation (§5.1, §16) — how deep does a dungeon actually get?
 *
 * `MAX_FLOORS` is 10 and `DIG_COST_TABLE` prices all ten, but nothing reported
 * whether a season ever uses them. "Keep building deeper" is the stated fantasy
 * (§16), so floors nobody digs are the same unreachable content the formation
 * report was written to catch — and the cap was silently 3 for a long stretch
 * precisely because no column would have shown it.
 *
 * Read `built` against `reached`. Equal means the party walks the whole
 * dungeon and depth is pure Thrill; a gap means the lower floors are storage.
 */
function excavationReport(aggs: readonly (readonly [Strategy, Agg])[]): void {
  console.log(`\n─── Excavation & depth (§5.1, §16) ───\n`);
  header([
    'strategy'.padEnd(11), 'built'.padStart(8), 'reach/raid'.padStart(12),
    'widened'.padStart(9), 'wide%'.padStart(8), 'dug%'.padStart(7),
    'floor4+%'.padStart(10), 'capped%'.padStart(9), 'depth'.padStart(8),
  ]);
  for (const [strat, a] of aggs) {
    console.log([
      strat.name.padEnd(11), f2(a.avgFloorsBuilt).padStart(8),
      f2(a.avgReachedMean).padStart(12), f2(a.avgWidened).padStart(9),
      pct(a.widenedShare).padStart(8), pct(a.dugRate).padStart(7),
      pct(a.deepRate).padStart(10), pct(a.capRate).padStart(9),
      f2(a.avgDepth).padStart(8),
    ].join(''));
  }

  const dug = aggs.reduce((m, [, a]) => Math.max(m, a.dugRate), 0);
  const deep = aggs.reduce((m, [, a]) => Math.max(m, a.deepRate), 0);
  const built = aggs.reduce((m, [, a]) => Math.max(m, a.avgFloorsBuilt), 0);
  if (dug <= 0) {
    console.log(
      '\nFAIL: no season ever dug a second floor. Digging is the only structural '
      + 'decision in the game (§16) and no strategy is taking it — check '
      + 'DIG_COST_TABLE against the mana curve, and the AI\'s digReserve.',
    );
  } else if (deep <= 0) {
    console.log(
      `\nWARN: no season reached floor 4. DIG_COST_TABLE prices ${MAX_FLOORS} floors `
      + `and the deepest built is ${built.toFixed(1)} — floors 4-${MAX_FLOORS} are `
      + 'unreachable content. Either the costs outrun the mana curve or the season '
      + 'ends first; §16 is designing on top of floors nobody sees.',
    );
  } else if (aggs.every(([, a]) => a.capRate <= 0)) {
    console.log(
      `\nNOTE: no season reached the ${MAX_FLOORS}-floor cap — the deepest built is `
      + `${built.toFixed(1)}. DIG_COST_TABLE prices all ${MAX_FLOORS} floors, so the `
      + `bottom half of the table is never spent. Floors ${Math.ceil(built) + 1}-${MAX_FLOORS} `
      + 'are priced content nobody sees: either the cap is aspirational and should say '
      + 'so, or the mana curve has to reach further before §16 builds on top of it.',
    );
  }
}

/**
 * The Nemesis and Patron tracks (§9.3, §9.4) — does the hook actually fire?
 *
 * A recurring character the player never meets twice is a data structure, not
 * a character. These columns are the difference between "implemented" and
 * "happens": how many faces cross each threshold in an 8-raid season, how hard
 * they come back (rank, traits), and — the column that matters most — how
 * often ONE adventurer is on both ladders at once. §9.4's last paragraph calls
 * that the decision the whole game is built around, so if `both` is zero the
 * feature is not doing its job however green the tests are.
 */
function rivalryReport(aggs: readonly (readonly [Strategy, Agg])[]): void {
  console.log(`\n─── Nemesis & Patron tracks (per season) ───\n`);
  header([
    'strategy'.padEnd(11), 'nemeses'.padStart(9), 'patrons'.padStart(9),
    'both'.padStart(7), 'maxRank'.padStart(9), 'traits'.padStart(8),
    'nemKill'.padStart(9), 'patKill'.padStart(9),
  ]);
  for (const [strat, a] of aggs) {
    console.log([
      strat.name.padEnd(11), f2(a.avgNemeses).padStart(9), f2(a.avgPatrons).padStart(9),
      f2(a.avgDualTrack).padStart(7), f2(a.avgMaxRank).padStart(9),
      f1(a.avgTraits).padStart(8), f2(a.avgNemesesKilled).padStart(9),
      f2(a.avgPatronsKilled).padStart(9),
    ].join(''));
  }

  const both = aggs.reduce((m, [, a]) => Math.max(m, a.avgDualTrack), 0);
  if (both <= 0) {
    console.log(
      '\nFAIL: no adventurer was ever on both tracks at once. §9.4\'s central '
      + 'case is excluded — check patronSpendFraction and recurringReturnChance.',
    );
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
    String(key).padEnd(22), 'raids'.padStart(7), 'tier'.padStart(6),
    'renown'.padStart(8), 'thrill'.padStart(8), 'killed'.padStart(8),
    'escaped'.padStart(8), 'breach'.padStart(8), 'gold'.padStart(7),
    'sales%'.padStart(8), 'mobLv'.padStart(7), 'retire/s'.padStart(9),
    'nem/s'.padStart(7), 'pat/s'.padStart(7),
  ]);
  for (const v of values) {
    const a = withTuning({ ...base, [key]: v } as Partial<Tuning>, () =>
      runBatch(STRATEGY_LIST[stratName], n));
    console.log([
      String(v).padEnd(22), f1(a.avgRaids).padStart(7),
      f1(a.avgTier).padStart(6), a.avgRenown.toFixed(0).padStart(8),
      f1(a.avgThrill).padStart(8), f1(a.avgKilled).padStart(8),
      f1(a.avgEscaped).padStart(8), f1(a.avgBreaches).padStart(8),
      a.avgGold.toFixed(0).padStart(7), pct(a.salesShare).padStart(8),
      f1(a.avgMaxMobLevel).padStart(7), f2(a.avgRetirements).padStart(9),
      f2(a.avgNemeses).padStart(7), f2(a.avgPatrons).padStart(7),
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

    // ── Formation: the line (§7.2) ──
    // The room-level withdrawal threshold. It is the knob that decides whether
    // single-file is a queue that backs out hurt or a queue that feeds itself
    // into a grinder — and because every member rotates down to roughly this
    // value on a hard delve, it also sets the ceiling on `peril` (§15.3). At 0
    // there is no line-break at all and single-file is pure attrition.
    sweep('lineBreakHpPct', [0, 0.2, 0.3, 0.4, 0.5], n, 'balanced');
    sweep('lineBreakHpPct', [0, 0.2, 0.3, 0.4, 0.5], n, 'combat');
    // How much of the delve's peril the waiting line banks. 0 is the raw
    // per-head mean, which under single-file measures the formation rather than
    // the danger; 1 says the whole queue tells the point man's story.
    sweep('singleFilePerilShare', [0, 0.35, 0.65, 1.0], n, 'balanced');
    // Disengaging under fire (§7.2). The knob that stops the line-break being a
    // free exit — at 0 nobody ever dies holding a door and every strategy
    // converges on the same delve; too high and withdrawal is a death sentence
    // and nobody ever escapes to tell the tale.
    sweep('linePartingMult', [0, 0.15, 0.3, 0.5, 1.0], n, 'balanced');
    // A skirmisher hits hardest at the person turning their back — the role's
    // single-file expression (§6.2). At 1.0 it has none.
    sweep('skirmisherPartingBonus', [1.0, 1.6, 2.5], n, 'swarm');

    // ── Traps (§5.2) ──
    // The volume dial on the whole roster. Swept against `traps` because that
    // is the build whose survival is a pure function of it, and against
    // `balanced` because the question traps exist to answer — "can an ordinary
    // dungeon get past raid 2?" — is an ordinary dungeon's question.
    sweep('trapPowerScalar', [0.5, 0.7, 1.0, 1.4, 2.0], n, 'balanced');
    sweep('trapPowerScalar', [0.5, 0.7, 1.0, 1.4, 2.0], n, 'traps');
    // The trap economy's only recurring bill, and the knob that decides
    // whether traps are cheap defence or cheap Thrill. Note it barely moves
    // `balanced` (a quarter of its purse) and dominates `traps` (over half).
    sweep('trapRearmScalar', [0.5, 1.0, 1.5, 2.5], n, 'traps');
    sweep('trapCostScalar', [0.7, 1.0, 1.5, 2.0], n, 'traps');
    // Trap variety credit (§15.3). At 0 traps score no `variety` at all; at 3
    // they can max the term with no bestiary, which is §15.1's exploit in a
    // new hat. Watch `renown` rather than `survive` — this knob is Renown, and
    // Renown is the difficulty dial (§4.4), so a higher value shows up as a
    // *lower* survival rate via the ratchet rather than as an easier game.
    sweep('trapVarietyCredit', [0, 1, 2, 3], n, 'traps');
    // Spring (§7.4). The scripted AI never spends a Ley Charge, so this sweep
    // is a floor rather than a measurement — it is here so that changing the
    // multiplier cannot silently change the game once a spending AI exists.
    sweep('springMult', [1.0, 1.5], n, 'traps');

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
    // ── Recurring characters (§9.3, §9.4) ──
    // The Nemesis counter. Swept against wardens because wardens manufactures
    // escapees, so it is the build that breeds the most opposition — which is
    // the point: the §15.1 "let everybody live" optimum arms its own enemies.
    sweep('nemesisEscapes', [2, 3, 4, 5], n, 'wardens');
    sweep('nemesisStatPerRank', [0, 0.08, 0.12, 0.2, 0.3], n, 'wardens');
    // The Patron counter, swept against commerce — the only scripted build that
    // opens enough shops for the track to have any chance of firing at all.
    sweep('patronSpends', [1, 2, 3], n, 'commerce');
    sweep('patronSpendFraction', [0.1, 0.25, 0.4, 0.6], n, 'commerce');
    sweep('patronGoldMult', [1, 2, 3, 4], n, 'commerce');
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
