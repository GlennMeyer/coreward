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
import type { SeasonState } from '../sim/types';

const KEY = 'coreward.profile.v1';
const IDLER_KEY = 'coreward.idler.v1';
const RUN_KEY = 'coreward.run.v1';

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

// ─── The run in progress ─────────────────────────────────────────────────────

export interface SavedRun {
  season: SeasonState;
  endless: boolean;
  /** Log lines from the last finished raid, so the replay panel survives too. */
  lastLog: { t: number; cls: string; text: string }[];
  lastRaidNumber: number;
}

/**
 * Autosave the run between raids.
 *
 * `SeasonState` is plain data — that is §13.2 paying off, since a sim full of
 * class instances or engine handles could not be written to storage at all.
 * `RaidSim` *is* a class, so a raid in flight is deliberately not saved: a
 * refresh mid-raid resumes at the Build Phase with the dungeon intact, which is
 * the same trade the HMR handler makes and for the same reason. Restoring a
 * half-finished raid would mean reconstructing a tick loop from JSON, and the
 * dungeon is the expensive thing to lose, not one raid.
 */
export function saveRun(run: SavedRun): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(RUN_KEY, JSON.stringify(run));
  } catch { /* quota — the run continues, it just will not survive a refresh */ }
}

export function loadRun(): SavedRun | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(RUN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedRun;
    // A season with no dungeon is a save from a build that structured things
    // differently; discard rather than crash on it.
    if (!parsed?.season?.dungeon?.floors) return null;

    // JSON cannot represent Infinity — `JSON.stringify(Infinity)` is `null`.
    // An endless run stores `totalRaids: Infinity`, so a saved-and-reloaded run
    // came back with `null`, and `raidNumber >= Math.min(null, cap)` is true on
    // raid 1: the run ended the moment it was resumed, reporting the season as
    // survived. Restore it on the way in.
    const t = parsed.season.totalRaids as number | null;
    if (t === null || t === undefined || !Number.isFinite(t)) {
      parsed.season.totalRaids = Number.POSITIVE_INFINITY;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearRun(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(RUN_KEY);
  } catch { /* nothing to do */ }
}
