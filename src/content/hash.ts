import { MAPS } from './maps';
import { ANIMALS } from './animals';
import { ABILITIES, ANIMAL_ABILITY } from './abilities';

/**
 * Content bundle identity.
 *
 * Both peers hash their loaded content and compare it during the HELLO
 * handshake. In a data-driven game this check is not optional — a one-line
 * difference in animals.json is the single most likely cause of "why is my
 * client showing something different", and it is almost impossible to diagnose
 * after the fact. Fail loudly at connect time instead.
 *
 * Maps matter most of all: the simulation derives walkability from terrain, so
 * two peers on different map data would predict different collisions and
 * silently desync. Add each new content file here as it lands; the hash then
 * changes automatically with any edit.
 */
export const CONTENT_BUNDLE = {
  bundleVersion: 'm3',
  animals: ANIMALS,
  eggs: [] as unknown[],
  abilities: { defs: ABILITIES, byAnimal: ANIMAL_ABILITY },
  maps: MAPS,
};

let cached: string | undefined;

export async function contentHash(): Promise<string> {
  if (cached) return cached;
  const bytes = new TextEncoder().encode(JSON.stringify(CONTENT_BUNDLE));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  cached = Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return cached;
}
