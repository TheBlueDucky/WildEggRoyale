/**
 * Wire protocol. Bumping PROTOCOL_VERSION changes the matchmaking slot
 * namespace, so incompatible builds can never even find each other.
 */
export const PROTOCOL_VERSION = 5;

/** Fixed simulation rate. Everything tick-based derives from this. */
export const TICK_HZ = 20;
export const TICK_MS = 1000 / TICK_HZ;
/**
 * Input is sampled at the sim rate on purpose. Prediction replay must use
 * exactly the same dt as the host's step — a mismatched dt is a classic and
 * very confusing source of reconciliation jitter.
 */
export const INPUT_HZ = TICK_HZ;

/**
 * Quantisation half-extent in metres. Positions are packed to u16 across
 * [-QUANT_HALF, +QUANT_HALF], giving ~3.9mm precision. Every map must fit
 * inside this box; it is a wire constant, not a map property, so that the
 * decoder never needs map data to make sense of a packet.
 */
export const QUANT_HALF = 128;

/** Input action bits. */
export const ACT_ATTACK = 1 << 0;

// ---------------------------------------------------------------------------
// Beacon channel — used only during matchmaking handoff, then discarded.
// ---------------------------------------------------------------------------

/** Host is already in a match; go probe the next slot. */
export interface MsgBusy {
  t: 'busy';
}

/** Host hands out the private peer id for the real match connection. */
export interface MsgOffer {
  t: 'offer';
  id: string;
}

export type BeaconMsg = MsgBusy | MsgOffer;

// ---------------------------------------------------------------------------
// Match channel
// ---------------------------------------------------------------------------

export interface MsgHello {
  t: 'hello';
  protocolVersion: number;
  /** SHA-256 of the loaded content bundle. Mismatch aborts the match. */
  contentHash: string;
  displayName: string;
}

export interface MsgStart {
  t: 'start';
  seed: number;
  mapId: string;
  /** 0 = host, 1 = client. */
  yourSide: 0 | 1;
  startedAt: number;
}

export interface MsgInput {
  t: 'in';
  tick: number;
  /** Normalised move vector, already rotated into world space by the sender. */
  mx: number;
  mz: number;
  /** Action bitmask — see ACT_*. */
  a: number;
}

export interface MsgSnap {
  t: 'sn';
  tick: number;
  /** [id, qx, qz, qyaw, hp, state] per entity — see snapshot.ts. */
  ents: number[][];
  /**
   * Egg DELTAS only: [id, state, progress0_255, channeler+1].
   *
   * Egg positions and tiers are never sent — both peers generate an identical
   * layout from the shared seed. Only mutations travel, and on a reliable
   * ordered channel each one arrives exactly once.
   */
  eggs?: number[][];
}

/**
 * Unit roster: [id, kind, side, animal, slot].
 *
 * Static per unit, so it is sent only when the roster changes rather than in
 * every snapshot. At forty units, repeating five constant fields at 20Hz would
 * cost more than all the moving data combined.
 */
export interface MsgUnits {
  t: 'un';
  list: number[][];
}

/** Army order: move a selection to a point, or recall it to the leash. */
export interface MsgOrder {
  t: 'ord';
  kind: 'move' | 'recall';
  x?: number;
  z?: number;
  ids?: number[];
}

/** One-shot world announcements (phase gates, egg kills, awakening). */
export interface MsgAnnounce {
  t: 'ann';
  list: Array<{ kind: string; text: string; side?: number }>;
}

/** Discrete player command. Applied on receipt, not tick-aligned. */
export interface MsgCmd {
  t: 'cmd';
  kind: 'replace' | 'decline';
  slot?: number;
}

/** Full army contents for both sides. Sent only when something changes. */
export interface MsgArmy {
  t: 'army';
  a: number[];
  b: number[];
}

/** The recipient's own pending hatch decision. animal -1 means "none". */
export interface MsgOfferState {
  t: 'off';
  animal: number;
  expiresTick: number;
}

export interface MsgAck {
  t: 'ack';
  tick: number;
}

export interface MsgPing {
  t: 'ping';
  ts: number;
}

export interface MsgPong {
  t: 'pong';
  ts: number;
}

export type MatchMsg =
  | MsgHello
  | MsgStart
  | MsgInput
  | MsgSnap
  | MsgCmd
  | MsgUnits
  | MsgOrder
  | MsgAnnounce
  | MsgArmy
  | MsgOfferState
  | MsgAck
  | MsgPing
  | MsgPong;

/** Slot id for the fixed-claim matchmaker. Never shown to the player. */
export function slotId(bucket: string, n: number): string {
  return `weg-v${PROTOCOL_VERSION}-${bucket}-host-${n}`;
}
