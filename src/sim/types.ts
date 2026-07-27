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

// ─── Traps (§5.2, §10 Engineering) ───────────────────────────────────────────

/**
 * What a trap is *for*. Deliberately not a copy of MobRole: a trap is a
 * mechanism, so it does one thing, once, and then it is a hole in the floor
 * until somebody pays to reset it.
 *
 * - `damage`  — chip every member. Softens the room for whatever is behind it.
 * - `burst`   — one big hit on the healthiest body. The tank arrives hurt.
 * - `kit`     — destroys supplies. §14.4: Kit is roughly half a party's
 *               effective HP, and §7.3 makes it the whole of the rest heal.
 * - `resolve` — breaks nerve rather than bodies. Pillar 2's third path, which
 *               the prototype bestiary has no monster for.
 * - `delay`   — holds the party still for a few ticks while the room's
 *               monsters keep swinging. A pure force multiplier.
 */
export type TrapJob = 'damage' | 'burst' | 'kit' | 'resolve' | 'delay';

export interface TrapDef {
  id: string;
  name: string;
  tier: number;
  job: TrapJob;
  /**
   * Magnitude, read according to `job`: HP per member, HP to one target, Kit
   * destroyed, Resolve per member, or ticks held.
   */
  power: number;
  /** Room capacity consumed — the same budget monsters draw on (§16.3). */
  slots: number;
  /** Mana to install. Arrives fully armed. */
  cost: number;
  /** Mana per charge to re-arm in the Build Phase. Traps have NO upkeep. */
  rearm: number;
  /** Armed charges it holds at once. Most are one-shot. */
  charges: number;
  blurb: string;
}

/** A placed trap. Persists across raids; never levels; never dies. */
export interface Trap {
  uid: number;
  defId: string;
  /**
   * Armed charges remaining.
   *
   * At 0 the trap is scenery: it fires nothing, it counts for no `variety`,
   * and its room reads as EMPTY for Tedium (§15.3). That last clause is what
   * stops a spent trap being free padding — see `noteRoomTraversed`.
   */
  charges: number;
  placement: TrapPlacement;
}

export type TrapPlacement =
  | { kind: 'unassigned' }
  | { kind: 'room'; floor: number; room: number };

// ─── Dungeon ─────────────────────────────────────────────────────────────────

export type AmenityId = 'hotspring' | 'provisioner' | 'apothecary';

export type PriceTier = 'modest' | 'standard' | 'premium' | 'gouge';

export interface AmenityDef {
  id: AmenityId;
  name: string;
  buildCost: number;
  upkeep: number;
  basePrice: number;
  blurb: string;
  /**
   * Trades with nobody behind the counter (§8.4a).
   *
   * A Hot Spring is a hole in the rock with warm water in it — it does not
   * need an attendant, and demanding one made the cheapest comfort in the game
   * cost a monster off the line. Shops and clinics still need staffing; that
   * opportunity cost is the point of them.
   */
  selfService?: boolean;
  /** Fraction of max HP restored. Undefined for non-healing amenities. */
  healPct?: number;
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
  /**
   * Traps installed here, in firing order. Optional so every existing Room
   * literal — tests, tools, saved states — stays valid; read it through
   * `trapsInRoom()`, which treats "missing" as "none".
   */
  trapUids?: number[];
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
  /**
   * Installed traps (§5.2). Optional for the same reason `Room.trapUids` is:
   * a Dungeon literal written before traps existed is still a valid Dungeon.
   */
  traps?: Trap[];
  nextTrapUid?: number;
}

// ─── Adventurers ─────────────────────────────────────────────────────────────

/**
 * How a delve engages a room (§7.2). A progression axis on the Threat Tier
 * table (§4.4), orthogonal to party size and party level.
 *
 * - `single-file` — the baseline, and what everyone does until the dungeon is
 *   famous. The whole group arrives together, descends together, rests and
 *   shops and votes on the Descent Decision together (§7.3) — but in a *room*
 *   they engage one at a time. The lead delver holds the door; when they fall
 *   or break off, the next steps up. Your monsters therefore fight one target
 *   at a time, which is a very large defensive advantage: room clears take
 *   roughly `partySize` times longer for the same total damage output.
 *
 * - `party` — an organised company. Every living member engages at once, which
 *   is the behaviour the sim shipped with. It is the escalation beat of the
 *   whole table: the same three people who used to file in politely now come at
 *   you together, and the room falls in a third of the time.
 *
 * Formation is a property of the tier, not of the party, so it is a thing the
 * player *earns* by becoming popular — pillar 1.
 */
export type Formation = 'single-file' | 'party';

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
   * Bleeding out at 0 HP but not dead (§19). Mirrors the monster Downed→Slain
   * rule: dropping someone is common, killing them outright takes overkill or
   * three failed saves. Downed adventurers cannot act and do not vote.
   */
  downed: boolean;
  /** Successful death saves this delve. Three stabilises them. */
  saveSuccesses: number;
  /** Failed death saves. Three kills them. */
  saveFailures: number;
  /** Stabilised: out of the fight for this delve, but they walk home. */
  stable: boolean;
  /**
   * Low-water mark of hp/maxHp across this delve. Drives `peril` (§15.3):
   * the closer they came to dying, the better the story they carry home.
   */
  lowestHpPct: number;
  /** Links back to a persistent Veteran record, if this is a returning face. */
  veteranId: number | null;

  // ── The Nemesis / Patron tracks (§9.3, §9.4) ──
  /**
   * Rank they walked in at. 0 for a first-timer; +1 per previous escape.
   * Higher rank is higher stats — this is the "+1 Rank" of §9.3.
   */
  rank: number;
  /** Learned traits carried in from previous delves (§9.3). Ids into LEARNED. */
  traits: string[];
  /** True if they were already a Nemesis / Patron when they arrived. */
  isNemesis: boolean;
  isPatron: boolean;
  /**
   * Deepest floor index a Patron will enter. Null means no limit — Patrons are
   * cautious and refuse to descend past the floor they nearly died on (§9.4).
   */
  cautiousFloor: number | null;
  /** Gold they arrived with, before any shopping. Drives the Patron track. */
  startGold: number;
  /** Gold handed over at your amenities this delve (§9.4). */
  goldSpentHere: number;
  /** Damage taken this delve, by the role of the monster that dealt it. */
  hurtByRole: Partial<Record<MobRole, number>>;
  /**
   * Damage taken this delve from traps (§5.2). Kept apart from `hurtByRole`
   * because a trap is not a role — and because the grudge it teaches is a
   * different one: a mechanism bleeds you a scratch at a time, so it makes
   * people come back *thicker* ('hale'), not armoured (§9.3).
   */
  hurtByTrap?: number;
  /** Resolve lost this delve, from Terror mobs and from watching allies die. */
  resolveLost: number;
  /** Floor index where their HP low-water mark was set. Feeds `cautiousFloor`. */
  nearDeathFloor: number | null;
  /**
   * What this delve taught them, decided at raid end. Null means they learned
   * nothing — they were never really in trouble.
   */
  grudge: GrudgeReason | null;
}

/**
 * Why a returning adventurer is coming back different (§9.3).
 *
 * The adventurer adapts to *your* dungeon, so the signal has to be what your
 * dungeon actually did to them — not a random roll.
 */
export type GrudgeReason = 'supplies' | 'nerve' | 'muscle' | 'swarm' | 'coin';

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

  // ── The two tracks (§9.3, §9.4) ──
  //
  // Optional, and only for compatibility: a Veteran is a plain record that
  // tests and tools build by hand, and making eight fields mandatory would
  // break every existing literal. Build them with `makeVeteran()` and they are
  // always present. Read them through `isNemesis` / `isPatron` /
  // `veteranRank` / `canReturn`, which all treat "missing" as "zero".
  /**
   * Named adventurer id if this face is one of §9.2's, else null. Kept on the
   * roster so a named adventurer who escapes comes back as *himself*, trait and
   * all, rather than as an anonymous returnee wearing his name.
   */
  namedId?: string | null;
  /** Killed here. The dead do not come back — the sim skips them in the pool. */
  dead?: boolean;
  /** Times they have walked out alive. Three makes a Nemesis (§9.3). */
  escapes?: number;
  /**
   * Delves on which they spent heavily and survived. Three makes a Patron
   * (§9.4). Independent of `escapes` — a single adventurer can be climbing
   * both ladders at once, which is the tension the game is built around.
   */
  bigSpends?: number;
  /** Total gold they have handed over across every visit. */
  goldSpent?: number;
  /** Learned traits (§9.3), ids into LEARNED. Capped at `maxLearnedTraits`. */
  traits?: string[];
  /** What the last delve taught them — the reason behind the newest trait. */
  lastGrudge?: GrudgeReason | null;
  /** Deepest floor they will enter once they are a Patron (§9.4). */
  cautiousFloor?: number | null;
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
  /** Kit stripped by Wardens this delve. Feeds the 'supplies' grudge (§9.3). */
  kitStripped: number;
}

/**
 * One recurring face's story from a single raid — the narrator's raw material.
 *
 * Everything here is plain readable data: no ids to resolve, no lookups into
 * SeasonState required. `src/sim/narrate.ts` can turn a `RivalNote` into a
 * sentence without touching the roster.
 */
export interface RivalNote {
  /** Roster id, or null if this is their first visit and they died on it. */
  veteranId: number | null;
  /** Their `Adventurer.id` this raid — the same id the RaidEvent stream uses. */
  advId: number;
  name: string;
  /** Named adventurer id (§9.2), else null. */
  namedId: string | null;
  /** Rank they arrived at: 0 = first-timer, +1 per previous escape (§9.3). */
  rank: number;
  /** Traits they walked in carrying (ids into LEARNED). */
  traits: string[];
  /** True if they arrived as a Nemesis / Patron. */
  wasNemesis: boolean;
  wasPatron: boolean;
  /** True if *this* raid was the one that made them one. The narrator's beat. */
  becameNemesis: boolean;
  becamePatron: boolean;
  survived: boolean;
  /** Gold they spent at your amenities this delve. */
  goldSpent: number;
  /** What this delve taught them, and the trait it will buy them next time. */
  grudge: GrudgeReason | null;
  learned: string | null;
  /** Escapes and big spends after this raid is folded in. */
  escapes: number;
  bigSpends: number;
}

// ─── Raid events ─────────────────────────────────────────────────────────────

/**
 * The sim's only output. The renderer is a pure consumer of this stream —
 * it never reads sim state directly, which is what makes the eventual 2.5D
 * renderer a swap rather than a rewrite.
 */
export type RaidEvent =
  | {
      t: number;
      type: 'raid-start';
      tier: number;
      partySize: number;
      /** How they will engage each room (§7.2). */
      formation: Formation;
    }
  | { t: number; type: 'floor-enter'; floor: number }
  // ── The line (§7.2, single-file). Who is holding the door, and who is next.
  /**
   * Someone stepped to the front. Emitted on entering a room and every time the
   * point changes hands, so a consumer can always answer "who is engaged?"
   * from the stream alone.
   */
  | { t: number; type: 'line-engage'; advId: number; waiting: number }
  /**
   * The point man broke off, too hurt to hold the door. `next` is whoever
   * stepped up, or null — nobody left fit, and the delve is over.
   */
  | { t: number; type: 'line-break'; advId: number; hpPct: number; next: number | null }
  | { t: number; type: 'room-enter'; floor: number; room: number }
  | { t: number; type: 'attack'; source: 'mob'; uid: number; targetId: number; dmg: number }
  | { t: number; type: 'attack'; source: 'adv'; advId: number; targetUid: number; dmg: number }
  | { t: number; type: 'kit-strip'; uid: number; amount: number; kitLeft: number }
  // ── Traps (§5.2). `trap-fire` is the beat; the rest carry the consequences.
  | {
      t: number;
      type: 'trap-fire';
      uid: number;
      defId: string;
      floor: number;
      room: number;
      /** True if a Ley Charge triggered it out of sequence — Spring (§7.4). */
      sprung: boolean;
      chargesLeft: number;
    }
  | { t: number; type: 'trap-hit'; uid: number; defId: string; advId: number; dmg: number }
  | { t: number; type: 'trap-kit'; uid: number; defId: string; amount: number; kitLeft: number }
  | { t: number; type: 'trap-snare'; uid: number; defId: string; ticks: number }
  | { t: number; type: 'resolve-hit'; advId: number; amount: number; resolveLeft: number }
  | { t: number; type: 'kit-heal'; advId: number; amount: number; kitLeft: number }
  | { t: number; type: 'mob-downed'; uid: number; defId: string; level: number }
  | { t: number; type: 'mob-slain'; uid: number; defId: string; level: number }
  | { t: number; type: 'adv-death'; advId: number; name: string; goldDropped: number }
  | { t: number; type: 'adv-downed'; advId: number; name: string; overkill: boolean }
  | { t: number; type: 'death-save'; advId: number; name: string; success: boolean; successes: number; failures: number }
  | { t: number; type: 'adv-stable'; advId: number; name: string }
  | { t: number; type: 'adv-rescued'; advId: number; name: string; fee: number }
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

/**
 * 'patron' is a Patron calling the delve off at their personal floor limit
 * (§9.4) — they are neither hurt nor out of supplies, they simply will not go
 * deeper than the floor that nearly killed them.
 */
export type RetreatReason = 'hp' | 'kit' | 'resolve' | 'wiped' | 'casualties' | 'patron';

/**
 * 'wiped'     — every adventurer killed. Max Souls, halved Renown (§4.4).
 * 'retreated' — party left alive. The Renown payout.
 * 'breach'    — reached the Core. Costs a Heart, and they all escape (§5.4).
 */
export type RaidOutcome = 'wiped' | 'retreated' | 'breach';

// ─── Results ─────────────────────────────────────────────────────────────────

export interface RaidResult {
  outcome: RaidOutcome;
  /** How they engaged rooms (§7.2). Read off the tier, recorded for the record. */
  formation: Formation;
  killed: number;
  escaped: number;
  goldFromSales: number;
  goldFromCorpses: number;
  /** Rescue fees (§19.3) — they pay us to drag them out alive. */
  goldFromRescues: number;
  /** Dropped to 0 HP at some point, whether or not they survived it. */
  downedCount: number;
  /** Stabilised by their own saves, or bought out. */
  rescuedCount: number;
  souls: number;
  renown: number;
  /** Mean Thrill across survivors, and the components behind it (§15.3). */
  thrill: ThrillScore;
  /** Adventurers who retired after this delve (§15.5). */
  retired: Legend[];
  /**
   * Recurring faces in this raid and what happened to them (§9.3, §9.4).
   * Only adventurers with a persistent identity appear here — a generic
   * first-timer who dies leaves no note.
   */
  rivals: RivalNote[];
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
