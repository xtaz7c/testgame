/**
 * Dimensões e conversões do mundo da primeira missão.
 *
 * O mundo usa uma grade ortogonal. Coordenadas de mundo são medidas em
 * pixels lógicos; coordenadas de célula são inteiros com origem no canto
 * superior esquerdo. Os limites máximos são exclusivos.
 */

export const WORLD_CONFIG = Object.freeze({
  /** Largura e altura do mapa em células. */
  columns: 120,
  rows: 90,
  /** Tamanho de cada célula em pixels lógicos. */
  tileSize: 32,
  /** Resolução lógica configurada no Phaser. */
  viewportWidth: 1920,
  viewportHeight: 1080,
});

export const WORLD_WIDTH = WORLD_CONFIG.columns * WORLD_CONFIG.tileSize;
export const WORLD_HEIGHT = WORLD_CONFIG.rows * WORLD_CONFIG.tileSize;

export interface TilePosition {
  readonly column: number;
  readonly row: number;
}

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
}

/** Retorna true quando a posição está dentro dos limites do mundo. */
export function isInsideWorld(position: WorldPosition): boolean {
  return (
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < WORLD_WIDTH &&
    position.y < WORLD_HEIGHT
  );
}

/**
 * Converte coordenadas de mundo em célula.
 * Retorna null para posições fora do mapa ou valores não finitos.
 */
export function worldToTile(position: WorldPosition): TilePosition | null {
  if (!isInsideWorld(position)) return null;

  return {
    column: Math.floor(position.x / WORLD_CONFIG.tileSize),
    row: Math.floor(position.y / WORLD_CONFIG.tileSize),
  };
}

/** Retorna o centro em pixels lógicos de uma célula válida. */
export function tileToWorldCenter(tile: TilePosition): WorldPosition | null {
  if (
    !Number.isInteger(tile.column) ||
    !Number.isInteger(tile.row) ||
    tile.column < 0 ||
    tile.row < 0 ||
    tile.column >= WORLD_CONFIG.columns ||
    tile.row >= WORLD_CONFIG.rows
  ) {
    return null;
  }

  const halfTile = WORLD_CONFIG.tileSize / 2;

  return {
    x: tile.column * WORLD_CONFIG.tileSize + halfTile,
    y: tile.row * WORLD_CONFIG.tileSize + halfTile,
  };
}
