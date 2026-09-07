import { and, asc, eq, inArray } from 'drizzle-orm';
import { Clock, Context, DateTime, Effect, Layer, Match, Schema } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import { tenantModuleStateChanges, tenantModuleStates, tenants } from '../db/schema.ts';
import type { ActionAuthMethod } from '../db/schema.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { CoreDatabaseExecutor } from '../db/types.ts';
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Pure Effect adapter constructor with no service dependencies; expires: 2027-03-01.
import { makePersistenceAttempt } from '../persistence/attempt.ts';
import {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStatePersistenceUnavailableError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateTenantMissingError,
  TenantModuleStateUnchangedError,
  TenantModuleStateUnknownModuleError,
  TenantModuleStateUnsupportedChangeSourceError,
  TenantModuleStateUnsupportedStateError,
} from './tenant-module-state-errors.ts';
import type { TenantModuleStateTransitionError } from './tenant-module-state-errors.ts';
import type { InstalledModuleCatalog } from './catalog.ts';
import { OntosModuleIdSchema } from './manifest.ts';
import type { OntosModuleId } from './manifest.ts';

const withOptionalProperty = <
  Base extends object,
  Key extends PropertyKey,
  Value,
  Trailing extends object,
>(
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

export const TenantModuleStateChangeSourceSchema = Schema.Literals(['support', 'system', 'user']);
export type TenantModuleStateChangeSource = typeof TenantModuleStateChangeSourceSchema.Type;

export const validateTenantModuleStateTransition = (
  catalog: InstalledModuleCatalog,
  moduleKey: OntosModuleId,
  newState: TenantModuleState,
): Effect.Effect<
  void,
  TenantModuleStateUnknownModuleError | TenantModuleStateUnsupportedStateError
> => {
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

const tenantModuleStateReadUnavailable = (cause?: unknown) => {
  const error = new TenantModuleStateReadUnavailableError({
    code: 'tenant_module_state_read_unavailable',
    reason: 'Tenant module state is temporarily unavailable',
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { configurable: true, value: cause });
  }
  return error;
};

const attemptTenantModuleStateRead = <Value>(operation: () => PromiseLike<Value>) =>
  makePersistenceAttempt(tenantModuleStateReadUnavailable)(operation).pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError(tenantModuleStateReadUnavailable),
  );

export const makeTenantModuleStateService = (database: {
  readonly executor: Pick<CoreDatabaseExecutor, 'select'>;
}): TenantModuleStateServiceContract => {
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

  const listTenantModuleStates = (tenantId: string) =>
    attemptTenantModuleStateRead(() =>
      database.executor
        .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
        .from(tenantModuleStates)
        .where(eq(tenantModuleStates.tenantId, tenantId))
        .orderBy(asc(tenantModuleStates.moduleKey)),
    ).pipe(Effect.flatMap(decodeRows));

  return {
    getTenantModuleStates: (tenantId, moduleKeys) => {
      const distinctKeys = [...new Set(moduleKeys)].toSorted();
      if (distinctKeys.length === 0) {
        return Effect.succeed(Object.freeze([]));
      }
      return attemptTenantModuleStateRead(() =>
        database.executor
          .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
          .from(tenantModuleStates)
          .where(
            and(
              eq(tenantModuleStates.tenantId, tenantId),
              inArray(tenantModuleStates.moduleKey, distinctKeys),
            ),
          )
          .orderBy(asc(tenantModuleStates.moduleKey)),
      ).pipe(Effect.flatMap(decodeRows));
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
  readonly authMethod: ActionAuthMethod;
  readonly expectedState?: TenantModuleState;
  readonly moduleKey: string;
  readonly newState: TenantModuleState;
  readonly principalId: string;
  readonly reason?: string;
  readonly tenantId: string;
}

export interface PersistTenantModuleStateChangeResult {
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

const attemptPersistence = <Value>(operation: () => PromiseLike<Value>) =>
  makePersistenceAttempt(persistenceUnavailable)(operation).pipe(
    Effect.timeout('30 seconds'),
    Effect.mapError(persistenceUnavailable),
  );

export const persistTenantModuleStateChange = Effect.fn(
  'TenantModuleStateService.persistTenantModuleStateChange',
)(function* persistTenantModuleStateChangeEffect(
  transaction: ScopedTransactionExecutor,
  input: PersistTenantModuleStateChangeInput,
): Effect.fn.Return<PersistTenantModuleStateChangeResult, TenantModuleStateTransitionError> {
  const { changeSource, tenantRows } = yield* resolveTenantModuleStateChangeSource(
    input.authMethod,
  ).pipe(
    Effect.flatMap((resolvedChangeSource) =>
      attemptPersistence(() =>
        transaction
          .select({ tenantId: tenants.tenantId })
          .from(tenants)
          .where(eq(tenants.tenantId, input.tenantId))
          .for('update'),
      ).pipe(
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

  const currentRows = yield* attemptPersistence(() =>
    transaction
      .select({
        state: tenantModuleStates.state,
        tenantModuleStateId: tenantModuleStates.tenantModuleStateId,
      })
      .from(tenantModuleStates)
      .where(
        and(
          eq(tenantModuleStates.tenantId, input.tenantId),
          eq(tenantModuleStates.moduleKey, input.moduleKey),
        ),
      ),
  );
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

  const historyRows = yield* attemptPersistence(() =>
    transaction
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
      .returning({ moduleStateChangeId: tenantModuleStateChanges.moduleStateChangeId }),
  );
  const [history] = historyRows;
  if (history === undefined) {
    return yield* persistenceUnavailable();
  }

  if (current === undefined) {
    const inserted = yield* attemptPersistence(() =>
      transaction
        .insert(tenantModuleStates)
        .values({
          lastChangeId: history.moduleStateChangeId,
          moduleKey: input.moduleKey,
          state: input.newState,
          tenantId: input.tenantId,
          updatedAt: changedAt,
        })
        .returning({ tenantModuleStateId: tenantModuleStates.tenantModuleStateId }),
    );
    const [insertedState] = inserted;
    if (insertedState === undefined) {
      return yield* persistenceUnavailable();
    }
  } else {
    const updated = yield* attemptPersistence(() =>
      transaction
        .update(tenantModuleStates)
        .set({
          lastChangeId: history.moduleStateChangeId,
          state: input.newState,
          updatedAt: changedAt,
        })
        .where(eq(tenantModuleStates.tenantModuleStateId, current.tenantModuleStateId))
        .returning({ tenantModuleStateId: tenantModuleStates.tenantModuleStateId }),
    );
    if (updated[0] === undefined) {
      return yield* persistenceUnavailable();
    }
  }

  return {
    moduleKey: input.moduleKey,
    newState: input.newState,
    previousState,
  };
});
