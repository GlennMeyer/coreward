/** Does the idler's build phase obey the same rules a player does? */
import { buildPhaseFor, randomGenome } from '../src/ui/idlerBrain';
import { createSeason, startRaid, applyAftermath } from '../src/sim/season';
import { roomCapacity, MAX_FLOORS } from '../src/sim/data';
import { roomSlotsUsed } from '../src/sim/dungeon';
import { Rng } from '../src/sim/rng';

let negMana = 0, negGold = 0, overCap = 0, overFloors = 0, checks = 0;
const rng = new Rng(7);
for (let seed = 0; seed < 120; seed++) {
  const s = createSeason(seed, true);
  s.totalRaids = 14;
  const g = randomGenome(rng);
  const r2 = new Rng(seed);
  while (!s.over) {
    buildPhaseFor(s, g, r2);
    checks++;
    if (s.mana < 0) negMana++;
    if (s.gold < 0) negGold++;
    if (s.dungeon.floors.length > MAX_FLOORS) overFloors++;
    for (let f = 0; f < s.dungeon.floors.length; f++)
      for (let r = 0; r < s.dungeon.floors[f]!.rooms.length; r++)
        if (roomSlotsUsed(s.dungeon, f, r) > roomCapacity(f)) overCap++;
    const sim = startRaid(s);
    while (sim.status !== 'complete') { sim.step(); if (sim.status==='awaiting-taunt') sim.resolveTaunt(false); }
    applyAftermath(s, sim);
  }
}
console.log(`${checks} build phases audited`);
console.log(`  negative mana:      ${negMana}`);
console.log(`  negative gold:      ${negGold}`);
console.log(`  rooms over capacity:${overCap}`);
console.log(`  floors over max:    ${overFloors}`);
