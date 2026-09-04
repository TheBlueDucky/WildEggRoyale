import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { Ent } from '../sim/units';
import { EntState } from '../sim/units';
import type { View } from '../game/match';
import { ANIMALS } from '../content/animals';
import { RARITY_CSS } from '../content/eggs';

/**
 * Instanced animal rendering.
 *
 * One InstancedMesh PER ANIMAL TYPE, not per unit: twenty wolves are one draw
 * call. This is not a later optimisation — with two armies of ten plus a dragon
 * and structures to come, per-unit meshes would blow the draw-call budget on
 * integrated graphics before the game is even finished.
 *
 * Health bars and selection rings are drawn separately and only for units that
 * need them, since those are the parts that cannot be instanced cheaply.
 */

const MAX_PER_TYPE = 24;
const BODY = new THREE.CapsuleGeometry(0.42, 0.62, 4, 8);
const FLYER = new THREE.ConeGeometry(0.45, 1.1, 6);

interface TypeBatch {
  mesh: THREE.InstancedMesh;
  count: number;
}

export class UnitField {
  readonly root = new THREE.Group();

  private readonly batches = new Map<number, TypeBatch>();
  private readonly dummy = new THREE.Object3D();
  private readonly color = new THREE.Color();

  private readonly bars: THREE.Sprite[] = [];
  private readonly rings: THREE.Mesh[] = [];
  private barPool = 0;
  private ringPool = 0;

  constructor(private readonly terrain: Terrain) {
    for (let i = 0; i < ANIMALS.length; i++) {
      const def = ANIMALS[i]!;
      const mesh = new THREE.InstancedMesh(
        def.flying ? FLYER : BODY,
        new THREE.MeshLambertMaterial({ color: new THREE.Color(RARITY_CSS[def.rarity]) }),
        MAX_PER_TYPE,
      );
      mesh.castShadow = true;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE * 3), 3);
      this.batches.set(i, { mesh, count: 0 });
      this.root.add(mesh);
    }

    for (let i = 0; i < MAX_PER_TYPE * 2; i++) {
      const bar = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x6fbf7f, depthTest: false }));
      bar.center.set(0, 0.5);
      bar.renderOrder = 12;
      bar.visible = false;
      this.bars.push(bar);
      this.root.add(bar);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.55, 0.7, 12),
        new THREE.MeshBasicMaterial({ color: 0xf0d98c, transparent: true, opacity: 0.85 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.rings.push(ring);
      this.root.add(ring);
    }
  }

  /**
   * @param units    every animal on the field
   * @param viewOf   interpolated transform lookup
   * @param mySide   which side gets the friendly tint
   * @param selected ids currently box-selected
   */
  update(
    units: Ent[],
    viewOf: (id: number) => View,
    mySide: number,
    selected: ReadonlySet<number>,
  ) {
    for (const b of this.batches.values()) b.count = 0;
    this.barPool = 0;
    this.ringPool = 0;

    for (const u of units) {
      const v = viewOf(u.id);
      if (v.state === EntState.Dead) continue;

      const batch = this.batches.get(u.animal);
      if (!batch || batch.count >= MAX_PER_TYPE) continue;

      const y = this.terrain.heightAt(v.x, v.z);
      const def = ANIMALS[u.animal];
      const lift = def?.flying ? 3.2 : 0;

      this.dummy.position.set(v.x, y + lift + 0.55, v.z);
      this.dummy.rotation.set(0, v.yaw, 0);
      // Scale reads HP tier at a glance — a Golem should look like a Golem.
      const s = 0.75 + Math.min(1, (def?.hp ?? 100) / 2000) * 0.9;
      this.dummy.scale.setScalar(s);
      this.dummy.updateMatrix();
      batch.mesh.setMatrixAt(batch.count, this.dummy.matrix);

      // Friend/foe tint on top of the rarity base colour.
      this.color.set(u.side === mySide ? 0x9fe8ae : 0xe89f9f);
      batch.mesh.setColorAt(batch.count, this.color);
      batch.count++;

      if (v.hp < u.maxHp * 0.999) this.placeBar(v, y + lift, u.maxHp);
      if (selected.has(u.id)) this.placeRing(v, y);
    }

    for (const b of this.batches.values()) {
      b.mesh.count = b.count;
      b.mesh.instanceMatrix.needsUpdate = true;
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
    }
    for (let i = this.barPool; i < this.bars.length; i++) this.bars[i]!.visible = false;
    for (let i = this.ringPool; i < this.rings.length; i++) this.rings[i]!.visible = false;
  }

  private placeBar(v: View, y: number, maxHp: number) {
    const bar = this.bars[this.barPool];
    if (!bar) return;
    this.barPool++;
    const frac = Math.max(0, Math.min(1, v.hp / maxHp));
    bar.visible = true;
    bar.position.set(v.x - 0.6, y + 2.0, v.z);
    bar.scale.set(1.2 * frac, 0.14, 1);
    (bar.material as THREE.SpriteMaterial).color.setHex(
      frac > 0.5 ? 0x6fbf7f : frac > 0.25 ? 0xd9b070 : 0xd97070,
    );
  }

  private placeRing(v: View, y: number) {
    const ring = this.rings[this.ringPool];
    if (!ring) return;
    this.ringPool++;
    ring.visible = true;
    ring.position.set(v.x, y + 0.06, v.z);
  }
}
