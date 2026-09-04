# Meta — Progression Without a Server

Everything here runs entirely on the two players' machines. Where that creates a trust problem, it's solved with cryptography rather than ignored.

---

## 1. Collection & variants

Local, versioned JSON. Tracks per animal: `discovered`, `timesHatched`, `variantsSeen[]`, `firstSeenAt`, `matchesWon with`.

```
🐣 COLLECTION           37 / 34 base · 6 / 170 variants

🐔 Chicken   ✓ ×48    🔥❄️
🐺 Wolf      ✓ ×31    🔥  👻
🦏 Rhino     ✓ ×7
🐉 Ancient Dragon   🔒
```

### Variants (pitch §15) — cosmetic only, rolled at hatch

| Variant | Odds | Look |
|---|---|---|
| Normal | 88% | — |
| 🔥 Fire / ❄️ Ice / 👻 Ghost | 8% total | emissive shader + particle trail |
| 🌈 Prism | 3.5% | iridescent shader |
| 👑 Royal | 0.5% | gold trim + crown mesh |

Zero stat change, by design. A Royal Chicken is still a Chicken — and that's exactly why finding one is fun to show off rather than something to complain about.

---

## 2. Ranked — the "Trust Ladder"

The hard problem: with no server, nobody can verify a match result. Here's the best honest answer.

### How it works

1. **Identity.** On first launch, generate an ECDSA P-256 keypair via WebCrypto. The private key lives in IndexedDB as a **non-extractable `CryptoKey`** — it can sign but can never be read out, even by page scripts. Your public key is your player identity.

2. **Counter-signing.** At a clean match end, both peers build the identical canonical record:

```json
{
  "matchId": "...", "mapId": "emerald_forest", "seed": 88123,
  "a": "<pubkeyA>", "b": "<pubkeyB>", "winner": "a",
  "startedAt": 0, "durationTicks": 14820,
  "prevA": "<A's chain head>", "prevB": "<B's chain head>"
}
```

Each signs it and sends the signature over. Each stores the record with **both** signatures attached.

3. **Chaining.** `head = SHA-256(canonical(record) + prevHead)`. Your ladder history is a hash chain, and each new record commits to the previous one.

4. **Rating.** Glicko-2 computed locally over your own chain. Buckets: Bronze · Silver · Gold · Platinum · Diamond · Master · Legend · Wild.

5. **Matchmaking uses it for free.** The bucket letter is part of the PeerJS slot namespace (`weg-v1-g-host-1`), so rank-based matching falls straight out of the existing mechanism.

### What this actually stops

| Attack | Stopped? |
|---|---|
| Editing your rating in `localStorage` | ✅ rating is recomputed from the chain, not stored |
| Fabricating a win | ✅ requires the loser's signature, and you can't extract their key |
| Silently deleting a loss | ⚠️ breaks your chain; your opponent holds a record proving your true head at that time |
| Rage-quitting to dodge a loss | ⚠️ an unsigned result is recorded at reduced weight rather than discarded |
| Two friends farming each other | ❌ not stopped |
| A modified client | ❌ not stopped |

### Weak gossip (optional, cheap)

During `HELLO`, peers can exchange a handful of recently-observed `(pubkey, head, timestamp)` triples. Over many matches this forms a loose web of attestation, and a truncated chain eventually contradicts hearsay someone else is carrying. It's a genuine improvement, not a guarantee — treat it as a bonus, and don't build anything load-bearing on it.

**Be upfront in the UI: this is a good-faith ladder, not an esports ladder.** Given "no server," it's the strongest thing available, and it is meaningfully better than a number in a text file.

---

## 3. Seasons — a date table, not a service

`content/seasons.json` ships in the bundle:

```json
{ "id": 1, "name": "Ancient Jungle", "startsAt": "2026-10-01", "endsAt": "2026-11-19",
  "unlocks": { "animals": ["basilisk"], "maps": ["emerald_forest"], "eggTier": "ancient" },
  "pass": [ /* 30 reward levels */ ] }
```

The client compares `Date.now()` against the table. **Rotating a season is a redeploy, not a server call** — and since both peers verify `contentHash` at connect, mismatched seasons simply can't play each other, which is exactly the behavior you want.

**Soft rank reset** at each boundary: `newRating = 0.6 × rating + 0.4 × 1200`. Your chain is preserved and annotated with a season marker; only the displayed rating resets.

---

## 4. Quests — date-seeded, globally identical, zero coordination

```
dailySeed  = hash("2026-09-04")
weeklySeed = hash("2026-W36")
```

Every player worldwide draws the same 3 dailies and 1 weekly from the pool, with no server telling them to. Progress is local.

| Quest | Goal |
|---|---|
| 🥚 Egg Hunter | hatch 5 Rare-or-better eggs |
| 🐺 Wolf Pack | win a match fielding 3+ Wolves |
| 🐉 Dragon Slayer | help kill an enemy dragon |
| 🏰 Castle Defender | finish a match with all 3 Dragon Eggs alive |
| ⚔️ Revenge | kill an animal owned by the player who killed yours |
| 🗺️ Wanderer | hatch an egg in the contested zone 3 times |
| 🎲 Gambler | win with a 10-slot army containing no duplicates |

Quest completion is the main source of Wild Pass XP.

---

## 5. Wild Pass — free track only

30 levels per season, XP from matches (win 100, loss 40) and quests (50–200). Rewards are **cosmetics only, all earnable**:

```
L1  🥚 Speckled Egg Skin     L10 🏰 Volcano Castle       L20 ✨ Meteor Victory FX
L3  🕺 Taunt Emote           L14 🐺 Cyber Wolf Skin      L25 👑 Royal Egg Skin
L7  🔥 Dragon Spawn FX       L18 🕺 Flex Emote           L30 🐉 Legendary Dragon Skin
```

### Cosmetics work in multiplayer, and here's why

Your equipped loadout is sent in `HELLO`. Since **every cosmetic asset ships in the content bundle**, your opponent's client already has the mesh and can render your Cyber Wolf immediately. No CDN, no server, no download. Cosmetics are trivially unlockable by a cheater — which is fine, because they carry no competitive weight at all.

Categories, per pitch §20: 🥚 egg skins · 🦆 animal skins · 🏰 castle skins · ✨ spawn/victory/death FX · 🕺 emotes.

**No real-money purchases exist.** There is no payment processor and no entitlement store to hold them. Everything the paid tiers would have sold is simply earnable instead — the content survives, only the paywall dies.

---

## 6. Clip capture — designing for virality (pitch §23)

The one piece of §23 that's actually buildable, and it needs no server at all.

- `canvas.captureStream(60)` → `MediaRecorder` writing 1-second chunks into a **30-second ring buffer** in memory.
- On a clip-worthy moment, keep the buffer, record 5 more seconds, mux to `.webm`, and offer **Save Clip** (plus store it in IndexedDB for a local Highlights reel).

**Auto-triggers** — the game notices the moment for you:

| Trigger | The clip it makes |
|---|---|
| Dragon slain below 15% castle HP | "1 HP CLUTCH" |
| Ancient or Mythic egg hatched | "I FOUND THE ONLY ANCIENT EGG" |
| Egg stolen — you hatch one an enemy had ≥70% channeled | "HE STOLE MY LEGENDARY" |
| 8+ units per side alive within 20 m | "10 ANIMALS VS 10 ANIMALS" |
| Third Dragon Egg destroyed | "🚨 DRAGON AWAKENING" |
| Match won with ≤10% castle HP remaining | comeback |

A short "📎 Clip saved" toast fires live. Clips are also what let you build a highlights screen in the post-match summary, which is where players actually decide to share.

---

## 7. Save format

`localStorage["weg.save.v2"]` — versioned, with a migration function per version. Clips and the ladder chain live in **IndexedDB** (larger, structured).

```json
{
  "version": 2,
  "identity": { "pubKey": "..." },
  "collection": { "wolf": { "hatched": 31, "variants": ["fire","ghost"] } },
  "ladder": { "chainHead": "...", "records": "<indexeddb>" },
  "season": { "id": 1, "passXp": 4210, "claimed": [1,3,7] },
  "quests": { "dailyDate": "2026-09-04", "progress": {} },
  "cosmetics": { "owned": [], "equipped": {} },
  "settings": {}
}
```

**Store nothing derived.** Rating, pass level, and collection counts are all recomputed on load. That keeps the save honest, keeps migrations trivial, and means a future backend can ingest this file as-is.
