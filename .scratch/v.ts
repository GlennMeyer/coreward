import { STRATEGY_LIST, AI, resetAi, type Strategy } from '../tools/strategy';
import { runSeason, type SeasonOutcome } from '../tools/balance';
const N = 400;
const variants: Record<string, Strategy> = {
  'A shipped':       { ...STRATEGY_LIST.showman },
  'B strongest-buy': { ...STRATEGY_LIST.showman, buyOrder: undefined },
  'C strong-rot':    { ...STRATEGY_LIST.showman, buyOrder: ['ogre','ooze','skeleton'] },
  'D strong-rot+cut':{ ...STRATEGY_LIST.showman, buyOrder: ['ogre','ooze','skeleton','cutpurse'] },
  'E C, no shops':   { ...STRATEGY_LIST.showman, buyOrder: ['ogre','ooze','skeleton'], commerceShare: 0 },
  'F C, taunt .4':   { ...STRATEGY_LIST.showman, buyOrder: ['ogre','ooze','skeleton'], tauntRate: 0.4 },
  'G E, taunt .4':   { ...STRATEGY_LIST.showman, buyOrder: ['ogre','ooze','skeleton'], commerceShare: 0, tauntRate: 0.4 },
  '— combat ref':    { ...STRATEGY_LIST.combat },
  '— wardens ref':   { ...STRATEGY_LIST.wardens },
};
resetAi(); AI.placeDepth = 15; AI.placeEmpty = 45;
console.log('variant           | surv renown tier thrill peril depth variety comfort tedium breach');
for (const [name, st] of Object.entries(variants)) {
  const rs: SeasonOutcome[] = [];
  for (let i = 0; i < N; i++) rs.push(runSeason(i, st));
  const m = (f: (r: SeasonOutcome) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  console.log(name.padEnd(18) + '|' + (m(r => r.survived ? 1 : 0) * 100).toFixed(0).padStart(5) + '%'
    + m(r => r.renown).toFixed(0).padStart(7) + m(r => r.finalTier).toFixed(1).padStart(5)
    + m(r => r.thrill).toFixed(1).padStart(7) + m(r => r.peril).toFixed(2).padStart(6)
    + m(r => r.depth).toFixed(2).padStart(6) + m(r => r.variety).toFixed(2).padStart(8)
    + m(r => r.comfort).toFixed(2).padStart(8) + m(r => r.tedium).toFixed(1).padStart(7)
    + m(r => r.breaches).toFixed(1).padStart(7));
}
resetAi();
