/**
 * Party generation (§9.1). Pure function of (rng, tier) — no hidden state.
 */
import {
  ADV_ARMOR_PER_LEVEL, ADV_BASE_DMG, ADV_BASE_HP, ADV_KIT_BASE,
  ADV_MAX_RESOLVE, CLASS_MODS, CLASS_WEIGHTS, EPITHETS, FIRST_NAMES, NAMED,
  TUNING, type TierRow,
} from './data';
import type { Rng } from './rng';
import type { Adventurer, AdventurerClass, Party } from './types';

function makeAdventurer(
  rng: Rng,
  id: number,
  cls: AdventurerClass,
  level: number,
  gold: number,
  namedId: string | null,
): Adventurer {
  const mod = CLASS_MODS[cls];
  const named = namedId ? NAMED[namedId] : undefined;
  const mult = named?.statMult ?? 1;

  const maxHp = Math.round((ADV_BASE_HP + TUNING.advHpPerLevel * level) * mod.hp * mult);
  const dmg = (ADV_BASE_DMG + TUNING.advDmgPerLevel * level) * mod.dmg * mult;
  const name = named
    ? named.name
    : `${rng.pick(FIRST_NAMES)} ${rng.pick(EPITHETS)}`;

  return {
    id,
    name,
    cls,
    level,
    maxHp,
    hp: maxHp,
    dmg,
    armor: level * ADV_ARMOR_PER_LEVEL,
    maxResolve: ADV_MAX_RESOLVE,
    resolve: ADV_MAX_RESOLVE,
    gold: Math.round(gold * (named ? 1.5 : 1)),
    greed: rng.float(0, 0.15) + mod.greed,
    alive: true,
    namedId,
    lowestHpPct: 1,      // TODO(§15.3): tracked during the delve
    veteranId: null,     // TODO(§15.5): set when a Veteran returns
  };
}

/**
 * Roll a party for a threat tier. Guarantees at least one fighter at size >= 3
 * so generic parties aren't accidentally made of glass.
 */
export function generateParty(rng: Rng, tier: TierRow): Party {
  const size = tier.partySize;
  const members: Adventurer[] = [];

  // Named adventurers roll first so they occupy a real slot rather than adding one.
  let namedId: string | null = null;
  for (const def of Object.values(NAMED)) {
    if (tier.tier >= def.minTier && rng.chance(def.appearChance)) {
      namedId = def.id;
      break;
    }
  }

  for (let i = 0; i < size; i++) {
    const level = rng.int(tier.levelMin, tier.levelMax);
    let cls: AdventurerClass;
    if (i === 0 && size >= 3) {
      cls = 'fighter';
    } else {
      cls = rng.weighted(CLASS_WEIGHTS);
    }
    const gold = Math.round(tier.gold * rng.float(0.8, 1.2));
    members.push(makeAdventurer(rng, i, cls, level, gold, i === 0 ? namedId : null));
  }

  const maxKit = (ADV_KIT_BASE + tier.tier) * size;

  return { members, kit: maxKit, maxKit, tier: tier.tier };
}

export function aliveMembers(party: Party): Adventurer[] {
  return party.members.filter((m) => m.alive);
}

export function partyHasNamed(party: Party, namedId: string): boolean {
  return party.members.some((m) => m.namedId === namedId && m.alive);
}

export function avgHpPct(party: Party): number {
  const alive = aliveMembers(party);
  if (alive.length === 0) return 0;
  return alive.reduce((s, m) => s + m.hp / m.maxHp, 0) / alive.length;
}

export function avgResolvePct(party: Party): number {
  const alive = aliveMembers(party);
  if (alive.length === 0) return 0;
  return alive.reduce((s, m) => s + m.resolve / m.maxResolve, 0) / alive.length;
}

export function partyGold(party: Party): number {
  return aliveMembers(party).reduce((s, m) => s + m.gold, 0);
}
