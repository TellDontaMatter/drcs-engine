/**
 * DRCS Engine public entry point.
 * Exports the domain types, the persistence layer, and the C1 gate.
 * (Gates C2–C8 are implemented in later blueprint sequence steps.)
 */
export * from './types';
export * as persistence from './persistence';
export * as c1 from './gates/c1';
