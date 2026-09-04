import { Peer, type DataConnection } from 'peerjs';
import { slotId, type BeaconMsg, type MsgOffer } from './protocol';

/**
 * Codeless matchmaking via PeerJS fixed-slot ID claiming.
 *
 * The broker rejects duplicate IDs atomically, which makes "claim a well-known
 * ID" a distributed lock:
 *
 *   claim "weg-v1-c-host-1"
 *     SUCCESS -> nobody here, become the waiting host   ("0/2, create match")
 *     TAKEN   -> someone is waiting, connect to them    ("1/2, auto-join")
 *
 * The player never sees a code. Two things make it actually work at scale:
 *
 *  1. A ladder of 8 slots, so more than one match can exist at a time.
 *  2. Beacon handoff: once paired, both peers move to freshly generated random
 *     IDs and the host destroys its beacon, freeing the slot within ~1s. The
 *     ladder therefore almost never gets used past slot 1.
 *
 * ORDER IS LOAD-BEARING: every client runs a CONNECT pass before a CLAIM pass.
 * If everyone claimed first you would get N players squatting N slots, all
 * waiting, none matching. The re-probe loop is the backstop for when two
 * clients claim simultaneously anyway.
 */

const SLOTS = 8;
const CONNECT_TIMEOUT_MS = 4000;
const OFFER_TIMEOUT_MS = 4000;
const REPROBE_MS = 5000;
const DIAL_BACK_TIMEOUT_MS = 12000;

export type MMState =
  | 'idle'
  | 'probing'
  | 'claiming'
  | 'waiting'
  | 'linking'
  | 'matched'
  | 'failed';

export interface MatchResult {
  peer: Peer;
  conn: DataConnection;
  role: 'host' | 'client';
}

// --- PeerJS promise wrappers ------------------------------------------------

const PEER_OPTS = { debug: 0 } as const;

/** Resolves once the broker confirms the id, rejects if it is taken. */
function createPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    let done = false;
    const onOpen = () => {
      if (done) return;
      done = true;
      peer.off('error', onError);
      resolve(peer);
    };
    const onError = (err: Error & { type?: string }) => {
      if (done) return;
      done = true;
      peer.off('open', onOpen);
      peer.destroy();
      reject(err);
    };
    peer.on('open', onOpen);
    peer.on('error', onError);
  });
}

/**
 * Dial a peer id. Resolves null on failure rather than throwing — probing a
 * dead slot is an expected outcome, not an error.
 *
 * PeerJS reports an unreachable target on the *peer*, not the connection, so
 * we correlate by id and also keep a hard timeout for silent failures.
 */
function connectTo(
  peer: Peer,
  targetId: string,
  timeoutMs: number,
): Promise<DataConnection | null> {
  return new Promise((resolve) => {
    let done = false;
    const conn = peer.connect(targetId, { reliable: true, serialization: 'json' });

    const cleanup = () => {
      clearTimeout(timer);
      peer.off('error', onPeerError);
    };
    const settle = (value: DataConnection | null) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };

    const timer = setTimeout(() => {
      try { conn?.close(); } catch { /* already gone */ }
      settle(null);
    }, timeoutMs);

    const onPeerError = (err: Error & { type?: string }) => {
      if (err.type === 'peer-unavailable' && err.message.includes(targetId)) settle(null);
    };
    peer.on('error', onPeerError);

    if (!conn) { settle(null); return; }
    conn.on('open', () => settle(conn));
    conn.on('error', () => settle(null));
    conn.on('close', () => settle(null));
  });
}

/** Wait for the first message on a connection. */
function firstMessage<T>(conn: DataConnection, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v: T | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.off('data', onData);
      resolve(v);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    const onData = (data: unknown) => settle(data as T);
    conn.on('data', onData);
    conn.on('close', () => settle(null));
  });
}

function waitOpen(conn: DataConnection, timeoutMs: number): Promise<boolean> {
  if (conn.open) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    conn.on('open', () => { clearTimeout(timer); resolve(true); });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Matchmaker -------------------------------------------------------------

export class Matchmaker {
  onState?: (state: MMState, detail: string) => void;

  private scout?: Peer;
  private cancelled = false;

  private setState(state: MMState, detail = '') {
    this.onState?.(state, detail);
  }

  cancel() {
    this.cancelled = true;
    this.scout?.destroy();
  }

  /** Runs the full join sequence and resolves with a live match connection. */
  async find(bucket = 'c'): Promise<MatchResult> {
    this.scout = await createPeer();

    // 1. CONNECT pass — is anyone already waiting?
    const offer = await this.connectPass(bucket);
    if (offer) return this.linkAsClient(offer);
    if (this.cancelled) throw new Error('cancelled');

    // 2. JITTER — breaks symmetry when two clients arrive together.
    await sleep(Math.random() * 500);

    // 3. CLAIM pass — become the waiting host.
    this.setState('claiming', 'claiming a slot');
    const claim = await this.claimPass(bucket);

    // 4. WAIT, with a re-probe backstop.
    return this.waitAsHost(bucket, claim.slot, claim.peer);
  }

  private async connectPass(bucket: string) {
    for (let i = 1; i <= SLOTS; i++) {
      if (this.cancelled) throw new Error('cancelled');
      this.setState('probing', `probing slot ${i}/${SLOTS}`);
      const found = await this.probeSlot(bucket, i);
      if (found) return found;
    }
    return null;
  }

  /** Dial one slot. Returns the offer if a host was waiting there. */
  private async probeSlot(bucket: string, n: number) {
    const conn = await connectTo(this.scout!, slotId(bucket, n), CONNECT_TIMEOUT_MS);
    if (!conn) return null;

    const msg = await firstMessage<BeaconMsg>(conn, OFFER_TIMEOUT_MS);
    if (!msg || msg.t !== 'offer') {
      // 'busy' (host already matched) or silence (zombie id) — move along.
      try { conn.close(); } catch { /* ignore */ }
      return null;
    }
    return { conn, privateId: (msg as MsgOffer).id };
  }

  private async claimPass(bucket: string): Promise<{ slot: number; peer: Peer }> {
    for (let i = 1; i <= SLOTS; i++) {
      if (this.cancelled) throw new Error('cancelled');
      try {
        const peer = await createPeer(slotId(bucket, i));
        return { slot: i, peer };
      } catch (err) {
        const type = (err as { type?: string }).type;
        if (type === 'unavailable-id') continue; // someone beat us to it
        throw err;
      }
    }
    throw new Error('every slot is occupied — try again in a moment');
  }

  private waitAsHost(bucket: string, slot: number, beacon: Peer): Promise<MatchResult> {
    this.setState('waiting', `slot ${slot} · waiting for an opponent`);

    return new Promise<MatchResult>((resolve, reject) => {
      let settled = false;

      const reprobe = window.setInterval(async () => {
        if (settled) return;
        // Resolve the "two hosts, no clients" deadlock: if a peer is now
        // waiting on a lower slot, abandon our claim and go to them.
        for (let i = 1; i < slot; i++) {
          if (settled) return;
          const found = await this.probeSlot(bucket, i);
          if (found && !settled) {
            settled = true;
            clearInterval(reprobe);
            beacon.destroy();
            this.linkAsClient(found).then(resolve, reject);
            return;
          }
        }
      }, REPROBE_MS);

      beacon.on('connection', (conn) => {
        if (settled) {
          // Already matched — bounce them down the ladder.
          void waitOpen(conn, 2000).then((ok) => {
            if (ok) conn.send({ t: 'busy' } satisfies BeaconMsg);
            setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 250);
          });
          return;
        }
        settled = true;
        clearInterval(reprobe);
        this.handoffAsHost(beacon, conn).then(resolve, reject);
      });

      beacon.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearInterval(reprobe);
        reject(err);
      });
    });
  }

  /**
   * Move off the well-known slot onto a private channel, then free the slot.
   * This is what makes concurrency unbounded.
   */
  private async handoffAsHost(beacon: Peer, beaconConn: DataConnection): Promise<MatchResult> {
    this.setState('linking', 'opponent found · opening private channel');

    if (!(await waitOpen(beaconConn, CONNECT_TIMEOUT_MS))) {
      throw new Error('beacon connection never opened');
    }

    const priv = await createPeer();

    const matchConn = await new Promise<DataConnection>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('opponent never dialled back')),
        DIAL_BACK_TIMEOUT_MS,
      );
      priv.on('connection', (c) => {
        c.on('open', () => { clearTimeout(timer); resolve(c); });
      });
      beaconConn.send({ t: 'offer', id: priv.id } satisfies BeaconMsg);
    });

    // The real link is up — release the well-known slot for the next pair.
    beacon.destroy();
    this.scout?.destroy();
    this.scout = undefined;

    this.setState('matched', 'connected as host');
    return { peer: priv, conn: matchConn, role: 'host' };
  }

  /** We found a waiting host: take their private id and dial it. */
  private async linkAsClient(offer: { conn: DataConnection; privateId: string }): Promise<MatchResult> {
    this.setState('linking', 'opponent found · opening private channel');

    const scout = this.scout!;
    const conn = await connectTo(scout, offer.privateId, DIAL_BACK_TIMEOUT_MS);
    try { offer.conn.close(); } catch { /* ignore */ }

    if (!conn) throw new Error('could not reach the host private channel');

    this.setState('matched', 'connected as client');
    return { peer: scout, conn, role: 'client' };
  }
}
