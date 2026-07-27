/**
 * Verbose single-season trace. Diagnostic aid for the balance runner —
 * prints what the AI built and how each raid actually went.
 *
 *   npx tsx tools/trace.ts [seed] [strategy]
 */
import { MOBS, TUNING } from '../src/sim/data';
import { livingMobs, mobsInRoom, totalUpkeep } from '../src/sim/dungeon';
import { applyAftermath, currentTier, startRaid } from '../src/sim/season';
import { createSeason } from '../src/sim/season';
import { Rng } from '../src/sim/rng';
import { buildPhaseFor, STRATEGY_LIST, type StrategyName } from './strategy';

const seed = Number(process.argv[2] ?? 1);
const stratName = (process.argv[3] ?? 'combat') as StrategyName;
const strat = STRATEGY_LIST[stratName];

const s = createSeason(seed, true);
const rng = new Rng(seed ^ 0xc0ffee);

console.log(`seed=${seed} strategy=${stratName} startingMana=${TUNING.startingMana}\n`);

while (!s.over) {
  const raidNo = s.raidNumber;
  buildPhaseFor(s, strat, rng);

  const layout = s.dungeon.floors.map((f, fi) =>
    f.rooms.map((_, ri) =>
      mobsInRoom(s.dungeon, fi, ri).map((m) => `${MOBS[m.defId]!.name.split(' ').pop()}${m.level > 1 ? `+${m.level}` : ''}`).join(',') || '-',
    ).join(' | '),
  );

  console.log(`── raid ${raidNo}  tier ${currentTier(s).tier}  mana ${s.mana.toFixed(0)}  upkeep ${totalUpkeep(s.dungeon)}  hearts ${s.dungeon.hearts}  mobs ${livingMobs(s.dungeon).length}`);
  layout.forEach((l, i) => console.log(`   F${i + 1}: ${l}`));

  const sim = startRaid(s);
  const party = sim.party.members.map((m) => `${m.cls[0]!.toUpperCase()}${m.level}`).join(' ');
  const totalHp = sim.party.members.reduce((a, m) => a + m.maxHp, 0);
  console.log(`   party: ${party}  hp=${totalHp}  kit=${sim.party.kit}`);

  while (sim.status !== 'complete') {
    sim.step();
    if (sim.status === 'awaiting-taunt') {
      const accept = rng.chance(strat.tauntRate);
      console.log(`   TAUNT offered (${sim.tauntOffer?.reason}) → ${accept ? 'ACCEPT' : 'decline'}`);
      sim.resolveTaunt(accept);
    }
  }

  const r = sim.result;
  const after = applyAftermath(s, sim);
  console.log(
    `   → ${r.outcome.toUpperCase()} killed=${r.killed} escaped=${r.escaped} `
    + `deepest=F${r.deepestFloorReached} ticks=${r.ticks} `
    + `downed=${r.mobsDowned.length} slain=${r.mobsLost.length} sales=${r.goldFromSales}g corpses=${r.goldFromCorpses}g `
    + `renown+${r.renown} mana${after.manaIncome >= 0 ? '+' : ''}${after.manaIncome}`,
  );

  // The Thrill line is the whole point of §15 — it says whether the delve was
  // worth talking about, which is now what Renown is actually paying for.
  const t = r.thrill;
  console.log(
    `   thrill ${t.total.toFixed(1)}  peril=${t.peril.toFixed(2)} depth=${t.depth.toFixed(2)} `
    + `variety=${t.variety.toFixed(2)} comfort=${t.comfort.toFixed(2)} tedium=${t.tedium.toFixed(1)}`
    + (TUNING.thrillRenown ? '' : '   (thrillRenown OFF — Renown is flat 6×escapees)'),
  );
  for (const legend of r.retired) {
    console.log(`   ★ RETIRED: ${legend.name} at thrill ${legend.thrill.toFixed(0)} → Legend`);
  }
  console.log('');
}

console.log(
  `ENDING: ${s.ending}  raids=${s.log.length}  renown=${s.renown}  gold=${s.gold}  souls=${s.souls}`
  + `  veterans=${s.veterans.length}  legends=${s.legends.length}`,
);
if (s.legends.length > 0) {
  console.log(`LEGENDS: ${s.legends.map((l) => `${l.name} (raid ${l.retiredOnRaid})`).join(', ')}`);
}
