import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { Ent } from '../sim/units';
import { EntState } from '../sim/units';
import { StructKind } from '../sim/structures';
import type { View } from '../game/match';

/**
 * Castles, towers and Dragon Eggs.
 *
 * Built once from the deterministic structure list and then only updated —
 * positions never change, so per-frame work is limited to health bars,
 * destruction state, and the pulse on a Dragon Egg that is still invulnerable.
 */

const FRIEND = 0x6fbf7f;
const ENEMY = 0xd97070;

interface StructVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  barBack: THREE.Sprite;
  barFill: THREE.Sprite;
  shield?: THREE.Mesh;
  kind: StructKind;
  maxHp: number;
}

export class CastleField {
  readonly root = new THREE.Group();
  private readonly visuals = new Map<number, StructVisual>();

  constructor(structures: Ent[], private readonly terrain: Terrain, private readonly mySide: number) {
    for (const st of structures) this.build(st);
  }

  private build(st: Ent) {
    const group = new THREE.Group();
    const y = this.terrain.heightAt(st.x, st.z);
    group.position.set(st.x, y, st.z);
    group.rotation.y = st.yaw;

    const friendly = st.side === this.mySide;
    const accent = friendly ? FRIEND : ENEMY;

    let body: THREE.Mesh;
    let shield: THREE.Mesh | undefined;
    let barY = 4;

    if (st.struct === StructKind.Castle) {
      body = new THREE.Mesh(
        new THREE.CylinderGeometry(5.5, 7, 11, 8),
        new THREE.MeshLambertMaterial({ color: 0x59616e }),
      );
      body.position.y = 5.5;
      const banner = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 5, 3.4),
        new THREE.MeshBasicMaterial({ color: accent }),
      );
      banner.position.y = 13.5;
      group.add(banner);
      barY = 16;
    } else if (st.struct === StructKind.Tower) {
      body = new THREE.Mesh(
        new THREE.CylinderGeometry(1.5, 2.0, 7, 6),
        new THREE.MeshLambertMaterial({ color: 0x6b7280 }),
      );
      body.position.y = 3.5;
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(2.2, 2.0, 6),
        new THREE.MeshLambertMaterial({ color: accent }),
      );
      cap.position.y = 8;
      group.add(cap);
      barY = 9.6;
    } else {
      // Dragon Egg: the objective, so it gets the loudest read on the board.
      body = new THREE.Mesh(
        new THREE.SphereGeometry(1.5, 18, 14),
        new THREE.MeshLambertMaterial({ color: 0x8b3a3a, emissive: 0x571c1c, emissiveIntensity: 0.5 }),
      );
      body.scale.set(1, 1.35, 1);
      body.position.y = 2.0;

      // A visible bubble while invulnerable — the 4:00 gate has to be legible
      // or players will just think their attacks are broken.
      shield = new THREE.Mesh(
        new THREE.SphereGeometry(2.4, 16, 12),
        new THREE.MeshBasicMaterial({
          color: 0x9fc4e8, transparent: true, opacity: 0.18,
          depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      shield.position.y = 2.0;
      group.add(shield);
      barY = 5.2;
    }

    body.castShadow = true;
    group.add(body);

    const barBack = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x11161d, depthTest: false }));
    barBack.center.set(0, 0.5);
    barBack.scale.set(3.0, 0.3, 1);
    barBack.position.set(-1.5, barY, 0);
    barBack.renderOrder = 14;
    group.add(barBack);

    const barFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: accent, depthTest: false }));
    barFill.center.set(0, 0.5);
    barFill.scale.set(2.9, 0.24, 1);
    barFill.position.set(-1.45, barY, 0);
    barFill.renderOrder = 15;
    group.add(barFill);

    this.visuals.set(st.id, { group, body, barBack, barFill, shield, kind: st.struct, maxHp: st.maxHp });
    this.root.add(group);
  }

  update(structures: Ent[], viewOf: (id: number) => View, siegeOpen: boolean, timeMs: number) {
    for (const st of structures) {
      const v = this.visuals.get(st.id);
      if (!v) continue;

      const view = viewOf(st.id);
      const dead = view.state === EntState.Dead;
      v.group.visible = !dead;
      if (dead) continue;

      const frac = Math.max(0, Math.min(1, view.hp / st.maxHp));
      v.barFill.scale.x = 2.9 * frac;
      (v.barFill.material as THREE.SpriteMaterial).color.setHex(
        frac > 0.5 ? 0x6fbf7f : frac > 0.25 ? 0xd9b070 : 0xd97070,
      );
      // The keep has no damage model yet, so a full bar would be a lie.
      const showBar = v.kind !== StructKind.Castle;
      v.barBack.visible = showBar;
      v.barFill.visible = showBar;

      if (v.shield) {
        v.shield.visible = !siegeOpen;
        if (!siegeOpen) {
          const pulse = 1 + Math.sin(timeMs / 420 + st.id) * 0.04;
          v.shield.scale.setScalar(pulse);
        }
        const mat = v.body.material as THREE.MeshLambertMaterial;
        mat.emissiveIntensity = siegeOpen ? 0.5 + Math.sin(timeMs / 300) * 0.12 : 0.12;
      }
    }
  }
}
