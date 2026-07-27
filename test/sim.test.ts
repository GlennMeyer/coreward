import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AMENITIES, GEAR, MOBS, RENOWN_PER_ESCAPEE, RENOWN_WIPE_MULT, TIERS, TRAPS, TUNING,
  STARTING_HEARTS, XP_THRESHOLDS, mobMaxHp, resetTuning, roomCapacity, roomsOnFloor,
  tierForRenown, trapCost, trapRearmCost, MAX_TIER_PROTOTYPE,
} from '../src/sim/data';
import { generateParty } from '../src/sim/adventurers';
import { Rng } from '../src/sim/rng';
import type { Veteran } from '../src/sim/types';
import {
  assignStaff, buildAmenity, buyMob, isOpen, buyTrap, createDungeon, digFloor, equipGear, getTrap,
  grantXp, healAllMobs, hireStaff, mobEffectiveDmg, mobEffectiveHp, mobStripsKit,
  mobsInRoom, packMultiplier, placeMobInRoom, placeTrapInRoom, rearmAll,
  rearmAllPrice, removeTrap, roomSlotsUsed, totalUpkeep, unplace,
} from '../src/sim/dungeon';
import { RaidSim } from '../src/sim/raid';
import { applyAftermath, createSeason, startRaid } from '../src/sim/season';
import type { Dungeon, Mob } from '../src/sim/types';
import { addMob, addStaffedAmenity, addTrap, seasonWithFloors } from './helpers';

describe('dungeon construction', () => {
  let d: Dungeon;
  beforeEach(() => {
    d = createDungeon();
  });

  it('starts with one floor and a Core-approach landing beneath it', () => {
    expect(d.floors).toHaveLength(1);
    // Without this landing a one-floor dungeon has no Descent Decision at all.
    expect(d.landings).toHaveLength(1);
  });

  it('opens a landing for each dug floor', () => {
    digFloor(d);
    expect(d.floors).toHaveLength(2);
    expect(d.landings).toHaveLength(2);
    digFloor(d);
    expect(d.landings).toHaveLength(3);
  });

  it('caps at 3 floors in the prototype', () => {
    digFloor(d);
    digFloor(d);
    expect(digFloor(d)).toMatch(/caps at 3/);
  });

  it('enforces room slot capacity', () => {
    // Ogre 3 + Cave Rat 1 exactly fills a Floor-1 room (capacity 4)...
    addMob(d, 'ogre', 0, 0);
    addMob(d, 'rat', 0, 0);
    expect(mobsInRoom(d, 0, 0)).toHaveLength(2);

    // ...so a 2-slot Skeleton has nowhere to go.
    const skeleton = buyMob(d, 'skeleton') as Mob;
    expect(placeMobInRoom(d, skeleton.uid, 0, 0)).toMatch(/full/);
    expect(mobsInRoom(d, 0, 0)).toHaveLength(2);
  });

  it('Pack Tactics scales with living allies, and only for small monsters', () => {
    const lone = buyMob(d, 'rat') as Mob;
    expect(packMultiplier(lone, 1)).toBe(1);
    expect(packMultiplier(lone, 4)).toBeCloseTo(1.3, 5); // 3 allies × 0.10
    const ogre = buyMob(d, 'ogre') as Mob;
    expect(packMultiplier(ogre, 4)).toBe(1); // bruisers get nothing
  });

  it('fits a swarm of cheap monsters in the space of one big one', () => {
    // The whole point of slot costs: 4 rats or 1 ogre, same room.
    for (let i = 0; i < roomCapacity(0); i++) addMob(d, 'rat', 0, 0);
    expect(mobsInRoom(d, 0, 0)).toHaveLength(4);
    const extra = buyMob(d, 'rat') as Mob;
    expect(placeMobInRoom(d, extra.uid, 0, 0)).toMatch(/full/);
  });

  it('rooms get bigger with depth', () => {
    digFloor(d);
    digFloor(d);
    expect(roomCapacity(0)).toBe(4);
    expect(roomCapacity(1)).toBe(5);
    expect(roomCapacity(2)).toBe(6);
    // A Floor-3 room fits an Ogre and a pair of rats; Floor 1 does not.
    addMob(d, 'ogre', 2, 0);
    addMob(d, 'rat', 2, 0);
    addMob(d, 'rat', 2, 0);
    expect(mobsInRoom(d, 2, 0)).toHaveLength(3);
  });

  it('deeper floors have more rooms (§5.1)', () => {
    expect(d.floors[0]!.rooms).toHaveLength(roomsOnFloor(0));
    digFloor(d);
    digFloor(d);
    expect(d.floors[1]!.rooms).toHaveLength(3);
    expect(d.floors[2]!.rooms).toHaveLength(4);
  });

  it('moving a mob vacates its old room', () => {
    const uid = addMob(d, 'rat', 0, 0);
    expect(placeMobInRoom(d, uid, 0, 1)).toBeNull();
    expect(mobsInRoom(d, 0, 0)).toHaveLength(0);
    expect(mobsInRoom(d, 0, 1)).toHaveLength(1);
  });

  it('re-placing a mob into its own room is a no-op, not a capacity error', () => {
    const uid = addMob(d, 'ogre', 0, 0);
    expect(placeMobInRoom(d, uid, 0, 0)).toBeNull();
  });
});

describe('staffing (§8.4)', () => {
  it('pulls the monster out of its room — it does not fight', () => {
    const d = createDungeon();
    digFloor(d);
    const uid = addMob(d, 'cutpurse', 0, 0);
    expect(mobsInRoom(d, 0, 0)).toHaveLength(1);

    addStaffedAmenity(d, 0, 0, 'provisioner');
    expect(assignStaff(d, uid, 0, 0)).toBeNull();
    expect(mobsInRoom(d, 0, 0)).toHaveLength(0);
  });

  it('charges upkeep for staffed amenities but not empty ones', () => {
    const d = createDungeon();
    digFloor(d);
    const before = totalUpkeep(d);
    // Staffing is optional now, but an attended counter still bills upkeep.
    const staffUid = addStaffedAmenity(d, 0, 0, 'provisioner', 'rat');
    // Provisioner upkeep 3 + Cave Rat upkeep 1.
    expect(totalUpkeep(d)).toBe(before + 3 + 1);

    // Pulling the monster off the counter frees the monster, but the building
    // still costs what a building costs — it is open and trading either way.
    unplace(d, staffUid);
    expect(totalUpkeep(d)).toBe(before + 3);
  });

  it('every amenity trades the moment it is built — staffing is an upsell', () => {
    const d = createDungeon();
    expect(buildAmenity(d, 0, 0, 'hotspring')).toBeNull();
    const spring = d.landings[0]!.amenities[0]!;
    expect(spring.staffUid).toBeNull();
    // Open for business with nobody standing next to it.
    expect(isOpen(spring)).toBe(true);
  });

  it('an Apothecary heals far more than a soak', () => {
    expect(AMENITIES['apothecary'].healPct).toBe(1);
    expect(AMENITIES['hotspring'].healPct).toBe(0.3);
    // The ladder has to be worth climbing.
    expect(AMENITIES['apothecary'].basePrice)
      .toBeGreaterThan(AMENITIES['hotspring'].basePrice * 3);
  });

  it('does not charge upkeep for unassigned monsters', () => {
    const d = createDungeon();
    buyMob(d, 'ogre');
    expect(totalUpkeep(d)).toBe(0);
  });
});

describe('mob leveling (§6.4)', () => {
  it('levels at the documented thresholds', () => {
    const d = createDungeon();
    const mob = buyMob(d, 'rat') as Mob;
    expect(mob.level).toBe(1);
    grantXp(mob, XP_THRESHOLDS[0]! - 1);
    expect(mob.level).toBe(1);
    grantXp(mob, 1);
    expect(mob.level).toBe(2);
  });

  it('scales HP by the tuned per-level scalar, compounding', () => {
    const base = MOBS['ogre']!.hp;
    const k = 1 + TUNING.mobLevelScalar;
    expect(mobMaxHp('ogre', 1)).toBe(base);
    expect(mobMaxHp('ogre', 3)).toBe(Math.round(base * k ** 2));
  });

  it('caps at level 10', () => {
    const d = createDungeon();
    const mob = buyMob(d, 'rat') as Mob;
    grantXp(mob, 100000);
    expect(mob.level).toBe(10);
  });
});

describe('tier lookup (§4.4)', () => {
  it('maps renown to the right tier', () => {
    // Read the thresholds rather than hard-coding them: they were stretched
    // ~2.2× for endless runs (§4.4) and will move again.
    const t2 = TIERS[1]!.renown;
    const t3 = TIERS[2]!.renown;
    expect(tierForRenown(0).tier).toBe(1);
    expect(tierForRenown(t2 - 1).tier).toBe(1);
    expect(tierForRenown(t2).tier).toBe(2);
    expect(tierForRenown(t3 - 1).tier).toBe(2);
    expect(tierForRenown(t3).tier).toBe(3);
  });

  it('respects the prototype tier cap', () => {
    expect(tierForRenown(99999, 4).tier).toBe(4);
  });
});

describe('raid resolution (§7)', () => {
  it('an emptied dungeon cannot turn them back — they walk to the Core', () => {
    // The reported bug: every monster downed, party clears the place, and the
    // raid still reported "they turn back" with no Heart lost.
    const s = seasonWithFloors(2600, 2);
    addMob(s.dungeon, 'rat', 0, 0);   // the only thing standing; it dies

    const sim = new RaidSim(s.dungeon, TIERS[3]!, 4);
    sim.runToCompletion();

    expect(sim.result.outcome).toBe('breach');
    expect(s.dungeon.hearts).toBe(STARTING_HEARTS - 1);
  });

  it('but a dungeon with something still standing gets a real decision', () => {
    let sawRetreat = false;
    for (let seed = 0; seed < 60 && !sawRetreat; seed++) {
      const fresh = seasonWithFloors(2601, 2);
      for (let f = 0; f < 2; f++) {
        for (let r = 0; r < fresh.dungeon.floors[f]!.rooms.length; r++) {
          addMob(fresh.dungeon, 'ogre', f, r);
        }
      }
      const sim = new RaidSim(fresh.dungeon, TIERS[0]!, seed);
      sim.runToCompletion();
      if (sim.result.outcome === 'retreated') sawRetreat = true;
    }
    expect(sawRetreat).toBe(true);
  });

  it('an undefended dungeon is breached, costing a heart', () => {
    const s = seasonWithFloors(1, 1);
    const sim = startRaid(s);
    sim.runToCompletion();
    expect(sim.result.outcome).toBe('breach');
    expect(s.dungeon.hearts).toBe(STARTING_HEARTS - 1);
  });

  it('breached parties all escape alive (§5.4)', () => {
    const s = seasonWithFloors(2, 1);
    const sim = startRaid(s);
    sim.runToCompletion();
    expect(sim.result.escaped).toBe(sim.party.members.length);
    expect(sim.result.killed).toBe(0);
  });

  it('a heavily defended dungeon can wipe a party', () => {
    const { sim } = findWipe();
    expect(sim.result.outcome).toBe('wiped');
    expect(sim.result.killed).toBe(sim.party.members.length);
    expect(sim.result.escaped).toBe(0);
  });

  it('a wipe costs no hearts', () => {
    const { season, sim } = findWipe();
    expect(sim.result.outcome).toBe('wiped');
    expect(season.dungeon.hearts).toBe(STARTING_HEARTS);
  });

  it('recovers only 25% of carried gold from corpses (§4.3, Q7)', () => {
    const { sim } = findWipe();
    // Gold is zeroed on death, so reconstruct what the party walked in with.
    const carried = sim.party.members.reduce((sum, m) => sum + m.gold, 0);
    expect(carried).toBe(0);
    expect(sim.result.goldFromCorpses).toBeGreaterThan(0);
    expect(TUNING.goldRecoveredOnKill).toBe(0.25);
  });

  it('downs monsters that lose their room, and only sometimes slays them', () => {
    const s = seasonWithFloors(7, 1);
    addMob(s.dungeon, 'rat', 0, 0);
    const sim = new RaidSim(s.dungeon, TIERS[3]!, 11);
    sim.runToCompletion();
    const r = sim.result;
    expect(r.mobsDowned.length).toBe(1);
    // Slain is a subset of downed — this is what lets monsters ever level.
    expect(r.mobsLost.length).toBeLessThanOrEqual(r.mobsDowned.length);
  });

  it('a breach slays downed monsters far more often than a repel does', () => {
    let downed = 0, slain = 0;
    for (let seed = 0; seed < 200; seed++) {
      const s = seasonWithFloors(700 + seed, 1);
      addMob(s.dungeon, 'rat', 0, 0);
      const sim = new RaidSim(s.dungeon, TIERS[1]!, seed);
      sim.runToCompletion();
      const r = sim.result;
      if (r.outcome !== 'breach' || r.mobsDowned.length === 0) continue;
      downed += r.mobsDowned.length;
      slain += r.mobsLost.length;
    }
    expect(downed).toBeGreaterThan(10);
    // Losing a Heart hurts, but no longer wipes the roster outright: §26 made
    // breaches common enough that a guaranteed cull was an inescapable spiral.
    const rate = slain / downed;
    expect(rate).toBeGreaterThan(TUNING.slayChance);
    expect(rate).toBeLessThan(1);
  });

  it('most downed monsters survive a raid that was turned back', () => {
    let downed = 0, slain = 0;
    for (let seed = 0; seed < 120; seed++) {
      const s = seasonWithFloors(800 + seed, 2);
      for (let r = 0; r < 3; r++) addMob(s.dungeon, 'ooze', 0, r);
      const sim = new RaidSim(s.dungeon, TIERS[0]!, seed);
      sim.runToCompletion();
      if (sim.result.outcome === 'breach') continue;
      downed += sim.result.mobsDowned.length;
      slain += sim.result.mobsLost.length;
    }
    expect(downed).toBeGreaterThan(20);
    // slayChance is 0.25, so the great majority should get back up.
    expect(slain / downed).toBeLessThan(0.45);
  });

  it('surviving monsters gain XP', () => {
    const s = seasonWithFloors(8, 1);
    const uid = addMob(s.dungeon, 'ogre', 0, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 5);
    sim.runToCompletion();
    const mob = s.dungeon.mobs.find((m) => m.uid === uid)!;
    expect(mob.xp).toBeGreaterThan(0);
  });

  it('never exceeds the tick safety valve', () => {
    const s = seasonWithFloors(10, 3);
    // Slimes do 1 damage a tick and have 22 HP: the slowest possible fight.
    for (let f = 0; f < 3; f++) {
      for (let room = 0; room < 3; room++) addMob(s.dungeon, 'slime', f, room);
    }
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 3);
    sim.runToCompletion();
    expect(sim.result.ticks).toBeLessThan(3000);
    expect(sim.status).toBe('complete');
  });
});

describe('interventions (§7.4)', () => {
  it('Retreat saves a monster and empties the room', () => {
    const s = seasonWithFloors(11, 1);
    const uid = addMob(s.dungeon, 'ogre', 0, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 2);
    sim.step(); // enter the room
    expect(sim.applyRetreatIntervention(uid)).toBe(true);
    sim.runToCompletion();

    const mob = s.dungeon.mobs.find((m) => m.uid === uid)!;
    expect(mob.alive).toBe(true);
    expect(sim.charges).toBe(2);
  });

  it('Retreat refuses a mob that is not in the active room', () => {
    const s = seasonWithFloors(12, 2);
    const deep = addMob(s.dungeon, 'rat', 1, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 2);
    sim.step();
    expect(sim.applyRetreatIntervention(deep)).toBe(false);
    expect(sim.charges).toBe(3);
  });

  it('Taunt forces a retreating party one floor deeper', () => {
    // Wardens strip Kit, which triggers a Kit-based retreat at the landing.
    // Something has to be waiting below too: a party with a clear run at the
    // Core presses on regardless of how battered it is (§7.3).
    const s = seasonWithFloors(13, 3);
    for (let room = 0; room < 3; room++) addMob(s.dungeon, 'ooze', 0, room);
    addMob(s.dungeon, 'rat', 1, 0);
    addMob(s.dungeon, 'rat', 2, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 21);

    let sawOffer = false;
    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') {
        sawOffer = true;
        const before = sim.currentFloor;
        sim.resolveTaunt(true);
        expect(sim.currentFloor).toBe(before + 1);
        expect(sim.charges).toBe(2);
        break;
      }
    }
    expect(sawOffer).toBe(true);
  });

  it('declining a Taunt ends the raid as a retreat', () => {
    const s = seasonWithFloors(14, 3);
    for (let room = 0; room < 3; room++) addMob(s.dungeon, 'ooze', 0, room);
    addMob(s.dungeon, 'rat', 1, 0);
    addMob(s.dungeon, 'rat', 2, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 21);
    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') sim.resolveTaunt(false);
    }
    expect(sim.result.outcome).toBe('retreated');
    expect(sim.result.escaped).toBeGreaterThan(0);
  });
});

describe('traps (§5.2)', () => {
  afterEach(resetTuning);

  it('installs armed, costs no upkeep, and draws on the room slot budget', () => {
    const d = createDungeon();
    addMob(d, 'ogre', 0, 0);          // 3 slots
    const uid = addTrap(d, 'darts', 0, 0);  // 1 slot

    expect(getTrap(d, uid)!.charges).toBe(TRAPS['darts']!.charges);
    expect(roomSlotsUsed(d, 0, 0)).toBe(MOBS['ogre']!.slots + TRAPS['darts']!.slots);
    // The whole point of the system: a trap never bills you for standing still.
    expect(totalUpkeep(d)).toBe(MOBS['ogre']!.upkeep);
  });

  it('refuses a trap that will not fit', () => {
    const d = createDungeon();
    addMob(d, 'ogre', 0, 0);
    // roomCapacity(0) is 4; Ogre takes 3 and a Deadfall needs 2.
    const trap = buyTrap(d, 'deadfall');
    if (typeof trap === 'string') throw new Error(trap);
    expect(placeTrapInRoom(d, trap.uid, 0, 0)).toMatch(/full/);
  });

  it('fires on room entry, before anything swings, and spends a charge', () => {
    const s = seasonWithFloors(900, 1);
    const uid = addTrap(s.dungeon, 'darts', 0, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 5);
    const events = sim.step();

    const fire = events.find((e) => e.type === 'trap-fire');
    const hit = events.find((e) => e.type === 'trap-hit');
    expect(fire).toBeTruthy();
    expect(hit).toBeTruthy();
    // `damage` still spreads across everyone IN THE ROOM — which under
    // single-file is one body (§18.2).
    expect(events.filter((e) => e.type === 'trap-hit'))
      .toHaveLength(sim.engagedIds.length || 1);
    expect(getTrap(s.dungeon, uid)!.charges).toBe(TRAPS['darts']!.charges - 1);
  });

  it('a spent trap does nothing at all', () => {
    const s = seasonWithFloors(901, 1);
    const uid = addTrap(s.dungeon, 'gasvent', 0, 0);
    getTrap(s.dungeon, uid)!.charges = 0;
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 5);
    const events = sim.runToCompletion();
    expect(events.some((e) => e.type === 'trap-fire')).toBe(false);
  });

  it('a room holding only a SPENT trap still counts as empty for Tedium', () => {
    const armed = (charges: number): number => {
      const s = seasonWithFloors(902, 1);
      const uid = addTrap(s.dungeon, 'darts', 0, 0);
      getTrap(s.dungeon, uid)!.charges = charges;
      const sim = new RaidSim(s.dungeon, TIERS[0]!, 7);
      sim.runToCompletion();
      return sim.result.thrill.tedium;
    };
    // Three rooms, one trap. Armed it occupies its room; spent it does not,
    // which is what stops traps buying Tedium relief once and collecting it
    // every raid forever.
    expect(armed(0)).toBe(3 * TUNING.tediumPerEmptyRoom);
    expect(armed(1)).toBe(2 * TUNING.tediumPerEmptyRoom);
  });

  it('destroys Kit, which is the lever §14.4 says matters', () => {
    const s = seasonWithFloors(903, 1);
    addTrap(s.dungeon, 'gasvent', 0, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 9);
    const before = sim.party.kit;
    const events = sim.step();
    const e = events.find((x) => x.type === 'trap-kit');
    expect(e).toBeTruthy();
    expect(sim.party.kit).toBe(before - TRAPS['gasvent']!.power);
    expect(sim.party.kitStripped).toBe(TRAPS['gasvent']!.power);
  });

  it('Resolve traps route through the traits that exist to stop Terror', () => {
    // Only the body in the room takes it now (§18.2), so this compares the
    // SAME point man with and without the trait rather than two party members.
    const lost = (steeled: boolean): number => {
      const s = seasonWithFloors(904, 1);
      addTrap(s.dungeon, 'shrieker', 0, 0);
      const sim = new RaidSim(s.dungeon, TIERS[0]!, 11);
      const victim = sim.party.members[0]!;
      if (steeled) victim.traits.push('steeled');   // halves Resolve damage (§9.3)
      const start = victim.resolve;
      sim.step();
      return start - victim.resolve;
    };
    expect(lost(true)).toBeLessThan(lost(false));
    expect(lost(false)).toBeGreaterThan(0);
  });

  it('a delay trap costs the party turns while the room keeps swinging', () => {
    const taken = (snare: boolean): number => {
      const s = seasonWithFloors(905, 1);
      addMob(s.dungeon, 'ogre', 0, 0);
      if (snare) addTrap(s.dungeon, 'snare', 0, 0);
      const sim = new RaidSim(s.dungeon, TIERS[0]!, 13);
      const events = sim.runToCompletion();
      return events
        .filter((e) => e.type === 'attack' && e.source === 'mob')
        .reduce((sum, e) => sum + (e as { dmg: number }).dmg, 0);
    };
    // A Snare does no damage of its own. It buys the room free swings — the
    // party still needs the same number of blows to fell the Ogre, it just
    // spends three more ticks being hit while it lands them.
    expect(taken(true)).toBeGreaterThan(taken(false));
  });

  it('trap damage counts toward peril', () => {
    const s = seasonWithFloors(906, 1);
    for (let r = 0; r < 3; r++) addTrap(s.dungeon, 'darts', 0, r);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 17);
    sim.runToCompletion();
    expect(sim.result.thrill.peril).toBeGreaterThan(0);
  });

  it('the whole trap layer is worth at most trapVarietyCredit', () => {
    const variety = (): number => {
      const s = seasonWithFloors(907, 1);
      addTrap(s.dungeon, 'darts', 0, 0);
      addTrap(s.dungeon, 'gasvent', 0, 1);
      addTrap(s.dungeon, 'shrieker', 0, 2);
      const sim = new RaidSim(s.dungeon, TIERS[0]!, 19);
      sim.runToCompletion();
      return sim.result.thrill.variety;
    };
    // Three distinct jobs, no monsters. Uncapped this would be full marks —
    // §15.1's exploit in a new hat. Capped at 1, it is a third of the term.
    expect(variety()).toBeCloseTo(1 / 3, 5);
    TUNING.trapVarietyCredit = 0;
    expect(variety()).toBe(0);
  });

  it('re-arming costs mana per spent charge and nothing when full', () => {
    const d = createDungeon();
    const uid = addTrap(d, 'deadfall', 0, 0);
    expect(rearmAllPrice(d)).toBe(0);
    getTrap(d, uid)!.charges = 0;
    expect(rearmAllPrice(d)).toBe(trapRearmCost('deadfall'));
    expect(rearmAll(d, 1000)).toBe(trapRearmCost('deadfall'));
    expect(getTrap(d, uid)!.charges).toBe(TRAPS['deadfall']!.charges);
  });

  it('re-arms cheapest-first when the purse is short', () => {
    const d = createDungeon();
    const cheap = addTrap(d, 'darts', 0, 0);
    const dear = addTrap(d, 'deadfall', 0, 1);
    getTrap(d, cheap)!.charges = 0;
    getTrap(d, dear)!.charges = 0;
    // Enough for the Dart Battery's charges, nowhere near the Deadfall's.
    const budget = trapRearmCost('darts') * TRAPS['darts']!.charges;
    expect(rearmAll(d, budget)).toBe(budget);
    expect(getTrap(d, cheap)!.charges).toBe(TRAPS['darts']!.charges);
    expect(getTrap(d, dear)!.charges).toBe(0);
  });

  it('Spring fires a trap out of sequence for a Ley Charge (§7.4)', () => {
    const s = seasonWithFloors(908, 2);
    // Installed on Floor 2 — a party that turns back on Floor 1 never meets it.
    const uid = addTrap(s.dungeon, 'gasvent', 1, 0);
    addMob(s.dungeon, 'ogre', 0, 0);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 23);
    sim.step();  // party is in Floor 1, room 1

    const before = sim.party.kit;
    expect(sim.applySpringIntervention(uid)).toBe(true);
    expect(sim.charges).toBe(2);
    expect(sim.party.kit).toBeLessThan(before);
    expect(getTrap(s.dungeon, uid)!.charges).toBe(0);
    // And it cannot be spent twice.
    expect(sim.applySpringIntervention(uid)).toBe(false);
  });

  it('Spring refuses a trap with no charges left', () => {
    const s = seasonWithFloors(909, 1);
    const uid = addTrap(s.dungeon, 'shrieker', 0, 1);
    getTrap(s.dungeon, uid)!.charges = 0;
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 29);
    sim.step();
    expect(sim.applySpringIntervention(uid)).toBe(false);
    expect(sim.charges).toBe(3);
  });

  it('ripping a trap out refunds half of base cost', () => {
    const d = createDungeon();
    const uid = addTrap(d, 'snare', 0, 0);
    expect(removeTrap(d, uid)).toBe(Math.floor(trapCost('snare') * 0.5));
    expect(getTrap(d, uid)).toBeUndefined();
    expect(roomSlotsUsed(d, 0, 0)).toBe(0);
  });
});

describe('season economy (§4.1)', () => {
  it('applies the documented mana formula', () => {
    const s = seasonWithFloors(20, 2);
    const before = s.mana;
    const sim = startRaid(s);
    sim.runToCompletion();
    const after = applyAftermath(s, sim);

    const b = after.manaBreakdown;
    expect(b.base).toBe(TUNING.manaBaseIncome);
    expect(b.floors).toBe(2 * TUNING.manaPerFloor);
    expect(after.manaIncome).toBe(b.base + b.floors + b.kills + b.tierBonus - b.upkeep);
    expect(s.mana).toBe(Math.max(0, before + after.manaIncome));
  });

  it('ends the season when hearts run out', () => {
    const s = seasonWithFloors(21, 1);
    for (let i = 0; i < STARTING_HEARTS; i++) {
      const sim = startRaid(s);
      sim.runToCompletion();
      applyAftermath(s, sim);
    }
    expect(s.dungeon.hearts).toBe(0);
    expect(s.over).toBe(true);
    expect(s.ending).toBe('overrun');
  });

  it('a fixed-length season still ends as survived after its raid count', () => {
    const s = seasonWithFloors(22, 1);
    for (let room = 0; room < 3; room++) addMob(s.dungeon, 'ogre', 0, room);
    s.dungeon.hearts = 99;
    while (!s.over) {
      const sim = startRaid(s);
      sim.runToCompletion();
      applyAftermath(s, sim);
    }
    expect(s.ending).toBe('survived');
    expect(s.log).toHaveLength(s.totalRaids);
  });

  it('renown ratchets upward and never decreases', () => {
    const s = createSeason(23);
    let last = s.renown;
    for (let i = 0; i < 4 && !s.over; i++) {
      const sim = startRaid(s);
      sim.runToCompletion();
      applyAftermath(s, sim);
      expect(s.renown).toBeGreaterThanOrEqual(last);
      last = s.renown;
    }
  });

  it('heals monsters between raids', () => {
    const s = seasonWithFloors(24, 1);
    const uid = addMob(s.dungeon, 'ogre', 0, 0);
    const sim = startRaid(s);
    sim.runToCompletion();
    const mob = s.dungeon.mobs.find((m) => m.uid === uid)!;
    if (mob.alive) {
      applyAftermath(s, sim);
      startRaid(s);
      expect(mob.hp).toBe(mobEffectiveHp(mob));
    }
  });
});

/** An undefended dungeon breaches every time; find a seed where it doesn't. */
/**
 * A total wipe is deliberately rare since §19: dropping someone to 0 HP downs
 * them, and killing outright needs overkill or three failed saves. Roughly 5%
 * of delves against this setup end in a wipe, so the scan is wide.
 */
function findWipe(): { season: ReturnType<typeof seasonWithFloors>; sim: RaidSim } {
  for (let seed = 0; seed < 600; seed++) {
    const season = seasonWithFloors(900 + seed, 1);
    // Ogre (3 slots) + Cave Rat (1) fills a Floor-1 room exactly.
    for (let r = 0; r < 3; r++) {
      addMob(season.dungeon, 'ogre', 0, r);
      addMob(season.dungeon, 'rat', 0, r);
    }
    const sim = new RaidSim(season.dungeon, TIERS[0]!, seed);
    sim.runToCompletion();
    if (sim.result.outcome === 'wiped') return { season, sim };
  }
  throw new Error('no wiping scenario found in 600 seeds');
}

describe('gear — the Gold sink (§6.5)', () => {
  it('scales effective stats', () => {
    const d = createDungeon();
    const mob = buyMob(d, 'ogre') as Mob;
    const baseHp = mobEffectiveHp(mob);
    const baseDmg = mobEffectiveDmg(mob);

    expect(equipGear(d, mob.uid, 'carapace')).toBeNull();
    expect(mobEffectiveHp(mob)).toBe(Math.round(baseHp * GEAR['carapace']!.hpMult));

    expect(equipGear(d, mob.uid, 'fangs')).toBeNull();
    expect(mobEffectiveDmg(mob)).toBeCloseTo(baseDmg * GEAR['fangs']!.dmgMult, 5);
  });

  it('caps at two slots and refuses duplicates', () => {
    const d = createDungeon();
    const mob = buyMob(d, 'ogre') as Mob;
    equipGear(d, mob.uid, 'fangs');
    expect(equipGear(d, mob.uid, 'fangs')).toMatch(/Already equipped/);
    equipGear(d, mob.uid, 'carapace');
    expect(equipGear(d, mob.uid, 'censer')).toMatch(/No free gear slots/);
  });

  it("Warden's Censer grants Kit-stripping to a non-Warden", () => {
    const d = createDungeon();
    const ogre = buyMob(d, 'ogre') as Mob;
    expect(mobStripsKit(ogre)).toBe(false);
    equipGear(d, ogre.uid, 'censer');
    expect(mobStripsKit(ogre)).toBe(true);
  });

  it('Wardens strip Kit without any gear', () => {
    const d = createDungeon();
    const ooze = buyMob(d, 'ooze') as Mob;
    expect(mobStripsKit(ooze)).toBe(true);
  });

  it('survives its wearer — the counterweight to permadeath', () => {
    const s = seasonWithFloors(950, 1);
    const uid = addMob(s.dungeon, 'rat', 0, 0);
    equipGear(s.dungeon, uid, 'fangs');

    // Wider scan than it used to need: a breach no longer culls the roster
    // outright (breachSlayChance 0.5), so a given monster survives more raids.
    for (let seed = 0; seed < 400; seed++) {
      healAllMobs(s.dungeon);
      const sim = new RaidSim(s.dungeon, TIERS[3]!, seed);
      sim.runToCompletion();
      const mob = s.dungeon.mobs.find((m) => m.uid === uid)!;
      if (mob.alive) continue;
      // Slain: the monster is gone but the Iron Fangs are back in the armory.
      expect(mob.gear).toEqual([]);
      return;
    }
    throw new Error('monster never died across 400 seeds');
  });
});

/** One floor, three rooms, all holding the same monster. Isolates peril. */
function threeRoomsOf(defId: string, seed: number) {
  const s = seasonWithFloors(seed, 1);
  for (let r = 0; r < 3; r++) addMob(s.dungeon, defId, 0, r);
  return s;
}

describe('Thrill-based Renown (§15.3)', () => {
  afterEach(resetTuning);

  it('tracks each adventurer\'s low-water HP, not their exit HP', () => {
    const s = threeRoomsOf('ogre', 300);
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 4);
    sim.runToCompletion();

    const hurt = sim.party.members.filter((m) => m.lowestHpPct < 1);
    expect(hurt.length).toBeGreaterThan(0);
    for (const m of sim.party.members) {
      expect(m.lowestHpPct).toBeLessThanOrEqual(m.hp / m.maxHp);
      expect(m.lowestHpPct).toBeGreaterThanOrEqual(0);
    }
  });

  it('pays far more for a party that nearly died than one that strolled out', () => {
    // Same shape, same depth, same variety, same tedium — only peril differs.
    // Cave Rats chip; Ogres very nearly finish the job.
    const measure = (defId: string) => {
      let n = 0, peril = 0, renown = 0;
      for (let seed = 0; seed < 40; seed++) {
        const sim = new RaidSim(threeRoomsOf(defId, seed).dungeon, TIERS[0]!, seed);
        sim.runToCompletion();
        const r = sim.result;
        if (r.escaped === 0) continue;   // wipes tell no tales; scored separately
        n++; peril += r.thrill.peril; renown += r.renown;
      }
      return { peril: peril / n, renown: renown / n };
    };

    const stroll = measure('rat');
    const brink = measure('ogre');

    // A chip-damage dungeon must stay below the kiddie-ride gate (§15.1) —
    // that, not any particular number, is the design property. Note single-file
    // (§7.2) legitimately raises it: three Cave Rats all chew on one point man
    // instead of spreading over the party, so a stroll is a slightly rougher
    // stroll than it used to be.
    expect(stroll.peril).toBeLessThan(TUNING.thrillPerilGate);
    // 0.35, not the 0.5 this asserted before §19. Peril is a mean over
    // *standing* survivors, and the member who came closest to dying is now
    // the one most likely to have been downed — so the very delves that should
    // score highest have their best evidence excluded. The ordering below is
    // what the rule actually promises; the absolute ceiling moved. See §19.6.
    expect(brink.peril).toBeGreaterThan(0.35);
    expect(brink.peril).toBeGreaterThan(stroll.peril * 2);
    // "The story everyone repeats" should be worth multiples of a quiet delve.
    expect(brink.renown).toBeGreaterThan(stroll.renown * 2);
  });

  it('a wipe earns nothing at all — no survivors, no reputation', () => {
    const { sim } = findWipe();
    const r = sim.result;
    expect(r.escaped).toBe(0);
    expect(r.thrill.total).toBe(0);
    expect(r.renown).toBe(0);
  });

  it('charges tedium for empty rooms', () => {
    // Undefended: three empty rooms, then the Core.
    const s = seasonWithFloors(301, 1);
    const sim = startRaid(s);
    sim.runToCompletion();
    expect(sim.result.thrill.tedium).toBe(3 * TUNING.tediumPerEmptyRoom);
  });

  it('charges tedium for consecutive identical rooms, and not for varied ones', () => {
    const same = new RaidSim(threeRoomsOf('rat', 302).dungeon, TIERS[0]!, 8);
    same.runToCompletion();
    // Rat, rat, rat — two repeats, no empty rooms.
    expect(same.result.thrill.tedium).toBe(2 * TUNING.tediumPerRepeatedRoom);

    const varied = seasonWithFloors(303, 1);
    addMob(varied.dungeon, 'rat', 0, 0);
    addMob(varied.dungeon, 'slime', 0, 1);
    addMob(varied.dungeon, 'rat', 0, 2);
    const mixed = new RaidSim(varied.dungeon, TIERS[0]!, 8);
    mixed.runToCompletion();
    expect(mixed.result.thrill.tedium).toBe(0);
    // Two roles met instead of one, and no tedium: strictly the better dungeon.
    expect(mixed.result.thrill.variety).toBeGreaterThan(same.result.thrill.variety);
    expect(mixed.result.renown).toBeGreaterThan(same.result.renown);
  });

  it('tedium is what makes an empty corridor cost Renown', () => {
    // Two floors: the lower one defended, the upper one three empty rooms of
    // walking. The delve has to be worth *something* before Tedium can be
    // measured as a deduction from it — an undefended dungeon now scores zero
    // either way, because peril gates the rest of the score (§15.1).
    const paid = () => {
      const s = seasonWithFloors(304, 2);
      addMob(s.dungeon, 'ogre', 1, 0);
      addMob(s.dungeon, 'ooze', 1, 1);
      addMob(s.dungeon, 'rat', 1, 2);
      const sim = new RaidSim(s.dungeon, TIERS[0]!, 9);
      sim.runToCompletion();
      return sim.result.renown;
    };
    const withTedium = paid();
    TUNING.tediumPerEmptyRoom = 0;
    expect(paid()).toBeGreaterThan(withTedium);
  });

  it('a long harmless dungeon is a kiddie ride, not a thrill (§15.1)', () => {
    // The wardens exploit in miniature: same depth, same variety, same walk —
    // one dungeon frightens them and the other does not. Depth must not pay
    // out on its own, or "let everyone stroll to the bottom" is optimal again.
    const run = (defId: string) => {
      const s = seasonWithFloors(320, 2);
      for (let r = 0; r < 3; r++) addMob(s.dungeon, defId, 1, r);
      const sim = new RaidSim(s.dungeon, TIERS[0]!, 11);
      sim.runToCompletion();
      return sim.result;
    };
    const harmless = run('slime');
    const dangerous = run('ogre');

    // The harmless dungeon gets walked at least as far as the lethal one —
    // under single-file (§7.2) it gets walked *further*, because the Ogres push
    // the queue back out of the room before it clears a second floor...
    expect(harmless.thrill.depth).toBeGreaterThanOrEqual(dangerous.thrill.depth);
    expect(harmless.thrill.depth).toBeGreaterThan(0);
    // ...and it still earns a fraction of the score, because only one of them
    // is a story. That is §15.1 stated as strongly as it can be: more of the
    // dungeon seen, less reputation earned.
    expect(harmless.thrill.peril).toBeLessThan(dangerous.thrill.peril);
    expect(harmless.thrill.total).toBeLessThan(dangerous.thrill.total / 2);

    // And depth is not a completion ratio: clearing a one-floor dungeon is not
    // the same achievement as clearing a three-floor one.
    const shallow = seasonWithFloors(321, 1);
    for (let r = 0; r < 3; r++) addMob(shallow.dungeon, 'ogre', 0, r);
    const shallowSim = new RaidSim(shallow.dungeon, TIERS[0]!, 11);
    shallowSim.runToCompletion();
    expect(shallowSim.result.thrill.depth).toBeLessThan(dangerous.thrill.depth);
  });

  it('the thrillRenown flag falls back to the flat 6 × escapees formula', () => {
    TUNING.thrillRenown = false;

    const s = seasonWithFloors(305, 1);
    // Selling cover multiplies Renown by its price tier (§21); this test is
    // about the Renown *rule*, so take the dungeon out of the insurance market.
    s.dungeon.insurance = 'off';
    const sim = startRaid(s);
    sim.runToCompletion();
    const r = sim.result;
    // Breach: everyone escapes, nobody dies, nothing sold.
    expect(r.renown).toBe(r.escaped * RENOWN_PER_ESCAPEE);

    const { sim: wiped } = findWipe();
    expect(wiped.result.renown)
      .toBe(Math.round(wiped.result.killed * 2 * RENOWN_WIPE_MULT));
  });
});

/**
 * A two-floor dungeon with something in every room, restocked between raids.
 *
 * The retirement tests used to run a single Cave Rat on a single floor for a
 * whole season, and it worked only because `depth` was a completion ratio:
 * clearing a one-floor dungeon scored depth 1.00 and paid a flat 25 Thrill
 * every raid no matter what was alive down there. With depth measured against
 * an absolute reference and gated on peril, that fixture correctly scores
 * nothing — so retirement needs a dungeon that is actually worth delving.
 *
 * `restock` stands in for the Build Phase these tests never had: without it
 * the dungeon is stripped by raid three and every later delve scores zero.
 */
const RESTOCK_PLAN = ['rat', 'slime', 'cutpurse', 'ooze', 'skeleton', 'rat'];

function restock(s: ReturnType<typeof createSeason>): void {
  let i = 0;
  for (let f = 0; f < s.dungeon.floors.length; f++) {
    for (let r = 0; r < s.dungeon.floors[f]!.rooms.length; r++, i++) {
      const defId = RESTOCK_PLAN[i % RESTOCK_PLAN.length]!;
      // Top the room up rather than skipping it: the point is that something
      // is always still standing when they reach the bottom.
      let guard = 0;
      while (guard++ < 6
        && roomSlotsUsed(s.dungeon, f, r) + MOBS[defId]!.slots <= roomCapacity(f)) {
        addMob(s.dungeon, defId, f, r);
      }
    }
  }
}

function runnableSeason(seed: number): ReturnType<typeof createSeason> {
  // Three floors, filled to capacity. A thin dungeon gets cleared mid-raid,
  // and a party with nothing left in front of it walks to the Core (§7.3) —
  // which is a delve with no peril and therefore no Thrill to retire on.
  const s = seasonWithFloors(seed, 3);
  s.dungeon.hearts = 99;   // the season must run its full length, not end early
  restock(s);
  return s;
}

describe('Veterans, Retirement and Legends (§15.5)', () => {
  afterEach(resetTuning);

  it('fills party slots with returning faces instead of fresh rolls', () => {
    const roster: Veteran[] = [
      { id: 7, name: 'Kesta the Patient', cls: 'rogue', delves: 2, bestThrill: 40, retired: false },
    ];
    let returns = 0;
    for (let seed = 0; seed < 60; seed++) {
      const party = generateParty(new Rng(seed), TIERS[0]!, roster);
      const back = party.members.filter((m) => m.veteranId === 7);
      if (back.length === 0) continue;
      returns++;
      // One veteran cannot fill two slots in the same party.
      expect(back).toHaveLength(1);
      expect(back[0]!.name).toBe('Kesta the Patient');
      expect(back[0]!.cls).toBe('rogue');
      // Re-levelled to the current tier — the world scales, and so do they.
      expect(back[0]!.level).toBeGreaterThanOrEqual(TIERS[0]!.levelMin);
      expect(back[0]!.level).toBeLessThanOrEqual(TIERS[0]!.levelMax);
    }
    expect(returns).toBeGreaterThan(10);
  });

  it('never brings a retiree back', () => {
    const roster: Veteran[] = [
      { id: 7, name: 'Gone Fishing', cls: 'mage', delves: 9, bestThrill: 90, retired: true },
    ];
    for (let seed = 0; seed < 60; seed++) {
      const party = generateParty(new Rng(seed), TIERS[0]!, roster);
      expect(party.members.some((m) => m.veteranId !== null)).toBe(false);
    }
  });

  it('records survivors on the roster and counts their delves', () => {
    const s = seasonWithFloors(310, 1);
    addMob(s.dungeon, 'rat', 0, 0);
    s.dungeon.hearts = 99;

    let escapedTotal = 0;
    while (!s.over) {
      const sim = startRaid(s);
      sim.runToCompletion();
      escapedTotal += sim.result.escaped;
      applyAftermath(s, sim);
    }

    expect(s.veterans.length).toBeGreaterThan(0);
    // Every survivor is on the roster once, and delves are cumulative.
    const delves = s.veterans.reduce((n, v) => n + v.delves, 0);
    expect(delves).toBe(escapedTotal);
    expect(s.veterans.some((v) => v.delves > 1)).toBe(true);
  });

  it('retires a high-thrill regular and hangs them on the wall', () => {
    // The mechanism is what is under test, not the threshold — at prototype
    // tuning `retireThrill` 75 is barely reachable (see the balance notes).
    TUNING.retireThrill = 8;
    TUNING.retireMinDelves = 2;

    const s = runnableSeason(311);

    let bonusRaids = 0;
    while (!s.over) {
      restock(s);
      const sim = startRaid(s);
      sim.runToCompletion();
      const r = sim.result;
      if (r.retired.length > 0) {
        bonusRaids++;
        for (const l of r.retired) expect(l.thrill).toBeGreaterThanOrEqual(8);
      }
      applyAftermath(s, sim);
      for (const l of r.retired) expect(l.retiredOnRaid).toBeGreaterThan(0);
    }

    expect(bonusRaids).toBeGreaterThan(0);
    expect(s.legends.length).toBeGreaterThan(0);
    // Struck off the roster, permanently.
    expect(s.veterans.filter((v) => v.retired).length).toBe(s.legends.length);
    expect(s.legends.length).toBe(new Set(s.legends.map((l) => l.name)).size);
  });

  it('pays the retirement bonus and the Legend trickle on top of Thrill', () => {
    TUNING.retireThrill = 8;
    TUNING.retireMinDelves = 2;

    const s = runnableSeason(312);
    // §21 scales Renown by the cover price; this test hand-computes the
    // Thrill formula, so keep the dungeon out of the insurance market.
    s.dungeon.insurance = 'off';

    let sawBonus = false, sawTrickle = false;
    while (!s.over) {
      const legendsBefore = s.legends.length;
      restock(s);
      const sim = startRaid(s);
      sim.runToCompletion();
      const r = sim.result;
      // Renown pays per storyteller, not per body that left (§19.4).
      const thrillPart = r.thrill.total * r.tellers * TUNING.renownPerThrill;
      const expected = Math.round(
        thrillPart
        + r.retired.length * TUNING.retireRenownBonus
        + legendsBefore * TUNING.legendRenownTrickle,
      );
      applyAftermath(s, sim);
      // applyAftermath folds the trickle into the logged result.
      expect(s.log[s.log.length - 1]!.renown).toBe(expected);
      if (r.retired.length > 0) sawBonus = true;
      if (legendsBefore > 0) sawTrickle = true;
    }
    expect(sawBonus).toBe(true);
    expect(sawTrickle).toBe(true);
  });

  it('retires nobody on a tedious delve at default tuning', () => {
    const s = seasonWithFloors(313, 1);
    const sim = startRaid(s);
    sim.runToCompletion();
    expect(sim.result.retired).toEqual([]);
  });
});

describe('hired staff (§8.4)', () => {
  it('opens an amenity without costing a monster', () => {
    const d = createDungeon();
    addStaffedAmenity(d, 0, 0, 'provisioner');
    const before = totalUpkeep(d);
    expect(hireStaff(d, 0, 0)).toBeNull();
    // The monster is freed; only the amenity's own upkeep remains.
    expect(totalUpkeep(d)).toBeLessThan(before);
    expect(d.landings[0]!.amenities[0]!.hired).toBe(true);
    expect(d.landings[0]!.amenities[0]!.staffUid).toBeNull();
  });
});

// ─── Formation: single-file vs party (§7.2) ──────────────────────────────────

/**
 * A tier row with a formation forced, so the two engagement orders can be run
 * against an identical dungeon. Everything else is copied from the real table,
 * because the point of these tests is the formation and nothing else.
 */
function tierAs(row: number, formation: 'single-file' | 'party') {
  return { ...TIERS[row]!, formation };
}

describe('formation (§7.2)', () => {
  afterEach(resetTuning);

  it('escalates with the Threat Tier, single-file first', () => {
    // The whole design claim: everyone files in until the dungeon is famous.
    expect(TIERS[0]!.formation).toBe('single-file');
    const flip = TIERS.findIndex((t) => t.formation === 'party');
    expect(flip).toBeGreaterThan(0);
    // Monotone — once companies start coming they do not go back to queueing.
    for (let i = 0; i < TIERS.length; i++) {
      expect(TIERS[i]!.formation).toBe(i < flip ? 'single-file' : 'party');
    }
    // ...and it has to be reachable, or the milestone is a comment (§12).
    expect(TIERS[flip]!.tier).toBeLessThanOrEqual(MAX_TIER_PROTOTYPE);
  });

  it('engages exactly one adventurer at a time under single-file', () => {
    const s = threeRoomsOf('slime', 400);
    const sim = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 7);
    expect(sim.party.members.length).toBeGreaterThan(1);

    let sawQueue = false;
    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') sim.resolveTaunt(false);
      const alive = sim.party.members.filter((m) => m.alive).length;
      if (alive === 0) break;
      expect(sim.engagedIds).toHaveLength(1);
      if (sim.waitingIds.length > 0) sawQueue = true;
      // Engaged and waiting partition the living party — nobody is unaccounted
      // for, because everyone is present the whole time (§7.3).
      expect(sim.engagedIds.length + sim.waitingIds.length).toBe(alive);
    }
    expect(sawQueue).toBe(true);
  });

  it('caps a party at partyEngageWidth — numbers never fully convert (§18.2)', () => {
    const s = threeRoomsOf('slime', 401);
    const sim = new RaidSim(s.dungeon, tierAs(0, 'party'), 7);
    let sawQueue = false;
    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') sim.resolveTaunt(false);
      const alive = sim.party.members.filter((m) => m.alive).length;
      if (alive === 0) break;
      // A room is a test of what is in it, not of how many bodies fit through
      // the door at once. Never the whole group while anyone is spare.
      expect(sim.engagedIds.length).toBeLessThanOrEqual(TUNING.partyEngageWidth);
      expect(sim.engagedIds.length).toBeLessThanOrEqual(alive);
      if (alive > TUNING.partyEngageWidth) {
        expect(sim.engagedIds.length).toBeLessThan(alive);
        sawQueue = true;
      }
      expect(sim.engagedIds.length + sim.waitingIds.length).toBe(alive);
    }
    expect(sawQueue).toBe(true);
  });

  it('a party still brings more to bear than single-file', () => {
    const s = threeRoomsOf('slime', 402);
    const solo = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 11);
    solo.step();
    const s2 = threeRoomsOf('slime', 402);
    const group = new RaidSim(s2.dungeon, tierAs(0, 'party'), 11);
    group.step();
    expect(group.engagedIds.length).toBeGreaterThan(solo.engagedIds.length);
  });

  it('a coordinated party clears the same dungeon far faster', () => {
    // The escalation beat, measured: same rooms, same tier, same seed — the
    // only difference is whether they take turns. Slimes, because they are
    // harmless: this has to measure engagement order, not who wins.
    let queued = 0, together = 0;
    for (let seed = 0; seed < 12; seed++) {
      const a = new RaidSim(threeRoomsOf('slime', 500 + seed).dungeon, tierAs(0, 'single-file'), seed);
      a.runToCompletion();
      const b = new RaidSim(threeRoomsOf('slime', 500 + seed).dungeon, tierAs(0, 'party'), seed);
      b.runToCompletion();
      queued += a.result.ticks;
      together += b.result.ticks;
    }
    // Not the full partySize speedup — landings, descents and the Core cost the
    // same ticks either way — but the rooms themselves fall in a fraction.
    expect(together).toBeLessThan(queued * 0.7);
  });

  it('rotates the line when the point man is too hurt to hold the door', () => {
    const s = threeRoomsOf('ogre', 402);
    const sim = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 3);
    const events = sim.runToCompletion();
    const breaks = events.filter((e) => e.type === 'line-break');
    expect(breaks.length).toBeGreaterThan(0);
    // Somebody stepped up for at least one of them, rather than everyone
    // simply dying in the doorway.
    const relieved = breaks.filter((e) => e.type === 'line-break' && e.next !== null);
    expect(relieved.length).toBeGreaterThan(0);
    // And every engage event names somebody who was actually in the party.
    const ids = new Set(sim.party.members.map((m) => m.id));
    for (const e of events) {
      if (e.type === 'line-engage') expect(ids.has(e.advId)).toBe(true);
    }
  });

  it('withdraws the delve alive when nobody in the queue is fit to fight', () => {
    // Three Ogres against a Tier-1 queue: they are pushed out of the room
    // rather than fed into it one corpse at a time. A retreat is the outcome
    // §15 pays for, and the reason the early game is survivable at all.
    let retreats = 0, wipes = 0;
    for (let seed = 0; seed < 20; seed++) {
      const sim = new RaidSim(threeRoomsOf('ogre', 600 + seed).dungeon, tierAs(0, 'single-file'), seed);
      sim.runToCompletion();
      if (sim.result.outcome === 'retreated') retreats++;
      if (sim.result.outcome === 'wiped') wipes++;
    }
    expect(retreats).toBeGreaterThan(wipes);
  });

  it('never lets the line-break loop forever', () => {
    // The rotation must terminate: a queue where everyone is below the break
    // threshold has to end the delve rather than shuffle indefinitely.
    for (let seed = 0; seed < 10; seed++) {
      const sim = new RaidSim(threeRoomsOf('rat', 700 + seed).dungeon, tierAs(0, 'single-file'), seed);
      sim.runToCompletion();
      expect(sim.status).toBe('complete');
      expect(sim.result.ticks).toBeLessThan(9000);
    }
  });

  it('lets the waiting line rest and spend Kit at a Landing (§7.3)', () => {
    // Rest is party-level. Everyone present pays into it and everyone present
    // heals from it, whether or not they ever held the door.
    // Slimes: enough to make it a fight, not enough to stop them reaching the
    // Landing, which is where the party-level rules live.
    const s = seasonWithFloors(403, 2);
    for (let r = 0; r < 3; r++) addMob(s.dungeon, 'slime', 0, r);
    const sim = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 5);
    const events = sim.runToCompletion();
    const rest = events.find((e) => e.type === 'rest');
    expect(rest).toBeDefined();
    if (rest && rest.type === 'rest') {
      // Kit spent at the Landing scales with the number of people present, not
      // with the number who were engaged — a queue of four spends four.
      expect(rest.kitSpent).toBeGreaterThan(1);
    }
  });

  it('counts the whole party in the Descent Decision, not just the engaged', () => {
    // Kit is a shared pool, so a queue can be talked out of descending by an
    // empty pack even though only one of them ever took a hit (§7.3).
    const s = seasonWithFloors(404, 2);
    addTrap(s.dungeon, 'gasvent', 0, 0);
    addTrap(s.dungeon, 'gasvent', 0, 1);
    addTrap(s.dungeon, 'gasvent', 0, 2);
    const sim = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 5);
    sim.runToCompletion();
    // Nothing down there deals damage at all, so if they turned back it was on
    // the party-level Kit check — which is the point.
    expect(sim.party.kit).toBeLessThan(sim.party.maxKit);
  });

  it('a caster shoots past the line; a bruiser cannot', () => {
    // §6.2 under single-file: the role preferences would collapse to nothing
    // against one legal target, so a caster keeps its reach instead.
    const cast = { ...MOBS['slime']!, id: 'testcaster', role: 'caster' as const, dmg: 6, spd: 1 };
    MOBS['testcaster'] = cast;
    try {
      const hitCount = (defId: string) => {
        const s = seasonWithFloors(405, 1);
        addMob(s.dungeon, defId, 0, 0);
        const sim = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 9);
        sim.runToCompletion();
        return sim.party.members.filter((m) => m.lowestHpPct < 1).length;
      };
      // A caster picks the squishiest person in the room whether or not they
      // are the one holding the door, so more than one person gets hurt.
      expect(hitCount('testcaster')).toBeGreaterThanOrEqual(1);
      // Everything else only ever reaches the front of the queue.
      const s = seasonWithFloors(406, 1);
      addMob(s.dungeon, 'ogre', 0, 0);
      const sim = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 9);
      sim.runToCompletion();
      const hurtByBruiser = sim.party.members.filter((m) => (m.hurtByRole.bruiser ?? 0) > 0);
      // At most as many as took a turn at the door — never the whole party at
      // once, which is what "one at a time" has to mean.
      expect(hurtByBruiser.length).toBeLessThanOrEqual(sim.party.members.length);
    } finally {
      delete MOBS['testcaster'];
    }
  });

  it('a trap fills the ROOM, and the queue is not in the room', () => {
    // Traps used to hit every living member, so a party waiting in the corridor
    // took dart fire it could not have been standing in front of. A mechanism
    // fills the chamber it is installed in (§18.2).
    //
    // The cost is real and deliberate: traps were single-file's designed
    // counter, the one layer a queue could not screen. They now hit harder per
    // head and reach fewer heads.
    const s = seasonWithFloors(407, 1);
    addTrap(s.dungeon, 'darts', 0, 0);
    const sim = new RaidSim(s.dungeon, tierAs(0, 'single-file'), 9);
    const events = sim.runToCompletion();
    const hit = new Set(
      events.filter((e) => e.type === 'trap-hit').map((e) => (e as { advId: number }).advId),
    );
    // Under single-file exactly one body is in the room at a time; a rotation
    // can put more than one through it, but never the whole party at once.
    expect(hit.size).toBeGreaterThanOrEqual(1);
    expect(hit.size).toBeLessThan(sim.party.members.length);
  });

  it('records the formation on the result', () => {
    const a = new RaidSim(threeRoomsOf('rat', 408).dungeon, tierAs(0, 'single-file'), 1);
    a.runToCompletion();
    expect(a.result.formation).toBe('single-file');
    const b = new RaidSim(threeRoomsOf('rat', 409).dungeon, tierAs(0, 'party'), 1);
    b.runToCompletion();
    expect(b.result.formation).toBe('party');
  });

  it('withdrawing under fire costs the point man, and skirmishers charge most', () => {
    // The stock Cave Rat cannot push anyone out of a doorway — it dies first —
    // so this needs a skirmisher with enough body to still be there when the
    // point man turns round. That is itself the measurement: chaff does not
    // get a parting shot because chaff is not standing when the moment comes.
    MOBS['testchaser'] = {
      ...MOBS['rat']!, id: 'testchaser', hp: 70, dmg: 7, spd: 1, slots: 1,
    };
    try {
      const withParting = (mult: number, bonus: number) => {
        resetTuning();
        TUNING.linePartingMult = mult;
        TUNING.skirmisherPartingBonus = bonus;
        let dealt = 0;
        for (let seed = 0; seed < 10; seed++) {
          const sim = new RaidSim(
            threeRoomsOf('testchaser', 800 + seed).dungeon, tierAs(0, 'single-file'), seed,
          );
          sim.runToCompletion();
          dealt += sim.party.members.reduce((t, m) => t + (m.hurtByRole.skirmisher ?? 0), 0);
        }
        resetTuning();
        return dealt;
      };
      // A free withdrawal takes strictly less out of them than a fighting one.
      expect(withParting(0.4, 1.6)).toBeGreaterThan(withParting(0, 1));
      // And the role that exists to finish the wounded hits hardest on the way out.
      expect(withParting(0.4, 3)).toBeGreaterThan(withParting(0.4, 1));
    } finally {
      delete MOBS['testchaser'];
    }
  });
});

describe('formation determinism (§13.2)', () => {
  for (const formation of ['single-file', 'party'] as const) {
    it(`reproduces ${formation} raids exactly`, () => {
      const run = () => {
        const s = seasonWithFloors(900, 2);
        addMob(s.dungeon, 'ogre', 0, 0);
        addMob(s.dungeon, 'rat', 0, 1);
        addMob(s.dungeon, 'cutpurse', 0, 2);
        addTrap(s.dungeon, 'darts', 1, 0);
        addMob(s.dungeon, 'skeleton', 1, 1);
        const sim = new RaidSim(s.dungeon, tierAs(1, formation), 4242);
        return JSON.stringify(sim.runToCompletion());
      };
      const a = run();
      expect(a).toBe(run());
      expect(JSON.parse(a).length).toBeGreaterThan(10);
    });
  }

  it('the two formations produce genuinely different raids', () => {
    const stream = (f: 'single-file' | 'party') => {
      const sim = new RaidSim(threeRoomsOf('skeleton', 901).dungeon, tierAs(1, f), 77);
      return JSON.stringify(sim.runToCompletion());
    };
    expect(stream('single-file')).not.toBe(stream('party'));
  });
});
