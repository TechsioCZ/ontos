import { ReadRuntime } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import { DateTime, Effect, Result, Schema } from 'effect';
import { ManufacturerTargetSchema } from '../../shared/domain/manufacturer-relation.ts';
import type { ManufacturerTarget } from '../../shared/domain/manufacturer-relation.ts';
import {
  ManufacturerTargetUnavailable,
  manufacturerTargetResolverForCoreRead,
} from '../persistence/manufacturer-target-resolver.ts';

const sameTarget = Schema.toEquivalence(ManufacturerTargetSchema);

/** Resolve the immutable payload selector under the original trusted principal, outside SQL. */
export const prepareManufacturerTarget = Effect.fn('CatalogManufacturer.prepareTarget')(function* prepareTarget(
  target: ManufacturerTarget,
  scope: OperationalScope,
) {
  const runtime = yield* ReadRuntime;
  const preparedAt = yield* DateTime.now;
  const resolution = yield* manufacturerTargetResolverForCoreRead(runtime, scope)
    .resolve(target, { requestId: scope.correlationId, tenantId: scope.tenantId })
    .pipe(Effect.result);
  return { preparedAt, resolution, scope, target };
});

export type PreparedManufacturerTarget = Effect.Success<ReturnType<typeof prepareManufacturerTarget>>;

/** Replays the exact owner result, including its typed denial, without a second owner read. */
export const preparedManufacturerTargetResolver = (
  prepared: PreparedManufacturerTarget,
): ReturnType<typeof manufacturerTargetResolverForCoreRead> => ({
  resolve: Effect.fn('CatalogManufacturer.resolvePrepared')(function* resolvePrepared(target, scope) {
    const now = yield* DateTime.now;
    const age = DateTime.toEpochMillis(now) - DateTime.toEpochMillis(prepared.preparedAt);
    if (
      !sameTarget(target, prepared.target) ||
      scope.tenantId !== prepared.scope.tenantId ||
      scope.requestId !== prepared.scope.correlationId ||
      age < 0 ||
      age >= 30_000
    ) {
      return yield* new ManufacturerTargetUnavailable();
    }
    return yield* Result.isFailure(prepared.resolution)
      ? Effect.fail(prepared.resolution.failure)
      : Effect.succeed(prepared.resolution.success);
  }),
});
