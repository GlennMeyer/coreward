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
  CLASS_WEIGHTS, DESCEND_HP_THRESHOLD, MOBS, NAMED, PRICE_TIERS, TIERS, TRAPS,
  TUNING, trapPower, type TierRow,
} from '../sim/data';
import {
  armedTrapsInRoom, getMob, isOpen, mobEffectiveDmg, mobEffectiveHp,
  packMultiplier,
} from '../sim/dungeon';
import { perilGate as perilGateFraction, thrillFromParts } from '../sim/raid';
import type { Dungeon, Formation, Mob, ThrillScore, Veteran } from '../sim/types';

/**
 * How many of the party are swinging at any one moment (§7.2).
 *
 * Single-file is one, whatever the party size — which is the single biggest
 * term in any honest "are we ready?" comparison, and the reason the forecast
 * cannot just multiply by headcount any more.
 */
function engagedCount(tier: TierRow): number {
  return tier.formation === 'party' ? tier.partySize : 1;
}

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

/**
 * Roles the variety component counts against. Must track the sim's own cap.
 * The prototype bestiary only fields three (skirmisher, bruiser, warden), so a
 * cap of four would make full marks unreachable — see the note in §15.3.
 */
const VARIETY_ROLES = 3;

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

/**
 * Multiset of what is in a room — the identity Tedium compares (§15.3).
 *
 * ARMED traps only, matching the sim: a spent trap is a hole in the floor, and
 * a room whose only occupant is a hole in the floor is an empty room.
 */
function roomSignature(d: Dungeon, floor: number, room: number): string {
  const r = d.floors[floor]?.rooms[room];
  if (!r) return '';
  return [
    ...r.mobUids
      .map((uid) => getMob(d, uid))
      .filter((m): m is Mob => !!m && m.alive)
      .map((m) => m.defId),
    ...armedTrapsInRoom(d, floor, room).map((t) => `trap:${t.defId}`),
  ].sort().join('+');
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
  // ...but only the *engaged* swing (§7.2). Under single-file that is one
  // person however many arrived, so the room takes `size` times longer to
  // clear and the party absorbs `size` times the damage doing it. Nothing else
  // in this model moves as much as this line does.
  const poolDps = engagedCount(tier)
    * (ADV_BASE_DMG + TUNING.advDmgPerLevel * level) * AVG.dmg;
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
  // Distinct trap jobs on the route, but capped exactly as the sim caps them —
  // the whole trap layer is worth `trapVarietyCredit` toward variety and no
  // more. See `RaidSim.varietyScore` for why.
  const trapJobs = new Set<string>();
  let armedTraps = 0;
  for (let fi = 0; fi < d.floors.length; fi++) {
    for (let ri = 0; ri < (d.floors[fi]?.rooms.length ?? 0); ri++) {
      for (const t of armedTrapsInRoom(d, fi, ri)) {
        trapJobs.add(TRAPS[t.defId]!.job);
        armedTraps++;
      }
    }
  }

  outer: for (let fi = 0; fi < d.floors.length; fi++) {
    const rooms = d.floors[fi]?.rooms.length ?? 0;
    for (let ri = 0; ri < rooms; ri++) {
      const mobs = livingMobsInRoom(d, fi, ri);
      const traps = armedTrapsInRoom(d, fi, ri);
      const sig = roomSignature(d, fi, ri);

      // Traps go off on the threshold, before anything swings — and they are
      // the whole reason a room with no monster in it need not be a corridor.
      for (const t of traps) {
        const def = TRAPS[t.defId]!;
        const power = trapPower(t.defId);
        if (def.job === 'damage') hp -= (power * size) / poolHp;
        else if (def.job === 'burst') hp -= power / poolHp;
        else if (def.job === 'kit') kit = Math.max(0, kit - power);
        lowest = Math.min(lowest, Math.max(0, hp));
      }

      if (mobs.length === 0 && traps.length === 0) {
        emptyRooms++;
        prevSig = '';
        continue;
      }
      if (sig === prevSig) repeatedRooms++;
      prevSig = sig;
      if (mobs.length === 0) continue;

      const roomHp = mobs.reduce((s, m) => s + mobEffectiveHp(d, m), 0);
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
        const raw = mobEffectiveDmg(d, m) * packMultiplier(m, mobs.length);
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
  // Absolute, not a completion ratio: floors_cleared / floors_in_dungeon is
  // maximised by owning the smallest dungeon, which made digging a penalty.
  const depth = Math.min(1, floorsReached / TUNING.thrillDepthFloors);
  const trapCredit = Math.min(trapJobs.size, TUNING.trapVarietyCredit);
  const variety = Math.min(1, (roles.size + trapCredit) / VARIETY_ROLES);
  const comfort = Math.min(1, comfortRaw / Math.max(1, d.landings.length));
  const tedium = TUNING.tediumPerEmptyRoom * emptyRooms
    + TUNING.tediumPerRepeatedRoom * repeatedRooms;

  // Call the sim's own formula rather than restating it — keeping two copies
  // of the arithmetic in sync is exactly how this estimator went stale before.
  const total = thrillFromParts({ peril, depth, variety, comfort, tedium });

  const warnings: ThrillWarning[] = [];
  const placed = d.mobs.filter((m) => m.alive && m.placement.kind === 'room').length;

  if (placed === 0 && armedTraps === 0) {
    warnings.push({ level: 'bad', text: 'Nothing is defending the dungeon. They walk to the Core.' });
  }
  const spent = d.traps?.filter(
    (t) => t.placement.kind === 'room' && t.charges < (TRAPS[t.defId]?.charges ?? 1),
  ).length ?? 0;
  if (spent > 0) {
    warnings.push({
      level: 'bad',
      text: `${spent} trap${spent === 1 ? ' is' : 's are'} spent and will do nothing. `
        + 'Re-arm before the raid — an unarmed trap is an empty room.',
    });
  }
  if (placed === 0 && armedTraps > 0) {
    warnings.push({
      level: 'warn',
      text: 'Traps only, no monsters. They soften and delay; nothing down there can finish anyone.',
    });
  }
  if (lethal) {
    warnings.push({
      level: 'bad',
      text: 'Looks lethal — they probably die here. Dead adventurers carry no story, and a wipe pays no Renown.',
    });
  } else if (peril < TUNING.thrillPerilGate && placed > 0) {
    const gate = Math.round(perilGateFraction(peril) * 100);
    warnings.push({
      level: 'bad',
      text: `They stroll out barely scratched — depth, variety and comfort are `
        + `only paying ${gate}% until peril reaches ${TUNING.thrillPerilGate.toFixed(2)}. `
        + `A long safe dungeon is a kiddie ride.`,
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
  if (roles.size + trapCredit < VARIETY_ROLES && placed > 0) {
    warnings.push({
      level: 'warn',
      text: `Only ${roles.size} monster role${roles.size === 1 ? '' : 's'} down there`
        + `${trapCredit > 0 ? ', plus the machinery' : ''}. Variety counts ${VARIETY_ROLES}, `
        + 'and traps together are worth one of them however many you install.',
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

// ─── Next-raid forecast (what is coming, and are we ready) ───────────────────

export interface Forecast {
  tier: number;
  partySize: number;
  /** How they engage a room (§7.2) — the other half of "what is coming". */
  formation: Formation;
  /** How many of them swing at once. 1 under single-file, whatever arrives. */
  engaged: number;
  /**
   * The formation-change ahead of the player, if there is one: the tier that
   * first fields it and the Renown that unlocks it. The player must be able to
   * see an organised company coming *before* it arrives, because "ready" means
   * something entirely different against one.
   */
  nextFormation: {
    formation: Formation;
    tier: number;
    renown: number;
    /** Renown still to earn. 0 means the very next raid could be it. */
    renownAway: number;
  } | null;
  levelMin: number;
  levelMax: number;
  /** Total HP the party brings, including Kit sustain — see below. */
  partyHp: number;
  partyDmg: number;
  /** Kit roughly doubles effective health (§14.4), so it belongs in the total. */
  partyKit: number;
  partyEffectiveHp: number;
  /** What the dungeon can field right now. */
  dungeonHp: number;
  dungeonDmg: number;
  /** Monsters standing in rooms, and monsters behind shop counters (§8.4). */
  defenders: number;
  staffed: number;
  /** dungeonPower / partyPower. 1.0 is a coin flip. */
  ratio: number;
  verdict: 'outmatched' | 'thin' | 'even' | 'strong' | 'overwhelming';
  namedIncoming: string[];
}

const VERDICTS: readonly (readonly [number, Forecast['verdict']])[] = [
  [0, 'outmatched'],
  [0.5, 'thin'],
  [0.85, 'even'],
  [1.3, 'strong'],
  [2.0, 'overwhelming'],
];

/**
 * A rough "are we ready?" readout for the next raid (team vs team).
 *
 * Deliberately a power ratio rather than a win probability: the sim decides
 * raids with targeting, Kit spending, rest and the Descent Decision, none of
 * which a single number can capture. This tells the player whether they are in
 * the right weight class, not what will happen.
 */
/**
 * `renown` is the player's current total, used only to say how far away the
 * next formation change is. Omitted, the countdown is reported as the full
 * threshold.
 */
export function forecast(d: Dungeon, tier: TierRow, renown = 0): Forecast {
  const size = tier.partySize;
  const level = (tier.levelMin + tier.levelMax) / 2;
  const engaged = engagedCount(tier);

  const partyHp = size * (ADV_BASE_HP + TUNING.advHpPerLevel * level) * AVG.hp;
  // Only the engaged swing (§7.2). A single-file queue of four brings a
  // quarter of the damage into any given room, and telling the player
  // otherwise would make the whole readout a lie in the direction that gets
  // dungeons overbuilt.
  const partyDmg = engaged * (ADV_BASE_DMG + TUNING.advDmgPerLevel * level) * AVG.dmg;
  const partyKit = (ADV_KIT_BASE + tier.tier) * size;
  // Each Kit is a heal worth kitHealPct of one member's max HP (§7.3, §14.4).
  const perMemberHp = partyHp / size;
  const partyEffectiveHp = partyHp + partyKit * perMemberHp * TUNING.kitHealPct;

  let dungeonHp = 0;
  let dungeonDmg = 0;
  let defenders = 0;
  let staffed = 0;
  for (const m of d.mobs) {
    if (!m.alive) continue;
    if (m.placement.kind === 'amenity') { staffed++; continue; }
    if (m.placement.kind !== 'room') continue;
    defenders++;
    dungeonHp += mobEffectiveHp(d, m);
    const def = MOBS[m.defId]!;
    // Terrors break nerve rather than bodies, so they do not count as damage.
    if (def.role !== 'terror') dungeonDmg += mobEffectiveDmg(d, m) * def.spd;
  }

  // Geometric mean of the two ratios: a dungeon that is all HP and no damage
  // (or the reverse) is not actually ready, and averaging would hide that.
  const hpRatio = dungeonHp / Math.max(1, partyEffectiveHp);
  const dmgRatio = dungeonDmg / Math.max(1, partyDmg);
  const ratio = Math.sqrt(Math.max(0, hpRatio) * Math.max(0, dmgRatio));

  let verdict: Forecast['verdict'] = 'outmatched';
  for (const [floor, name] of VERDICTS) if (ratio >= floor) verdict = name;

  const namedIncoming = Object.values(NAMED)
    .filter((n) => tier.tier >= n.minTier)
    .map((n) => n.name);

  // The next tier on the table that engages differently. Deliberately the next
  // *change*, not the next tier: "they will be level 9 instead of 7" is a
  // gradient the player can absorb, and "they will all attack at once" is not.
  const ahead = TIERS.find(
    (t) => t.tier > tier.tier && t.formation !== tier.formation,
  );

  return {
    tier: tier.tier,
    partySize: size,
    formation: tier.formation,
    engaged,
    nextFormation: ahead
      ? {
        formation: ahead.formation,
        tier: ahead.tier,
        renown: ahead.renown,
        renownAway: Math.max(0, ahead.renown - renown),
      }
      : null,
    levelMin: tier.levelMin,
    levelMax: tier.levelMax,
    partyHp: Math.round(partyHp),
    partyDmg: Math.round(partyDmg),
    partyKit,
    partyEffectiveHp: Math.round(partyEffectiveHp),
    dungeonHp: Math.round(dungeonHp),
    dungeonDmg: Math.round(dungeonDmg),
    defenders,
    staffed,
    ratio,
    namedIncoming,
    verdict,
  };
}

/** Returning faces the player has seen before (§15.5) — flavour for the forecast. */
export function returningCount(veterans: Veteran[]): number {
  return veterans.filter((v) => !v.retired).length;
}
