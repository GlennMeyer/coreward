import { STRATEGY_LIST, AI, resetAi } from '../tools/strategy';
import { runSeason, type SeasonOutcome } from '../tools/balance';
const N = 300;
console.log('reserve | surv renown tier thrill comfort depth sales breach');
for (const v of [100, 110, 120, 130, 140, 150, 160, 180]) {
  resetAi(); AI.showmanDefenceReserve = v; AI.placeDepth = 15; AI.placeEmpty = 45;
  const rs: SeasonOutcome[] = [];
  for (let i = 0; i < N; i++) rs.push(runSeason(i, STRATEGY_LIST.showman));
  const m = (f: (r: SeasonOutcome) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  console.log(
    String(v).padStart(7) + ' |' + (m(r => r.survived ? 1 : 0) * 100).toFixed(0).padStart(5) + '%'
    + m(r => r.renown).toFixed(0).padStart(7) + m(r => r.finalTier).toFixed(1).padStart(5)
    + m(r => r.thrill).toFixed(1).padStart(7) + m(r => r.comfort).toFixed(2).padStart(8)
    + m(r => r.depth).toFixed(2).padStart(6) + m(r => r.goldFromSales).toFixed(0).padStart(6)
    + m(r => r.breaches).toFixed(1).padStart(7));
}
resetAi();
