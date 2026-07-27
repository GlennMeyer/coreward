import { STRATEGY_LIST } from '../tools/strategy';
import { runSeason, type SeasonOutcome } from '../tools/balance';
import { MOBS, roomCapacity } from '../src/sim/data';
import { mobsInRoom, placeMobInRoom, roomSlotsUsed } from '../src/sim/dungeon';
import * as strategy from '../tools/strategy';
const N = 400;
// monkey-patch placeAnywhere to a "no empty room while anything is stacked" variant
const orig = strategy.placeAnywhere;
function breadthFirst(s: any, mob: any): boolean {
  const d = s.dungeon;
  const slots = MOBS[mob.defId]!.slots;
  for (const wantEmpty of [true, false]) {
    for (let f = d.floors.length - 1; f >= 0; f--) {
      for (let r = 0; r < d.floors[f]!.rooms.length; r++) {
        if (roomSlotsUsed(d, f, r) + slots > roomCapacity(f)) continue;
        if (wantEmpty && mobsInRoom(d, f, r).length > 0) continue;
        return placeMobInRoom(d, mob.uid, f, r) === null;
      }
    }
  }
  return false;
}
function run(label: string) {
  console.log('\n' + label);
  console.log('strategy | surv renown tier thrill peril depth tedium breach');
  for (const st of Object.values(STRATEGY_LIST)) {
    const rs: SeasonOutcome[] = [];
    for (let i = 0; i < N; i++) rs.push(runSeason(i, st));
    const m = (f: (r: SeasonOutcome) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    console.log(st.name.padEnd(9) + '|' + (m(r => r.survived ? 1 : 0) * 100).toFixed(0).padStart(5) + '%'
      + m(r => r.renown).toFixed(0).padStart(7) + m(r => r.finalTier).toFixed(1).padStart(5)
      + m(r => r.thrill).toFixed(1).padStart(7) + m(r => r.peril).toFixed(2).padStart(6)
      + m(r => r.depth).toFixed(2).padStart(6) + m(r => r.tedium).toFixed(1).padStart(7)
      + m(r => r.breaches).toFixed(1).padStart(7));
  }
}
run('── current (deepest-first, stacking) ──');
(strategy as any).placeAnywhere = breadthFirst;
run('── breadth-first (fill every room before stacking) ──');
