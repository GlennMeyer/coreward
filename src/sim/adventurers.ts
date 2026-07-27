/**
 * Party generation (§9.1). Pure function of (rng, tier) — no hidden state.
 */
import {
  ADV_ARMOR_PER_LEVEL, ADV_BASE_DMG, ADV_BASE_HP, ADV_KIT_BASE,
  ADV_MAX_RESOLVE, CLASS_MODS, CLASS_WEIGHTS, EPITHETS, FIRST_NAMES, NAMED,
  TUNING, type TierRow,
} from './data';
import type { Rng } from './rng';
import type { Adventurer, AdventurerClass, Party, Veteran } from './types';

function makeAdventurer(
  rng: Rng,
  id: number,
  cls: AdventurerClass,
  level: number,
  gold: number,
  namedId: string | null,
  /** A returning face (§15.5). Keeps their name; everything else is re-rolled. */
  veteran?: Veteran,
): Adventurer {
  const mod = CLASS_MODS[cls];
  const named = namedId ? NAMED[namedId] : undefined;
  const mult = named?.statMult ?? 1;

  const maxHp = Math.round((ADV_BASE_HP + TUNING.advHpPerLevel * level) * mod.hp * mult);
  const dmg = (ADV_BASE_DMG + TUNING.advDmgPerLevel * level) * mod.dmg * mult;
  // The name roll happens unconditionally so a returning veteran does not
  // shift the RNG stream relative to a fresh party — determinism (§13.2) is
  // per-(seed, roster), and the roster is itself deterministic season state.
  const rolled = `${rng.pick(FIRST_NAMES)} ${rng.pick(EPITHETS)}`;
  const name = named ? named.name : veteran?.name ?? rolled;

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
    /** Low-water mark starts full and only ever falls (§15.3). */
    lowestHpPct: 1,
    veteranId: veteran?.id ?? null,
  };
}

/**
 * Roll a party for a threat tier. Guarantees at least one fighter at size >= 3
 * so generic parties aren't accidentally made of glass.
 *
 * `veterans` is the season's persistent roster (§15.5). Each slot after the
 * first may be filled by a living, un-retired veteran instead of a fresh roll:
 * same face and class, but re-levelled to the current tier, because the world
 * scales with your Renown and they scale with it.
 */
export function generateParty(rng: Rng, tier: TierRow, veterans: Veteran[] = []): Party {
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

  // Retirees never come back (§15.5). Splice as we draw so one veteran cannot
  // fill two slots in the same party.
  const pool = veterans.filter((v) => !v.retired);

  for (let i = 0; i < size; i++) {
    const level = rng.int(tier.levelMin, tier.levelMax);

    // Slot 0 is reserved: it carries the named adventurer and the fighter
    // guarantee, neither of which survives being overwritten by a returnee.
    let vet: Veteran | undefined;
    if (i > 0 && pool.length > 0 && rng.chance(TUNING.veteranReturnChance)) {
      vet = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    }

    let cls: AdventurerClass;
    if (i === 0 && size >= 3) {
      cls = 'fighter';
    } else {
      cls = rng.weighted(CLASS_WEIGHTS);
    }
    if (vet) cls = vet.cls;

    const gold = Math.round(tier.gold * rng.float(0.8, 1.2));
    members.push(makeAdventurer(rng, i, cls, level, gold, i === 0 ? namedId : null, vet));
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
