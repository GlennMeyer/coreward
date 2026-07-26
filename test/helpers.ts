import {
  assignStaff, buildAmenity, buyMob, digFloor, placeMobInRoom,
} from '../src/sim/dungeon';
import { createSeason } from '../src/sim/season';
import type { AmenityId, Dungeon, SeasonState } from '../src/sim/types';

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
export function seasonWithFloors(seed: number, floors: number): SeasonState {
  const s = createSeason(seed);
  for (let i = 1; i < floors; i++) {
    const err = digFloor(s.dungeon);
    if (err) throw new Error(err);
  }
  return s;
}
