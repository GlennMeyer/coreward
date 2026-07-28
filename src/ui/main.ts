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
  AMENITIES, FORMATION_INFO, GEAR, HIRED_STAFF_COST, MAX_GEAR_SLOTS,
  MAX_UPGRADE_RANK, MOBS, STARTING_HEARTS, upgradeName, type UpgradeTrack,
  INSURANCE_BASE, STAFFED_REVENUE_MULT,
  admissionPrice,
  PRICE_TIERS, TRAPS, TUNING, roomCapacity, trapCost,
  trapRearmCost,
} from '../sim/data';
import {
  allTraps, assignStaff, buildAmenity, buyMob, buyTrap, demolishAmenity,
  buyUpgrade, digCost, digFloor, dismissMob, dismissValue, equipGear, getMob,
  nextReforgeCost, reforgeGear, reforgeRank,
  getTrap, nextUpgradeCost, upgradeRank,
  hireStaff, isOpen, mobEffectiveHp, placeMobInRoom, placeTrapInRoom, rearmAll,
  rearmTrap, trapRearmPrice,
  rearmAllPrice, removeTrap, roomSlotsUsed, setPrice, totalUpkeep, trapsInRoom,
  trapSalvageValue,
} from '../sim/dungeon';
import { applyAftermath, createSeason, currentTier, startRaid } from '../sim/season';
import {
  CODEX, applyProfile, applyRun, nextCodexCost, rankOf, buyCodex,
  startingBonuses, type CodexId, type InsightBreakdown, type Profile,
} from '../sim/meta';
import {
  loadProfile, saveProfile, loadIdler, saveIdler, loadRun, saveRun, clearRun,
  clearProfile,
} from './storage';
import { Rng } from '../sim/rng';
import { buildPhaseFor } from './idlerBrain';
import {
  IDLE_YIELD, collectIdle, describeGenome, startIdler, stopIdler,
  wipeIdlerProgress, type IdlerMode,
  type IdlerState,
} from './idler';
import { narrateRaid, type Narration } from '../sim/narrate';
import { forecast, predictThrill, thrillRating, type ThrillPrediction } from './predict';
import type { RaidSim } from '../sim/raid';
import type {
  Adventurer, Amenity, AmenityId, Legend, Mob, PriceTier, RaidEvent,
  SeasonState, ThrillScore, Trap,
} from '../sim/types';
import type { Aftermath as AftermathType } from '../sim/season';

// ─── App state ───────────────────────────────────────────────────────────────

type Phase = 'menu' | 'build' | 'raid' | 'aftermath' | 'over';

const SPEEDS = [
  { label: 'II', ms: 0 },
  { label: '1x', ms: 340 },
  { label: '2x', ms: 170 },
  { label: '4x', ms: 85 },
] as const;

interface LogLine { t: number; cls: string; text: string; }

interface App {
  /** Persistent meta-progression (§10). Survives the run and the tab. */
  profile: Profile;
  /** Insight earned by the run that just ended, for the summary screen. */
  lastInsight: InsightBreakdown | null;
  /** Background genetic search (§32). */
  idler: IdlerState;
  /**
   * Watching the Understudy play (§32.3). It drives the real Build Phase and
   * the real raid loop — the point is to SEE a good build, not to be told
   * about one, and it is the only way to answer whether a raid is worth
   * watching at all.
   */
  spectating: boolean;
  /**
   * A delve is under way (even if it is still raid 1 with nothing built).
   *
   * Inferring this from the season does not work: on raid 1 a started run and
   * an untouched one look identical, so the menu could not tell whether to
   * offer Resume.
   */
  runStarted: boolean;
  /** Two-step confirm on the wipe button. */
  confirmWipe: boolean;
  /**
   * The Understudy is holding, because you touched something.
   *
   * At 4× the auto-advance chain leaves almost no window to click anything —
   * the raid ends, the summary dismisses, the Aftermath continues and the next
   * build starts inside a couple of seconds. Any interaction now stops the
   * clock until you say go, so changing speed mid-watch is actually possible.
   */
  spectatePaused: boolean;
  /** Endless: raid until the Core falls, rather than stopping at 8 (§12a). */
  endless: boolean;
  season: SeasonState;
  phase: Phase;
  sim: RaidSim | null;
  speedIdx: number;
  log: LogLine[];
  /**
   * The raw event stream for the raid in progress, kept alongside the prettied
   * log lines. The narrator (§13.2) reads events, not strings — the log throws
   * away exactly the structure it needs.
   */
  events: RaidEvent[];
  /** Last finished raid's log, kept so it can be re-read during the Build Phase. */
  lastLog: LogLine[];
  lastRaidNumber: number;
  showLastLog: boolean;
  selectedMob: number | null;
  /**
   * Selected trap uid. Deliberately a second field rather than a tagged
   * `selection`: monsters and traps go in the same rooms but obey different
   * rules — a trap cannot staff a shop, a monster cannot be re-armed — and one
   * field would mean every call site re-deriving which kind it is holding.
   */
  selectedTrap: number | null;
  aftermath: AftermathType | null;
  /** The account of the last raid, rendered above the ledger. */
  narration: Narration | null;
  error: string;
}

// Loaded before `app` exists: the first season needs the Codex applied, and
// `newSeason()` reads `app`, which is not initialised yet.
const bootProfile = loadProfile();
// A run in progress outranks a fresh one: refreshing mid-game should put you
// back where you were, not at a title screen with your dungeon gone.
const bootRun = loadRun();
const bootSeason = bootRun?.season
  ?? (() => {
    const fresh = createSeason(Math.floor(Date.now() % 100000), true);
    applyProfile(fresh, bootProfile);
    return fresh;
  })();

const app: App = {
  profile: bootProfile,
  lastInsight: null,
  idler: loadIdler(),
  spectating: false,
  runStarted: bootRun !== null,
  confirmWipe: false,
  spectatePaused: false,
  endless: bootRun?.endless ?? true,
  season: bootSeason,
  phase: bootRun ? 'build' : 'menu',
  sim: null,
  speedIdx: 1,
  log: [],
  events: [],
  lastLog: bootRun?.lastLog ?? [],
  lastRaidNumber: bootRun?.lastRaidNumber ?? 0,
  showLastLog: false,
  selectedMob: null,
  selectedTrap: null,
  aftermath: null,
  narration: null,
  error: '',
};

let timer: number | null = null;

/** How long the Aftermath waits before continuing on its own. */
const AUTO_CONTINUE_MS = 4000;
let autoTimer: number | null = null;

function clearAutoContinue(): void {
  if (autoTimer !== null) { clearTimeout(autoTimer); autoTimer = null; }
}

/**
 * Continue after a pause unless the player acts first.
 *
 * Cancelled by any interaction, so it never steals a click — the failure mode
 * to avoid is advancing while someone is still reading the narration.
 */
function scheduleAutoContinue(ms: number, fn: () => void): void {
  clearAutoContinue();
  autoTimer = setTimeout(() => { autoTimer = null; fn(); }, ms) as unknown as number;
}

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

/**
 * Report the outcome of a Build Phase action and repaint.
 *
 * Also the autosave hook: every purchase, placement and price change funnels
 * through here, so persisting on this path means a refresh keeps the dungeon
 * you just built rather than the one you had at the last raid.
 */
function fail(msg: string | null): boolean {
  app.error = msg ?? '';
  if (app.phase === 'build') persistRun();
  render();
  return msg === null;
}

function pushLog(e: RaidEvent): void {
  // Every drain path in this file funnels through here, so this is the one
  // place the whole stream is guaranteed to pass. The log is trimmed for the
  // scrollback; `events` is not, because the narrator needs the whole delve.
  app.events.push(e);
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
      return {
        cls: 'info',
        text: `${e.partySize} enter at Threat Tier ${e.tier} — `
          + `${FORMATION_INFO[e.formation].label.toLowerCase()}, `
          + `${FORMATION_INFO[e.formation].short}.`,
      };
    case 'floor-enter':
      return { cls: 'info', text: `— they descend to Floor ${e.floor + 1} —` };
    // The line (§7.2). Who is holding the door is the question the player is
    // actually asking while they watch, so it gets a line of its own.
    case 'line-engage':
      return {
        cls: 'info',
        text: `${advName(e.advId)} takes the front`
          + `${e.waiting > 0 ? `, ${e.waiting} waiting behind` : ''}.`,
      };
    case 'line-break':
      return {
        cls: 'good',
        text: e.next === null
          ? `${advName(e.advId)} breaks off at ${Math.round(e.hpPct * 100)}% — `
            + 'and nobody left is fit to take the door.'
          : `${advName(e.advId)} falls back at ${Math.round(e.hpPct * 100)}%. `
            + `${advName(e.next)} steps up.`,
      };
    case 'room-enter':
      return { cls: '', text: `Room ${e.room + 1} of Floor ${e.floor + 1}.` };
    case 'attack':
      return e.source === 'mob'
        ? { cls: 'hit', text: `${mobName(e.uid)} hits ${advName(e.targetId)} for ${e.dmg}.` }
        : { cls: '', text: `${advName(e.advId)} hits ${mobName(e.targetUid)} for ${e.dmg}.` };
    case 'kit-strip':
      return { cls: 'good', text: `${mobName(e.uid)} destroys supplies. Kit ${e.kitLeft}.` };
    case 'trap-fire':
      return {
        cls: e.sprung ? 'crit' : 'buy2',
        text: e.sprung
          ? `SPRUNG — the ${TRAPS[e.defId]!.name} goes off early.`
          : `The ${TRAPS[e.defId]!.name} triggers.`,
      };
    case 'trap-hit':
      return { cls: 'hit', text: `${TRAPS[e.defId]!.name} catches ${advName(e.advId)} for ${e.dmg}.` };
    case 'trap-kit':
      return { cls: 'good', text: `${TRAPS[e.defId]!.name} ruins ${e.amount} Kit. Kit ${e.kitLeft}.` };
    case 'trap-snare':
      return { cls: 'good', text: `They are held fast for ${e.ticks} ticks.` };
    case 'resolve-hit':
      return { cls: 'good', text: `${advName(e.advId)} falters. Resolve ${e.resolveLeft}.` };
    case 'kit-heal':
      return { cls: '', text: `${advName(e.advId)} drinks a potion (+${e.amount}). Kit ${e.kitLeft}.` };
    case 'mob-downed':
      return { cls: 'crit', text: `${MOBS[e.defId]!.name} is downed.` };
    case 'mob-slain':
      return { cls: 'crit', text: `${MOBS[e.defId]!.name} (lv ${e.level}) is slain for good.` };
    case 'admission':
      return e.turnedAway > 0
        ? { cls: 'buy2', text: `${e.total}g at the gate — ${e.turnedAway} turned away, unable to pay ${e.each}g.` }
        : { cls: 'buy2', text: `${e.total}g taken at the gate (${e.each}g a head).` };
    case 'insurance-sold':
      return { cls: 'buy2', text: `${e.buyers} bought death cover at ${e.each}g — ${e.total}g in premiums.` };
    case 'insurance-claim':
      return { cls: 'buy2', text: `${e.name} dies, and the policy pays. They get up again.` };
    case 'adv-downed':
      return { cls: 'good', text: `${e.name} goes down, bleeding.` };
    case 'death-save':
      return {
        cls: e.success ? '' : 'crit',
        text: `${e.name} ${e.success ? 'holds on' : 'fades'} — ${e.successes} steady, ${e.failures} failing.`,
      };
    case 'adv-stable':
      return { cls: '', text: `${e.name} is stabilised. Out of the fight, but alive.` };
    case 'adv-rescued':
      return { cls: 'buy2', text: `${e.name} is dragged out alive — ${e.fee}g for the service.` };
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
      return {
        cls: 'crit',
        text: `THE CORE IS BREACHED. They carry off ${Math.round(e.lootPct * 100)}% of the treasury. `
          + `Hearts left: ${e.heartsLeft}.`,
      };
    case 'raid-end':
      return { cls: 'info', text: `Raid over: ${e.outcome}.` };
  }
}

function reasonText(r: string): string {
  return { hp: 'too wounded', kit: 'out of supplies', resolve: 'nerve broken', wiped: 'all dead', casualties: 'carrying wounded' }[r] ?? r;
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
  render();
}

// ─── Phase transitions ───────────────────────────────────────────────────────

function beginRaid(): void {
  app.sim = startRaid(app.season);
  app.phase = 'raid';
  if (app.log.length) {
    app.lastLog = app.log;
    app.lastRaidNumber = app.season.raidNumber - 1;
  }
  app.log = [];
  app.events = [];
  app.narration = null;
  app.selectedMob = null;
  app.selectedTrap = null;
  app.error = '';
  for (const e of app.sim.step()) pushLog(e);
  render();
  syncTimer();
}

function finishRaid(): void {
  clearAutoContinue();
  const sim = app.sim;
  if (!sim || sim.status !== 'complete') return;
  stopTimer();
  const raidNumber = app.season.raidNumber;
  // Read BEFORE the Aftermath appends this raid to the log: "have we ever seen
  // this formation before?" must not count the raid we are about to describe.
  const formationDebut = !app.season.log.some((r) => r.formation === sim.formation);
  app.aftermath = applyAftermath(app.season, sim);
  // Narrated *after* the Aftermath so retirements, Legends and the veterans'
  // delve counts are already folded in — "her fifth descent" needs the count
  // that includes the descent we are describing.
  app.narration = narrateRaid({
    events: app.events,
    result: app.aftermath.result,
    party: sim.party,
    dungeon: app.season.dungeon,
    veterans: app.season.veterans,
    raidNumber,
    formationDebut,
  });
  if (app.season.over && !app.lastInsight) {
    // Souls, Legends and Renown had no sink; they are a run's residue, and
    // residue is what a meta-currency should be made of (§10).
    app.lastInsight = applyRun(app.profile, app.season, currentTier(app.season).tier);
    saveProfile(app.profile);
    clearRun();
    app.runStarted = false;
  }
  app.phase = app.season.over ? 'over' : 'aftermath';
  render();
}

function nextRaid(): void {
  clearAutoContinue();
  app.phase = 'build';
  app.sim = null;
  app.aftermath = null;
  app.narration = null;
  persistRun();
  render();
  // Spectating: the Understudy takes its next turn straight away, so the run
  // plays continuously instead of pausing for a click nobody is there to make.
  if (app.spectating && !app.spectatePaused) setTimeout(understudyTurn, 400);
}

/** A season with the Codex applied (§10). */
function newSeason(seed: number): SeasonState {
  const s = createSeason(seed, app.endless);
  applyProfile(s, app.profile);
  return s;
}

function restart(): void {
  stopTimer();
  clearAutoContinue();
  clearRun();
  app.lastInsight = null;
  Object.assign(app, {
    season: newSeason(Math.floor(Math.random() * 100000)),
    phase: 'build', runStarted: true, sim: null, speedIdx: 1, log: [], events: [],
    selectedMob: null, selectedTrap: null, aftermath: null, narration: null, error: '',
  });
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
  | { kind: 'buy'; defId: string }
  | { kind: 'trap'; uid: number }
  | { kind: 'buy-trap'; defId: string };

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

  // Traps only ever go in rooms — there is nothing to trap on a Landing, and
  // §11 Q9 keeps the shops neutral ground.
  if (payload.kind === 'buy-trap' || payload.kind === 'trap') {
    if (!target.classList.contains('room')) return void fail('Traps go in rooms.');
    const floor = Number(target.dataset['floor']);
    const room = Number(target.dataset['room']);
    if (payload.kind === 'trap') {
      const err = placeTrapInRoom(d, payload.uid, floor, room);
      if (!err) app.selectedTrap = null;
      return void fail(err);
    }
    const price = trapCost(payload.defId);
    if (app.season.mana < price) return void fail('Not enough mana.');
    const trap = buyTrap(d, payload.defId);
    if (typeof trap === 'string') return void fail(trap);
    const err = placeTrapInRoom(d, trap.uid, floor, room);
    if (err) {
      d.traps = allTraps(d).filter((t) => t.uid !== trap.uid); // undo the purchase
      return void fail(err);
    }
    app.season.mana -= price;
    app.selectedTrap = trap.uid;
    app.selectedMob = null;
    return void fail(null);
  }

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

/**
 * Title screen. Exists because the game now has state that outlives a run —
 * a Codex to spend in, a best-run record, and options — and none of that had
 * anywhere to live except a modal you could only reach by dying.
 */
function menuScreen(): HTMLElement {
  const p = app.profile;
  const wrap = el('<div class="menu"></div>');
  wrap.append(el(`<h1 class="title">Coreward</h1>`));
  wrap.append(el('<div class="tagline">You are the thing at the bottom of the stairs.</div>'));

  if (p.runs > 0) {
    wrap.append(el(`<div class="record">${p.runs} run${p.runs === 1 ? '' : 's'}
      · best ${p.bestRaids} raids, Tier ${p.bestTier}
      · <b>${p.insight}</b> Insight</div>`));
  }

  // Resume from memory first, storage second. A run stepped out of is right
  // there in `app.season`; requiring a successful save to offer the way back
  // would strand the player whenever storage is unavailable — private
  // browsing, a full quota, or a jsdom that supplies none.
  const inMemory = app.runStarted && !app.season.over;
  const saved = inMemory ? null : loadRun();
  const resumable = inMemory ? app.season : saved?.season ?? null;
  if (resumable && !resumable.over) {
    const resume = el(`<button class="primary big">Resume — raid ${resumable.raidNumber}</button>`);
    resume.onclick = () => {
      if (saved) { app.season = saved.season; app.endless = saved.endless; }
      app.phase = 'build';
      render();
    };
    wrap.append(resume);
  }

  const start = el(`<button class="${resumable ? '' : 'primary '}big">${resumable ? 'Abandon and Begin Anew' : 'Begin a Delve'}</button>`);
  start.onclick = () => { restart(); };
  wrap.append(start);

  const codex = el(`<button class="big" ${p.insight <= 0 && p.runs === 0 ? 'disabled' : ''}>The Codex${p.insight > 0 ? ` — ${p.insight} Insight` : ''}</button>`);
  codex.onclick = () => { app.phase = 'over'; render(); };
  wrap.append(codex);

  // The idler (§32). Advisor informs; auto-play also banks Insight, at a
  // reduced rate so leaving the tab open never beats playing.
  const banked = Math.floor(app.idler.pendingInsight);
  if (app.idler.mode !== 'off') {
    const b = app.idler.best;
    const panel = el(`<div class="idler-box"></div>`);
    panel.append(el(`<div class="idler-head">Understudy — generation ${app.idler.generation}</div>`));
    panel.append(el(b
      ? `<div class="idler-best">best: ${esc(describeGenome(b.genome))}<span class="sub">${Math.round(b.renown)} Renown over ${b.raids.toFixed(1)} raids</span></div>`
      : '<div class="idler-best sub">thinking…</div>'));
    if (app.idler.mode === 'autoplay') {
      const collect = el(`<button ${banked <= 0 ? 'disabled' : ''}>Collect ${banked} Insight</button>`);
      collect.onclick = () => {
        collectIdle(app.idler, app.profile);
        saveProfile(app.profile);
        saveIdler(app.idler);
        render();
      };
      panel.append(collect);
    }
    wrap.append(panel);
  }

  if (app.idler.best) {
    const watch = el('<button class="big">Watch the Understudy</button>');
    watch.onclick = startSpectating;
    wrap.append(watch);
  }

  const opts = el('<div class="row opts"></div>');
  const endlessBtn = el(`<button class="${app.endless ? 'on' : ''}">Endless: ${app.endless ? 'on' : 'off'}</button>`);
  endlessBtn.onclick = () => { app.endless = !app.endless; render(); };
  opts.append(endlessBtn);
  for (const m of ['off', 'advisor', 'autoplay'] as IdlerMode[]) {
    const on = app.idler.mode === m;
    const label = { off: 'Understudy: off', advisor: 'Advisor', autoplay: 'Auto-play' }[m];
    const b = el(`<button class="${on ? 'on' : ''}"
      title="${m === 'advisor' ? 'Evolves builds against your Codex and reports what it finds. Never plays for you.'
        : m === 'autoplay' ? `Also plays runs in the background, banking ${Math.round(IDLE_YIELD * 100)}% of what a delve would earn.`
        : 'No background search.'}">${label}</button>`);
    b.onclick = () => {
      app.idler.mode = m;
      saveIdler(app.idler);
      syncIdler();
      render();
    };
    opts.append(b);
  }
  wrap.append(opts);
  wrap.append(el('<div class="hint">Endless runs until the Core falls. Off gives a fixed 8-raid season.</div>'));

  // Wipe. Deliberately does NOT touch the Understudy's evolved population:
  // that is the tool's learning, not the player's progress, and throwing it
  // away would cost hours of search to punish a decision about a save file.
  const wipe = el(`<button class="wipe">${app.confirmWipe ? 'Really wipe? This cannot be undone' : 'Wipe save'}</button>`);
  wipe.onclick = () => {
    if (!app.confirmWipe) { app.confirmWipe = true; render(); return; }
    clearProfile();
    clearRun();
    // Banked Insight is progress, not learning — a wipe takes it. The evolved
    // population survives (see wipeIdlerProgress).
    wipeIdlerProgress(app.idler);
    saveIdler(app.idler);
    syncIdler();
    app.profile = loadProfile();
    app.season = createSeason(Math.floor(Math.random() * 100000), app.endless);
    applyProfile(app.season, app.profile);
    // Reset the whole view, not just the data. A wipe left `phase`, `sim` and
    // the spectator flags untouched, so wiping from anywhere other than a
    // clean menu could leave a stale RaidSim pointing at the dungeon that was
    // just thrown away — a raid rendering against one season while the topbar
    // reads another.
    stopTimer();
    clearAutoContinue();
    app.phase = 'menu';
    app.sim = null;
    app.aftermath = null;
    app.narration = null;
    app.events = [];
    app.log = [];
    app.spectating = false;
    app.spectatePaused = false;
    app.runStarted = false;
    app.lastInsight = null;
    app.lastLog = [];
    app.lastRaidNumber = 0;
    app.confirmWipe = false;
    render();
  };
  const wipeRow = el('<div class="wipe-row"></div>');
  wipeRow.append(wipe);
  wrap.append(wipeRow);
  if (app.idler.generation > 0) {
    wrap.append(el(`<div class="hint dim-t">The Understudy keeps what it has learned (generation ${app.idler.generation}).</div>`));
  }

  return wrap;
}

/**
 * Let the Understudy take a turn: it builds, then it delves.
 *
 * Deliberately the same `buildPhaseFor` the CLI search uses, so what you watch
 * is the build the evolver actually scored — not a demo approximation of it.
 */
function understudyTurn(): void {
  if (!app.spectating || app.spectatePaused || app.phase !== 'build') return;
  const genome = app.idler.best?.genome;
  if (!genome) return;
  buildPhaseFor(app.season, genome, spectateRng);
  beginRaid();
}

/** Seeded so a spectated run is reproducible like everything else (§13.2). */
const spectateRng = new Rng(0x5EEC7);

function startSpectating(): void {
  if (!app.idler.best) return;
  app.spectating = true;
  restart();
  understudyTurn();
}

/**
 * Hold the run when you reach into the dungeon — not merely when you click.
 *
 * The first cut paused on *any* interaction, which meant it could not idle at
 * all: watching it play and adjusting the view are different things from taking
 * the wheel. Changing speed, reading a panel or working the spectate bar all
 * leave it running.
 *
 * What does hold is intervening in the game itself — placing, buying, pricing,
 * re-arming. Those are the player's moves, and the Understudy should not carry
 * on making its own on top of them.
 *
 * The guarantee this is really protecting is narrower than "clicks pause it":
 * the spectate bar is always on screen with Hold and Take over, so control is
 * one click away at any speed, always.
 */
function holdOnInteraction(ev: Event): void {
  if (!app.spectating || app.spectatePaused) return;
  const t = ev.target as HTMLElement | null;
  if (!t) return;
  // Its own controls, the speed buttons and anything in a modal are "watching",
  // not "intervening".
  if (t.closest('.spectate-bar') || t.closest('.modal') || t.closest('.log')) return;
  const intervening = t.closest('.room, .amenity, .buy, .landing, .mob, .trap')
    || (t.closest('button') && app.phase === 'build');
  if (!intervening) return;
  app.spectatePaused = true;
  clearAutoContinue();
  render();
}

/** Pick the run back up from wherever it was left. */
function resumeSpectating(): void {
  if (!app.spectating || app.spectatePaused) return;
  if (app.phase === 'build') setTimeout(understudyTurn, 300);
  else if (app.phase === 'aftermath') scheduleAutoContinue(1200, nextRaid);
  else if (app.sim?.status === 'complete') scheduleAutoContinue(800, finishRaid);
  else syncTimer();
}

function stopSpectating(): void {
  app.spectating = false;
  app.spectatePaused = false;
  clearAutoContinue();
  render();
}

/** (Re)start the background search to match the current mode. */
function syncIdler(): void {
  startIdler(app.idler, app.profile, () => {
    saveIdler(app.idler);
    if (app.phase === 'menu') render();
  });
}

/**
 * Autosave the run. Called on entering the Build Phase, which is the only
 * moment the whole thing is plain serialisable data (see `saveRun`).
 */
function persistRun(): void {
  if (app.season.over) { clearRun(); return; }
  saveRun({
    season: app.season,
    endless: app.endless,
    lastLog: app.lastLog,
    lastRaidNumber: app.lastRaidNumber,
  });
}

function render(): void {
  // Read-only debug handle onto the live season, refreshed each frame so it
  // survives a restart. The sim is the source of truth (§13.2); nothing in the
  // app ever reads this back.
  (globalThis as unknown as { __coreward: SeasonState }).__coreward = app.season;
  root.innerHTML = '';
  if (app.phase === 'menu') {
    root.append(menuScreen());
    return;
  }
  root.append(topbar());
  if (app.spectating) {
    const bar = el(`<div class="spectate-bar ${app.spectatePaused ? 'held' : ''}">
      <span>${app.spectatePaused
        ? 'Held — the Understudy is waiting on you'
        : `Watching the Understudy — generation ${app.idler.generation}`}</span>
      <span class="row">
        <button class="resume">${app.spectatePaused ? 'Resume' : 'Hold'}</button>
        <button>Take over</button>
      </span></div>`);
    (bar.querySelector('.resume') as HTMLElement).onclick = (ev) => {
      ev.stopPropagation();
      app.spectatePaused = !app.spectatePaused;
      if (!app.spectatePaused) resumeSpectating(); else clearAutoContinue();
      render();
    };
    (bar.querySelectorAll('button')[1] as HTMLElement).onclick = stopSpectating;
    root.append(bar);
  }

  const cols = el('<div class="cols"></div>');
  const info = el('<div class="col-info"></div>');
  const left = el('<div class="col-left"></div>');
  const right = el('<div class="col-right"></div>');

  // Next Raid and Predicted Thrill sit left of the map: they are what you read
  // while looking at the floor plan, so they belong next to it rather than
  // across the page in the build column.
  info.append(forecastPanel());
  info.append(predictionPanel());
  left.append(dungeonPanel());
  right.append(app.phase === 'raid' ? raidPanel() : buildPanel());
  const sel = selectionPanel();
  if (sel) left.append(sel);
  cols.append(info, left, right);
  root.append(cols);

  if (app.phase === 'aftermath' && app.aftermath) root.append(aftermathModal(app.aftermath));
  if (app.phase === 'over') root.append(gameOverModal());
  if (app.sim?.status === 'awaiting-taunt') root.append(tauntModal());
  if (app.sim?.status === 'complete' && app.phase === 'raid') root.append(raidDoneBar());
}

/** Step out to the title screen. The run is saved, not abandoned (§33.1). */
function toMenu(): void {
  stopTimer();
  clearAutoContinue();
  persistRun();
  app.spectating = false;
  app.spectatePaused = false;
  app.phase = 'menu';
  render();
}

function topbar(): HTMLElement {
  const s = app.season;
  const tier = currentTier(s);
  const trickle = s.legends.length * TUNING.legendRenownTrickle;
  const bar = el(`
    <div class="topbar">
      <button class="menu-btn" title="Back to the title screen. Your run is saved.">☰</button>
      <h1>Coreward</h1>
      <span class="stat incoming" title="Adventurers expected next raid, at levels ${tier.levelMin}–${tier.levelMax}">
        <span class="lbl">incoming</span><b>${tier.partySize}</b>
        <span class="lvl">lv ${tier.levelMin}–${tier.levelMax}</span>
      </span>
      <span class="stat"><span class="lbl">raid</span><b>${s.raidNumber}${Number.isFinite(s.totalRaids) ? `/${s.totalRaids}` : ''}</b></span>
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
  (bar.querySelector('.menu-btn') as HTMLElement).onclick = toMenu;
  return bar;
}

const UPGRADE_BLURB: Record<string, string> = {
  bite: 'More damage per swing.',
  hide: 'Soaks a flat amount off every hit — best on whatever holds the front.',
  vigor: 'More hit points; it stays standing longer.',
};

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
      const canDrop = app.phase === 'build'
        && (app.selectedMob !== null || app.selectedTrap !== null);
      const room = el(
        `<div class="room ${isActive ? 'active' : ''} ${canDrop ? 'droppable' : ''}"
              data-floor="${fi}" data-room="${ri}"></div>`,
      );

      for (const uid of d.floors[fi]!.rooms[ri]!.mobUids) {
        const mob = getMob(d, uid);
        if (!mob || !mob.alive) continue;
        room.append(mobChip(mob));
      }
      for (const trap of trapsInRoom(d, fi, ri)) room.append(trapChip(trap));

      // The delvers themselves, standing in the room they are actually in.
      // Under single-file that is exactly one person with the rest queued at
      // the door (§18.2) — putting them on the map is the only way the player
      // can SEE the rule working rather than infer it from a list.
      if (isActive && sim) room.append(stageStrip(sim));
      // Traps draw on the same capacity as monsters (§16.3), so the readout
      // has to show the real ceiling rather than the doc's flat 3.
      room.append(el(
        `<div class="slots">${roomSlotsUsed(d, fi, ri)}/${roomCapacity(fi)}</div>`,
      ));

      room.onclick = (ev) => {
        ev.stopPropagation();
        if (app.phase !== 'build') return;
        if (app.selectedTrap !== null) {
          const err = placeTrapInRoom(d, app.selectedTrap, fi, ri);
          if (!err) app.selectedTrap = null;
          return fail(err);
        }
        if (app.selectedMob === null) return;
        const err = placeMobInRoom(d, app.selectedMob, fi, ri);
        if (!err) app.selectedMob = null;
        return fail(err);
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

/**
 * A trap in a room. Charges are drawn as pips rather than a number so a glance
 * across the dungeon answers the only question that matters in the Build
 * Phase: what is still armed?
 *
 * Clicking it in a raid is the **Spring** intervention (§7.4) — the same
 * gesture as clicking a monster to Retreat it, because both are "spend a Ley
 * Charge on this thing, now".
 */
function trapChip(trap: Trap): HTMLElement {
  const def = TRAPS[trap.defId]!;
  const max = def.charges;
  const pips = '●'.repeat(trap.charges) + '○'.repeat(Math.max(0, max - trap.charges));
  const spent = trap.charges === 0;
  const sel = app.selectedTrap === trap.uid ? 'selected' : '';
  const chip = el(`
    <div class="trap ${spent ? 'spent' : ''} ${sel}" title="${esc(def.blurb)}">
      ${esc(def.name)} <span class="ch">${pips}</span>
    </div>`);

  attachDrag(chip, { kind: 'trap', uid: trap.uid }, def.name);

  chip.onclick = (ev) => {
    ev.stopPropagation();
    if (app.phase === 'build') {
      app.selectedTrap = app.selectedTrap === trap.uid ? null : trap.uid;
      app.selectedMob = null;
      fail(null);
    } else if (app.phase === 'raid' && app.sim) {
      const ok = app.sim.applySpringIntervention(trap.uid);
      fail(ok ? null : 'Spring needs a Ley Charge and a trap with a charge left.');
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
    // Build buttons are rendered ONCE per landing, below — not once per empty
    // slot. A landing has two slots, so per-slot rendering drew the whole
    // amenity menu twice and read as a duplication bug.
    if (!a) return;
    void slot;

    const def = AMENITIES[a.defId];
    const p = PRICE_TIERS[a.price];
    const attended = a.hired || a.staffUid !== null;
    const staff = a.hired
      ? 'hirelings'
      : a.staffUid !== null ? mobName(a.staffUid) : 'unattended';
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
      if (!attended) {
        row.append(el(
          `<span class="staff-hint">open — staff it for +${Math.round((STAFFED_REVENUE_MULT - 1) * 100)}% takings</span>`,
        ));
      }
      if (!a.hired) {
        const hire = el(`<button ${app.season.gold < HIRED_STAFF_COST ? 'disabled' : ''}
          title="Optional. A monster staffs it for free; hirelings do the same without costing you a fighter.">Hire ${HIRED_STAFF_COST}g</button>`);
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

  // One menu per landing, targeting the first free slot.
  const free = amenities.findIndex((a) => a === null);
  if (app.phase === 'build' && free !== -1) {
    const spare = amenities.filter((a) => a === null).length;
    row.append(el(`<span class="slot-free">${spare} slot${spare === 1 ? '' : 's'} free</span>`));
    for (const id of Object.keys(AMENITIES) as AmenityId[]) {
      const def = AMENITIES[id];
      const b = el(`<button ${app.season.gold < def.buildCost ? 'disabled' : ''}
        title="${esc(def.blurb)}">+ ${def.name} ${def.buildCost}g</button>`);
      b.onclick = () => {
        const target = amenities.findIndex((x) => x === null);
        if (target === -1) return fail('No free slot on this landing.');
        const err = buildAmenity(d, idx, target, id);
        // Gold, not Mana (§8.4c): Mana digs and buys monsters, Gold runs the
        // business. Paying the dungeon's build currency for a shop was taking
        // defence off the board to sell potions.
        if (!err) app.season.gold -= def.buildCost;
        return fail(err);
      };
      row.append(b);
    }
  }
  return row;
}

// ─── Build panel ─────────────────────────────────────────────────────────────

function buildPanel(): HTMLElement {
  const s = app.season;
  const d = s.dungeon;
  const wrap = el('<div></div>');

  const actions = el('<div class="panel"></div>');
  const tier = currentTier(s);
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

  // Re-arming (§5.2) — the trap economy's entire recurring bill, and the one
  // thing that must never be automatic. A monster charges rent whether it
  // fought or not; a trap charges only for the charges it spent, and a player
  // who cannot afford the reset this raid fights without it and keeps the trap.
  const rearmPrice = rearmAllPrice(d);
  if (rearmPrice > 0) {
    const btn = el(
      `<button class="${s.gold >= rearmPrice ? 'primary' : ''}" ${s.gold < rearmPrice ? 'disabled' : ''}>Re-arm traps — ${rearmPrice}g</button>`,
    );
    btn.onclick = () => {
      s.gold -= rearmAll(d, s.gold);
      fail(null);
    };
    rowA.append(btn);
  }
  actions.append(rowA);
  // Admission (§20). The one dial that pushes BACK on the Renown ratchet:
  // gouging is safe, rich and obscure; a cheap gate is famous and dangerous.
  const adm = el('<div class="row adm"></div>');
  adm.append(el('<span class="adm-l">Admission</span>'));
  for (const t of ['modest', 'standard', 'premium', 'gouge'] as PriceTier[]) {
    const price = admissionPrice(tier.tier, PRICE_TIERS[t].mult);
    const on = d.admission === t;
    const b = el(`<button class="${on ? 'on' : ''}" title="${price}g a head · Renown ×${PRICE_TIERS[t].renownMult}">${t} ${price}g</button>`);
    b.onclick = () => { d.admission = t; fail(null); };
    adm.append(b);
  }
  actions.append(adm);
  // Death cover (§21). Premiums land every raid from everyone; claims are rare.
  const ins = el('<div class="row adm"></div>');
  ins.append(el('<span class="adm-l">Death cover</span>'));
  for (const t of ['off', 'modest', 'standard', 'premium', 'gouge'] as (PriceTier | 'off')[]) {
    const on = (d.insurance ?? 'off') === t;
    const label = t === 'off'
      ? 'off'
      : `${t} ${Math.round(INSURANCE_BASE * tier.tier * PRICE_TIERS[t].mult)}g`;
    const title = t === 'off'
      ? 'Sell no policies.'
      : `${Math.round(INSURANCE_BASE * tier.tier * PRICE_TIERS[t].mult)}g a head · Renown ×${PRICE_TIERS[t].renownMult} · a claim resurrects them`;
    const b = el(`<button class="${on ? 'on' : ''}" title="${title}">${label}</button>`);
    b.onclick = () => { d.insurance = t; fail(null); };
    ins.append(b);
  }
  actions.append(ins);

  actions.append(el(`<div class="hint">Gate money is money they cannot spend on surviving — and a fleecing is remembered (Renown ×${PRICE_TIERS[d.admission ?? 'modest'].renownMult}).</div>`));

  actions.append(el(`<div class="hint">Drag monsters into rooms, or onto a shop to staff it. Clicking works too: select, then click a target.</div>`));
  if (rearmPrice > 0) {
    actions.append(el(
      `<div class="hint warn-t">Spent traps do nothing, and a room holding only a spent trap counts as empty for Tedium.</div>`,
    ));
  }
  wrap.append(actions);

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

  // Trap shop (§5.2). The pitch on every line is the same one: cheap, and it
  // never sends you a bill for standing still.
  const traps = el('<div class="panel"></div>');
  traps.append(el('<h2>Traps &nbsp;·&nbsp; no upkeep</h2>'));
  for (const def of Object.values(TRAPS)) {
    const price = trapCost(def.id);
    const off = s.mana < price;
    const b = el(`<div class="buy trap-buy ${off ? 'off' : ''}">
        <span>${def.name}<div class="meta">${def.job} ${def.power} · ${def.slots} slot${def.slots > 1 ? 's' : ''} · ${def.charges} charge${def.charges > 1 ? 's' : ''} · re-arm ${trapRearmCost(def.id)}</div></span>
        <span class="cost">${price}</span>
      </div>`);
    if (!off) {
      attachDrag(b, { kind: 'buy-trap', defId: def.id }, def.name);
      b.onclick = () => {
        const trap = buyTrap(d, def.id);
        if (typeof trap === 'string') return fail(trap);
        s.mana -= price;
        app.selectedTrap = trap.uid;
        app.selectedMob = null;
        return fail(null);
      };
    }
    traps.append(b);
  }
  traps.append(el(
    '<div class="hint">A trap fires once on the threshold, before anything swings — then it needs re-arming. It softens; the monster behind it finishes.</div>',
  ));
  wrap.append(traps);

  // Roster sits BELOW the shops. Buying anything makes something unassigned,
  // so putting this above the menus meant every purchase shoved the next one
  // down the page.
  const idle = d.mobs.filter((m) => m.alive && m.placement.kind === 'unassigned');
  const idleTraps = allTraps(d).filter((t) => t.placement.kind === 'unassigned');
  if (idle.length || idleTraps.length) {
    const rp = el('<div class="panel"></div>');
    rp.append(el(`<h2>Unassigned (${idle.length + idleTraps.length}) — no upkeep, no defence</h2>`));
    for (const m of idle) rp.append(mobChip(m));
    for (const t of idleTraps) rp.append(trapChip(t));
    wrap.append(rp);
  }

  const replay = lastLogPanel();
  if (replay) wrap.append(replay);
  wrap.append(legendsPanel());
  return wrap;
}

/**
 * Detail for the selected monster, rendered as a docked panel rather than
 * inline: inline it sat above the shop and shoved the whole menu down the page
 * every time you clicked a monster, which made buying two things in a row a
 * game of chase-the-button.
 */
function selectionPanel(): HTMLElement | null {
  if (app.phase !== 'build') return null;
  const d = app.season.dungeon;
  const s = app.season;

  // Traps dock in the same place monsters do — the inline version had exactly
  // the problem the monster card had, and one place to look is better than two.
  if (app.selectedTrap !== null) {
    const trap = getTrap(d, app.selectedTrap);
    if (!trap) return null;
    const tdef = TRAPS[trap.defId]!;
    const tp = el('<div class="panel dock"></div>');
    const th = el(`<h2>${esc(tdef.name)} — ${trap.charges}/${tdef.charges} armed
      <span class="chev close">×</span></h2>`);
    th.querySelector('.close')!.addEventListener('click', () => {
      app.selectedTrap = null;
      render();
    });
    tp.append(th);
    tp.append(el(`<div class="hint">${esc(tdef.blurb)}</div>`));
    tp.append(el(
      `<div class="hint">${trapRearmCost(trap.defId)}g per charge to re-arm. No upkeep, ever — and it cannot be killed.</div>`,
    ));

    // Per-trap re-arming. Re-arm-all is a convenience, not the only option:
    // when Gold is short the whole decision is WHICH traps to reset — the ones
    // on the floor they will actually reach — and a single button took that
    // choice away.
    const price = trapRearmPrice(d, trap.uid);
    if (price > 0) {
      const arm = el(`<button class="${s.gold >= price ? 'primary' : ''}"
        ${s.gold < price ? 'disabled' : ''}>Re-arm this one — ${price}g</button>`);
      arm.onclick = () => {
        const paid = rearmTrap(d, trap.uid, s.gold);
        if (typeof paid === 'string') return fail(paid);
        s.gold -= paid;
        return fail(null);
      };
      const armRow = el('<div class="row"></div>');
      armRow.append(arm);
      tp.append(armRow);
    } else {
      tp.append(el('<div class="hint good-t">Fully armed.</div>'));
    }
    const refund = trapSalvageValue(trap.defId);
    const rip = el(`<button class="danger sell">Rip out — refund ${refund}g</button>`);
    rip.onclick = () => {
      const res = removeTrap(d, trap.uid);
      if (typeof res === 'string') return fail(res);
      s.gold += res;
      app.selectedTrap = null;
      return fail(null);
    };
    tp.append(rip);
    return tp;
  }

  if (app.selectedMob === null) return null;
  const mob = getMob(d, app.selectedMob);
  if (!mob) return null;

  const def = MOBS[mob.defId]!;
  const p = el('<div class="panel dock"></div>');
  const head = el(`<h2>${esc(def.name)} — lv ${mob.level} · ${mob.xp} xp
    <span class="chev close">×</span></h2>`);
  head.querySelector('.close')!.addEventListener('click', () => {
    app.selectedMob = null;
    render();
  });
  p.append(head);

  // Named upgrade tracks (§6.6). Same maths as a level, but you are choosing
  // what this creature becomes rather than watching a number go up.
  for (const track of ['bite', 'hide', 'vigor'] as UpgradeTrack[]) {
    const rank = upgradeRank(mob, track);
    const cost = nextUpgradeCost(mob, track);
    const maxed = cost === null;
    const off = maxed || s.mana < cost!;
    const pips = '●'.repeat(rank) + '○'.repeat(MAX_UPGRADE_RANK - rank);
    const b = el(`<div class="buy up ${off ? 'off' : ''}"
        title="${UPGRADE_BLURB[track]}">
        <span>${esc(upgradeName(mob.defId, track))}<div class="meta">${pips}</div></span>
        <span class="cost">${maxed ? 'max' : `${cost} mana`}</span>
      </div>`);
    if (!off) {
      b.onclick = () => {
        const err = buyUpgrade(d, mob.uid, track);
        if (!err) s.mana -= cost!;
        fail(err);
      };
    }
    p.append(b);
  }
  p.append(el('<div class="hint">Mana raises the monster; Gold equips it.</div>'));

  for (const g of Object.values(GEAR)) {
    const owned = mob.gear.includes(g.id);
    const full = mob.gear.length >= MAX_GEAR_SLOTS;
    const off = owned || full || s.gold < g.cost;
    if (owned) {
      // Reforging: the one Gold sink that scales with a long run (§6.5).
      const rank = reforgeRank(mob, g.id);
      const cost = nextReforgeCost(mob, g.id);
      const cant = s.gold < cost;
      const b = el(`<div class="buy ${cant ? 'off' : ''}"
          title="Amplifies this piece again. Costs rise each time.">
          <span>${g.name} ✓<div class="meta">reforged ×${rank}</div></span>
          <span class="cost g">${cost}g</span>
        </div>`);
      if (!cant) {
        b.onclick = () => {
          const err = reforgeGear(d, mob.uid, g.id);
          if (!err) s.gold -= cost;
          fail(err);
        };
      }
      p.append(b);
      continue;
    }
    const b = el(`<div class="buy ${off ? 'off' : ''}">
        <span>${g.name}</span>
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

  const refund = dismissValue(mob);
  const sell = el(`<button class="danger sell">Dismiss — refund ${refund} mana</button>`);
  sell.onclick = () => {
    const res = dismissMob(d, mob.uid);
    if (typeof res === 'string') return fail(res);
    s.mana += res.mana;
    app.selectedMob = null;
    return fail(null);
  };
  p.append(sell);
  if (mob.level > 1) {
    p.append(el(`<div class="hint warn-t">Dismissing loses ${mob.level - 1} level${mob.level === 2 ? '' : 's'} — the refund is on base cost only.</div>`));
  }
  return p;
}

/**
 * "What is coming, and can we take it?" — a power-ratio readout, not a
 * prediction. See `forecast()` for why a single number cannot be a win chance.
 */
function forecastPanel(): HTMLElement {
  const s = app.season;
  const tier = currentTier(s);
  const f = forecast(s.dungeon, tier, s.renown);
  const p = el('<div class="panel"></div>');
  p.append(el(`<h2>Next Raid — Tier ${f.tier}</h2>`));

  const returning = s.veterans.filter((v) => !v.retired).length;
  p.append(el(`
    <div class="fc-party">
      <b>${f.partySize} adventurers</b>, level ${f.levelMin}–${f.levelMax}
      ${returning > 0 ? `<span class="fc-ret" title="Survivors who may come back (§15.5)">· ${returning} may return</span>` : ''}
    </div>`));

  // Formation (§7.2). This changes what "ready" means more than any other row
  // in the panel — the same four people either take turns at your door or come
  // through it together — so it sits above the power bar, not in the footnotes.
  const info = FORMATION_INFO[f.formation];
  p.append(el(`
    <div class="fc-form ${f.formation}">
      <span class="fc-form-tag">${info.label}</span>
      <span class="fc-form-eng">${f.engaged} of ${f.partySize} engaged at a time</span>
      <div class="sub">${esc(info.blurb)}</div>
    </div>`));

  // The escalation beat, telegraphed. A player who is surprised by the first
  // real party was never given the chance to prepare for it.
  if (f.nextFormation) {
    const n = f.nextFormation;
    const label = FORMATION_INFO[n.formation].label;
    p.append(el(`
      <div class="fc-form-next ${n.renownAway <= 0 ? 'imminent' : ''}">
        ${n.renownAway <= 0
          ? `<b>${label} from the next raid.</b> Tier ${n.tier} is here — `
            + 'they stop queueing and start coordinating.'
          : `<b>${n.renownAway} Renown</b> until Tier ${n.tier}, when delves become `
            + `<b>${label.toLowerCase()}</b> — all ${f.partySize} of them at once.`}
      </div>`));
  }

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
  if (f.formation === 'single-file') {
    p.append(el(`<div class="hint">Damage is what <em>one</em> of them puts out — they queue, so
      your rooms fight the front of the line and take ${f.partySize}× as long to fall (§7.2).</div>`));
  } else {
    p.append(el(`<div class="hint warn-t">All ${f.partySize} swing at once. Rooms that used to hold
      for a dozen ticks now fall in three.</div>`));
  }

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
    b.onclick = () => { app.speedIdx = i; render(); syncTimer(); };
    row.append(b);
  });
  const inst = el('<button>Instant</button>');
  inst.onclick = runInstant;
  row.append(inst);
  ctl.append(row);
  ctl.append(el('<div class="hint">Click a monster in the active room to pull it out (costs a Ley Charge).</div>'));
  if (app.error) ctl.append(el(`<div class="err">${esc(app.error)}</div>`));
  wrap.append(ctl);

  // Party. Under single-file the interesting question is not "how is everyone
  // doing" but "who is in the doorway and who is next", so the list is ordered
  // by the queue rather than by roster position (§7.2).
  const info = FORMATION_INFO[sim.formation];
  const engaged = new Set(sim.engagedIds);
  const waiting = sim.waitingIds;
  const order = sim.formation === 'party'
    ? sim.party.members
    : [
      ...sim.engagedIds,
      ...waiting,
      ...sim.party.members.filter((m) => !m.alive).map((m) => m.id),
    ].map((id) => sim.party.members.find((m) => m.id === id)!);

  const p = el('<div class="panel"></div>');
  p.append(el(`<h2>The Party — Tier ${sim.tier.tier}
    <span class="form-tag ${sim.formation}" title="${esc(info.blurb)}">${info.label}</span></h2>`));
  p.append(el(`<div class="meters">
      <span>Kit <b>${sim.party.kit}</b>/${sim.party.maxKit}</span>
      <span>Gold <b>${sim.party.members.reduce((a, m) => a + (m.alive ? m.gold : 0), 0)}</b></span>
      ${sim.formation === 'single-file'
        ? `<span title="They descend, rest and decide together — they just fight one at a time (§7.2)">Queued <b>${waiting.length}</b></span>`
        : ''}
    </div>`));
  for (const a of order) {
    p.append(advRow(a, sim.formation === 'party' ? null : engaged.has(a.id)));
  }
  wrap.append(p);

  // Log
  const lp = el('<div class="panel"></div>');
  lp.append(el('<h2>Log</h2>'));
  const log = logList(app.log);
  lp.append(log);
  wrap.append(lp);
  queueMicrotask(() => { log.scrollTop = log.scrollHeight; });
  return wrap;
}

/**
 * Who is physically in the room right now, drawn inside the room on the map.
 *
 * Single-file means one delver on the stage and a queue outside the door; a
 * coordinated party means the whole group is in there at once. That difference
 * is the entire point of §18, and before this it was invisible unless you read
 * the log carefully.
 */
function stageStrip(sim: RaidSim): HTMLElement {
  const engagedIds = new Set(sim.engagedIds);
  const inRoom = sim.party.members.filter((m) => m.alive && engagedIds.has(m.id));
  const queued = sim.waitingIds.length;

  const strip = el('<div class="stage"></div>');
  for (const a of inRoom) {
    const hp = Math.max(0, Math.round((a.hp / a.maxHp) * 100));
    strip.append(el(`
      <div class="delver" title="${esc(a.name)} — ${a.cls} ${a.level}, ${hp}% HP">
        <span class="dnm">${esc(a.name.split(' ')[0] ?? a.name)}</span>
        <span class="dhp"><i style="width:${hp}%"></i></span>
      </div>`));
  }
  if (queued > 0) {
    strip.append(el(
      `<div class="queued" title="Waiting at the door — they fight one at a time (§18.2)">`
      + `+${queued} at the door</div>`,
    ));
  }
  return strip;
}

/**
 * One adventurer. `engaged` is null under `party` formation — everyone is in
 * the fight, so marking it would be noise.
 */
/** Scrollable log list. Shared by the live raid view and the Build-Phase replay. */
function logList(lines: LogLine[]): HTMLElement {
  const log = el('<div class="log"></div>');
  for (const line of lines.slice(-400)) {
    log.append(el(`<div class="${line.cls}"><span class="t">${line.t}</span>${esc(line.text)}</div>`));
  }
  return log;
}

/** Last raid's combat log, collapsed by default so it does not crowd the build. */
function lastLogPanel(): HTMLElement | null {
  if (!app.lastLog.length) return null;
  const p = el('<div class="panel"></div>');
  const head = el(`<h2 class="clicky">Last Raid Log — raid ${app.lastRaidNumber}
    <span class="chev">${app.showLastLog ? '▾' : '▸'}</span></h2>`);
  head.onclick = () => { app.showLastLog = !app.showLastLog; render(); };
  p.append(head);
  if (app.showLastLog) {
    const list = logList(app.lastLog);
    list.classList.add('replay');
    p.append(list);
  } else {
    p.append(el(`<div class="hint">${app.lastLog.length} lines — click to review what happened.</div>`));
  }
  return p;
}

function advRow(a: Adventurer, engaged: boolean | null = null): HTMLElement {
  const hp = Math.max(0, (a.hp / a.maxHp) * 100);
  const res = Math.max(0, (a.resolve / a.maxResolve) * 100);
  const stance = !a.alive || engaged === null
    ? ''
    : engaged
      ? '<span class="stance in" title="Holding the door — the only one your monsters can reach">▶</span>'
      : '<span class="stance out" title="Waiting their turn. Still present: still rests, still spends Kit, still votes on the Descent Decision (§7.3)">·</span>';
  // A face the player recognises is the emotional core of §15.5 — a returning
  // veteran should never be indistinguishable from a fresh roll.
  const vet = a.veteranId === null
    ? null
    : app.season.veterans.find((v) => v.id === a.veteranId);
  const mark = vet
    ? `<span class="vet" title="Returning — ${vet.delves} previous delve${vet.delves === 1 ? '' : 's'}, best Thrill ${Math.round(vet.bestThrill)}">↩${vet.delves}</span>`
    : '';
  return el(`
    <div class="adv ${a.alive ? '' : 'dead'} ${a.namedId ? 'named' : ''} ${vet ? 'returning' : ''}
                ${engaged === true && a.alive ? 'engaged' : ''} ${engaged === false && a.alive ? 'waiting' : ''}">
      <span class="nm">${stance}${mark}${esc(a.name)} <span style="color:var(--dim)">${a.cls} ${a.level}</span></span>
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
  const btn = m.querySelector('button') as HTMLElement;
  btn.onclick = () => { clearAutoContinue(); finishRaid(); };
  if (!app.spectating || !app.spectatePaused) {
    scheduleAutoContinue(app.spectating ? 900 : AUTO_CONTINUE_MS, finishRaid);
  }
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
  if (app.spectating) {
    const g = app.idler.best?.genome;
    setTimeout(() => {
      if (!app.spectating || sim.status !== 'awaiting-taunt') return;
      for (const e of sim.resolveTaunt(spectateRng.chance(g?.tauntRate ?? 0.5))) pushLog(e);
      render();
      syncTimer();
    }, 700);
  }
  m.querySelectorAll('button').forEach((b) => {
    (b as HTMLElement).onclick = () => {
      for (const e of sim.resolveTaunt((b as HTMLElement).dataset['a'] === '1')) pushLog(e);
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

  // The story leads. Everything below it is the receipt.
  if (app.narration) m.append(narrationBlock(app.narration));

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
  const go = row.querySelector('button') as HTMLElement;
  go.onclick = () => { clearAutoContinue(); nextRaid(); };
  m.append(row);
  // Auto-continue. This is the modal the player actually clicks through every
  // raid, and it was the one my earlier edit missed — the raid-summary bar got
  // it, this did not. Cancelled by any interaction, so reading at your own pace
  // still wins.
  scheduleAutoContinue(app.spectating ? 1400 : AUTO_CONTINUE_MS, nextRaid);
  bg.append(m);
  return bg;
}

/**
 * The account of the raid — theatre of the mind, above the ledger.
 *
 * This is deliberately the first thing in the Aftermath and the only prose in
 * it. The Thrill card and the table explain *what the numbers were*; this
 * explains what happened, which is the part worth building another floor for.
 */
function narrationBlock(n: Narration): HTMLElement {
  const box = el('<div class="tale"></div>');
  box.append(el('<div class="tale-label">Word from the stair</div>'));
  box.append(el(`<div class="tale-head">${esc(n.headline)}</div>`));
  const body = el('<p class="tale-body"></p>');
  // One sentence per <span> so the CSS can breathe between them without the
  // browser collapsing the gap the way it would with plain text nodes.
  for (const s of n.sentences) body.append(el(`<span>${esc(s)}</span>`));
  box.append(body);
  return box;
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
  const p = app.profile;
  const gained = app.lastInsight;
  const bg = el('<div class="modal-bg"></div>');
  const m = el('<div class="modal wide"></div>');

  m.append(el(`<h3>The Core has fallen — ${s.log.length} raids, Tier ${currentTier(s).tier}</h3>`));

  if (gained) {
    // The whole point of §10: a lost run still moved you forward.
    m.append(el(`
      <div class="insight-won">
        <b>+${gained.total}</b> Insight
        <span class="sub">depth ${gained.depth} · renown ${gained.tier}
          · legends ${gained.legends} · souls ${gained.souls}${gained.bonus ? ` · memory +${gained.bonus}` : ''}</span>
      </div>`));
  }
  m.append(el(`<p>Best run: ${p.bestRaids} raids, Tier ${p.bestTier} · ${p.runs} run${p.runs === 1 ? '' : 's'} · <b>${p.insight}</b> Insight banked</p>`));

  m.append(el('<h2>The Codex</h2>'));
  for (const def of Object.values(CODEX)) {
    const rank = rankOf(p, def.id as CodexId);
    const cost = nextCodexCost(p, def.id as CodexId);
    const maxed = cost === null;
    const cant = maxed || p.insight < cost;
    const pips = '●'.repeat(rank) + '○'.repeat(def.maxRank - rank);
    const b = el(`<div class="buy ${cant ? 'off' : ''}" title="${esc(def.blurb)}">
        <span>${def.name}<div class="meta">${pips} — ${esc(def.blurb)}</div></span>
        <span class="cost i">${maxed ? 'max' : `${cost}`}</span>
      </div>`);
    if (!cant) {
      b.onclick = () => {
        const err = buyCodex(p, def.id as CodexId);
        if (!err) saveProfile(p);
        fail(err);
      };
    }
    m.append(b);
  }

  const bonus = startingBonuses(p);
  m.append(el(`<div class="hint">Next run starts with ${STARTING_HEARTS + bonus.hearts} Hearts, ${TUNING.startingMana + bonus.mana} Mana, ${TUNING.startingGold + bonus.gold} Gold.</div>`));

  const row = el('<div class="row" style="margin-top:14px"></div>');
  const endlessBtn = el(`<button class="${app.endless ? 'on' : ''}">Endless: ${app.endless ? 'on' : 'off'}</button>`);
  endlessBtn.onclick = () => { app.endless = !app.endless; render(); };
  const again = el('<button class="primary">Delve Again →</button>');
  again.onclick = restart;
  row.append(endlessBtn, again);
  m.append(row);

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

// Capture phase, so the hold lands before the clicked control does its work —
// otherwise a speed button would change speed and immediately be swept past.
root.addEventListener('click', holdOnInteraction, true);
// Do not leave a search running against a page that is going away.
globalThis.addEventListener?.('pagehide', () => { stopIdler(); stopTimer(); });

syncIdler();
render();

