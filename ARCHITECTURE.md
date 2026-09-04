# Architecture — 3D, Simulation, Netcode

---

## 1. Stack

| Layer | Choice | Note |
|---|---|---|
| Language | TypeScript, strict | |
| Build | Vite | static output, deployable to any CDN / GitHub Pages |
| Render | **Three.js** (WebGL2) | |
| Transport | **PeerJS** → WebRTC DataChannel | |
| Crypto | WebCrypto (Ed25519 / ECDSA P-256) | Trust Ladder signing |
| Assets | glTF 2.0 (`.glb`), Draco-compressed | |
| Audio | Howler.js or raw WebAudio | |
| Persistence | `localStorage` + IndexedDB (clips) | |

**No physics engine. No ECS library. No state framework.** At ~120 entities all three are pure overhead.

---

## 2. Matchmaking — fixed slot claim, no visible codes

PeerJS lets a peer **claim a specific ID**, and the broker rejects duplicates atomically. That is a distributed lock, and it gives the "same code every time" spec exactly:

```
claim "weg-v1-<bucket>-host-1"
  ├─ SUCCESS → nobody here. You are the host. Wait.      <- "0/2, create match"
  └─ TAKEN   → someone is waiting. Connect to them.      <- "1/2, auto-join"
```

`<bucket>` is the Trust Ladder rank bucket (`b` bronze … `w` wild), so rank-based matchmaking falls out of the same mechanism for free. Casual uses bucket `c`.

### Slot ladder + beacon handoff

One fixed ID means one match on Earth at a time. Fix:

- Slots `…-host-1` through `…-host-8` per bucket.
- On accept, the two peers exchange fresh random IDs, re-establish the **real** match connection on a second `Peer` object, and the host **destroys its beacon** — freeing slot 1 within ~1s.
- The ladder therefore almost never gets past slot 1, and concurrency is unbounded.

### Join sequence — order is load-bearing

```
1. CONNECT pass — probe slots 1..8, ~4s timeout each, first live waiter wins
2. JITTER       — random 0-500ms, breaks simultaneous-claim symmetry
3. CLAIM pass   — take the lowest free slot, become a waiting host
4. RE-PROBE     — while waiting, rescan slots below yours every ~5s;
                  if one now holds a waiter, drop your claim and connect
5. WIDEN        — after 30s with no match, also probe adjacent rank buckets
```

**Step 1 must precede step 3.** If every client claims first, N players squat N slots, all waiting, none matching. Step 4 is the backstop when two claim simultaneously anyway.

### Failure matrix

| Case | Handling |
|---|---|
| Third player hits a busy host | Host replies `BUSY` → client walks to next slot |
| Host tab crashed, ID still registered | 4s connect timeout → next slot; broker expires IDs ~60s |
| Both players claimed different slots | Re-probe loop resolves in ~5s |
| Broker down / rate-limited | Real error state, exponential backoff, try next broker in list |
| Nobody ever joins | Wait indefinitely, visible "searching" state, widen buckets at 30s |
| Content hash mismatch | Abort with an explicit "different game version" message |

### Optional: play with a friend

The auto-matchmaker never shows a code. A **separate** "Play with a Friend" button can claim `weg-v1-priv-<6 chars>` and display that code. It's the same mechanism, opt-in, and doesn't pollute the default flow.

---

## 3. Netcode

Host runs the authoritative sim. Client sends inputs, renders what it's told.

- **Sim tick** 20 Hz fixed (50 ms) · **Input** 30 Hz · **Snapshot** 20 Hz delta-encoded

### Messages

| Msg | Dir | Payload |
|---|---|---|
| `HELLO` | both | `{contentHash, protocolVersion, pubKey, displayName, rank}` |
| `START` | H→C | `{seed, mapId, yourSide, eventSchedule}` |
| `INPUT` | C→H | `{tick, move, cursorRay, cmds[]}` |
| `SNAP` | H→C | `{tick, baseTick, ents[], events[]}` |
| `ACK` | C→H | `{tick}` |
| `PING`/`PONG` | both | RTT |
| `RESULT` | both | signed match result (`META.md §2`) |

`contentHash` is **not optional** — both peers hash loaded JSON and abort on mismatch. In a data-driven game this is the #1 cause of "why does my client show something different."

### Entity snapshot — why 2.5D pays off

```
id      u16
type    u8
x, z    u16 each   quantized over map bounds (~3cm precision on a 200m map)
y       u16        FLYING UNITS ONLY — ground units derive y from the heightmap
yaw     u8         1.4° precision
hp      u16
state   u8         idle|move|attack|hatch|dead|ability
target  u16
```

**~10 bytes per entity.** 120 entities × 20 Hz ≈ **24 KB/s** before delta compression, well under half that after. A naive full-3D transform stream would be 3–4× that.

### Client-side

- **Own avatar only** gets prediction + reconciliation (rewind to server tick, replay unacked inputs). It is the *only* predicted entity — this keeps reconciliation tractable.
- **Everything else** interpolates between the two newest snapshots on a ~100 ms render delay buffer.
- **Events** (`egg_hatched`, `animal_died`, `dragon_egg_destroyed`, `dragon_spawned`, `ability_cast`, `variant_rolled`) ride in `SNAP.events[]` and drive **render, audio, and clip triggers only — never state.**

### Known trade-offs, stated plainly

- PeerJS `DataConnection` is **reliable + ordered**. Upside: no drops, no dedup logic. Downside: a latency spike causes head-of-line blocking, so you get a visible *stall* rather than a skip. Acceptable for v1; the later fix is a second unreliable channel carrying snapshots.
- **The host can cheat and has a small latency edge.** Unavoidable without a server. Mitigations: randomize which peer hosts, and have the client sanity-check snapshots for impossible deltas (teleports, HP gain without a heal event) and abort loudly.
- **No reconnection in v1.** Drop → 10 s grace → remaining player wins. The match result is only signed by both parties on a clean finish, so a rage-quit yields an unsigned win that the Trust Ladder scores at reduced weight.

### RNG

Host-authority means determinism isn't required, but egg placement and the world-event schedule come from a **shared xorshift32 seed** in `START`, so the client can lay out the world and pre-announce events before the first snapshot lands.

---

## 4. Simulation

Entities: `Map<id, Entity>` of plain tagged objects. Neighbor queries via a **uniform 2D grid, 8 m cells** — targeting, separation, and AoE all use it.

Systems, fixed order, every tick:

```
 1. InputSystem       apply buffered remote + local input
 2. SpawnSystem       egg spawns, scheduled world events
 3. AISystem          target acquisition — retarget every 500ms, NOT every tick
 4. MovementSystem    steering, separation, leash-to-owner, 2D obstacle avoidance
 5. CombatSystem      cooldowns, damage, projectiles, structure multipliers
 6. AbilitySystem     player + animal abilities, status effects
 7. StructureSystem   towers auto-fire, Dragon Egg HP, castle state
 8. DragonSystem      boss FSM
 9. PhaseSystem       gate timers, win check
10. SnapshotSystem    build + send
```

**Hard rule: `sim/` never imports `render/` or `three`.** The sim must run headless — that's what makes it testable and what lets the client run a hollow mirror it only interpolates into.

### Pathfinding

Flow-field over the 2D walkability grid, recomputed per detached group rather than per unit, plus local separation steering. With ≤20 units per side this is cheap and looks good. **No A\* per unit, no navmesh.**

### Dragon boss FSM

```
ARRIVING ──► ASSAULT ──(hp ≤ 60%)──► ENRAGED ──┐
                │                        │      │
                ├──(hp = 0)──────────────┴──► SLAIN       defenders survive,
                │                                          eggs respawn 40% @45s
                └──(castle hp = 0)─────────► TRIUMPHANT   attacker wins
```

---

## 5. 3D rendering

| Concern | Approach |
|---|---|
| Terrain | Heightfield mesh from a per-map heightmap PNG, chunked, frustum-culled |
| Units | **`InstancedMesh` per animal type.** 20 wolves = 1 draw call. Non-negotiable for perf |
| Placeholder art | Colored primitives + a billboarded emoji sprite over each unit. 3D from day one, zero asset cost |
| Real art | Low-poly `.glb`, shared atlas, 3 LODs on anything that appears >8 times |
| Animation | Baked vertex-texture animation for crowds; skeletal only for the player, dragon, and Legendary+ |
| Shadows | One cascaded directional shadow map. Units cast, terrain receives |
| Camera | Elevated third-person follow, orbit on RMB-drag, scroll zoom, collision-pushed off terrain |
| Ground targeting | Raycast cursor onto the terrain heightfield for right-click move orders |
| Fog | Distance fog doubles as draw-distance management and as map mood |
| Perf target | 60 fps at 1080p with 120 entities on integrated graphics |

**Every visual effect reads sim state. No effect ever writes it.**

---

## 6. Directory structure

```
/src
  /net        peer.ts  matchmaker.ts  protocol.ts  snapshot.ts  clock.ts  crypto.ts
  /sim        world.ts  entity.ts  grid.ts  flowfield.ts  rng.ts  systems/*.ts
  /content    animals.json eggs.json abilities.json maps/*.json loader.ts hash.ts
  /game       match.ts  phases.ts  winconditions.ts  events.ts
  /render     renderer.ts camera.ts terrain.ts units.ts fx.ts interpolate.ts
  /ui         hud.ts armypanel.ts eggchoice.ts abilitybar.ts lobby.ts summary.ts
  /meta       collection.ts ladder.ts seasons.ts quests.ts pass.ts clips.ts save.ts
/assets       models/  textures/  audio/  heightmaps/
```

Dependency direction: `net → game → sim`, and `render`/`ui` → `game` **read-only**. Never the reverse. Enforce it with an ESLint import boundary rule on day one — this is the constraint that decays first and is the most expensive to fix late.
