import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import { EggState, type Egg } from '../sim/eggs';
import { EGG_TIERS } from '../content/eggs';

/**
 * Egg visuals.
 *
 * The map's whole information layer. Tier colour and pillar height are how a
 * player reads the board at a glance and decides whether a trek into the
 * contested zone is worth it — a Legendary's 22m gold pillar is visible across
 * the map ON PURPOSE, because both players seeing it is what starts the fight.
 */

const PILLAR_SEGMENTS = 8;

interface EggVisual {
  group: THREE.Group;
  shell: THREE.Mesh;
  barBack: THREE.Sprite;
  barFill: THREE.Sprite;
  pillar?: THREE.Mesh;
  locked: boolean;
}

export class EggField {
  private readonly visuals = new Map<number, EggVisual>();
  readonly root = new THREE.Group();

  constructor(eggs: Egg[], private readonly terrain: Terrain) {
    for (const egg of eggs) this.root.add(this.build(egg).group);
  }

  private build(egg: Egg): EggVisual {
    const tier = EGG_TIERS[egg.tier];
    const group = new THREE.Group();
    const y = this.terrain.heightAt(egg.x, egg.z);
    group.position.set(egg.x, y, egg.z);

    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 14, 12),
      new THREE.MeshLambertMaterial({ color: tier.color, emissive: tier.color, emissiveIntensity: 0.25 }),
    );
    shell.scale.set(1, 1.32, 1);
    shell.position.y = 0.72;
    shell.castShadow = true;
    group.add(shell);

    let pillar: THREE.Mesh | undefined;
    if (tier.pillarHeight > 0) {
      pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.75, 0.75, tier.pillarHeight, PILLAR_SEGMENTS, 1, true),
        new THREE.MeshBasicMaterial({
          color: tier.color,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      pillar.position.y = tier.pillarHeight / 2;
      group.add(pillar);
    }

    // Hatch progress bar, hidden until someone actually starts channelling.
    const barBack = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x11161d, depthTest: false }));
    barBack.center.set(0, 0.5);
    barBack.scale.set(2.0, 0.24, 1);
    barBack.position.set(-1.0, 2.1, 0);
    barBack.renderOrder = 20;
    barBack.visible = false;
    group.add(barBack);

    const barFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xf0d98c, depthTest: false }));
    barFill.center.set(0, 0.5);
    barFill.scale.set(0, 0.18, 1);
    barFill.position.set(-0.95, 2.1, 0);
    barFill.renderOrder = 21;
    barFill.visible = false;
    group.add(barFill);

    const visual: EggVisual = { group, shell, barBack, barFill, pillar, locked: false };
    this.visuals.set(egg.id, visual);
    return visual;
  }

  /** @param tick current sim tick, for lock state and idle animation. */
  update(eggs: Egg[], tick: number, timeMs: number) {
    for (const egg of eggs) {
      const v = this.visuals.get(egg.id);
      if (!v) continue;

      if (egg.state === EggState.Consumed) {
        v.group.visible = false;
        continue;
      }

      const locked = tick < egg.unlockAtTick;
      v.group.visible = true;

      // Locked eggs are visible but inert — you can see the prize in the
      // contested zone from minute one and have to wait for it.
      if (locked !== v.locked) {
        v.locked = locked;
        const mat = v.shell.material as THREE.MeshLambertMaterial;
        mat.emissiveIntensity = locked ? 0.02 : 0.25;
        mat.opacity = locked ? 0.5 : 1;
        mat.transparent = locked;
        if (v.pillar) (v.pillar.material as THREE.MeshBasicMaterial).opacity = locked ? 0.05 : 0.16;
      }

      // Gentle bob so eggs read as interactive rather than as scenery.
      v.shell.position.y = 0.72 + Math.sin(timeMs / 600 + egg.id) * 0.06;

      const channelling = egg.progress > 0.001;
      v.barBack.visible = channelling;
      v.barFill.visible = channelling;
      if (channelling) {
        v.barFill.scale.x = 1.9 * Math.min(1, egg.progress);
        (v.barFill.material as THREE.SpriteMaterial).color.setHex(
          egg.channeler === 0 ? 0x6fbf7f : 0xd97070,
        );
      }
    }
  }
}
