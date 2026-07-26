/**
 * Tuning tables. Every number here traces to docs/DESIGN.md — when you change
 * one, change the doc too, or the doc becomes a lie.
 */
import type { AdventurerClass, AmenityDef, AmenityId, MobDef, PriceTier } from './types';

// ─── Monsters (§6.3, prototype subset of 6) ──────────────────────────────────

export const MOBS: Record<string, MobDef> = {
  rat: {
    id: 'rat', name: 'Cave Rat', tier: 1, role: 'skirmisher',
    hp: 8, dmg: 2, spd: 1.5, slots: 1, cost: 12, upkeep: 1, pack: 0.10,
  },
  slime: {
    id: 'slime', name: 'Slime', tier: 1, role: 'bruiser',
    hp: 22, dmg: 1, spd: 0.5, slots: 1, cost: 15, upkeep: 2, pack: 0.08,
  },
  cutpurse: {
    id: 'cutpurse', name: 'Goblin Cutpurse', tier: 2, role: 'warden',
    hp: 18, dmg: 2, spd: 1.0, slots: 1, cost: 35, upkeep: 3, pack: 0.08,
  },
  skeleton: {
    id: 'skeleton', name: 'Skeleton', tier: 2, role: 'bruiser',
    hp: 34, dmg: 5, spd: 0.75, slots: 2, cost: 40, upkeep: 4,
  },
  ogre: {
    id: 'ogre', name: 'Ogre', tier: 3, role: 'bruiser',
    hp: 90, dmg: 14, spd: 0.5, slots: 3, cost: 85, upkeep: 7,
  },
  ooze: {
    id: 'ooze', name: 'Rust Ooze', tier: 3, role: 'warden',
    hp: 55, dmg: 3, spd: 0.75, slots: 2, cost: 75, upkeep: 6,
  },
};

export const MOB_IDS = Object.keys(MOBS);

/**
 * Sweepable tuning knobs.
 *
 * These live in a mutable object rather than as `const`s specifically so
 * `tools/balance.ts` can vary them across thousands of headless seasons.
 * Anything the balance runner needs to sweep belongs here; everything else
 * stays a plain const below.
 *
 * Mutating this outside the balance runner will desync a replay from its
 * seed — treat it as read-only at runtime.
 */
export const TUNING = {
  /** Mob HP/DMG gain per level, compounding (§6.4). */
  mobLevelScalar: 0.12,
  /** Adventurer stat growth per level (§7.1). */
  advHpPerLevel: 8,
  advDmgPerLevel: 1.0,
  /** §11 open question 7 — the predation/commerce exchange rate. */
  goldRecoveredOnKill: 0.25,
  /** Fraction of max HP restored per Kit spent mid-combat. */
  kitHealPct: 0.25,
  /** Fraction of max HP restored at a Landing, per Kit (§7.3). */
  restHealPct: 0.4,
  /** Opening budget. Must buy a floor 1 that can actually threaten tier 1. */
  startingMana: 300,
  /** Flat mana per raid (§4.1). */
  manaBaseIncome: 55,
  /** Mana per raid per floor dug (§4.1). */
  manaPerFloor: 40,
  /**
   * Chance a downed monster is permanently slain rather than getting back up.
   * At 1.0 no monster ever survives a room it defended, and mob leveling —
   * pillar 3 — becomes unreachable. Breaches slay every downed monster
   * regardless, so this only governs raids you actually turned back.
   */
  slayChance: 0.25,

  // ── Thrill-based Renown (§15). Set `thrillRenown` false for the flat
  //    `6 × escapees` formula, so the two can be measured against each other.
  thrillRenown: true,
  thrillPerilWeight: 0.45,
  thrillDepthWeight: 0.25,
  thrillVarietyWeight: 0.2,
  thrillComfortWeight: 0.1,
  tediumPerEmptyRoom: 4,
  tediumPerRepeatedRoom: 8,
  /** Renown per point of Thrill, per surviving adventurer. */
  renownPerThrill: 0.1,

  // ── Retirement and Legends (§15.5) ──
  retireThrill: 75,
  retireMinDelves: 3,
  /** Renown paid once when an adventurer retires. */
  retireRenownBonus: 25,
  /** Passive Renown per raid, per Legend on the wall. */
  legendRenownTrickle: 2,
  /** Chance a party slot is filled by a returning veteran rather than a fresh roll. */
  veteranReturnChance: 0.35,
};

export type Tuning = typeof TUNING;

const TUNING_DEFAULTS: Tuning = { ...TUNING };

export function resetTuning(): void {
  Object.assign(TUNING, TUNING_DEFAULTS);
}

/** XP thresholds for levels 2..10 (§6.4). */
export const XP_THRESHOLDS = [10, 25, 45, 70, 100, 140, 190, 250, 320];
export const XP_PER_HIT = 1;
export const XP_PER_KILL = 5;
export const MAX_LEVEL = 10;

/** Reconstitute cost in Souls: 20 × level². Deliberately brutal (§6.4). */
export function reconstituteCost(level: number): number {
  return 20 * level * level;
}

export function mobMaxHp(defId: string, level: number): number {
  return Math.round(MOBS[defId]!.hp * (1 + TUNING.mobLevelScalar) ** (level - 1));
}

export function mobDmg(defId: string, level: number): number {
  return MOBS[defId]!.dmg * (1 + TUNING.mobLevelScalar) ** (level - 1);
}

// ─── Dungeon structure (§5.1) ────────────────────────────────────────────────

/** Prototype caps at 3 floors (§12). Index 0 = floor 1, which is free. */
export const DIG_COSTS = [0, 60, 110];
export const MAX_FLOORS = 3;
export const AMENITY_SLOTS_PER_LANDING = 2;
export const STARTING_HEARTS = 3;

/**
 * Rooms per floor, by depth (§5.1). Deeper floors are bigger — this is half of
 * why digging is worth it; the other half is the mana bonus.
 */
export const ROOMS_BY_FLOOR = [3, 3, 4, 4, 5, 5, 6, 6, 7, 7];

export function roomsOnFloor(floorIndex: number): number {
  return ROOMS_BY_FLOOR[floorIndex] ?? ROOMS_BY_FLOOR[ROOMS_BY_FLOOR.length - 1]!;
}

/**
 * Slot capacity per room, growing one slot per floor of depth.
 *
 * Capacity is what makes body size a real decision. An Ogre is 4 slots and
 * fills a Floor-1 room by itself; four Cave Rats fit in the same space for
 * roughly half the mana, with more total damage but far less staying power.
 * Deeper rooms are the only place a big monster AND a screen of chaff fit
 * together.
 */
export const ROOM_CAPACITY_BASE = 4;

export function roomCapacity(floorIndex: number): number {
  return ROOM_CAPACITY_BASE + floorIndex;
}

// ─── Amenities (§8.2, prototype subset of 2) ─────────────────────────────────

export const AMENITIES: Record<AmenityId, AmenityDef> = {
  hotspring: {
    id: 'hotspring', name: 'Hot Spring', buildCost: 90, upkeep: 4, basePrice: 8,
    blurb: 'Restores 30% HP. Undermines burst builds.',
  },
  provisioner: {
    id: 'provisioner', name: 'Provisioner', buildCost: 70, upkeep: 3, basePrice: 6,
    blurb: 'Sells Kit, up to 3. Undermines drain builds.',
  },
};

/** §8.3 — expected gold is near-flat across the first three tiers, by design. */
export const PRICE_TIERS: Record<PriceTier, { mult: number; usage: number; renownMult: number }> = {
  modest: { mult: 1.0, usage: 0.9, renownMult: 1.0 },
  standard: { mult: 1.5, usage: 0.65, renownMult: 0.9 },
  premium: { mult: 2.5, usage: 0.35, renownMult: 0.8 },
  gouge: { mult: 4.0, usage: 0.15, renownMult: 0.5 },
};

// ─── Monster gear (§6.5) — the Gold sink ─────────────────────────────────────

export interface GearDef {
  id: string;
  name: string;
  cost: number;
  hpMult: number;
  dmgMult: number;
  /** Grants Kit-stripping to any monster, not just Wardens. */
  stripsKit: boolean;
}

export const GEAR: Record<string, GearDef> = {
  fangs: {
    id: 'fangs', name: 'Iron Fangs', cost: 60,
    hpMult: 1, dmgMult: 1.15, stripsKit: false,
  },
  carapace: {
    id: 'carapace', name: 'Carapace Plating', cost: 70,
    hpMult: 1.2, dmgMult: 1, stripsKit: false,
  },
  censer: {
    id: 'censer', name: "Warden's Censer", cost: 110,
    hpMult: 1, dmgMult: 1, stripsKit: true,
  },
};

export const MAX_GEAR_SLOTS = 2;

/** Hired NPC shopkeeper (§8.4). Lets a monster go back to fighting. */
export const HIRED_STAFF_COST = 250;

export const HOTSPRING_HEAL_PCT = 0.3;
export const PROVISIONER_MAX_KIT = 3;
/** Commerce level grants +10% revenue each (§8.4). */
export const COMMERCE_REVENUE_PER_LEVEL = 0.1;
export const COMMERCE_XP_PER_SALE = 1;
export const COMMERCE_XP_THRESHOLDS = [3, 8, 16, 28];
export const MAX_COMMERCE_LEVEL = 5;

// ─── Threat tiers (§4.4) ─────────────────────────────────────────────────────

export interface TierRow {
  tier: number;
  renown: number;
  partySize: number;
  levelMin: number;
  levelMax: number;
  gold: number;
  manaBonus: number;
}

/** Prototype runs tiers 1-4 (§12), but the full table is here for the balance runner. */
export const TIERS: TierRow[] = [
  { tier: 1, renown: 0, partySize: 3, levelMin: 1, levelMax: 2, gold: 25, manaBonus: 0 },
  { tier: 2, renown: 30, partySize: 3, levelMin: 3, levelMax: 4, gold: 45, manaBonus: 5 },
  { tier: 3, renown: 75, partySize: 4, levelMin: 5, levelMax: 6, gold: 65, manaBonus: 12 },
  { tier: 4, renown: 140, partySize: 4, levelMin: 7, levelMax: 8, gold: 85, manaBonus: 20 },
  { tier: 5, renown: 230, partySize: 4, levelMin: 9, levelMax: 11, gold: 105, manaBonus: 30 },
  { tier: 6, renown: 350, partySize: 5, levelMin: 12, levelMax: 14, gold: 125, manaBonus: 42 },
  { tier: 7, renown: 500, partySize: 5, levelMin: 15, levelMax: 17, gold: 145, manaBonus: 56 },
  { tier: 8, renown: 700, partySize: 5, levelMin: 18, levelMax: 21, gold: 165, manaBonus: 72 },
  { tier: 9, renown: 950, partySize: 5, levelMin: 22, levelMax: 25, gold: 185, manaBonus: 90 },
  { tier: 10, renown: 1250, partySize: 5, levelMin: 26, levelMax: 30, gold: 205, manaBonus: 110 },
];

export const MAX_TIER_PROTOTYPE = 4;

export function tierForRenown(renown: number, cap = MAX_TIER_PROTOTYPE): TierRow {
  let row = TIERS[0]!;
  for (const t of TIERS) {
    if (renown >= t.renown && t.tier <= cap) row = t;
  }
  return row;
}

// ─── Economy (§4) ────────────────────────────────────────────────────────────

export const MANA_PER_KILL = 3;
export const SOULS_PER_KILL = 2;
export const SOULS_PER_NAMED = 15;
export const RENOWN_PER_ESCAPEE = 6;
export const RENOWN_PER_KILL = 2;
export const RENOWN_PER_GOLD = 1 / 40;
export const RENOWN_WIPE_MULT = 0.5;

export function soulsTierMult(tier: number): number {
  return 1 + 0.3 * (tier - 1);
}

// ─── Adventurers (§7.1, §9) ──────────────────────────────────────────────────

export interface ClassMod {
  hp: number;
  dmg: number;
  greed: number;
  /** Kit-spend aggression: fraction of max HP below which they drink. */
  healThreshold: number;
}

export const CLASS_MODS: Record<AdventurerClass, ClassMod> = {
  fighter: { hp: 1.3, dmg: 1.1, greed: 0.0, healThreshold: 0.3 },
  rogue: { hp: 0.9, dmg: 1.2, greed: 0.05, healThreshold: 0.3 },
  cleric: { hp: 1.1, dmg: 0.9, greed: -0.02, healThreshold: 0.5 },
  mage: { hp: 0.75, dmg: 1.4, greed: 0.02, healThreshold: 0.35 },
  ranger: { hp: 1.0, dmg: 1.15, greed: 0.03, healThreshold: 0.3 },
};

export const CLASS_WEIGHTS: (readonly [AdventurerClass, number])[] = [
  ['fighter', 3],
  ['rogue', 2],
  ['cleric', 2],
  ['mage', 2],
  ['ranger', 2],
];

export const ADV_BASE_HP = 20;
export const ADV_BASE_DMG = 3;
export const ADV_ARMOR_PER_LEVEL = 1 / 3;
export const ADV_MAX_RESOLVE = 20;
export const ADV_KIT_BASE = 2;
/** Resolve lost by every survivor when an ally dies. */
export const RESOLVE_ON_ALLY_DEATH = 6;

// ─── Rest & descent (§7.3) ───────────────────────────────────────────────────

export const REST_RESOLVE_PCT = 0.25;
export const DESCEND_HP_THRESHOLD = 0.35;
export const DESCEND_KIT_PER_MEMBER = 0.5;
export const DESCEND_RESOLVE_THRESHOLD = 0.3;

// ─── Interventions (§7.4) ────────────────────────────────────────────────────

export const LEY_CHARGES = 3;

// ─── Named adventurers (§9.2, prototype has one) ─────────────────────────────

export interface NamedDef {
  id: string;
  name: string;
  trait: string;
  minTier: number;
  appearChance: number;
  statMult: number;
}

export const NAMED: Record<string, NamedDef> = {
  berrick: {
    id: 'berrick',
    name: 'Berrick the Unfed',
    trait: 'Ignores Kit thresholds when deciding to descend.',
    minTier: 3,
    appearChance: 0.35,
    statMult: 1.25,
  },
};

// ─── Flavor name pools ───────────────────────────────────────────────────────

export const FIRST_NAMES = [
  'Aldric', 'Bess', 'Corvin', 'Dala', 'Emrik', 'Fenn', 'Gretta', 'Hobb',
  'Ilsa', 'Joram', 'Kesta', 'Lune', 'Merek', 'Nyle', 'Orla', 'Pike',
  'Quill', 'Rhun', 'Sable', 'Tam', 'Ulric', 'Vessa', 'Wren', 'Yorick',
];

export const EPITHETS = [
  'the Bold', 'of Ashfen', 'Quickhand', 'the Lesser', 'Coppertooth',
  'of the Vale', 'Threefingers', 'the Patient', 'Redcloak', 'Farwalker',
];

export const SEASON_RAIDS = 8;
