/**
 * Grid-search the scripted AI's own build constants (`AI` in strategy.ts).
 *
 * Answers the question the balance runner cannot: when a strategy performs
 * badly, is the *strategy* bad or is the AI playing it badly? Sweeping game
 * tuning to rescue a badly-played strategy is how you tune a game into a
 * shape nobody actually plays.
 *
 *   npx tsx tools/aigrid.ts showman
 */
import { STRATEGY_LIST, AI, resetAi, type StrategyName } from './strategy';
import { runSeason, type SeasonOutcome } from './balance';

const N = Number(process.env.N ?? 200);

function measure(name: StrategyName) {
  const rs: SeasonOutcome[] = [];
  for (let i = 0; i < N; i++) rs.push(runSeason(i, STRATEGY_LIST[name]));
  const mean = (f: (r: SeasonOutcome) => number) =>
    rs.reduce((s, r) => s + f(r), 0) / rs.length;
  return {
    surv: mean((r) => (r.survived ? 1 : 0)),
    renown: mean((r) => r.renown),
    tier: mean((r) => r.finalTier),
    thrill: mean((r) => r.thrill),
    comfort: mean((r) => r.comfort),
    depth: mean((r) => r.depth),
    tedium: mean((r) => r.tedium),
    breach: mean((r) => r.breaches),
  };
}

const name = (process.argv[2] ?? 'showman') as StrategyName;

console.log(`\n═══ AI grid for ${name} (${N} seasons per cell) ═══\n`);
console.log(
  'reserve digRes digTil depth empty |  surv  renown  tier thrill comfort depth tedium breach',
);
console.log('─'.repeat(92));

const rows: { key: string; r: ReturnType<typeof measure> }[] = [];

for (const showmanDefenceReserve of [95, 150, 220]) {
  for (const digReserve of [60, 90, 140]) {
    for (const digUntilRaid of [3, 5]) {
      for (const [placeDepth, placeEmpty] of [[25, 30], [40, 20], [15, 45]]) {
        resetAi();
        Object.assign(AI, {
          showmanDefenceReserve, digReserve, digUntilRaid, placeDepth, placeEmpty,
        });
        const r = measure(name);
        const key =
          `${String(showmanDefenceReserve).padStart(7)}${String(digReserve).padStart(7)}`
          + `${String(digUntilRaid).padStart(7)}${String(placeDepth).padStart(6)}`
          + `${String(placeEmpty).padStart(6)}`;
        rows.push({ key, r });
        console.log(
          `${key} |${(r.surv * 100).toFixed(0).padStart(5)}%`
          + `${r.renown.toFixed(0).padStart(8)}${r.tier.toFixed(1).padStart(6)}`
          + `${r.thrill.toFixed(1).padStart(7)}${r.comfort.toFixed(2).padStart(8)}`
          + `${r.depth.toFixed(2).padStart(6)}${r.tedium.toFixed(1).padStart(7)}`
          + `${r.breach.toFixed(1).padStart(7)}`,
        );
      }
    }
  }
}
resetAi();

const best = [...rows].sort((a, b) => b.r.renown - a.r.renown).slice(0, 3);
console.log('\ntop 3 by renown:');
for (const b of best) {
  console.log(`  ${b.key}  renown ${b.r.renown.toFixed(0)}  surv ${(b.r.surv * 100).toFixed(0)}%`);
}
const safest = [...rows].sort((a, b) => b.r.surv - a.r.surv).slice(0, 3);
console.log('top 3 by survival:');
for (const b of safest) {
  console.log(`  ${b.key}  surv ${(b.r.surv * 100).toFixed(0)}%  renown ${b.r.renown.toFixed(0)}`);
}
