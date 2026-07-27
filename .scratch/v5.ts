import { STRATEGY_LIST, AI, resetAi } from '../tools/strategy';
import { runSeason, type SeasonOutcome } from '../tools/balance';
const N = 400;
function run(label: string) {
  console.log('\n' + label);
  console.log('strategy | surv renown tier thrill peril depth tedium breach mobLv');
  for (const st of Object.values(STRATEGY_LIST)) {
    const rs: SeasonOutcome[] = [];
    for (let i = 0; i < N; i++) rs.push(runSeason(i, st));
    const m = (f: (r: SeasonOutcome) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    console.log(st.name.padEnd(9) + '|' + (m(r => r.survived ? 1 : 0) * 100).toFixed(0).padStart(5) + '%'
      + m(r => r.renown).toFixed(0).padStart(7) + m(r => r.finalTier).toFixed(1).padStart(5)
      + m(r => r.thrill).toFixed(1).padStart(7) + m(r => r.peril).toFixed(2).padStart(6)
      + m(r => r.depth).toFixed(2).padStart(6) + m(r => r.tedium).toFixed(1).padStart(7)
      + m(r => r.breaches).toFixed(1).padStart(7) + m(r => r.maxMobLevel).toFixed(1).padStart(6));
  }
}
resetAi(); AI.fillEmptyFirst = false; run('── stacking (old) ──');
resetAi(); AI.fillEmptyFirst = true;  run('── fill-empty-first ──');
resetAi();
