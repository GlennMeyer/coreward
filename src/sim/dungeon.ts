/**
 * Dungeon state and Build Phase actions (§5, §6, §8).
 *
 * Every mutator returns an error string instead of throwing, so the UI can
 * disable/explain a button with the same call it would use to perform it.
 */
import {
  AMENITIES, AMENITY_SLOTS_PER_LANDING, COMMERCE_XP_THRESHOLDS, DIG_COSTS,
  GEAR, HIRED_STAFF_COST, MAX_COMMERCE_LEVEL, MAX_FLOORS, MAX_GEAR_SLOTS,
  MAX_LEVEL, MOBS, STARTING_HEARTS, TRAPS, XP_THRESHOLDS, mobDmg, mobMaxHp,
  roomCapacity, roomsOnFloor, trapCost, trapRearmCost,
} from './data';
import type {
  Amenity, AmenityId, Dungeon, Landing, Mob, PriceTier, Room, Trap,
} from './types';

export type BuildError = string | null;

export function createDungeon(): Dungeon {
  return {
    floors: [{ rooms: emptyRooms(0) }],
    landings: [emptyLanding()],
    hearts: STARTING_HEARTS,
    mobs: [],
    nextMobUid: 1,
    traps: [],
    nextTrapUid: 1,
  };
}

function emptyRooms(floorIndex: number): Room[] {
  return Array.from(
    { length: roomsOnFloor(floorIndex) },
    () => ({ mobUids: [], trapUids: [] }),
  );
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

/**
 * Room capacity used by everything in the room — monsters AND traps.
 *
 * **Traps share the monster slot budget; they do not get a layer of their own.**
 * §5.2 writes a room as holding "one of" a mob group, a trap, or a cache, and
 * §16.3 already turned that into a single capacity number. Two reasons to keep
 * it that way rather than giving traps free space:
 *
 * 1. A free layer is a free win. If a trap costs no capacity then every room in
 *    the dungeon gets one, no room is ever "empty" for Tedium (§15.3), and the
 *    §15.1 exploit reopens through the back door — reputation for a delve
 *    nobody paid for. Capacity is the price that keeps the choice honest.
 * 2. It is the interesting decision. A Hewn floor-1 room holds 4 slots: an Ogre
 *    (3) plus a Snare, or a Skeleton (2) plus two traps, or four traps and
 *    nothing that can finish anybody. Every trap you install is a monster you
 *    did not, in that room, on that floor — which is exactly the "soften, then
 *    kill" arrangement §7.5 describes, arrived at as a budget rather than a
 *    rule.
 */
export function roomSlotsUsed(d: Dungeon, floor: number, room: number): number {
  const r = d.floors[floor]?.rooms[room];
  if (!r) return 0;
  const mobSlots = r.mobUids.reduce((sum, uid) => {
    const m = getMob(d, uid);
    return sum + (m ? MOBS[m.defId]!.slots : 0);
  }, 0);
  const trapSlots = (r.trapUids ?? []).reduce((sum, uid) => {
    const t = getTrap(d, uid);
    return sum + (t ? TRAPS[t.defId]!.slots : 0);
  }, 0);
  return mobSlots + trapSlots;
}

// ─── Traps (§5.2) ────────────────────────────────────────────────────────────

export function getTrap(d: Dungeon, uid: number): Trap | undefined {
  return d.traps?.find((t) => t.uid === uid);
}

/** Every installed trap. Safe on a Dungeon literal written before traps existed. */
export function allTraps(d: Dungeon): Trap[] {
  return d.traps ?? [];
}

/** Traps installed in a room, in firing order, armed or not. */
export function trapsInRoom(d: Dungeon, floor: number, room: number): Trap[] {
  const r = d.floors[floor]?.rooms[room];
  if (!r) return [];
  return (r.trapUids ?? [])
    .map((uid) => getTrap(d, uid))
    .filter((t): t is Trap => !!t);
}

/**
 * Traps in a room that will actually do something.
 *
 * The distinction matters everywhere: a spent trap is a hole in the floor. It
 * fires nothing, it counts for no `variety`, and its room reads as empty for
 * Tedium. Re-arming is the whole recurring cost of the trap economy, so it has
 * to be the thing every downstream rule keys off.
 */
export function armedTrapsInRoom(d: Dungeon, floor: number, room: number): Trap[] {
  return trapsInRoom(d, floor, room).filter((t) => t.charges > 0);
}

export function buyTrap(d: Dungeon, defId: string): Trap | string {
  const def = TRAPS[defId];
  if (!def) return `Unknown trap: ${defId}`;
  d.traps ??= [];
  d.nextTrapUid ??= 1;
  const trap: Trap = {
    uid: d.nextTrapUid++,
    defId,
    charges: def.charges,   // installed armed — the purchase price includes it
    placement: { kind: 'unassigned' },
  };
  d.traps.push(trap);
  return trap;
}

/** Remove a trap from wherever it sits. Idempotent. */
export function unplaceTrap(d: Dungeon, uid: number): void {
  const trap = getTrap(d, uid);
  if (!trap) return;
  if (trap.placement.kind === 'room') {
    const r = d.floors[trap.placement.floor]?.rooms[trap.placement.room];
    if (r?.trapUids) r.trapUids = r.trapUids.filter((x) => x !== uid);
  }
  trap.placement = { kind: 'unassigned' };
}

export function placeTrapInRoom(
  d: Dungeon, uid: number, floor: number, room: number,
): BuildError {
  const trap = getTrap(d, uid);
  if (!trap) return 'No such trap.';
  const target = d.floors[floor]?.rooms[room];
  if (!target) return 'No such room.';

  const def = TRAPS[trap.defId]!;
  const already = trap.placement.kind === 'room'
    && trap.placement.floor === floor && trap.placement.room === room;
  const used = roomSlotsUsed(d, floor, room) - (already ? def.slots : 0);
  const cap = roomCapacity(floor);
  if (used + def.slots > cap) {
    return `Room is full — ${used}/${cap} slots, ${def.name} needs ${def.slots}.`;
  }

  unplaceTrap(d, uid);
  (target.trapUids ??= []).push(uid);
  trap.placement = { kind: 'room', floor, room };
  return null;
}

/**
 * Mana to put one charge back into a trap. Zero if it is already full.
 *
 * There is no automatic re-arm anywhere in the sim. That is the design: a
 * monster's bill arrives whether it fought or not (§4.1), and a trap's arrives
 * only for what it spent. A player who cannot afford to reset the dungeon this
 * raid simply fights without it, and the trap is still there next raid.
 */
export function trapRearmPrice(d: Dungeon, uid: number): number {
  const trap = getTrap(d, uid);
  if (!trap) return 0;
  const def = TRAPS[trap.defId]!;
  return Math.max(0, def.charges - trap.charges) * trapRearmCost(trap.defId);
}

/** Total mana to bring every installed trap back to full charges. */
export function rearmAllPrice(d: Dungeon): number {
  return allTraps(d).reduce((sum, t) => sum + trapRearmPrice(d, t.uid), 0);
}

/** Re-arm one trap fully. Returns the mana spent, or an error. */
export function rearmTrap(d: Dungeon, uid: number, mana: number): number | string {
  const trap = getTrap(d, uid);
  if (!trap) return 'No such trap.';
  const price = trapRearmPrice(d, uid);
  if (price === 0) return 'Already armed.';
  if (mana < price) return `Re-arming costs ${price} mana.`;
  trap.charges = TRAPS[trap.defId]!.charges;
  return price;
}

/**
 * Re-arm as much of the dungeon as `mana` covers, cheapest first.
 *
 * Cheapest-first rather than deepest-first on purpose: when the budget is
 * short, the player gets the most triggers back per mana, which is the whole
 * argument for traps over monsters. Returns what it spent.
 */
export function rearmAll(d: Dungeon, mana: number): number {
  let spent = 0;
  const queue = allTraps(d)
    .filter((t) => trapRearmPrice(d, t.uid) > 0)
    .sort((a, b) => trapRearmCost(a.defId) - trapRearmCost(b.defId));
  for (const t of queue) {
    const price = trapRearmPrice(d, t.uid);
    if (spent + price > mana) continue;
    t.charges = TRAPS[t.defId]!.charges;
    spent += price;
  }
  return spent;
}

/**
 * Rip a trap out. Refunds half the install cost, like dismissing a monster
 * (§4.1) — and unlike a monster there are no levels to throw away, because a
 * trap never improves. Spent charges are not refunded.
 */
export function trapSalvageValue(defId: string): number {
  return Math.floor(trapCost(defId) * DISMISS_REFUND);
}

export function removeTrap(d: Dungeon, uid: number): number | string {
  const trap = getTrap(d, uid);
  if (!trap) return 'No such trap.';
  unplaceTrap(d, uid);
  const refund = trapSalvageValue(trap.defId);
  d.traps = allTraps(d).filter((t) => t.uid !== uid);
  return refund;
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

/**
 * Only *placed* mobs cost upkeep; unassigned ones are in stasis by default.
 *
 * **Traps deliberately contribute nothing.** That is not an oversight and it is
 * not "traps are free": a trap's bill is `rearmAllPrice()`, charged in the
 * Build Phase for exactly the charges it spent. Splitting the two is the point
 * of the system — §4.1's pressure valve should squeeze a dungeon that is
 * standing idle, not one that is being overrun.
 */
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
  if (AMENITIES[a.defId].selfService) return true;
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

/**
 * Refund fraction when a monster is dismissed (§4.1).
 *
 * Half of base cost, and deliberately NOT scaled by level: selling a veteran
 * throws its levels away, which is what stops dismissal being a way to launder
 * a grown monster back into mana.
 */
export const DISMISS_REFUND = 0.5;

export function dismissValue(mob: Mob): number {
  return Math.floor(MOBS[mob.defId]!.cost * DISMISS_REFUND);
}

/**
 * Sell a monster back. Returns the mana refunded and any gear it was carrying,
 * which returns to the armory intact (§6.5) — you lose the creature, never the
 * investment.
 */
export function dismissMob(
  d: Dungeon, uid: number,
): { mana: number; gear: string[] } | string {
  const mob = getMob(d, uid);
  if (!mob) return 'No such monster.';
  if (!mob.alive) return 'That monster is already dead.';
  const mana = dismissValue(mob);
  const gear = salvageGear(d, uid);
  unplace(d, uid);
  d.mobs = d.mobs.filter((m) => m.uid !== uid);
  return { mana, gear };
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
