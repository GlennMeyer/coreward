/**
 * Meta-progression: what survives a run (§10).
 *
 * Every run currently ends overrun and nothing carries forward, so failure is
 * pure loss. This is the piece that makes a lost run worth having played.
 *
 * Headless like the rest of `src/sim` (§13.2): this module computes and applies
 * a profile but never touches storage. Persistence lives in the UI layer, so
 * the balance runner and the evolver can drive meta-progression without a
 * browser anywhere near them.
 */
import type { SeasonState } from './types';

// ─── The profile ─────────────────────────────────────────────────────────────

export type CodexId = 'hearts' | 'mana' | 'gold' | 'insightYield';

export interface CodexDef {
  id: CodexId;
  name: string;
  blurb: string;
  /** Insight for the first rank; each rank costs `growth` times the last. */
  base: number;
  growth: number;
  maxRank: number;
  /** How much one rank gives. */
  perRank: number;
}

export const CODEX: Record<CodexId, CodexDef> = {
  hearts: {
    id: 'hearts', name: 'Deeper Foundations',
    blurb: '+1 Heart. The Core takes one more breach before it falls.',
    base: 14, growth: 2.1, maxRank: 4, perRank: 1,
  },
  mana: {
    id: 'mana', name: 'Ley Reservoir',
    blurb: '+60 starting Mana. A first floor that can actually hold.',
    base: 8, growth: 1.7, maxRank: 6, perRank: 60,
  },
  gold: {
    id: 'gold', name: 'Opening Float',
    blurb: '+80 starting Gold. Traps and a shop before the first raid.',
    base: 8, growth: 1.7, maxRank: 6, perRank: 80,
  },
  insightYield: {
    id: 'insightYield', name: 'Long Memory',
    blurb: '+15% Insight from every run. Compounds into everything else.',
    base: 20, growth: 2.4, maxRank: 4, perRank: 0.15,
  },
};

export interface Profile {
  /** Unspent Insight. */
  insight: number;
  /** Ranks bought per Codex entry. */
  ranks: Partial<Record<CodexId, number>>;
  /** Runs finished, for flavour and for the idler's bookkeeping. */
  runs: number;
  /** Deepest raid ever reached — the high score a roguelite wants. */
  bestRaids: number;
  bestTier: number;
}

export function emptyProfile(): Profile {
  return { insight: 0, ranks: {}, runs: 0, bestRaids: 0, bestTier: 0 };
}

export function rankOf(p: Profile, id: CodexId): number {
  return p.ranks[id] ?? 0;
}

export function codexCost(id: CodexId, rank: number): number {
  const def = CODEX[id];
  return Math.round(def.base * def.growth ** rank);
}

export function nextCodexCost(p: Profile, id: CodexId): number | null {
  const rank = rankOf(p, id);
  return rank >= CODEX[id].maxRank ? null : codexCost(id, rank);
}

export function buyCodex(p: Profile, id: CodexId): string | null {
  const cost = nextCodexCost(p, id);
  if (cost === null) return 'Already fully studied.';
  if (p.insight < cost) return `Costs ${cost} Insight.`;
  p.insight -= cost;
  p.ranks[id] = rankOf(p, id) + 1;
  return null;
}

// ─── What a run is worth ─────────────────────────────────────────────────────

export interface InsightBreakdown {
  depth: number;
  tier: number;
  legends: number;
  souls: number;
  renown: number;
  bonus: number;
  total: number;
}

/**
 * Insight earned by a finished run.
 *
 * This is also the answer to "what are Souls, Legends and Renown *for*?" — all
 * three were accumulating with no sink. They are a run's residue, and residue
 * is exactly what a meta-currency should be made of: whatever you built up and
 * then lost when the Core fell.
 */
export function insightFromRun(s: SeasonState, p: Profile): InsightBreakdown {
  const depth = s.log.length;
  const tierPart = Math.round(s.renown / 120);
  const legends = s.legends.length * 4;
  const souls = Math.round(s.souls / 8);
  const renown = 0;   // folded into tierPart; kept for a legible breakdown

  const raw = depth + tierPart + legends + souls + renown;
  const mult = 1 + CODEX.insightYield.perRank * rankOf(p, 'insightYield');
  const total = Math.max(1, Math.round(raw * mult));

  return { depth, tier: tierPart, legends, souls, renown, bonus: total - raw, total };
}

/** Fold a finished run into the profile. Mutates `p`. */
export function applyRun(p: Profile, s: SeasonState, tierReached: number): InsightBreakdown {
  const gained = insightFromRun(s, p);
  p.insight += gained.total;
  p.runs += 1;
  p.bestRaids = Math.max(p.bestRaids, s.log.length);
  p.bestTier = Math.max(p.bestTier, tierReached);
  return gained;
}

// ─── What a profile changes about a run ──────────────────────────────────────

export interface StartingBonuses {
  hearts: number;
  mana: number;
  gold: number;
}

export function startingBonuses(p: Profile): StartingBonuses {
  return {
    hearts: rankOf(p, 'hearts') * CODEX.hearts.perRank,
    mana: rankOf(p, 'mana') * CODEX.mana.perRank,
    gold: rankOf(p, 'gold') * CODEX.gold.perRank,
  };
}

/** Apply the profile to a freshly created season. */
export function applyProfile(s: SeasonState, p: Profile): void {
  const b = startingBonuses(p);
  s.dungeon.hearts += b.hearts;
  s.mana += b.mana;
  s.gold += b.gold;
}
