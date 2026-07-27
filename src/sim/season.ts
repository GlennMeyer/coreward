/**
 * Season orchestration and the Aftermath economy (§3, §4).
 */
import {
  GRUDGE_TRAIT, MAX_TIER_PROTOTYPE, SEASON_RAIDS, TUNING, tierForRenown,
  type TierRow,
} from './data';
import {
  canReturn, isNemesis, isPatron, makeVeteran,
} from './adventurers';
import { createDungeon, healAllMobs, totalUpkeep } from './dungeon';
import { RaidSim } from './raid';
import type { Adventurer, RaidResult, SeasonState, Veteran } from './types';

export function createSeason(seed: number): SeasonState {
  return {
    seed,
    raidNumber: 1,
    totalRaids: SEASON_RAIDS,
    mana: TUNING.startingMana,
    souls: 0,
    gold: TUNING.startingGold,
    renown: 0,
    dungeon: createDungeon(),
    veterans: [],
    nextVeteranId: 1,
    legends: [],
    over: false,
    ending: null,
    log: [],
  };
}

export function currentTier(s: SeasonState): TierRow {
  return tierForRenown(s.renown, MAX_TIER_PROTOTYPE);
}

/**
 * Raids are seeded from (season seed, raid number) so a given raid is
 * reproducible independently of how the previous ones played out.
 */
export function raidSeed(s: SeasonState): number {
  return (Math.imul(s.seed, 0x9e3779b1) ^ Math.imul(s.raidNumber, 0x85ebca6b)) >>> 0;
}

export function startRaid(s: SeasonState): RaidSim {
  healAllMobs(s.dungeon);
  // The roster goes in by reference: returning faces are drawn from it during
  // party generation, and retirees are struck off it at raid end (§15.5).
  return new RaidSim(s.dungeon, currentTier(s), raidSeed(s), s.veterans);
}

export interface Aftermath {
  result: RaidResult;
  manaIncome: number;
  manaBreakdown: {
    base: number;
    floors: number;
    kills: number;
    /** Mana drawn from the quality of the delve itself (§15.3). */
    thrill: number;
    tierBonus: number;
    upkeep: number;
  };
  tierBefore: number;
  tierAfter: number;
  seasonOver: boolean;
}

/**
 * Fold the raid's survivors into the persistent roster (§15.5).
 *
 * Anyone who walks out becomes — or stays — a Veteran, so they can come back
 * with a name you recognise. Anyone who retired is struck off and hung on the
 * wall as a Legend instead. The dead are simply gone.
 */
function recordVeterans(s: SeasonState, sim: RaidSim, result: RaidResult): void {
  const retiredNames = new Set(result.retired.map((l) => l.name));
  const noteFor = (adv: Adventurer) => result.rivals.find((r) => r.advId === adv.id);

  for (const adv of sim.party.members) {
    let vet: Veteran | undefined = adv.veteranId !== null
      ? s.veterans.find((v) => v.id === adv.veteranId)
      : undefined;

    // The dead are struck off. Without this a Nemesis you finally killed walks
    // straight back in next raid, which makes the whole track meaningless.
    if (!adv.alive) {
      if (vet) vet.dead = true;
      continue;
    }

    const thrill = sim.survivorThrill.get(adv.id) ?? 0;

    if (!vet) {
      vet = makeVeteran(s.nextVeteranId++, adv.name, adv.cls, adv.namedId);
      s.veterans.push(vet);
    }

    vet.delves++;
    vet.bestThrill = Math.max(vet.bestThrill, Math.round(thrill));

    // ── The Nemesis track (§9.3) ──
    // They walked out. That is the counter, and it is the same event the
    // Renown formula pays for — every escapee is reputation now and opposition
    // later, which is exactly the trade §15 wanted the player to feel.
    const wasNemesis = isNemesis(vet);
    vet.escapes = (vet.escapes ?? 0) + 1;
    if (adv.grudge) {
      vet.lastGrudge = adv.grudge;
      const traits = (vet.traits ??= []);
      const trait = GRUDGE_TRAIT[adv.grudge]!;
      if (!traits.includes(trait) && traits.length < TUNING.maxLearnedTraits) {
        traits.push(trait);
      }
    }

    // ── The Patron track (§9.4) ──
    // Deliberately independent of the above: nothing here reads `escapes`, and
    // nothing above reads `bigSpends`. §9.4's last paragraph is a *property of
    // the data model*, not a special case — the same person can be climbing
    // both ladders, becoming more profitable and more dangerous at once.
    const wasPatron = isPatron(vet);
    vet.goldSpent = (vet.goldSpent ?? 0) + adv.goldSpentHere;
    if (adv.startGold > 0
      && adv.goldSpentHere >= adv.startGold * TUNING.patronSpendFraction) {
      vet.bigSpends = (vet.bigSpends ?? 0) + 1;
    }
    // The floor that nearly killed them. Kept fresh every visit — a Patron's
    // caution tracks the last place they bled, not the first.
    if (adv.nearDeathFloor !== null) vet.cautiousFloor = adv.nearDeathFloor;

    // The sim already flipped `retired` for anyone it retired; belt and braces
    // for a first-time face who somehow qualified without a Veteran record.
    if (retiredNames.has(adv.name)) vet.retired = true;

    const note = noteFor(adv);
    if (note) {
      note.veteranId = vet.id;
      note.becameNemesis = !wasNemesis && isNemesis(vet);
      note.becamePatron = !wasPatron && isPatron(vet);
      note.escapes = vet.escapes ?? 0;
      note.bigSpends = vet.bigSpends ?? 0;
    }
  }

  for (const legend of result.retired) {
    legend.retiredOnRaid = s.raidNumber;   // the sim has no raid counter
    s.legends.push(legend);
  }
}

/** Living Patrons on the roster — a standing income stream, and a standing tax. */
export function activePatrons(s: SeasonState): Veteran[] {
  return s.veterans.filter((v) => canReturn(v) && isPatron(v));
}

/** Living Nemeses on the roster. These are the faces the player is afraid of. */
export function activeNemeses(s: SeasonState): Veteran[] {
  return s.veterans.filter((v) => canReturn(v) && isNemesis(v));
}

/**
 * Apply a finished raid to the season. Mutates `s`.
 *
 * Note upkeep is charged whatever happens — a dungeon full of idle monsters
 * bleeds mana even on a quiet raid, which is the pressure valve on overbuilding.
 */
export function applyAftermath(s: SeasonState, sim: RaidSim): Aftermath {
  const result = sim.result;
  const tierBefore = currentTier(s).tier;

  const base = TUNING.manaBaseIncome;
  const floors = s.dungeon.floors.length * TUNING.manaPerFloor;
  const kills = sim.manaFromKills;
  const thrill = Math.round(result.thrill.total * TUNING.manaPerThrill);
  const tierBonus = currentTier(s).manaBonus;
  const upkeep = totalUpkeep(s.dungeon);
  const manaIncome = base + floors + kills + thrill + tierBonus - upkeep;

  // Legends already on the wall pay out before this raid's retirees join them —
  // you do not get the trickle on the same raid you earned the Legend (§15.5).
  if (TUNING.thrillRenown) {
    result.renown += s.legends.length * TUNING.legendRenownTrickle;
  }
  // SUBSTITUTION for §9.4's "+3 Insight at season end while alive": a Patron
  // talks about your dungeon, and talk is Renown. Counted before this raid is
  // folded in, for the same reason Legends are — and note that Renown is the
  // difficulty dial (§4.4), so keeping a Patron alive raises the tier of
  // everyone who follows them in. The income stream has a price.
  result.renown += activePatrons(s).length * TUNING.patronRenownTrickle;

  recordVeterans(s, sim, result);

  s.mana = Math.max(0, s.mana + manaIncome);
  s.souls += result.souls;
  s.gold += result.goldFromSales + result.goldFromCorpses
    + result.goldFromRescues + result.goldFromAdmission + result.goldFromInsurance;
  s.renown += result.renown;
  s.log.push(result);

  const tierAfter = currentTier(s).tier;

  if (s.dungeon.hearts <= 0) {
    s.over = true;
    s.ending = 'overrun';
  } else if (s.raidNumber >= s.totalRaids) {
    s.over = true;
    s.ending = 'survived';
  } else {
    s.raidNumber++;
  }

  return {
    result,
    manaIncome,
    manaBreakdown: { base, floors, kills, thrill, tierBonus, upkeep },
    tierBefore,
    tierAfter,
    seasonOver: s.over,
  };
}
