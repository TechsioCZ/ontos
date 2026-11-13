import { and, asc, eq, inArray } from 'drizzle-orm';
import { Clock, Context, DateTime, Effect, Layer, Match, Schema } from 'effect';

import { CoreDatabase } from '../db/client.ts';
import type { ActionAuthMethod } from '../db/schema.ts';
import { auditEvents, tenantModuleStateChanges, tenantModuleStates, tenants } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { InstalledModuleCatalog } from './catalog.ts';
import {
  tenantModuleInstallsWithClosure,
  tenantModuleIntrinsicDependencyClosure,
} from './module-dependency-contracts.ts';

import { unsatisfiedTenantModuleDependency as unsatisfiedDependency } from './tenant-module-state-unsatisfied-dependency-error.ts';
import type { OntosModuleId } from './manifest.ts';
import { OntosModuleIdSchema } from './manifest.ts';
import type { TenantModuleStateTransitionError } from './tenant-module-state-errors.ts';
import {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStatePersistenceUnavailableError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateTenantMissingError,
  TenantModuleStateUnchangedError,
  TenantModuleStateUnknownModuleError,
  TenantModuleStateUnsupportedChangeSourceError,
  TenantModuleStateUnsupportedStateError,
  TenantModuleStateValidationUnavailableError,
} from './tenant-module-state-errors.ts';

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

export const TENANT_MODULE_STATES = [
  'inactive',
  'active',
  'read_only',
  'suspended',
  'quarantined',
  'deprecated',
  'archived',
] as const;

export const TenantModuleStateSchema = Schema.Literals(TENANT_MODULE_STATES);
export type TenantModuleState = Schema.Schema.Type<typeof TenantModuleStateSchema>;

export const ActiveTenantModuleSchema = Schema.Struct({
  moduleKey: OntosModuleIdSchema,
  state: Schema.Literal('active'),
});
export type ActiveTenantModule = Schema.Schema.Type<typeof ActiveTenantModuleSchema>;

export const TenantModuleStateRecordSchema = Schema.Struct({
  moduleKey: OntosModuleIdSchema,
  state: TenantModuleStateSchema,
});
export type TenantModuleStateRecord = Schema.Schema.Type<typeof TenantModuleStateRecordSchema>;

const TenantModuleStateChangeSourceSchema = Schema.Literals(['support', 'system', 'user']);
export type TenantModuleStateChangeSource = typeof TenantModuleStateChangeSourceSchema.Type;

export const validateTenantModuleStateTransition = (
  catalog: InstalledModuleCatalog,
  moduleKey: OntosModuleId,
  newState: TenantModuleState,
): Effect.Effect<void, TenantModuleStateUnknownModuleError | TenantModuleStateUnsupportedStateError> => {
  if (newState === 'inactive') {
    return Effect.void;
  }
  const contract = catalog.getByModuleId(moduleKey);
  if (contract === undefined) {
    return Effect.fail(
      new TenantModuleStateUnknownModuleError({
        code: 'tenant_module_state_module_unknown',
        reason: 'The requested OntOS module is not installed',
      }),
    );
  }
  if (!contract.manifest.activation.supportedStates.includes(newState)) {
    return Effect.fail(
      new TenantModuleStateUnsupportedStateError({
        code: 'tenant_module_state_unsupported',
        reason: 'The requested state is not supported by the installed module',
      }),
    );
  }
  return Effect.void;
};

const transitionValidationUnavailable = (cause: unknown) => {
  const error = new TenantModuleStateValidationUnavailableError({
    code: 'tenant_module_state_validation_unavailable',
    reason: 'Tenant module transition validation is temporarily unavailable',
  });
  Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  return error;
};

/** Decode the single locked batch before distinguishing definite absence from indeterminate data. */
export const validateTenantModuleIntrinsicDependencyStates = Effect.fn(
  'TenantModuleState.validateIntrinsicDependencyStates',
)(function* validateIntrinsicDependencyStates(
  dependencies: readonly string[],
  rows: readonly { readonly moduleKey: string; readonly state: unknown }[],
) {
  const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(TenantModuleStateRecordSchema))(rows).pipe(
    Effect.mapError(transitionValidationUnavailable),
  );
  const states = new Map(decoded.map(({ moduleKey, state }) => [moduleKey, state]));
  const expected = new Set(dependencies);
  if (states.size !== decoded.length || decoded.some(({ moduleKey }) => !expected.has(moduleKey))) {
    return yield* transitionValidationUnavailable('Contradictory dependency state evidence');
  }
  if (dependencies.some((dependency) => states.get(dependency) !== 'active')) {
    return yield* unsatisfiedDependency();
  }
  return yield* Effect.void;
});

export const resolveTenantModuleStateChangeSource = (
  authMethod: ActionAuthMethod,
): Effect.Effect<TenantModuleStateChangeSource, TenantModuleStateUnsupportedChangeSourceError> =>
  Match.value(authMethod).pipe(
    Match.when('session', () => Effect.succeed('user' as const)),
    Match.when('support_impersonation', () => Effect.succeed('support' as const)),
    Match.when('system', () => Effect.succeed('system' as const)),
    Match.when('api_key', () =>
      Effect.fail(
        new TenantModuleStateUnsupportedChangeSourceError({
          code: 'tenant_module_state_change_source_unsupported',
          reason: 'This authentication method cannot change tenant module state',
        }),
      ),
    ),
    Match.when('oauth_connection', () =>
      Effect.fail(
        new TenantModuleStateUnsupportedChangeSourceError({
          code: 'tenant_module_state_change_source_unsupported',
          reason: 'This authentication method cannot change tenant module state',
        }),
      ),
    ),
    Match.exhaustive,
  );

export const rejectUnchangedTenantModuleState = (
  previousState: TenantModuleState | null,
  newState: TenantModuleState,
): Effect.Effect<void, TenantModuleStateUnchangedError> =>
  previousState === newState
    ? Effect.fail(
        new TenantModuleStateUnchangedError({
          code: 'tenant_module_state_unchanged',
          reason: 'The tenant module already has the requested state',
        }),
      )
    : Effect.void;

export interface TenantModuleStateServiceContract {
  readonly getTenantModuleStates: (
    tenantId: string,
    moduleKeys: readonly string[],
  ) => Effect.Effect<readonly TenantModuleStateRecord[], TenantModuleStateReadUnavailableError>;
  readonly listActiveTenantModules: (
    tenantId: string,
  ) => Effect.Effect<readonly ActiveTenantModule[], TenantModuleStateReadUnavailableError>;
  readonly listTenantModuleStates: (
    tenantId: string,
  ) => Effect.Effect<readonly TenantModuleStateRecord[], TenantModuleStateReadUnavailableError>;
}

export class TenantModuleStateService extends Context.Service<
  TenantModuleStateService,
  TenantModuleStateServiceContract
>()('@app/core-runtime/modules/tenant-module-state-service/TenantModuleStateService') {}

const tenantModuleStateReadUnavailable = (cause?: unknown) =>
  new TenantModuleStateReadUnavailableError({
    cause,
    code: 'tenant_module_state_read_unavailable',
    reason: 'Tenant module state is temporarily unavailable',
  });

const decodeRows = (rows: readonly { readonly moduleKey: string; readonly state: unknown }[]) =>
  Effect.forEach(
    rows,
    (row: (typeof rows)[number]) =>
      Schema.decodeUnknownEffect(TenantModuleStateSchema)(row.state).pipe(
        Effect.map((state) => Object.freeze({ moduleKey: row.moduleKey, state })),
        Effect.mapError(tenantModuleStateReadUnavailable),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((records) => Object.freeze(records)));

export const makeTenantModuleStateService = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): TenantModuleStateServiceContract => {
  const listTenantModuleStates = (tenantId: string) =>
    database.executor
      .select({
        moduleKey: tenantModuleStates.moduleKey,
        state: tenantModuleStates.state,
      })
      .from(tenantModuleStates)
      .where(eq(tenantModuleStates.tenantId, tenantId))
      .orderBy(asc(tenantModuleStates.moduleKey))
      .pipe(Effect.mapError(tenantModuleStateReadUnavailable), Effect.flatMap(decodeRows));

  return {
    getTenantModuleStates: (tenantId, moduleKeys) => {
      const distinctKeys = [...new Set(moduleKeys)].toSorted();
      if (distinctKeys.length === 0) {
        return Effect.succeed(Object.freeze([]));
      }
      return database.executor
        .select({
          moduleKey: tenantModuleStates.moduleKey,
          state: tenantModuleStates.state,
        })
        .from(tenantModuleStates)
        .where(and(eq(tenantModuleStates.tenantId, tenantId), inArray(tenantModuleStates.moduleKey, distinctKeys)))
        .orderBy(asc(tenantModuleStates.moduleKey))
        .pipe(Effect.mapError(tenantModuleStateReadUnavailable), Effect.flatMap(decodeRows));
    },
    listActiveTenantModules: (tenantId) =>
      listTenantModuleStates(tenantId).pipe(
        Effect.map((rows) =>
          rows.flatMap((row) =>
            row.state === 'active' ? [{ moduleKey: row.moduleKey, state: 'active' as const }] : [],
          ),
        ),
      ),
    listTenantModuleStates,
  };
};

export const TenantModuleStateServiceLive = Layer.effect(
  TenantModuleStateService,
  CoreDatabase.pipe(Effect.map(makeTenantModuleStateService)),
);

export interface PersistTenantModuleStateChangeInput {
  readonly actionInvocationId: string;
  /** How the person was signed in, as the Action's own audit record names it; each module installed with it is
   * audited for the same person, the same way. */
  readonly actor: Pick<
    OperationalScope,
    'authBindingId' | 'authContextRef' | 'impersonatedByPrincipalId' | 'legalEntityId'
  >;
  readonly authMethod: ActionAuthMethod;
  readonly catalog: InstalledModuleCatalog;
  /** The composition revision the change ran against, named in the audit record of each module installed with it. */
  readonly compositionRevision: string;
  readonly expectedState?: TenantModuleState;
  readonly moduleKey: string;
  readonly newState: TenantModuleState;
  readonly principalId: string;
  readonly reason?: string;
  readonly tenantId: string;
}

export interface PersistTenantModuleStateChangeResult {
  /** The modules installed `active` with this one in the same transaction (its `installsWith` the Tenant lacked). */
  readonly installedWith: readonly string[];
  readonly moduleKey: string;
  readonly newState: TenantModuleState;
  readonly previousState: TenantModuleState | null;
}

const persistenceUnavailable = (cause?: unknown) => {
  const error = new TenantModuleStatePersistenceUnavailableError({
    code: 'tenant_module_state_persistence_unavailable',
    reason: 'Tenant module state could not be persisted',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

/** The audit event of a module a person's activation installed with another (its manifest's `installsWith`). */
export const TENANT_MODULE_INSTALLED_WITH_EVENT = 'core.modules.tenant-module-installed-with';

export const persistTenantModuleStateChange = Effect.fn('TenantModuleStateService.persistTenantModuleStateChange')(
  function* persistTenantModuleStateChangeEffect(
    transaction: ScopedTransactionExecutor,
    input: PersistTenantModuleStateChangeInput,
  ): Effect.fn.Return<PersistTenantModuleStateChangeResult, TenantModuleStateTransitionError> {
    const { changeSource, tenantRows } = yield* resolveTenantModuleStateChangeSource(input.authMethod).pipe(
      Effect.flatMap((resolvedChangeSource) =>
        transaction
          .select({ tenantId: tenants.tenantId })
          .from(tenants)
          .where(eq(tenants.tenantId, input.tenantId))
          .for('update')
          .pipe(
            Effect.mapError(persistenceUnavailable),
            Effect.map((lockedTenantRows) => ({
              changeSource: resolvedChangeSource,
              tenantRows: lockedTenantRows,
            })),
          ),
      ),
    );
    const [tenant] = tenantRows;
    if (tenant === undefined) {
      return yield* new TenantModuleStateTenantMissingError({
        code: 'tenant_module_state_tenant_missing',
        reason: 'The tenant required for this state change does not exist',
      });
    }

    // The tenant row lock serializes every state mutation, including provider deactivation.
    // Resolve the trusted revision's closure and read its states inside this same transaction.
    yield* validateTenantModuleStateTransition(input.catalog, input.moduleKey, input.newState);
    // Activation installs the modules the manifest names in `installsWith` that the Tenant has no state for yet; a
    // state somebody set is left exactly as set.
    const companions =
      input.newState === 'active' ? yield* tenantModuleInstallsWithClosure(input.catalog, input.moduleKey) : [];
    const presentCompanions =
      companions.length === 0
        ? []
        : yield* transaction
            .select({ moduleKey: tenantModuleStates.moduleKey })
            .from(tenantModuleStates)
            .where(
              and(eq(tenantModuleStates.tenantId, input.tenantId), inArray(tenantModuleStates.moduleKey, companions)),
            )
            .pipe(Effect.mapError(persistenceUnavailable));
    const present = new Set(presentCompanions.map(({ moduleKey }) => moduleKey));
    const installedWith = companions.filter((moduleKey) => !present.has(moduleKey));
    if (input.newState === 'active' || input.newState === 'read_only') {
      const closures = yield* Effect.forEach(
        [input.moduleKey, ...installedWith],
        (moduleKey) => tenantModuleIntrinsicDependencyClosure(input.catalog, moduleKey),
        { concurrency: 1 },
      );
      // A module installed in this same transaction satisfies a dependency on it.
      const dependencies = [...new Set(closures.flat())]
        .filter((moduleKey) => moduleKey !== input.moduleKey && !installedWith.includes(moduleKey))
        .toSorted();
      if (dependencies.length > 0) {
        const dependencyRows = yield* transaction
          .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
          .from(tenantModuleStates)
          .where(
            and(eq(tenantModuleStates.tenantId, input.tenantId), inArray(tenantModuleStates.moduleKey, dependencies)),
          )
          .pipe(Effect.mapError(persistenceUnavailable));
        yield* validateTenantModuleIntrinsicDependencyStates(dependencies, dependencyRows);
      }
    }

    const currentRows = yield* transaction
      .select({
        state: tenantModuleStates.state,
        tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
      })
      .from(tenantModuleStates)
      .where(and(eq(tenantModuleStates.tenantId, input.tenantId), eq(tenantModuleStates.moduleKey, input.moduleKey)))
      .pipe(Effect.mapError(persistenceUnavailable));
    const [current] = currentRows;
    const previousState =
      current === undefined
        ? null
        : yield* Schema.decodeUnknownEffect(TenantModuleStateSchema)(current.state).pipe(
            Effect.mapError(persistenceUnavailable),
          );
    const effectivePreviousState = previousState ?? 'inactive';
    if (input.expectedState !== undefined && input.expectedState !== effectivePreviousState) {
      return yield* new TenantModuleStateConcurrentChangeError({
        code: 'tenant_module_state_changed_concurrently',
        reason: 'The tenant module state changed after it was read',
      });
    }
    yield* rejectUnchangedTenantModuleState(previousState, input.newState);
    const currentTimeMillis = yield* Clock.currentTimeMillis;
    const changedAt = DateTime.toDateUtc(DateTime.makeUnsafe(currentTimeMillis));

    const historyRows = yield* transaction
      .insert(tenantModuleStateChanges)
      .values(
        withOptionalProperty(
          {
            actionInvocationId: input.actionInvocationId,
            changedByPrincipalId: input.principalId,
            changeSource,
            moduleKey: input.moduleKey,
            newState: input.newState,
            occurredAt: changedAt,
            previousState,
          },
          input.reason !== undefined,
          'reason',
          input.reason,
          {
            tenantId: input.tenantId,
          },
        ),
      )
      .returning({
        moduleStateChangeId: tenantModuleStateChanges.moduleStateChangeId,
      })
      .pipe(Effect.mapError(persistenceUnavailable));
    const [history] = historyRows;
    if (history === undefined) {
      return yield* persistenceUnavailable();
    }

    if (current === undefined) {
      const inserted = yield* transaction
        .insert(tenantModuleStates)
        .values({
          lastChangeId: history.moduleStateChangeId,
          moduleKey: input.moduleKey,
          state: input.newState,
          tenantId: input.tenantId,
          updatedAt: changedAt,
        })
        .returning({
          tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
        })
        .pipe(Effect.mapError(persistenceUnavailable));
      const [insertedState] = inserted;
      if (insertedState === undefined) {
        return yield* persistenceUnavailable();
      }
    } else {
      const updated = yield* transaction
        .update(tenantModuleStates)
        .set({
          lastChangeId: history.moduleStateChangeId,
          state: input.newState,
          updatedAt: changedAt,
        })
        .where(eq(tenantModuleStates.tenantModuleStateId, current.tenantModuleStateId))
        .returning({
          tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
        })
        .pipe(Effect.mapError(persistenceUnavailable));
      if (updated[0] === undefined) {
        return yield* persistenceUnavailable();
      }
    }

    yield* Effect.forEach(
      installedWith,
      Effect.fnUntraced(function* installCompanion(moduleKey) {
        const [companionHistory] = yield* transaction
          .insert(tenantModuleStateChanges)
          .values({
            actionInvocationId: input.actionInvocationId,
            changedByPrincipalId: input.principalId,
            changeSource,
            moduleKey,
            newState: 'active',
            occurredAt: changedAt,
            previousState: null,
            reason: `Installed with ${input.moduleKey}`,
            tenantId: input.tenantId,
          })
          .returning({ moduleStateChangeId: tenantModuleStateChanges.moduleStateChangeId })
          .pipe(Effect.mapError(persistenceUnavailable));
        if (companionHistory === undefined) {
          return yield* persistenceUnavailable();
        }
        yield* transaction
          .insert(tenantModuleStates)
          .values({
            lastChangeId: companionHistory.moduleStateChangeId,
            moduleKey,
            state: 'active',
            tenantId: input.tenantId,
            updatedAt: changedAt,
          })
          .pipe(Effect.mapError(persistenceUnavailable));
        // Audited as the release audits a module it installs with another: its own sensitive record, critical, in
        // this transaction, by the person whose Action installed it. No secret is recorded.
        return yield* transaction
          .insert(auditEvents)
          .values({
            actionInvocationId: input.actionInvocationId,
            auditProfile: 'sensitive',
            authBindingId: input.actor.authBindingId,
            authContextRef: input.actor.authContextRef,
            authMethod: input.authMethod,
            eventType: TENANT_MODULE_INSTALLED_WITH_EVENT,
            evidenceJson: {
              compositionRevision: input.compositionRevision,
              installedWith: input.moduleKey,
              moduleKey,
              newState: 'active',
              previousState: null,
              risk: 'critical',
            },
            impersonatedByPrincipalId: input.actor.impersonatedByPrincipalId,
            legalEntityId: input.actor.legalEntityId,
            outcome: 'succeeded',
            outcomeCode: 'module_installed',
            outcomeStage: 'execution',
            principalId: input.principalId,
            targetModuleKey: moduleKey,
            targetResourceId: moduleKey,
            targetResourceType: 'tenant-module-state',
            tenantId: input.tenantId,
          })
          .pipe(Effect.mapError(persistenceUnavailable), Effect.asVoid);
      }),
      { concurrency: 1, discard: true },
    );

    return {
      installedWith,
      moduleKey: input.moduleKey,
      newState: input.newState,
      previousState,
    };
  },
);

export { tenantModuleIntrinsicDependencyClosure } from './module-dependency-contracts.ts';
