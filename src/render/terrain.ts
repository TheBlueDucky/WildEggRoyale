import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';
import { zoneAt, type ZoneKind } from '../content/maps';

/**
 * Builds the visible ground from the sim's heightfield.
 *
 * The mesh is display only — walkability lives in Terrain and is what the
 * simulation actually consults. Keeping those separate is what lets the
 * renderer get prettier (chunking, LODs, real textures) without any risk of
 * changing where players can walk.
 *
 * One mesh at 2m resolution for now (~8.8k quads). Chunking + frustum culling
 * land when maps grow or draw calls start mattering.
 */

const RESOLUTION = 2; // metres per quad

const ZONE_COLOR: Record<ZoneKind, THREE.Color> = {
  safe: new THREE.Color(0x2f4a37),
  wild: new THREE.Color(0x24382c),
  contested: new THREE.Color(0x4a3228),
};

export interface TerrainView {
  mesh: THREE.Mesh;
  boundaries: THREE.Group;
}

export function buildTerrain(terrain: Terrain): TerrainView {
  const map = terrain.map;
  const [w, h] = map.size;
  const segX = Math.round(w / RESOLUTION);
  const segZ = Math.round(h / RESOLUTION);

  const geo = new THREE.PlaneGeometry(w, h, segX, segZ);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const y = terrain.heightAt(x, z);
    pos.setY(i, y);

    // Zone tint, lifted slightly with elevation so relief reads at a glance.
    c.copy(ZONE_COLOR[zoneAt(map, x)]);
    const lift = Math.max(0, Math.min(1, y / map.maxHeight));
    c.lerp(new THREE.Color(0x7f9b6f), lift * 0.45);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({ vertexColors: true }),
  );
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  return { mesh, boundaries: buildBoundaries(terrain) };
}

/** Glowing lines where the zone bands meet, drawn along the terrain surface. */
function buildBoundaries(terrain: Terrain): THREE.Group {
  const map = terrain.map;
  const halfW = map.size[0] / 2;
  const group = new THREE.Group();

  const lines: Array<{ x: number; color: number }> = [
    { x: -map.zones.contestedHalfWidth, color: 0xd97070 },
    { x: map.zones.contestedHalfWidth, color: 0xd97070 },
    { x: -(halfW - map.zones.safeMargin), color: 0x6fbf7f },
    { x: halfW - map.zones.safeMargin, color: 0x6fbf7f },
  ];

  for (const { x, color } of lines) {
    const pts: THREE.Vector3[] = [];
    for (let z = -terrain.halfH; z <= terrain.halfH; z += 2) {
      pts.push(new THREE.Vector3(x, terrain.heightAt(x, z) + 0.15, z));
    }
    group.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
      ),
    );
  }

  return group;
}
