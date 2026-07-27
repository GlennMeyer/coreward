/**
 * Tuning tables. Every number here traces to docs/DESIGN.md — when you change
 * one, change the doc too, or the doc becomes a lie.
 */
import type {
  AdventurerClass, AmenityDef, AmenityId, Formation, MobDef, PriceTier, TrapDef,
} from './types';

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

// ─── Monster upgrades (§6.6) ─────────────────────────────────────────────────

/** The three things any creature can get better at. */
export type UpgradeTrack = 'bite' | 'hide' | 'vigor';

export const UPGRADE_EFFECT: Record<UpgradeTrack, { dmg: number; armor: number; hp: number }> = {
  bite: { dmg: 0.18, armor: 0, hp: 0 },
  hide: { dmg: 0, armor: 1.2, hp: 0 },
  vigor: { dmg: 0, armor: 0, hp: 0.22 },
};

export const MAX_UPGRADE_RANK = 4;

/**
 * Mana per rank. Rises steeply so a single monster cannot absorb the whole
 * dungeon budget, and so breadth stays competitive with depth.
 */
export function upgradeRankCost(defId: string, rank: number): number {
  const tier = MOBS[defId]?.tier ?? 1;
  return Math.round(18 * tier * 1.6 ** rank);
}

/**
 * Per-species names for the same three tracks.
 *
 * "Train to level 5" is an abstraction; "Sharper Teeth" is a decision about
 * what this creature becomes. Same maths, and it costs nothing to make the
 * spending legible.
 */
export const UPGRADE_NAMES: Record<string, Record<UpgradeTrack, string>> = {
  rat:      { bite: 'Sharper Teeth',   hide: 'Thicker Hide',      vigor: 'Higher Metabolism' },
  slime:    { bite: 'Caustic Coat',    hide: 'Dense Nucleus',     vigor: 'Greater Mass' },
  cutpurse: { bite: 'Notched Blades',  hide: 'Scavenged Mail',    vigor: 'Hard Living' },
  skeleton: { bite: 'Honed Edge',      hide: 'Fused Ribs',        vigor: 'Deeper Binding' },
  ogre:     { bite: 'Studded Club',    hide: 'Callused Plate',    vigor: 'Brute Constitution' },
  ooze:     { bite: 'Corrosive Bloom', hide: 'Mineral Crust',     vigor: 'Swollen Body' },
};

export function upgradeName(defId: string, track: UpgradeTrack): string {
  return UPGRADE_NAMES[defId]?.[track]
    ?? { bite: 'Sharper', hide: 'Tougher', vigor: 'Hardier' }[track];
}

// ─── Traps (§5.2, §10 Engineering) ───────────────────────────────────────────

/**
 * The trap roster. Costed against the *opening* budget, not the endgame.
 *
 * **Why traps exist.** Measured over 750 seasons, raid 2 was a cliff: 6% of
 * raids breached on raid 1 and 40% on raid 2, and 62% of seasons ended overrun.
 * 300 starting Mana buys roughly three monsters, which holds one party; from
 * then on income is ~130-150/raid against permanent monster losses and a rising
 * Threat Tier, so the player cannot replace what died, let alone invest. §4.1
 * calls upkeep "the pressure valve", and it was stuck shut — every defensive
 * option in the game charged rent.
 *
 * So the shape of a trap is defined by what a monster is *not*:
 *
 * | | Monster | Trap |
 * |---|---|---|
 * | Up front | 12-85 mana | 22-70 mana |
 * | Per raid, idle | upkeep, always | **nothing** |
 * | Per raid, working | upkeep | re-arm what fired |
 * | Scales | levels, gear, evolution | never |
 * | Dies | permanently (§6.4) | never |
 *
 * A trap is a *pay-per-use* defence. A dungeon that is losing can stop paying
 * for it and it is still there; a dungeon that is winning pays only for the
 * charges it actually spent. That is the option a poor dungeon can take, and
 * it is why traps soften the early cliff without inflating the late game —
 * they are the one thing in the dungeon that never gets better.
 *
 * **They complement monsters rather than replacing them.** Only two of the five
 * deal HP damage at all, and the other three (Kit, Resolve, delay) do nothing
 * on their own — they set up whatever is standing behind them. A room of pure
 * traps is a room the party walks out of.
 */
export const TRAPS: Record<string, TrapDef> = {
  darts: {
    id: 'darts', name: 'Dart Battery', tier: 1, job: 'damage',
    power: 7, slots: 1, cost: 24, rearm: 8, charges: 2,
    blurb: 'Peppers the whole party. Ignores armour — it is a mechanism, not a swordsman.',
  },
  snare: {
    id: 'snare', name: 'Snare Net', tier: 1, job: 'delay',
    power: 3, slots: 1, cost: 30, rearm: 10, charges: 1,
    blurb: 'Holds them still for three ticks while the room keeps swinging. Worthless alone.',
  },
  gasvent: {
    id: 'gasvent', name: 'Rot-Gas Vent', tier: 2, job: 'kit',
    power: 3, slots: 1, cost: 38, rearm: 13, charges: 1,
    blurb: 'Spoils rations, fouls potions. Kit is half their effective health (§14.4).',
  },
  shrieker: {
    id: 'shrieker', name: 'Shrieker', tier: 2, job: 'resolve',
    power: 6, slots: 1, cost: 34, rearm: 11, charges: 1,
    blurb: 'Breaks nerve, not bodies. The prototype bestiary fields no Terror; this is it.',
  },
  deadfall: {
    id: 'deadfall', name: 'Deadfall', tier: 3, job: 'burst',
    power: 30, slots: 2, cost: 66, rearm: 22, charges: 1,
    blurb: 'Drops a ceiling on whoever is healthiest. The tank arrives at the fight hurt.',
  },
};

export const TRAP_IDS = Object.keys(TRAPS);

/** Install cost after the sweepable scalar. Always use this, never `def.cost`. */
export function trapCost(defId: string): number {
  return Math.max(1, Math.round((TRAPS[defId]?.cost ?? 0) * TUNING.trapCostScalar));
}

/** Mana per charge to re-arm. Always use this, never `def.rearm`. */
export function trapRearmCost(defId: string): number {
  return Math.max(1, Math.round((TRAPS[defId]?.rearm ?? 0) * TUNING.trapRearmScalar));
}

/**
 * Effective magnitude of one firing. `sprung` applies the §7.4 Spring
 * multiplier — a trap triggered out of sequence catches them mid-fight instead
 * of on the threshold.
 */
export function trapPower(defId: string, sprung = false): number {
  const def = TRAPS[defId];
  if (!def) return 0;
  const scaled = def.power * TUNING.trapPowerScalar * (sprung ? TUNING.springMult : 1);
  // Rounded, but never to nothing: a trap that fires must do something, or the
  // event stream tells the player a lie.
  return Math.max(1, Math.round(scaled));
}

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
  /**
   * Opening capital (§8.4c).
   *
   * Amenities are bought with Gold now, and Gold starts at zero — so without a
   * float you cannot open a single shop until raid 3, which is most of a
   * prototype season. You are opening a business; you have a purse.
   */
  startingGold: 150,
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
  /**
   * Share of your Gold and Souls carried off when they reach the Core (§5.4).
   *
   * A breach used to cost a Heart and nothing else — an abstract counter, so
   * losing felt like a timer expiring rather than something being taken. They
   * are standing in your treasury; they should leave with it.
   */
  /**
   * Chance a party carrying casualties turns back, per casualty (§19.2).
   *
   * This was an absolute rule and it became the game's dominant exploit: down
   * one adventurer and the delve ALWAYS ended, so a build of cheap chaff plus
   * two traps could guarantee it was never breached. Measured, the genetic
   * search converged on exactly that — 100% season survival at 776 Renown.
   *
   * A hurt party is much more likely to leave, not certain to. Nerve, greed and
   * how deep they already are all argue for pressing on, and a run should be
   * winnable by threatening people rather than by tripping one of them.
   */
  casualtyRetreatChance: 0.55,
  breachLootPct: 0.35,
  /**
   * Extra loot share per previous breach this season.
   *
   * Word gets out that the dungeon can be cracked, so the next crew comes
   * knowing where the vault is. This is the roguelite death-spiral: losing
   * makes losing more expensive, which is what gives a run a shape.
   */
  breachLootEscalation: 0.2,
  slayChance: 0.25,
  /**
   * Chance a downed monster is slain when the Core is breached.
   *
   * Was an unconditional 1.0. That was survivable while breaches were rare, but
   * §26 made them common — an emptied dungeon always breaches, and an emptied
   * dungeon is one where everything is already down. So every breach wiped the
   * entire roster and the player rebuilt from nothing, which is a death spiral
   * with no way out rather than a setback.
   *
   * Still far worse than a repelled raid (0.25): losing a Heart should hurt.
   */
  breachSlayChance: 0.5,

  // ── Formation: the line (§7.2) ──
  /**
   * HP fraction at which the point man breaks off and the next in line steps up.
   *
   * Single-file only — a coordinated party fights to the Descent Decision like
   * it always did. This is the *room-level* mirror of `DESCEND_HP_THRESHOLD`
   * (0.35) and is set just below it on purpose: an individual holding a door
   * alone gives up at roughly the health at which the whole party would turn
   * back, because the calculation is the same one and they are making it by
   * themselves.
   *
   * It is also what stops single-file being a meat grinder. Without it the
   * queue feeds people into a room one corpse at a time — every early raid ends
   * in a wipe, a wipe pays no Renown at all (§15.3), and the ratchet seizes.
   * With it, the delve *withdraws*, which is the outcome the whole economy is
   * built to reward.
   *
   * Set to 0 to get the meat grinder back and measure the difference.
   */
  /**
   * How many of a coordinated party can be engaged in a room at once (§18).
   *
   * Never the whole group. A room is a test of what is in it, not of how many
   * bodies the party can pile through the door at the same moment — without a
   * cap, numbers convert directly into damage and a five-person party simply
   * drowns any room. A party's real advantage is that it can rotate a fresh
   * fighter in the moment the point man falls back, not that everyone swings.
   *
   * Single-file is this same rule at width 1.
   */
  partyEngageWidth: 2,
  // ── Downed, death saves and rescue (§19) ──
  /**
   * Damage past 0 HP, as a fraction of max HP, that kills outright.
   *
   * Below this they are DOWNED, not dead — the mirror of the monster
   * Downed→Slain rule (§6.4), and for the same reason: if every drop is a
   * death, nobody ever becomes a recurring face and §9.3/§15.5 never fire.
   * Overkill is how a genuinely lethal dungeon still kills.
   */
  overkillPct: 0.15,
  /** Chance a death save succeeds. Three successes stabilise, three fail kills. */
  deathSaveChance: 0.5,
  /** Ticks between a downed adventurer's saves. */
  deathSaveInterval: 3,
  /**
   * Gold the party pays to have a downed member dragged out alive (§19.3).
   *
   * The dungeon runs a rescue service. It is the Tycoon reframe applied to the
   * one moment the old rules threw money away: killing destroys 75% of what
   * they carry (§4.3), so a corpse was worth less than a customer. Now dropping
   * someone can be *more* profitable than killing them.
   */
  /** HP a bought-out adventurer is put back on their feet with. */
  rescueHpPct: 0.25,
  rescueFee: 45,
  /**
   * Each rescue in the same delve costs this much more than the last.
   *
   * Surge pricing, and it is what stops the service being a blanket immunity:
   * measured at a flat fee the party bought out essentially every casualty
   * (0.98 rescues/raid) and nobody ever died. The first body is affordable,
   * the third is a decision.
   */
  rescueFeeEscalation: 1.8,
  /** Party's willingness to pay: they buy out if they can afford it and care. */
  rescueResolveFloor: 0.25,
  lineBreakHpPct: 0.3,
  /**
   * Damage multiplier on the parting blow every monster in the room lands on a
   * withdrawing point man (§7.2).
   *
   * **Disengaging under fire is the whole reason `lineBreakHpPct` is a decision
   * rather than a free exit.** Without this, breaking off is a teleport: the
   * queue trades its front man out at exactly `lineBreakHpPct` every time,
   * nobody ever dies, and `peril` is pinned to a constant by the rule rather
   * than set by the dungeon. Measured, that is what happens — deaths per season
   * fall from 11.6 to 2.5 and every strategy converges on the same delve.
   *
   * With it, the cost of stepping back scales with what you are stepping back
   * *from*. Breaking off in front of a Cave Rat is a scratch; breaking off in
   * front of an Ogre at 30% HP kills you. That is a real answer to §6.2 under
   * single-file: a **bruiser**'s role identity becomes "the thing you cannot
   * safely stop fighting", which is a much better bruiser than "the thing that
   * happens to be in the doorway".
   *
   * Set to 0 to make withdrawal free and measure the difference.
   */
  linePartingMult: 0.4,
  /**
   * Extra multiplier on a **skirmisher**'s parting blow (§6.2), on top of
   * `linePartingMult`.
   *
   * Single-file collapses monster targeting: with one legal target, "finish the
   * wounded", "pick the squishiest" and "hit the healthiest" all choose the
   * same person, and three roles read as one. Each therefore keeps its
   * preference expressed against the *line* instead of against the party, and a
   * skirmisher's is this — they chase. "Targets the party's weakest member"
   * applied to the only moment single-file offers a choice is "hits hardest at
   * the person turning their back".
   *
   * At 1.0 a skirmisher is no different from anything else on the way out, and
   * the role has no single-file identity at all.
   */
  skirmisherPartingBonus: 1.6,
  /**
   * How much of the delve's peril the waiting line banks (§15.3).
   *
   *     peril = own + (worst_surviving_peril − own) × singleFilePerilShare
   *
   * **Ships at 0, and the reason is the whole point of having a balance runner.**
   *
   * The worry was structural and looked obvious at the desk: `peril` is a mean
   * over survivors' low-water HP, which quietly assumes everyone was in the
   * room. Under single-file only one person ever is, so a delve where the point
   * man was carried out at 8% would score the same peril as a stroll, purely
   * because three people were queued behind him — a measurement artifact of the
   * formation, deflating Renown for a change the player did not make. This knob
   * was built to correct it.
   *
   * **Measured, the artifact does not happen.** Because the line *rotates*, any
   * delve long enough to matter feeds every member through the door in turn and
   * chews each of them down to `lineBreakHpPct`. Across 300 seasons per
   * strategy, `balanced` peril rose from 0.28 (party-formation baseline) to
   * **0.39 at share 0** — single-file makes delves more frightening on its own,
   * not less.
   *
   * The only delves where the queue does stay pristine are the ones where
   * nothing in the dungeon can hurt anybody — which is §15.1's degenerate
   * family, exactly. So every point of share is a subsidy to the builds the
   * Thrill reframe exists to demote. Raising it to 0.5 costs the trap build 35
   * points of season survival (62% → 27%) and walks `wardens` from Tier 3.2 to
   * Tier 3.6 on 17 more Renown, while doing almost nothing for a dungeon that
   * actually fights.
   *
   * Kept, swept and set to 0 rather than deleted, because "why doesn't the rest
   * of the queue share the story?" is a question worth having an answer to.
   * Ignored entirely for `party` formation, where the mean was always honest.
   */
  singleFilePerilShare: 0,

  // ── Traps (§5.2) ──
  /**
   * Global multiplier on every trap's magnitude.
   *
   * One knob for the whole roster, so the balance runner can ask "are traps
   * strong enough to soften raid 2?" without sweeping five numbers against each
   * other. The *relative* strengths in TRAPS are a design statement; this is
   * the volume dial on all of them at once.
   */
  trapPowerScalar: 1.0,
  /** Global multiplier on install cost. */
  trapCostScalar: 1.0,
  /**
   * Global multiplier on re-arm cost — the trap economy's only recurring bill.
   *
   * This is the knob that decides whether traps are cheap defence or cheap
   * *Thrill*. An armed trap makes its room non-empty, which is worth
   * `tediumPerEmptyRoom` (4) Thrill, and Thrill pays `manaPerThrill` (1.8) mana
   * per point — so re-arming has to cost more than ~7 mana or a trap pays for
   * itself in Tedium relief alone and every empty corridor gets a decorative
   * spring. The cheapest re-arm in the roster is 9.
   */
  trapRearmScalar: 1.0,
  /**
   * Magnitude multiplier when a trap is triggered by the Spring intervention
   * (§7.4) rather than by someone stepping on it.
   *
   * 1.0: Spring buys *timing and reach*, not power. Its value is that it can
   * fire a trap the party will never reach — one on a floor they are about to
   * turn back from is otherwise dead mana — and that it can land mid-fight,
   * when a lost Kit or a lost turn actually decides the room. That is a real
   * decision precisely because springing a trap they were going to walk into
   * anyway is a waste of a Ley Charge.
   */
  springMult: 1.0,
  /**
   * How much the whole trap layer may add to the `variety` set (§15.3).
   *
   * Traps *do* count toward variety — they are part of what makes a delve worth
   * describing, and pretending otherwise would make the Tedium rules a lie.
   * But all trap jobs together contribute at most this much, however many
   * distinct ones the party meets. Adventurers tell stories about the things
   * that fought back; a trap is scenery with a punchline, and the first one is
   * a beat while the fourth is a corridor.
   *
   * Without the cap, four traps (~190 mana, no upkeep) would max `variety` with
   * no bestiary at all — which is §15.1's exploit wearing a different hat.
   * Set to 0 to take trap variety away entirely and measure the difference.
   */
  trapVarietyCredit: 1,

  // ── Thrill-based Renown (§15). Set `thrillRenown` false for the flat
  //    `6 × escapees` formula, so the two can be measured against each other.
  thrillRenown: true,
  thrillPerilWeight: 0.45,
  thrillDepthWeight: 0.25,
  thrillVarietyWeight: 0.2,
  thrillComfortWeight: 0.1,
  /**
   * Peril required before depth/variety/comfort pay in full — the "kiddie ride"
   * gate (§15.1).
   *
   * A long, varied, well-appointed dungeon that never threatens anybody is a
   * scenic walk, not a delve. The three non-peril terms are multiplied by
   * `min(1, peril / thrillPerilGate)`, so length only converts into reputation
   * once the ride is actually frightening. At 0.6 a party has to have been down
   * around 40% health at some point to bank the full value of the walk.
   *
   * Set to 0 to disable the gate and get the flat §15.3 sum back — which is
   * also the measurement that justifies it. With the gate off, `wardens` — the
   * §15.1 degenerate build, which kills nobody and threatens nobody — tops the
   * Renown table at 120 against `showman`'s 108. At 0.6 it is second at 66
   * against 84, and the ordering does not flip back at any higher value.
   */
  thrillPerilGate: 0.6,
  /**
   * Floors that count as a full-`depth` delve.
   *
   * §15.3 wrote `depth = floors_cleared / floors_in_dungeon`, which is a
   * *completion ratio* — and a completion ratio is maximised by owning the
   * smallest dungeon possible. Every strategy in the balance runner scored
   * depth 1.00 on a single undug floor, so the term paid a flat 25 Thrill to
   * everybody and rewarded never digging. Measuring against a fixed reference
   * instead makes depth mean depth: one floor is a third of a delve, and
   * digging buys Thrill as well as mana. Kept in TUNING (rather than reading
   * MAX_FLOORS) so it can be swept, and so raising the floor cap later is not
   * silently a Renown nerf.
   */
  thrillDepthFloors: 3,
  tediumPerEmptyRoom: 4,
  tediumPerRepeatedRoom: 8,
  /**
   * Renown per point of Thrill, per surviving adventurer.
   *
   * This is the gear ratio of the whole difficulty ratchet, so it is set by
   * matching the pre-Thrill baseline rather than picked: at 0.3 the scripted
   * combat AI finishes around Tier 2.0 with ~50% season survival, which is
   * what the flat `6 × escapees` formula produced (§14.6). At the 0.1 it
   * shipped with, combat never left Tier 1.1 and the ratchet was inert.
   */
  renownPerThrill: 0.3,
  /**
   * Mana per point of Thrill (§4.1).
   *
   * Without this, Mana came only from kills and floors while §15 pays Renown
   * for letting people LEAVE — so the two halves of the design pulled against
   * each other and a player who ran a good, survivable dungeon earned 83 mana
   * a raid and starved. The dungeon feeds on the experience, not just the
   * corpses.
   *
   * Scaled on the raid's Thrill score, deliberately NOT multiplied by survivor
   * count: per-head would hand the volume-farming wardens build a second
   * income stream and reopen §15.1.
   */
  manaPerThrill: 1.8,

  // ── Retirement and Legends (§15.5) ──
  /**
   * Thrill a delve must reach for a regular to retire on it (§15.5).
   *
   * Set from the measured distribution, not picked, and **re-derived when
   * single-file landed** (§7.2) because the distribution moved under it: the
   * line rotates every member through the door, so far more delves now finish
   * with a genuinely frightened survivor in them. Across 36,745 scored
   * survivors at the current tuning, p50 is 12.2 and **p90 is 56.9** — so 60 is
   * the top-decile delve §15.7.4 asked for.
   *
   * Left at the old 45 it qualified roughly one delve in four: `balanced` made
   * 2.0 Legends a season against the 0.4 the design targets, and the
   * `retireRenownBonus` those Legends pay became a second, unintended Renown
   * engine driving the difficulty ratchet. The original 75 qualified 0.04% of
   * raids and made Legends unreachable content. The rule — "genuine top decile"
   * — is what is stable here; the number is downstream of it and has to be
   * re-measured whenever combat changes shape.
   */
  retireThrill: 60,
  /**
   * Delves survived before a regular can retire (§15.5).
   *
   * 2, not the doc's 3, because a prototype season is only 8 raids: measured,
   * 3 delves cuts Legends by ~15× (showman 0.47/season → 0.03) and the system
   * effectively never fires. Revisit at the full design's 12 raids, where 3 is
   * reachable.
   */
  retireMinDelves: 2,
  /** Renown paid once when an adventurer retires. */
  retireRenownBonus: 25,
  /** Passive Renown per raid, per Legend on the wall. */
  legendRenownTrickle: 2,
  /** Chance a party slot is filled by a returning veteran rather than a fresh roll. */
  /**
   * Chance a party slot is filled by a returning face rather than a fresh roll.
   * Raised from 0.35: recurring adventurers are the emotional payload of §15.5,
   * and at 0.35 a veteran rarely survived long enough to become one.
   */
  veteranReturnChance: 0.55,

  // ── The Nemesis track (§9.3) ──
  /**
   * Escapes required to become a Nemesis (§9.3).
   *
   * The counter is the whole point: every party you send home *unharmed* is a
   * person who now knows your dungeon. It is also, structurally, the natural
   * brake on the §15.1 "let everybody live" optimum — a build that maximises
   * escapees is a build that manufactures its own opposition.
   */
  nemesisEscapes: 3,
  /**
   * Stat multiplier per Rank. §9.3's "+1 Rank: higher stats".
   *
   * Deliberately modest and compounding-free: the returning face is supposed to
   * be recognisably tougher, not a wall. The *traits* are what make them hard,
   * because a trait invalidates a strategy and a stat bump only taxes it.
   */
  nemesisStatPerRank: 0.12,
  /** Rank ceiling, so a season-long survivor cannot spiral out of reach. */
  nemesisMaxRank: 5,
  /** Extra party members a Nemesis brings — they lead a party of their own. */
  nemesisPartyBonus: 1,
  /**
   * Souls for killing a Nemesis, on top of the normal named payout.
   *
   * SUBSTITUTION: §9.3 pays "triple Insight". Insight and the Codex are out of
   * prototype scope (§12), so the reward lands in Souls — the prototype's only
   * permanent-progress currency — plus a Renown spike for the story.
   */
  nemesisKillSouls: 60,
  nemesisKillRenown: 20,
  /**
   * Chance a Nemesis or Patron forces their way into a given raid.
   *
   * Higher than `veteranReturnChance` because these are characters, not extras:
   * a Nemesis you never see again is not a Nemesis. They still have to survive
   * the roll, so a season can go a raid or two without them.
   */
  recurringReturnChance: 0.7,
  /** Cap on Nemesis/Patron headliners in one party, and on the size bonus. */
  maxRecurringPerParty: 2,
  maxPartyBonus: 2,
  /** Traits one adventurer may accumulate. Four exist; three is already nasty. */
  maxLearnedTraits: 3,

  // ── The Patron track (§9.4) ──
  /**
   * Delves with heavy spending required to become a Patron (§9.4).
   * Symmetric with `nemesisEscapes` on purpose — the two ladders are the same
   * height so one adventurer can climb both at the same rate.
   */
  patronSpends: 3,
  /**
   * Fraction of their purse an adventurer must hand over for the delve to count
   * as a big spend. At 0.4 a party that uses a shop twice qualifies; a party
   * that window-shops does not.
   */
  patronSpendFraction: 0.4,
  /** §9.4: a Patron "arrives with 3× gold". */
  patronGoldMult: 3,
  /** §9.4: "brings one extra party member (a friend they told)". */
  patronPartyBonus: 1,
  /**
   * Renown per raid per living Patron.
   *
   * SUBSTITUTION: §9.4 grants "+3 Insight at season end while alive". With no
   * Insight in the prototype this becomes a Renown trickle, matching how
   * Legends already pay (§15.5). Note this is a *cost* as much as a reward —
   * Renown is the difficulty dial (§4.4), so a stable of Patrons raises the
   * tier of everyone who follows them in.
   */
  patronRenownTrickle: 2,
  /** Souls for killing a Patron — §9.4's "large one-time Soul payout". */
  patronKillSouls: 45,
  /**
   * HP fraction that counts as "nearly died", for the floor a Patron will not
   * descend past (§9.4).
   */
  patronCautionHpPct: 0.4,

  // ── Learned trait strengths (§9.3) ──
  /** 'supplies': extra party Kit per provisioned member. Counters drain. */
  learnedKitBonus: 2,
  /** 'muscle': flat armour. Counters burst bruisers. */
  learnedArmorBonus: 2,
  /** 'swarm': extra max HP, as a fraction. Counters chip damage and packs. */
  learnedHpBonus: 0.2,
  /** 'nerve': extra max Resolve, and Resolve damage taken is halved. */
  learnedResolveBonus: 10,
  learnedResolveResist: 0.5,
  /** 'coin': what a haggler pays at your amenities. Counters commerce. */
  learnedHagglePct: 0.6,

  // ── Named adventurer traits (§9.2) ──
  /**
   * Damage multiplier on every monster while the Quiet Twins are alive.
   *
   * §9.2 has them "split into two paths, halving your per-room mob density".
   * The prototype has no pathing, so the abstraction is applied where the
   * density actually mattered: half your monsters are chasing the other twin,
   * so half your damage lands. It is the same counter to the same build —
   * one heavily stacked choke room.
   */
  twinsDensityMult: 0.55,
  /** Gold Coin-Cutter Sable lifts from your takings at each Landing (§9.2). */
  sableTheft: 30,
  /**
   * HP fraction a delve must push someone below before the monster that did it
   * teaches them anything (§9.3).
   *
   * Without a floor here every survivor learns something from every scratch,
   * and within three raids the whole roster is carrying three traits. A grudge
   * has to be earned or it stops meaning anything.
   */
  grudgeHurtHpPct: 0.6,
};

export type Tuning = typeof TUNING;

const TUNING_DEFAULTS: Tuning = { ...TUNING };

export function resetTuning(): void {
  Object.assign(TUNING, TUNING_DEFAULTS);
}

/** XP thresholds for levels 2..10 (§6.4). */
export const XP_THRESHOLDS = [8, 20, 36, 56, 82, 114, 154, 202, 260];
export const XP_PER_HIT = 1;
export const XP_PER_KILL = 5;
/**
 * XP for putting an adventurer on the floor (§19.1).
 *
 * §19 made kills rare by design, and XP came only from hits and kills — so
 * monsters stopped levelling almost entirely. Measured before this: **81% of
 * surviving monsters were still level 1 at season end** and levels 8–10 were
 * unreachable, which quietly killed pillar 3 (there was no veteran to lose).
 * Downing someone is the fight the monster actually won.
 */
export const XP_PER_DOWN = 4;
export const MAX_LEVEL = 10;

/**
 * Mana to train a monster up one level (§6.4).
 *
 * XP is the slow, earned path and it mostly does not happen — measured, 81% of
 * monsters never leave level 1 because they die and get replaced by recruits.
 * Training is the deliberate one: Mana raises the dungeon's own creatures, and
 * it gives a player who *wants* a veteran a way to make one instead of waiting
 * on a lottery. Rises steeply so it never replaces earning it in the field.
 */
export function upgradeCost(level: number): number {
  return Math.round(30 * 1.55 ** (level - 1));
}

/**
 * Souls to bring a slain monster back, per level.
 *
 * Was `20 × level²` — 500 Souls for a level 5 against a season income of ~10.
 * That is not "deliberately brutal", it is decorative: nobody has ever paid it.
 * Losing a veteran should be a setback you can claw back from, because that is
 * the whole of pillar 3 — a monster you care about needs to be recoverable or
 * it is just a consumable with a name.
 */
export const SOULS_PER_RECONSTITUTE = 4;

/** Reconstitute cost in Souls, linear in level (§6.4). */
export function reconstituteCost(level: number): number {
  return Math.round(SOULS_PER_RECONSTITUTE * level);
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
/**
 * Hearts the Core starts with (§5.4).
 *
 * 4, not the doc's 3. §26 made breaches far more common — an emptied dungeon
 * now always breaches instead of being saved by the party's manners — and 3
 * Hearts against that left every strategy under 32%. Measured across five
 * builds: 3 gives 32/28/12/12/7%, 4 gives 49/49/33/29/14%, 5 gives 81/83/57.
 *
 * 4 is the roguelite curve: good play wins about half the time and a weak build
 * mostly loses. 5 is charity.
 */
export const STARTING_HEARTS = 4;

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
    id: 'hotspring', name: 'Hot Spring', buildCost: 55, upkeep: 4, basePrice: 8,
    blurb: 'Self-service. Restores 30% HP — a soak, not a cure.',
    selfService: true,
    healPct: 0.3,
  },
  apothecary: {
    id: 'apothecary', name: 'Apothecary', buildCost: 110, upkeep: 9, basePrice: 34,
    blurb: 'Heals to full, and will treat the walking wounded.',
    selfService: true,
    healPct: 1,
  },
  provisioner: {
    id: 'provisioner', name: 'Provisioner', buildCost: 45, upkeep: 3, basePrice: 6,
    blurb: 'Sells Kit, up to 3. Undermines drain builds.',
    selfService: true,
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

/**
 * Gear can be reforged, repeatedly, at a rising price (§6.5).
 *
 * Every Gold sink in the game was priced for the early run — traps, amenities
 * and gear are all flat costs — so a long run just accumulates. Measured under
 * endless, a depth build finished on **17,978 Gold**, roughly forty times what
 * it could spend on anything.
 *
 * Reforging scales without bound, so Gold always has somewhere to go and the
 * player's late-run decision is how much to pour into which monster.
 */
export const REFORGE_BASE = 90;
export const REFORGE_GROWTH = 1.7;
/** Each rank multiplies the piece's effect by this much again. */
export const REFORGE_EFFECT = 0.35;

export function reforgeCost(rank: number): number {
  return Math.round(REFORGE_BASE * REFORGE_GROWTH ** rank);
}

// ─── Admission (§20) ─────────────────────────────────────────────────────────

/**
 * Base gate price, scaled by the Threat Tier they came for and the admission
 * tier you set. A famous dungeon can charge more; a Tier 1 farmhand cannot pay
 * what a Tier 4 company can.
 *
 * 3, not 10. At 10 the gate took roughly half of every purse and the rest of
 * the economy died with it — measured 605g at the door against **9g** in shop
 * sales, because they arrived broke. Admission has to be a slice, not the meal.
 */
export const ADMISSION_BASE = 3;

/**
 * Death-cover premium, scaled like admission (§21).
 *
 * The dungeon sells you a policy against the dungeon. Premiums land every raid
 * from every buyer; claims are rare, because §19 already makes death rare — so
 * this is a floor under your income where rescue was a lottery.
 */
export const INSURANCE_BASE = 4;

/** How readily an adventurer buys cover. Cautious classes buy; the greedy skip. */
export const INSURANCE_UPTAKE = 0.65;

/**
 * Gold taken at the gate is gold they cannot spend on surviving your dungeon.
 *
 * That is the whole decision (§20): charge at the door and bank it before
 * anything can go wrong, or leave it in their purse so they can buy healing,
 * Kit and rescues — all of which are also your revenue, and all of which keep
 * them alive to tell the story that pays Renown (§15.3, §19.4).
 */
export function admissionPrice(tier: number, mult: number): number {
  return Math.round(ADMISSION_BASE * tier * mult);
}

/**
 * Hired NPC shopkeeper (§8.4). Purely optional revenue, never a requirement.
 *
 * Amenities used to be dead until staffed, which meant paying Mana to build a
 * thing and then Gold to switch it on — two tolls for one shop, and the second
 * one (250g) cost more than a whole season's income. Now every amenity trades
 * the moment it is built; a body behind the counter is an upsell.
 */
export const HIRED_STAFF_COST = 70;

/** Revenue multiplier for a staffed counter — the reason to bother (§8.4). */
export const STAFFED_REVENUE_MULT = 1.35;

/** @deprecated Read `AMENITIES[id].healPct` — kept so old callers still build. */
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
  /**
   * How this tier's delves engage a room (§7.2).
   *
   * The second escalation axis on the table, and the one that is about
   * *organisation* rather than stats. Everyone files in one at a time until the
   * dungeon is famous enough to be worth mounting a real expedition against.
   */
  formation: Formation;
}

/**
 * Prototype runs tiers 1-4 (§12), but the full table is here for the balance runner.
 *
 * **`formation` flips at Tier 4.** Below it, a delve is a queue: three or four
 * people arrive together and take turns holding the door, so a starting dungeon
 * fights one adventurer at a time and a room that would fall in four ticks
 * takes twelve. At Tier 4 — 140 Renown, which is a dungeon with a reputation —
 * organised companies start coming, and the same party size hits all at once.
 * That is deliberately the single largest step change on the table: it is the
 * moment the player finds out whether the dungeon they built was actually good
 * or merely arithmetic-proof.
 *
 * Tier 4 rather than later because the prototype caps at Tier 4
 * (`MAX_TIER_PROTOTYPE`) — a milestone the player can never reach is not a
 * milestone, it is a comment.
 */
export const TIERS: TierRow[] = [
  { tier: 1, renown: 0, partySize: 3, levelMin: 1, levelMax: 2, gold: 25, manaBonus: 0, formation: 'single-file' },
  { tier: 2, renown: 66, partySize: 3, levelMin: 3, levelMax: 4, gold: 45, manaBonus: 25, formation: 'single-file' },
  { tier: 3, renown: 165, partySize: 4, levelMin: 5, levelMax: 6, gold: 65, manaBonus: 55, formation: 'single-file' },
  { tier: 4, renown: 308, partySize: 4, levelMin: 7, levelMax: 8, gold: 85, manaBonus: 95, formation: 'party' },
  { tier: 5, renown: 506, partySize: 4, levelMin: 9, levelMax: 11, gold: 105, manaBonus: 140, formation: 'party' },
  { tier: 6, renown: 770, partySize: 5, levelMin: 12, levelMax: 14, gold: 125, manaBonus: 195, formation: 'party' },
  { tier: 7, renown: 1100, partySize: 5, levelMin: 15, levelMax: 17, gold: 145, manaBonus: 255, formation: 'party' },
  { tier: 8, renown: 1540, partySize: 5, levelMin: 18, levelMax: 21, gold: 165, manaBonus: 325, formation: 'party' },
  { tier: 9, renown: 2090, partySize: 5, levelMin: 22, levelMax: 25, gold: 185, manaBonus: 405, formation: 'party' },
  { tier: 10, renown: 2750, partySize: 5, levelMin: 26, levelMax: 30, gold: 205, manaBonus: 495, formation: 'party' },
];

/**
 * Highest Threat Tier that can be reached.
 *
 * Was 4, a §12 scoping decision made before any of the escalation systems
 * existed — and it silently capped the difficulty while the dungeon kept
 * growing, so a sufficiently built dungeon became unbeatable BY CONSTRUCTION.
 * The genetic search found it immediately: 100% season survival at 773 Renown,
 * every generation, because nothing stronger could ever arrive.
 *
 * The Renown ratchet is the whole premise of §15. It cannot have a ceiling
 * below the top of the tier table.
 */
export const MAX_TIER_PROTOTYPE = 40;

/** Player-facing copy for each formation, shared by the UI and the forecast. */
export const FORMATION_INFO: Record<Formation, {
  label: string;
  short: string;
  blurb: string;
}> = {
  'single-file': {
    label: 'Single file',
    short: 'one at a time',
    blurb: 'They arrive, descend and rest together, but only one of them '
      + 'fights at a time. Your monsters face the front of a queue.',
  },
  party: {
    label: 'Coordinated party',
    short: 'all at once',
    blurb: 'An organised company. Every one of them engages at once — the same '
      + 'people, three times the damage into your rooms.',
  },
};

/** The first tier that fields a given formation, or undefined if none does. */
export function firstTierWithFormation(f: Formation): TierRow | undefined {
  return TIERS.find((t) => t.formation === f);
}

/**
 * Threat Tiers past the end of the table (§4.4).
 *
 * The table stops at 10, and once a run maxes it escalation stops — a
 * sufficiently upgraded dungeon then holds forever. That is the §25 ceiling
 * bug again, four tiers higher: measured under endless, a depth build sat at
 * Tier 9 for 94 raids without being threatened.
 *
 * Beyond the table, tiers are generated: levels keep climbing, purses keep
 * growing, party size holds at 5 because a room can only hold so many people
 * (§18.2) and the pressure should come from quality, not a crowd.
 */
function generatedTier(tier: number): TierRow {
  const last = TIERS[TIERS.length - 1]!;
  const over = tier - last.tier;
  return {
    tier,
    renown: last.renown + over * 400,
    partySize: last.partySize,
    levelMin: last.levelMin + over * 4,
    levelMax: last.levelMax + over * 4,
    gold: Math.round(last.gold * 1.18 ** over),
    manaBonus: Math.round(last.manaBonus * 1.22 ** over),
    formation: last.formation,
  };
}

export function tierAt(tier: number): TierRow {
  return TIERS[tier - 1] ?? generatedTier(tier);
}

export function tierForRenown(renown: number, cap = MAX_TIER_PROTOTYPE): TierRow {
  let row = TIERS[0]!;
  for (const t of TIERS) {
    if (renown >= t.renown && t.tier <= cap) row = t;
  }
  // Past the table, keep generating. `cap` still bounds it so a caller that
  // wants the prototype's ceiling can still ask for one.
  for (let tier = TIERS.length + 1; tier <= cap; tier++) {
    const gen = generatedTier(tier);
    if (renown >= gen.renown) row = gen; else break;
  }
  return row;
}

// ─── Economy (§4) ────────────────────────────────────────────────────────────

/**
 * Mana per adventurer killed.
 *
 * Was 3, which made kills 7% of income — a full season of them paid less than
 * half an Ogre while the dungeon bled 1–8 monsters a raid. Predation has to
 * fund the predator or the whole build phase runs a deficit.
 */
export const MANA_PER_KILL = 12;
export const SOULS_PER_KILL = 2;
/**
 * Souls for putting an adventurer on the floor rather than in the ground.
 *
 * §19 made kills rare by design and Souls come only from kills, so the upgrade
 * currency dried up to ~10 a season. The dungeon still won that fight.
 */
export const SOULS_PER_DOWN = 1;
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

/**
 * §9.2's roster. **Each trait invalidates a strategy — they are counter-play,
 * not stat spikes.** The `statMult` is deliberately small; the trait is the
 * content. If a named adventurer is only "the same person with more HP", the
 * player has learned nothing about their own dungeon by meeting them.
 *
 * `Halden Torch` is absent: his trait is "dispels one floor effect on entry"
 * and floor effects (§5.3) are out of prototype scope, so there is nothing for
 * him to counter. Inventing a substitute trait would make the doc a lie.
 */
export const NAMED: Record<string, NamedDef> = {
  berrick: {
    id: 'berrick',
    name: 'Berrick the Unfed',
    trait: 'Ignores Kit thresholds when deciding to descend.',
    minTier: 3,
    appearChance: 0.35,
    statMult: 1.25,
  },
  ivane: {
    id: 'ivane',
    name: 'Sister Ivane',
    trait: 'Restores 1 Kit to the party on entering each floor.',
    minTier: 3,
    appearChance: 0.22,
    statMult: 1.1,
  },
  twins: {
    id: 'twins',
    name: 'The Quiet Twins',
    trait: 'Split the party down two paths — your monsters hit at reduced density.',
    minTier: 3,
    appearChance: 0.18,
    statMult: 1.1,
  },
  vess: {
    id: 'vess',
    name: 'Marrow-Knight Vess',
    trait: 'Immune to Resolve damage. Terror does nothing.',
    minTier: 4,
    appearChance: 0.22,
    statMult: 1.2,
  },
  sable: {
    id: 'sable',
    name: 'Coin-Cutter Sable',
    trait: 'Pays half price at amenities, and lifts gold from every Landing.',
    minTier: 4,
    appearChance: 0.22,
    statMult: 1.1,
  },
  oros: {
    id: 'oros',
    name: 'Guildmaster Oros',
    trait: 'The party leaves on his order alone — never triggers the Descent Decision.',
    // Late-tier only, by design. The prototype caps at Tier 4
    // (MAX_TIER_PROTOTYPE), so Oros is implemented but unreachable until the
    // tier cap lifts — he is here so the roster is complete, not as content.
    minTier: 7,
    appearChance: 0.3,
    statMult: 1.4,
  },
};

// ─── Learned traits (§9.3) ───────────────────────────────────────────────────

export interface LearnedDef {
  id: string;
  name: string;
  /** What it does, for the narrator and the UI. */
  blurb: string;
  /** The build it exists to punish. */
  counters: string;
}

/**
 * What an adventurer takes home from a delve they barely walked out of.
 *
 * The mapping from grudge → trait is *deterministic*, and that is the design.
 * A random second trait would be a stat spike wearing a story; a trait chosen
 * by what your dungeon did to them means the counter-play is something the
 * player built themselves. Drain them and they come back stocked. Crush them
 * with an Ogre and they come back armoured. Break their nerve and they come
 * back braver. The dungeon teaches its own opposition.
 */
export const LEARNED: Record<string, LearnedDef> = {
  provisioned: {
    id: 'provisioned', name: 'Provisioned',
    blurb: 'Carries a deeper pack — adds Kit to the party.',
    counters: 'Kit drain (Wardens, Rust Ooze)',
  },
  armored: {
    id: 'armored', name: 'Plated',
    blurb: 'Wears heavier plate — flat damage reduction.',
    counters: 'Bruiser burst (Ogre, Skeleton)',
  },
  hale: {
    id: 'hale', name: 'Hale',
    blurb: 'Came back thicker — more max HP.',
    counters: 'Swarms and chip damage',
  },
  steeled: {
    id: 'steeled', name: 'Steeled',
    blurb: 'Has seen worse — more Resolve, and loses it half as fast.',
    counters: 'Terror and morale builds',
  },
  haggler: {
    id: 'haggler', name: 'Haggler',
    blurb: 'Knows what your prices should be — pays less at every amenity.',
    counters: 'Commerce builds',
  },
};

/** Grudge → the trait it teaches. The player's dungeon picks this, not the RNG. */
export const GRUDGE_TRAIT: Record<string, string> = {
  supplies: 'provisioned',
  muscle: 'armored',
  swarm: 'hale',
  nerve: 'steeled',
  coin: 'haggler',
};

/** Human-readable "why they came back" — the narrator wants this text. */
export const GRUDGE_BLURB: Record<string, string> = {
  supplies: 'left your dungeon with an empty pack',
  muscle: 'was nearly broken in half down there',
  swarm: 'was bled dry a scratch at a time',
  nerve: 'ran, and remembers running',
  coin: 'paid your prices once too often',
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

/**
 * Endless: raid until the Core falls (§12a).
 *
 * The 8-raid cap is a prototype convenience, not a design position — §3 calls a
 * season a run, and a roguelite run should end because you lost, not because a
 * counter ran out. Endless lets the Renown ratchet keep climbing until it beats
 * you, which is the only honest test of whether the ratchet is tuned.
 */
export const ENDLESS_RAIDS = Number.POSITIVE_INFINITY;

/**
 * Hard stop for an endless run.
 *
 * Not a design limit — a safety rail so tooling cannot spin forever on a build
 * the ratchet never catches. If a run reaches this, the ratchet is broken, and
 * that is worth knowing rather than hanging on.
 */
export const ENDLESS_SAFETY_CAP = 200;

/**
 * Raids before the Threat Tier floor rises by one, regardless of Renown.
 *
 * Renown is the player's dial (§20.3) and that is the point — but in an endless
 * run a dial that can be turned to zero is a permanent stall. Measured: gouging
 * the gate froze the tier at 3.0 and a build with level-8 monsters ran to the
 * 200-raid safety cap without ever being threatened.
 *
 * A dungeon that has been open for thirty raids is known about whether or not
 * anyone enjoyed it. Word gets around on its own; the dial changes how fast,
 * not whether.
 */
export const TIER_FLOOR_RAIDS = 6;

/** The tier a run is at least at, from how long it has been running. */
export function tierFloorFromRaids(raidNumber: number): number {
  return 1 + Math.floor((raidNumber - 1) / TIER_FLOOR_RAIDS);
}
