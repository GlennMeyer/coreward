/**
 * The idler: a genetic search that keeps running between your delves (§32).
 *
 * Two modes, because they answer different needs:
 *
 * - **Advisor** evolves builds against your *current* Codex and tells you what
 *   it found. It never plays. Zero risk of competing with you.
 * - **Auto-play** additionally banks Insight from the runs it plays, at a
 *   deliberately reduced rate — see `IDLE_YIELD`.
 *
 * The population persists, so the search genuinely gets smarter across
 * sessions rather than restarting cold every time the tab opens.
 *
 * Runs in chunks on a timer rather than a Worker: a season resolves in about a
 * millisecond, so a handful of generations per tick is imperceptible, and it
 * keeps the whole thing dependency-free and debuggable.
 */
import { AMENITIES, GEAR, MOBS, TIERS, TRAPS, TUNING } from '../sim/data';
import { Rng } from '../sim/rng';
import { applyProfile, type Profile } from '../sim/meta';
import { createSeason, startRaid, applyAftermath, currentTier } from '../sim/season';
import {
  buildPhaseFor, evaluateGenome, randomGenome, mutate, crossover, describeGenome,
  type Genome,
} from './idlerBrain';

/**
 * Share of a run's Insight that idle play banks.
 *
 * The load-bearing number. If idling out-earns playing, the optimal strategy
 * becomes "leave the tab open" and the game deletes itself. A third means a
 * session of idling is worth having and never worth choosing over a delve.
 */
export const IDLE_YIELD = 0.3;

/**
 * Insight idle play may bank per real minute.
 *
 * The first attempt awarded `insight × IDLE_YIELD` **per generation**, and
 * generations run about once a second — roughly 20 Insight/second against a
 * whole manual run being worth ~23. A minute of idling was worth fifty runs.
 * IDLE_YIELD was supposed to stop exactly that and could not, because it scaled
 * the wrong quantity.
 *
 * Rate is now wall-clock. A manual run takes minutes and pays ~23, so ~6/min is
 * parity; a third of that is the intended "worth having, never worth choosing".
 */
export const IDLE_INSIGHT_PER_MIN = 2;

/** Wall-clock mark for the accrual above. */
let lastAccrual = Date.now();

export type IdlerMode = 'off' | 'advisor' | 'autoplay';

export interface IdlerState {
  mode: IdlerMode;
  /**
   * Fingerprint of the ruleset the population was evolved against.
   *
   * A genome is only meaningful under the numbers it was scored on. Change a
   * trap's cost or the Renown thresholds and every stored build is advice about
   * a game that no longer exists — worse than no advice, because it looks
   * authoritative. When this stops matching, the population is discarded and
   * the search starts again on the current rules.
   */
  rulesHash?: string;
  /** Evolved population, carried across sessions. */
  population: Genome[];
  generation: number;
  /** Best genome seen, and what it scored. */
  best: { genome: Genome; renown: number; raids: number } | null;
  /** Insight banked by auto-play, awaiting collection. */
  pendingInsight: number;
  runsPlayed: number;
}

export function emptyIdler(): IdlerState {
  return {
    mode: 'off', population: [], generation: 0, best: null,
    pendingInsight: 0, runsPlayed: 0, rulesHash: rulesHash(),
  };
}

/**
 * A cheap fingerprint of everything a genome is scored against.
 *
 * Not cryptographic and does not need to be — it only has to change when the
 * balance does.
 */
export function rulesHash(): string {
  const src = JSON.stringify([TUNING, MOBS, TRAPS, AMENITIES, GEAR, TIERS]);
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Throw away a population evolved against different numbers. Returns true if it did. */
export function invalidateIfStale(state: IdlerState): boolean {
  const now = rulesHash();
  if (state.rulesHash === now) return false;
  state.population = [];
  state.generation = 0;
  state.best = null;
  state.rulesHash = now;
  return true;
}

/**
 * Erase everything the idler holds — learning included.
 *
 * Distinct from `wipeIdlerProgress` (§33.2a), which spares the population on
 * purpose. This is the admin's blunt instrument for when the rules have moved
 * far enough that even the search's memory is misleading.
 */
export function nukeIdler(state: IdlerState): void {
  Object.assign(state, emptyIdler());
  stopIdler();
}

/** Forget everything the search has learned and start over. */
export function resetLearning(state: IdlerState): void {
  state.population = [];
  state.generation = 0;
  state.best = null;
  state.rulesHash = rulesHash();
  stopIdler();
}

const POPULATION = 16;
const SEASONS_PER_EVAL = 3;
/** Generations per tick. Small enough that a frame is never noticeably eaten. */
const GENS_PER_TICK = 1;

let timer: number | null = null;

export function stopIdler(): void {
  if (timer !== null) { clearInterval(timer); timer = null; }
}

/**
 * Start (or restart) the background search.
 *
 * `onProgress` fires after each chunk so the caller can persist and repaint;
 * this module owns no storage and no DOM, for the same reason `src/sim` does
 * not (§13.2).
 */
export function resetAccrualClock(): void {
  lastAccrual = Date.now();
}

export function startIdler(
  state: IdlerState,
  profile: Profile,
  onProgress: () => void,
): void {
  stopIdler();
  // Do not pay for time the search was not running — a tab left closed
  // overnight should not cash out on open.
  lastAccrual = Date.now();
  if (state.mode === 'off') return;

  const rng = new Rng(0xA1DE7 ^ state.generation);
  if (state.population.length < POPULATION) {
    while (state.population.length < POPULATION) {
      state.population.push(randomGenome(rng));
    }
  }

  timer = setInterval(() => {
    for (let i = 0; i < GENS_PER_TICK; i++) step(state, profile, rng);
    onProgress();
  }, 900) as unknown as number;
}

function step(state: IdlerState, profile: Profile, rng: Rng): void {
  // Same seeds for every genome in a generation, so selection compares builds
  // rather than luck; seeds rotate per generation so nothing overfits one run.
  const seedBase = 5000 + state.generation * 7919;

  const scored = state.population
    .map((g) => ({ g, f: evaluateGenome(g, SEASONS_PER_EVAL, seedBase, profile) }))
    .sort((a, b) => b.f.renown - a.f.renown);

  const top = scored[0]!;
  if (!state.best || top.f.renown > state.best.renown) {
    state.best = { genome: top.g, renown: top.f.renown, raids: top.f.raids };
  }

  if (state.mode === 'autoplay') {
    // Paid by the clock, not by the generation: how fast the search happens to
    // run must not decide how fast the player gets paid.
    const now = Date.now();
    const minutes = Math.min(5, (now - lastAccrual) / 60_000);
    lastAccrual = now;
    state.pendingInsight += minutes * IDLE_INSIGHT_PER_MIN;
    state.runsPlayed += SEASONS_PER_EVAL * state.population.length;
  }

  const elite = scored.slice(0, Math.max(2, Math.floor(POPULATION * 0.25))).map((x) => x.g);
  const next: Genome[] = [...elite];
  while (next.length < POPULATION) {
    next.push(mutate(crossover(rng.pick(elite), rng.pick(elite), rng), rng, 0.25));
  }
  state.population = next;
  state.generation += 1;
}

/**
 * Strip a wipe's worth of progress while leaving the search intact.
 *
 * The line is learning vs progress: the evolved population, its generation and
 * the best build it has found are the *tool* getting better, and binning hours
 * of search to reset a save file would be the wrong trade. Banked Insight and
 * the run tally are the *player's* progress, and a wipe has to take them —
 * otherwise you can wipe and immediately collect a pile of Insight that the
 * wipe was supposed to have removed.
 */
export function wipeIdlerProgress(state: IdlerState): void {
  state.pendingInsight = 0;
  state.runsPlayed = 0;
  // Switched off, not just emptied. Auto-play left running after a wipe starts
  // banking into the fresh profile immediately, which undoes the wipe a few
  // seconds after you confirmed it. Turning it back on is one click.
  state.mode = 'off';
  stopIdler();
}

/** Collect banked Insight into the profile. Returns how much moved. */
export function collectIdle(state: IdlerState, profile: Profile): number {
  const whole = Math.floor(state.pendingInsight);
  if (whole <= 0) return 0;
  profile.insight += whole;
  state.pendingInsight -= whole;
  return whole;
}

export { describeGenome };

/** One season played by a genome, for the advisor's "try it" preview. */
export function previewRun(g: Genome, profile: Profile, seed: number): {
  raids: number; tier: number; renown: number;
} {
  const s = createSeason(seed, true);
  applyProfile(s, profile);
  const rng = new Rng(seed ^ 0x5eed);
  while (!s.over) {
    buildPhaseFor(s, g, rng);
    const sim = startRaid(s);
    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') sim.resolveTaunt(rng.chance(g.tauntRate));
    }
    applyAftermath(s, sim);
  }
  return { raids: s.log.length, tier: currentTier(s).tier, renown: s.renown };
}
