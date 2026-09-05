import { fresh } from 'effect/Layer';

// Re-exporting is a declaration site, not a use.
export { fresh };

// Type members that happen to be named `fresh` are not references to the import.
export interface CacheEntry { fresh: boolean }
export type CacheShape = { fresh: string };
export interface CacheOps { fresh(value: number): void }
declare function withParameter(fresh: number): void;
export const paramProof = withParameter;
export const record = { fresh: 1 };
export const read = record.fresh;
export const indexed = record['fresh'];
export type Keyed = CacheEntry['fresh'];
