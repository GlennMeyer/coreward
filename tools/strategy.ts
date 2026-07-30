/**
 * Scripted Build Phase AI, shared by the balance runner and the tracer.
 *
 * It is not trying to play well — it is trying to play *consistently*, so that
 * differences between batches come from tuning changes rather than from the AI
 * getting lucky.
 */
import {
  AMENITIES, GEAR, HIRED_STAFF_COST, MAX_GEAR_SLOTS, MOBS, TRAPS,
  widenCostFor, boonCost,
} from '../src/sim/data';
import {
  allTraps, assignStaff, buildAmenity, buyMob, buyTrap, digCost, digFloor,
  equipGear, hireStaff, livingMobs, mobsInRoom, placeMobInRoom,
  buyBoon, hasBoon, mobCost, placeTrapInRoom, rearmAll, rearmAllPrice, roomCapacityAt,
  roomSlotsUsed, setPrice, startWiden, trapPrice,
  totalUpkeep, trapsInRoom,
} from '../src/sim/dungeon';
import type { Rng } from '../src/sim/rng';
import type {
  AmenityId, Dungeon, Mob, PriceTier, SeasonState, Trap,
} from '../src/sim/types';

export type StrategyName =
  | 'combat' | 'commerce' | 'balanced' | 'swarm' | 'wardens' | 'showman'
  | 'patron' | 'traps';

export interface Strategy {
  name: StrategyName;
  /** Fraction of mana reserved for amenities rather than monsters. */
  commerceShare: number;
  /** Accept a Taunt offer with this probability. */
  tauntRate: number;
  /** Purchase preference, strongest-affordable first. */
  buyOrder?: string[];
  /**
   * Buy by rotating through `buyOrder` instead of always taking the strongest
   * affordable thing, and place for role spread rather than depth (§15.3).
   *
   * The default AI produces the dungeon §15.4 explicitly calls out as bad —
   * nine near-identical rooms of whatever was strongest that raid. `variety`
   * is the opposite bet: a different role in every room, no empty slots, and
   * amenities for `comfort`.
   */
  showmanship?: boolean;
  /** Price tier to set on every amenity built. Defaults to whatever `buildAmenity` picks. */
  priceTier?: PriceTier;
  /**
   * Open an amenity on every landing rather than stopping at the first one the
   * budget allows, and keep buying shops before monsters.
   */
  shopEverywhere?: boolean;
  /**
   * Fraction of the Build Phase purse reserved for installing traps (§5.2).
   *
   * Note re-arming is NOT taken out of this share and is not optional for any
   * strategy: a charge already installed is the cheapest defence in the game,
   * and an AI that let its traps sit spent would be measuring a build nobody
   * would play.
   *
   * **0.25 for the generalists, and the ceiling is a design decision rather
   * than a measurement.** Swept over 800 seasons of `balanced`:
   *
   * | share | overrun | reach raid 8 | tier @8 | killed/season | best mob lv |
   * |---|---|---|---|---|---|
   * | 0 (baseline) | 62% | 305 | 1.4 | 9.3 | 1.6 |
   * | 0.25 | 53% | 404 | 1.5 | 11.6 | 2.2 |
   * | 0.30 | 64% | 409 | 3.2 | — | — |
   * | 0.40 | 43% | 612 | 3.5 | 2.1 | 0.6 |
   * | 0.45 | 34% | 651 | 3.4 | — | — |
   *
   * Survival keeps improving past 0.25 and it is tempting to take it. Do not.
   * At 0.4 every strategy in the file converges on the same dungeon — `combat`
   * kills 2.1 a season instead of 11.6 and sends 26.6 people home, which is
   * `wardens`' line exactly. Traps strip and soften, so a build made mostly of
   * them produces retreats rather than corpses; past about a third of the purse
   * that stops being a tool and starts being the whole plan, and pillar 2's
   * "three distinct builds" quietly becomes one. Best mob level collapsing from
   * 2.2 to 0.6 is the same fact from pillar 3's side — traps grant no XP, and a
   * dungeon whose traps do the work has no veterans.
   *
   * So the generalists take traps as an *option* (0.25, which is also the best
   * cell below 0.4), and `traps` below shows what specialising actually buys.
   * That the specialist is better at surviving than the generalists is correct;
   * that it should be better at everything is not.
   *
   * The 0.30 cell is a genuine chaotic outlier, not noise: the trap reserve
   * pushes the monster budget just under an Ogre, and which monsters a raid can
   * afford cascades through digging, placement and the Renown ratchet. Nothing
   * in this file is smooth in `trapShare`, so sweep it rather than interpolate.
   */
  trapShare?: number;
  /** Trap purchase preference, strongest-affordable first. */
  trapOrder?: string[];
}

export const STRATEGY_LIST: Record<StrategyName, Strategy> = {
  combat: { name: 'combat', commerceShare: 0, tauntRate: 0.5, trapShare: 0.25 },
  commerce: { name: 'commerce', commerceShare: 0.5, tauntRate: 0.1, trapShare: 0.25 },
  balanced: { name: 'balanced', commerceShare: 0.25, tauntRate: 0.35, trapShare: 0.25 },
  /**
   * Cheap bodies only: maximum damage per mana, minimum staying power.
   *
   * Kept trap-free on purpose. It is the control for "does the game reward
   * spending everything on the cheapest thing that can attack?", and giving it
   * traps would make it a second trap build rather than a baseline.
   */
  swarm: { name: 'swarm', commerceShare: 0, tauntRate: 0.5, buyOrder: ['rat', 'slime'] },
  // Kit drain: turn them back rather than killing them. The Rot-Gas Vent is
  // the same plan by other means, so it gets one.
  wardens: {
    name: 'wardens', commerceShare: 0, tauntRate: 0.2,
    buyOrder: ['ooze', 'cutpurse', 'rat'], trapShare: 0.2, trapOrder: ['gasvent'],
  },
  /**
   * Run a good ride, not a good fortress (§15.2). Tests whether Thrill is
   * actually playable-for: role spread for `variety`, amenities for `comfort`,
   * every room occupied so nothing reads as padding, and a low taunt rate
   * because a party pushed one floor too far dies, and the dead pay nothing.
   *
   * The buy order alternates roles deliberately — bruiser, warden, skirmisher —
   * so consecutive rooms differ even before the placer gets involved.
   */
  showman: {
    name: 'showman', commerceShare: 0.35, tauntRate: 0.1, showmanship: true,
    // Traps are a showman's cheapest peril: they hurt on the threshold, before
    // the party has spent a single Kit, and they cost nothing to own between
    // raids — which is what lets the defence reserve go on shops instead.
    trapShare: 0.25,
    // One body per role — bruiser, warden, skirmisher — and the *strongest* of
    // each. The original six-mob rotation reached down to Slime and Cutpurse,
    // which bought bodies rather than threat: `variety` saturates at three
    // roles (the prototype bestiary has no more), so the fourth, fifth and
    // sixth entries added no Thrill and cost the mana that peril is made of.
    buyOrder: ['ogre', 'ooze', 'rat'],
  },
  /**
   * Play for Patrons (§9.4) — the build the track is actually written for.
   *
   * It exists because measuring the Patron threshold against the other
   * strategies would have been measuring an artifact. §11 Q8 and §15.7.6 both
   * record that the scripted commerce AI is weak and under-shops: it opens
   * ~1.8 amenities a raid and only 16% of survivors buy anything, which
   * produces ~1.6 heavy-spend events per season across the whole roster.
   * No threshold can concentrate three of those on one face, so tuning
   * `patronSpends` down to compensate would have been tuning to the AI's
   * weakness rather than to the design.
   *
   * So: shops on every landing at `modest` prices (0.9 usage against
   * standard's 0.65) — and, counter-intuitively, *strong* monsters.
   *
   * Measured: a soft dungeon sells nothing. A gentle warden build opened 2.2
   * amenities a raid and got 2.3% of survivors to buy, against the ordinary
   * commerce build's 16.3%, because the Hot Spring only sells to someone under
   * 85% HP and the Provisioner only sells to someone whose pack is empty.
   * **Nobody shops until the dungeon has hurt them.** Which is §7.5's line —
   * sell on the upper landings, drain in the middle — arrived at from the
   * other direction, and the same thing §15 says about Thrill: peril is what
   * the whole economy is downstream of.
   */
  patron: {
    name: 'patron', commerceShare: 0.4, tauntRate: 0.1,
    priceTier: 'modest', shopEverywhere: true, trapShare: 0.25,
  },
  /**
   * The trap-leaning build (§5.2) — the one this system exists to make
   * possible.
   *
   * Its thesis is the opposite of every other strategy in this file: **buy
   * almost no rent.** Traps cost nothing to own, so a dungeon made mostly of
   * them runs an upkeep bill of single digits and can spend its whole income
   * on getting bigger instead of on standing still. It still buys monsters —
   * traps soften, delay and strip, and something has to finish the job (§7.5)
   * — but it buys them last and cheaply, and it re-arms before it buys
   * anything at all.
   *
   * The trap order is the design's own argument in purchase form: the Snare
   * and the Gas Vent first, because they are pure force multipliers for
   * whatever is behind them, then the Dart Battery for chip damage, then the
   * Shrieker, and the Deadfall only when there is real money about.
   */
  traps: {
    name: 'traps', commerceShare: 0, tauntRate: 0.3,
    trapShare: 0.55,
    trapOrder: ['snare', 'gasvent', 'darts', 'shrieker', 'deadfall'],
    buyOrder: ['skeleton', 'cutpurse', 'slime', 'rat'],
  },
};

/**
 * Traps are bought CHEAPEST first and by rotation, which is the opposite of
 * `DEFAULT_BUY_ORDER`'s always-take-the-strongest rule. Both facts are
 * measured, not stylistic:
 *
 * - Strongest-first spent an entire trap budget on one Deadfall and left four
 *   rooms bare. A trap fires once, so a second trap is worth far more than a
 *   bigger trap — unlike a monster, where concentration is what makes a room
 *   winnable (see `AI.fillEmptyFirst`).
 * - Rotating keeps the jobs mixed. Five Dart Batteries is one job, one point of
 *   `variety`, and a row of identical rooms the signature flags as repeats.
 */
const DEFAULT_TRAP_ORDER = ['darts', 'gasvent', 'snare', 'shrieker', 'deadfall'];

/** Strongest first — the AI always buys the best thing it can afford. */
const DEFAULT_BUY_ORDER = ['ogre', 'ooze', 'skeleton', 'cutpurse', 'slime', 'rat'];

/**
 * Build-order constants for the scripted AI.
 *
 * Mutable for the same reason `TUNING` is (src/sim/data.ts): several of the
 * balance questions in §14/§15 turned out to be "is the AI playing this badly,
 * or is the strategy bad?", and you cannot answer that without sweeping the
 * AI's own numbers. These are *not* game tuning — nothing in src/sim reads
 * them — so they live here rather than in TUNING.
 */
export const AI = {
  /** Mana a showman keeps back for monsters before opening a shop. */
  showmanDefenceReserve: 150,
  /** Mana left over a dig, so a new floor is never opened completely naked. */
  digReserve: 90,
  /**
   * Stop digging past this raid. A floor bought on raid 7 cannot be staffed
   * before the season ends — strictly worse than another monster.
   */
  digUntilRaid: 5,
  /** placeForVariety weights — see the function for what they trade off. */
  placeDepth: 15,
  placeEmpty: 45,
  /**
   * placeAnywhere: fill every room once before stacking any of them.
   *
   * Off, and the measurement is why. It reads like a free win — the same
   * monsters, no empty corridors, less Tedium — and it does raise combat's
   * Renown from 53 to 71. But it also takes combat's season survival from 49%
   * to 20% and its best monster level from 2.1 to 0.7: one Ogre per room loses
   * every room, so nothing survives to level and pillar 3 stops existing.
   * Concentration is not a placement bug, it is what makes a room winnable.
   */
  fillEmptyFirst: false,
  /**
   * Mana kept back over a widening, and the last raid worth starting one on.
   *
   * §16.11's warning, taken seriously: "an AI that never widens a room, or
   * widens rooms at random, will report that this system does nothing." §11 Q8
   * is the cautionary tale — the commerce strategy measured at 8% partly
   * because the AI staffed shops with Cave Rats, and that read as a verdict on
   * commerce rather than on the AI.
   *
   * The policy is deliberately the *simplest defensible* one rather than a
   * clever one: widen the room that is already full and already fights, so the
   * space bought is space immediately used. A widening finished after the last
   * raid is pure waste, hence the cutoff.
   */
  widenReserve: 70,
  widenUntilRaid: 6,
  /** Do not widen a room unless it is this full — space nobody needs is dead mana. */
  widenAtLeastFull: 1,
};

const AI_DEFAULTS = { ...AI };

export function resetAi(): void {
  Object.assign(AI, AI_DEFAULTS);
}

export function buildPhaseFor(s: SeasonState, strat: Strategy, rng: Rng): void {
  const d = s.dungeon;

  // 1. Dig.
  //
  // The old gate — `mana >= cost + 120` from raid 2 — meant *no strategy ever
  // dug a second floor* in an 8-raid season, because the AI spends down to ~30
  // mana every Build Phase and income is ~85. Every measured dungeon was one
  // floor deep, which made `depth` untestable and the Descent Decision (§7.3)
  // unreachable. A floor costs 60 and pays TUNING.manaPerFloor (+40) every raid
  // thereafter: it repays itself in under two raids, so the right rule is
  // "dig as early as you can still afford to defend it".
  const cost = digCost(d);
  if (cost !== null && s.mana >= cost + AI.digReserve && s.raidNumber <= AI.digUntilRaid) {
    if (digFloor(d) === null) s.mana -= cost;
  }

  // 0. Boons (§48).
  //
  // Before anything else, because Souls buy nothing else — there is no
  // competing claim on the currency, so holding it back would just be hoarding.
  // The policy is the same shape as the widening one and for the same reason
  // (§16.11, §11 Q8): an AI that never takes a boon would report that the whole
  // system does nothing, and that would read as a verdict on boons rather than
  // on the AI. Cheapest first, so a run buys breadth rather than saving all
  // season for one Legendary it may not live to enjoy.
  if (s.boonOffer?.length) {
    for (;;) {
      const affordable = s.boonOffer
        .filter((id) => !hasBoon(d, id))
        .map((id) => ({ id, cost: boonCost(id) }))
        .filter((b) => b.cost <= s.souls)
        .sort((a, b) => a.cost - b.cost);
      const pick = affordable[0];
      if (!pick) break;
      const got = buyBoon(d, pick.id);
      if (typeof got === 'string') break;
      s.souls -= got.cost;
    }
  }

  // 1a. Widen (§16.3, §16.11).
  //
  // After the dig and before anything is bought, because widening competes with
  // the dig for the same mana and the dig is worth more: a floor pays
  // `manaPerFloor` every raid thereafter, a wider room pays nothing directly.
  //
  // Target the fullest room that is at capacity — the space then gets used the
  // raid it lands, rather than sitting empty while the Crew is booked. One
  // project at a time is enforced by `startWiden`, so this is a no-op while
  // work is already under way.
  if (!d.project && s.raidNumber <= AI.widenUntilRaid) {
    let best: { floor: number; room: number; cost: number } | null = null;
    for (let f = 0; f < d.floors.length; f++) {
      for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
        const room = d.floors[f]!.rooms[r]!;
        if ((room.capacityTier ?? 'hewn') === 'widened') continue;
        const used = roomSlotsUsed(d, f, r);
        // Full, and defended — an empty room does not need to be bigger.
        if (used < roomCapacityAt(d, f, r) || used < AI.widenAtLeastFull) continue;
        const cost = widenCostFor(f);
        if (s.mana < cost + AI.widenReserve) continue;
        // Shallowest first: it is cheapest, and floor 1 is the room every party
        // actually walks through (the runner reports ~2.5 floors of ~4 reached).
        if (!best || cost < best.cost) best = { floor: f, room: r, cost };
      }
    }
    if (best) {
      const started = startWiden(d, best.floor, best.room);
      if (typeof started !== 'string') s.mana -= started.cost;
    }
  }

  // 1b. Re-arm. This is deliberately the FIRST thing any purse touches after
  // the dig, and it is not gated on `trapShare`: a trap that is already
  // installed is the cheapest defence available — 9-24 mana for a full trigger
  // against 12-85 for a monster that then bills you every raid forever. An AI
  // that bought a new Cave Rat while its Deadfall sat spent would be measuring
  // a mistake rather than a strategy.
  if (rearmAllPrice(d) > 0) s.gold -= rearmAll(d, s.gold);

  // 2. Commerce: one amenity per landing, staffed by a cheap monster.
  if (strat.commerceShare > 0) {
    // A showman budgets by what is left above a defence reserve rather than by
    // a fixed share. A proportional budget of a small purse never clears an
    // amenity's build cost, so `comfort` — the term that is supposed to make
    // commerce pay for itself (§15.4) — would stay at zero all season.
    const budget = strat.showmanship
      ? Math.max(0, s.mana - AI.showmanDefenceReserve)
      : s.mana * strat.commerceShare;
    let spent = 0;
    for (let l = 0; l < d.landings.length; l++) {
      const landing = d.landings[l]!;
      // A patron build fills both slots on a landing; everyone else stops at one.
      const full = strat.shopEverywhere
        ? landing.amenities.every((a) => a !== null)
        : landing.amenities.some((a) => a !== null);
      if (full) continue;
      // Hot Spring shallow, Provisioner deep — not the other way round.
      //
      // The Provisioner only sells when the party is short of Kit
      // (`party.kit >= need` breaks out of the shopping loop), and a party
      // arrives at the first Landing with a full pack. A Provisioner on
      // Landing 0 therefore never makes a single sale: it was costing 82 mana
      // and returning zero gold and zero `comfort` all season. The Hot Spring
      // wants `hp < 85%`, which is true of everyone who has just fought a
      // floor, so it is the amenity that pays on the way in.
      const slot = landing.amenities.findIndex((a) => a === null);
      if (slot < 0) continue;
      // Hot Spring first on every landing: it is the one that sells on the way
      // in. A second slot takes the Provisioner, which only pays once the
      // party's pack is empty.
      const pick: AmenityId = (l === 0 || strat.shopEverywhere) && slot === 0
        ? 'hotspring'
        : 'provisioner';
      const def = AMENITIES[pick];
      if (spent + def.buildCost + MOBS['rat']!.cost > budget) break;
      if (buildAmenity(d, l, slot, pick) !== null) continue;
      spent += def.buildCost;
      s.gold -= def.buildCost;
      if (strat.priceTier) setPrice(d, l, slot, strat.priceTier);

      const staff = buyMob(d, 'rat');
      if (typeof staff !== 'string') {
        s.mana -= MOBS['rat']!.cost;
        spent += MOBS['rat']!.cost;
        assignStaff(d, staff.uid, l, slot);
      }
    }
  }

  // 3. Spend Gold — the only sink, and the whole point of running shops.
  spendGold(s, strat);

  // 4. Re-place survivors that got pulled out by a Retreat intervention.
  const place = (mob: Mob) =>
    (strat.showmanship ? placeForVariety(s, mob) : placeAnywhere(s, mob));
  for (const mob of livingMobs(d)) {
    if (mob.placement.kind === 'unassigned') place(mob);
  }

  // 5. Set the trap budget aside, then buy monsters, then spend it.
  //
  // Traps go in AFTER monsters and the ordering is load-bearing. `placeTrap`
  // wants a room that already has something in it — a Snare with nothing
  // behind it holds the party still in an empty corridor, and a Gas Vent is
  // most valuable where the fight it is softening actually happens. Buying
  // traps first put them all in empty rooms, which measured as a 91% breach
  // rate on raid ONE for the trap build: five traps, no teeth.
  //
  // Reserving the share up front rather than spending the remainder is what
  // makes it a *share*: the monster loop below drains everything down to the
  // upkeep reserve, so anything not withheld here is never seen again.
  const trapBudget = Math.floor(s.gold * (strat.trapShare ?? 0));

  // 6. Spend the rest of the mana on monsters.
  const order = strat.buyOrder ?? DEFAULT_BUY_ORDER;
  let cursor = 0;
  let guard = 0;
  while (guard++ < 80) {
    // Keep enough in hand to cover upkeep, or income goes negative.
    const reserve = totalUpkeep(d) + trapBudget;
    const budget = s.mana - reserve;
    // A showman rotates the roster so no role dominates; everyone else takes
    // the strongest thing they can afford.
    const defId = strat.showmanship
      ? nextInRotation(order, cursor++, budget)
      : (order.find((id) => MOBS[id]!.cost <= budget) ?? null);
    if (defId === null) break;

    const mob = buyMob(d, defId);
    if (typeof mob === 'string') break;
    if (!place(mob)) {
      d.mobs.pop(); // nowhere to put it; undo
      break;
    }
    s.mana -= mobCost(d, defId);
    if (rng.chance(0.02)) break; // jitter so batches aren't lockstep
  }

  // 7. Install traps into the rooms the monsters are now standing in.
  if (trapBudget > 0) {
    const trapOrder = strat.trapOrder ?? DEFAULT_TRAP_ORDER;
    let budget = Math.min(trapBudget, s.gold);
    let tcursor = 0;
    let tguard = 0;
    while (tguard++ < 40) {
      const defId = nextTrapInRotation(d, trapOrder, tcursor++, budget);
      if (!defId) break;
      const trap = buyTrap(d, defId);
      if (typeof trap === 'string') break;
      if (!placeTrap(s, trap)) {
        d.traps = allTraps(d).filter((t) => t.uid !== trap.uid); // nowhere to put it
        break;
      }
      const price = trapPrice(d, defId);
      s.gold -= price;
      budget -= price;
    }
  }
}

/** `nextInRotation`, for traps. Same argument, different price table. */
function nextTrapInRotation(
  d: Dungeon, order: string[], cursor: number, budget: number,
): string | null {
  for (let i = 0; i < order.length; i++) {
    const id = order[(cursor + i) % order.length]!;
    if (trapPrice(d, id) <= budget) return id;
  }
  return null;
}

/**
 * Where a trap goes.
 *
 * Two placements, in order of preference:
 *
 * 1. **In a room that already has a monster**, deepest first. This is the
 *    arrangement the whole system is for — the trap takes a bite on the
 *    threshold and the monster finishes what is left (§7.5). It is the only
 *    placement a `delay` trap is worth anything in at all, since a Snare with
 *    nothing behind it holds the party still in an empty room.
 * 2. **The shallowest empty room otherwise.** A trap standing alone on Floor 1
 *    is not wasted: Kit and Resolve stripped before the first real fight are
 *    stripped for the whole delve, and the room stops reading as an empty
 *    corridor for Tedium as long as it stays armed.
 *
 * Never two of the same trap in one room — a doubled Snare is two ticks the
 * party was already going to lose, and the room signature would flag it as a
 * repeat besides.
 */
function placeTrap(s: SeasonState, trap: Trap): boolean {
  const d = s.dungeon;
  const slots = TRAPS[trap.defId]!.slots;
  const fits = (f: number, r: number): boolean =>
    roomSlotsUsed(d, f, r) + slots <= roomCapacityAt(d, f, r)
    && !trapsInRoom(d, f, r).some((t) => t.defId === trap.defId);

  for (let f = d.floors.length - 1; f >= 0; f--) {
    for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
      if (mobsInRoom(d, f, r).length === 0) continue;
      if (fits(f, r)) return placeTrapInRoom(d, trap.uid, f, r) === null;
    }
  }
  for (let f = 0; f < d.floors.length; f++) {
    for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
      if (fits(f, r)) return placeTrapInRoom(d, trap.uid, f, r) === null;
    }
  }
  return false;
}

/**
 * First affordable entry at or after `cursor`, wrapping once. Rotating rather
 * than always-strongest is what keeps a showman's roster mixed — buying the
 * best affordable mob every time converges on one species, which scores
 * `variety` 0.25 and eats the repeated-room Tedium penalty (§15.3).
 */
function nextInRotation(order: string[], cursor: number, budget: number): string | null {
  for (let i = 0; i < order.length; i++) {
    const id = order[(cursor + i) % order.length]!;
    if (MOBS[id]!.cost <= budget) return id;
  }
  return null;
}

/**
 * Deepest-first, so the strongest monsters end up guarding the Core — but in
 * two passes, so no room is left empty while another is stacked three deep.
 *
 * The single-pass version filled the deepest floor's rooms to capacity before
 * touching anything shallower, which on a two-floor dungeon meant Floor 1 was
 * three empty rooms every single raid: 12 Tedium a raid, and three rooms of
 * free walking on the way in. Filling breadth-first first costs nothing — the
 * same monsters are still deepest-first within each pass.
 */
export function placeAnywhere(s: SeasonState, mob: Mob): boolean {
  const d = s.dungeon;
  const slots = MOBS[mob.defId]!.slots;
  const passes = AI.fillEmptyFirst ? [true, false] : [false];
  for (const emptyOnly of passes) {
    for (let f = d.floors.length - 1; f >= 0; f--) {
      for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
        if (roomSlotsUsed(d, f, r) + slots > roomCapacityAt(d, f, r)) continue;
        if (emptyOnly && mobsInRoom(d, f, r).length > 0) continue;
        return placeMobInRoom(d, mob.uid, f, r) === null;
      }
    }
  }
  return false;
}

/**
 * Placement for Thrill — but defence first (§15.3).
 *
 * The original weights had this exactly inverted: an empty room scored +40 and
 * depth scored `f × 3`, so the placer spread one cheap monster into every room
 * it could find and left the Core approach guarded by a Cave Rat. It was
 * trading a Heart for 4 points of Tedium, and it breached on 3 raids out of
 * every season and survived 0% of them.
 *
 * The corrected order is: depth dominates, because a monster that is not
 * between the party and the Core is not doing anything; then role spread,
 * because two rooms of the same thing back to back is 8 Tedium and dead
 * `variety`; and only then filling an empty room, which is worth exactly the
 * 4 Tedium it saves. A showman still runs a varied dungeon — it just stacks
 * that variety from the bottom up instead of smearing it across the map.
 */
export function placeForVariety(s: SeasonState, mob: Mob): boolean {
  const d = s.dungeon;
  const role = MOBS[mob.defId]!.role;
  const slots = MOBS[mob.defId]!.slots;
  const roleOf = (m: Mob) => MOBS[m.defId]!.role;

  let bestFloor = -1, bestRoom = -1, bestScore = -Infinity;
  for (let f = 0; f < d.floors.length; f++) {
    for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
      if (roomSlotsUsed(d, f, r) + slots > roomCapacityAt(d, f, r)) continue;
      const here = mobsInRoom(d, f, r);
      const prev = r > 0 ? mobsInRoom(d, f, r - 1) : [];

      // Depth first: the deepest rooms are the ones that decide the season.
      let score = f * AI.placeDepth;
      // Then spread: never double up a role in a room or against its neighbour.
      if (here.some((m) => roleOf(m) === role)) score -= 30;
      if (prev.length > 0 && prev.every((m) => roleOf(m) === role)) score -= 20;
      // Then padding. Weighted so an empty room *anywhere* outranks stacking a
      // second monster one floor deeper: every room gets something before any
      // room gets seconds, and only then does the dungeon thicken downward.
      if (here.length === 0) score += AI.placeEmpty;

      if (score > bestScore) {
        bestScore = score;
        bestFloor = f;
        bestRoom = r;
      }
    }
  }

  if (bestFloor < 0) return false;
  return placeMobInRoom(d, mob.uid, bestFloor, bestRoom) === null;
}

/**
 * Gold buys hirelings first, then gear. Hirelings come first because they undo
 * the staffing opportunity cost — the monster behind the counter goes back to
 * fighting, which is what makes a commerce build stop bleeding defence.
 */
function spendGold(s: SeasonState, strat: Strategy): void {
  const d = s.dungeon;

  if (strat.commerceShare > 0) {
    for (const landing of d.landings) {
      for (let slot = 0; slot < landing.amenities.length; slot++) {
        const a = landing.amenities[slot];
        if (!a || a.hired || s.gold < HIRED_STAFF_COST) continue;
        const freed = a.staffUid;
        if (hireStaff(d, d.landings.indexOf(landing), slot) !== null) continue;
        s.gold -= HIRED_STAFF_COST;
        // The monster it replaced goes straight back into a room.
        if (freed !== null) {
          const mob = d.mobs.find((m) => m.uid === freed);
          if (mob) placeAnywhere(s, mob);
        }
      }
    }
  }

  // Gear the deepest, most-invested monsters first — they survive to use it.
  const candidates = livingMobs(d)
    .filter((m) => m.placement.kind === 'room' && m.gear.length < MAX_GEAR_SLOTS)
    .sort((a, b) => b.level - a.level);

  for (const mob of candidates) {
    for (const g of ['fangs', 'carapace', 'censer']) {
      if (mob.gear.length >= MAX_GEAR_SLOTS) break;
      if (mob.gear.includes(g)) continue;
      const cost = GEAR[g]!.cost;
      if (s.gold < cost) continue;
      if (equipGear(d, mob.uid, g) === null) s.gold -= cost;
    }
  }
}
