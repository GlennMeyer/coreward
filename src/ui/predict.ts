/**
 * Build-Phase Thrill estimate — "ride stats before you open" (§15.6 Q3).
 *
 * THIS IS A UI-SIDE APPROXIMATION OF THE SIM'S REAL §15.3 FORMULA, not a second
 * implementation of it, and it lives here rather than under src/sim on purpose
 * (§13.2): it is an affordance for the player, not a game rule. Nothing in the
 * sim reads it and nothing depends on it being right.
 *
 * It will drift from the score a raid actually produces, because it assumes an
 * average party instead of a rolled one and throws away everything stochastic:
 * no RNG, no targeting priorities, no Taunt, no mid-fight Kit drinking, no
 * Provisioner restock, no ambush round, no monsters levelling mid-raid. When the
 * two disagree, the sim is right and this is a hint. Treat the numbers as a
 * shape — "peril is far too low", "those two rooms are identical" — not a
 * forecast.
 *
 * The component weights and Tedium rates are read from TUNING so a balance sweep
 * moves the estimate along with the real thing.
 */
import {
  ADV_ARMOR_PER_LEVEL, ADV_BASE_DMG, ADV_BASE_HP, ADV_KIT_BASE, CLASS_MODS,
  CLASS_WEIGHTS, DESCEND_HP_THRESHOLD, MOBS, PRICE_TIERS, TUNING,
  type TierRow,
} from '../sim/data';
import {
  getMob, isOpen, mobEffectiveDmg, mobEffectiveHp, packMultiplier,
} from '../sim/dungeon';
import type { Dungeon, Mob, ThrillScore } from '../sim/types';

export interface ThrillWarning {
  /** 'bad' is a design problem worth fixing; 'warn' is a cost worth knowing. */
  level: 'bad' | 'warn';
  text: string;
}

export interface ThrillPrediction extends ThrillScore {
  /** Fraction of floors the model thinks they reach before turning back. */
  floorsReached: number;
  /** Rooms with nothing in them on the route down. Pure Tedium (§15.3). */
  emptyRooms: number;
  /** Back-to-back rooms holding the same monsters. Also pure Tedium. */
  repeatedRooms: number;
  /** The model ran the party's HP pool to zero — a wipe pays no Renown at all. */
  lethal: boolean;
  warnings: ThrillWarning[];
}

/**
 * Weighted mean class modifiers, so the estimate tracks CLASS_WEIGHTS rather
 * than hard-coding "an average adventurer". Party generation guarantees a
 * fighter in slot 0, which this ignores — a small, deliberate optimism.
 */
const AVG = (() => {
  let w = 0, hp = 0, dmg = 0;
  for (const [cls, weight] of CLASS_WEIGHTS) {
    w += weight;
    hp += CLASS_MODS[cls].hp * weight;
    dmg += CLASS_MODS[cls].dmg * weight;
  }
  return { hp: hp / w, dmg: dmg / w };
})();

/**
 * Monsters die one at a time under focus fire, so a room's damage output decays
 * across the fight. Half would be the answer if they died at a constant rate;
 * they don't quite, because the party kills the weakest first.
 */
const ATTRITION = 0.55;

/**
 * Predicted party HP fraction at or below which we warn about a likely wipe.
 *
 * Not zero. This walks an *average* party through deterministic attrition while
 * real raids swing by seed, so the useful signal is "cutting it close", not
 * "certain death". Calibrated against the sim on Floor-1 tier-1 setups:
 *
 *   three Ogres      → predicts 0.29 HP left, sim wipes 35% of the time
 *   Ogre+Ooze+Ogre   → predicts 0.53 HP left, sim wipes 14%
 *   three Skeletons  → predicts 0.88 HP left, sim wipes  0%
 *
 * 0.35 separates the first case from the rest. Worth warning about because a
 * wipe pays no Renown at all (§15.3) — over-killing is a real failure mode.
 */
const WIPE_RISK = 0.35;

const RATINGS: readonly (readonly [number, string])[] = [
  [0, 'Dull'],
  [20, 'Tame'],
  [40, 'Decent'],
  [60, 'Thrilling'],
  [TUNING.retireThrill, 'Legendary'],
];

export function thrillRating(total: number): string {
  let label = 'Dull';
  for (const [floor, name] of RATINGS) if (total >= floor) label = name;
  return label;
}

/** Multiset of monster types in a room — the identity Tedium compares (§15.3). */
function roomSignature(d: Dungeon, floor: number, room: number): string {
  const r = d.floors[floor]?.rooms[room];
  if (!r) return '';
  return r.mobUids
    .map((uid) => getMob(d, uid))
    .filter((m): m is Mob => !!m && m.alive)
    .map((m) => m.defId)
    .sort()
    .join('+');
}

function livingMobsInRoom(d: Dungeon, floor: number, room: number): Mob[] {
  const r = d.floors[floor]?.rooms[room];
  if (!r) return [];
  return r.mobUids
    .map((uid) => getMob(d, uid))
    .filter((m): m is Mob => !!m && m.alive);
}

export function predictThrill(d: Dungeon, tier: TierRow): ThrillPrediction {
  const size = tier.partySize;
  const level = (tier.levelMin + tier.levelMax) / 2;

  // One pooled adventurer standing in for the party. Coarse, but peril is a
  // party-level question anyway — the sim's real peril is a mean over members.
  const poolHp = size * (ADV_BASE_HP + TUNING.advHpPerLevel * level) * AVG.hp;
  const poolDps = size * (ADV_BASE_DMG + TUNING.advDmgPerLevel * level) * AVG.dmg;
  const armor = level * ADV_ARMOR_PER_LEVEL;

  let hp = 1;             // fraction of the pool still standing
  let lowest = 1;         // low-water mark → peril (§15.3)
  let kit = (ADV_KIT_BASE + tier.tier) * size;
  let floorsReached = 0;
  let emptyRooms = 0;
  let repeatedRooms = 0;
  let lethal = false;
  let prevSig = '';

  const roles = new Set<string>();
  for (const m of d.mobs) {
    if (m.alive && m.placement.kind === 'room') roles.add(MOBS[m.defId]!.role);
  }

  outer: for (let fi = 0; fi < d.floors.length; fi++) {
    const rooms = d.floors[fi]?.rooms.length ?? 0;
    for (let ri = 0; ri < rooms; ri++) {
      const mobs = livingMobsInRoom(d, fi, ri);
      const sig = roomSignature(d, fi, ri);

      if (mobs.length === 0) {
        emptyRooms++;
        prevSig = '';
        continue;
      }
      if (sig === prevSig) repeatedRooms++;
      prevSig = sig;

      const roomHp = mobs.reduce((s, m) => s + mobEffectiveHp(m), 0);
      // Death spiral: a pooled HP bar hides the fact that a hurt party has
      // actually LOST members, so its damage output falls and every subsequent
      // room takes longer to clear, costing yet more HP. Without this term the
      // estimate is badly optimistic — it read 35% HP remaining on a setup the
      // sim wipes 35% of the time.
      const fighting = Math.max(0.3, Math.min(1, hp * 1.4));
      const ticks = Math.max(1, roomHp / (poolDps * fighting));
      // Terrors spend their turns on Resolve, not HP, so they threaten the
      // retreat decision rather than the peril score.
      const roomDps = mobs.reduce((s, m) => {
        const def = MOBS[m.defId]!;
        if (def.role === 'terror') return s;
        const raw = mobEffectiveDmg(m) * packMultiplier(m, mobs.length);
        return s + Math.max(1, raw - armor) * def.spd;
      }, 0);

      hp -= (roomDps * ticks * ATTRITION) / poolHp;
      lowest = Math.min(lowest, Math.max(0, hp));
      if (hp <= WIPE_RISK) { lethal = true; break outer; }
    }

    floorsReached = fi + 1;

    // Landing: rest, then the Descent Decision (§7.3). Running the party dry is
    // what caps depth on a deep dungeon.
    const spend = Math.min(kit, size);
    kit -= spend;
    hp = Math.min(1, hp + (spend / size) * TUNING.restHealPct);
    if (hp < DESCEND_HP_THRESHOLD) break;
  }

  // comfort = amenities used / available (§15.3). Approximated by coverage:
  // one open shop per landing at its price tier's usage rate. Gouging shows up
  // here as lost Thrill, which is the whole point of §15.4.
  let comfortRaw = 0;
  for (const l of d.landings) {
    for (const a of l.amenities) {
      if (a && isOpen(a)) comfortRaw += PRICE_TIERS[a.price].usage;
    }
  }
  const openAmenities = d.landings
    .flatMap((l) => l.amenities)
    .filter((a) => a && isOpen(a)).length;
  const builtAmenities = d.landings.flatMap((l) => l.amenities).filter(Boolean).length;

  const peril = 1 - lowest;
  const depth = d.floors.length ? floorsReached / d.floors.length : 0;
  const variety = Math.min(1, roles.size / 4);
  const comfort = Math.min(1, comfortRaw / Math.max(1, d.landings.length));
  const tedium = TUNING.tediumPerEmptyRoom * emptyRooms
    + TUNING.tediumPerRepeatedRoom * repeatedRooms;

  const total = Math.max(0, 100 * (
    TUNING.thrillPerilWeight * peril
    + TUNING.thrillDepthWeight * depth
    + TUNING.thrillVarietyWeight * variety
    + TUNING.thrillComfortWeight * comfort
  ) - tedium);

  const warnings: ThrillWarning[] = [];
  const placed = d.mobs.filter((m) => m.alive && m.placement.kind === 'room').length;

  if (placed === 0) {
    warnings.push({ level: 'bad', text: 'Nothing is defending the dungeon. They walk to the Core.' });
  }
  if (lethal) {
    warnings.push({
      level: 'bad',
      text: 'Looks lethal — they probably die here. Dead adventurers carry no story, and a wipe pays no Renown.',
    });
  } else if (peril < 0.25 && placed > 0) {
    warnings.push({
      level: 'bad',
      text: 'They stroll out barely scratched. Peril is where Renown comes from — threaten harder.',
    });
  }
  if (emptyRooms > 0) {
    warnings.push({
      level: 'warn',
      text: `${emptyRooms} empty room${emptyRooms === 1 ? '' : 's'} on the way down — `
        + `−${TUNING.tediumPerEmptyRoom} Thrill each.`,
    });
  }
  if (repeatedRooms > 0) {
    warnings.push({
      level: 'warn',
      text: `${repeatedRooms} room${repeatedRooms === 1 ? '' : 's'} identical to the one before — `
        + `−${TUNING.tediumPerRepeatedRoom} Thrill each. Mix the bestiary up.`,
    });
  }
  if (roles.size < 3 && placed > 0) {
    warnings.push({
      level: 'warn',
      text: `Only ${roles.size} monster role${roles.size === 1 ? '' : 's'} down there. Variety counts four.`,
    });
  }
  if (builtAmenities === 0) {
    warnings.push({ level: 'warn', text: 'No amenities: comfort is zero. A shop is Thrill, not just Gold.' });
  } else if (openAmenities === 0) {
    warnings.push({ level: 'warn', text: 'Every shop is closed — nobody behind the counter, no comfort.' });
  }
  if (depth < 1 && !lethal && placed > 0) {
    warnings.push({
      level: 'warn',
      text: 'They turn back before the Core. Depth is a quarter of the score — ease the upper floors.',
    });
  }

  return {
    total, peril, depth, variety, comfort, tedium,
    floorsReached, emptyRooms, repeatedRooms, lethal, warnings,
  };
}
