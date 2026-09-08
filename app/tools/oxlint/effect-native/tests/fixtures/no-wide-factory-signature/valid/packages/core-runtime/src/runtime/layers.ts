import { Effect, Layer } from 'effect';

/** The Effect-native target: collaborators come from Context, not from the parameter list. */
export const ActionRuntimeLive = Layer.effect(
  ActionRuntime,
  Effect.gen(function* () {
    const database = yield* CoreDatabase;
    const repository = yield* ActionRepository;
    const permission = yield* ActionPermission;
    const scopeResolver = yield* OperationalScopeResolver;
    return {
      runAction: (input: RunActionInput) =>
        Effect.succeed({ database, input, permission, repository, scopeResolver }),
    };
  }),
);

/** Narrow data constructors stay silent. */
export const makeModuleStateSnapshot = (rows: readonly ModuleStateRow[], now: DateTime) =>
  Object.freeze({ now, rows });

export const createTag = (name: string) => name;

export const defineAction = (descriptor: ActionDescriptor, handler: ActionHandler) => ({ descriptor, handler });

/** A pure config bag with no Effect body is a data constructor, not hidden dependency wiring. */
export const createPoolConfig = (options: DatabasePoolOptions) => ({
  max: options.max ?? 10,
  min: options.min ?? 1,
});

/** Callbacks have no factory identity: `Array#map`/`reduce` signatures must never be counted. */
export const makeRows = (items: readonly string[]) => items.map((value, index, all) => `${value}${index}${all.length}`);
export const makeTotal = (items: readonly number[]) => items.reduce((accumulator, value, index) => accumulator + value + index, 0);

/** Deliberate startup-root `Layer.orDie` — blessed by the audit and invisible to this rule. */
export const RootLive = Layer.orDie(ActionRuntimeLive);

/** Not a factory name: handlers, resolvers and hooks are never inspected. */
export const resolveOperationalScope = (tenant: string, module: string, action: string, principal: string) =>
  Effect.succeed({ action, module, principal, tenant });
