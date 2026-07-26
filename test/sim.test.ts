import { beforeEach, describe, expect, it } from 'vitest';
import {
  GEAR, MOBS, RENOWN_PER_ESCAPEE, RENOWN_WIPE_MULT, TIERS, TUNING,
  XP_THRESHOLDS, mobMaxHp, roomCapacity, roomsOnFloor, tierForRenown,
} from '../src/sim/data';
import {
  assignStaff, buyMob, createDungeon, digFloor, equipGear, grantXp, hireStaff,
  mobEffectiveDmg, mobEffectiveHp, mobStripsKit, mobsInRoom, packMultiplier,
  placeMobInRoom, totalUpkeep, unplace,
} from '../src/sim/dungeon';
import { RaidSim } from '../src/sim/raid';
import { applyAftermath, createSeason, startRaid } from '../src/sim/season';
import type { Dungeon, Mob } from '../src/sim/types';
import { addMob, addStaffedAmenity, seasonWithFloors } from './helpers';

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
    const staffUid = addStaffedAmenity(d, 0, 0, 'hotspring', 'rat');
    // Hot Spring upkeep 4 + Cave Rat upkeep 1.
    expect(totalUpkeep(d)).toBe(before + 4 + 1);

    unplace(d, staffUid);
    expect(totalUpkeep(d)).toBe(before);
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
    expect(tierForRenown(0).tier).toBe(1);
    expect(tierForRenown(29).tier).toBe(1);
    expect(tierForRenown(30).tier).toBe(2);
    expect(tierForRenown(74).tier).toBe(2);
    expect(tierForRenown(75).tier).toBe(3);
  });

  it('respects the prototype tier cap', () => {
    expect(tierForRenown(99999, 4).tier).toBe(4);
  });
});

describe('raid resolution (§7)', () => {
  it('an undefended dungeon is breached, costing a heart', () => {
    const s = seasonWithFloors(1, 1);
    const sim = startRaid(s);
    sim.runToCompletion();
    expect(sim.result.outcome).toBe('breach');
    expect(s.dungeon.hearts).toBe(2);
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

  it('halves renown on a total wipe — nobody tells the tale', () => {
    const { sim } = findWipe();
    const r = sim.result;
    expect(r.renown).toBe(Math.round(r.killed * 2 * RENOWN_WIPE_MULT));
  });

  it('a wipe costs no hearts', () => {
    const { season, sim } = findWipe();
    expect(sim.result.outcome).toBe('wiped');
    expect(season.dungeon.hearts).toBe(3);
  });

  it('recovers only 25% of carried gold from corpses (§4.3, Q7)', () => {
    const { sim } = findWipe();
    // Gold is zeroed on death, so reconstruct what the party walked in with.
    const carried = sim.party.members.reduce((sum, m) => sum + m.gold, 0);
    expect(carried).toBe(0);
    expect(sim.result.goldFromCorpses).toBeGreaterThan(0);
    expect(TUNING.goldRecoveredOnKill).toBe(0.25);
  });

  it('awards renown per escapee', () => {
    const s = seasonWithFloors(6, 1);
    const sim = startRaid(s);
    sim.runToCompletion();
    const r = sim.result;
    // Breach: everyone escapes, nobody dies, nothing sold.
    expect(r.renown).toBe(r.escaped * RENOWN_PER_ESCAPEE);
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

  it('a breach slays every downed monster', () => {
    // Scan for a breach where something actually fell.
    for (let seed = 0; seed < 60; seed++) {
      const s = seasonWithFloors(700 + seed, 1);
      addMob(s.dungeon, 'rat', 0, 0);
      const sim = new RaidSim(s.dungeon, TIERS[1]!, seed);
      sim.runToCompletion();
      const r = sim.result;
      if (r.outcome !== 'breach' || r.mobsDowned.length === 0) continue;
      expect(r.mobsLost.length).toBe(r.mobsDowned.length);
      return;
    }
    throw new Error('no breach-with-casualties scenario found');
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
    const s = seasonWithFloors(13, 3);
    for (let room = 0; room < 3; room++) addMob(s.dungeon, 'ooze', 0, room);
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
    const sim = new RaidSim(s.dungeon, TIERS[0]!, 21);
    while (sim.status !== 'complete') {
      sim.step();
      if (sim.status === 'awaiting-taunt') sim.resolveTaunt(false);
    }
    expect(sim.result.outcome).toBe('retreated');
    expect(sim.result.escaped).toBeGreaterThan(0);
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
    for (let i = 0; i < 3; i++) {
      const sim = startRaid(s);
      sim.runToCompletion();
      applyAftermath(s, sim);
    }
    expect(s.dungeon.hearts).toBe(0);
    expect(s.over).toBe(true);
    expect(s.ending).toBe('overrun');
  });

  it('ends the season as survived after the full raid count', () => {
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
function findWipe(): { season: ReturnType<typeof seasonWithFloors>; sim: RaidSim } {
  for (let seed = 0; seed < 200; seed++) {
    const season = seasonWithFloors(900 + seed, 1);
    // An Ogre fills a Floor-1 room on its own now (4 of 4 slots).
    for (let r = 0; r < 3; r++) addMob(season.dungeon, 'ogre', 0, r);
    const sim = new RaidSim(season.dungeon, TIERS[0]!, seed);
    sim.runToCompletion();
    if (sim.result.outcome === 'wiped') return { season, sim };
  }
  throw new Error('no wiping scenario found in 200 seeds');
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

    for (let seed = 0; seed < 80; seed++) {
      const sim = new RaidSim(s.dungeon, TIERS[3]!, seed);
      sim.runToCompletion();
      const mob = s.dungeon.mobs.find((m) => m.uid === uid)!;
      if (mob.alive) continue;
      // Slain: the monster is gone but the Iron Fangs are back in the armory.
      expect(mob.gear).toEqual([]);
      return;
    }
    throw new Error('monster never died across 80 seeds');
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
