import { Effect } from './local-effect-lookalike.ts';

declare const items: readonly string[];
declare const run: (value: string) => unknown;

// No `effect` import in this module, so nothing here is an Effect fan-out.
export const each = Effect.forEach(items, run);
export const both = Effect.all([run('a'), run('b')]);
