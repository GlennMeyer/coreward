import { STRATEGY_LIST, AI, resetAi, type Strategy } from '../tools/strategy';
import { runSeason, type SeasonOutcome } from '../tools/balance';
const N = 400;
const st: Strategy = { ...STRATEGY_LIST.showman, buyOrder: ['ogre','ooze','rat'] };
console.log('digRes digTil | surv renown tier thrill depth floors3 breach');
for (const dr of [40, 60, 90]) for (const du of [3, 5, 8]) {
  resetAi(); AI.placeDepth = 15; AI.placeEmpty = 45; AI.digReserve = dr; AI.digUntilRaid = du;
  const rs: SeasonOutcome[] = [];
  for (let i = 0; i < N; i++) rs.push(runSeason(i, st));
  const m = (f: (r: SeasonOutcome) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  console.log(String(dr).padStart(6) + String(du).padStart(7) + ' |'
    + (m(r => r.survived ? 1 : 0) * 100).toFixed(0).padStart(5) + '%'
    + m(r => r.renown).toFixed(0).padStart(7) + m(r => r.finalTier).toFixed(1).padStart(5)
    + m(r => r.thrill).toFixed(1).padStart(7) + m(r => r.depth).toFixed(2).padStart(6)
    + m(r => r.breaches).toFixed(1).padStart(14));
}
resetAi();
