import { Effect } from 'effect';

declare const rows: readonly string[];
declare const insert: (row: string) => Effect.Effect<void>;

// Operational scripts are audit B3 territory; this rule stays out of `scripts/` by default.
export const seed = Effect.forEach(rows, insert);
