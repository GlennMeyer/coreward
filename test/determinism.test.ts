/**
 * The load-bearing test. If determinism breaks, replays, reproducible bug
 * reports, and the headless balance runner all break with it (§13.2).
 */
import { describe, expect, it } from 'vitest';
import { RaidSim } from '../src/sim/raid';
import { Rng } from '../src/sim/rng';
import { TIERS } from '../src/sim/data';
import {
  addMob, addStaffedAmenity, addTrap, seasonWithFloors, widenRoom,
} from './helpers';
import type { SeasonState } from '../src/sim/types';

function buildScenario(seed: number): SeasonState {
  const s = seasonWithFloors(seed, 3);
  // Three of these rooms hold a body and a trap, which is 4-5 slots — more than
  // a Hewn room's 3 since §16.3. Widened rather than thinned out: the point of
  // the fixture is a dungeon busy enough that an ordering bug has somewhere to
  // show up, and dropping occupants to fit would cost exactly that.
  widenRoom(s.dungeon, 0, 0);
  widenRoom(s.dungeon, 1, 0);
  widenRoom(s.dungeon, 2, 1);
  addMob(s.dungeon, 'rat', 0, 0);
  addMob(s.dungeon, 'slime', 0, 1);
  addMob(s.dungeon, 'cutpurse', 1, 0);
  addMob(s.dungeon, 'skeleton', 1, 1);
  addMob(s.dungeon, 'ogre', 2, 0);
  addMob(s.dungeon, 'ooze', 2, 1);
  // Every trap job in the roster (§5.2), so the stream covers each effect
  // path — including the two that mutate party state outside combat (Kit and
  // the Snare's tick counter), which are the ones an ordering bug would show
  // up in first.
  addTrap(s.dungeon, 'darts', 0, 0);
  addTrap(s.dungeon, 'snare', 0, 1);
  addTrap(s.dungeon, 'gasvent', 1, 0);
  addTrap(s.dungeon, 'shrieker', 1, 1);
  addTrap(s.dungeon, 'deadfall', 2, 1);
  addStaffedAmenity(s.dungeon, 0, 0, 'provisioner');
  addStaffedAmenity(s.dungeon, 1, 0, 'hotspring');
  return s;
}

describe('determinism', () => {
  it('produces byte-identical event streams for the same seed', () => {
    const runs = [0, 1].map(() => {
      const s = buildScenario(4242);
      const sim = new RaidSim(s.dungeon, TIERS[2]!, 999);
      return JSON.stringify(sim.runToCompletion());
    });
    expect(runs[0]).toBe(runs[1]);
    expect(JSON.parse(runs[0]!).length).toBeGreaterThan(10);
  });

  it('produces identical results for the same seed', () => {
    const results = [0, 1].map(() => {
      const s = buildScenario(777);
      const sim = new RaidSim(s.dungeon, TIERS[3]!, 12345);
      sim.runToCompletion();
      return sim.result;
    });
    expect(results[0]).toEqual(results[1]);
  });

  it('produces different streams for different seeds', () => {
    const a = new RaidSim(buildScenario(1).dungeon, TIERS[2]!, 1);
    const b = new RaidSim(buildScenario(1).dungeon, TIERS[2]!, 2);
    expect(JSON.stringify(a.runToCompletion()))
      .not.toBe(JSON.stringify(b.runToCompletion()));
  });

  // Formation (§7.2) adds a second code path through room combat — the line
  // rotates, monsters retarget, and a withdrawal fires a parting volley. All of
  // it has to be as reproducible as the rest, or replays break for exactly the
  // raids that are most worth replaying.
  for (const formation of ['single-file', 'party'] as const) {
    it(`is byte-identical under ${formation} engagement`, () => {
      const runs = [0, 1].map(() => {
        const s = buildScenario(8080);
        const tier = { ...TIERS[2]!, formation };
        return JSON.stringify(new RaidSim(s.dungeon, tier, 313).runToCompletion());
      });
      expect(runs[0]).toBe(runs[1]);
      expect(JSON.parse(runs[0]!).length).toBeGreaterThan(10);
    });
  }

  it('steps and runToCompletion agree', () => {
    const s1 = buildScenario(31337);
    const sim1 = new RaidSim(s1.dungeon, TIERS[1]!, 555);
    const streamed = sim1.runToCompletion();

    const s2 = buildScenario(31337);
    const sim2 = new RaidSim(s2.dungeon, TIERS[1]!, 555);
    const stepped = [];
    while (sim2.status !== 'complete') {
      stepped.push(...sim2.step());
      if (sim2.status === 'awaiting-taunt') stepped.push(...sim2.resolveTaunt(false));
    }
    expect(stepped).toEqual(streamed);
  });
});

describe('Rng', () => {
  it('is reproducible and restorable', () => {
    const a = new Rng(99);
    const first = [a.next(), a.next(), a.next()];
    const state = a.getState();
    const mid = a.next();

    const b = new Rng(99);
    expect([b.next(), b.next(), b.next()]).toEqual(first);
    b.setState(state);
    expect(b.next()).toBe(mid);
  });

  it('survives seed 0 without collapsing', () => {
    const r = new Rng(0);
    const vals = new Set(Array.from({ length: 20 }, () => r.next()));
    expect(vals.size).toBe(20);
  });

  it('weighted() respects weights', () => {
    const r = new Rng(7);
    let heavy = 0;
    for (let i = 0; i < 2000; i++) {
      if (r.weighted([['a', 9], ['b', 1]] as const) === 'a') heavy++;
    }
    expect(heavy / 2000).toBeGreaterThan(0.85);
    expect(heavy / 2000).toBeLessThan(0.95);
  });

  it('forked streams diverge from the parent', () => {
    const parent = new Rng(500);
    const child = parent.fork(1);
    const other = parent.fork(2);
    expect(child.next()).not.toBe(other.next());
  });
});
