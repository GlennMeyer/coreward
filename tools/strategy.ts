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
  livingMobs, placeMobInRoom, roomSlotsUsed, totalUpkeep,
} from '../src/sim/dungeon';
import type { Rng } from '../src/sim/rng';
import type { AmenityId, Mob, SeasonState } from '../src/sim/types';

export type StrategyName = 'combat' | 'commerce' | 'balanced' | 'swarm' | 'wardens';

export interface Strategy {
  name: StrategyName;
  /** Fraction of mana reserved for amenities rather than monsters. */
  commerceShare: number;
  /** Accept a Taunt offer with this probability. */
  tauntRate: number;
  /** Purchase preference, strongest-affordable first. */
  buyOrder?: string[];
}

export const STRATEGY_LIST: Record<StrategyName, Strategy> = {
  combat: { name: 'combat', commerceShare: 0, tauntRate: 0.5 },
  commerce: { name: 'commerce', commerceShare: 0.5, tauntRate: 0.1 },
  balanced: { name: 'balanced', commerceShare: 0.25, tauntRate: 0.35 },
  // Cheap bodies only: maximum damage per mana, minimum staying power.
  swarm: { name: 'swarm', commerceShare: 0, tauntRate: 0.5, buyOrder: ['rat', 'slime'] },
  // Kit drain: turn them back rather than killing them.
  wardens: { name: 'wardens', commerceShare: 0, tauntRate: 0.2, buyOrder: ['ooze', 'cutpurse', 'rat'] },
};

/** Strongest first — the AI always buys the best thing it can afford. */
const DEFAULT_BUY_ORDER = ['ogre', 'ooze', 'skeleton', 'cutpurse', 'slime', 'rat'];

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
    const budget = s.mana * strat.commerceShare;
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
  for (const mob of livingMobs(d)) {
    if (mob.placement.kind === 'unassigned') placeAnywhere(s, mob);
  }

  // 5. Spend what's left of the mana on monsters.
  let guard = 0;
  while (guard++ < 80) {
    // Keep enough in hand to cover upkeep, or income goes negative.
    const reserve = totalUpkeep(d);
    const order = strat.buyOrder ?? DEFAULT_BUY_ORDER;
    const affordable = order.filter((id) => MOBS[id]!.cost + reserve <= s.mana);
    if (affordable.length === 0) break;

    const defId = affordable[0]!;
    const mob = buyMob(d, defId);
    if (typeof mob === 'string') break;
    if (!placeAnywhere(s, mob)) {
      d.mobs.pop(); // nowhere to put it; undo
      break;
    }
    s.mana -= MOBS[defId]!.cost;
    if (rng.chance(0.02)) break; // jitter so batches aren't lockstep
  }
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
