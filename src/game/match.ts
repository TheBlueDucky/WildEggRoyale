import type { DataConnection } from 'peerjs';
import type { MatchResult } from '../net/matchmaker';
import {
  ACT_ATTACK, INPUT_HZ, PROTOCOL_VERSION, TICK_HZ, TICK_MS,
  type MatchMsg, type MsgHello, type MsgSnap, type MsgStart,
} from '../net/protocol';
import { RateMeter, TickLoop } from '../net/clock';
import { decodeEggs, decodeSnapshot, encodeSnapshot, type DecodedEnt } from '../net/snapshot';
import {
  EntKind, EntState, PLAYER_MAX_HP, stepMovement, World, ZERO_INPUT,
  type Ent, type HatchOffer, type Input,
} from '../sim/world';
import { EggState, type Egg } from '../sim/eggs';
import { makeAnimal } from '../sim/units';
import { StructKind, SIEGE_OPENS_TICK } from '../sim/structures';
import { DragonPhase, makeDragon } from '../sim/dragon';
import type { Announcement, Outcome } from '../sim/world';
import { ARMY_SLOTS } from '../content/eggs';
import { EMERALD_FOREST, MAPS, type MapDef, type Side } from '../content/maps';
import { contentHash } from '../content/hash';

/** Render behind the newest snapshot by this much, to absorb network jitter. */
const INTERP_DELAY_MS = 100;
/** Extra ticks of lead so our input reaches the host before it is consumed. */
const BASE_INPUT_LEAD = 2;
const SNAP_HISTORY = 20;

export interface View {
  x: number;
  z: number;
  yaw: number;
  hp: number;
  state: EntState;
}

export interface MatchStats {
  role: 'host' | 'client';
  side: Side;
  tick: number;
  rttMs: number;
  inBps: number;
  outBps: number;
  /** Client only: the visible correction applied after replaying inputs. */
  reconcileM: number;
  /** Client only: our tick estimate minus the host's last reported tick. */
  tickLead: number;
  snapsPerSec: number;
}

interface StampedSnap {
  recvAt: number;
  tick: number;
  ents: DecodedEnt[];
}

const DEAD_VIEW: View = { x: 0, z: 0, yaw: 0, hp: 0, state: EntState.Dead };

export class Match {
  world!: World;
  map: MapDef = EMERALD_FOREST;
  readonly isHost: boolean;
  side: Side = 0;

  onFatal?: (reason: string) => void;

  private readonly conn: DataConnection;
  private readonly inMeter = new RateMeter();
  private readonly outMeter = new RateMeter();

  private loop?: TickLoop;
  private pingTimer?: number;
  private rttMs = 0;
  private snapCount = 0;
  private snapCountAt = performance.now();
  private snapsPerSec = 0;
  private dead = false;

  // --- host state ---
  private clientInputs = new Map<number, Input>();
  private lastClientInput: Input = { ...ZERO_INPUT };
  private prev = new Map<number, View>();

  // --- client state ---
  private snaps: StampedSnap[] = [];
  private pending: Array<{ tick: number; input: Input }> = [];
  private predicted!: Ent;
  private prevPredicted: View = { ...DEAD_VIEW };
  private reconcileM = 0;
  private tickLead = 0;
  private hostTick = 0;
  private hostTickAt = 0;
  private remoteArmies: [number[], number[]] = [[], []];
  private remoteOffer: HatchOffer | null = null;
  private pendingAnnouncements: Announcement[] = [];
  private remoteOutcome: Outcome | null = null;

  constructor(link: MatchResult, private readonly displayName: string) {
    this.conn = link.conn;
    this.isHost = link.role === 'host';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.conn.on('close', () => this.fatal('Opponent disconnected'));
    this.conn.on('error', () => this.fatal('Connection error'));
    // Must be wired BEFORE the handshake — expect() reads through onData().
    this.conn.on('data', (raw) => this.onData(raw));

    await this.handshake();

    if (this.isHost) {
      this.side = 0;
      this.map = EMERALD_FOREST;
      // The seed must be decided BEFORE the world is built: it drives the egg
      // layout, and the client rebuilds an identical one from the same number.
      const seed = (Math.random() * 0xffffffff) >>> 0;
      this.world = new World(this.map, seed);
      this.send({ t: 'start', seed, mapId: this.map.id, yourSide: 1, startedAt: Date.now() });
      this.runHost();
    } else {
      const start = await this.expect<MsgStart>('start', 8000);
      const map = MAPS[start.mapId];
      if (!map) throw new Error(`Unknown map "${start.mapId}"`);
      this.map = map;
      this.side = start.yourSide;
      this.world = new World(this.map, start.seed);
      this.runClient();
    }

    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', ts: performance.now() }), 1000);
  }

  stop() {
    this.dead = true;
    this.loop?.stop();
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    try { this.conn.close(); } catch { /* already gone */ }
  }

  private fatal(reason: string) {
    if (this.dead) return;
    this.dead = true;
    this.loop?.stop();
    if (this.pingTimer !== undefined) clearInterval(this.pingTimer);
    this.onFatal?.(reason);
  }

  /**
   * Exchange HELLO and refuse to play if the content bundles differ. Aborting
   * here is far kinder than a match that silently desyncs ten minutes in — and
   * with terrain now feeding walkability, differing map data would do exactly
   * that.
   */
  private async handshake(): Promise<void> {
    const ours = await contentHash();
    this.send({
      t: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      contentHash: ours,
      displayName: this.displayName,
    });

    const theirs = await this.expect<MsgHello>('hello', 10000);

    if (theirs.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Version mismatch (you v${PROTOCOL_VERSION}, them v${theirs.protocolVersion})`);
    }
    if (theirs.contentHash !== ours) {
      throw new Error(`Content mismatch (${ours} vs ${theirs.contentHash}) — different game build`);
    }
  }

  // -------------------------------------------------------------------------
  // Host: authoritative simulation
  // -------------------------------------------------------------------------

  private runHost() {
    this.loop = new TickLoop(TICK_HZ, (tick) => {
      this.prev.clear();
      for (const e of this.world.ents.values()) this.prev.set(e.id, entView(e));

      const queued = this.clientInputs.get(tick);
      if (queued) {
        this.lastClientInput = queued;
        this.clientInputs.delete(tick);
      }
      for (const t of this.clientInputs.keys()) {
        if (t < tick - TICK_HZ) this.clientInputs.delete(t);
      }

      this.world.inputs[0] = this.localInput;
      this.world.inputs[1] = this.lastClientInput;
      this.world.step();

      this.send(encodeSnapshot(this.world));
      this.flushArmyAndOffer();

      // Announcements are one-shot and must never be lost, so they ride their
      // own reliable message rather than being inferred from state deltas.
      if (this.world.announcements.length) {
        const list = this.world.announcements.splice(0);
        this.pendingAnnouncements.push(...list);
        this.send({ t: 'ann', list });
      }
    });
    this.loop.start();
  }

  // -------------------------------------------------------------------------
  // Client: prediction + reconciliation
  // -------------------------------------------------------------------------

  private runClient() {
    const self = this.world.entForSide(this.side);
    this.predicted = self ? { ...self } : this.world.spawnPlayer(99, this.side);
    this.prevPredicted = entView(this.predicted);

    this.loop = new TickLoop(INPUT_HZ, () => {
      const input = { ...this.localInput };
      const tick = this.estimateServerTick() + this.inputLead();

      this.send({ t: 'in', tick, mx: input.mx, mz: input.mz, a: input.attack ? ACT_ATTACK : 0 });
      this.pending.push({ tick, input });
      if (this.pending.length > 120) this.pending.shift();

      this.prevPredicted = entView(this.predicted);
      stepMovement(this.predicted, input, this.world.terrain);

      this.tickLead = tick - this.hostTick;
    });
    this.loop.start();
  }

  private estimateServerTick(): number {
    if (!this.hostTickAt) return 0;
    return this.hostTick + Math.floor((performance.now() - this.hostTickAt) / TICK_MS);
  }

  private inputLead(): number {
    return BASE_INPUT_LEAD + Math.ceil(this.rttMs / 2 / TICK_MS);
  }

  /**
   * Snap to the authoritative position, then replay every input the host has
   * not yet acknowledged. Because stepMovement() is shared with the host and
   * both sides use the same dt, this converges rather than oscillating.
   */
  private reconcile(snap: MsgSnap, ents: DecodedEnt[]) {
    const selfId = this.world.entForSide(this.side)?.id;
    const auth = ents.find((e) => e.id === selfId);
    if (!auth) return;

    const beforeX = this.predicted.x;
    const beforeZ = this.predicted.z;

    this.predicted.x = auth.x;
    this.predicted.z = auth.z;
    this.predicted.yaw = auth.yaw;
    // HP and life state are never predicted — damage is host-authoritative, so
    // a client can't briefly show a kill that did not happen.
    this.predicted.hp = auth.hp;
    this.predicted.state = auth.state;

    this.pending = this.pending.filter((p) => p.tick > snap.tick);
    for (const p of this.pending) stepMovement(this.predicted, p.input, this.world.terrain);

    // The visible correction: how far the character actually jumped once the
    // authoritative state was folded in and unacked inputs replayed. Measuring
    // against the raw authoritative position instead would just report the
    // input lead distance, which is expected and not an error at all.
    this.reconcileM = Math.hypot(this.predicted.x - beforeX, this.predicted.z - beforeZ);
  }

  // -------------------------------------------------------------------------
  // Army & hatch offers
  // -------------------------------------------------------------------------

  /**
   * Armies and offers change rarely, so they are event-driven rather than part
   * of the 20Hz snapshot. Ten indices per side every tick would cost more than
   * the entity data does.
   */
  private flushArmyAndOffer() {
    if (this.world.rosterDirty) {
      this.world.rosterDirty = false;
      const list: number[][] = [];
      for (const e of this.world.ents.values()) {
        if (e.kind !== EntKind.Animal) continue;
        list.push([e.id, e.kind, e.side, e.animal, e.slot]);
      }
      this.send({ t: 'un', list });
    }
    if (this.world.armyDirty) {
      this.world.armyDirty = false;
      this.send({ t: 'army', a: [...this.world.armies[0]], b: [...this.world.armies[1]] });
    }
    if (this.world.offerDirty) {
      this.world.offerDirty = false;
      const offer = this.world.offers[1]; // the client's own offer
      this.send({ t: 'off', animal: offer?.animal ?? -1, expiresTick: offer?.expiresAtTick ?? 0 });
    }
  }

  /**
   * Rebuild the client's mirror of the unit roster.
   *
   * The client never simulates units — it only needs enough of each one to draw
   * it. Transforms arrive in snapshots; this carries the fields that don't
   * change, so they aren't repeated twenty times a second.
   */
  private applyRoster(list: number[][]) {
    const seen = new Set<number>();
    for (const row of list) {
      const [id, , side, animal, slot] = row;
      if (id === undefined) continue;
      seen.add(id);
      if (this.world.ents.has(id)) continue;
      const u = makeAnimal(id, (side ?? 0) as Side, slot ?? -1, animal ?? 0, 0, 0);
      this.world.ents.set(id, u);
    }
    for (const e of [...this.world.ents.values()]) {
      if (e.kind === EntKind.Animal && !seen.has(e.id)) this.world.ents.delete(e.id);
    }
  }

  /**
   * Whether the siege window has opened.
   *
   * MUST go through stats().tick, not world.tick: the client never runs step(),
   * so its world.tick sits at 0 forever and every gate would read as closed.
   */
  siegeOpen(): boolean {
    return this.stats().tick >= SIEGE_OPENS_TICK;
  }

  /** Non-null once a castle has fallen. */
  outcome(): Outcome | null {
    return this.isHost ? this.world.outcome : this.remoteOutcome;
  }

  /** The attacking dragon in play for a side, if any. */
  dragonFor(side: Side): Ent | undefined {
    for (const e of this.world.ents.values()) {
      if (e.kind === EntKind.Dragon && e.side === side && e.state !== EntState.Dead) return e;
    }
    return undefined;
  }

  anyDragon(): Ent | undefined {
    return this.dragonFor(0) ?? this.dragonFor(1);
  }

  /** Every dragon entity, live or not, for the renderer. */
  dragons(): Ent[] {
    const out: Ent[] = [];
    for (const e of this.world.ents.values()) if (e.kind === EntKind.Dragon) out.push(e);
    return out;
  }

  dragonPhase(d: Ent): DragonPhase {
    return d.phase as DragonPhase;
  }

  /** Drain queued world announcements for the banner UI. */
  takeAnnouncements(): Announcement[] {
    if (!this.pendingAnnouncements.length) return EMPTY_ANNOUNCEMENTS;
    return this.pendingAnnouncements.splice(0);
  }

  /** All castles, towers and Dragon Eggs. Deterministic on both peers. */
  structures(): Ent[] {
    const out: Ent[] = [];
    for (const e of this.world.ents.values()) if (e.kind === EntKind.Structure) out.push(e);
    return out;
  }

  castleHp(side: Side): { hp: number; maxHp: number } {
    for (const e of this.world.ents.values()) {
      if (e.kind === EntKind.Structure && e.struct === StructKind.Castle && e.side === side) {
        return { hp: Math.max(0, e.hp), maxHp: e.maxHp };
      }
    }
    return { hp: 0, maxHp: 1 };
  }

  /** Live Dragon Eggs a side still has, for the HUD. */
  dragonEggsLeft(side: Side): number {
    let n = 0;
    for (const e of this.world.ents.values()) {
      if (e.kind !== EntKind.Structure || e.struct !== StructKind.DragonEgg) continue;
      if (e.side !== side) continue;
      if (this.viewOf(e.id).state !== EntState.Dead) n++;
    }
    return n;
  }

  /** Every animal currently on the field, for rendering and selection. */
  units(): Ent[] {
    const out: Ent[] = [];
    for (const e of this.world.ents.values()) if (e.kind === EntKind.Animal) out.push(e);
    return out;
  }

  myUnits(): Ent[] {
    return this.units().filter((u) => u.side === this.side);
  }

  orderMove(x: number, z: number, ids?: number[]) {
    if (this.isHost) this.world.orderMove(0, x, z, ids);
    else this.send({ t: 'ord', kind: 'move', x, z, ids });
  }

  orderRecall(ids?: number[]) {
    if (this.isHost) this.world.orderRecall(0, ids);
    else this.send({ t: 'ord', kind: 'recall', ids });
  }

  armyFor(side: Side): number[] {
    return this.isHost ? this.world.armies[side] : this.remoteArmies[side];
  }

  myArmy(): number[] {
    return this.armyFor(this.side);
  }

  /** Our own pending replace decision, if any. */
  myOffer(): HatchOffer | null {
    return this.isHost ? this.world.offers[0] : this.remoteOffer;
  }

  /** Seconds left on the pending decision. */
  offerSecondsLeft(): number {
    const offer = this.myOffer();
    if (!offer) return 0;
    const now = this.isHost ? this.world.tick : this.hostTick;
    return Math.max(0, (offer.expiresAtTick - now) / TICK_HZ);
  }

  requestReplace(slot: number) {
    if (this.isHost) this.world.replaceSlot(0, slot);
    else this.send({ t: 'cmd', kind: 'replace', slot });
  }

  requestDecline() {
    if (this.isHost) this.world.declineOffer(0);
    else this.send({ t: 'cmd', kind: 'decline' });
  }

  armyFull(): boolean {
    return this.myArmy().length >= ARMY_SLOTS;
  }

  /** Eggs still worth rendering. Consumed ones are dropped from the scene. */
  liveEggs(): Egg[] {
    return this.world.eggs.filter((e) => e.state !== EggState.Consumed);
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private send(msg: MatchMsg) {
    if (this.dead || !this.conn.open) return;
    this.outMeter.add(JSON.stringify(msg).length);
    this.conn.send(msg);
  }

  private onData(raw: unknown) {
    const msg = raw as MatchMsg;
    this.inMeter.add(JSON.stringify(msg).length);

    switch (msg.t) {
      case 'in':
        if (this.isHost) {
          this.clientInputs.set(msg.tick, {
            mx: msg.mx,
            mz: msg.mz,
            attack: (msg.a & ACT_ATTACK) !== 0,
          });
        }
        break;

      case 'sn': {
        this.hostTick = msg.tick;
        this.hostTickAt = performance.now();

        this.snapCount++;
        const dt = this.hostTickAt - this.snapCountAt;
        if (dt >= 1000) {
          this.snapsPerSec = (this.snapCount * 1000) / dt;
          this.snapCount = 0;
          this.snapCountAt = this.hostTickAt;
        }

        // Eggs mutate only on the host; the client folds in the deltas.
        for (const d of decodeEggs(msg)) {
          const egg = this.world.eggAt(d.id);
          if (!egg) continue;
          egg.state = d.state;
          egg.progress = d.progress;
          egg.channeler = d.channeler;
        }

        const ents = decodeSnapshot(msg);

        // Mirror authoritative state into the local world. Interpolation still
        // drives rendering, but anything that reads entity state directly
        // (dragon phase, structure HP, altitude) needs a real home.
        for (const d of ents) {
          let e = this.world.ents.get(d.id);
          if (!e && d.phase !== undefined) {
            // A dragon the client has not seen before — materialise it.
            e = makeDragon(this.map, d.id % 2 === 0 ? 0 : 1);
            e.id = d.id;
            this.world.ents.set(d.id, e);
          }
          if (!e) continue;
          e.hp = d.hp;
          e.state = d.state;
          if (d.altitude !== undefined) e.altitude = d.altitude;
          if (d.phase !== undefined) e.phase = d.phase;
          if (e.kind === EntKind.Structure || e.kind === EntKind.Dragon) {
            e.x = d.x;
            e.z = d.z;
            e.yaw = d.yaw;
          }
        }

        this.snaps.push({ recvAt: this.hostTickAt, tick: msg.tick, ents });
        if (this.snaps.length > SNAP_HISTORY) this.snaps.shift();

        this.reconcile(msg, ents);
        this.send({ t: 'ack', tick: msg.tick });
        break;
      }

      case 'cmd':
        // Only the host acts on commands, and only ever for side 1 — a client
        // cannot address a command at the host's own army.
        if (this.isHost) {
          if (msg.kind === 'replace') this.world.replaceSlot(1, msg.slot ?? -1);
          else this.world.declineOffer(1);
        }
        break;

      case 'army':
        this.remoteArmies = [msg.a, msg.b];
        break;

      case 'ann': {
        const list = msg.list as Announcement[];
        this.pendingAnnouncements.push(...list);
        // The outcome rides the victory announcement rather than needing its
        // own message; both are one-shot and both must arrive exactly once.
        const win = list.find((a) => a.kind === 'victory');
        if (win && win.side !== undefined) {
          this.remoteOutcome = { winner: win.side, reason: 'castle', atTick: this.hostTick };
        }
        break;
      }

      case 'un':
        // Rebuild the client's mirror of the unit roster. Transforms still come
        // from snapshots; this only carries the fields that never change.
        this.applyRoster(msg.list);
        break;

      case 'ord':
        if (this.isHost) {
          if (msg.kind === 'move') this.world.orderMove(1, msg.x ?? 0, msg.z ?? 0, msg.ids);
          else this.world.orderRecall(1, msg.ids);
        }
        break;

      case 'off':
        this.remoteOffer = msg.animal < 0 ? null : { animal: msg.animal, expiresAtTick: msg.expiresTick };
        break;

      case 'ping':
        this.send({ t: 'pong', ts: msg.ts });
        break;

      case 'pong':
        this.rttMs = performance.now() - msg.ts;
        break;

      default:
        break;
    }

    this.waiting?.(msg);
  }

  private waiting?: (msg: MatchMsg) => void;

  private expect<T extends MatchMsg>(type: T['t'], timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new Error(`Timed out waiting for "${type}"`));
      }, timeoutMs);

      this.waiting = (msg) => {
        if (msg.t !== type) return;
        clearTimeout(timer);
        this.waiting = undefined;
        resolve(msg as T);
      };
    });
  }

  // -------------------------------------------------------------------------
  // Local input, written by the input handler in main.ts
  // -------------------------------------------------------------------------

  localInput: Input = { ...ZERO_INPUT };

  // -------------------------------------------------------------------------
  // Views for the renderer
  // -------------------------------------------------------------------------

  viewSelf(): View {
    if (this.isHost) return this.interpolateLocal(this.world.entForSide(this.side)?.id ?? 1);
    const v = lerpView(this.prevPredicted, entView(this.predicted), this.loop?.alpha() ?? 1);
    v.hp = this.predicted.hp;
    v.state = this.predicted.state;
    return v;
  }

  /**
   * Transform for any entity by id. The host reads its own sim; the client
   * reads the interpolated snapshot buffer. Dead animals stay in the snapshot
   * rather than being culled — skipping them saves a little bandwidth but means
   * the client never learns they died, which is much worse.
   */
  viewOf(id: number): View {
    return this.isHost ? this.interpolateLocal(id) : this.interpolateSnapshots(id);
  }

  viewOpponent(): View {
    const otherSide: Side = this.side === 0 ? 1 : 0;
    const id = this.world.entForSide(otherSide)?.id ?? 2;
    if (this.isHost) return this.interpolateLocal(id);
    return this.interpolateSnapshots(id);
  }

  private interpolateLocal(id: number): View {
    const cur = this.world.ents.get(id);
    if (!cur) return { ...DEAD_VIEW };
    const curView = entView(cur);
    const p = this.prev.get(id) ?? curView;
    const v = lerpView(p, curView, this.loop?.alpha() ?? 1);
    v.hp = cur.hp;
    v.state = cur.state;
    return v;
  }

  /**
   * Render the opponent 100ms in the past. That delay is what turns an
   * irregular stream of snapshots into smooth motion.
   */
  private interpolateSnapshots(id: number): View {
    if (this.snaps.length === 0) return { ...DEAD_VIEW };

    const target = performance.now() - INTERP_DELAY_MS;
    let older: StampedSnap | undefined;
    let newer: StampedSnap | undefined;

    for (const s of this.snaps) {
      if (s.recvAt <= target) older = s;
      else { newer = s; break; }
    }

    const last = this.snaps[this.snaps.length - 1]!;
    if (!older) older = this.snaps[0]!;
    if (!newer) {
      const e = older.ents.find((x) => x.id === id) ?? last.ents.find((x) => x.id === id);
      return e ? { x: e.x, z: e.z, yaw: e.yaw, hp: e.hp, state: e.state } : { ...DEAD_VIEW };
    }

    const a = older.ents.find((x) => x.id === id);
    const b = newer.ents.find((x) => x.id === id);
    if (!a || !b) return { ...DEAD_VIEW };

    const span = newer.recvAt - older.recvAt;
    const t = span > 0 ? Math.max(0, Math.min(1, (target - older.recvAt) / span)) : 1;
    const v = lerpView(a, b, t);
    v.hp = b.hp;
    v.state = b.state;
    return v;
  }

  /**
   * Seconds until our respawn, or 0 if alive. Returns -1 on the client, which
   * is not sent the respawn tick — the HUD shows a plain "respawning" there
   * rather than inventing a countdown that could disagree with the host.
   */
  respawnIn(): number {
    if (this.viewSelf().state !== EntState.Dead) return 0;
    if (!this.isHost) return -1;
    const e = this.world.entForSide(this.side);
    return e ? Math.max(0, (e.respawnAt - this.world.tick) / TICK_HZ) : 0;
  }

  maxHp(): number {
    return PLAYER_MAX_HP;
  }

  stats(): MatchStats {
    return {
      role: this.isHost ? 'host' : 'client',
      side: this.side,
      tick: this.isHost ? this.world.tick : this.hostTick,
      rttMs: this.rttMs,
      inBps: this.inMeter.perSecond(),
      outBps: this.outMeter.perSecond(),
      reconcileM: this.reconcileM,
      tickLead: this.tickLead,
      snapsPerSec: this.snapsPerSec,
    };
  }
}

const EMPTY_ANNOUNCEMENTS: Announcement[] = [];

function entView(e: Ent): View {
  return { x: e.x, z: e.z, yaw: e.yaw, hp: e.hp, state: e.state };
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function lerpView(a: View, b: View, t: number): View {
  return {
    x: a.x + (b.x - a.x) * t,
    z: a.z + (b.z - a.z) * t,
    yaw: lerpAngle(a.yaw, b.yaw, t),
    hp: b.hp,
    state: b.state,
  };
}
