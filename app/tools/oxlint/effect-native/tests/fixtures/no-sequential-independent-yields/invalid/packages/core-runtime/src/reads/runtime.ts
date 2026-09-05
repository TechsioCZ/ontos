// expect-count: 3
// Direct member import (`import { gen } from "effect/Effect"`) and a re-export barrel binding.
import { gen } from 'effect/Effect';
import { Effect } from '@modern-js/plugin-bff/effect-edge';

declare const database: { readonly rows: (id: string) => unknown };
declare const entrypointGateway: { readonly fetchProjection: (id: string) => unknown };
declare const scopeResolver: { readonly resolveFor: (id: string) => unknown };

export const read = gen(function* () {
  const rows = yield* database.rows('a');
  const projection = yield* entrypointGateway.fetchProjection('b');
  const scope = yield* scopeResolver.resolveFor('c');
  return { projection, rows, scope };
});

export const barrelRead = Effect.gen(function* () {
  const rows = yield* database.rows('a');
  const projection = yield* entrypointGateway.fetchProjection('b');
  return { projection, rows };
});
