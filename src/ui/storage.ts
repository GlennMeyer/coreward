/**
 * Profile persistence.
 *
 * `localStorage`, not `sessionStorage`: meta-progression that vanishes when the
 * tab closes is not meta-progression. This lives in the UI layer on purpose —
 * `src/sim` stays headless (§13.2), so the balance runner and the evolver can
 * drive a Profile without a browser anywhere near them.
 */
import { emptyProfile, type Profile } from '../sim/meta';
import { emptyIdler, type IdlerState } from './idler';

const KEY = 'coreward.profile.v1';
const IDLER_KEY = 'coreward.idler.v1';

/**
 * Storage can throw — private browsing, disabled cookies, a full quota. None of
 * that should cost the player their game, so every path falls back to an
 * in-memory profile and the run continues.
 */
function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    const probe = '__cw';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export function loadProfile(): Profile {
  const s = storage();
  if (!s) return emptyProfile();
  try {
    const raw = s.getItem(KEY);
    if (!raw) return emptyProfile();
    const parsed = JSON.parse(raw) as Partial<Profile>;
    // Merged over a fresh profile so a save written by an older build — one
    // without `bestTier`, say — loads rather than crashing on a missing field.
    return { ...emptyProfile(), ...parsed, ranks: { ...(parsed.ranks ?? {}) } };
  } catch {
    return emptyProfile();
  }
}

export function saveProfile(p: Profile): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(p));
  } catch {
    // Quota or a locked-down browser. Losing the save is bad; losing the run
    // in progress because we threw is worse.
  }
}

export function clearProfile(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch { /* nothing to do */ }
}

// ─── Idler ───────────────────────────────────────────────────────────────────

/**
 * The evolved population, persisted so the search gets smarter across sessions
 * instead of restarting cold every time the tab opens (§32).
 */
export function loadIdler(): IdlerState {
  const s = storage();
  if (!s) return emptyIdler();
  try {
    const raw = s.getItem(IDLER_KEY);
    if (!raw) return emptyIdler();
    return { ...emptyIdler(), ...(JSON.parse(raw) as Partial<IdlerState>) };
  } catch {
    return emptyIdler();
  }
}

export function saveIdler(st: IdlerState): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(IDLER_KEY, JSON.stringify(st));
  } catch { /* quota; the search simply restarts next session */ }
}
