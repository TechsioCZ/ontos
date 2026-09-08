// expect-count: 2
// Audit B4 concerns collaborator wiring, not the scalar-only identity constructor below.
import { Effect, Layer } from 'effect';

/** B4 evidence: five positional collaborators, four of them already Context services. */
export const makeActionRuntime = (
  database: CoreDatabaseService,
  repository: ActionRepositoryService,
  permission: ActionPermissionService,
  operationalScopeResolver: OperationalScopeResolverService,
  options: ActionRuntimeOptions,
): ActionRuntimeService => ({
  runAction: (input: unknown) => Effect.succeed({ database, operationalScopeResolver, options, permission, repository, input }),
});

/** Same shape as a function declaration, with a defaulted option bag as the fifth parameter. */
export function makeReadRuntime(
  database: CoreDatabaseService,
  gateway: ModuleEntrypointGatewayService,
  scopeResolver: OperationalScopeResolverService,
  contextAccess: ContextAccessService,
  options: ReadRuntimeOptions = {},
) {
  return { contextAccess, database, gateway, options, scopeResolver };
}

/** Three scalar values are not proof of dependency injection (B4); this stays silent. */
const makeInvocationIdentity = (tenant: string, action: string, seed: string) => `${tenant}:${action}:${seed}`;

/** Allowed: the Effect-native target shape. The generator is a callback, not a named factory. */
export const ActionRuntimeLive = Layer.effect(
  ActionRuntime,
  Effect.gen(function* () {
    const database = yield* CoreDatabase;
    const repository = yield* ActionRepository;
    return makeActionRuntime(database, repository, repository, repository, {});
  }),
);

export const invocation = makeInvocationIdentity('t', 'a', 's');
