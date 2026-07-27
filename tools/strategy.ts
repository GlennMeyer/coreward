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
  livingMobs, mobsInRoom, placeMobInRoom, roomSlotsUsed, totalUpkeep,
} from '../src/sim/dungeon';
import type { Rng } from '../src/sim/rng';
import type { AmenityId, Mob, SeasonState } from '../src/sim/types';

export type StrategyName =
  | 'combat' | 'commerce' | 'balanced' | 'swarm' | 'wardens' | 'showman';

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
    buyOrder: ['ogre', 'ooze', 'rat', 'skeleton', 'cutpurse', 'slime'],
  },
};

/** Strongest first — the AI always buys the best thing it can afford. */
const DEFAULT_BUY_ORDER = ['ogre', 'ooze', 'skeleton', 'cutpurse', 'slime', 'rat'];

/** Mana a showman keeps back for monsters before opening a shop — an Ogre plus a screen. */
const SHOWMAN_DEFENCE_RESERVE = 150;

export function buildPhaseFor(s: SeasonState, strat: Strategy, rng: Rng): void {
  const d = s.dungeon;

  // 1. Dig once the existing floors are defended and mana allows.
  const cost = digCost(d);
  // Digging pays for itself: deeper dungeons earn more mana AND buy more time.
  if (cost !== null && s.mana >= cost + 120 && s.raidNumber >= 2) {
    if (digFloor(d) === null) s.mana -= cost;
  }

  // 2. Commerce: one amenity per landing, staffed by a cheap monster.
  if (strat.commerceShare > 0) {
    // A showman budgets by what is left above a defence reserve rather than by
    // a fixed share. A proportional budget of a small purse never clears an
    // amenity's build cost, so `comfort` — the term that is supposed to make
    // commerce pay for itself (§15.4) — would stay at zero all season.
    const budget = strat.showmanship
      ? Math.max(0, s.mana - SHOWMAN_DEFENCE_RESERVE)
      : s.mana * strat.commerceShare;
    let spent = 0;
    for (let l = 0; l < d.landings.length; l++) {
      const landing = d.landings[l]!;
      if (landing.amenities.some((a) => a !== null)) continue;
      const pick: AmenityId = l % 2 === 0 ? 'provisioner' : 'hotspring';
      const def = AMENITIES[pick];
      if (spent + def.buildCost + MOBS['rat']!.cost > budget) break;
      if (buildAmenity(d, l, 0, pick) !== null) continue;
      spent += def.buildCost;
      s.mana -= def.buildCost;

      const staff = buyMob(d, 'rat');
      if (typeof staff !== 'string') {
        s.mana -= MOBS['rat']!.cost;
        spent += MOBS['rat']!.cost;
        assignStaff(d, staff.uid, l, 0);
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

/** Deepest-first, so the strongest monsters end up guarding the Core. */
export function placeAnywhere(s: SeasonState, mob: Mob): boolean {
  const d = s.dungeon;
  for (let f = d.floors.length - 1; f >= 0; f--) {
    for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
      if (roomSlotsUsed(d, f, r) + MOBS[mob.defId]!.slots <= roomCapacity(f)) {
        return placeMobInRoom(d, mob.uid, f, r) === null;
      }
    }
  }
  return false;
}

/**
 * Placement for Thrill instead of for defence (§15.3).
 *
 * Three things score, in order: an empty room is pure Tedium so filling one
 * beats everything; a room that already holds this role, or that follows one,
 * is a "repeated room" and costs 8 Tedium each; and only then does depth
 * matter. Depth is kept as a weak tiebreak rather than dropped — a showman
 * still loses a Heart if nothing guards the Core approach.
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

      let score = here.length === 0 ? 40 : 0;
      if (here.some((m) => roleOf(m) === role)) score -= 25;
      if (prev.length > 0 && prev.every((m) => roleOf(m) === role)) score -= 15;
      score += f * 3;

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
