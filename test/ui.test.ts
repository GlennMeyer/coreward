/**
 * UI smoke test. Drives the real DOM renderer through a whole raid to catch
 * runtime errors the type checker can't see (null refs, bad selectors, handlers
 * wired to elements that no longer exist).
 *
 * Runs in jsdom — see environmentMatchGlobs in vite.config.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

function click(node: Element | null | undefined): void {
  if (!node) throw new Error('tried to click a node that does not exist');
  (node as HTMLElement).click();
}

/** Find a button by its visible text. */
function button(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')]
    .find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;
}

describe('UI smoke', () => {
  beforeEach(async () => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
    await import('../src/ui/main');
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
    expect(document.querySelector('.room .slots')?.textContent).toBe('1/3');
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
    expect(document.querySelector('.amenity')).toBeTruthy();
    // Amenity starts closed: nobody behind the counter.
    expect(document.querySelector('.amenity')?.classList.contains('closed')).toBe(true);

    click(document.querySelector('.room .mob'));      // select the monster
    click(document.querySelector('.amenity'));         // assign as staff
    expect(document.querySelector('.amenity')?.classList.contains('closed')).toBe(false);
    // Staffing pulls it out of the room — the opportunity cost (§8.4).
    expect(document.querySelector('.room .mob')).toBeFalsy();
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
    expect(document.querySelector('.topbar')?.textContent).toContain('2/8');
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

  it('speed controls do not throw', () => {
    click(button('Begin Raid'));
    for (const label of ['II', '1x', '2x', '4x']) click(button(label));
    expect(document.querySelector('.log')).toBeTruthy();
  });
});
