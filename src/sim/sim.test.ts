import { describe, expect, it } from 'vitest';
import { EMERALD_FOREST, type Side } from '../content/maps';
import { ANIMAL_INDEX } from '../content/animals';
import { EGG_TIERS } from '../content/eggs';
import { TICK_HZ } from '../net/protocol';
import { EntKind, EntState, World, type Ent } from './world';
import { StructKind, SIEGE_OPENS_TICK, TOWERS_CRUMBLE_TICK, WILDFIRE_TICK } from './structures';
import { DragonPhase, dragonIdFor } from './dragon';
import { EggState } from './eggs';
import { encodeSnapshot, decodeSnapshot, QUANT_ERROR_M } from '../net/snapshot';

/**
 * Headless simulation tests.
 *
 * These exist because sim/ never imports three or touches the DOM — the rule
 * that felt pedantic in M0 is what makes the entire game logic testable in Node
 * without a browser, a canvas or a peer connection.
 */

const A = ANIMAL_INDEX;

function world(seed = 12345): World {
  return new World(EMERALD_FOREST, seed);
}

/** Run n ticks. */
function run(w: World, n: number) {
  for (let i = 0; i < n; i++) w.step();
}

/** Put a side's army on the field and place it at a spot. */
function fieldArmy(w: World, side: Side, ids: string[], x: number, z: number) {
  w.armies[side] = ids.map((id) => A[id]!);
  w.syncArmyUnits();
  w.unitsOf(side).forEach((u, i) => {
    u.x = x + (i % 4) * 0.9;
    u.z = z + Math.floor(i / 4) * 0.9;
    u.hp = u.maxHp;
    u.state = EntState.Alive;
  });
}

function park(w: World, side: Side, x: number, z: number) {
  const p = w.entForSide(side)!;
  p.x = x;
  p.z = z;
}

function eggsOf(w: World, side: Side) {
  return w.dragonEggsOf(side);
}

function openSiege(w: World) {
  w.tick = SIEGE_OPENS_TICK + 10;
}

/**
 * An unlocked egg well clear of both castles.
 *
 * Channelling tests must not sit inside tower range: a defended egg genuinely
 * cannot be hatched, which is correct game behaviour but ruins a test that is
 * trying to measure something else.
 */
function neutralEgg(w: World, notCommon = true) {
  return w.eggs.find((e) =>
    e.unlockAtTick === 0
    && (!notCommon || e.tier !== 'common')
    && Math.abs(e.x) < 55)!;
}

// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('generates an identical egg layout from the same seed', () => {
    const a = world(999);
    const b = world(999);
    expect(a.eggs.length).toBe(b.eggs.length);
    expect(a.eggs.map((e) => `${e.id}:${e.tier}:${e.x}:${e.z}`))
      .toEqual(b.eggs.map((e) => `${e.id}:${e.tier}:${e.x}:${e.z}`));
  });

  it('generates a different layout from a different seed', () => {
    const a = world(1);
    const b = world(2);
    expect(a.eggs.map((e) => e.x)).not.toEqual(b.eggs.map((e) => e.x));
  });

  it('mirrors eggs through the origin so neither side gets a better map', () => {
    const w = world(777);
    for (let i = 0; i < w.eggs.length; i += 2) {
      const a = w.eggs[i]!;
      const b = w.eggs[i + 1]!;
      expect(b.x).toBeCloseTo(-a.x, 9);
      expect(b.z).toBeCloseTo(-a.z, 9);
      expect(b.tier).toBe(a.tier);
    }
  });

  it('produces identical state from identical inputs (no Math.random in the sim)', () => {
    const a = world(4242);
    const b = world(4242);
    for (const w of [a, b]) {
      fieldArmy(w, 0, ['wolf', 'wolf', 'bear'], -20, 0);
      fieldArmy(w, 1, ['stag', 'crab', 'boar'], 20, 0);
      w.orderMove(0, 0, 0);
      w.orderMove(1, 0, 0);
    }
    run(a, 400);
    run(b, 400);
    const dump = (w: World) => [...w.ents.values()]
      .map((e) => `${e.id}:${e.x.toFixed(6)}:${e.z.toFixed(6)}:${e.hp.toFixed(4)}:${e.state}`)
      .sort()
      .join('|');
    expect(dump(a)).toBe(dump(b));
  });
});

describe('terrain and pathing', () => {
  it('keeps the castles connected with a sane detour ratio', () => {
    const w = world();
    expect(w.terrain.castlesConnected()).toBe(true);
    expect(w.terrain.connectedFraction()).toBeCloseTo(1, 2);
    expect(w.terrain.detourRatio()).toBeLessThan(1.35);
  });

  it('never lets a ground unit stand inside rock', () => {
    const w = world(31337);
    fieldArmy(w, 0, ['wolf', 'wolf', 'wolf', 'wolf'], -60, 0);
    w.orderMove(0, 62, 0);
    for (let i = 0; i < 1200; i++) {
      w.step();
      for (const u of w.unitsOf(0)) {
        if (u.state !== EntState.Alive || u.flying) continue;
        expect(w.terrain.walkable(u.x, u.z)).toBe(true);
      }
    }
  });

  it('routes units around terrain to a destination behind a ridge', () => {
    const w = world();
    fieldArmy(w, 0, ['wolf', 'wolf', 'wolf'], -60, 0);
    park(w, 1, 105, 75);
    w.orderMove(0, 62, 0);
    run(w, 900);
    for (const u of w.unitsOf(0)) {
      expect(Math.hypot(u.x - 62, u.z - 0)).toBeLessThan(6);
    }
  });
});

describe('eggs and hatching', () => {
  it('cannot hatch a contested egg before the siege window', () => {
    const w = world();
    const locked = w.eggs.find((e) => e.unlockAtTick > 0)!;
    park(w, 0, locked.x + 0.4, locked.z);
    park(w, 1, 105, 75);
    run(w, 200);
    expect(locked.progress).toBe(0);
    expect(locked.state).toBe(EggState.Available);
  });

  it('hatches an egg and grows the army', () => {
    const w = world();
    const egg = w.eggs.find((e) => e.unlockAtTick === 0 && e.tier === 'common')!;
    park(w, 0, egg.x + 0.3, egg.z);
    park(w, 1, 105, 75);
    run(w, Math.ceil(EGG_TIERS.common.hatchSeconds * TICK_HZ) + 5);
    expect(egg.state).toBe(EggState.Consumed);
    expect(w.armies[0].length).toBe(1);
    expect(w.unitsOf(0).length).toBe(1);
  });

  it('resets progress when the channeller walks away', () => {
    const w = world();
    const egg = neutralEgg(w);
    park(w, 0, egg.x + 0.3, egg.z);
    park(w, 1, 105, 75);
    run(w, 10);
    expect(egg.progress).toBeGreaterThan(0);
    park(w, 0, egg.x + 40, egg.z);
    run(w, 2);
    expect(egg.progress).toBe(0);
  });

  it('lets a rival steal a nearly-complete channel', () => {
    const w = world();
    const egg = neutralEgg(w);
    park(w, 0, egg.x + 1.9, egg.z);
    park(w, 1, 105, 75);
    while (egg.progress < 0.6) w.step();
    const stolenFrom = egg.progress;
    park(w, 1, egg.x + 0.2, egg.z);
    w.step();
    expect(egg.channeler).toBe(1);
    expect(egg.progress).toBeGreaterThan(stolenFrom); // progress carried over
    while (egg.state === EggState.Available) w.step();
    expect(w.armies[1].length).toBe(1);
    expect(w.armies[0].length).toBe(0);
  });

  it('interrupts a channel when the CHANNELLER is hit, not when a unit is', () => {
    const w = world();
    const egg = neutralEgg(w);
    park(w, 0, egg.x + 0.3, egg.z);
    park(w, 1, 105, 75);
    run(w, 8);
    expect(egg.progress).toBeGreaterThan(0);

    // A friendly ANIMAL taking damage must not cancel the hatch.
    fieldArmy(w, 0, ['wolf'], egg.x + 30, egg.z);
    const wolf = w.unitsOf(0)[0]!;
    const held = egg.progress;
    wolf.hp -= 50;
    w.step();
    expect(egg.progress).toBeGreaterThan(held);

    // The player being hit must. Progress restarts the very next tick because
    // the player is still standing on the egg, so assert it is being held down
    // rather than expecting an exact zero.
    const peak = egg.progress;
    fieldArmy(w, 1, ['wolf', 'wolf'], egg.x + 1.2, egg.z);
    run(w, 60);
    expect(egg.progress).toBeLessThan(peak * 0.5);
    expect(egg.progress).toBeLessThan(0.2);
  });

  it('raises a timed offer instead of overflowing a full army', () => {
    const w = world();
    w.armies[0] = new Array(10).fill(A['chicken']!);
    w.syncArmyUnits();
    const egg = w.eggs.find((e) => e.unlockAtTick === 0)!;
    park(w, 0, egg.x + 0.3, egg.z);
    park(w, 1, 105, 75);
    while (egg.state === EggState.Available) w.step();
    expect(w.offers[0]).not.toBeNull();
    expect(w.armies[0].length).toBe(10);

    const incoming = w.offers[0]!.animal;
    expect(w.replaceSlot(0, 3)).toBe(true);
    expect(w.armies[0][3]).toBe(incoming);
    expect(w.offers[0]).toBeNull();
  });

  it('expires an unclaimed offer and rejects bad slot indices', () => {
    const w = world();
    w.armies[0] = new Array(10).fill(A['chicken']!);
    w.syncArmyUnits();
    const egg = w.eggs.find((e) => e.unlockAtTick === 0)!;
    park(w, 0, egg.x + 0.3, egg.z);
    park(w, 1, 105, 75);
    while (egg.state === EggState.Available) w.step();

    expect(w.replaceSlot(0, -1)).toBe(false);
    expect(w.replaceSlot(0, 99)).toBe(false);
    expect(w.replaceSlot(0, 1.5)).toBe(false);
    expect(w.offers[0]).not.toBeNull();

    run(w, 16 * TICK_HZ);
    expect(w.offers[0]).toBeNull();
  });
});

describe('combat', () => {
  it('lets melee units damage a large structure (surface-to-surface reach)', () => {
    const w = world();
    openSiege(w);
    const egg = eggsOf(w, 1)[1]!;
    fieldArmy(w, 0, new Array(6).fill('wolf'), egg.x - 2, egg.z - 1);
    park(w, 1, -105, -75);
    for (const t of [...w.ents.values()]) {
      if (t.kind === EntKind.Structure && t.struct === StructKind.Tower) t.state = EntState.Dead;
    }
    const before = egg.hp;
    run(w, 100);
    expect(egg.hp).toBeLessThan(before - 100);
  });

  it('applies the structure damage multiplier by role', () => {
    const measure = (animal: string) => {
      const w = world();
      openSiege(w);
      for (const t of [...w.ents.values()]) {
        if (t.kind === EntKind.Structure && t.struct === StructKind.Tower) t.state = EntState.Dead;
      }
      const egg = eggsOf(w, 1)[1]!;
      fieldArmy(w, 0, new Array(8).fill(animal), egg.x - 2, egg.z - 1);
      park(w, 1, -105, -75);
      run(w, 40); // close and engage
      const start = eggsOf(w, 1).reduce((s, e) => s + Math.max(0, e.hp), 0);
      run(w, 100);
      const end = eggsOf(w, 1).reduce((s, e) => s + Math.max(0, e.hp), 0);
      return (start - end) / (100 / TICK_HZ);
    };
    const siege = measure('beaver');
    const support = measure('owl_mage');
    // Siege is x2.0, support x0.1 — a 20x spread before stats.
    expect(siege).toBeGreaterThan(support * 4);
  });

  it('never damages a castle with an army', () => {
    const w = world();
    openSiege(w);
    const keep = w.castleEntity(1)!;
    fieldArmy(w, 0, new Array(10).fill('golem'), keep.x - 3, keep.z);
    park(w, 1, -105, -75);
    run(w, 300);
    expect(keep.hp).toBe(keep.maxHp);
    expect(keep.state).toBe(EntState.Alive);
  });

  it('keeps Dragon Eggs invulnerable and untargeted before the siege window', () => {
    const w = world();
    const egg = eggsOf(w, 1)[1]!;
    fieldArmy(w, 0, new Array(6).fill('beaver'), egg.x - 2, egg.z);
    park(w, 1, -105, -75);
    run(w, 60);
    expect(egg.hp).toBe(egg.maxHp);
    expect(w.unitsOf(0).some((u) => u.targetId === egg.id)).toBe(false);
  });

  it('does not let knockback shove a structure or a dragon', () => {
    const w = world();
    openSiege(w);
    const tower = [...w.ents.values()]
      .find((e) => e.kind === EntKind.Structure && e.struct === StructKind.Tower && e.side === 1)!;
    const at = { x: tower.x, z: tower.z };
    fieldArmy(w, 0, new Array(6).fill('rhino'), tower.x - 2.5, tower.z);
    park(w, 1, -105, -75);
    run(w, 200);
    expect(tower.x).toBeCloseTo(at.x, 6);
    expect(tower.z).toBeCloseTo(at.z, 6);
  });

  it('does not poison structures (DoT would bypass the siege multiplier)', () => {
    const w = world();
    openSiege(w);
    for (const t of [...w.ents.values()]) {
      if (t.kind === EntKind.Structure && t.struct === StructKind.Tower) t.state = EntState.Dead;
    }
    const egg = eggsOf(w, 1)[1]!;
    fieldArmy(w, 0, new Array(4).fill('venom_snake'), egg.x - 2, egg.z);
    park(w, 1, -105, -75);
    run(w, 150);
    expect(egg.poisonUntil).toBe(0);
  });

  it('excludes an aura source from its own aura', () => {
    const lone = world();
    fieldArmy(lone, 0, ['wolf'], -60, 0);
    park(lone, 1, 105, 75);
    lone.step();
    const solo = lone.unitsOf(0)[0]!;

    const pack = world();
    fieldArmy(pack, 0, ['wolf', 'wolf', 'wolf', 'wolf'], -60, 0);
    park(pack, 1, 105, 75);
    pack.step();

    // A lone wolf must gain nothing; a pack of four gains 3 x 0.15.
    const soloDmg = damageDealtBy(lone, solo);
    const packDmg = damageDealtBy(pack, pack.unitsOf(0)[0]!);
    expect(soloDmg).toBeCloseTo(18, 5);
    expect(packDmg).toBeCloseTo(18 * 1.45, 1);
  });

  it('respawns animals at the castle but never structures', () => {
    const w = world();
    fieldArmy(w, 0, ['wolf'], -60, 0);
    park(w, 1, 105, 75);
    const wolf = w.unitsOf(0)[0]!;
    wolf.hp = 0;
    w.step();
    expect(wolf.state).toBe(EntState.Dead);
    run(w, 21 * TICK_HZ);
    expect(wolf.state).toBe(EntState.Alive);
    expect(wolf.hp).toBe(wolf.maxHp);

    openSiege(w);
    const egg = eggsOf(w, 1)[0]!;
    egg.hp = 0;
    w.step();
    run(w, 60 * TICK_HZ);
    expect(egg.state).toBe(EntState.Dead);
  });

  it('keeps a standing order across respawn', () => {
    const w = world();
    fieldArmy(w, 0, ['wolf'], -60, 0);
    park(w, 1, 105, 75);
    w.orderMove(0, -40, 10);
    const wolf = w.unitsOf(0)[0]!;
    wolf.hp = 0;
    w.step();
    run(w, 21 * TICK_HZ);
    expect(wolf.detached).toBe(true);
    expect(wolf.orderX).toBe(-40);
  });
});

/** Damage one swing of this unit would deal, including aura bonus. */
function damageDealtBy(w: World, u: Ent): number {
  const probe = w as unknown as { dmgBonus: Map<number, number> };
  const bonus = probe.dmgBonus.get(u.id) ?? 0;
  return 18 * (1 + bonus); // wolf base damage
}

describe('phase gates', () => {
  it('opens the siege window at 4:00', () => {
    const w = world();
    expect(w.siegeOpen()).toBe(false);
    w.tick = SIEGE_OPENS_TICK;
    w.step();
    expect(w.siegeOpen()).toBe(true);
    expect(w.announcements.some((a) => a.kind === 'siege')).toBe(true);
  });

  it('halves towers at 10:00 and cuts their damage', () => {
    const w = world();
    const tower = [...w.ents.values()]
      .find((e) => e.kind === EntKind.Structure && e.struct === StructKind.Tower)!;
    const full = tower.maxHp;
    expect(w.towerDamageScale()).toBe(1);
    w.tick = TOWERS_CRUMBLE_TICK;
    w.step();
    expect(tower.maxHp).toBe(Math.round(full * 0.5));
    expect(w.towerDamageScale()).toBeCloseTo(0.7, 6);
  });

  it('burns Dragon Eggs down at 15:00 so a match cannot stalemate', () => {
    const w = world();
    park(w, 0, -105, -75);
    park(w, 1, 105, 75);
    w.tick = WILDFIRE_TICK;
    const egg = eggsOf(w, 1)[0]!;
    const start = egg.hp;
    run(w, TICK_HZ); // one second
    expect(start - egg.hp).toBeCloseTo(egg.maxHp * 0.05, 0);
    run(w, 25 * TICK_HZ);
    expect(eggsOf(w, 1).every((e) => e.state === EntState.Dead)).toBe(true);
  });
});

describe('dragon', () => {
  function awaken(w: World, side: Side) {
    openSiege(w);
    const foe: Side = side === 0 ? 1 : 0;
    for (const e of eggsOf(w, foe)) e.hp = 0;
    w.step();
  }

  it('awakens only when all three enemy Dragon Eggs are gone', () => {
    const w = world();
    openSiege(w);
    const eggs = eggsOf(w, 1);
    eggs[0]!.hp = 0;
    w.step();
    expect(w.dragonReady[0]).toBe(false);
    eggs[1]!.hp = 0;
    eggs[2]!.hp = 0;
    w.step();
    expect(w.dragonReady[0]).toBe(true);
    expect(w.announcements.some((a) => a.kind === 'awakening')).toBe(true);
  });

  it('descends from the sky, then flies at the enemy keep', () => {
    const w = world();
    park(w, 0, -105, -75);
    park(w, 1, 105, 75);
    awaken(w, 0);
    run(w, 2);
    const d = w.dragonOf(0)!;
    expect(d.phase).toBe(DragonPhase.Arriving);
    expect(d.altitude).toBeGreaterThan(40);
    run(w, 7 * TICK_HZ);
    expect(w.dragonOf(0)!.phase).toBe(DragonPhase.Assault);
    const before = w.dragonOf(0)!.x;
    run(w, TICK_HZ);
    expect(w.dragonOf(0)!.x).toBeGreaterThan(before);
  });

  it('cannot be shot down while still arriving', () => {
    const w = world();
    park(w, 0, -105, -75);
    awaken(w, 0);
    run(w, 2);
    const d = w.dragonOf(0)!;
    fieldArmy(w, 1, new Array(6).fill('peregrine'), d.x + 2, d.z);
    run(w, 20);
    expect(w.dragonOf(0)!.hp).toBe(w.dragonOf(0)!.maxHp);
  });

  it('enrages at 60% health', () => {
    const w = world();
    park(w, 0, -105, -75);
    park(w, 1, 105, 75);
    awaken(w, 0);
    run(w, 7 * TICK_HZ);
    const d = w.dragonOf(0)!;
    expect(d.phase).toBe(DragonPhase.Assault);
    d.hp = d.maxHp * 0.59;
    w.step();
    expect(d.phase).toBe(DragonPhase.Enraged);
  });

  it('when slain, reforms the defender eggs at 40% and clears the corpse', () => {
    const w = world();
    park(w, 0, -105, -75);
    park(w, 1, 105, 75);
    awaken(w, 0);
    run(w, 7 * TICK_HZ);
    const d = w.dragonOf(0)!;
    d.hp = 0;
    w.step();
    expect(w.dragonReady[0]).toBe(false);
    expect(w.ents.get(dragonIdFor(0))!.phase).toBe(DragonPhase.Slain);

    run(w, 46 * TICK_HZ);
    for (const e of eggsOf(w, 1)) {
      expect(e.state).toBe(EntState.Alive);
      expect(e.hp).toBeCloseTo(e.maxHp * 0.4, 5);
    }
    expect(w.ents.has(dragonIdFor(0))).toBe(false);
  });

  it('destroys the castle and ends the match', () => {
    const w = world();
    park(w, 0, -105, -75);
    park(w, 1, 105, 75);
    awaken(w, 0);
    run(w, 7 * TICK_HZ);
    const keep = w.castleEntity(1)!;
    keep.hp = 400;
    run(w, 40 * TICK_HZ);
    expect(keep.state).toBe(EntState.Dead);
    expect(w.outcome).not.toBeNull();
    expect(w.outcome!.winner).toBe(0);

    // The world freezes once a castle falls.
    const frozen = [...w.ents.values()].map((e) => `${e.x}:${e.z}`).join('|');
    run(w, 50);
    expect([...w.ents.values()].map((e) => `${e.x}:${e.z}`).join('|')).toBe(frozen);
  });
});

describe('snapshot wire format', () => {
  it('round-trips positions within the quantisation bound', () => {
    const w = world();
    fieldArmy(w, 0, ['wolf', 'hawk', 'golem'], -30, 4);
    run(w, 50);
    const decoded = decodeSnapshot(encodeSnapshot(w));
    const byId = new Map(decoded.map((d) => [d.id, d]));
    for (const e of w.ents.values()) {
      const d = byId.get(e.id)!;
      expect(d).toBeDefined();
      expect(Math.hypot(d.x - e.x, d.z - e.z)).toBeLessThanOrEqual(QUANT_ERROR_M * 2);
      expect(d.hp).toBe(Math.max(0, Math.round(e.hp)));
      expect(d.state).toBe(e.state);
    }
  });

  it('carries altitude for fliers and phase for the dragon only', () => {
    const w = world();
    openSiege(w);
    for (const e of eggsOf(w, 1)) e.hp = 0;
    w.step();
    fieldArmy(w, 0, ['hawk', 'wolf'], -30, 0);
    run(w, 3);
    const decoded = decodeSnapshot(encodeSnapshot(w));
    const byId = new Map(decoded.map((d) => [d.id, d]));

    const hawk = w.unitsOf(0).find((u) => u.flying)!;
    const wolf = w.unitsOf(0).find((u) => !u.flying)!;
    expect(byId.get(hawk.id)!.altitude).toBeGreaterThan(0);
    expect(byId.get(wolf.id)!.altitude).toBeUndefined();
    expect(byId.get(dragonIdFor(0))!.phase).toBeDefined();
    expect(byId.get(hawk.id)!.phase).toBeUndefined();
  });
});

describe('invariant soak', () => {
  it('holds every invariant across a long, busy match', () => {
    const w = world(20260904);
    w.tick = SIEGE_OPENS_TICK - 200;
    fieldArmy(w, 0, ['wolf', 'turtle', 'beaver', 'rhino', 'owl_mage', 'stag', 'bat', 'scorpion', 'golem', 'thunderbird'], -30, 0);
    fieldArmy(w, 1, ['chicken', 'rat', 'boar', 'frog', 'sheep', 'hawk', 'bee', 'fox', 'venom_snake', 'elephant'], 30, 0);
    w.orderMove(0, 6, 2);
    w.orderMove(1, -6, -2);

    const problems: string[] = [];
    for (let i = 0; i < 6000; i++) {
      w.step();
      if (i === 2000) { w.dragonReady = [true, true]; }
      if (i === 4000) { for (const d of [0, 1] as const) { const dr = w.dragonOf(d); if (dr) dr.hp = 1; } }

      for (const e of w.ents.values()) {
        if (!Number.isFinite(e.x) || !Number.isFinite(e.z)) problems.push(`NaN pos ${e.id}`);
        if (!Number.isFinite(e.hp)) problems.push(`NaN hp ${e.id}`);
        if (!Number.isFinite(e.yaw)) problems.push(`NaN yaw ${e.id}`);
        if (!Number.isFinite(e.altitude)) problems.push(`NaN alt ${e.id}`);
        if (e.hp > e.maxHp + 1e-6) problems.push(`hp>max ${e.id}`);
        if (e.state === EntState.Alive && e.hp <= 0) problems.push(`alive@0hp ${e.id}`);
        if (Math.abs(e.x) > 128 || Math.abs(e.z) > 128) problems.push(`out of quant range ${e.id}`);
        if (e.targetId && !w.ents.has(e.targetId)) problems.push(`dangling target ${e.id}`);
        if (e.state === EntState.Alive && e.kind === EntKind.Animal && !e.flying
            && !w.terrain.walkable(e.x, e.z)) problems.push(`in rock ${e.id}`);
      }
      for (const egg of w.eggs) {
        if (!Number.isFinite(egg.progress)) problems.push(`NaN egg ${egg.id}`);
        if (egg.progress < -1e-9 || egg.progress > 1 + 1e-9) problems.push(`egg range ${egg.id}`);
      }
      if (problems.length) break;
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it('survives many simultaneous group orders without unbounded field rebuilds', () => {
    const w = world();
    fieldArmy(w, 0, new Array(10).fill('wolf'), -40, 0);
    park(w, 1, 105, 75);
    const units = w.unitsOf(0);
    // Ten groups, ten different destinations — the pathological case for a
    // flow-field cache.
    units.forEach((u, i) => w.orderMove(0, -40 + i * 7, (i % 2 ? 1 : -1) * 12, [u.id]));
    const t0 = Date.now();
    run(w, 200);
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});
