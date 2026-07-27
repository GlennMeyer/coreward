/**
 * Sweep one knob across *every* strategy at once.
 *
 * `tools/balance.ts sweep` varies a knob against a single strategy, which is
 * the right tool for "what does this number do to the game". It is the wrong
 * tool for "which strategy wins", because that question is about the *ordering*
 * of the Renown column and you cannot see an ordering one row at a time.
 *
 *   npx tsx tools/sweepall.ts thrillPerilGate 0 0.3 0.5 0.7 1.0
 *   npx tsx tools/sweepall.ts renownPerThrill 0.1 0.15 0.2 --n 300
 */
import { TUNING, resetTuning, type Tuning } from '../src/sim/data';
import { STRATEGY_LIST, type StrategyName } from './strategy';
import { runSeason, type SeasonOutcome } from './balance';

const NAMES = Object.keys(STRATEGY_LIST) as StrategyName[];

function batch(name: StrategyName, n: number): SeasonOutcome[] {
  const out: SeasonOutcome[] = [];
  for (let i = 0; i < n; i++) out.push(runSeason(i, STRATEGY_LIST[name]));
  return out;
}

const mean = (rs: SeasonOutcome[], f: (r: SeasonOutcome) => number) =>
  rs.reduce((s, r) => s + f(r), 0) / rs.length;

function main(): void {
  const argv = process.argv.slice(2);
  const nFlag = argv.indexOf('--n');
  const n = nFlag >= 0 ? Number(argv[nFlag + 1]) : 300;
  const args = nFlag >= 0 ? argv.slice(0, nFlag) : argv;

  const key = args[0] as keyof Tuning;
  const values = args.slice(1).map(Number);
  if (!key || values.length === 0) {
    console.error('usage: sweepall.ts <tuningKey> <v1> <v2> ... [--n 300]');
    process.exit(1);
  }

  console.log(`\n═══ ${String(key)} across all strategies (${n} seasons each) ═══`);

  for (const v of values) {
    resetTuning();
    Object.assign(TUNING, { [key]: v });

    const rows = NAMES.map((name) => {
      const rs = batch(name, n);
      return {
        name,
        renown: mean(rs, (r) => r.renown),
        tier: mean(rs, (r) => r.finalTier),
        surv: mean(rs, (r) => (r.survived ? 1 : 0)),
        thrill: mean(rs, (r) => r.thrill),
        peril: mean(rs, (r) => r.peril),
      };
    });

    const winner = [...rows].sort((a, b) => b.renown - a.renown)[0]!;
    console.log(`\n${String(key)} = ${v}    top-renown: ${winner.name}`);
    console.log(
      '  ' + rows.map((r) => `${r.name} ${r.renown.toFixed(0)}`).join('  |  '),
    );
    console.log(
      '  tier ' + rows.map((r) => `${r.name.slice(0, 4)} ${r.tier.toFixed(1)}`).join(' ')
      + '\n  surv ' + rows.map((r) => `${r.name.slice(0, 4)} ${(r.surv * 100).toFixed(0)}%`).join(' '),
    );
  }
  resetTuning();
}

main();
