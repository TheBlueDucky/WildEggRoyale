# 🥚 Wild Egg Royale — Master Design

**Status:** pre-code planning. Nothing implemented yet.
**Target:** 1v1, 8–15 min matches, **3D browser game**, peer-to-peer, no server we own.

| Doc | Covers |
|---|---|
| `DESIGN.md` | this file — decisions, pillars, match flow, the no-server strategy |
| `ARCHITECTURE.md` | 3D rendering, simulation, netcode, matchmaking |
| `CONTENT.md` | animals, eggs, abilities, maps, events + JSON schemas |
| `META.md` | collection, Trust Ladder ranked, seasons, quests, cosmetics, clips |
| `ROADMAP.md` | milestones and build order |

---

## 1. Decisions locked

| Area | Decision |
|---|---|
| Stack | **TypeScript + Three.js** (WebGL2), Vite |
| Dimension | **3D rendering, 2.5D simulation** (see §3 — this is the single most important call in the project) |
| Netcode | Host-authoritative snapshots, 20 Hz |
| Signaling | PeerJS broker, fixed-slot claim (no visible codes) |
| Players | 1v1 only |
| Persistence | Local-only, cryptographically counter-signed where it matters |

### Decided by default — override any of these

| Area | Default |
|---|---|
| Army control | **Leash + detach** — army swarms you; select a group, right-click ground/target to detach it there until recalled |
| Avatar risk | Player has HP, dies, respawns at own castle after 10s. No loot drop; in-progress hatch is lost |
| Egg pickup | **Hatch channel** — 2s (Common) → 10s (Ancient), interrupted by damage or leaving the ring |
| Pacing | **Timed phase gates** — see §5 |
| Camera | Elevated third-person follow, mouse-look orbit, scroll zoom |

### One honest flag on the stack

3D raises the cost of the web/Three.js choice more than 2D did: no scene editor, no built-in navmesh, no physics, manual glTF pipeline. Godot 4 would hand you all of that. You confirmed web, so this plan is built for Three.js — but know that you're paying for the browser's native WebRTC with tooling you'll write yourself. The architecture below is deliberately shaped to minimize that bill (§3).

---

## 2. Pillars

Everything in this plan serves one of four:

1. **Discovery is gameplay** — you *find* eggs by moving through a world, not by opening menus.
2. **The 10-slot limit forces real choices** — finding a Mythic is only exciting because something has to go.
3. **The dragon is an event, not a win button** — a 5-phase boss both players fight over.
4. **Every match should produce a clip** — designed for, not hoped for (§META clip system).

---

## 3. The key architectural call: 3D render, 2.5D sim

**The simulation runs on a 2D plane. Only the renderer is 3D.**

- Units store `x, z` and sample terrain height `y = heightmap(x, z)` for display.
- Only **flying** units carry a real independent `y`.
- Pathfinding, targeting, separation, and range checks are all 2D distance on `x/z`.
- Collision is 2D circles. No physics engine. No 3D navmesh.

This buys you, in one decision:

- Snapshots stay tiny (~10 bytes/entity) because `y` is derived, not sent.
- Unit AI and steering are the same code they'd be in a 2D game.
- No navmesh baking, no rigid body solver, no 3D pathfinding.
- Terrain can still have hills, cliffs, and visual drama — it's just a heightfield plus a 2D walkability grid.

The vertical axis is used deliberately and only where it earns its keep: **flying units** (Hawk, Bee, Phoenix, Thunderbird), **the dragon boss** arriving from the sky, **castle walls and towers**, and **terrain occlusion** for hiding.

---

## 4. The match

```
             ⛰️  CONTESTED RIDGE  ⛰️
        🥚Ancient      ☄️        🥚Mythic

   🌲 WILDERNESS 🌲          🌲 WILDERNESS 🌲
      🥚 🥚 🐺 🥚               🥚 🐺 🥚 🥚

  🏰 CASTLE A                      CASTLE B 🏰
   🥚🥚🥚 towers                  towers 🥚🥚🥚
```

**Each player starts with:** 2 Chickens, a castle, 3 Dragon Eggs, 10 army slots, a basic attack, and 2 equipped abilities.

**Win condition (single path, deliberately):**

```
destroy all 3 enemy Dragon Eggs
        ↓
YOUR DRAGON AWAKENS and flies at their castle
        ↓
they must kill it   ─────► dragon SLAIN → their eggs respawn at 40% HP after 45s
        │                                  you keep your army, try again
        └── they fail ──► CASTLE DESTROYED → you win
```

The castle itself is **invulnerable to everything except a dragon.** That's what makes the dragon matter, and it removes the degenerate "just hit the building with 10 wolves" line.

## 5. Phase gates

| Time | Event |
|---|---|
| 0:00 | Explore. Dragon Eggs invulnerable. Contested zone rolls Common/Uncommon only |
| 4:00 | **⚔️ SIEGE OPEN** — Dragon Eggs become damageable; contested zone unlocks Epic+ tables |
| 7:00 | First scheduled world event fires (Golden Egg / Egg Rain / Dark Hour) |
| 10:00 | **🏹 TOWERS CRUMBLE** — castle towers drop to 50% HP and lose 30% damage |
| 15:00 | **🔥 WILDFIRE** — all Dragon Eggs lose 5% max HP per second. Forces a resolution |

Guarantees the 8–15 minute target, kills both the 60-second cheese rush and the 40-minute turtle stalemate.

---

## 6. The no-server strategy

This is where the design has to be honest. Three tiers:

### ✅ Works fully P2P

| Feature | How |
|---|---|
| Matchmaking | PeerJS fixed-slot ID claim — no visible codes (`ARCHITECTURE.md §2`) |
| The entire match | Host-authoritative sim over WebRTC DataChannel |
| Collection, variants | `localStorage`, versioned JSON |
| **Seasons** | A **date table shipped in the content bundle**. Season 3 starts 2026-11-14 because the JSON says so. Rotating a season is a redeploy, not a server call |
| **Quests** | Daily/weekly rolled from a **date-seeded PRNG**. Every player worldwide gets identical dailies with zero coordination |
| **Wild Pass** | Free track only, driven by local XP. Every cosmetic it would have sold is earnable instead |
| **Clip capture** | `MediaRecorder` 30s ring buffer, saved to the player's disk |

### ⚠️ Works, with a caveat you should accept knowingly

**Ranked → the "Trust Ladder"** (`META.md §2`). Both clients hold WebCrypto keypairs, both **counter-sign** the match result, and each player's record chain hashes to the previous entry. You cannot fabricate a win (you'd need the loser's signature) and you cannot silently delete a loss (it breaks your chain, and your opponent holds a copy proving the true head).

What it does **not** stop: two players colluding to farm each other, and a determined attacker who reverse-engineers the client. **This is a good-faith ladder, not an esports ladder.** Given the constraint, it's the best available, and it's genuinely better than a plain local number.

### ❌ Genuinely impossible — cut

| Feature | Why |
|---|---|
| Real-money purchases, Wild Gems, premium pass | No accounts, no payment processor, no entitlement store |
| Global leaderboards | No shared state anywhere |
| Cross-device save sync | Nowhere to sync to |
| Server-side anti-cheat | Nothing authoritative exists |
| Live balance patches | Balance ships in the bundle; changing it is a redeploy |

**Cutting monetization is a net win here.** Every cosmetic §20–22 would have sold — egg skins, animal skins, castle skins, effects, emotes — becomes an earnable reward instead. The content survives; only the paywall dies.

### The one caveat on "no server"

WebRTC always needs a third party to introduce two peers. **"No server" means none you run or pay for**, not zero servers in existence. The PeerJS public broker is free, rate-limited, and occasionally down — so the broker list is swappable config from day one.

---

## 7. The loop

```
   MATCH ──► explore ──► hatch eggs ──► agonize over 10 slots ──► fight
     ▲                                                              │
     │                                                              ▼
  new strategy ◄── unlock cosmetic ◄── Wild Pass XP ◄── destroy dragon eggs
     ▲                                                              │
     └──────── collection grows ◄── variants roll ◄── DRAGON ◄──────┘
```

No completion requirement, ever. The animal roster is data (`CONTENT.md`), so it grows forever without touching sim code.
