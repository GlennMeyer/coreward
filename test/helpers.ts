import {
  advanceProject, assignStaff, buildAmenity, buyMob, buyTrap, digFloor,
  placeMobInRoom, placeTrapInRoom, startWiden,
} from '../src/sim/dungeon';
import { createSeason } from '../src/sim/season';
import type { AmenityId, Dungeon, SeasonState } from '../src/sim/types';

/** Install a trap in a room, fully armed. Throws on any build error (§5.2). */
export function addTrap(
  d: Dungeon, defId: string, floor: number, room: number,
): number {
  const trap = buyTrap(d, defId);
  if (typeof trap === 'string') throw new Error(trap);
  const err = placeTrapInRoom(d, trap.uid, floor, room);
  if (err) throw new Error(err);
  return trap.uid;
}

/** Buy a mob and drop it straight into a room. Throws on any build error. */
export function addMob(
  d: Dungeon, defId: string, floor: number, room: number,
): number {
  const mob = buyMob(d, defId);
  if (typeof mob === 'string') throw new Error(mob);
  const err = placeMobInRoom(d, mob.uid, floor, room);
  if (err) throw new Error(err);
  return mob.uid;
}

/** Buy a mob and put it behind a counter instead. */
export function addStaffedAmenity(
  d: Dungeon, landing: number, slot: number, defId: AmenityId, staffDefId = 'rat',
): number {
  const e1 = buildAmenity(d, landing, slot, defId);
  if (e1) throw new Error(e1);
  const mob = buyMob(d, staffDefId);
  if (typeof mob === 'string') throw new Error(mob);
  const e2 = assignStaff(d, mob.uid, landing, slot);
  if (e2) throw new Error(e2);
  return mob.uid;
}

/** A season with `floors` floors dug and nothing placed. */
/**
 * A season with `floors` dug. **Bounded by default**: runs are endless in the
 * game (§12a), but a test wants a fixture that terminates. Pass `endless: true`
 * for the real thing.
 */
export function seasonWithFloors(
  seed: number, floors: number, endless = false,
): SeasonState {
  const s = createSeason(seed, endless);
  for (let i = 1; i < floors; i++) {
    const err = digFloor(s.dungeon);
    if (err) throw new Error(err);
  }
  return s;
}

/**
 * Widen a room and finish the work at once (§16.3).
 *
 * Fixtures that predate purchased capacity were written against rooms that held
 * 4-6 slots by depth; a Hewn room holds 3. Where such a fixture genuinely needs
 * the space — an Ogre *and* a Deadfall, say — this is the honest translation:
 * it buys the room rather than pretending the cap never changed. Skips the
 * build time on purpose, because none of those tests are about waiting.
 */
export function widenRoom(d: Dungeon, floor: number, room: number): void {
  const started = startWiden(d, floor, room);
  if (typeof started === 'string') throw new Error(started);
  advanceProject(d);
}
