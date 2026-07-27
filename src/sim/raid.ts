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
  GRUDGE_TRAIT, HOTSPRING_HEAL_PCT, LEY_CHARGES, MANA_PER_KILL, MOBS,
  PRICE_TIERS, PROVISIONER_MAX_KIT, RENOWN_PER_ESCAPEE, RENOWN_PER_GOLD,
  RENOWN_PER_KILL, RENOWN_WIPE_MULT, REST_RESOLVE_PCT, RESOLVE_ON_ALLY_DEATH,
  SOULS_PER_KILL, SOULS_PER_NAMED, TRAPS, TUNING, XP_PER_HIT, XP_PER_KILL,
  CLASS_MODS, mobMaxHp, soulsTierMult, trapPower, type TierRow,
} from './data';
import {
  armedTrapsInRoom, downMob, getMob, getTrap, grantCommerceXp, grantXp, isOpen,
  mobEffectiveDmg, mobStripsKit, mobsInRoom, packMultiplier, slayMob,
} from './dungeon';
import { Rng } from './rng';
import {
  aliveMembers, avgHpPct, avgResolvePct, generateParty, partyHasNamed,
} from './adventurers';
import type {
  Adventurer, Dungeon, GrudgeReason, Legend, Mob, MobRole, Party, RaidEvent,
  RaidOutcome, RaidResult, RetreatReason, RivalNote, ThrillScore, Trap, TrapJob,
  Veteran,
} from './types';

export type RaidStatus = 'running' | 'awaiting-taunt' | 'complete';

/** Safety valve: no raid may spin forever. */
const MAX_TICKS = 3000;

/** `variety` saturates here — four distinct roles is already a varied dungeon (§15.3). */
/**
 * Roles that count toward full variety marks.
 *
 * The prototype bestiary fields exactly three (skirmisher, bruiser, warden), so
 * a cap of 4 made `variety` unreachable above 0.75 — a component permanently
 * short of full marks reads as a bug to the player and silently deflates every
 * Thrill score. Raise this when caster/terror/ambusher monsters ship (§6.3).
 */
const VARIETY_ROLE_CAP = 3;

const ZERO_THRILL: ThrillScore = {
  total: 0, peril: 0, depth: 0, variety: 0, comfort: 0, tedium: 0,
};

/**
 * How much of the non-peril score a delve at this peril is allowed to bank
 * (§15.1). Excitement without intensity is a kiddie ride: a dungeon that is
 * long, varied and comfortable but never frightening should not out-earn one
 * that put people in genuine danger.
 *
 * Returns 1 when the gate is disabled, which restores the flat §15.3 sum.
 */
export function perilGate(peril: number): number {
  const k = TUNING.thrillPerilGate;
  if (k <= 0) return 1;
  return clamp01(peril / k);
}

/**
 * The Thrill formula itself (§15.3), pulled out of the sim so the Build-Phase
 * estimator can score a hypothetical dungeon with exactly the same arithmetic
 * the raid will use. Duplicating it was how the two drifted apart.
 */
export function thrillFromParts(p: {
  peril: number; depth: number; variety: number; comfort: number; tedium: number;
}): number {
  const gate = perilGate(p.peril);
  const raw =
    100 * (
      TUNING.thrillPerilWeight * p.peril
      + gate * (
        TUNING.thrillDepthWeight * p.depth
        + TUNING.thrillVarietyWeight * p.variety
        + TUNING.thrillComfortWeight * p.comfort
      )
    ) - p.tedium;
  // Floored at zero: Renown is a ratchet that only goes up (§4.4), so a tedious
  // delve pays nothing rather than costing you reputation.
  return Math.max(0, raw);
}

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

  /**
   * Ticks the party is held for by a Snare (§5.2 `delay`). While this is
   * positive the adventurers forfeit their actions and the room's monsters
   * keep swinging — which is the entire value of a delay trap: it does nothing
   * on its own and multiplies whatever is standing behind it.
   *
   * Cleared on leaving the room. A net does not follow people downstairs.
   */
  private stunTicks = 0;

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
  /**
   * Distinct trap jobs that actually went off (§5.2). Only *fired* traps go in
   * here — an armed trap the party never reached made no impression, and a
   * spent one is a hole in the floor.
   */
  private trapJobsFaced = new Set<TrapJob>();
  private amenitiesUsed = new Set<string>();
  private thrillScore: ThrillScore = ZERO_THRILL;
  private retiredThisRaid: Legend[] = [];
  private perAdvThrill = new Map<number, number>();
  /** Recurring faces and what this delve did to them (§9.3, §9.4). */
  private rivalNotes: RivalNote[] = [];

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

  /**
   * Intervention: **Spring** (§7.4) — trigger a trap early, out of sequence.
   *
   * Costs a Ley Charge and fires any armed trap in the dungeon at the party's
   * current position, wherever the trap happens to be installed. Two things
   * make that worth a charge:
   *
   * 1. **Reach.** A trap on Floor 3 is dead mana against a party that turns
   *    back on Floor 1. Spring is the only way to convert it.
   * 2. **Timing.** A trap normally goes off on the threshold, before anyone has
   *    swung. Sprung, it lands in the middle of a fight the player is losing —
   *    a Snare while the Ogre is still up, or a Gas Vent the tick before they
   *    would have drunk their last Kit.
   *
   * It is deliberately possible to waste: springing a trap they were going to
   * walk into anyway spends a Ley Charge for nothing. `TUNING.springMult` is
   * 1.0 so the decision stays about *when*, not about damage.
   */
  applySpringIntervention(uid: number): boolean {
    if (this._status !== 'running' || this.leyCharges <= 0) return false;
    const trap = getTrap(this.d, uid);
    if (!trap || trap.charges <= 0) return false;
    if (aliveMembers(this.party).length === 0) return false;

    this.leyCharges--;
    this.fireTrap(trap, true);
    this.checkPartyState();
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
      // Sampled before anything fires, so a trap that is about to spend its
      // last charge still counts as content the party walked into (§15.3).
      this.noteRoomTraversed();
      // Traps go off on the threshold, ahead of the ambush round and ahead of
      // the first exchange (§7.2 step 1). The party arrives at the fight
      // already lighter, already hurt, or already held — which is the only
      // reason to put one in front of a monster rather than buy another
      // monster.
      this.fireRoomTraps();
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

    // Held by a Snare: the monsters got their turn above, the party does not
    // get theirs. One tick of the net is spent per tick of the fight.
    if (this.stunTicks > 0) {
      this.stunTicks--;
    } else {
      for (const adv of aliveMembers(this.party)) {
        let acc = (this.advAtb.get(adv.id) ?? 0) + 1;
        while (acc >= 1) {
          acc -= 1;
          this.advAct(adv);
        }
        this.advAtb.set(adv.id, acc);
      }
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
    // ARMED traps only. A spent trap is a hole in the floor, and a room whose
    // only occupant is a hole in the floor is an empty room — which is what
    // stops traps being a way to buy Tedium relief once and collect it every
    // raid forever. Keeping the room "occupied" means paying to re-arm it, and
    // `trapRearmScalar` is set so that bill exceeds the Tedium it saves.
    const traps = armedTrapsInRoom(this.d, this.floor, this.room);

    if (mobs.length === 0 && traps.length === 0) {
      this.emptyRooms++;
      // Empty rooms already pay tediumPerEmptyRoom; charging them the repeat
      // penalty as well would double-bill the same corridor.
      this.lastRoomSig = null;
      return;
    }

    for (const m of mobs) this.rolesFaced.add(MOBS[m.defId]!.role);

    // Same cast as the room before it — nine identical Ogre rooms is a bad
    // dungeon by rule, not just by taste (§15.4). Traps are in the signature
    // for the same reason: a corridor of nine Dart Batteries is the same
    // failure with a smaller budget.
    const sig = [
      ...mobs.map((m) => m.defId),
      ...traps.map((t) => `trap:${t.defId}`),
    ].sort().join(',');
    if (sig === this.lastRoomSig) this.repeatedRooms++;
    this.lastRoomSig = sig;
  }

  // ─── Traps (§5.2) ──────────────────────────────────────────────────────────

  /** Everything armed in this room goes off, in installation order. */
  private fireRoomTraps(): void {
    for (const trap of armedTrapsInRoom(this.d, this.floor, this.room)) {
      if (aliveMembers(this.party).length === 0) return;
      this.fireTrap(trap, false);
    }
  }

  /**
   * Spend one charge and apply the effect.
   *
   * Traps never level, never take damage and never die — they are the one
   * thing in the dungeon that does not improve (§6.4 is about monsters and
   * always was). What they have instead is that they cost nothing to own.
   */
  private fireTrap(trap: Trap, sprung: boolean): void {
    const def = TRAPS[trap.defId];
    if (!def || trap.charges <= 0) return;
    trap.charges--;

    const at = trap.placement.kind === 'room'
      ? trap.placement
      : { floor: this.floor, room: this.room };
    this.emit({
      t: this.tick, type: 'trap-fire', uid: trap.uid, defId: trap.defId,
      floor: at.floor, room: at.room, sprung, chargesLeft: trap.charges,
    });
    // Only a trap that actually went off is content the party experienced —
    // and even then the whole trap layer is capped at `trapVarietyCredit`
    // toward `variety`. See TUNING for why.
    this.trapJobsFaced.add(def.job);

    const power = trapPower(trap.defId, sprung);
    const alive = aliveMembers(this.party);
    if (alive.length === 0) return;

    switch (def.job) {
      case 'damage':
        // Every member, armour ignored. Deliberately spread: it is the trap
        // that makes a room *survivable to enter and expensive to leave*,
        // rather than the trap that picks a victim.
        for (const adv of [...alive]) this.trapDamage(trap, adv, power);
        break;

      case 'burst': {
        // The healthiest body — which in practice is the one that has not been
        // hit yet, i.e. the tank walking point.
        const target = alive.reduce((a, b) => (b.hp > a.hp ? b : a));
        this.trapDamage(trap, target, power);
        break;
      }

      case 'kit': {
        // §7.3: no Kit, no rest heal — so this is the cheapest way in the game
        // to make HP damage stick. It also drives the Descent Decision, which
        // is the "send them home" win condition (§7.5) available to a dungeon
        // that cannot afford a Warden.
        const taken = Math.min(this.party.kit, power);
        if (taken <= 0) break;
        this.party.kit -= taken;
        this.party.kitStripped += taken;
        this.emit({
          t: this.tick, type: 'trap-kit', uid: trap.uid, defId: trap.defId,
          amount: taken, kitLeft: this.party.kit,
        });
        break;
      }

      case 'resolve':
        // Routed through applyResolveDamage so the traits that exist to stop
        // Terror stop this too — Vess is immune, 'steeled' halves it (§9.2,
        // §9.3). A trap should not be a way around published counter-play.
        for (const adv of [...alive]) {
          const amount = this.applyResolveDamage(adv, power);
          if (amount > 0) {
            this.emit({
              t: this.tick, type: 'resolve-hit', advId: adv.id,
              amount, resolveLeft: adv.resolve,
            });
          }
        }
        break;

      case 'delay':
        this.stunTicks += power;
        this.emit({
          t: this.tick, type: 'trap-snare', uid: trap.uid,
          defId: trap.defId, ticks: power,
        });
        break;
    }
  }

  /** Trap damage. Ignores armour, feeds peril, and can kill. */
  private trapDamage(trap: Trap, adv: Adventurer, amount: number): void {
    if (!adv.alive) return;
    const dmg = Math.max(1, Math.round(amount));
    adv.hp = Math.max(0, adv.hp - dmg);
    adv.hurtByTrap = (adv.hurtByTrap ?? 0) + dmg;
    // Traps count toward `peril` exactly like a monster does. They are part of
    // how close the party came to dying, and pretending otherwise would make
    // a trap dungeon quietly unprofitable under §15.
    const pct = adv.hp / adv.maxHp;
    if (pct < adv.lowestHpPct) {
      adv.lowestHpPct = pct;
      if (pct <= TUNING.patronCautionHpPct) adv.nearDeathFloor = this.floor;
    }
    this.emit({
      t: this.tick, type: 'trap-hit', uid: trap.uid, defId: trap.defId,
      advId: adv.id, dmg,
    });
    if (adv.hp <= 0) this.killAdventurer(adv);
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

  // ─── Trait effects (§9.2 named, §9.3 learned) ──────────────────────────────

  /**
   * Resolve damage, filtered through the traits that exist to stop it (§9.2).
   * Returns the amount actually taken, so the caller can decide whether it is
   * worth an event.
   */
  private applyResolveDamage(adv: Adventurer, amount: number): number {
    // Marrow-Knight Vess: immune to Resolve damage. Terror builds do nothing
    // to him at all — that is the entire point of him.
    if (adv.namedId === 'vess') return 0;
    // 'Steeled': they have run from this dungeon before and are not doing it
    // again quite so fast (§9.3).
    let taken = amount;
    if (adv.traits.includes('steeled')) taken = amount * (1 - TUNING.learnedResolveResist);
    taken = Math.min(adv.resolve, Math.max(0, Math.round(taken)));
    if (taken <= 0) return 0;
    adv.resolve -= taken;
    adv.resolveLost += taken;
    return taken;
  }

  /**
   * The Quiet Twins split the party down two paths, so only half your monsters
   * are ever in the room they are in (§9.2). No pathing exists in the
   * prototype, so the density loss lands on the damage instead — same counter,
   * same target: the single heavily stacked choke room.
   */
  private densityMult(): number {
    return partyHasNamed(this.party, 'twins') ? TUNING.twinsDensityMult : 1;
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
    const raw = mobEffectiveDmg(mob) * packMultiplier(mob, allies) * this.densityMult();

    if (role === 'terror') {
      const amount = this.applyResolveDamage(target, Math.max(1, Math.round(raw)));
      if (amount > 0) {
        this.emit({
          t: this.tick, type: 'resolve-hit', advId: target.id,
          amount, resolveLeft: target.resolve,
        });
      }
      grantXp(mob, XP_PER_HIT);
      return;
    }

    const dmg = Math.max(1, Math.round(raw - target.armor));
    target.hp = Math.max(0, target.hp - dmg);
    // Who is doing the hurting, so a returning adventurer can adapt to *this*
    // dungeon rather than to dungeons in general (§9.3).
    target.hurtByRole[role] = (target.hurtByRole[role] ?? 0) + dmg;
    // The low-water mark is the whole of `peril` (§15.3): what matters is how
    // close they came, not what they limped out on.
    const pct = target.hp / target.maxHp;
    if (pct < target.lowestHpPct) {
      target.lowestHpPct = pct;
      // The floor a Patron will not go past next time (§9.4).
      if (pct <= TUNING.patronCautionHpPct) target.nearDeathFloor = this.floor;
    }
    this.emit({
      t: this.tick, type: 'attack', source: 'mob',
      uid: mob.uid, targetId: target.id, dmg,
    });

    if (mobStripsKit(mob) && this.party.kit > 0) {
      this.party.kit -= 1;
      this.party.kitStripped++;
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
      this.applyResolveDamage(other, RESOLVE_ON_ALLY_DEATH);
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
    // A net does not follow people down the corridor.
    this.stunTicks = 0;
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
    this.doTheft(landingIdx);

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
      const list = def.basePrice * pricing.mult * commerceMult;

      for (const adv of aliveMembers(this.party)) {
        const price = this.priceFor(adv, list);
        if (a.defId === 'hotspring') {
          const wants = adv.hp / adv.maxHp < 0.85;
          if (!wants || adv.gold < price) continue;
          if (!this.rng.chance(pricing.usage + adv.greed)) continue;
          this.takePayment(adv, price);
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
          this.takePayment(adv, spend);
          this.party.kit += qty;
          this.amenitiesUsed.add(key);
          this.recordSale(staff, landingIdx, a.defId, adv, spend, `+${qty} Kit`);
        }
      }
    }
  }

  /**
   * What this particular adventurer pays. Two traits attack the commerce build
   * from opposite ends: Coin-Cutter Sable was born knowing your margins (§9.2),
   * and a Haggler learned them by overpaying here three raids running (§9.3).
   */
  private priceFor(adv: Adventurer, list: number): number {
    let mult = 1;
    if (adv.namedId === 'sable') mult *= 0.5;
    if (adv.traits.includes('haggler')) mult *= TUNING.learnedHagglePct;
    return Math.max(1, Math.round(list * mult));
  }

  /** One place to bank a sale, so the Patron track cannot miss a transaction. */
  private takePayment(adv: Adventurer, amount: number): void {
    adv.gold -= amount;
    adv.goldSpentHere += amount;
    this.goldFromSales += amount;
  }

  /**
   * Coin-Cutter Sable lifts gold from the till at every Landing that has
   * something on it (§9.2). §11 Q9 keeps shops as neutral ground for everyone
   * else; Sable is the exception that proves the rule.
   */
  private doTheft(landingIdx: number): void {
    if (!partyHasNamed(this.party, 'sable')) return;
    const landing = this.d.landings[landingIdx];
    if (!landing || !landing.amenities.some((a) => a && isOpen(a))) return;
    const taken = Math.min(this.goldFromSales, TUNING.sableTheft);
    if (taken <= 0) return;
    this.goldFromSales -= taken;
    const sable = aliveMembers(this.party).find((m) => m.namedId === 'sable');
    if (sable) {
      sable.gold += taken;
      // Stolen back, so it does not count as money he spent here — the Patron
      // track must not be farmable by a thief.
      sable.goldSpentHere = Math.max(0, sable.goldSpentHere - taken);
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

    // §9.4: a Patron will not descend past the floor they nearly died on. This
    // is checked first and unconditionally, because it is not a judgement about
    // this delve — it is a standing rule they arrived with. It also caps how
    // much of your dungeon your best customer will ever see, which is the price
    // of the income stream.
    const cautious = alive.find(
      (m) => m.cautiousFloor !== null && this.floor >= m.cautiousFloor,
    );
    if (cautious) return 'patron';

    // Guildmaster Oros: the party leaves on his order alone. No threshold in
    // §7.3 can turn this party back — they either breach or they die (§9.2).
    if (partyHasNamed(this.party, 'oros')) return null;

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
    this.stunTicks = 0;
    this.phase = 'room';
    // Sister Ivane restores 1 Kit to the party on every floor she enters
    // (§9.2). A drain dungeon can still out-strip her — it just cannot win by
    // arithmetic alone any more.
    if (partyHasNamed(this.party, 'ivane')) {
      this.party.kit = Math.min(this.party.maxKit, this.party.kit + 1);
    }
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
    this.recordGrudges(reason);
    this.rivalNotes = this.buildRivalNotes();
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
  /**
   * `variety` (§15.3): distinct monster roles met, plus a capped credit for
   * having met any traps at all.
   *
   * Traps count — they are part of what makes a delve worth describing, and a
   * Tedium rule that says "an armed trap is not an empty room" while a variety
   * rule says "a trap is nothing" would be two rules disagreeing about the
   * same object.
   *
   * But the whole trap layer is worth at most `TUNING.trapVarietyCredit`,
   * however many distinct jobs fired. Uncapped, four traps — around 190 mana,
   * no upkeep, no bestiary — would score full marks on the term that is
   * supposed to reward a wide roster, which is §15.1's exploit with a
   * different sign on it. Adventurers tell stories about the things that fought
   * back. A trap is scenery with a punchline: the first is a beat, the fourth
   * is a corridor.
   */
  private varietyScore(): number {
    const trapCredit = Math.min(this.trapJobsFaced.size, TUNING.trapVarietyCredit);
    const distinct = this.rolesFaced.size + trapCredit;
    return Math.min(distinct, VARIETY_ROLE_CAP) / VARIETY_ROLE_CAP;
  }

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

    // Absolute floors cleared, not the fraction of *this* dungeon cleared —
    // see TUNING.thrillDepthFloors for why the §15.3 ratio was backwards.
    const depth = clamp01(this.deepestFloor / TUNING.thrillDepthFloors);
    const variety = this.varietyScore();
    const open = this.openAmenityCount();
    const comfort = open > 0 ? clamp01(this.amenitiesUsed.size / open) : 0;

    const scored: { adv: Adventurer; thrill: number }[] = [];
    let perilSum = 0;
    let thrillSum = 0;

    for (const adv of survivors) {
      const peril = clamp01(1 - adv.lowestHpPct);
      perilSum += peril;
      // Gated per adventurer, not per party: the one who nearly died banks the
      // full length of the walk, the three who strolled behind them do not.
      const thrill = thrillFromParts({ peril, depth, variety, comfort, tedium });
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

  // ─── The Nemesis track: what they learned (§9.3) ───────────────────────────

  /**
   * Work out what each survivor takes home from this delve.
   *
   * This is the whole hook, so it is worth being explicit about the design
   * choice: **the grudge is a deterministic read of what your dungeon did to
   * them.** It is not rolled. Drain someone's pack and they come back
   * provisioned; put them under an Ogre and they come back plated; break their
   * nerve and they come back steeled. The counter-play the player faces on raid
   * six is a mirror of the dungeon they built on raid three, which means the
   * escalation is legible, predictable, and theirs.
   *
   * The retreat reason comes first because it is literally "why they left".
   * Damage is the fallback: someone can walk out of a bruiser floor at 10% HP
   * without the party ever failing a threshold.
   */
  private recordGrudges(reason: RetreatReason): void {
    for (const adv of aliveMembers(this.party)) {
      adv.grudge = this.grudgeFor(adv, reason);
    }
  }

  private grudgeFor(adv: Adventurer, reason: RetreatReason): GrudgeReason | null {
    if (reason === 'resolve') return 'nerve';
    if (reason === 'kit') return 'supplies';

    // Otherwise: whatever hurt them most, but only if it genuinely hurt. A
    // grudge you can pick up from a scratch is not a grudge (§9.3).
    if (adv.lowestHpPct <= TUNING.grudgeHurtHpPct) {
      let topRole: MobRole | null = null;
      let top = 0;
      for (const [role, dealt] of Object.entries(adv.hurtByRole)) {
        if (dealt > top) {
          top = dealt;
          topRole = role as MobRole;
        }
      }
      // A mechanism outdid every monster down there. It teaches 'hale' — you
      // come back thicker, not armoured, because armour does nothing against a
      // dart that ignores it. Same deterministic rule as everything else in
      // §9.3: the counter-play is a mirror of what the player built.
      if ((adv.hurtByTrap ?? 0) > top) return 'swarm';
      switch (topRole) {
        case 'skirmisher':
        case 'ambusher':
          return 'swarm';     // bled a scratch at a time → 'hale'
        case 'warden':
          return 'supplies';  // the thing taking their pack was also hitting them
        case 'terror':
          return 'nerve';
        case null:
          break;
        default:
          return 'muscle';    // bruiser, caster, support → 'armored'
      }
    }

    // Resolve took a beating without breaking. They noticed.
    if (adv.resolveLost >= adv.maxResolve * 0.5) return 'nerve';

    // Nothing hurt them — but they left a lot lighter than they arrived. The
    // commerce build has its own opposition, and this is where it comes from.
    if (adv.startGold > 0 && adv.goldSpentHere >= adv.startGold * TUNING.patronSpendFraction) {
      return 'coin';
    }

    return null;
  }

  /**
   * The narrator's raw material (§9.3, §9.4).
   *
   * Only faces with a persistent identity get a note: a returning veteran, or a
   * named adventurer on any visit. A generic first-timer has no story yet.
   * `becameNemesis` / `becamePatron` and the post-raid counters are stamped by
   * season.ts, which is where the roster is actually updated.
   */
  private buildRivalNotes(): RivalNote[] {
    const out: RivalNote[] = [];
    for (const adv of this.party.members) {
      if (adv.veteranId === null && adv.namedId === null) continue;
      const vet = adv.veteranId !== null
        ? this.veterans.find((v) => v.id === adv.veteranId)
        : undefined;
      const grudge = adv.alive ? adv.grudge : null;
      out.push({
        veteranId: adv.veteranId,
        advId: adv.id,
        name: adv.name,
        namedId: adv.namedId,
        rank: adv.rank,
        traits: [...adv.traits],
        wasNemesis: adv.isNemesis,
        wasPatron: adv.isPatron,
        becameNemesis: false,
        becamePatron: false,
        survived: adv.alive,
        goldSpent: adv.goldSpentHere,
        grudge,
        // A trait they already carry teaches them nothing new — surfacing it as
        // "learned" would have the narrator announce the same beat every raid.
        learned: grudge && !adv.traits.includes(GRUDGE_TRAIT[grudge]!)
          ? GRUDGE_TRAIT[grudge]!
          : null,
        escapes: vet?.escapes ?? 0,
        bigSpends: vet?.bigSpends ?? 0,

      });
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

    // Killing a recurring character ends something (§9.3, §9.4).
    //
    // SUBSTITUTION: §9.3 pays "triple Insight" for a Nemesis and §9.4 "a large
    // one-time Soul payout" for a Patron. Insight and the Codex are out of
    // prototype scope (§12), so the Nemesis bounty lands in Souls plus a Renown
    // spike — the story of the kill travels. Both are read off the state the
    // adventurer *arrived* with, so a face who became a Nemesis by escaping
    // three times and then died on the fourth visit pays out in full.
    let bountySouls = 0;
    let bountyRenown = 0;
    for (const adv of this.party.members) {
      if (adv.alive) continue;
      if (adv.isNemesis) {
        bountySouls += TUNING.nemesisKillSouls;
        bountyRenown += TUNING.nemesisKillRenown;
      }
      if (adv.isPatron) bountySouls += TUNING.patronKillSouls;
    }

    const souls = Math.round(
      this.killed * SOULS_PER_KILL * soulsTierMult(this.tier.tier)
      + namedKilled * SOULS_PER_NAMED
      + bountySouls,
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
    // Paid under either formula so the head-to-head stays a like-for-like
    // comparison of the Renown *rule*, not of who happened to kill a Nemesis.
    renown += bountyRenown;

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
      rivals: this.rivalNotes,
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
