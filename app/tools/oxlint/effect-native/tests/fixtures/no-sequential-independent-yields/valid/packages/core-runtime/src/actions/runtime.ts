// The audit S1 target pipeline `lock -> validate -> install scope -> recheck -> commit`. Every step
// names its ordering, so the sequence is declared rather than accidental.
import { Effect } from 'effect';

declare const repository: {
  readonly lockInvocation: (id: string) => Effect.Effect<string>;
  readonly recheckState: (id: string) => Effect.Effect<string>;
  readonly commitInvocation: (id: string) => Effect.Effect<string>;
  readonly persistOutcome: (id: string) => Effect.Effect<string>;
};
declare const resolver: { readonly resolve: (id: string) => Effect.Effect<string> };
declare const scopes: { readonly installScope: (id: string) => Effect.Effect<string> };
declare const guard: { readonly validateTransport: (id: string) => Effect.Effect<string> };

export const transaction = (id: string) =>
  Effect.gen(function* () {
    const locked = yield* repository.lockInvocation(id);
    const transport = yield* guard.validateTransport(id);
    const scope = yield* scopes.installScope(id);
    const resolved = yield* resolver.resolve(id);
    const rechecked = yield* repository.recheckState(id);
    const committed = yield* repository.commitInvocation(id);
    const persisted = yield* repository.persistOutcome(id);
    return { committed, locked, persisted, rechecked, resolved, scope, transport };
  });
