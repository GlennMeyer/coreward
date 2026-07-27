/**
 * Raid narration — the account of what just happened (§1 tone, §15 framing).
 *
 * The Aftermath used to be a table of numbers. A table is a receipt; it is not
 * a reason to build another floor. This turns a finished raid into three to six
 * sentences the player might actually retell, which is the same product the
 * dungeon sells to adventurers: a story worth carrying home.
 *
 * Two rules make it work.
 *
 * 1. **It is pure and headless.** No DOM, no `Math.random()` — see §13.2. All
 *    variation comes from a `Rng` seeded off the raid itself, so the same raid
 *    narrates identically every time. Replays, reproducible bug reports and the
 *    headless balance runner all keep working, and a narration bug can be filed
 *    with a seed instead of a screenshot.
 *
 * 2. **It reports, it does not decorate.** Every beat below is gated on
 *    something that actually happened in the event stream. A dull raid produces
 *    a dull account on purpose: an empty dungeon should *read* as boredom,
 *    because that is the feedback the player needs (§15.4).
 *
 * Tone target (§1): the operator of a lethal attraction, doing the books at the
 * end of the night. Dry, wry, faintly commercial. Never a cackling villain and
 * never purple.
 */
import { AMENITIES, MOBS, TRAPS } from './data';
import { Rng } from './rng';
import type {
  Dungeon, Party, RaidEvent, RaidResult, RetreatReason, Veteran,
} from './types';

// ─── Public surface ──────────────────────────────────────────────────────────

export interface NarrationContext {
  /** The raid's event stream — the only thing the narrator truly requires. */
  events: readonly RaidEvent[];
  result: RaidResult;
  /**
   * Everything below is optional context that sharpens the account. The
   * narrator degrades to a coarser story without them rather than throwing,
   * which also means a caller that only kept the event stream still works.
   */
  party?: Party | null;
  /** Used to name monsters by uid, and to read their levels. */
  dungeon?: Dungeon | null;
  /** The season roster (§15.5), for recognising returning faces. */
  veterans?: readonly Veteran[] | null;
  raidNumber?: number;
  /**
   * Override the phrasing seed. Omitted, it is fingerprinted from the raid,
   * which is what makes a given raid narrate identically forever.
   */
  seed?: number;
}

export interface Narration {
  /** One short verdict line. The chapter title, not a sentence of the story. */
  headline: string;
  /** The account itself, 3–6 sentences. */
  sentences: string[];
  /** `sentences` joined with spaces, for callers that just want the prose. */
  text: string;
  /**
   * Which beats fired, in order. Not shown to the player — this exists so
   * tests can assert that a near-miss raid actually produced the near-miss
   * beat rather than three sentences of pleasant nothing.
   */
  beats: string[];
}

/** Turn a finished raid into prose. Pure; deterministic for a given raid. */
export function narrateRaid(ctx: NarrationContext): Narration {
  const d = digestRaid(ctx);
  const rng = new Rng(ctx.seed ?? fingerprint(d));

  const headline = fill(rng, headlinePool(d));
  const candidates = buildBeats(d, rng);

  // Opening and closing always run; the middle is whatever was most notable.
  const opening = candidates.find((b) => b.slot === 'open');
  const closing = candidates.find((b) => b.slot === 'close');
  let middles = candidates
    .filter((b) => b.slot === 'mid' && b.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .slice(0, middleCount(d))
    .sort((a, b) => a.order - b.order);

  // A raid where genuinely nothing stood out still gets a middle sentence,
  // because "arrival, verdict" is a stub rather than an account. The fallback
  // (weight 0) is a flat description of a flat delve, which is the point.
  if (middles.length === 0) {
    const quiet = candidates.find((b) => b.slot === 'mid' && b.weight === 0);
    if (quiet) middles = [quiet];
  }

  const chosen = [...(opening ? [opening] : []), ...middles, ...(closing ? [closing] : [])];

  return {
    headline,
    sentences: chosen.map((b) => b.text),
    text: chosen.map((b) => b.text).join(' '),
    beats: chosen.map((b) => b.id),
  };
}

/**
 * How many middle beats to spend. A raid where nothing happened gets a short,
 * flat account — the brevity is the feedback (§15.4). Total lands in 3–6.
 */
function middleCount(d: RaidDigest): number {
  const eventful =
    (d.deaths.length ? 1 : 0)
    + (d.slain.length ? 1 : 0)
    + (d.tauntUsed ? 1 : 0)
    + (d.breachHearts !== null ? 1 : 0)
    + (d.retired.length ? 1 : 0)
    + (d.closest && d.closest.pct <= 40 ? 1 : 0)
    + (d.purchaseGold > 0 ? 1 : 0)
    + (d.rivalry.nemesis ? 1 : 0)
    + (d.repeatedMob ? 1 : 0)
    + (d.sprung ? 1 : 0)
    + (d.trapKit > 0 || d.trapHeld > 0 || d.trapDmg >= 12 ? 1 : 0);
  if (d.thrill < 12 && eventful === 0) return 1;
  return Math.max(1, Math.min(4, 1 + eventful));
}

// ─── Digest: interrogate the event stream ────────────────────────────────────

interface RoomTally {
  floor: number;
  room: number;
  /** Damage the party took in this room. The blunt measure of "it got bad here". */
  dmgTaken: number;
  advDeaths: string[];
  mobDowns: number;
  kitStripped: number;
  resolveHits: number;
  /** Nobody swung a weapon here. Tedium (§15.3) made visible. */
  empty: boolean;
  /** uid → damage that mob put through the party, in this room. */
  byMob: Map<number, number>;
  /** Trap defIds that went off here (§5.2). A trap firing is not an empty room. */
  traps: string[];
}

interface MobRef {
  uid: number;
  defId: string;
  level: number;
}

export interface RaidDigest {
  outcome: RaidResult['outcome'];
  tier: number;
  partySize: number;
  raidNumber: number | null;
  ticks: number;
  thrill: number;
  peril: number;
  renown: number;
  souls: number;

  rooms: RoomTally[];
  emptyRooms: number;
  /** Longest run of consecutive rooms with nothing in them. */
  longestEmptyRun: number;
  /** A room signature that repeated back-to-back, if any: the nine-Ogres problem. */
  repeatedMob: MobRef | null;
  deepestFloor: number;

  /** The room that decided the raid, if one stands out. */
  turningPoint: RoomTally | null;
  /** The monster that did the most damage across the whole delve. */
  starMob: MobRef | null;
  /** Total damage that star put through them. */
  starMobDmg: number;

  kitStripped: number;
  kitStripper: MobRef | null;
  /** They sat down at a landing with nothing to spend on resting. */
  dryRest: boolean;
  kitFloor: number | null;
  resolveHits: number;

  // ── Traps (§5.2) ──
  /** Traps that fired, by defId, most-used first. */
  trapsFired: { defId: string; times: number }[];
  /** HP damage traps put through the party, and Kit they destroyed. */
  trapDmg: number;
  trapKit: number;
  /** Ticks the party spent held by a Snare. */
  trapHeld: number;
  /** A trap triggered by the Spring intervention (§7.4) — the player's own beat. */
  sprung: { defId: string; floor: number; room: number } | null;
  /** The trap that did the most measurable work. */
  topTrap: string | null;

  tauntOffered: boolean;
  tauntUsed: boolean;
  /** Adventurers killed *after* the taunt landed — did the gamble pay? */
  killsAfterTaunt: number;
  interventions: MobRef[];

  breachHearts: number | null;
  retreatReason: RetreatReason | null;

  purchaseGold: number;
  purchaseCount: number;
  /** Amenity id that took the most money. */
  topAmenity: string | null;

  levelUps: MobRef[];
  slain: MobRef[];
  downed: MobRef[];
  /** The most decorated thing we lost. Losing a level-6 anything should sting. */
  bestLost: MobRef | null;

  deaths: { name: string; gold: number }[];
  survivors: { name: string; pct: number; cls: string }[];
  /** The survivor who came closest to not being one. */
  closest: { name: string; pct: number; cls: string } | null;
  /** The healthiest survivor — the "nothing happened to me" case. */
  safest: { name: string; pct: number; cls: string } | null;

  namedAdventurer: { name: string; alive: boolean } | null;
  /** Returning faces, most-travelled first. */
  returning: { name: string; delves: number; alive: boolean }[];
  /** Nemesis / Patron / grudge material, if the roster carries any. See `readRivalry`. */
  rivalry: Rivalry;
  retired: { name: string; thrill: number }[];
}

/**
 * Fold the stream into everything the prose might want to mention.
 *
 * Exported because it is the honest way to test the narrator: assert that the
 * digest found the near-miss, then assert the near-miss beat fired.
 */
export function digestRaid(ctx: NarrationContext): RaidDigest {
  const { events, result } = ctx;
  const party = ctx.party ?? null;

  // uid → identity, assembled from every source that knows one. Attack events
  // carry only a uid, so without this a monster can only be "something".
  const mobIndex = new Map<number, MobRef>();
  const noteMob = (uid: number, defId?: string, level?: number): void => {
    const prev = mobIndex.get(uid);
    mobIndex.set(uid, {
      uid,
      defId: defId ?? prev?.defId ?? '',
      level: Math.max(level ?? 0, prev?.level ?? 0) || 1,
    });
  };
  if (ctx.dungeon) {
    for (const m of ctx.dungeon.mobs) noteMob(m.uid, m.defId, m.level);
  }
  // The result knows the identity of everything that fell, which covers the
  // case where the caller kept no dungeon — an attack event carries a uid and
  // nothing else, and an unnamed monster makes for a much worse sentence.
  for (const m of [...result.mobsDowned, ...result.mobsLost]) noteMob(m.uid, m.defId, m.level);
  for (const e of events) {
    if (e.type === 'mob-downed' || e.type === 'mob-slain') noteMob(e.uid, e.defId, e.level);
    if (e.type === 'mob-levelup') noteMob(e.uid, undefined, e.level);
  }
  const mobRef = (uid: number): MobRef => mobIndex.get(uid) ?? { uid, defId: '', level: 1 };

  const rooms: RoomTally[] = [];
  let cur: RoomTally | null = null;
  const dmgByMob = new Map<number, number>();
  const levelUps: MobRef[] = [];
  const interventions: MobRef[] = [];
  const deaths: { name: string; gold: number }[] = [];
  const stripsByMob = new Map<number, number>();

  let tier = 0;
  let partySize = party?.members.length ?? 0;
  let kitStripped = 0;
  let resolveHits = 0;
  let dryRest = false;
  let kitFloor: number | null = null;
  let tauntOffered = false;
  let tauntUsed = false;
  let tauntTick: number | null = null;
  let killsAfterTaunt = 0;
  let breachHearts: number | null = null;
  let retreatReason: RetreatReason | null = null;
  let purchaseGold = 0;
  let purchaseCount = 0;
  const goldByAmenity = new Map<string, number>();
  let repeatedMob: MobRef | null = null;
  let lastRoomSig: string | null = null;
  const trapFires = new Map<string, number>();
  const trapWork = new Map<string, number>();
  let trapDmg = 0;
  let trapKit = 0;
  let trapHeld = 0;
  let sprung: { defId: string; floor: number; room: number } | null = null;

  for (const e of events) {
    switch (e.type) {
      case 'raid-start':
        tier = e.tier;
        if (!partySize) partySize = e.partySize;
        break;

      case 'room-enter':
        cur = {
          floor: e.floor, room: e.room, dmgTaken: 0, advDeaths: [], mobDowns: 0,
          kitStripped: 0, resolveHits: 0, empty: true, byMob: new Map(), traps: [],
        };
        rooms.push(cur);
        break;

      // ── Traps (§5.2) ──
      // A trap going off is emphatically not an empty room, so `empty` clears
      // here for the same reason it clears on an attack: something happened.
      case 'trap-fire':
        trapFires.set(e.defId, (trapFires.get(e.defId) ?? 0) + 1);
        if (e.sprung) sprung = { defId: e.defId, floor: e.floor, room: e.room };
        if (cur) { cur.traps.push(e.defId); cur.empty = false; }
        break;

      case 'trap-hit':
        trapDmg += e.dmg;
        trapWork.set(e.defId, (trapWork.get(e.defId) ?? 0) + e.dmg);
        if (cur) { cur.dmgTaken += e.dmg; cur.empty = false; }
        break;

      case 'trap-kit':
        trapKit += e.amount;
        kitStripped += e.amount;
        // Weighted well above raw damage: taking supplies is worth far more
        // than the hit points it superficially resembles (§7.3, §14.4).
        trapWork.set(e.defId, (trapWork.get(e.defId) ?? 0) + e.amount * 12);
        if (e.kitLeft === 0 && kitFloor === null) kitFloor = cur?.floor ?? 0;
        if (cur) { cur.kitStripped += e.amount; cur.empty = false; }
        break;

      case 'trap-snare':
        trapHeld += e.ticks;
        trapWork.set(e.defId, (trapWork.get(e.defId) ?? 0) + e.ticks * 6);
        if (cur) cur.empty = false;
        break;

      case 'attack':
        if (e.source === 'mob') {
          if (cur) {
            cur.dmgTaken += e.dmg;
            cur.empty = false;
            cur.byMob.set(e.uid, (cur.byMob.get(e.uid) ?? 0) + e.dmg);
          }
          dmgByMob.set(e.uid, (dmgByMob.get(e.uid) ?? 0) + e.dmg);
        } else if (cur) {
          cur.empty = false;
        }
        break;

      case 'kit-strip':
        kitStripped += e.amount;
        stripsByMob.set(e.uid, (stripsByMob.get(e.uid) ?? 0) + e.amount);
        if (e.kitLeft === 0 && kitFloor === null) kitFloor = cur?.floor ?? 0;
        if (cur) { cur.kitStripped += e.amount; cur.empty = false; }
        break;

      case 'resolve-hit':
        resolveHits++;
        if (cur) { cur.resolveHits++; cur.empty = false; }
        break;

      case 'mob-downed':
        if (cur) { cur.mobDowns++; cur.empty = false; }
        break;

      case 'mob-levelup':
        levelUps.push(mobRef(e.uid));
        break;

      case 'adv-death':
        deaths.push({ name: e.name, gold: e.goldDropped });
        if (cur) { cur.advDeaths.push(e.name); cur.empty = false; }
        if (tauntTick !== null) killsAfterTaunt++;
        break;

      case 'intervention-retreat':
        interventions.push(mobRef(e.uid));
        break;

      case 'rest':
        // No Kit, no heal (§7.3) — the moment a drain build actually pays off.
        if (e.kitSpent === 0) dryRest = true;
        break;

      case 'purchase':
        purchaseGold += e.gold;
        purchaseCount++;
        goldByAmenity.set(e.amenity, (goldByAmenity.get(e.amenity) ?? 0) + e.gold);
        break;

      case 'taunt-offer':
        tauntOffered = true;
        break;

      case 'taunt-used':
        tauntUsed = true;
        tauntTick = e.t;
        break;

      case 'core-breach':
        breachHearts = e.heartsLeft;
        break;

      case 'retreat':
        retreatReason = e.reason;
        break;

      default:
        break;
    }

    // Consecutive identical rooms are a scored failure, not just a taste
    // problem (§15.4) — worth calling out by name when it happens.
    if (e.type === 'room-enter') {
      const sig = roomSignature(rooms.length - 1, events, mobIndex);
      if (sig.key && sig.key === lastRoomSig && sig.ref) repeatedMob = sig.ref;
      lastRoomSig = sig.key;
    }
  }

  // Empty-room runs: the "long walk through rooms we forgot to fill" beat.
  let emptyRooms = 0;
  let longestEmptyRun = 0;
  let run = 0;
  for (const r of rooms) {
    if (r.empty) { emptyRooms++; run++; longestEmptyRun = Math.max(longestEmptyRun, run); }
    else run = 0;
  }

  // The turning point: a death outranks any amount of damage, because a death
  // is the thing the survivors will actually talk about.
  const turningPoint = rooms.reduce<RoomTally | null>((best, r) => {
    if (r.empty) return best;
    const score = r.advDeaths.length * 10_000 + r.dmgTaken;
    if (!best) return score > 0 ? r : null;
    const bestScore = best.advDeaths.length * 10_000 + best.dmgTaken;
    return score > bestScore ? r : best;
  }, null);

  const starEntry = [...dmgByMob.entries()].sort((a, b) => b[1] - a[1])[0];
  const stripEntry = [...stripsByMob.entries()].sort((a, b) => b[1] - a[1])[0];
  const amenityEntry = [...goldByAmenity.entries()].sort((a, b) => b[1] - a[1])[0];

  const slain = result.mobsLost.map((m) => ({ uid: m.uid, defId: m.defId, level: m.level }));
  const downed = result.mobsDowned.map((m) => ({ uid: m.uid, defId: m.defId, level: m.level }));
  // The loss worth naming: highest level first, then the biggest body. A
  // level-1 Ogre is still a worse thing to lose than a level-1 Cave Rat, and
  // "we buried four, including the Cave Rat" undersells the evening.
  const lossRank = (m: MobRef): number => m.level * 100 + (MOBS[m.defId]?.tier ?? 0);
  const bestLost = slain.reduce<MobRef | null>(
    (best, m) => (!best || lossRank(m) > lossRank(best) ? m : best), null,
  );

  const survivors = (party?.members ?? [])
    .filter((m) => m.alive)
    .map((m) => ({ name: m.name, pct: Math.round(clamp01(m.lowestHpPct) * 100), cls: m.cls }))
    .sort((a, b) => a.pct - b.pct);

  const named = (party?.members ?? []).find((m) => m.namedId);
  const returning = (party?.members ?? [])
    .filter((m) => m.veteranId !== null)
    .map((m) => ({
      name: m.name,
      delves: ctx.veterans?.find((v) => v.id === m.veteranId)?.delves ?? 0,
      alive: m.alive,
    }))
    .sort((a, b) => b.delves - a.delves);

  return {
    outcome: result.outcome,
    tier,
    partySize,
    raidNumber: ctx.raidNumber ?? null,
    ticks: result.ticks,
    thrill: Math.round(result.thrill.total),
    peril: result.thrill.peril,
    renown: result.renown,
    souls: result.souls,

    rooms,
    emptyRooms,
    longestEmptyRun,
    repeatedMob,
    deepestFloor: result.deepestFloorReached,

    turningPoint,
    starMob: starEntry ? mobRef(starEntry[0]) : null,
    starMobDmg: starEntry ? starEntry[1] : 0,

    kitStripped,
    kitStripper: stripEntry ? mobRef(stripEntry[0]) : null,
    dryRest,
    kitFloor,
    resolveHits,

    trapsFired: [...trapFires.entries()]
      .map(([defId, times]) => ({ defId, times }))
      .sort((a, b) => b.times - a.times),
    trapDmg,
    trapKit,
    trapHeld,
    sprung,
    topTrap: [...trapWork.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,

    tauntOffered,
    tauntUsed,
    killsAfterTaunt,
    interventions,

    breachHearts,
    retreatReason,

    purchaseGold,
    purchaseCount,
    topAmenity: amenityEntry ? amenityEntry[0] : null,

    levelUps,
    slain,
    downed,
    bestLost,

    deaths,
    survivors,
    closest: survivors[0] ?? null,
    safest: survivors[survivors.length - 1] ?? null,

    namedAdventurer: named ? { name: named.name, alive: named.alive } : null,
    returning,
    rivalry: readRivalry(party),
    retired: result.retired.map((l) => ({ name: l.name, thrill: Math.round(l.thrill) })),
  };
}

/**
 * The cast of a room, for detecting back-to-back repeats.
 *
 * The stream does not announce a room's roster, so it is reconstructed from
 * who swung in it. Approximate by design: a monster that never got a turn
 * before the room was cleared did not contribute to the tedium either.
 */
function roomSignature(
  index: number, events: readonly RaidEvent[], mobIndex: Map<number, MobRef>,
): { key: string | null; ref: MobRef | null } {
  let seen = -1;
  const uids = new Set<number>();
  const traps = new Set<string>();
  for (const e of events) {
    if (e.type === 'room-enter') {
      seen++;
      if (seen > index) break;
    }
    if (seen !== index) continue;
    if (e.type === 'attack' && e.source === 'mob') uids.add(e.uid);
    if (e.type === 'kit-strip') uids.add(e.uid);
    // A trap is part of a room's cast: two rooms of Dart Batteries back to
    // back is the same failure as two rooms of Ogres, and the sim's own
    // signature counts it (see `noteRoomTraversed`).
    if (e.type === 'trap-fire' && !e.sprung) traps.add(e.defId);
  }
  if (uids.size === 0 && traps.size === 0) return { key: null, ref: null };
  const refs = [...uids].map((u) => mobIndex.get(u)).filter((r): r is MobRef => !!r);
  const key = [
    ...refs.map((r) => r.defId),
    ...[...traps].map((t) => `trap:${t}`),
  ].sort().join(',');
  return { key: key || null, ref: refs[0] ?? null };
}

export interface Rivalry {
  /** Someone who has escaped often enough to be a problem (§9.3). */
  nemesis: { name: string; rank: number } | null;
  /** A recurring customer (§9.4). Worth more alive than dead, and knows it. */
  patron: { name: string } | null;
  /** A survivor who learned something specific about this dungeon tonight. */
  learned: { name: string; reason: string } | null;
}

const NO_RIVALRY: Rivalry = { nemesis: null, patron: null, learned: null };

/**
 * Read the Nemesis / Patron tracks (§9.3, §9.4) off the party, if they exist.
 *
 * That system is owned elsewhere and still moving, so every field here is
 * probed rather than assumed: an `Adventurer` without `isNemesis` simply never
 * produces a Nemesis sentence. The narrator is a reporter — if the sim has not
 * recorded a grudge, there is no grudge to report, and nothing to crash on.
 */
function readRivalry(party: Party | null): Rivalry {
  if (!party) return NO_RIVALRY;
  const out: Rivalry = { nemesis: null, patron: null, learned: null };

  for (const adv of party.members) {
    const bag = adv as unknown as Record<string, unknown>;

    if (!out.nemesis && bag['isNemesis'] === true) {
      const rank = typeof bag['rank'] === 'number' ? bag['rank'] : 0;
      out.nemesis = { name: adv.name, rank };
    }
    if (!out.patron && bag['isPatron'] === true) {
      out.patron = { name: adv.name };
    }
    // A grudge is stamped at raid end and only means anything if they lived to
    // act on it, so the dead are skipped.
    if (!out.learned && adv.alive) {
      const reason = bag['grudge'];
      if (typeof reason === 'string' && reason.length > 0) {
        out.learned = { name: adv.name, reason };
      }
    }
  }
  return out;
}

/**
 * A stable 32-bit fingerprint of the delve.
 *
 * This is the default phrasing seed, and it is why the same raid always reads
 * the same: the seed is a function of what happened, not of when it is being
 * rendered. Two different raids that happen to be identical in every detail
 * will narrate identically too, which is correct — they are the same story.
 */
function fingerprint(d: RaidDigest): number {
  const parts = [
    d.outcome, d.tier, d.partySize, d.ticks, d.thrill, d.renown, d.souls,
    d.deepestFloor, d.rooms.length, d.emptyRooms, d.kitStripped, d.resolveHits,
    d.purchaseGold, d.slain.length, d.downed.length, d.deaths.length,
    d.trapDmg, d.trapKit, d.trapHeld, d.sprung ? 'S' : '-',
    d.survivors.map((s) => `${s.name}:${s.pct}`).join('|'),
    d.deaths.map((x) => x.name).join('|'),
    d.tauntUsed ? 'T' : '-', d.breachHearts ?? '-', d.retreatReason ?? '-',
  ].join('/');

  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ─── Beats ───────────────────────────────────────────────────────────────────

interface Beat {
  id: string;
  slot: 'open' | 'mid' | 'close';
  /** Narrative position, so selected beats still read in a sensible order. */
  order: number;
  /** How much this deserves a sentence. Only the top few middles survive. */
  weight: number;
  text: string;
}

/**
 * Every beat the raid earned, with the phrasing already rolled.
 *
 * Rolling phrasing for beats that later get dropped is deliberate: the draws
 * happen in a fixed order regardless of selection, so the output stays
 * deterministic and adding a new beat does not reshuffle every existing one
 * beyond its own position.
 */
function buildBeats(d: RaidDigest, rng: Rng): Beat[] {
  const out: Beat[] = [];
  const add = (
    id: string, slot: Beat['slot'], order: number, weight: number, text: string,
  ): void => {
    if (text) out.push({ id, slot, order, weight, text });
  };

  add('arrival', 'open', 0, 100, arrivalBeat(d, rng));

  // Weights are "how much does this tell the player about their dungeon".
  // The near-miss tops the scale on purpose: a party at 8% *is* the product
  // (§15.3), so when one happens it outranks nearly everything else.
  if (d.rivalry.nemesis) {
    add('nemesis', 'mid', 5, 95, nemesisBeat(d, rng));
  }
  if (d.longestEmptyRun >= 2 || (d.emptyRooms >= 2 && d.thrill < 30)) {
    add('tedium', 'mid', 10, Math.min(80, 46 + d.longestEmptyRun * 6), tediumBeat(d, rng));
  }
  if (d.repeatedMob) {
    add('repetition', 'mid', 11, 55 + (d.thrill < 25 ? 25 : 0), repetitionBeat(d, rng));
  }
  if (d.turningPoint && (d.turningPoint.advDeaths.length > 0 || d.turningPoint.dmgTaken >= 12)) {
    add('turning-point', 'mid', 20, 70 + (d.turningPoint.advDeaths.length ? 25 : 0),
      turningPointBeat(d, rng));
  }
  // The Kit beat is written around a *monster* taking the pack apart. When
  // nothing living did it, the trap beat below says the same thing accurately
  // instead of this one saying it about "something".
  const kitByMonster = d.kitStripped > d.trapKit || d.kitStripper !== null;
  if ((d.kitStripped >= 2 && kitByMonster) || d.dryRest) {
    add('kit', 'mid', 25, 52 + Math.min(d.kitStripped, 8) * 4 + (d.dryRest ? 18 : 0),
      kitBeat(d, rng));
  }
  if (d.resolveHits >= 3 || d.retreatReason === 'resolve') {
    add('resolve', 'mid', 26, 48 + (d.retreatReason === 'resolve' ? 25 : 0), resolveBeat(d, rng));
  }
  // Springing a trap is a player decision paid for with a Ley Charge (§7.4),
  // so it outranks the trap firing on its own — the same reasoning that puts
  // Taunt near the top of the scale.
  if (d.sprung) {
    add('spring', 'mid', 27, 86, springBeat(d, rng));
  } else if (d.trapsFired.length > 0) {
    // Weighted on what the machinery actually did, not on how many clicked.
    add('traps', 'mid', 28,
      40 + Math.min(24, d.trapDmg / 2) + d.trapKit * 9 + d.trapHeld * 4,
      trapBeat(d, rng));
  }
  if (d.purchaseGold > 0) {
    // Commerce is one of the three ways to win a floor (§7.5). Weighted to be
    // competitive, or the Gold economy never gets a word said about it.
    add('commerce', 'mid', 30, 58 + Math.min(d.purchaseGold, 80) / 4, commerceBeat(d, rng));
  }
  if (d.rivalry.patron) {
    add('patron', 'mid', 31, 62, patronBeat(d, rng));
  }
  if (d.interventions.length > 0) {
    add('intervention', 'mid', 33, 50, interventionBeat(d, rng));
  }
  if (d.tauntUsed) {
    add('taunt', 'mid', 35, 88, tauntBeat(d, rng));
  }
  if (d.deaths.length > 0) {
    add('deaths', 'mid', 40, 75, deathsBeat(d, rng));
  }
  if (d.slain.length > 0) {
    add('losses', 'mid', 45, 62 + (d.bestLost ? d.bestLost.level * 5 : 0), lossesBeat(d, rng));
  } else if (d.downed.length >= 2) {
    add('held', 'mid', 45, 44, heldBeat(d, rng));
  }
  if (d.levelUps.length > 0) {
    // A promotion is a smaller story than a funeral, so it steps aside when we
    // also buried something — but on a clean night it is the whole point of
    // monsters being units rather than turrets (pillar 3).
    add('levelup', 'mid', 46, d.slain.length ? 30 : 56, levelUpBeat(d, rng));
  }
  if (d.closest && d.survivors.length > 0) {
    if (d.closest.pct <= 40) {
      add('near-miss', 'mid', 50, Math.min(112, 62 + (45 - Math.min(d.closest.pct, 45)) * 2),
        nearMissBeat(d, rng));
    } else if (d.closest.pct >= 75 && d.outcome !== 'wiped') {
      add('untroubled', 'mid', 50, 64, untroubledBeat(d, rng));
    }
  }
  if (d.breachHearts !== null) {
    add('breach', 'mid', 55, 120, breachBeat(d, rng));
  }
  if (d.retired.length > 0) {
    add('retirement', 'mid', 58, 110, retirementBeat(d, rng));
  }
  if (d.rivalry.learned) {
    add('learned', 'mid', 60, 52, learnedBeat(d, rng));
  }

  // Weight 0 marks this a fallback: only used when nothing else earned a line.
  add('quiet', 'mid', 15, 0, quietBeat(d, rng));

  add('verdict', 'close', 90, 100, verdictBeat(d, rng));
  return out;
}

// ─── Phrasing pools ──────────────────────────────────────────────────────────
//
// House style, for anyone adding to these: state a fact, then undercut it.
// The joke is always that this is a business. Nothing gloats, nothing cackles,
// and nothing is described as "writhing".

function headlinePool(d: RaidDigest): readonly string[] {
  if (d.breachHearts !== null) {
    return [
      'They got all the way down.',
      'A Heart, gone.',
      'The Core has visitors.',
      'Deep enough to touch us. They did.',
    ];
  }
  if (d.outcome === 'wiped') {
    return [
      'Nobody went home.',
      'A clean sweep, and not a word of it leaves this dungeon.',
      'Total loss, their side.',
      'The stair goes both ways. Not tonight.',
    ];
  }
  if (d.retired.length > 0) {
    return [
      'Someone hung it up.',
      'A career ends on our stair.',
      'Retired, on the premises.',
    ];
  }
  if (d.thrill >= 55) {
    return [
      'They will not shut up about this one.',
      'That is the delve they tell in the tavern.',
      'Word gets out, and word is the product.',
      'A very good night for the reputation.',
    ];
  }
  if (d.thrill >= 30) {
    return [
      'Respectable. Not legendary.',
      'A solid night’s trade.',
      'They got their money’s worth. Roughly.',
      'Nothing to frame, nothing to apologise for.',
    ];
  }
  if (d.thrill >= 12) {
    return [
      'Thin.',
      'They have had worse. That is the problem.',
      'Adequate, in the way a corridor is adequate.',
    ];
  }
  return [
    'Nothing happened, expensively.',
    'A quiet evening. Quiet is not a business model.',
    'They came, they looked, they left unbothered.',
    'The dungeon did not come up in conversation.',
  ];
}

function arrivalBeat(d: RaidDigest, rng: Rng): string {
  const n = countWord(d.partySize);           // mid-sentence: "a party of three"
  const N = cap(n);                           // sentence-initial: "Three came down"
  const rest = countWord(Math.max(0, d.partySize - 1));
  const tier = d.tier;
  // `delves` counts delves SURVIVED, so someone with 1 is here for their
  // second time. Recognising them is the whole point of the recurring-face
  // hook (§9.3, §15.5) — anyone who has been here before is worth naming.
  const vet = d.returning.find((v) => v.delves >= 1);
  const visit = vet ? ordinalWord(vet.delves + 1) : '';

  // Both a famous face AND a regular: say so. Suppressing the regular was
  // hiding the recurring-character hook behind the static named roster.
  if (d.namedAdventurer && vet && vet.name !== d.namedAdventurer.name) {
    const name = d.namedAdventurer.name;
    return fill(rng, [
      `${name} came down at Tier ${tier}, and ${vet.name} came with them — ${visit} time now for one of them, and a first for the rest.`,
      `Tier ${tier}: ${name} at the front, ${vet.name} a step behind on their ${visit} descent, and ${rest} others who have never seen the place.`,
      `We had ${name} on the manifest and ${vet.name} back for a ${visit} look. ${cap(n)} in total, and only one of them still curious.`,
    ]);
  }

  if (d.namedAdventurer) {
    const name = d.namedAdventurer.name;
    return fill(rng, [
      `${name} came down at Tier ${tier} with ${rest} others in tow, and no interest whatsoever in our warnings.`,
      `Tier ${tier}, ${n} of them, and ${name} setting a pace the rest clearly regretted agreeing to.`,
      `${name} was at the front again — Tier ${tier}, ${n} strong, one of them famous and the rest hoping to be.`,
      `We had ${name} on the manifest: Tier ${tier}, ${n} in the party, and a reputation walking ahead of them down the stair.`,
    ]);
  }

  if (vet) {
    return fill(rng, [
      `${vet.name} was back for a ${visit} time, bringing ${rest} others down at Tier ${tier}.`,
      `We recognised ${vet.name} on the stair — ${visit} descent — with ${rest} newer faces behind.`,
      `${N} came down at Tier ${tier}, and ${vet.name} did not need directions. That is the ${visit} time now.`,
      `A Tier ${tier} party of ${n}, ${vet.name} among them for the ${visit} time, which by now counts as loyalty.`,
    ]);
  }

  return fill(rng, [
    `${N} came down the stair at Threat Tier ${tier}, carrying the usual optimism.`,
    `${N} adventurers signed themselves in at Tier ${tier}. None of them asked what the tier meant.`,
    `Tier ${tier}. ${N} of them, roped together and pretending the dark was fine.`,
    `Business as usual: ${n} at Tier ${tier}, in through the front, torches high and plans vague.`,
    `The stair delivered ${n} more at Tier ${tier} — fresh boots, fresh debt, firm opinions about ventilation.`,
    `${N} arrived at Tier ${tier}, priced accordingly, and confident in a way the ledger did not support.`,
    `A party of ${n} arrived at Tier ${tier} and spent their first minute admiring the stonework.`,
  ]);
}

/**
 * The nothing-happened sentence. Used only when no other beat fired, which is
 * itself the report: a dungeon that produces this line has nothing in it worth
 * describing, and the player should feel that before they read the Thrill.
 */
function quietBeat(d: RaidDigest, rng: Rng): string {
  const floors = Math.max(1, d.deepestFloor);
  const rooms = countWord(d.rooms.length);
  return fill(rng, [
    `They got through ${floors === 1 ? 'a floor' : `${countWord(floors)} floors`} without anything worth writing down happening to them.`,
    `${cap(rooms)} rooms, no surprises, and nothing either side will remember by morning.`,
    `The delve went exactly as the floor plan said it would, which is the problem with the floor plan.`,
    `Nothing in there did anything a report would need to mention.`,
    `They came, they walked about a bit, and the dungeon failed to make an impression.`,
  ]);
}

function tediumBeat(d: RaidDigest, rng: Rng): string {
  const n = countWord(d.longestEmptyRun || d.emptyRooms);
  return fill(rng, [
    `They crossed ${n} empty rooms without drawing a weapon, and one of them started counting bricks.`,
    `${cap(n)} rooms of nothing. Whatever they came for, it was not in the corridors.`,
    `Most of the delve was walking. Walking does not sell tickets.`,
    `A long stroll through ${n} rooms we forgot to fill, and they noticed — they always notice.`,
    `The empty stretches did the real damage: ${n} rooms in a row where the most dangerous thing was the draught.`,
    `They got ${n} rooms deep before anything down here bothered to introduce itself.`,
  ]);
}

function repetitionBeat(d: RaidDigest, rng: Rng): string {
  const m = mobPhrase(d.repeatedMob, { plural: true });
  return fill(rng, [
    `Then another room of ${m}, exactly like the last one. By the second they had the routine, and routine is the only thing down here that costs us money.`,
    `More ${m}, again, in the same arrangement. They stopped being frightened and started being efficient.`,
    `The same ${m} in the same formation twice running — they solved it once and then just did it again.`,
  ]);
}

function turningPointBeat(d: RaidDigest, rng: Rng): string {
  const tp = d.turningPoint!;
  const where = `the ${ordinalWord(tp.room + 1)} room of Floor ${tp.floor + 1}`;
  const topUid = [...tp.byMob.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const m = mobPhrase(topUid !== undefined ? refFor(d, topUid) : d.starMob);

  if (tp.advDeaths.length > 0) {
    const who = listNames(tp.advDeaths);
    return fill(rng, [
      `${cap(where)} is where ${who} stopped, and where the rest of them started doing arithmetic.`,
      `It came apart in ${where}: ${m} got through, ${who} went down, and the survivors did not look at the body twice.`,
      `${cap(where)} took ${who} off the roster. ${cap(m)} has been in a good mood since.`,
      `They lost ${who} in ${where} — ${tp.dmgTaken} damage came through that door and not all of it was survivable.`,
    ]);
  }

  return fill(rng, [
    `It turned in ${where}, where ${m} put ${tp.dmgTaken} damage through them in a single stand.`,
    `${cap(m)} held ${where} long enough to change their plans entirely — ${tp.dmgTaken} damage, and a much quieter party afterwards.`,
    `${cap(where)} is where the arithmetic stopped working: ${tp.dmgTaken} damage taken, nobody laughing after.`,
    `The worst of it was ${where}. ${cap(m)} did ${tp.dmgTaken} damage and asked for nothing in return.`,
  ]);
}

function kitBeat(d: RaidDigest, rng: Rng): string {
  const m = mobPhrase(d.kitStripper);
  const n = d.kitStripped;

  if (d.dryRest && n >= 2) {
    return fill(rng, [
      `${cap(m)} spent the fight opening packs rather than throats — ${n} lots of supplies gone — so when they sat down at the landing there was nothing to sit down with.`,
      `They lost ${n} kit to ${m}. The wounds would have healed; the potions did not come back, and the landing was a very quiet place after that.`,
      `${n} supplies torn open by ${m}, and then a rest that restored nothing at all. That is the win condition working exactly as designed.`,
    ]);
  }
  if (d.dryRest) {
    return fill(rng, [
      `They reached the landing, sat down, and found they had nothing left to sit down with.`,
      `The rest did nothing — empty packs make a landing into a corridor with better lighting.`,
      `No supplies left to rest on. Damage stops evaporating the moment the bag is empty.`,
    ]);
  }
  return fill(rng, [
    `${cap(m)} went through ${n} of their supplies, which they will feel later rather than now.`,
    `${n} lots of kit destroyed by ${m} — quietly the most expensive thing that happened to them.`,
    `${cap(m)} took ${n} supplies out of the party's hands. Nobody bleeds from that, and everybody suffers for it.`,
  ]);
}

function resolveBeat(d: RaidDigest, rng: Rng): string {
  if (d.retreatReason === 'resolve') {
    return fill(rng, [
      `Their nerve went before their health did — they turned round with plenty of blood left in them and none of the appetite.`,
      `Nobody was dying. They left anyway, which is what happens when the dark does the work for you.`,
      `The party broke on morale, not on wounds. Cheapest kind of win we sell.`,
    ]);
  }
  return fill(rng, [
    `Something down there worked on their nerve for a while, and it showed in how fast they took the stairs back up.`,
    `They spent a good stretch flinching at things rather than fighting them.`,
  ]);
}

/** The name of a trap, or a serviceable noun if the roster has moved on. */
function trapName(defId: string | null): string {
  return (defId && TRAPS[defId]?.name) || 'something mechanical';
}

/**
 * The machinery did some of the work tonight.
 *
 * Kept to one sentence and pitched at the ledger, because a trap is the part
 * of the dungeon with no personality — that is the joke, and it is also the
 * design: monsters are units, traps are overheads that occasionally pay off.
 */
function trapBeat(d: RaidDigest, rng: Rng): string {
  const t = trapName(d.topTrap ?? d.trapsFired[0]?.defId ?? null);
  const fired = d.trapsFired.reduce((s, x) => s + x.times, 0);

  if (d.trapKit > 0) {
    return fill(rng, [
      `The ${t} took ${countWord(d.trapKit)} lots of supplies off them before anything in the room had moved. No blood, no upkeep, no argument.`,
      `${countWord(d.trapKit)} of their kit went into the ${t}. It cost us a re-arming fee and nothing else, which is the sort of bargain we like.`,
      `The ${t} did what it is there for: ${countWord(d.trapKit)} supplies spoiled on the threshold, and a much shorter delve as a result.`,
    ]);
  }
  if (d.trapHeld > 0) {
    return fill(rng, [
      `The ${t} held them still for ${countWord(d.trapHeld)} ticks while everything in the room kept working. A net does no damage and wins the fight anyway.`,
      `They spent ${countWord(d.trapHeld)} ticks in the ${t}, unable to swing at anything, being swung at throughout.`,
      `The ${t} did not hurt anybody. It simply arranged for them to stand still while something else did.`,
    ]);
  }
  if (d.trapDmg >= 12) {
    return fill(rng, [
      `The ${t} opened the room for ${d.trapDmg} damage before a single monster had to earn its keep.`,
      `${d.trapDmg} damage came out of the ${t} — no upkeep, no levels, no funeral. It will be there next raid too.`,
      `The ${t} took ${d.trapDmg} out of them on the threshold. Cheapest hit points we sell.`,
    ]);
  }
  return fill(rng, [
    `The machinery went off ${fired === 1 ? 'once' : `${countWord(fired)} times`} and made rather less impression than the brochure promised.`,
    `The ${t} triggered on cue and did very little. It still needs re-arming.`,
    `${cap(countWord(fired))} trap${fired === 1 ? '' : 's'} fired. Nobody down there seemed especially inconvenienced.`,
  ]);
}

/** The player spent a Ley Charge to fire a trap out of sequence (§7.4). */
function springBeat(d: RaidDigest, rng: Rng): string {
  const t = trapName(d.sprung!.defId);
  const where = `Floor ${d.sprung!.floor + 1}`;
  return fill(rng, [
    `We sprung the ${t} early, out of sequence, while they were still busy. Nobody had planned for the ${where} machinery to go off from over there.`,
    `A Ley Charge went on triggering the ${t} at a moment of our choosing rather than theirs. That is what the charge is for.`,
    `The ${t} on ${where} was never going to see them at this rate, so we fired it anyway. Waste not.`,
    `We reached over and set the ${t} off mid-fight. Very little of the dungeon is a surprise twice; timing is what is left.`,
  ]);
}

function commerceBeat(d: RaidDigest, rng: Rng): string {
  const g = d.purchaseGold;
  const shop = d.topAmenity && AMENITIES[d.topAmenity as keyof typeof AMENITIES]
    ? AMENITIES[d.topAmenity as keyof typeof AMENITIES].name
    : 'the counter';
  return fill(rng, [
    `On the way through they handed over ${g}g at the ${shop}, which is the most cooperative thing anyone did all night.`,
    `${g}g came over the counter at the ${shop}. It out-earned half the roster and never took a scratch.`,
    `They paid ${g}g for comforts at the ${shop} and then complained about the danger, in that order.`,
    `${g}g of their money stayed here. They bought it willingly, which is the part that never stops being funny.`,
    `Takings at the ${shop}: ${g}g. Every coin of it is a coin we did not have to kill anyone for.`,
  ]);
}

function interventionBeat(d: RaidDigest, rng: Rng): string {
  const m = mobPhrase(d.interventions[0]);
  return fill(rng, [
    `We pulled ${m} out of a fight it was losing. The room stood empty after that, but the levels are still ours.`,
    `${cap(m)} was walked out mid-fight. Cowardice is cheaper than recruitment.`,
    `A Ley Charge went on getting ${m} clear before the finish. Worth it — that thing took years to grow.`,
  ]);
}

function tauntBeat(d: RaidDigest, rng: Rng): string {
  if (d.breachHearts !== null) {
    return fill(rng, [
      `They were leaving. We goaded them into one more floor, and that floor turned out to be the last thing between them and the Core.`,
      `Taunting them was a decision. It is now a Heart we do not have.`,
      `We told them there was more below. There was. They took it.`,
    ]);
  }
  if (d.killsAfterTaunt > 0) {
    return fill(rng, [
      `They were halfway out when the dungeon found something to say — and ${countWord(d.killsAfterTaunt)} of them never got back to the stair.`,
      `They were leaving. We suggested otherwise, and the suggestion proved fatal for ${countWord(d.killsAfterTaunt)} of them.`,
      `One more floor, at our invitation. It cost them ${countWord(d.killsAfterTaunt)} and cost us a Ley Charge.`,
    ]);
  }
  return fill(rng, [
    `They were on their way out when we goaded them into one more floor. They cleared it, walked home, and told everyone.`,
    `We taunted them deeper. They survived the extra floor, which is annoying and also excellent for business.`,
    `One more floor, forced. Nobody died for it, but nobody will forget it either.`,
  ]);
}

function deathsBeat(d: RaidDigest, rng: Rng): string {
  const names = listNames(d.deaths.map((x) => x.name));
  const gold = d.deaths.reduce((s, x) => s + x.gold, 0);

  // If the turning-point beat already read the roll of the dead, naming them a
  // second sentence later reads as a duplication bug rather than a flourish.
  // Keep the ledger, drop the roll-call.
  const alreadyNamed = new Set(d.turningPoint?.advDeaths ?? []);
  const fresh = d.deaths.filter((x) => !alreadyNamed.has(x.name));
  if (fresh.length === 0 && d.deaths.length > 0) {
    return fill(rng, [
      `${gold}g came back off the bodies. Killing them destroys most of what they carry, and it always will.`,
      `The bodies yielded ${gold}g between them — a poor exchange rate for a person, but it is the rate.`,
      `${gold}g salvaged, Souls in the ledger, and nobody left to complain about the service.`,
    ]);
  }
  // Some fell elsewhere: name only those, so the sentence adds information
  // rather than repeating the roll already read out.
  if (fresh.length > 0 && fresh.length < d.deaths.length) {
    const freshNames = listNames(fresh.map((x) => x.name));
    return fill(rng, [
      `${freshNames} did not make the stair either. ${gold}g recovered across all of them.`,
      `Add ${freshNames} to the count. ${gold}g came back between the lot.`,
      `${freshNames} went the same way, elsewhere in the dungeon. ${gold}g salvaged in total.`,
    ]);
  }

  if (d.deaths.length === 1) {
    const only = d.deaths[0]!;
    return fill(rng, [
      `${only.name} did not leave. ${only.gold}g of what he was carrying survived him; the rest went the way everything does down here.`,
      `We kept ${only.name}. ${only.gold}g came back with the body, which is a poor exchange rate for a person.`,
      `${only.name} stays. Souls in the ledger, ${only.gold}g in the pan, and one fewer mouth to tell the story.`,
    ]);
  }
  return fill(rng, [
    `${names} are staying. Permanently. ${gold}g was recoverable between them.`,
    `We kept ${names}. ${gold}g survived the process — killing them destroys most of what they carry, and it always will.`,
    `${cap(countWord(d.deaths.length))} did not come back up: ${names}. ${gold}g salvaged, reputation forfeited.`,
  ]);
}

function lossesBeat(d: RaidDigest, rng: Rng): string {
  const best = d.bestLost!;
  const m = mobPhrase(best);
  const veteran = best.level >= 4;

  if (d.slain.length === 1 && veteran) {
    return fill(rng, [
      `${cap(m)} does not get up again. ${best.level} levels of work, finished in one room, and there is no version of that we come out ahead on.`,
      `We lost ${m} for good. It had earned every one of those levels the slow way, and it went down holding a doorway.`,
      `${cap(m)} is gone — properly gone. Replacing the body is cheap; replacing the levels is not.`,
    ]);
  }
  if (d.slain.length === 1) {
    return fill(rng, [
      `${cap(m)} did not get back up afterwards, which most of them do.`,
      `We are one ${MOBS[best.defId]?.name ?? 'monster'} lighter than we were this morning.`,
      `${cap(m)} stayed down when the counting was done — the only one that did.`,
    ]);
  }
  const n = countWord(d.slain.length);
  return fill(rng, [
    `${cap(n)} of ours stayed down for good, ${m} among them.`,
    `We buried ${n}, including ${m}. Recruitment is cheap; the levels were not.`,
    `${cap(n)} permanent losses on our side — ${m} the one worth mourning.`,
  ]);
}

function heldBeat(d: RaidDigest, rng: Rng): string {
  const n = countWord(d.downed.length);
  return fill(rng, [
    `${cap(n)} of ours went down and every one of them got back up. A good night for the infirmary.`,
    `We lost ${n} to the floor and none to the grave — they were all standing again by the time the stair went quiet.`,
    `${cap(n)} knocked flat, nothing killed. The roster is intact and slightly annoyed.`,
  ]);
}

function levelUpBeat(d: RaidDigest, rng: Rng): string {
  const m = mobPhrase(d.levelUps[0]);
  const n = d.levelUps.length;
  if (n === 1) {
    return fill(rng, [
      `${cap(m)} came out of it a level better, which is the only raise anyone gets down here.`,
      `${cap(m)} learned something in there. It is bigger now, and it remembers.`,
      `A level for ${m}. Nobody said thank you and it did not seem to mind.`,
    ]);
  }
  return fill(rng, [
    `${cap(countWord(n))} of ours came up a level on the strength of it, ${m} included.`,
    `The floor paid for itself in experience: ${countWord(n)} promotions, with ${m} at the front of the queue.`,
  ]);
}

function nemesisBeat(d: RaidDigest, rng: Rng): string {
  const n = d.rivalry.nemesis!;
  const rank = n.rank > 0 ? `Rank ${n.rank}` : 'a full rank above where they started';
  return fill(rng, [
    `${n.name} is a Nemesis now — ${rank}, back again, and using our own floors against us.`,
    `We have made ${n.name} into a problem. ${cap(rank)}, and everything they know about this place they learned here, for free.`,
    `${n.name} came back at ${rank}. Every escape has been a lesson and we have been the tutor.`,
  ]);
}

function patronBeat(d: RaidDigest, rng: Rng): string {
  const p = d.rivalry.patron!;
  return fill(rng, [
    `${p.name} is a Patron by now, and spent like one. Killing that is possible; it is just bad accounting.`,
    `${p.name} shopped here again — a regular, at this point, and worth more with a pulse.`,
    `${p.name} came down with a full purse and left with an empty one, as is the arrangement.`,
  ]);
}

function learnedBeat(d: RaidDigest, rng: Rng): string {
  const l = d.rivalry.learned!;
  const lesson = LEARNED_LESSON[l.reason] ?? 'and they went home thinking hard about it';
  return fill(rng, [
    `${l.name} took a lesson up the stair with them, ${lesson}.`,
    `Whatever else happened, ${l.name} worked something out about this place — ${lesson}.`,
    `${l.name} leaves knowing more than they arrived with, ${lesson}.`,
  ]);
}

/**
 * `GrudgeReason` (§9.3) → what the adventurer will do about it next time.
 *
 * Keyed loosely on purpose: an unrecognised reason falls through to a generic
 * line rather than breaking the sentence, so the rivalry system can add new
 * reasons without this file needing to ship at the same time.
 */
const LEARNED_LESSON: Record<string, string> = {
  supplies: 'and next time the packs will be deeper',
  nerve: 'and next time the dark will not move them',
  muscle: 'and next time they will bring something sized for our big ones',
  swarm: 'and next time they will bring something that clears a room at a stroke',
  coin: 'and next time they will walk past the counter without looking at it',
};

function nearMissBeat(d: RaidDigest, rng: Rng): string {
  const c = d.closest!;
  return fill(rng, [
    `${c.name} walked out at ${c.pct}% — close enough that the story tells itself, and they will tell it.`,
    `We had ${c.name} down to ${c.pct}%. One more room and it would have been Souls instead of reputation.`,
    `${c.name} left on ${c.pct}% of a person, and every point of that missing health is worth something to us.`,
    `${c.name} got within ${c.pct}% of never leaving. That is the number the tavern will hear about, repeatedly.`,
    `The best moment of the night was ${c.name} at ${c.pct}%, upright by a margin nobody would call comfortable.`,
  ]);
}

function untroubledBeat(d: RaidDigest, rng: Rng): string {
  const c = d.closest!;
  return fill(rng, [
    `Nobody dropped below ${c.pct}%. They were never in danger and, worse, they know it.`,
    `The lowest anyone got was ${c.pct}%. That is not a delve, that is a walk with better lighting.`,
    `They left at ${c.pct}% and a straight face. There is no story in a straight face.`,
    `Not one of them got below ${c.pct}%. Whatever they tell people, it will be short.`,
  ]);
}

function breachBeat(d: RaidDigest, rng: Rng): string {
  const h = d.breachHearts!;
  const left = h > 0 ? `${countWord(h)} Heart${h === 1 ? '' : 's'} left` : 'nothing left to break';
  return fill(rng, [
    `They came all the way down and put hands on the Core. ${cap(left)}, and every one of them walked home to describe it.`,
    `The Core was breached. ${cap(left)} — and the people who did it are alive, articulate, and heading for the nearest tavern.`,
    `They reached the bottom. A Heart went with them; ${left}.`,
  ]);
}

function retirementBeat(d: RaidDigest, rng: Rng): string {
  const r = d.retired[0]!;
  if (d.retired.length === 1) {
    return fill(rng, [
      `${r.name} hung up the sword on the way out — Thrill ${r.thrill}, and a story to dine on for the rest of a natural life. They never come back, and the name stays on our wall.`,
      `That was ${r.name}'s last one. Thrill ${r.thrill} is enough to retire on, apparently, and the legend outlives the customer.`,
      `${r.name} is done. Thrill ${r.thrill}, one final delve, and a permanent line on the Legends board — worth more to us than they ever were alive and shopping.`,
    ]);
  }
  const names = listNames(d.retired.map((x) => x.name));
  return fill(rng, [
    `${names} all called it a career on the way out. ${countWord(d.retired.length)} Legends made in one night, and ${countWord(d.retired.length)} customers lost forever.`,
    `${names} retired on the spot. The wall gets longer; the queue gets shorter.`,
  ]);
}

function verdictBeat(d: RaidDigest, rng: Rng): string {
  if (d.outcome === 'wiped') {
    return fill(rng, [
      `Nothing walked out — ${d.souls} Souls, and not one witness to earn us a scrap of reputation. Dead men tell no tales, and tales are the business.`,
      `A total wipe: ${d.souls} Souls in hand and zero Renown, because nobody survived to mention us.`,
      `They all stayed. ${d.souls} Souls, no story, no queue tomorrow.`,
    ]);
  }
  if (d.breachHearts !== null) {
    // A breach with nothing to show for it is the worst outcome in the game:
    // the Heart is gone and the delve was not even good enough to sell.
    if (d.renown <= 0) {
      return fill(rng, [
        `They walked the whole dungeon and were never once in trouble doing it — Thrill ${d.thrill}, no Renown, and a Heart gone anyway. That is the bill for a place with nothing in it.`,
        `Thrill ${d.thrill}, ${d.renown} Renown, one Heart lighter. We paid full price for an experience nobody had.`,
        `Nothing earned and a Heart spent. They were not frightened, they were just thorough.`,
      ]);
    }
    return fill(rng, [
      `${d.renown} Renown out of it, which is a great deal of reputation for something we would very much like not to repeat.`,
      `Thrill ${d.thrill} and ${d.renown} Renown. Expensive advertising.`,
      `They took ${d.renown} Renown and a Heart up the stair with them. Only one of those grows back.`,
    ]);
  }

  const why = retreatPhrase(d.retreatReason);
  if (d.thrill >= 45) {
    return fill(rng, [
      `They turned back ${why} and carried ${d.renown} Renown up the stair with them — Thrill ${d.thrill}, and the queue outside gets longer for it.`,
      `Out ${why}, alive, and talking: Thrill ${d.thrill}, ${d.renown} Renown, and a much worse class of visitor arriving next.`,
      `Thrill ${d.thrill}. They left ${why}, and the ${d.renown} Renown they took with them is the bill coming due later.`,
    ]);
  }
  if (d.thrill >= 20) {
    return fill(rng, [
      `They left ${why}. Thrill ${d.thrill}, ${d.renown} Renown — a serviceable night, if not one anybody writes down.`,
      `Out ${why}, with Thrill ${d.thrill} and ${d.renown} Renown between them. The dungeon works; it does not yet impress.`,
      `Thrill ${d.thrill} and ${d.renown} Renown. They will mention us, briefly, to people who ask.`,
    ]);
  }
  return fill(rng, [
    `They left ${why}, unimpressed. Thrill ${d.thrill} and ${d.renown} Renown — barely worth the upkeep.`,
    `Out ${why}. Thrill ${d.thrill}. Nobody is going to make a song of that, and nobody is going to queue for it either.`,
    `Thrill ${d.thrill}, ${d.renown} Renown, ${why}. The dungeon needs something in it worth surviving.`,
  ]);
}

function retreatPhrase(r: RetreatReason | null): string {
  switch (r) {
    case 'hp': return 'too chewed up to go on';
    case 'kit': return 'with nothing left in the packs';
    case 'resolve': return 'with their nerve gone';
    case 'wiped': return 'in pieces';
    default: return 'when they had had enough';
  }
}

// ─── Small text helpers ──────────────────────────────────────────────────────

/**
 * Draw one phrasing from a pool.
 *
 * Every draw goes through the seeded Rng — this is the only source of variation
 * in the whole file, and the reason a raid reads differently from the one
 * before it without ever reading differently from itself.
 */
function fill(rng: Rng, pool: readonly string[]): string {
  return pool.length ? rng.pick(pool) : '';
}

const COUNT_WORDS = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

const ORDINAL_WORDS = [
  '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth',
];

function ordinalWord(n: number): string {
  const w = ORDINAL_WORDS[n];
  if (w) return w;
  const rem100 = n % 100;
  const suffix = rem100 >= 11 && rem100 <= 13
    ? 'th'
    : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function listNames(names: readonly string[]): string {
  if (names.length === 0) return 'nobody';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Name a monster the way the player thinks of it.
 *
 * Level is included from level 2 up, because a level-6 Ogre is a different
 * character from a fresh one — that difference is most of what makes losing a
 * grown monster hurt (§2, pillar 3).
 */
function mobPhrase(ref: MobRef | null | undefined, opts: { plural?: boolean } = {}): string {
  if (!ref) return opts.plural ? 'whatever we had in there' : 'something in the dark';
  const name = MOBS[ref.defId]?.name;
  if (!name) return opts.plural ? 'whatever we had in there' : 'something in the dark';
  if (opts.plural) return ref.level >= 2 ? `level-${ref.level} ${name}s` : `${name}s`;
  return ref.level >= 2 ? `the level-${ref.level} ${name}` : `the ${name}`;
}

function refFor(d: RaidDigest, uid: number): MobRef | null {
  if (d.starMob?.uid === uid) return d.starMob;
  return (
    d.slain.find((m) => m.uid === uid)
    ?? d.downed.find((m) => m.uid === uid)
    ?? d.levelUps.find((m) => m.uid === uid)
    ?? null
  );
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
