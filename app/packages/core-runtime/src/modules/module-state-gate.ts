// @effect-diagnostics effectFnOpportunity:off
import { and, eq } from 'drizzle-orm';
import { Clock, Context, Effect, Layer, Schema } from 'effect';
import type { CoreTransaction } from '../db/types.ts';
import { tenantModuleStates, tenants } from '../db/schema.ts';
import type {
  ModuleEntrypointAccess,
  ModuleEntrypointDescriptor,
  TenantModuleEntrypoint,
} from './module-entrypoint.ts';
import {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from './module-state-gate-errors.ts';
import type { ModuleStateGateError } from './module-state-gate-errors.ts';
import {
  TENANT_MODULE_STATES,
  TenantModuleStateSchema,
  TenantModuleStateService,
  TenantModuleStateServiceLive,
} from './tenant-module-state-service.ts';
import type {
  TenantModuleState,
  TenantModuleStateServiceContract,
} from './tenant-module-state-service.ts';

export type ModuleStateDecision = 'allow' | 'deny';

const allowedAccessByState: Readonly<
  Record<TenantModuleState, ReadonlySet<ModuleEntrypointAccess>>
> = Object.freeze({
  active: new Set<ModuleEntrypointAccess>(['background', 'historical_read', 'read', 'write']),
  archived: new Set<ModuleEntrypointAccess>(['historical_read']),
  deprecated: new Set<ModuleEntrypointAccess>(['historical_read', 'read']),
  inactive: new Set<ModuleEntrypointAccess>(['historical_read']),
  quarantined: new Set<ModuleEntrypointAccess>(),
  read_only: new Set<ModuleEntrypointAccess>(['historical_read', 'read']),
  suspended: new Set<ModuleEntrypointAccess>(['historical_read']),
});

export const decideModuleStateAccess = (
  state: TenantModuleState | null,
  access: ModuleEntrypointAccess,
): ModuleStateDecision =>
  state !== null && allowedAccessByState[state].has(access) ? 'allow' : 'deny';

export const tenantStatesAllowingAccess = (
  access: ModuleEntrypointAccess,
): readonly TenantModuleState[] =>
  Object.freeze(
    TENANT_MODULE_STATES.map((state) => [state, allowedAccessByState[state]] as const)
      .filter(([, accesses]) => accesses.has(access))
      .map(([state]) => state)
      .toSorted(),
  );

export interface ModuleStateSnapshot {
  readonly entrypointKeys: readonly string[];
  readonly moduleKeys: readonly string[];
  readonly tenantId: string;
}

interface ModuleStateSnapshotData {
  readonly declaredEntrypoints: ReadonlySet<string>;
  readonly evaluatedEntrypoints: Set<string>;
  readonly states: ReadonlyMap<string, TenantModuleState>;
}

const snapshotData = new WeakMap<ModuleStateSnapshot, ModuleStateSnapshotData>();

const entrypointFingerprint = (entrypoint: ModuleEntrypointDescriptor): string =>
  [
    entrypoint.scope,
    entrypoint.moduleKey,
    entrypoint.entrypointKey,
    entrypoint.role,
    entrypoint.access,
  ].join('\u0000');

const unavailable = () =>
  new ModuleStateCheckUnavailableError({
    code: 'module_state_check_unavailable',
    reason: 'Module state could not be checked safely',
  });

const denied = () =>
  new ModuleStateDeniedError({
    code: 'module_state_denied',
    reason: 'The module entrypoint is unavailable in the current module state',
  });

export const makeModuleStateSnapshot = (
  tenantId: string,
  entrypoints: readonly ModuleEntrypointDescriptor[],
  records: readonly { readonly moduleKey: string; readonly state: TenantModuleState }[],
): ModuleStateSnapshot => {
  const entrypointKeys = Object.freeze(
    [...new Set(entrypoints.map((entrypoint) => entrypoint.entrypointKey))].toSorted(),
  );
  const declaredEntrypoints = new Set(entrypoints.map(entrypointFingerprint));
  const moduleKeys = entrypoints
    .filter((entrypoint) => entrypoint.scope === 'tenant')
    .map((entrypoint) => entrypoint.moduleKey);
  const declaredKeys = Object.freeze([...new Set(moduleKeys)].toSorted());
  const declaredSet = new Set(declaredKeys);
  const states = new Map<string, TenantModuleState>();
  for (const record of records) {
    if (!declaredSet.has(record.moduleKey) || states.has(record.moduleKey)) {
      throw new TypeError('Module state snapshot records do not match the declared module keys');
    }
    states.set(record.moduleKey, record.state);
  }
  const snapshot = Object.freeze({ entrypointKeys, moduleKeys: declaredKeys, tenantId });
  snapshotData.set(snapshot, {
    declaredEntrypoints,
    evaluatedEntrypoints: new Set(),
    states,
  });
  return snapshot;
};

type ModuleStateSpanAttributes = Readonly<Record<string, boolean | number | string>>;

const annotateCurrentSpan = (attributes: ModuleStateSpanAttributes) =>
  Effect.currentSpan.pipe(
    Effect.tap((span) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(attributes)) {
          span.attribute(key, value);
        }
      }),
    ),
    Effect.asVoid,
    Effect.ignore,
  );

const recordAcquisitionTelemetry = (
  startedAt: number,
  batchSize: number,
  outcome: 'available' | 'unavailable',
) =>
  Effect.gen(function* recordAcquisitionTelemetryEffect() {
    const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
    yield* annotateCurrentSpan({ batchSize, elapsedMs, outcome });
    yield* Effect.annotateLogs(Effect.logDebug('Module state snapshot acquisition completed'), {
      batchSize,
      elapsedMs,
      outcome,
    });
  });

export const prepareModuleStateSnapshot = (
  stateService: TenantModuleStateServiceContract,
  tenantId: string,
  entrypoints: readonly ModuleEntrypointDescriptor[],
): Effect.Effect<ModuleStateSnapshot, ModuleStateCheckUnavailableError> => {
  const moduleKeys = entrypoints
    .filter((entrypoint) => entrypoint.scope === 'tenant')
    .map((entrypoint) => entrypoint.moduleKey);
  const distinctKeys = [...new Set(moduleKeys)].toSorted();
  return Effect.gen(function* prepareSnapshotEffect() {
    const startedAt = yield* Clock.currentTimeMillis;
    let acquisition: Effect.Effect<ModuleStateSnapshot, ModuleStateCheckUnavailableError>;
    if (distinctKeys.length === 0) {
      acquisition = Effect.succeed(makeModuleStateSnapshot(tenantId, entrypoints, []));
    } else if (tenantId.length === 0) {
      acquisition = Effect.fail(unavailable());
    } else {
      acquisition = stateService.getTenantModuleStates(tenantId, distinctKeys).pipe(
        Effect.mapError(unavailable),
        Effect.flatMap((records) =>
          Effect.try({
            catch: unavailable,
            try: () => makeModuleStateSnapshot(tenantId, entrypoints, records),
          }),
        ),
      );
    }
    return yield* acquisition.pipe(
      Effect.tap(() => recordAcquisitionTelemetry(startedAt, distinctKeys.length, 'available')),
      Effect.tapError(() =>
        recordAcquisitionTelemetry(startedAt, distinctKeys.length, 'unavailable'),
      ),
    );
  }).pipe(
    Effect.withSpan('ModuleStateGate.acquire', {
      attributes: { batchSize: distinctKeys.length },
    }),
  );
};

export const checkModuleEntrypoint = (
  snapshot: ModuleStateSnapshot,
  entrypoint: ModuleEntrypointDescriptor,
): Effect.Effect<void, ModuleStateGateError> => {
  const data = snapshotData.get(snapshot);
  const fingerprint = entrypointFingerprint(entrypoint);
  if (data === undefined || !data.declaredEntrypoints.has(fingerprint)) {
    return Effect.fail(unavailable()).pipe(
      Effect.withSpan('ModuleStateGate.evaluate', {
        attributes: {
          access: entrypoint.access,
          outcome: 'unavailable',
          scope: entrypoint.scope,
          snapshotReuse: false,
        },
      }),
    );
  }
  const snapshotReuse = data.evaluatedEntrypoints.has(fingerprint);
  data.evaluatedEntrypoints.add(fingerprint);
  if (entrypoint.scope === 'system') {
    return Effect.void.pipe(
      Effect.withSpan('ModuleStateGate.evaluate', {
        attributes: {
          access: entrypoint.access,
          outcome: 'allow',
          scope: 'system',
          snapshotReuse,
        },
      }),
    );
  }
  if (snapshot.tenantId.length === 0 || !snapshot.moduleKeys.includes(entrypoint.moduleKey)) {
    return Effect.fail(unavailable()).pipe(
      Effect.withSpan('ModuleStateGate.evaluate', {
        attributes: {
          access: entrypoint.access,
          outcome: 'unavailable',
          scope: 'tenant',
          snapshotReuse,
        },
      }),
    );
  }
  const outcome = decideModuleStateAccess(
    data.states.get(entrypoint.moduleKey) ?? null,
    entrypoint.access,
  );
  return (outcome === 'allow' ? Effect.void : Effect.fail(denied())).pipe(
    Effect.withSpan('ModuleStateGate.evaluate', {
      attributes: {
        access: entrypoint.access,
        outcome,
        scope: 'tenant',
        snapshotReuse,
      },
    }),
  );
};

export interface ModuleStateGateService {
  readonly check: (
    snapshot: ModuleStateSnapshot,
    entrypoint: ModuleEntrypointDescriptor,
  ) => Effect.Effect<void, ModuleStateGateError>;
  readonly prepareSnapshot: (
    tenantId: string,
    entrypoints: readonly ModuleEntrypointDescriptor[],
  ) => Effect.Effect<ModuleStateSnapshot, ModuleStateCheckUnavailableError>;
  readonly recheckWrite: (
    transaction: CoreTransaction,
    tenantId: string,
    entrypoint: TenantModuleEntrypoint<ModuleEntrypointDescriptor['role'], 'write'>,
  ) => Effect.Effect<void, ModuleStateGateError>;
}

export const makeModuleStateGate = (
  stateService: TenantModuleStateServiceContract,
): ModuleStateGateService => ({
  check: checkModuleEntrypoint,
  prepareSnapshot: (tenantId, entrypoints) =>
    prepareModuleStateSnapshot(stateService, tenantId, entrypoints),
  recheckWrite: (transaction, tenantId, entrypoint) => {
    const recheck = Effect.gen(function* recheckWriteEffect() {
      const tenantRows = yield* Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select({ tenantId: tenants.tenantId })
            .from(tenants)
            .where(eq(tenants.tenantId, tenantId))
            .for('update'),
      });
      if (tenantRows[0] === undefined) {
        return yield* unavailable();
      }
      const rows = yield* Effect.tryPromise({
        catch: unavailable,
        try: () =>
          transaction
            .select({ state: tenantModuleStates.state })
            .from(tenantModuleStates)
            .where(
              and(
                eq(tenantModuleStates.tenantId, tenantId),
                eq(tenantModuleStates.moduleKey, entrypoint.moduleKey),
              ),
            ),
      });
      const state =
        rows[0] === undefined
          ? null
          : yield* Schema.decodeUnknownEffect(TenantModuleStateSchema)(rows[0].state).pipe(
              Effect.mapError(unavailable),
            );
      if (decideModuleStateAccess(state, 'write') === 'deny') {
        return yield* denied();
      }
    });
    const annotateFailure = (error: ModuleStateGateError) =>
      annotateCurrentSpan({
        outcome: error._tag === 'ModuleStateDeniedError' ? 'deny' : 'unavailable',
      });
    return recheck.pipe(
      Effect.tap(() => annotateCurrentSpan({ outcome: 'allow' })),
      Effect.tapError(annotateFailure),
      Effect.withSpan('ModuleStateGate.recheckWrite', {
        attributes: { access: 'write', scope: 'tenant' },
      }),
    );
  },
});

export class ModuleStateGate extends Context.Service<ModuleStateGate, ModuleStateGateService>()(
  '@app/core-runtime/modules/module-state-gate/ModuleStateGate',
) {}

export const ModuleStateGateLive = Layer.effect(
  ModuleStateGate,
  TenantModuleStateService.pipe(Effect.map(makeModuleStateGate)),
).pipe(Layer.provide(TenantModuleStateServiceLive));
