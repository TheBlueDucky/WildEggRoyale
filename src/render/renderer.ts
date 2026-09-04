import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import type { View } from '../game/match';
import { EntState, PLAYER_MAX_HP } from '../sim/world';
import { FollowCamera } from './camera';
import { buildTerrain } from './terrain';
import { CastleField } from './castle';
import { DragonField } from './dragon';
import { EggField } from './eggs';
import { UnitField } from './units';
import type { Egg } from '../sim/eggs';
import type { Ent } from '../sim/units';

/**
 * The view layer. Reads state, owns none of it.
 *
 * Characters sit on the ground via terrain.heightAt() rather than a simulated
 * y — that is the 2.5D decision paying off: the wire carries x/z only and the
 * ground is reconstructed locally.
 */

const SELF_COLOR = 0x6fbf7f;
const OPPONENT_COLOR = 0xd97070;

interface Character {
  group: THREE.Group;
  body: THREE.Mesh;
  hpFill: THREE.Sprite;
  hpBack: THREE.Sprite;
}

function makeCharacter(color: number): Character {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.6, 1.1, 6, 14),
    new THREE.MeshLambertMaterial({ color }),
  );
  body.position.y = 1.15;
  body.castShadow = true;
  group.add(body);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.8, 10),
    new THREE.MeshLambertMaterial({ color: 0xf0d98c }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 1.15, 0.85);
  group.add(nose);

  // Health bar as two sprites: sprites always face the camera, so there is no
  // per-frame billboarding maths to get wrong. center.x = 0 anchors the fill
  // on the left so it drains rather than shrinking towards the middle.
  const hpBack = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1b222c, depthTest: false }));
  hpBack.center.set(0, 0.5);
  hpBack.scale.set(2.2, 0.26, 1);
  hpBack.position.set(-1.1, 2.7, 0);
  hpBack.renderOrder = 10;
  group.add(hpBack);

  const hpFill = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x6fbf7f, depthTest: false }));
  hpFill.center.set(0, 0.5);
  hpFill.scale.set(2.1, 0.2, 1);
  hpFill.position.set(-1.05, 2.7, 0);
  hpFill.renderOrder = 11;
  group.add(hpFill);

  return { group, body, hpFill, hpBack };
}

export class Renderer {
  readonly follow = new FollowCamera();

  private readonly scene = new THREE.Scene();
  private readonly gl: THREE.WebGLRenderer;
  private readonly self = makeCharacter(SELF_COLOR);
  private readonly opponent = makeCharacter(OPPONENT_COLOR);
  private readonly cursor: THREE.Mesh;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2(0, 0);
  private readonly terrainMesh: THREE.Mesh;

  /** Ground point under the mouse, or null when the cursor is off-terrain. */
  cursorPoint: THREE.Vector3 | null = null;

  private readonly eggField: EggField;
  private readonly unitField: UnitField;
  private castleField?: CastleField;
  private dragonField?: DragonField;

  constructor(container: HTMLElement, private readonly terrain: Terrain, eggs: Egg[]) {
    this.scene.background = new THREE.Color(0x0b0e13);
    this.scene.fog = new THREE.Fog(0x0b0e13, 90, 300);

    this.gl = new THREE.WebGLRenderer({ antialias: true });
    this.gl.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.gl.domElement);

    const { mesh, boundaries } = buildTerrain(terrain);
    this.terrainMesh = mesh;
    this.scene.add(mesh, boundaries);

    this.scene.add(new THREE.HemisphereLight(0x9fc4e8, 0x1a2430, 1.0));
    const sun = new THREE.DirectionalLight(0xffe9c4, 1.6);
    sun.position.set(60, 110, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 320;
    const s = 90;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s });
    sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun);

    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.95, 24),
      new THREE.MeshBasicMaterial({ color: 0xf0d98c, transparent: true, opacity: 0.7 }),
    );
    this.cursor.rotation.x = -Math.PI / 2;
    this.scene.add(this.cursor);

    this.eggField = new EggField(eggs, terrain);
    this.scene.add(this.eggField.root);

    this.unitField = new UnitField(terrain);
    this.scene.add(this.unitField.root);

    this.scene.add(this.self.group, this.opponent.group);

    this.follow.attach(this.gl.domElement);
    this.gl.domElement.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    });

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Structures are known only once the match world exists. */
  attachStructures(structures: Ent[], mySide: number) {
    this.castleField = new CastleField(structures, this.terrain, mySide);
    this.scene.add(this.castleField.root);
    this.dragonField = new DragonField(this.terrain, mySide);
    this.scene.add(this.dragonField.root);
  }

  resize() {
    this.gl.setSize(innerWidth, innerHeight);
    this.follow.resize(innerWidth, innerHeight);
  }

  update(
    self: View,
    opponent: View,
    eggs: Egg[],
    tick: number,
    units: Ent[] = [],
    viewOf: (id: number) => View = () => self,
    mySide = 0,
    selected: ReadonlySet<number> = EMPTY_SELECTION,
    structures: Ent[] = [],
    siegeOpen = false,
    dragons: Ent[] = [],
  ) {
    const now = performance.now();
    this.eggField.update(eggs, tick, now);
    this.unitField.update(units, viewOf, mySide, selected);
    this.castleField?.update(structures, viewOf, siegeOpen, now);
    this.dragonField?.update(dragons, now);
    this.place(this.self, self);
    this.place(this.opponent, opponent);

    this.follow.update(self.x, this.terrain.heightAt(self.x, self.z), self.z, this.terrain);

    // Ground raycast for the cursor ring. M3 uses this for move orders.
    this.raycaster.setFromCamera(this.pointer, this.follow.camera);
    const hit = this.raycaster.intersectObject(this.terrainMesh, false)[0];
    if (hit) {
      this.cursorPoint = hit.point;
      this.cursor.position.copy(hit.point).setY(hit.point.y + 0.08);
      this.cursor.visible = true;
    } else {
      this.cursorPoint = null;
      this.cursor.visible = false;
    }
  }

  private place(ch: Character, v: View) {
    const dead = v.state === EntState.Dead;
    ch.group.visible = !dead;
    if (dead) return;

    ch.group.position.set(v.x, this.terrain.heightAt(v.x, v.z), v.z);
    ch.group.rotation.y = v.yaw;

    const frac = Math.max(0, Math.min(1, v.hp / PLAYER_MAX_HP));
    ch.hpFill.scale.x = 2.1 * frac;
    (ch.hpFill.material as THREE.SpriteMaterial).color.setHex(
      frac > 0.5 ? 0x6fbf7f : frac > 0.25 ? 0xd9b070 : 0xd97070,
    );
    ch.hpFill.visible = frac > 0;
  }

  render() {
    this.gl.render(this.scene, this.follow.camera);
  }

  /** World point -> screen pixels, for box selection. */
  projectToScreen(x: number, y: number, z: number): { x: number; y: number; behind: boolean } {
    PROJ.set(x, y, z).project(this.follow.camera);
    return {
      x: (PROJ.x * 0.5 + 0.5) * innerWidth,
      y: (-PROJ.y * 0.5 + 0.5) * innerHeight,
      behind: PROJ.z > 1,
    };
  }

  groundHeight(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }
}

const PROJ = new THREE.Vector3();
const EMPTY_SELECTION: ReadonlySet<number> = new Set<number>();
