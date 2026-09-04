import * as THREE from 'three';
import type { Terrain } from '../sim/terrain';

/**
 * Elevated third-person follow camera with orbit and zoom.
 *
 * Also the source of truth for "which way is forward": movement is
 * camera-relative, and the client rotates its input into world space before
 * sending it. The simulation therefore never needs to know a camera exists —
 * which is what keeps sim/ headless.
 */

const MIN_PITCH = 0.28;
const MAX_PITCH = 1.35;
const MIN_DIST = 12;
const MAX_DIST = 55;
/** Keep the camera this far above the ground so hills never clip through. */
const GROUND_CLEARANCE = 2.5;

export class FollowCamera {
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 900);

  yaw = 0;
  pitch = 0.78;
  distance = 30;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly target = new THREE.Vector3();

  attach(dom: HTMLElement) {
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    dom.addEventListener('pointerdown', (e) => {
      // Middle button (or Alt+left) orbits. Left drag box-selects and right
      // click issues orders, which is what an RTS player's hands expect.
      const orbiting = e.button === 1 || (e.button === 0 && e.altKey);
      if (!orbiting) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    });

    dom.addEventListener('pointerup', (e) => {
      this.dragging = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    });

    dom.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.005;
      this.pitch = clamp(this.pitch - (e.clientY - this.lastY) * 0.004, MIN_PITCH, MAX_PITCH);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });

    dom.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.distance = clamp(this.distance + Math.sign(e.deltaY) * 2.5, MIN_DIST, MAX_DIST);
      },
      { passive: false },
    );
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(x: number, y: number, z: number, terrain: Terrain) {
    this.target.set(x, y + 1.4, z);

    const horiz = Math.cos(this.pitch) * this.distance;
    const camX = x + Math.sin(this.yaw) * horiz;
    const camZ = z + Math.cos(this.yaw) * horiz;
    let camY = y + Math.sin(this.pitch) * this.distance + 1.4;

    // Never let a hill swallow the camera.
    const ground = terrain.heightAt(camX, camZ) + GROUND_CLEARANCE;
    if (camY < ground) camY = ground;

    this.camera.position.set(camX, camY, camZ);
    this.camera.lookAt(this.target);
  }

  /** Unit vector pointing away from the camera, flattened onto the ground. */
  forward(): { x: number; z: number } {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  /** Unit vector pointing to the camera's right, flattened onto the ground. */
  right(): { x: number; z: number } {
    return { x: -Math.cos(this.yaw), z: Math.sin(this.yaw) };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
