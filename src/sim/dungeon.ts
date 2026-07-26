/**
 * Dungeon state and Build Phase actions (§5, §6, §8).
 *
 * Every mutator returns an error string instead of throwing, so the UI can
 * disable/explain a button with the same call it would use to perform it.
 */
import {
  AMENITIES, AMENITY_SLOTS_PER_LANDING, COMMERCE_XP_THRESHOLDS, DIG_COSTS,
  GEAR, HIRED_STAFF_COST, MAX_COMMERCE_LEVEL, MAX_FLOORS, MAX_GEAR_SLOTS,
  MAX_LEVEL, MOBS, STARTING_HEARTS, XP_THRESHOLDS, mobDmg, mobMaxHp,
  roomCapacity, roomsOnFloor,
} from './data';
import type {
  Amenity, AmenityId, Dungeon, Landing, Mob, PriceTier, Room,
} from './types';

export type BuildError = string | null;

export function createDungeon(): Dungeon {
  return {
    floors: [{ rooms: emptyRooms(0) }],
    landings: [emptyLanding()],
    hearts: STARTING_HEARTS,
    mobs: [],
    nextMobUid: 1,
  };
}

function emptyRooms(floorIndex: number): Room[] {
  return Array.from({ length: roomsOnFloor(floorIndex) }, () => ({ mobUids: [] }));
}

function emptyLanding(): Landing {
  return { amenities: Array.from({ length: AMENITY_SLOTS_PER_LANDING }, () => null) };
}

export function getMob(d: Dungeon, uid: number): Mob | undefined {
  return d.mobs.find((m) => m.uid === uid);
}

export function digCost(d: Dungeon): number | null {
  const next = d.floors.length;
  if (next >= MAX_FLOORS) return null;
  return DIG_COSTS[next] ?? null;
}

/**
 * Adding a floor also opens a Landing beneath it (§5.1). The Core is always
 * beneath the deepest floor, so digging inserts above the Core, not below it.
 *
 * landings[i] sits BELOW floor i. That means the deepest landing is the "Core
 * approach" — the party's last chance to turn back. Without it a one-floor
 * dungeon would have no Descent Decision at all, leaving `wiped` as its only
 * non-losing outcome and contradicting pillar 2.
 */
export function digFloor(d: Dungeon): BuildError {
  if (d.floors.length >= MAX_FLOORS) return 'Prototype caps at 3 floors.';
  d.floors.push({ rooms: emptyRooms(d.floors.length) });
  d.landings.push(emptyLanding());
  return null;
}

export function buyMob(d: Dungeon, defId: string): Mob | string {
  const def = MOBS[defId];
  if (!def) return `Unknown monster: ${defId}`;
  const mob: Mob = {
    uid: d.nextMobUid++,
    defId,
    level: 1,
    xp: 0,
    commerceLevel: 1,
    commerceXp: 0,
    hp: def.hp,
    alive: true,
    downed: false,
    gear: [],
    placement: { kind: 'unassigned' },
  };
  d.mobs.push(mob);
  return mob;
}

export function roomSlotsUsed(d: Dungeon, floor: number, room: number): number {
  const r = d.floors[floor]?.rooms[room];
  if (!r) return 0;
  return r.mobUids.reduce((sum, uid) => {
    const m = getMob(d, uid);
    return sum + (m ? MOBS[m.defId]!.slots : 0);
  }, 0);
}

/** Remove a mob from wherever it currently sits. Idempotent. */
export function unplace(d: Dungeon, uid: number): void {
  const mob = getMob(d, uid);
  if (!mob) return;
  const p = mob.placement;
  if (p.kind === 'room') {
    const room = d.floors[p.floor]?.rooms[p.room];
    if (room) room.mobUids = room.mobUids.filter((x) => x !== uid);
  } else if (p.kind === 'amenity') {
    const a = d.landings[p.landing]?.amenities[p.slot];
    if (a && a.staffUid === uid) a.staffUid = null;
  }
  mob.placement = { kind: 'unassigned' };
}

export function placeMobInRoom(
  d: Dungeon, uid: number, floor: number, room: number,
): BuildError {
  const mob = getMob(d, uid);
  if (!mob || !mob.alive) return 'That monster is not available.';
  const target = d.floors[floor]?.rooms[room];
  if (!target) return 'No such room.';

  const cost = MOBS[mob.defId]!.slots;
  const already = mob.placement.kind === 'room'
    && mob.placement.floor === floor && mob.placement.room === room;
  const used = roomSlotsUsed(d, floor, room) - (already ? cost : 0);
  const cap = roomCapacity(floor);
  if (used + cost > cap) {
    return `Room is full — ${used}/${cap} slots, ${MOBS[mob.defId]!.name} needs ${cost}.`;
  }

  unplace(d, uid);
  target.mobUids.push(uid);
  mob.placement = { kind: 'room', floor, room };
  return null;
}

export function buildAmenity(
  d: Dungeon, landing: number, slot: number, defId: AmenityId,
): BuildError {
  const l = d.landings[landing];
  if (!l) return 'No such landing. Dig another floor first.';
  if (slot < 0 || slot >= AMENITY_SLOTS_PER_LANDING) return 'No such slot.';
  if (l.amenities[slot]) return 'Slot already occupied.';
  const a: Amenity = { defId, price: 'standard', staffUid: null, hired: false };
  l.amenities[slot] = a;
  return null;
}

export function demolishAmenity(d: Dungeon, landing: number, slot: number): BuildError {
  const l = d.landings[landing];
  const a = l?.amenities[slot];
  if (!l || !a) return 'Nothing there.';
  if (a.staffUid !== null) unplace(d, a.staffUid);
  l.amenities[slot] = null;
  return null;
}

export function setPrice(
  d: Dungeon, landing: number, slot: number, price: PriceTier,
): BuildError {
  const a = d.landings[landing]?.amenities[slot];
  if (!a) return 'Nothing there.';
  a.price = price;
  return null;
}

/**
 * Assign a monster to run a shop. It will not fight this raid — that
 * opportunity cost is the whole point of the system (§8.4).
 */
export function assignStaff(
  d: Dungeon, uid: number, landing: number, slot: number,
): BuildError {
  const mob = getMob(d, uid);
  if (!mob || !mob.alive) return 'That monster is not available.';
  const a = d.landings[landing]?.amenities[slot];
  if (!a) return 'No amenity in that slot.';
  if (a.staffUid !== null && a.staffUid !== uid) unplace(d, a.staffUid);
  unplace(d, uid);
  a.staffUid = uid;
  mob.placement = { kind: 'amenity', landing, slot };
  return null;
}

// ─── Upkeep & economy helpers ────────────────────────────────────────────────

/** Only *placed* mobs cost upkeep; unassigned ones are in stasis by default. */
export function totalUpkeep(d: Dungeon): number {
  let total = 0;
  for (const m of d.mobs) {
    if (!m.alive || m.placement.kind === 'unassigned') continue;
    total += MOBS[m.defId]!.upkeep;
  }
  for (const l of d.landings) {
    for (const a of l.amenities) {
      if (a && isOpen(a)) total += AMENITIES[a.defId].upkeep;
    }
  }
  return total;
}

/** An amenity trades only when someone is behind the counter. */
export function isOpen(a: Amenity): boolean {
  return a.hired || a.staffUid !== null;
}

// ─── Gear and hired staff — the Gold sinks (§6.5, §8.4) ──────────────────────

/** Effective stats including gear. Always use these, never the raw MobDef. */
export function mobEffectiveHp(mob: Mob): number {
  let hp = mobMaxHp(mob.defId, mob.level);
  for (const g of mob.gear) hp *= GEAR[g]?.hpMult ?? 1;
  return Math.round(hp);
}

export function mobEffectiveDmg(mob: Mob): number {
  let dmg = mobDmg(mob.defId, mob.level);
  for (const g of mob.gear) dmg *= GEAR[g]?.dmgMult ?? 1;
  return dmg;
}

/**
 * Damage multiplier from Pack Tactics, given how many allies are still up in
 * the room. Counts *other* monsters, so a lone rat gets nothing.
 */
export function packMultiplier(mob: Mob, alliesInRoom: number): number {
  const pack = MOBS[mob.defId]!.pack ?? 0;
  if (pack === 0) return 1;
  return 1 + pack * Math.max(0, alliesInRoom - 1);
}

/** Gear grants Kit-stripping to monsters that aren't Wardens. */
export function mobStripsKit(mob: Mob): boolean {
  if (MOBS[mob.defId]!.role === 'warden') return true;
  return mob.gear.some((g) => GEAR[g]?.stripsKit);
}

export function gearCost(gearId: string): number {
  return GEAR[gearId]?.cost ?? 0;
}

export function equipGear(d: Dungeon, uid: number, gearId: string): BuildError {
  const mob = getMob(d, uid);
  if (!mob || !mob.alive) return 'That monster is not available.';
  if (!GEAR[gearId]) return `Unknown gear: ${gearId}`;
  if (mob.gear.length >= MAX_GEAR_SLOTS) return 'No free gear slots.';
  if (mob.gear.includes(gearId)) return 'Already equipped.';
  mob.gear.push(gearId);
  mob.hp = mobEffectiveHp(mob);
  return null;
}

/**
 * Gear survives its wearer (§6.5) — this is the counterweight to permanent
 * monster death. You lose the levels and the history, never the investment.
 */
export function salvageGear(d: Dungeon, uid: number): string[] {
  const mob = getMob(d, uid);
  if (!mob) return [];
  const salvaged = [...mob.gear];
  mob.gear = [];
  return salvaged;
}

export function hiredStaffCost(): number {
  return HIRED_STAFF_COST;
}

/** Put NPC staff behind the counter so a monster can go back to fighting. */
export function hireStaff(d: Dungeon, landing: number, slot: number): BuildError {
  const a = d.landings[landing]?.amenities[slot];
  if (!a) return 'No amenity in that slot.';
  if (a.hired) return 'Already staffed by hirelings.';
  if (a.staffUid !== null) unplace(d, a.staffUid);
  a.hired = true;
  return null;
}

export function livingMobs(d: Dungeon): Mob[] {
  return d.mobs.filter((m) => m.alive);
}

/** Monsters currently able to fight in this room. */
export function mobsInRoom(d: Dungeon, floor: number, room: number): Mob[] {
  const r = d.floors[floor]?.rooms[room];
  if (!r) return [];
  return r.mobUids
    .map((uid) => getMob(d, uid))
    .filter((m): m is Mob => !!m && m.alive && !m.downed);
}

/** Restore all monsters to full HP and pick the downed ones back up. */
export function healAllMobs(d: Dungeon): void {
  for (const m of d.mobs) {
    if (!m.alive) continue;
    m.downed = false;
    m.hp = mobEffectiveHp(m);
  }
}

/** Returns true if the mob gained a level. */
export function grantXp(mob: Mob, amount: number): boolean {
  if (mob.level >= MAX_LEVEL) return false;
  mob.xp += amount;
  let leveled = false;
  while (mob.level < MAX_LEVEL && mob.xp >= XP_THRESHOLDS[mob.level - 1]!) {
    mob.level++;
    leveled = true;
  }
  return leveled;
}

export function grantCommerceXp(mob: Mob, amount: number): boolean {
  if (mob.commerceLevel >= MAX_COMMERCE_LEVEL) return false;
  mob.commerceXp += amount;
  let leveled = false;
  while (
    mob.commerceLevel < MAX_COMMERCE_LEVEL
    && mob.commerceXp >= COMMERCE_XP_THRESHOLDS[mob.commerceLevel - 1]!
  ) {
    mob.commerceLevel++;
    leveled = true;
  }
  return leveled;
}

/** Knocked out for the rest of this raid. Keeps its room and its levels. */
export function downMob(d: Dungeon, uid: number): void {
  const mob = getMob(d, uid);
  if (!mob) return;
  mob.downed = true;
  mob.hp = 0;
}

/** Permanent death (§6.4). The mob stays in the roster so it can be reconstituted. */
export function slayMob(d: Dungeon, uid: number): string[] {
  const mob = getMob(d, uid);
  if (!mob) return [];
  unplace(d, uid);
  mob.alive = false;
  mob.downed = false;
  mob.hp = 0;
  return salvageGear(d, uid);
}

export function reconstitute(d: Dungeon, uid: number): BuildError {
  const mob = getMob(d, uid);
  if (!mob) return 'No such monster.';
  if (mob.alive) return 'That monster is alive.';
  mob.alive = true;
  mob.downed = false;
  mob.hp = mobEffectiveHp(mob);
  mob.placement = { kind: 'unassigned' };
  return null;
}
