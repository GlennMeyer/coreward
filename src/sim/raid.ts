/**
 * Raid resolution (§7). The heart of the sim.
 *
 * Steppable rather than run-to-completion, because interventions are player
 * input arriving mid-raid. Determinism still holds: (seed, dungeon, tier,
 * intervention log) reproduces a raid exactly, which is what makes replays
 * and the headless balance runner possible.
 */
import {
  AMENITIES, COMMERCE_REVENUE_PER_LEVEL, COMMERCE_XP_PER_SALE,
  DESCEND_HP_THRESHOLD, DESCEND_KIT_PER_MEMBER, DESCEND_RESOLVE_THRESHOLD,
  HOTSPRING_HEAL_PCT, LEY_CHARGES, MANA_PER_KILL, MOBS, PRICE_TIERS,
  PROVISIONER_MAX_KIT, RENOWN_PER_ESCAPEE, RENOWN_PER_GOLD, RENOWN_PER_KILL,
  RENOWN_WIPE_MULT, REST_RESOLVE_PCT, RESOLVE_ON_ALLY_DEATH, SOULS_PER_KILL,
  SOULS_PER_NAMED, TUNING, XP_PER_HIT, XP_PER_KILL, CLASS_MODS, mobMaxHp,
  soulsTierMult, type TierRow,
} from './data';
import {
  downMob, getMob, grantCommerceXp, grantXp, isOpen, mobEffectiveDmg,
  mobStripsKit, mobsInRoom, packMultiplier, slayMob,
} from './dungeon';
import { Rng } from './rng';
import {
  aliveMembers, avgHpPct, avgResolvePct, generateParty, partyHasNamed,
} from './adventurers';
import type {
  Adventurer, Dungeon, Legend, Mob, MobRole, Party, RaidEvent, RaidOutcome,
  RaidResult, RetreatReason, ThrillScore, Veteran,
} from './types';

export type RaidStatus = 'running' | 'awaiting-taunt' | 'complete';

/** Safety valve: no raid may spin forever. */
const MAX_TICKS = 3000;

/** `variety` saturates here — four distinct roles is already a varied dungeon (§15.3). */
const VARIETY_ROLE_CAP = 4;

const ZERO_THRILL: ThrillScore = {
  total: 0, peril: 0, depth: 0, variety: 0, comfort: 0, tedium: 0,
};

export class RaidSim {
  readonly party: Party;
  readonly tier: TierRow;

  private readonly d: Dungeon;
  private readonly rng: Rng;

  private tick = 0;
  private floor = 0;
  private room = 0;
  private phase: 'room' | 'landing' | 'done' = 'room';
  private roomEntered = false;

  private atb = new Map<number, number>();
  private advAtb = new Map<number, number>();

  private _status: RaidStatus = 'running';
  private pendingTaunt: { landing: number; reason: RetreatReason } | null = null;
  private leyCharges = LEY_CHARGES;

  // Running tallies for the result.
  private goldFromSales = 0;
  private goldFromCorpses = 0;
  private killed = 0;
  private mobsDowned: { uid: number; defId: string; level: number }[] = [];
  private mobsLost: { uid: number; defId: string; level: number }[] = [];
  private deepestFloor = 0;
  private outcome: RaidOutcome | null = null;

  // Thrill inputs, tallied as the delve happens (§15.3).
  private emptyRooms = 0;
  private repeatedRooms = 0;
  private lastRoomSig: string | null = null;
  private rolesFaced = new Set<MobRole>();
  private amenitiesUsed = new Set<string>();
  private thrillScore: ThrillScore = ZERO_THRILL;
  private retiredThisRaid: Legend[] = [];
  private perAdvThrill = new Map<number, number>();

  private readonly veterans: Veteran[];

  private pending: RaidEvent[] = [];

  /**
   * `veterans` is the season's persistent roster (§15.5) and is optional so
   * every existing call site — tests, tools, the UI — keeps working without it.
   * The sim only reads it, except for flipping `retired` on a retiree.
   */
  constructor(dungeon: Dungeon, tier: TierRow, seed: number, veterans: Veteran[] = []) {
    this.d = dungeon;
    this.tier = tier;
    this.rng = new Rng(seed);
    this.veterans = veterans;
    this.party = generateParty(this.rng, tier, veterans);
    this.emit({ t: 0, type: 'raid-start', tier: tier.tier, partySize: this.party.members.length });
    this.emit({ t: 0, type: 'floor-enter', floor: 0 });
  }

  get status(): RaidStatus {
    return this._status;
  }

  get charges(): number {
    return this.leyCharges;
  }

  get currentFloor(): number {
    return this.floor;
  }

  get currentRoom(): number {
    return this.room;
  }

  get tauntOffer(): { landing: number; reason: RetreatReason } | null {
    return this.pendingTaunt;
  }

  /**
   * Thrill by adventurer id, for survivors only. `RaidResult.thrill` carries
   * the party mean; the Aftermath needs the individual figures to update each
   * Veteran's personal best (§15.5).
   */
  get survivorThrill(): ReadonlyMap<number, number> {
    return this.perAdvThrill;
  }

  private emit(e: RaidEvent): void {
    this.pending.push(e);
  }

  private drain(): RaidEvent[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  // ─── Public driving API ────────────────────────────────────────────────────

  /** Advance one tick. Returns events generated this tick (possibly empty). */
  step(): RaidEvent[] {
    if (this._status !== 'running') return this.drain();
    if (this.tick >= MAX_TICKS) {
      this.finish('retreated', 'hp');
      return this.drain();
    }
    this.tick++;

    if (this.phase === 'room') this.stepRoom();
    else if (this.phase === 'landing') this.stepLanding();

    return this.drain();
  }

  /**
   * Run with no player input. Used by "Instant" speed and the balance runner;
   * auto-declines every Taunt offer.
   */
  runToCompletion(): RaidEvent[] {
    const all: RaidEvent[] = [];
    while (this._status !== 'complete') {
      all.push(...this.step());
      if (this._status === 'awaiting-taunt') {
        all.push(...this.resolveTaunt(false));
      }
    }
    return all;
  }

  /** Intervention: pull a mob out of combat. It survives; the room is now undefended. */
  applyRetreatIntervention(uid: number): boolean {
    if (this._status !== 'running' || this.leyCharges <= 0) return false;
    const mob = getMob(this.d, uid);
    if (!mob || !mob.alive) return false;
    if (mob.placement.kind !== 'room') return false;
    if (mob.placement.floor !== this.floor || mob.placement.room !== this.room) return false;

    this.leyCharges--;
    // Withdrawn from the fight but NOT killed — it keeps its levels.
    const r = this.d.floors[mob.placement.floor]!.rooms[mob.placement.room]!;
    r.mobUids = r.mobUids.filter((x) => x !== uid);
    mob.placement = { kind: 'unassigned' };
    this.atb.delete(uid);
    this.emit({ t: this.tick, type: 'intervention-retreat', uid });
    return true;
  }

  /** Answer a pending Taunt offer. `true` forces one more floor of descent. */
  resolveTaunt(accept: boolean): RaidEvent[] {
    if (this._status !== 'awaiting-taunt' || !this.pendingTaunt) return [];
    const offer = this.pendingTaunt;
    this.pendingTaunt = null;
    this._status = 'running';

    if (accept && this.leyCharges > 0) {
      this.leyCharges--;
      this.emit({ t: this.tick, type: 'taunt-used', landing: offer.landing });
      this.descend();
    } else {
      this.finish('retreated', offer.reason);
    }
    return this.drain();
  }

  // ─── Room combat ───────────────────────────────────────────────────────────

  private stepRoom(): void {
    if (!this.roomEntered) {
      this.roomEntered = true;
      this.emit({ t: this.tick, type: 'room-enter', floor: this.floor, room: this.room });
      this.noteRoomTraversed();
      this.initRoomCombatants();
      this.ambushRound();
      if (this.checkPartyState()) return;
    }

    const mobs = mobsInRoom(this.d, this.floor, this.room);

    if (mobs.length === 0) {
      this.emit({ t: this.tick, type: 'room-clear', floor: this.floor, room: this.room });
      this.advanceRoom();
      return;
    }

    // Mobs and adventurers act simultaneously within a tick.
    for (const mob of mobs) {
      const spd = MOBS[mob.defId]!.spd;
      let acc = (this.atb.get(mob.uid) ?? 0) + spd;
      while (acc >= 1) {
        acc -= 1;
        if (mob.alive) this.mobAct(mob);
      }
      this.atb.set(mob.uid, acc);
    }

    for (const adv of aliveMembers(this.party)) {
      let acc = (this.advAtb.get(adv.id) ?? 0) + 1;
      while (acc >= 1) {
        acc -= 1;
        this.advAct(adv);
      }
      this.advAtb.set(adv.id, acc);
    }

    this.checkPartyState();
  }

  /**
   * Tedium and variety bookkeeping, taken at the moment they walk in (§15.3).
   *
   * Sampling on entry rather than on clear is deliberate: a room that was
   * emptied by a Ley intervention still threatened them when they arrived, and
   * a room they died in still counts as content they saw.
   */
  private noteRoomTraversed(): void {
    const mobs = mobsInRoom(this.d, this.floor, this.room);

    if (mobs.length === 0) {
      this.emptyRooms++;
      // Empty rooms already pay tediumPerEmptyRoom; charging them the repeat
      // penalty as well would double-bill the same corridor.
      this.lastRoomSig = null;
      return;
    }

    for (const m of mobs) this.rolesFaced.add(MOBS[m.defId]!.role);

    // Same cast of monsters as the room before it — nine identical Ogre rooms
    // is a bad dungeon by rule, not just by taste (§15.4).
    const sig = mobs.map((m) => m.defId).sort().join(',');
    if (sig === this.lastRoomSig) this.repeatedRooms++;
    this.lastRoomSig = sig;
  }

  private initRoomCombatants(): void {
    this.atb.clear();
    this.advAtb.clear();
    for (const m of mobsInRoom(this.d, this.floor, this.room)) {
      this.atb.set(m.uid, 0);
    }
    for (const a of aliveMembers(this.party)) this.advAtb.set(a.id, 0);
  }

  /** Ambushers act before the party's first turn in a room (§6.2). */
  private ambushRound(): void {
    for (const mob of mobsInRoom(this.d, this.floor, this.room)) {
      if (MOBS[mob.defId]!.role === 'ambusher') this.mobAct(mob);
    }
  }

  private mobAct(mob: Mob): void {
    const alive = aliveMembers(this.party);
    if (alive.length === 0) return;
    const role = MOBS[mob.defId]!.role;
    const target = this.pickTarget(role, alive);
    if (!target) return;

    // Pack Tactics scales with how many allies are still standing, so a swarm
    // hits hardest before it gets thinned out.
    const allies = mobsInRoom(this.d, this.floor, this.room).length;
    const raw = mobEffectiveDmg(mob) * packMultiplier(mob, allies);

    if (role === 'terror') {
      const amount = Math.max(1, Math.round(raw));
      target.resolve = Math.max(0, target.resolve - amount);
      this.emit({
        t: this.tick, type: 'resolve-hit', advId: target.id,
        amount, resolveLeft: target.resolve,
      });
      grantXp(mob, XP_PER_HIT);
      return;
    }

    const dmg = Math.max(1, Math.round(raw - target.armor));
    target.hp = Math.max(0, target.hp - dmg);
    // The low-water mark is the whole of `peril` (§15.3): what matters is how
    // close they came, not what they limped out on.
    target.lowestHpPct = Math.min(target.lowestHpPct, target.hp / target.maxHp);
    this.emit({
      t: this.tick, type: 'attack', source: 'mob',
      uid: mob.uid, targetId: target.id, dmg,
    });

    if (mobStripsKit(mob) && this.party.kit > 0) {
      this.party.kit -= 1;
      this.emit({ t: this.tick, type: 'kit-strip', uid: mob.uid, amount: 1, kitLeft: this.party.kit });
    }

    if (target.hp <= 0) {
      this.killAdventurer(target);
      if (grantXp(mob, XP_PER_KILL)) {
        this.emit({ t: this.tick, type: 'mob-levelup', uid: mob.uid, level: mob.level });
      }
    } else if (grantXp(mob, XP_PER_HIT)) {
      this.emit({ t: this.tick, type: 'mob-levelup', uid: mob.uid, level: mob.level });
    }
  }

  private pickTarget(role: string, alive: Adventurer[]): Adventurer | undefined {
    switch (role) {
      case 'skirmisher':
        // Finish the wounded.
        return alive.reduce((a, b) => (b.hp < a.hp ? b : a));
      case 'caster':
        // Go for the squishiest.
        return alive.reduce((a, b) => (b.maxHp < a.maxHp ? b : a));
      case 'warden':
        // Whoever is carrying the most, abstractly: the healthiest.
        return alive.reduce((a, b) => (b.hp > a.hp ? b : a));
      default:
        return this.rng.pick(alive);
    }
  }

  private advAct(adv: Adventurer): void {
    if (!adv.alive) return;

    // Kit spend takes priority over attacking (§7.2).
    const threshold = CLASS_MODS[adv.cls].healThreshold;
    if (adv.hp / adv.maxHp < threshold && this.party.kit > 0) {
      this.party.kit -= 1;
      const heal = Math.round(adv.maxHp * TUNING.kitHealPct);
      adv.hp = Math.min(adv.maxHp, adv.hp + heal);
      this.emit({
        t: this.tick, type: 'kit-heal', advId: adv.id,
        amount: heal, kitLeft: this.party.kit,
      });
      return;
    }

    const mobs = mobsInRoom(this.d, this.floor, this.room);
    if (mobs.length === 0) return;
    // Focus fire the weakest — standard party behavior.
    const target = mobs.reduce((a, b) => (b.hp < a.hp ? b : a));
    const dmg = Math.max(1, Math.round(adv.dmg));
    target.hp = Math.max(0, target.hp - dmg);
    this.emit({
      t: this.tick, type: 'attack', source: 'adv',
      advId: adv.id, targetUid: target.uid, dmg,
    });

    if (target.hp <= 0) {
      this.mobsDowned.push({ uid: target.uid, defId: target.defId, level: target.level });
      this.emit({
        t: this.tick, type: 'mob-downed',
        uid: target.uid, defId: target.defId, level: target.level,
      });
      downMob(this.d, target.uid);
      this.atb.delete(target.uid);
    }
  }

  private killAdventurer(adv: Adventurer): void {
    adv.alive = false;
    adv.hp = 0;
    this.killed++;
    // Killing destroys 75% of what they carried (§4.3) — this is the number
    // that makes predation and commerce compete.
    const recovered = Math.round(adv.gold * TUNING.goldRecoveredOnKill);
    this.goldFromCorpses += recovered;
    this.emit({
      t: this.tick, type: 'adv-death',
      advId: adv.id, name: adv.name, goldDropped: recovered,
    });
    adv.gold = 0;

    // Morale shock to the survivors — this is what makes Resolve matter even
    // without a Terror mob in the roster.
    for (const other of aliveMembers(this.party)) {
      other.resolve = Math.max(0, other.resolve - RESOLVE_ON_ALLY_DEATH);
    }
    this.advAtb.delete(adv.id);
  }

  /** Returns true if the raid ended. */
  private checkPartyState(): boolean {
    if (aliveMembers(this.party).length === 0) {
      this.finish('wiped', 'wiped');
      return true;
    }
    if (avgResolvePct(this.party) <= 0) {
      this.finish('retreated', 'resolve');
      return true;
    }
    return false;
  }

  private advanceRoom(): void {
    this.room++;
    this.roomEntered = false;
    const floorDef = this.d.floors[this.floor]!;
    if (this.room < floorDef.rooms.length) return;

    // Floor cleared. Every floor has a Landing beneath it, including the
    // deepest — that one is the Core approach.
    this.deepestFloor = Math.max(this.deepestFloor, this.floor + 1);
    this.phase = 'landing';
  }

  private get atDeepestFloor(): boolean {
    return this.floor >= this.d.floors.length - 1;
  }

  // ─── Landing: rest, shop, decide (§7.3) ────────────────────────────────────

  private stepLanding(): void {
    const landingIdx = this.floor;
    this.emit({ t: this.tick, type: 'landing-enter', landing: landingIdx });

    this.doRest();
    this.doShopping(landingIdx);

    const reason = this.descentDecision();
    if (reason === null) {
      // They press on. Below the deepest floor there is only the Core.
      if (this.atDeepestFloor) this.breachCore();
      else this.descend();
      return;
    }

    // They want to leave. Offer the Taunt if we can pay for it (§7.4).
    //
    // Not at the deepest landing though: there is no floor below to taunt them
    // into, only the Core, so it would be a guaranteed Heart loss and never
    // the right call. Taunt becomes available once you have dug a second floor.
    if (this.leyCharges > 0 && !this.atDeepestFloor) {
      this.pendingTaunt = { landing: landingIdx, reason };
      this._status = 'awaiting-taunt';
      this.emit({ t: this.tick, type: 'taunt-offer', landing: landingIdx, reason });
      return;
    }
    this.finish('retreated', reason);
  }

  private doRest(): void {
    const alive = aliveMembers(this.party);
    const kitSpent = Math.min(alive.length, this.party.kit);
    let hpRestored = 0;

    // Kit is what converts to lasting damage — no Kit, no heal (§7.3).
    for (let i = 0; i < kitSpent; i++) {
      const m = alive[i]!;
      const heal = Math.round(m.maxHp * TUNING.restHealPct);
      const before = m.hp;
      m.hp = Math.min(m.maxHp, m.hp + heal);
      hpRestored += m.hp - before;
    }
    this.party.kit -= kitSpent;

    for (const m of alive) {
      m.resolve = Math.min(m.maxResolve, m.resolve + m.maxResolve * REST_RESOLVE_PCT);
    }

    this.emit({
      t: this.tick, type: 'rest',
      hpRestored, kitSpent, kitLeft: this.party.kit,
    });
  }

  private doShopping(landingIdx: number): void {
    const landing = this.d.landings[landingIdx];
    if (!landing) return;

    for (let slot = 0; slot < landing.amenities.length; slot++) {
      const a = landing.amenities[slot];
      if (!a || !isOpen(a)) continue;
      const key = `${landingIdx}:${slot}`;
      // Hirelings have no Commerce track — that is what the monster is for.
      const staff = a.staffUid !== null ? getMob(this.d, a.staffUid) : undefined;
      if (a.staffUid !== null && (!staff || !staff.alive)) continue;

      const def = AMENITIES[a.defId];
      const pricing = PRICE_TIERS[a.price];
      const commerceMult = 1 + COMMERCE_REVENUE_PER_LEVEL * ((staff?.commerceLevel ?? 1) - 1);
      const price = Math.round(def.basePrice * pricing.mult * commerceMult);

      for (const adv of aliveMembers(this.party)) {
        if (a.defId === 'hotspring') {
          const wants = adv.hp / adv.maxHp < 0.85;
          if (!wants || adv.gold < price) continue;
          if (!this.rng.chance(pricing.usage + adv.greed)) continue;
          adv.gold -= price;
          this.goldFromSales += price;
          const heal = Math.round(adv.maxHp * HOTSPRING_HEAL_PCT);
          adv.hp = Math.min(adv.maxHp, adv.hp + heal);
          this.amenitiesUsed.add(key);
          this.recordSale(staff, landingIdx, a.defId, adv, price, `+${heal} HP`);
        } else {
          const need = aliveMembers(this.party).length * 1.5;
          if (this.party.kit >= need) break;
          if (adv.gold < price) continue;
          if (!this.rng.chance(pricing.usage + adv.greed)) continue;
          const affordable = Math.floor(adv.gold / price);
          const qty = Math.min(PROVISIONER_MAX_KIT, affordable);
          if (qty <= 0) continue;
          const spend = qty * price;
          adv.gold -= spend;
          this.goldFromSales += spend;
          this.party.kit += qty;
          this.amenitiesUsed.add(key);
          this.recordSale(staff, landingIdx, a.defId, adv, spend, `+${qty} Kit`);
        }
      }
    }
  }

  private recordSale(
    staff: Mob | undefined, landing: number, amenity: 'hotspring' | 'provisioner',
    adv: Adventurer, gold: number, detail: string,
  ): void {
    if (staff) grantCommerceXp(staff, COMMERCE_XP_PER_SALE);
    this.emit({
      t: this.tick, type: 'purchase',
      landing, amenity, advId: adv.id, gold, detail,
    });
  }

  /** Null means "they descend". Otherwise, why they turned back (§7.3). */
  private descentDecision(): RetreatReason | null {
    const alive = aliveMembers(this.party);
    if (alive.length === 0) return 'wiped';

    const greedMod = alive.reduce((s, m) => s + m.greed, 0) / alive.length;

    if (avgHpPct(this.party) <= DESCEND_HP_THRESHOLD - greedMod) return 'hp';

    // Berrick's whole trait: he does not care that the packs are empty (§9.2).
    const ignoresKit = partyHasNamed(this.party, 'berrick');
    if (!ignoresKit && this.party.kit <= alive.length * DESCEND_KIT_PER_MEMBER) return 'kit';

    if (avgResolvePct(this.party) <= DESCEND_RESOLVE_THRESHOLD) return 'resolve';

    return null;
  }

  private descend(): void {
    this.floor++;
    this.room = 0;
    this.roomEntered = false;
    this.phase = 'room';
    this.emit({ t: this.tick, type: 'descend', toFloor: this.floor });
    this.emit({ t: this.tick, type: 'floor-enter', floor: this.floor });
  }

  private breachCore(): void {
    this.d.hearts = Math.max(0, this.d.hearts - 1);
    this.emit({ t: this.tick, type: 'core-breach', heartsLeft: this.d.hearts });
    // A Heart loss scatters them home alive — a huge Renown spike (§5.4).
    this.finish('breach', 'hp');
  }

  private finish(outcome: RaidOutcome, reason: RetreatReason): void {
    if (this._status === 'complete') return;
    if (outcome === 'retreated') {
      this.emit({ t: this.tick, type: 'retreat', reason });
    }
    this.resolveDowned(outcome);
    // Scored once, here, rather than in the `result` getter: retirement mutates
    // the veteran roster, and the getter is read repeatedly by the UI.
    this.scoreDelve();
    this.outcome = outcome;
    this._status = 'complete';
    this.emit({ t: this.tick, type: 'raid-end', outcome });
  }

  // ─── Thrill (§15.3) ────────────────────────────────────────────────────────

  /**
   * Amenities the party could have used, by the same open/staffed test the
   * shopping pass uses — an amenity nobody can serve at is not on offer.
   */
  private openAmenityCount(): number {
    let n = 0;
    for (const landing of this.d.landings) {
      for (const a of landing.amenities) {
        if (!a || !isOpen(a)) continue;
        const staff = a.staffUid !== null ? getMob(this.d, a.staffUid) : undefined;
        if (a.staffUid !== null && (!staff || !staff.alive)) continue;
        n++;
      }
    }
    return n;
  }

  /**
   * Thrill per survivor, meaned (§15.3). You are running an attraction, and
   * the score is the quality of the ride: how close to death they came, how
   * deep they got, how much of the bestiary they met, how well they were
   * looked after — less the tedium of empty and repeated rooms.
   */
  private scoreDelve(): void {
    const tedium =
      TUNING.tediumPerEmptyRoom * this.emptyRooms
      + TUNING.tediumPerRepeatedRoom * this.repeatedRooms;

    const survivors = aliveMembers(this.party);
    // Dead men tell no tales. A wipe scores nothing, which is the principled
    // replacement for the old flat ×0.5 wipe multiplier (§15.3).
    if (survivors.length === 0) {
      this.thrillScore = { ...ZERO_THRILL, tedium };
      return;
    }

    const depth = clamp01(this.deepestFloor / this.d.floors.length);
    const variety = Math.min(this.rolesFaced.size, VARIETY_ROLE_CAP) / VARIETY_ROLE_CAP;
    const open = this.openAmenityCount();
    const comfort = open > 0 ? clamp01(this.amenitiesUsed.size / open) : 0;

    const scored: { adv: Adventurer; thrill: number }[] = [];
    let perilSum = 0;
    let thrillSum = 0;

    for (const adv of survivors) {
      const peril = clamp01(1 - adv.lowestHpPct);
      perilSum += peril;
      const raw =
        100 * (
          TUNING.thrillPerilWeight * peril
          + TUNING.thrillDepthWeight * depth
          + TUNING.thrillVarietyWeight * variety
          + TUNING.thrillComfortWeight * comfort
        ) - tedium;
      // Floored at zero: Renown is a ratchet that only goes up (§4.4), so a
      // tedious delve pays nothing rather than costing you reputation.
      const thrill = Math.max(0, raw);
      thrillSum += thrill;
      scored.push({ adv, thrill });
      this.perAdvThrill.set(adv.id, thrill);
    }

    this.thrillScore = {
      total: thrillSum / survivors.length,
      peril: perilSum / survivors.length,
      depth,
      variety,
      comfort,
      tedium,
    };
    this.retiredThisRaid = this.resolveRetirements(scored);
  }

  /**
   * A great delve can be somebody's last (§15.5). Retiring costs you the
   * adventurer permanently — and their future gold — in exchange for a Legend
   * on the wall.
   */
  private resolveRetirements(scored: { adv: Adventurer; thrill: number }[]): Legend[] {
    const out: Legend[] = [];
    for (const { adv, thrill } of scored) {
      if (thrill < TUNING.retireThrill) continue;
      const vet = adv.veteranId !== null
        ? this.veterans.find((v) => v.id === adv.veteranId)
        : undefined;
      // +1 counts the delve they have just walked out of; season.ts does the
      // actual increment during the Aftermath, after this runs.
      if ((vet?.delves ?? 0) + 1 < TUNING.retireMinDelves) continue;
      if (vet) vet.retired = true;
      // `retiredOnRaid` is stamped by season.ts — the sim has no raid counter.
      out.push({ name: adv.name, thrill: Math.round(thrill), retiredOnRaid: 0 });
    }
    return out;
  }

  /**
   * Decide which downed monsters actually died. Rolled inside the sim so it
   * stays part of the deterministic event stream.
   *
   * A breach slays everyone who fell — the dungeon was overrun and nobody came
   * back for them. That is most of what makes losing a Heart hurt.
   */
  private resolveDowned(outcome: RaidOutcome): void {
    for (const entry of this.mobsDowned) {
      const mob = getMob(this.d, entry.uid);
      if (!mob || !mob.alive) continue;
      const slain = outcome === 'breach' || this.rng.chance(TUNING.slayChance);
      if (!slain) continue;
      this.mobsLost.push(entry);
      this.emit({
        t: this.tick, type: 'mob-slain',
        uid: entry.uid, defId: entry.defId, level: entry.level,
      });
      slayMob(this.d, entry.uid);
    }
  }

  // ─── Result ────────────────────────────────────────────────────────────────

  get result(): RaidResult {
    const outcome = this.outcome ?? 'retreated';
    const escaped = aliveMembers(this.party).length;
    const namedKilled = this.party.members.filter((m) => !m.alive && m.namedId).length;

    const souls = Math.round(
      this.killed * SOULS_PER_KILL * soulsTierMult(this.tier.tier)
      + namedKilled * SOULS_PER_NAMED,
    );

    // The reframe (§15.3): reputation is the quality of the delve, not the
    // headcount that walked out. The flag keeps the old flat formula reachable
    // so tools/balance.ts can measure the two head to head.
    let renown: number;
    if (TUNING.thrillRenown) {
      renown =
        this.thrillScore.total * escaped * TUNING.renownPerThrill
        + this.retiredThisRaid.length * TUNING.retireRenownBonus;
    } else {
      renown =
        escaped * RENOWN_PER_ESCAPEE
        + this.killed * RENOWN_PER_KILL
        + this.goldFromSales * RENOWN_PER_GOLD;
      if (outcome === 'wiped') renown *= RENOWN_WIPE_MULT;
    }

    return {
      outcome,
      killed: this.killed,
      escaped,
      goldFromSales: this.goldFromSales,
      goldFromCorpses: this.goldFromCorpses,
      souls,
      renown: Math.round(renown),
      thrill: this.thrillScore,
      retired: this.retiredThisRaid,
      mobsDowned: this.mobsDowned,
      mobsLost: this.mobsLost,
      deepestFloorReached: this.deepestFloor,
      ticks: this.tick,
    };
  }

  /** Mana earned from kills this raid; the rest of the formula is in season.ts. */
  get manaFromKills(): number {
    return this.killed * MANA_PER_KILL;
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export { mobMaxHp };
