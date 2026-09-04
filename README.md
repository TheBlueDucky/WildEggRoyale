# 🥚 Wild Egg Royale

A 3D peer-to-peer 1v1 strategy game. Explore a wild map, hatch a 10-animal
army, destroy the enemy's Dragon Eggs, and summon a dragon to bring down their
castle.

**No game server.** Matches run host-authoritative over WebRTC, and players are
paired with no visible lobby code.

## Status: M5 complete — the game is winnable

M0–M5 is a complete match: explore, hatch a 10-animal army, agonise over the
tenth slot, siege the enemy castle, destroy three Dragon Eggs, and summon a
dragon that has to survive their whole army to burn the keep down. Everything
from M6 on is retention, not gameplay. See [ROADMAP.md](ROADMAP.md) for verified
results and the bug pass.

## Run it

```bash
npm install
npm run dev
```

Open **two tabs** on `http://localhost:5173`. They pair automatically within a
few seconds — no code to copy.

| Control | Action |
|---|---|
| WASD / arrows | move (camera-relative) |
| Space | basic attack |
| scroll | zoom |
| F3 | toggle debug overlay |
| walk onto an egg | hatch it (stand still; damage interrupts) |
| 1-0 / Esc | pick a replacement slot / discard, when your army is full |
| left-drag | box-select your animals (click selects all) |
| right-click | send the selection to that spot |
| E | recall the selection to your leash |
| middle-drag / Alt+drag | orbit the camera |

> Both tabs must be visible-ish to render, but the sim itself keeps running at
> full rate in a hidden tab (see `src/net/ticker.ts` for why that took work).

## Docs

| File | Contents |
|---|---|
| [DESIGN.md](DESIGN.md) | Pillars, match flow, phase gates, the no-server strategy |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 3D rendering, simulation, netcode, matchmaking |
| [CONTENT.md](CONTENT.md) | 34 animals, eggs, abilities, maps, events, JSON schemas |
| [META.md](META.md) | Collection, Trust Ladder ranked, seasons, quests, clips |
| [ROADMAP.md](ROADMAP.md) | Milestones M0–M9 |

## How matchmaking works with no server

PeerJS lets a peer claim a *specific* broker ID, and duplicates are rejected
atomically — a distributed lock:

```
claim "weg-v1-c-host-1"
  SUCCESS -> nobody here, become the waiting host   ("0/2, create match")
  TAKEN   -> someone is waiting, connect to them    ("1/2, auto-join")
```

A ladder of 8 slots plus **beacon handoff** (paired peers move to random IDs and
free the slot within ~1s) makes concurrency unbounded. Full details and the
failure matrix are in [ARCHITECTURE.md](ARCHITECTURE.md#2-matchmaking).

## Layout

```
src/
  net/       peer, matchmaker, protocol, snapshot, clock, ticker
  sim/       headless sim — terrain, eggs, units, structures, dragon, world
  game/      match orchestration: handshake, host loop, client prediction
  render/    Three.js view layer, reads sim state and owns none of it
  ui/        army panel, replace modal, phase bar, boss bar, summary
  content/   animals, abilities, eggs, maps + hash (peers must agree, or abort)
```

**Hard rule:** nothing under `src/sim` may import from `src/render`, `src/ui`,
or `three`. The simulation has to run headless — that is what makes it testable
and what lets the client run a hollow mirror of it.

## Scripts

```bash
npm run dev        # dev server
npm test           # 36 headless simulation tests
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build
```

## Tests

`src/sim/sim.test.ts` runs the whole game in Node — no browser, no canvas, no
peer connection — because nothing under `sim/` imports three or touches the DOM.
It covers determinism, pathing, hatching, combat, phase gates, the dragon
lifecycle, the snapshot wire format, and a 6000-tick invariant soak that checks
every entity each tick for NaN, HP over max, alive-at-zero-HP, out-of-range
positions, units inside rock and dangling target ids.
