# Coreward

A dungeon-builder / reverse tower-defense roguelite. You are the intelligence at the
bottom of a dungeon: buy monsters, dig floors, run shops on the landings, and decide
raid by raid whether to kill the adventurers, bleed them dry, or sell to them.

**Prototype v0.1** — simulated combat, colored rectangles, no art.
Full design in [`docs/DESIGN.md`](docs/DESIGN.md).

```bash
npm install
npm run dev       # play it
npm test          # 59 tests: sim, determinism, UI smoke
npm run balance   # headless strategy comparison
```

## How to play

1. **Build Phase** — spend Mana on monsters and floors, Gold on gear and hirelings.
   Click a monster to select it, then a room to place it (or a shop to staff it).
2. **Raid** — a party descends. Watch at 1×–4×, or hit Instant. You get 3 Ley Charges:
   pull a monster out of a losing fight, or **Taunt** a retreating party one floor deeper.
3. **Aftermath** — collect Mana, Gold, Souls, and Renown.

**Renown is the difficulty dial and it only goes up.** Letting adventurers escape pays far
more Renown than killing them, and Renown is what raises the Threat Tier of everyone who
comes next. Killing an adventurer destroys 75% of the gold they were carrying, so
predation and commerce genuinely compete for the same person.

## Architecture

The one rule that matters ([§13.2](docs/DESIGN.md)):

```
src/sim/     pure TypeScript, zero engine/DOM imports, seeded RNG, deterministic
    │        given (dungeon, party, seed) → an ordered RaidEvent[] stream
    ▼
src/ui/      consumes that stream at whatever speed it likes
             v0: DOM rectangles  →  later: isometric / 2.5D
```

Everything good follows from it: speed modes are just how fast you drain the queue,
"Instant" is draining it with no renderer at all, replays are a seed plus an input log,
and the eventual 2.5D renderer is a swap rather than a rewrite.

**`Math.random()` must never appear under `src/sim`.** All randomness goes through the
injected seeded PRNG in `src/sim/rng.ts`. `test/determinism.test.ts` enforces it.

```
src/sim/rng.ts          seeded PRNG (mulberry32)
src/sim/types.ts        core types + the RaidEvent union
src/sim/data.ts         all tuning tables; TUNING holds the sweepable knobs
src/sim/dungeon.ts      dungeon state, Build Phase actions, gear, staffing
src/sim/adventurers.ts  party generation
src/sim/raid.ts         the steppable tick loop — the heart of the sim
src/sim/season.ts       season orchestration and the Aftermath economy
tools/balance.ts        headless batch runner + parameter sweeps
tools/trace.ts          verbose single-season trace, for debugging
```

## Balance tooling

Because the sim is headless and deterministic, tuning questions are answerable in seconds:

```bash
npx tsx tools/balance.ts compare 400   # strategy comparison
npx tsx tools/balance.ts sweep 400     # parameter sweeps
npx tsx tools/trace.ts 42 combat       # one season, verbose
```

This found three design bugs that looked like tuning bugs — a one-floor dungeon with no
Descent Decision, permadeath that made monster leveling unreachable, and a Gold economy
with no sink. All three are written up in §14 of the design doc.

## What the prototype is for

Three questions, and nothing else:

1. Does the Renown ratchet create a real decision?
2. Is Taunt as tense as it looks on paper?
3. Does staffing a shop hurt enough to be interesting?

If those land, the rest is content.
