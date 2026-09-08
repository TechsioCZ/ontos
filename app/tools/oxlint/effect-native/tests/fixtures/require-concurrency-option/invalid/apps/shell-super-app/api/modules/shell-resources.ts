// expect-count: 2
import { Effect } from 'effect';

declare const dependencies: {
  readonly contextAccess: {
    readonly modules: (input: { readonly moduleIds: readonly string[] }) => Effect.Effect<readonly string[]>;
  };
  readonly issueAssertion: (input: { readonly appId: string }) => Effect.Effect<string>;
  readonly moduleStates: {
    readonly getTenantModuleStates: (
      tenantId: string,
      moduleIds: readonly string[],
    ) => Effect.Effect<readonly string[]>;
  };
};
declare const gateway: {
  readonly search: (input: {
    readonly appId: string;
    readonly authorization: string;
  }) => Effect.Effect<string>;
};
declare const moduleIds: readonly string[];
declare const eligible: readonly { readonly appId: string }[];

export const searchShellResources = Effect.gen(function* shellResourceSearch() {
  // Audit B1 evidence shape (`shell-resources.ts:191`): two independent reads, run one after the other.
  const [states, permissions] = yield* Effect.all([
    dependencies.moduleStates.getTenantModuleStates('tenant', moduleIds),
    dependencies.contextAccess.modules({ moduleIds }),
  ]);
  // Audit B1 evidence shape (`shell-resources.ts:236`): every eligible provider searched sequentially.
  const attempts = yield* Effect.forEach(eligible, (provider) =>
    dependencies
      .issueAssertion({ appId: provider.appId })
      .pipe(
        Effect.flatMap((authorization) => gateway.search({ appId: provider.appId, authorization })),
      ),
  );
  return { attempts, permissions, states };
});
