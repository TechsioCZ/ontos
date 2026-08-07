import { and, asc, eq, inArray } from 'drizzle-orm';
import { Clock, Context, DateTime, Effect, Layer, Schema } from 'effect';
import { CoreDatabase } from '../db/client.ts';
import { tenantModuleStateChanges, tenantModuleStates, tenants } from '../db/schema.ts';
import type { ActionAuthMethod } from '../db/schema.ts';
import type { ActionTransactionExecutor } from '../actions/context.ts';
import {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStatePersistenceUnavailableError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateTenantMissingError,
  TenantModuleStateUnchangedError,
  TenantModuleStateUnsupportedChangeSourceError,
} from './tenant-module-state-errors.ts';
import type { TenantModuleStateTransitionError } from './tenant-module-state-errors.ts';

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
  moduleKey: Schema.String,
  state: Schema.Literal('active'),
});
export type ActiveTenantModule = Schema.Schema.Type<typeof ActiveTenantModuleSchema>;

export const TenantModuleStateRecordSchema = Schema.Struct({
  moduleKey: Schema.String,
  state: TenantModuleStateSchema,
});
export type TenantModuleStateRecord = Schema.Schema.Type<typeof TenantModuleStateRecordSchema>;

export type TenantModuleStateChangeSource = 'support' | 'system' | 'user';

export const resolveTenantModuleStateChangeSource = (
  authMethod: ActionAuthMethod,
): Effect.Effect<TenantModuleStateChangeSource, TenantModuleStateUnsupportedChangeSourceError> => {
  switch (authMethod) {
    case 'session': {
      return Effect.succeed('user');
    }
    case 'support_impersonation': {
      return Effect.succeed('support');
    }
    case 'system': {
      return Effect.succeed('system');
    }
    case 'api_key': {
      return Effect.fail(
        new TenantModuleStateUnsupportedChangeSourceError({
          code: 'tenant_module_state_change_source_unsupported',
          reason: 'This authentication method cannot change tenant module state',
        }),
      );
    }
    default: {
      return authMethod;
    }
  }
};

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

export interface TenantModuleStateServiceShape {
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
  TenantModuleStateServiceShape
>()('@app/core-runtime/modules/tenant-module-state-service/TenantModuleStateService') {}

export const makeTenantModuleStateService = (
  database: Context.Service.Shape<typeof CoreDatabase>,
): TenantModuleStateServiceShape => {
  const listTenantModuleStates = (tenantId: string) =>
    Effect.tryPromise({
      catch: () =>
        new TenantModuleStateReadUnavailableError({
          code: 'tenant_module_state_read_unavailable',
          reason: 'Tenant module state is temporarily unavailable',
        }),
      try: () =>
        database.executor
          .select({ moduleKey: tenantModuleStates.moduleKey, state: tenantModuleStates.state })
          .from(tenantModuleStates)
          .where(eq(tenantModuleStates.tenantId, tenantId))
          .orderBy(asc(tenantModuleStates.moduleKey)),
    }).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach((row: (typeof rows)[number]) =>
          Schema.decodeUnknownEffect(TenantModuleStateSchema)(row.state).pipe(
            Effect.map((state) => ({ moduleKey: row.moduleKey, state })),
            Effect.mapError(
              () =>
                new TenantModuleStateReadUnavailableError({
                  code: 'tenant_module_state_read_unavailable',
                  reason: 'Tenant module state is temporarily unavailable',
                }),
            ),
          ),
        )(rows),
      ),
    );

  const decodeRows = (rows: readonly { readonly moduleKey: string; readonly state: unknown }[]) =>
    Effect.forEach((row: (typeof rows)[number]) =>
      Schema.decodeUnknownEffect(TenantModuleStateSchema)(row.state).pipe(
        Effect.map((state) => Object.freeze({ moduleKey: row.moduleKey, state })),
        Effect.mapError(
          () =>
            new TenantModuleStateReadUnavailableError({
              code: 'tenant_module_state_read_unavailable',
              reason: 'Tenant module state is temporarily unavailable',
            }),
        ),
      ),
    )(rows).pipe(Effect.map((records) => Object.freeze(records)));

  return {
    getTenantModuleStates: (tenantId, moduleKeys) => {
      const distinctKeys = [...new Set(moduleKeys)].toSorted();
      if (distinctKeys.length === 0) {
        return Effect.succeed(Object.freeze([]));
      }
      return Effect.tryPromise({
        catch: () =>
          new TenantModuleStateReadUnavailableError({
            code: 'tenant_module_state_read_unavailable',
            reason: 'Tenant module state is temporarily unavailable',
          }),
        try: () =>
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
      }).pipe(Effect.flatMap(decodeRows));
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

const persistenceUnavailable = () =>
  new TenantModuleStatePersistenceUnavailableError({
    code: 'tenant_module_state_persistence_unavailable',
    reason: 'Tenant module state could not be persisted',
  });

export const persistTenantModuleStateChange = (
  transaction: ActionTransactionExecutor,
  input: PersistTenantModuleStateChangeInput,
): Effect.Effect<PersistTenantModuleStateChangeResult, TenantModuleStateTransitionError> =>
  Effect.gen(function* persistTenantModuleStateChangeEffect() {
    const changeSource = yield* resolveTenantModuleStateChangeSource(input.authMethod);

    const tenantRows = yield* Effect.tryPromise({
      catch: persistenceUnavailable,
      try: () =>
        transaction
          .select({ tenantId: tenants.tenantId })
          .from(tenants)
          .where(eq(tenants.tenantId, input.tenantId))
          .for('update'),
    });
    const [tenant] = tenantRows;
    if (tenant === undefined) {
      return yield* new TenantModuleStateTenantMissingError({
        code: 'tenant_module_state_tenant_missing',
        reason: 'The tenant required for this state change does not exist',
      });
    }

    const currentRows = yield* Effect.tryPromise({
      catch: persistenceUnavailable,
      try: () =>
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
    });
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

    const historyRows = yield* Effect.tryPromise({
      catch: persistenceUnavailable,
      try: () =>
        transaction
          .insert(tenantModuleStateChanges)
          .values({
            actionInvocationId: input.actionInvocationId,
            changeSource,
            changedByPrincipalId: input.principalId,
            moduleKey: input.moduleKey,
            newState: input.newState,
            occurredAt: changedAt,
            previousState,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
            tenantId: input.tenantId,
          })
          .returning({ moduleStateChangeId: tenantModuleStateChanges.moduleStateChangeId }),
    });
    const [history] = historyRows;
    if (history === undefined) {
      return yield* persistenceUnavailable();
    }

    if (current === undefined) {
      const inserted = yield* Effect.tryPromise({
        catch: persistenceUnavailable,
        try: () =>
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
      });
      const [insertedState] = inserted;
      if (insertedState === undefined) {
        return yield* persistenceUnavailable();
      }
    } else {
      const updated = yield* Effect.tryPromise({
        catch: persistenceUnavailable,
        try: () =>
          transaction
            .update(tenantModuleStates)
            .set({
              lastChangeId: history.moduleStateChangeId,
              state: input.newState,
              updatedAt: changedAt,
            })
            .where(eq(tenantModuleStates.tenantModuleStateId, current.tenantModuleStateId))
            .returning({ tenantModuleStateId: tenantModuleStates.tenantModuleStateId }),
      });
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
