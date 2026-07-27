/**
 * Prototype renderer: DOM rectangles and text (§12 — no art).
 *
 * This file is a pure *consumer* of the sim. It reads sim state for display and
 * drains the RaidEvent stream for pacing and the log, but the sim knows nothing
 * about it (§13.2). Swapping this for an isometric renderer should not require
 * touching anything under src/sim.
 */
import './styles.css';
import {
  AMENITIES, GEAR, HIRED_STAFF_COST, MAX_GEAR_SLOTS, MOBS, PRICE_TIERS,
  SEASON_RAIDS, TUNING,
} from '../sim/data';
import {
  assignStaff, buildAmenity, buyMob, demolishAmenity, digCost, digFloor,
  dismissMob, dismissValue, equipGear, getMob, hireStaff, isOpen,
  mobEffectiveHp, placeMobInRoom, roomSlotsUsed, setPrice, totalUpkeep,
} from '../sim/dungeon';
import { applyAftermath, createSeason, currentTier, startRaid } from '../sim/season';
import { forecast, predictThrill, thrillRating, type ThrillPrediction } from './predict';
import type { RaidSim } from '../sim/raid';
import type {
  Adventurer, Amenity, AmenityId, Legend, Mob, PriceTier, RaidEvent,
  SeasonState, ThrillScore,
} from '../sim/types';
import type { Aftermath as AftermathType } from '../sim/season';

// ─── App state ───────────────────────────────────────────────────────────────

type Phase = 'build' | 'raid' | 'aftermath' | 'over';

const SPEEDS = [
  { label: 'II', ms: 0 },
  { label: '1x', ms: 340 },
  { label: '2x', ms: 170 },
  { label: '4x', ms: 85 },
] as const;

interface LogLine { t: number; cls: string; text: string; }

interface App {
  season: SeasonState;
  phase: Phase;
  sim: RaidSim | null;
  speedIdx: number;
  log: LogLine[];
  selectedMob: number | null;
  aftermath: AftermathType | null;
  error: string;
}

const app: App = {
  season: createSeason(Math.floor(Date.now() % 100000)),
  phase: 'build',
  sim: null,
  speedIdx: 1,
  log: [],
  selectedMob: null,
  aftermath: null,
  error: '',
};

let timer: number | null = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const root = document.getElementById('app')!;

/**
 * Parse an HTML fragment into an element.
 *
 * Uses <template> rather than a <div>: the HTML parser silently DISCARDS
 * table-scoped tags (<tr>, <td>) when they are set as a div's innerHTML,
 * because they are only valid inside a table. Template content has no such
 * restriction, so `el('<tr>…</tr>')` returns a row instead of null.
 */
const el = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};
/** 1st, 2nd, 3rd, 4th — the suffix was hardcoded 'rd', which read as "2rd". */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

function fail(msg: string | null): boolean {
  app.error = msg ?? '';
  // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
  return msg === null;
}

function pushLog(e: RaidEvent): void {
  const line = describe(e);
  if (line) app.log.push({ t: e.t, ...line });
  if (app.log.length > 400) app.log.splice(0, app.log.length - 400);
}

function mobName(uid: number): string {
  const m = getMob(app.season.dungeon, uid);
  return m ? MOBS[m.defId]!.name : `#${uid}`;
}

function advName(id: number): string {
  return app.sim?.party.members.find((m) => m.id === id)?.name ?? `#${id}`;
}

/** RaidEvent → log line. The renderer's only interpretation of the stream. */
function describe(e: RaidEvent): { cls: string; text: string } | null {
  switch (e.type) {
    case 'raid-start':
      return { cls: 'info', text: `A party of ${e.partySize} enters (Threat Tier ${e.tier}).` };
    case 'floor-enter':
      return { cls: 'info', text: `— they descend to Floor ${e.floor + 1} —` };
    case 'room-enter':
      return { cls: '', text: `Room ${e.room + 1} of Floor ${e.floor + 1}.` };
    case 'attack':
      return e.source === 'mob'
        ? { cls: 'hit', text: `${mobName(e.uid)} hits ${advName(e.targetId)} for ${e.dmg}.` }
        : { cls: '', text: `${advName(e.advId)} hits ${mobName(e.targetUid)} for ${e.dmg}.` };
    case 'kit-strip':
      return { cls: 'good', text: `${mobName(e.uid)} destroys supplies. Kit ${e.kitLeft}.` };
    case 'resolve-hit':
      return { cls: 'good', text: `${advName(e.advId)} falters. Resolve ${e.resolveLeft}.` };
    case 'kit-heal':
      return { cls: '', text: `${advName(e.advId)} drinks a potion (+${e.amount}). Kit ${e.kitLeft}.` };
    case 'mob-downed':
      return { cls: 'crit', text: `${MOBS[e.defId]!.name} is downed.` };
    case 'mob-slain':
      return { cls: 'crit', text: `${MOBS[e.defId]!.name} (lv ${e.level}) is slain for good.` };
    case 'adv-death':
      return { cls: 'good', text: `${e.name} dies. ${e.goldDropped}g recovered.` };
    case 'mob-levelup':
      return { cls: 'buy2', text: `${mobName(e.uid)} reaches level ${e.level}.` };
    case 'room-clear':
      return { cls: '', text: `Room ${e.room + 1} cleared.` };
    case 'landing-enter':
      return { cls: 'info', text: `They reach Landing ${e.landing + 1}.` };
    case 'rest':
      return e.kitSpent > 0
        ? { cls: '', text: `They rest: +${e.hpRestored} HP for ${e.kitSpent} Kit. Kit ${e.kitLeft}.` }
        : { cls: 'good', text: `No supplies left to rest with.` };
    case 'purchase':
      return { cls: 'buy2', text: `${advName(e.advId)} buys from the ${AMENITIES[e.amenity].name}: ${e.detail} (${e.gold}g).` };
    case 'descend':
      return null;
    case 'retreat':
      return { cls: 'good', text: `They turn back (${reasonText(e.reason)}).` };
    case 'taunt-offer':
      return { cls: 'info', text: `They are leaving...` };
    case 'taunt-used':
      return { cls: 'crit', text: `TAUNTED — the dungeon goads them deeper.` };
    case 'intervention-retreat':
      return { cls: 'info', text: `${mobName(e.uid)} is pulled from the fight.` };
    case 'core-breach':
      return { cls: 'crit', text: `THE CORE IS BREACHED. Hearts left: ${e.heartsLeft}.` };
    case 'raid-end':
      return { cls: 'info', text: `Raid over: ${e.outcome}.` };
  }
}

function reasonText(r: string): string {
  return { hp: 'too wounded', kit: 'out of supplies', resolve: 'nerve broken', wiped: 'all dead' }[r] ?? r;
}

// ─── Playback ────────────────────────────────────────────────────────────────

function stopTimer(): void {
  if (timer !== null) { clearInterval(timer); timer = null; }
}

function syncTimer(): void {
  stopTimer();
  if (app.phase !== 'raid' || !app.sim) return;
  const ms = SPEEDS[app.speedIdx]!.ms;
  if (ms === 0) return; // paused
  timer = setInterval(tick, ms) as unknown as number;
}

function tick(): void {
  const sim = app.sim;
  if (!sim || sim.status !== 'running') { stopTimer(); return; }
  for (const e of sim.step()) pushLog(e);
  if (sim.status !== 'running') stopTimer();
  // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
}

/** "Instant": drain the whole raid with no renderer in the loop. */
function runInstant(): void {
  const sim = app.sim;
  if (!sim) return;
  stopTimer();
  while (sim.status !== 'complete') {
    for (const e of sim.step()) pushLog(e);
    if (sim.status === 'awaiting-taunt') {
      for (const e of sim.resolveTaunt(false)) pushLog(e);
    }
  }
  // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
}

// ─── Phase transitions ───────────────────────────────────────────────────────

function beginRaid(): void {
  app.sim = startRaid(app.season);
  app.phase = 'raid';
  app.log = [];
  app.selectedMob = null;
  app.error = '';
  for (const e of app.sim.step()) pushLog(e);
  // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
  syncTimer();
}

function finishRaid(): void {
  const sim = app.sim;
  if (!sim || sim.status !== 'complete') return;
  stopTimer();
  app.aftermath = applyAftermath(app.season, sim);
  app.phase = app.season.over ? 'over' : 'aftermath';
  // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
}

function nextRaid(): void {
  app.phase = 'build';
  app.sim = null;
  app.aftermath = null;
  // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
}

function restart(): void {
  stopTimer();
  Object.assign(app, {
    season: createSeason(Math.floor(Math.random() * 100000)),
    phase: 'build', sim: null, speedIdx: 1, log: [],
    selectedMob: null, aftermath: null, error: '',
  });
  // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
}

// ─── Drag and drop ───────────────────────────────────────────────────────────

/**
 * Pointer-events based rather than the HTML5 drag API: one code path for mouse,
 * touch and pen, and full control over the drag ghost. A drag that never passes
 * the movement threshold falls through to the element's click handler, so
 * click-to-select still works (and keeps the UI usable without a pointer).
 */
type DragPayload =
  | { kind: 'mob'; uid: number }
  | { kind: 'buy'; defId: string };

const DRAG_THRESHOLD = 5;
let ghost: HTMLElement | null = null;

function attachDrag(node: HTMLElement, payload: DragPayload, label: string): void {
  node.addEventListener('pointerdown', (ev: PointerEvent) => {
    if (ev.button !== 0 || app.phase !== 'build') return;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let dragging = false;

    const move = (e: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(e.clientX - x0, e.clientY - y0) < DRAG_THRESHOLD) return;
        dragging = true;
        ghost = el(`<div class="ghost">${esc(label)}</div>`);
        document.body.append(ghost);
        document.body.classList.add('dragging');
      }
      ghost!.style.left = `${e.clientX}px`;
      ghost!.style.top = `${e.clientY}px`;
      markHover(e);
    };

    const up = (e: PointerEvent): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (!dragging) return; // a click, not a drag — let onclick handle it
      ghost?.remove();
      ghost = null;
      document.body.classList.remove('dragging');
      clearHover();
      drop(e, payload);
    };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
}

/** The ghost is pointer-events:none, so elementFromPoint sees through it. */
function targetUnder(e: PointerEvent): HTMLElement | null {
  const node = document.elementFromPoint(e.clientX, e.clientY);
  return (node?.closest('.room, .amenity') as HTMLElement | null) ?? null;
}

function markHover(e: PointerEvent): void {
  clearHover();
  targetUnder(e)?.classList.add('drop-hover');
}

function clearHover(): void {
  document.querySelectorAll('.drop-hover').forEach((n) => n.classList.remove('drop-hover'));
}

function drop(e: PointerEvent, payload: DragPayload): void {
  const target = targetUnder(e);
  if (!target) return;
  const d = app.season.dungeon;

  // Buying and placing in one gesture.
  let uid: number;
  if (payload.kind === 'buy') {
    const def = MOBS[payload.defId]!;
    if (app.season.mana < def.cost) return void fail('Not enough mana.');
    const mob = buyMob(d, def.id);
    if (typeof mob === 'string') return void fail(mob);
    uid = mob.uid;

    const err = applyDrop(target, uid);
    if (err) {
      d.mobs.pop(); // undo the purchase rather than stranding it
      return void fail(err);
    }
    app.season.mana -= def.cost;
    app.selectedMob = uid;
    return void fail(null);
  }

  uid = payload.uid;
  const err = applyDrop(target, uid);
  if (!err) app.selectedMob = null;
  fail(err);
}

function applyDrop(target: HTMLElement, uid: number): string | null {
  const d = app.season.dungeon;
  if (target.classList.contains('room')) {
    return placeMobInRoom(d, uid, Number(target.dataset['floor']), Number(target.dataset['room']));
  }
  return assignStaff(d, uid, Number(target.dataset['landing']), Number(target.dataset['slot']));
}

// ─── Render ──────────────────────────────────────────────────────────────────

function render(): void {
  root.innerHTML = '';
  root.append(topbar());

  const cols = el('<div class="cols"></div>');
  const left = el('<div class="col-left"></div>');
  const right = el('<div class="col-right"></div>');

  left.append(dungeonPanel());
  right.append(app.phase === 'raid' ? raidPanel() : buildPanel());
  cols.append(left, right);
  root.append(cols);

  if (app.phase === 'aftermath' && app.aftermath) root.append(aftermathModal(app.aftermath));
  if (app.phase === 'over') root.append(gameOverModal());
  if (app.sim?.status === 'awaiting-taunt') root.append(tauntModal());
  if (app.sim?.status === 'complete' && app.phase === 'raid') root.append(raidDoneBar());
}

function topbar(): HTMLElement {
  const s = app.season;
  const tier = currentTier(s);
  const trickle = s.legends.length * TUNING.legendRenownTrickle;
  const bar = el(`
    <div class="topbar">
      <h1>Coreward</h1>
      <span class="stat"><span class="lbl">raid</span><b>${s.raidNumber}/${SEASON_RAIDS}</b></span>
      <span class="stat"><span class="lbl">tier</span><b>${tier.tier}</b></span>
      <div class="stats">
        <span class="stat hearts"><span class="lbl">hearts</span><b>${'♥'.repeat(s.dungeon.hearts) || '—'}</b></span>
        <span class="stat mana"><span class="lbl">mana</span><b>${Math.round(s.mana)}</b></span>
        <span class="stat gold"><span class="lbl">gold</span><b>${s.gold}</b></span>
        <span class="stat souls"><span class="lbl">souls</span><b>${s.souls}</b></span>
        <span class="stat legends" title="Retired adventurers — ${trickle} passive Renown per raid (§15.5)">
          <span class="lbl">legends</span><b>★ ${s.legends.length}</b></span>
        <span class="stat renown"><span class="lbl">renown</span><b>${s.renown}</b></span>
      </div>
    </div>`);
  return bar;
}

const VERDICT_TEXT: Record<string, string> = {
  outmatched: 'Outmatched — they will walk to the Core.',
  thin: 'Thin — expect a breach unless the upper floors slow them.',
  even: 'Evenly matched — this is where the good stories happen.',
  strong: 'Strong — they should turn back hurt.',
  overwhelming: 'Overwhelming — likely a wipe, and a wipe pays no Renown.',
};

// ─── Thrill (§15) ────────────────────────────────────────────────────────────

/**
 * The four positive components, with the weights they carry into the score.
 * Read from TUNING so a balance sweep moves the readout with the formula.
 */
const THRILL_PARTS = [
  { key: 'peril', label: 'Peril', weight: TUNING.thrillPerilWeight, note: 'how close to death' },
  { key: 'depth', label: 'Depth', weight: TUNING.thrillDepthWeight, note: 'floors cleared' },
  { key: 'variety', label: 'Variety', weight: TUNING.thrillVarietyWeight, note: 'roles faced' },
  { key: 'comfort', label: 'Comfort', weight: TUNING.thrillComfortWeight, note: 'amenities used' },
] as const;

/**
 * Thrill and its breakdown, as an RCT-style ride-stats block. Shared by the
 * Aftermath (real score) and the Build Phase (predicted) so the player learns
 * one readout, not two.
 */
function thrillCard(t: ThrillScore, opts: { caption: string }): HTMLElement {
  const total = Math.round(t.total);
  const card = el(`<div class="thrill"></div>`);
  card.append(el(`
    <div class="thrill-head">
      <div class="thrill-score"><b>${total}</b><span>Thrill</span></div>
      <div class="thrill-verdict">
        ${thrillRating(t.total)}
        <div class="sub">${esc(opts.caption)}</div>
      </div>
    </div>`));
  card.append(el(`<div class="thrill-track"><i style="width:${Math.min(100, Math.max(0, total))}%"></i></div>`));

  const table = el('<table class="thrill-parts"></table>');
  for (const p of THRILL_PARTS) {
    const v = Math.max(0, Math.min(1, t[p.key]));
    const pts = Math.round(100 * p.weight * v);
    table.append(el(`
      <tr title="${esc(p.note)} — worth up to ${Math.round(p.weight * 100)}">
        <td class="pname">${p.label}</td>
        <td class="pval">${v.toFixed(2)}</td>
        <td class="pbar"><span><i style="width:${v * 100}%"></i></span></td>
        <td class="pos">+${pts}</td>
      </tr>`));
  }
  table.append(el(`
    <tr class="tot" title="Empty rooms and repeated rooms (§15.3)">
      <td class="pname">Tedium</td>
      <td class="pval"></td>
      <td class="pbar"><span class="bad"><i style="width:${Math.min(100, t.tedium)}%"></i></span></td>
      <td class="${t.tedium > 0 ? 'neg' : ''}">${t.tedium > 0 ? '−' : ''}${Math.round(t.tedium)}</td>
    </tr>`));
  card.append(table);
  return card;
}

function dungeonPanel(): HTMLElement {
  const s = app.season;
  const d = s.dungeon;
  const sim = app.sim;
  const panel = el('<div class="panel"></div>');
  panel.append(el(`<h2>The Dungeon &nbsp;·&nbsp; upkeep ${totalUpkeep(d)}/raid</h2>`));

  d.floors.forEach((floor, fi) => {
    const wrap = el(`<div class="floor"></div>`);
    wrap.append(el(`<div class="floor-label">Floor ${fi + 1}</div>`));
    const rooms = el('<div class="rooms"></div>');

    floor.rooms.forEach((_, ri) => {
      const isActive = app.phase === 'raid' && sim?.status !== 'complete'
        && sim?.currentFloor === fi && sim?.currentRoom === ri;
      const canDrop = app.phase === 'build' && app.selectedMob !== null;
      const room = el(
        `<div class="room ${isActive ? 'active' : ''} ${canDrop ? 'droppable' : ''}"
              data-floor="${fi}" data-room="${ri}"></div>`,
      );

      for (const uid of d.floors[fi]!.rooms[ri]!.mobUids) {
        const mob = getMob(d, uid);
        if (!mob || !mob.alive) continue;
        room.append(mobChip(mob));
      }
      room.append(el(`<div class="slots">${roomSlotsUsed(d, fi, ri)}/3</div>`));

      room.onclick = (ev) => {
        ev.stopPropagation();
        if (app.phase !== 'build' || app.selectedMob === null) return;
        const err = placeMobInRoom(d, app.selectedMob, fi, ri);
        if (!err) app.selectedMob = null;
        fail(err);
      };
      rooms.append(room);
    });

    wrap.append(rooms);
    panel.append(wrap);

    const landing = d.landings[fi];
    if (landing) panel.append(landingRow(fi, landing.amenities));
  });

  panel.append(el(`<div class="core">◆ THE CORE ◆</div>`));
  if (app.error) panel.append(el(`<div class="err">${esc(app.error)}</div>`));
  return panel;
}

function mobChip(mob: Mob): HTMLElement {
  const def = MOBS[mob.defId]!;
  const maxHp = mobEffectiveHp(mob);
  const pct = Math.max(0, Math.min(100, (mob.hp / maxHp) * 100));
  const sel = app.selectedMob === mob.uid ? 'selected' : '';
  const gear = mob.gear.length
    ? `<span class="gear"> ${mob.gear.map((g) => GEAR[g]!.name.split(' ')[0]).join('/')}</span>` : '';
  const chip = el(`
    <div class="mob ${mob.downed ? 'downed' : ''} ${sel}">
      ${esc(def.name)}${mob.level > 1 ? ` <span class="lv">lv${mob.level}</span>` : ''}${gear}
      <div class="hpbar"><i style="width:${pct}%"></i></div>
    </div>`);

  attachDrag(chip, { kind: 'mob', uid: mob.uid }, def.name);

  chip.onclick = (ev) => {
    ev.stopPropagation();
    if (app.phase === 'build') {
      app.selectedMob = app.selectedMob === mob.uid ? null : mob.uid;
      fail(null);
    } else if (app.phase === 'raid' && app.sim) {
      // Retreat intervention: pull a veteran out before the room falls.
      const ok = app.sim.applyRetreatIntervention(mob.uid);
      fail(ok ? null : 'Retreat needs a Ley Charge and a monster in the active room.');
    }
  };
  return chip;
}

function landingRow(idx: number, amenities: readonly (Amenity | null)[]): HTMLElement {
  const d = app.season.dungeon;
  const deepest = idx === d.floors.length - 1;
  const active = app.phase === 'raid' && app.sim?.currentFloor === idx
    && app.sim?.status === 'awaiting-taunt';
  const row = el(`<div class="landing ${active ? 'active' : ''}"></div>`);
  row.append(el(`<span class="tag">${deepest ? 'Core approach' : `Landing ${idx + 1}`}</span>`));

  amenities.forEach((a, slot) => {
    if (!a) {
      if (app.phase !== 'build') return;
      for (const id of Object.keys(AMENITIES) as AmenityId[]) {
        const def = AMENITIES[id];
        const b = el(`<button ${app.season.mana < def.buildCost ? 'disabled' : ''}>+ ${def.name} ${def.buildCost}</button>`);
        b.onclick = () => {
          const err = buildAmenity(d, idx, slot, id);
          if (!err) app.season.mana -= def.buildCost;
          fail(err);
        };
        row.append(b);
      }
      return;
    }

    const def = AMENITIES[a.defId];
    const p = PRICE_TIERS[a.price];
    const staff = a.hired ? 'hirelings' : a.staffUid !== null ? mobName(a.staffUid) : 'CLOSED';
    const chip = el(`
      <div class="amenity ${isOpen(a) ? '' : 'closed'}"
           data-landing="${idx}" data-slot="${slot}">
        ${def.name} <span class="price">${Math.round(def.basePrice * p.mult)}g</span>
        · ${a.price} · ${esc(staff)}
      </div>`);
    if (app.phase === 'build') {
      chip.onclick = () => {
        if (app.selectedMob !== null) {
          const err = assignStaff(d, app.selectedMob, idx, slot);
          if (!err) app.selectedMob = null;
          fail(err);
        } else {
          const order: PriceTier[] = ['modest', 'standard', 'premium', 'gouge'];
          setPrice(d, idx, slot, order[(order.indexOf(a.price) + 1) % order.length]!);
          fail(null);
        }
      };
    }
    row.append(chip);

    if (app.phase === 'build') {
      if (!a.hired) {
        const hire = el(`<button ${app.season.gold < HIRED_STAFF_COST ? 'disabled' : ''}>Hire ${HIRED_STAFF_COST}g</button>`);
        hire.onclick = () => {
          const err = hireStaff(d, idx, slot);
          if (!err) app.season.gold -= HIRED_STAFF_COST;
          fail(err);
        };
        row.append(hire);
      }
      const del = el('<button class="danger">×</button>');
      del.onclick = () => fail(demolishAmenity(d, idx, slot));
      row.append(del);
    }
  });
  return row;
}

// ─── Build panel ─────────────────────────────────────────────────────────────

function buildPanel(): HTMLElement {
  const s = app.season;
  const d = s.dungeon;
  const wrap = el('<div></div>');

  const actions = el('<div class="panel"></div>');
  actions.append(el('<h2>Build Phase</h2>'));
  const cost = digCost(d);
  const digBtn = el(`<button ${cost === null || s.mana < cost ? 'disabled' : ''}>Dig Floor ${d.floors.length + 1}${cost !== null ? ` — ${cost}` : ' (max)'}</button>`);
  digBtn.onclick = () => {
    if (cost === null) return;
    const err = digFloor(d);
    if (!err) s.mana -= cost;
    fail(err);
  };
  const go = el('<button class="primary">Begin Raid →</button>');
  go.onclick = beginRaid;
  const rowA = el('<div class="row"></div>');
  rowA.append(digBtn, go);
  actions.append(rowA);
  actions.append(el(`<div class="hint">Drag monsters into rooms, or onto a shop to staff it. Clicking works too: select, then click a target.</div>`));
  wrap.append(actions);

  // Order requested: Build Phase, then what's coming, then Monsters, then
  // Predicted Thrill, then Legends. Forecast sits high because it is what the
  // player acts on while spending; Thrill and Legends are review, not input.
  wrap.append(forecastPanel());

  // Roster
  const idle = d.mobs.filter((m) => m.alive && m.placement.kind === 'unassigned');
  if (idle.length) {
    const p = el('<div class="panel"></div>');
    p.append(el(`<h2>Unassigned (${idle.length}) — no upkeep, no defence</h2>`));
    for (const m of idle) p.append(mobChip(m));
    wrap.append(p);
  }

  // Selected monster: gear
  if (app.selectedMob !== null) {
    const mob = getMob(d, app.selectedMob);
    if (mob) {
      const p = el('<div class="panel"></div>');
      p.append(el(`<h2>${esc(MOBS[mob.defId]!.name)} — lv ${mob.level} · ${mob.xp} xp</h2>`));
      for (const g of Object.values(GEAR)) {
        const owned = mob.gear.includes(g.id);
        const full = mob.gear.length >= MAX_GEAR_SLOTS;
        const off = owned || full || s.gold < g.cost;
        const b = el(`<div class="buy ${off ? 'off' : ''}">
            <span>${g.name}${owned ? ' ✓' : ''}</span>
            <span class="cost g">${g.cost}g</span>
          </div>`);
        if (!off) {
          b.onclick = () => {
            const err = equipGear(d, mob.uid, g.id);
            if (!err) s.gold -= g.cost;
            fail(err);
          };
        }
        p.append(b);
      }
      p.append(el(`<div class="hint">Gear survives its wearer — slain monsters return it to the armory.</div>`));

      // Dismiss (§4.1). Half of BASE cost, so selling a levelled monster
      // throws its levels away — worth saying out loud before they click.
      const refund = dismissValue(mob);
      const sell = el(`<button class="danger sell">Dismiss — refund ${refund} mana</button>`);
      sell.onclick = () => {
        const res = dismissMob(d, mob.uid);
        if (typeof res === 'string') return fail(res);
        s.mana += res.mana;
        app.selectedMob = null;
        return fail(null);
      };
      const sellRow = el('<div class="row"></div>');
      sellRow.append(sell);
      p.append(sellRow);
      if (mob.level > 1) {
        p.append(el(`<div class="hint warn-t">Dismissing loses ${mob.level - 1} level${mob.level === 2 ? '' : 's'} permanently — the refund is on base cost only.</div>`));
      }
      if (mob.gear.length) {
        p.append(el(`<div class="hint">Its gear returns to the armory.</div>`));
      }
      wrap.append(p);
    }
  }

  // Monster shop
  const shop = el('<div class="panel"></div>');
  shop.append(el('<h2>Monsters</h2>'));
  for (const def of Object.values(MOBS)) {
    const off = s.mana < def.cost;
    const b = el(`<div class="buy ${off ? 'off' : ''}">
        <span>${def.name}<div class="meta">${def.role} · ${def.hp}hp ${def.dmg}dmg ${def.spd}spd · ${def.slots} slot${def.slots > 1 ? 's' : ''} · ${def.upkeep} upkeep</div></span>
        <span class="cost">${def.cost}</span>
      </div>`);
    if (!off) {
      attachDrag(b, { kind: 'buy', defId: def.id }, def.name);
      b.onclick = () => {
        const mob = buyMob(d, def.id);
        if (typeof mob === 'string') return fail(mob);
        s.mana -= def.cost;
        app.selectedMob = mob.uid;
        return fail(null);
      };
    }
    shop.append(b);
  }
  wrap.append(shop);
  wrap.append(predictionPanel());
  wrap.append(legendsPanel());
  return wrap;
}

/**
 * "What is coming, and can we take it?" — a power-ratio readout, not a
 * prediction. See `forecast()` for why a single number cannot be a win chance.
 */
function forecastPanel(): HTMLElement {
  const s = app.season;
  const tier = currentTier(s);
  const f = forecast(s.dungeon, tier);
  const p = el('<div class="panel"></div>');
  p.append(el(`<h2>Next Raid — Tier ${f.tier}</h2>`));

  const returning = s.veterans.filter((v) => !v.retired).length;
  p.append(el(`
    <div class="fc-party">
      <b>${f.partySize} adventurers</b>, level ${f.levelMin}–${f.levelMax}
      ${returning > 0 ? `<span class="fc-ret" title="Survivors who may come back (§15.5)">· ${returning} may return</span>` : ''}
    </div>`));

  const bar = el(`<div class="fc-bar" title="Dungeon power vs party power"></div>`);
  const pct = Math.max(4, Math.min(96, (f.ratio / 2) * 100));
  bar.append(el(`<i class="fc-us" style="width:${pct}%"></i>`));
  p.append(bar);
  p.append(el(`
    <div class="fc-verdict ${f.verdict}">
      ${VERDICT_TEXT[f.verdict]}
      <span class="fc-ratio">×${f.ratio.toFixed(2)}</span>
    </div>`));

  const t = el('<table class="fc-table"></table>');
  t.append(el(`<tr><td></td><td class="fc-them">Them</td><td class="fc-us-h">Us</td></tr>`));
  t.append(el(`<tr><td>HP</td><td class="fc-them">${f.partyEffectiveHp}</td><td class="fc-us-h">${f.dungeonHp}</td></tr>`));
  t.append(el(`<tr><td>Damage</td><td class="fc-them">${f.partyDmg}</td><td class="fc-us-h">${f.dungeonDmg}</td></tr>`));
  t.append(el(`<tr><td>Bodies</td><td class="fc-them">${f.partySize}</td><td class="fc-us-h">${f.defenders}</td></tr>`));
  p.append(t);

  // Kit is why "Them HP" looks inflated — it roughly doubles their health
  // (§14.4), and hiding that would make the comparison lie.
  p.append(el(`<div class="hint">Their HP includes ${f.partyKit} Kit of healing — supplies are most of a party's staying power (§7.3).</div>`));

  if (f.staffed > 0) {
    p.append(el(`<div class="hint warn-t">${f.staffed} monster${f.staffed === 1 ? '' : 's'} behind a counter, not fighting (§8.4).</div>`));
  }
  if (f.namedIncoming.length) {
    p.append(el(`<div class="hint warn-t">Named adventurers possible: ${esc(f.namedIncoming.join(', '))}.</div>`));
  }
  return p;
}

/**
 * "Ride stats before you open" (§15.6 Q3). The estimate is computed in the UI
 * (src/ui/predict.ts) and is explicitly an approximation of §15.3 — the panel
 * says so, because a number the player trusts and the sim then contradicts is
 * worse than no number.
 */
function predictionPanel(): HTMLElement {
  const p = el('<div class="panel"></div>');
  const tier = currentTier(app.season);
  let est: ThrillPrediction;
  try {
    est = predictThrill(app.season.dungeon, tier);
  } catch {
    // A bad estimate must never cost the player their Build Phase.
    return el('<div class="panel"><h2>Predicted Thrill</h2><div class="hint">unavailable</div></div>');
  }

  p.append(el(`<h2>Predicted Thrill — Tier ${tier.tier}</h2>`));
  p.append(thrillCard(est, {
    caption: `estimate · reaches floor ${est.floorsReached || 1} of ${app.season.dungeon.floors.length}`,
  }));

  if (est.warnings.length) {
    const list = el('<div class="warnings"></div>');
    for (const w of est.warnings) {
      list.append(el(`<div class="warn-line ${w.level}">${w.level === 'bad' ? '!' : '·'} ${esc(w.text)}</div>`));
    }
    p.append(list);
  }
  p.append(el(`<div class="hint">A rough UI-side model of the real §15.3 formula — no dice, no Taunt, an average party. Treat it as a shape, not a forecast.</div>`));
  return p;
}

/** Legends are permanent, so they get a permanent home in the Build Phase (§15.5). */
function legendsPanel(): HTMLElement {
  const s = app.season;
  const trickle = s.legends.length * TUNING.legendRenownTrickle;
  const p = el('<div class="panel"></div>');
  p.append(el(`<h2>Legends (${s.legends.length}) &nbsp;·&nbsp; +${trickle} Renown/raid</h2>`));

  if (!s.legends.length) {
    p.append(el(`<div class="hint">Nobody has retired here yet. Send an adventurer home from
      their ${ordinal(TUNING.retireMinDelves)} delve at Thrill ${TUNING.retireThrill}+ and they hang up
      their sword — a permanent Renown trickle you never have to defend.</div>`));
  } else {
    for (const l of s.legends) p.append(legendRow(l));
  }

  // The recurring face is the point of §15.5 — surface the regulars even before
  // any of them retire, so retirement reads as the end of a relationship.
  const regulars = s.veterans.filter((v) => !v.retired);
  if (regulars.length) {
    const top = [...regulars].sort((a, b) => b.delves - a.delves).slice(0, 4);
    p.append(el(`<div class="regulars">
        <span class="lbl">regulars</span>
        ${top.map((v) => `${esc(v.name)} <span class="vet">×${v.delves}</span>`).join(' · ')}
        ${regulars.length > top.length ? ` <span class="lbl">+${regulars.length - top.length} more</span>` : ''}
      </div>`));
  }
  return p;
}

function legendRow(l: Legend): HTMLElement {
  return el(`
    <div class="legend">
      <span class="star">★</span>
      <span class="nm">${esc(l.name)}</span>
      <span class="lbl">raid ${l.retiredOnRaid}</span>
      <span class="th">${Math.round(l.thrill)}</span>
    </div>`);
}

// ─── Raid panel ──────────────────────────────────────────────────────────────

function raidPanel(): HTMLElement {
  const sim = app.sim!;
  const wrap = el('<div></div>');

  const ctl = el('<div class="panel"></div>');
  ctl.append(el(`<h2>Raid — ${sim.charges} Ley Charge${sim.charges === 1 ? '' : 's'}</h2>`));
  const row = el('<div class="row"></div>');
  SPEEDS.forEach((sp, i) => {
    const b = el(`<button class="${app.speedIdx === i ? 'on' : ''}">${sp.label}</button>`);
    b.onclick = () => { app.speedIdx = i; // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render(); syncTimer(); };
    row.append(b);
  });
  const inst = el('<button>Instant</button>');
  inst.onclick = runInstant;
  row.append(inst);
  ctl.append(row);
  ctl.append(el('<div class="hint">Click a monster in the active room to pull it out (costs a Ley Charge).</div>'));
  if (app.error) ctl.append(el(`<div class="err">${esc(app.error)}</div>`));
  wrap.append(ctl);

  // Party
  const p = el('<div class="panel"></div>');
  p.append(el(`<h2>The Party — Tier ${sim.tier.tier}</h2>`));
  p.append(el(`<div class="meters">
      <span>Kit <b>${sim.party.kit}</b>/${sim.party.maxKit}</span>
      <span>Gold <b>${sim.party.members.reduce((a, m) => a + (m.alive ? m.gold : 0), 0)}</b></span>
    </div>`));
  for (const a of sim.party.members) p.append(advRow(a));
  wrap.append(p);

  // Log
  const lp = el('<div class="panel"></div>');
  lp.append(el('<h2>Log</h2>'));
  const log = el('<div class="log"></div>');
  for (const line of app.log.slice(-160)) {
    log.append(el(`<div class="${line.cls}"><span class="t">${line.t}</span>${esc(line.text)}</div>`));
  }
  lp.append(log);
  wrap.append(lp);
  queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
  return wrap;
}

function advRow(a: Adventurer): HTMLElement {
  const hp = Math.max(0, (a.hp / a.maxHp) * 100);
  const res = Math.max(0, (a.resolve / a.maxResolve) * 100);
  // A face the player recognises is the emotional core of §15.5 — a returning
  // veteran should never be indistinguishable from a fresh roll.
  const vet = a.veteranId === null
    ? null
    : app.season.veterans.find((v) => v.id === a.veteranId);
  const mark = vet
    ? `<span class="vet" title="Returning — ${vet.delves} previous delve${vet.delves === 1 ? '' : 's'}, best Thrill ${Math.round(vet.bestThrill)}">↩${vet.delves}</span>`
    : '';
  return el(`
    <div class="adv ${a.alive ? '' : 'dead'} ${a.namedId ? 'named' : ''} ${vet ? 'returning' : ''}">
      <span class="nm">${mark}${esc(a.name)} <span style="color:var(--dim)">${a.cls} ${a.level}</span></span>
      <span class="bar" title="HP"><i style="width:${hp}%"></i></span>
      <span class="bar res" title="Resolve"><i style="width:${res}%"></i></span>
    </div>`);
}

function raidDoneBar(): HTMLElement {
  const bg = el('<div class="modal-bg"></div>');
  const r = app.sim!.result;
  const m = el(`
    <div class="modal">
      <h3>${r.outcome === 'wiped' ? 'The party is destroyed' : r.outcome === 'breach' ? 'The Core is breached' : 'They turn back'}</h3>
      <p>${r.killed} killed · ${r.escaped} escaped · ${r.mobsDowned.length} monsters downed, ${r.mobsLost.length} slain</p>
      <div class="row"><button class="primary">Aftermath →</button></div>
    </div>`);
  m.querySelector('button')!.onclick = finishRaid;
  bg.append(m);
  return bg;
}

function tauntModal(): HTMLElement {
  const sim = app.sim!;
  const offer = sim.tauntOffer!;
  const bg = el('<div class="modal-bg"></div>');
  const m = el(`
    <div class="modal">
      <h3>They are leaving — ${reasonText(offer.reason)}</h3>
      <p>Let them go and take the Renown, or spend a Ley Charge to goad them one
         floor deeper and try for the Souls. ${sim.charges} charge(s) left.</p>
      <div class="row">
        <button data-a="0">Let them go</button>
        <button class="danger" data-a="1">Taunt them deeper</button>
      </div>
    </div>`);
  m.querySelectorAll('button').forEach((b) => {
    (b as HTMLElement).onclick = () => {
      for (const e of sim.resolveTaunt((b as HTMLElement).dataset['a'] === '1')) pushLog(e);
      // ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
      syncTimer();
    };
  });
  bg.append(m);
  return bg;
}

/**
 * Thrill leads the Aftermath because it *is* the result now (§15.2): Renown is
 * a function of it, and Renown is the difficulty dial. Mana and Gold are the
 * consequences of the delve; Thrill is the delve.
 */
function aftermathModal(a: AftermathType): HTMLElement {
  const b = a.manaBreakdown;
  const r = a.result;
  const bg = el('<div class="modal-bg"></div>');
  const m = el('<div class="modal wide"></div>');
  m.append(el('<h3>Aftermath</h3>'));

  const survivors = r.escaped;
  m.append(thrillCard(r.thrill, {
    caption: survivors
      ? `mean across ${survivors} survivor${survivors === 1 ? '' : 's'}`
      : 'no survivors — dead men tell no tales',
  }));

  if (r.retired.length) m.append(retirementBlock(r.retired));

  // Renown is stated as a derivation, not a number out of nowhere.
  const renownFrom = survivors
    ? `${survivors} survivor${survivors === 1 ? '' : 's'} × Thrill ÷ ${Math.round(1 / TUNING.renownPerThrill)}`
    : 'no survivors carried the story home';
  const trickle = app.season.legends.length * TUNING.legendRenownTrickle;

  m.append(el(`
    <table>
      <tr class="tot"><td>Renown — ${renownFrom}</td><td class="pos">+${r.renown}</td></tr>
      ${r.retired.length ? `<tr><td class="dimmed">…including ${r.retired.length} retirement bonus${r.retired.length === 1 ? '' : 'es'}</td><td class="dimmed">+${r.retired.length * TUNING.retireRenownBonus}</td></tr>` : ''}
      ${trickle ? `<tr><td class="dimmed">…and ${app.season.legends.length} Legend${app.season.legends.length === 1 ? '' : 's'} on the wall</td><td class="dimmed">+${trickle}</td></tr>` : ''}
      <tr><td>Base</td><td class="pos">+${b.base}</td></tr>
      <tr><td>Floors (${app.season.dungeon.floors.length})</td><td class="pos">+${b.floors}</td></tr>
      <tr><td>Kills (${r.killed})</td><td class="pos">+${b.kills}</td></tr>
      <tr><td>Tier bonus</td><td class="pos">+${b.tierBonus}</td></tr>
      <tr><td>Upkeep</td><td class="neg">−${b.upkeep}</td></tr>
      <tr class="tot"><td>Mana</td><td class="${a.manaIncome >= 0 ? 'pos' : 'neg'}">${a.manaIncome >= 0 ? '+' : ''}${a.manaIncome}</td></tr>
      <tr><td>Gold — sales</td><td>+${r.goldFromSales}</td></tr>
      <tr><td>Gold — corpses (25%)</td><td>+${r.goldFromCorpses}</td></tr>
      <tr><td>Souls</td><td>+${r.souls}</td></tr>
      ${a.tierAfter > a.tierBefore ? `<tr class="tot"><td colspan="2" class="neg">Threat Tier rises to ${a.tierAfter}</td></tr>` : ''}
      ${r.mobsLost.length ? `<tr><td colspan="2" class="neg">Slain: ${r.mobsLost.map((x) => `${MOBS[x.defId]!.name} lv${x.level}`).join(', ')}</td></tr>` : ''}
    </table>`));

  const row = el('<div class="row" style="margin-top:14px"><button class="primary">Continue →</button></div>');
  row.querySelector('button')!.onclick = nextRaid;
  m.append(row);
  bg.append(m);
  return bg;
}

/** Retirement is a celebration, not a line item (§15.5). */
function retirementBlock(retired: Legend[]): HTMLElement {
  const box = el('<div class="retirement"></div>');
  box.append(el(`<div class="rt-head">★ ${retired.length === 1 ? 'A Legend is made' : `${retired.length} Legends are made`}</div>`));
  for (const l of retired) {
    box.append(el(`<div class="rt-line"><b>${esc(l.name)}</b> hangs it up at Thrill ${Math.round(l.thrill)} — and never comes back.</div>`));
  }
  box.append(el(`<div class="rt-foot">+${TUNING.retireRenownBonus} Renown each, then +${TUNING.legendRenownTrickle} every raid from here on.</div>`));
  return box;
}

function gameOverModal(): HTMLElement {
  const s = app.season;
  const won = s.ending === 'survived';
  const bg = el('<div class="modal-bg"></div>');
  const m = el(`
    <div class="modal">
      <h3>${won ? 'The season ends. The dungeon holds.' : 'The Core has fallen.'}</h3>
      <p>${s.log.length} raids · renown ${s.renown} · gold ${s.gold} · souls ${s.souls}<br>
         Killed ${s.log.reduce((a, r) => a + r.killed, 0)} · let ${s.log.reduce((a, r) => a + r.escaped, 0)} walk away.<br>
         Best Thrill ${Math.round(s.log.reduce((a, r) => Math.max(a, r.thrill.total), 0))}
         · ${s.legends.length} Legend${s.legends.length === 1 ? '' : 's'} on the wall.</p>
      <div class="row"><button class="primary">New Season</button></div>
    </div>`);
  m.querySelector('button')!.onclick = restart;
  bg.append(m);
  return bg;
}

// ─── Hot module replacement ──────────────────────────────────────────────────

/**
 * Keep the run alive across edits.
 *
 * Without this, every save is a full page reload: the season, the dungeon you
 * spent ten minutes building, and the log all vanish — which makes tuning by
 * feel impractical. Two things have to happen.
 *
 * 1. `dispose` MUST stop the playback timer. Module-level `setInterval` is not
 *    torn down by HMR, so without this each edit during a raid leaves another
 *    interval running against a dead module — the raid appears to accelerate.
 *
 * 2. The season is plain data (see §13.2 — the sim is engine-free), so it
 *    survives a module swap intact. `RaidSim` is a class *instance*, though, and
 *    after a sim edit the stashed one still closes over the OLD code. Carrying
 *    it would mean watching a raid resolve under rules that no longer exist, so
 *    an in-flight raid is dropped back to the Build Phase instead. The dungeon
 *    is the expensive thing to rebuild; a raid is one click.
 */
interface HotSnapshot {
  season: SeasonState;
  speedIdx: number;
  log: LogLine[];
  wasMidRaid: boolean;
}

// `import.meta.hot` is also truthy under Vitest, where `.data` is undefined —
// hence the optional chaining. It doubles as a guard against a snapshot leaking
// between tests that re-import this module.
if (import.meta.hot) {
  const saved = import.meta.hot.data?.['snapshot'] as HotSnapshot | undefined;
  if (saved) {
    app.season = saved.season;
    app.speedIdx = saved.speedIdx;
    app.log = saved.log;
    app.phase = 'build';
    app.sim = null;
    app.aftermath = null;
    if (saved.wasMidRaid) {
      app.error = 'Reloaded mid-raid — the raid was reset, your dungeon is intact.';
    }
  }

  import.meta.hot.dispose((data) => {
    stopTimer();
    if (!data) return;
    const snapshot: HotSnapshot = {
      season: app.season,
      speedIdx: app.speedIdx,
      log: app.log,
      wasMidRaid: app.phase === 'raid',
    };
    data['snapshot'] = snapshot;
  });

  import.meta.hot.accept();
}

render();
