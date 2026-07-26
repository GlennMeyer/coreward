/**
 * Core sim types. Zero engine/DOM imports — see docs/DESIGN.md §13.2.
 */

// ─── Monsters ────────────────────────────────────────────────────────────────

export type MobRole =
  | 'bruiser'
  | 'skirmisher'
  | 'caster'
  | 'warden'
  | 'ambusher'
  | 'terror'
  | 'support';

export interface MobDef {
  id: string;
  name: string;
  tier: number;
  role: MobRole;
  hp: number;
  dmg: number;
  spd: number;
  slots: number;
  cost: number;
  upkeep: number;
  /**
   * Pack Tactics: bonus damage per other living ally in the same room.
   *
   * Without this a swarm is worthless — adventurers focus-fire the weakest
   * target, so an 8 HP rat costs exactly one attack no matter how hard that
   * attack hits. Body count (capped by room slots) is then all the staying
   * power a swarm has, while a bruiser's scales with HP, levels and gear.
   * Pack Tactics is what makes numbers a strategy rather than a worse way to
   * buy hit points.
   *
   * Deliberately limited to small cheap monsters — an archetype, not a global
   * rule. Its counter is anything that clears bodies quickly.
   */
  pack?: number;
}

/** A purchased monster instance. Persists across raids; levels; dies for real. */
export interface Mob {
  uid: number;
  defId: string;
  level: number;
  xp: number;
  /** Commerce XP track — earned only while staffing an amenity (§8.4). */
  commerceLevel: number;
  commerceXp: number;
  /** Current HP carries within a raid only; restored between raids. */
  hp: number;
  /** Permanent. False means slain for good (§6.4). */
  alive: boolean;
  /**
   * Transient, within a raid: dropped to 0 HP and out of the fight.
   *
   * A room is only cleared by downing everything in it, so without this any
   * front-line monster would be destroyed every single raid and could never
   * accumulate levels. Downed monsters are rolled against `slayChance` at the
   * end of the raid; most get back up.
   */
  downed: boolean;
  /** Equipped gear ids, bought with Gold (§6.5). Survives its wearer's death. */
  gear: string[];
  /** Placement: a room, an amenity, or unassigned. */
  placement: Placement;
}

export type Placement =
  | { kind: 'unassigned' }
  | { kind: 'room'; floor: number; room: number }
  | { kind: 'amenity'; landing: number; slot: number };

// ─── Dungeon ─────────────────────────────────────────────────────────────────

export type AmenityId = 'hotspring' | 'provisioner';

export type PriceTier = 'modest' | 'standard' | 'premium' | 'gouge';

export interface AmenityDef {
  id: AmenityId;
  name: string;
  buildCost: number;
  upkeep: number;
  basePrice: number;
  blurb: string;
}

export interface Amenity {
  defId: AmenityId;
  price: PriceTier;
  /** uid of the staffing mob, or null. */
  staffUid: number | null;
  /** Hired NPC staff, bought with Gold. Frees a monster to go back to fighting. */
  hired: boolean;
}

export interface Room {
  mobUids: number[];
}

export interface Floor {
  rooms: Room[];
}

/** A Landing sits beneath each floor (§7.3). */
export interface Landing {
  amenities: (Amenity | null)[];
}

export interface Dungeon {
  floors: Floor[];
  /**
   * landings[i] sits BELOW floor i, so there is always one more decision point
   * than there are gaps between floors. The deepest landing is the Core
   * approach — turn back here, or breach.
   */
  landings: Landing[];
  hearts: number;
  mobs: Mob[];
  nextMobUid: number;
}

// ─── Adventurers ─────────────────────────────────────────────────────────────

export type AdventurerClass = 'fighter' | 'rogue' | 'cleric' | 'mage' | 'ranger';

export interface Adventurer {
  id: number;
  name: string;
  cls: AdventurerClass;
  level: number;
  maxHp: number;
  hp: number;
  dmg: number;
  armor: number;
  maxResolve: number;
  resolve: number;
  gold: number;
  greed: number;
  alive: boolean;
  /** Named adventurer id, e.g. 'berrick'. Null for generics. */
  namedId: string | null;
  /**
   * Low-water mark of hp/maxHp across this delve. Drives `peril` (§15.3):
   * the closer they came to dying, the better the story they carry home.
   */
  lowestHpPct: number;
  /** Links back to a persistent Veteran record, if this is a returning face. */
  veteranId: number | null;
}

/**
 * A persistent adventurer across raids (§15.5). Retirement needs an identity
 * that survives more than one delve, which generic rolled parties do not have.
 */
export interface Veteran {
  id: number;
  name: string;
  cls: AdventurerClass;
  /** Delves survived. Retirement requires `retireMinDelves`. */
  delves: number;
  /** Best thrill they have experienced here. */
  bestThrill: number;
  retired: boolean;
}

/** A retired adventurer. Permanent passive Renown, never returns (§15.5). */
export interface Legend {
  name: string;
  thrill: number;
  retiredOnRaid: number;
}

/** Per-delve Thrill score and its components (§15.3). */
export interface ThrillScore {
  total: number;
  peril: number;
  depth: number;
  variety: number;
  comfort: number;
  tedium: number;
}

export interface Party {
  members: Adventurer[];
  /** Kit is a shared party pool (§7.1). */
  kit: number;
  maxKit: number;
  tier: number;
}

// ─── Raid events ─────────────────────────────────────────────────────────────

/**
 * The sim's only output. The renderer is a pure consumer of this stream —
 * it never reads sim state directly, which is what makes the eventual 2.5D
 * renderer a swap rather than a rewrite.
 */
export type RaidEvent =
  | { t: number; type: 'raid-start'; tier: number; partySize: number }
  | { t: number; type: 'floor-enter'; floor: number }
  | { t: number; type: 'room-enter'; floor: number; room: number }
  | { t: number; type: 'attack'; source: 'mob'; uid: number; targetId: number; dmg: number }
  | { t: number; type: 'attack'; source: 'adv'; advId: number; targetUid: number; dmg: number }
  | { t: number; type: 'kit-strip'; uid: number; amount: number; kitLeft: number }
  | { t: number; type: 'resolve-hit'; advId: number; amount: number; resolveLeft: number }
  | { t: number; type: 'kit-heal'; advId: number; amount: number; kitLeft: number }
  | { t: number; type: 'mob-downed'; uid: number; defId: string; level: number }
  | { t: number; type: 'mob-slain'; uid: number; defId: string; level: number }
  | { t: number; type: 'adv-death'; advId: number; name: string; goldDropped: number }
  | { t: number; type: 'mob-levelup'; uid: number; level: number }
  | { t: number; type: 'room-clear'; floor: number; room: number }
  | { t: number; type: 'landing-enter'; landing: number }
  | { t: number; type: 'rest'; hpRestored: number; kitSpent: number; kitLeft: number }
  | {
      t: number;
      type: 'purchase';
      landing: number;
      amenity: AmenityId;
      advId: number;
      gold: number;
      detail: string;
    }
  | { t: number; type: 'descend'; toFloor: number }
  | { t: number; type: 'retreat'; reason: RetreatReason }
  | { t: number; type: 'taunt-offer'; landing: number; reason: RetreatReason }
  | { t: number; type: 'taunt-used'; landing: number }
  | { t: number; type: 'intervention-retreat'; uid: number }
  | { t: number; type: 'core-breach'; heartsLeft: number }
  | { t: number; type: 'raid-end'; outcome: RaidOutcome };

export type RetreatReason = 'hp' | 'kit' | 'resolve' | 'wiped';

/**
 * 'wiped'     — every adventurer killed. Max Souls, halved Renown (§4.4).
 * 'retreated' — party left alive. The Renown payout.
 * 'breach'    — reached the Core. Costs a Heart, and they all escape (§5.4).
 */
export type RaidOutcome = 'wiped' | 'retreated' | 'breach';

// ─── Results ─────────────────────────────────────────────────────────────────

export interface RaidResult {
  outcome: RaidOutcome;
  killed: number;
  escaped: number;
  goldFromSales: number;
  goldFromCorpses: number;
  souls: number;
  renown: number;
  /** Mean Thrill across survivors, and the components behind it (§15.3). */
  thrill: ThrillScore;
  /** Adventurers who retired after this delve (§15.5). */
  retired: Legend[];
  /** Downed during the raid — most of these get back up. */
  mobsDowned: { uid: number; defId: string; level: number }[];
  /** Permanently slain. A subset of `mobsDowned`. */
  mobsLost: { uid: number; defId: string; level: number }[];
  deepestFloorReached: number;
  ticks: number;
}

export interface SeasonState {
  seed: number;
  raidNumber: number;
  totalRaids: number;
  mana: number;
  souls: number;
  gold: number;
  renown: number;
  dungeon: Dungeon;
  /** Adventurers who may return in later raids (§15.5). */
  veterans: Veteran[];
  nextVeteranId: number;
  /** Retired adventurers — a permanent passive Renown trickle. */
  legends: Legend[];
  over: boolean;
  /** Set when the season ends: 'survived' or 'overrun'. */
  ending: 'survived' | 'overrun' | null;
  log: RaidResult[];
}
