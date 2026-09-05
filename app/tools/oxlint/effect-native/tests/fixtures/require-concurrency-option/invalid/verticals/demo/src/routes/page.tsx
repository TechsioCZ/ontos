// expect-count: 2
import { Effect } from 'effect';

declare const legalEntities: Effect.Effect<readonly string[]>;
declare const navigation: Effect.Effect<readonly string[]>;
declare const tenants: Effect.Effect<readonly string[]>;
declare const entries: readonly string[];
declare const render: (entry: string) => Effect.Effect<string>;

// A struct of three independent reads is still resolved one at a time.
export const model = Effect.all({ legalEntities, navigation, tenants });

// Unbounded fan-out from a route loader.
export const rows = Effect.forEach(entries, render, { concurrency: 'unbounded' });

export const Page = () => <div className="page">{String(model)}</div>;
