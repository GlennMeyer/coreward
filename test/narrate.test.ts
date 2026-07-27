/**
 * Narration tests (src/sim/narrate.ts).
 *
 * Two things are being defended here.
 *
 * 1. **Determinism.** The narrator lives under src/sim, so it is bound by the
 *    §13.2 rule: same raid, same words, forever, and `Math.random()` never.
 *    Without that, a replay would tell a different story than the raid it
 *    replays and a narration bug could not be filed with a seed.
 *
 * 2. **It reports the actual delve.** The whole point is that a near-miss reads
 *    differently from a stroll. Each distinctive case below is built as a raid
 *    with exactly one interesting thing in it, and the account has to find it.
 *
 * Fixtures are assembled by hand rather than typed as full sim structures on
 * purpose: the narrator reads a handful of fields defensively, and hand-built
 * fixtures keep these tests from breaking every time an unrelated field is
 * added to `RaidResult` or `Adventurer` elsewhere in the sim.
 */
import { describe, expect, it, vi } from 'vitest';
import { digestRaid, narrateRaid, type NarrationContext } from '../src/sim/narrate';
import { addMob, seasonWithFloors } from './helpers';
import { applyAftermath, startRaid } from '../src/sim/season';
import type {
  Adventurer, Party, RaidEvent, RaidResult, ThrillScore,
} from '../src/sim/types';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function thrill(over: Partial<ThrillScore> = {}): ThrillScore {
  return { total: 30, peril: 0.4, depth: 0.6, variety: 0.6, comfort: 0, tedium: 0, ...over };
}

function makeResult(over: Partial<RaidResult> = {}): RaidResult {
  const base = {
    outcome: 'retreated',
    formation: 'single-file',
    killed: 0,
    escaped: 3,
    goldFromSales: 0,
    goldFromCorpses: 0,
    souls: 0,
    renown: 24,
    thrill: thrill(),
    retired: [],
    rivals: [],
    mobsDowned: [],
    mobsLost: [],
    deepestFloorReached: 2,
    ticks: 120,
  };
  return { ...base, ...over } as unknown as RaidResult;
}

function adv(over: Partial<Adventurer> & { name: string }): Adventurer {
  const base = {
    id: 0, cls: 'fighter', level: 2, maxHp: 40, hp: 30, dmg: 6, armor: 1,
    maxResolve: 10, resolve: 8, gold: 20, greed: 0.05, alive: true,
    namedId: null, lowestHpPct: 0.8, veteranId: null,
  };
  return { ...base, ...over } as unknown as Adventurer;
}

function makeParty(members: Adventurer[]): Party {
  return { members, kit: 4, maxKit: 12, tier: 2 } as unknown as Party;
}

/** A plausible spine of events. Individual tests splice their own beats in. */
function baseEvents(over: RaidEvent[] = []): RaidEvent[] {
  return [
    { t: 0, type: 'raid-start', tier: 2, partySize: 3, formation: 'single-file' },
    { t: 0, type: 'floor-enter', floor: 0 },
    { t: 1, type: 'room-enter', floor: 0, room: 0 },
    { t: 2, type: 'attack', source: 'mob', uid: 1, targetId: 0, dmg: 9 },
    { t: 3, type: 'attack', source: 'adv', advId: 0, targetUid: 1, dmg: 7 },
    { t: 4, type: 'room-clear', floor: 0, room: 0 },
    ...over,
    { t: 40, type: 'raid-end', outcome: 'retreated' },
  ];
}

function ctx(over: Partial<NarrationContext> = {}): NarrationContext {
  return {
    events: baseEvents(),
    result: makeResult(),
    party: makeParty([adv({ id: 0, name: 'Bess the Bold' })]),
    ...over,
  };
}

// ─── Determinism (§13.2) ─────────────────────────────────────────────────────

describe('narration is deterministic', () => {
  it('gives the same account for the same raid, every time', () => {
    const c = ctx();
    const first = narrateRaid(c);
    for (let i = 0; i < 20; i++) {
      const again = narrateRaid(ctx());
      expect(again.text).toBe(first.text);
      expect(again.headline).toBe(first.headline);
    }
  });

  it('never touches Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    try {
      // A busy raid, so as many phrasing pools as possible get drawn from.
      narrateRaid(ctx({
        events: baseEvents([
          { t: 10, type: 'landing-enter', landing: 0 },
          { t: 11, type: 'purchase', landing: 0, amenity: 'hotspring', advId: 0, gold: 12, detail: '+8 HP' },
          { t: 12, type: 'taunt-offer', landing: 0, reason: 'hp' },
          { t: 13, type: 'taunt-used', landing: 0 },
          { t: 20, type: 'room-enter', floor: 1, room: 0 },
          { t: 21, type: 'attack', source: 'mob', uid: 5, targetId: 0, dmg: 30 },
          { t: 22, type: 'kit-strip', uid: 5, amount: 1, kitLeft: 0 },
          { t: 23, type: 'adv-death', advId: 1, name: 'Pike Quickhand', goldDropped: 6 },
          { t: 24, type: 'mob-slain', uid: 5, defId: 'ogre', level: 6 },
        ]),
        result: makeResult({ killed: 1, mobsLost: [{ uid: 5, defId: 'ogre', level: 6 }] }),
      }));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('narrates a real replayed raid identically', () => {
    const tell = (): string => {
      const s = seasonWithFloors(4242, 2);
      s.mana = 900;
      addMob(s.dungeon, 'skeleton', 0, 0);
      addMob(s.dungeon, 'ogre', 1, 0);
      const sim = startRaid(s);
      const events: RaidEvent[] = [];
      while (sim.status !== 'complete') {
        events.push(...sim.step());
        if (sim.status === 'awaiting-taunt') events.push(...sim.resolveTaunt(false));
      }
      const a = applyAftermath(s, sim);
      return narrateRaid({
        events, result: a.result, party: sim.party,
        dungeon: s.dungeon, veterans: s.veterans,
      }).text;
    };
    expect(tell()).toBe(tell());
  });

  it('varies the phrasing when the seed changes', () => {
    const texts = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) texts.add(narrateRaid(ctx({ seed })).text);
    // Same raid, different phrasing seeds: the pools have to be deep enough
    // that repeat raids do not read identically.
    expect(texts.size).toBeGreaterThan(6);
  });

  it('varies across genuinely different raids', () => {
    const texts = new Set<string>();
    for (let i = 0; i < 12; i++) {
      texts.add(narrateRaid(ctx({
        result: makeResult({ renown: 20 + i, ticks: 100 + i }),
      })).text);
    }
    expect(texts.size).toBeGreaterThan(6);
  });
});

// ─── Shape ───────────────────────────────────────────────────────────────────

describe('narration shape', () => {
  it('is three to six sentences, opening and closing included', () => {
    const n = narrateRaid(ctx());
    expect(n.sentences.length).toBeGreaterThanOrEqual(3);
    expect(n.sentences.length).toBeLessThanOrEqual(6);
    expect(n.beats[0]).toBe('arrival');
    expect(n.beats[n.beats.length - 1]).toBe('verdict');
    expect(n.text).toBe(n.sentences.join(' '));
    expect(n.headline.length).toBeGreaterThan(0);
  });

  it('works from the event stream and result alone', () => {
    // The optional context sharpens the story; its absence must not break it.
    const n = narrateRaid({ events: baseEvents(), result: makeResult() });
    expect(n.sentences.length).toBeGreaterThanOrEqual(3);
    expect(n.text).not.toContain('undefined');
    expect(n.text).not.toContain('NaN');
  });

  it('survives an empty event stream', () => {
    const n = narrateRaid({ events: [], result: makeResult({ escaped: 0 }) });
    expect(n.sentences.length).toBeGreaterThanOrEqual(2);
    expect(n.text).not.toContain('undefined');
  });
});

// ─── The distinctive cases ───────────────────────────────────────────────────

describe('narration finds what was distinctive', () => {
  it('names the survivor who nearly died, and their low-water mark', () => {
    const n = narrateRaid(ctx({
      party: makeParty([
        adv({ id: 0, name: 'Bess the Bold', lowestHpPct: 0.83 }),
        adv({ id: 1, name: 'Corvin Coppertooth', lowestHpPct: 0.08 }),
      ]),
      result: makeResult({ thrill: thrill({ total: 62, peril: 0.92 }) }),
    }));
    expect(n.beats).toContain('near-miss');
    expect(n.text).toContain('Corvin Coppertooth');
    expect(n.text).toContain('8%');
    // The one who strolled is not the story.
    expect(n.beats).not.toContain('untroubled');
  });

  it('reads a safe delve as the anticlimax it was', () => {
    const n = narrateRaid(ctx({
      party: makeParty([adv({ id: 0, name: 'Bess the Bold', lowestHpPct: 0.96 })]),
      result: makeResult({ renown: 2, thrill: thrill({ total: 4, peril: 0.04 }) }),
    }));
    expect(n.beats).toContain('untroubled');
    expect(n.text).toContain('96%');
  });

  it('reads an empty dungeon as boredom', () => {
    const empty: RaidEvent[] = [{ t: 0, type: 'raid-start', tier: 1, partySize: 3, formation: 'single-file' }];
    for (let r = 0; r < 6; r++) {
      empty.push({ t: r * 2 + 1, type: 'room-enter', floor: Math.floor(r / 3), room: r % 3 });
      empty.push({ t: r * 2 + 2, type: 'room-clear', floor: Math.floor(r / 3), room: r % 3 });
    }
    empty.push({ t: 30, type: 'raid-end', outcome: 'retreated' });

    const n = narrateRaid(ctx({
      events: empty,
      result: makeResult({ renown: 0, thrill: thrill({ total: 0, peril: 0, tedium: 24 }) }),
    }));
    expect(n.beats).toContain('tedium');
    expect(digestRaid(ctx({ events: empty })).longestEmptyRun).toBe(6);
  });

  it('reports the machinery, and reads a trap room as occupied (§5.2)', () => {
    const events: RaidEvent[] = [
      { t: 0, type: 'raid-start', tier: 1, partySize: 3, formation: 'single-file' },
      { t: 1, type: 'room-enter', floor: 0, room: 0 },
      {
        t: 1, type: 'trap-fire', uid: 500, defId: 'gasvent',
        floor: 0, room: 0, sprung: false, chargesLeft: 0,
      },
      { t: 1, type: 'trap-kit', uid: 500, defId: 'gasvent', amount: 3, kitLeft: 4 },
      { t: 2, type: 'room-clear', floor: 0, room: 0 },
      { t: 3, type: 'raid-end', outcome: 'retreated' },
    ];
    const d = digestRaid(ctx({ events }));
    expect(d.trapKit).toBe(3);
    expect(d.topTrap).toBe('gasvent');
    // A trap going off is not an empty corridor.
    expect(d.emptyRooms).toBe(0);

    const n = narrateRaid(ctx({ events }));
    expect(n.beats).toContain('traps');
    expect(n.text).toContain('Rot-Gas Vent');
  });

  it('gives the Spring intervention its own beat (§7.4)', () => {
    const events: RaidEvent[] = [
      { t: 0, type: 'raid-start', tier: 2, partySize: 3, formation: 'single-file' },
      { t: 1, type: 'room-enter', floor: 0, room: 0 },
      {
        t: 4, type: 'trap-fire', uid: 501, defId: 'snare',
        floor: 1, room: 2, sprung: true, chargesLeft: 0,
      },
      { t: 4, type: 'trap-snare', uid: 501, defId: 'snare', ticks: 3 },
      { t: 9, type: 'raid-end', outcome: 'retreated' },
    ];
    const n = narrateRaid(ctx({ events }));
    expect(n.beats).toContain('spring');
    // The sprung beat replaces the generic one rather than doubling up.
    expect(n.beats).not.toContain('traps');
    expect(n.text).toContain('Snare Net');
  });

  it('calls out back-to-back identical rooms', () => {
    const same: RaidEvent[] = [
      { t: 0, type: 'raid-start', tier: 2, partySize: 3, formation: 'single-file' },
      { t: 1, type: 'room-enter', floor: 0, room: 0 },
      { t: 2, type: 'attack', source: 'mob', uid: 1, targetId: 0, dmg: 5 },
      { t: 3, type: 'room-clear', floor: 0, room: 0 },
      { t: 4, type: 'room-enter', floor: 0, room: 1 },
      { t: 5, type: 'attack', source: 'mob', uid: 2, targetId: 0, dmg: 5 },
      { t: 6, type: 'room-clear', floor: 0, room: 1 },
      { t: 7, type: 'raid-end', outcome: 'retreated' },
    ];
    const c = ctx({
      events: same,
      result: makeResult({
        mobsDowned: [
          { uid: 1, defId: 'skeleton', level: 1 },
          { uid: 2, defId: 'skeleton', level: 1 },
        ],
        thrill: thrill({ total: 10 }),
      }),
    });
    expect(digestRaid(c).repeatedMob?.defId).toBe('skeleton');
    expect(narrateRaid(c).beats).toContain('repetition');
  });

  it('finds the room where it went wrong', () => {
    const c = ctx({
      events: baseEvents([
        { t: 20, type: 'room-enter', floor: 1, room: 2 },
        { t: 21, type: 'attack', source: 'mob', uid: 9, targetId: 1, dmg: 34 },
        { t: 22, type: 'adv-death', advId: 1, name: 'Pike Quickhand', goldDropped: 5 },
      ]),
      result: makeResult({
        killed: 1, escaped: 2,
        mobsDowned: [{ uid: 9, defId: 'ogre', level: 5 }],
      }),
    });
    const d = digestRaid(c);
    expect(d.turningPoint?.floor).toBe(1);
    expect(d.turningPoint?.room).toBe(2);

    const n = narrateRaid(c);
    expect(n.beats).toContain('turning-point');
    // Floors and rooms are 1-indexed in prose; nobody says "room zero".
    expect(n.text).toContain('third room of Floor 2');
    expect(n.text).toContain('Pike Quickhand');
  });

  it('treats a grown monster as a character when it dies', () => {
    const n = narrateRaid(ctx({
      events: baseEvents([{ t: 30, type: 'mob-slain', uid: 7, defId: 'ogre', level: 6 }]),
      result: makeResult({
        mobsDowned: [{ uid: 7, defId: 'ogre', level: 6 }],
        mobsLost: [{ uid: 7, defId: 'ogre', level: 6 }],
      }),
    }));
    expect(n.beats).toContain('losses');
    expect(n.text).toContain('level-6 Ogre');
  });

  it('mourns the biggest loss, not the first one in the list', () => {
    const d = digestRaid(ctx({
      result: makeResult({
        mobsLost: [
          { uid: 1, defId: 'rat', level: 1 },
          { uid: 2, defId: 'ogre', level: 1 },
        ],
      }),
    }));
    expect(d.bestLost?.defId).toBe('ogre');
  });

  it('reports a Kit strip that stranded them', () => {
    const c = ctx({
      events: baseEvents([
        { t: 10, type: 'kit-strip', uid: 3, amount: 1, kitLeft: 2 },
        { t: 11, type: 'kit-strip', uid: 3, amount: 1, kitLeft: 1 },
        { t: 12, type: 'kit-strip', uid: 3, amount: 1, kitLeft: 0 },
        { t: 13, type: 'landing-enter', landing: 0 },
        { t: 14, type: 'rest', hpRestored: 0, kitSpent: 0, kitLeft: 0 },
      ]),
      result: makeResult({ mobsDowned: [{ uid: 3, defId: 'ooze', level: 2 }] }),
    });
    const d = digestRaid(c);
    expect(d.kitStripped).toBe(3);
    expect(d.dryRest).toBe(true);
    expect(d.kitStripper?.defId).toBe('ooze');

    const n = narrateRaid(c);
    expect(n.beats).toContain('kit');
    expect(n.text).toContain('Rust Ooze');
  });

  it('reports a Taunt, and whether it paid', () => {
    const events = baseEvents([
      { t: 10, type: 'taunt-offer', landing: 0, reason: 'hp' },
      { t: 11, type: 'taunt-used', landing: 0 },
      { t: 20, type: 'room-enter', floor: 1, room: 0 },
      { t: 21, type: 'adv-death', advId: 1, name: 'Pike Quickhand', goldDropped: 4 },
    ]);
    const d = digestRaid(ctx({ events }));
    expect(d.tauntUsed).toBe(true);
    expect(d.killsAfterTaunt).toBe(1);

    const n = narrateRaid(ctx({ events, result: makeResult({ killed: 1, escaped: 2 }) }));
    expect(n.beats).toContain('taunt');
  });

  it('reports a Core breach as the disaster it is', () => {
    const n = narrateRaid(ctx({
      events: baseEvents([{ t: 30, type: 'core-breach', heartsLeft: 2, lootPct: 0.35 }]),
      result: makeResult({ outcome: 'breach', thrill: thrill({ total: 40 }) }),
    }));
    expect(n.beats).toContain('breach');
    expect(n.text).toContain('Core');
    expect(n.text).toMatch(/two hearts/i);
  });

  it('celebrates a retirement', () => {
    const n = narrateRaid(ctx({
      result: makeResult({
        thrill: thrill({ total: 58 }),
        retired: [{ name: 'Vessa Farwalker', thrill: 58, retiredOnRaid: 4 }],
      }),
    }));
    expect(n.beats).toContain('retirement');
    expect(n.text).toContain('Vessa Farwalker');
  });

  it('says nobody is left to tell the tale on a wipe', () => {
    const n = narrateRaid(ctx({
      party: makeParty([adv({ id: 0, name: 'Bess the Bold', alive: false, lowestHpPct: 0 })]),
      events: baseEvents([{ t: 30, type: 'adv-death', advId: 0, name: 'Bess the Bold', goldDropped: 3 }]),
      result: makeResult({
        outcome: 'wiped', killed: 3, escaped: 0, souls: 9, renown: 0,
        thrill: thrill({ total: 0, peril: 0 }),
      }),
    }));
    expect(n.text).toMatch(/Souls/);
    expect(n.headline.length).toBeGreaterThan(0);
    expect(n.beats).not.toContain('near-miss');
  });

  it('mentions the takings when they shopped', () => {
    const n = narrateRaid(ctx({
      events: baseEvents([
        { t: 10, type: 'landing-enter', landing: 0 },
        { t: 11, type: 'purchase', landing: 0, amenity: 'provisioner', advId: 0, gold: 18, detail: '+3 Kit' },
        { t: 12, type: 'purchase', landing: 0, amenity: 'hotspring', advId: 0, gold: 8, detail: '+9 HP' },
      ]),
      result: makeResult({ goldFromSales: 26, thrill: thrill({ total: 20 }) }),
    }));
    expect(n.beats).toContain('commerce');
    expect(n.text).toContain('26g');
    expect(n.text).toContain('Provisioner');
  });

  it('names a named adventurer and a returning veteran', () => {
    const named = narrateRaid(ctx({
      party: makeParty([adv({ id: 0, name: 'Berrick the Unfed', namedId: 'berrick' })]),
    }));
    expect(named.text).toContain('Berrick the Unfed');

    const returning = narrateRaid(ctx({
      party: makeParty([adv({ id: 0, name: 'Orla the Patient', veteranId: 3 })]),
      veterans: [{
        id: 3, name: 'Orla the Patient', cls: 'ranger', delves: 5,
        bestThrill: 50, retired: false,
      } as never],
    }));
    expect(returning.text).toContain('Orla the Patient');
    // `delves` counts delves SURVIVED and increments after the raid, so a
    // veteran arriving with 5 is here for their sixth time.
    expect(returning.text).toContain('sixth');
  });
});

// ─── Graceful degradation ────────────────────────────────────────────────────

describe('narration reads the roster defensively', () => {
  it('ignores rivalry fields that are not there', () => {
    const d = digestRaid(ctx());
    expect(d.rivalry).toEqual({ nemesis: null, patron: null, learned: null });
  });

  it('uses rivalry fields when the sim provides them', () => {
    // Written as loose extra properties on purpose: the Nemesis/Patron system
    // (§9.3, §9.4) is owned elsewhere and the narrator must not depend on the
    // exact shape it settles on.
    const member = {
      ...adv({ id: 0, name: 'Sable Redcloak' }),
      isNemesis: true, rank: 2, grudge: 'supplies',
    } as unknown as Adventurer;

    const d = digestRaid(ctx({ party: makeParty([member]) }));
    expect(d.rivalry.nemesis).toEqual({ name: 'Sable Redcloak', rank: 2 });
    expect(d.rivalry.learned).toEqual({ name: 'Sable Redcloak', reason: 'supplies' });

    const n = narrateRaid(ctx({ party: makeParty([member]) }));
    expect(n.beats).toContain('nemesis');
    expect(n.text).toContain('Sable Redcloak');
  });

  it('does not credit a grudge to a corpse', () => {
    const dead = {
      ...adv({ id: 0, name: 'Tam of Ashfen', alive: false }),
      grudge: 'nerve',
    } as unknown as Adventurer;
    expect(digestRaid(ctx({ party: makeParty([dead]) })).rivalry.learned).toBeNull();
  });
});

// ─── Formation (§7.2) ────────────────────────────────────────────────────────

describe('the narrator reads the marching order', () => {
  /** A delve where the queue rotated twice under fire. */
  const queued: RaidEvent[] = [
    { t: 0, type: 'raid-start', tier: 1, partySize: 3, formation: 'single-file' },
    { t: 0, type: 'floor-enter', floor: 0 },
    { t: 1, type: 'room-enter', floor: 0, room: 0 },
    { t: 1, type: 'line-engage', advId: 0, waiting: 2 },
    { t: 4, type: 'attack', source: 'mob', uid: 1, targetId: 0, dmg: 14 },
    { t: 5, type: 'line-break', advId: 0, hpPct: 0.18, next: 1 },
    { t: 5, type: 'line-engage', advId: 1, waiting: 2 },
    { t: 9, type: 'line-break', advId: 1, hpPct: 0.27, next: 2 },
    { t: 9, type: 'line-engage', advId: 2, waiting: 2 },
    { t: 12, type: 'retreat', reason: 'hp' },
    { t: 12, type: 'raid-end', outcome: 'retreated' },
  ];

  const trio = () => makeParty([
    adv({ id: 0, name: 'Bess the Bold' }),
    adv({ id: 1, name: 'Corvin Quickhand' }),
    adv({ id: 2, name: 'Orla Redcloak' }),
  ]);

  it('digests who held the door and how far they were pushed', () => {
    const d = digestRaid(ctx({ events: queued, party: trio() }));
    expect(d.formation).toBe('single-file');
    expect(d.lineBreaks).toBe(2);
    expect(d.pointMen).toEqual(['Bess the Bold', 'Corvin Quickhand', 'Orla Redcloak']);
    expect(d.hardestStand).toEqual({ name: 'Bess the Bold', pct: 18 });
  });

  it('gives a rotating queue its own beat, naming the hardest stand', () => {
    const n = narrateRaid(ctx({ events: queued, party: trio() }));
    expect(n.beats).toContain('line');
    expect(n.text).toContain('Bess the Bold');
    expect(n.text).toContain('18%');
  });

  it('says nothing about the line when nobody was pushed out of it', () => {
    const d = digestRaid(ctx());
    expect(d.lineBreaks).toBe(0);
    expect(narrateRaid(ctx()).beats).not.toContain('line');
  });

  it('makes the first coordinated party a milestone, headline and all', () => {
    const together: RaidEvent[] = [
      { t: 0, type: 'raid-start', tier: 4, partySize: 4, formation: 'party' },
      { t: 1, type: 'room-enter', floor: 0, room: 0 },
      { t: 2, type: 'attack', source: 'mob', uid: 1, targetId: 0, dmg: 9 },
      { t: 6, type: 'raid-end', outcome: 'retreated' },
    ];
    const c = ctx({
      events: together,
      party: trio(),
      result: makeResult({ formation: 'party' }),
      formationDebut: true,
    });
    const n = narrateRaid(c);
    expect(digestRaid(c).formationDebut).toBe(true);
    expect(n.beats).toContain('formation-debut');
    expect(n.headline).toMatch(/compan|queue|popular/i);

    // The same raid, once it is no longer news, does not get the beat.
    const later = narrateRaid({ ...c, formationDebut: false });
    expect(later.beats).not.toContain('formation-debut');
  });

  it('opens differently for a queue and for a company', () => {
    const open = (formation: 'single-file' | 'party') => narrateRaid(ctx({
      events: [
        { t: 0, type: 'raid-start', tier: 3, partySize: 3, formation },
        { t: 1, type: 'room-enter', floor: 0, room: 0 },
        { t: 5, type: 'raid-end', outcome: 'retreated' },
      ],
      party: trio(),
      result: makeResult({ formation }),
    })).sentences[0]!;
    expect(open('single-file')).not.toBe(open('party'));
  });

  it('still narrates identically for the same raid, formation and all', () => {
    const c = () => ctx({ events: queued, party: trio() });
    const first = narrateRaid(c());
    for (let i = 0; i < 10; i++) expect(narrateRaid(c()).text).toBe(first.text);
  });
});
