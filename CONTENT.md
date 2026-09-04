# Content — Animals, Eggs, Abilities, Maps, Events

All of this is **JSON validated at load**. Adding an animal must never require touching sim code. Numbers below are a first pass designed to be internally consistent — they will need balancing, but they're a real starting point, not placeholders.

---

## 1. Combat math

World units are **meters**. Map is ~220 × 160 m.

| Constant | Value |
|---|---|
| Player HP / respawn | 300 / 10 s at own castle |
| Dragon Egg HP | 2000 each (invulnerable until 4:00) |
| Tower HP / DPS / range | 1200 / 45 / 18 m |
| Castle HP | 8000 — **damageable only by a dragon** |
| Boss dragon HP | 6000, enrages at 60% |
| Army slots | 10, every animal costs 1 |

`DPS = damage × attackSpeed`

### Structure damage multiplier — this is what makes roles matter

| Role | vs structures |
|---|---|
| 🏰 Siege | **×2.0** |
| 🛡️ Tank | ×0.5 |
| 🗡️ DPS / 🏹 Ranged | ×0.3 |
| ⚡ Assassin / 🧙 Controller | ×0.2 |
| ❤️ Support | ×0.1 |

Ten Wolves = 252 DPS, but only **76 DPS against a Dragon Egg** → ~26 s per egg under tower fire. A siege comp does it in a third of the time. Composition is a real decision, exactly as §3–4 of the pitch intended.

---

## 2. Animal roster — 34 at launch

`HP / DMG / atk-speed / range m / move m·s⁻¹`

### 🥚 Common
| Animal | Role | Stats | Note |
|---|---|---|---|
| 🐔 Chicken | DPS | 70 / 10 / 1.6 / 1.5 / 5.0 | cheap swarm filler |
| 🐀 Rat | Assassin | 60 / 8 / 2.0 / 1.5 / 6.5 | fast, fragile |
| 🐗 Boar | Tank | 160 / 14 / 1.0 / 1.8 / 4.5 | early bruiser |
| 🐸 Frog | Ranged | 90 / 12 / 1.2 / 5.0 / 4.0 | hop attack |
| 🐑 Sheep | Tank | 200 / 6 / 0.8 / 1.5 / 3.5 | pure body-block |

### 🟢 Uncommon
| Animal | Role | Stats | Ability |
|---|---|---|---|
| 🐺 Wolf | DPS | 140 / 18 / 1.4 / 1.8 / 7.0 | +15% dmg per nearby Wolf (max 4) |
| 🦅 Hawk | Ranged 🪽 | 110 / 16 / 1.3 / 9.0 / 8.0 | flying |
| 🐢 Turtle | Tank | 700 / 9 / 0.6 / 1.5 / 2.2 | −40% dmg while stationary |
| 🐝 Bee | DPS 🪽 | 55 / 7 / 2.4 / 1.5 / 9.0 | flying, poison stacks |
| 🦫 Beaver | **Siege** | 220 / 20 / 0.9 / 1.8 / 4.0 | ×2.0 structures |
| 🦊 Fox | Assassin | 120 / 22 / 1.2 / 1.8 / 7.5 | always targets lowest-HP enemy |

### 🔵 Rare
| Animal | Role | Stats | Ability |
|---|---|---|---|
| 🦏 Rhino | Tank | 520 / 40 / 0.7 / 2.0 / 5.0 | charge → knockback 6 m |
| 🐍 Venom Snake | Controller | 130 / 9 / 1.5 / 2.5 / 4.5 | poison 8 dps for 5 s |
| 🦉 Owl Mage | Support | 100 / 12 / 1.0 / 10 / 5.0 | aura +20% ally dmg, 8 m |
| 🐻 Bear | Tank | 600 / 45 / 0.8 / 2.0 / 4.2 | |
| 🦌 Stag | DPS | 300 / 26 / 1.1 / 1.8 / 8.0 | fast flanker |
| 🦀 Crab | Tank | 450 / 18 / 1.0 / 1.5 / 2.5 | −30% ranged damage taken |
| 🦇 Bat | DPS 🪽 | 90 / 11 / 1.8 / 1.5 / 8.5 | flying, 30% lifesteal |

### 🟣 Epic
| Animal | Role | Stats | Ability |
|---|---|---|---|
| 👻 Ghost Fox | Assassin | 200 / 34 / 1.3 / 1.8 / 8.0 | invisible 4 s every 15 s |
| 🐘 Elephant | Tank | 1100 / 55 / 0.6 / 2.5 / 3.2 | knockback aura |
| 🦂 Scorpion | Controller | 260 / 20 / 1.4 / 2.0 / 5.5 | stun 0.8 s every 5th hit |
| 🪶 Peregrine | Ranged 🪽 | 150 / 60 / 0.5 / 16 / 7.0 | flying sniper |
| 🦡 Badger | DPS | 380 / 30 / 1.2 / 1.8 / 5.0 | burrow: immune 2 s |
| 🐙 Octopus | Controller | 340 / 16 / 1.6 / 7.0 / 3.0 | slows target 35% |

### 🟡 Legendary
| Animal | Role | Stats | Ability |
|---|---|---|---|
| 🦁 Lion | DPS | 900 / 70 / 1.0 / 2.2 / 6.5 | roar: fear nearby 1.5 s |
| 🦅🦁 Griffin | DPS 🪽 | 700 / 55 / 1.1 / 3.0 / 8.5 | flying bruiser |
| 🗿 Golem | **Siege** | 1800 / 50 / 0.5 / 2.5 / 2.5 | ×2.0 structures, knockback-immune |
| 🔥🐦 Phoenix | Support 🪽 | 500 / 45 / 1.2 / 6.0 / 8.0 | revives once at 40% HP |
| 🦑 Kraken Spawn | Controller | 800 / 38 / 1.0 / 9.0 / 3.0 | tentacle pull |

### 🔴 Mythic
| Animal | Role | Stats | Ability |
|---|---|---|---|
| 🐕‍🦺 Cerberus | DPS | 1500 / 85 / 1.1 / 2.5 / 6.0 | strikes 3 targets |
| ⚡🦅 Thunderbird | Ranged 🪽 | 1000 / 70 / 0.9 / 12 / 8.0 | chain lightning, 3 jumps |
| 🐍 Basilisk | Controller | 1200 / 60 / 1.0 / 5.0 / 5.0 | petrify 1.5 s every 6th hit |

### 🌈 Ancient
| Animal | Role | Stats | Ability |
|---|---|---|---|
| 🐉 Ancient Dragon | DPS 🪽 | 2500 / 120 / 1.0 / 8.0 / 7.0 | flying AoE breath *(not the boss dragon)* |
| 🌍🐢 World Turtle | Support | 4000 / 40 / 0.6 / 2.0 / 1.8 | allies within 10 m take −25% dmg |

**Rarity ≠ power, per the pitch.** Turtle (Uncommon) out-tanks Stag (Rare). Beaver (Uncommon) out-sieges everything below Golem. Peregrine (Epic) has 150 HP and dies to a stiff breeze.

---

## 3. Egg tiers

| Tier | Hatch | Glow | Typical spawn |
|---|---|---|---|
| 🥚 Common | 2.0 s | none | Safe + Wilderness |
| 🟢 Uncommon | 3.0 s | faint green | Wilderness |
| 🔵 Rare | 4.0 s | blue pulse | Wilderness + Contested |
| 🟣 Epic | 5.5 s | purple beam | Contested (after 4:00) |
| 🟡 Legendary | 7.0 s | gold pillar, visible map-wide | Contested / events |
| 🔴 Mythic | 8.5 s | red pillar + audio sting for both players | events only |
| 🌈 Ancient | 10.0 s | rainbow pillar, **announced to both players** | one per match, maybe |

**Hatching is a channel**: stand in the ring, take damage or leave → progress resets. Higher tiers glow brighter and are visible further, so the best eggs advertise themselves. That's the point — it manufactures the fight.

---

## 4. Player abilities — equip 2

| Ability | Effect | CD |
|---|---|---|
| 🥚 Egg Radar | reveal all eggs within 60 m for 8 s | 30 s |
| 🏃 Wild Dash | dash 12 m | 8 s |
| ❤️ Rally | nearby allies +30% dmg, +20% speed, 6 s | 40 s |
| ⚡ Lightning | 120 dmg in a 6 m radius | 25 s |
| 🛡️ Shield | absorb 400 dmg across nearby allies, 5 s | 45 s |
| 🌀 Recall | 3 s channel → teleport to own castle | 60 s |
| 📣 Whistle | instantly recall every detached group | 20 s |
| ⏩ Hatch Rush | next hatch is 70% faster | 45 s |

---

## 5. Maps — 3 at launch

| Map | Terrain | Mechanic |
|---|---|---|
| 🌳 **Emerald Forest** | rolling hills, dense tree cover | Baseline. Foliage blocks line of sight — the teaching map |
| 🏜️ **Scorching Valley** | open mesa, deep canyons | No cover; long sightlines favor ranged and flying. Canyons are hard walls that funnel armies |
| ❄️ **Frozen Wilds** | ice sheets, snowdrifts | Ice patches: +40% move speed, no turning grip. Drifts: −50% speed. Terrain *is* the strategy |

Later, purely as content: 🌋 Volcano · 🌊 Flooded Ruins · 🌙 Haunted Forest · 🏝️ Lost Island · ☁️ Skylands.

### Zones — three concentric bands

```
🏰 CASTLE (safe)  →  🌲 WILDERNESS  →  ☠️ CONTESTED  ←  🌲  ←  🏰
   Common only        Common–Rare      Rare–Ancient
   towers cover       the bulk of      one shared strip,
                      exploration      both players want it
```

---

## 6. World events

Rolled from the shared seed, so **both clients know the schedule up front** and can pre-announce with a countdown — no server, perfectly synced drama.

| Event | Effect |
|---|---|
| 🌟 **Golden Egg** | one Legendary egg spawns dead center, gold pillar, both players see it. A pure race |
| 🥚 **Egg Rain** | 20 Common/Uncommon eggs scatter across the wilderness over 10 s |
| 🌑 **Dark Hour** | 45 s of night. Sight range halved; every egg re-rolls one tier up |
| ☄️ **Meteor Egg** | a Mythic egg crashes in with a visible 8 s sky trail and an AoE impact |
| 🐲 **Ancient Egg** | rarest event. One Ancient egg, 10 s hatch, announced map-wide. This is the "BRO I FOUND IT" moment |

One fires at 7:00; a second may fire at 11:00 in longer matches.

---

## 7. Schemas

**Animal**
```json
{
  "id": "wolf", "name": "Wolf", "glyph": "🐺", "model": "wolf.glb",
  "rarity": "uncommon", "role": "dps", "tags": ["ground", "beast", "pack"],
  "hp": 140, "damage": 18, "attackSpeed": 1.4, "range": 1.8, "moveSpeed": 7.0,
  "targetType": ["ground", "air"], "flying": false,
  "ability": "pack_bond", "eggTables": ["forest", "wild"]
}
```

**Ability** — one format for player and animal alike
```json
{
  "id": "poison_bite", "trigger": "onHit", "cooldown": 0,
  "effects": [{ "type": "status", "status": "poison", "duration": 5, "dps": 8 }]
}
```

Triggers: `onHit · onHurt · onDeath · onSpawn · active · aura · periodic`
Effects: `damage · heal · status(poison|slow|stun|fear|buff|invisible|petrify) · knockback · pull · dash · reveal · shield · revive · summon · chain`

**The effect executor is one switch statement in one file.** A small interpreter, not a scripting language. Resist the urge — this is where data-driven designs go to die.

**Map**
```json
{
  "id": "emerald_forest", "size": [220, 160],
  "heightmap": "heightmaps/emerald.png", "maxHeight": 24,
  "castles": [{ "side": 0, "x": 20, "z": 80 }, { "side": 1, "x": 200, "z": 80 }],
  "zones": [{ "kind": "safe|wild|contested", "poly": [[0,0]] }],
  "obstacles": [{ "x": 40, "z": 60, "r": 2.5, "model": "tree_a.glb" }],
  "eggSpawns": [
    { "zone": "wild", "count": 8, "table": "common" },
    { "zone": "contested", "count": 3, "table": "rare", "unlockAt": 240 }
  ],
  "modifiers": { "iceGrip": 0.4 }
}
```

`eggSpawns` gives you procedural placement with an **authored distribution** — every match differs, but never unfairly. Spawn points are jittered within their zone polygon from the shared seed, and mirrored across the map's axis of symmetry so neither side gets a better roll.
