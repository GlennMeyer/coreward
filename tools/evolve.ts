/**
 * Evolve a dungeon-builder.
 *
 * The scripted strategies in `strategy.ts` encode *my* assumptions about how to
 * play. That makes them useless for the one question worth asking: is there a
 * degenerate build nobody has thought of? A genetic search does not share my
 * assumptions, so when it finds something absurd, the design is wrong rather
 * than the player.
 *
 * This is only possible because the sim is headless and deterministic (§13.2) —
 * a genome is scored by playing whole seasons, and the same genome on the same
 * seeds always scores identically, so selection pressure is real signal instead
 * of noise.
 *
 *   npx tsx tools/evolve.ts [generations] [population] [seasonsPerEval]
 */
import {
  buildPhaseFor, crossover, describeGenome, mutate, randomGenome, type Genome,
} from '../src/ui/idlerBrain';
import { Rng } from '../src/sim/rng';
import { applyAftermath, createSeason, currentTier, startRaid } from '../src/sim/season';

export interface Fitness {
  score: number;
  survival: number;
  renown: number;
  tier: number;
  /** Raids actually played — distinct from the Threat Tier reached. */
  raids: number;
  gold: number;
  bestMobLevel: number;
}

/**
 * Fitness is Renown, not survival.
 *
 * Renown is what the design says the player is chasing (§15), and optimising it
 * is what surfaces exploits — a genome that farms reputation while never being
 * threatened is exactly the §15.1 failure we want a machine to keep hunting.
 * Dying early is punished only through the seasons it cuts short.
 */
type FitnessMode = 'renown' | 'survival';

/**
 * How to score a genome.
 *
 * `renown` is what §15 says the player chases, and optimising it surfaces
 * exploits — but its fittest build reliably has 0% survival, because dying rich
 * at a high tier beats living poor at a low one. That is the design working,
 * and it also means Renown alone cannot answer "is this survivable".
 *
 * `survival` weights finishing the season heavily, so it answers the other
 * question: what does a build that actually holds look like?
 */
function score(f: Omit<Fitness, 'score'>, mode: FitnessMode): number {
  // Runs are endless (§12a), so "survived the season" no longer exists —
  // every run ends overrun. Depth is the score: how many raids you lasted.
  if (mode === 'survival') return f.raids * 100 + f.renown * 0.1;
  return f.renown;
}

function evaluate(
  g: Genome, seasons: number, seedBase: number, mode: FitnessMode = 'renown',
): Fitness {
  let renown = 0, survived = 0, tier = 0, raids = 0, gold = 0, bestLv = 0;
  for (let i = 0; i < seasons; i++) {
    const seed = seedBase + i * 7919;
    const s = createSeason(seed, true);
    const rng = new Rng(seed ^ 0x5eed);
    while (!s.over) {
      buildPhaseFor(s, g, rng);
      const sim = startRaid(s);
      while (sim.status !== 'complete') {
        sim.step();
        if (sim.status === 'awaiting-taunt') sim.resolveTaunt(rng.chance(g.tauntRate));
      }
      applyAftermath(s, sim);
    }
    renown += s.renown;
    gold += s.gold;
    if (s.ending === 'survived') survived++;
    raids += s.log.length;
    tier += currentTier(s).tier;
    bestLv += s.dungeon.mobs.reduce((m, x) => (x.alive && x.level > m ? x.level : m), 0);
  }
  const parts = {
    survival: survived / seasons,
    renown: renown / seasons,
    tier: tier / seasons,
    raids: raids / seasons,
    gold: gold / seasons,
    bestMobLevel: bestLv / seasons,
  };
  return { ...parts, score: score(parts, mode) };
}

// ─── The loop ────────────────────────────────────────────────────────────────


function main(): void {
  const generations = Number(process.argv[2] ?? 12);
  const population = Number(process.argv[3] ?? 24);
  const seasons = Number(process.argv[4] ?? 6);
  const mode = (process.argv[5] ?? 'renown') as FitnessMode;
  const rng = new Rng(0xC0FFEE);

  let pop = Array.from({ length: population }, () => randomGenome(rng));
  const t0 = Date.now();

  console.log(
    `evolving ${population} genomes × ${generations} generations × ${seasons} seasons`
    + `  [fitness: ${mode}]\n`,
  );
  console.log('gen   best   survive  tier raids  gold  mobLv   build');
  console.log('─'.repeat(110));

  let best: { g: Genome; f: Fitness } | null = null;

  for (let gen = 0; gen < generations; gen++) {
    // Same seeds for every genome in a generation: selection has to compare
    // builds, not luck. Seeds rotate per generation so nothing overfits one run.
    const seedBase = 1000 + gen * 104729;
    const scored = pop
      .map((g) => ({ g, f: evaluate(g, seasons, seedBase, mode) }))
      .sort((a, b) => b.f.score - a.f.score);

    const top = scored[0]!;
    if (!best || top.f.score > best.f.score) best = top;

    console.log(
      `${String(gen).padStart(3)} ${top.f.score.toFixed(0).padStart(6)} `
      + `${(top.f.survival * 100).toFixed(0).padStart(7)}% `
      + `${top.f.tier.toFixed(1).padStart(5)} ${top.f.raids.toFixed(1).padStart(5)} `
      + `${top.f.gold.toFixed(0).padStart(5)} `
      + `${top.f.bestMobLevel.toFixed(1).padStart(6)}   ${describeGenome(top.g)}`,
    );

    // Elitism + tournament selection.
    const elite = scored.slice(0, Math.max(2, Math.floor(population * 0.2))).map((x) => x.g);
    const next: Genome[] = [...elite];
    while (next.length < population) {
      const a = rng.pick(elite);
      const b = rng.pick(scored.slice(0, Math.floor(population * 0.5))).g;
      next.push(mutate(crossover(a, b, rng), rng, 0.25));
    }
    pop = next;
  }

  console.log('\n═══ fittest build found ═══');
  console.log(describeGenome(best!.g));
  // The one-line summary shows only the top two weights, which reads like a
  // recipe and is not one — every genome weights the whole roster. Print the
  // actual profile so the result can be acted on.
  const profile = (label: string, m: Record<string, number>) => {
    const total = Object.values(m).reduce((a, b) => a + b, 0) || 1;
    const parts = Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${(100 * v / total).toFixed(0)}%`)
      .join('  ');
    console.log(`  ${label.padEnd(9)} ${parts}`);
  };
  profile('monsters', best!.g.mobWeights);
  profile('traps', best!.g.trapWeights);
  console.log(
    `renown=${best!.f.renown.toFixed(0)} survival=${(best!.f.survival * 100).toFixed(0)}% `
    + `tier=${best!.f.tier.toFixed(1)} raids=${best!.f.raids.toFixed(1)} gold=${best!.f.gold.toFixed(0)} `
    + `bestMobLevel=${best!.f.bestMobLevel.toFixed(1)}`,
  );
  console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
