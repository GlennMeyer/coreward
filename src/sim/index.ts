/**
 * Public surface of the sim core.
 *
 * Nothing under src/sim may import from src/ui, from a game engine, or from
 * the DOM. See docs/DESIGN.md §13.2 — this boundary is what makes the eventual
 * isometric renderer a swap instead of a rewrite.
 */
export * from './types';
export * from './data';
export * from './rng';
export * from './dungeon';
export * from './adventurers';
export * from './raid';
export * from './season';
