import { Matchmaker, type MMState } from './net/matchmaker';
import { Match } from './game/match';
import { Renderer } from './render/renderer';
import type { FollowCamera } from './render/camera';
import { QUANT_ERROR_M } from './net/snapshot';
import { TICK_HZ } from './net/protocol';
import { EntState, type Input } from './sim/world';
import { zoneAt } from './content/maps';
import { ArmyUI, ROSTER_SIZE } from './ui/army';
import { PhaseUI } from './ui/phase';
import { BossUI } from './ui/boss';
import { ARMY_SLOTS, EGG_TIERS, HATCH_RADIUS } from './content/eggs';
import { EggState } from './sim/eggs';

const app = document.getElementById('app')!;
const lobby = document.getElementById('lobby')!;
const mmState = document.getElementById('mmState')!;
const mmDetail = document.getElementById('mmDetail')!;
const mmBar = document.getElementById('mmBar')!;
const hud = document.getElementById('hud')!;
const help = document.getElementById('help')!;

const LOBBY_COPY: Record<MMState, string> = {
  idle: 'Starting…',
  probing: '🔍 Looking for an opponent',
  claiming: '📡 Opening a match',
  waiting: '⏳ Waiting for an opponent',
  linking: '🤝 Opponent found',
  matched: '✅ Connected',
  failed: '⚠️ Could not connect',
};

function setLobby(state: MMState, detail: string) {
  mmState.textContent = LOBBY_COPY[state];
  mmDetail.textContent = detail;
  mmBar.classList.toggle('done', state === 'matched');
}

function fail(reason: string) {
  lobby.classList.remove('hidden');
  mmBar.classList.remove('done');
  mmState.innerHTML = `<span class="err">⚠️ ${reason}</span>`;
  mmDetail.textContent = 'Reload to try again.';
}

// --- input ------------------------------------------------------------------

const held = new Set<string>();
let debugOn = true;
/** Dev-only input override, driven by automated tests through __weg. */
let testInput: Input | null = null;

addEventListener('keydown', (e) => {
  if (e.code === 'F3') { debugOn = !debugOn; hud.hidden = !debugOn; e.preventDefault(); return; }
  if (e.code === 'Space') e.preventDefault(); // stop the page scrolling
  held.add(e.code);
});
addEventListener('keyup', (e) => held.delete(e.code));
addEventListener('blur', () => held.clear());

/**
 * Movement is camera-relative, and we rotate it into world space HERE, before
 * it goes on the wire. The simulation therefore never learns that cameras
 * exist, and the host does not need to track the client's view direction.
 */
function readInput(cam: FollowCamera): Input {
  if (testInput) return testInput;
  const f = cam.forward();
  const r = cam.right();
  let mx = 0;
  let mz = 0;

  if (held.has('KeyW') || held.has('ArrowUp')) { mx += f.x; mz += f.z; }
  if (held.has('KeyS') || held.has('ArrowDown')) { mx -= f.x; mz -= f.z; }
  if (held.has('KeyD') || held.has('ArrowRight')) { mx += r.x; mz += r.z; }
  if (held.has('KeyA') || held.has('ArrowLeft')) { mx -= r.x; mz -= r.z; }

  return { mx, mz, attack: held.has('Space') };
}

/**
 * Box selection and move orders.
 *
 * Left-drag selects, right-click sends the selection, E recalls. This is the
 * "leash + detach" model: the army trails you by default, and detaching a group
 * is a deliberate act — which is what makes the split in the design ("Group A
 * attacks, Group B defends") expressible without a full RTS control scheme.
 */
function wireArmyCommands(renderer: Renderer, match: Match, selected: Set<number>) {
  const box = document.getElementById('selectBox') as HTMLDivElement;
  let dragging = false;
  let sx = 0;
  let sy = 0;

  const canvas = document.querySelector('canvas');
  if (!canvas) return;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.altKey) return;
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    box.style.left = `${sx}px`;
    box.style.top = `${sy}px`;
    box.style.width = '0px';
    box.style.height = '0px';
    box.hidden = false;
  });

  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    box.style.left = `${Math.min(sx, e.clientX)}px`;
    box.style.top = `${Math.min(sy, e.clientY)}px`;
    box.style.width = `${Math.abs(e.clientX - sx)}px`;
    box.style.height = `${Math.abs(e.clientY - sy)}px`;
  });

  addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    box.hidden = true;

    const x0 = Math.min(sx, e.clientX);
    const x1 = Math.max(sx, e.clientX);
    const y0 = Math.min(sy, e.clientY);
    const y1 = Math.max(sy, e.clientY);

    selected.clear();
    // A click rather than a drag selects the whole army — the common case, and
    // far less fiddly than requiring a lasso every time.
    if (x1 - x0 < 6 && y1 - y0 < 6) {
      for (const u of match.myUnits()) {
        if (match.viewOf(u.id).state !== EntState.Dead) selected.add(u.id);
      }
      return;
    }
    for (const u of match.myUnits()) {
      const v = match.viewOf(u.id);
      if (v.state === EntState.Dead) continue;
      const p = renderer.projectToScreen(v.x, renderer.groundHeight(v.x, v.z) + 1, v.z);
      if (p.behind) continue;
      if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) selected.add(u.id);
    }
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const pt = renderer.cursorPoint;
    if (!pt) return;
    const ids = selected.size ? [...selected] : undefined;
    match.orderMove(pt.x, pt.z, ids);
  });

  addEventListener('keydown', (e) => {
    if (e.code !== 'KeyE') return;
    match.orderRecall(selected.size ? [...selected] : undefined);
  });
}

// --- boot -------------------------------------------------------------------

async function boot() {
  const mm = new Matchmaker();
  mm.onState = setLobby;
  setLobby('idle', '');

  let match: Match;
  try {
    const link = await mm.find('c');
    match = new Match(link, 'Player');
    await match.start();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }

  match.onFatal = (reason) => fail(reason);

  // The renderer needs the terrain, which only exists once the map is known —
  // the host picks it and the client learns it from START.
  const renderer = new Renderer(app, match.world.terrain, match.world.eggs);
  const armyUI = new ArmyUI(match);
  const phaseUI = new PhaseUI(match);
  const bossUI = new BossUI(match);
  renderer.attachStructures(match.structures(), match.side);
  const selected = new Set<number>();
  wireArmyCommands(renderer, match, selected);

  if (import.meta.env.DEV) {
    (globalThis as Record<string, unknown>)['__weg'] = {
      match,
      renderer,
      stats: () => match.stats(),
      self: () => match.viewSelf(),
      opponent: () => match.viewOpponent(),
      /** Override keyboard input; pass null to hand control back. */
      setTestInput: (i: Input | null) => { testInput = i; },
      armyUI,
    };
  }

  lobby.classList.add('hidden');
  hud.hidden = !debugOn;
  help.hidden = false;

  let lastHud = 0;

  const frame = () => {
    requestAnimationFrame(frame);

    // Units die, respawn under new ids, or get replaced out of the army, so the
    // selection has to be swept or it accumulates ids that no longer exist.
    if (selected.size) {
      for (const id of selected) {
        if (!match.world.ents.has(id)) selected.delete(id);
      }
    }

    match.localInput = readInput(renderer.follow);
    renderer.update(
      match.viewSelf(), match.viewOpponent(), match.world.eggs, match.stats().tick,
      match.units(), (id) => match.viewOf(id), match.side, selected,
      match.structures(), match.siegeOpen(), match.dragons(),
    );
    renderer.render();
    armyUI.update();
    phaseUI.update();
    bossUI.update();

    const now = performance.now();
    if (debugOn && now - lastHud > 100) {
      lastHud = now;
      hud.innerHTML = formatStats(match);
    }
  };
  requestAnimationFrame(frame);
}

function aliveCount(match: Match, side: number): number {
  let n = 0;
  for (const u of match.units()) {
    if (u.side !== side) continue;
    if (match.viewOf(u.id).state !== EntState.Dead) n++;
  }
  return n;
}

/** What egg you are standing on or nearest to — the core exploration readout. */
function nearestEggLine(match: Match, x: number, z: number): string {
  let best: { d: number; tier: string; progress: number; locked: boolean } | null = null;

  for (const egg of match.world.eggs) {
    if (egg.state === EggState.Consumed) continue;
    const d = Math.hypot(egg.x - x, egg.z - z);
    if (!best || d < best.d) {
      best = {
        d,
        tier: egg.tier,
        progress: egg.progress,
        locked: match.stats().tick < egg.unlockAtTick,
      };
    }
  }

  if (!best) return `egg       none left`;
  const glyph = EGG_TIERS[best.tier as keyof typeof EGG_TIERS].glyph;
  if (best.d <= HATCH_RADIUS) {
    if (best.locked) return `egg       ${glyph} <span class="warn">locked</span>`;
    return `egg       ${glyph} <span class="ok">hatching ${(best.progress * 100).toFixed(0)}%</span>`;
  }
  return `egg       ${glyph} ${best.tier} ${best.d.toFixed(0)}m${best.locked ? ' (locked)' : ''}`;
}

function formatStats(match: Match): string {
  const s = match.stats();
  const self = match.viewSelf();
  const total = s.inBps + s.outBps;
  const cls = (v: number, warn: number) => (v > warn ? 'warn' : 'ok');

  const hpFrac = self.hp / match.maxHp();
  const hpBar = '█'.repeat(Math.round(hpFrac * 10)).padEnd(10, '·');
  const dead = self.state === EntState.Dead;
  const respawn = match.respawnIn();

  const rows = [
    `<b>WILD EGG ROYALE</b>  M2 · ${match.map.name}`,
    ``,
    dead
      ? `<span class="warn">☠️ DOWN</span>  ${respawn < 0 ? 'respawning…' : `respawn in ${respawn.toFixed(1)}s`}`
      : `hp        <span class="${hpFrac > 0.3 ? 'ok' : 'warn'}">${hpBar}</span> ${Math.round(self.hp)}`,
    `zone      ${zoneAt(match.map, self.x)}`,
    `army      ${match.myArmy().length}/${ARMY_SLOTS}   roster ${ROSTER_SIZE}`,
    `units     ${aliveCount(match, match.side)} alive  vs ${aliveCount(match, match.side === 0 ? 1 : 0)}`,
    `eggs      you ${match.dragonEggsLeft(match.side)}  them ${match.dragonEggsLeft(match.side === 0 ? 1 : 0)}${match.siegeOpen() ? '' : '  (invulnerable)'}`,
    nearestEggLine(match, self.x, self.z),
    ``,
    `role      <b>${s.role}</b> (side ${s.side})`,
    `tick      ${s.tick}  @ ${TICK_HZ}Hz`,
    `rtt       <span class="${cls(s.rttMs, 150)}">${s.rttMs.toFixed(0)} ms</span>`,
    `snaps/s   ${s.snapsPerSec.toFixed(1)}`,
    `net total <span class="${cls(total, 30720)}">${(total / 1024).toFixed(2)} KB/s</span>`,
  ];

  if (s.role === 'client') {
    rows.push(
      `reconcile <span class="${cls(s.reconcileM, 0.5)}">${s.reconcileM.toFixed(3)} m</span>`,
      `tick lead ${s.tickLead > 0 ? '+' : ''}${s.tickLead}`,
    );
  }
  rows.push(``, `quant err ${(QUANT_ERROR_M * 1000).toFixed(1)} mm`);

  return rows.join('\n');
}

void boot();
