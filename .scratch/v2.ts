import { STRATEGY_LIST, AI, resetAi, type Strategy } from '../tools/strategy';
import { runSeason, type SeasonOutcome } from '../tools/balance';
const N = 400;
const base = STRATEGY_LIST.showman;
const variants: Record<string, Strategy> = {
  'shipped 6-rot':   { ...base },
  'ogre/ooze/skel':  { ...base, buyOrder: ['ogre','ooze','skeleton'] },
  'ogre/ooze/rat':   { ...base, buyOrder: ['ogre','ooze','rat'] },
  'ogre/ooze/skl/rat':{ ...base, buyOrder: ['ogre','ooze','skeleton','rat'] },
  'ogre/ooze/skl/cut':{ ...base, buyOrder: ['ogre','ooze','skeleton','cutpurse'] },
  'ogr/ooz/skl/rat cs0':{ ...base, buyOrder: ['ogre','ooze','skeleton','rat'], commerceShare: 0 },
  'ogr/ooz/skl/rat t.4':{ ...base, buyOrder: ['ogre','ooze','skeleton','rat'], tauntRate: 0.4 },
};
resetAi(); AI.placeDepth = 15; AI.placeEmpty = 45;
console.log('variant             | surv renown tier thrill peril depth variety tedium escd breach');
for (const [name, st] of Object.entries(variants)) {
  const rs: SeasonOutcome[] = [];
  for (let i = 0; i < N; i++) rs.push(runSeason(i, st));
  const m = (f: (r: SeasonOutcome) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
  console.log(name.padEnd(20) + '|' + (m(r => r.survived ? 1 : 0) * 100).toFixed(0).padStart(5) + '%'
    + m(r => r.renown).toFixed(0).padStart(7) + m(r => r.finalTier).toFixed(1).padStart(5)
    + m(r => r.thrill).toFixed(1).padStart(7) + m(r => r.peril).toFixed(2).padStart(6)
    + m(r => r.depth).toFixed(2).padStart(6) + m(r => r.variety).toFixed(2).padStart(8)
    + m(r => r.tedium).toFixed(1).padStart(7) + m(r => r.escaped).toFixed(1).padStart(6)
    + m(r => r.breaches).toFixed(1).padStart(7));
}
resetAi();
