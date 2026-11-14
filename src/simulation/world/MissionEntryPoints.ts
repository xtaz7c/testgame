import type { GridMap } from './GridMap';
import type { TilePosition } from './WorldConfig';

export interface MissionEntryPoint {
  readonly id: string;
  readonly kind: 'door' | 'window';
  readonly approachTile: TilePosition;
  readonly breachTile: TilePosition;
  readonly structurePosition: { readonly x: number; readonly y: number };
}

/**
 * Approach cells are outside the blocked entrance rectangles in mission-01.tmj.
 * The map grid is checked at runtime so invalid/blocked approaches are excluded.
 */
export const MISSION_ENTRY_POINTS: readonly MissionEntryPoint[] = Object.freeze([
  {
    id: 'front-door',
    kind: 'door',
    approachTile: { column: 60, row: 54 },
    breachTile: { column: 60, row: 52 },
    structurePosition: { x: 1920, y: 1712 },
  },
  {
    id: 'north-window-west',
    kind: 'window',
    approachTile: { column: 55, row: 35 },
    breachTile: { column: 55, row: 37 },
    structurePosition: { x: 1760, y: 1168 },
  },
  {
    id: 'north-window-east',
    kind: 'window',
    approachTile: { column: 64, row: 35 },
    breachTile: { column: 63, row: 37 },
    structurePosition: { x: 2048, y: 1168 },
  },
  {
    id: 'west-window',
    kind: 'window',
    approachTile: { column: 49, row: 44 },
    breachTile: { column: 51, row: 44 },
    structurePosition: { x: 1616, y: 1408 },
  },
  {
    id: 'east-window',
    kind: 'window',
    approachTile: { column: 70, row: 44 },
    breachTile: { column: 68, row: 44 },
    structurePosition: { x: 2224, y: 1408 },
  },
]);

export function getAvailableEntryPoints(map: GridMap): MissionEntryPoint[] {
  return MISSION_ENTRY_POINTS.filter((point) => map.isWalkable(point.approachTile));
}
