# Roadmap

Ordered by **risk retired per week**, not by what's fun to build. The two things most likely to sink this project are matchmaking and 3D unit performance, so both get proven before any content exists.

---

## M0 — Netcode spike ✅ COMPLETE

Two capsules on a flat plane. No game. Built and verified.

- PeerJS wrapper, broker list with failover
- Full slot ladder: connect pass -> jitter -> claim pass -> re-probe -> widen
- `HELLO` handshake with `contentHash` abort
- 20 Hz host sim, quantised snapshots, client interpolation (100 ms buffer)
- Client-side prediction + reconciliation on the local capsule only
- Debug overlay: RTT, tick, bytes/s, reconciliation error, tick lead

### Exit test results

| Assertion | Result |
|---|---|
| Two clients auto-match with no code shown | ✅ pass |
| Third and fourth clients pair with each other, not the running match | ✅ pass — match 1 held 19.9 snaps/s throughout |
| Simultaneous reload (both claim at once) still resolves | ✅ pass via the re-probe backstop |
| Snapshot rate holds at target | ✅ 20.2 snaps/s |
| Prediction stays converged | ✅ avg visible correction 0.13 m, max 0.40 m (= 1 tick of travel) |
| Tick lead stable | ✅ +3 to +4 ticks |
| Console errors | ✅ none |

### Findings worth carrying forward

**1. Background-tab throttling broke the host sim. Fixed.**
A hidden tab clamps main-thread timers, and the host's authoritative sim fell
from 20 Hz to **6.37 Hz** — which slows the match for *both* players, because
one peer is the authority for everyone. Moving the heartbeat into a dedicated
Worker (`src/net/ticker.ts`) restored **19.95 Hz while hidden**. This was the
single most valuable thing M0 surfaced; it would have been miserable to
diagnose once there were 120 entities and a dragon on screen.

**2. Binary snapshot encoding is required — now measured, not guessed.**
Host output is ~73 bytes/snapshot for 2 entities, i.e. ~23 bytes per entity of
JSON tuple. Extrapolating to the M3 target of 120 entities:

```
26 + 120 x 23 = ~2.8 KB per snapshot  x 20 Hz = ~56 KB/s
```

That is more than double the ~24 KB/s design budget. Write the ArrayBuffer
encoder in M3, not later — the quantisation is already in place, so it is a
contained change to `snapshot.ts`.

**3. Delta encoding is still unbuilt.** Irrelevant at 2 entities; pair it with
the binary encoder in M3.

**4. Reconciliation must be measured after replay.** Comparing the predicted
position against the raw authoritative one reports the input lead distance
(1.2 m at 3 ticks) and looks like a desync when nothing is wrong. The metric now
measures the visible correction after unacked inputs are replayed.

**5. No reconnection.** A reload on either side correctly ends the other's match
with "Opponent disconnected". Reconnect support is deliberately out of scope.

---

## M1 — 3D world ✅ COMPLETE

- Procedural heightfield terrain (seeded value-noise fBm), flattened near castles
- 1m walkability grid derived from slope, baked at load
- Orbit follow camera: right-drag to orbit, scroll to zoom, pushed clear of terrain
- Camera-relative movement, rotated into world space client-side
- Player HP, basic attack, death, 10s castle respawn
- Zone bands (safe / wilderness / contested) with vertex tint + boundary lines
- Ground raycast cursor ring, placeholder castle keeps
- Map validation metrics: walkable fraction, castle connectivity, detour ratio

**Terrain is generated from `terrainSeed`, not a heightmap PNG.** The sim derives
walkability from it, so both peers must agree exactly — procedural generation
gets that for free with no asset pipeline, and `Terrain` hides it behind
`heightAt()`/`walkable()` so a PNG sampler can replace it later.

### Exit test results

| Assertion | Result |
|---|---|
| Both peers agree where the other is | ✅ **1.7 mm** apart (inside the 3.9 mm quantisation bound) |
| Player never enters blocked terrain | ✅ 0 violations across 960 samples |
| Map is fully traversable | ✅ 127.6 m travelled of 128 m ideal, 1.3% stalled |
| Castles reachable from each other | ✅ detour ratio **1.105**, 100% of walkable ground connected |
| Death and respawn | ✅ killed at tick 1100, respawned tick 1300 = **exactly 10.0 s**, own castle, full HP |
| Damage is host-authoritative | ✅ 25/hit, never predicted client-side |

### Findings worth carrying forward

**1. The slide angle set must include exactly 90°.**
The nastiest bug of the milestone. Pressed flat against an axis-aligned wall,
every deflection below 90° keeps a small component *into* the wall (cos 88° is
still 0.035). When an entity sits near a 1m cell boundary that component is
enough to land back in the blocked cell, so **every** candidate fails and the
player sticks completely with open ground right alongside. Measured 67.5% of
frames stalled; adding a purely perpendicular 90° option (plus 105° to back out
of concave corners) dropped it to 1.3%. M3 unit steering inherits this.

**2. Map tuning needs a number, not an eyeball.**
`maxWalkSlope` at 0.85 left the map 100% walkable — the collision code never
ran. At 0.45 it produced 8.5% blocked, but as *large masses* that walled the map
in half. `detourRatio()` (walking distance between castles ÷ straight-line
distance) is the metric that actually captures this. At 0.6 the map sits at
3.2% blocked, detour 1.105 — thin ridge lines that shape movement without
blocking it. Every new map should be checked against this before it ships.

**3. Terrain must be part of the content hash.** Walkability feeds prediction,
so peers on different map data would desync silently. `MAPS` is now hashed into
the bundle, and mismatched builds refuse to connect.

**4. Automated testing needs an input hook.** Driving `localInput` directly
fights the rAF loop, which overwrites it every frame — and rAF is paused in
hidden tabs, so the two failure modes alternate confusingly. `__weg.setTestInput()`
(dev builds only, behind `import.meta.env.DEV`) makes this deterministic.

## M2 — Eggs & the 10-slot choice ✅ COMPLETE

- 34-animal roster as data, referenced over the wire by index
- 7 egg tiers with hatch times, tier colours and light pillars
- Deterministic egg layout from the shared seed, mirrored through the origin
- Hatch channel: progress on the egg, walk-off reset, damage interrupt, steal
- Contested-zone eggs locked until the 4:00 siege window
- 10 army slots, host-authoritative, event-driven sync
- Hatch offer with a 15s countdown, and the replace modal

**Egg positions and tiers are never sent over the network.** Both peers generate
an identical layout from the shared seed; only mutations (progress, consumed)
travel as deltas, typically 0-2 rows per snapshot.

**The replace modal does not pause the game.** A modal that freezes one player
in a real-time P2P match either stalls the opponent or hands the chooser free
safety. The animal is held for 15 seconds while the world keeps running, so
deciding under pressure IS the mechanic.

### Exit test results

| Assertion | Result |
|---|---|
| Both peers generate an identical egg layout | ✅ same 34-egg fingerprint hash, zero bytes on the wire |
| Layout is perfectly symmetric | ✅ 0 mirror violations across 17 pairs |
| Hatching fills the army | ✅ egg consumed, animal appended, synced host↔client |
| Contested eggs stay locked until 4:00 | ✅ 0 progress after 89 ticks standing on a locked egg |
| Full army raises a timed offer | ✅ 15s countdown, blocks further hatching |
| Replace applies host-authoritatively | ✅ client command → host → both armies agree |
| Composition warnings are correct | ✅ flagged "no Tank" and "last 🏰 siege"; correctly did NOT flag a same-role swap |
| Stealing a channel | ✅ opponent at 78% shouldered off, thief kept the progress |
| Damage interrupts a channel | ✅ 0.43 → 0, re-denied on every 0.6s swing |

### Findings worth carrying forward

**1. The slide sweep must reach 180°, not stop at 105°.**
A second, distinct failure from the same code M1 fixed. Capped at 105°, an
entity that walks into a *concave bay* cannot leave — the only exit is behind
it, and all 15 sampled directions still point into rock. Measured: frozen
indefinitely with open ground two metres away. The full sweep guarantees that if
any adjacent cell is open the entity can reach it, and because the first
walkable candidate wins it still takes the smallest deflection that works.
M3 flow-field units inherit this directly.

**2. Egg contents are rolled on the host, not seeded.**
The layout is seeded (free bandwidth), but if contents were seeded too, a
modified client could read every egg's animal before touching one. Contents come
from a separate host-side RNG stream and reach the client only on hatch.

**3. Discrete commands do not belong in the input stream.**
Replace/decline are rare, must not be lost, and are meaningless to
tick-align. They ride a separate `cmd` message applied on receipt. Armies and
offers are event-driven too — ten indices per side at 20Hz would cost more than
all the entity data combined.

**4. A blocking decision needs a deadline, not a pause.** The 15-second timer is
what lets the modal exist at all in a real-time P2P match.

**5. Automated play needs pathfinding to be useful.** The test driver walks
straight at a target and orbits when a ridge is in the way — it cannot reach
eggs behind terrain. Not a game bug, but it caps what can be verified by script
until M3 lands flow-field pathing.

## M3 — Animals & combat ✅ COMPLETE

- `InstancedMesh` per animal type — twenty wolves are one draw call
- Targeting AI on a 500ms retarget cadence, with flier/ground targeting rules
- **Flow-field pathing**: one BFS from the destination, shared across a group
- Separation steering, so a stack of twenty does not occupy one point
- Combat, armor, auras, and the structure-damage multipliers (used from M4)
- Leash + detach: drag-select, right-click to send, E to recall
- Ability executor — one switch, one file — over a data-only effect vocabulary
- 23 of the 34 animals carry a structured ability

**Animals respawn at the castle after 20s rather than dying permanently.**
Permanent loss would empty armies over a match and quietly kill the 10-slot
replace decision that the whole egg loop is built around.

### Exit test results

| Assertion | Result |
|---|---|
| 20 units per side in one fight | ✅ 22 entities, full 10v10 resolves |
| Both clients show the same result | ✅ **2.59mm** max position error, 0 HP and 0 state mismatches |
| Frame budget | ✅ **2.96ms CPU/frame** = 17.7% of the 60fps budget, **30 draw calls** |
| Sim cost | ✅ **0.166ms/tick average** against a 50ms budget (0.3%) |
| Units path around terrain | ✅ 10/10 arrived within 1.5m of a destination whose direct line crosses 8 blocked samples |
| Abilities fire | ✅ poison active 6/6 samples, stun 2/6, armor reducing damage as configured |
| Bandwidth | ✅ 12.8 KB/s at 22 entities |

The agreement test is the one worth explaining: rather than sampling both peers
across tool round-trips (which races against a moving world and produced a
bogus 22m "disagreement"), the host records its authoritative state per tick and
the client reports the raw snapshot it received. Comparing tick 3758 to tick
3758 is the only honest version of this measurement.

### Findings worth carrying forward

**1. Respawn was silently discarding standing orders.**
`stepRespawns` reset `detached`, so a group the player had just sent somewhere
drifted back to the leash as its members trickled back — with `orderX` still
set, which made it look like pathing had failed. Orders now survive respawn;
recall is explicit (E). An order quietly discarded is worse than one that needs
cancelling.

**2. Binary snapshot encoding is still NOT needed — measured, not assumed.**
M0 projected ~56 KB/s at 120 entities and scheduled the ArrayBuffer encoder for
M3. Actual: **12.8 KB/s at 22 entities** (~29 bytes/entity/tick), which
extrapolates to ~35 KB/s at 60 entities. Deferring to M4/M5, when structures and
the dragon push entity counts up, is the better trade — the quantisation is
already done, so it stays a contained change to snapshot.ts.

**3. Static unit fields do not belong in snapshots.** Kind, side, animal and
slot never change, so they ride a separate roster message sent on change.
Repeating five constant fields per unit at 20Hz would have cost more than all
the moving data combined.

**4. Flow-field rebuilds are the only visible spike.** Sim step averages 0.166ms
but peaks at 9.6ms when a field rebuilds (BFS over ~35k cells). Still well
inside the 50ms budget, but it is the thing to watch as entity counts grow;
fields are already cached and reused within 3m.

**5. O(n^2) separation and targeting are fine at this scale.** 22 entities is a
few thousand cheap checks per tick. The uniform spatial grid the plan called for
would be an untested optimisation solving a problem the measurements say does
not exist yet.

**6. Balance is untuned.** A full 10v10 resolves in roughly ten seconds. That is
a numbers problem, not a systems one, and it belongs in the M9 balance pass —
but it is worth knowing that current damage values make fights very swingy.

**Not yet verified:** true end-to-end frame rate. The browser pane does not
composite `requestAnimationFrame` while hidden, so the 2.96ms figure is CPU
submit time and excludes GPU execution and vsync. Real FPS on integrated
graphics still needs a human to open the page.

## M4 — Castles & siege ✅ COMPLETE

- Castles, 4 towers and 3 Dragon Eggs per side, generated from the map
- Dragon Eggs invulnerable until the 4:00 siege window, with a visible shield
- Tower auto-fire (45 dps, 18m), weakening at the 10:00 gate
- Structure damage multipliers — composition finally decides siege speed
- Phase gates at 4:00 / 10:00 / 15:00 with announcements on both peers
- Egg-destruction countdown and the DRAGON AWAKENING trigger
- Phase bar: match clock, next gate countdown, Dragon Egg pips

**Structures are derived from the map on both peers**, exactly like the egg
layout, so no structure position, type or side ever crosses the network — only
HP and life state, through the snapshot path that already existed.

**The keep cannot be damaged by an army at all.** Verified: a side that has
destroyed all three enemy Dragon Eggs still leaves both castles at 8000/8000.
Only a dragon ends a match, which is what makes the dragon worth building the
whole game around.

### Exit test results

| Assertion | Result |
|---|---|
| Both peers derive identical structures | ✅ same 16-structure fingerprint, zero bytes on the wire |
| Dragon Eggs invulnerable before 4:00 | ✅ 0 damage, and units do not even target them |
| Siege multipliers work | ✅ siege comp **393 dps** vs predicted 402; wolves 130; turtles 23 |
| Towers punish an unsupported siege | ✅ 58 hp/s incoming, attackers 10 → 5 |
| Towers crumble at 10:00 | ✅ maxHp 1200 → 600, damage scale 1.0 → 0.7 |
| Wildfire at 15:00 | ✅ exactly 100 dps (5% of 2000) — eggs burn out in 20s |
| Egg chain and awakening | ✅ "2 remaining" → "1 remaining" → DRAGON AWAKENING, `dragonReady` set |
| Announcements reach the client | ✅ all six, including SIEGE OPEN |
| Castle survives a full army | ✅ 8000/8000 with every Dragon Egg gone |
| Bandwidth | ✅ 17.7 KB/s at 28 entities |

### Findings worth carrying forward

**1. Attack range was measured centre-to-centre, which silently broke melee
siege entirely.**
The worst bug of the milestone because the numbers looked fine. Separation holds
a unit at `attacker.radius + target.radius` from a target's centre, so a Wolf
(1.8m reach, 0.45m radius) standing flush against a Dragon Egg (1.6m radius)
sits 2.05m from its centre — outside its own range, forever. Ten Wolves dealt
**4.3 dps** where the multiplier predicts ~76. Measuring surface-to-surface took
that to **129.6**, and the siege comp from 66.7 to **393**. Every melee animal in
the game was unable to damage a building, and nothing about the multipliers or
the combat log hinted at it.

**2. Units should not target what they cannot hurt.** Before the fix for
invulnerable eggs, an army would happily walk into tower fire and stand next to
a shielded egg doing nothing. `canBeDamaged` is checked during target
acquisition, not just when damage lands.

**3. Buildings must be immovable in separation.** Sharing the overlap push
equally let a unit shove a tower across the field. Structures now absorb none of
it and the unit takes the whole correction.

**4. The invulnerability window needs a visual.** A gate that silently switches
on reads as "my attacks randomly started working". The shield bubble and the
"siege opens in m:ss" countdown exist so the rule is legible before it matters.

**5. Wolf pack aura is doing real work.** Ten Wolves measured 130 dps against
the predicted 76 — the +15%-per-nearby-Wolf aura stacking into its 0.6 cap. The
cap is load-bearing; without it ten wolves would have been at +150%.

## M5 — Dragon ✅ COMPLETE

- Five-phase boss FSM: ARRIVING -> ASSAULT -> ENRAGED -> SLAIN | TRIUMPHANT
- Sky arrival: descends 60m over 6s, invulnerable, with a shrinking ground shadow
- Enrage at 60% HP: +50% damage, +30% speed, visible aura and faster wingbeat
- Slain -> defender's Dragon Eggs reform at 40% after 45s; attacker must re-earn it
- Castle destruction -> win/lose, with an end-of-match summary
- Boss health bar, and the dragon outranks everything in target priority

**M0–M5 is now a complete, winnable game.**

### Exit test results

| Assertion | Result |
|---|---|
| Arrival descends and transitions | ✅ 60m -> 9m over 6s, then ASSAULT at 9 m/s |
| Enrage threshold | ✅ fires at 59%, phase 1 -> 2, announced |
| Slain resets the attacker | ✅ `dragonReady` cleared, corpse removed |
| Comeback beat | ✅ eggs reform at exactly **800 HP** (40% of 2000) after 45s |
| Castle destruction wins | ✅ 200 dps, outcome `{winner, castle, atTick}` |
| Client mirrors the dragon | ✅ phase, altitude and HP all match; outcome propagates |
| Both dragons at once | ✅ ran simultaneously without interference |
| Frame budget | ✅ **5.26ms/frame** (31.5% of 60fps), 121 draw calls, 40 entities |

---

## Bug pass — findings and fixes

A systematic sweep after M5: code reading, then a live invariant soak.

### Fixed

**1. Melee units could not damage any structure** *(found in M4, the worst of the set)*
Attack range was measured centre-to-centre. Separation holds a unit at
`attacker.radius + target.radius` from a target's centre, so a Wolf (1.8m reach,
0.45m radius) flush against a Dragon Egg (1.6m radius) sat 2.05m away —
permanently out of range. Ten Wolves dealt **4.3 dps** against a predicted 76.
Now measured surface-to-surface: **129.6 dps**, and siege comps went 66.7 -> 393.

**2. Aura sources buffed themselves.** Wolf pack bond is "+15% per NEARBY wolf",
but the source was included in its own aura, so a lone wolf carried a permanent
free +15%. Verified after the fix: lone wolf **0**, pack of four **+0.45**.

**3. Attackers burned their cooldown on empty swings.** A tower with nothing in
range still went on cooldown every tick, handing an arriving attacker up to a
free second. `swing()` now reports whether it fired, and only a real attack
spends the cooldown.

**4. The client's phase gates never opened.** `world.siegeOpen()` reads
`world.tick`, but the client never runs `step()`, so its tick sits at 0 forever —
Dragon Eggs would have rendered as shielded for the entire match on the client.
Gates now go through `match.siegeOpen()`, which uses the host-derived tick.

**5. Respawn silently discarded standing orders** *(found in M3)*. A detached
group drifted back to the leash as members trickled back, with `orderX` still
set — which looked exactly like a pathing failure.

**6. Selection accumulated dead and deleted unit ids.** Units die, respawn under
new ids, or get replaced out of the army; the selection is now swept each frame
and dead units are excluded from box-select.

**7. Structures could be shoved.** Separation split the overlap evenly, so a unit
walking into a tower pushed it across the field. Buildings are now immovable and
the unit absorbs the whole correction.

**8. The match clock ran after the match ended.** The sim freezes on a castle
falling but the tick keeps counting, leaving a live timer behind the summary.

**9. Units targeted things they could not hurt.** Armies stood next to shielded
Dragon Eggs doing nothing; `canBeDamaged` is now checked during target
acquisition, not only when damage lands.

### Verified clean

A live invariant soak wrapped `World.step()` and checked, every tick, for: NaN
in position/HP/yaw/altitude, HP above max, alive-at-zero-HP, positions outside
the quantisation range, ground units inside rock, dangling target ids, duplicate
entity ids, and egg progress out of [0,1].

**1117+ ticks across a full 10v10 with both dragons airborne, every phase gate
crossing, a rebirth cycle and a castle destruction: zero violations.** Zero
uncaught errors or promise rejections on either peer.

### Known, not fixed (deliberate)

- **Structures ride every snapshot** despite never moving — 16 of 40 entities.
  Worth dirty-tracking when bandwidth matters; at 24 KB/s it does not yet.
- **The dragon renders from mirrored state, not interpolation**, so it moves at
  20Hz rather than frame rate. Visible only as slight stutter.
- **Balance is untuned.** A 10v10 still resolves in roughly ten seconds.
- **True FPS is unmeasured.** The 5.26ms figure is CPU submit time; the browser
  pane does not composite `requestAnimationFrame`, so GPU cost and vsync are
  excluded.

## Audit pass — code read + headless test suite

A second, deeper sweep: a line-by-line read of the simulation, then a real test
suite. `npm test` runs **36 tests** covering determinism, terrain, pathing,
hatching, combat, phase gates, the dragon lifecycle, the wire format and a
6000-tick invariant soak.

**The test suite exists because `sim/` never imports three or touches the DOM.**
That rule felt pedantic in M0; it is what lets the entire game run in Node with
no browser, no canvas and no peer connection.

### Bugs found by reading, and fixed

**1. Any friendly entity taking damage cancelled your hatch.**
The worst gameplay bug in the project. `applyDamage` interrupted the target's
whole SIDE, so a wolf trading blows on the far side of the map cancelled your
channel. With ten units in play, long hatches were close to impossible and it
would have read as "hatching is broken" rather than a bug. Only the channelling
player interrupting now — verified live: a hatch completed while all five
friendly units were under fire.

**2. Knockback shoved buildings.** Separation was fixed in M4, but the `knockback`
effect called `slideMove` directly on its target, so a Rhino physically pushed
towers across the field. Verified after the fix: tower moved 0.000000m under
four knockback rhinos.

**3. Poison on a structure bypassed the siege multiplier entirely.** DoT is
applied with no attacker, and the structure multiplier scales by the attacker's
role — so a Venom Snake's poison ticked a Dragon Egg at full rate instead of
x0.2. Buildings and the dragon are now immune to statuses and knockback.

**4. `Math.random()` inside the simulation.** Respawn scatter used it, which made
the sim unreproducible — breaking headless tests and quietly ruling out replays
or lockstep later. Now a seeded stream. A determinism test asserts two Worlds
with the same seed and inputs produce byte-identical state after 400 ticks.

**5. Entities could be alive at zero HP.** Death only happened inside
`applyDamage`, so any other path that lowered HP left a zombie: alive,
unkillable, still fighting. A central reaper now enforces "zero HP means dead",
making the invariant structural rather than something every call site must
remember.

**6. Flow-field cache could thrash into multiple full BFS rebuilds per tick.**
More simultaneous group destinations than cache slots meant groups evicted each
other every tick, each miss costing a ~35k-cell BFS. The cache is larger, and at
most one field is built per tick — a caller that misses falls back to
straight-line steering for one frame. A test issues ten separate group orders
and asserts the tick budget holds.

**7. `entForSide()` was called per entity per tick**, making owner lookup O(n^2).
Hoisted.

**8. `orderRecall` accepted non-animal ids** where `orderMove` filtered them.

### What the tests actually pin down

Regression coverage for every earlier bug: surface-to-surface reach (melee siege),
aura self-exclusion (lone wolf gets nothing, pack of four gets +0.45), orders
surviving respawn, structures never respawning, castles immune to armies, eggs
invulnerable *and untargeted* before 4:00, and the full dragon chain — arrival,
invulnerable descent, enrage at 60%, slain, eggs reforming at exactly 40%,
castle destruction and the post-victory freeze.

### Two test failures that were the test's fault, not the game's

Worth recording because both looked like bugs:

- Channel tests placed players next to a castle, so **towers shot the channeller**
  and progress kept resetting. That is correct behaviour — a defended egg really
  is unhatchable. Tests now use eggs clear of tower range.
- A phase-gate test was off by one: a gate fires on the tick it reaches, not the
  tick before.

### Honest limits

I cannot certify "no bugs". What I can say: 36 tests pass, a 6000-tick soak with
both dragons and every phase gate reports zero invariant violations, and both
peers run clean with no uncaught errors. Still open and listed above: untuned
balance, structures riding every snapshot, the dragon rendering at 20Hz, and
true FPS being unmeasured in this environment.

---

## M6 — Meta layer

Collection + variant rolls · Trust Ladder (keypair, counter-signing, chain, Glicko-2) · rank buckets wired into the matchmaking namespace · save format with migrations.

---

## M7 — Clips & virality

Ring-buffer `MediaRecorder` · all six auto-triggers · Save Clip toast · highlights reel in the summary screen.

---

## M8 — Seasons, quests, pass

Season date table · date-seeded daily/weekly quests · Wild Pass free track · cosmetic system with loadout exchange in `HELLO`.

---

## M9 — Content & polish

Maps 2 and 3 (Scorching Valley, Frozen Wilds) with their terrain mechanics · world events · audio · real models replacing primitives · balance pass · onboarding.

---

## Ship boundary

**M0–M5 is a complete, playable, winnable game.** Everything from M6 on is retention. If you have to stop somewhere, stop at M5 and ship it — a game with one map, 34 animals, and a great dragon fight is a real game. A game with seasons and no dragon fight is not.

---

## Standing risks

| Risk | Mitigation |
|---|---|
| Public broker flakiness | Swappable broker list; escalate to self-hosted `peerjs-server` (~10 lines, free tier) if it bites |
| Head-of-line blocking on the reliable channel | Not observed through M1 at 2 entities; recheck under M3 load. Fix is a second unreliable channel for snapshots |
| Host advantage / cheating | Randomize host assignment; client sanity-checks snapshots for impossible deltas |
| `sim/` → `render/` import creeping in | ESLint import-boundary rule on day one. This decays first and costs the most to fix late |
| Draw-call blowup with 120 units | `InstancedMesh` from M3, not as an optimization later |
| **Scope** | The pitch is 23 sections and ~250 animals. M0–M5 is roughly 15% of it, and is still months of solo work |
