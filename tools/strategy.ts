/**
 * Scripted Build Phase AI, shared by the balance runner and the tracer.
 *
 * It is not trying to play well — it is trying to play *consistently*, so that
 * differences between batches come from tuning changes rather than from the AI
 * getting lucky.
 */
import {
  AMENITIES, GEAR, HIRED_STAFF_COST, MAX_GEAR_SLOTS, MOBS, roomCapacity,
} from '../src/sim/data';
import {
  assignStaff, buildAmenity, buyMob, digCost, digFloor, equipGear, hireStaff,
  livingMobs, mobsInRoom, placeMobInRoom, roomSlotsUsed, setPrice, totalUpkeep,
} from '../src/sim/dungeon';
import type { Rng } from '../src/sim/rng';
import type { AmenityId, Mob, PriceTier, SeasonState } from '../src/sim/types';

export type StrategyName =
  | 'combat' | 'commerce' | 'balanced' | 'swarm' | 'wardens' | 'showman'
  | 'patron';

export interface Strategy {
  name: StrategyName;
  /** Fraction of mana reserved for amenities rather than monsters. */
  commerceShare: number;
  /** Accept a Taunt offer with this probability. */
  tauntRate: number;
  /** Purchase preference, strongest-affordable first. */
  buyOrder?: string[];
  /**
   * Buy by rotating through `buyOrder` instead of always taking the strongest
   * affordable thing, and place for role spread rather than depth (§15.3).
   *
   * The default AI produces the dungeon §15.4 explicitly calls out as bad —
   * nine near-identical rooms of whatever was strongest that raid. `variety`
   * is the opposite bet: a different role in every room, no empty slots, and
   * amenities for `comfort`.
   */
  showmanship?: boolean;
  /** Price tier to set on every amenity built. Defaults to whatever `buildAmenity` picks. */
  priceTier?: PriceTier;
  /**
   * Open an amenity on every landing rather than stopping at the first one the
   * budget allows, and keep buying shops before monsters.
   */
  shopEverywhere?: boolean;
}

export const STRATEGY_LIST: Record<StrategyName, Strategy> = {
  combat: { name: 'combat', commerceShare: 0, tauntRate: 0.5 },
  commerce: { name: 'commerce', commerceShare: 0.5, tauntRate: 0.1 },
  balanced: { name: 'balanced', commerceShare: 0.25, tauntRate: 0.35 },
  // Cheap bodies only: maximum damage per mana, minimum staying power.
  swarm: { name: 'swarm', commerceShare: 0, tauntRate: 0.5, buyOrder: ['rat', 'slime'] },
  // Kit drain: turn them back rather than killing them.
  wardens: { name: 'wardens', commerceShare: 0, tauntRate: 0.2, buyOrder: ['ooze', 'cutpurse', 'rat'] },
  /**
   * Run a good ride, not a good fortress (§15.2). Tests whether Thrill is
   * actually playable-for: role spread for `variety`, amenities for `comfort`,
   * every room occupied so nothing reads as padding, and a low taunt rate
   * because a party pushed one floor too far dies, and the dead pay nothing.
   *
   * The buy order alternates roles deliberately — bruiser, warden, skirmisher —
   * so consecutive rooms differ even before the placer gets involved.
   */
  showman: {
    name: 'showman', commerceShare: 0.35, tauntRate: 0.1, showmanship: true,
    // One body per role — bruiser, warden, skirmisher — and the *strongest* of
    // each. The original six-mob rotation reached down to Slime and Cutpurse,
    // which bought bodies rather than threat: `variety` saturates at three
    // roles (the prototype bestiary has no more), so the fourth, fifth and
    // sixth entries added no Thrill and cost the mana that peril is made of.
    buyOrder: ['ogre', 'ooze', 'rat'],
  },
  /**
   * Play for Patrons (§9.4) — the build the track is actually written for.
   *
   * It exists because measuring the Patron threshold against the other
   * strategies would have been measuring an artifact. §11 Q8 and §15.7.6 both
   * record that the scripted commerce AI is weak and under-shops: it opens
   * ~1.8 amenities a raid and only 16% of survivors buy anything, which
   * produces ~1.6 heavy-spend events per season across the whole roster.
   * No threshold can concentrate three of those on one face, so tuning
   * `patronSpends` down to compensate would have been tuning to the AI's
   * weakness rather than to the design.
   *
   * So: shops on every landing at `modest` prices (0.9 usage against
   * standard's 0.65) — and, counter-intuitively, *strong* monsters.
   *
   * Measured: a soft dungeon sells nothing. A gentle warden build opened 2.2
   * amenities a raid and got 2.3% of survivors to buy, against the ordinary
   * commerce build's 16.3%, because the Hot Spring only sells to someone under
   * 85% HP and the Provisioner only sells to someone whose pack is empty.
   * **Nobody shops until the dungeon has hurt them.** Which is §7.5's line —
   * sell on the upper landings, drain in the middle — arrived at from the
   * other direction, and the same thing §15 says about Thrill: peril is what
   * the whole economy is downstream of.
   */
  patron: {
    name: 'patron', commerceShare: 0.4, tauntRate: 0.1,
    priceTier: 'modest', shopEverywhere: true,
  },
};

/** Strongest first — the AI always buys the best thing it can afford. */
const DEFAULT_BUY_ORDER = ['ogre', 'ooze', 'skeleton', 'cutpurse', 'slime', 'rat'];

/**
 * Build-order constants for the scripted AI.
 *
 * Mutable for the same reason `TUNING` is (src/sim/data.ts): several of the
 * balance questions in §14/§15 turned out to be "is the AI playing this badly,
 * or is the strategy bad?", and you cannot answer that without sweeping the
 * AI's own numbers. These are *not* game tuning — nothing in src/sim reads
 * them — so they live here rather than in TUNING.
 */
export const AI = {
  /** Mana a showman keeps back for monsters before opening a shop. */
  showmanDefenceReserve: 150,
  /** Mana left over a dig, so a new floor is never opened completely naked. */
  digReserve: 90,
  /**
   * Stop digging past this raid. A floor bought on raid 7 cannot be staffed
   * before the season ends — strictly worse than another monster.
   */
  digUntilRaid: 5,
  /** placeForVariety weights — see the function for what they trade off. */
  placeDepth: 15,
  placeEmpty: 45,
  /**
   * placeAnywhere: fill every room once before stacking any of them.
   *
   * Off, and the measurement is why. It reads like a free win — the same
   * monsters, no empty corridors, less Tedium — and it does raise combat's
   * Renown from 53 to 71. But it also takes combat's season survival from 49%
   * to 20% and its best monster level from 2.1 to 0.7: one Ogre per room loses
   * every room, so nothing survives to level and pillar 3 stops existing.
   * Concentration is not a placement bug, it is what makes a room winnable.
   */
  fillEmptyFirst: false,
};

const AI_DEFAULTS = { ...AI };

export function resetAi(): void {
  Object.assign(AI, AI_DEFAULTS);
}

export function buildPhaseFor(s: SeasonState, strat: Strategy, rng: Rng): void {
  const d = s.dungeon;

  // 1. Dig.
  //
  // The old gate — `mana >= cost + 120` from raid 2 — meant *no strategy ever
  // dug a second floor* in an 8-raid season, because the AI spends down to ~30
  // mana every Build Phase and income is ~85. Every measured dungeon was one
  // floor deep, which made `depth` untestable and the Descent Decision (§7.3)
  // unreachable. A floor costs 60 and pays TUNING.manaPerFloor (+40) every raid
  // thereafter: it repays itself in under two raids, so the right rule is
  // "dig as early as you can still afford to defend it".
  const cost = digCost(d);
  if (cost !== null && s.mana >= cost + AI.digReserve && s.raidNumber <= AI.digUntilRaid) {
    if (digFloor(d) === null) s.mana -= cost;
  }

  // 2. Commerce: one amenity per landing, staffed by a cheap monster.
  if (strat.commerceShare > 0) {
    // A showman budgets by what is left above a defence reserve rather than by
    // a fixed share. A proportional budget of a small purse never clears an
    // amenity's build cost, so `comfort` — the term that is supposed to make
    // commerce pay for itself (§15.4) — would stay at zero all season.
    const budget = strat.showmanship
      ? Math.max(0, s.mana - AI.showmanDefenceReserve)
      : s.mana * strat.commerceShare;
    let spent = 0;
    for (let l = 0; l < d.landings.length; l++) {
      const landing = d.landings[l]!;
      // A patron build fills both slots on a landing; everyone else stops at one.
      const full = strat.shopEverywhere
        ? landing.amenities.every((a) => a !== null)
        : landing.amenities.some((a) => a !== null);
      if (full) continue;
      // Hot Spring shallow, Provisioner deep — not the other way round.
      //
      // The Provisioner only sells when the party is short of Kit
      // (`party.kit >= need` breaks out of the shopping loop), and a party
      // arrives at the first Landing with a full pack. A Provisioner on
      // Landing 0 therefore never makes a single sale: it was costing 82 mana
      // and returning zero gold and zero `comfort` all season. The Hot Spring
      // wants `hp < 85%`, which is true of everyone who has just fought a
      // floor, so it is the amenity that pays on the way in.
      const slot = landing.amenities.findIndex((a) => a === null);
      if (slot < 0) continue;
      // Hot Spring first on every landing: it is the one that sells on the way
      // in. A second slot takes the Provisioner, which only pays once the
      // party's pack is empty.
      const pick: AmenityId = (l === 0 || strat.shopEverywhere) && slot === 0
        ? 'hotspring'
        : 'provisioner';
      const def = AMENITIES[pick];
      if (spent + def.buildCost + MOBS['rat']!.cost > budget) break;
      if (buildAmenity(d, l, slot, pick) !== null) continue;
      spent += def.buildCost;
      s.mana -= def.buildCost;
      if (strat.priceTier) setPrice(d, l, slot, strat.priceTier);

      const staff = buyMob(d, 'rat');
      if (typeof staff !== 'string') {
        s.mana -= MOBS['rat']!.cost;
        spent += MOBS['rat']!.cost;
        assignStaff(d, staff.uid, l, slot);
      }
    }
  }

  // 3. Spend Gold — the only sink, and the whole point of running shops.
  spendGold(s, strat);

  // 4. Re-place survivors that got pulled out by a Retreat intervention.
  const place = (mob: Mob) =>
    (strat.showmanship ? placeForVariety(s, mob) : placeAnywhere(s, mob));
  for (const mob of livingMobs(d)) {
    if (mob.placement.kind === 'unassigned') place(mob);
  }

  // 5. Spend what's left of the mana on monsters.
  const order = strat.buyOrder ?? DEFAULT_BUY_ORDER;
  let cursor = 0;
  let guard = 0;
  while (guard++ < 80) {
    // Keep enough in hand to cover upkeep, or income goes negative.
    const reserve = totalUpkeep(d);
    const budget = s.mana - reserve;
    // A showman rotates the roster so no role dominates; everyone else takes
    // the strongest thing they can afford.
    const defId = strat.showmanship
      ? nextInRotation(order, cursor++, budget)
      : (order.find((id) => MOBS[id]!.cost <= budget) ?? null);
    if (defId === null) break;

    const mob = buyMob(d, defId);
    if (typeof mob === 'string') break;
    if (!place(mob)) {
      d.mobs.pop(); // nowhere to put it; undo
      break;
    }
    s.mana -= MOBS[defId]!.cost;
    if (rng.chance(0.02)) break; // jitter so batches aren't lockstep
  }
}

/**
 * First affordable entry at or after `cursor`, wrapping once. Rotating rather
 * than always-strongest is what keeps a showman's roster mixed — buying the
 * best affordable mob every time converges on one species, which scores
 * `variety` 0.25 and eats the repeated-room Tedium penalty (§15.3).
 */
function nextInRotation(order: string[], cursor: number, budget: number): string | null {
  for (let i = 0; i < order.length; i++) {
    const id = order[(cursor + i) % order.length]!;
    if (MOBS[id]!.cost <= budget) return id;
  }
  return null;
}

/**
 * Deepest-first, so the strongest monsters end up guarding the Core — but in
 * two passes, so no room is left empty while another is stacked three deep.
 *
 * The single-pass version filled the deepest floor's rooms to capacity before
 * touching anything shallower, which on a two-floor dungeon meant Floor 1 was
 * three empty rooms every single raid: 12 Tedium a raid, and three rooms of
 * free walking on the way in. Filling breadth-first first costs nothing — the
 * same monsters are still deepest-first within each pass.
 */
export function placeAnywhere(s: SeasonState, mob: Mob): boolean {
  const d = s.dungeon;
  const slots = MOBS[mob.defId]!.slots;
  const passes = AI.fillEmptyFirst ? [true, false] : [false];
  for (const emptyOnly of passes) {
    for (let f = d.floors.length - 1; f >= 0; f--) {
      for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
        if (roomSlotsUsed(d, f, r) + slots > roomCapacity(f)) continue;
        if (emptyOnly && mobsInRoom(d, f, r).length > 0) continue;
        return placeMobInRoom(d, mob.uid, f, r) === null;
      }
    }
  }
  return false;
}

/**
 * Placement for Thrill — but defence first (§15.3).
 *
 * The original weights had this exactly inverted: an empty room scored +40 and
 * depth scored `f × 3`, so the placer spread one cheap monster into every room
 * it could find and left the Core approach guarded by a Cave Rat. It was
 * trading a Heart for 4 points of Tedium, and it breached on 3 raids out of
 * every season and survived 0% of them.
 *
 * The corrected order is: depth dominates, because a monster that is not
 * between the party and the Core is not doing anything; then role spread,
 * because two rooms of the same thing back to back is 8 Tedium and dead
 * `variety`; and only then filling an empty room, which is worth exactly the
 * 4 Tedium it saves. A showman still runs a varied dungeon — it just stacks
 * that variety from the bottom up instead of smearing it across the map.
 */
export function placeForVariety(s: SeasonState, mob: Mob): boolean {
  const d = s.dungeon;
  const role = MOBS[mob.defId]!.role;
  const slots = MOBS[mob.defId]!.slots;
  const roleOf = (m: Mob) => MOBS[m.defId]!.role;

  let bestFloor = -1, bestRoom = -1, bestScore = -Infinity;
  for (let f = 0; f < d.floors.length; f++) {
    for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
      if (roomSlotsUsed(d, f, r) + slots > roomCapacity(f)) continue;
      const here = mobsInRoom(d, f, r);
      const prev = r > 0 ? mobsInRoom(d, f, r - 1) : [];

      // Depth first: the deepest rooms are the ones that decide the season.
      let score = f * AI.placeDepth;
      // Then spread: never double up a role in a room or against its neighbour.
      if (here.some((m) => roleOf(m) === role)) score -= 30;
      if (prev.length > 0 && prev.every((m) => roleOf(m) === role)) score -= 20;
      // Then padding. Weighted so an empty room *anywhere* outranks stacking a
      // second monster one floor deeper: every room gets something before any
      // room gets seconds, and only then does the dungeon thicken downward.
      if (here.length === 0) score += AI.placeEmpty;

      if (score > bestScore) {
        bestScore = score;
        bestFloor = f;
        bestRoom = r;
      }
    }
  }

  if (bestFloor < 0) return false;
  return placeMobInRoom(d, mob.uid, bestFloor, bestRoom) === null;
}

/**
 * Gold buys hirelings first, then gear. Hirelings come first because they undo
 * the staffing opportunity cost — the monster behind the counter goes back to
 * fighting, which is what makes a commerce build stop bleeding defence.
 */
function spendGold(s: SeasonState, strat: Strategy): void {
  const d = s.dungeon;

  if (strat.commerceShare > 0) {
    for (const landing of d.landings) {
      for (let slot = 0; slot < landing.amenities.length; slot++) {
        const a = landing.amenities[slot];
        if (!a || a.hired || s.gold < HIRED_STAFF_COST) continue;
        const freed = a.staffUid;
        if (hireStaff(d, d.landings.indexOf(landing), slot) !== null) continue;
        s.gold -= HIRED_STAFF_COST;
        // The monster it replaced goes straight back into a room.
        if (freed !== null) {
          const mob = d.mobs.find((m) => m.uid === freed);
          if (mob) placeAnywhere(s, mob);
        }
      }
    }
  }

  // Gear the deepest, most-invested monsters first — they survive to use it.
  const candidates = livingMobs(d)
    .filter((m) => m.placement.kind === 'room' && m.gear.length < MAX_GEAR_SLOTS)
    .sort((a, b) => b.level - a.level);

  for (const mob of candidates) {
    for (const g of ['fangs', 'carapace', 'censer']) {
      if (mob.gear.length >= MAX_GEAR_SLOTS) break;
      if (mob.gear.includes(g)) continue;
      const cost = GEAR[g]!.cost;
      if (s.gold < cost) continue;
      if (equipGear(d, mob.uid, g) === null) s.gold -= cost;
    }
  }
}
