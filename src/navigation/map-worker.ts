import { upstreamRoot } from '../runtime-paths.ts';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { distance, samples, splitRoute, validTile } from './geometry';
import { QUEST_DANGER_ZONES } from './quest-hazards';
const upstream = upstreamRoot();
const map = await import(pathToFileURL(resolve(upstream, 'sdk/pathfinding.ts')).href);
const rsmod = await import(pathToFileURL(resolve(upstream, 'server/vendor/rsmod-pathfinder/rsmod-pathfinder.js')).href);
map.initPathfinding();
// Confirmed live danger on 2026-09-07: Draynor dark wizards killed Stinger
// at (3087,3237). Keep a conservative exclusion around their observed spawns.
// Approach the southern net spot from the south/east, not through the wizards.
for (let x = 3076; x <= 3092; x++) for (let z = 3233; z <= 3247; z++) {
  rsmod.changeLoc(x, z, 0, 1, 1, false, false, true);
}
const hash = createHash('sha256').update(readFileSync(resolve(upstream, 'sdk/collision-data.json'))).digest('hex');
// Reuse the SDK's cached JSON module rather than retain another million-tile
// parse in each of the three planner workers.
const collision = (await import(pathToFileURL(resolve(upstream, 'sdk/collision-data.json')).href)).default;
const coveredZones = new Set(collision.zones.map(([level, x, z]: number[]) => `${level},${x >> 3},${z >> 3}`));
// The collision export omits this source-confirmed diagonal door. It blocks a
// tile (shape 9), not a wall edge, so ordinary changeWall unmasking cannot help.
// Plan conditionally through its CLOSED footprint and avoid its OPEN footprint.
// The normal executor must still observe/open the actual door before crossing.
const questDoors = [{ x:3107, z:3162, level:0, shape:9, angle:3, blockrange:true }];
rsmod.changeLoc(3107, 3162, 0, 1, 1, true, false, false);
rsmod.changeLoc(3106, 3162, 0, 1, 1, true, false, true);
function doorCollision(door: any, add: boolean) {
  if (door.shape === 9) rsmod.changeLoc(door.x, door.z, door.level, 1, 1, door.blockrange, false, add);
  else rsmod.changeWall(door.x, door.z, door.level, door.angle, door.shape, door.blockrange, false, add);
}
self.onmessage = ({ data: { id, from, to, blocked = [], interaction, questTravel=false } }) => {
  const addedFloors: {x:number,z:number}[]=[];
  try {
    if (!validTile(from) || !validTile(to)) throw new Error('invalid-goal');
    if (from.level !== to.level) throw new Error('transition-required');
    if(questTravel && from.level===0) {
      // Agent-only safety constraint. Never alter exported/server collision or
      // ordinary combat routes. Preserve pre-existing floor flags on cleanup.
      for(const h of QUEST_DANGER_ZONES)for(let x=h.minX;x<=h.maxX;x++)for(let z=h.minZ;z<=h.maxZ;z++) {
        if(!rsmod.isFlagged(x,z,0,rsmod.CollisionFlag.FLOOR)) {
          rsmod.changeFloor(x,z,0,true);addedFloors.push({x,z});
        }
      }
    }
    if (blocked.some((d: any) => d.x===3107 && d.z===3162 && d.level===0)) throw new Error('quest-door-blocked');
    const turns = map.findLongPath(from.level, from.x, from.z, to.x, to.z, 500, blocked);
    if (distance(turns.at(-1) ?? from, to)) throw new Error('partial-path');
    let previous = from, unmappedTiles = 0;
    const legs = splitRoute(from, turns).map(target => {
      const tiles = samples(previous, target);
      for (const t of tiles) if (!coveredZones.has(`${t.level},${t.x >> 3},${t.z >> 3}`)) unmappedTiles++;
      // A nearby gate is not necessarily crossed. Restore its wall temporarily
      // and test the exact edges of this segment, then restore the shared map.
      const doors = [...map.findDoorsAlongPath(tiles), ...questDoors.filter(d => tiles.some(t => distance(t,d)<=3))].filter((door: any) => {
        const legal = tiles.slice(1).map((t, i) => rsmod.canTravel(t.level, tiles[i]!.x, tiles[i]!.z, t.x - tiles[i]!.x, t.z - tiles[i]!.z, 1, 0, rsmod.CollisionType.NORMAL));
        doorCollision(door, true);
        try {
          return tiles.slice(1).some((t, i) => legal[i] && !rsmod.canTravel(t.level, tiles[i]!.x, tiles[i]!.z, t.x - tiles[i]!.x, t.z - tiles[i]!.z, 1, 0, rsmod.CollisionType.NORMAL));
        } finally { doorCollision(door, false); }
      });
      previous = target;
      return { target, doors };
    });
    const interactionValid = interaction ? rsmod.reached(to.level, to.x, to.z, interaction.x, interaction.z, interaction.width, interaction.height, 1, interaction.angle, interaction.shape, 0) : undefined;
    self.postMessage({ id, legs, hash, unmappedTiles, interactionValid });
  } catch (error) { self.postMessage({ id, error: String(error) }); }
  finally { for(const t of addedFloors)rsmod.changeFloor(t.x,t.z,0,false); }
};
self.postMessage({ ready: true, hash });
