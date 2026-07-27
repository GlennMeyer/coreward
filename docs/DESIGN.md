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
            + 12 × adventurers_killed        # ✅ was 3 — see below
            + 1.8 × raid_thrill              # ✅ a good show draws power
            + tier_bonus[threat_tier]        # ✅ 0, 25, 55, 95, 140, 195, 255, 325, 405, 495
            - total_upkeep                   # mobs + amenity operating costs
```

Starting Mana: **300**. ✅ It must buy a Floor 1 that can actually threaten Tier 1 —
at 260 or below the opening is a guaranteed Heart loss.

**The two halves of the design were fighting.** Mana came only from kills and floors,
while §15 pays Renown for letting adventurers *leave*. A player who ran a good, survivable
dungeon — exactly what the Tycoon reframe asks for — earned 83 mana a raid (1 floor, no
kills, 12 upkeep) and starved. Thrill now feeds Mana directly: the dungeon draws power
from the experience, not just the corpses. Scaled on the raid's Thrill score and
deliberately **not** per-survivor, since per-head would hand the volume-farming wardens
build a second income stream and reopen §15.1.

**Measured problem, fixed:** at 3 mana/kill and a tier-3 bonus of 12, income was 129–147
per raid against a 282-mana opening build, and `base + floors` was over 90% of it. Kills
paid 9. A season of them bought less than half an Ogre while the dungeon lost 1–8 monsters
a raid to permadeath, so **every raid ran a structural deficit** and seasons ended overrun
around raid 6. Killing now funds the killer, and the ratchet is worth riding: escalating a
tier used to add 5–12 mana, which was noise against the cost of the monsters needed to
survive it.

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

**Status: IMPLEMENTED and measured (v0.3).** The formula below is what ships; §15.7
records where the design as first written turned out to be wrong.

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
depth   = floors_cleared / 3                                     # 0..1, ABSOLUTE  ✅
variety = distinct monster roles faced / 3                       # 0..1, capped    ✅
comfort = amenities used / amenities available                   # 0..1

gate    = min(1, peril / 0.6)                                    # ✅ see §15.7.1

thrill  = 100 × (0.45×peril + gate × (0.25×depth + 0.20×variety + 0.10×comfort))
          − tedium
tedium  = 4 × empty_rooms_traversed + 8 × consecutive_identical_rooms

renown  = Σ (thrill × 0.3) over SURVIVORS only                   # ✅ was /10
```

Three of those numbers changed under measurement and the reasons matter — §15.7.

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

An adventurer who survives a delve at **thrill ≥ 45** with **2+ delves** behind them may
**retire** (✅ both set from the measured distribution — see §15.7.4):

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

---

## 15.7 What Measurement Changed

§15 was written at the desk and then run through `tools/balance.ts`. Four of its numbers
were wrong, and two of them were wrong in ways that mattered more than tuning.

### 15.7.1 The peril gate was necessary but not sufficient

The proposal assumed peril-weighting alone would demote the wardens exploit (§15.1). It
did not. Adding a gate — `min(1, peril / 0.6)` multiplying depth, variety and comfort, so
length only converts into reputation once the dungeon is actually frightening — cut
wardens from 89 Renown to 49, **and they still ranked #1 at every gate value swept from
0 to 1.2.**

Two other things were holding the exploit open.

### 15.7.2 `depth` was a completion ratio, which punished digging

`floors_cleared / floors_in_dungeon` is maximised by owning the **smallest possible
dungeon**. Every measured strategy sat on one floor and scored `depth 1.00` — a free 25
Thrill each, and a standing penalty for the one structural investment the game is built
around. Now absolute: `floors_cleared / 3`.

### 15.7.3 `variety` could never reach full marks

The cap counted four roles; the prototype bestiary fields three (skirmisher, bruiser,
warden). A component permanently stuck at 0.75 silently deflated every score. Cap is 3
until caster/terror/ambusher monsters ship.

### 15.7.4 Retirement was unreachable content

`retireThrill: 75` qualified **0.04% of raids** — across 600 measured seasons the Legends
system fired essentially never, despite being built, tested and surfaced in the UI. The
measured distribution over 2,783 raids with survivors:

| p50 | p75 | p90 | p95 | max |
|---|---|---|---|---|
| 11.6 | 28.0 | 44.2 | 51.0 | 75.5 |

`retireThrill` is now **45** — genuine top-decile. `retireMinDelves` dropped 3 → **2**,
because at 3 an 8-raid season produced 0.03 Legends (a ~15× cut), and
`veteranReturnChance` rose 0.35 → **0.55** so recurring faces actually recur.

Result: showman earns **0.61 Legends/season**, wardens **0.07**. Showmanship is rewarded
with Legends; the drain build is not. That is the design working as intended.

### 15.7.5 Verdict

```
                flat 6×escapees      Thrill (shipped)
wardens         162  #1  ← exploit    70  #2
showman          90  #2               95  #1
combat           58  #6               60  #5
```

The reframe demotes the boring optimum. `npx tsx tools/balance.ts h2h` re-checks this and
prints `FAIL:` if wardens ever ranks #1 again.

### 15.7.6 Still open

1. **`thrillComfortWeight: 0.1` cannot pay for a 90-mana amenity.** Measured across a
   54-cell grid search, `comfort` stayed at 0.00–0.02 at every defence reserve tried;
   forcing a build cost 13 points of survival and 24 Renown. **§15.4's claim that "the Hot
   Spring earns its keep" is false at these weights.** Fixing it means comfort ≈0.25 or a
   cheaper amenity, and either moves `commerce` too.
2. **`tediumPerEmptyRoom: 4` may now be too harsh.** It is a flat per-room cost, so it
   scales with dungeon size while Thrill does not — digging is partly self-punishing.
   Tedium ran 4–8/raid on one floor and runs 13–19 now.
3. **wardens still survives 99% at #2 Renown**, so risk-adjusted it may remain the
   strongest play. It is no longer the harmless build (peril 0.25 — it does hurt people),
   but volume does a lot of work.

---

## 16. Excavation & Structure

**Status: proposed, not implemented.** Depends on §15 landing first — half of this
section's justification is Thrill, and if Thrill doesn't ship, most of this is just a tax.

Today the *shape* of the dungeon is a lookup table. `roomsOnFloor()` and
`roomCapacity(floorIndex) = 4 + floorIndex` hand the player a floor plan the moment they
pay the dig cost. Digging is the only structural decision in the game, and it is a
one-button decision: you can afford it or you can't.

This section makes structure a thing you build: **room capacity is purchased per room, floor
space is a finite spatial resource, and every excavation costs build time as well as Mana.**
On top of that it adds **Shafts** — which look like connectivity plumbing and are actually
the game's pacing control.

**Two reference points, and the second is the closer one.** X-COM contributes build time:
the thing you started is the thing you don't have yet. **Fallout Shelter** contributes
almost everything else — a fixed-width vertical cross-section, rooms that occupy cells of
it, identical adjacent rooms merging into larger and more efficient chambers, three upgrade
tiers per room, elevators as placed structures that eat floor space, and a rush button with
an incident attached. Coreward is already a vertical cross-section of stacked floors
(§13.4). Fallout Shelter is what this game looks like from the outside, and we should steal
from it deliberately rather than reinvent it badly.

The one thing we do **not** steal is Fallout Shelter's answer to merging. There, merging is
strictly good and the game is a puzzle about doing it optimally. Here it collides head-on
with §15 — and that collision is the best thing in this section (§16.5).

### 16.1 The four claims

1. **Capacity should be bought, not granted.** A formula hands out capacity uniformly, so
   every floor is the same shape and the only variable is what you put in it. Purchased
   capacity lets floors be asymmetric — a wide killing chamber at the bottom of floor 3, a
   line of narrow corridors above it — and asymmetry is what makes a dungeon read as
   *designed* rather than *filled in*.
2. **Floor space should be finite and contested.** Right now `ROOMS_BY_FLOOR` is an
   abstract count with no spatial meaning. Making it a strip of **cells** that rooms,
   merged chambers, and shaft heads all compete for gives every structural decision a cost
   that isn't Mana — and gives §13.4's signature image something to actually draw.
3. **Build time is the missing commitment.** X-COM base building is interesting because
   the Workshop you started is a Workshop you don't have for four days. Coreward has no
   equivalent: everything is instant. A dig that completes in three raids means playing two
   raids with an unfinished dungeon, and that is a real decision in a way that "spend 110
   mana" is not. **Rush** (§16.7) is the escape hatch, with Fallout Shelter's price attached.
4. **Shafts shape the Thrill curve.** Under §15 you are selling a ride. A shaft that drops
   a party two floors deeper produces high `peril` and high `depth` — a steep, perilous,
   memorable delve. Walking them the long way past every Landing earns Gold and flattens
   the curve. The shaft's Gate toggle (§16.8) is that choice, per raid.

### 16.2 The currency question — recommendation: **no sixth currency**

The brief asked whether excavation should introduce a sixth currency. It should not.
Excavation spends **Mana + crew time**, and **Insight** is where structural permanence
lives. Option (a).

The reasoning, because "we have enough currencies already" is a vibe, not an argument:

- **The scarce thing here is time, not money, and time already has a unit.** Crew-raids
  are a genuinely new scarce axis and they are the one X-COM actually uses. Charging both a
  new currency *and* build time double-taxes the same decision.
- **Every source is taken.** A currency needs a source no other currency has. Kills →
  Souls. Escapes → Renown. Sales → Gold. Passive trickle and depth → Mana. Season-end
  milestones → Insight. The only unclaimed source is *time passing*, and a currency earned
  purely by time passing is a clock with a wallet strapped to it. That is crew-raids.
- **§14.3's lesson runs both ways.** A currency with no sink is a bug. A sink with no
  distinct source is decoration.
- **Mana already has the right shape.** §4 states the split plainly: *Mana builds the
  dungeon, Gold improves it.* Mana is the currency that scales with floors (+40 each) and
  whose primary existing sink is digging. Excavation **is** digging. Putting it anywhere
  else would be a category error.

**The honest steelman for (b), and why it still loses.** A sixth currency would make
structure *non-fungible* with monsters: you could not raid your excavation budget to panic-
buy an Ogre before a Tier-4 party. That is a real and desirable property — it is why
X-COM's Engineers aren't just money. But crew-raids deliver exactly that property for free.
You cannot convert Mana into crew time, and you cannot convert crew time into an Ogre. The
non-fungibility we wanted is in the schedule, not the wallet. A currency would add the
bookkeeping and none of the constraint.

The concrete version we rejected, for the record: **Labor**, earned at a flat rate per raid
(say 2/raid, +1 per floor), spendable only on build time. Cost it out and it is
crew-raids with a denomination — the same integer, displayed twice, with a new HUD element
and a new tutorial paragraph. Rejected.

**Where Insight earns its keep.** Everything above resets at season end, which is correct
for a roguelite — but it means a player who spent six raids building a Chamber loses it. The
answer is not to make structure persist; it is to make *the ability to build it faster*
persist. See §16.7. That is already what the Codex's Engineering branch (§10) promises
("more room slots per floor"), so this is filling in an existing hole rather than opening a
new one.

### 16.3 Room capacity — purchased, in tiers

Replace `roomCapacity(floorIndex)` with a per-room `capacityTier`.

| Tier | Name | Capacity | Mana (base) | Build time | Notes |
|---|---|---|---|---|---|
| 0 | **Hewn** | 3 | — | — | Every room starts here, free |
| 1 | **Widened** | 5 | 40 | 1 raid | |
| 2 | **Hall** | 7 | 70 | 1 raid | |
| 3 | **Chamber** | 10 | 120 | 2 raids | Codex-gated (§16.7) |

Tiers are sequential — you cannot buy Hall without owning Widened. Mana is spent up front,
at commit time, not on completion.

**Depth multiplier.** Deeper rock is harder to move:

```
capacity_cost = base_cost × (1 + 0.30 × floorIndex)
```

| Floor | ×  | Widened | Hall | Chamber | Full stack |
|---|---|---|---|---|---|
| 1 | 1.0 | 40 | 70 | 120 | 230 |
| 2 | 1.3 | 52 | 91 | 156 | 299 |
| 3 | 1.6 | 64 | 112 | 192 | 368 |
| 5 | 2.2 | 88 | 154 | 264 | 506 |

This **inverts** the current rule, which gives deeper floors *more* capacity for free. That
inversion is deliberate. Under the old formula the deepest floor is unconditionally the
best place to put everything, so there is no reason to think about the upper ones. Under
this one, depth is earned twice — once by the dig, once by the widening — and a wide room
on floor 3 is a statement of intent. Deeper floors still get more *rooms* (`ROOMS_BY_FLOOR`
is untouched), so the "digging is worth it" argument in §5.1 survives intact.

**Why Hewn is 3 and not 4.** Two reasons. First, §6.2 already states rooms hold 3 slots —
the `ROOM_CAPACITY_BASE = 4` in `data.ts` is drift, and this puts the doc and the code back
in agreement at the base tier. Second, and more importantly: at 3, an Ogre (3 slots) exactly
fills an unimproved room. That is the cleanest possible statement of what capacity means —
*one big monster, or several small ones, and you may not have both until you pay.*

With slot costs at Cave Rat / Slime / Cutpurse 1, Skeleton / Rust Ooze 2, Ogre 3:

| Capacity | What fits |
|---|---|
| 3 (Hewn) | One Ogre. Or Skeleton + Rat. Or three Rats. |
| 5 (Widened) | Ogre + Skeleton. Or Ooze + Cutpurse + Rat + Slime. |
| 7 (Hall) | Ogre + Ooze + Skeleton. Three roles in one room. |
| 10 (Chamber) | Ogre + Ooze + Skeleton + Cutpurse + Rat. A killing floor. |

That table is the load-bearing argument for the whole system, because of what it does to
§15's `variety` term. `variety = distinct monster roles faced / 4`. A Hewn room holds one
role. A Hall holds three. **Capacity is now the primary variety lever in the game** — which
means widening a room raises Thrill directly, not just raw damage output. Without §15 this
system is a power purchase; with §15 it is a showmanship purchase, and that is a much
better thing for it to be.

> ⚠️ **Note for whoever implements this:** the slot costs in §6.3's table (Skeleton 1,
> Ogre 2) do not match `src/sim/data.ts` (Skeleton 2, Ooze 2, Ogre 3). The code is right and
> this section is costed against the code. §6.3 should be corrected — but not by this
> section, which is not allowed to touch it.

### 16.4 Build time and the Crew

**One Crew. One project at a time.** This is the constraint that makes the system, and it
should feel tight.

- A **project** is one capacity tier on one room, or one shaft.
- Committing a project spends its Mana immediately and occupies the Crew for N raids.
- The project completes at Aftermath of its final raid, and is live for the raid after.
- **Cancel** any time in the Build Phase for a **50% Mana refund** — the same rate as
  dismissing a mob (§4.1). The Crew frees immediately. Progress is lost.
- **A breach cancels every in-progress project** at the standard 50% refund. Losing a Heart
  already slays every downed monster (§6.4); it should cost you the site as well. This is
  §5.4's "losing is a death spiral by design, and it should be legible."

At 8 raids (prototype) a single Crew gives you **8 crew-raids** for the entire season. At 12
(full design), 12. That is the real budget, and it binds long before Mana does:

```
Season income, 3 floors, tier ~2, 8 raids:   ~1250 mana total (300 start + ~950 earned)
Committed elsewhere:                          170 digging, ~350 monsters
Available for structure:                      ~700 mana
A plausible structural season:                ~300 mana / 6 crew-raids
```

You will run out of Crew with mana in the bank. That is the intended feeling and it is the
single most important thing to preserve if these numbers get retuned: **if a season ends
with unspent crew-raids, the costs are too high; if it ends with the queue backed up and
mana idle, the system is working.**

#### In-progress construction during a raid

The brief asks whether a half-dug room is a liability. Answer: **not mechanically, but
visibly.**

| State | During a raid |
|---|---|
| **Scaffolded room** (capacity work) | Keeps its *current* capacity. Monsters in it fight normally. `tedium += 5` if the party traverses it. |
| **Scaffolded Landing** (shaft work) | Amenities are **closed** — no sales, no Gold, no `comfort`. Rest and the Descent Decision still happen. |

Widening a room does not weaken it — you are enlarging it from 3 to 5, and until the work
lands it is a perfectly good room that holds 3. Punishing the player for the capacity they
already paid for *and* haven't received yet would be punishing them twice, and would make
the correct play "never build during a raid," which is the opposite of the point.

The cost is that it **looks like a building site**, which is exactly the right cost in a
game where reputation is the product. A scaffolded room traversed is +5 tedium, in the same
units as §15's `4 × empty_rooms_traversed`. And a scaffolded *Landing* is the expensive
one: a 3-raid shaft costs you three raids of that Landing's amenity revenue while its
upkeep keeps ticking. That is the commitment. A commerce player thinks hard before boring a
shaft under their best-selling Landing.

**Does a scaffolded room count as empty for tedium?** No — it is scaffolded, not empty, and
the two penalties do not stack. If it also happens to have no monsters in it, it takes the
empty penalty (4) and not the scaffold penalty, whichever is larger, not both. Never charge
9 for one boring room.

### 16.5 Shafts — pacing control, not plumbing

A **Shaft** is excavated at a Landing. It has three properties:

| Property | Set when | Costs |
|---|---|---|
| **Target floor** | At commit | Re-boring to a different floor: 90 mana + 2 raids |
| **Entry room index** | Any Build Phase | Free |
| **Gate: Open / Sealed** | Any Build Phase | Free |

```
shaft_cost = 70 + 90 × floors_bypassed        mana
shaft_time =  2 +  1 × floors_bypassed        raids
```

| Shaft | Mana | Raids | Compare |
|---|---|---|---|
| To the next floor down | 70 | 2 | ≈ one floor-2 dig (60) |
| Bypassing 1 floor | 160 | 3 | |
| Bypassing 2 floors | 250 | 4 | |

**One Shaft per Landing, maximum.** This is not a budget rule, it is the anti-pillar rule —
see §16.6.

**What a Shaft does.** With the Gate **Open**, the party leaves that Landing by the shaft
instead of the stair. They arrive at the target floor, at the chosen room index, and
traverse from there to the end of the floor. Everything skipped is skipped completely:

- **Skipped rooms** are never entered. No combat, no travel ticks, no `tedium`, no
  `variety` contribution. Monsters in them do nothing and **still pay upkeep** — you can
  reassign them for free in the Build Phase, and if you don't, that's on you.
- **Bypassed Landings** are never reached. No rest, no shopping, **no Descent Decision**.

That last line is the whole design. A bypassed Landing means the party cannot restore 40%
of their HP, cannot buy Kit, and — critically — **cannot turn back**. §7.3's descent check
is the party's off-ramp; a shaft removes it. They arrive deep, unhealed, and committed.

Read that against §15.3:

| Term | Shaft Open | Shaft Sealed |
|---|---|---|
| `peril` = 1 − lowest HP fraction | **Up hard.** No rest between floors. | Baseline |
| `depth` = floors cleared / floors | **Up.** Bypassed floors count as cleared (see Q1) | Baseline |
| `variety` = distinct roles / 4 | **Down.** Fewer rooms faced. | Baseline |
| `comfort` = amenities used / available | **Down.** They walked past your shops. | Up |
| `tedium` = 4 × empty rooms traversed | **Down.** A shaft erases your boring rooms. | Baseline |
| Gold | **Zero from bypassed Landings.** | Full |
| Souls | Up — fewer parties escape a floor they can't retreat from | Baseline |
| Breach risk | **Up.** The shaft points at your Core. | Baseline |

So the Gate is a per-raid dial with the same shape as the amenity pricing dial (§8.3), and
it expresses pillar 4 more directly than anything else in the document:

> **Sealed is commerce mode. Open is showmanship mode.** Sealed walks them past every shop
> you own and sends them home comfortable and unimpressed. Open makes it a story and takes
> their money out of the equation entirely.

The tedium interaction deserves calling out on its own, because it is the most
tycoon-correct thing here: **a shaft is how you cut the boring first act of a floor.** §15.4
notes that empty rooms become a real cost. A shaft is the tool that lets you not pay it —
you keep the rooms (they're free) and route past them. That is RCT's "the queue line is too
long, add a second entrance," and it arrives in the design for free.

**The Taunt interaction.** §7.4's Taunt forces a retreating party down one more floor.
Taunting into an Open shaft sends a party that already wanted to leave somewhere they can't
leave from. §15.4 already argues Taunt gets better under Thrill; this makes it a genuinely
dangerous button, which is what §7.4 wants it to be.

### 16.6 The anti-pillar — evaluated honestly

§2: *"No lane-based pathing or maze-drawing. Depth replaces distance."*

The brief's proposed resolution is that a shaft sets the *entry point* on the floor below,
so the player chooses where the party arrives rather than drawing a route. **I think that
holds, and here is the test I'd apply:**

> The anti-pillar forbids the player from authoring a **graph** that the party then solves.
> It does not forbid the player from choosing **where a linear sequence begins.**

Under this design the party's route is always a strictly descending, non-branching
sequence of rooms. There is no adjacency to author, no junctions, no choice made by the
party, no pathfinding of any kind. What the player edits is an integer per floor (the entry
index) and a boolean per shaft (the gate). You cannot draw a maze with an integer.

Four rules keep it that way, and they are load-bearing, not tuning:

1. **One shaft per Landing.** Two shafts from the same Landing means the party chooses, and
   the moment the party chooses between routes we have pathfinding.
2. **Shafts only go down.** No returning, no loops, no back-tracking.
3. **No side-branches.** A shaft has one entry and one exit. It is a hole, not a corridor.
4. **Entry index is set in the Build Phase only.** Not mid-raid, not by intervention.
   Rerouting a party live is lane control by another name.

**Where I think it genuinely does erode, and it should be written down:** with an entry
index per floor, the player is authoring a *sequence* — and a sequence has an optimum that
can be solved on paper. The risk is not that the UI becomes a maze editor; it is that the
player's *head* becomes one, and the Build Phase turns into a constraint-satisfaction
puzzle rather than a design exercise. The mitigations are structural: floors are small (3–7
rooms), shafts are capped at one per Landing, and re-aiming is free — which means there is
no wrong permanent answer to agonise over, only a per-raid preference. If playtesting shows
people opening a spreadsheet, the fix is to cut the entry index entirely and let a shaft
always arrive at room 1 of its target floor. That is a strictly weaker but completely
anti-pillar-safe fallback, and it keeps the important half of the feature (bypassed
Landings), so it is a cheap retreat if we need it.

**The alternative I considered and rejected:** making the shaft's arrival depth a party-
facing *temptation* rather than a player setting — "a suspiciously convenient hole, do they
take it?" — with Greed deciding. It is more thematic and it dodges the anti-pillar
completely. It also makes a 250-mana purchase resolve on a dice roll, which is a miserable
thing to spend four crew-raids on. Rejected, but it is a good idea looking for a cheaper
home; it might be the right shape for a *trap* (§5.2) rather than a structure.

### 16.7 Insight — where permanence lives

Structure resets each season. What persists is throughput. New **Engineering** unlocks:

| Unlock | Insight | Effect |
|---|---|---|
| **Prospected Start** | 6 | Floor 1's rooms begin at Widened (5) |
| **Deep Shoring** | 8 | Depth multiplier 0.30 → 0.20 |
| **Second Crew** | 12 | Two concurrent projects, permanently |
| **Vaulting** | 14 | Unlocks the Chamber tier. Without it, capacity caps at Hall. |
| **Surveyed Shaft** | 10 | Start each season with a completed Shaft under Landing 1 |
| **Third Crew** | 20 | |

Against §4.5's yields (~1 per floor + 2 per tier + 10 for surviving the season, so roughly
15–25 for a decent run), the Second Crew is about one good season of savings. That is the
right price for the unlock that most changes how the system plays.

Gating **Chamber** behind Insight is deliberate: it keeps the season-1 decision space to
two tiers, which matters given §16.9's decision-load concern.

**The Gold hook.** A **Sapper Gang** — a temporary second Crew for the rest of the season —
is the natural Gold purchase here, and it would give commerce builds a structural advantage
they badly need (§11 Q8). I am not putting a confident price on it, because §14.6 measures
**25–37 Gold per season** and the existing Gold price list (gear at 60–110, Hired Staff at
250) is already pricing against a Gold economy that does not exist yet. Provisional: **120
Gold**, on the understanding that it is unbuyable until the Gold supply is rescaled.
Flagging that mismatch is probably the most useful thing this section does for the current
build — `HIRED_STAFF_COST = 250` against 37 Gold/season means §8.4's Hired Staff is
decorative today.

### 16.8 Interaction summary

**With §5 (floors).** `DIG_COSTS` (0/60/110) and `ROOMS_BY_FLOOR` are untouched. Excavation
is additive to digging, not a replacement for it. Digging buys you *rooms and mana income*;
excavation buys you *what fits in them*. A player who only digs still has a working dungeon,
just a uniformly narrow one.

**With §8 (amenities).** Two contacts, both sharp. A shaft under construction closes that
Landing's shops for 2–4 raids while upkeep keeps running. A shaft with the Gate Open sells
nothing at every Landing it bypasses. Both mean commerce players build shafts late, at the
bottom, or not at all — which is a real strategic identity rather than a penalty.

**With §15 (Thrill).** Covered in §16.3 (capacity → `variety`) and §16.5 (the shaft table).
The one-line version: **capacity is the variety lever, shafts are the peril and tedium
levers, and the Gate is the comfort/Gold trade.** Every excavation decision now lands on the
Thrill formula somewhere, which is the test I'd want any new system to pass.

**With §6.4 (Downed → Slain).** A Chamber concentrates monsters, and a room that loses a
fight loses everything in it. Wide rooms are higher-variance for mob survival, not just
higher-power. Good — it gives the narrow corridor a reason to exist beyond being cheap.

**With §11 Q5 (treasure caches).** This makes caches worse. Capacity improvements and
caches now compete for the same room, and a cache was already the marginal option. If
excavation ships, cut caches or fold them into Landings as §11 Q5 already suggests.

### 16.9 What this costs us

Stated plainly, because the rest of the section is advocacy:

- **A whole new Build Phase panel.** A project queue with countdowns, per-room capacity
  readouts, a shaft target picker, and a Gate toggle — in a build phase that already has
  monsters, placement, gear, staffing, amenities, and pricing. This is the largest single
  UI addition in the document.
- **The Build Phase becomes a scheduling problem.** Deciding *what to build* is a game;
  deciding *in what order, to arrive by which raid* is a different and drier game. Some
  players will love it and some will experience it as homework.
- **It nerfs the opening, which is where seasons die.** Floor 1 goes from 12 free slots to
  9. §14.1 established that opening raids are the fragile part of the season; this is
  exactly the kind of change that quietly makes the first three raids unsurvivable.
- **It arrives before §11 Q3 is answered.** We still do not know whether auto-resolve is
  satisfying to watch. Adding build-phase depth on top of an unproven watch loop is the
  scope risk to be honest about — if the raid isn't fun, a richer build phase makes the
  game *longer*, not better.
- **It makes tedium harder to reason about.** Empty rooms, scaffolded rooms, skipped rooms
  and repeated rooms all now feed one number, and §15.6 Q3 already asks whether that number
  needs to be shown during the Build Phase. This makes the case for showing it much
  stronger, and that is a large commitment.
- **The commitment is asymmetric.** The shaft's *existence* is a heavy commitment; its
  *aim* is free to change every raid. The expensive decision is therefore the boring one
  ("do I want a hole here") and the interesting one is free. I don't think that's wrong —
  free re-aiming is what stops the entry index becoming a puzzle — but it is not the X-COM
  feeling the brief asked for, and it should be acknowledged rather than dressed up.
- **The Crew is a second "your monster isn't fighting" system waiting to happen.** §8.4's
  staffing cost is one of the design's best ideas. The obvious unification is to make the
  Crew a monster too. That would be elegant and it would also mean a player running one shop
  and one dig has two monsters behind counters and shovels — which is most of a prototype
  roster. Left unresolved, see Q8.

### 16.10 Open questions

In the style of §11 — things I cannot settle from the desk.

1. **Does a floor bypassed by a shaft count toward `depth`?** I ruled yes, because a shaft
   that *lowered* Thrill would be pointless. But it makes shafts a pure depth accelerant
   with a Gold cost and nothing else, which is probably too strong. Sweep it: count
   bypassed floors at 1.0, 0.5, and 0.0.
2. **Should `comfort` count amenities on bypassed Landings in its denominator?** As written,
   `amenities_used / amenities_available` punishes a shaft twice — no sales *and* a comfort
   penalty for shops they were never offered. I lean toward "available on the route taken."
   Measure both; it may be that the double penalty is what keeps shafts honest.
3. **Is Hewn = 3 survivable in raid 1?** This is §14.1's failure mode with a new cause.
   Sweep `ROOM_CAPACITY_BASE` at 2/3/4 against raid-1 through raid-3 Heart loss rate before
   committing. If 3 kills the opening, the fix is Prospected Start as a default rather than
   a Codex unlock, not a higher base.
4. **Is one Crew too few at 8 raids?** Eight crew-raits for a whole season may mean the
   system barely gets used before the season ends. This interacts with §11 Q1 (is 12 raids
   right?) — a longer season makes build times feel better and may be an argument for 12
   or 15 independent of the reasons already listed there.
5. **Under Thrill, does skipping rooms beat filling them?** `peril` is weighted 0.45 and
   `variety` 0.20, which suggests the optimum is a very short, very lethal route. If the
   runner finds "one Chamber and a shaft past everything else" dominant, either the variety
   weight goes up or shafts need a floor on how much they can skip.
6. **Should monsters in bypassed rooms still pay upkeep?** I ruled yes. If it turns out
   players just leave rooms empty behind a shaft, the upkeep rule is doing nothing and
   should be dropped for simplicity.
7. **Is closing a Landing's amenities during shaft construction too harsh?** Commerce is
   already at 8% season survival (§11 Q8). This adds a cost that lands almost entirely on
   commerce builds. It may need to be a revenue *reduction* (say 50%) rather than a
   blackout.
8. **Should the Crew be a monster, like amenity staff?** Tempting for consistency with
   §8.4 and it would give the Crew a real opportunity cost rather than an abstract one. The
   risk is stacking two systems that both remove monsters from rooms, in a game whose
   prototype roster is six species. Needs a human playing it, not a runner.
9. **Does purchased capacity make the Build Phase better or just longer?** The one question
   the balance runner cannot answer at all, and the one that decides whether this ships.

### 16.11 Prototype slice

In the spirit of §12 — the smallest version that tests whether this is fun, and nothing
else.

**In:**
- Per-room `capacityTier`, two tiers only: **Hewn (3, free)** and **Widened (5)**.
- Cost `40 × (1 + 0.30 × floorIndex)` — 40 / 52 / 64 on the prototype's three floors.
- Build time **1 raid**. **One Crew**, one project at a time.
- Cancel for 50% refund. Breach cancels all work.
- The scaffolded-room tedium term (+5, not stacking with the empty-room penalty).

**Out of the slice:** Hall, Chamber, shafts, Gates, entry indices, the Sapper Gang, and
every Insight unlock in §16.7. All of it. Shafts are the more exciting half of this section
and they are also the half that risks the anti-pillar, cost the most to build, and depend on
§15 having shipped and been measured. They do not go in until capacity has justified itself.

**Two code changes, and they are small:** `roomCapacity(floorIndex)` becomes
`roomCapacity(room)`, and rooms gain a `capacityTier` field plus a project queue on the
dungeon. Nothing in `raid.ts` changes except where capacity is read.

**The one thing that will make this measure nothing:** the balance runner's scripted AI
needs an excavation policy. §11 Q8 is the cautionary tale — the commerce strategy measures
at 8% partly because the AI staffs shops with Cave Rats. An AI that never widens a room, or
widens rooms at random, will report that this system does nothing. Write the policy before
trusting the numbers.

**The questions this slice answers:**
1. Does paying for capacity make the Build Phase a better decision, or just a slower one?
2. Is a 1-raid delay felt at all, or is it invisible noise?
3. Does an asymmetric floor plan emerge on its own, or does everyone widen everything in
   the same order?

---

## 17. Traps — the cheap defence

**Status: IMPLEMENTED (v0.4).** Built to answer a specific measured failure, recorded below.

### 17.1 The problem

Breach rate by raid, 750 seasons, before traps existed:

| raid | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| breach % | 4% | **39%** | 42% | 48% | 57% |

**72% of seasons ended overrun.** Raid 2 was a cliff. Starting Mana buys ~3 monsters, which
holds raid 1 comfortably; then income is ~130–150/raid, monsters are lost permanently to
`slayChance`, and the Threat Tier rises. The player cannot replace losses, let alone
invest — so §16's "keep building" fantasy was structurally unreachable.

The root cause: **monsters were the only defensive tool, and they are expensive AND carry
per-raid upkeep** — which §4.1 calls the pressure valve. A poor dungeon had no options.

### 17.2 Roster

| Trap | Tier | Job | Power | Slots | Cost | Re-arm | Charges |
|---|---|---|---|---|---|---|---|
| **Dart Battery** | 1 | Damage, every member, ignores armour | 7 | 1 | 24 | 8 | 2 |
| **Snare Net** | 1 | Delay — the party forfeits its turns | 3 ticks | 1 | 30 | 10 | 1 |
| **Rot-Gas Vent** | 2 | Kit destroyed | 3 | 1 | 38 | 13 | 1 |
| **Shrieker** | 2 | Resolve damage, every member | 6 | 1 | 34 | 11 | 1 |
| **Deadfall** | 3 | Burst on the healthiest body | 30 | 2 | 66 | 22 | 1 |

**The economic shape is the whole point: zero upkeep, ever.** A trap's only recurring cost
is re-arming the charges it actually spent, paid in the Build Phase and never automatic. A
monster bills you whether it fought or not; a trap bills you only when it worked. Traps
never level and never die — they are the one thing in the dungeon that does not improve,
which is why they soften the early cliff without inflating the endgame.

Three of the five deal no HP damage at all. They **set up whatever stands behind them**, so
an all-trap room is a room the party walks out of — which is §7.5's "soften, then kill"
arrived at as a budget rather than a rule.

**Traps share the monster slot budget.** A free layer would put a trap in every room, make
no room "empty" for Tedium, and reopen §15.1 through the back door. A Floor-1 room is 4
slots: an Ogre (3) plus a Snare, or a Skeleton plus two traps, or four traps and nothing
that can finish anybody.

**Spring (§7.4) is now wired.** One Ley Charge fires any armed trap at the party's current
position. Its value is reach — a Floor-3 trap is dead mana against a party turning back on
Floor 1 — and timing. The multiplier is deliberately 1.0: springing a trap they would have
walked into anyway wastes the charge, which is what makes it a decision.

### 17.3 Keeping traps out of the Thrill loophole

Three rules, all keyed on **armed**:

1. **A spent trap is a hole in the floor.** Its room counts as empty for Tedium. Keeping
   the relief means paying to re-arm — cheapest is 9 mana against 4 Tedium × 1.8 mana =
   7.2, so it is deliberately not free.
2. Trap ids are in the room signature, so nine Dart Battery rooms are repeats.
3. **The whole trap layer is worth at most one `variety` entry** however many jobs fire.
   Uncapped, four traps (~190 mana, no upkeep, no bestiary) would max the term that exists
   to reward a wide roster.

### 17.4 Result

| | before | after (balanced) | trap-leaning build |
|---|---|---|---|
| raid-2 breach | 39% | 29% | **8%** |
| seasons overrun | 72% | 54% | **29%** |
| reach raid 8 | 305/750 | — | 488/600 at Tier 2.9 |

The raid-2 *step change* is gone in both configurations — the curve is a ramp. For a
trap-leaning build, raid 2 is the safest raid of the season.

An unplanned win for pillar 3: best monster level rose 1.6 → 2.2 and monsters lost fell
13.2 → 7.4, because traps absorb work that used to kill veterans.

### 17.5 Deliberately not done

Pushing the generalist strategies to a 0.4 trap share reaches 43% overrun and Tier 3.5 —
better on every headline number. **It was reverted.** At 0.4 every strategy converges on
the same dungeon: `combat` kills 2.1 a season instead of 11.6 and sends 26.6 people home,
which is `wardens`' line exactly. Best monster level collapses to 0.6. Traps produce
retreats, not corpses, so past about a third of the purse **pillar 2's three distinct
builds become one and pillar 3 stops happening**. Winning numbers, dead design.

### 17.6 Still open

1. **Cheap monsters have terrible marginal efficiency.** Under focus fire a Skeleton dies
   in ~3 ticks having delivered ~11 damage for 40 mana + 4 upkeep; an Ogre delivers ~52 for
   85 + 7. The only efficient defence is a big monster you cannot afford yet, and
   everything between is a bad buy. Traps work *because* they are immune to focus fire and
   always deliver their full payload — but the gap underneath is what makes the mid-tier
   bestiary feel pointless.
2. **§14.5 is unfixed.** Adventurers out-scale monsters permanently, so a build that rides
   the ratchet outruns its own veterans.
3. **The residual raid-2 spike is a digging artifact**, not a trap problem: the raid after a
   dig is a 10-room dungeon with 6 rooms of defence. Delaying the dig is worse (a floor
   pays 40/raid). If raid 2 should be flatter still, the lever is the dig cost curve.

---

## 18. Formation — how a delve engages

**Status: IMPLEMENTED (v0.5).**

### 18.1 The problem

Every living party member acted every tick, simultaneously, and the tier table sends three
adventurers at Tier 1. So from the first raid your monsters faced 3-on-1 in every room with
no ramp. In the owner's words: *"Having an entire group go in against the monsters is very
much one-sided."*

### 18.2 The rule

**Party sizes are unchanged.** The only thing that changes is engagement order inside a
room. Formation is a column on the Threat Tier table (§4.4):

| Tier | 1 | 2 | 3 | **4+** |
|---|---|---|---|---|
| party size | 3 | 3 | 4 | 4–5 |
| formation | single-file | single-file | single-file | **party** |

- **Single-file** (the baseline). The whole group arrives, descends, rests, shops, spends
  Kit and votes on the Descent Decision together — but only the point man fights. When they
  fall or withdraw, the next fit person steps up.
- **Party.** Everyone engages at once. This is the old behaviour, now an *escalation*: the
  same three people who used to file in politely arrive as a coordinated company.

Tier 4 rather than later because `MAX_TIER_PROTOTYPE` is 4 — a milestone the player can
never reach is a comment, not a milestone. Measured, 46–65% of seasons meet a party.

**Line-break** (`lineBreakHpPct` 0.3): the point man withdraws when badly hurt and the next
steps up; if nobody is fit, the delve retreats alive. Without it single-file is a meat
grinder — every early raid ended in a wipe, a wipe pays no Renown (§15.3), and the ratchet
seized at Tier 1 forever.

**Disengaging under fire** (`linePartingMult` 0.4): everything in the room lands one blow
on the man turning his back. This is the load-bearing knob. At 0, withdrawal is a teleport,
nobody ever dies (season kills 11.6 → 2.5), and `peril` is pinned by the *rule* rather than
set by the dungeon.

### 18.3 Role identity with one target (§6.2)

Single-file collapses "finish the wounded" and "pick the squishiest" into the same choice,
so roles needed another expression:

- **Caster** — shoots *past* the line at the squishiest person in the room. The one role a
  queue cannot screen, and single-file's designed counter.
- **Skirmisher** — chases, with a 1.6× bonus on the parting blow.
- **Bruiser** — becomes "the thing you cannot safely stop fighting".
- **Warden / Terror** — already party-level (shared Kit, morale). Formation-blind.
- **Traps** — deliberately formation-blind: a mechanism fills a room. This is what makes
  traps the cheap answer to a queue.

### 18.4 Peril — the expected problem that did not happen

The predicted risk was that `peril` (a mean over survivors' low-water HP) would deflate,
since the point man eats everything while the queue stays pristine. A correction knob was
built — and then measurement showed **the deflation does not occur**: because the line
*rotates*, any delve worth scoring feeds every member through the door. `balanced` peril
went **0.28 → 0.39**.

The only delves where the queue stays pristine are the ones where nothing could hurt
anyone — the §15.1 family exactly. The knob ships at 0, kept and swept.

`retireThrill` was re-derived 45 → **60** from the new p90 of 56.9; at 45 it qualified one
delve in four and became an unintended second Renown engine.

### 18.5 Result

| | survive | tier | renown | breach | mobLv | peril |
|---|---|---|---|---|---|---|
| balanced **before** | 49% | 2.4 | 81 | 1.6 | 2.2 | 0.28 |
| balanced **after** | **71%** | **2.9** | 138 | **1.1** | **3.1** | 0.39 |

Breach % by raid: `1 29 31 44 39 25 15 16` → **`0 0 4 9 22 28 30 26`**. Seasons overrun
**54% → 28%**.

The early game is fair — raids 1–2 breach at 0% — and the late game is not flattened: raids
5–8 still breach at 22–30%. The player sees *more* content while dying less (Tier 2.9 up
from 2.4).

### 18.6 Two builds regressed, and the reasons are informative

1. **`traps` 29% → 39% overrun.** Isolated: forcing single-file at every tier gives traps
   30% survival vs 27% at the Tier-4 flip, so this is **not** the formation change. It is
   the Renown ratchet carrying a build with zero scaling to Tier 4 faster — §14.5 and
   §17.6.1 biting a build with no answer to them. Arguably correct (traps start you, they
   do not finish you), but it is a real cost.
2. **`swarm` 97% → 42%.** Chip damage can no longer finish anyone before they step back.
   This is the sharpest new strategic statement in the change: **chaff is now a `party`-
   formation answer, not an early one.** Under single-file a mob of rats gnawing on one
   person who can withdraw at will is a nuisance, not a threat.

**New failure mode:** an over-killed room wipes a single-file queue in ~10 ticks for zero
Renown, because you cannot withdraw from an Ogre alpha strike. `predictThrill`'s "looks
lethal" warning covers it, but over-building is punished harder than before.
