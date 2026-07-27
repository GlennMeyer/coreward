/**
 * Evolve a dungeon-builder.
 *
 * The scripted strategies in `strategy.ts` encode *my* assumptions about how to
 * play. That makes them useless for the one question worth asking: is there a
 * degenerate build nobody has thought of? A genetic search does not share my
 * assumptions, so when it finds something absurd, the design is wrong rather
 * than the player.
 *
 * This is only possible because the sim is headless and deterministic (§13.2) —
 * a genome is scored by playing whole seasons, and the same genome on the same
 * seeds always scores identically, so selection pressure is real signal instead
 * of noise.
 *
 *   npx tsx tools/evolve.ts [generations] [population] [seasonsPerEval]
 */
import { AMENITIES, MOBS, TRAPS, roomCapacity } from '../src/sim/data';
import {
  assignStaff, buildAmenity, buyMob, buyTrap, buyUpgrade, digCost, digFloor,
  livingMobs, placeMobInRoom, placeTrapInRoom, roomSlotsUsed, totalUpkeep,
  trapRearmPrice, rearmTrap,
} from '../src/sim/dungeon';
import { Rng } from '../src/sim/rng';
import { applyAftermath, createSeason, startRaid } from '../src/sim/season';
import type { UpgradeTrack } from '../src/sim/data';
import type { AmenityId, PriceTier, SeasonState } from '../src/sim/types';

// ─── Genome ──────────────────────────────────────────────────────────────────

/**
 * A build policy, not a build order. Fixed orders cannot react to losing a
 * monster in raid 2, and every interesting question here is about reacting.
 */
interface Genome {
  /** Relative weight for buying each monster. */
  mobWeights: Record<string, number>;
  /** Relative weight for buying each trap. */
  trapWeights: Record<string, number>;
  /** Share of Mana kept back for traps rather than monsters. */
  trapShare: number;
  /** Share of Mana spent upgrading what you have instead of buying more. */
  upgradeShare: number;
  /** Preference between the three upgrade tracks. */
  trackWeights: Record<UpgradeTrack, number>;
  /** Share of Gold spent on amenities. */
  amenityShare: number;
  amenityPick: AmenityId;
  admission: PriceTier;
  insurance: PriceTier | 'off';
  shopPrice: PriceTier;
  /** Mana reserve before digging the next floor. */
  digReserve: number;
  /** Probability of accepting a Taunt offer. */
  tauntRate: number;
  /** Staff a shop with a monster, giving up a fighter for +35% takings. */
  staffShops: boolean;
}

const MOB_IDS = Object.keys(MOBS);
const TRAP_IDS = Object.keys(TRAPS);
const AMENITY_IDS = Object.keys(AMENITIES) as AmenityId[];
const PRICE_TIERS_L: PriceTier[] = ['modest', 'standard', 'premium', 'gouge'];
const TRACKS: UpgradeTrack[] = ['bite', 'hide', 'vigor'];

function randomGenome(rng: Rng): Genome {
  const w = (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, rng.float(0, 1)]));
  return {
    mobWeights: w(MOB_IDS),
    trapWeights: w(TRAP_IDS),
    trapShare: rng.float(0, 0.7),
    upgradeShare: rng.float(0, 0.6),
    trackWeights: {
      bite: rng.float(0, 1), hide: rng.float(0, 1), vigor: rng.float(0, 1),
    },
    amenityShare: rng.float(0, 0.8),
    amenityPick: rng.pick(AMENITY_IDS),
    admission: rng.pick(PRICE_TIERS_L),
    insurance: rng.chance(0.2) ? 'off' : rng.pick(PRICE_TIERS_L),
    shopPrice: rng.pick(PRICE_TIERS_L),
    digReserve: rng.float(0, 250),
    tauntRate: rng.float(0, 1),
    staffShops: rng.chance(0.5),
  };
}

function mutate(g: Genome, rng: Rng, rate: number): Genome {
  const jitter = (v: number, lo: number, hi: number) =>
    rng.chance(rate) ? Math.max(lo, Math.min(hi, v + rng.float(-0.25, 0.25) * (hi - lo))) : v;
  const jitterMap = (m: Record<string, number>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, jitter(v, 0, 1)]));

  return {
    mobWeights: jitterMap(g.mobWeights),
    trapWeights: jitterMap(g.trapWeights),
    trapShare: jitter(g.trapShare, 0, 0.9),
    upgradeShare: jitter(g.upgradeShare, 0, 0.8),
    trackWeights: jitterMap(g.trackWeights) as Record<UpgradeTrack, number>,
    amenityShare: jitter(g.amenityShare, 0, 0.9),
    amenityPick: rng.chance(rate) ? rng.pick(AMENITY_IDS) : g.amenityPick,
    admission: rng.chance(rate) ? rng.pick(PRICE_TIERS_L) : g.admission,
    insurance: rng.chance(rate)
      ? (rng.chance(0.2) ? 'off' : rng.pick(PRICE_TIERS_L))
      : g.insurance,
    shopPrice: rng.chance(rate) ? rng.pick(PRICE_TIERS_L) : g.shopPrice,
    digReserve: jitter(g.digReserve, 0, 400),
    tauntRate: jitter(g.tauntRate, 0, 1),
    staffShops: rng.chance(rate) ? !g.staffShops : g.staffShops,
  };
}

function crossover(a: Genome, b: Genome, rng: Rng): Genome {
  const pick = <T>(x: T, y: T) => (rng.chance(0.5) ? x : y);
  const mix = (m: Record<string, number>, n: Record<string, number>) =>
    Object.fromEntries(Object.keys(m).map((k) => [k, pick(m[k]!, n[k]!)]));
  return {
    mobWeights: mix(a.mobWeights, b.mobWeights),
    trapWeights: mix(a.trapWeights, b.trapWeights),
    trapShare: pick(a.trapShare, b.trapShare),
    upgradeShare: pick(a.upgradeShare, b.upgradeShare),
    trackWeights: mix(a.trackWeights, b.trackWeights) as Record<UpgradeTrack, number>,
    amenityShare: pick(a.amenityShare, b.amenityShare),
    amenityPick: pick(a.amenityPick, b.amenityPick),
    admission: pick(a.admission, b.admission),
    insurance: pick(a.insurance, b.insurance),
    shopPrice: pick(a.shopPrice, b.shopPrice),
    digReserve: pick(a.digReserve, b.digReserve),
    tauntRate: pick(a.tauntRate, b.tauntRate),
    staffShops: pick(a.staffShops, b.staffShops),
  };
}

// ─── Playing a season with a genome ──────────────────────────────────────────

function weightedPick(weights: Record<string, number>, affordable: string[], rng: Rng): string | null {
  const entries = affordable.map((id) => [id, weights[id] ?? 0] as const)
    .filter(([, w]) => w > 0);
  if (entries.length === 0) return affordable.length ? rng.pick(affordable) : null;
  return rng.weighted(entries);
}

function placeAnywhere(s: SeasonState, slots: number, put: (f: number, r: number) => boolean): boolean {
  const d = s.dungeon;
  for (let f = d.floors.length - 1; f >= 0; f--) {
    for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
      if (roomSlotsUsed(d, f, r) + slots <= roomCapacity(f) && put(f, r)) return true;
    }
  }
  return false;
}

function buildPhase(s: SeasonState, g: Genome, rng: Rng): void {
  const d = s.dungeon;
  d.admission = g.admission;
  d.insurance = g.insurance;

  const cost = digCost(d);
  if (cost !== null && s.mana >= cost + g.digReserve) {
    if (digFloor(d) === null) s.mana -= cost;
  }

  // Re-arm spent traps before buying anything new: a spent trap is a hole.
  for (const t of d.traps ?? []) {
    const price = trapRearmPrice(d, t.uid);
    if (price > 0 && s.gold >= price + 20) {
      const paid = rearmTrap(d, t.uid, s.gold);
      if (typeof paid === 'number') s.gold -= paid;
    }
  }

  // Gold: amenities.
  const goldBudget = s.gold * g.amenityShare;
  let goldSpent = 0;
  for (let l = 0; l < d.landings.length; l++) {
    const landing = d.landings[l]!;
    const slot = landing.amenities.findIndex((a) => a === null);
    if (slot === -1) continue;
    const def = AMENITIES[g.amenityPick];
    if (goldSpent + def.buildCost > goldBudget || s.gold < def.buildCost) break;
    if (buildAmenity(d, l, slot, g.amenityPick) !== null) continue;
    s.gold -= def.buildCost;
    goldSpent += def.buildCost;
    landing.amenities[slot]!.price = g.shopPrice;
  }

  // Mana: upgrades on what we already own.
  const upBudget = s.mana * g.upgradeShare;
  let upSpent = 0;
  for (const mob of livingMobs(d)) {
    if (mob.placement.kind !== 'room') continue;
    const track = rng.weighted(TRACKS.map((t) => [t, g.trackWeights[t] ?? 0] as const));
    const price = 18 * (MOBS[mob.defId]!.tier) * 1.6 ** (mob.upgrades?.[track] ?? 0);
    if (upSpent + price > upBudget || s.mana < price) continue;
    if (buyUpgrade(d, mob.uid, track) === null) {
      s.mana -= Math.round(price);
      upSpent += price;
    }
  }

  // Mana: traps, then monsters.
  const trapBudget = s.gold * g.trapShare;
  let trapSpent = 0;
  for (let i = 0; i < 20; i++) {
    const affordable = TRAP_IDS.filter((id) => TRAPS[id]!.cost <= Math.min(s.gold, trapBudget - trapSpent));
    const pickId = weightedPick(g.trapWeights, affordable, rng);
    if (!pickId) break;
    const t = buyTrap(d, pickId);
    if (typeof t === 'string') break;
    if (!placeAnywhere(s, TRAPS[pickId]!.slots, (f, r) => placeTrapInRoom(d, t.uid, f, r) === null)) {
      d.traps!.pop();
      break;
    }
    s.gold -= TRAPS[pickId]!.cost;
    trapSpent += TRAPS[pickId]!.cost;
  }

  for (const mob of livingMobs(d)) {
    if (mob.placement.kind === 'unassigned') {
      placeAnywhere(s, MOBS[mob.defId]!.slots, (f, r) => placeMobInRoom(d, mob.uid, f, r) === null);
    }
  }

  for (let i = 0; i < 30; i++) {
    const reserve = totalUpkeep(d);
    const affordable = MOB_IDS.filter((id) => MOBS[id]!.cost + reserve <= s.mana);
    const pickId = weightedPick(g.mobWeights, affordable, rng);
    if (!pickId) break;
    const m = buyMob(d, pickId);
    if (typeof m === 'string') break;
    if (!placeAnywhere(s, MOBS[pickId]!.slots, (f, r) => placeMobInRoom(d, m.uid, f, r) === null)) {
      d.mobs.pop();
      break;
    }
    s.mana -= MOBS[pickId]!.cost;
  }

  if (g.staffShops) {
    for (let l = 0; l < d.landings.length; l++) {
      for (let slot = 0; slot < d.landings[l]!.amenities.length; slot++) {
        const a = d.landings[l]!.amenities[slot];
        if (!a || a.staffUid !== null) continue;
        const spare = livingMobs(d).find((m) => m.placement.kind === 'room');
        if (spare) assignStaff(d, spare.uid, l, slot);
      }
    }
  }
}

export interface Fitness {
  score: number;
  survival: number;
  renown: number;
  tier: number;
  gold: number;
  bestMobLevel: number;
}

/**
 * Fitness is Renown, not survival.
 *
 * Renown is what the design says the player is chasing (§15), and optimising it
 * is what surfaces exploits — a genome that farms reputation while never being
 * threatened is exactly the §15.1 failure we want a machine to keep hunting.
 * Dying early is punished only through the seasons it cuts short.
 */
function evaluate(g: Genome, seasons: number, seedBase: number): Fitness {
  let renown = 0, survived = 0, tier = 0, gold = 0, bestLv = 0;
  for (let i = 0; i < seasons; i++) {
    const seed = seedBase + i * 7919;
    const s = createSeason(seed);
    const rng = new Rng(seed ^ 0x5eed);
    while (!s.over) {
      buildPhase(s, g, rng);
      const sim = startRaid(s);
      while (sim.status !== 'complete') {
        sim.step();
        if (sim.status === 'awaiting-taunt') sim.resolveTaunt(rng.chance(g.tauntRate));
      }
      applyAftermath(s, sim);
    }
    renown += s.renown;
    gold += s.gold;
    if (s.ending === 'survived') survived++;
    tier += s.log.length;
    bestLv += s.dungeon.mobs.reduce((m, x) => (x.alive && x.level > m ? x.level : m), 0);
  }
  return {
    score: renown / seasons,
    survival: survived / seasons,
    renown: renown / seasons,
    tier: tier / seasons,
    gold: gold / seasons,
    bestMobLevel: bestLv / seasons,
  };
}

// ─── The loop ────────────────────────────────────────────────────────────────

function describe(g: Genome): string {
  const top = (m: Record<string, number>, n: number) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k).join('/');
  return [
    `mobs=${top(g.mobWeights, 2)}`,
    `traps=${top(g.trapWeights, 2)}`,
    `trap%=${(g.trapShare * 100).toFixed(0)}`,
    `upg%=${(g.upgradeShare * 100).toFixed(0)}`,
    `track=${top(g.trackWeights, 1)}`,
    `shop=${g.amenityPick}@${g.shopPrice}`,
    `adm=${g.admission}`,
    `ins=${g.insurance}`,
    `taunt=${(g.tauntRate * 100).toFixed(0)}%`,
    g.staffShops ? 'staffed' : 'unstaffed',
  ].join(' ');
}

function main(): void {
  const generations = Number(process.argv[2] ?? 12);
  const population = Number(process.argv[3] ?? 24);
  const seasons = Number(process.argv[4] ?? 6);
  const rng = new Rng(0xC0FFEE);

  let pop = Array.from({ length: population }, () => randomGenome(rng));
  const t0 = Date.now();

  console.log(`evolving ${population} genomes × ${generations} generations × ${seasons} seasons\n`);
  console.log('gen   best   survive  tier  gold  mobLv   build');
  console.log('─'.repeat(110));

  let best: { g: Genome; f: Fitness } | null = null;

  for (let gen = 0; gen < generations; gen++) {
    // Same seeds for every genome in a generation: selection has to compare
    // builds, not luck. Seeds rotate per generation so nothing overfits one run.
    const seedBase = 1000 + gen * 104729;
    const scored = pop
      .map((g) => ({ g, f: evaluate(g, seasons, seedBase) }))
      .sort((a, b) => b.f.score - a.f.score);

    const top = scored[0]!;
    if (!best || top.f.score > best.f.score) best = top;

    console.log(
      `${String(gen).padStart(3)} ${top.f.score.toFixed(0).padStart(6)} `
      + `${(top.f.survival * 100).toFixed(0).padStart(7)}% `
      + `${top.f.tier.toFixed(1).padStart(5)} ${top.f.gold.toFixed(0).padStart(5)} `
      + `${top.f.bestMobLevel.toFixed(1).padStart(6)}   ${describe(top.g)}`,
    );

    // Elitism + tournament selection.
    const elite = scored.slice(0, Math.max(2, Math.floor(population * 0.2))).map((x) => x.g);
    const next: Genome[] = [...elite];
    while (next.length < population) {
      const a = rng.pick(elite);
      const b = rng.pick(scored.slice(0, Math.floor(population * 0.5))).g;
      next.push(mutate(crossover(a, b, rng), rng, 0.25));
    }
    pop = next;
  }

  console.log('\n═══ fittest build found ═══');
  console.log(describe(best!.g));
  console.log(
    `renown=${best!.f.renown.toFixed(0)} survival=${(best!.f.survival * 100).toFixed(0)}% `
    + `tier=${best!.f.tier.toFixed(1)} gold=${best!.f.gold.toFixed(0)} `
    + `bestMobLevel=${best!.f.bestMobLevel.toFixed(1)}`,
  );
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
