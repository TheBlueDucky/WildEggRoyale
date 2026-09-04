import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { Ent } from '../sim/units';
import { EntState } from '../sim/units';
import { DragonPhase } from '../sim/dragon';

/**
 * The dragon.
 *
 * Built from primitives like everything else, but deliberately given the
 * largest silhouette in the game and a shadow that tracks it across the ground.
 * The arrival is supposed to be the moment both players stop what they are
 * doing, and it cannot be that if it reads as another unit.
 */

const FRIEND = 0x8ee6a1;
const ENEMY = 0xff6b6b;

interface DragonVisual {
  group: THREE.Group;
  wingL: THREE.Mesh;
  wingR: THREE.Mesh;
  body: THREE.Mesh;
  shadow: THREE.Mesh;
  aura: THREE.Mesh;
}

export class DragonField {
  readonly root = new THREE.Group();
  private readonly visuals = new Map<number, DragonVisual>();

  constructor(private readonly terrain: Terrain, private readonly mySide: number) {}

  private build(d: Ent): DragonVisual {
    const group = new THREE.Group();
    const hostile = d.side !== this.mySide;
    const color = hostile ? ENEMY : FRIEND;

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(1.5, 5.5, 6, 12),
      new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.18 }),
    );
    body.rotation.x = Math.PI / 2;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(
      new THREE.ConeGeometry(1.2, 3.2, 7),
      new THREE.MeshLambertMaterial({ color: 0xf0d98c }),
    );
    head.rotation.x = Math.PI / 2;
    head.position.z = 4.6;
    group.add(head);

    const wingGeo = new THREE.BoxGeometry(7.5, 0.25, 3.4);
    const wingMat = new THREE.MeshLambertMaterial({
      color, transparent: true, opacity: 0.85, side: THREE.DoubleSide,
    });
    const wingL = new THREE.Mesh(wingGeo, wingMat);
    wingL.position.set(-4.2, 0.4, 0);
    group.add(wingL);
    const wingR = new THREE.Mesh(wingGeo, wingMat);
    wingR.position.set(4.2, 0.4, 0);
    group.add(wingR);

    // Enrage glow, toggled by phase.
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(6.5, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0xff4422, transparent: true, opacity: 0.0,
        depthWrite: false, side: THREE.BackSide,
      }),
    );
    group.add(aura);

    // A ground shadow so the dragon's position is readable even when the
    // camera is low and it is high overhead.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(5, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }),
    );
    shadow.rotation.x = -Math.PI / 2;

    this.root.add(group, shadow);
    const v: DragonVisual = { group, wingL, wingR, body, shadow, aura };
    this.visuals.set(d.id, v);
    return v;
  }

  update(dragons: Ent[], timeMs: number) {
    const live = new Set<number>();

    for (const d of dragons) {
      live.add(d.id);
      const v = this.visuals.get(d.id) ?? this.build(d);

      if (d.state === EntState.Dead) {
        v.group.visible = false;
        v.shadow.visible = false;
        continue;
      }

      const ground = this.terrain.heightAt(d.x, d.z);
      v.group.visible = true;
      v.shadow.visible = true;
      v.group.position.set(d.x, ground + d.altitude, d.z);
      v.group.rotation.y = d.yaw;

      // Faster, harder wingbeat once enraged.
      const enraged = d.phase === DragonPhase.Enraged;
      const beat = Math.sin(timeMs / (enraged ? 110 : 190)) * (enraged ? 0.75 : 0.5);
      v.wingL.rotation.z = beat;
      v.wingR.rotation.z = -beat;

      (v.aura.material as THREE.MeshBasicMaterial).opacity = enraged
        ? 0.16 + Math.sin(timeMs / 130) * 0.06
        : 0;

      v.shadow.position.set(d.x, ground + 0.1, d.z);
      // The shadow shrinks with altitude, which sells the descent.
      const s = Math.max(0.35, 1 - d.altitude / 70);
      v.shadow.scale.setScalar(s);
      (v.shadow.material as THREE.MeshBasicMaterial).opacity = 0.32 * s;
    }

    for (const [id, v] of this.visuals) {
      if (live.has(id)) continue;
      v.group.visible = false;
      v.shadow.visible = false;
    }
  }
}
