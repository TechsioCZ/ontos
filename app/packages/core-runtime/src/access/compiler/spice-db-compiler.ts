import { v1 } from '@authzed/authzed-node';
import { Effect, Layer, Option, Result } from 'effect';

import { fullyConsistent } from '../../permissions/client.ts';
import { openSpiceDbRpc } from '../../permissions/spicedb-transaction-guard.ts';
import type { SpiceDbRpcError } from '../../permissions/spicedb-rpc.ts';
import type { SpiceDbConfigError } from '../../permissions/config-error.ts';
import { SpiceDbConfig } from '../../permissions/config.ts';
import type { SpiceDbConfigValue } from '../../permissions/config.ts';
import { AccessProjectionCompiler as AccessProjectionCompilerService } from '../intent/projection-compiler.ts';
import { diffProjection, verifyProjection } from './diff.ts';
import type { ProjectionDiff, ProjectionDrift, ProjectionVerification } from './diff.ts';
import type { AccessProjectionIntent } from './intent.ts';
import { planAccessProjection } from './plan.ts';
import type { ProjectionFenceScope } from './plan.ts';
import { AccessProjectionError } from './projection-error.ts';
import type { AccessRelationship, ProjectionUnitKey } from './relationship.ts';
import { MANAGED_RELATIONS } from './relationship.ts';
import { decodeObjectId, tenantObjectIdPrefix } from './object-id.ts';
import { fromSpiceDbRelationship, toSpiceDbRelationship } from './spicedb-relationship.ts';

/**
 * The deadline of every engine call on the projection path. A whole-projection read is bigger than one permission
 * check, so it gets its own. The deadline is the engine's too (a gRPC deadline, `Grpc-Timeout` over HTTP), so a call
 * that outlives it is cancelled in SpiceDB, never committed later.
 *
 * It must stay below the lease minus the holder's unproved limit: RPC deadline 15 s < lease 120 s − 90 s = 30 s. A
 * holder sends a write only while its hold was proved within 90 s, and that proof keeps the lease live for 120 s after
 * it, so every write it sent is either committed or cancelled before the lease can lapse to a taker.
 */
export const ACCESS_PROJECTION_RPC_TIMEOUT_MS = 15_000;
const READ_CONCURRENCY = 4;
/** gRPC INVALID_ARGUMENT: the engine read the request and refused it, so a retry cannot succeed. */
const GRPC_INVALID_ARGUMENT = 3;
/**
 * SpiceDB's default `--write-relationships-max-updates-per-call`. One request carries at most this
 * many updates, so a unit whose tuple set is larger is written in batches instead of being refused as
 * unavailable and retried forever.
 */
export const ACCESS_PROJECTION_MAX_UPDATES_PER_WRITE = 1000;

const grpcCodeText = (error: SpiceDbRpcError): string =>
  Option.match(error.code, {
    onNone: () => 'no gRPC status',
    onSome: (code) => `gRPC ${code}`,
  });

const unavailable = (error: SpiceDbRpcError): AccessProjectionError =>
  new AccessProjectionError({
    code: 'access_projection_unavailable',
    reason: `The SpiceDB projection call did not complete safely: ${grpcCodeText(error)}`,
  });

/**
 * A plan the engine refuses as invalid never becomes valid by retrying it: reporting it as
 * unavailable would make the writer retry a permanent failure and hide the real cause.
 */
const projectionFailure = (error: SpiceDbRpcError): AccessProjectionError =>
  Option.getOrUndefined(error.code) === GRPC_INVALID_ARGUMENT
    ? new AccessProjectionError({
        code: 'access_projection_engine_rejected',
        reason: 'The engine refused the projection as invalid, so the same plan cannot succeed on retry',
      })
    : unavailable(error);

export interface AccessProjectionTransport {
  readonly close: () => void;
  readonly readRelationships: (
    request: v1.ReadRelationshipsRequest,
  ) => Effect.Effect<readonly v1.ReadRelationshipsResponse[], AccessProjectionError>;
  readonly writeRelationships: (
    request: v1.WriteRelationshipsRequest,
  ) => Effect.Effect<v1.WriteRelationshipsResponse, AccessProjectionError>;
}

/** Resolves to gRPC on Node and to the HTTP gateway on workerd, like every other SpiceDB client. */
export const makeAccessProjectionTransport = (
  configuration: SpiceDbConfigValue,
  timeoutMilliseconds: number = ACCESS_PROJECTION_RPC_TIMEOUT_MS,
): AccessProjectionTransport => {
  const rpc = openSpiceDbRpc(configuration, timeoutMilliseconds);
  const transport: AccessProjectionTransport = {
    close: rpc.close,
    readRelationships: (request) => rpc.readRelationships(request).pipe(Effect.mapError(projectionFailure)),
    writeRelationships: (request) => rpc.writeRelationships(request).pipe(Effect.mapError(projectionFailure)),
  };
  return Object.freeze(transport);
};

/**
 * The relations whose tuple takes access away: each is the right-hand side of an exclusion in the v2 schema
 * (`permission access = member - suspended`). Adding such a tuple revokes and deleting it grants, the opposite of every
 * other managed relation. A schema test fails when an exclusion appears that is not listed here.
 */
export const SUBTRACTIVE_RELATIONS: readonly { readonly relation: string; readonly resourceType: string }[] = [
  { relation: 'suspended', resourceType: 'access_tenant' },
  { relation: 'suspended', resourceType: 'access_legal_entity' },
];

const isSubtractive = (relationship: AccessRelationship): boolean =>
  SUBTRACTIVE_RELATIONS.some(
    ({ relation, resourceType }) => relationship.relation === relation && relationship.resourceType === resourceType,
  );

const updatesOf = (
  relationships: readonly AccessRelationship[],
  operation: v1.RelationshipUpdate_Operation,
): readonly v1.RelationshipUpdate[] =>
  relationships.map((relationship) =>
    v1.RelationshipUpdate.create({ operation, relationship: toSpiceDbRelationship(relationship) }),
  );

/**
 * A projection's updates in the order that never shows a reader more access than the old or the new intent gives,
 * cut into batches the engine accepts. Revocations first, grants last:
 *
 * 1. new suspensions (a TOUCH of a subtractive relation revokes),
 * 2. every other deletion (revokes),
 * 3. every other touch (grants),
 * 4. lifted suspensions (a DELETE of a subtractive relation grants).
 *
 * A reader between two batches may be denied a right that is being granted, never keep a revoked one beside a new one.
 */
export const projectionWriteBatches = (diff: ProjectionDiff): readonly (readonly v1.RelationshipUpdate[])[] => {
  const { DELETE, TOUCH } = v1.RelationshipUpdate_Operation;
  const deletions = diff.units.flatMap((unitDiff) => unitDiff.deletions);
  const touches = diff.units.flatMap((unitDiff) => unitDiff.touches);
  const updates = [
    ...updatesOf(touches.filter(isSubtractive), TOUCH),
    ...updatesOf(
      deletions.filter((relationship) => !isSubtractive(relationship)),
      DELETE,
    ),
    ...updatesOf(
      touches.filter((relationship) => !isSubtractive(relationship)),
      TOUCH,
    ),
    ...updatesOf(deletions.filter(isSubtractive), DELETE),
  ];
  const batches: (readonly v1.RelationshipUpdate[])[] = [];
  for (let index = 0; index < updates.length; index += ACCESS_PROJECTION_MAX_UPDATES_PER_WRITE) {
    batches.push(updates.slice(index, index + ACCESS_PROJECTION_MAX_UPDATES_PER_WRITE));
  }
  return batches;
};

export interface ProjectionQueryOptions {
  /** Units whose intent is gone; their tuples are deleted by the same write. */
  readonly removedUnits?: readonly ProjectionUnitKey[];
}

/**
 * D15: every reconcile runs inside the scope fence of each scope it writes, and the fence is proved
 * before the compiler reads anything. A plan built from a graph another writer can change mid-flight
 * would otherwise verify against its own stale read. The writer passes its fence store's assertion:
 * `Effect.void` while it holds the scope's fence, a refusal once another operation holds it.
 */
export type ProjectionFenceAssertion = (
  scope: ProjectionFenceScope,
) => Effect.Effect<void, readonly AccessProjectionError[]>;

export interface ProjectionOptions extends ProjectionQueryOptions {
  /**
   * Runs before every relationship write the reconcile sends, so the writer knows the engine was touched (the graph
   * may be half-written from then on) and can stop a write it may no longer make.
   */
  readonly beforeWrite?: Effect.Effect<void, readonly AccessProjectionError[]>;
  readonly fence: ProjectionFenceAssertion;
}

export interface ReconcileReport {
  readonly deletions: number;
  readonly drift: readonly ProjectionDrift[];
  readonly projectionToken?: string;
  readonly touches: number;
  readonly units: readonly string[];
  readonly verified: boolean;
}

export interface AccessProjectionCompiler {
  /** Every managed tuple the engine holds for these tenants, decoded into intent terms. */
  readonly readProjection: (
    tenantIds: readonly string[],
  ) => Effect.Effect<readonly AccessRelationship[], readonly AccessProjectionError[]>;
  readonly reconcile: (
    intent: AccessProjectionIntent,
    options: ProjectionOptions,
  ) => Effect.Effect<ReconcileReport, readonly AccessProjectionError[]>;
  readonly verify: (
    intent: AccessProjectionIntent,
    options?: ProjectionQueryOptions,
  ) => Effect.Effect<ProjectionVerification, readonly AccessProjectionError[]>;
}

const asFailures = (error: AccessProjectionError): readonly AccessProjectionError[] => [error];

const relationshipsOf = (responses: readonly v1.ReadRelationshipsResponse[]): readonly AccessRelationship[] => {
  const relationships: AccessRelationship[] = [];
  for (const response of responses) {
    const { relationship } = response;
    if (relationship !== undefined) {
      relationships.push(...Option.toArray(fromSpiceDbRelationship(relationship)));
    }
  }
  return relationships;
};

/** The tenant a tuple belongs to: the first part of its resource ID. */
const tenantOf = (relationship: AccessRelationship): string | undefined =>
  Option.getOrUndefined(decodeObjectId(relationship.resourceId))?.parts[0];

/** The tenants one reconcile reads: those it plans, plus the owners of any unit it removes. */
const tenantsOf = (intent: AccessProjectionIntent, removedUnits: readonly ProjectionUnitKey[]): readonly string[] => [
  ...intent.tenants.map((tenant) => tenant.tenantId),
  ...removedUnits.flatMap((unit) => Option.toArray(decodeObjectId(unit.objectId)).map(({ parts }) => parts[0] ?? '')),
];

const planOrFail = (intent: AccessProjectionIntent) => {
  const planned = planAccessProjection(intent);
  return Result.isFailure(planned) ? Effect.fail(planned.failure) : Effect.succeed(planned.success);
};

/**
 * The single Core writer. A reconcile plans, reads, writes the minimal mutation set in one
 * transaction, then re-reads and verifies: the graph is either exactly the intent or the operation
 * fails (D13). An unavailable engine is reported as unavailable, never as an empty projection.
 */
/**
 * A transport that opens the engine connection on its first call and closes it with its scope. A process
 * whose runtime reaches the projection only from some requests then starts, and answers readiness, without
 * SpiceDB configured; a configuration it cannot read fails that call as unavailable, never a grant.
 */
export const makeDeferredAccessProjectionTransport = Effect.fn('AccessProjection.deferredTransport')(
  function* deferredAccessProjectionTransport(
    loadConfiguration: Effect.Effect<SpiceDbConfigValue, SpiceDbConfigError>,
  ) {
    // The engine connection, once a call opened it; closing the transport closes it with the scope.
    const opened: AccessProjectionTransport[] = [];
    const closeOpened = (): void => {
      for (const engine of opened.splice(0)) {
        engine.close();
      }
    };
    yield* Effect.addFinalizer(() => Effect.sync(closeOpened));
    const open = yield* Effect.cached(
      loadConfiguration.pipe(
        Effect.mapError(
          (error) =>
            new AccessProjectionError({
              code: 'access_projection_unavailable',
              reason: `The SpiceDB configuration of this process could not be read: ${error.reason}`,
            }),
        ),
        Effect.map((configuration) => makeAccessProjectionTransport(configuration)),
        Effect.tap((engine) => Effect.sync(() => opened.push(engine))),
      ),
    );
    const transport: AccessProjectionTransport = {
      close: closeOpened,
      readRelationships: (request) => open.pipe(Effect.flatMap((engine) => engine.readRelationships(request))),
      writeRelationships: (request) => open.pipe(Effect.flatMap((engine) => engine.writeRelationships(request))),
    };
    return Object.freeze(transport);
  },
);

export const makeAccessProjectionCompiler = (transport: AccessProjectionTransport): AccessProjectionCompiler => {
  const readRelationships = (
    managed: (typeof MANAGED_RELATIONS)[number],
    tenantId: string,
  ): Effect.Effect<readonly AccessRelationship[], readonly AccessProjectionError[]> =>
    transport
      .readRelationships(
        v1.ReadRelationshipsRequest.create({
          consistency: fullyConsistent,
          optionalLimit: 0,
          relationshipFilter: v1.RelationshipFilter.create({
            optionalRelation: managed.relation,
            optionalResourceIdPrefix: Option.getOrElse(tenantObjectIdPrefix(managed.type, tenantId), () => ''),
            resourceType: managed.type,
          }),
        }),
      )
      .pipe(
        Effect.mapError(asFailures),
        Effect.map((responses) =>
          relationshipsOf(responses).filter((relationship) => tenantOf(relationship) === tenantId),
        ),
      );

  // A reconcile reads only the tenants it writes, so its cost never grows with the rest of the engine.
  const readProjection: AccessProjectionCompiler['readProjection'] = Effect.fn(
    'AccessProjectionCompiler.readProjection',
  )(function* readProjectionEffect(tenantIds: readonly string[]) {
    const reads: Effect.Effect<readonly AccessRelationship[], readonly AccessProjectionError[]>[] = [];
    for (const tenantId of new Set(tenantIds)) {
      for (const managed of MANAGED_RELATIONS) {
        reads.push(readRelationships(managed, tenantId));
      }
    }
    const settled = yield* Effect.all(reads, { concurrency: READ_CONCURRENCY });
    return settled.flat();
  });

  /**
   * The whole difference, in the order that never widens access, sent in batches the engine accepts. One request is
   * atomic in the engine, so a difference that fits in one request (most do) is written at once; a larger one is sent
   * batch by batch, and reads (which never wait on the tenant's fence) can observe it half-written. See
   * `projectionWriteBatches` for the order. A `TOUCH` replaces content, never deletes.
   */
  const writeDiff = (
    diff: ProjectionDiff,
    beforeWrite: Effect.Effect<void, readonly AccessProjectionError[]>,
  ): Effect.Effect<Option.Option<string>, readonly AccessProjectionError[]> => {
    const batches = projectionWriteBatches(diff);
    return Effect.forEach(
      batches,
      (batch) =>
        beforeWrite.pipe(
          Effect.andThen(
            transport
              .writeRelationships(v1.WriteRelationshipsRequest.create({ updates: [...batch] }))
              .pipe(Effect.mapError(asFailures)),
          ),
          Effect.map((written) => {
            const token = written.writtenAt?.token;
            return token === undefined || token.length === 0 ? Option.none<string>() : Option.some(token);
          }),
        ),
      { concurrency: 1 },
    ).pipe(Effect.map((tokens) => tokens.findLast(Option.isSome) ?? Option.none()));
  };

  const reconcile: AccessProjectionCompiler['reconcile'] = Effect.fn('AccessProjectionCompiler.reconcile')(
    function* reconcileEffect(intent: AccessProjectionIntent, options: ProjectionOptions) {
      const desired = yield* planOrFail(intent);
      // D15: the fence comes first, before the compiler reads a single tuple.
      yield* Effect.forEach(desired.fences, (scope) => options.fence(scope), { concurrency: 1, discard: true });
      const removedUnits = options.removedUnits ?? [];
      const tenantIds = tenantsOf(intent, removedUnits);
      const current = yield* readProjection(tenantIds);
      const diff = diffProjection(desired, current, removedUnits);
      const units = desired.units.map((planned) => planned.key);
      if (diff.touches.length === 0 && diff.deletions.length === 0) {
        return { deletions: 0, drift: [], touches: 0, units, verified: true };
      }
      // One request after another: two writes to one tenant never overlap.
      const token = yield* writeDiff(diff, options.beforeWrite ?? Effect.void);
      const after = yield* readProjection(tenantIds);
      const verification = verifyProjection(desired, after, removedUnits);
      if (!verification.ok) {
        return yield* Effect.fail<readonly AccessProjectionError[]>([
          new AccessProjectionError({
            code: 'access_projection_verification_failed',
            reason: `The projection still differs from intent in ${verification.drift.length} tuple(s) after the write`,
          }),
        ]);
      }
      const report: ReconcileReport = {
        deletions: diff.deletions.length,
        drift: verification.drift,
        touches: diff.touches.length,
        units,
        verified: true,
      };
      return Option.match(token, {
        onNone: () => report,
        onSome: (projectionToken) => ({ ...report, projectionToken }),
      });
    },
  );

  const verify: AccessProjectionCompiler['verify'] = Effect.fn('AccessProjectionCompiler.verify')(
    function* verifyEffect(intent: AccessProjectionIntent, options: ProjectionQueryOptions = {}) {
      // A plan that violates an invariant fails before the compiler reads the engine at all.
      const desired = yield* planOrFail(intent);
      const removedUnits = options.removedUnits ?? [];
      return yield* readProjection(tenantsOf(intent, removedUnits)).pipe(
        Effect.map((current) => verifyProjection(desired, current, removedUnits)),
      );
    },
  );

  const compiler: AccessProjectionCompiler = { readProjection, reconcile, verify };
  return Object.freeze(compiler);
};

/**
 * The projection compiler of the worker process. Its engine transport is deferred, so a worker that has
 * no SpiceDB configured still starts and answers readiness; the first reconcile that needs the engine
 * opens it, and a configuration it cannot read fails that reconcile as unavailable, never as a grant.
 */
export const CoreAuthorizationProjectionCompilerLive: Layer.Layer<
  AccessProjectionCompilerService,
  never,
  SpiceDbConfig
> = Layer.effect(
  AccessProjectionCompilerService,
  Effect.gen(function* makeCoreAuthorizationProjectionCompiler() {
    const configuration = yield* SpiceDbConfig;
    const transport = yield* makeDeferredAccessProjectionTransport(Effect.succeed(configuration));
    return makeAccessProjectionCompiler(transport);
  }),
);
