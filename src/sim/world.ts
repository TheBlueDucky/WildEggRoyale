import { TICK_HZ, TICK_MS } from '../net/protocol';
import type { MapDef, Side } from '../content/maps';
import { ANIMALS_BY_RARITY, STRUCTURE_MULTIPLIER } from '../content/animals';
import { ARMY_SLOTS, EGG_TIERS, HATCH_RADIUS, OFFER_SECONDS } from '../content/eggs';
import type { Effect } from '../content/abilities';
import { Terrain } from './terrain';
import { EggState, generateEggs, type Egg } from './eggs';
import { FlowField } from './flowfield';
import { Rng } from './rng';
import {
  AGGRO_RANGE, ANIMAL_RESPAWN_TICKS, EntKind, EntState, LEASH_RADIUS, RETARGET_TICKS,
  animalDef, attackCooldownTicks, canTarget, damageOf, effectsFor, isStealthed, isStunned,
  makeAnimal, passiveEffect, rangeOf, speedOf, targetPriority, type Ent,
} from './units';
import {
  SIEGE_OPENS_TICK, StructKind, TOWERS_CRUMBLE_TICK, TOWER_COOLDOWN_TICKS,
  WILDFIRE_DPS_FRACTION, WILDFIRE_TICK, generateStructures,
} from './structures';
import {
  ARRIVE_ALTITUDE, ARRIVE_TICKS, DRAGON_CASTLE_DPS, DRAGON_CASTLE_RANGE,
  DRAGON_ENRAGE_AT, DRAGON_SPLASH_DPS, DRAGON_SPLASH_RADIUS,
  DragonPhase, EGG_RESPAWN_DELAY_TICKS, EGG_RESPAWN_FRACTION, FLY_ALTITUDE,
  dragonDamageMult, dragonIdFor, dragonSpeed, makeDragon,
} from './dragon';

export { EntKind, EntState } from './units';
export type { Ent } from './units';
export { StructKind, SIEGE_OPENS_TICK, TOWERS_CRUMBLE_TICK, WILDFIRE_TICK } from './structures';
export { DragonPhase } from './dragon';

export interface Outcome {
  winner: Side;
  reason: 'castle';
  atTick: number;
}

/** A one-shot world announcement, surfaced to both players. */
export interface Announcement {
  kind:
    | 'siege' | 'towers' | 'wildfire' | 'egg' | 'awakening'
    | 'enrage' | 'slain' | 'rebirth' | 'victory';
  text: string;
  side?: Side;
}

/**
 * The simulation. Headless by construction.
 *
 * HARD RULE: nothing under src/sim may import from src/render, src/ui, or
 * three. The sim has to run without a canvas — that is what makes it testable,
 * and what lets the client run a hollow mirror of it.
 *
 * 2.5D: entities carry x/z only. Ground height is a render-time lookup; it is
 * never simulated and never sent over the wire.
 */

export const PLAYER_SPEED = 8;
export const PLAYER_MAX_HP = 300;
export const PLAYER_DAMAGE = 25;
export const PLAYER_RANGE = 2.8;
export const PLAYER_ATTACK_CD = Math.round(0.6 * TICK_HZ);
export const RESPAWN_TICKS = 10 * TICK_HZ;

/** Rebuild the follow field once its owner has drifted this far from it. */
const FOLLOW_FIELD_DRIFT = 4;
/** Order fields within this distance of an existing one are shared. */
const FIELD_REUSE_RADIUS = 3;
const MAX_ORDER_FIELDS = 8;

export interface Input {
  mx: number;
  mz: number;
  attack: boolean;
}

export interface HatchOffer {
  animal: number;
  expiresAtTick: number;
}

export const ZERO_INPUT: Input = { mx: 0, mz: 0, attack: false };

const SLIDE_ANGLES = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180] as const;
const ONE_SIGN = [1] as const;
const BOTH_SIGNS = [1, -1] as const;

/**
 * Move an entity by `step` metres along (dirX, dirZ), sliding around terrain.
 *
 * Two lessons are baked into SLIDE_ANGLES, both found the hard way:
 *
 * 1. 90 must be present. Pressed flat against an axis-aligned wall, every
 *    deflection below 90 keeps a component INTO the wall (cos 88 is still
 *    0.035) — enough to land back in the blocked cell when the entity sits near
 *    a cell boundary, freezing it with open ground alongside.
 * 2. The sweep must reach 180, or an entity that walks into a concave bay can
 *    never leave: the only exit is behind it.
 *
 * The first walkable candidate wins, so an entity always takes the smallest
 * deflection that works and only reverses when genuinely boxed in.
 */
export function slideMove(e: Ent, dirX: number, dirZ: number, step: number, terrain: Terrain): boolean {
  for (const deg of SLIDE_ANGLES) {
    const signs = deg === 0 ? ONE_SIGN : BOTH_SIGNS;
    for (const sign of signs) {
      const a = (deg * sign * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const nx = e.x + (dirX * cos - dirZ * sin) * step;
      const nz = e.z + (dirX * sin + dirZ * cos) * step;
      if (terrain.walkable(nx, nz)) {
        e.x = nx;
        e.z = nz;
        return true;
      }
    }
  }
  return false;
}

/**
 * The player's own movement step.
 *
 * Shared verbatim between the host's authoritative sim and the client's
 * prediction replay — one copy, both sides call it. Combat is deliberately NOT
 * here: damage is host-authoritative and never predicted, so a client can't
 * briefly show a kill that didn't happen.
 */
export function stepMovement(e: Ent, input: Input, terrain: Terrain, dtMs = TICK_MS): void {
  if (e.state === EntState.Dead) return;
  const len = Math.hypot(input.mx, input.mz);
  if (len < 0.001) return;

  const dirX = input.mx / len;
  const dirZ = input.mz / len;
  e.yaw = Math.atan2(dirX, dirZ);
  slideMove(e, dirX, dirZ, PLAYER_SPEED * (dtMs / 1000), terrain);
}

/**
 * Reuses flow fields between groups heading to nearly the same place.
 *
 * Two safeguards matter here. Groups sent to more distinct destinations than
 * the cache holds would otherwise evict each other every tick, and since each
 * miss is a BFS over ~35k cells that turns into several full rebuilds PER TICK.
 * So: the cache is large enough for realistic play, and at most one field is
 * built per tick. A caller that misses the budget gets null and falls back to
 * straight-line steering for that frame, picking the field up next tick.
 */
class FieldCache {
  private entries: Array<{ x: number; z: number; field: FlowField }> = [];
  private lastBuildTick = -1;

  get(terrain: Terrain, x: number, z: number, tick: number): FlowField | null {
    let nearest: FlowField | null = null;
    let nearestD = Infinity;

    for (const e of this.entries) {
      const d = Math.hypot(e.x - x, e.z - z);
      if (d <= FIELD_REUSE_RADIUS) return e.field;
      if (d < nearestD) { nearestD = d; nearest = e.field; }
    }

    // Budget spent this tick — reuse the closest field we already have rather
    // than paying for another BFS.
    if (this.lastBuildTick === tick) return nearest;

    this.lastBuildTick = tick;
    const field = new FlowField(terrain, x, z);
    this.entries.push({ x, z, field });
    if (this.entries.length > MAX_ORDER_FIELDS) this.entries.shift();
    return field;
  }

  clear() {
    this.entries = [];
    this.lastBuildTick = -1;
  }
}

/**
 * Reach against a specific target, measured surface-to-surface.
 *
 * Centre-to-centre is wrong the moment targets differ in size. Separation holds
 * a unit `attacker.radius + target.radius` from a target's centre, so a melee
 * animal (1.8m reach, 0.45m radius) standing flush against a Dragon Egg (1.6m
 * radius) sits 2.05m from its centre and could never land a hit — silently
 * breaking siege for every melee unit in the game while the multipliers looked
 * fine on paper.
 */
function reachAgainst(target: Ent, baseRange: number): number {
  return baseRange + target.radius;
}

export class World {
  tick = 0;
  ents = new Map<number, Ent>();
  readonly terrain: Terrain;
  readonly eggs: Egg[];

  armies: [number[], number[]] = [[], []];
  offers: [HatchOffer | null, HatchOffer | null] = [null, null];
  inputs: [Input, Input] = [{ ...ZERO_INPUT }, { ...ZERO_INPUT }];

  // --- host-only change tracking, drained by the encoder ---
  readonly changedEggs = new Set<number>();
  armyDirty = false;
  offerDirty = false;
  rosterDirty = false;
  /** Drained by the host each tick and forwarded to the client. */
  announcements: Announcement[] = [];
  /** Set when a side has destroyed all three enemy Dragon Eggs. */
  dragonReady: [boolean, boolean] = [false, false];
  /** Non-null once a castle has fallen. The match is over. */
  outcome: Outcome | null = null;
  /** Tick at which a slain dragon's victim gets their eggs back. */
  private eggRebirthAt: [number, number] = [0, 0];

  private phasesFired = new Set<string>();

  private nextId = 10;
  private readonly contentRng = new Rng((Math.random() * 0xffffffff) >>> 0);
  /**
   * Seeded stream for everything the sim itself randomises (respawn scatter).
   * Math.random() here would make the sim unreproducible, which breaks headless
   * tests and would quietly rule out replays or lockstep later. terrain.ts makes
   * the same promise; this keeps world.ts honest about it.
   */
  private readonly simRng: Rng;
  private readonly eggById = new Map<number, Egg>();

  private readonly followField: Array<FlowField | null> = [null, null];
  private readonly followOrigin: Array<{ x: number; z: number }> = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  private readonly orderFields = [new FieldCache(), new FieldCache()];

  /** Scratch, rebuilt each tick: aura contributions keyed by entity id. */
  private readonly dmgBonus = new Map<number, number>();
  private readonly dmgReduction = new Map<number, number>();

  constructor(readonly map: MapDef, readonly seed: number) {
    this.simRng = new Rng((seed ^ 0x5eed1e) >>> 0);
    this.terrain = new Terrain(map);
    this.eggs = generateEggs(map, this.terrain, seed);
    for (const e of this.eggs) this.eggById.set(e.id, e);
    // Structures are derived from the map on BOTH peers, like the egg layout,
    // so nothing about them ever needs to cross the network.
    for (const st of generateStructures(map)) this.ents.set(st.id, st);
    this.spawnPlayer(1, 0);
    this.spawnPlayer(2, 1);
  }

  // -------------------------------------------------------------------------
  // Entities
  // -------------------------------------------------------------------------

  private castleFor(side: Side) {
    return this.map.castles.find((c) => c.side === side) ?? { side, x: 0, z: 0 };
  }

  spawnPlayer(id: number, side: Side): Ent {
    const c = this.castleFor(side);
    const e: Ent = {
      id, kind: EntKind.Player, side, animal: -1, slot: -1,
      x: c.x + (side === 0 ? 6 : -6), z: c.z, struct: StructKind.None,
      phase: 0, altitude: 0, spawnTick: 0,
      yaw: side === 0 ? Math.PI / 2 : -Math.PI / 2,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
      state: EntState.Alive, flying: false, radius: 0.6,
      respawnAt: 0, attackReadyAt: 0, retargetAt: 0, targetId: 0, hitCount: 0,
      detached: false, orderX: 0, orderZ: 0,
      slowUntil: 0, slowAmount: 0, stunUntil: 0,
      poisonUntil: 0, poisonDps: 0, poisonBy: side,
      stealthUntil: 0, stealthReadyAt: 0, revived: false,
    };
    this.ents.set(id, e);
    return e;
  }

  entForSide(side: Side): Ent | undefined {
    for (const e of this.ents.values()) if (e.kind === EntKind.Player && e.side === side) return e;
    return undefined;
  }

  unitsOf(side: Side): Ent[] {
    const out: Ent[] = [];
    for (const e of this.ents.values()) if (e.kind === EntKind.Animal && e.side === side) out.push(e);
    return out;
  }

  eggAt(id: number): Egg | undefined {
    return this.eggById.get(id);
  }

  /**
   * Make the live units match the army list. Called whenever an army changes,
   * so army slots and battlefield units can never drift apart.
   */
  syncArmyUnits() {
    for (const side of [0, 1] as const) {
      const army = this.armies[side];
      const bySlot = new Map<number, Ent>();
      for (const u of this.unitsOf(side)) bySlot.set(u.slot, u);

      for (let slot = 0; slot < army.length; slot++) {
        const want = army[slot]!;
        const have = bySlot.get(slot);
        if (have && have.animal === want) continue;
        if (have) this.ents.delete(have.id);

        const owner = this.entForSide(side)!;
        const angle = (slot / ARMY_SLOTS) * Math.PI * 2;
        const u = makeAnimal(
          this.nextId++, side, slot, want,
          owner.x + Math.cos(angle) * 3,
          owner.z + Math.sin(angle) * 3,
        );
        this.ents.set(u.id, u);
        this.rosterDirty = true;
      }

      // Trim units whose slot no longer exists.
      for (const [slot, u] of bySlot) {
        if (slot >= army.length) {
          this.ents.delete(u.id);
          this.rosterDirty = true;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Orders
  // -------------------------------------------------------------------------

  /** Detach the given units (or all of a side) to a world position. */
  orderMove(side: Side, x: number, z: number, unitIds?: number[]) {
    const units = unitIds
      ? unitIds.map((id) => this.ents.get(id)).filter((u): u is Ent => !!u && u.side === side && u.kind === EntKind.Animal)
      : this.unitsOf(side);
    for (const u of units) {
      u.detached = true;
      u.orderX = x;
      u.orderZ = z;
    }
  }

  /** Put units back on the owner's leash. */
  orderRecall(side: Side, unitIds?: number[]) {
    const units = unitIds
      ? unitIds.map((id) => this.ents.get(id))
          .filter((u): u is Ent => !!u && u.side === side && u.kind === EntKind.Animal)
      : this.unitsOf(side);
    for (const u of units) u.detached = false;
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  step(): void {
    // Once a castle falls nothing else matters; freezing here keeps the final
    // frame stable while the summary is on screen.
    if (this.outcome) { this.tick++; return; }

    this.stepPhases();
    this.stepDragons();
    this.stepEggRebirth();
    this.stepRespawns();
    this.stepStatus();
    this.reapZeroHp();
    this.computeAuras();
    this.refreshFields();
    this.stepAI();
    this.stepMovementAll();
    this.stepSeparation();
    this.stepAttacks();
    this.stepHatching();
    this.expireOffers();
    this.tick++;
  }

  private stepRespawns() {
    for (const e of this.ents.values()) {
      if (e.state !== EntState.Dead) continue;
      // Structures are gone for good — that is the whole point of a siege, and
      // a slain dragon has to be earned again rather than simply returning.
      if (e.kind === EntKind.Structure || e.kind === EntKind.Dragon) continue;
      if (this.tick < e.respawnAt) continue;
      const c = this.castleFor(e.side);
      e.x = c.x + (e.side === 0 ? 6 : -6) + (this.simRng.float() - 0.5) * 4;
      e.z = c.z + (this.simRng.float() - 0.5) * 4;
      e.hp = e.maxHp;
      e.state = EntState.Alive;
      e.attackReadyAt = 0;
      e.targetId = 0;
      e.revived = false;
      // A standing order SURVIVES respawn. Clearing it here meant a group the
      // player had just detached would silently drift back to the leash as its
      // members trickled back — an order quietly discarded is far worse than
      // one that needs an explicit recall (E).
    }
  }

  /**
   * Anything alive at zero HP is dead, full stop.
   *
   * Death used to happen only inside applyDamage(), so any other path that
   * lowered HP left a zombie: alive, unkillable, still fighting. Enforcing the
   * invariant centrally means new damage sources cannot forget to call kill(),
   * and "alive with hp <= 0" becomes structurally impossible rather than a rule
   * every call site has to remember.
   */
  private reapZeroHp() {
    for (const e of this.ents.values()) {
      if (e.state === EntState.Alive && e.hp <= 0) this.kill(e);
    }
  }

  private stepStatus() {
    const dt = TICK_MS / 1000;
    for (const e of this.ents.values()) {
      if (e.state !== EntState.Alive) continue;

      if (this.tick < e.poisonUntil && e.poisonDps > 0) {
        this.applyDamage(e, e.poisonDps * dt, undefined, false);
      }

      // Stealth is a passive on a cadence rather than an activated ability, so
      // it never needs a command and can't be desynced by a dropped input.
      const stealth = passiveEffect(e, 'stealth');
      if (stealth && this.tick >= e.stealthReadyAt && e.hp < e.maxHp) {
        e.stealthUntil = this.tick + Math.round((stealth.durationSec ?? 2) * TICK_HZ);
        e.stealthReadyAt = this.tick + Math.round((stealth.cooldownSec ?? 12) * TICK_HZ);
      }
    }
  }

  /** Rebuild aura contributions. O(n*sources) — sources are rare. */
  private computeAuras() {
    this.dmgBonus.clear();
    this.dmgReduction.clear();

    const sources: Array<{ e: Ent; fx: Effect }> = [];
    for (const e of this.ents.values()) {
      if (e.state !== EntState.Alive) continue;
      for (const fx of effectsFor(e, 'aura')) sources.push({ e, fx });
    }
    if (sources.length === 0) return;

    for (const target of this.ents.values()) {
      if (target.state !== EntState.Alive) continue;
      let bonus = 0;
      let reduction = 0;
      for (const { e, fx } of sources) {
        if (e.side !== target.side) continue;
        // An aura never applies to its own source. Wolf pack bond is "+15% per
        // NEARBY wolf", so a lone wolf must get nothing; self-application gave
        // it a permanent free +15%.
        if (e.id === target.id) continue;
        const r = fx.radius ?? 8;
        if (Math.hypot(e.x - target.x, e.z - target.z) > r) continue;
        const amt = fx.amount ?? 0;
        // Negative aura amounts mean damage reduction for allies (World
        // Turtle), positive mean bonus damage dealt (Wolf pack, Owl Mage).
        if (amt >= 0) bonus += amt;
        else reduction += -amt;
      }
      if (bonus) this.dmgBonus.set(target.id, Math.min(bonus, 0.6));
      if (reduction) this.dmgReduction.set(target.id, Math.min(reduction, 0.6));
    }
  }

  private refreshFields() {
    for (const side of [0, 1] as const) {
      const owner = this.entForSide(side);
      if (!owner) continue;
      const origin = this.followOrigin[side]!;
      const drift = Math.hypot(owner.x - origin.x, owner.z - origin.z);
      if (!this.followField[side] || drift > FOLLOW_FIELD_DRIFT) {
        this.followField[side] = new FlowField(this.terrain, owner.x, owner.z);
        origin.x = owner.x;
        origin.z = owner.z;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  /**
   * Timed phase gates.
   *
   * These exist to guarantee the match has a shape: the early game is pure
   * exploration because Dragon Eggs simply cannot be hurt, and the late game
   * cannot stalemate because Wildfire burns the eggs down whether anyone
   * attacks or not.
   */
  private stepPhases() {
    if (this.tick >= SIEGE_OPENS_TICK) {
      this.fireOnce('siege', {
        kind: 'siege',
        text: 'SIEGE OPEN - Dragon Eggs can now be destroyed',
      });
    }

    if (this.tick >= TOWERS_CRUMBLE_TICK) {
      this.fireOnce('towers', {
        kind: 'towers',
        text: 'TOWERS CRUMBLE - castle defences weaken',
      }, () => {
        for (const e of this.ents.values()) {
          if (e.kind !== EntKind.Structure || e.struct !== StructKind.Tower) continue;
          e.maxHp = Math.round(e.maxHp * 0.5);
          e.hp = Math.min(e.hp, e.maxHp);
        }
      });
    }

    if (this.tick >= WILDFIRE_TICK) {
      this.fireOnce('wildfire', {
        kind: 'wildfire',
        text: 'WILDFIRE - Dragon Eggs are burning',
      });
      const dt = TICK_MS / 1000;
      for (const e of this.ents.values()) {
        if (e.kind !== EntKind.Structure || e.struct !== StructKind.DragonEgg) continue;
        if (e.state !== EntState.Alive) continue;
        e.hp -= e.maxHp * WILDFIRE_DPS_FRACTION * dt;
        if (e.hp <= 0) this.destroyStructure(e);
      }
    }
  }

  private fireOnce(key: string, note: Announcement, apply?: () => void) {
    if (this.phasesFired.has(key)) return;
    this.phasesFired.add(key);
    apply?.();
    this.announcements.push(note);
  }

  /** True once the siege window has opened. */
  siegeOpen(): boolean {
    return this.tick >= SIEGE_OPENS_TICK;
  }

  towerDamageScale(): number {
    return this.tick >= TOWERS_CRUMBLE_TICK ? 0.7 : 1;
  }

  dragonEggsOf(side: Side): Ent[] {
    const out: Ent[] = [];
    for (const e of this.ents.values()) {
      if (e.kind === EntKind.Structure && e.struct === StructKind.DragonEgg && e.side === side) out.push(e);
    }
    return out;
  }

  private destroyStructure(e: Ent) {
    e.hp = 0;
    e.state = EntState.Dead;

    if (e.struct === StructKind.DragonEgg) {
      const left = this.dragonEggsOf(e.side).filter((x) => x.state === EntState.Alive).length;
      const attacker: Side = e.side === 0 ? 1 : 0;
      if (left > 0) {
        this.announcements.push({
          kind: 'egg',
          side: attacker,
          text: `DRAGON EGG DESTROYED - ${left} remaining`,
        });
      } else {
        this.dragonReady[attacker] = true;
        this.announcements.push({
          kind: 'awakening',
          side: attacker,
          text: 'DRAGON AWAKENING',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Dragon
  // -------------------------------------------------------------------------

  dragonOf(side: Side): Ent | undefined {
    const d = this.ents.get(dragonIdFor(side));
    return d && d.state === EntState.Alive ? d : undefined;
  }

  private stepDragons() {
    for (const side of [0, 1] as const) {
      if (this.dragonReady[side] && !this.ents.has(dragonIdFor(side))) {
        const d = makeDragon(this.map, side);
        d.spawnTick = this.tick;
        this.ents.set(d.id, d);
      }
      const dragon = this.ents.get(dragonIdFor(side));
      if (dragon && dragon.state === EntState.Alive) this.stepDragon(dragon);
    }
  }

  private stepDragon(d: Ent) {
    const dt = TICK_MS / 1000;
    const foe: Side = d.side === 0 ? 1 : 0;
    const keep = this.castleEntity(foe);

    // Enrage is checked every tick so it can trigger mid-approach.
    if (d.phase === DragonPhase.Assault && d.hp <= d.maxHp * DRAGON_ENRAGE_AT) {
      d.phase = DragonPhase.Enraged;
      this.announcements.push({ kind: 'enrage', side: d.side, text: 'THE DRAGON IS ENRAGED' });
    }

    if (d.phase === DragonPhase.Arriving) {
      // Descend from the sky over ARRIVE_TICKS. Invulnerable while it does, so
      // the arrival always reads as an event rather than a free kill.
      const t = Math.min(1, (this.tick - d.spawnTick) / ARRIVE_TICKS);
      d.altitude = ARRIVE_ALTITUDE + (FLY_ALTITUDE - ARRIVE_ALTITUDE) * t;
      if (t >= 1) {
        d.altitude = FLY_ALTITUDE;
        d.phase = DragonPhase.Assault;
      }
    }

    if (!keep) return;

    // Fly straight at the enemy keep. Terrain is irrelevant to a flier, which
    // is exactly why the defender must intercept rather than wall it off.
    const dx = keep.x - d.x;
    const dz = keep.z - d.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.001) d.yaw = Math.atan2(dx / dist, dz / dist);

    if (d.phase === DragonPhase.Arriving) return;

    if (dist > DRAGON_CASTLE_RANGE) {
      const step = dragonSpeed(d) * dt;
      d.x += (dx / dist) * step;
      d.z += (dz / dist) * step;
    } else {
      keep.hp -= DRAGON_CASTLE_DPS * dragonDamageMult(d) * dt;
      if (keep.hp <= 0) {
        keep.hp = 0;
        keep.state = EntState.Dead;
        d.phase = DragonPhase.Triumphant;
        this.outcome = { winner: d.side, reason: 'castle', atTick: this.tick };
        this.announcements.push({ kind: 'victory', side: d.side, text: 'CASTLE DESTROYED' });
        return;
      }
    }

    // Splash the defenders standing under it.
    for (const e of this.ents.values()) {
      if (e.side === d.side || e.state !== EntState.Alive) continue;
      if (e.kind === EntKind.Structure) continue;
      if (Math.hypot(e.x - d.x, e.z - d.z) > DRAGON_SPLASH_RADIUS) continue;
      this.applyDamage(e, DRAGON_SPLASH_DPS * dragonDamageMult(d) * dt, d, true);
    }
  }

  private slayDragon(d: Ent) {
    d.hp = 0;
    d.state = EntState.Dead;
    d.phase = DragonPhase.Slain;
    const victim: Side = d.side === 0 ? 1 : 0;

    // The attacker loses their dragon and has to break the eggs again; the
    // defender gets them back at 40% after a grace period. That is the
    // comeback beat, and the reason a dragon is not simply a win button.
    this.dragonReady[d.side] = false;
    this.eggRebirthAt[victim] = this.tick + EGG_RESPAWN_DELAY_TICKS;
    this.announcements.push({ kind: 'slain', side: victim, text: 'DRAGON SLAIN' });
  }

  private stepEggRebirth() {
    for (const side of [0, 1] as const) {
      const at = this.eggRebirthAt[side];
      if (!at || this.tick < at) continue;
      this.eggRebirthAt[side] = 0;

      for (const e of this.dragonEggsOf(side)) {
        e.state = EntState.Alive;
        e.hp = e.maxHp * EGG_RESPAWN_FRACTION;
      }
      // The slain dragon's corpse is cleared so a new one can be earned.
      const attacker: Side = side === 0 ? 1 : 0;
      this.ents.delete(dragonIdFor(attacker));
      this.announcements.push({
        kind: 'rebirth', side,
        text: 'DRAGON EGGS REFORM AT 40%',
      });
    }
  }

  castleEntity(side: Side): Ent | undefined {
    for (const e of this.ents.values()) {
      if (e.kind === EntKind.Structure && e.struct === StructKind.Castle && e.side === side) return e;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // AI
  // -------------------------------------------------------------------------

  private stepAI() {
    for (const e of this.ents.values()) {
      if (e.kind !== EntKind.Animal || e.state !== EntState.Alive) continue;
      if (this.tick < e.retargetAt) {
        const cur = this.ents.get(e.targetId);
        if (cur && cur.state === EntState.Alive && !isStealthed(cur, this.tick)) continue;
      }
      e.retargetAt = this.tick + RETARGET_TICKS;
      e.targetId = this.acquireTarget(e);
    }
  }

  private acquireTarget(e: Ent): number {
    const assassin = !!passiveEffect(e, 'multi') && animalDef(e)?.role === 'assassin';
    let best = 0;
    let bestPriority = Infinity;
    let bestScore = Infinity;

    for (const other of this.ents.values()) {
      if (other.side === e.side || other.state !== EntState.Alive) continue;
      if (isStealthed(other, this.tick)) continue;
      if (!canTarget(e, other)) continue;
      if (!this.canBeDamaged(other)) continue;
      const d = Math.hypot(other.x - e.x, other.z - e.z) - other.radius;
      if (d > AGGRO_RANGE) continue;

      // Live enemies always outrank buildings; within a tier, Fox and friends
      // dive the weakest thing they can reach and everyone else takes the
      // closest.
      const priority = targetPriority(other);
      const score = assassin ? other.hp : d;
      if (priority < bestPriority || (priority === bestPriority && score < bestScore)) {
        bestPriority = priority;
        bestScore = score;
        best = other.id;
      }
    }
    return best;
  }

  /** Whether anything is allowed to hurt this entity right now. */
  private canBeDamaged(e: Ent): boolean {
    // A dragon still descending cannot be shot out of the sky — the arrival is
    // meant to be an event, not a free kill on something that can't fight back.
    if (e.kind === EntKind.Dragon) return e.phase !== DragonPhase.Arriving;
    if (e.kind !== EntKind.Structure) return true;
    // The keep only ever falls to a dragon — that is what makes the dragon
    // matter and removes the "hit the building with ten wolves" line.
    if (e.struct === StructKind.Castle) return false;
    if (e.struct === StructKind.DragonEgg) return this.siegeOpen();
    return true;
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  private stepMovementAll() {
    const dt = TICK_MS / 1000;
    // Hoisted: entForSide scans every entity, so calling it per unit made this
    // an O(n^2) walk just to find two players.
    const owners: [Ent | undefined, Ent | undefined] = [this.entForSide(0), this.entForSide(1)];

    for (const e of this.ents.values()) {
      if (e.kind === EntKind.Structure || e.kind === EntKind.Dragon) continue;
      if (e.kind === EntKind.Player) {
        if (e.state === EntState.Alive && !isStunned(e, this.tick)) {
          stepMovement(e, this.inputs[e.side], this.terrain);
        }
        continue;
      }
      if (e.state !== EntState.Alive || isStunned(e, this.tick)) continue;

      const step = speedOf(e, this.tick) * dt;
      const target = this.ents.get(e.targetId);

      if (target && target.state === EntState.Alive) {
        const dx = target.x - e.x;
        const dz = target.z - e.z;
        const d = Math.hypot(dx, dz);
        if (d > reachAgainst(target, rangeOf(e)) * 0.9) {
          e.yaw = Math.atan2(dx / d, dz / d);
          slideMove(e, dx / d, dz / d, Math.min(step, d), this.terrain);
        } else {
          e.yaw = Math.atan2(dx / (d || 1), dz / (d || 1));
        }
        continue;
      }

      // No target: hold your ordered ground, or trail your owner.
      const owner = owners[e.side];
      const destX = e.detached ? e.orderX : owner?.x ?? e.x;
      const destZ = e.detached ? e.orderZ : owner?.z ?? e.z;
      const arriveAt = e.detached ? 1.5 : LEASH_RADIUS;
      const d = Math.hypot(destX - e.x, destZ - e.z);
      if (d <= arriveAt) continue;

      const field = e.detached
        ? this.orderFields[e.side]!.get(this.terrain, destX, destZ, this.tick)
        : this.followField[e.side];
      const dir = field?.dirAt(e.x, e.z) ?? null;

      // Fall back to straight-line when the field has nothing (already at the
      // destination cell, or standing outside the map's walkable region).
      const dx = dir ? dir.x : (destX - e.x) / (d || 1);
      const dz = dir ? dir.z : (destZ - e.z) / (d || 1);
      e.yaw = Math.atan2(dx, dz);
      slideMove(e, dx, dz, Math.min(step, d), this.terrain);
    }
  }

  /**
   * Push overlapping units apart so a stack of twenty does not occupy one
   * point. O(n^2), which at ~45 entities is a few thousand cheap checks — a
   * spatial grid only starts paying for itself in the hundreds.
   */
  private stepSeparation() {
    const list: Ent[] = [];
    for (const e of this.ents.values()) if (e.state === EntState.Alive) list.push(e);

    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        if (a.flying !== b.flying) continue; // fliers ignore ground traffic
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const want = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= want * want || d2 < 1e-6) continue;

        const d = Math.sqrt(d2);
        const nx = dx / d;
        const nz = dz / d;
        const aFixed = a.kind === EntKind.Structure || a.kind === EntKind.Dragon;
        const bFixed = b.kind === EntKind.Structure || b.kind === EntKind.Dragon;
        if (aFixed && bFixed) continue;

        // Buildings do not budge, so a unit bumping one absorbs the whole
        // overlap rather than shoving a tower across the field.
        const aPush = aFixed ? 0 : bFixed ? want - d : (want - d) * 0.5;
        const bPush = bFixed ? 0 : aFixed ? want - d : (want - d) * 0.5;

        if (aPush && this.terrain.walkable(a.x - nx * aPush, a.z - nz * aPush)) {
          a.x -= nx * aPush;
          a.z -= nz * aPush;
        }
        if (bPush && this.terrain.walkable(b.x + nx * bPush, b.z + nz * bPush)) {
          b.x += nx * bPush;
          b.z += nz * bPush;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Combat
  // -------------------------------------------------------------------------

  private stepAttacks() {
    for (const e of this.ents.values()) {
      if (e.state !== EntState.Alive || isStunned(e, this.tick)) continue;
      if (this.tick < e.attackReadyAt) continue;

      if (e.kind === EntKind.Dragon) continue; // handled by stepDragon
      if (e.kind === EntKind.Structure) {
        if (e.struct !== StructKind.Tower) continue;
        const L = this.map.castle;
        // Only spend the cooldown if the shot actually happened, otherwise a
        // tower with nothing to shoot idles on cooldown and gives an attacker
        // up to a free second on arrival.
        if (this.swing(e, L.towerRange, L.towerDps * this.towerDamageScale(), 1)) {
          e.attackReadyAt = this.tick + TOWER_COOLDOWN_TICKS;
        }
        continue;
      }

      if (e.kind === EntKind.Player) {
        if (!this.inputs[e.side].attack) continue;
        e.attackReadyAt = this.tick + PLAYER_ATTACK_CD;
        this.swing(e, PLAYER_RANGE, PLAYER_DAMAGE, 1);
        continue;
      }

      const target = this.ents.get(e.targetId);
      if (!target || target.state !== EntState.Alive) continue;
      if (Math.hypot(target.x - e.x, target.z - e.z) > reachAgainst(target, rangeOf(e))) continue;

      const multi = passiveEffect(e, 'multi');
      const targets = animalDef(e)?.role === 'assassin' ? 1 : multi?.targets ?? 1;
      if (this.swing(e, rangeOf(e), damageOf(e, this.dmgBonus.get(e.id) ?? 0), targets)) {
        e.attackReadyAt = this.tick + attackCooldownTicks(e);
      }
    }
  }

  /** One attack. Returns false when nothing valid was in range. */
  private swing(attacker: Ent, range: number, damage: number, count: number): boolean {
    const inRange: Ent[] = [];
    for (const t of this.ents.values()) {
      if (t.side === attacker.side || t.state !== EntState.Alive) continue;
      if (isStealthed(t, this.tick)) continue;
      if (!canTarget(attacker, t)) continue;
      if (!this.canBeDamaged(t)) continue;
      if (Math.hypot(t.x - attacker.x, t.z - attacker.z) > reachAgainst(t, range)) continue;
      inRange.push(t);
    }
    if (inRange.length === 0) return false;

    inRange.sort((a, b) => {
      const p = targetPriority(a) - targetPriority(b);
      if (p !== 0) return p;
      return Math.hypot(a.x - attacker.x, a.z - attacker.z) - Math.hypot(b.x - attacker.x, b.z - attacker.z);
    });

    attacker.hitCount++;
    const ranged = range >= 5;

    for (const t of inRange.slice(0, Math.max(1, count))) {
      const dealt = this.applyDamage(t, damage, attacker, ranged);
      this.runOnHit(attacker, t, dealt);
    }
    return true;
  }

  /** The one place damage is applied. Returns the amount actually dealt. */
  private applyDamage(target: Ent, amount: number, attacker: Ent | undefined, ranged: boolean): number {
    if (!this.canBeDamaged(target)) return 0;

    // This is where army composition finally pays off: ten Wolves are 252 DPS
    // but only 76 against a Dragon Egg, while a siege comp does it in a third
    // of the time.
    if (target.kind === EntKind.Structure && attacker) {
      amount *= this.structureMultiplier(attacker);
    }

    const armor = passiveEffect(target, 'armor');
    let mult = 1;
    if (armor && (armor.vs === 'all' || (armor.vs === 'ranged' && ranged))) {
      mult *= 1 - (armor.amount ?? 0);
    }
    mult *= 1 - (this.dmgReduction.get(target.id) ?? 0);

    const dealt = amount * mult;
    target.hp -= dealt;

    // Only the CHANNELLER being hit breaks a hatch. Interrupting on any
    // friendly entity taking damage meant a wolf trading blows across the map
    // cancelled your channel, which with ten units in play made long hatches
    // essentially impossible to complete.
    if (attacker && target.kind === EntKind.Player) this.interruptChannel(target.side);
    if (target.hp <= 0) this.kill(target);
    return dealt;
  }

  /**
   * The ability executor: one switch, one place. Deliberately a small
   * interpreter rather than a scripting hook — the moment abilities can express
   * arbitrary logic, "content is data" stops being true.
   */
  private runOnHit(attacker: Ent, target: Ent, dealt: number) {
    // Buildings cannot be poisoned, stunned, slowed or shoved, and the dragon
    // is not a knockback toy. Without this a Rhino literally pushed towers
    // across the field, and a Venom Snake's poison ticked on a Dragon Egg at
    // full rate — bypassing the structure multiplier entirely, because DoT has
    // no attacker to scale by.
    const immune = target.kind === EntKind.Structure || target.kind === EntKind.Dragon;

    for (const fx of effectsFor(attacker, 'onHit')) {
      const every = fx.everyNthHit ?? 1;
      if (attacker.hitCount % every !== 0) continue;
      if (immune && (fx.type === 'status' || fx.type === 'knockback')) continue;

      switch (fx.type) {
        case 'status': {
          const ticks = Math.round((fx.durationSec ?? 1) * TICK_HZ);
          if (fx.status === 'poison') {
            target.poisonUntil = this.tick + ticks;
            target.poisonDps = fx.dps ?? 0;
            target.poisonBy = attacker.side;
          } else if (fx.status === 'slow') {
            target.slowUntil = this.tick + ticks;
            target.slowAmount = fx.amount ?? 0.3;
          } else if (fx.status === 'stun') {
            target.stunUntil = this.tick + ticks;
          }
          break;
        }
        case 'lifesteal':
          attacker.hp = Math.min(attacker.maxHp, attacker.hp + dealt * (fx.amount ?? 0.3));
          break;

        case 'knockback': {
          const dist = fx.distance ?? 0;
          const dx = target.x - attacker.x;
          const dz = target.z - attacker.z;
          const d = Math.hypot(dx, dz) || 1;
          slideMove(target, (dx / d) * Math.sign(dist), (dz / d) * Math.sign(dist), Math.abs(dist), this.terrain);
          break;
        }
        case 'chain': {
          const jumps = fx.targets ?? 2;
          const frac = fx.amount ?? 0.5;
          let hops = 0;
          for (const t of this.ents.values()) {
            if (hops >= jumps) break;
            if (t.id === target.id || t.side === attacker.side || t.state !== EntState.Alive) continue;
            if (Math.hypot(t.x - target.x, t.z - target.z) > 6) continue;
            this.applyDamage(t, dealt * frac, attacker, true);
            hops++;
          }
          break;
        }
        default:
          break; // multi/aura/armor/stealth/revive are handled elsewhere
      }
    }
  }

  private kill(e: Ent) {
    if (e.kind === EntKind.Structure) {
      this.destroyStructure(e);
      return;
    }
    if (e.kind === EntKind.Dragon) {
      this.slayDragon(e);
      return;
    }

    const revive = effectsFor(e, 'onDeath').find((f) => f.type === 'revive');
    if (revive && !e.revived) {
      e.revived = true;
      e.hp = e.maxHp * (revive.atFraction ?? 0.4);
      return;
    }

    e.hp = 0;
    e.state = EntState.Dead;
    e.targetId = 0;
    e.stunUntil = 0;
    e.poisonUntil = 0;
    e.stealthUntil = 0;
    // Animals rejoin at the castle rather than being lost for good: permanent
    // loss would empty armies and quietly kill the 10-slot replace decision
    // that the whole egg loop is built around.
    e.respawnAt = this.tick + (e.kind === EntKind.Player ? RESPAWN_TICKS : ANIMAL_RESPAWN_TICKS);
    if (e.kind === EntKind.Player) this.interruptChannel(e.side);
  }

  /** Structure damage multiplier for a unit's role. Used from M4. */
  structureMultiplier(e: Ent): number {
    const def = animalDef(e);
    if (def) return STRUCTURE_MULTIPLIER[def.role];
    // Players and towers hit buildings weakly; sieging is the army's job.
    return e.kind === EntKind.Player ? 0.2 : 1;
  }

  // -------------------------------------------------------------------------
  // Hatching
  // -------------------------------------------------------------------------

  private stepHatching() {
    const dt = TICK_MS / 1000;

    for (const egg of this.eggs) {
      if (egg.state === EggState.Consumed) continue;
      if (this.tick < egg.unlockAtTick) continue;

      const claimant = this.closestChannellerTo(egg);
      if (claimant === null) {
        if (egg.progress !== 0 || egg.channeler !== -1) {
          egg.progress = 0;
          egg.channeler = -1;
          this.changedEggs.add(egg.id);
        }
        continue;
      }

      // Progress lives on the EGG, not the player. Shouldering someone off a
      // 90%-done Legendary hands you their work.
      egg.channeler = claimant.side;
      egg.progress += dt / EGG_TIERS[egg.tier].hatchSeconds;
      this.changedEggs.add(egg.id);

      if (egg.progress >= 1) this.completeHatch(egg, claimant.side);
    }
  }

  private closestChannellerTo(egg: Egg): Ent | null {
    let best: Ent | null = null;
    let bestD = HATCH_RADIUS;
    for (const e of this.ents.values()) {
      if (e.kind !== EntKind.Player || e.state !== EntState.Alive) continue;
      if (this.offers[e.side]) continue;
      const d = Math.hypot(e.x - egg.x, e.z - egg.z);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private completeHatch(egg: Egg, side: Side) {
    egg.state = EggState.Consumed;
    egg.progress = 1;
    egg.channeler = -1;
    this.changedEggs.add(egg.id);

    const animal = this.contentRng.pick(ANIMALS_BY_RARITY[egg.tier]);
    if (animal === undefined) return;

    const army = this.armies[side];
    if (army.length < ARMY_SLOTS) {
      army.push(animal);
      this.armyDirty = true;
      this.syncArmyUnits();
      return;
    }
    this.offers[side] = { animal, expiresAtTick: this.tick + OFFER_SECONDS * TICK_HZ };
    this.offerDirty = true;
  }

  private expireOffers() {
    for (const side of [0, 1] as const) {
      const offer = this.offers[side];
      if (offer && this.tick >= offer.expiresAtTick) {
        this.offers[side] = null;
        this.offerDirty = true;
      }
    }
  }

  private interruptChannel(side: Side) {
    for (const egg of this.eggs) {
      if (egg.channeler !== side || egg.state === EggState.Consumed) continue;
      egg.progress = 0;
      egg.channeler = -1;
      this.changedEggs.add(egg.id);
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  replaceSlot(side: Side, slot: number): boolean {
    const offer = this.offers[side];
    if (!offer) return false;
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.armies[side].length) return false;
    this.armies[side][slot] = offer.animal;
    this.offers[side] = null;
    this.armyDirty = true;
    this.offerDirty = true;
    this.syncArmyUnits();
    return true;
  }

  declineOffer(side: Side): boolean {
    if (!this.offers[side]) return false;
    this.offers[side] = null;
    this.offerDirty = true;
    return true;
  }

  /** Drop cached order fields — call when the map's walkability changes. */
  invalidateFields() {
    this.orderFields[0]!.clear();
    this.orderFields[1]!.clear();
    this.followField[0] = null;
    this.followField[1] = null;
  }
}
