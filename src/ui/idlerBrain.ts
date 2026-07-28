/**
 * The idler's brain — shared with `tools/evolve.ts`.
 *
 * The genome and the build policy live here so the CLI search and the in-game
 * idler cannot drift apart: a build the tool says is strong has to be the same
 * build the game plays. Pure and headless like `src/sim` (§13.2) — no DOM, all
 * randomness through the injected seeded Rng.
 */

import {
  AMENITIES, GEAR, MAX_GEAR_SLOTS, MOBS, TRAPS, roomCapacity,
  type UpgradeTrack,
} from '../sim/data';
import {
  assignStaff, buildAmenity, buyMob, buyTrap, buyUpgrade, digCost, digFloor,
  equipGear, livingMobs, nextReforgeCost, nextUpgradeCost, placeMobInRoom,
  placeTrapInRoom,
  rearmTrap, reforgeGear, roomSlotsUsed, totalUpkeep, trapRearmPrice,
} from '../sim/dungeon';
import { Rng } from '../sim/rng';
import { applyAftermath, createSeason, currentTier, startRaid } from '../sim/season';
import { applyProfile, insightFromRun, type Profile } from '../sim/meta';
import type { AmenityId, PriceTier, SeasonState } from '../sim/types';

// ─── Genome ──────────────────────────────────────────────────────────────────

/**
 * A build policy, not a build order. Fixed orders cannot react to losing a
 * monster in raid 2, and every interesting question here is about reacting.
 */
export interface Genome {
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

export function randomGenome(rng: Rng): Genome {
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

export function mutate(g: Genome, rng: Rng, rate: number): Genome {
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

export function crossover(a: Genome, b: Genome, rng: Rng): Genome {
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

export function placeAnywhere(s: SeasonState, slots: number, put: (f: number, r: number) => boolean): boolean {
  const d = s.dungeon;
  for (let f = d.floors.length - 1; f >= 0; f--) {
    for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
      if (roomSlotsUsed(d, f, r) + slots <= roomCapacity(f) && put(f, r)) return true;
    }
  }
  return false;
}

export function buildPhaseFor(s: SeasonState, g: Genome, rng: Rng): void {
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
  // Upgrades are per species now, so iterate the species it fields rather than
  // the individual creatures — buying the same track once per rat used to be
  // several purchases and is now one.
  const species = [...new Set(livingMobs(d)
    .filter((m) => m.placement.kind === 'room')
    .map((m) => m.defId))];
  for (const defId of species) {
    const track = rng.weighted(TRACKS.map((t) => [t, g.trackWeights[t] ?? 0] as const));
    // Ask the game what it costs. This was a hand-copied formula, which is a
    // silent drift waiting to happen: the moment the real curve changes, the
    // idler is buying at a price nobody else pays.
    const price = nextUpgradeCost(d, defId, track) ?? Infinity;
    if (upSpent + price > upBudget || s.mana < price) continue;
    if (buyUpgrade(d, defId, track) === null) {
      s.mana -= Math.round(price);
      upSpent += price;
    }
  }

  // Gold: gear, then reforging it. The late-run sink (§6.5).
  const gearBudget = s.gold * (1 - g.amenityShare);
  let gearSpent = 0;
  for (const mob of livingMobs(d)) {
    if (mob.placement.kind !== 'room') continue;
    for (const gid of Object.keys(GEAR)) {
      if (!mob.gear.includes(gid)) {
        const c = GEAR[gid]!.cost;
        if (mob.gear.length < MAX_GEAR_SLOTS && s.gold >= c && gearSpent + c <= gearBudget) {
          if (equipGear(d, mob.uid, gid) === null) { s.gold -= c; gearSpent += c; }
        }
        continue;
      }
      const c = nextReforgeCost(mob, gid);
      if (s.gold >= c && gearSpent + c <= gearBudget) {
        if (reforgeGear(d, mob.uid, gid) === null) { s.gold -= c; gearSpent += c; }
      }
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


// ─── Scoring, for both the CLI and the idler ─────────────────────────────────

export interface GenomeScore {
  renown: number;
  raids: number;
  tier: number;
  /** Insight the run would bank, so the idler can pay out what it actually earned. */
  insight: number;
}

/**
 * Raids a scored season is allowed to run for.
 *
 * Evaluation used to inherit the game's endless default, so every genome played
 * until its Core fell — up to the 200-raid safety cap. At 16 genomes × 3 seasons
 * that is up to 9,600 raids per generation, every 900ms, which is what made the
 * browser feel like it was leaking: not a retained reference, just relentless
 * allocation the collector could not keep ahead of.
 *
 * A fixed length is also the fairer comparison. Genomes should be ranked on the
 * same amount of game, not on who happened to survive long enough to accrue
 * more of it.
 */
export const EVAL_RAIDS = 14;

export function evaluateGenome(
  g: Genome, seasons: number, seedBase: number, profile?: Profile,
): GenomeScore {
  let renown = 0, raids = 0, tier = 0, insight = 0;
  for (let i = 0; i < seasons; i++) {
    const seed = seedBase + i * 7919;
    const s = createSeason(seed, true);
    s.totalRaids = EVAL_RAIDS;   // bounded: see EVAL_RAIDS
    if (profile) applyProfile(s, profile);
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
    renown += s.renown;
    raids += s.log.length;
    tier += currentTier(s).tier;
    if (profile) insight += insightFromRun(s, profile).total;
  }
  return {
    renown: renown / seasons, raids: raids / seasons,
    tier: tier / seasons, insight: insight / seasons,
  };
}

export function describeGenome(g: Genome): string {
  const top = (m: Record<string, number>, n: number) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k).join(' + ');
  return [
    `monsters ${top(g.mobWeights, 2)}`,
    `traps ${top(g.trapWeights, 2)}`,
    `${Math.round(g.trapShare * 100)}% gold on traps`,
    `${Math.round(g.upgradeShare * 100)}% mana on upgrades`,
    `${g.amenityPick} at ${g.shopPrice}`,
    `gate ${g.admission}`,
    `cover ${g.insurance}`,
    `taunt ${Math.round(g.tauntRate * 100)}%`,
  ].join(' · ');
}
