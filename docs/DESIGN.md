# Coreward — Game Design Document

*Working title. A dungeon-builder / reverse tower-defense roguelite.*

**Version:** 0.3
**Status:** Prototype v0.1 built and playable. Numbers below marked ✅ have been
validated against the headless balance runner; the rest are still targets.

**Changes in 0.3 — all driven by balance data, see §14:** Landings now sit beneath
every floor including the deepest (§5.1, §7.3). Monster death is now Downed →
Slain rather than instant permadeath (§6.4). Economy retuned (§4.1). Gear and
Hired Staff pulled into prototype scope because Gold otherwise had no sink (§12).

**Changes in 0.2:** Added the Gold economy and Landing amenities (§8), monster gear
(§6.5), the Patron track (§9.4), and presentation/technical direction (§13).

---

## 1. Pitch

You are the intelligence at the bottom of a dungeon. You buy monsters, dig floors, and lay
traps — then adventurers come down to kill you.

The twist: you don't want to kill all of them. A dungeon that swallows every party stops
attracting parties. Survivors carry the story home, and the story is what brings the next,
richer, deadlier wave. And between your floors you run **shops, inns, and hot springs** —
because the party that just fought your ogre has gold in its pockets, and you would like
that gold.

Every raid is a three-way choice between **feeding on the dead**, **farming the living**,
and **doing business with them**.

**Genre:** Roguelite tower defense with base-building, unit persistence, and commerce
**Session length:** 45–75 min per season (a full run)
**Camera:** 2D cross-section, floors stacked vertically → isometric/2.5D (see §13)
**Tone:** Fantasy, dry humor, management-sim framing. You are the operator of a lethal
attraction, not a cackling villain.

---

## 2. Design Pillars

1. **The player sets the difficulty curve.** Renown is earned, not granted. Escalation is
   always a decision the player made. No wave counter dictating your fate.
2. **Three ways to win a floor.** Kill them, break their supplies, or break their nerve.
   Each is a distinct build, and the best dungeons use all three at different depths.
3. **Monsters are units, not turrets.** They level, they evolve, they carry gear, they die
   permanently. Losing a veteran is the emotional beat the genre usually lacks.
4. **Predation and commerce compete for the same adventurer.** Every gold piece you earn
   makes the person carrying it harder to kill. This is the design's central knot and it
   should never be resolvable — only navigable.

### Anti-pillars (things we are deliberately not doing)

- No lane-based pathing or maze-drawing. Depth replaces distance.
- No real-time twitch input. Raids resolve on a tick clock; player input during a raid is
  limited and deliberate.
- No "evil overlord" morality system. The fantasy is competence, not cruelty.

---

## 3. Core Loop

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   BUILD PHASE  ──►  RAID PHASE  ──►  AFTERMATH  ──┐       │
│   (untimed)         (~90 sec)        (~20 sec)    │       │
│   spend Mana/Gold   watch + 3        collect,     │       │
│   place mobs        interventions    level up,    │       │
│   dig, trap, stock  speed 1–4×       bury dead    │       │
│   staff amenities                    tally sales  │       │
│                                                   │       │
└───────────────────────────────────────────────────┘       │
            ▲                                               │
            └───────────────  ×12 raids  ◄──────────────────┘
                                │
                                ▼
                    SEASON END ──► spend Insight ──► new season
```

A **season** is one run: 12 raids. It ends early in failure if adventurers reach the Core.

---

## 4. Economy

Five currencies. Four are in-season, one is meta.

| Currency | Earned from | Spent on | Persists? |
|---|---|---|---|
| **Mana** | Passive trickle + kills + floor depth | Mobs, traps, digging, floor effects, building amenities | No |
| **Souls** | Kills only | Evolutions, reconstituting dead mobs, rare unlocks | No |
| **Gold** | Adventurers spending at your amenities | Monster gear, amenity upgrades, hired staff | No |
| **Renown** | Escapees ≫ kills | *Nothing.* It is a dial, not a wallet. | No |
| **Insight** | Season-end milestones | Permanent unlocks between seasons | **Yes** |

The split matters: **Mana builds the dungeon, Gold improves it.** You can win a season
without ever building a shop — you will just be poorer and your monsters will be naked.

### 4.1 Mana

Primary build currency. Income is calculated at Aftermath:

```
mana_income = 55                             # ✅ was 20
            + 40 × floors_built              # ✅ was 10
            + 3  × adventurers_killed
            + tier_bonus[threat_tier]        # 0, 5, 12, 20, 30, 42, 56, 72, 90, 110
            - total_upkeep                   # mobs + amenity operating costs
```

Starting Mana: **300**. ✅ It must buy a Floor 1 that can actually threaten Tier 1 —
at 260 or below the opening is a guaranteed Heart loss.

**Upkeep is the pressure valve.** Every placed mob and every open amenity costs mana per
raid. Overbuilding starves you. Mobs can be dismissed for 50% refund of base cost (losing
all levels), or put in **Stasis** — half upkeep, cannot fight, keeps levels.

### 4.2 Souls

Only kills produce Souls. This is the mechanical reason to ever kill anyone.

```
souls = 2 × adventurers_killed × tier_multiplier   # tier_mult = 1 + 0.3×(tier-1)
      + 15 per named adventurer killed
```

Souls are the *upgrade* currency. Mana makes your dungeon wider; Souls make it deeper.

### 4.3 Gold

See §8 for the full amenity system. In short: adventurers arrive carrying gold and spend
it on your services. Summary of the two ways to get it:

```
gold_from_sales  = 100% of what they choose to spend    # they must survive to spend it
gold_from_corpses = 25% of remaining gold on a kill     # the rest scatters
```

**Killing an adventurer destroys three quarters of their gold.** Predation and commerce
are not additive — they compete. A party that spends everything and walks out is worth
more gold than the same party dead in a pit.

### 4.4 Renown — the difficulty dial

```
renown = 6 × adventurers_escaped
       + 2 × adventurers_killed
       + 1 × treasure_crates_looted
       + 1 per 40 gold spent at your amenities   # good service travels too
       × 0.5 if the entire party was wiped       # nobody left to tell the tale
```

Renown accumulates and never decreases. Threat Tier is a lookup on total Renown:

| Tier | Renown | Party size | Party level | Gold each | Notes |
|---|---|---|---|---|---|
| 1 | 0 | 3 | 1–2 | 25 | Tutorial-grade. Farmhands with pitchforks. |
| 2 | 30 | 3 | 3–4 | 45 | First real kits (potions appear) |
| 3 | 75 | 4 | 5–6 | 65 | First named adventurer possible |
| 4 | 140 | 4 | 7–8 | 85 | Dispel effects appear |
| 5 | 230 | 4 | 9–11 | 105 | Guild-sponsored parties, revive scrolls |
| 6 | 350 | 5 | 12–14 | 125 | Named adventurers common |
| 7 | 500 | 5 | 15–17 | 145 | Counter-strategy traits get nasty |
| 8 | 700 | 5 | 18–21 | 165 | Two parties may raid in one wave |
| 9 | 950 | 5 | 22–25 | 185 | Elite guild strike teams |
| 10 | 1250 | 5 | 26+ | 205 | Nation-backed hero companies |

**The central tension:** Renown gates your mana income, your Soul yield, *and* how much
gold walks through the door. You cannot grow without it. But it is a ratchet — you can
never walk it back.

### 4.5 Insight (meta)

Awarded at season end regardless of win/loss:

- +1 per floor reached at season end
- +2 per Threat Tier reached
- +5 per named adventurer killed (first time only, per adventurer)
- +3 per Patron established (§9.4)
- +10 for surviving all 12 raids

Spent in the **Codex** between seasons on permanent unlocks (§10).

---

## 5. The Dungeon

### 5.1 Floors

You begin with **Floor 1** and the **Core** directly beneath it. Digging adds a floor
*above the Core* — the Core is always the deepest point.

**A Landing sits beneath every floor, including the deepest.** The deepest one is the
**Core approach**: the party's last chance to turn back before breaching. This matters
more than it sounds. Without it, a one-floor dungeon has no Descent Decision at all, so
the only non-losing outcome is a total wipe — which contradicts pillar 2 and made the
opening raids unsurvivable in testing.

| Floor # | Dig cost (Mana) | Room slots | Mana bonus |
|---|---|---|---|
| 1 | — (start) | 3 | +40 |
| 2 | 60 | 3 | +40 |
| 3 | 110 | 4 | +40 |
| 4 | 180 | 4 | +40 |
| 5 | 270 | 5 | +40 |
| 6 | 390 | 5 | +40 |
| 7 | 540 | 6 | +40 |
| 8 | 720 | 6 | +40 |
| 9 | 940 | 7 | +40 |
| 10 | 1200 | 7 | +40 |

Digging must stay strongly positive-EV — it is the only thing that outpaces rising
Renown. At +10/floor the original economy could never fund a second floor. ✅

Digging is the main mana sink and the main way to raise income. It is also how you buy
*time* — more floors means more chances to stop a party before the Core.

Each new floor also opens a new **Landing** above it (§8.1).

### 5.2 Rooms

Each floor has room slots, traversed in order. A room holds **one** of:

- A **mob group** (1–3 mobs depending on their Slot cost)
- A **trap** (or trap chain)
- A **treasure cache** — deliberately placed loot. Costs mana, generates Renown when
  looted, and **slows the party** (looting takes ticks). A bribe that buys you time.
- **Empty** — free, and not useless: empty rooms still cost travel ticks, and parties burn
  Kit on caution in unfamiliar dungeons.

### 5.3 Floor Effects

One per floor. Unlocked via Insight. Applies to every room on that floor.

| Effect | Cost | Behavior |
|---|---|---|
| **Miasma** | 80 | Party loses 1 Kit per room entered |
| **Darkness** | 70 | Adventurer accuracy −25%; your ambushers get +1 surprise round |
| **Crushing Depths** | 120 | Rest at the Landing below restores half as much |
| **Silence** | 100 | Adventurer casters cannot use spells or scrolls |
| **Labyrinth** | 90 | +2 empty room slots; party burns extra travel ticks |
| **Sanctuary** *(trap)* | 60 | Looks like a safe room. Party rests here — and Resolve drops when they realize it was staged |

### 5.4 The Core

Sits below the deepest floor. If any adventurer reaches it, you lose a **Heart**. You
start with 3 Hearts (unlockable to 5). At 0 Hearts, the season ends immediately.

A Heart loss also scatters the party home alive — a huge Renown spike. Losing is a death
spiral by design, and it should be legible: the run gets harder precisely because you
failed.

---

## 6. Monsters

### 6.1 Stat block

| Stat | Meaning |
|---|---|
| **HP** | Damage absorbed before death |
| **DMG** | Damage per attack tick |
| **SPD** | Attacks per tick window (0.5 = every other tick) |
| **Slots** | Room capacity consumed (rooms hold 3 slots) |
| **Cost** | Mana to purchase |
| **Upkeep** | Mana per raid while placed |
| **Role** | Behavioral archetype (below) |

### 6.2 Roles

- **Bruiser** — high HP, blocks the room, forces the party to spend time
- **Skirmisher** — high SPD, low HP, targets the party's weakest member
- **Caster** — ranged damage, ignores armor, dies fast to focus fire
- **Warden** — *drains Kit.* Destroys potions, corrodes gear, burns scrolls. The
  strategic backbone of a drain build.
- **Ambusher** — acts before the party's first turn; bonus with Darkness
- **Terror** — deals **Resolve** damage instead of HP damage. Breaks nerve, not bodies.
- **Support** — buffs/heals other mobs, never attacks

### 6.3 Roster (starting set — 15 mobs, 5 tiers)

| Tier | Name | Role | HP | DMG | SPD | Slots | Cost | Upkeep |
|---|---|---|---|---|---|---|---|---|
| 1 | Cave Rat | Skirmisher | 8 | 2 | 1.5 | 1 | 12 | 1 |
| 1 | Slime | Bruiser | 22 | 1 | 0.5 | 1 | 15 | 2 |
| 1 | Bat Swarm | Ambusher | 10 | 3 | 1.0 | 1 | 18 | 2 |
| 2 | Goblin Cutpurse | Warden | 18 | 2 | 1.0 | 1 | 35 | 3 |
| 2 | Skeleton | Bruiser | 34 | 5 | 0.75 | 1 | 40 | 4 |
| 2 | Wisp | Caster | 14 | 7 | 0.75 | 1 | 45 | 4 |
| 3 | Ogre | Bruiser | 90 | 14 | 0.5 | 2 | 85 | 7 |
| 3 | Shade | Terror | 40 | 6* | 1.0 | 1 | 80 | 7 |
| 3 | Rust Ooze | Warden | 55 | 3 | 0.75 | 1 | 75 | 6 |
| 4 | Gargoyle | Bruiser | 140 | 20 | 0.5 | 2 | 140 | 11 |
| 4 | Coven Witch | Support | 60 | 8 | 0.75 | 1 | 150 | 12 |
| 4 | Basilisk | Skirmisher | 95 | 26 | 1.0 | 2 | 160 | 13 |
| 5 | Wyrm | Bruiser | 300 | 45 | 0.5 | 3 | 280 | 22 |
| 5 | Lich | Caster | 120 | 55 | 0.75 | 2 | 300 | 24 |
| 5 | Nightmare | Terror | 150 | 18* | 1.25 | 2 | 290 | 23 |

\* Terror DMG applies to **Resolve**, not HP.

### 6.4 Leveling & permanence

- Mobs gain **1 XP per adventurer they damage**, **5 XP per kill**.
- Level thresholds: 10, 25, 45, 70, 100, 140, 190, 250, 320 XP (levels 2–10).
- Each level: **+12% HP and DMG** (compounding). ✅ At +8% a level-10 veteran was only
  2× a fresh recruit, which never felt like a reason to protect one.
- **Level 5 and Level 10 grant an Evolution choice** — a branching pick that changes role
  behavior, not just stats. (e.g. Ogre → *Warlord* [buffs adjacent mobs] or *Juggernaut*
  [immune to first 3 attacks each room].)

#### Downed, then Slain ✅

A room is only cleared by defeating everything in it, so "0 HP = permanent death" means
**every front-line monster dies every single raid** — leveling becomes unreachable and
pillar 3 collapses. Measured: with instant permadeath, season survival was 7% and the
average best monster never passed level 0.4.

So death is two-stage:

1. **Downed** — dropped to 0 HP, out for the rest of the raid. Keeps its room and levels.
2. **Slain** — at raid end, each downed monster is permanently lost with probability
   **25%**. ✅ A **breach slays every downed monster**, which is most of what makes
   losing a Heart hurt.

| slayChance | Season survival | Best monster level |
|---|---|---|
| 0.10 | 65% | 3.1 |
| **0.25** | **50%** | **2.1** |
| 0.60 | 25% | 0.9 |
| 1.00 (v0.2 rule) | 7% | 0.4 |

Slain monsters may be **Reconstituted** in the next Build Phase for `20 × level² Souls` —
deliberately brutal at high levels, so veterans are worth protecting. This is what the
Retreat intervention (§7.4) exists for.

### 6.5 Monster gear (Gold)

Bought with Gold, equipped in the Build Phase. Two slots per mob (a third at level 6).

| Item | Cost | Effect |
|---|---|---|
| Iron Fangs | 60 | +15% DMG |
| Carapace Plating | 70 | +20% HP |
| Swiftstep Charm | 90 | +0.25 SPD |
| Warden's Censer | 110 | Attacks also strip 1 Kit |
| Dread Standard | 130 | Attacks also deal 2 Resolve damage |
| Phylactery Shard | 200 | On death, revive once at 30% HP (consumed) |

**Gear survives its wearer.** When a mob dies, its equipment returns to your Armory
undamaged. This is the intended counterweight to permanent mob death — you lose the levels
and the history, but not the investment.

It also gives Gold a job that Mana cannot do, which is what keeps the second economy from
collapsing into "Mana, but yellow."

---

## 7. Raid Resolution

The heart of the system. Raids resolve automatically on a tick clock, ~90 seconds of
watchable simulation at 1× speed, with three player interventions available.

### 7.1 Adventurer stat block

| Stat | Meaning |
|---|---|
| **HP** | Standard |
| **DMG / Armor** | Standard |
| **Kit** | Abstracted consumables: potions, scrolls, rations, rope. **The key stat.** |
| **Resolve** | Morale. Hits 0 → the party flees immediately, regardless of HP |
| **Gold** | Spending money. Yours if you can sell them something. |
| **Greed** | Modifier to the Descent Decision threshold *and* to amenity spending |
| **Class** | Fighter / Rogue / Cleric / Mage / Ranger — determines Kit usage |

### 7.2 Floor traversal

For each room, in order:
1. Party enters. Ambushers act.
2. Combat ticks resolve: mobs and adventurers trade damage simultaneously.
3. Adventurers spend **Kit** to heal, buff, or dispel when thresholds are hit (Clerics
   spend Kit most aggressively).
4. Room resolves when all mobs die, all adventurers die, or the party retreats.

### 7.3 The Landing — rest and the Descent Decision

**A Landing sits beneath every floor.** The party stops here. Three things happen, in
order: they rest, they shop (§8), and they decide whether to keep going.

**Rest** (free, automatic):

```
hp_restored_per_member = 0.40 × max_hp    # requires 1 Kit
                       = 0                # if Kit is empty
resolve_restored       = 0.25 × max_resolve
```

**This is why Kit drain is the real win condition.** HP damage evaporates at every Landing
unless you have taken their supplies away. A dungeon that only deals damage is a dungeon
that resets itself every floor.

Then the **Descent Decision**:

```
descend  if  avg_hp_pct > (0.35 - greed_mod)
        and  total_kit  > (party_size × 0.5)
        and  avg_resolve_pct > 0.30
        and  floors_remaining > 0
```

Fail any check → the party **retreats alive**. That is a Renown payout, not a failure.

### 7.4 Interventions

You get **3 Ley Charges** per raid (unlockable to 5). Spend during the raid:

| Intervention | Effect |
|---|---|
| **Reposition** | Move a mob to an adjacent room mid-raid |
| **Spring** | Trigger a trap early, out of sequence |
| **Retreat** | Pull a mob out of combat immediately. Saves a veteran. Room is now undefended. |
| **Taunt** | Force a retreating party to descend one more floor anyway |

**Taunt is the gambler's button.** A party is walking away with your Renown — Taunt them
into one more floor and you might convert them into Souls. Or they might clear that floor
and reach the next one with momentum. This is the single most interesting decision in the
game and should be tuned to be genuinely close to even odds.

### 7.5 Win conditions per floor, restated

| You want | Build for | Result |
|---|---|---|
| **Souls** | Burst damage before the Landing | Kills. Low Renown, 75% of their gold lost. |
| **Renown** | Kit drain (Wardens, Miasma) | Retreats. High Renown, no Souls. |
| **Gold** | Amenities + survivable floors | Sales. They leave rich in stories and poor in coin. |
| **Time / safety** | Terror + treasure caches | They leave early and barely scratch you. |

A well-built dungeon usually goes: **sell on the upper landings, drain in the middle,
burst at the bottom** — so anyone who makes it deep arrives with an empty pack and an
empty purse.

---

## 8. Landings, Amenities, and the Gold Economy

The second economy. Optional, and probably where the game's personality lives.

### 8.1 Landings

Each Landing sits between two floors and has **2 amenity slots** (3 with the *Concourse*
Codex unlock). Amenities cost **Mana to build** and generate **Gold when used**.

Adventurers use a Landing's amenities *after* resting and *before* the Descent Decision.
Which means anything you sell them directly affects whether they keep coming down.

### 8.2 Amenity types

Each amenity restores exactly one of the three resources your three win conditions attack.
This is deliberate: **every sale undermines one of your own strategies.**

| Amenity | Build (Mana) | Upkeep | Base price | Effect on party | Undermines |
|---|---|---|---|---|---|
| **Hot Spring** | 90 | 4 | 8g each | +30% HP | Burst builds |
| **Inn** | 110 | 5 | 10g each | +40% Resolve, +1 Kit | Terror builds |
| **Provisioner** | 70 | 3 | 6g per Kit (max 3) | Restores Kit | Drain builds |
| **Smithy** | 150 | 8 | 25g each | +2 DMG or +1 Armor for the raid | Everything |
| **Shrine** | 130 | 6 | 40g each | Revives one dead member at 25% HP | Everything, expensively |

The Smithy and Shrine are the "are you sure?" tier — real money, real consequences. A
Shrine is how a party that should have died reaches your Core.

### 8.3 Pricing — the player's dial

Set per-amenity in the Build Phase:

| Tier | Multiplier | Usage rate | Renown per sale |
|---|---|---|---|
| Modest | 1.0× | 90% | ×1.0 |
| Standard | 1.5× | 65% | ×0.9 |
| Premium | 2.5× | 35% | ×0.8 |
| Gouge | 4.0× | 15% | ×0.5 |

Expected gold per adventurer is *roughly flat* across the first three tiers — that is
intentional. **The decision is not about gold. It is about how many adventurers walk away
healed.** Modest pricing is a profitable way to make your own dungeon harder. Gouging is
how you shut the tap off when a party is going too deep.

Greedy adventurers (high Greed) spend more and tolerate higher prices. Some named
adventurers refuse to shop at all.

### 8.4 Staffing — the opportunity cost

**Every open amenity requires one monster assigned as staff.** That monster does not fight
this raid. It is not in a room; it is behind a counter.

This is the system's real cost. A Goblin Cutpurse running the Provisioner is a Goblin
Cutpurse not stripping Kit on floor 2.

- Staffing monsters earn **Commerce XP** on a separate track (levels 1–5, **+10% revenue
  per level**). A career shopkeeper is genuinely valuable and genuinely useless in a fight.
- **Hired Staff** — neutral NPC shopkeepers, purchasable for 250 Gold each. No Commerce
  scaling, but they free your monsters. The main gold sink of a commerce build.
- Staff in an amenity **cannot be killed** by adventurers. Shops are neutral ground. This
  is a hard rule, not a soft one — see §11.4.

### 8.5 Active enticement — *stub, expand later*

Renown is currently a **passive** attractor: you do things, word spreads, better parties
arrive. Missing is the other half of running a dungeon as a business — actively drumming
up trade. Sketch of the lever, not yet designed:

- **Rumors** — spend Gold to seed tavern talk. Raises next raid's tier by +1 *without*
  permanently raising Renown. A one-shot difficulty spike you chose, for one wave of richer
  adventurers. The tactical counterpart to the Renown ratchet.
- **Guild Contracts** — accept a posted bounty ("a party will come for the Basilisk on
  floor 3"). You know exactly who is coming and when; they arrive better prepared. Turns a
  random raid into a set-piece you can build against.
- **Advertised Boss** — publicly name a boss as the dungeon's prize. Draws parties
  specifically hunting it, at higher tier, carrying more gold. Bosses become marketing
  rather than just the deepest stat block.
- **Seasonal Festival** — a scheduled high-traffic wave. Many parties, many sales, one
  chance to be overrun. A natural season-end climax and probably the best home for the
  "dungeon as public attraction" idea.

The common thread: these are all ways to **spend a resource to pull difficulty forward in
time** rather than accumulating it permanently. That is a genuinely different knob from
Renown, and it is what makes the player feel like a proprietor instead of a defender.

### 8.6 Why a commerce build is viable, not just flavor

A player who leans hard into amenities is choosing: fewer defenders, better-equipped
defenders, and much richer adventurers. It should be a real strategy with a real failure
mode — you get very wealthy monsters in a very thin dungeon, and then Guildmaster Oros
walks in with a full party and a Shrine two floors above your Core.

---

## 9. Adventurers

### 9.1 Generic parties

Rolled procedurally from the Threat Tier table (§4.4). Composition weighted toward
balanced parties, with occasional themed variants (all-Rogue "delve crew", Cleric-heavy
"pilgrimage").

### 9.2 Named Adventurers

Appear starting at Tier 3, more frequently as tiers climb. Each has a **Trait** that
invalidates a specific strategy — they are counter-play, not stat spikes.

| Name | Trait | Counters |
|---|---|---|
| **Berrick the Unfed** | Ignores Kit thresholds in the Descent Decision | Drain builds |
| **Sister Ivane** | Restores 1 Kit to the party per floor | Miasma / Wardens |
| **Halden Torch** | Immune to Darkness; dispels one floor effect on entry | Floor-effect builds |
| **The Quiet Twins** | Split into two paths, halving your per-room mob density | Single-choke builds |
| **Marrow-Knight Vess** | Immune to Resolve damage | Terror builds |
| **Coin-Cutter Sable** | Pays half price at all amenities; steals 30g per Landing | Commerce builds |
| **Guildmaster Oros** | Party retreats on *his* order only — never triggers Descent Decision | Everything. Late-tier only. |

### 9.3 The Nemesis track (predation)

A named adventurer who **escapes** returns in a later raid at **+1 Rank**: higher stats,
plus a second Trait learned from how they died last time (e.g. escaped a Miasma floor →
gains Miasma resistance).

Escape three times and they become a **Nemesis**: they lead a full party of their own and
grant triple Insight if killed.

### 9.4 The Patron track (commerce)

The mirror image. An adventurer who **spends heavily and survives** three times becomes a
**Patron**:

- Arrives with **3× gold**
- Brings one extra party member (a friend they told)
- Grants +3 Insight at season end while alive
- **Will not descend past the floor they died on last time** — Patrons are cautious

A Patron is a recurring income stream that walks into your dungeon voluntarily. Killing
one ends the stream permanently and converts them into a large one-time Soul payout.

**A single adventurer can be on both tracks.** Someone who shops at your Provisioner every
raid and keeps escaping your kill floors is accruing Nemesis rank *and* Patron rank
simultaneously — becoming both more profitable and more dangerous, and forcing the
decision the whole game is built around.

---

## 10. Meta-Progression (the Codex)

Insight is spent between seasons. Five branches:

- **Bestiary** — unlock new mob species and their evolution lines
- **Engineering** — new traps, trap chains, more room slots per floor
- **Geomancy** — new floor effects, cheaper dig costs, extra Hearts
- **Dominion** — more Ley Charges, better starting mana, start at Floor 2/3
- **Commerce** — new amenity types, third Landing slot (*Concourse*), cheaper Hired Staff,
  higher Commerce XP cap

**Depth Records:** the deepest floor you have ever built and the highest Tier survived are
tracked per-season and unlock harder starting conditions (an Ascension analogue) —
"Awakened Guilds" modifiers that raise both difficulty and Insight yield.

---

## 11. Open Questions

Decisions I would want play data to answer, not guesses:

1. **Is 12 raids the right season length?** Long enough to grow a veteran mob to level 8,
   short enough to retry. May need 15.
2. **Should Renown ever decay?** Currently a pure ratchet. If runs spiral too fast, a small
   per-raid decay would let players hold at a tier and consolidate.
3. **Is auto-resolve satisfying enough to watch?** Still open — the prototype implements
   it with speed controls, but nobody has watched it yet. This is the one remaining
   question that could force a re-scope. **Test this first.**
4. **Two parties at Tier 8+ — same floors or split?** Simultaneous parties on the same
   floors is chaos; staggered entry is more readable. Prototype both.
5. **Does the treasure cache read as a real option** now that amenities exist? It may be
   redundant — a cache gives them Renown and costs you mana, where a shop at least pays.
   Consider folding caches into the Landing system or cutting them.
6. **How punishing should Reconstitute be?** `20 × level²` means a level 8 mob costs 1280
   Souls — likely never affordable. Gear-survives-death (§6.5) softens this; it may now be
   correctly harsh. Fallback: `20 × level^1.5`.
7. ~~**Is 25% gold-on-kill the right number?**~~ **Answered: yes, 25% holds.** ✅ It splits
   income 58% sales / 42% corpses — both channels stay live. At 1.0 commerce collapses to
   18% of gold and killing is strictly better; at 0 it is forced the other way. The number
   only means anything once Gold has a sink, which is why gear moved into prototype scope.

   | goldRecoveredOnKill | gold/season | from sales |
   |---|---|---|
   | 0 | 28 | 100% |
   | **0.25** | **37** | **58%** |
   | 0.5 | 45 | 39% |
   | 1.0 | 58 | 18% |
8. **Why is a commerce build so much weaker?** Measured at 8% season survival against 50%
   for a pure combat build — §8.5 claims it should be viable and it currently isn't. Some
   of that is a naive scripted AI (it staffs shops with Cave Rats and overbuilds early),
   but not all. Needs a human playing it before deciding whether to buff amenities or
   accept that commerce is a harder difficulty setting.

9. **Can adventurers rob a shop?** Answer for now is no — neutral ground is a clean,
   legible rule and it protects the staffing investment. But "a party too poor to shop
   decides to take instead" is a strong late-tier beat, and Coin-Cutter Sable already
   half-does it. Revisit once commerce builds are tuned.

---

## 12. Prototype Scope (v0.1) — **BUILT**

Simulated combat, no art. Implemented in `src/`, playable with `npm run dev`.

**In:**
- 3 floors max, 3 room slots each, a Landing beneath every floor
- 6 monsters (Cave Rat, Slime, Goblin Cutpurse, Skeleton, Ogre, Rust Ooze)
- 2 amenities (Hot Spring, Provisioner) with the pricing dial and staffing cost
- Monster leveling, Downed → Slain permadeath
- 8 raids, Tiers 1–4
- One named adventurer: Berrick the Unfed
- Interventions: Retreat and Taunt
- Speed controls: pause / 1× / 2× / 4× / Instant
- **No art.** Colored rectangles and text.

**Added to scope during the build**, because the original scope had a hole:
- **Monster gear** (Iron Fangs, Carapace Plating, Warden's Censer) and **Hired Staff**.
  Gold had no sink at all without them — `goldRecoveredOnKill` measurably did nothing
  across its whole range, making §11 Q7 unanswerable and pillar 4 inert.
- **Reconstitute**, for the same reason on the Souls side.

**Still out:** traps, floor effects, evolutions, Inn/Smithy/Shrine, Nemesis, Patron,
Insight and the Codex.

**The questions this prototype answers:**
1. Does the Renown ratchet create a real decision?
2. Is Taunt as tense as it looks on paper?
3. Does staffing a shop *hurt* enough to be interesting?

## 13. Presentation & Technical Direction

### 13.1 The visual target

Long-term: **isometric / 2.5D.** Near-term: colored rectangles.

The plan below exists so that going from one to the other is a renderer swap, not a
rewrite.

### 13.2 The architectural rule

**The simulation must be headless, deterministic, and know nothing about rendering.**

```
┌─────────────────────┐
│   SIM CORE          │   pure TypeScript, zero engine imports
│   - seeded RNG      │   given (dungeon state, party, seed)
│   - tick loop       │   → emits an ordered event stream
│   - no timers       │
└──────────┬──────────┘
           │  RaidEvent[]   (tick, actor, action, target, deltas)
           ▼
┌─────────────────────┐
│   RENDERER          │   consumes events at whatever speed it likes
│   v0: rectangles    │
│   v1: 2D sprites    │   ← swap here, sim untouched
│   v2: isometric     │
└─────────────────────┘
```

Everything good follows from this one rule:

- **Speed modes are free.** 1×/2×/4× is just how fast you drain the event queue. "Instant"
  is draining it with no renderer at all and showing the summary.
- **Balance testing is free.** Run 10,000 headless seasons overnight to find out whether
  Gouge pricing is ever correct. Question 7 in §11 is answerable in an afternoon instead of
  a month of playtests.
- **The 2.5D upgrade is a renderer swap.** The sim does not know what a pixel is.
- **Determinism gives you replays and bug reports for free** — a seed plus a build order
  reproduces any raid exactly.

The one discipline this demands: no `Math.random()` anywhere in the sim, ever. All
randomness through an injected seeded PRNG.

### 13.3 Stack recommendation

- **Sim core:** plain TypeScript, no dependencies, its own package/folder. Unit-testable.
- **Prototype renderer:** Phaser (you already have it in `my-phaser-catapult`), or honestly
  just DOM/CSS — the v0 UI is rectangles, numbers, and buttons, and HTML is faster for that
  than a game engine.
- **2.5D renderer, later:** two viable paths, decide when we get there —
  - Phaser + isometric tilemap: less work, stays in one ecosystem, weaker lighting
  - Three.js with an orthographic camera: real depth sorting and lighting, "2.5D" via flat
    billboarded sprites in 3D space. More setup, much better ceiling for a dungeon full of
    torchlight.

### 13.4 The camera problem worth flagging now

The game's identity is the **vertical stack** — floors and landings descending toward the
Core, all visible at once. Isometric renders a single floor beautifully and a stack of ten
floors poorly (they occlude each other).

Likely resolution, to be designed properly later: two camera modes.

- **Stack view** — pulled back, floors as angled slabs, the party as a moving dot. This is
  the strategic/build view and the game's signature image.
- **Floor view** — isometric, one floor at a time, where the actual combat is watched.
  Auto-follows the party during a raid; the player can lock it to a floor.

Worth noting because it affects art production: assets need to read at two very different
zoom levels. That is a real constraint on the eventual art direction, and cheaper to
account for now than after a tileset exists.

---

## 14. What the Balance Runner Found

Every number marked ✅ in this document came out of `tools/balance.ts`, which plays
hundreds of full seasons headlessly in about a second. Recording the findings here
because three of them were *design* problems wearing the costume of tuning problems.

### 14.1 A one-floor dungeon had no Descent Decision

Landings originally sat *between* floors, so a starting dungeon (one floor) had none at
all. The party could only be wiped or reach the Core — one win condition, not three, in
direct contradiction of pillar 2. Every opening raid was a guaranteed Heart loss and
seasons ended by raid 3 with 0% survival.

**Fix:** a Landing beneath every floor, the deepest being the Core approach. Taunt is not
offered there (there is no floor below to taunt them into, only the Core).

### 14.2 Universal permadeath made pillar 3 unreachable

A room is only cleared by defeating everything in it, so "0 HP = dead forever" meant every
front-line monster died every raid. Nothing ever levelled — average best monster level
0.4, season survival 7%. A floor cost ~260 mana, repelled one party, and was gone.

**Fix:** Downed → Slain at 25%. See §6.4.

### 14.3 Gold had no sink, so pillar 4 was inert

Sweeping `goldRecoveredOnKill` from 0 to 1.0 produced *identical* results at every value.
Gold accumulated and bought nothing, because §12 had cut gear from scope. The design's
central tension — predation versus commerce — could not be measured, let alone felt.

**Fix:** gear and hired staff moved into prototype scope. The sweep then produced a real
curve, and 25% turned out to be a good answer.

**General lesson:** a currency with no sink is a bug, not a simplification. The same
reasoning applies to Souls, which is why Reconstitute is in the prototype.

### 14.4 Kit is the single most powerful lever

A Tier-1 party has ~114 total HP and ~108 HP of Kit sustain — **Kit roughly doubles their
effective health.** `kitHealPct` moves season survival from 82% (at 0.15) to 34% (at 0.30).
This is §7.3's premise confirmed hard: a dungeon that only deals damage resets itself at
every Landing, and drain builds are not a side strategy but the core of the game.

### 14.5 Adventurers out-scale monsters, permanently

Adventurer damage grows linearly with level; monster power grows only via a compounding
per-level scalar against a hard level-10 ceiling. At `advDmgPerLevel` 1.5 a Tier-4 party
walked through three Ogres in 9 ticks without a casualty. Reduced to 1.0, and monster
scaling raised from +8% to +12%.

This is structural, not a one-off: **the deep tiers will always need new monsters, not
just levelled old ones.** The tier table promising Tier 10 parties needs Tier 5+ monsters
to exist, or escalation is suicide by design.

### 14.6 Current state

At the tuned defaults, the scripted combat AI survives a season **~50%** of the time,
reaching Tier 2.1 with a best monster around level 2. That is a reasonable roguelite
baseline for an AI that plays consistently but not well.

```
strategy    survive  tier  renown   gold  souls  sales%  killed escaped  breach  mobLv
combat          50%   2.1      58     25     25      0%    12.2     7.4     1.6    2.1
commerce         8%   2.0      50     37     6      58%     3.1     7.6     2.8    1.3
balanced        50%   2.1      58     25     25      0%    12.1     7.5     1.6    2.1
```

The commerce gap is §11 Q8 and the biggest open balance question.

---

## 15. The Tycoon Reframe — Thrill-based Renown

**Status: proposed, not implemented.** This changes the core dial, so it needs building
and re-measuring before it goes in.

### 15.1 The problem it fixes

Renown is currently flat: `6 × escapees`. The balance runner found the degenerate case
immediately. A pure Kit-drain dungeon:

```
wardens    survive 1%   tier 3.7   renown 144   killed 0.0   escaped 24.1   mobLv 0.0
```

It earns more than double any other strategy's Renown by taking everyone's supplies and
sending them home **unharmed**. The most boring possible delve — turn back at full HP,
having never been in danger — is the reputation optimum. Then the ratchet kills you.

The deeper issue: **"let everyone live" is trivially optimal.** There is no skill in it.

### 15.2 The reframe

You are not running a fortress. You are running an **attraction**. Adventurers are guests.
Reputation comes from the *quality of the delve*, not the headcount that walked out.

The RollerCoaster Tycoon triad maps almost directly:

| RCT | Coreward | Meaning |
|---|---|---|
| Excitement | **Thrill** | Was it a great delve? Drives Renown. |
| Intensity | **Peril** | How close to death did they come? |
| Nausea | **Tedium** | Empty corridors, repeated rooms, cheap deaths. |

### 15.3 Thrill score

Computed per surviving adventurer at raid end:

```
peril   = 1 − (lowest HP fraction reached during the delve)      # 0..1
depth   = floors_cleared / floors_in_dungeon                     # 0..1
variety = distinct monster roles faced / 4                       # 0..1, capped
comfort = amenities used / amenities available                   # 0..1

thrill  = 100 × (0.45×peril + 0.25×depth + 0.20×variety + 0.10×comfort) − tedium
tedium  = 4 × empty_rooms_traversed + 8 × consecutive_identical_rooms

renown  = Σ (thrill / 10) over SURVIVORS only
```

Dead adventurers contribute **zero** — which replaces the current `×0.5 on wipe` hack with
something principled. Dead men tell no tales; that was always the fiction.

What this does to play:

| Delve | Peril | Renown | Why |
|---|---|---|---|
| Strolls out at 95% HP | 0.05 | ~2 | Nothing happened. Nobody cares. |
| Drops to 12%, escapes | 0.88 | ~7 | **The story everyone repeats.** |
| Drain build: leaves healthy | 0.10 | ~2 | Fixes the wardens exploit. |
| Total wipe | — | 0 | No survivors, no reputation. |

**The optimum becomes: bring them to the brink, then let them walk out.** That is genuinely
hard — it needs a dungeon tuned to threaten precisely, not one tuned to kill or to stall.
It is the skill expression the design currently lacks.

### 15.4 What this does to the rest of the design

- **Pillar 4 becomes showmanship.** Not just predation vs commerce — you are staging an
  experience and choosing how much of it to monetise.
- **Taunt gets better.** It stops being "gamble for Souls" and becomes "make the ride
  scarier at the last moment", which is both more thematic and more often correct.
- **Variety and Tedium justify §5.3 floor effects and a wide bestiary** mechanically, not
  just for flavour. A dungeon of nine identical Ogre rooms scores badly *by rule*.
- **The Hot Spring earns its keep.** `comfort` means amenities raise Thrill directly, so
  commerce stops being a pure defensive sacrifice — which is §11 Q8, the biggest open
  balance problem.
- **Empty rooms become a real cost.** Currently they are free padding.

### 15.5 Retirement

An adventurer who survives a delve at **thrill ≥ 75** with **3+ delves** behind them may
**retire**:

- Large one-off Renown payout
- Added to your **Legends** list — a permanent, passive Renown trickle
- **They never come back**

So a recurring Patron (§9.4) can be converted into a permanent reputation asset — at the
cost of the income stream. Three dispositions now, not two:

| Outcome | Yields | Costs you |
|---|---|---|
| Killed | Souls, 25% of their gold | Renown, and any future visits |
| Sent home | Renown scaled by Thrill | Their gold stays theirs |
| **Retired** | Big Renown + a permanent Legend | The adventurer, permanently |

### 15.6 Open questions this raises

1. Does peril-weighted Renown make the ratchet *harder* to control, since the best play is
   also the riskiest? That may be good — it makes escalation feel earned — or it may make
   the game punishingly swingy. **Measure before committing.**
2. Does tracking `lowest HP reached` per adventurer need to be in the event stream, or is
   it a raid-level tally? (Raid-level is simpler and probably enough.)
3. Should Tedium be visible to the player *during* the Build Phase — a predicted Thrill
   score for the dungeon as designed? RCT shows ride stats before you open. That is a big
   usability win and a big design commitment.
4. Rival dungeons competing for a shared adventurer pool is the natural next layer of the
   tycoon framing. Almost certainly v2 — but it is where "market share" would live.
