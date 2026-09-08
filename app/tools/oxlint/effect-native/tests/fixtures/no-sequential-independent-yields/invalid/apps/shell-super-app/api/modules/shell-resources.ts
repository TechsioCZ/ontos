// expect-count: 2
// Audit B1 evidence shape: shell search enriches from three independent sources one after another.
import { Effect } from "effect";

interface ShellContext {
  readonly tenantId: string;
  readonly principalId: string;
}

declare const gateway: {
  readonly prepareSnapshot: (context: ShellContext, ids: readonly string[]) => Effect.Effect<string>;
};
declare const moduleStates: {
  readonly get: (tenantId: string, ids: readonly string[]) => Effect.Effect<readonly string[]>;
};
declare const contextAccess: {
  readonly modules: (input: { readonly ids: readonly string[] }) => Effect.Effect<readonly string[]>;
};

export const enrich = (context: ShellContext, ids: readonly string[]) =>
  Effect.gen(function* shellSearchEffect() {
    const snapshot = yield* gateway.prepareSnapshot(context, ids);
    const states = yield* moduleStates.get(context.tenantId, ids);
    const permissions = yield* contextAccess.modules({ ids });
    return { permissions, snapshot, states };
  });
