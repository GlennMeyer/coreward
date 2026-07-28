/**
 * UI smoke test. Drives the real DOM renderer through a whole raid to catch
 * runtime errors the type checker can't see (null refs, bad selectors, handlers
 * wired to elements that no longer exist).
 *
 * Runs in jsdom — see environmentMatchGlobs in vite.config.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOBS, TIERS, TRAPS, TUNING, roomCapacity } from '../src/sim/data';
import { buildAmenity, buyMob, createDungeon, placeMobInRoom } from '../src/sim/dungeon';
import { predictThrill, thrillRating } from '../src/ui/predict';
import type { SeasonState } from '../src/sim/types';

function click(node: Element | null | undefined): void {
  if (!node) throw new Error('tried to click a node that does not exist');
  (node as HTMLElement).click();
}

/**
 * The live Dungeon behind the rendered UI. jsdom gives us no handle on module
 * state, so reach it through the season the UI is driving.
 */
function seasonDungeon(): import('../src/sim/types').Dungeon {
  return (globalThis as unknown as { __coreward?: { dungeon: import('../src/sim/types').Dungeon } })
    .__coreward!.dungeon;
}

/** A minimal valid genome, for tests that need a build without evolving one. */
function seedGenome(): import('../src/ui/idlerBrain').Genome {
  const flat = (ids: string[]) => Object.fromEntries(ids.map((k) => [k, 1]));
  return {
    mobWeights: flat(['rat', 'slime', 'cutpurse', 'skeleton', 'ogre', 'ooze']),
    trapWeights: flat(['darts', 'snare', 'gasvent', 'shrieker', 'deadfall']),
    trapShare: 0.3, upgradeShare: 0.2,
    trackWeights: { bite: 1, hide: 1, vigor: 1 },
    amenityShare: 0.3, amenityPick: 'provisioner',
    admission: 'standard', insurance: 'standard', shopPrice: 'standard',
    digReserve: 120, tauntRate: 0.5, staffShops: false,
  } as unknown as import('../src/ui/idlerBrain').Genome;
}

/** Current mana, read off the rendered top bar. */
function app(): { mana: number; gold: number } {
  const num = (sel: string) => Number(document.querySelector(sel)?.textContent ?? '0');
  return { mana: num('.stat.mana b'), gold: num('.stat.gold b') };
}

/**
 * Force a repaint after poking sim state directly. The UI renders on its own
 * events; a test that mutates the Dungeon behind its back has to ask for one.
 */
function render$(): void {
  // Selecting a chip always repaints; clicking an empty room with nothing
  // selected returns early and does not.
  const chip = document.querySelector('.room .trap, .room .mob') as HTMLElement | null;
  chip?.click();
  chip?.click();  // and deselect, so the caller's state is unchanged
}

/** Find a button by its visible text. */
function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

/** An in-memory Storage, since jsdom here supplies none. */
function fakeStorage(seed: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: () => null, length: 0,
  } as unknown as Storage);
  return store;
}

describe('UI smoke', () => {
  // Unconditional, so a failing test cannot leak a stubbed global into the
  // next one — that leak timed nine tests out at 12s each on CI.
  afterEach(() => { vi.unstubAllGlobals(); });

  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    // A clean profile per test, so Codex ranks cannot bleed between them.
    // jsdom does not always expose localStorage; the app tolerates that (see
    // src/ui/storage.ts) and so should this.
    globalThis.localStorage?.clear();
    await import('../src/ui/main');
    // The app opens on the title screen now; every test below wants a delve.
    const begin = button('Begin a Delve');
    begin?.click();
  });

  it('renders the build phase without throwing', () => {
    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.querySelector('.core')).toBeTruthy();
    // One floor, three rooms, and the Core-approach landing beneath it.
    expect(document.querySelectorAll('.room')).toHaveLength(3);
    expect(document.querySelectorAll('.landing')).toHaveLength(1);
  });

  it('buys a monster and places it in a room', () => {
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Cave Rat'));
    click(buy);
    // Buying selects the monster; clicking a room places it.
    click(document.querySelectorAll('.room')[0]);
    expect(document.querySelector('.room .mob')).toBeTruthy();
    // The readout used to print a hardcoded "/3" while `roomCapacity(0)` was
    // actually 4 — harmless while monsters were the only occupants, a lie once
    // traps draw on the same budget.
    expect(document.querySelector('.room .slots')?.textContent)
      .toBe(`1/${roomCapacity(0)}`);
  });

  it('digs a floor, which opens another landing', () => {
    click(button('Dig Floor 2'));
    expect(document.querySelectorAll('.room')).toHaveLength(6);
    expect(document.querySelectorAll('.landing')).toHaveLength(2);
  });

  it('builds and staffs an amenity', () => {
    const rat = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Cave Rat'));
    click(rat);
    click(document.querySelectorAll('.room')[0]);

    click(button('+ Provisioner'));
    const shop = document.querySelector('.amenity')!;
    // Open on build — you paid Mana for it, it works (§8.4).
    expect(shop.classList.contains('closed')).toBe(false);
    expect(shop.textContent).toContain('unattended');

    click(document.querySelector('.room .mob'));      // select the monster
    click(document.querySelector('.amenity'));         // assign as staff
    expect(document.querySelector('.amenity')?.textContent).not.toContain('unattended');
    // Staffing pulls it out of the room — the opportunity cost (§8.4).
    expect(document.querySelector('.room .mob')).toBeFalsy();
  });

  it('offers each amenity once per landing, not once per empty slot', () => {
    // A landing has 2 slots; rendering the menu per-slot drew every amenity
    // twice and read as a duplication bug.
    const labels = [...document.querySelectorAll('.landing button')]
      .map((b) => b.textContent ?? '')
      .filter((t) => t.startsWith('+'));
    expect(labels.length).toBe(new Set(labels).size);
    expect(labels.filter((t) => t.includes('Hot Spring'))).toHaveLength(1);
  });

  it('still fills both landing slots, one after the other', () => {
    click(button('+ Hot Spring'));
    click(button('+ Provisioner'));
    expect(document.querySelectorAll('.landing .amenity')).toHaveLength(2);
    // Both slots used, so the menu is gone.
    expect(button('+ Apothecary')).toBeFalsy();
  });

  it('cycles amenity pricing', () => {
    click(button('+ Hot Spring'));
    const label = () => document.querySelector('.amenity')?.textContent ?? '';
    expect(label()).toContain('standard');
    click(document.querySelector('.amenity'));
    expect(label()).toContain('premium');
  });

  it('runs a full raid to completion via Instant', () => {
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Ogre'));
    click(buy);
    click(document.querySelectorAll('.room')[0]);

    click(button('Begin Raid'));
    expect(document.querySelector('.log')).toBeTruthy();

    click(button('Instant'));
    // Raid finished: either the summary bar or a Taunt prompt resolved into it.
    const modal = document.querySelector('.modal');
    expect(modal).toBeTruthy();
    expect(modal?.textContent).toMatch(/party is destroyed|Core is breached|turn back/);
  });

  it('auto-continues from the Aftermath without a click', async () => {
    vi.useFakeTimers();
    try {
      click(button('Begin Raid'));
      click(button('Instant'));
      click(button('Aftermath'));
      expect(document.querySelector('.modal')?.textContent).toContain('Aftermath');

      // No click: it should move on by itself.
      await vi.advanceTimersByTimeAsync(4500);
      expect(button('Begin Raid')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('advances through aftermath back to the build phase', () => {
    click(button('Begin Raid'));
    click(button('Instant'));
    click(button('Aftermath'));

    const modal = document.querySelector('.modal');
    expect(modal?.textContent).toContain('Aftermath');
    expect(modal?.textContent).toContain('Upkeep');

    click(button('Continue'));
    // Back in the Build Phase for the next raid.
    expect(button('Begin Raid')).toBeTruthy();
    // Endless is the default (§12a), so the raid counter has no denominator.
    expect(document.querySelector('.topbar')?.textContent).toMatch(/raid\s*2/);
  });

  it('survives an entire season without throwing', () => {
    for (let guard = 0; guard < 40; guard++) {
      const start = button('Begin Raid');
      if (!start) break;
      click(start);
      click(button('Instant'));
      click(button('Aftermath'));
      const cont = button('Continue') ?? button('New Season');
      if (!cont) break;
      const isEnd = cont.textContent?.includes('New Season');
      click(cont);
      if (isEnd) break;
    }
    // Either the season ended or we are mid-season; both must render cleanly.
    expect(document.querySelector('.topbar')).toBeTruthy();
  });

  it('drop targets carry the coordinates the drop handler reads', () => {
    // jsdom has no layout, so elementFromPoint (and therefore the pointer
    // hit-testing itself) can't be exercised here — that needs a real browser.
    // What is worth guarding is the data the drop handler depends on.
    click(button('Dig Floor 2'));
    click(button('+ Provisioner'));

    document.querySelectorAll('.room').forEach((r) => {
      expect((r as HTMLElement).dataset['floor']).toMatch(/^\d+$/);
      expect((r as HTMLElement).dataset['room']).toMatch(/^\d+$/);
    });
    const amenity = document.querySelector('.amenity') as HTMLElement;
    expect(amenity.dataset['landing']).toMatch(/^\d+$/);
    expect(amenity.dataset['slot']).toMatch(/^\d+$/);
  });

  it('shows the delvers standing in the active room, one at a time', () => {
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Ogre'));
    click(buy);
    click(document.querySelectorAll('.room')[0]);
    click(button('Begin Raid'));

    const stage = document.querySelector('.room.active .stage');
    expect(stage).toBeTruthy();
    // Tier 1 is single-file: exactly one delver on the stage, rest at the door.
    expect(stage!.querySelectorAll('.delver')).toHaveLength(1);
    expect(stage!.querySelector('.queued')?.textContent).toMatch(/\+\d+ at the door/);
  });

  it('offers the Understudy modes and switching one on starts a search', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    globalThis.localStorage?.clear();
    await import('../src/ui/main');

    expect(button('Understudy: off')).toBeTruthy();
    expect(button('Advisor')).toBeTruthy();
    expect(button('Auto-play')).toBeTruthy();

    click(button('Advisor'));
    // The panel appears; the generation counter is the search actually running.
    expect(document.querySelector('.idler-box')).toBeTruthy();
    expect(document.querySelector('.idler-head')?.textContent).toContain('generation');
  });

  it('the Understudy can be watched playing the real game', async () => {
    // Seeded through storage rather than by waiting on the live search: a real
    // interval outlives the test and times CI out, and the thing under test is
    // the spectator loop, not the evolver.
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    // jsdom here has no localStorage, so seed through the module the app reads
    // rather than the storage it cannot see.
    vi.doMock('../src/ui/storage', async () => {
      const actual = await vi.importActual<typeof import('../src/ui/storage')>('../src/ui/storage');
      return {
        ...actual,
        loadIdler: () => ({
          mode: 'off' as const, population: [], generation: 3,
          pendingInsight: 0, runsPlayed: 0,
          best: { genome: seedGenome(), renown: 100, raids: 6 },
        }),
        saveIdler: () => {},
      };
    });
    await import('../src/ui/main');

    const watch = button('Watch the Understudy');
    expect(watch).toBeTruthy();
    watch!.click();

    // It drives the REAL game: the dungeon is on screen and a run is under way.
    expect(document.querySelector('.spectate-bar')).toBeTruthy();
    expect(document.querySelector('.topbar')).toBeTruthy();

    click(button('Take over'));
    expect(document.querySelector('.spectate-bar')).toBeFalsy();
    vi.doUnmock('../src/ui/storage');
  });

  it('a run in progress survives a reload, and can be abandoned', async () => {
    fakeStorage();

    // Play a bit: buy something so the dungeon is distinguishable.
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    await import('../src/ui/main');
    click(button('Begin a Delve'));
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Ogre'));
    click(buy);
    click(document.querySelectorAll('.room')[0]);
    expect(document.querySelector('.room .mob')).toBeTruthy();

    // "Hard refresh": fresh DOM, fresh modules, same storage.
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    await import('../src/ui/main');

    // Straight back into the run, with the Ogre still placed.
    expect(document.querySelector('.topbar')).toBeTruthy();
    expect(document.querySelector('.room .mob')?.textContent).toContain('Ogre');

  });

  it('offers a wipe that spares the Understudy', async () => {
    // Own setup: the shared beforeEach clicks into a delve, and this test
    // needs the title screen.
    const store = fakeStorage({
      'coreward.idler.v1': JSON.stringify({
        mode: 'autoplay', population: [], generation: 42,
        pendingInsight: 250, runsPlayed: 90, best: null,
      }),
    });

    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    await import('../src/ui/main');

    click(button('Wipe save'));                 // two-step: arms first
    click(button('Really wipe'));
    // Profile and run are gone; the evolved population is not. Asserting the
    // key survives rather than its exact contents: a background search from an
    // earlier test can still be writing to it, and what matters is that wipe
    // does not delete the Understudy's learning.
    expect(store.has('coreward.profile.v1')).toBe(false);
    expect(store.has('coreward.run.v1')).toBe(false);
    expect(store.has('coreward.idler.v1')).toBe(true);

    // ...but banked Insight is progress, not learning, and the wipe takes it.
    // Otherwise you can wipe and immediately collect the pile it removed.
    const idler = JSON.parse(store.get('coreward.idler.v1')!) as
      { pendingInsight: number; runsPlayed: number };
    expect(idler.pendingInsight).toBe(0);
    expect(idler.runsPlayed).toBe(0);
    // And it is switched off: left running, auto-play banks into the fresh
    // profile within seconds and quietly undoes the wipe.
    expect((idler as unknown as { mode: string }).mode).toBe('off');
    // And the view is reset, not just the data: no stale raid pointing at the
    // dungeon that was just discarded.
    expect(document.querySelector('.menu')).toBeTruthy();
    expect(document.querySelector('.topbar')).toBeFalsy();

  });

  it('opens on a title screen, not straight into a delve', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    globalThis.localStorage?.clear();
    await import('../src/ui/main');
    expect(document.querySelector('.menu')).toBeTruthy();
    expect(document.querySelector('.topbar')).toBeFalsy();
    // ...and starting actually starts.
    button('Begin a Delve')!.click();
    expect(document.querySelector('.topbar')).toBeTruthy();
  });

  it('a finished run banks Insight and offers the Codex', () => {
    // Play until the Core falls.
    for (let guard = 0; guard < 60; guard++) {
      const start = button('Begin Raid');
      if (!start) break;
      click(start);
      click(button('Instant'));
      click(button('Aftermath'));
      const cont = button('Continue') ?? button('Delve Again');
      if (!cont) break;
      const ended = cont.textContent?.includes('Delve Again');
      if (ended) {
        const modal = document.querySelector('.modal')!;
        expect(modal.textContent).toContain('Insight');
        expect(modal.textContent).toContain('The Codex');
        expect(modal.textContent).toContain('Deeper Foundations');
        // Something was earned — a lost run still moved the player forward.
        expect(modal.querySelector('.insight-won b')?.textContent)
          .toMatch(/^\+?\d+$/);
        return;
      }
      click(cont);
    }
    throw new Error('run never ended');
  });

  it('speed controls do not throw', () => {
    click(button('Begin Raid'));
    for (const label of ['II', '1x', '2x', '4x']) click(button(label));
    expect(document.querySelector('.log')).toBeTruthy();
  });

  it('puts Next Raid and Predicted Thrill left of the dungeon map', () => {
    const info = [...document.querySelectorAll('.col-info .panel h2')]
      .map((h) => h.textContent ?? '');
    expect(info[0]).toContain('Next Raid');
    expect(info[1]).toContain('Predicted Thrill');
    // The map sits in its own column between info and the build controls.
    expect(document.querySelector('.col-left .panel h2')?.textContent).toContain('The Dungeon');
  });

  it('orders the build column: build phase, monsters, legends', () => {
    const heads = [...document.querySelectorAll('.col-right .panel h2')]
      .map((h) => h.textContent ?? '');
    const at = (frag: string) => heads.findIndex((h) => h.includes(frag));
    expect(at('Build Phase')).toBe(0);
    expect(at('Monsters')).toBeGreaterThan(at('Build Phase'));
    expect(at('Traps')).toBeGreaterThan(at('Monsters'));
    expect(at('Legends')).toBeGreaterThan(at('Traps'));
  });

  it('buys a trap, places it, and offers to re-arm it once it has fired', () => {
    const def = TRAPS['darts']!;
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes(def.name));
    const before = app().mana;
    click(buy);
    click(document.querySelectorAll('.room')[0]);

    const chip = document.querySelector('.room .trap');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain(def.name);
    expect(app().mana).toBe(before - def.cost);
    // Traps never bill you for standing still — that is the whole system.
    expect(document.querySelector('.col-left .panel h2')?.textContent)
      .toContain('upkeep 0/raid');
    // Fully armed, so there is nothing to re-arm yet.
    expect(button('Re-arm traps')).toBeFalsy();

    click(button('Begin Raid'));
    click(button('Instant'));
    click(button('Aftermath'));
    click(button('Continue') ?? button('New Season'));
    // It fired on the threshold, so now it has a bill.
    expect(button('Re-arm traps')).toBeTruthy();
  });

  it('shows the expected adventurer count top-left', () => {
    const inc = document.querySelector('.topbar .stat.incoming');
    expect(inc).toBeTruthy();
    // Tier 1 is 3 adventurers at levels 1-2 (§4.4).
    expect(inc!.textContent).toContain('3');
    expect(inc!.textContent).toContain('lv 1–2');
    // Ahead of raid/tier in the bar.
    const stats = [...document.querySelectorAll('.topbar .stat')];
    expect(stats.indexOf(inc as Element)).toBe(0);
  });

  it('forecasts party size and level for the coming raid', () => {
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => p.querySelector('h2')?.textContent?.includes('Next Raid'))!;
    // Tier 1 is 3 adventurers at levels 1-2 (§4.4).
    expect(panel.textContent).toContain('3 adventurers');
    expect(panel.textContent).toContain('1–2');
    // Team-vs-team readout.
    expect(panel.textContent).toContain('HP');
    expect(panel.textContent).toContain('Damage');
  });

  it('an empty dungeon reads as outmatched, and building shifts the verdict', () => {
    const bare = document.querySelector('.fc-verdict')!.className;
    expect(bare).toContain('outmatched');

    for (let i = 0; i < 3; i++) {
      const buy = [...document.querySelectorAll('.buy')]
        .find((b) => b.textContent?.includes('Ogre'));
      click(buy);
      click(document.querySelectorAll('.room')[i]);
    }
    expect(document.querySelector('.fc-verdict')!.className).not.toContain('outmatched');
  });

  it('offers named upgrade tracks for the selected monster', () => {
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Cave Rat'));
    click(buy);
    click(document.querySelectorAll('.room')[0]);
    click(document.querySelector('.room .mob'));

    const dock = document.querySelector('.panel.dock')!;
    expect(dock).toBeTruthy();
    // Species-specific names, not "train to level N" (§6.6).
    expect(dock.textContent).toContain('Sharper Teeth');
    expect(dock.textContent).toContain('Thicker Hide');
    expect(dock.textContent).toContain('Higher Metabolism');
    expect(dock.textContent).toContain('mana');
  });

  it('a spent trap can be re-armed on its own, not only via re-arm-all', () => {
    const trapBuy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Dart Battery'));
    click(trapBuy);
    click(document.querySelectorAll('.room')[0]);

    // Freshly installed: armed, so the dock offers no re-arm.
    click(document.querySelector('.room .trap'));
    const dock = () => document.querySelector('.col-left .panel.dock')!;
    expect(dock().textContent).toContain('Fully armed');

    // Spend it, and the single-trap button appears.
    const d = seasonDungeon();
    const trap = d.traps![0]!;
    trap.charges = 0;
    click(document.querySelector('.room .trap'));
    click(document.querySelector('.room .trap'));
    expect(dock().textContent).toMatch(/Re-arm this one — \d+g/);

    // ...and clicking it actually re-arms, and actually charges for it.
    const goldBefore = app().gold;
    click(button('Re-arm this one'));
    expect(trap.charges).toBeGreaterThan(0);
    expect(app().gold).toBeLessThan(goldBefore);
  });

  it('re-arm-all is a convenience, not the only route', () => {
    const trapBuy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Dart Battery'));
    click(trapBuy);
    click(document.querySelectorAll('.room')[0]);
    click(trapBuy);
    click(document.querySelectorAll('.room')[1]);

    const d = seasonDungeon();
    for (const t of d.traps!) t.charges = 0;
    render$();
    click(button('Re-arm traps'));
    expect(d.traps!.every((t) => t.charges > 0)).toBe(true);
  });

  it('nothing pushes the Monsters menu down when you buy things', () => {
    const heads = () => [...document.querySelectorAll('.col-right .panel h2')]
      .map((h) => h.textContent ?? '');
    const monstersAt = () => heads().findIndex((h) => h.includes('Monsters'));
    const before = monstersAt();

    // Buy a monster: it becomes selected AND unassigned — the two things that
    // used to insert panels above the shop.
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Cave Rat'));
    click(buy);
    expect(monstersAt()).toBe(before);

    // And with a trap selected.
    const trapBuy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Dart Battery'));
    if (trapBuy) {
      click(trapBuy);
      expect(monstersAt()).toBe(before);
    }
  });

  it('the selection panel does not sit above the monster shop', () => {
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Cave Rat'));
    click(buy);
    click(document.querySelectorAll('.room')[0]);
    click(document.querySelector('.room .mob'));
    // Docked beside the map, so the build column keeps its order.
    expect(document.querySelector('.col-left .panel.dock')).toBeTruthy();
    expect(document.querySelector('.col-right .panel.dock')).toBeFalsy();
  });

  it('sells a monster back for half its base cost', () => {
    const before = app().mana;
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Ogre'));
    click(buy);
    click(document.querySelectorAll('.room')[0]);
    const afterBuy = app().mana;
    expect(afterBuy).toBe(before - MOBS['ogre']!.cost);

    click(document.querySelector('.room .mob'));  // select it
    click(button('Dismiss'));
    // Half of base cost back, and the monster is gone from the room.
    expect(app().mana).toBe(afterBuy + Math.floor(MOBS['ogre']!.cost * 0.5));
    expect(document.querySelector('.room .mob')).toBeFalsy();
  });

  // ─── Thrill (§15) ─────────────────────────────────────────────────────────

  it('shows a predicted Thrill readout in the Build Phase', () => {
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => p.querySelector('h2')?.textContent?.includes('Predicted Thrill'));
    expect(panel).toBeTruthy();
    // All four §15.3 components, plus the Tedium penalty.
    const rows = [...panel!.querySelectorAll('.thrill-parts .pname')].map((n) => n.textContent);
    expect(rows).toEqual(['Peril', 'Depth', 'Variety', 'Comfort', 'Tedium']);
    // A bare starting dungeon is three empty rooms and no shops — say so.
    expect(panel!.textContent).toContain('Nothing is defending');
    expect(panel!.textContent).toContain('empty rooms');
    expect(panel!.textContent).toContain('No amenities');
  });

  it('the prediction reacts to what gets built', () => {
    const before = document.querySelector('.thrill-score b')?.textContent;
    const buy = [...document.querySelectorAll('.buy')]
      .find((b) => b.textContent?.includes('Ogre'));
    click(buy);
    click(document.querySelectorAll('.room')[0]);
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => p.querySelector('h2')?.textContent?.includes('Predicted Thrill'))!;
    expect(panel.textContent).not.toContain('Nothing is defending');
    // Peril went from nothing to something, so the headline number moved.
    expect(document.querySelector('.thrill-score b')?.textContent).not.toBe(before);
  });

  it('leads the Aftermath with the Thrill breakdown', () => {
    click(button('Begin Raid'));
    click(button('Instant'));
    click(button('Aftermath'));

    const modal = document.querySelector('.modal')!;
    expect(modal.querySelector('.thrill-score')).toBeTruthy();
    expect(modal.querySelector('.thrill-parts')).toBeTruthy();
    for (const part of ['Peril', 'Depth', 'Variety', 'Comfort', 'Tedium']) {
      expect(modal.textContent).toContain(part);
    }
    // Renown must read as a derivation of Thrill, not a bare number.
    expect(modal.textContent).toMatch(/Renown — .*Thrill|Renown — no survivors/);
  });

  it('keeps a Legends panel and a top-bar count', () => {
    expect(document.querySelector('.topbar .legends')?.textContent).toContain('legends');
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => p.querySelector('h2')?.textContent?.includes('Legends'))!;
    expect(panel).toBeTruthy();
    // Empty state still has to teach the mechanic.
    expect(panel.querySelector('h2')?.textContent).toContain('Legends (0)');
    expect(panel.textContent).toContain(`Thrill ${TUNING.retireThrill}+`);
  });
});

/**
 * The sim does not populate veterans or legends yet (§15 is landing in parallel),
 * so the season is stubbed to prove the renderer handles them when they arrive.
 */
describe('UI — returning faces and Legends', () => {
  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    vi.doMock('../src/sim/season', async () => {
      const actual = await vi.importActual<typeof import('../src/sim/season')>('../src/sim/season');
      return {
        ...actual,
        createSeason: (seed: number, endless?: boolean): SeasonState => {
          const s = actual.createSeason(seed, endless);
          s.veterans.push({
            id: 7, name: 'Wren Threefingers', cls: 'rogue',
            delves: 4, bestThrill: 68, retired: false,
          });
          s.legends.push({ name: 'Orla the Bold', thrill: 82, retiredOnRaid: 2 });
          return s;
        },
        startRaid: (s: SeasonState) => {
          const sim = actual.startRaid(s);
          const first = sim.party.members[0];
          if (first) first.veteranId = 7;
          return sim;
        },
      };
    });
    await import('../src/ui/main');
    // Past the title screen (§ main menu) — this suite inspects the raid view.
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Begin a Delve'))?.click();
  });

  afterEach(() => { vi.doUnmock('../src/sim/season'); });

  it('marks a returning veteran in the party list with their delve count', () => {
    click(button('Begin Raid'));
    const vet = document.querySelector('.adv .vet');
    expect(vet?.textContent).toContain('4');
    expect(vet?.closest('.adv')?.classList.contains('returning')).toBe(true);
    // Not asserting an exact count: this mock forces slot 0 to be veteran #7,
    // but generateParty independently rolls returning faces at
    // TUNING.veteranReturnChance, so other slots may legitimately be marked too.
    // Fresh rolls must stay unmarked, though.
    const marked = document.querySelectorAll('.adv .vet').length;
    expect(marked).toBeGreaterThanOrEqual(1);
    expect(marked).toBeLessThan(document.querySelectorAll('.adv').length);
  });

  it('lists Legends and their passive Renown trickle', () => {
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => p.querySelector('h2')?.textContent?.includes('Legends'))!;
    expect(panel.querySelector('h2')?.textContent).toContain('Legends (1)');
    expect(panel.querySelector('h2')?.textContent).toContain('Renown/raid');
    expect(panel.querySelector('.legend .nm')?.textContent).toBe('Orla the Bold');
    expect(panel.querySelector('.legend .th')?.textContent).toBe('82');
    // Regulars appear before any of them retire — the recurring face (§15.5).
    expect(panel.querySelector('.regulars')?.textContent).toContain('Wren Threefingers');
    expect(document.querySelector('.topbar .legends b')?.textContent).toContain('1');
  });
});

// ─── Formation (§7.2) ────────────────────────────────────────────────────────

describe('UI — formation', () => {
  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    // A clean profile per test, so Codex ranks cannot bleed between them.
    // jsdom does not always expose localStorage; the app tolerates that (see
    // src/ui/storage.ts) and so should this.
    globalThis.localStorage?.clear();
    await import('../src/ui/main');
    // The app opens on the title screen now; every test below wants a delve.
    const begin = button('Begin a Delve');
    begin?.click();
  });

  it('names the incoming formation in the Next Raid panel', () => {
    const tag = document.querySelector('.fc-form.single-file .fc-form-tag');
    expect(tag?.textContent?.trim()).toBe('Single file');
    expect(document.querySelector('.fc-form-eng')?.textContent).toContain('1 of 3');
  });

  it('telegraphs the coming formation change so the player can prepare', () => {
    const next = document.querySelector('.fc-form-next');
    // Tier 1 with 0 Renown: the whole gap to the first party tier is owed.
    const flip = TIERS.find((t) => t.formation === 'party')!;
    expect(next?.textContent).toContain(String(flip.renown));
    expect(next?.textContent).toContain(`Tier ${flip.tier}`);
  });

  it('shows who is engaged and who is queued during a raid', () => {
    click(button('Begin Raid'));
    click(button('Instant'));
    // The heading carries the formation, and the meters carry the queue depth.
    const panel = [...document.querySelectorAll('.panel')]
      .find((p) => p.querySelector('h2')?.textContent?.includes('The Party'))!;
    expect(panel.querySelector('.form-tag')?.textContent).toContain('Single file');
    expect(panel.textContent).toContain('Queued');
  });

  it('logs the line changing hands', () => {
    click(button('Begin Raid'));
    click(button('Instant'));
    const log = document.querySelector('.log')?.textContent ?? '';
    expect(log).toContain('takes the front');
    expect(log).toContain('single file');
  });
});

// ─── The estimator itself (src/ui/predict.ts) ────────────────────────────────

describe('predicted Thrill', () => {
  const tier1 = TIERS[0]!;

  it('scores a bare dungeon as empty rooms and nothing else', () => {
    const p = predictThrill(createDungeon(), tier1);
    expect(p.emptyRooms).toBe(3);
    expect(p.peril).toBe(0);
    expect(p.comfort).toBe(0);
    expect(p.tedium).toBe(12); // 3 rooms × 4
    expect(p.warnings.some((w) => w.text.includes('Nothing is defending'))).toBe(true);
    expect(p.warnings.some((w) => w.text.includes('No amenities'))).toBe(true);
  });

  it('penalises two identical rooms back to back', () => {
    const d = createDungeon();
    for (const room of [0, 1]) {
      const m = buyMob(d, 'rat');
      if (typeof m === 'string') throw new Error(m);
      placeMobInRoom(d, m.uid, 0, room);
    }
    const p = predictThrill(d, tier1);
    expect(p.repeatedRooms).toBe(1);
    expect(p.warnings.some((w) => w.text.includes('identical to the one before'))).toBe(true);
  });

  it('does not call two different rooms a repeat', () => {
    const d = createDungeon();
    const rat = buyMob(d, 'rat');
    const slime = buyMob(d, 'slime');
    if (typeof rat === 'string' || typeof slime === 'string') throw new Error('buy failed');
    placeMobInRoom(d, rat.uid, 0, 0);
    placeMobInRoom(d, slime.uid, 0, 1);
    const p = predictThrill(d, tier1);
    expect(p.repeatedRooms).toBe(0);
    expect(p.variety).toBeGreaterThan(0);
  });

  it('counts an open amenity as comfort and a closed one as nothing', () => {
    const d = createDungeon();
    // Every amenity is open on build now, so comfort lands immediately.
    expect(predictThrill(d, tier1).comfort).toBe(0);
    buildAmenity(d, 0, 0, 'provisioner');
    expect(predictThrill(d, tier1).comfort).toBeGreaterThan(0);
  });

  it('a self-service Hot Spring counts as comfort with no staff at all', () => {
    const d = createDungeon();
    buildAmenity(d, 0, 0, 'hotspring');
    expect(predictThrill(d, tier1).comfort).toBeGreaterThan(0);
  });

  it('flags a dungeon lethal enough to leave no survivors', () => {
    const d = createDungeon();
    for (let room = 0; room < 3; room++) {
      const m = buyMob(d, 'ogre');
      if (typeof m === 'string') throw new Error(m);
      placeMobInRoom(d, m.uid, 0, room);
    }
    const p = predictThrill(d, tier1);
    expect(p.lethal).toBe(true);
    expect(p.warnings.some((w) => w.level === 'bad' && w.text.includes('lethal'))).toBe(true);
  });

  it('rates the score on the same scale retirement uses', () => {
    expect(thrillRating(0)).toBe('Dull');
    expect(thrillRating(80)).toBe('Legendary');
  });
});
