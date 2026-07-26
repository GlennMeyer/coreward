/**
 * Season orchestration and the Aftermath economy (§3, §4).
 */
import {
  MAX_TIER_PROTOTYPE, SEASON_RAIDS, TUNING, tierForRenown, type TierRow,
} from './data';
import { createDungeon, healAllMobs, totalUpkeep } from './dungeon';
import { RaidSim } from './raid';
import type { RaidResult, SeasonState } from './types';

export function createSeason(seed: number): SeasonState {
  return {
    seed,
    raidNumber: 1,
    totalRaids: SEASON_RAIDS,
    mana: TUNING.startingMana,
    souls: 0,
    gold: 0,
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
  return new RaidSim(s.dungeon, currentTier(s), raidSeed(s));
}

export interface Aftermath {
  result: RaidResult;
  manaIncome: number;
  manaBreakdown: {
    base: number;
    floors: number;
    kills: number;
    tierBonus: number;
    upkeep: number;
  };
  tierBefore: number;
  tierAfter: number;
  seasonOver: boolean;
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
  const tierBonus = currentTier(s).manaBonus;
  const upkeep = totalUpkeep(s.dungeon);
  const manaIncome = base + floors + kills + tierBonus - upkeep;

  s.mana = Math.max(0, s.mana + manaIncome);
  s.souls += result.souls;
  s.gold += result.goldFromSales + result.goldFromCorpses;
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
    manaBreakdown: { base, floors, kills, tierBonus, upkeep },
    tierBefore,
    tierAfter,
    seasonOver: s.over,
  };
}
