/**
 * Party generation (§9.1) and the two recurring-character tracks (§9.3, §9.4).
 *
 * Pure function of (rng, tier, roster) — no hidden state. The roster is itself
 * deterministic season state, so replays still reproduce exactly (§13.2).
 */
import {
  ADV_ARMOR_PER_LEVEL, ADV_BASE_DMG, ADV_BASE_HP, ADV_KIT_BASE,
  ADV_MAX_RESOLVE, CLASS_MODS, CLASS_WEIGHTS, EPITHETS, FIRST_NAMES, NAMED,
  TUNING, type TierRow,
} from './data';
import type { Rng } from './rng';
import type { Adventurer, AdventurerClass, Party, Veteran } from './types';

// ─── Veteran roster helpers (§9.3, §9.4) ─────────────────────────────────────

/** A fresh roster entry. One place to initialise, so new fields cannot be missed. */
export function makeVeteran(
  id: number, name: string, cls: AdventurerClass, namedId: string | null = null,
): Veteran {
  return {
    id,
    name,
    cls,
    delves: 0,
    bestThrill: 0,
    retired: false,
    namedId,
    dead: false,
    escapes: 0,
    bigSpends: 0,
    goldSpent: 0,
    traits: [],
    lastGrudge: null,
    cautiousFloor: null,
  };
}

/** Escaped `nemesisEscapes` times — leads their own party, worth a fortune dead. */
export function isNemesis(v: Veteran): boolean {
  return (v.escapes ?? 0) >= TUNING.nemesisEscapes;
}

/** Spent heavily and survived `patronSpends` times — 3× gold, brings a friend. */
export function isPatron(v: Veteran): boolean {
  return (v.bigSpends ?? 0) >= TUNING.patronSpends;
}

/**
 * §9.3's Rank. One per escape: the stat bump that says "this one has been here
 * before" before the player has read a single word of UI.
 */
export function veteranRank(v: Veteran): number {
  return Math.min(v.escapes ?? 0, TUNING.nemesisMaxRank);
}

/** Alive, un-retired, and therefore able to walk back in. */
export function canReturn(v: Veteran): boolean {
  return !v.retired && !v.dead;
}

// ─── Adventurer construction ─────────────────────────────────────────────────

function makeAdventurer(
  rng: Rng,
  id: number,
  cls: AdventurerClass,
  level: number,
  gold: number,
  namedId: string | null,
  /** A returning face (§15.5, §9.3). Keeps their name, rank and learned traits. */
  veteran?: Veteran,
  /** First names already spoken for in this party — see the collision note. */
  usedFirstNames?: Set<string>,
): Adventurer {
  const mod = CLASS_MODS[cls];
  const named = namedId ? NAMED[namedId] : undefined;
  const rank = veteran ? veteranRank(veteran) : 0;
  const traits = veteran ? [...(veteran.traits ?? [])] : [];
  // Rank is a flat, non-compounding multiplier on top of the named bonus: a
  // recurring face should read as tougher, not become a wall (§9.3).
  const mult = (named?.statMult ?? 1) * (1 + TUNING.nemesisStatPerRank * rank);

  let maxHp = Math.round((ADV_BASE_HP + TUNING.advHpPerLevel * level) * mod.hp * mult);
  if (traits.includes('hale')) maxHp = Math.round(maxHp * (1 + TUNING.learnedHpBonus));

  const dmg = (ADV_BASE_DMG + TUNING.advDmgPerLevel * level) * mod.dmg * mult;

  let armor = level * ADV_ARMOR_PER_LEVEL;
  if (traits.includes('armored')) armor += TUNING.learnedArmorBonus;

  let maxResolve = ADV_MAX_RESOLVE;
  if (traits.includes('steeled')) maxResolve += TUNING.learnedResolveBonus;

  // The name roll happens unconditionally so a returning veteran does not
  // shift the RNG stream relative to a fresh party — determinism (§13.2) is
  // per-(seed, roster), and the roster is itself deterministic season state.
  const firstRoll = rng.pick(FIRST_NAMES);
  const epithet = rng.pick(EPITHETS);

  // Names carry the story now — §9.3 rivalries and the narrator both read them
  // aloud — and a party fielding two Sables reads as a generator bug. Resolve a
  // collision by walking FIRST_NAMES from the rolled index rather than drawing
  // again, so the RNG stream stays aligned and determinism (§13.2) holds.
  let first = firstRoll;
  if (usedFirstNames) {
    let i = FIRST_NAMES.indexOf(firstRoll);
    for (let n = 0; n < FIRST_NAMES.length && usedFirstNames.has(first); n++) {
      i = (i + 1) % FIRST_NAMES.length;
      first = FIRST_NAMES[i]!;
    }
    usedFirstNames.add(first);
  }

  const rolled = `${first} ${epithet}`;
  const name = veteran?.name ?? (named ? named.name : rolled);

  const patron = veteran ? isPatron(veteran) : false;
  // §9.4: a Patron "arrives with 3× gold". This is the income stream that walks
  // in voluntarily — and the reason killing one hurts.
  const purse = Math.round(gold * (named ? 1.5 : 1) * (patron ? TUNING.patronGoldMult : 1));

  return {
    id,
    name,
    cls,
    level,
    maxHp,
    hp: maxHp,
    dmg,
    armor,
    maxResolve,
    resolve: maxResolve,
    gold: purse,
    greed: rng.float(0, 0.15) + mod.greed,
    alive: true,
    namedId,
    /** Low-water mark starts full and only ever falls (§15.3). */
    downed: false,
    turnedAway: false,
    saveSuccesses: 0,
    saveFailures: 0,
    stable: false,
    lowestHpPct: 1,
    veteranId: veteran?.id ?? null,

    rank,
    traits,
    isNemesis: veteran ? isNemesis(veteran) : false,
    isPatron: patron,
    // Only Patrons are cautious. A Nemesis who has not yet become a Patron will
    // happily walk back into the room that nearly killed them (§9.4).
    cautiousFloor: patron ? veteran!.cautiousFloor ?? null : null,
    startGold: purse,
    goldSpentHere: 0,
    hurtByRole: {},
    hurtByTrap: 0,
    resolveLost: 0,
    nearDeathFloor: null,
    grudge: null,
  };
}

/**
 * Roll a party for a threat tier. Guarantees at least one fighter at size >= 3
 * so generic parties aren't accidentally made of glass.
 *
 * `veterans` is the season's persistent roster. Three kinds of face can fill a
 * slot, in descending priority:
 *
 *  1. **Headliners** — Nemeses and Patrons (§9.3, §9.4). These force their own
 *     appearance and *add* slots: a Nemesis leads a party of their own, and a
 *     Patron brings a friend they told about the place. Nothing here excludes a
 *     veteran from being both at once, which is §9.4's last paragraph and the
 *     single most interesting thing the roster can produce.
 *  2. **A named adventurer** (§9.2), if one is not already returning as a
 *     headliner — counter-play that invalidates a specific build.
 *  3. **Ordinary returnees** (§15.5) and fresh rolls.
 */
export function generateParty(rng: Rng, tier: TierRow, veterans: Veteran[] = []): Party {
  // Names carry the story now (§9.3, and the narrator reads them aloud), so a
  // party must not field two Sables. Track first names and re-roll collisions.
  const usedFirstNames = new Set<string>();
  const pool = veterans.filter(canReturn);

  // 1. Headliners. Rolled in roster order so the draw sequence is stable.
  const headliners: Veteran[] = [];
  for (const v of pool) {
    if (headliners.length >= TUNING.maxRecurringPerParty) break;
    if (!isNemesis(v) && !isPatron(v)) continue;
    if (rng.chance(TUNING.recurringReturnChance)) headliners.push(v);
  }

  let size = tier.partySize;
  let bonus = 0;
  for (const v of headliners) {
    if (isNemesis(v)) bonus += TUNING.nemesisPartyBonus;
    if (isPatron(v)) bonus += TUNING.patronPartyBonus;
  }
  size += Math.min(bonus, TUNING.maxPartyBonus);

  // 2. Named adventurers roll into a real slot rather than adding one. A named
  //    face already on the roster is skipped: when Berrick comes back he comes
  //    back as *himself*, rank and grudge intact, not as a fresh copy.
  const onRoster = new Set(
    pool.map((v) => v.namedId).filter((x): x is string => typeof x === 'string'),
  );
  let namedId: string | null = null;
  for (const def of Object.values(NAMED)) {
    if (tier.tier < def.minTier) continue;
    if (onRoster.has(def.id)) continue;
    if (rng.chance(def.appearChance)) {
      namedId = def.id;
      break;
    }
  }

  // Retirees and the dead never come back. Splice as we draw so one veteran
  // cannot fill two slots in the same party.
  const rest = pool.filter((v) => !headliners.includes(v));
  const members: Adventurer[] = [];
  // Headliners take the first slots; the named adventurer takes the first slot
  // they leave free.
  const namedSlot = headliners.length;

  for (let i = 0; i < size; i++) {
    const level = rng.int(tier.levelMin, tier.levelMax);

    let vet: Veteran | undefined = headliners[i];
    if (!vet && i > namedSlot && rest.length > 0 && rng.chance(TUNING.veteranReturnChance)) {
      vet = rest.splice(rng.int(0, rest.length - 1), 1)[0];
    }

    const slotNamed = i === namedSlot ? namedId : null;

    let cls: AdventurerClass;
    if (i === 0 && size >= 3) {
      // The fighter guarantee, so a generic party is not made of glass.
      cls = 'fighter';
    } else {
      cls = rng.weighted(CLASS_WEIGHTS);
    }
    if (vet) cls = vet.cls;

    const gold = Math.round(tier.gold * rng.float(0.8, 1.2));
    members.push(makeAdventurer(rng, i, cls, level, gold, vet?.namedId ?? slotNamed, vet, usedFirstNames));
  }

  // Kit is the drain build's whole win condition, so the trait that counters it
  // pays into the shared pool the drain build is trying to empty (§9.3).
  const provisioned = members.filter((m) => m.traits.includes('provisioned')).length;
  const maxKit = (ADV_KIT_BASE + tier.tier) * size + provisioned * TUNING.learnedKitBonus;

  return { members, kit: maxKit, maxKit, tier: tier.tier, kitStripped: 0 };
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
